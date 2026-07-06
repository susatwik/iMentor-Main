# server/rag_service/material_discovery.py
"""
Deep Material Discovery
========================

When a course has only a syllabus CSV (no PDFs or Markdown) this module
searches multiple academic sources, downloads the best materials, converts
them to high-quality Markdown using marker-pdf, then deletes the raw PDFs.

Every discovered source URL is logged to ``material_sources.csv`` inside the
course directory so the team always knows where content came from.

Search sources (in priority order):
  1. Semantic Scholar  — academic papers & lecture notes (JSON API, no key needed)
  2. ArXiv             — preprints for ML / CS / maths topics
  3. DuckDuckGo        — general web search, filtered to PDF links

PDF → Markdown:
  Uses marker-pdf (offline, GPU-accelerated) for highest quality conversion.
  Falls back to pymupdf4llm → pdfplumber → fitz if marker is unavailable.
"""

import csv
import json
import logging
import os
import re
import time
import urllib.request
from typing import Dict, List, Optional, Tuple

import requests
from ddgs import DDGS

import config

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# MARKER IMPORT (loaded lazily to avoid startup cost on every service restart)
# ---------------------------------------------------------------------------
_marker_converter = None
_marker_loaded = False
_MARKER_AVAILABLE = False


def _load_marker():
    """Lazily load marker models once (expensive but offline-quality)."""
    global _marker_converter, _marker_loaded, _MARKER_AVAILABLE
    if _marker_loaded:
        return

    _marker_loaded = True  # prevent repeated load attempts on failure

    # Try new API (marker >= 0.3)
    try:
        from marker.converters.pdf import PdfConverter
        from marker.models import create_model_dict

        _marker_converter = PdfConverter(artifact_dict=create_model_dict())
        _MARKER_AVAILABLE = True
        logger.info("Discovery: marker-pdf (new API) loaded ✓")
        return
    except Exception:
        pass

    # Try legacy API (marker ~0.2)
    try:
        from marker.convert import convert_single_pdf  # noqa: F401
        from marker.models import load_all_models

        _marker_converter = load_all_models()
        _MARKER_AVAILABLE = True
        logger.info("Discovery: marker-pdf (legacy API) loaded ✓")
        return
    except Exception:
        pass

    logger.warning(
        "Discovery: marker-pdf not available — will fall back to pymupdf4llm/pdfplumber."
    )


def _pdf_to_markdown_marker(fpath: str) -> Optional[str]:
    """Convert PDF to Markdown using marker-pdf (offline, high quality)."""
    _load_marker()
    if not _MARKER_AVAILABLE or _marker_converter is None:
        return None

    try:
        # New API
        if hasattr(_marker_converter, "__call__"):
            rendered = _marker_converter(fpath)
            text = getattr(rendered, "markdown", None) or getattr(rendered, "text", None)
            if text and len(text.strip()) > 100:
                logger.info(f"Discovery: marker (new API) converted {os.path.basename(fpath)}: {len(text)} chars")
                return text
        else:
            # Legacy API — _marker_converter holds loaded models
            from marker.convert import convert_single_pdf
            full_text, _images, _meta = convert_single_pdf(fpath, _marker_converter)
            if full_text and len(full_text.strip()) > 100:
                logger.info(f"Discovery: marker (legacy API) converted {os.path.basename(fpath)}: {len(full_text)} chars")
                return full_text
    except Exception as e:
        logger.warning(f"Discovery: marker failed for {os.path.basename(fpath)}: {e}")
    return None


def _pdf_to_markdown_fallback(fpath: str) -> Optional[str]:
    """Fallback chain: pymupdf4llm → pdfplumber → fitz."""
    fname = os.path.basename(fpath)

    try:
        import pymupdf4llm
        md = pymupdf4llm.to_markdown(fpath)
        if md and len(md.strip()) > 100:
            logger.info(f"Discovery: pymupdf4llm converted {fname}: {len(md)} chars")
            return md
    except Exception:
        pass

    try:
        import pdfplumber
        parts = []
        with pdfplumber.open(fpath) as pdf:
            for page in pdf.pages:
                t = page.extract_text()
                if t:
                    parts.append(t)
        combined = "\n\n".join(parts)
        if combined.strip():
            logger.info(f"Discovery: pdfplumber extracted {fname}: {len(combined)} chars")
            return combined
    except Exception:
        pass

    try:
        import fitz
        doc = fitz.open(fpath)
        pages = [doc[i].get_text() for i in range(len(doc))]
        doc.close()
        combined = "\n\n".join(p for p in pages if p.strip())
        if combined.strip():
            logger.info(f"Discovery: fitz extracted {fname}: {len(combined)} chars")
            return combined
    except Exception:
        pass

    return None


def pdf_to_markdown(fpath: str) -> Optional[str]:
    """
    Convert a PDF file to Markdown.
    Tries marker first (best quality), then falls back.
    """
    md = _pdf_to_markdown_marker(fpath)
    if md:
        return md
    return _pdf_to_markdown_fallback(fpath)


# =============================================================================
# SOURCE LOGGING
# =============================================================================

def log_source(
    course_dir: str,
    course_name: str,
    topic: str,
    url: str,
    local_filename: str,
    quality_score: int,
    source_type: str,
    notes: str = "",
):
    """Append a discovery event to material_sources.csv inside the course directory."""
    log_path = os.path.join(course_dir, "material_sources.csv")
    file_exists = os.path.exists(log_path)

    with open(log_path, "a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if not file_exists:
            writer.writerow([
                "timestamp", "course", "topic", "source_type",
                "url", "local_filename", "quality_score", "notes",
            ])
        writer.writerow([
            time.strftime("%Y-%m-%dT%H:%M:%S"),
            course_name, topic, source_type,
            url, local_filename, quality_score, notes,
        ])


# =============================================================================
# VALIDATION (LLM-assisted)
# =============================================================================

def _call_llm(prompt: str) -> Optional[str]:
    """Simple LLM wrapper for validation (Gemini → Ollama)."""
    if config.GEMINI_API_KEY and not getattr(config, "_GEMINI_DEAD_DISCOVERY", False):
        try:
            from google import genai
            client = genai.Client(api_key=config.GEMINI_API_KEY)
            resp = client.models.generate_content(
                model=config.GEMINI_MODEL_NAME, contents=prompt
            )
            if resp.text:
                return resp.text.strip()
        except Exception as e:
            if "API_KEY_INVALID" in str(e) or "expired" in str(e).lower():
                setattr(config, "_GEMINI_DEAD_DISCOVERY", True)
            logger.warning(f"Discovery LLM: Gemini failed: {e}")

    try:
        ollama_url = getattr(config, "OLLAMA_BASE_URL", "http://localhost:11434")
        payload = json.dumps({
            "model": "qwen2.5:3b",
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": 0.1, "num_predict": 512},
        }).encode()
        req = urllib.request.Request(
            f"{ollama_url}/api/generate", data=payload,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read())
        return data.get("response", "").strip()
    except Exception as e:
        logger.error(f"Discovery LLM: Ollama failed: {e}")
    return None


def validate_material(file_path: str, course_name: str, topic: str) -> Tuple[bool, int, str]:
    """LLM-based relevance validation of a downloaded document."""
    try:
        import fitz
        doc = fitz.open(file_path)
        text = ""
        for i in range(min(len(doc), 3)):
            text += doc[i].get_text()
        doc.close()

        if len(text.strip()) < 200:
            return False, 0, "Too little text to validate."

        prompt = (
            f"Evaluate if this document is a high-quality academic resource for "
            f"the course '{course_name}' covering the topic '{topic}'.\n\n"
            f"DOCUMENT PREVIEW:\n{text[:2000]}\n\n"
            f"Respond ONLY with JSON: "
            f'{{ "relevant": true/false, "quality_score": 1-10, "reason": "short explanation" }}'
        )
        raw = _call_llm(prompt)
        if not raw:
            return True, 5, "LLM unavailable, assuming okay."

        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if m:
            data = json.loads(m.group())
            return (
                data.get("relevant", True),
                data.get("quality_score", 5),
                data.get("reason", ""),
            )
    except Exception as e:
        logger.warning(f"Discovery: Validation error for {file_path}: {e}")

    return True, 5, "Validation error, assuming okay."


# =============================================================================
# SEARCH BACKENDS
# =============================================================================

def _search_semantic_scholar(course_name: str, topic: str, max_results: int = 5) -> List[Dict]:
    """
    Query the Semantic Scholar open API.
    Returns list of {url, title, source_type} dicts.
    """
    results = []
    try:
        query = f"{course_name} {topic} lecture notes"
        url = "https://api.semanticscholar.org/graph/v1/paper/search"
        params = {
            "query": query,
            "limit": max_results * 2,
            "fields": "title,openAccessPdf,year",
        }
        resp = requests.get(url, params=params, timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            for paper in data.get("data", []):
                pdf_info = paper.get("openAccessPdf")
                if pdf_info and pdf_info.get("url"):
                    results.append({
                        "url": pdf_info["url"],
                        "title": paper.get("title", ""),
                        "source_type": "semantic_scholar",
                    })
                    if len(results) >= max_results:
                        break
        logger.info(f"Discovery SemanticScholar: {len(results)} links for '{topic}'")
    except Exception as e:
        logger.warning(f"Discovery SemanticScholar error: {e}")
    return results


def _search_arxiv(course_name: str, topic: str, max_results: int = 5) -> List[Dict]:
    """
    Query the ArXiv API for preprints.
    Returns list of {url, title, source_type} dicts.
    """
    results = []
    try:
        import urllib.parse
        query = urllib.parse.quote(f"{course_name} {topic}")
        url = (
            f"http://export.arxiv.org/api/query?"
            f"search_query=all:{query}&max_results={max_results * 2}&sortBy=relevance"
        )
        with urllib.request.urlopen(url, timeout=15) as r:
            content = r.read().decode("utf-8")

        # Extract PDF links from Atom feed
        pdf_links = re.findall(
            r'<link[^>]+title="pdf"[^>]+href="([^"]+)"', content
        )
        titles = re.findall(r"<title>([^<]+)</title>", content)

        for i, link in enumerate(pdf_links[:max_results]):
            pdf_url = link.replace("/abs/", "/pdf/") + ".pdf"
            results.append({
                "url": pdf_url,
                "title": titles[i + 1] if i + 1 < len(titles) else "",
                "source_type": "arxiv",
            })

        logger.info(f"Discovery ArXiv: {len(results)} links for '{topic}'")
    except Exception as e:
        logger.warning(f"Discovery ArXiv error: {e}")
    return results


def _search_duckduckgo(course_name: str, topic: str, max_results: int = 5) -> List[Dict]:
    """
    DuckDuckGo text search filtered to PDF links.
    Returns list of {url, title, source_type} dicts.
    """
    results = []
    query = f"{course_name} {topic} lecture notes filetype:pdf"
    try:
        with DDGS() as ddgs:
            for r in ddgs.text(query, max_results=max_results * 3):
                link = r.get("href", "")
                if link.lower().endswith(".pdf"):
                    results.append({
                        "url": link,
                        "title": r.get("title", ""),
                        "source_type": "duckduckgo",
                    })
                    if len(results) >= max_results:
                        break
        logger.info(f"Discovery DDG: {len(results)} PDF links for '{topic}'")
    except Exception as e:
        logger.error(f"Discovery DDG error for '{topic}': {e}")
    return results


def search_for_materials(
    course_name: str,
    topic: str,
    max_per_source: int = 3,
) -> List[Dict]:
    """
    Aggregate results from all search backends.
    Returns deduplicated list of {url, title, source_type}.
    """
    all_results: List[Dict] = []

    # Priority order: Semantic Scholar, ArXiv, DuckDuckGo
    all_results += _search_semantic_scholar(course_name, topic, max_per_source)
    all_results += _search_arxiv(course_name, topic, max_per_source)
    all_results += _search_duckduckgo(course_name, topic, max_per_source)

    # Deduplicate by URL
    seen: set = set()
    deduped = []
    for item in all_results:
        if item["url"] not in seen:
            seen.add(item["url"])
            deduped.append(item)

    logger.info(f"Discovery: {len(deduped)} unique sources for '{course_name}/{topic}'")
    return deduped


# Keep backward-compat alias used by older code paths
def search_for_pdf_materials(course_name: str, topic: str, max_results: int = 3) -> List[str]:
    """Backward-compatible wrapper — returns plain URL list."""
    return [c["url"] for c in search_for_materials(course_name, topic, max_results)]


# =============================================================================
# DOWNLOAD + CONVERT + LOG
# =============================================================================

def download_and_convert(
    url: str,
    dest_dir: str,
    course_dir: str,
    course_name: str,
    topic: str,
    source_type: str,
    title: str = "",
    quality_threshold: int = 5,
) -> Optional[str]:
    """
    Download a PDF from *url*, validate it, convert to Markdown with marker,
    save the .md file to *dest_dir*, log the source, and delete the raw PDF.

    Returns the path to the .md file, or None if skipped/failed.
    """
    fname_safe = re.sub(r"[^a-zA-Z0-9_-]", "_", topic)[:40]
    ts = str(int(time.time() % 100000))
    pdf_path = os.path.join(course_dir, f"Discovery_{fname_safe}_{ts}.pdf")

    try:
        logger.info(f"Discovery: Downloading {url} …")
        resp = requests.get(url, timeout=60, stream=True, allow_redirects=True)
        if resp.status_code != 200:
            logger.warning(f"Discovery: HTTP {resp.status_code} for {url}")
            return None

        ct = resp.headers.get("content-type", "")
        if "pdf" not in ct and not url.lower().endswith(".pdf"):
            logger.warning(f"Discovery: Non-PDF content-type '{ct}' for {url}")
            return None

        with open(pdf_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=65536):
                f.write(chunk)

    except Exception as e:
        logger.error(f"Discovery: Download failed {url}: {e}")
        _try_delete(pdf_path)
        return None

    # Validate relevance
    is_ok, score, reason = validate_material(pdf_path, course_name, topic)
    if not is_ok or score < quality_threshold:
        logger.warning(f"Discovery: REJECTED ({score}/10) {url}: {reason}")
        _try_delete(pdf_path)
        return None

    # Convert PDF → Markdown
    md_text = pdf_to_markdown(pdf_path)
    if not md_text:
        logger.warning(f"Discovery: Could not convert to Markdown: {url}")
        _try_delete(pdf_path)
        return None

    # Save Markdown
    os.makedirs(dest_dir, exist_ok=True)
    md_fname = f"Discovery_{fname_safe}_{ts}.md"
    md_path = os.path.join(dest_dir, md_fname)
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(f"# {title or topic}\n\n> Source: {url}\n\n")
        f.write(md_text)

    # Log the source
    log_source(
        course_dir=course_dir,
        course_name=course_name,
        topic=topic,
        url=url,
        local_filename=md_fname,
        quality_score=score,
        source_type=source_type,
        notes=title or reason,
    )

    # Delete raw PDF — we keep only Markdown
    _try_delete(pdf_path)
    logger.info(f"Discovery: ACCEPTED ({score}/10) → {md_fname}")
    return md_path


def _try_delete(path: str):
    try:
        if path and os.path.exists(path):
            os.remove(path)
    except Exception:
        pass


# =============================================================================
# READ TOPICS FROM SYLLABUS
# =============================================================================

def _topics_from_syllabus(syllabus_path: str, max_topics: int = 8) -> List[str]:
    """Extract the most important topic names from syllabus.csv."""
    topics: List[str] = []
    try:
        with open(syllabus_path, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                topic = (
                    row.get("Lecture Topic")
                    or row.get("Topic")
                    or row.get("topic")
                    or row.get("Subtopics")
                    or row.get("Title")
                    or next((v for v in row.values() if v and v.strip()), None)
                )
                if topic and topic.strip() and topic.strip() not in topics:
                    topics.append(topic.strip())
                if len(topics) >= max_topics:
                    break
    except Exception as e:
        logger.error(f"Discovery: Error reading syllabus: {e}")
    return topics


# =============================================================================
# MAIN ENTRY POINT
# =============================================================================

def process_syllabus_discovery(
    course_dir: str,
    course_name: str,
    min_materials: int = 3,
    quality_threshold: int = 5,
) -> int:
    """
    Run deep multi-source material discovery for a course that has only a
    syllabus CSV and no existing documents.

    Markdown files are written directly to _markdown/ so the main pipeline
    picks them up on the next scan.

    Returns the number of Markdown files successfully created.
    """
    # Find syllabus (prefer unified format)
    syllabus_path = os.path.join(course_dir, "syllabus_unified.csv")
    if not os.path.exists(syllabus_path):
        syllabus_path = os.path.join(course_dir, "syllabus.csv")
    if not os.path.exists(syllabus_path):
        for candidate in ["modules.csv", "topics.csv", "subtopics.csv"]:
            p = os.path.join(course_dir, candidate)
            if os.path.exists(p):
                syllabus_path = p
                break
        else:
            logger.warning(f"Discovery: No syllabus found in {course_dir}")
            return 0

    topics = _topics_from_syllabus(syllabus_path)
    if not topics:
        topics = [course_name]
    logger.info(f"Discovery: Starting for '{course_name}' — topics: {topics}")

    # Markdown goes directly into _markdown/ so the pipeline picks it up
    md_dest = os.path.join(course_dir, "_markdown")
    os.makedirs(md_dest, exist_ok=True)

    total_found = 0

    for topic in topics:
        if total_found >= min_materials * 2:
            break  # Enough material; don't over-download

        candidates = search_for_materials(course_name, topic, max_per_source=3)
        topic_found = 0

        for candidate in candidates:
            if topic_found >= 2:  # Max 2 files per topic
                break

            md_path = download_and_convert(
                url=candidate["url"],
                dest_dir=md_dest,
                course_dir=course_dir,
                course_name=course_name,
                topic=topic,
                source_type=candidate["source_type"],
                title=candidate.get("title", ""),
                quality_threshold=quality_threshold,
            )
            if md_path:
                topic_found += 1
                total_found += 1

            time.sleep(1)  # Polite delay between downloads

    logger.info(
        f"Discovery: Finished for '{course_name}'. "
        f"Created {total_found} Markdown file(s) in {md_dest}"
    )
    return total_found
