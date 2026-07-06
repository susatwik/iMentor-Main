# server/rag_service/course_material_processor.py
"""
Unified Course Material Processing Pipeline
============================================

Triggered on server restart (or manually via API).  Scans the course_bootstrap/
directory and applies the following decision logic per course:

┌─────────────────────────────────────────────────────────────────┐
│                  COURSE DIRECTORY STATE                         │
├──────────────────────────────┬──────────────────────────────────┤
│ EMPTY (no CSV/PDF/MD)        │ → DECOMMISSION (Neo4j + Qdrant + │
│                              │   delete folder)                 │
├──────────────────────────────┼──────────────────────────────────┤
│ Has PDFs                     │ → Convert with marker-pdf        │
│                              │   (fallback: pymupdf4llm/fitz)   │
│                              │   DELETE source PDFs after       │
│                              │   Ingest to Qdrant               │
├──────────────────────────────┼──────────────────────────────────┤
│ Has MDs (processed/backup)   │ → Qdrant integrity check         │
│ + syllabus CSV               │   Re-ingest any missing chunks   │
│                              │   (idempotent, SHA-tracked)      │
├──────────────────────────────┼──────────────────────────────────┤
│ Only syllabus CSV            │ → Deep multi-source search       │
│ (no PDFs, no MDs)            │   Download + validate + convert  │
│                              │   to MD, log sources, delete PDFs│
├──────────────────────────────┼──────────────────────────────────┤
│ All above completed          │ → Stage 5: STN generation        │
│                              │   Stage 6: STN → Qdrant          │
│                              │   Stage 7: Markdown backup       │
│                              │   Stage 8: Study Questions       │
│                              │   Stage 9: Skill Tree            │
└──────────────────────────────┴──────────────────────────────────┘

State is tracked in ``pipeline_state.json`` per course (SHA-256 manifest
for PDFs and MD files, done-lists for STN / questions / skill-tree).

marker-pdf is used as the primary offline converter because it preserves
mathematical notation, tables, and section headings at publication quality.
"""

import hashlib
import json
import logging
import os
import shutil
import threading
import time
import uuid
from typing import Any, Callable, Dict, List, Optional, Tuple

import config
import neo4j_handler
from vector_db_service import VectorDBService

logger = logging.getLogger(__name__)

# ── Directories ──────────────────────────────────────────────────────────────
BOOTSTRAP_DIR = os.path.abspath(
    os.getenv("COURSE_BOOTSTRAP_DIR",
              os.path.join(os.path.dirname(__file__), "..", "course_bootstrap"))
)
_COURSE_USER_ID = "__course_material__"

# ── Per-course lock ───────────────────────────────────────────────────────────
_LOCKS: dict = {}
_LOCKS_LOCK = threading.Lock()


def _get_lock(course: str) -> threading.Lock:
    with _LOCKS_LOCK:
        if course not in _LOCKS:
            _LOCKS[course] = threading.Lock()
        return _LOCKS[course]


# =============================================================================
# UTILITY HELPERS
# =============================================================================

def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(65536), b""):
            h.update(block)
    return h.hexdigest()


def _load_json(path: str) -> dict:
    if os.path.exists(path):
        try:
            with open(path, "r") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _save_json(path: str, data: dict):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def _ensure_dirs(*dirs):
    for d in dirs:
        os.makedirs(d, exist_ok=True)


def _move_to(src: str, dst_dir: str):
    """Move file to dst_dir, no-op if already exists."""
    os.makedirs(dst_dir, exist_ok=True)
    dst = os.path.join(dst_dir, os.path.basename(src))
    if not os.path.exists(dst):
        shutil.move(src, dst)
        logger.info(f"Moved → {dst}")
    else:
        if os.path.exists(src) and src != dst:
            os.remove(src)
            logger.debug(f"Duplicate removed: {src}")


# =============================================================================
# PIPELINE STATE — survives interruptions
# =============================================================================

class PipelineState:
    """
    Tracks per-course pipeline progress in ``pipeline_state.json``.

    Schema:
        {
            "pdfs": {
                "<sha256>": {
                    "filename": "R1.pdf",
                    "markdown_done": true,
                    "qdrant_done": true,
                    "deleted": true
                }
            },
            "mds": {
                "<sha256>": {
                    "filename": "R1.md",
                    "qdrant_done": true
                }
            },
            "stn_done": ["subtopic_id_1", ...],
            "stn_qdrant_done": ["subtopic_id_1", ...],
            "questions_done": ["subtopic_id_1", ...],
            "skill_tree_done": false,
            "discovery_done": false,
            "markdown_backup_done": false,
            "last_run": "2026-03-22T10:00:00"
        }
    """

    def __init__(self, course_dir: str):
        self.path = os.path.join(course_dir, "pipeline_state.json")
        self.data = _load_json(self.path)
        # Ensure all keys present
        self.data.setdefault("pdfs", {})
        self.data.setdefault("mds", {})
        self.data.setdefault("stn_done", [])
        self.data.setdefault("stn_qdrant_done", [])
        self.data.setdefault("questions_done", [])
        self.data.setdefault("skill_tree_done", False)
        self.data.setdefault("discovery_done", False)
        self.data.setdefault("markdown_backup_done", False)
        # Dual-layer knowledge pyramid
        self.data.setdefault("pedagogical_done", [])
        self.data.setdefault("scholarly_done", False)
        self.data.setdefault("raw_chunks_cleared", False)
        self.data.setdefault("lecture_done", False)

    def save(self):
        self.data["last_run"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        _save_json(self.path, self.data)

    # -- PDF tracking --
    def is_pdf_done(self, sha: str, stage: str) -> bool:
        return self.data["pdfs"].get(sha, {}).get(stage, False)

    def mark_pdf(self, sha: str, filename: str, stage: str):
        if sha not in self.data["pdfs"]:
            self.data["pdfs"][sha] = {"filename": filename}
        self.data["pdfs"][sha][stage] = True
        self.save()

    # -- MD tracking (Qdrant integrity) --
    def is_md_ingested(self, sha: str) -> bool:
        return self.data["mds"].get(sha, {}).get("qdrant_done", False)

    def mark_md_ingested(self, sha: str, filename: str):
        if sha not in self.data["mds"]:
            self.data["mds"][sha] = {"filename": filename}
        self.data["mds"][sha]["qdrant_done"] = True
        self.save()

    # -- STN tracking --
    def is_stn_done(self, subtopic_id: str) -> bool:
        return subtopic_id in self.data["stn_done"]

    def mark_stn_done(self, subtopic_id: str):
        if subtopic_id not in self.data["stn_done"]:
            self.data["stn_done"].append(subtopic_id)
            self.save()

    def is_stn_qdrant_done(self, subtopic_id: str) -> bool:
        return subtopic_id in self.data["stn_qdrant_done"]

    def mark_stn_qdrant_done(self, subtopic_id: str):
        if subtopic_id not in self.data["stn_qdrant_done"]:
            self.data["stn_qdrant_done"].append(subtopic_id)
            self.save()

    # -- Study Questions tracking --
    def is_questions_done(self, subtopic_id: str) -> bool:
        return subtopic_id in self.data["questions_done"]

    def mark_questions_done(self, subtopic_id: str):
        if subtopic_id not in self.data["questions_done"]:
            self.data["questions_done"].append(subtopic_id)
            self.save()

    # -- Skill Tree --
    @property
    def skill_tree_done(self) -> bool:
        return self.data.get("skill_tree_done", False)

    @skill_tree_done.setter
    def skill_tree_done(self, val: bool):
        self.data["skill_tree_done"] = val
        self.save()

    # -- Discovery --
    @property
    def discovery_done(self) -> bool:
        return self.data.get("discovery_done", False)

    @discovery_done.setter
    def discovery_done(self, val: bool):
        self.data["discovery_done"] = val
        self.save()

    # -- Markdown backup --
    @property
    def markdown_backup_done(self) -> bool:
        return self.data.get("markdown_backup_done", False)

    @markdown_backup_done.setter
    def markdown_backup_done(self, val: bool):
        self.data["markdown_backup_done"] = val
        self.save()

    # -- Pedagogical layers (L2/L3/L4 per subtopic) --
    def is_pedagogical_done(self, subtopic_id: str) -> bool:
        return subtopic_id in self.data["pedagogical_done"]

    def mark_pedagogical_done(self, subtopic_id: str):
        if subtopic_id not in self.data["pedagogical_done"]:
            self.data["pedagogical_done"].append(subtopic_id)
            self.save()

    # -- Scholarly claims extraction --
    @property
    def scholarly_done(self) -> bool:
        return self.data.get("scholarly_done", False)

    @scholarly_done.setter
    def scholarly_done(self, val: bool):
        self.data["scholarly_done"] = val
        self.save()

    # -- Old raw chunks cleared from main Qdrant collection --
    @property
    def raw_chunks_cleared(self) -> bool:
        return self.data.get("raw_chunks_cleared", False)

    @raw_chunks_cleared.setter
    def raw_chunks_cleared(self, val: bool):
        self.data["raw_chunks_cleared"] = val
        self.save()

    # -- Lecture notes generated --
    @property
    def lecture_done(self) -> bool:
        return self.data.get("lecture_done", False)

    @lecture_done.setter
    def lecture_done(self, val: bool):
        self.data["lecture_done"] = val
        self.save()


# =============================================================================
# DIRECTORY INSPECTION HELPERS
# =============================================================================

def _is_course_empty(course_dir: str) -> bool:
    """
    Returns True only if the course directory has NO meaningful content:
    no CSV, PDF, MD files in root or in any processing subdirectory.
    """
    for fname in os.listdir(course_dir):
        if fname.startswith(".") or fname == "pipeline_state.json":
            continue
        fpath = os.path.join(course_dir, fname)
        if os.path.isfile(fpath) and fname.lower().endswith(
            (".pdf", ".csv", ".md", ".txt")
        ):
            return False
        # Check processing subdirs
        if os.path.isdir(fpath) and not fname.startswith("_"):
            return False

    for subdir in ("_markdown", "_markdown_backup", "_processed", "_stn_backup",
                   "_study_questions"):
        sp = os.path.join(course_dir, subdir)
        if os.path.isdir(sp):
            for entry in os.scandir(sp):
                if entry.is_file():
                    return False
    return True


def _find_csvs(course_dir: str) -> Dict[str, Optional[str]]:
    """
    Returns dict with keys 'syllabus', 'modules', 'topics', 'subtopics'
    pointing to absolute paths or None.
    """
    result = {
        "syllabus": None,
        "modules": None,
        "topics": None,
        "subtopics": None,
    }
    for fname in os.listdir(course_dir):
        lname = fname.lower()
        fpath = os.path.join(course_dir, fname)
        if not os.path.isfile(fpath):
            continue
        if lname == "syllabus_unified.csv":
            result["syllabus"] = fpath
        elif lname == "syllabus.csv" and result["syllabus"] is None:
            result["syllabus"] = fpath
        elif lname == "modules.csv":
            result["modules"] = fpath
        elif lname == "topics.csv":
            result["topics"] = fpath
        elif lname == "subtopics.csv":
            result["subtopics"] = fpath
    return result


def _collect_md_files(course_dir: str) -> List[Tuple[str, str]]:
    """
    Returns list of (abs_path, filename) for all Markdown files in:
      _markdown/, _markdown_backup/
    """
    results = []
    for subdir in ("_markdown", "_markdown_backup"):
        sp = os.path.join(course_dir, subdir)
        if os.path.isdir(sp):
            for fname in sorted(os.listdir(sp)):
                if fname.lower().endswith(".md"):
                    results.append((os.path.join(sp, fname), fname))
    return results


def _collect_root_pdfs(course_dir: str) -> List[Tuple[str, str]]:
    """Returns list of (abs_path, filename) for PDFs in the course root."""
    results = []
    for fname in sorted(os.listdir(course_dir)):
        if fname.lower().endswith(".pdf"):
            fpath = os.path.join(course_dir, fname)
            if os.path.isfile(fpath):
                results.append((fpath, fname))
    return results


# =============================================================================
# MARKER-BASED PDF → MARKDOWN
# =============================================================================

_marker_converter = None
_marker_loaded = False
_MARKER_AVAILABLE = False


def _load_marker():
    """Lazily load marker models once per process lifetime."""
    global _marker_converter, _marker_loaded, _MARKER_AVAILABLE
    if _marker_loaded:
        return
    _marker_loaded = True

    # New API (marker >= 0.3)
    try:
        from marker.converters.pdf import PdfConverter
        from marker.models import create_model_dict
        _marker_converter = PdfConverter(artifact_dict=create_model_dict())
        _MARKER_AVAILABLE = True
        logger.info("Pipeline: marker-pdf (new API) loaded ✓")
        return
    except Exception:
        pass

    # Legacy API (marker ~0.2)
    try:
        from marker.convert import convert_single_pdf  # noqa: F401
        from marker.models import load_all_models
        _marker_converter = load_all_models()
        _MARKER_AVAILABLE = True
        logger.info("Pipeline: marker-pdf (legacy API) loaded ✓")
        return
    except Exception:
        pass

    logger.warning("Pipeline: marker-pdf unavailable — falling back to pymupdf4llm/pdfplumber.")


# Try pymupdf4llm at import time (lightweight fallback)
_pymupdf4llm = None
try:
    import pymupdf4llm as _pymupdf4llm_mod
    _pymupdf4llm = _pymupdf4llm_mod
    logger.info("Pipeline: pymupdf4llm available as fallback.")
except ImportError:
    pass

try:
    import pdfplumber as _pdfplumber
except ImportError:
    _pdfplumber = None


def _pdf_to_markdown(fpath: str, fname: str) -> Optional[str]:
    """
    Convert PDF to Markdown.

    Priority:
      1. marker-pdf      — offline GPU model, best quality (math, tables, layout)
      2. pymupdf4llm     — fast CPU fallback, decent math
      3. pdfplumber      — plain text extraction
      4. PyMuPDF fitz    — last resort
    """
    # ── 1. marker ────────────────────────────────────────────────────────────
    _load_marker()
    if _MARKER_AVAILABLE and _marker_converter is not None:
        try:
            if hasattr(_marker_converter, "__call__"):
                rendered = _marker_converter(fpath)
                text = getattr(rendered, "markdown", None) or getattr(rendered, "text", None)
                if text and len(text.strip()) > 100:
                    logger.info(f"marker (new API): {fname} → {len(text)} chars")
                    return text
            else:
                from marker.convert import convert_single_pdf
                full_text, _, _ = convert_single_pdf(fpath, _marker_converter)
                if full_text and len(full_text.strip()) > 100:
                    logger.info(f"marker (legacy): {fname} → {len(full_text)} chars")
                    return full_text
        except Exception as e:
            logger.warning(f"marker failed for {fname}: {e}")

    # ── 2. pymupdf4llm ────────────────────────────────────────────────────────
    if _pymupdf4llm:
        try:
            md_text = _pymupdf4llm.to_markdown(fpath)
            if md_text and len(md_text.strip()) > 100:
                logger.info(f"pymupdf4llm: {fname} → {len(md_text)} chars")
                return md_text
        except Exception as e:
            logger.warning(f"pymupdf4llm failed for {fname}: {e}")

    # ── 3. pdfplumber ─────────────────────────────────────────────────────────
    if _pdfplumber:
        try:
            parts = []
            with _pdfplumber.open(fpath) as pdf:
                for page in pdf.pages:
                    t = page.extract_text()
                    if t:
                        parts.append(t)
            combined = "\n\n".join(parts)
            if combined.strip():
                logger.info(f"pdfplumber: {fname} → {len(combined)} chars")
                return combined
        except Exception as e:
            logger.warning(f"pdfplumber failed for {fname}: {e}")

    # ── 4. fitz ───────────────────────────────────────────────────────────────
    try:
        import fitz
        doc = fitz.open(fpath)
        pages = [doc[i].get_text() for i in range(len(doc))]
        doc.close()
        combined = "\n\n".join(p for p in pages if p.strip())
        if combined.strip():
            logger.info(f"fitz: {fname} → {len(combined)} chars")
            return combined
    except Exception as e:
        logger.warning(f"fitz failed for {fname}: {e}")

    return None


# =============================================================================
# STAGE 3 — QDRANT: chunk markdown and embed into main collection
# =============================================================================

def _chunk_and_embed(md_text: str, fname: str, course_name: str) -> int:
    """Chunk markdown text, embed, and upsert to main Qdrant collection.
    Returns chunk count."""
    try:
        import ai_core
        from vector_db_service import VectorDBService

        try:
            from app import vector_service
            vds = vector_service if vector_service is not None else VectorDBService()
        except Exception:
            vds = VectorDBService()

        chunks, _, _ = ai_core.process_document_for_qdrant(
            file_path="",
            original_name=fname,
            user_id=_COURSE_USER_ID,
            text_content_override=md_text,
        )
        if chunks:
            for chunk in chunks:
                meta = chunk.get("metadata", {})
                meta["course_name"] = course_name
                meta["source"] = "course_bootstrap"
                chunk["metadata"] = meta
            added = vds.add_processed_chunks(chunks)
            logger.info(f"Qdrant: upserted {added} chunks for {course_name}/{fname}")
            return added
        return 0
    except Exception as e:
        logger.error(f"Chunk/embed failed for {course_name}/{fname}: {e}", exc_info=True)
        return 0


# =============================================================================
# STAGE 3b — QDRANT INTEGRITY CHECK
# =============================================================================

def _verify_and_reingest_mds(
    course_name: str,
    md_files: List[Tuple[str, str]],
    state: PipelineState,
) -> int:
    """
    For every Markdown file in the course (both _markdown/ and _markdown_backup/),
    check whether it is properly represented in Qdrant.  Re-ingest any that are
    missing or whose SHA has changed.

    Returns count of files that required (re-)ingestion.
    """
    reingested = 0
    for fpath, fname in md_files:
        try:
            sha = _sha256(fpath)
            if state.is_md_ingested(sha):
                logger.debug(f"Qdrant integrity: {fname} already ingested ✓")
                continue

            logger.info(f"Qdrant integrity: {fname} missing — ingesting…")
            with open(fpath, "r", encoding="utf-8") as f:
                md_text = f.read()

            if md_text.strip():
                added = _chunk_and_embed(md_text, fname, course_name)
                if added > 0:
                    state.mark_md_ingested(sha, fname)
                    reingested += 1
                    logger.info(f"Qdrant integrity: re-ingested {fname} ({added} chunks)")
                else:
                    logger.warning(f"Qdrant integrity: ingestion returned 0 chunks for {fname}")
        except Exception as e:
            logger.error(f"Qdrant integrity: error for {fname}: {e}")

    logger.info(f"Qdrant integrity: {reingested}/{len(md_files)} file(s) re-ingested for '{course_name}'")
    return reingested


# =============================================================================
# STAGE 0 — CURRICULUM INGESTION
# =============================================================================

def _ingest_curriculum(course_name: str, course_dir: str):
    """Ingest the syllabus/curriculum into Neo4j (idempotent MERGE)."""
    csvs = _find_csvs(course_dir)
    try:
        import curriculum_graph_handler
        import syllabus_graph_handler

        if csvs["modules"] and csvs["topics"] and csvs["subtopics"]:
            curriculum_graph_handler.ingest_curriculum_from_csvs(
                course_name,
                csvs["modules"],
                csvs["topics"],
                csvs["subtopics"],
            )
            logger.info(f"Pipeline [{course_name}]: Curriculum ingested (3-CSV) ✓")

        elif csvs["syllabus"]:
            # Use the normalised Module→Topic→Subtopic schema so that
            # curriculum_graph_handler.traverse_curriculum() can read it.
            result = curriculum_graph_handler.ingest_from_unified_csv(
                course_name, csvs["syllabus"]
            )
            logger.info(
                f"Pipeline [{course_name}]: Curriculum ingested (syllabus.csv) ✓"
                f" — {result.get('modules_created',0)} modules, "
                f"{result.get('topics_created',0)} topics, "
                f"{result.get('subtopics_created',0)} subtopics"
            )

    except Exception as e:
        logger.error(f"Pipeline [{course_name}]: Curriculum ingestion failed: {e}")


# =============================================================================
# STAGE 5 — STN GENERATION
# =============================================================================

def _get_curriculum_structure(course_name: str) -> Optional[List[Dict]]:
    try:
        import curriculum_graph_handler
        curriculum = curriculum_graph_handler.traverse_curriculum(course_name)
        return curriculum.get("modules", [])
    except Exception as e:
        logger.warning(f"Could not fetch curriculum for '{course_name}': {e}")
        return None


def _generate_stn_for_course(
    course_name: str,
    markdown_dir: str,
    state: PipelineState,
    delay: float = 0.5,
) -> int:
    import subtopic_notes_generator as stn_gen

    modules = _get_curriculum_structure(course_name)
    if not modules:
        logger.warning(f"STN: No curriculum modules for '{course_name}' — skipping.")
        return 0

    all_markdown = ""
    if os.path.isdir(markdown_dir):
        for mf in sorted(os.listdir(markdown_dir)):
            if mf.lower().endswith(".md"):
                try:
                    with open(os.path.join(markdown_dir, mf), "r", encoding="utf-8") as f:
                        all_markdown += f"\n\n--- {mf} ---\n\n" + f.read()
                except Exception:
                    pass

    total = sum(
        len(t.get("subtopics", []))
        for m in modules
        for t in m.get("topics", [])
    )
    generated = 0
    logger.info(f"STN: Starting for '{course_name}' — {total} subtopics")

    for module in modules:
        for topic in module.get("topics", []):
            topic_id = topic.get("id", "")
            topic_name = topic.get("name", topic_id)
            for sub in topic.get("subtopics", []):
                sub_id = sub.get("id", "")
                sub_name = sub.get("name", sub_id)

                if state.is_stn_done(sub_id):
                    generated += 1
                    continue

                try:
                    result = stn_gen.generate_subtopic_notes(
                        course=course_name,
                        topic_id=topic_id,
                        topic_name=topic_name,
                        subtopic_id=sub_id,
                        subtopic_name=sub_name,
                        force=False,
                    )
                    if result:
                        state.mark_stn_done(sub_id)
                        generated += 1
                        logger.info(f"STN [{generated}/{total}]: {course_name}/{sub_id}")
                    else:
                        logger.warning(f"STN failed: {course_name}/{sub_id}")
                except Exception as e:
                    logger.error(f"STN error {course_name}/{sub_id}: {e}")

                if delay > 0:
                    time.sleep(delay)

    logger.info(f"STN: Completed {generated}/{total} for '{course_name}'")
    return generated


# =============================================================================
# STAGE 6 — STN → QDRANT
# =============================================================================

def _push_stn_to_qdrant(course_name: str, state: PipelineState) -> int:
    try:
        from qdrant_client import QdrantClient, models as qmodels

        stn_collection = getattr(config, "STN_QDRANT_COLLECTION", "stn_notes")
        client = QdrantClient(host=config.QDRANT_HOST, port=config.QDRANT_PORT)
        embed_model = config.get_embedding_model()
        if not embed_model:
            logger.warning("STN Qdrant: embedding model unavailable, skipping.")
            return 0

        # Detect the actual vector dimension of the stn_notes collection.
        # subtopic_notes_generator creates it with size=384 (its own embed model),
        # while config.DOCUMENT_VECTOR_DIMENSION may be 1024 — always match existing.
        try:
            coll_info = client.get_collection(stn_collection)
            stn_vector_dim = coll_info.config.params.vectors.size
        except Exception:
            stn_vector_dim = config.DOCUMENT_VECTOR_DIMENSION
            client.create_collection(
                collection_name=stn_collection,
                vectors_config=qmodels.VectorParams(
                    size=stn_vector_dim,
                    distance=qmodels.Distance.COSINE,
                ),
            )
            logger.info(f"Created Qdrant collection: {stn_collection} (dim={stn_vector_dim})")

        # If our main embed model dimension doesn't match the collection, use the
        # subtopic_notes_generator's own push helper which handles dimension correctly.
        embed_dim = len(embed_model.encode("test").tolist())
        if embed_dim != stn_vector_dim:
            logger.info(
                f"STN Qdrant: embed dim {embed_dim} != collection dim {stn_vector_dim}; "
                "delegating to subtopic_notes_generator push helper."
            )
            import subtopic_notes_generator as stn_gen_mod
            modules_check = _get_curriculum_structure(course_name)
            if not modules_check:
                return 0
            pushed = 0
            for module in modules_check:
                for topic in module.get("topics", []):
                    for sub in topic.get("subtopics", []):
                        sub_id = sub.get("id", "")
                        if state.is_stn_qdrant_done(sub_id):
                            pushed += 1
                            continue
                        stn_data = stn_gen_mod.get_subtopic_notes(course_name, sub_id)
                        if stn_data:
                            # Re-store: inline generator also handles Qdrant push
                            stn_gen_mod._store_subtopic_notes(course_name, sub_id, stn_data)
                            state.mark_stn_qdrant_done(sub_id)
                            pushed += 1
            logger.info(f"STN Qdrant (delegated): marked {pushed} done for '{course_name}'")
            return pushed

        import subtopic_notes_generator as stn_gen
        modules = _get_curriculum_structure(course_name)
        if not modules:
            return 0

        pushed = 0
        for module in modules:
            for topic in module.get("topics", []):
                for sub in topic.get("subtopics", []):
                    sub_id = sub.get("id", "")
                    sub_name = sub.get("name", sub_id)

                    if state.is_stn_qdrant_done(sub_id):
                        pushed += 1
                        continue

                    stn_data = stn_gen.get_subtopic_notes(course_name, sub_id)
                    if not stn_data or "teaching_context" not in stn_data:
                        continue

                    teaching_ctx = stn_data["teaching_context"]
                    if not teaching_ctx.strip():
                        continue

                    try:
                        embedding = embed_model.encode(teaching_ctx).tolist()
                        point = qmodels.PointStruct(
                            id=str(uuid.uuid5(
                                uuid.NAMESPACE_DNS, f"stn:{course_name}:{sub_id}"
                            )),
                            vector=embedding,
                            payload={
                                "course": course_name,
                                "topic_id": stn_data.get("topic_id", ""),
                                "topic_name": stn_data.get("topic_name", ""),
                                "subtopic_id": sub_id,
                                "subtopic_name": sub_name,
                                "teaching_context": teaching_ctx,
                                "concept": stn_data.get("concept", ""),
                                "key_points": stn_data.get("key_points", []),
                                "math": stn_data.get("math", ""),
                                "worked_example": stn_data.get("worked_example", ""),
                                "misconceptions": stn_data.get("misconceptions", []),
                                "type": "stn",
                            },
                        )
                        client.upsert(
                            collection_name=stn_collection, points=[point], wait=True
                        )
                        state.mark_stn_qdrant_done(sub_id)
                        pushed += 1
                    except Exception as e:
                        logger.error(f"STN Qdrant push failed {sub_id}: {e}")

        logger.info(f"STN Qdrant: pushed {pushed} vectors for '{course_name}'")
        return pushed

    except Exception as e:
        logger.error(f"STN Qdrant push error for '{course_name}': {e}", exc_info=True)
        return 0


# =============================================================================
# STAGE 7 — BACKUP MARKDOWN
# =============================================================================

def _backup_markdown(course_dir: str, state: PipelineState):
    if state.markdown_backup_done:
        return

    md_dir = os.path.join(course_dir, "_markdown")
    backup_dir = os.path.join(course_dir, "_markdown_backup")

    if not os.path.isdir(md_dir):
        state.markdown_backup_done = True
        return

    md_files = [f for f in os.listdir(md_dir) if f.lower().endswith(".md")]
    if not md_files:
        state.markdown_backup_done = True
        return

    _ensure_dirs(backup_dir)
    for mf in md_files:
        src = os.path.join(md_dir, mf)
        _move_to(src, backup_dir)

    state.markdown_backup_done = True
    logger.info(f"Markdown backup: moved {len(md_files)} files to {backup_dir}")


# =============================================================================
# STAGE 8 — STUDY QUESTIONS
# =============================================================================

def _generate_study_questions_for_course(
    course_name: str,
    state: PipelineState,
    delay: float = 0.5,
) -> int:
    """Generate study-mode questions for all subtopics not already done."""
    try:
        import study_questions_generator as sq_gen
        import subtopic_notes_generator as stn_gen

        modules = _get_curriculum_structure(course_name)
        if not modules:
            logger.warning(f"StudyQ: No curriculum for '{course_name}' — skipping.")
            return 0

        # Ensure the Qdrant collection exists
        sq_gen._ensure_qdrant_collection()

        total = sum(
            len(t.get("subtopics", []))
            for m in modules
            for t in m.get("topics", [])
        )
        done = 0
        logger.info(f"StudyQ: Starting for '{course_name}' — {total} subtopics")

        for module in modules:
            for topic in module.get("topics", []):
                topic_id = topic.get("id", "")
                topic_name = topic.get("name", topic_id)
                for sub in topic.get("subtopics", []):
                    sub_id = sub.get("id", "")
                    sub_name = sub.get("name", sub_id)

                    if state.is_questions_done(sub_id):
                        done += 1
                        continue

                    teaching_ctx = ""
                    try:
                        stn = stn_gen.get_subtopic_notes(course_name, sub_id)
                        if stn:
                            teaching_ctx = stn.get("teaching_context", "")
                    except Exception:
                        pass

                    result = sq_gen.generate_study_questions(
                        course=course_name,
                        topic_id=topic_id,
                        topic_name=topic_name,
                        subtopic_id=sub_id,
                        subtopic_name=sub_name,
                        teaching_context=teaching_ctx,
                    )
                    if result:
                        state.mark_questions_done(sub_id)
                        done += 1
                        logger.info(f"StudyQ [{done}/{total}]: {course_name}/{sub_id}")
                    else:
                        logger.warning(f"StudyQ failed: {course_name}/{sub_id}")

                    if delay > 0:
                        time.sleep(delay)

        logger.info(f"StudyQ: Completed {done}/{total} for '{course_name}'")
        return done

    except Exception as e:
        logger.error(f"StudyQ stage error for '{course_name}': {e}", exc_info=True)
        return 0


# =============================================================================
# STAGE 9 — SKILL TREE
# =============================================================================

def _generate_skill_tree_for_course(
    course_name: str,
    state: PipelineState,
) -> bool:
    """Generate prerequisite skill tree for the course and persist to Neo4j + disk."""
    if state.skill_tree_done:
        logger.debug(f"SkillTree: already done for '{course_name}'")
        return True

    try:
        import skill_tree_generator as stg

        modules = _get_curriculum_structure(course_name)
        if not modules:
            logger.warning(f"SkillTree: No curriculum for '{course_name}' — skipping.")
            return False

        result = stg.generate_skill_tree(course=course_name, modules=modules)
        if result:
            state.skill_tree_done = True
            logger.info(f"SkillTree: Done for '{course_name}' ✓")
            return True
        else:
            logger.warning(f"SkillTree: Generation failed for '{course_name}'")
            return False

    except Exception as e:
        logger.error(f"SkillTree stage error for '{course_name}': {e}", exc_info=True)
        return False


# =============================================================================
# STAGE 10 — PEDAGOGICAL LAYERS (L2 / L3 / L4 per subtopic)
# =============================================================================

def _generate_pedagogical_layers(
    course_name: str,
    markdown_dir: str,
    backup_md_dir: str,
    state: PipelineState,
    delay: float = 1.0,
) -> int:
    """
    For every curriculum subtopic, synthesize:
      L0 / L1  — seeded from existing STN (no LLM call)
      L2        — full technical depth exposition
      L3        — 3 worked examples (easy / medium / hard)
      L4        — 5 misconception analyses

    Results stored in Qdrant `pedagogical_notes` + Redis.
    Skips subtopics already marked done in pipeline_state.json.
    Returns count of subtopics completed.
    """
    try:
        import pedagogical_agent as ped_agent
        import subtopic_notes_generator as stn_gen

        modules = _get_curriculum_structure(course_name)
        if not modules:
            logger.warning(f"Pedagogy: No curriculum for '{course_name}' — skipping.")
            return 0

        # Concatenate all available markdown for context
        all_markdown = ""
        for md_dir in [markdown_dir, backup_md_dir]:
            if os.path.isdir(md_dir):
                for mf in sorted(os.listdir(md_dir)):
                    if mf.lower().endswith(".md"):
                        try:
                            with open(os.path.join(md_dir, mf), "r", encoding="utf-8") as f:
                                all_markdown += f"\n\n--- {mf} ---\n\n" + f.read()
                        except Exception:
                            pass

        ped_agent.setup_pedagogical_collection()

        total = sum(
            len(t.get("subtopics", []))
            for m in modules
            for t in m.get("topics", [])
        )
        done = 0
        logger.info(f"Pedagogy: Starting for '{course_name}' — {total} subtopics")

        for module in modules:
            for topic in module.get("topics", []):
                topic_name = topic.get("name", "")
                for sub in topic.get("subtopics", []):
                    sub_id   = sub.get("id", "")
                    sub_name = sub.get("name", sub_id)

                    if state.is_pedagogical_done(sub_id):
                        done += 1
                        continue

                    existing_stn = None
                    try:
                        existing_stn = stn_gen.get_subtopic_notes(course_name, sub_id)
                    except Exception:
                        pass

                    try:
                        results = ped_agent.synthesize_pedagogical_levels(
                            course=course_name,
                            subtopic_id=sub_id,
                            subtopic_name=sub_name,
                            topic_name=topic_name,
                            course_markdown=all_markdown,
                            existing_stn=existing_stn,
                        )
                        if results.get("L2"):
                            state.mark_pedagogical_done(sub_id)
                            done += 1
                            logger.info(f"Pedagogy [{done}/{total}]: {course_name}/{sub_id}")
                        else:
                            logger.warning(f"Pedagogy failed L2: {course_name}/{sub_id}")
                    except Exception as e:
                        logger.error(f"Pedagogy error {course_name}/{sub_id}: {e}")

                    if delay > 0:
                        time.sleep(delay)

        logger.info(f"Pedagogy: Completed {done}/{total} for '{course_name}'")
        return done

    except Exception as e:
        logger.error(f"Pedagogical stage error for '{course_name}': {e}", exc_info=True)
        return 0


# =============================================================================
# STAGE 11 — SCHOLARLY CLAIMS EXTRACTION
# =============================================================================

def _extract_scholarly_claims_for_course(
    course_name: str,
    course_dir: str,
    state: PipelineState,
) -> int:
    """
    For every markdown file in the course, extract atomic scholarly claims
    and store them in Qdrant `scholarly_claims` with source attribution.
    Idempotent — skips if state.scholarly_done is True.
    Returns total claims stored.
    """
    if state.scholarly_done:
        logger.debug(f"Scholarly: already done for '{course_name}'")
        return 0

    try:
        import scholarly_agent as schol_agent

        modules = _get_curriculum_structure(course_name)
        if not modules:
            return 0

        # Build subtopic_map for auto-tagging
        subtopic_map: Dict[str, str] = {}
        for module in modules:
            for topic in module.get("topics", []):
                for sub in topic.get("subtopics", []):
                    subtopic_map[sub.get("id", "")] = sub.get("name", "")

        schol_agent.setup_scholarly_collection()

        md_files = _collect_md_files(course_dir)
        total_claims = 0

        for fpath, fname in md_files:
            try:
                with open(fpath, "r", encoding="utf-8") as f:
                    md_text = f.read()
                count = schol_agent.extract_and_store_claims(
                    course=course_name,
                    source_file=fname,
                    md_text=md_text,
                    subtopic_map=subtopic_map,
                )
                total_claims += count
                logger.info(f"Scholarly: {count} claims from {fname}")
            except Exception as e:
                logger.error(f"Scholarly extraction error for {fname}: {e}")

        state.scholarly_done = True
        logger.info(f"Scholarly: {total_claims} total claims for '{course_name}' ✓")
        return total_claims

    except Exception as e:
        logger.error(f"Scholarly stage error for '{course_name}': {e}", exc_info=True)
        return 0


# =============================================================================
# STAGE 12 — CLEAR OLD RAW CHUNKS
# =============================================================================

def _clear_old_raw_chunks(course_name: str, state: PipelineState) -> bool:
    """
    Delete raw PDF chunks from the main Qdrant collection for this course.
    Only runs after pedagogical layers are fully built (Stage 10 done > 0).
    Only deletes vectors tagged source=course_bootstrap for this course —
    user-uploaded documents in the same collection are untouched.
    """
    if state.raw_chunks_cleared:
        return True

    try:
        from qdrant_client import QdrantClient
        from qdrant_client.models import Filter, FieldCondition, MatchValue

        client = QdrantClient(host=config.QDRANT_HOST, port=config.QDRANT_PORT)

        # Vectors ingested by the pipeline carry top-level payload fields:
        #   source = "course_bootstrap"  (set in _chunk_and_embed)
        #   course_name = <course_name>
        delete_filter = Filter(must=[
            FieldCondition(
                key="source",
                match=MatchValue(value="course_bootstrap"),
            ),
            FieldCondition(
                key="course_name",
                match=MatchValue(value=course_name),
            ),
        ])

        client.delete(
            collection_name=config.QDRANT_COLLECTION_NAME,
            points_selector=delete_filter,
            wait=True,
        )

        state.raw_chunks_cleared = True
        logger.info(
            f"Stage 12: cleared raw course_bootstrap chunks for '{course_name}' "
            f"from {config.QDRANT_COLLECTION_NAME} ✓"
        )
        return True

    except Exception as e:
        logger.error(f"Stage 12 clear raw chunks failed for '{course_name}': {e}", exc_info=True)
        return False


# =============================================================================
# STAGE 13 — LECTURE NOTES GENERATION
# =============================================================================

def _generate_lecture_notes(
    course_name: str,
    course_dir: str,
    backup_md_dir: str,
    state: PipelineState,
) -> bool:
    """
    Stage 13: Generate lecture notes (HTML + Markdown) per-module using the
    lecture_generator module.  Uses _markdown_backup/ as grounded source.
    Output lands in course_bootstrap/<Course>/lecture_notes/<module_name>/.

    Runs per-module so each KG extraction covers ~10 subtopics — well within
    the model's token budget.  Idempotent — skips if state.lecture_done True.
    """
    if state.lecture_done:
        logger.debug(f"Stage 13 lecture notes: already done for '{course_name}' — skipping.")
        return True

    try:
        import sys as _sys
        _repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
        if _repo_root not in _sys.path:
            _sys.path.insert(0, _repo_root)

        from lecture_generator.course_loader import load_course
        from lecture_generator.concept_extractor import extract_knowledge_graph
        from lecture_generator.note_writer import generate_all_notes
        from lecture_generator.concept_map import build_concept_map
        from lecture_generator.concept_tracker import track_coverage
        from lecture_generator.renderer import to_html, to_markdown

        source_dir = backup_md_dir if os.path.isdir(backup_md_dir) else os.path.join(course_dir, "_markdown")
        if not os.path.isdir(source_dir) or not os.listdir(source_dir):
            logger.warning(f"Stage 13: No source markdown for '{course_name}' — skipping lecture gen.")
            return False

        course = load_course(source_dir)
        if not course or not course.lectures:
            logger.warning(f"Stage 13: load_course returned empty for '{course_name}'")
            return False

        # Get module names from curriculum state — fall back to a single run if unavailable
        try:
            modules = curriculum_graph_handler.traverse_curriculum(course_name)
            module_names = [m.get("name", m.get("id", "")) for m in modules if m.get("name") or m.get("id")]
        except Exception:
            module_names = []

        if not module_names:
            module_names = [course_name]  # single-pass fallback

        out_root = os.path.join(course_dir, "lecture_notes")
        os.makedirs(out_root, exist_ok=True)

        logger.info(
            f"Stage 13 lecture gen: '{course_name}' — {len(module_names)} modules, "
            f"{len(course.lectures)} source files"
        )

        any_succeeded = False
        for module_name in module_names:
            try:
                topic_label = f"{course_name}: {module_name}"
                kg = extract_knowledge_graph(topic_label, course.combined_text)
                if not kg:
                    logger.warning(f"Stage 13: KG extraction failed for module '{module_name}'")
                    continue

                out_dir = os.path.join(out_root, module_name.replace("/", "_").replace(" ", "_"))
                os.makedirs(out_dir, exist_ok=True)

                coverage = track_coverage(kg.concepts, course)
                cm_path = os.path.join(out_dir, "concept_map.html")
                build_concept_map(kg, cm_path, coverage=coverage)

                notes = generate_all_notes(kg, coverage=coverage)

                html_path = os.path.join(out_dir, "lecture.html")
                html = to_html(kg, notes, concept_map_rel_path="concept_map.html",
                               coverage=coverage, lectures_count=len(course.lectures))
                with open(html_path, "w", encoding="utf-8") as fh:
                    fh.write(html)

                md_path = os.path.join(out_dir, "lecture.md")
                md = to_markdown(kg, notes, concept_map_rel_path="concept_map.html")
                with open(md_path, "w", encoding="utf-8") as fh:
                    fh.write(md)

                succeeded = sum(1 for _, n in notes if n is not None)
                logger.info(
                    f"Stage 13: module '{module_name}' done — "
                    f"{succeeded}/{len(kg.concepts)} concepts written to {out_dir}"
                )
                any_succeeded = True

            except Exception as module_err:
                logger.warning(f"Stage 13: module '{module_name}' failed: {module_err}")

        if any_succeeded:
            state.lecture_done = True
            logger.info(f"Stage 13 lecture gen: '{course_name}' complete — output: {out_root}")

        return any_succeeded

    except Exception as e:
        logger.error(f"Stage 13 lecture gen failed for '{course_name}': {e}", exc_info=True)
        return False


# =============================================================================
# DECOMMISSION
# =============================================================================

def _decommission_course(
    course_name: str,
    course_dir: str,
    summary: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Remove all traces of a course:
      1. Delete curriculum nodes from Neo4j (Module / Topic / Subtopic)
      2. Unassign / delete Qdrant vectors tagged with this course
      3. Delete the course directory on disk
    """
    logger.warning(
        f"Pipeline [{course_name}]: Directory empty — DECOMMISSIONING…"
    )
    try:
        neo4j_handler.decommission_course_curriculum(course_name)
    except Exception as e:
        logger.error(f"Pipeline [{course_name}]: Neo4j decommission failed: {e}")

    try:
        vds = VectorDBService()
        vds.unassign_course_from_vectors(course_name)
    except Exception as e:
        logger.error(f"Pipeline [{course_name}]: Qdrant decommission failed: {e}")

    try:
        shutil.rmtree(course_dir)
        logger.info(f"Pipeline [{course_name}]: DECOMMISSIONED and folder deleted ✓")
    except Exception as e:
        logger.error(f"Pipeline [{course_name}]: Folder delete failed: {e}")

    summary["status"] = "decommissioned"
    return summary


# =============================================================================
# MAIN PIPELINE — processes a single course end-to-end
# =============================================================================

def process_course(course_name: str, course_dir: str) -> Dict[str, Any]:
    """
    Run the full material processing pipeline for one course.
    Resumable — skips already-completed stages per PDF / per subtopic.
    """
    lock = _get_lock(course_name)
    if not lock.acquire(blocking=False):
        return {"course": course_name, "status": "already_running"}
    try:
        return _process_course_locked(course_name, course_dir)
    finally:
        lock.release()


def _process_course_locked(course_name: str, course_dir: str) -> Dict[str, Any]:
    """Internal: run pipeline with lock already held."""

    summary: Dict[str, Any] = {
        "course": course_name,
        "pdfs_converted": 0,
        "pdfs_deleted": 0,
        "qdrant_chunks": 0,
        "mds_reingested": 0,
        "stn_generated": 0,
        "stn_qdrant_pushed": 0,
        "study_questions_generated": 0,
        "skill_tree_done": False,
        "pedagogical_layers_done": 0,
        "scholarly_claims": 0,
        "raw_chunks_cleared": False,
        "lecture_generated": False,
        "status": "ok",
    }

    # ── Pre-check: empty directory → decommission ────────────────────────────
    if _is_course_empty(course_dir):
        return _decommission_course(course_name, course_dir, summary)

    state = PipelineState(course_dir)
    csvs = _find_csvs(course_dir)
    has_syllabus = bool(csvs["syllabus"] or csvs["modules"])

    markdown_dir = os.path.join(course_dir, "_markdown")
    _ensure_dirs(markdown_dir)

    # ── Stage 0: Curriculum ingestion into Neo4j ──────────────────────────────
    if has_syllabus:
        _ingest_curriculum(course_name, course_dir)

    # ── Stage 2–4: Process root PDFs with marker ─────────────────────────────
    root_pdfs = _collect_root_pdfs(course_dir)
    if root_pdfs:
        logger.info(f"Pipeline [{course_name}]: {len(root_pdfs)} PDF(s) to convert")

        for fpath, fname in root_pdfs:
            sha = _sha256(fpath)

            # ── 2a: PDF → Markdown ──────────────────────────────────────────
            if not state.is_pdf_done(sha, "markdown_done"):
                md_text = _pdf_to_markdown(fpath, fname)
                if md_text:
                    stem = os.path.splitext(fname)[0]
                    md_path = os.path.join(markdown_dir, stem + ".md")
                    with open(md_path, "w", encoding="utf-8") as f:
                        f.write(md_text)
                    state.mark_pdf(sha, fname, "markdown_done")
                    summary["pdfs_converted"] += 1
                    logger.info(f"Pipeline [{course_name}]: Markdown ✓ {fname}")
                else:
                    logger.warning(f"Pipeline [{course_name}]: Markdown FAILED for {fname}")
                    continue
            else:
                logger.debug(f"Pipeline [{course_name}]: markdown already done for {fname}")

            # ── 2b: Chunk + embed MD → Qdrant ───────────────────────────────
            if not state.is_pdf_done(sha, "qdrant_done"):
                stem = os.path.splitext(fname)[0]
                md_path = os.path.join(markdown_dir, stem + ".md")
                md_text_to_ingest = ""
                if os.path.exists(md_path):
                    with open(md_path, "r", encoding="utf-8") as f:
                        md_text_to_ingest = f.read()
                else:
                    # Re-convert if md was not saved yet
                    md_text_to_ingest = _pdf_to_markdown(fpath, fname) or ""

                if md_text_to_ingest:
                    added = _chunk_and_embed(md_text_to_ingest, fname, course_name)
                    summary["qdrant_chunks"] += added
                    # Also track the md file as ingested
                    if os.path.exists(md_path):
                        md_sha = _sha256(md_path)
                        state.mark_md_ingested(md_sha, stem + ".md")

                state.mark_pdf(sha, fname, "qdrant_done")
                logger.info(f"Pipeline [{course_name}]: Qdrant ✓ {fname}")

            # ── 2c: DELETE source PDF (not backup — save disk space) ──────────
            if not state.is_pdf_done(sha, "deleted"):
                try:
                    if os.path.exists(fpath):
                        os.remove(fpath)
                        summary["pdfs_deleted"] += 1
                        logger.info(f"Pipeline [{course_name}]: Deleted PDF {fname}")
                except Exception as e:
                    logger.warning(f"Pipeline [{course_name}]: Could not delete {fname}: {e}")
                state.mark_pdf(sha, fname, "deleted")

    # ── Stage Discovery: only syllabus, no PDFs, no MDs ──────────────────────
    md_files_existing = _collect_md_files(course_dir)
    if (
        has_syllabus
        and not root_pdfs
        and not md_files_existing
        and not state.discovery_done
    ):
        logger.info(f"Pipeline [{course_name}]: Only syllabus found — running deep discovery…")
        try:
            import material_discovery
            found = material_discovery.process_syllabus_discovery(
                course_dir, course_name
            )
            state.discovery_done = True
            if found > 0:
                logger.info(
                    f"Pipeline [{course_name}]: Discovery produced {found} MD file(s)"
                )
                # MD files were written directly to _markdown/ by discovery module
                md_files_existing = _collect_md_files(course_dir)
        except Exception as de:
            logger.error(f"Pipeline [{course_name}]: Discovery error: {de}")
            state.discovery_done = True  # Don't retry on every restart

    # ── Stage 3b: Qdrant integrity check for all existing MD files ───────────
    md_files_all = _collect_md_files(course_dir)
    if md_files_all:
        reingested = _verify_and_reingest_mds(course_name, md_files_all, state)
        summary["mds_reingested"] = reingested

    # ── Stage 5: STN generation ───────────────────────────────────────────────
    if has_syllabus:
        stn_count = _generate_stn_for_course(course_name, markdown_dir, state)
        summary["stn_generated"] = stn_count

        # ── Stage 6: STN → Qdrant ────────────────────────────────────────────
        stn_qdrant = _push_stn_to_qdrant(course_name, state)
        summary["stn_qdrant_pushed"] = stn_qdrant

        # ── Stage 7: Markdown backup ─────────────────────────────────────────
        _backup_markdown(course_dir, state)

        # ── Stage 8: Study Questions ─────────────────────────────────────────
        q_done = _generate_study_questions_for_course(course_name, state)
        summary["study_questions_generated"] = q_done

        # ── Stage 9: Skill Tree ───────────────────────────────────────────────
        st_done = _generate_skill_tree_for_course(course_name, state)
        summary["skill_tree_done"] = st_done

        # ── Stage 10: Pedagogical Layers (L2 / L3 / L4 per subtopic) ─────────
        backup_md_dir = os.path.join(course_dir, "_markdown_backup")
        ped_done = _generate_pedagogical_layers(
            course_name, markdown_dir, backup_md_dir, state
        )
        summary["pedagogical_layers_done"] = ped_done

        # ── Stage 11: Scholarly Claims Extraction ─────────────────────────────
        schol_count = _extract_scholarly_claims_for_course(course_name, course_dir, state)
        summary["scholarly_claims"] = schol_count

        # ── Stage 12: Clear Old Raw Chunks ────────────────────────────────────
        # Only clear after new pedagogical layer is built — preserves fallback
        if ped_done > 0:
            _clear_old_raw_chunks(course_name, state)
            summary["raw_chunks_cleared"] = state.raw_chunks_cleared

        # ── Stage 13: Lecture Notes Generation ────────────────────────────────
        lec_ok = _generate_lecture_notes(course_name, course_dir, backup_md_dir, state)
        summary["lecture_generated"] = lec_ok

    logger.info(f"Pipeline [{course_name}]: COMPLETE — {json.dumps(summary, default=str)}")
    return summary


# =============================================================================
# PROCESS ALL COURSES
# =============================================================================

def discover_courses(bootstrap_dir: str = None) -> List[Dict[str, str]]:
    """List all course folders in the bootstrap directory."""
    base = bootstrap_dir or BOOTSTRAP_DIR
    if not os.path.isdir(base):
        logger.warning(f"Bootstrap dir not found: {base}")
        return []

    courses = []
    for entry in sorted(os.listdir(base)):
        course_dir = os.path.join(base, entry)
        if not os.path.isdir(course_dir) or entry.startswith("_") or entry.startswith("."):
            continue
        has_csv = any(f.lower().endswith(".csv") for f in os.listdir(course_dir))
        has_pdfs = any(f.lower().endswith(".pdf") for f in os.listdir(course_dir))
        has_mds = bool(_collect_md_files(course_dir))
        if has_csv or has_pdfs or has_mds:
            courses.append({
                "name": entry,
                "dir": course_dir,
                "has_syllabus": has_csv,
                "has_pdfs": has_pdfs,
                "has_mds": has_mds,
            })
    return courses


def process_all_courses(
    bootstrap_dir: str = None,
    delay_between_courses: float = 2.0,
) -> Dict[str, Any]:
    """Scan bootstrap directory, process each course end-to-end."""
    base = bootstrap_dir or BOOTSTRAP_DIR
    courses = discover_courses(base)

    aggregate = {
        "bootstrap_dir": base,
        "courses_found": len(courses),
        "results": [],
    }

    for course_info in courses:
        course_name = course_info["name"]
        course_dir = course_info["dir"]
        logger.info(f"Pipeline: processing course '{course_name}' from {course_dir}")
        result = process_course(course_name, course_dir)
        aggregate["results"].append(result)
        if delay_between_courses > 0 and course_info != courses[-1]:
            time.sleep(delay_between_courses)

    return aggregate


def process_all_courses_background(
    bootstrap_dir: str = None,
    delay_between_courses: float = 2.0,
) -> threading.Thread:
    """Run process_all_courses in a background daemon thread."""
    def _worker():
        try:
            result = process_all_courses(bootstrap_dir, delay_between_courses)
            logger.info(
                f"Pipeline background: completed — {json.dumps(result, default=str)}"
            )
        except Exception as e:
            logger.error(f"Pipeline background error: {e}", exc_info=True)

    t = threading.Thread(target=_worker, daemon=True, name="material-pipeline")
    t.start()
    logger.info("Pipeline: background processing started.")
    return t


# =============================================================================
# STATUS
# =============================================================================

def get_pipeline_status(
    course_name: str = None, bootstrap_dir: str = None
) -> Dict[str, Any]:
    """Get pipeline status for one or all courses."""
    base = bootstrap_dir or BOOTSTRAP_DIR

    if course_name:
        course_dir = os.path.join(base, course_name)
        if not os.path.isdir(course_dir):
            return {"error": f"Course folder not found: {course_name}"}
        return _course_status(course_name, course_dir)

    courses = discover_courses(base)
    return {
        "bootstrap_dir": base,
        "courses": [_course_status(c["name"], c["dir"]) for c in courses],
    }


def _course_status(course_name: str, course_dir: str) -> Dict[str, Any]:
    state = PipelineState(course_dir)
    md_dir = os.path.join(course_dir, "_markdown")
    md_backup_dir = os.path.join(course_dir, "_markdown_backup")

    root_pdfs = [
        f for f in os.listdir(course_dir)
        if f.lower().endswith(".pdf") and os.path.isfile(os.path.join(course_dir, f))
    ]
    md_files = (
        [f for f in os.listdir(md_dir) if f.lower().endswith(".md")]
        if os.path.isdir(md_dir) else []
    )
    md_backup_files = (
        [f for f in os.listdir(md_backup_dir) if f.lower().endswith(".md")]
        if os.path.isdir(md_backup_dir) else []
    )

    return {
        "course": course_name,
        "pending_pdfs": len(root_pdfs),
        "markdown_files": len(md_files),
        "markdown_backed_up": len(md_backup_files),
        "stn_completed": len(state.data.get("stn_done", [])),
        "stn_qdrant_completed": len(state.data.get("stn_qdrant_done", [])),
        "study_questions_completed": len(state.data.get("questions_done", [])),
        "skill_tree_done": state.skill_tree_done,
        "discovery_done": state.discovery_done,
        "markdown_backup_done": state.markdown_backup_done,
        "lecture_done": state.lecture_done,
        "last_run": state.data.get("last_run"),
    }
