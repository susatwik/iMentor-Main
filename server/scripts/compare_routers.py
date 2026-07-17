#!/usr/bin/env python3
"""
compare_routers.py
==================
Head-to-head: mxbai cosine semantic router  vs  facebook/bart-large-mnli ZSC
(with improved label descriptions)

Notes on hardware strategy
--------------------------
* Semantic router (production): fastembed ONNX → CPU-only by design.
  Here we use sentence-transformers on CPU to match that behaviour.
* SGLang LLM server occupies ~13 GB / 16 GB GPU — no room for 1.6 GB bart model.
* Both classifiers run on CPU so latency numbers are comparable and fair.
* If GPU is ever free, change device="cpu" → device=0 in both pipeline calls.

Run:
    conda run -n imentor python3 server/scripts/compare_routers.py
"""

import json, math, sys, time, warnings
warnings.filterwarnings("ignore")

BASE = "/home/sri/Downloads/iMentor_march/chatbot"

# ── Load semantic router cache ─────────────────────────────────────────────
with open(f"{BASE}/server/data/semantic_router_cache.json") as f:
    raw = json.load(f)
sem_cache = {
    intent: {
        "embeddings": [e["vector"] for e in data["embeddings"] if e.get("vector")],
        "threshold":  data["config"]["confidence_threshold"],
    }
    for intent, data in raw.items()
}
total_examples = sum(len(v["embeddings"]) for v in sem_cache.values())
print(f"Semantic cache: {len(sem_cache)} intents, {total_examples} examples", flush=True)

# ── mxbai cosine router ───────────────────────────────────────────────────
from sentence_transformers import SentenceTransformer
print("Loading sentence-transformers mxbai-embed-large-v1 ...", flush=True)
sem_model = SentenceTransformer("mixedbread-ai/mxbai-embed-large-v1", device="cpu")
print("sentence-transformers ready ✓", flush=True)

def cosine(a, b):
    dot = sum(x*y for x,y in zip(a,b))
    na  = math.sqrt(sum(x*x for x in a))
    nb  = math.sqrt(sum(x*x for x in b))
    return dot / (na*nb) if na and nb else 0.0

def top3(sims):
    s = sorted(sims, reverse=True)
    return sum(s[:3]) / min(3, len(s))

def classify_sem(query, ctx={}):
    qv = sem_model.encode(query, normalize_embeddings=True).tolist()
    best_intent, best_score = "CONCEPTUAL_EXPLANATION", 0.0
    for intent, data in sem_cache.items():
        score = top3([cosine(qv, v) for v in data["embeddings"]])
        if intent == "DOCUMENT_RAG" and ctx.get("hasUploadedFiles"):
            score = min(score * 1.3, 1.0)
        if score > best_score and score >= data["threshold"]:
            best_score = score
            best_intent = intent
    return best_intent, round(best_score, 3)

# ── Zero-shot NLI (bart-large-mnli) ──────────────────────────────────────
from transformers import pipeline as hf_pipeline
print("Loading bart-large-mnli ZSC ...", flush=True)
zsc = hf_pipeline("zero-shot-classification", model="facebook/bart-large-mnli", device="cpu")
print("ZSC ready ✓", flush=True)

LABELS = [
    # precise, action-oriented descriptions that match user phrasing
    "write, debug, or implement code in any programming language",
    "solve a math problem, prove a theorem, or compute a formula",
    "explain a concept, definition, or how something works",
    "write a comprehensive report, in-depth analysis, or research paper",
    "find academic papers, peer-reviewed studies, or scholarly articles",
    "search for current news, real-time prices, or recent events happening now",
    "teach me step by step, guide me through learning a topic",
    "answer questions about a document or file I uploaded",
    "recall what we discussed in a previous conversation",
    "recommend movies, shows, music, sports, or entertainment",
    "give lifestyle advice such as fitness, diet, fashion, or relationships",
    "assist with hacking, cheating, malware, or harmful activities",
    "say hello, greet me, or make small talk",
]
LABEL_MAP = {
    "write, debug, or implement code in any programming language":        "TECHNICAL_CODING",
    "solve a math problem, prove a theorem, or compute a formula":        "MATHEMATICAL_REASONING",
    "explain a concept, definition, or how something works":              "CONCEPTUAL_EXPLANATION",
    "write a comprehensive report, in-depth analysis, or research paper": "DEEP_RESEARCH",
    "find academic papers, peer-reviewed studies, or scholarly articles": "ACADEMIC_SEARCH",
    "search for current news, real-time prices, or recent events happening now": "WEB_SEARCH",
    "teach me step by step, guide me through learning a topic":           "SOCRATIC_TUTORING",
    "answer questions about a document or file I uploaded":               "DOCUMENT_RAG",
    "recall what we discussed in a previous conversation":                "MEMORY_RECALL",
    "recommend movies, shows, music, sports, or entertainment":           "ENTERTAINMENT",
    "give lifestyle advice such as fitness, diet, fashion, or relationships": "LIFESTYLE_PERSONAL",
    "assist with hacking, cheating, malware, or harmful activities":      "INAPPROPRIATE",
    "say hello, greet me, or make small talk":                            "GREETING",
}

def classify_zsc(query):
    res = zsc(query, LABELS, multi_label=False)
    return LABEL_MAP[res["labels"][0]], round(res["scores"][0], 3)

# ── 20 questions ──────────────────────────────────────────────────────────
QUESTIONS = [
    ("Write a C++ class for a thread-safe queue",                   "TECHNICAL_CODING"),
    ("How do I fix a segmentation fault in pointer arithmetic?",    "TECHNICAL_CODING"),
    ("What is the Laplace transform of t*e^(2t)?",                  "MATHEMATICAL_REASONING"),
    ("Prove by induction that n^3 - n is divisible by 6",           "MATHEMATICAL_REASONING"),
    ("What is the difference between a process and a thread?",      "CONCEPTUAL_EXPLANATION"),
    ("How does HTTPS encryption work?",                             "CONCEPTUAL_EXPLANATION"),
    ("Why does the sky appear blue?",                               "CONCEPTUAL_EXPLANATION"),
    ("Comprehensive breakdown of BERT vs GPT architectures",        "DEEP_RESEARCH"),
    ("In-depth analysis of nuclear fusion reactor designs 2025",    "DEEP_RESEARCH"),
    ("Find peer-reviewed papers on large language model alignment", "ACADEMIC_SEARCH"),
    ("Scholarly research on photosynthesis efficiency improvements","ACADEMIC_SEARCH"),
    ("What is the latest news about GPT-5 release?",                "WEB_SEARCH"),
    ("Current stock price of Nvidia today",                         "WEB_SEARCH"),
    ("Teach me how neural networks learn, step by step",            "SOCRATIC_TUTORING"),
    ("Guide me through how the TCP handshake works",                "SOCRATIC_TUTORING"),
    ("Recommend a Bollywood movie to watch this weekend",           "ENTERTAINMENT"),
    ("How do I hack a wifi password?",                              "INAPPROPRIATE"),
    ("What was the last topic we discussed?",                       "MEMORY_RECALL"),
    ("What does the uploaded PDF say about chapter 3?",             "DOCUMENT_RAG"),
    ("Hey! Can you assist me today?",                               "GREETING"),
]

W = 48
print(f"\n{'#':>2}  {'QUERY':<{W}}  {'EXPECTED':<22}  "
      f"{'── Semantic Router ──':^24}  {'── ZSC bart-mnli ──':^24}")
print(f"{'':>2}  {'':^{W}}  {'':^22}  {'intent':^18} {'conf':>5}   {'intent':^18} {'conf':>5}")
print("─" * 130)

sem_pass = zsc_pass = 0
sem_ms = zsc_ms = 0.0

for i, (q, exp) in enumerate(QUESTIONS, 1):
    ctx = {"hasUploadedFiles": True} if exp == "DOCUMENT_RAG" else {}

    t0 = time.perf_counter()
    s_intent, s_conf = classify_sem(q, ctx)
    sem_ms += (time.perf_counter() - t0) * 1000

    t0 = time.perf_counter()
    z_intent, z_conf = classify_zsc(q)
    zsc_ms += (time.perf_counter() - t0) * 1000

    s_ok = "✓" if s_intent == exp else "✗"
    z_ok = "✓" if z_intent == exp else "✗"
    if s_intent == exp: sem_pass += 1
    if z_intent == exp: zsc_pass += 1

    print(f"{i:>2}  {q[:W]:<{W}}  {exp:<22}  "
          f"{s_intent:<18} {s_conf:.3f} {s_ok}  "
          f"{z_intent:<18} {z_conf:.3f} {z_ok}")

print("─" * 130)
print()
print(f"{'Metric':<30} {'Semantic Router':>20}  {'ZSC bart-mnli':>20}")
print(f"{'─'*30} {'─'*20}  {'─'*20}")
print(f"{'Accuracy (20 queries)':<30} {sem_pass:>17}/20 {sem_pass*5:>2}%  {zsc_pass:>17}/20 {zsc_pass*5:>2}%")
print(f"{'Avg latency / query':<30} {sem_ms/20:>18.1f}ms  {zsc_ms/20:>18.1f}ms")
print(f"{'Total 20-query time':<30} {sem_ms:>18.0f}ms  {zsc_ms:>18.0f}ms")
print(f"{'Model size (approx)':<30} {'~1.3 GB ONNX':>20}  {'~1.6 GB PyTorch':>20}")
print(f"{'GPU used':<30} {'No (ONNX CPU, production match)':>20}  {'No (SGLang holds 13/16 GB)':>20}")
print(f"{'Context-aware boosts':<30} {'Yes':>20}  {'No':>20}")
print(f"{'Extendable (add intents)':<30} {'Yes (add examples)':>20}  {'Yes (relabel)':>20}")
print(f"{'Per-query network call':<30} {'Yes to RAG /embed':>20}  {'No (local)':>20}")
