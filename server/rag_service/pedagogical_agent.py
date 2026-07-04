# server/rag_service/pedagogical_agent.py
"""
Pedagogical Agent — Deep Subtopic Content Synthesis (Offline Only)

Generates L2/L3/L4 knowledge layers per curriculum subtopic from all available
course markdown material, extending the existing STN (L0: concept, L1: key_points).

  L0 — Concept Definition   (seeded from existing STN — no LLM call)
  L1 — Key Points + Math     (seeded from existing STN — no LLM call)
  L2 — Technical Depth       : formal derivations, algorithm steps, theoretical treatment
  L3 — Worked Examples       : 3 step-by-step examples at easy / medium / hard
  L4 — Misconception Analysis: 5 errors with root-cause + correct understanding

ZERO LATENCY CONSTRAINT: all synthesis is offline. Query time = Qdrant filter + Redis.

Storage:
  - Qdrant `pedagogical_notes` collection (1024-dim, keyword payload indexes per level)
  - Redis warm cache (populated by store + reloaded by startup cache warmer)
"""
import hashlib
import json
import logging
import os
import struct
from typing import Dict, List, Optional

import config

# Import Provider Manager
try:
    from llm_provider_manager import get_llm_manager
    _PROVIDER_MANAGER_AVAILABLE = True
except ImportError:
    _PROVIDER_MANAGER_AVAILABLE = False
    logging.getLogger(__name__).warning("Provider Manager not available, using legacy LLM calls")

logger = logging.getLogger(__name__)

PEDAGOGICAL_COLLECTION = getattr(config, "PEDAGOGICAL_QDRANT_COLLECTION", "pedagogical_notes")

# ── SGLang (primary) ──────────────────────────────────────────────────────────
_SGLANG_ENABLED     = os.getenv("SGLANG_ENABLED", "true").lower() == "true"
_SGLANG_HEAVY_URL   = os.getenv("SGLANG_HEAVY_URL", "http://localhost:8000/v1")
_SGLANG_HEAVY_MODEL = os.getenv("SGLANG_HEAVY_MODEL", "Qwen/Qwen2.5-7B-Instruct-AWQ")

_sglang_client = None
if _SGLANG_ENABLED:
    try:
        from openai import OpenAI
        _sglang_client = OpenAI(base_url=_SGLANG_HEAVY_URL, api_key="EMPTY")
        logger.info(f"PedagogicalAgent: SGLang client ready ({_SGLANG_HEAVY_MODEL})")
    except Exception as _e:
        logger.warning(f"PedagogicalAgent: SGLang init failed: {_e}")

# ── Redis ─────────────────────────────────────────────────────────────────────
try:
    from cache_service import cache_service as _redis
    _REDIS_OK = True
except Exception:
    _redis = None
    _REDIS_OK = False

_CACHE_TTL = 7 * 24 * 3600  # 7 days


# =============================================================================
# QDRANT SETUP
# =============================================================================

def setup_pedagogical_collection():
    """Create pedagogical_notes collection with keyword payload indexes if needed."""
    try:
        from qdrant_client import QdrantClient
        from qdrant_client.models import Distance, VectorParams, PayloadSchemaType

        client = QdrantClient(host=config.QDRANT_HOST, port=config.QDRANT_PORT)

        try:
            client.get_collection(PEDAGOGICAL_COLLECTION)
        except Exception:
            client.create_collection(
                collection_name=PEDAGOGICAL_COLLECTION,
                vectors_config=VectorParams(
                    size=config.DOCUMENT_VECTOR_DIMENSION,
                    distance=Distance.COSINE,
                ),
            )
            logger.info(
                f"Created Qdrant collection: {PEDAGOGICAL_COLLECTION} "
                f"(dim={config.DOCUMENT_VECTOR_DIMENSION})"
            )

        # Payload indexes for O(1) filtered retrieval
        for field in ("course", "subtopic_id", "level"):
            try:
                client.create_payload_index(
                    collection_name=PEDAGOGICAL_COLLECTION,
                    field_name=field,
                    field_schema=PayloadSchemaType.KEYWORD,
                )
            except Exception:
                pass  # index already exists

    except Exception as e:
        logger.error(f"setup_pedagogical_collection failed: {e}", exc_info=True)


# =============================================================================
# LLM HELPERS
# =============================================================================

def _call_sglang(system_prompt: str, user_prompt: str, max_tokens: int = 1500) -> Optional[str]:
    """Call LLM via Provider Manager (SGLang → Grok → Gemini → Ollama)."""
    # Use Provider Manager if available
    if _PROVIDER_MANAGER_AVAILABLE:
        try:
            manager = get_llm_manager()
            result = manager.generate(
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user",   "content": user_prompt},
                ],
                model=_SGLANG_HEAVY_MODEL,
                temperature=0.3,
                max_tokens=max_tokens,
            )
            if result:
                return result.strip()
        except Exception as e:
            logger.warning(f"PedagogicalAgent Provider Manager failed: {e}")

    # Legacy fallback: direct SGLang call
    if not _sglang_client:
        return None
    try:
        resp = _sglang_client.chat.completions.create(
            model=_SGLANG_HEAVY_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": user_prompt},
            ],
            temperature=0.3,
            max_tokens=max_tokens,
        )
        return (resp.choices[0].message.content or "").strip()
    except Exception as e:
        logger.warning(f"PedagogicalAgent SGLang call failed: {e}")
        return None


def _trim(text: str, max_chars: int = 5000) -> str:
    return text[:max_chars] if len(text) > max_chars else text


# =============================================================================
# L2 — TECHNICAL DEPTH
# =============================================================================

_L2_SYSTEM = (
    "You are an expert university lecturer writing a technical reference. "
    "Write rigorous, comprehensive content suitable for final-year engineering students. "
    "Use LaTeX for mathematical notation: inline $...$, block $$...$$."
)


def _synthesize_l2(subtopic_name: str, course_material: str) -> Optional[str]:
    user_prompt = f"""Based on the following course material, write a comprehensive technical exposition for: "{subtopic_name}".

Cover:
1. Formal definition and mathematical formulation
2. Step-by-step derivation or algorithm description
3. Key theoretical properties, guarantees, and complexity
4. Connections to related concepts in the course

Course material:
{_trim(course_material, 5000)}

Write 600–900 words of technical prose. Use LaTeX for all math."""

    return _call_sglang(_L2_SYSTEM, user_prompt, max_tokens=1200)


# =============================================================================
# L3 — WORKED EXAMPLES
# =============================================================================

_L3_SYSTEM = (
    "You are an expert tutor creating worked examples for engineering students. "
    "Each example must be self-contained with a clear problem statement and complete solution "
    "showing every intermediate step."
)


def _synthesize_l3(subtopic_name: str, course_material: str) -> Optional[List[Dict]]:
    user_prompt = f"""Create 3 worked examples for: "{subtopic_name}".

Requirements:
- Example 1: Easy — basic application, single concept
- Example 2: Medium — multiple steps or combined concepts
- Example 3: Hard — real-world scenario or edge case

For each provide:
  "problem": the problem statement
  "solution": complete step-by-step solution with reasoning
  "difficulty": "easy" | "medium" | "hard"

Course material for reference:
{_trim(course_material, 4000)}

Output ONLY a JSON array of 3 objects. No explanation outside JSON."""

    raw = _call_sglang(_L3_SYSTEM, user_prompt, max_tokens=1500)
    if not raw:
        return None

    try:
        start = raw.find("[")
        end   = raw.rfind("]") + 1
        if start >= 0 and end > start:
            examples = json.loads(raw[start:end])
            if isinstance(examples, list) and examples:
                return examples
    except Exception as e:
        logger.debug(f"L3 JSON parse failed: {e} — wrapping as single example")

    # Fallback: treat entire response as one medium example
    return [{"problem": f"Worked example for {subtopic_name}", "solution": raw, "difficulty": "medium"}]


# =============================================================================
# L4 — MISCONCEPTION ANALYSIS
# =============================================================================

_L4_SYSTEM = (
    "You are an expert educator who specialises in identifying and correcting student misconceptions. "
    "Be specific about why each misconception arises and give precise corrections."
)


def _synthesize_l4(subtopic_name: str, course_material: str) -> Optional[List[Dict]]:
    user_prompt = f"""Identify 5 common student misconceptions about: "{subtopic_name}".

For each provide:
  "misconception": the incorrect belief
  "why_it_arises": root cause (prior knowledge, intuition, similar-concept confusion)
  "correction": accurate understanding with evidence
  "example": a concrete example demonstrating the correct view

Course material for reference:
{_trim(course_material, 4000)}

Output ONLY a JSON array of 5 objects. No explanation outside JSON."""

    raw = _call_sglang(_L4_SYSTEM, user_prompt, max_tokens=1500)
    if not raw:
        return None

    try:
        start = raw.find("[")
        end   = raw.rfind("]") + 1
        if start >= 0 and end > start:
            items = json.loads(raw[start:end])
            if isinstance(items, list) and items:
                return items
    except Exception as e:
        logger.debug(f"L4 JSON parse failed: {e}")

    return None


# =============================================================================
# STORAGE
# =============================================================================

def _point_id(course: str, subtopic_id: str, level: str) -> int:
    """Deterministic Qdrant point ID."""
    digest = hashlib.md5(f"{course.lower()}:{subtopic_id}:{level}".encode()).digest()
    return struct.unpack(">I", digest[:4])[0]


def _get_embed_model():
    try:
        return config.get_embedding_model()
    except Exception as e:
        logger.warning(f"Could not load embedding model: {e}")
        return None


def store_pedagogical_level(
    course: str,
    subtopic_id: str,
    subtopic_name: str,
    topic_name: str,
    level: str,
    content,
) -> bool:
    """
    Upsert one pedagogical level into Qdrant + warm Redis.
    content: str for L0/L2, list[dict] for L1/L3/L4
    """
    if not content:
        return False

    content_str = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
    if not content_str.strip():
        return False

    try:
        from qdrant_client import QdrantClient
        from qdrant_client.models import PointStruct, UpdateStatus

        client    = QdrantClient(host=config.QDRANT_HOST, port=config.QDRANT_PORT)
        setup_pedagogical_collection()

        embed_model = _get_embed_model()
        vector = (
            embed_model.encode(content_str[:512]).tolist()
            if embed_model
            else [0.0] * config.DOCUMENT_VECTOR_DIMENSION
        )

        payload = {
            "course":        course.lower(),
            "subtopic_id":   subtopic_id,
            "subtopic_name": subtopic_name,
            "topic_name":    topic_name,
            "level":         level,
            "content":       content_str,
            "content_type":  "text" if isinstance(content, str) else "json",
        }

        result = client.upsert(
            collection_name=PEDAGOGICAL_COLLECTION,
            points=[PointStruct(id=_point_id(course, subtopic_id, level), vector=vector, payload=payload)],
            wait=True,
        )

        ok = result.status == UpdateStatus.COMPLETED
        if ok and _REDIS_OK:
            cache_key = f"pedagogy:{course.lower()}:{subtopic_id}:{level}"
            _redis.set_cache(cache_key, {"content": content, "level": level}, expire_seconds=_CACHE_TTL)

        return ok

    except Exception as e:
        logger.error(f"store_pedagogical_level {course}/{subtopic_id}/{level}: {e}")
        return False


def get_pedagogical_level(course: str, subtopic_id: str, level: str) -> Optional[Dict]:
    """Retrieve a single pedagogical level.  Redis → Qdrant."""
    cache_key = f"pedagogy:{course.lower()}:{subtopic_id}:{level}"

    if _REDIS_OK:
        cached = _redis.get_cache(cache_key)
        if cached:
            return cached

    try:
        from qdrant_client import QdrantClient
        from qdrant_client.models import Filter, FieldCondition, MatchValue

        client  = QdrantClient(host=config.QDRANT_HOST, port=config.QDRANT_PORT)
        points, _ = client.scroll(
            collection_name=PEDAGOGICAL_COLLECTION,
            scroll_filter=Filter(must=[
                FieldCondition(key="course",      match=MatchValue(value=course.lower())),
                FieldCondition(key="subtopic_id", match=MatchValue(value=subtopic_id)),
                FieldCondition(key="level",       match=MatchValue(value=level)),
            ]),
            limit=1,
            with_payload=True,
            with_vectors=False,
        )
        if points:
            p = points[0].payload
            raw = p.get("content", "")
            content = raw
            if p.get("content_type") == "json":
                try:
                    content = json.loads(raw)
                except Exception:
                    pass
            result = {"content": content, "level": level}
            if _REDIS_OK:
                _redis.set_cache(cache_key, result, expire_seconds=_CACHE_TTL)
            return result
    except Exception as e:
        logger.debug(f"Qdrant pedagogical fetch {course}/{subtopic_id}/{level}: {e}")

    return None


def get_full_pedagogical_profile(course: str, subtopic_id: str) -> Dict:
    """Return all available levels (L0–L4) for a subtopic as a dict."""
    return {
        level: (r["content"] if r else None)
        for level in ("L0", "L1", "L2", "L3", "L4")
        for r in [get_pedagogical_level(course, subtopic_id, level)]
    }


# =============================================================================
# MAIN SYNTHESIS
# =============================================================================

def synthesize_pedagogical_levels(
    course: str,
    subtopic_id: str,
    subtopic_name: str,
    topic_name: str,
    course_markdown: str,
    existing_stn: Optional[Dict] = None,
) -> Dict[str, bool]:
    """
    Synthesize L0–L4 for one subtopic.

    L0/L1 seeded from existing STN (no LLM call).
    L2/L3/L4 generated via SGLang.

    Returns {level: success_bool}.
    """
    results: Dict[str, bool] = {}

    # ── L0 / L1: seed from existing STN ──────────────────────────────────────
    if existing_stn:
        concept    = existing_stn.get("concept", "")
        key_points = existing_stn.get("key_points", [])
        math_content = existing_stn.get("math", "")

        if concept:
            results["L0"] = store_pedagogical_level(
                course, subtopic_id, subtopic_name, topic_name, "L0", concept
            )
        if key_points:
            results["L1"] = store_pedagogical_level(
                course, subtopic_id, subtopic_name, topic_name, "L1",
                {"key_points": key_points, "math": math_content},
            )

    # ── L2: technical depth ───────────────────────────────────────────────────
    l2 = _synthesize_l2(subtopic_name, course_markdown)
    results["L2"] = store_pedagogical_level(
        course, subtopic_id, subtopic_name, topic_name, "L2", l2
    ) if l2 else False

    # ── L3: worked examples ───────────────────────────────────────────────────
    l3 = _synthesize_l3(subtopic_name, course_markdown)
    results["L3"] = store_pedagogical_level(
        course, subtopic_id, subtopic_name, topic_name, "L3", l3
    ) if l3 else False

    # ── L4: misconception analysis ────────────────────────────────────────────
    l4 = _synthesize_l4(subtopic_name, course_markdown)
    results["L4"] = store_pedagogical_level(
        course, subtopic_id, subtopic_name, topic_name, "L4", l4
    ) if l4 else False

    return results


# =============================================================================
# STARTUP CACHE WARMER
# =============================================================================

def warm_pedagogical_cache(courses: Optional[List[str]] = None) -> int:
    """
    Pre-load ALL pedagogical notes from Qdrant into Redis.
    Called during app startup so that every subsequent request is served
    from Redis without any Qdrant round-trips.

    Returns number of entries warmed.
    """
    if not _REDIS_OK:
        logger.warning("CacheWarmer: Redis unavailable — skipping pedagogical warm.")
        return 0

    try:
        from qdrant_client import QdrantClient

        client = QdrantClient(host=config.QDRANT_HOST, port=config.QDRANT_PORT)
        try:
            client.get_collection(PEDAGOGICAL_COLLECTION)
        except Exception:
            logger.info("CacheWarmer: pedagogical_notes not found — nothing to warm.")
            return 0

        scroll_filter = None
        if courses:
            from qdrant_client.models import Filter, FieldCondition, MatchAny
            scroll_filter = Filter(must=[
                FieldCondition(key="course", match=MatchAny(any=[c.lower() for c in courses]))
            ])

        warmed = 0
        offset = None
        while True:
            results, next_offset = client.scroll(
                collection_name=PEDAGOGICAL_COLLECTION,
                scroll_filter=scroll_filter,
                limit=100,
                offset=offset,
                with_payload=True,
                with_vectors=False,
            )
            for point in results:
                p           = point.payload
                course_val  = p.get("course", "")
                sub_id      = p.get("subtopic_id", "")
                level       = p.get("level", "")
                raw         = p.get("content", "")
                ctype       = p.get("content_type", "text")

                if not (course_val and sub_id and level):
                    continue

                content = raw
                if ctype == "json":
                    try:
                        content = json.loads(raw)
                    except Exception:
                        pass

                cache_key = f"pedagogy:{course_val}:{sub_id}:{level}"
                _redis.set_cache(
                    cache_key,
                    {"content": content, "level": level},
                    expire_seconds=_CACHE_TTL,
                )
                warmed += 1

            if next_offset is None:
                break
            offset = next_offset

        logger.info(f"CacheWarmer: pre-loaded {warmed} pedagogical notes into Redis ✓")
        return warmed

    except Exception as e:
        logger.error(f"CacheWarmer failed: {e}", exc_info=True)
        return 0
