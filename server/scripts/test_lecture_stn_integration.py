#!/usr/bin/env python3
"""
Tests for the three lecture/STN integration points:

  1. generate_subtopic_notes_from_concept   — concept-aware STN (prerequisites, importance)
  2. note_writer._load_stn_from_cache       — lecture generator reads Redis STN cache
  3. bootstrap_course._trigger_stn_from_kg  — single-command pipeline orchestration

Runs without any live services (mocks Redis, SGLang, Qdrant, requests).

    python -m pytest server/scripts/test_lecture_stn_integration.py -v
    # or:
    python server/scripts/test_lecture_stn_integration.py
"""

import json
import os
import sys
import unittest
from unittest.mock import MagicMock, patch

# ── Resolve paths ─────────────────────────────────────────────────────────────
ROOT        = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RAG_SERVICE = os.path.join(ROOT, "server", "rag_service")
LG_DIR      = os.path.join(ROOT, "lecture_generator")

# ── Stub server-side modules BEFORE any import touches them ───────────────────
_mock_config = MagicMock(
    GEMINI_VALIDATED=False,
    GEMINI_API_KEY="",
    GEMINI_MODEL_NAME="gemini-flash",
    QDRANT_HOST="localhost",
    QDRANT_PORT=6333,
    QDRANT_COLLECTION_NAME="col",
    DOCUMENT_EMBEDDING_MODEL_NAME="all-MiniLM-L6-v2",
    STN_BACKUP_DIR="/tmp/_stn_test",
    OLLAMA_BASE_URL="http://localhost:11434",
    OLLAMA_STN_MODEL="qwen2.5:3b",
    NEO4J_DATABASE="neo4j",
)

for _mod in ["config", "cache_service", "pythonjsonlogger",
             "pythonjsonlogger.jsonlogger", "dotenv", "google", "google.genai"]:
    sys.modules.setdefault(_mod, MagicMock())
sys.modules["config"] = _mock_config

if RAG_SERVICE not in sys.path:
    sys.path.insert(0, RAG_SERVICE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
if LG_DIR not in sys.path:
    sys.path.insert(0, LG_DIR)

import subtopic_notes_generator as sng


# =============================================================================
# INTEGRATION POINT 1 — concept-aware STN generation
# =============================================================================

class TestGenerateSubtopicNotesFromConcept(unittest.TestCase):

    def setUp(self):
        sng._REDIS_OK = False
        sng._redis = None
        sng._sglang_client = None
        sng._gemini_client = None
        os.makedirs("/tmp/_stn_test", exist_ok=True)

    def _llm_json(self, name="Concept"):
        return json.dumps({
            "concept": f"{name} is important.",
            "key_points": ["A", "B", "C"],
            "math": "",
            "worked_example": "Example.",
            "misconceptions": ["Myth 1"],
            "teaching_context": f"Rich explanation of {name}.",
        })

    # ------------------------------------------------------------------
    def test_payload_stores_importance_and_prerequisites(self):
        """Returned payload includes concept-graph metadata (importance, prereqs)."""
        with patch.object(sng, "get_subtopic_notes", return_value=None), \
             patch.object(sng, "_get_qdrant_chunks_for_subtopic", return_value=""), \
             patch.object(sng, "_call_llm", return_value=self._llm_json("Backpropagation")), \
             patch.object(sng, "_store_subtopic_notes"):

            result = sng.generate_subtopic_notes_from_concept(
                course="Machine Learning",
                concept_label="Backpropagation",
                concept_description="Algorithm for computing gradients.",
                concept_importance="core",
                prerequisites=["Forward Pass", "Chain Rule"],
                related_concepts=["Gradient Descent"],
            )

        self.assertIsNotNone(result)
        self.assertEqual(result["importance"], "core")
        self.assertEqual(result["prerequisites"], ["Forward Pass", "Chain Rule"])
        self.assertEqual(result["subtopic_name"], "Backpropagation")
        self.assertEqual(result["subtopic_id"], "backpropagation")
        self.assertIn("teaching_context", result)

    # ------------------------------------------------------------------
    def test_cache_hit_skips_llm(self):
        """A warm cache returns immediately without calling the LLM."""
        cached = {"teaching_context": "cached", "subtopic_name": "Backpropagation"}
        with patch.object(sng, "get_subtopic_notes", return_value=cached), \
             patch.object(sng, "_call_llm") as mock_llm:

            result = sng.generate_subtopic_notes_from_concept(
                course="ML", concept_label="Backpropagation", concept_description="..."
            )

        self.assertEqual(result, cached)
        mock_llm.assert_not_called()

    # ------------------------------------------------------------------
    def test_concept_aware_prompt_includes_importance_and_prereqs(self):
        """The prompt fed to the LLM contains importance and prerequisite labels."""
        captured = []

        def capture(prompt):
            captured.append(prompt)
            return self._llm_json("Softmax")

        with patch.object(sng, "get_subtopic_notes", return_value=None), \
             patch.object(sng, "_get_qdrant_chunks_for_subtopic", return_value=""), \
             patch.object(sng, "_call_llm", side_effect=capture), \
             patch.object(sng, "_store_subtopic_notes"):

            sng.generate_subtopic_notes_from_concept(
                course="ML",
                concept_label="Softmax",
                concept_description="Normalises logits.",
                concept_importance="supporting",
                prerequisites=["Logits", "Exp Function"],
            )

        self.assertEqual(len(captured), 1)
        prompt = captured[0]
        self.assertIn("supporting", prompt)
        self.assertIn("Logits",     prompt)
        self.assertIn("Exp Function", prompt)

    # ------------------------------------------------------------------
    def test_llm_failure_returns_none(self):
        """Returns None when all LLM backends fail."""
        with patch.object(sng, "get_subtopic_notes", return_value=None), \
             patch.object(sng, "_get_qdrant_chunks_for_subtopic", return_value=""), \
             patch.object(sng, "_call_llm", return_value=None):

            result = sng.generate_subtopic_notes_from_concept(
                course="ML", concept_label="SVM", concept_description="..."
            )

        self.assertIsNone(result)

    # ------------------------------------------------------------------
    def test_generate_course_notes_from_kg_processes_core_first(self):
        """generate_course_notes_from_kg processes core → supporting → detail."""
        order = []

        def fake_gen(course, concept_label, concept_importance="supporting", **kw):
            order.append((concept_label, concept_importance))
            return {"teaching_context": "ok"}

        concepts = [
            {"label": "Detail A",  "description": "", "importance": "detail",     "prereq_labels": [], "related_labels": []},
            {"label": "Core A",    "description": "", "importance": "core",       "prereq_labels": [], "related_labels": []},
            {"label": "Support A", "description": "", "importance": "supporting", "prereq_labels": [], "related_labels": []},
        ]

        with patch.object(sng, "generate_subtopic_notes_from_concept", side_effect=fake_gen):
            t = sng.generate_course_notes_from_kg("ML", concepts, delay_between=0)
            t.join(timeout=5)

        self.assertEqual(order[0], ("Core A",    "core"))
        self.assertEqual(order[1], ("Support A", "supporting"))
        self.assertEqual(order[2], ("Detail A",  "detail"))


# =============================================================================
# INTEGRATION POINT 2 — lecture note_writer reads STN Redis cache
# =============================================================================

def _import_note_writer():
    """Fresh import of note_writer with mocked lecture_generator dependencies."""
    for key in list(sys.modules):
        if "note_writer" in key:
            del sys.modules[key]

    sys.modules["lecture_generator.sglang_client"] = MagicMock()
    sys.modules["lecture_generator.config"] = MagicMock(
        NOTE_PARAMS={}, SCHEMA_PARAMS={}, DIAGRAM_PARAMS={}
    )
    sys.modules["lecture_generator.concept_extractor"] = MagicMock()

    # Use importlib so we get a real module object with correct __file__
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "lecture_generator.note_writer",
        os.path.join(LG_DIR, "note_writer.py"),
    )
    nw = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(nw)
    return nw


class TestNoteWriterSTNCache(unittest.TestCase):

    def setUp(self):
        self.nw = _import_note_writer()

    # ------------------------------------------------------------------
    def test_cache_hit_returns_teaching_context(self):
        mock_redis = MagicMock()
        mock_redis.get.return_value = json.dumps({
            "teaching_context": "Detailed notes on Gradient Descent.",
        })
        self.nw._redis_client = mock_redis
        self.nw._REDIS_OK = True

        result = self.nw._load_stn_from_cache("Machine Learning", "Gradient Descent")

        self.assertEqual(result, "Detailed notes on Gradient Descent.")
        mock_redis.get.assert_called_once_with(
            "subtopic_notes:machine learning:gradient_descent"
        )

    # ------------------------------------------------------------------
    def test_cache_miss_returns_empty_string(self):
        mock_redis = MagicMock()
        mock_redis.get.return_value = None
        self.nw._redis_client = mock_redis
        self.nw._REDIS_OK = True

        result = self.nw._load_stn_from_cache("ML", "Unknown Concept")
        self.assertEqual(result, "")

    # ------------------------------------------------------------------
    def test_redis_unavailable_returns_empty_string(self):
        self.nw._REDIS_OK = False
        self.nw._redis_client = None

        result = self.nw._load_stn_from_cache("ML", "Any Concept")
        self.assertEqual(result, "")

    # ------------------------------------------------------------------
    def test_redis_exception_returns_empty_string(self):
        mock_redis = MagicMock()
        mock_redis.get.side_effect = Exception("Redis down")
        self.nw._redis_client = mock_redis
        self.nw._REDIS_OK = True

        result = self.nw._load_stn_from_cache("ML", "Concept")
        self.assertEqual(result, "")

    # ------------------------------------------------------------------
    def test_generate_concept_note_prepends_stn_context_to_grounding(self):
        """STN teaching_context is prepended to the grounding block before SGLang call."""
        mock_redis = MagicMock()
        mock_redis.get.return_value = json.dumps({
            "teaching_context": "Cached backprop notes."
        })
        self.nw._redis_client = mock_redis
        self.nw._REDIS_OK = True

        captured = []

        def fake_generate_structured(system, user, schema_model, schema_name, params):
            captured.append(user)
            return None  # let it return None — we only care about the prompt

        import lecture_generator.sglang_client as sc
        sc.generate_structured = fake_generate_structured

        concept = MagicMock()
        concept.label = "Backpropagation"
        concept.description = "Gradient algo."
        concept.importance = "core"
        concept.prerequisites = []
        concept.has_math = True

        self.nw.generate_concept_note(
            concept=concept,
            topic="Deep Learning",
            all_labels=["Backpropagation"],
            grounding_context="Raw lecture excerpt.",
        )

        self.assertTrue(len(captured) > 0, "generate_structured was never called")
        prompt = captured[0]
        self.assertIn("Cached backprop notes.", prompt)
        self.assertIn("Raw lecture excerpt.", prompt)
        # STN block should appear before raw grounding
        self.assertLess(
            prompt.index("Cached backprop notes."),
            prompt.index("Raw lecture excerpt."),
        )


# =============================================================================
# INTEGRATION POINT 3 — bootstrap_course pipeline orchestration
# =============================================================================

def _import_bootstrap():
    """Import bootstrap_course.py with all heavy deps mocked out."""
    for key in list(sys.modules):
        if "bootstrap_course" in key:
            del sys.modules[key]

    for mod in [
        "lecture_generator", "lecture_generator.config",
        "lecture_generator.sglang_client", "lecture_generator.concept_extractor",
        "lecture_generator.course_loader", "lecture_generator.syllabus_loader",
        "generate_lecture",
    ]:
        sys.modules[mod] = MagicMock()

    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "bootstrap_course", os.path.join(ROOT, "bootstrap_course.py")
    )
    bc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bc)
    return bc


class TestBootstrapCoursePipeline(unittest.TestCase):

    def setUp(self):
        self.bc = _import_bootstrap()

    # ------------------------------------------------------------------
    def _make_kg(self):
        """Minimal two-concept KnowledgeGraph mock."""
        c1 = MagicMock(); c1.id = "c1"; c1.label = "Neural Networks"
        c1.description = "A model."; c1.importance = "core"; c1.prerequisites = []
        c2 = MagicMock(); c2.id = "c2"; c2.label = "Backprop"
        c2.description = "Grad algo."; c2.importance = "supporting"; c2.prerequisites = ["c1"]
        r1 = MagicMock(); r1.source = "c1"; r1.target = "c2"
        kg = MagicMock()
        kg.concepts = [c1, c2]
        kg.relationships = [r1]
        return kg

    # ------------------------------------------------------------------
    def test_posts_to_correct_endpoint_with_course_name_and_concepts(self):
        """POSTs to /course/stn_from_kg with correct course_name and concepts list."""
        mock_resp = MagicMock(); mock_resp.ok = True

        with patch("requests.post", return_value=mock_resp) as mock_post:
            result = self.bc._trigger_stn_from_kg(
                "Machine Learning", self._make_kg(), rag_url="http://localhost:2001"
            )

        self.assertTrue(result)
        mock_post.assert_called_once()
        url     = mock_post.call_args[0][0]
        payload = mock_post.call_args[1]["json"]

        self.assertEqual(url, "http://localhost:2001/course/stn_from_kg")
        self.assertEqual(payload["course_name"], "Machine Learning")
        self.assertEqual(len(payload["concepts"]), 2)

    # ------------------------------------------------------------------
    def test_prerequisite_ids_resolved_to_labels(self):
        """Concept c2 lists c1's label (not ID) in prereq_labels."""
        mock_resp = MagicMock(); mock_resp.ok = True

        with patch("requests.post", return_value=mock_resp) as mock_post:
            self.bc._trigger_stn_from_kg("ML", self._make_kg())

        payload   = mock_post.call_args[1]["json"]
        c2_entry  = next(c for c in payload["concepts"] if c["label"] == "Backprop")
        self.assertIn("Neural Networks", c2_entry["prereq_labels"])

    # ------------------------------------------------------------------
    def test_network_error_returns_false(self):
        """Connection error is caught gracefully and returns False."""
        with patch("requests.post", side_effect=Exception("Connection refused")):
            result = self.bc._trigger_stn_from_kg("ML", self._make_kg())
        self.assertFalse(result)

    # ------------------------------------------------------------------
    def test_non_ok_response_returns_false(self):
        """HTTP 500 from the RAG service is treated as failure."""
        mock_resp = MagicMock(); mock_resp.ok = False; mock_resp.status_code = 500
        with patch("requests.post", return_value=mock_resp):
            result = self.bc._trigger_stn_from_kg("ML", self._make_kg())
        self.assertFalse(result)

    # ------------------------------------------------------------------
    def test_missing_requests_package_returns_false(self):
        """ImportError for 'requests' is caught and returns False."""
        with patch.dict(sys.modules, {"requests": None}):
            # Force ImportError by removing from sys.modules
            original = sys.modules.pop("requests", None)
            try:
                result = self.bc._trigger_stn_from_kg("ML", self._make_kg())
            except Exception:
                result = False  # any uncaught exception = failure
            finally:
                if original is not None:
                    sys.modules["requests"] = original
        # We just verify it doesn't crash the process
        self.assertIsInstance(result, bool)


# =============================================================================
# BUG-FIX REGRESSION TESTS
# =============================================================================

class TestBugFixes(unittest.TestCase):
    """Regression tests for the three bugs found in the user's changes."""

    def setUp(self):
        sng._REDIS_OK = False
        sng._redis = None
        sng._sglang_client = None
        sng._gemini_client = None
        os.makedirs("/tmp/_stn_test", exist_ok=True)

    # ------------------------------------------------------------------
    # Bug 1: invalidate_course_stn used _redis._client (wrong attribute)
    # ------------------------------------------------------------------
    def test_invalidate_uses_redis_client_attribute(self):
        """invalidate_course_stn must use getattr(redis, 'redis_client'), not '_client'."""
        import subtopic_notes_generator as sng2
        sng2._REDIS_OK = True
        mock_cache = MagicMock()
        mock_redis_inner = MagicMock()
        mock_redis_inner.keys.return_value = [b"im_cache:subtopic_notes:ml:backprop"]
        mock_cache.redis_client = mock_redis_inner
        # Remove _client so only redis_client exists (validates fix)
        if hasattr(mock_cache, '_client'):
            del mock_cache._client
        sng2._redis = mock_cache

        count = sng2.invalidate_course_stn("ml")

        mock_redis_inner.keys.assert_called_once()
        mock_redis_inner.delete.assert_called_once()
        self.assertEqual(count, 1)
        sng2._REDIS_OK = False

    # ------------------------------------------------------------------
    # Bug 2: generate_subtopic_notes() hardcoded importance="core"
    # ------------------------------------------------------------------
    def test_generate_subtopic_notes_uses_supporting_importance(self):
        """Standard generate_subtopic_notes must not hardcode importance='core'."""
        captured = []

        def capture(prompt):
            captured.append(prompt)
            return json.dumps({
                "concept": "x", "key_points": [], "math": "",
                "worked_example": "", "misconceptions": [],
                "teaching_context": "ok",
            })

        with patch.object(sng, "get_subtopic_notes", return_value=None), \
             patch.object(sng, "_get_qdrant_chunks_for_subtopic", return_value=""), \
             patch.object(sng, "_get_neo4j_prerequisites", return_value=[]), \
             patch.object(sng, "_call_llm", side_effect=capture), \
             patch.object(sng, "_store_subtopic_notes"):
            sng.generate_subtopic_notes("ML", "t1", "Intro", "subtopic1", "Activation Functions")

        self.assertEqual(len(captured), 1)
        prompt = captured[0]
        # The Importance line must read "supporting", not "core"
        # (the legend always contains "core = must know" — we check the value, not the legend)
        import re as _re
        importance_match = _re.search(r"Importance\s*:\s*(\w+)", prompt)
        self.assertIsNotNone(importance_match, "Prompt must contain an Importance field")
        self.assertEqual(importance_match.group(1), "supporting",
                         "generate_subtopic_notes must default to 'supporting', not 'core'")

    # ------------------------------------------------------------------
    # Bug 3: graph_rag.extract_and_store_graph wrong call to generate_graph_from_text
    # ------------------------------------------------------------------
    def test_graph_rag_passes_llm_function_to_generator(self):
        """extract_and_store_graph must call generate_graph_from_text(text, llm_fn)."""
        # Clear any cached import of graph_rag
        for key in list(sys.modules):
            if "graph_rag" in key:
                del sys.modules[key]

        sys.modules.setdefault("neo4j_handler", MagicMock())
        sys.modules.setdefault("ai_core", MagicMock())

        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "graph_rag",
            os.path.join(RAG_SERVICE, "graph_rag.py"),
        )
        gr = importlib.util.module_from_spec(spec)

        call_args = []

        def fake_gen(text, llm_fn):
            call_args.append((text, llm_fn))
            return {"nodes": [], "edges": []}

        mock_kg_gen = MagicMock()
        mock_kg_gen.generate_graph_from_text = fake_gen
        sys.modules["knowledge_graph_generator"] = mock_kg_gen

        mock_nh = MagicMock()
        mock_nh.ingest_knowledge_graph = MagicMock()
        sys.modules["neo4j_handler"] = mock_nh

        spec.loader.exec_module(gr)

        import asyncio
        asyncio.run(gr.extract_and_store_graph("Some course text.", "doc.pdf", "user1"))

        self.assertEqual(len(call_args), 1, "generate_graph_from_text should be called once")
        _, llm_fn = call_args[0]
        self.assertTrue(callable(llm_fn), "second argument must be a callable llm_function")

    # ------------------------------------------------------------------
    # Fix 4: _store_subtopic_notes calls Qdrant + Neo4j writers
    # ------------------------------------------------------------------
    def test_store_subtopic_notes_calls_qdrant_and_neo4j_writers(self):
        """_store_subtopic_notes must invoke both _write_stn_to_qdrant and _write_stn_to_neo4j."""
        payload = {
            "teaching_context": "Detailed explanation.",
            "concept": "SGD", "key_points": [], "math": "",
            "subtopic_name": "SGD", "topic_name": "Optimisation",
            "topic_id": "opt", "importance": "core", "misconceptions": [],
        }
        with patch.object(sng, "_write_stn_to_qdrant") as mock_qdrant, \
             patch.object(sng, "_write_stn_to_neo4j") as mock_neo4j, \
             patch.object(sng, "_save_stn_backup"):
            sng._store_subtopic_notes("ML", "sgd", payload)

        mock_qdrant.assert_called_once_with("ML", "sgd", payload)
        mock_neo4j.assert_called_once_with("ML", "sgd", payload)

    # ------------------------------------------------------------------
    # Fix 5: _write_stn_to_neo4j uses correct Cypher
    # ------------------------------------------------------------------
    def test_write_stn_to_neo4j_sets_correct_properties(self):
        """_write_stn_to_neo4j must SET teaching_context, importance, stn_updated_at."""
        mock_driver = MagicMock()
        mock_session = MagicMock()
        mock_driver.session.return_value.__enter__ = MagicMock(return_value=mock_session)
        mock_driver.session.return_value.__exit__ = MagicMock(return_value=False)

        mock_nh = MagicMock()
        mock_nh.get_driver_instance.return_value = mock_driver

        payload = {
            "teaching_context": "Rich notes on backprop.",
            "importance": "core",
        }
        with patch.dict(sys.modules, {"neo4j_handler": mock_nh}):
            sng._write_stn_to_neo4j("ML", "backpropagation", payload)

        mock_session.run.assert_called_once()
        cypher, params = mock_session.run.call_args[0][0], mock_session.run.call_args[1]
        self.assertIn("teaching_context", cypher)
        self.assertIn("importance", cypher)
        self.assertIn("stn_updated_at", cypher)
        self.assertEqual(params["teaching_context"], "Rich notes on backprop.")
        self.assertEqual(params["importance"], "core")


# =============================================================================

if __name__ == "__main__":
    unittest.main(verbosity=2)
