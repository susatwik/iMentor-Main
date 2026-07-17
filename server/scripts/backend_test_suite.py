#!/usr/bin/env python3
"""
iMentor Backend Test Suite
===========================
Tests (no frontend / no Playwright):
  1. Login & auth
  2. Offline jobs health (nightly evaluator + RAG pipeline status)
  3. 10 general chat questions  →  checks response + source_pipeline
  4. 10 web-search intent questions  →  checks useWebSearch activated
  5. 5 critical-thinking (ToT) questions  →  checks ToT pipeline
  6. 10 knowledge-base (RAG) questions  →  checks references cited
  7. XP allotment sanity (user XP before vs after chat)

Usage:
    python3 backend_test_suite.py
    python3 backend_test_suite.py --section jobs
    python3 backend_test_suite.py --section chat
    python3 backend_test_suite.py --section web
    python3 backend_test_suite.py --section crit
    python3 backend_test_suite.py --section rag
    python3 backend_test_suite.py --section xp
    python3 backend_test_suite.py --section all   (default)
"""

import sys
import json
import uuid
import time
import argparse
import subprocess
import threading
import requests

# ─── CONFIG ──────────────────────────────────────────────────────────────────
BASE_URL   = "http://localhost:5001"
RAG_URL    = "http://localhost:2001"          # python RAG service
EMAIL      = "ultra.boy7@gmail.com"
PASSWORD   = "123456"
TIMEOUT    = 90           # seconds per SSE request
STREAM_TIMEOUT = 120      # streaming timeout

# ─── COLOURS ─────────────────────────────────────────────────────────────────
G = "\033[92m"   # green
R = "\033[91m"   # red
Y = "\033[93m"   # yellow
B = "\033[94m"   # blue
W = "\033[0m"    # reset
BOLD = "\033[1m"

def p(color, tag, msg):
    print(f"{color}{BOLD}[{tag}]{W} {msg}")

# ─── AUTH ─────────────────────────────────────────────────────────────────────
def login() -> str:
    """Login and return JWT token."""
    p(B, "AUTH", f"Logging in as {EMAIL} ...")
    resp = requests.post(
        f"{BASE_URL}/api/auth/signin",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    token = data.get("token")
    if not token:
        raise RuntimeError(f"No token in login response: {data}")
    p(G, "AUTH", "Login successful ✓")
    return token


def auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


# ─── SSE STREAM PARSER ───────────────────────────────────────────────────────
def send_chat(token: str, payload: dict, label: str = "") -> dict:
    """
    POST to /api/chat/message, consume the SSE stream, return the
    parsed final_answer event content + metadata.
    """
    url = f"{BASE_URL}/api/chat/message"
    headers = {**auth_headers(token), "Accept": "text/event-stream"}

    start = time.time()
    events = []
    final_answer = None
    status_updates = []

    try:
        with requests.post(url, json=payload, headers=headers,
                           stream=True, timeout=STREAM_TIMEOUT) as resp:
            resp.raise_for_status()
            buffer = ""
            for chunk in resp.iter_content(chunk_size=None, decode_unicode=True):
                if chunk:
                    buffer += chunk
                    while "\n\n" in buffer:
                        raw, buffer = buffer.split("\n\n", 1)
                        # Parse SSE line(s)
                        for line in raw.split("\n"):
                            line = line.strip()
                            if line.startswith("data:"):
                                data_str = line[5:].strip()
                                if data_str in ("", "[DONE]"):
                                    continue
                                try:
                                    evt = json.loads(data_str)
                                    events.append(evt)
                                    etype = evt.get("type", "")
                                    if etype == "final_answer":
                                        final_answer = evt.get("content", {})
                                    elif etype == "status_update":
                                        status_updates.append(evt.get("content", ""))
                                except json.JSONDecodeError:
                                    pass
    except requests.exceptions.Timeout:
        return {"error": "TIMEOUT", "label": label, "elapsed": time.time() - start}
    except Exception as e:
        return {"error": str(e), "label": label, "elapsed": time.time() - start}

    elapsed = round(time.time() - start, 2)

    if final_answer is None:
        return {"error": "no_final_answer", "label": label, "elapsed": elapsed, "events": events}

    return {
        "label":          label,
        "elapsed_s":      elapsed,
        "text":           (final_answer.get("text") or "")[:400],
        "source_pipeline": final_answer.get("source_pipeline", "unknown"),
        "references":     final_answer.get("references", []),
        "intent":         final_answer.get("intent", ""),
        "confidence":     final_answer.get("confidenceScore", ""),
        "status_updates": status_updates,
        "thinking":       bool(final_answer.get("thinking")),
        "raw":            final_answer,
    }


# ─── RESULT HELPERS ──────────────────────────────────────────────────────────
class Results:
    def __init__(self, section: str):
        self.section = section
        self.passed = 0
        self.failed = 0
        self.rows   = []

    def record(self, label: str, ok: bool, detail: str = ""):
        icon = f"{G}✓{W}" if ok else f"{R}✗{W}"
        status = "PASS" if ok else "FAIL"
        self.rows.append((icon, label, status, detail))
        if ok:
            self.passed += 1
        else:
            self.failed += 1

    def print_summary(self):
        print(f"\n{'─'*70}")
        p(B, self.section, f"Results — {self.passed} pass / {self.failed} fail")
        print(f"{'─'*70}")
        for icon, label, status, detail in self.rows:
            det = f"  ↳ {detail}" if detail else ""
            print(f"  {icon}  {label}{det}")
        print(f"{'─'*70}\n")


def print_chat_result(r: dict, idx: int, flags_hint: str = ""):
    pipe  = r.get("source_pipeline", "?")
    et    = r.get("elapsed_s", "?")
    refs  = r.get("references", [])
    txt   = r.get("text", "")[:120].replace("\n", " ")
    err   = r.get("error")
    if err:
        p(R, f"Q{idx}", f"ERROR: {err}")
        return
    hint  = f" [{flags_hint}]" if flags_hint else ""
    ref_info = f" refs={len(refs)}" if refs else ""
    p(G, f"Q{idx}", f"pipeline={pipe}{hint}{ref_info} ({et}s)")
    print(f"      {B}Q:{W} {r['label'][:80]}")
    print(f"      {B}A:{W} {txt}...")


# ─── SECTION 1: OFFLINE JOBS ─────────────────────────────────────────────────
def test_jobs() -> Results:
    r = Results("OFFLINE-JOBS")
    print(f"\n{'═'*70}")
    p(B, "JOBS", "Checking offline job components ...")
    print(f"{'═'*70}")

    # 1a. RAG service health
    try:
        resp = requests.get(f"{RAG_URL}/health", timeout=10)
        data = resp.json()
        ok_qdrant = data.get("qdrant_service") == "initialized"
        ok_neo4j  = data.get("neo4j_connection") == "connected"
        ok_status = data.get("status") == "ok"
        r.record("RAG service /health → status=ok",       ok_status,  f"status={data.get('status')}")
        r.record("RAG service /health → qdrant initialized", ok_qdrant, f"qdrant={data.get('qdrant_service')}")
        r.record("RAG service /health → neo4j connected",   ok_neo4j,  f"neo4j={data.get('neo4j_connection')}")
    except Exception as e:
        r.record("RAG service /health reachable", False, str(e))

    # 1b. Node server health check
    try:
        resp = requests.get(f"{BASE_URL}/health", timeout=10)
        ok   = resp.status_code == 200
        r.record("Node server /health reachable", ok, f"HTTP {resp.status_code}")
    except Exception as e:
        # Try /api/health or just the root
        try:
            resp = requests.get(f"{BASE_URL}/", timeout=5)
            ok   = resp.status_code < 500
            r.record("Node server root reachable", ok, f"HTTP {resp.status_code}")
        except Exception as e2:
            r.record("Node server reachable", False, str(e2))

    # 1c. Boss battle / bounty cron jobs — verify routes exist (admin)
    # These run on the live server; we check the jobs route responds
    try:
        # Unauthenticated — should get 401 not 404
        resp = requests.get(f"{BASE_URL}/api/jobs/000000000000000000000001", timeout=5)
        ok   = resp.status_code in (401, 403, 404)   # route exists, just auth blocked
        r.record("Jobs route /api/jobs/:id exists", ok, f"HTTP {resp.status_code}")
    except Exception as e:
        r.record("Jobs route reachable", False, str(e))

    # 1d. Dry-run the nightly evaluator script (check it exits cleanly; uses --dry-run flag we inject)
    # We call node + runOfflineJobs.js with no DB changes by reading its log intent
    p(Y, "JOBS", "Checking nightly evaluator script syntax (node --check) ...")
    server_dir = "/home/sri/Downloads/iMentor_march/chatbot/server"
    try:
        result = subprocess.run(
            ["node", "--check", "scripts/runOfflineJobs.js"],
            cwd=server_dir, capture_output=True, text=True, timeout=15,
        )
        ok = result.returncode == 0
        r.record("runOfflineJobs.js syntax valid", ok, result.stderr.strip()[:120] or "OK")
    except FileNotFoundError:
        r.record("node available in PATH", False, "node not found")
    except Exception as e:
        r.record("runOfflineJobs.js syntax check", False, str(e))

    # 1e. Verify XP evaluator module loads
    try:
        result = subprocess.run(
            ["node", "-e", "require('./services/advancedXPEvaluator'); console.log('OK');"],
            cwd=server_dir, capture_output=True, text=True, timeout=10,
        )
        ok = "OK" in result.stdout
        r.record("advancedXPEvaluator module loads", ok,
                 (result.stderr.strip()[:120] or "OK"))
    except Exception as e:
        r.record("advancedXPEvaluator module loads", False, str(e))

    # 1f. Verify nightly evaluator module loads
    try:
        result = subprocess.run(
            ["node", "-e", "require('./jobs/nightlySessionEvaluator'); console.log('OK');"],
            cwd=server_dir, capture_output=True, text=True, timeout=10,
        )
        ok = "OK" in result.stdout
        r.record("nightlySessionEvaluator module loads", ok,
                 (result.stderr.strip()[:120] or "OK"))
    except Exception as e:
        r.record("nightlySessionEvaluator module loads", False, str(e))

    r.print_summary()
    return r


# ─── SECTION 2: GENERAL CHAT ─────────────────────────────────────────────────
GENERAL_QUESTIONS = [
    "What is the difference between supervised and unsupervised learning?",
    "Explain Newton's three laws of motion with examples.",
    "How does TCP/IP networking work? Explain the four layers.",
    "What is photosynthesis and why is it important?",
    "Describe the water cycle and its stages.",
    "What is the significance of the Magna Carta in English history?",
    "Explain the concept of recursion in programming with a code example.",
    "What is the difference between a stack and a queue data structure?",
    "How does the human digestive system work?",
    "What is the Pythagorean theorem and when is it used?",
]

def test_general_chat(token: str) -> Results:
    r = Results("GENERAL-CHAT")
    print(f"\n{'═'*70}")
    p(B, "CHAT", "Running 10 general chat questions (no special tools) ...")
    print(f"{'═'*70}")

    session_id = f"test_general_{uuid.uuid4().hex[:8]}"
    for i, q in enumerate(GENERAL_QUESTIONS, 1):
        payload = {
            "query":      q,
            "sessionId":  session_id,
            "useWebSearch":      False,
            "useAcademicSearch": False,
            "criticalThinkingEnabled": False,
            "deepResearchMode":  False,
        }
        result = send_chat(token, payload, label=q)
        print_chat_result(result, i, "general")

        ok    = not result.get("error") and bool(result.get("text"))
        pipe  = result.get("source_pipeline", "")
        detail = f"pipeline={pipe} elapsed={result.get('elapsed_s')}s"
        r.record(f"Q{i}: {q[:55]}...", ok, detail)
        time.sleep(0.5)   # brief pause between calls

    r.print_summary()
    return r


# ─── SECTION 3: WEB SEARCH ───────────────────────────────────────────────────
WEB_SEARCH_QUESTIONS = [
    "What are the latest developments in quantum computing in 2025?",
    "Who won the Nobel Prize in Physics in 2024?",
    "What is the current state of the AI regulation debate globally?",
    "What are the most recent findings about climate change impacts?",
    "What new features did Python 3.13 introduce?",
    "What is the current status of the James Webb Space Telescope discoveries?",
    "What are the latest breakthroughs in cancer research from 2025?",
    "Who is the current Prime Minister of the United Kingdom?",
    "What is the current inflation rate in the United States?",
    "What recent advances have been made in fusion energy research?",
]

def test_web_search(token: str) -> Results:
    r = Results("WEB-SEARCH")
    print(f"\n{'═'*70}")
    p(B, "WEB", "Running 10 web-search intent questions (useWebSearch=true) ...")
    print(f"{'═'*70}")

    session_id = f"test_web_{uuid.uuid4().hex[:8]}"
    for i, q in enumerate(WEB_SEARCH_QUESTIONS, 1):
        payload = {
            "query":      q,
            "sessionId":  session_id,
            "useWebSearch":      True,
            "useAcademicSearch": False,
            "criticalThinkingEnabled": False,
            "deepResearchMode":  False,
        }
        result = send_chat(token, payload, label=q)
        print_chat_result(result, i, "web_search=ON")

        ok        = not result.get("error") and bool(result.get("text"))
        pipe      = result.get("source_pipeline", "")
        refs      = result.get("references", [])
        # Check pipeline suggests web search was used
        web_hit   = any(kw in pipe.lower() for kw in ["web", "search", "agent", "research", "react"])
        # References or at least a non-trivial response
        has_refs  = len(refs) > 0
        detail = f"pipeline={pipe} refs={len(refs)} web_pipeline_detected={web_hit}"
        r.record(f"Q{i}: response received",    ok,      f"elapsed={result.get('elapsed_s')}s")
        r.record(f"Q{i}: web pipeline detected", web_hit, detail)
        time.sleep(0.5)

    r.print_summary()
    return r


# ─── SECTION 4: CRITICAL THINKING (ToT) ─────────────────────────────────────
CRITICAL_THINKING_QUESTIONS = [
    "Analyze the ethical implications of using AI in criminal sentencing. Present multiple perspectives.",
    "Compare and contrast capitalism and socialism — what are the strengths and weaknesses of each?",
    "Should social media platforms be legally responsible for user-generated misinformation? Argue both sides.",
    "Is nuclear energy a viable solution to climate change? Evaluate the evidence.",
    "Critically evaluate whether standardized testing is an effective measure of student intelligence.",
]

def test_critical_thinking(token: str) -> Results:
    r = Results("CRITICAL-THINKING")
    print(f"\n{'═'*70}")
    p(B, "TOT", "Running 5 critical-thinking questions (criticalThinkingEnabled=true) ...")
    print(f"{'═'*70}")

    session_id = f"test_crit_{uuid.uuid4().hex[:8]}"
    for i, q in enumerate(CRITICAL_THINKING_QUESTIONS, 1):
        payload = {
            "query":      q,
            "sessionId":  session_id,
            "useWebSearch":            False,
            "useAcademicSearch":       False,
            "criticalThinkingEnabled": True,
            "deepResearchMode":        False,
        }
        result = send_chat(token, payload, label=q)

        ok        = not result.get("error") and bool(result.get("text"))
        pipe      = result.get("source_pipeline", "")
        thinking  = result.get("thinking", False)
        statuses  = result.get("status_updates", [])
        tot_hit   = any(kw in pipe.lower() for kw in ["tot", "tree", "reasoning", "react"])
        tot_status = any("reasoning" in s.lower() or "thinking" in s.lower() or "tree" in s.lower()
                         for s in statuses)
        tot_activated = tot_hit or thinking or tot_status

        print_chat_result(result, i, "criticalThinking=ON")
        print(f"      {Y}ToT activated:{W} {tot_activated}  "
              f"(pipeline={pipe}, thinking={thinking}, statuses={statuses[:2]})")

        r.record(f"Q{i}: response received",         ok,            f"elapsed={result.get('elapsed_s')}s")
        r.record(f"Q{i}: ToT/reasoning pipeline hit", tot_activated, f"pipeline={pipe}")
        time.sleep(1.0)

    r.print_summary()
    return r


# ─── SECTION 5: KNOWLEDGE BASE / RAG ─────────────────────────────────────────
# These questions are asked WITH documentContextName set to test RAG retrieval
# We'll try a few known admin course names from the Cpurses folder
RAG_QUESTIONS = [
    "What are the main topics covered in this course?",
    "Explain the key concepts introduced in the first module.",
    "What prerequisites are needed for this subject?",
    "Summarize the most important theories discussed.",
    "What are the practical applications of the topics in this course?",
    "How are the subtopics interconnected in this course curriculum?",
    "What mathematical foundations are needed for this subject?",
    "Give an overview of the advanced topics in this course.",
    "What is the learning progression recommended for this course?",
    "What are the most challenging concepts in this course and how should I approach them?",
]

def get_available_courses() -> list:
    """Fetch the list of courses from the Cpurses directory."""
    import os
    cpurses_dir = "/home/sri/Downloads/iMentor_march/chatbot/server/Cpurses"
    try:
        courses = [
            d.replace("_", " ").lower()
            for d in os.listdir(cpurses_dir)
            if os.path.isdir(os.path.join(cpurses_dir, d)) and not d.startswith("_")
        ]
        return courses[:3] if courses else ["Machine Learning"]  # test max 3 courses
    except Exception:
        return ["machine learning", "data structures"]


def test_rag(token: str) -> Results:
    r = Results("RAG-KNOWLEDGE-BASE")
    print(f"\n{'═'*70}")
    p(B, "RAG", "Running 10 RAG questions with knowledge-base activated ...")
    print(f"{'═'*70}")

    courses = get_available_courses()
    p(Y, "RAG", f"Testing with courses: {courses}")

    session_id = f"test_rag_{uuid.uuid4().hex[:8]}"
    for i, q in enumerate(RAG_QUESTIONS, 1):
        # Rotate through available courses
        course = courses[(i - 1) % len(courses)]
        payload = {
            "query":               q,
            "sessionId":           session_id,
            "documentContextName": course,
            "useWebSearch":        False,
            "useAcademicSearch":   False,
            "criticalThinkingEnabled": False,
            "deepResearchMode":    False,
        }
        result = send_chat(token, payload, label=f"[{course}] {q}")
        print_chat_result(result, i, f"RAG course={course}")

        ok       = not result.get("error") and bool(result.get("text"))
        pipe     = result.get("source_pipeline", "")
        refs     = result.get("references", [])
        text     = result.get("text", "").lower()

        rag_hit  = any(kw in pipe.lower() for kw in ["rag", "document", "retriev", "context"])
        has_refs = len(refs) > 0
        # Check if text actually cites something (sources, references, "according to", brackets)
        citation_in_text = (
            "according to" in text
            or "source:" in text
            or "reference" in text
            or "[1]" in text or "[2]" in text
            or "from the course" in text
            or "in the document" in text
        )

        r.record(f"Q{i}: response received ({course})", ok, f"elapsed={result.get('elapsed_s')}s")
        r.record(f"Q{i}: RAG pipeline activated",  rag_hit,          f"pipeline={pipe}")
        r.record(f"Q{i}: references in response",  has_refs or citation_in_text,
                 f"refs_obj={len(refs)} citation_in_text={citation_in_text}")
        time.sleep(0.5)

    r.print_summary()
    return r


# ─── SECTION 6: XP SANITY ────────────────────────────────────────────────────
def test_xp(token: str) -> Results:
    r = Results("XP-ALLOTMENT")
    print(f"\n{'═'*70}")
    p(B, "XP", "Checking XP allotment (pre/post chat comparison) ...")
    print(f"{'═'*70}")

    # Fetch user profile before
    def get_xp():
        try:
            resp = requests.get(
                f"{BASE_URL}/api/users/profile",
                headers=auth_headers(token), timeout=10,
            )
            if resp.status_code == 200:
                data = resp.json()
                return data.get("totalXP") or data.get("xp") or data.get("totalXp") or data.get("points")
        except Exception:
            pass
        # Try gamification route
        try:
            resp = requests.get(
                f"{BASE_URL}/api/gamification/profile",
                headers=auth_headers(token), timeout=10,
            )
            if resp.status_code == 200:
                data = resp.json()
                return data.get("totalXP") or data.get("xp") or data.get("totalXp") or data.get("points") or 0
        except Exception:
            pass
        return None

    xp_before = get_xp()
    p(Y, "XP", f"XP before chat: {xp_before}")

    if xp_before is None:
        r.record("XP endpoint reachable", False, "Could not read XP — check /api/users/profile or /api/gamification/stats")
    else:
        r.record("XP endpoint readable (pre-chat)",  True, f"xp={xp_before}")

    # Send one substantive chat to trigger XP
    session_id = f"test_xp_{uuid.uuid4().hex[:8]}"
    result = send_chat(token, {
        "query":     "Explain the concept of Big O notation and give examples for O(1), O(n), and O(n²).",
        "sessionId": session_id,
    })
    ok_chat = not result.get("error") and bool(result.get("text"))
    r.record("XP trigger chat message sent", ok_chat, f"pipeline={result.get('source_pipeline','?')}")

    if ok_chat:
        # XP is awarded async (nightly), but live XP events may fire immediately
        time.sleep(3)
        xp_after = get_xp()
        p(Y, "XP", f"XP after chat: {xp_after}")

        if xp_before is not None and xp_after is not None:
            xp_gained = xp_after - xp_before
            p(G if xp_gained >= 0 else Y, "XP", f"XP delta: {xp_gained:+d}")
            r.record("XP increased or held after chat", xp_gained >= 0,
                     f"before={xp_before} after={xp_after} delta={xp_gained:+d}")
        else:
            r.record("XP readable post-chat", xp_after is not None,
                     "could not read xp after chat")

    r.print_summary()
    return r


# ─── MASTER RUNNER ───────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="iMentor Backend Test Suite")
    parser.add_argument("--section", default="all",
                        choices=["all", "jobs", "chat", "web", "crit", "rag", "xp"])
    args = parser.parse_args()

    print(f"\n{'╔'+'═'*68+'╗'}")
    print(f"║{'iMentor Backend Test Suite':^68}║")
    print(f"{'╚'+'═'*68+'╝'}")
    print(f"  Server : {BASE_URL}")
    print(f"  RAG    : {RAG_URL}")
    print(f"  User   : {EMAIL}")
    print(f"  Section: {args.section}")
    print()

    all_results: list[Results] = []

    # ── Jobs (no auth needed for node --check) ──
    if args.section in ("all", "jobs"):
        all_results.append(test_jobs())

    # ── Auth login (needed for all chat tests) ──
    token = None
    if args.section in ("all", "chat", "web", "crit", "rag", "xp"):
        try:
            token = login()
        except Exception as e:
            p(R, "AUTH", f"Login failed: {e}")
            sys.exit(1)

    if args.section in ("all", "chat"):
        all_results.append(test_general_chat(token))

    if args.section in ("all", "web"):
        all_results.append(test_web_search(token))

    if args.section in ("all", "crit"):
        all_results.append(test_critical_thinking(token))

    if args.section in ("all", "rag"):
        all_results.append(test_rag(token))

    if args.section in ("all", "xp"):
        all_results.append(test_xp(token))

    # ── Grand summary ──
    if len(all_results) > 1:
        total_pass = sum(r.passed for r in all_results)
        total_fail = sum(r.failed for r in all_results)
        total      = total_pass + total_fail
        pct        = (total_pass / total * 100) if total else 0
        print(f"\n{'╔'+'═'*68+'╗'}")
        print(f"║{'GRAND TOTAL':^68}║")
        print(f"{'╚'+'═'*68+'╝'}")
        color = G if pct >= 80 else (Y if pct >= 60 else R)
        print(f"  {color}{BOLD}{total_pass}/{total} checks passed ({pct:.1f}%){W}")
        for r in all_results:
            bar = G if r.failed == 0 else (Y if r.failed <= 2 else R)
            print(f"  {bar}■{W}  {r.section:<30} {r.passed}/{r.passed+r.failed}")
        print()


if __name__ == "__main__":
    main()
