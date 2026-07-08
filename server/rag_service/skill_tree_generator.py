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
from prompts import SKILL_TREE_GENERATION_PROMPT, CHUNKED_SKILL_TREE_PROMPT, CROSS_CHUNK_LINKING_PROMPT

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


def load_course_skill_tree(course: str) -> Optional[Dict]:
    """
    Load skill tree for a course. For individual courses (e.g. EE1011),
    load the EE mega-course tree and filter to only nodes for that topic
    by querying Neo4j for the actual Subtopic→Topic relationships.
    """
    tree = load_skill_tree(course)
    if tree:
        return tree

    try:
        import neo4j_handler
        driver = neo4j_handler.get_driver_instance()
        with driver.session(database=config.NEO4J_DATABASE) as session:
            topic = session.run(
                "MATCH (c:Course {course: $course})-[:REFERENCES_TOPIC]->(t:Topic) "
                "RETURN t.id AS topic_id, t.name AS topic_name",
                course=course
            ).single()
            if not topic:
                return None

            topic_id = topic["topic_id"]

            # Get subtopic IDs that link to this topic via PREREQUISITE_OF
            sub_ids = set()
            sub_names = {}
            r = session.run(
                "MATCH (s:Subtopic)-[:PREREQUISITE_OF]->(t:Topic {course:'EE', id: $topic_id}) "
                "RETURN s.id AS sid, s.name AS sname",
                topic_id=topic_id
            )
            for row in r:
                sid = row["sid"]
                sname = row["sname"]
                sub_ids.add(sid)
                sub_names[sid] = sname

        if not sub_ids:
            return None

        ee_tree = load_skill_tree("EE")
        if not ee_tree:
            return None

        skill_tree = ee_tree.get("skill_tree", [])
        filtered = [n for n in skill_tree if n.get("subtopic_id") in sub_ids]

        if not filtered:
            return None

        return {
            "course": course,
            "skill_tree": filtered,
            "source_course": "EE",
            "source_topic": topic["topic_name"],
            "generation_method": "filtered_from_ee",
            "generated_at": ee_tree.get("generated_at", ""),
            "final_node_count": len(filtered),
        }
    except Exception as e:
        logger.warning(f"SkillTree: load for individual course '{course}' failed: {e}")
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


def _call_llm(prompt: str, max_tokens: int = 4000) -> Optional[str]:
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
                model=None,
                temperature=0.3,
                max_tokens=max_tokens,
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
# CHUNKING HELPERS
# =============================================================================

def _flatten_to_topics(modules: List[Dict]) -> List[Dict]:
    """Flatten curriculum into topic-level entries, each with its subtopics."""
    topics = []
    for m in modules:
        for t in m.get("topics", []):
            subs = t.get("subtopics", [])
            if not subs:
                continue
            topics.append({
                "module": {"id": m.get("id"), "name": m.get("name")},
                "topic": {"id": t.get("id"), "name": t.get("name")},
                "subtopics": subs,
            })
    return topics


def _chunk_topics(topics: List[Dict], max_chars: int) -> List[List[Dict]]:
    """Group topics into chunks of at most MAX_SUBS_PER_CHUNK subtopics.
    Input size is not the bottleneck (32K context) — output generation is.
    We limit output by capping subtopics per chunk to ~50."""
    MAX_SUBS_PER_CHUNK = 50
    chunks = []
    current_chunk = []
    current_count = 0

    for entry in topics:
        sub_count = len(entry["subtopics"])
        if current_count + sub_count > MAX_SUBS_PER_CHUNK and current_chunk:
            chunks.append(current_chunk)
            current_chunk = [entry]
            current_count = sub_count
        else:
            current_chunk.append(entry)
            current_count += sub_count

    if current_chunk:
        chunks.append(current_chunk)

    total_topics = len(topics)
    total_chunks = len(chunks)
    logger.info(
        f"SkillTree: Split {total_topics} topics ({sum(len(e['subtopics']) for e in topics)} subs) "
        f"into {total_chunks} chunks (max {MAX_SUBS_PER_CHUNK} subs/chunk)"
    )
    for i, chunk in enumerate(chunks):
        sub_count = sum(len(e["subtopics"]) for e in chunk)
        logger.info(f"  Chunk {i+1}: {len(chunk)} topics, {sub_count} subtopics")
    return chunks


def _topics_to_prompt_json(entries: List[Dict]) -> str:
    """Convert topic-level entries to compact prompt JSON."""
    flat = []
    for entry in entries:
        for s in entry["subtopics"]:
            flat.append({
                "module_id": entry["module"]["id"],
                "module_name": entry["module"]["name"],
                "topic_id": entry["topic"]["id"],
                "topic_name": entry["topic"]["name"],
                "subtopic_id": s.get("id", ""),
                "subtopic_name": s.get("name", ""),
            })
    return json.dumps(flat, ensure_ascii=False, indent=2)


def _build_cross_module_json(modules: List[Dict]) -> str:
    """Build a compact summary of all subtopics grouped by module for cross-chunk linking."""
    lines = []
    for m in modules:
        mid = m.get("id", "")
        mname = m.get("name", mid)
        lines.append(f'Module "{mid}" ({mname}):')
        for t in m.get("topics", []):
            for s in t.get("subtopics", []):
                sid = s.get("id", "")
                sname = s.get("name", sid)
                lines.append(f'  - "{sid}": "{sname}"')
        lines.append("")
    return "\n".join(lines)


# =============================================================================
# CHUNKED GENERATION
# =============================================================================

def _build_deterministic_skill_tree(
    course: str,
    modules: List[Dict],
) -> Dict:
    """
    Build a complete skill tree from curriculum ordering WITHOUT any LLM calls.

    Algorithm:
      1. Subtopics within a topic: linear chain based on 'order' field.
      2. Topics within a module: last subtopic of topic N → first subtopic of topic N+1.
      3. Modules: last subtopic of module N → first subtopic of module N+1.

    Difficulty:
      - Module position maps to difficulty bucket:
        first third  → foundational (1-4)
        middle third → intermediate (5-7)
        final third  → advanced    (8-10)

    This is deterministic, instant, and covers 100% of the curriculum.
    It can be refined with LLM analysis later when GPU/API resources are available.
    """
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    total_modules = len(modules)
    all_nodes: Dict[str, Dict] = {}
    all_subtopics_ordered: List[str] = []  # linear order across entire course
    previous_subtopic_id: Optional[str] = None

    for m_idx, module in enumerate(modules):
        mid = module.get("id", "")
        mname = module.get("name", mid)

        # Module position → difficulty bucket
        module_position_ratio = m_idx / max(total_modules - 1, 1)
        if module_position_ratio < 0.33:
            base_diff = 2
            base_level = "foundational"
        elif module_position_ratio < 0.66:
            base_diff = 5
            base_level = "intermediate"
        else:
            base_diff = 8
            base_level = "advanced"

        topics = module.get("topics", [])
        module_subtopics: List[str] = []
        last_subtopic_in_module: Optional[str] = None

        for t_idx, topic in enumerate(topics):
            tid = topic.get("id", "")
            tname = topic.get("name", tid)
            subtopics = topic.get("subtopics", [])

            if not subtopics:
                continue

            # Topic-level difficulty: adjust from module baseline
            topic_ratio = t_idx / max(len(topics) - 1, 1)
            if base_level == "foundational":
                diff_mod = int(topic_ratio * 3) + 1  # 1-4
            elif base_level == "intermediate":
                diff_mod = int(topic_ratio * 2) + 5  # 5-7
            else:
                diff_mod = int(topic_ratio * 2) + 8  # 8-10

            topic_diff = min(diff_mod, 10)
            if topic_diff <= 3:
                topic_level = "foundational"
            elif topic_diff <= 7:
                topic_level = "intermediate"
            else:
                topic_level = "advanced"

            subtopic_diff_step = max(1, topic_diff - 4)
            last_subtopic_in_topic: Optional[str] = None

            for s_idx, subtopic in enumerate(subtopics):
                sid = subtopic.get("id", "")
                sname = subtopic.get("name", sid)

                # Subtopic difficulty: vary slightly within topic
                sub_diff = min(topic_diff + (s_idx - len(subtopics) // 2) // max(len(subtopics) // 3, 1), 10)
                sub_diff = max(sub_diff, 1)

                sub_level = topic_level
                if sub_diff <= 3:
                    sub_level = "foundational"
                elif sub_diff <= 7:
                    sub_level = "intermediate"
                else:
                    sub_level = "advanced"

                # Learning outcomes: auto-generated from name
                learning_outcomes = [
                    f"Understand the concept of {sname}",
                    f"Apply {sname} in practical scenarios",
                ]

                # Prerequisites: previous subtopic in the same topic
                prereqs = []
                if last_subtopic_in_topic:
                    prereqs.append(last_subtopic_in_topic)
                elif previous_subtopic_id and last_subtopic_in_module is None:
                    # First subtopic of first topic in a new module: link to previous module's last
                    prereqs.append(previous_subtopic_id)

                all_nodes[sid] = {
                    "subtopic_id": sid,
                    "subtopic_name": sname,
                    "topic_id": tid,
                    "topic_name": tname,
                    "module_id": mid,
                    "module_name": mname,
                    "difficulty_score": sub_diff,
                    "skill_level": sub_level,
                    "estimated_study_hours": max(1, sub_diff // 2),
                    "prerequisites": prereqs,
                    "unlocks": [],
                    "learning_outcomes": learning_outcomes,
                }

                module_subtopics.append(sid)
                all_subtopics_ordered.append(sid)
                last_subtopic_in_topic = sid
                last_subtopic_in_module = sid
                previous_subtopic_id = sid

        # Cross-topic linking within module: link last subtopic of each topic
        # to first subtopic of the next topic (already handled by previous_subtopic_id)

    # Build unlocks from prerequisites (reverse edges)
    for sub_id, node in all_nodes.items():
        for prereq_id in node.get("prerequisites", []):
            if prereq_id in all_nodes:
                if sub_id not in all_nodes[prereq_id].get("unlocks", []):
                    all_nodes[prereq_id].setdefault("unlocks", []).append(sub_id)

    # Remove cycles (deterministic tree should not have cycles, but guard anyway)
    merged_tree = _remove_cycles(list(all_nodes.values()))

    payload = {
        "course": course,
        "generated_at": timestamp,
        "skill_tree": merged_tree,
        "generation_method": "deterministic_curriculum_ordering",
        "final_node_count": len(merged_tree),
    }

    # Persist to disk, Redis, Neo4j, and MongoDB
    _save_skill_tree(course, payload)
    _cache_skill_tree(course, payload)
    _write_skill_tree_to_neo4j(course, merged_tree)
    _sync_to_nodejs_mongodb(course, merged_tree)

    total_prereqs = sum(len(n.get("prerequisites", [])) for n in merged_tree)
    logger.info(
        f"SkillTree: Built deterministic tree for '{course}' — "
        f"{len(merged_tree)} nodes, {total_prereqs} prerequisite edges "
        f"(persisted to disk, Neo4j, MongoDB)"
    )
    return payload


def _generate_skill_tree_chunked(
    course: str,
    modules: List[Dict],
) -> Optional[Dict]:
    """
    Generate skill tree using the deterministic ordering approach.
    This is fast, complete, and does not require any LLM calls.

    Falls back to LLM chunked generation only if deterministic mode is explicitly
    disabled via SKILL_TREE_LLM_FALLBACK=1 environment variable.
    """
    use_llm = os.getenv("SKILL_TREE_LLM_FALLBACK", "").lower() in ("1", "true", "yes")

    if not use_llm:
        return _build_deterministic_skill_tree(course, modules)

    # LLM fallback (for GPU/API-powered environments where quality matters more)
    logger.info("SkillTree: Using LLM-based generation (SKILL_TREE_LLM_FALLBACK=1)")
    _SGLANG_MAX_CONTEXT = get_model_max_context()
    _MIN_COMPLETION_TOKENS = 2000
    _SYSTEM_OVERHEAD_CHARS = 800
    _MAX_CURRICULUM_CHARS = int(
        (_SGLANG_MAX_CONTEXT - _MIN_COMPLETION_TOKENS) * 3.5
    ) - _SYSTEM_OVERHEAD_CHARS

    topics = _flatten_to_topics(modules)
    chunks = _chunk_topics(topics, _MAX_CURRICULUM_CHARS)
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    all_nodes: Dict[str, Dict] = {}
    processed_chunks = 0

    for chunk_idx, chunk_entries in enumerate(chunks):
        chunk_curriculum = _topics_to_prompt_json(chunk_entries)
        chunk_info = f"Part {chunk_idx + 1} of {len(chunks)}"

        prompt = CHUNKED_SKILL_TREE_PROMPT.format(
            course=course,
            curriculum_json=chunk_curriculum,
            timestamp=timestamp,
            chunk_info=chunk_info,
        )

        logger.info(
            f"SkillTree: Chunk {chunk_idx+1}/{len(chunks)} "
            f"({len(chunk_curriculum)} chars, "
            f"{sum(len(e['subtopics']) for e in chunk_entries)} subtopics)..."
        )
        raw = _call_llm(prompt, max_tokens=8192)
        if not raw:
            logger.warning(f"SkillTree: Chunk {chunk_idx+1} returned nothing, skipping")
            continue

        payload = _extract_json(raw)
        if not payload or "skill_tree" not in payload:
            logger.warning(
                f"SkillTree: Could not parse chunk {chunk_idx+1} JSON: {raw[:200]}"
            )
            continue

        for node in payload["skill_tree"]:
            sub_id = node.get("subtopic_id", "")
            if not sub_id:
                continue
            if sub_id in all_nodes:
                existing = all_nodes[sub_id]
                existing_prereqs = set(existing.get("prerequisites", []))
                new_prereqs = set(node.get("prerequisites", []))
                existing_prereqs.update(new_prereqs)
                existing["prerequisites"] = list(existing_prereqs)
                existing["unlocks"] = list(
                    set(existing.get("unlocks", [])).union(
                        set(node.get("unlocks", []))
                    )
                )
            else:
                all_nodes[sub_id] = dict(node)

        processed_chunks += 1
        logger.info(
            f"SkillTree: Chunk {chunk_idx+1} → {len(payload['skill_tree'])} nodes "
            f"(total unique: {len(all_nodes)})"
        )

    if not all_nodes:
        logger.warning(f"SkillTree: No nodes generated for '{course}'")
        return None

    merged_tree = list(all_nodes.values())

    if processed_chunks > 1:
        try:
            cross_module_json = _build_cross_module_json(modules)
            cross_prompt = CROSS_CHUNK_LINKING_PROMPT.format(
                course=course,
                cross_module_json=cross_module_json,
            )
            logger.info(f"SkillTree: Cross-chunk linking for '{course}'...")
            raw = _call_llm(cross_prompt, max_tokens=4096)
            if raw:
                cross_payload = _extract_json(raw)
                if cross_payload and "cross_module_edges" in cross_payload:
                    cross_edges = cross_payload["cross_module_edges"]
                    added = 0
                    for sub_id, prereqs in cross_edges.items():
                        if not isinstance(prereqs, list):
                            continue
                        if sub_id in all_nodes:
                            existing_prereqs = set(
                                all_nodes[sub_id].get("prerequisites", [])
                            )
                            for p in prereqs:
                                if p not in existing_prereqs and p in all_nodes:
                                    existing_prereqs.add(p)
                                    added += 1
                            all_nodes[sub_id]["prerequisites"] = list(existing_prereqs)
                    logger.info(
                        f"SkillTree: Cross-chunk linking added {added} edges"
                    )
                    merged_tree = list(all_nodes.values())
                else:
                    logger.info("SkillTree: No cross-chunk edges found by LLM")
            else:
                logger.warning("SkillTree: Cross-chunk linking returned nothing")
        except Exception as e:
            logger.warning(f"SkillTree: Cross-chunk linking failed: {e}")

    merged_tree = _remove_cycles(merged_tree)

    payload = {
        "course": course,
        "generated_at": timestamp,
        "skill_tree": merged_tree,
        "chunks_used": len(chunks),
        "chunks_processed": processed_chunks,
        "final_node_count": len(merged_tree),
    }

    _save_skill_tree(course, payload)
    _cache_skill_tree(course, payload)
    _write_skill_tree_to_neo4j(course, merged_tree)
    _sync_to_nodejs_mongodb(course, merged_tree)

    total_prereqs = sum(len(n.get("prerequisites", [])) for n in merged_tree)
    logger.info(
        f"SkillTree: Done for '{course}' — "
        f"{len(merged_tree)} nodes, {total_prereqs} prerequisite edges "
        f"(merged from {processed_chunks}/{len(chunks)} chunks)"
    )
    return payload


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
    Uses deterministic curriculum-ordering approach (no LLM calls) by default.
    Set SKILL_TREE_LLM_FALLBACK=1 for LLM-based generation on GPU/API.

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

    return _generate_skill_tree_chunked(course, modules)


# =============================================================================
# NODE.JS MONGODB SYNC
# =============================================================================

def _sync_to_nodejs_mongodb(course: str, skill_tree: List[Dict]):
    """
    POST the skill tree to Node.js backend to sync into MongoDB SkillTree model.
    This bridges Python-generated skill tree data with the Node.js gamification system.
    Non-blocking — failure here does not break the pipeline.
    """
    nodejs_url = os.getenv("NODEJS_BACKEND_URL", "http://localhost:5001")
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
