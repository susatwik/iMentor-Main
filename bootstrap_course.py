#!/usr/bin/env python3
"""
iMentor Course Bootstrap — single command to set up a complete new course.
===========================================================================
Runs both pipelines from one command:

  A. RAG/Chat backend  — syllabus→Neo4j, PDFs→Qdrant, STN generation
  B. Lecture HTML      — concept graph, per-concept notes, interactive HTML

Both pipelines share the same syllabus load and concept extraction pass,
so concept extraction happens once and is reused by both.

Usage:
    python bootstrap_course.py "Machine Learning" \\
        --course-dir ./server/course_bootstrap/Machine\\ Learning/ \\
        --materials-dir ./server/course_bootstrap/Machine\\ Learning/

    # Skip one pipeline if already done:
    python bootstrap_course.py "DBMS" --course-dir ./server/course_bootstrap/DBMS/_markdown_backup/ --skip-rag
    python bootstrap_course.py "DBMS" --course-dir ./server/course_bootstrap/DBMS/_markdown_backup/ --skip-lecture

Requirements:
    pip install openai pydantic networkx pyvis pdfplumber redis
    RAG service must be running: conda run -n imentor python app.py
    SGLang must be running with SGLANG_ENABLED=true
"""

import argparse
import logging
import os
import sys
import time
import threading

sys.path.insert(0, os.path.dirname(__file__))

# ── Dependency check ────────────────────────────────────────────────────────
_missing = []
for pkg in ["openai", "pydantic", "networkx", "pyvis"]:
    try:
        __import__(pkg)
    except ImportError:
        _missing.append(pkg)
if _missing:
    print(f"❌  Missing packages: {', '.join(_missing)}")
    print(f"   Run:  pip install {' '.join(_missing)}")
    sys.exit(1)

# Import Provider Manager for LLM fallback
from server.rag_service.llm_provider_manager import get_llm_manager

from lecture_generator import config as lg_config
from lecture_generator import sglang_client
from lecture_generator.concept_extractor import extract_knowledge_graph, KnowledgeGraph
from lecture_generator.course_loader import load_course, Course
from lecture_generator.syllabus_loader import find_syllabus, Syllabus
from generate_lecture import run as run_lecture_pipeline

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)


# ── RAG pipeline trigger (calls the running Python RAG service) ────────────

def _trigger_rag_pipeline(
    course_name: str,
    syllabus_path: str,
    materials_dir: str,
    rag_url: str = "http://localhost:2001",
) -> bool:
    """POST to the RAG service to ingest the course (Neo4j + Qdrant + STN)."""
    try:
        import requests
        resp = requests.post(
            f"{rag_url}/course/ingest",
            json={
                "course_name": course_name,
                "syllabus_csv_path": syllabus_path,
                "materials_folder": materials_dir,
            },
            timeout=600,
        )
        if resp.ok:
            data = resp.json()
            print(f"    ✓  RAG pipeline: Neo4j={data.get('neo4j', {})}")
            print(f"    ✓  RAG pipeline: Qdrant chunks={data.get('qdrant', {}).get('total_chunks_added', '?')}")
            return True
        else:
            print(f"    ⚠  RAG service returned {resp.status_code}: {resp.text[:200]}")
            return False
    except ImportError:
        print("    ⚠  'requests' not installed — RAG pipeline trigger skipped.")
        print("       Run:  pip install requests")
        return False
    except Exception as exc:
        print(f"    ⚠  RAG service not reachable ({exc})")
        print(f"       Make sure it's running:  conda run -n imentor python app.py")
        return False


def _trigger_stn_from_kg(
    course_name: str,
    kg: KnowledgeGraph,
    rag_url: str = "http://localhost:2001",
) -> bool:
    """
    POST the concept graph to the RAG service to generate STN using
    concept-aware prompts (prerequisite + importance context).
    """
    try:
        import requests
        id_to_label = {c.id: c.label for c in kg.concepts}
        concepts_payload = []
        rel_map: dict = {}
        for rel in kg.relationships:
            rel_map.setdefault(rel.source, []).append(rel.target)
            rel_map.setdefault(rel.target, []).append(rel.source)

        for c in kg.concepts:
            concepts_payload.append({
                "label": c.label,
                "description": c.description,
                "importance": c.importance,
                "prereq_labels": [id_to_label.get(p, p) for p in c.prerequisites],
                "related_labels": [id_to_label.get(r, r) for r in rel_map.get(c.id, [])[:6]],
            })

        resp = requests.post(
            f"{rag_url}/course/stn_from_kg",
            json={"course_name": course_name, "concepts": concepts_payload},
            timeout=30,
        )
        if resp.ok:
            print(f"    ✓  STN (concept-aware) generation started in background")
            return True
        else:
            print(f"    ⚠  STN trigger returned {resp.status_code}")
            return False
    except Exception as exc:
        logger.debug("STN KG trigger failed: %s", exc)
        return False


# ── Main bootstrap ──────────────────────────────────────────────────────────

def bootstrap(
    course_name: str,
    course_dir: str,
    materials_dir: str = "",
    skip_rag: bool = False,
    skip_lecture: bool = False,
    output_root: str = "",
    rag_url: str = "http://localhost:2001",
) -> None:
    materials_dir = materials_dir or course_dir
    # Find syllabus (shared by both pipelines)
    syllabus = find_syllabus(course_dir, course_name=course_name)
    if not syllabus:
        syllabus = find_syllabus(materials_dir, course_name=course_name)

    print(f"\n{'='*60}")
    print(f"  iMentor Course Bootstrap: {course_name}")
    print(f"{'='*60}")
    if syllabus:
        print(f"  Syllabus : {syllabus.summary}")
        print(f"             {syllabus.source_path}")
    else:
        print(f"  Syllabus : ⚠  not found — concept structure inferred by LLM")
    print(f"  Course dir: {course_dir}")
    print(f"  Materials : {materials_dir}")
    print(f"  RAG service: {rag_url}")
    print()

    # ── Step 1: Load course text ───────────────────────────────────────────
    print("📂  Loading course files …", flush=True)
    try:
        course = load_course(course_dir, course_name=course_name)
        print(f"    ✓  {course.summary}", flush=True)
    except (FileNotFoundError, ValueError) as exc:
        print(f"    ⚠  Could not load course files from {course_dir}: {exc}")
        course = None

    # ── Step 2: Extract concept graph (shared between both pipelines) ──────
    source_text = course.combined_text if course else ""
    print("\n🧠  Extracting concept graph (shared) …", flush=True)
    if syllabus:
        print(f"    Blueprint: {syllabus.summary} → ~{syllabus.concept_count_hint()} concepts", flush=True)

    lg_config.validate()
    
    # Use Provider Manager for health check and fallback
    llm_manager = get_llm_manager()
    health_results = llm_manager.check_all_health()
    healthy_provider = llm_manager.get_healthy_provider()
    if healthy_provider:
        print(f"    ✓  LLM Provider: {healthy_provider.config.name}", flush=True)
    else:
        print(f"    ⚠  No healthy LLM provider found — concept extraction may fail", flush=True)
        for ptype, result in health_results.items():
            status = "✅" if result.healthy else "❌"
            print(f"       {status} {ptype.value}", flush=True)

    kg = extract_knowledge_graph(course_name, source_text, syllabus=syllabus)
    if kg:
        print(f"    ✓  {len(kg.concepts)} concepts, {len(kg.relationships)} relationships\n", flush=True)
    else:
        print("    ❌  Concept extraction failed — continuing with pipelines anyway\n", flush=True)

    t_start = time.time()

    # ── Step 3A: RAG pipeline (background-friendly) ────────────────────────
    rag_ok = False
    if not skip_rag:
        print("🗄   Pipeline A — RAG backend (Neo4j + Qdrant + STN) …", flush=True)
        syllabus_path = syllabus.source_path if syllabus else ""
        if not syllabus_path:
            print("    ⚠  No syllabus.csv found — Neo4j curriculum graph will be empty")

        rag_ok = _trigger_rag_pipeline(course_name, syllabus_path, materials_dir, rag_url)

        # Trigger concept-aware STN generation using our KG
        if rag_ok and kg:
            _trigger_stn_from_kg(course_name, kg, rag_url)

    # ── Step 3B: Lecture HTML pipeline ────────────────────────────────────
    if not skip_lecture:
        print("\n📚  Pipeline B — Lecture HTML notes …", flush=True)
        run_lecture_pipeline(
            topic=course_name,
            source_text=source_text,
            course=course,
            syllabus=syllabus,
            output_root=output_root,
        )

    # ── Step 3C: Per-subtopic lecture generation ──────────────────────────
    # Generate one lecture note (definition + intuition + diagram + math +
    # examples) per syllabus subtopic.  Uses LLM + cached STN data.
    # Results are written to course_bootstrap/{course}/lecture_notes/subtopics/
    # so the RAG /curriculum/{course}/lecture/{subtopic_id} endpoint is instant.
    if not skip_rag and syllabus:
        print("\n✏️   Pipeline C — Per-subtopic lecture notes …", flush=True)
        try:
            import sys as _sys, os as _os, re as _re
            _rag_service_dir = _os.path.join(_os.path.dirname(__file__), "server", "rag_service")
            if _rag_service_dir not in _sys.path:
                _sys.path.insert(0, _rag_service_dir)
            import subtopic_lecture_generator as _slg

            def _to_id(name: str) -> str:
                """Convert subtopic display name to id (mirrors curriculum_graph_handler)."""
                s = name.lower().strip()
                s = _re.sub(r"[^a-z0-9\s_]", "", s)
                s = _re.sub(r"[\s]+", "_", s)
                return s

            # Build flat subtopic list from syllabus entries
            subtopics_flat = []
            for entry in syllabus.entries:
                topic_name = entry.topic or ""
                for sub_name in entry.subtopics:
                    sub_name = sub_name.strip()
                    if not sub_name:
                        continue
                    subtopics_flat.append({
                        "id":         _to_id(sub_name),
                        "name":       sub_name,
                        "topic_name": topic_name,
                    })

            if subtopics_flat:
                print(f"    Generating for {len(subtopics_flat)} subtopics …", flush=True)
                _slg.generate_all_subtopic_lectures(course_name, subtopics_flat)
                print("    ✓  Per-subtopic lectures done", flush=True)
            else:
                print("    ⚠  No subtopics found in syllabus — skipping", flush=True)
        except Exception as _e:
            print(f"    ⚠  Per-subtopic lecture generation failed: {_e}", flush=True)

    elapsed = time.time() - t_start
    print(f"\n{'='*60}")
    print(f"  Bootstrap complete in {elapsed:.0f}s")
    if not skip_rag:
        print(f"  RAG backend: {'✓ done' if rag_ok else '⚠ check RAG service logs'}")
    if not skip_lecture:
        print(f"  Lecture HTML: ✓ check lectures/ folder")
    print(f"{'='*60}\n")


# ── CLI ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Bootstrap a complete iMentor course (RAG backend + lecture HTML).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("course_name", help='Course name, e.g. "Machine Learning"')
    parser.add_argument(
        "--course-dir", "-c", required=True, metavar="DIR",
        help="Folder of lecture files (.pdf .md .txt) for lecture HTML generation",
    )
    parser.add_argument(
        "--materials-dir", "-m", metavar="DIR", default="",
        help="Folder of raw PDFs for Qdrant ingestion (defaults to --course-dir)",
    )
    parser.add_argument(
        "--out", "-o", metavar="DIR", default="",
        help="Output root for lecture HTML (default: lectures/ in repo root)",
    )
    parser.add_argument(
        "--rag-url", default="http://localhost:2001",
        help="RAG service base URL (default: http://localhost:2001)",
    )
    parser.add_argument(
        "--skip-rag", action="store_true",
        help="Skip RAG/Neo4j/Qdrant pipeline (lecture HTML only)",
    )
    parser.add_argument(
        "--skip-lecture", action="store_true",
        help="Skip lecture HTML generation (RAG pipeline only)",
    )
    parser.add_argument(
        "--model", metavar="MODEL_ID",
        help="Override SGLANG_HEAVY_MODEL for this run",
    )
    parser.add_argument(
        "--url", metavar="URL",
        help="Override SGLANG_HEAVY_URL for this run",
    )
    args = parser.parse_args()

    if args.model:
        lg_config.LG_MODEL = args.model
    if args.url:
        lg_config.LG_URL = args.url

    bootstrap(
        course_name=args.course_name,
        course_dir=args.course_dir,
        materials_dir=args.materials_dir,
        skip_rag=args.skip_rag,
        skip_lecture=args.skip_lecture,
        output_root=args.out,
        rag_url=args.rag_url,
    )


if __name__ == "__main__":
    main()
