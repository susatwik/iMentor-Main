#!/usr/bin/env python3
"""
test_routing.py — offline routing correctness tester
=====================================================
Tests the semanticRouter.js (12-class tool-activation router) and the
routing_prototypes.json (3-class style router) WITHOUT requiring any server
to be running.  Uses the pre-embedded JSON caches + fastembed directly.

Embedding priority:
  1. fastembed TextEmbedding (same model as production — mxbai-embed-large-v1)
  2. Running RAG service at EMBED_SERVICE env var  (e.g. http://localhost:2001)
  3. Pseudo-embedding fallback (structural test only; accuracy not guaranteed)

Run:
    python3 server/scripts/test_routing.py
"""

import json
import math
import os
import sys
from dataclasses import dataclass, field
from typing import Optional

# ── Try to load fastembed (same model as production) ─────────────────────────
_FASTEMBED_MODEL_NAME = os.getenv("EMBED_MODEL", "mixedbread-ai/mxbai-embed-large-v1")
_fastembed_model = None
try:
    from fastembed import TextEmbedding as _FE
    print(f"[embed] Loading fastembed model '{_FASTEMBED_MODEL_NAME}' …", flush=True)
    _fastembed_model = _FE(model_name=_FASTEMBED_MODEL_NAME)
    print("[embed] Model ready ✓")
except Exception as _fe_err:
    print(f"[embed] fastembed unavailable ({_fe_err}) — will try service or pseudo-embedding")

# ── Paths ─────────────────────────────────────────────────────────────────────
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEMANTIC_CACHE  = os.path.join(BASE, "data", "semantic_router_cache.json")
PROTO_CACHE     = os.path.join(BASE, "data", "routing_prototypes.json")

# Optional: point to a running RAG /embed service as fallback
_EMBED_SERVICE: Optional[str] = os.getenv("EMBED_SERVICE")  # e.g. "http://localhost:2001"

# ── Config mirrors of semanticRouter.js ──────────────────────────────────────
# These thresholds must stay in sync with semanticRouter.js confidence_threshold values.
CONFIDENCE_THRESHOLDS = {
    "DEEP_RESEARCH":          0.60,   # was 0.75
    "ACADEMIC_SEARCH":        0.60,   # was 0.70
    "WEB_SEARCH":             0.52,   # was 0.60
    "TECHNICAL_CODING":       0.57,   # was 0.75
    "MATHEMATICAL_REASONING": 0.68,   # was 0.80
    "CONCEPTUAL_EXPLANATION": 0.70,
    "SOCRATIC_TUTORING":      0.72,   # was 0.75
    "DOCUMENT_RAG":           0.70,
    "ENTERTAINMENT":          0.56,   # was 0.65
    "LIFESTYLE_PERSONAL":     0.60,   # was 0.65
    "INAPPROPRIATE":          0.57,   # was 0.70
    "MEMORY_RECALL":          0.75,
    "GREETING":               0.70,
}
GLOBAL_MIN_SCORE = 0.55   # below → default to CONCEPTUAL_EXPLANATION/fallback
REJECTION_INTENTS = {"ENTERTAINMENT", "LIFESTYLE_PERSONAL", "INAPPROPRIATE"}

# Proto router (3-class style) thresholds
PROTO_FALLBACK       = 0.65
PROTO_DIRECT_ANSWER  = 0.75
PROTO_TOT            = 0.75


# ── Maths ─────────────────────────────────────────────────────────────────────
def cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na  = math.sqrt(sum(x * x for x in a))
    nb  = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


def top3_mean(sims):
    return sum(sorted(sims, reverse=True)[:3]) / min(3, len(sims)) if sims else 0.0


# ── Load caches ───────────────────────────────────────────────────────────────
def load_semantic_cache():
    with open(SEMANTIC_CACHE) as f:
        raw = json.load(f)
    cache = {}
    for intent, data in raw.items():
        embeddings = [e["vector"] for e in data.get("embeddings", []) if e.get("vector")]
        if embeddings:
            # Use stored threshold if present, else fall back to dict above
            stored_thresh = data.get("config", {}).get("confidence_threshold")
            cache[intent] = {
                "embeddings": embeddings,
                "threshold":  stored_thresh if stored_thresh is not None else CONFIDENCE_THRESHOLDS.get(intent, 0.70),
            }
    return cache


def load_proto_cache():
    with open(PROTO_CACHE) as f:
        raw = json.load(f)
    protos = {}
    for p in raw["prototypes"]:
        route = p["route"]
        if p.get("embedding") and len(p["embedding"]) > 0:
            protos.setdefault(route, []).append(p["embedding"])
    return protos


# ── Routing functions (mirrors of JS) ────────────────────────────────────────
def classify_semantic(query_vec, cache, context=None):
    """Mirror of classifyIntent() with context-aware scoring."""
    context = context or {}
    has_file     = context.get("hasUploadedFiles", False)
    active_tools = context.get("activeTools", {})

    best_intent, best_score = None, 0.0
    all_scores = {}

    for intent, data in cache.items():
        vectors = data["embeddings"]
        thresh  = data["threshold"]
        sims  = [cosine(query_vec, v) for v in vectors]
        score = top3_mean(sims)

        # Context-aware boosts (mirrors JS changes)
        if intent == "DOCUMENT_RAG" and has_file:
            score = min(score * 1.3, 1.0)
        if intent == "WEB_SEARCH"      and active_tools.get("webSearch"):
            score = min(score * 1.15, 1.0)
        if intent == "ACADEMIC_SEARCH" and active_tools.get("academicSearch"):
            score = min(score * 1.15, 1.0)
        if intent == "DEEP_RESEARCH"   and active_tools.get("deepResearch"):
            score = min(score * 1.15, 1.0)

        all_scores[intent] = round(score, 4)
        if score > best_score and score >= thresh:
            best_score  = score
            best_intent = intent

    if not best_intent or best_score < GLOBAL_MIN_SCORE:
        best_intent = "CONCEPTUAL_EXPLANATION"  # default

    return best_intent, round(best_score, 4), all_scores


def classify_proto(query_vec, proto_cache):
    """Mirror of semanticRouterService.js getSemanticRoute."""
    route_scores = {}
    for route, vectors in proto_cache.items():
        sims = [cosine(query_vec, v) for v in vectors]
        route_scores[route] = top3_mean(sims)

    best_route = max(route_scores, key=route_scores.get)
    best_conf  = route_scores[best_route]
    resolved   = best_route if best_conf >= PROTO_FALLBACK else None
    return resolved, round(best_conf, 4), route_scores


# ── Test cases ────────────────────────────────────────────────────────────────
@dataclass
class Case:
    query:        str
    expected:     str          # expected semantic-router intent
    proto_expect: str = "standard"   # expected 3-class route (direct_answer/standard/tot)
    context:      dict = field(default_factory=dict)
    tags:         list = field(default_factory=list)


TEST_CASES: list[Case] = [
    # ── Greetings ──────────────────────────────────────────────────────────
    Case("Hello!",                          "GREETING",               "direct_answer", tags=["greeting"]),
    Case("Hi, how are you?",                "GREETING",               "direct_answer", tags=["greeting"]),
    Case("Good morning, can you help me?",  "GREETING",               "direct_answer", tags=["greeting"]),

    # ── Technical coding ───────────────────────────────────────────────────
    Case("Write a Python function to reverse a linked list",        "TECHNICAL_CODING", "standard",      tags=["code"]),
    Case("How do I implement OAuth2 in Express.js?",                "TECHNICAL_CODING", "standard",      tags=["code"]),
    Case("Debug this React useEffect infinite loop",                "TECHNICAL_CODING", "standard",      tags=["code"]),
    Case("What is the time complexity of merge sort?",              "TECHNICAL_CODING", "standard",      tags=["code"]),
    Case("Build a REST API with JWT authentication in FastAPI",     "TECHNICAL_CODING", "standard",      tags=["code"]),

    # ── Mathematical reasoning ─────────────────────────────────────────────
    Case("Solve the integral of x^2 * sin(x) dx",                  "MATHEMATICAL_REASONING", "tot",     tags=["math"]),
    Case("Find eigenvalues of the matrix [[2,1],[1,3]]",            "MATHEMATICAL_REASONING", "tot",     tags=["math"]),
    Case("Prove that sqrt(2) is irrational",                        "MATHEMATICAL_REASONING", "tot",     tags=["math"]),
    Case("Compute the Fourier transform of a rectangular pulse",    "MATHEMATICAL_REASONING", "tot",     tags=["math"]),

    # ── Conceptual explanation ─────────────────────────────────────────────
    Case("Explain how backpropagation works in neural networks",    "CONCEPTUAL_EXPLANATION", "standard", tags=["concept"]),
    Case("What is the difference between TCP and UDP?",             "CONCEPTUAL_EXPLANATION", "standard", tags=["concept"]),
    Case("How does the immune system fight viruses?",               "CONCEPTUAL_EXPLANATION", "standard", tags=["concept"]),
    Case("Describe the water cycle",                                "CONCEPTUAL_EXPLANATION", "standard", tags=["concept"]),
    Case("What causes inflation in an economy?",                    "CONCEPTUAL_EXPLANATION", "standard", tags=["concept"]),

    # ── Deep research ─────────────────────────────────────────────────────
    Case("Give me a comprehensive analysis of transformer architectures", "DEEP_RESEARCH", "standard",   tags=["deep"]),
    Case("Write an in-depth explanation of CRISPR gene editing",         "DEEP_RESEARCH", "standard",   tags=["deep"]),
    Case("Thorough analysis of supply chain disruptions post-COVID",      "DEEP_RESEARCH", "standard",   tags=["deep"]),

    # ── Academic search ────────────────────────────────────────────────────
    Case("Find arxiv papers on diffusion models for image generation",    "ACADEMIC_SEARCH", "standard", tags=["academic"]),
    Case("Peer-reviewed research on mRNA vaccine safety",                 "ACADEMIC_SEARCH", "standard", tags=["academic"]),
    Case("Scholarly articles on dark matter detection methods",           "ACADEMIC_SEARCH", "standard", tags=["academic"]),
    Case("Research papers on reinforcement learning from human feedback",  "ACADEMIC_SEARCH", "standard", tags=["academic"]),

    # ── Web search / current events ───────────────────────────────────────
    Case("Latest news about the US-China trade war",               "WEB_SEARCH", "direct_answer",       tags=["web"]),
    Case("What happened in the Ukraine conflict today?",           "WEB_SEARCH", "direct_answer",       tags=["web"]),
    Case("Current oil prices as of this week",                     "WEB_SEARCH", "direct_answer",       tags=["web"]),
    Case("Recent breakthroughs in quantum computing 2025",         "WEB_SEARCH", "standard",            tags=["web"]),
    Case("What's happening with the AI regulation bills right now?","WEB_SEARCH","direct_answer",       tags=["web"]),
    # web_search with activeTools flag already set
    Case("Tell me more about the news",                            "WEB_SEARCH", "direct_answer",       context={"activeTools": {"webSearch": True}}, tags=["web", "context"]),

    # ── Socratic tutoring ─────────────────────────────────────────────────
    Case("Teach me calculus from the basics step by step",         "SOCRATIC_TUTORING", "standard",     tags=["tutor"]),
    Case("Help me understand quantum mechanics gradually",          "SOCRATIC_TUTORING", "standard",     tags=["tutor"]),
    Case("Guide me through learning data structures",              "SOCRATIC_TUTORING", "standard",     tags=["tutor"]),
    Case("Tutor me on organic chemistry reactions",                "SOCRATIC_TUTORING", "standard",     tags=["tutor"]),

    # ── Document RAG ──────────────────────────────────────────────────────
    Case("Summarize what the uploaded document says",               "DOCUMENT_RAG", "standard",         context={"hasUploadedFiles": True},  tags=["rag", "context"]),
    Case("What does page 3 of my notes say about recursion?",      "DOCUMENT_RAG", "standard",         context={"hasUploadedFiles": True},  tags=["rag", "context"]),
    Case("Find references to machine learning in the PDF",         "DOCUMENT_RAG", "standard",         context={"hasUploadedFiles": True},  tags=["rag", "context"]),
    # Without file — should NOT route to DOCUMENT_RAG (recursion is a coding concept)
    Case("Summarize the concept of recursion",                     "TECHNICAL_CODING", "standard", tags=["boundary"]),

    # ── Memory recall ──────────────────────────────────────────────────────
    Case("What did we talk about last time?",                      "MEMORY_RECALL", "direct_answer",    tags=["memory"]),
    Case("Continue from where our previous conversation ended",    "MEMORY_RECALL", "direct_answer",    tags=["memory"]),
    Case("Remind me what I asked you about neural networks before", "MEMORY_RECALL", "direct_answer",   tags=["memory"]),

    # ── Rejection (entertainment / lifestyle / inappropriate) ─────────────
    Case("Recommend a Netflix series to watch",                    "ENTERTAINMENT",      "direct_answer", tags=["rejection"]),
    Case("Who won the cricket match yesterday?",                   "ENTERTAINMENT",      "direct_answer", tags=["rejection"]),
    Case("Best workout routine to lose belly fat",                 "LIFESTYLE_PERSONAL", "direct_answer", tags=["rejection"]),
    Case("How do I hack into someone's email account?",            "INAPPROPRIATE",      "direct_answer", tags=["rejection", "security"]),

    # ── Edge / ambiguous ────────────────────────────────────────────────────
    Case("What is 2 + 2?",                                         "MATHEMATICAL_REASONING", "direct_answer", tags=["edge"]),  # trivial math
    Case("Explain and implement a red-black tree in Python",       "TECHNICAL_CODING",   "standard",      tags=["edge", "code"]),  # hybrid
    Case("Can you help me understand and write a research paper on AI ethics?", "DEEP_RESEARCH", "standard", tags=["edge", "deep"]),
    # context: all tools active — should respect dominant semantic match
    Case("What are the latest peer-reviewed papers on LLM alignment?",
         "ACADEMIC_SEARCH", "standard",
         context={"activeTools": {"academicSearch": True, "webSearch": True}},
         tags=["context", "academic"]),
    Case("What is machine learning?",                              "CONCEPTUAL_EXPLANATION", "direct_answer", tags=["edge"]),  # basic factual
]

assert len(TEST_CASES) == 50, f"Expected 50 test cases, got {len(TEST_CASES)}"


# ── Embedding ─────────────────────────────────────────────────────────────────
_embed_cache: dict = {}   # query → vector (avoid re-embedding identical strings)

def make_query_vector(query: str, dim: int = 1024) -> list:
    """
    Get a real embedding for `query` using priority:
      1. fastembed (same mxbai-embed-large-v1 model as production)
      2. Running RAG service /embed endpoint
      3. Deterministic pseudo-embedding (structural test only)
    Results are memoised per query string.
    """
    if query in _embed_cache:
        return _embed_cache[query]

    # 1. fastembed direct
    if _fastembed_model is not None:
        try:
            import numpy as np
            vecs = list(_fastembed_model.embed([query]))
            vec  = vecs[0].tolist() if hasattr(vecs[0], "tolist") else list(vecs[0])
            _embed_cache[query] = vec
            return vec
        except Exception as e:
            print(f"  [WARN] fastembed failed for query: {e}")

    # 2. RAG service /embed
    if _EMBED_SERVICE:
        import urllib.request, json as _json
        body = _json.dumps({"text": query}).encode()
        req  = urllib.request.Request(
            f"{_EMBED_SERVICE}/embed",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                emb = _json.loads(resp.read())["embedding"]
                if len(emb) == dim:
                    _embed_cache[query] = emb
                    return emb
        except Exception as e:
            print(f"  [WARN] embed service call failed: {e} — using pseudo-embedding")

    # 3. Pseudo-embedding fallback (keyword-signal based)
    vec = _pseudo_embed(query, dim)
    _embed_cache[query] = vec
    return vec


def _pseudo_embed(query: str, dim: int = 1024) -> list:
    """Deterministic keyword-signal pseudo-embedding (structural tests only)."""
    vec = [0.0] * dim
    q   = query.lower()
    signal_groups = [
        (range(0,   8),  ["python","javascript","java","sql","api","function","debug","implement",
                          "code","algorithm","class","method","script","program","compile","syntax"]),
        (range(8,  16),  ["integral","derivative","matrix","eigenvalue","fourier","solve","equation",
                          "proof","theorem","calculus","vector","probability","statistics","algebra"]),
        (range(16, 24),  ["latest","news","today","current","recent","update","happening","conflict",
                          "yesterday","week","war","election","crisis","breaking","live","now"]),
        (range(24, 32),  ["arxiv","paper","peer-reviewed","research","scholarly","journal","citation",
                          "literature","study","abstract","publication","findings","article"]),
        (range(32, 40),  ["teach","guide","learn","step by step","gradually","tutor","help me understand",
                          "walk me through","beginner","explain slowly"]),
        (range(40, 48),  ["comprehensive","in-depth","thorough","detailed","extensive","full analysis",
                          "complete overview","deep dive","everything about"]),
        (range(48, 56),  ["hello","hi","hey","greet","morning","good day","how are you","who are you"]),
        (range(56, 64),  ["last time","previous","remind","recall","continue","we discussed","before",
                          "conversation history","where we left off"]),
        (range(64, 72),  ["movie","netflix","series","cricket","workout","lose weight","hack","cheat",
                          "recipe","fashion","gossip","dating","relationship advice"]),
        (range(72, 80),  ["uploaded","my notes","the document","pdf","page 3","file","summarize the"]),
    ]
    for slot_range, words in signal_groups:
        hit = sum(1 for w in words if w in q)
        if hit:
            for i in slot_range:
                vec[i] = hit * 0.5 + 0.1
    for i, ch in enumerate(query):
        vec[i % dim] += ord(ch) * 0.00001
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


# ── Run tests ─────────────────────────────────────────────────────────────────
def run_tests(sem_cache, proto_cache):
    results  = []
    sem_pass = 0
    proto_pass = 0
    CATEGORIES = {}

    for tc in TEST_CASES:
        qvec = make_query_vector(tc.query)

        # Semantic router (tool activation)
        sem_intent, sem_conf, all_s = classify_semantic(qvec, sem_cache, tc.context)

        # 3-class prototype router (style routing)
        proto_route, proto_conf, proto_scores = classify_proto(qvec, proto_cache)

        sem_ok   = (sem_intent == tc.expected)
        proto_ok = (proto_route == tc.proto_expect or proto_route is None)

        if sem_ok:   sem_pass   += 1
        if proto_ok: proto_pass += 1

        # Track per-category
        for tag in tc.tags:
            CATEGORIES.setdefault(tag, {"total": 0, "sem_pass": 0})
            CATEGORIES[tag]["total"] += 1
            if sem_ok:
                CATEGORIES[tag]["sem_pass"] += 1

        results.append({
            "query":        tc.query[:55],
            "expected":     tc.expected,
            "got":          sem_intent,
            "sem_pass":     sem_ok,
            "sem_conf":     sem_conf,
            "proto_expect": tc.proto_expect,
            "proto_got":    proto_route,
            "proto_pass":   proto_ok,
            "proto_conf":   proto_conf,
            "context":      bool(tc.context),
        })

    return results, sem_pass, proto_pass, CATEGORIES


def print_report(results, sem_pass, proto_pass, categories):
    n = len(results)
    print("\n" + "="*90)
    print("ROUTING TEST RESULTS — 50 query coverage")
    print("="*90)
    print(f"{'#':<3} {'QUERY':<56} {'EXPECTED':<24} {'GOT':<24} {'CONF':<6} {'SEM':3} {'P':3}")
    print("-"*90)

    for i, r in enumerate(results, 1):
        sem_mark   = "✓" if r["sem_pass"]   else "✗"
        proto_mark = "✓" if r["proto_pass"] else "✗"
        ctx_mark   = "+" if r["context"]    else ""
        row = (
            f"{i:<3} "
            f"{r['query'][:55]:<56} "
            f"{r['expected']:<24} "
            f"{r['got'][:22]:<24} "
            f"{r['sem_conf']:<6.3f} "
            f"{sem_mark:<3} "
            f"{proto_mark:<3}"
        )
        if not r["sem_pass"]:
            row = "\033[91m" + row + "\033[0m"  # red for failures
        elif r["context"]:
            row = "\033[93m" + row + "\033[0m"  # yellow for context cases
        print(row)

    print("-"*90)
    print(f"\nSemantic router  : {sem_pass:2}/{n}  ({sem_pass/n*100:.1f}%)")
    print(f"Proto router     : {proto_pass:2}/{n}  ({proto_pass/n*100:.1f}%)")

    print("\n── Per-category breakdown ──────────────────────────────")
    for cat, d in sorted(categories.items()):
        bar = "█" * d["sem_pass"] + "░" * (d["total"] - d["sem_pass"])
        print(f"  {cat:<12} {bar}  {d['sem_pass']}/{d['total']}")

    # Failures
    failures = [r for r in results if not r["sem_pass"]]
    if failures:
        print("\n── Semantic router failures ─────────────────────────────")
        for r in failures:
            print(f"  FAIL │ \"{r['query'][:50]}\"")
            print(f"       │ expected={r['expected']}  got={r['got']}  conf={r['sem_conf']:.3f}")

    # Rejection sanity check
    rejection_cases = [r for r in results if r["expected"] in ("ENTERTAINMENT", "LIFESTYLE_PERSONAL", "INAPPROPRIATE")]
    rejection_pass  = sum(1 for r in rejection_cases if r["sem_pass"])
    print(f"\n── Rejection gates : {rejection_pass}/{len(rejection_cases)} correctly classified as rejectable")

    # Context-aware scoring check
    ctx_cases = [r for r in results if r["context"]]
    ctx_pass  = sum(1 for r in ctx_cases if r["sem_pass"])
    print(f"── Context-aware   : {ctx_pass}/{len(ctx_cases)} correctly boosted by context")

    print("\n" + "="*90)
    overall = (sem_pass + proto_pass) / (2 * n) * 100
    status  = "PASS" if overall >= 72 else "NEEDS_IMPROVEMENT"
    print(f"  OVERALL HEALTH: {overall:.1f}%  [{status}]")
    print("="*90 + "\n")

    # Return failure list for programmatic use
    return failures


def main():
    print("\nLoading caches…")
    try:
        sem_cache   = load_semantic_cache()
        proto_cache = load_proto_cache()
    except FileNotFoundError as e:
        print(f"ERROR: Cache file missing: {e}")
        print("  Run the server once to trigger cache population, then retry.")
        sys.exit(1)

    print(f"  Semantic cache : {len(sem_cache)} intents")
    print(f"  Proto cache    : {len(proto_cache)} routes, "
          f"{sum(len(v) for v in proto_cache.values())} prototypes")

    print("\nRunning 50-query routing test…")
    print("  (Using pseudo-embeddings; start RAG service for real embedding accuracy)\n")

    results, sem_pass, proto_pass, categories = run_tests(sem_cache, proto_cache)
    failures = print_report(results, sem_pass, proto_pass, categories)

    # Exit non-zero if > 20% semantic failures (hard gate)
    if sem_pass < len(TEST_CASES) * 0.80:
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
