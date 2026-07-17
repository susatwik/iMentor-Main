import csv
import logging
import os
import re
from typing import Dict, List, Tuple

try:
    import file_parser
except Exception as exc:
    file_parser = None
    logging.getLogger(__name__).warning("file_parser unavailable: %s", exc)

logger = logging.getLogger(__name__)


def _normalize_id(value: str) -> str:
    value = (value or "").strip().lower()
    value = re.sub(r"[^a-z0-9]+", "_", value)
    return value.strip("_")


def extract_text_from_upload(file_path: str) -> str:
    """Extract text from PDF, DOCX, TXT, or image-like inputs using existing parsers.

    Image uploads must use OCR text only. We intentionally avoid falling back to
    raw binary reads for image files, because that produces metadata such as
    IHDR/PLTE/ICC instead of meaningful syllabus text.
    """
    _, ext = os.path.splitext(file_path)
    ext = ext.lower()
    is_image = ext in {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp"}

    if file_parser and hasattr(file_parser, "parse_file"):
        try:
            text = file_parser.parse_file(file_path)
            if isinstance(text, str) and text.strip():
                logger.info("OCR text extracted from %s (%d chars)", os.path.basename(file_path), len(text.strip()))
                return text.strip()
        except Exception as exc:
            logger.warning("Primary file parsing failed for %s: %s", file_path, exc)

    if is_image:
        logger.warning("Image OCR returned no readable text for %s; rejecting image syllabus upload.", os.path.basename(file_path))
        return ""

    try:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as handle:
            text = handle.read()
        return text.strip()
    except Exception:
        return ""


def build_outline_from_text(text: str, course_name: str) -> Dict:
    """Create a simple module/topic/subtopic outline from extracted text for any subject."""
    lines = [line.strip() for line in text.replace('\r', '\n').split('\n') if line.strip()]

    modules = []
    topics = []
    subtopics = []

    current_module = None
    current_topic = None

    def add_module(name: str):
        nonlocal current_module
        module_id = _normalize_id(name) or f"module_{len(modules)+1}"
        current_module = {"id": module_id, "name": name, "order": len(modules) + 1}
        modules.append(current_module)
        return current_module

    def add_topic(name: str, module_id: str):
        nonlocal current_topic
        topic_id = _normalize_id(name) or f"topic_{len(topics)+1}"
        current_topic = {"id": topic_id, "name": name, "module_id": module_id, "order": len(topics) + 1}
        topics.append(current_topic)
        return current_topic

    def add_subtopic(name: str, topic_id: str):
        subtopic_id = _normalize_id(name) or f"subtopic_{len(subtopics)+1}"
        subtopics.append({"id": subtopic_id, "name": name, "topic_id": topic_id, "order": len(subtopics) + 1})

    for raw in lines:
        line = raw.strip()
        lowered = line.lower()

        if re.match(r"^(module|unit|part)\b", lowered) or re.match(r"^\d+\s*\.\s*(module|unit|part)\b", lowered):
            name = re.sub(r"^(module|unit|part)\s*[:\-]?\s*", "", line, flags=re.I)
            add_module(name or f"Module {len(modules)+1}")
            continue

        if re.match(r"^#+\s+", line) or re.match(r"^\d+\s*\.\s+", line):
            name = re.sub(r"^#+\s*", "", line)
            name = re.sub(r"^\d+\s*\.\s*", "", name)
            if not current_module:
                add_module(course_name or "Course Overview")
            add_topic(name, current_module["id"])
            continue

        if line.startswith("- ") or line.startswith("* ") or line.startswith("• "):
            name = line[2:].strip()
            if current_topic:
                add_subtopic(name, current_topic["id"])
            elif current_module:
                add_topic(name, current_module["id"])
            else:
                add_module(course_name or "Course Overview")
                add_topic(name, current_module["id"])
            continue

    if not modules:
        add_module(course_name or "Course Overview")
    if not topics:
        for idx, line in enumerate(lines[:8], start=1):
            if len(line) > 4:
                add_topic(line, current_module["id"])
                break

    return {"course": course_name, "modules": modules, "topics": topics, "subtopics": subtopics}


def write_syllabus_csv(course_name: str, outline: Dict, output_path: str) -> str:
    """Write a unified syllabus.csv compatible with the existing pipeline."""
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["Module", "Lecture Number", "Lecture Topic", "Subtopics"])
        for module in outline.get("modules", []):
            module_topics = [t for t in outline.get("topics", []) if t.get("module_id") == module.get("id")]
            for topic in module_topics:
                related_subtopics = [s.get("name", "") for s in outline.get("subtopics", []) if s.get("topic_id") == topic.get("id")]
                writer.writerow([module.get("name", ""), topic.get("order", ""), topic.get("name", ""), "; ".join(related_subtopics)])
    return output_path
