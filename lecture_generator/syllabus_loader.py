"""
Syllabus loader — reads syllabus.csv as the authoritative course blueprint.

Expected format (columns can vary slightly — detected automatically):
    Module,Lecture Number,Lecture Topic,Subtopics[,Resources]

Returns a Syllabus object used to:
  - Guide concept extraction (structure-first, not LLM-invented)
  - Align lecture file ordering with canonical lecture numbers
  - Provide a module→topic hierarchy for the concept map
"""
import csv
import os
import re
import logging
from dataclasses import dataclass, field
from typing import List, Optional, Dict

logger = logging.getLogger(__name__)


# ── Data model ─────────────────────────────────────────────────────────────

@dataclass
class SyllabusEntry:
    module: str           # e.g. "Module 1"
    lecture_number: int   # 1-based
    topic: str            # e.g. "Introduction to Databases"
    subtopics: List[str]  # parsed from comma-separated string


@dataclass
class Syllabus:
    course_name: str
    source_path: str
    entries: List[SyllabusEntry] = field(default_factory=list)

    @property
    def modules(self) -> List[str]:
        """Unique module names in order."""
        seen = set()
        result = []
        for e in self.entries:
            if e.module not in seen:
                seen.add(e.module)
                result.append(e.module)
        return result

    @property
    def entries_by_module(self) -> Dict[str, List[SyllabusEntry]]:
        d: Dict[str, List[SyllabusEntry]] = {}
        for e in self.entries:
            d.setdefault(e.module, []).append(e)
        return d

    def to_prompt_block(self, max_entries: int = 60) -> str:
        """
        Format syllabus as a structured text block for LLM prompts.
        Truncated to max_entries if the course is very long.
        """
        lines = [f"COURSE SYLLABUS — {self.course_name}", ""]
        current_module = None
        count = 0
        for entry in self.entries:
            if count >= max_entries:
                remaining = len(self.entries) - count
                lines.append(f"  … and {remaining} more lectures …")
                break
            if entry.module != current_module:
                current_module = entry.module
                lines.append(f"\n{entry.module}:")
            sub_str = "; ".join(entry.subtopics[:6])  # cap for prompt length
            lines.append(
                f"  Lecture {entry.lecture_number}: {entry.topic}"
                + (f" | {sub_str}" if sub_str else "")
            )
            count += 1
        return "\n".join(lines)

    def concept_count_hint(self) -> int:
        """Suggest how many concepts to extract based on syllabus size."""
        # Roughly: 1 core concept per lecture topic + partial subtopic coverage
        total_subtopics = sum(len(e.subtopics) for e in self.entries)
        base = len(self.entries)
        # Cap at a practical range for the LLM
        return max(10, min(40, base + total_subtopics // 3))

    @property
    def summary(self) -> str:
        nm = len(self.modules)
        nl = len(self.entries)
        return f"{nm} modules, {nl} lectures"


# ── CSV parsing ────────────────────────────────────────────────────────────

# Column header aliases (handles slight naming variations)
_COL_MODULE   = re.compile(r"module", re.IGNORECASE)
_COL_LECNUM   = re.compile(r"lecture\s*(number|num|no\.?|#)?", re.IGNORECASE)
_COL_TOPIC    = re.compile(r"lecture\s*topic|topic", re.IGNORECASE)
_COL_SUBTOPIC = re.compile(r"subtopic", re.IGNORECASE)


def _detect_columns(headers: List[str]) -> Dict[str, int]:
    """Map logical column names to CSV column indices."""
    result: Dict[str, int] = {}
    for i, h in enumerate(headers):
        h = h.strip()
        if _COL_MODULE.match(h) and "module" not in result:
            result["module"] = i
        elif _COL_LECNUM.match(h) and "lecture_number" not in result:
            result["lecture_number"] = i
        elif _COL_TOPIC.match(h) and "topic" not in result:
            result["topic"] = i
        elif _COL_SUBTOPIC.match(h) and "subtopics" not in result:
            result["subtopics"] = i
    return result


def _parse_subtopics(raw: str) -> List[str]:
    """Split comma-separated subtopic string into a list."""
    if not raw:
        return []
    return [s.strip() for s in raw.split(",") if s.strip()]


def load_syllabus(csv_path: str, course_name: str = "") -> Optional["Syllabus"]:
    """
    Load syllabus.csv and return a Syllabus object.
    Returns None (with warning) if the file is missing or unreadable.
    """
    if not os.path.isfile(csv_path):
        return None

    entries: List[SyllabusEntry] = []
    try:
        with open(csv_path, "r", encoding="utf-8-sig", errors="ignore") as fh:
            reader = csv.reader(fh)
            headers = next(reader, None)
            if not headers:
                logger.warning("syllabus.csv is empty: %s", csv_path)
                return None

            cols = _detect_columns(headers)
            required = {"module", "lecture_number", "topic"}
            missing = required - cols.keys()
            if missing:
                logger.warning(
                    "syllabus.csv missing columns %s (found: %s). "
                    "Proceeding without syllabus structure.",
                    missing, headers
                )
                return None

            for row in reader:
                if not row or not any(row):
                    continue
                try:
                    module = row[cols["module"]].strip() or "Module 1"
                    lec_raw = row[cols["lecture_number"]].strip()
                    lec_num = int(re.search(r"\d+", lec_raw).group()) if re.search(r"\d+", lec_raw) else len(entries) + 1
                    topic = row[cols["topic"]].strip()
                    subtopics_raw = row[cols["subtopics"]].strip() if "subtopics" in cols and cols["subtopics"] < len(row) else ""
                    entries.append(SyllabusEntry(
                        module=module,
                        lecture_number=lec_num,
                        topic=topic,
                        subtopics=_parse_subtopics(subtopics_raw),
                    ))
                except (IndexError, AttributeError, ValueError) as exc:
                    logger.debug("Skipping malformed syllabus row %s: %s", row, exc)

    except OSError as exc:
        logger.warning("Cannot read syllabus.csv: %s", exc)
        return None

    if not entries:
        logger.warning("syllabus.csv had no valid rows: %s", csv_path)
        return None

    name = course_name or os.path.basename(os.path.dirname(csv_path))
    syl = Syllabus(course_name=name, source_path=csv_path, entries=entries)
    logger.info("Syllabus loaded: %s", syl.summary)
    return syl


def find_syllabus(course_dir: str, course_name: str = "") -> Optional["Syllabus"]:
    """
    Auto-detect syllabus.csv in a course directory.
    Tries: syllabus.csv, Syllabus.csv, SYLLABUS.csv
    """
    for candidate in ["syllabus_unified.csv", "syllabus.csv", "Syllabus.csv", "SYLLABUS.csv"]:
        path = os.path.join(course_dir, candidate)
        syl = load_syllabus(path, course_name=course_name)
        if syl is not None:
            return syl
    return None
