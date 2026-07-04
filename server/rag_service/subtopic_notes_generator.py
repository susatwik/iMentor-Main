# server/rag_service/subtopic_notes_generator.py
"""
Subtopic Teaching Notes (STN) Generator.

For each curriculum subtopic, this module:
  1. Finds the most relevant sections from course material (marker-pdf Markdown).
  2. Uses an LLM to generate structured teaching notes:
       - concept      : 2-3 sentence definition
       - key_points   : bullet list of core ideas
       - math         : LaTeX / equations if applicable (empty string otherwise)
       - worked_example: one concrete example
       - misconceptions: common wrong beliefs
       - teaching_context: full prose paragraph for use as LLM system-prompt context
  3. Caches the result in Redis (7-day TTL).

Cache key : im_cache:subtopic_notes:{course}:{subtopic_id}

The teaching_context field is the primary payload used during tutor interactions —
it replaces a per-request Qdrant vector search (~200-500 ms saved per turn).
"""

import json
import logging
import os
import re
import threading
import time
import urllib.request
from typing import Dict, List, Optional, Tuple

import config
from sglang_caps import get_model_max_context

# Import Provider Manager
try:
    from llm_provider_manager import get_llm_manager
    _PROVIDER_MANAGER_AVAILABLE = True
except ImportError:
    _PROVIDER_MANAGER_AVAILABLE = False
    logging.getLogger(__name__).warning("Provider Manager not available, using legacy LLM calls")

logger = logging.getLogger(__name__)

_CACHE_TTL = 7 * 24 * 3600  # 7 days

# Disk backup directory — persistent beyond Redis TTL
_STN_BACKUP_DIR = getattr(config, "STN_BACKUP_DIR", os.path.join(os.path.dirname(__file__), "..", "Cpurses", "_stn_backup"))
os.makedirs(_STN_BACKUP_DIR, exist_ok=True)


def _backup_path(course: str, subtopic_id: str) -> str:
    course_dir = os.path.join(_STN_BACKUP_DIR, course.lower().replace(" ", "_"))
    os.makedirs(course_dir, exist_ok=True)
    return os.path.join(course_dir, f"{subtopic_id.lower()}.json")


def _save_stn_backup(course: str, subtopic_id: str, payload: Dict):
    """Write STN payload to disk so it survives Redis eviction."""
    try:
        path = _backup_path(course, subtopic_id)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        logger.debug(f"STN backup written: {path}")
    except Exception as e:
        logger.warning(f"STN backup write failed for {course}/{subtopic_id}: {e}")


def _load_stn_backup(course: str, subtopic_id: str) -> Optional[Dict]:
    """Load STN from disk backup (fallback when Redis is cold/flushed)."""
    try:
        path = _backup_path(course, subtopic_id)
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception as e:
        logger.warning(f"STN backup read failed for {course}/{subtopic_id}: {e}")
    return None

# ── Redis ─────────────────────────────────────────────────────────────────────
try:
    from cache_service import cache_service as _redis
    _REDIS_OK = True
except Exception:
    _redis = None
    _REDIS_OK = False
    logger.warning("subtopic_notes: Redis not available.")

# ── Gemini ────────────────────────────────────────────────────────────────────
_gemini_client = None
_gemini_dead = False
if config.GEMINI_VALIDATED:
    try:
        from google import genai
        _gemini_client = genai.Client(api_key=config.GEMINI_API_KEY)
        logger.info("subtopic_notes: Gemini client ready (admin-validated)")
    except Exception as e:
        logger.warning(f"subtopic_notes: Gemini init failed: {e}")

# ── SGLang (Primary - Constrained JSON Decoding) ────────────────────────────
_SGLANG_ENABLED = os.getenv("SGLANG_ENABLED", "true").lower() == "true"
_SGLANG_HEAVY_URL = os.getenv("SGLANG_HEAVY_URL", "http://localhost:8000/v1")
_SGLANG_HEAVY_MODEL = os.getenv("SGLANG_HEAVY_MODEL", "Qwen/Qwen2.5-7B-Instruct-AWQ")

_sglang_client = None
if _SGLANG_ENABLED:
    try:
        from openai import OpenAI
        _sglang_client = OpenAI(base_url=_SGLANG_HEAVY_URL, api_key="EMPTY")
        logger.info(f"STN: SGLang client initialized ({_SGLANG_HEAVY_MODEL})")
    except Exception as e:
        logger.warning(f"STN: SGLang init failed: {e}")
        _sglang_client = None

# ── Ollama (Fallback) ────────────────────────────────────────────────────────
_OLLAMA_BASE_URL = getattr(config, "OLLAMA_BASE_URL", "http://localhost:11434")
_OLLAMA_STN_MODEL = getattr(config, "OLLAMA_STN_MODEL", "qwen2.5:3b")
# Priority: STN model → 7b → 3b (models actually available in typical Ollama setups)
_OLLAMA_MODELS = list(dict.fromkeys([_OLLAMA_STN_MODEL, "qwen2.5:7b", "qwen2.5:3b", "qwen2.5:1.5b"]))


def _is_model_available(model: str) -> bool:
    """Check if an Ollama model is pulled and ready."""
    try:
        req = urllib.request.Request(f"{_OLLAMA_BASE_URL}/api/tags")
        with urllib.request.urlopen(req, timeout=3) as r:
            data = json.loads(r.read())
        return any(m.get("name") == model for m in data.get("models", []))
    except Exception:
        return False


# =============================================================================
# CACHE HELPERS
# =============================================================================

def _cache_key(course: str, subtopic_id: str) -> str:
    return f"subtopic_notes:{course.lower()}:{subtopic_id.lower()}"


def get_subtopic_notes(course: str, subtopic_id: str) -> Optional[Dict]:
    """Return cached subtopic teaching notes — Redis → disk backup → Qdrant stn_notes fallback."""
    # 1. Redis (hot cache)
    if _REDIS_OK:
        cached = _redis.get_cache(_cache_key(course, subtopic_id))
        if cached:
            return cached
    # 2. Disk backup (survives Redis flush)
    payload = _load_stn_backup(course, subtopic_id)
    if payload:
        if _REDIS_OK:
            _redis.set_cache(_cache_key(course, subtopic_id), payload, expire_seconds=_CACHE_TTL)
            logger.info(f"STN re-warmed from disk backup: {course}/{subtopic_id}")
        return payload
    # 3. Qdrant stn_notes collection (permanent vector store)
    payload = _load_stn_from_qdrant(course, subtopic_id)
    if payload:
        # Re-warm Redis + disk
        _store_subtopic_notes(course, subtopic_id, payload)
        logger.info(f"STN re-warmed from Qdrant stn_notes: {course}/{subtopic_id}")
        return payload
    return None


def _load_stn_from_qdrant(course: str, subtopic_id: str) -> Optional[Dict]:
    """Fallback: retrieve STN from the dedicated Qdrant stn_notes collection."""
    try:
        from qdrant_client import QdrantClient, models as qmodels
        stn_collection = getattr(config, "STN_QDRANT_COLLECTION", "stn_notes")
        client = QdrantClient(host=config.QDRANT_HOST, port=config.QDRANT_PORT)

        # Check collection exists
        try:
            client.get_collection(stn_collection)
        except Exception:
            return None

        # Scroll with filter on course + subtopic_id
        results = client.scroll(
            collection_name=stn_collection,
            scroll_filter=qmodels.Filter(
                must=[
                    qmodels.FieldCondition(key="course", match=qmodels.MatchValue(value=course.lower())),
                    qmodels.FieldCondition(key="subtopic_id", match=qmodels.MatchValue(value=subtopic_id)),
                ]
            ),
            limit=1,
            with_payload=True,
            with_vectors=False,
        )
        points = results[0] if results else []
        if points:
            p = points[0].payload
            return {
                "course": p.get("course", course),
                "topic_id": p.get("topic_id", ""),
                "topic_name": p.get("topic_name", ""),
                "subtopic_id": p.get("subtopic_id", subtopic_id),
                "subtopic_name": p.get("subtopic_name", ""),
                "teaching_context": p.get("teaching_context", ""),
                "concept": p.get("concept", ""),
                "key_points": p.get("key_points", []),
                "math": p.get("math", ""),
                "worked_example": p.get("worked_example", ""),
                "misconceptions": p.get("misconceptions", []),
            }
    except Exception as e:
        logger.debug(f"Qdrant STN fallback failed for {course}/{subtopic_id}: {e}")
    return None


def _store_subtopic_notes(course: str, subtopic_id: str, payload: Dict):
    # 1. Redis (hot cache, 7-day TTL)
    if _REDIS_OK:
        _redis.set_cache(_cache_key(course, subtopic_id), payload, expire_seconds=_CACHE_TTL)
        logger.debug(f"Cached STN for {course}/{subtopic_id}")
    # 2. Disk backup (survives Redis flush)
    _save_stn_backup(course, subtopic_id, payload)
    # 3. Qdrant stn_notes collection (permanent — completes the fallback chain)
    _write_stn_to_qdrant(course, subtopic_id, payload)
    # 4. Neo4j Subtopic node (teaching_context on the node — fast at query time)
    _write_stn_to_neo4j(course, subtopic_id, payload)


def _write_stn_to_qdrant(course: str, subtopic_id: str, payload: Dict):
    """
    Upsert STN payload into the dedicated Qdrant stn_notes collection.
    This completes the fallback chain: Redis → disk → Qdrant.
    The point ID is derived from a deterministic hash of course+subtopic_id.
    """
    teaching_context = payload.get("teaching_context", "")
    if not teaching_context:
        return
    try:
        from qdrant_client import QdrantClient
        from qdrant_client.models import (
            Distance, VectorParams, PointStruct, UpdateStatus,
        )
        import hashlib, struct
        import config as _cfg

        stn_collection = getattr(_cfg, "STN_QDRANT_COLLECTION", "stn_notes")
        client = QdrantClient(host=_cfg.QDRANT_HOST, port=_cfg.QDRANT_PORT)

        # Ensure collection exists
        try:
            client.get_collection(stn_collection)
        except Exception:
            client.create_collection(
                collection_name=stn_collection,
                vectors_config=VectorParams(size=384, distance=Distance.COSINE),
            )

        # Embed teaching_context for semantic search (best-effort)
        vector = None
        try:
            from sentence_transformers import SentenceTransformer
            _emb = SentenceTransformer(_cfg.DOCUMENT_EMBEDDING_MODEL_NAME)
            vector = _emb.encode(teaching_context[:512]).tolist()
        except Exception:
            vector = [0.0] * 384  # zero vector — point is still retrievable by filter

        # Deterministic integer ID from course+subtopic_id
        digest = hashlib.md5(f"{course.lower()}:{subtopic_id}".encode()).digest()
        point_id = struct.unpack(">I", digest[:4])[0]

        point_payload = {
            "course": course.lower(),
            "subtopic_id": subtopic_id,
            "subtopic_name": payload.get("subtopic_name", subtopic_id),
            "topic_id": payload.get("topic_id", ""),
            "topic_name": payload.get("topic_name", ""),
            "teaching_context": teaching_context,
            "concept": payload.get("concept", ""),
            "key_points": payload.get("key_points", []),
            "math": payload.get("math", ""),
            "misconceptions": payload.get("misconceptions", []),
            "importance": payload.get("importance", "supporting"),
        }

        result = client.upsert(
            collection_name=stn_collection,
            points=[PointStruct(id=point_id, vector=vector, payload=point_payload)],
        )
        if result.status == UpdateStatus.COMPLETED:
            logger.debug(f"STN upserted to Qdrant stn_notes: {course}/{subtopic_id}")
    except Exception as e:
        logger.debug(f"STN Qdrant write skipped for {course}/{subtopic_id}: {e}")


def _write_stn_to_neo4j(course: str, subtopic_id: str, payload: Dict):
    """
    Store teaching_context and importance on the matching Neo4j Subtopic node.
    This makes teaching context available via a single graph lookup at query time —
    no Redis round-trip needed once nodes are enriched.
    """
    teaching_context = payload.get("teaching_context", "")
    if not teaching_context:
        return
    try:
        import neo4j_handler
        import config as _cfg
        driver = neo4j_handler.get_driver_instance()
        with driver.session(database=_cfg.NEO4J_DATABASE) as session:
            session.run(
                """
                MATCH (s:Subtopic {id: $subtopic_id, course: $course})
                SET s.teaching_context = $teaching_context,
                    s.importance       = $importance,
                    s.stn_updated_at   = datetime()
                """,
                subtopic_id=subtopic_id,
                course=course,
                teaching_context=teaching_context,
                importance=payload.get("importance", "supporting"),
            )
        logger.debug(f"STN written to Neo4j Subtopic: {course}/{subtopic_id}")
    except Exception as e:
        logger.debug(f"STN Neo4j write skipped for {course}/{subtopic_id}: {e}")


def invalidate_course_stn(course: str) -> int:
    """
    Invalidate all cached STN entries for a course (Redis + disk backup).
    Called when new course material is uploaded so stale teaching notes
    are regenerated on next access.

    Returns the number of entries invalidated.
    """
    count = 0
    course_key_prefix = f"subtopic_notes:{course.lower()}:"

    # 1. Redis — delete all matching keys
    if _REDIS_OK:
        try:
            redis_client = getattr(_redis, 'redis_client', None)
            if redis_client:
                pattern = f"im_cache:{course_key_prefix}*"
                keys = redis_client.keys(pattern)
                if keys:
                    redis_client.delete(*keys)
                    count += len(keys)
                    logger.info(f"STN invalidate: deleted {len(keys)} Redis keys for '{course}'")
        except Exception as e:
            logger.warning(f"STN invalidate: Redis flush failed for '{course}': {e}")

    # 2. Disk backup — remove the course subfolder so stale JSON isn't served
    course_backup_dir = os.path.join(
        _STN_BACKUP_DIR, course.lower().replace(" ", "_")
    )
    if os.path.isdir(course_backup_dir):
        try:
            import shutil
            shutil.rmtree(course_backup_dir)
            logger.info(f"STN invalidate: removed disk backup dir '{course_backup_dir}'")
        except Exception as e:
            logger.warning(f"STN invalidate: disk backup removal failed: {e}")

    return count


# =============================================================================
# LLM HELPERS
# =============================================================================

def _call_gemini(prompt: str) -> Optional[str]:
    global _gemini_dead
    if not _gemini_client or _gemini_dead:
        return None
    try:
        resp = _gemini_client.models.generate_content(
            model=config.GEMINI_MODEL_NAME, contents=prompt
        )
        return resp.text.strip() if resp.text else None
    except Exception as e:
        err = str(e)
        if "API_KEY_INVALID" in err or "key expired" in err.lower():
            _gemini_dead = True
            logger.error("subtopic_notes: Gemini key invalid — set GEMINI_API_VALIDATED=false in .env")
        else:
            logger.error(f"subtopic_notes: Gemini error: {e}")
        return None


def _call_sglang(prompt: str) -> Optional[Dict]:
    """
    Call SGLang with Pydantic schema for guaranteed valid JSON.
    Returns parsed JSON dict or None on failure.
    """
    if not _sglang_client:
        return None
    
    try:
        from pydantic import BaseModel, Field
        from typing import List
        
        # Define strict JSON schema
        class SubtopicNotes(BaseModel):
            concept: str = Field(description="2-3 sentence definition of the subtopic")
            key_points: List[str] = Field(description="4-6 core ideas as bullet points")
            math: str = Field(description="LaTeX equations or formulas, or empty string")
            worked_example: str = Field(description="One concrete step-by-step example")
            misconceptions: List[str] = Field(description="2-3 common wrong beliefs")
            teaching_context: str = Field(description="3-4 paragraph rich explanation for AI tutor system prompt")
        
        logger.info(f"STN: Using SGLang model {_SGLANG_HEAVY_MODEL} with constrained JSON")

        # Compute safe completion budget from the live model context length
        _stn_system = "You are an expert educator. Always output valid JSON."
        _stn_input_tokens = int((len(_stn_system) + len(prompt)) / 3.5)
        _stn_max_tokens = max(512, get_model_max_context() - _stn_input_tokens - 256)

        response = _sglang_client.chat.completions.create(
            model=_SGLANG_HEAVY_MODEL,
            messages=[
                {"role": "system", "content": _stn_system},
                {"role": "user", "content": prompt}
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "subtopic_notes_schema",
                    "schema": SubtopicNotes.model_json_schema(),
                    "strict": True
                }
            },
            temperature=0.1,
            max_tokens=_stn_max_tokens
        )
        
        content = response.choices[0].message.content
        if content:
            return json.loads(content)
    except Exception as e:
        logger.warning(f"STN: SGLang call failed: {e}")
    return None


def _call_ollama(prompt: str) -> Optional[str]:
    for model in _OLLAMA_MODELS:
        # Skip models that aren't pulled yet (avoids long pull-on-demand waits)
        if not _is_model_available(model):
            logger.debug(f"subtopic_notes: {model} not available, skipping.")
            continue
        try:
            logger.info(f"subtopic_notes: using Ollama model {model}")
            payload = json.dumps({
                "model": model, "prompt": prompt, "stream": False,
                "options": {"temperature": 0.2, "num_predict": 3000},
            }).encode()
            req = urllib.request.Request(
                f"{_OLLAMA_BASE_URL}/api/generate", data=payload,
                headers={"Content-Type": "application/json"}, method="POST",
            )
            with urllib.request.urlopen(req, timeout=300) as r:
                data = json.loads(r.read())
            text = data.get("response", "").strip()
            if text:
                return text
        except Exception as e:
            logger.warning(f"subtopic_notes: Ollama {model} failed: {e}")
    return None


def _call_llm(prompt: str) -> Optional[str]:
    """Provider Manager (SGLang → Grok → Gemini → Ollama)."""
    # Use Provider Manager if available
    if _PROVIDER_MANAGER_AVAILABLE:
        try:
            manager = get_llm_manager()
            system_msg = "You are an expert educator. Always output valid JSON."
            result = manager.generate(
                messages=[
                    {"role": "system", "content": system_msg},
                    {"role": "user", "content": prompt}
                ],
                model=_SGLANG_HEAVY_MODEL,
                temperature=0.1,
                max_tokens=3000,
            )
            if result:
                return result
        except Exception as e:
            logger.warning(f"STN: Provider Manager failed: {e}")

    # ── 1. SGLang (primary — constrained JSON) ────────────────────────────────
    sglang_result = _call_sglang(prompt)
    if sglang_result:
        return json.dumps(sglang_result)

    # ── 2. Gemini — ONLY if admin has validated the key ───────────────────────
    gemini_result = _call_gemini(prompt)
    if gemini_result:
        return gemini_result

    # ── 3. Ollama — local fallback ────────────────────────────────────────────
    ollama_result = _call_ollama(prompt)
    if ollama_result:
        return ollama_result

    logger.error("subtopic_notes: No LLM available. Ensure at least one provider is configured.")
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
    """Double any backslash in a JSON string value that is not a valid JSON escape.
    Handles \\sqrt, \\sum, \\delta etc. from LLM math notation output."""
    result = []
    in_string = False
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == '"':
            in_string = not in_string
            result.append(ch)
            i += 1
            continue
        if in_string and ch == '\\' and i + 1 < len(text):
            next_ch = text[i + 1]
            if next_ch not in _VALID_JSON_ESCAPES:
                result.append('\\\\')
                i += 1
                continue
        result.append(ch)
        i += 1
    return ''.join(result)


def _extract_json(raw: str) -> Optional[Dict]:
    _lax = json.JSONDecoder(strict=False)
    # 1. Parse as-is
    try:
        return json.loads(raw)
    except Exception:
        pass
    # 2. Lax parse — allows literal control chars (newlines) inside strings
    try:
        return _lax.decode(raw)
    except Exception:
        pass
    # 3. Sanitize invalid backslash escapes (math: \sqrt, \sum, \delta …)
    try:
        return json.loads(_sanitize_backslashes(raw))
    except Exception:
        pass
    try:
        return _lax.decode(_sanitize_backslashes(raw))
    except Exception:
        pass
    # 4. Extract first {...} block
    m = re.search(r'\{.*\}', raw, re.DOTALL)
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
    # 5. Repair truncated output (SGLang hit max_tokens mid-response)
    try:
        result = _lax.decode(_sanitize_backslashes(_repair_truncated_json(raw)))
        logger.info("STN: repaired truncated JSON response ✓")
        return result
    except Exception:
        pass
    if m:
        try:
            result = _lax.decode(_sanitize_backslashes(_repair_truncated_json(m.group())))
            logger.info("STN: repaired truncated inner JSON ✓")
            return result
        except Exception:
            pass
    return None


# =============================================================================
# MATERIAL RETRIEVAL — pull Qdrant chunks for a subtopic
# =============================================================================

def _get_qdrant_chunks_for_subtopic(
    course: str, topic_name: str, subtopic_name: str, max_chars: int = 8000
) -> str:
    """
    Pull the most relevant Qdrant chunks for a subtopic.

    Strategy:
    1. Try filtered search: syllabus_topic exact-match + semantic query on subtopic name.
    2. Fall back to unfiltered semantic search if the filtered result is sparse.
    """
    try:
        from vector_db_service import VectorDBService
        from qdrant_client import models as qmodels
        import config as _cfg
        vds = VectorDBService(
            qdrant_host=_cfg.QDRANT_HOST,
            qdrant_port=_cfg.QDRANT_PORT,
            collection_name=_cfg.QDRANT_COLLECTION_NAME,
            embedding_model_name=_cfg.DOCUMENT_EMBEDDING_MODEL_NAME,
        )
        query = f"{topic_name} {subtopic_name}"

        # Attempt 1: filter by topic so we don't bleed into neighbouring topics
        topic_filter = qmodels.Filter(
            must=[
                qmodels.FieldCondition(
                    key="syllabus_topic",
                    match=qmodels.MatchText(text=topic_name),
                )
            ]
        )
        docs, _, _ = vds.search_documents(query, k=10, filter_conditions=topic_filter)

        # If fewer than 3 chunks match the topic filter, fall back to unfiltered search
        if len(docs) < 3:
            docs_fallback, _, _ = vds.search_documents(query, k=10)
            if len(docs_fallback) > len(docs):
                docs = docs_fallback
                logger.debug(f"STN: topic filter sparse for '{topic_name}', using unfiltered search")

        chunks = [d.page_content for d in docs if d.page_content]
        combined = "\n\n---\n\n".join(chunks)
        return combined[:max_chars]
    except Exception as e:
        logger.debug(f"Qdrant chunk fetch skipped: {e}")
        return ""


def _get_neo4j_prerequisites(course: str, subtopic_id: str) -> List[str]:
    """
    Query Neo4j for the prerequisite subtopics of the given subtopic.
    Returns a list of prerequisite names, or [] if Neo4j is unavailable.
    """
    try:
        import neo4j_handler
        driver = neo4j_handler.get_driver_instance()
        import config as _cfg
        with driver.session(database=_cfg.NEO4J_DATABASE) as session:
            result = session.run(
                """
                MATCH (pre:Subtopic)-[:PREREQUISITE_OF]->(s:Subtopic {id: $subtopic_id, course: $course})
                RETURN pre.name AS name
                """,
                subtopic_id=subtopic_id,
                course=course,
            )
            return [r["name"] for r in result if r.get("name")]
    except Exception as e:
        logger.debug(f"STN: Neo4j prerequisite query skipped for {course}/{subtopic_id}: {e}")
        return []


# =============================================================================
# NOTE GENERATION PROMPT
# =============================================================================

_CONCEPT_AWARE_NOTES_PROMPT = """You are an expert educator preparing teaching notes for an AI tutor.

Course      : {course}
Topic       : {topic_name}
Subtopic    : {subtopic_name}
Importance  : {importance}  (core = must know | supporting = aids understanding | detail = advanced/optional)
Prerequisites (concepts students need first): {prerequisites}
Related concepts in this course: {related_concepts}

SOURCE MATERIAL (from course documents):
<material>
{material}
</material>

Generate structured teaching notes as VALID JSON only — no prose outside the JSON:

{{
  "concept": "<2-3 sentence definition of {subtopic_name} — be precise and match the importance level>",
  "key_points": [
    "<core idea 1>",
    "<core idea 2>",
    "<core idea 3>",
    "<core idea 4>"
  ],
  "math": "<LaTeX equations or formulas relevant to this subtopic, or empty string if none>",
  "worked_example": "<one concrete step-by-step example>",
  "misconceptions": [
    "<common wrong belief 1>",
    "<common wrong belief 2>"
  ],
  "teaching_context": "<3-4 paragraph rich explanation of {subtopic_name}. Include: intuition building, how it connects to prerequisites ({prerequisites}), math context where applicable, and real-world relevance. For 'core' concepts go deep. For 'detail' concepts be concise. This is the direct system-prompt context for the AI tutor.>"
}}

Rules:
- teaching_context MUST be complete and self-contained.
- Explicitly mention how this concept builds on its prerequisites where relevant.
- Preserve all mathematical notation using LaTeX (e.g. $E = mc^2$).
- If source material is sparse or empty, generate from your own knowledge.
- Output ONLY the JSON object — no markdown fences, no preamble.
"""

_NOTES_PROMPT = """You are an expert educator preparing teaching notes for an AI tutor.

Course     : {course}
Topic      : {topic_name}
Subtopic   : {subtopic_name}

SOURCE MATERIAL (from course documents):
<material>
{material}
</material>

Generate structured teaching notes as VALID JSON only — no prose outside the JSON:

{{
  "concept": "<2-3 sentence definition of {subtopic_name}>",
  "key_points": [
    "<core idea 1>",
    "<core idea 2>",
    "<core idea 3>",
    "<core idea 4>"
  ],
  "math": "<LaTeX equations or formulas relevant to this subtopic, or empty string if none>",
  "worked_example": "<one concrete step-by-step example>",
  "misconceptions": [
    "<common wrong belief 1>",
    "<common wrong belief 2>"
  ],
  "teaching_context": "<3-4 paragraph rich explanation of {subtopic_name} including intuition, math context, and real-world relevance. This is the direct system-prompt context for the AI tutor during student interactions.>"
}}

Rules:
- teaching_context MUST be complete and self-contained (the AI tutor will read only this field during interactions).
- Preserve all mathematical notation using LaTeX where applicable (e.g. $E = mc^2$).
- If source material is sparse or empty, generate from your own knowledge of this topic.
- Output ONLY the JSON object — no markdown fences, no preamble.
"""


# =============================================================================
# MAIN GENERATION FUNCTION
# =============================================================================

def generate_subtopic_notes(
    course: str,
    topic_id: str,
    topic_name: str,
    subtopic_id: str,
    subtopic_name: str,
    force: bool = False,
) -> Optional[Dict]:
    """
    Generate and cache teaching notes for one subtopic.
    Returns cached result if available (unless force=True).
    """
    if not force:
        cached = get_subtopic_notes(course, subtopic_id)
        if cached:
            logger.debug(f"STN cache HIT: {course}/{subtopic_id}")
            return cached

    # Pull material from Qdrant (topic-filtered)
    material = _get_qdrant_chunks_for_subtopic(course, topic_name, subtopic_name)
    if not material:
        logger.info(f"STN: No Qdrant material for {subtopic_name} — generating from LLM knowledge.")

    # Pull prerequisites from Neo4j
    prereqs = _get_neo4j_prerequisites(course, subtopic_id)
    prereqs_str = ", ".join(prereqs) if prereqs else "None identified"

    prompt = _CONCEPT_AWARE_NOTES_PROMPT.format(
        course=course,
        topic_name=topic_name,
        subtopic_name=subtopic_name,
        importance="supporting",  # neutral default; use generate_subtopic_notes_from_concept for KG-aware importance
        prerequisites=prereqs_str,
        related_concepts="",
        material=material or "(No source material available — use your own knowledge of this topic)",
    )

    raw = _call_llm(prompt)
    if not raw:
        logger.warning(f"STN: LLM returned nothing for {course}/{subtopic_id}")
        return None

    payload = _extract_json(raw)
    if not payload:
        # Last resort: wrap the raw text as teaching_context
        payload = {"teaching_context": raw.strip()}
        logger.warning(f"STN: Non-JSON response for {course}/{subtopic_id} — using raw text as teaching_context")
    elif "teaching_context" not in payload:
        # Model returned a partial schema (e.g. concept + key_points) — synthesise
        parts = []
        if payload.get("concept"):
            parts.append(payload["concept"])
        if payload.get("key_points"):
            kp = payload["key_points"]
            if isinstance(kp, list):
                parts.append(" ".join(str(k) for k in kp))
            else:
                parts.append(str(kp))
        if payload.get("examples"):
            parts.append(str(payload["examples"]))
        if parts:
            payload["teaching_context"] = " ".join(parts)
            logger.warning(f"STN: Synthesised teaching_context from partial JSON for {course}/{subtopic_id}")
        else:
            logger.warning(f"STN: Invalid JSON for {course}/{subtopic_id}: {raw[:200]}")
            return None

    payload.update({
        "course": course,
        "topic_id": topic_id,
        "topic_name": topic_name,
        "subtopic_id": subtopic_id,
        "subtopic_name": subtopic_name,
    })

    _store_subtopic_notes(course, subtopic_id, payload)
    logger.info(f"STN generated: {course}/{subtopic_id}")
    return payload


# =============================================================================
# BULK BACKGROUND GENERATION
# =============================================================================

def generate_course_notes_background(
    course: str,
    modules: List[Dict],
    delay_between: float = 1.0,
) -> threading.Thread:
    """
    Generate STN for all subtopics in a course in a background thread.
    modules: list of {id, name, topics: [{id, name, subtopics: [{id, name}]}]}
    """
    def _worker():
        total = sum(
            len(t.get("subtopics", []))
            for m in modules
            for t in m.get("topics", [])
        )
        done = 0
        logger.info(f"STN START: {course} — {total} subtopics")

        for module in modules:
            for topic in module.get("topics", []):
                topic_id = topic.get("id", "")
                topic_name = topic.get("name", topic_id)
                for sub in topic.get("subtopics", []):
                    sub_id = sub.get("id", "")
                    sub_name = sub.get("name", sub_id)
                    try:
                        generate_subtopic_notes(course, topic_id, topic_name, sub_id, sub_name)
                    except Exception as e:
                        logger.error(f"STN error {course}/{sub_id}: {e}")
                    done += 1
                    if delay_between > 0:
                        time.sleep(delay_between)

        logger.info(f"STN DONE: {course} — {done}/{total} subtopics cached")

    t = threading.Thread(target=_worker, daemon=True, name=f"stn:{course}")
    t.start()
    return t


def generate_subtopic_notes_from_concept(
    course: str,
    concept_label: str,
    concept_description: str,
    concept_importance: str = "supporting",
    prerequisites: List[str] = None,
    related_concepts: List[str] = None,
    topic_name: str = "",
    force: bool = False,
) -> Optional[Dict]:
    """
    Generate STN using richer concept graph context (prerequisites, importance, relations).
    Drop-in replacement for generate_subtopic_notes when concept graph data is available.

    Args:
        course:               Course name (e.g. "DBMS")
        concept_label:        Human-readable concept name (used as subtopic_name + subtopic_id)
        concept_description:  2-3 sentence description from KnowledgeGraph
        concept_importance:   "core" | "supporting" | "detail"
        prerequisites:        List of prerequisite concept labels (not IDs)
        related_concepts:     List of related concept labels
        topic_name:           Parent topic/lecture name (if known)
        force:                Bypass cache and regenerate
    """
    subtopic_id = concept_label.lower().replace(" ", "_").replace("/", "_")
    prerequisites = prerequisites or []
    related_concepts = related_concepts or []

    # Check cache first (uses same key format as existing STN system)
    if not force:
        cached = get_subtopic_notes(course, subtopic_id)
        if cached:
            logger.debug(f"STN cache HIT (concept-aware): {course}/{subtopic_id}")
            return cached

    # Pull Qdrant material
    material = _get_qdrant_chunks_for_subtopic(course, topic_name or concept_label, concept_label)

    prompt = _CONCEPT_AWARE_NOTES_PROMPT.format(
        course=course,
        topic_name=topic_name or concept_label,
        subtopic_name=concept_label,
        importance=concept_importance,
        prerequisites=", ".join(prerequisites) if prerequisites else "none",
        related_concepts=", ".join(related_concepts[:8]) if related_concepts else "none",
        material=material or f"Description: {concept_description}\n\n(No additional source material — generate from knowledge of this topic)",
    )

    raw = _call_llm(prompt)
    if not raw:
        logger.warning(f"STN (concept-aware): LLM returned nothing for {course}/{subtopic_id}")
        return None

    payload = _extract_json(raw)
    if not payload:
        payload = {"teaching_context": raw.strip()}
    elif "teaching_context" not in payload:
        parts = [s for s in [payload.get("concept", ""), " ".join(payload.get("key_points", []))] if s]
        payload["teaching_context"] = " ".join(parts) if parts else ""

    payload.update({
        "course": course,
        "topic_id": topic_name.lower().replace(" ", "_") if topic_name else subtopic_id,
        "topic_name": topic_name or concept_label,
        "subtopic_id": subtopic_id,
        "subtopic_name": concept_label,
        "importance": concept_importance,
        "prerequisites": prerequisites,
    })

    _store_subtopic_notes(course, subtopic_id, payload)
    logger.info(f"STN (concept-aware) generated: {course}/{subtopic_id} [{concept_importance}]")
    return payload


def generate_course_notes_from_kg(
    course: str,
    kg_concepts: List[Dict],
    delay_between: float = 0.5,
    force: bool = False,
) -> threading.Thread:
    """
    Generate STN for all concepts from a KnowledgeGraph in a background thread.

    kg_concepts: list of dicts with keys:
        id, label, description, importance, prerequisites (list of IDs),
        and optionally 'prereq_labels' (list of labels resolved externally)

    Example usage:
        from lecture_generator.concept_extractor import extract_knowledge_graph
        kg = extract_knowledge_graph("DBMS", source_text)
        id_to_label = {c.id: c.label for c in kg.concepts}
        concepts_dicts = [
            {
                "id": c.id, "label": c.label, "description": c.description,
                "importance": c.importance,
                "prereq_labels": [id_to_label.get(p, p) for p in c.prerequisites],
                "related_labels": [id_to_label.get(x.source if x.target == c.id else x.target, "")
                                   for x in kg.relationships
                                   if x.source == c.id or x.target == c.id][:6],
            }
            for c in kg.concepts
        ]
        generate_course_notes_from_kg("DBMS", concepts_dicts)
    """
    def _worker():
        total = len(kg_concepts)
        done = 0
        logger.info(f"STN (from KG) START: {course} — {total} concepts")
        # Core concepts first
        ordered = sorted(kg_concepts, key=lambda c: {"core": 0, "supporting": 1, "detail": 2}.get(c.get("importance", "supporting"), 1))
        for concept in ordered:
            try:
                generate_subtopic_notes_from_concept(
                    course=course,
                    concept_label=concept["label"],
                    concept_description=concept.get("description", ""),
                    concept_importance=concept.get("importance", "supporting"),
                    prerequisites=concept.get("prereq_labels", []),
                    related_concepts=concept.get("related_labels", []),
                    force=force,
                )
            except Exception as e:
                logger.error(f"STN (KG) error {course}/{concept.get('label', '?')}: {e}")
            done += 1
            if delay_between > 0:
                time.sleep(delay_between)
        logger.info(f"STN (from KG) DONE: {course} — {done}/{total}")

    t = threading.Thread(target=_worker, daemon=True, name=f"stn-kg-{course}")
    t.start()
    return t
