# server/rag_service/study_questions_generator.py
"""
Study Mode Question Bank Generator
====================================

For each curriculum subtopic this module generates a rich, levelled question
bank that feeds the frontend Study Mode:

  MCQ         — 15 multiple-choice questions (5 beginner / 6 intermediate / 4 advanced)
  Short-Answer — 3 open-ended conceptual questions
  Flashcards  — 5 term → definition cards

The generator leverages the pre-computed Subtopic Teaching Notes (STN)
`teaching_context` field as its primary source, so it DOES NOT require
a live Qdrant search at generation time.

Storage (3-tier, all idempotent):
  1. Disk backup  → course_bootstrap/<Course>/_study_questions/<subtopic_id>.json
  2. Redis cache  → study_q:<course>:<subtopic_id>   (7-day TTL)
  3. Qdrant       → `study_questions` collection (semantic retrieval)

System-prompt design:
  The STUDY_QUESTIONS_GENERATION_PROMPT (in prompts.py) is engineered to:
    - Anchor every question to the teaching_context (no hallucination)
    - Enforce Bloom's taxonomy difficulty calibration
    - Produce self-contained flashcard backs
    - Output strict JSON for zero-post-processing parsing
"""

import json
import logging
import os
import re
import time
import uuid
from typing import Dict, List, Optional

import config
from sglang_caps import get_model_max_context
from prompts import STUDY_QUESTIONS_GENERATION_PROMPT

# Import Provider Manager
try:
    from llm_provider_manager import get_llm_manager
    _PROVIDER_MANAGER_AVAILABLE = True
except ImportError:
    _PROVIDER_MANAGER_AVAILABLE = False
    logging.getLogger(__name__).warning("Provider Manager not available, using legacy LLM calls")

logger = logging.getLogger(__name__)

_CACHE_TTL = 7 * 24 * 3600  # 7 days

# ── Redis ─────────────────────────────────────────────────────────────────────
try:
    from cache_service import cache_service as _redis
    _REDIS_OK = True
except Exception:
    _redis = None
    _REDIS_OK = False
    logger.warning("study_questions: Redis not available — disk backup only.")


# =============================================================================
# DISK BACKUP HELPERS
# =============================================================================

def _questions_backup_dir(course: str) -> str:
    base = os.path.join(
        os.path.dirname(__file__), "..", "course_bootstrap",
        course, "_study_questions",
    )
    os.makedirs(base, exist_ok=True)
    return base


def _save_questions_backup(course: str, subtopic_id: str, payload: Dict):
    try:
        path = os.path.join(_questions_backup_dir(course), f"{subtopic_id}.json")
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
        logger.debug(f"StudyQ backup written: {course}/{subtopic_id}")
    except Exception as e:
        logger.warning(f"StudyQ backup write failed {course}/{subtopic_id}: {e}")


def _load_questions_backup(course: str, subtopic_id: str) -> Optional[Dict]:
    try:
        path = os.path.join(_questions_backup_dir(course), f"{subtopic_id}.json")
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception as e:
        logger.warning(f"StudyQ backup read failed {course}/{subtopic_id}: {e}")
    return None


# =============================================================================
# REDIS CACHE HELPERS
# =============================================================================

def _cache_key(course: str, subtopic_id: str) -> str:
    return f"study_q:{course.lower()}:{subtopic_id.lower()}"


def _cache_get(course: str, subtopic_id: str) -> Optional[Dict]:
    if not _REDIS_OK:
        return None
    try:
        return _redis.get_cache(_cache_key(course, subtopic_id))
    except Exception:
        return None


def _cache_set(course: str, subtopic_id: str, payload: Dict):
    if not _REDIS_OK:
        return
    try:
        _redis.set_cache(_cache_key(course, subtopic_id), payload, expire_seconds=_CACHE_TTL)
    except Exception:
        pass


# =============================================================================
# QDRANT PERSISTENCE
# =============================================================================

_STUDY_Q_COLLECTION = getattr(config, "STUDY_QUESTIONS_COLLECTION", "study_questions")


def _ensure_qdrant_collection():
    """Create study_questions collection if it doesn't exist."""
    try:
        from qdrant_client import QdrantClient, models as qmodels
        client = QdrantClient(host=config.QDRANT_HOST, port=config.QDRANT_PORT)
        try:
            client.get_collection(_STUDY_Q_COLLECTION)
        except Exception:
            client.create_collection(
                collection_name=_STUDY_Q_COLLECTION,
                vectors_config=qmodels.VectorParams(
                    size=config.DOCUMENT_VECTOR_DIMENSION,
                    distance=qmodels.Distance.COSINE,
                ),
            )
            logger.info(f"StudyQ: Created Qdrant collection '{_STUDY_Q_COLLECTION}'")
    except Exception as e:
        logger.warning(f"StudyQ: Could not ensure Qdrant collection: {e}")


def _push_questions_to_qdrant(course: str, subtopic_id: str, payload: Dict) -> bool:
    """
    Push a single representative embedding for each subtopic's question bank.
    The full JSON payload is stored as Qdrant point metadata so it can be
    retrieved without a separate DB call.
    """
    try:
        from qdrant_client import QdrantClient, models as qmodels

        embed_model = config.get_embedding_model()
        if not embed_model:
            return False

        # Embed a combined index text for semantic retrieval
        index_text = (
            f"{course} {payload.get('topic_name', '')} {payload.get('subtopic_name', '')} "
            + " ".join(q.get("question", "") for q in payload.get("mcq", [])[:3])
        )
        vector = embed_model.encode(index_text).tolist()

        client = QdrantClient(host=config.QDRANT_HOST, port=config.QDRANT_PORT)
        point_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"studyq:{course}:{subtopic_id}"))

        from qdrant_client.models import PointStruct
        client.upsert(
            collection_name=_STUDY_Q_COLLECTION,
            points=[PointStruct(
                id=point_id,
                vector=vector,
                payload={
                    "course": course,
                    "subtopic_id": subtopic_id,
                    "subtopic_name": payload.get("subtopic_name", ""),
                    "topic_name": payload.get("topic_name", ""),
                    "mcq": payload.get("mcq", []),
                    "short_answer": payload.get("short_answer", []),
                    "flashcards": payload.get("flashcards", []),
                    "type": "study_questions",
                },
            )],
            wait=True,
        )
        logger.debug(f"StudyQ: Qdrant upsert ok for {course}/{subtopic_id}")
        return True
    except Exception as e:
        logger.warning(f"StudyQ: Qdrant push failed {course}/{subtopic_id}: {e}")
        return False


# =============================================================================
# LLM CALL  —  Provider Manager (SGLang → Grok → Gemini → Ollama)
# =============================================================================

_sglang_client = None
if config.SGLANG_ENABLED:
    try:
        from openai import OpenAI as _OAI
        _sglang_client = _OAI(base_url=config.SGLANG_HEAVY_URL, api_key="EMPTY")
        logger.info(f"StudyQ: SGLang client ready ({config.SGLANG_HEAVY_MODEL})")
    except Exception as _e:
        logger.warning(f"StudyQ: SGLang client init failed: {_e}")

_gemini_dead = False


def _call_llm(prompt: str) -> Optional[str]:
    """Provider Manager (SGLang → Grok → Gemini → Ollama)."""
    global _gemini_dead

    # Use Provider Manager if available
    if _PROVIDER_MANAGER_AVAILABLE:
        try:
            manager = get_llm_manager()
            system_msg = "You are an expert curriculum designer. Output only valid JSON."
            result = manager.generate(
                messages=[
                    {"role": "system", "content": system_msg},
                    {"role": "user",   "content": prompt},
                ],
                model=config.SGLANG_HEAVY_MODEL,
                temperature=0.3,
                max_tokens=4000,
            )
            if result:
                text = result.strip()
                logger.info(f"StudyQ LLM: Provider Manager ok ({len(text)} chars)")
                return text
        except Exception as e:
            logger.warning(f"StudyQ LLM: Provider Manager failed: {e}")

    # ── 1. SGLang (primary — legacy fallback) ───────────────────────────────────
    if _sglang_client:
        try:
            _SGLANG_MAX_CONTEXT = get_model_max_context()
            _SAFETY_BUFFER = 256
            system_msg = "You are an expert curriculum designer. Output only valid JSON."
            estimated_input_tokens = int((len(system_msg) + len(prompt)) / 3.5)
            safe_max_tokens = max(512, _SGLANG_MAX_CONTEXT - estimated_input_tokens - _SAFETY_BUFFER)
            resp = _sglang_client.chat.completions.create(
                model=config.SGLANG_HEAVY_MODEL,
                messages=[
                    {"role": "system", "content": system_msg},
                    {"role": "user",   "content": prompt},
                ],
                temperature=0.3,
                max_tokens=safe_max_tokens,
            )
            text = resp.choices[0].message.content.strip() if resp.choices else ""
            if text:
                logger.info(f"StudyQ LLM: SGLang ok ({len(text)} chars)")
                return text
        except Exception as e:
            logger.error(f"StudyQ LLM: SGLang failed: {e}")

    # ── 2. Gemini — ONLY if admin has validated the key ───────────────────────
    if config.GEMINI_VALIDATED and not _gemini_dead:
        try:
            from google import genai
            client = genai.Client(api_key=config.GEMINI_API_KEY)
            resp = client.models.generate_content(
                model=config.GEMINI_MODEL_NAME, contents=prompt
            )
            if resp.text:
                logger.info("StudyQ LLM: Gemini fallback used")
                return resp.text.strip()
        except Exception as e:
            err = str(e)
            if "API_KEY_INVALID" in err or "expired" in err.lower():
                _gemini_dead = True
                logger.error("StudyQ LLM: Gemini key invalid — set GEMINI_API_VALIDATED=false in .env")
            else:
                logger.error(f"StudyQ LLM: Gemini error: {e}")
    elif not config.GEMINI_VALIDATED and config.GEMINI_API_KEY:
        logger.warning("StudyQ LLM: SGLang unavailable and Gemini not admin-validated — cannot generate.")

    logger.error("StudyQ LLM: No LLM available. Ensure at least one provider is configured.")
    return None


def _repair_truncated_json(text: str) -> str:
    """Close unclosed brackets/braces in a max-tokens-truncated JSON response."""
    text = text.rstrip()
    while text.endswith(","):
        text = text[:-1].rstrip()
    stack = []
    in_string = False
    escape_next = False
    for ch in text:
        if escape_next:
            escape_next = False
            continue
        if ch == "\\" and in_string:
            escape_next = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch in "{[":
            stack.append("}" if ch == "{" else "]")
        elif ch in "}]":
            if stack and stack[-1] == ch:
                stack.pop()
    closing = ('"' if in_string else '') + "".join(reversed(stack))
    return text + closing


_VALID_JSON_ESCAPES = set('"\\\/bfnrtu')


def _sanitize_backslashes(text: str) -> str:
    """
    Double any backslash inside a JSON string value that is not a valid
    JSON escape sequence.  Handles \\sqrt, \\sum, \\delta, etc. produced
    by the LLM for math notation.
    """
    result = []
    in_string = False
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == '"' and (i == 0 or result[-1:] != ['\\'] or
                          len(result) >= 2 and result[-2] == '\\'):
            # simple quote tracking (doesn't handle all edge-cases but good enough)
            in_string = not in_string
            result.append(ch)
            i += 1
            continue
        if in_string and ch == '\\' and i + 1 < len(text):
            next_ch = text[i + 1]
            if next_ch not in _VALID_JSON_ESCAPES:
                result.append('\\\\')  # escape the rogue backslash
                i += 1
                continue
        result.append(ch)
        i += 1
    return ''.join(result)


def _extract_json(raw: str) -> Optional[Dict]:
    """Parse JSON from LLM response, tolerating markdown fences, truncation,
    and invalid backslash escapes from math notation."""
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-z]*\n?", "", cleaned).rstrip("`").strip()

    _lax = json.JSONDecoder(strict=False)

    # 1. Parse as-is
    try:
        return json.loads(cleaned)
    except Exception:
        pass

    # 2. Lax parse — allows literal control chars (newlines) inside strings
    try:
        return _lax.decode(cleaned)
    except Exception:
        pass

    # 3. Sanitize invalid backslash escapes (math notation: \sqrt, \sum, …)
    try:
        return json.loads(_sanitize_backslashes(cleaned))
    except Exception:
        pass
    try:
        return _lax.decode(_sanitize_backslashes(cleaned))
    except Exception:
        pass

    # 4. Extract first {...} block
    m = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if m:
        for candidate in (m.group(), _sanitize_backslashes(m.group())):
            try:
                return json.loads(candidate)
            except Exception:
                pass
            try:
                return _lax.decode(candidate)
            except Exception:
                pass

    # 5. Repair truncated output (SGLang hit max_tokens)
    try:
        result = _lax.decode(_sanitize_backslashes(_repair_truncated_json(cleaned)))
        logger.info("StudyQ: repaired truncated JSON response ✓")
        return result
    except Exception:
        pass

    if m:
        try:
            result = _lax.decode(_sanitize_backslashes(_repair_truncated_json(m.group())))
            logger.info("StudyQ: repaired truncated inner JSON ✓")
            return result
        except Exception:
            pass

    return None


# =============================================================================
# PUBLIC API
# =============================================================================

def get_study_questions(course: str, subtopic_id: str) -> Optional[Dict]:
    """
    Return study questions for a subtopic.
    Lookup order: Redis → disk backup.
    """
    cached = _cache_get(course, subtopic_id)
    if cached:
        return cached
    payload = _load_questions_backup(course, subtopic_id)
    if payload:
        _cache_set(course, subtopic_id, payload)
        logger.info(f"StudyQ: re-warmed from disk for {course}/{subtopic_id}")
    return payload


def generate_study_questions(
    course: str,
    topic_id: str,
    topic_name: str,
    subtopic_id: str,
    subtopic_name: str,
    teaching_context: str = "",
    force: bool = False,
) -> Optional[Dict]:
    """
    Generate and persist study questions for one subtopic.

    Args:
        teaching_context: Pre-computed STN teaching context. If empty the
                          generator will fall back to generic LLM knowledge.
        force:            Re-generate even if cached.
    """
    if not force:
        existing = get_study_questions(course, subtopic_id)
        if existing:
            logger.debug(f"StudyQ cache HIT: {course}/{subtopic_id}")
            return existing

    prompt = STUDY_QUESTIONS_GENERATION_PROMPT.format(
        course=course,
        topic_name=topic_name,
        subtopic_name=subtopic_name,
        subtopic_id=subtopic_id,
        teaching_context=teaching_context or "(No teaching context available — use your own knowledge.)",
    )

    raw = _call_llm(prompt)
    if not raw:
        logger.warning(f"StudyQ: LLM returned nothing for {course}/{subtopic_id}")
        return None

    payload = _extract_json(raw)
    if not payload:
        logger.warning(f"StudyQ: Could not parse JSON for {course}/{subtopic_id}: {raw[:300]}")
        return None

    # Normalise / enrich metadata
    payload.setdefault("subtopic_id", subtopic_id)
    payload.setdefault("subtopic_name", subtopic_name)
    payload.setdefault("topic_id", topic_id)
    payload.setdefault("topic_name", topic_name)
    payload.setdefault("course", course)

    # Validate minimal structure
    if not payload.get("mcq") and not payload.get("flashcards"):
        logger.warning(f"StudyQ: Empty question bank for {course}/{subtopic_id}")
        return None

    # Persist in all tiers
    _save_questions_backup(course, subtopic_id, payload)
    _cache_set(course, subtopic_id, payload)
    _push_questions_to_qdrant(course, subtopic_id, payload)

    logger.info(
        f"StudyQ generated: {course}/{subtopic_id} — "
        f"{len(payload.get('mcq', []))} MCQ, "
        f"{len(payload.get('short_answer', []))} SA, "
        f"{len(payload.get('flashcards', []))} FC"
    )
    return payload


def generate_course_study_questions(
    course: str,
    modules: List[Dict],
    delay: float = 0.5,
) -> int:
    """
    Generate study questions for every subtopic in the curriculum.

    Args:
        modules: curriculum from curriculum_graph_handler.traverse_curriculum()
        delay:   seconds between LLM calls to avoid rate-limit

    Returns:
        Count of subtopics successfully processed.
    """
    import subtopic_notes_generator as stn_gen

    _ensure_qdrant_collection()

    total = sum(
        len(t.get("subtopics", []))
        for m in modules
        for t in m.get("topics", [])
    )
    done = 0
    logger.info(f"StudyQ: Starting for '{course}' — {total} subtopics")

    for module in modules:
        for topic in module.get("topics", []):
            topic_id = topic.get("id", "")
            topic_name = topic.get("name", topic_id)

            for sub in topic.get("subtopics", []):
                sub_id = sub.get("id", "")
                sub_name = sub.get("name", sub_id)

                # Get teaching_context from STN (already generated)
                teaching_ctx = ""
                try:
                    stn = stn_gen.get_subtopic_notes(course, sub_id)
                    if stn:
                        teaching_ctx = stn.get("teaching_context", "")
                except Exception:
                    pass

                result = generate_study_questions(
                    course=course,
                    topic_id=topic_id,
                    topic_name=topic_name,
                    subtopic_id=sub_id,
                    subtopic_name=sub_name,
                    teaching_context=teaching_ctx,
                )
                if result:
                    done += 1
                    logger.info(f"StudyQ [{done}/{total}]: {course}/{sub_id}")
                else:
                    logger.warning(f"StudyQ failed: {course}/{sub_id}")

                if delay > 0:
                    time.sleep(delay)

    logger.info(f"StudyQ: Completed {done}/{total} for '{course}'")
    return done
