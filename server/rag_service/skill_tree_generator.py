# server/rag_service/skill_tree_generator.py
"""
Skill Tree Generator
=====================

Builds a prerequisite dependency graph for every course in the system.
The skill tree enables:
  • Adaptive learning paths  (student sees what to study next)
  • Gap detection            (identify weak prerequisite subtopics)
  • Frontend roadmap display (visual dependency graph)

Algorithm:
  1. Pull the full curriculum from Neo4j via curriculum_graph_handler.
  2. Feed the full curriculum JSON to the LLM with the SKILL_TREE_GENERATION_PROMPT.
  3. Parse the LLM response into a typed SkillTree structure.
  4. Write PREREQUISITE_OF edges between Subtopic nodes in Neo4j.
  5. Save the full tree as skill_tree.json in the course directory for
     offline access and fast frontend serving.

Storage:
  • Neo4j   — PREREQUISITE_OF, UNLOCKS relationships on Subtopic nodes
  • Disk    — course_bootstrap/<Course>/skill_tree.json
  • Redis   — skill_tree:<course>   (1-day TTL, optional)
"""

import json
import logging
import os
import re
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional

import config
from sglang_caps import get_model_max_context
from prompts import SKILL_TREE_GENERATION_PROMPT

# Import Provider Manager
try:
    from llm_provider_manager import get_llm_manager
    _PROVIDER_MANAGER_AVAILABLE = True
except ImportError:
    _PROVIDER_MANAGER_AVAILABLE = False
    logging.getLogger(__name__).warning("Provider Manager not available, using legacy LLM calls")

logger = logging.getLogger(__name__)

_CACHE_TTL = 24 * 3600  # 1 day

# ── Redis ─────────────────────────────────────────────────────────────────────
try:
    from cache_service import cache_service as _redis
    _REDIS_OK = True
except Exception:
    _redis = None
    _REDIS_OK = False

# ── Bootstrap base directory ──────────────────────────────────────────────────
_BOOTSTRAP_DIR = os.path.abspath(
    os.getenv(
        "COURSE_BOOTSTRAP_DIR",
        os.path.join(os.path.dirname(__file__), "..", "course_bootstrap"),
    )
)


# =============================================================================
# DISK / CACHE HELPERS
# =============================================================================

def _skill_tree_path(course: str) -> str:
    course_dir = os.path.join(_BOOTSTRAP_DIR, course)
    os.makedirs(course_dir, exist_ok=True)
    return os.path.join(course_dir, "skill_tree.json")


def _save_skill_tree(course: str, payload: Dict):
    try:
        path = _skill_tree_path(course)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
        logger.info(f"SkillTree: saved to disk for '{course}'")
    except Exception as e:
        logger.warning(f"SkillTree: disk save failed for '{course}': {e}")


def load_skill_tree(course: str) -> Optional[Dict]:
    """Load skill tree — Redis first, then disk."""
    if _REDIS_OK:
        try:
            cached = _redis.get_cache(f"skill_tree:{course.lower()}")
            if cached:
                return cached
        except Exception:
            pass

    path = _skill_tree_path(course)
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                tree = json.load(f)
            if _REDIS_OK:
                try:
                    _redis.set_cache(f"skill_tree:{course.lower()}", tree, expire_seconds=_CACHE_TTL)
                except Exception:
                    pass
            return tree
        except Exception as e:
            logger.warning(f"SkillTree: disk load failed for '{course}': {e}")
    return None


def _cache_skill_tree(course: str, payload: Dict):
    if _REDIS_OK:
        try:
            _redis.set_cache(f"skill_tree:{course.lower()}", payload, expire_seconds=_CACHE_TTL)
        except Exception:
            pass


# =============================================================================
# NEO4J PERSISTENCE
# =============================================================================

def _write_skill_tree_to_neo4j(course: str, skill_tree: List[Dict]) -> int:
    """
    Write PREREQUISITE_OF and UNLOCKS relationships between Subtopic nodes.
    Relationships are idempotent — safe to call multiple times.

    Returns number of edges created.
    """
    try:
        import neo4j_handler

        edges_created = 0
        for node in skill_tree:
            sub_id = node.get("subtopic_id", "")
            if not sub_id:
                continue

            # Write difficulty_score and skill_level back onto the Subtopic node
            def _update_node(tx, _sub_id, _node, _course):
                tx.run(
                    """
                    MATCH (s:Subtopic {id: $id})
                    WHERE toLower(s.course) = toLower($course)
                    SET s.difficulty_score = $diff,
                        s.skill_level = $level,
                        s.estimated_study_hours = $hours,
                        s.learning_outcomes = $outcomes
                    """,
                    id=_sub_id,
                    course=_course,
                    diff=_node.get("difficulty_score", 5),
                    level=_node.get("skill_level", "intermediate"),
                    hours=_node.get("estimated_study_hours", 2),
                    outcomes=_node.get("learning_outcomes", []),
                )

            try:
                neo4j_handler._execute_write_tx(_update_node, sub_id, node, course)
            except Exception as e:
                logger.debug(f"SkillTree Neo4j node update failed {sub_id}: {e}")

            # Create PREREQUISITE_OF edges
            for prereq_id in node.get("prerequisites", []):
                def _create_prereq_edge(tx, _from_id, _to_id, _course):
                    tx.run(
                        """
                        MATCH (prereq:Subtopic {id: $prereq_id})
                              WHERE toLower(prereq.course) = toLower($course)
                        MATCH (sub:Subtopic {id: $sub_id})
                              WHERE toLower(sub.course) = toLower($course)
                        MERGE (prereq)-[:PREREQUISITE_OF]->(sub)
                        """,
                        prereq_id=_from_id,
                        sub_id=_to_id,
                        course=_course,
                    )

                try:
                    neo4j_handler._execute_write_tx(_create_prereq_edge, prereq_id, sub_id, course)
                    edges_created += 1
                except Exception as e:
                    logger.debug(f"SkillTree Neo4j prereq edge failed {prereq_id}→{sub_id}: {e}")

        logger.info(f"SkillTree Neo4j: wrote {edges_created} PREREQUISITE_OF edges for '{course}'")
        return edges_created

    except Exception as e:
        logger.error(f"SkillTree Neo4j write failed for '{course}': {e}", exc_info=True)
        return 0


# =============================================================================
# LLM CALL  —  Provider Manager (SGLang → Grok → Gemini → Ollama)
# =============================================================================

_sglang_client = None
if config.SGLANG_ENABLED:
    try:
        from openai import OpenAI as _OAI
        _sglang_client = _OAI(base_url=config.SGLANG_HEAVY_URL, api_key="EMPTY")
        logger.info(f"SkillTree: SGLang client ready ({config.SGLANG_HEAVY_MODEL})")
    except Exception as _e:
        logger.warning(f"SkillTree: SGLang client init failed: {_e}")

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
                logger.info(f"SkillTree LLM: Provider Manager ok ({len(text)} chars)")
                return text
        except Exception as e:
            logger.warning(f"SkillTree LLM: Provider Manager failed: {e}")

    # ── 1. SGLang (primary — legacy fallback) ────────────────────────────────
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
                logger.info(f"SkillTree LLM: SGLang ok ({len(text)} chars)")
                return text
        except Exception as e:
            logger.error(f"SkillTree LLM: SGLang failed: {e}")

    # ── 2. Gemini — ONLY if admin has validated the key ───────────────────────
    if config.GEMINI_VALIDATED and not _gemini_dead:
        try:
            from google import genai
            client = genai.Client(api_key=config.GEMINI_API_KEY)
            resp = client.models.generate_content(
                model=config.GEMINI_MODEL_NAME, contents=prompt
            )
            if resp.text:
                logger.info("SkillTree LLM: Gemini fallback used")
                return resp.text.strip()
        except Exception as e:
            err = str(e)
            if "API_KEY_INVALID" in err or "expired" in err.lower():
                _gemini_dead = True
                logger.error("SkillTree LLM: Gemini key invalid — set GEMINI_API_VALIDATED=false in .env")
            else:
                logger.error(f"SkillTree LLM: Gemini error: {e}")
    elif not config.GEMINI_VALIDATED and config.GEMINI_API_KEY:
        logger.warning("SkillTree LLM: SGLang unavailable and Gemini not admin-validated — cannot generate.")

    logger.error("SkillTree LLM: No LLM available. Ensure at least one provider is configured.")
    return None


def _repair_truncated_json(text: str) -> str:
    """
    Close any unclosed brackets/braces in a truncated JSON string so that
    json.loads can recover partial output from a max-tokens-cut response.
    """
    # Remove trailing incomplete token (last comma, partial string, etc.)
    text = text.rstrip()
    # Remove trailing comma before we close
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

    # Close all unclosed containers in reverse order (and any open string literal)
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
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-z]*\n?", "", cleaned).rstrip("`").strip()

    _lax = json.JSONDecoder(strict=False)

    # 1. Try as-is
    try:
        return json.loads(cleaned)
    except Exception:
        pass

    # 2. Lax parse — allows literal control chars (newlines) inside strings
    try:
        return _lax.decode(cleaned)
    except Exception:
        pass

    # 3. Sanitize invalid backslash escapes (math: \sqrt, \sum, \delta …)
    try:
        return json.loads(_sanitize_backslashes(cleaned))
    except Exception:
        pass
    try:
        return _lax.decode(_sanitize_backslashes(cleaned))
    except Exception:
        pass

    # 4. Try regex-extracted object
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

    # 5. Try repairing truncated output (SGLang hit max_tokens)
    try:
        result = _lax.decode(_sanitize_backslashes(_repair_truncated_json(cleaned)))
        logger.info("SkillTree: repaired truncated JSON response ✓")
        return result
    except Exception:
        pass

    # 6. Try repairing just the inner object
    if m:
        try:
            result = _lax.decode(_sanitize_backslashes(_repair_truncated_json(m.group())))
            logger.info("SkillTree: repaired truncated inner JSON ✓")
            return result
        except Exception:
            pass

    return None


# =============================================================================
# CURRICULUM → COMPACT JSON FOR PROMPT
# =============================================================================

def _curriculum_to_prompt_json(modules: List[Dict]) -> str:
    """
    Flatten curriculum into a compact JSON list that fits in the LLM context window.
    Each entry: {module_id, module_name, topic_id, topic_name, subtopic_id, subtopic_name}
    """
    entries = []
    for m in modules:
        for t in m.get("topics", []):
            for s in t.get("subtopics", []):
                entries.append({
                    "module_id": m.get("id", ""),
                    "module_name": m.get("name", ""),
                    "topic_id": t.get("id", ""),
                    "topic_name": t.get("name", ""),
                    "subtopic_id": s.get("id", ""),
                    "subtopic_name": s.get("name", ""),
                })
    return json.dumps(entries, ensure_ascii=False, indent=2)


# =============================================================================
# CYCLE DETECTION (guard against LLM introducing circular dependencies)
# =============================================================================

def _remove_cycles(skill_tree: List[Dict]) -> List[Dict]:
    """
    Topological sort / cycle removal using DFS.
    Any edge that introduces a cycle is silently dropped.
    """
    id_to_node: Dict[str, Dict] = {n["subtopic_id"]: n for n in skill_tree if n.get("subtopic_id")}
    visited: set = set()
    in_stack: set = set()
    safe_prereqs: Dict[str, List[str]] = {nid: list(n.get("prerequisites", [])) for nid, n in id_to_node.items()}

    def _dfs(node_id: str) -> bool:
        """Returns True if a cycle was found/removed for this node."""
        if node_id in in_stack:
            return True  # cycle
        if node_id in visited:
            return False
        in_stack.add(node_id)
        kept = []
        for prereq in safe_prereqs.get(node_id, []):
            if _dfs(prereq):
                logger.warning(f"SkillTree: Cycle removed — dropping edge {prereq}→{node_id}")
            else:
                kept.append(prereq)
        safe_prereqs[node_id] = kept
        in_stack.discard(node_id)
        visited.add(node_id)
        return False

    for nid in list(id_to_node.keys()):
        _dfs(nid)

    for node in skill_tree:
        nid = node.get("subtopic_id", "")
        if nid in safe_prereqs:
            node["prerequisites"] = safe_prereqs[nid]

    return skill_tree


# =============================================================================
# PUBLIC API
# =============================================================================

def generate_skill_tree(
    course: str,
    modules: List[Dict],
    force: bool = False,
) -> Optional[Dict]:
    """
    Generate (or return cached) the skill tree for a course.

    Args:
        course:  Course name matching course_bootstrap directory.
        modules: Curriculum structure from curriculum_graph_handler.
        force:   Regenerate even if a cached version exists.

    Returns:
        The skill tree dict, or None on failure.
    """
    if not force:
        existing = load_skill_tree(course)
        if existing:
            logger.debug(f"SkillTree: cache HIT for '{course}'")
            return existing

    if not modules:
        logger.warning(f"SkillTree: no modules for '{course}' — skipping.")
        return None

    curriculum_json = _curriculum_to_prompt_json(modules)

    # Guard: if the curriculum JSON alone is too large for the model's context,
    # truncate it so we always leave at least 1500 tokens for the completion.
    _SGLANG_MAX_CONTEXT = get_model_max_context()  # reads /v1/models once, then cached
    _MIN_COMPLETION_TOKENS = 1500
    _SYSTEM_OVERHEAD_CHARS = 200   # system prompt chars
    _MAX_CURRICULUM_CHARS = int((_SGLANG_MAX_CONTEXT - _MIN_COMPLETION_TOKENS) * 3.5) - _SYSTEM_OVERHEAD_CHARS
    if len(curriculum_json) > _MAX_CURRICULUM_CHARS:
        logger.warning(f"SkillTree: Curriculum too large ({len(curriculum_json)} chars) — truncating to {_MAX_CURRICULUM_CHARS} chars for SGLang context limit.")
        curriculum_json = curriculum_json[:_MAX_CURRICULUM_CHARS] + "\n]"  # close the JSON array

    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    prompt = SKILL_TREE_GENERATION_PROMPT.format(
        course=course,
        curriculum_json=curriculum_json,
        timestamp=timestamp,
    )

    logger.info(f"SkillTree: Generating for '{course}' ({len(curriculum_json)} chars curriculum)…")
    raw = _call_llm(prompt)
    if not raw:
        logger.warning(f"SkillTree: LLM returned nothing for '{course}'")
        return None

    payload = _extract_json(raw)
    if not payload or "skill_tree" not in payload:
        logger.warning(f"SkillTree: Could not parse JSON for '{course}': {raw[:300]}")
        return None

    payload.setdefault("course", course)
    payload.setdefault("generated_at", timestamp)

    # Remove any cycles introduced by the LLM
    payload["skill_tree"] = _remove_cycles(payload["skill_tree"])

    # Persist
    _save_skill_tree(course, payload)
    _cache_skill_tree(course, payload)

    # Write relationships to Neo4j
    _write_skill_tree_to_neo4j(course, payload["skill_tree"])

    # Sync to Node.js MongoDB SkillTree model (for frontend/gamification)
    _sync_to_nodejs_mongodb(course, payload["skill_tree"])

    total = len(payload["skill_tree"])
    total_prereqs = sum(len(n.get("prerequisites", [])) for n in payload["skill_tree"])
    logger.info(
        f"SkillTree: Done for '{course}' — {total} nodes, {total_prereqs} prerequisite edges"
    )
    return payload


# =============================================================================
# NODE.JS MONGODB SYNC
# =============================================================================

def _sync_to_nodejs_mongodb(course: str, skill_tree: List[Dict]):
    """
    POST the skill tree to Node.js backend to sync into MongoDB SkillTree model.
    This bridges Python-generated skill tree data with the Node.js gamification system.
    Non-blocking — failure here does not break the pipeline.
    """
    nodejs_url = os.getenv("NODEJS_BACKEND_URL", "http://localhost:3000")
    sync_endpoint = f"{nodejs_url}/api/internal/skill-tree/sync"

    internal_token = os.getenv("INTERNAL_SERVICE_TOKEN", "")

    try:
        import requests
        headers = {"Content-Type": "application/json"}
        if internal_token:
            headers["X-Internal-Token"] = internal_token

        resp = requests.post(
            sync_endpoint,
            json={"course": course, "skill_tree": skill_tree},
            headers=headers,
            timeout=30,
        )
        if resp.status_code == 200:
            data = resp.json()
            logger.info(
                f"SkillTree MongoDB sync OK for '{course}': "
                f"{data.get('created', 0)} created, {data.get('updated', 0)} updated"
            )
        else:
            logger.warning(
                f"SkillTree MongoDB sync returned {resp.status_code} for '{course}': "
                f"{resp.text[:200]}"
            )
    except Exception as e:
        logger.warning(
            f"SkillTree MongoDB sync failed for '{course}' (non-fatal): {e}"
        )
