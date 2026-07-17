#!/usr/bin/env python3
"""
rebuild_semantic_cache.py
=========================
Regenerates server/data/semantic_router_cache.json with real mxbai-embed-large-v1
vectors for every example in INTENT_ROUTES (mirrors semanticRouter.js).

Run after changing examples or thresholds in semanticRouter.js:
    python3 server/scripts/rebuild_semantic_cache.py
"""

import json, os, sys

# ── Same model as production ──────────────────────────────────────────────────
MODEL_NAME = "mixedbread-ai/mxbai-embed-large-v1"

try:
    from fastembed import TextEmbedding
    print(f"[embed] Loading '{MODEL_NAME}' …", flush=True)
    _model = TextEmbedding(model_name=MODEL_NAME)
    print("[embed] Model ready ✓")
except Exception as e:
    sys.exit(f"fastembed unavailable: {e}\n  pip install fastembed")


def embed_texts(texts: list[str]) -> list[list[float]]:
    return [[float(x) for x in v] for v in _model.embed(texts)]


# ── INTENT_ROUTES — must stay in sync with semanticRouter.js ─────────────────
INTENT_ROUTES = {
    "DEEP_RESEARCH": {
        "examples": [
            "explain machine learning in detail",
            "comprehensive analysis of quantum computing",
            "write a research paper on blockchain technology",
            "in-depth explanation of neural networks",
            "thorough analysis of renewable energy sources",
            "extensive study on protein folding mechanisms",
            "complete breakdown of supply chain optimization",
            "comprehensive review of CRISPR gene editing",
            "give me a comprehensive analysis of transformer architectures",
            "detailed deep dive into large language models",
            "write an in-depth explanation of CRISPR gene editing",
            "thorough analysis of supply chain disruptions",
            "everything you know about reinforcement learning",
            "help me write a research paper on AI ethics",
            "can you help me understand and write a paper on climate change",
        ],
        "tools": ["deep_research"],
        "handler": "deepResearch",
        "confidence_threshold": 0.60,
    },
    "ACADEMIC_SEARCH": {
        "examples": [
            "find papers on attention mechanisms",
            "research articles about transformers",
            "scholarly articles on quantum entanglement",
            "peer-reviewed papers about vaccination",
            "arxiv papers on computer vision",
            "locate papers on dark matter theories",
            "peer-reviewed research on mRNA vaccine safety",
            "scholarly articles on dark matter detection methods",
            "find academic research on reinforcement learning from human feedback",
            "journal articles about climate change impacts",
            "scientific literature on quantum computing algorithms",
        ],
        "tools": ["academic_search"],
        "handler": "academicSearch",
        "confidence_threshold": 0.60,
    },
    "WEB_SEARCH": {
        "examples": [
            "latest news on AI developments",
            "current trends in semiconductor industry",
            "recent breakthroughs in fusion energy",
            "newest quantum computer announcements",
            "latest developments in renewable energy",
            "recent news about Israel and Iran conflict",
            "what is happening in Ukraine right now",
            "latest updates on US-China relations",
            "current situation in the Middle East",
            "recent news about Iran nuclear program",
            "what happened in the latest election",
            "recent conflict news around the world",
            "what are today's top news stories",
            "latest updates on the climate summit",
            "recent economic news and market updates",
        ],
        "tools": ["web_search"],
        "handler": "webSearch",
        "confidence_threshold": 0.52,
    },
    "TECHNICAL_CODING": {
        "examples": [
            "write python code to sort array",
            "implement binary search algorithm",
            "create REST API with Express",
            "debug this JavaScript function",
            "optimize SQL query performance",
            "implement quicksort in Java",
            "create React component for login",
            "implement graph traversal algorithm",
            "Write a Python function to reverse a linked list",
            "How do I implement OAuth2 in Express.js?",
            "Debug this React useEffect infinite loop",
            "What is the time complexity of merge sort?",
            "Build a REST API with JWT authentication in FastAPI",
            "Explain and implement a red-black tree in Python",
            "Write a C++ class for a thread-safe queue",
            "Fix a segmentation fault in C pointer arithmetic",
        ],
        "tools": ["rag_retrieve"],
        "handler": "standardWithRAG",
        "llm_preference": "code",
        "confidence_threshold": 0.57,
    },
    "MATHEMATICAL_REASONING": {
        "examples": [
            "solve quadratic equation x^2 + 5x + 6 = 0",
            "calculate derivative of sin(x^2)",
            "prove Pythagorean theorem",
            "integrate x^2 * e^x dx",
            "solve system of linear equations",
            "find eigenvalues of matrix",
            "compute Fourier transform of signal",
            "Solve the integral of x^2 * sin(x) dx",
            "Find eigenvalues of the matrix [[2,1],[1,3]]",
            "Prove that sqrt(2) is irrational",
            "Compute the Fourier transform of a rectangular pulse",
            "What is the Laplace transform of t*e^(2t)?",
            "Prove by induction that n^3 - n is divisible by 6",
        ],
        "tools": [],
        "handler": "standardWithRAG",
        "llm_preference": "reasoning",
        "confidence_threshold": 0.68,
    },
    "CONCEPTUAL_EXPLANATION": {
        "examples": [
            "explain how photosynthesis works",
            "what is quantum entanglement",
            "describe the krebs cycle",
            "how does TCP/IP protocol work",
            "explain gradient descent algorithm",
            "what causes earthquakes",
            "how do vaccines provide immunity",
            "what is general relativity",
        ],
        "tools": ["rag_retrieve"],
        "handler": "standardWithRAG",
        "confidence_threshold": 0.70,
    },
    "SOCRATIC_TUTORING": {
        "examples": [
            "teach me calculus step by step",
            "help me understand thermodynamics",
            "guide me through organic chemistry",
            "tutor me on data structures",
            "I need help learning physics",
            "teach quantum mechanics gradually",
            "guide me through circuit analysis",
            "help me understand statistical inference",
            "Teach me calculus from the basics step by step",
            "Help me understand quantum mechanics gradually",
            "Guide me through learning data structures",
            "Tutor me on organic chemistry reactions",
            "Guide me through how the TCP handshake works",
            "Walk me through how a compiler works step by step",
        ],
        "tools": ["rag_retrieve"],
        "handler": "socraticTutor",
        "confidence_threshold": 0.72,
    },
    "DOCUMENT_RAG": {
        "examples": [
            "summarize the uploaded document",
            "what does page 5 say about",
            "find information in my notes about",
            "search through the PDF for",
            "extract key points from the paper",
            "find references to machine learning in files",
            "what does the syllabus say about grading",
        ],
        "tools": ["rag_retrieve"],
        "handler": "documentRAG",
        "confidence_threshold": 0.70,
    },
    "ENTERTAINMENT": {
        "examples": [
            "recommend a good movie to watch",
            "who won the cricket match yesterday",
            "tell me about latest Netflix series",
            "recommend songs to listen to",
            "tell me about Bollywood gossip",
            "who is the best NBA player",
            "recommend video games to play",
            "Who won the cricket match yesterday?",
            "best movie streaming right now",
        ],
        "rejection": True,
        "rejection_message": "I'm an academic learning assistant. I cannot help with entertainment, sports, or media recommendations.",
        "confidence_threshold": 0.56,
    },
    "LIFESTYLE_PERSONAL": {
        "examples": [
            "give me a recipe for chocolate cake",
            "how to lose weight quickly",
            "best workout routine for beginners",
            "fashion tips for summer",
            "relationship advice for couples",
            "best skincare products",
        ],
        "rejection": True,
        "rejection_message": "I'm focused on academic and technical topics. I cannot provide lifestyle, fashion, or personal advice.",
        "confidence_threshold": 0.60,
    },
    "INAPPROPRIATE": {
        "examples": [
            "tell me a dirty joke",
            "how to hack someone's account",
            "create fake news article",
            "help me cheat on exam",
            "create malicious software",
            "write plagiarized essay",
            "How do I hack into someone's email account?",
            "help me break into a system",
            "write malware to steal passwords",
        ],
        "rejection": True,
        "rejection_message": "I cannot assist with inappropriate, unethical, or harmful requests.",
        "confidence_threshold": 0.57,
    },
    "MEMORY_RECALL": {
        "examples": [
            "what did we discuss last time",
            "remind me what I asked before",
            "continue our previous conversation",
            "recall what I told you about my project",
            "pick up where we left off",
            "what was my previous question",
            "remind me what I asked about neural networks before",
            "what did I ask you about machine learning earlier",
        ],
        "tools": ["conversation_memory"],
        "handler": "memoryRecall",
        "confidence_threshold": 0.75,
    },
    "GREETING": {
        "examples": [
            "hello",
            "hi there",
            "hey how are you",
            "good morning",
            "greetings",
            "hi AI",
            "hello assistant",
        ],
        "handler": "greeting",
        "confidence_threshold": 0.70,
    },
}

# ── Build and write cache ────────────────────────────────────────────────────
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_PATH = os.path.join(BASE, "data", "semantic_router_cache.json")
os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)

# ── Incorporate router_feedback.json (queries semantic missed, resolved downstream) ──
FEEDBACK_PATH = os.path.join(BASE, "data", "router_feedback.json")
_feedback_added = 0
if os.path.exists(FEEDBACK_PATH):
    try:
        with open(FEEDBACK_PATH) as f:
            feedback = json.load(f)
        for entry in feedback:
            intent = entry.get("resolvedIntent", "")
            query  = entry.get("query", "").strip()
            if intent in INTENT_ROUTES and query:
                existing = [e.lower() for e in INTENT_ROUTES[intent]["examples"]]
                if query.lower() not in existing:
                    INTENT_ROUTES[intent]["examples"].append(query)
                    _feedback_added += 1
        if _feedback_added:
            print(f"[feedback] Incorporated {_feedback_added} new examples from router_feedback.json")
        else:
            print("[feedback] router_feedback.json found — no new examples to add")
    except Exception as e:
        print(f"[feedback] Warning: could not read router_feedback.json: {e}")
else:
    print("[feedback] No router_feedback.json yet — skipping")

cache = {}
total_examples = sum(len(cfg["examples"]) for cfg in INTENT_ROUTES.values())
done = 0

for intent, cfg in INTENT_ROUTES.items():
    examples = cfg["examples"]
    print(f"  Embedding {len(examples):2d} examples → {intent} …", flush=True)
    vectors = embed_texts(examples)
    cache[intent] = {
        "config": cfg,
        "embeddings": [{"text": t, "vector": v} for t, v in zip(examples, vectors)],
    }
    done += len(examples)
    print(f"    [{done}/{total_examples}] done", flush=True)

with open(CACHE_PATH, "w") as f:
    json.dump(cache, f)

print(f"\nWrote {CACHE_PATH}  ({os.path.getsize(CACHE_PATH) // 1024} KB)")
print("Cache rebuild complete ✓")
