# server/rag_service/subtopic_lecture_generator.py
"""
Per-Subtopic Lecture Note Generator
====================================
Generates student-facing Markdown lecture notes for each curriculum subtopic
by combining STN teaching context (from Qdrant/Redis) with LLM generation.

Output format mirrors lecture_generator/note_writer.py:
  ## Subtopic Name
  ### Definition
  ### Intuition
  ### Mathematical Foundation   ($$…$$ KaTeX blocks)
  ### Diagram                   (```mermaid``` flowchart)
  ### Worked Example
  ### Key Takeaways
  ### Common Misconceptions

Results are cached to disk at:
  course_bootstrap/{course}/lecture_notes/subtopics/{subtopic_id}.md

On subsequent requests the file is served immediately (no LLM call needed).
This also acts as the offline pre-generation step: run
`generate_all_subtopic_lectures(course)` during course bootstrap.
"""

import json
import logging
import os
from typing import Optional

import config

# Import Provider Manager
try:
    from llm_provider_manager import get_llm_manager
    _PROVIDER_MANAGER_AVAILABLE = True
except ImportError:
    _PROVIDER_MANAGER_AVAILABLE = False
    logging.getLogger(__name__).warning("Provider Manager not available, using legacy LLM calls")

logger = logging.getLogger(__name__)


# ─── Disk cache ───────────────────────────────────────────────────────────────

def _find_course_bootstrap_dir(course: str) -> Optional[str]:
    """Return the course folder under course_bootstrap/, case-insensitive."""
    bootstrap_dir = config.COURSE_BOOTSTRAP_DIR
    course_lower = course.strip().lower()
    try:
        entries = [e for e in os.listdir(bootstrap_dir)
                   if os.path.isdir(os.path.join(bootstrap_dir, e))]
    except OSError:
        return None
    # Exact match first
    for e in entries:
        if e.lower() == course_lower:
            return os.path.join(bootstrap_dir, e)
    # Partial match
    for e in entries:
        if course_lower in e.lower() or e.lower() in course_lower:
            return os.path.join(bootstrap_dir, e)
    return None


def _subtopics_dir(course: str) -> str:
    """Return (and create) the per-subtopic cache directory."""
    course_dir = _find_course_bootstrap_dir(course)
    if course_dir:
        d = os.path.join(course_dir, "lecture_notes", "subtopics")
    else:
        d = os.path.join(config.COURSE_BOOTSTRAP_DIR,
                         course.replace(" ", "_"), "lecture_notes", "subtopics")
    os.makedirs(d, exist_ok=True)
    return d


def _cache_path(course: str, subtopic_id: str) -> str:
    return os.path.join(_subtopics_dir(course), f"{subtopic_id.lower()}.md")


def load_from_cache(course: str, subtopic_id: str) -> Optional[str]:
    path = _cache_path(course, subtopic_id)
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return f.read()
        except Exception as e:
            logger.warning(f"Subtopic lecture cache read failed: {e}")
    return None


def save_to_cache(course: str, subtopic_id: str, markdown: str) -> None:
    path = _cache_path(course, subtopic_id)
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(markdown)
        logger.info(f"Subtopic lecture cached: {path}")
    except Exception as e:
        logger.warning(f"Subtopic lecture cache write failed: {e}")


# ─── STN fetch ────────────────────────────────────────────────────────────────

def _fetch_stn(course: str, subtopic_id: str) -> Optional[dict]:
    """Fetch cached STN dict from subtopic_notes_generator (Redis→disk→Qdrant)."""
    try:
        import subtopic_notes_generator as sng
        return sng.get_subtopic_notes(course, subtopic_id)
    except Exception as e:
        logger.debug(f"STN fetch failed for {course}/{subtopic_id}: {e}")
    return None


def _build_context(subtopic_name: str, stn: Optional[dict]) -> str:
    """Assemble LLM context from STN fields."""
    if not stn:
        return (
            f"No pre-existing notes available. "
            f"Generate high-quality lecture content for '{subtopic_name}' "
            f"based on your knowledge."
        )
    parts = []
    if stn.get("teaching_context"):
        parts.append(f"TEACHING CONTEXT:\n{stn['teaching_context']}")
    if stn.get("concept"):
        parts.append(f"CONCEPT DEFINITION:\n{stn['concept']}")
    if stn.get("key_points"):
        kp = stn["key_points"]
        if isinstance(kp, list):
            kp = "\n".join(f"- {p}" for p in kp)
        parts.append(f"KEY POINTS:\n{kp}")
    if stn.get("math"):
        parts.append(f"MATHEMATICAL CONTENT (raw):\n{stn['math']}")
    if stn.get("worked_example"):
        parts.append(f"WORKED EXAMPLE:\n{stn['worked_example']}")
    if stn.get("misconceptions"):
        ms = stn["misconceptions"]
        if isinstance(ms, list):
            ms = "\n".join(f"- {m}" for m in ms)
        parts.append(f"COMMON MISCONCEPTIONS:\n{ms}")
    return "\n\n".join(parts) if parts else (
        f"Generate comprehensive lecture content for '{subtopic_name}'."
    )


# ─── LLM prompt ───────────────────────────────────────────────────────────────

_SYSTEM_PROMPT = (
    "You are an expert university-level AI/ML educator. "
    "You write crystal-clear, beautifully structured lecture notes in Markdown. "
    "Every equation must use $$ … $$ double-dollar blocks (on their own line). "
    "Every diagram must be a valid ```mermaid``` code block using graph TD or flowchart LR syntax. "
    "CRITICAL MERMAID RULES: Node labels must contain ONLY plain text — no LaTeX, no parentheses with backslashes, no special characters. "
    "Use simple words in node labels: write 'f(x)' as 'f of x', write Greek letters as words (alpha, beta, theta). "
    "Never use \\documentclass, \\begin{document}, or any LaTeX document commands. "
    "Never output raw JSON. Output only clean Markdown."
)

_USER_PROMPT_TMPL = """\
Write a complete, student-friendly lecture note in Markdown for the following concept.

CONCEPT   : {subtopic_name}
COURSE    : {course}
TOPIC     : {topic_name}

REFERENCE MATERIAL (use as knowledge base — rewrite clearly for students, do NOT copy verbatim):
---
{context}
---

OUTPUT the Markdown note using EXACTLY this structure:

## {subtopic_name}

### Definition
[2–3 precise sentences defining the concept.]

### Intuition
[2–3 paragraphs building intuition with analogies and real-world comparisons. Start simple, build up.]

### Mathematical Foundation
[If applicable: one or more key equations as KaTeX blocks:]

$$
equation here
$$

[Explain each symbol. If no math applies, write: "This concept is primarily qualitative — no specific formula is needed."]

### Diagram

```mermaid
[A clear flowchart (graph TD) or sequence diagram illustrating the concept. At least 5 nodes/steps. Make it genuinely explanatory, not just a list.]
```

*[One-sentence diagram caption.]*

### Worked Example

**Problem:** [A concrete, realistic problem statement.]

**Solution:**
[Step-by-step solution. Show all reasoning. Be specific with numbers/values where possible.]

### Key Takeaways
- [Most important point 1]
- [Most important point 2]
- [Most important point 3]
- [Most important point 4]

### Common Misconceptions
- ⚠️ **Misconception:** [Common wrong belief.] **Correction:** [What is actually true.]
- ⚠️ **Misconception:** [Another mistake.] **Correction:** [Clarification.]

RULES:
- Use proper Markdown throughout.
- All math MUST be in $$ … $$ blocks on their own lines (not inline $).
- The mermaid block must be syntactically valid Mermaid (graph TD or flowchart LR).
- Write at late-undergraduate level: precise but accessible.
- Do NOT wrap the entire response in a ```markdown``` fence.
"""


def _build_prompt(subtopic_name: str, course: str, topic_name: str,
                  context: str) -> str:
    return _USER_PROMPT_TMPL.format(
        subtopic_name=subtopic_name,
        course=course,
        topic_name=topic_name or "General",
        context=context,
    )


# ─── LLM call (SGLang → Gemini → Groq) ───────────────────────────────────────

def _call_sglang(prompt: str) -> Optional[str]:
    sglang_url   = os.getenv("SGLANG_HEAVY_URL",   "http://localhost:8000/v1")
    sglang_model = os.getenv("SGLANG_HEAVY_MODEL",  "Qwen/Qwen2.5-7B-Instruct-AWQ")
    try:
        from openai import OpenAI
        client = OpenAI(base_url=sglang_url, api_key="EMPTY")
        resp = client.chat.completions.create(
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user",   "content": prompt},
            ],
            model=sglang_model,
            temperature=0.35,
            max_tokens=2400,
            timeout=45,  # 45 s max — leaves room for Gemini/Groq fallback within proxy budget
        )
        text = (resp.choices[0].message.content or "").strip()
        if len(text) > 300:
            logger.info("Subtopic lecture generated via SGLang")
            return text
    except Exception as e:
        logger.debug(f"SGLang subtopic lecture failed: {e}")
    return None


def _call_gemini(prompt: str) -> Optional[str]:
    if not (getattr(config, "GEMINI_VALIDATED", False) and config.GEMINI_API_KEY):
        return None
    try:
        from google import genai
        from google.genai import types as genai_types
        safety = [
            genai_types.SafetySetting(category="HARM_CATEGORY_HARASSMENT",        threshold="BLOCK_NONE"),
            genai_types.SafetySetting(category="HARM_CATEGORY_HATE_SPEECH",       threshold="BLOCK_NONE"),
            genai_types.SafetySetting(category="HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold="BLOCK_NONE"),
            genai_types.SafetySetting(category="HARM_CATEGORY_DANGEROUS_CONTENT", threshold="BLOCK_NONE"),
        ]
        client = genai.Client(api_key=config.GEMINI_API_KEY)
        full_prompt = f"{_SYSTEM_PROMPT}\n\n{prompt}"
        resp = client.models.generate_content(
            model=config.GEMINI_MODEL_NAME,
            contents=full_prompt,
            config=genai_types.GenerateContentConfig(safety_settings=safety),
        )
        text = (resp.text or "").strip()
        if len(text) > 300:
            logger.info("Subtopic lecture generated via Gemini")
            return text
    except Exception as e:
        logger.debug(f"Gemini subtopic lecture failed: {e}")
    return None


def _call_groq(prompt: str) -> Optional[str]:
    groq_key = getattr(config, "GROQ_API_KEY", "") or ""
    if not groq_key.startswith("gsk_"):
        return None
    try:
        from groq import Groq
        model = getattr(config, "GROQ_MODEL_NAME", "llama-3.3-70b-versatile")
        client = Groq(api_key=groq_key)
        resp = client.chat.completions.create(
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user",   "content": prompt},
            ],
            model=model,
            temperature=0.35,
            max_tokens=2400,
        )
        text = (resp.choices[0].message.content or "").strip()
        if len(text) > 300:
            logger.info("Subtopic lecture generated via Groq")
            return text
    except Exception as e:
        logger.debug(f"Groq subtopic lecture failed: {e}")
    return None


def _call_llm(prompt: str) -> Optional[str]:
    """Provider Manager (SGLang → Grok → Gemini → Ollama)."""
    # Use Provider Manager if available
    if _PROVIDER_MANAGER_AVAILABLE:
        try:
            manager = get_llm_manager()
            result = manager.generate(
                messages=[
                    {"role": "system", "content": _SYSTEM_PROMPT},
                    {"role": "user",   "content": prompt},
                ],
                model=os.getenv("SGLANG_HEAVY_MODEL", "Qwen/Qwen2.5-7B-Instruct-AWQ"),
                temperature=0.35,
                max_tokens=2400,
            )
            if result and len(result.strip()) > 300:
                logger.info("Subtopic lecture generated via Provider Manager")
                return result.strip()
        except Exception as e:
            logger.debug(f"Provider Manager subtopic lecture failed: {e}")

    """Try Groq → Gemini → SGLang in order (fastest first)."""
    return _call_groq(prompt) or _call_gemini(prompt) or _call_sglang(prompt)


# ─── Post-processing ──────────────────────────────────────────────────────────

def _clean_markdown(raw: str, subtopic_name: str) -> str:
    """Strip outer ```markdown``` fence if the LLM added one."""
    text = raw.strip()
    if text.startswith("```markdown"):
        text = text[len("```markdown"):].strip()
        if text.endswith("```"):
            text = text[:-3].strip()
    elif text.startswith("```") and not text.startswith("```mermaid"):
        text = text[3:].strip()
        if text.endswith("```"):
            text = text[:-3].strip()
    if not text.startswith("##"):
        text = f"## {subtopic_name}\n\n{text}"
    return text


# ─── Public API ───────────────────────────────────────────────────────────────

def get_or_generate_lecture(
    course: str,
    subtopic_id: str,
    subtopic_name: str,
    topic_name: str = "",
) -> tuple[str, bool]:
    """
    Return (markdown, from_cache).

    1. Check disk cache → instant return
    2. Fetch STN context from Qdrant/Redis
    3. Build prompt and call LLM (SGLang → Gemini → Groq)
    4. Cache result to disk
    5. Return Markdown
    """
    name = subtopic_name or subtopic_id.replace("_", " ").title()

    # ── 1. Disk cache ──
    cached = load_from_cache(course, subtopic_id)
    if cached:
        logger.info(f"Subtopic lecture served from disk cache: {course}/{subtopic_id}")
        return cached, True

    # ── 2. STN context ──
    stn = _fetch_stn(course, subtopic_id)
    context = _build_context(name, stn)

    # ── 3. LLM generation ──
    prompt = _build_prompt(name, course, topic_name, context)
    raw = _call_llm(prompt)

    if raw:
        markdown = _clean_markdown(raw, name)
        save_to_cache(course, subtopic_id, markdown)
        return markdown, False

    # ── 4. Graceful stub (all LLMs down) ──
    stub = (
        f"## {name}\n\n"
        "> ⚠️ Lecture notes for this subtopic are being generated. "
        "Please try again in a moment, or use the **Ask AI** button "
        "to get an explanation via the tutor.\n"
    )
    return stub, False


def generate_all_subtopic_lectures(course: str, subtopics: list[dict]) -> None:
    """
    Offline batch generation — call this from the course bootstrap pipeline.
    `subtopics` is a list of dicts with keys: id, name, topic_name.
    Skips subtopics that already have a cached note.
    """
    logger.info(f"[batch] Generating per-subtopic lectures for '{course}' "
                f"({len(subtopics)} subtopics)")
    for sub in subtopics:
        sid   = sub.get("id", "")
        sname = sub.get("name", sid.replace("_", " ").title())
        tname = sub.get("topic_name", "")
        if not sid:
            continue
        if load_from_cache(course, sid):
            logger.debug(f"[batch] Already cached: {course}/{sid}")
            continue
        logger.info(f"[batch] Generating: {course}/{sid} ({sname})")
        try:
            get_or_generate_lecture(course, sid, sname, tname)
        except Exception as e:
            logger.warning(f"[batch] Failed for {course}/{sid}: {e}")
