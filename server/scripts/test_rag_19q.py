#!/usr/bin/env python3
"""
19-question live RAG test
  - Login as ultra.boy7@gmail.com
  - One session, RAG ON (Machine Learning course), Web OFF
  - Checks: pipeline = rag_search, inline [N] citations present, ## References section
"""

import http.client, json, time, re, sys

BASE = "localhost"
PORT = 5001
EMAIL = "ultra.boy7@gmail.com"
PASSWORD = "123456"
COURSE = "Machine Learning"
TIMEOUT = 120  # seconds per question

QUESTIONS = [
    "What is supervised learning and how does it differ from unsupervised learning?",
    "Explain the bias-variance tradeoff with examples.",
    "What is gradient descent and how does it work step by step?",
    "Describe the concept of overfitting and how to prevent it.",
    "What are support vector machines and how do they classify data?",
    "Explain backpropagation in neural networks with the chain rule.",
    "What is the difference between bagging and boosting in ensemble methods?",
    "How does the random forest algorithm work?",
    "What is regularization (L1 and L2) and why is it used?",
    "What is dimensionality reduction and how does PCA work?",
    "What are activation functions and why is ReLU commonly used?",
    "Explain the k-nearest neighbours algorithm.",
    "What is cross-validation and why is it important?",
    "How does logistic regression work for classification?",
    "What is the role of the learning rate in training a neural network?",
    "Explain the concept of a decision tree and how splits are chosen.",
    "What is precision and recall and when do you prefer one over the other?",
    "What is the vanishing gradient problem and how is it addressed?",
    "Explain convolutional neural networks and their use in image recognition.",
]


def _post_json(path, body, token=None):
    conn = http.client.HTTPConnection(BASE, PORT, timeout=30)
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    conn.request("POST", path, json.dumps(body), headers)
    r = conn.getresponse()
    return r.status, json.loads(r.read())


def _get_json(path, token=None):
    conn = http.client.HTTPConnection(BASE, PORT, timeout=30)
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    conn.request("GET", path, headers=headers)
    r = conn.getresponse()
    return r.status, json.loads(r.read())


def send_rag_query(query, session_id, token, max_retries=2):
    """Send one chat message with RAG on, return final_answer content or None."""
    from http.client import IncompleteRead
    payload = {
        "query": query,
        "sessionId": session_id,
        "documentContextName": COURSE,
        "isKgRealtimeEnabled": True,
        "useWebSearch": False,
        "useAcademicSearch": False,
        "deepResearchMode": False,
        "tutorMode": False,
        "criticalThinkingEnabled": False,
    }

    for attempt in range(max_retries + 1):
        if attempt > 0:
            print(f"       ↺ retry {attempt}...")
            time.sleep(3)
        try:
            conn = http.client.HTTPConnection(BASE, PORT, timeout=TIMEOUT)
            headers = {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}
            conn.request("POST", "/api/chat/message", json.dumps(payload), headers)
            resp = conn.getresponse()

            if resp.status != 200:
                return None, f"HTTP {resp.status}"

            # Parse SSE stream — handle chunked transfer IncompleteRead gracefully
            buffer = b""
            final = None

            def process_buffer(buf):
                nonlocal final
                lines = buf.split(b"\n")
                for line in lines:
                    line = line.strip()
                    if line.startswith(b"data:"):
                        raw = line[5:].strip()
                        if raw in (b"[DONE]", b""):
                            continue
                        try:
                            ev = json.loads(raw)
                            if ev.get("type") == "final_answer":
                                final = ev.get("content", {})
                        except Exception:
                            pass

            deadline = time.time() + TIMEOUT
            try:
                while time.time() < deadline:
                    try:
                        chunk = resp.read(4096)
                    except IncompleteRead as e:
                        chunk = e.partial
                    if not chunk:
                        break
                    buffer += chunk
                    # Process all complete lines except last (may be partial)
                    split = buffer.split(b"\n")
                    buffer = split[-1]
                    for line in split[:-1]:
                        line = line.strip()
                        if line.startswith(b"data:"):
                            raw = line[5:].strip()
                            if raw in (b"[DONE]", b""):
                                continue
                            try:
                                ev = json.loads(raw)
                                if ev.get("type") == "final_answer":
                                    final = ev.get("content", {})
                                    return final, None
                            except Exception:
                                pass
            except Exception:
                pass

            # Process any remainder in buffer
            process_buffer(buffer)

            if final is not None:
                return final, None
            # If stream closed without final_answer, retry
            last_error = "STREAM_CLOSED"

        except (ConnectionRefusedError, OSError) as e:
            last_error = f"CONN_ERR: {e}"
            continue

    return None, last_error


def check_citations(text):
    """Return True if inline [N] citation found."""
    return bool(re.search(r'\[\d+\]', text or ""))


def check_references_section(text):
    """Return True if ## References section is present."""
    return bool(re.search(r'##\s*References', text or "", re.IGNORECASE))


# ─────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────
print("=" * 68)
print("  19-QUESTION RAG TEST  |  Course: Machine Learning")
print("=" * 68)

# 1. Login
status, data = _post_json("/api/auth/signin", {"email": EMAIL, "password": PASSWORD})
assert status == 200, f"Login failed: {status} {data}"
TOKEN = data["token"]
print(f"[Auth] ✓ Logged in\n")

# 2. Create session
status, sess = _post_json("/api/chat/history", {"subject": COURSE}, TOKEN)
assert status in (200, 201), f"Session creation failed: {status} {sess}"
SESSION_ID = sess.get("newSessionId") or sess.get("sessionId") or sess.get("_id")
print(f"[Session] ✓ {SESSION_ID}\n")

# 3. Run questions
results = []
for i, q in enumerate(QUESTIONS, 1):
    print(f"[Q{i:02d}] {q[:70]}{'...' if len(q)>70 else ''}")
    t0 = time.time()
    content, err = send_rag_query(q, SESSION_ID, TOKEN)
    elapsed = time.time() - t0

    if err and content is None:
        print(f"       ✗ ERROR: {err}  ({elapsed:.1f}s)\n")
        results.append({"q": i, "ok": False, "pipeline": "ERROR", "citations": False, "refs": False, "error": err, "ms": elapsed})
        continue

    pipeline = content.get("source_pipeline", "?")
    text = content.get("text", "")
    references = content.get("references", [])
    citations_ok = check_citations(text)
    refs_section = check_references_section(text)
    is_rag = "rag" in pipeline.lower()

    status_str = "✓" if (is_rag and citations_ok) else "~"
    print(f"       {status_str} pipeline={pipeline}  refs={len(references)}  inline_cite={citations_ok}  ref_section={refs_section}  ({elapsed:.1f}s)")

    # Show first inline citation found
    m = re.search(r'\[\d+\]', text)
    if m:
        start = max(0, m.start() - 40)
        end = min(len(text), m.end() + 40)
        snippet = text[start:end].replace('\n', ' ')
        print(f"       → cite snippet: ...{snippet}...")

    print()
    results.append({
        "q": i, "ok": is_rag and citations_ok,
        "pipeline": pipeline,
        "citations": citations_ok,
        "refs_section": refs_section,
        "num_refs": len(references),
        "error": err,
        "ms": round(elapsed, 1)
    })
    time.sleep(1)  # brief pause between requests

# ─── Summary ────────────────────────────────────────
print("=" * 68)
print("SUMMARY")
print("=" * 68)
rag_count = sum(1 for r in results if "rag" in r["pipeline"].lower())
cite_count = sum(1 for r in results if r["citations"])
refs_count = sum(1 for r in results if r.get("refs_section"))
ok_count = sum(1 for r in results if r["ok"])
err_count = sum(1 for r in results if r["error"])

print(f"  RAG pipeline used   : {rag_count}/19")
print(f"  Inline citations [N]: {cite_count}/19")
print(f"  ## References section: {refs_count}/19")
print(f"  Errors/Timeouts     : {err_count}/19")
print(f"  OVERALL PASS (rag+cite): {ok_count}/19")
print()
print(f"{'Q':>3}  {'Pipeline':<35}  {'Cite':>4}  {'RefSec':>6}  {'Refs':>4}  {'Time':>6}  Status")
print("-" * 75)
for r in results:
    status_icon = "✓" if r["ok"] else ("✗" if r["error"] else "~")
    print(f"  {r['q']:>2}  {r['pipeline']:<35}  {str(r['citations']):>4}  {str(r.get('refs_section',False)):>6}  {r['num_refs'] if not r['error'] else '-':>4}  {r['ms']:>5.1f}s  {status_icon} {r['error'] or ''}")

print("=" * 68)
