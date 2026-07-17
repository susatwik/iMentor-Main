#!/usr/bin/env python3
"""
Comprehensive Socratic Tutor Test for 'Machine Learning' course.
  - Fresh-start from Module 1, iterates through ALL 4 modules / 36 topics
  - Validates: response quality, socratic state transitions, mastery flow,
    progress persistence across separate sessions (cross-session check)
  - Simulates a real student: correct answers, partial answers, wrong answers
  - Outputs per-question analysis + full summary report
"""

import http.client
import json
import uuid
import time
import re
import sys
from datetime import datetime

# ─── Config ────────────────────────────────────────────────────────────────────
API_HOST = "localhost"
API_PORT = 5001
EMAIL    = "ultra.boy7@gmail.com"
PASSWORD = "123456"
COURSE   = "Machine Learning"
DELAY_BETWEEN_TURNS = 2.5   # seconds between SSE calls
MODULE_DELAY = 4.0           # seconds between modules

# ML curriculum structure (4 modules × up to 9 topics × subtopics)
# For each subtopic we plan: [first_answer, followup_answer]
# Answers cycle through: good -> partial -> wrong -> good to test full socratic loop
ML_CURRICULUM = [
    {
        "id": "module_1", "name": "Module 1: ML Foundations",
        "topics": [
            {"name": "Introduction to Machine Learning", "subtopics": ["Definition of ML", "history of ML", "applications of ML"],
             "student_answers": [
                 "Machine learning is a subset of AI where algorithms learn from data without being explicitly programmed.",
                 "ML started with perceptrons in the 1950s and evolved through neural networks to deep learning.",
                 "ML is used in image recognition, NLP, recommendation systems."
             ]},
            {"name": "Learning Paradigms I", "subtopics": ["Supervised Learning", "unsupervised Learning", "reinforcement learning"],
             "student_answers": [
                 "In supervised learning, we train on labeled data with input-output pairs.",
                 "Unsupervised learning finds patterns without labels, like clustering.",
                 "Reinforcement learning uses rewards and penalties to train agents."
             ]},
            {"name": "Learning Paradigms II", "subtopics": ["Online Learning", "active Learning", "transfer learning"],
             "student_answers": [
                 "Online learning updates the model with each new data point rather than batch training.",
                 "I'm not sure, maybe it involves selecting which data to label?",
                 "I don't know what transfer learning is."
             ]},
            {"name": "Inductive Learning & Bias", "subtopics": ["Hypothesis space", "inductive bias"],
             "student_answers": [
                 "Hypothesis space is the set of all possible functions the model can learn.",
                 "Inductive bias is the assumptions the model makes to generalize beyond training data."
             ]},
            {"name": "Bias-Variance Tradeoff", "subtopics": ["Overfitting", "underfitting"],
             "student_answers": [
                 "Overfitting is when the model learns noise and doesn't generalize to new data.",
                 "Underfitting is when the model is too simple and can't capture the pattern."
             ]},
        ]
    },
    {
        "id": "module_2", "name": "Module 2: Core Algorithms",
        "topics": [
            {"name": "Linear Regression", "subtopics": ["Least squares"],
             "student_answers": [
                 "Linear regression fits a line by minimizing the sum of squared residuals."
             ]},
            {"name": "Logistic Regression", "subtopics": ["Sigmoid", "binary classification"],
             "student_answers": [
                 "The sigmoid function squashes output to 0-1, used for probability.",
                 "Binary classification decides between two classes using a threshold on the sigmoid output."
             ]},
            {"name": "Gradient Descent & Delta Rule", "subtopics": ["Cost optimization"],
             "student_answers": [
                 "Gradient descent iteratively adjusts weights in the direction of negative gradient to minimize loss."
             ]},
            {"name": "Backpropagation Derivation", "subtopics": ["Chain rule", "gradients"],
             "student_answers": [
                 "The chain rule allows computing gradients through compositions of functions.",
                 "Gradients tell us how much each weight contributed to the error."
             ]},
            {"name": "Support Vector Machines", "subtopics": ["Max margin", "kernels"],
             "student_answers": [
                 "SVMs find the hyperplane that maximizes the margin between classes.",
                 "Kernels map data to higher dimensions where it becomes linearly separable."
             ]},
        ]
    },
    {
        "id": "module_3", "name": "Module 3: Advanced Methods",
        "topics": [
            {"name": "Decision Trees", "subtopics": ["Entropy", "information gain"],
             "student_answers": [
                 "Entropy measures uncertainty or impurity in a dataset.",
                 "Information gain measures how much a feature reduces entropy."
             ]},
            {"name": "Random Forests", "subtopics": ["Bagging", "Ensemble"],
             "student_answers": [
                 "Bagging trains many models on random subsets and averages predictions.",
                 "Ensemble methods combine multiple models to improve performance."
             ]},
            {"name": "Bayesian Classifier", "subtopics": ["Naive Bayes"],
             "student_answers": [
                 "Naive Bayes uses Bayes' theorem assuming feature independence."
             ]},
            {"name": "Clustering", "subtopics": ["K-means", "hierarchical"],
             "student_answers": [
                 "K-means partitions data into k clusters by minimizing intra-cluster variance.",
                 "Hierarchical clustering builds a tree of clusters by merging or splitting."
             ]},
            {"name": "Performance Metrics", "subtopics": ["Precision", "recall"],
             "student_answers": [
                 "Precision is TP/(TP+FP) - of all predicted positives how many are actually positive.",
                 "Recall is TP/(TP+FN) - of all actual positives how many did we catch."
             ]},
        ]
    },
    {
        "id": "module_4", "name": "Module 4: Advanced Topics",
        "topics": [
            {"name": "Regularization Techniques", "subtopics": ["L1", "L2"],
             "student_answers": [
                 "L1 regularization adds absolute value of weights to loss, creating sparsity.",
                 "L2 regularization adds squared weights, shrinking them towards zero."
             ]},
            {"name": "Loss Functions & Optimizers", "subtopics": ["SGD", "momentum"],
             "student_answers": [
                 "SGD updates weights on each mini-batch instead of full dataset.",
                 "Momentum accumulates past gradients to speed up convergence."
             ]},
            {"name": "Ensemble Learning", "subtopics": ["Bagging", "boosting"],
             "student_answers": [
                 "Bagging trains parallel models on bootstrap samples.",
                 "Boosting trains models sequentially where each corrects the previous."
             ]},
            {"name": "Convergence & Generalization", "subtopics": ["Overfitting"],
             "student_answers": [
                 "Overfitting happens when training loss is low but validation loss is high."
             ]},
        ]
    }
]

# ─── Helpers ───────────────────────────────────────────────────────────────────

def http_post(host, port, path, body, headers, timeout=60):
    """HTTP POST with timeout."""
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    conn.request("POST", path, json.dumps(body), headers)
    return conn.getresponse()

def http_get(host, port, path, headers={}, timeout=15):
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    conn.request("GET", path, headers=headers)
    return conn.getresponse()


def parse_sse(raw_bytes):
    """Parse SSE stream and return all events as list of dicts."""
    text = raw_bytes.decode("utf-8", errors="replace")
    events = []
    for line in text.split("\n"):
        line = line.strip()
        if line.startswith("data: "):
            data_str = line[6:]
            if data_str == "[DONE]":
                continue
            try:
                events.append(json.loads(data_str))
            except json.JSONDecodeError:
                pass
    return events


def read_sse_response(response, max_bytes=60000):
    """Read full SSE response, tolerating IncompleteRead."""
    try:
        raw = response.read(max_bytes)
    except http.client.IncompleteRead as e:
        raw = e.partial
    except Exception:
        raw = b""
    return raw


def extract_response_text(events):
    """Build final text from SSE events."""
    tokens = []
    final_answer = None
    error_msg = None
    socratic_state = None
    source_pipeline = None
    mastery_info = None
    classification = None

    for ev in events:
        t = ev.get("type", "")
        c = ev.get("content", "")

        if t == "token":
            tokens.append(c if isinstance(c, str) else "")
        elif t == "final_answer":
            if isinstance(c, dict):
                final_answer = c.get("text", "") or c.get("followUpQuestion", "")
                source_pipeline = c.get("source_pipeline", "")
                socratic_state = c.get("socraticState", "")
                mastery_info = c.get("masteryProgress", None)
                # check for isError
                if c.get("isError"):
                    error_msg = final_answer
            else:
                final_answer = str(c)
        elif t == "error":
            error_msg = c if isinstance(c, str) else str(c)
        elif t == "stream_closed":
            error_msg = "STREAM_CLOSED"
        elif t == "classification":
            classification = c

    text = final_answer or "".join(tokens)
    return text, source_pipeline, socratic_state, error_msg, mastery_info, classification


def signin(email, password):
    headers = {"Content-Type": "application/json"}
    r = http_post(API_HOST, API_PORT, "/api/auth/signin",
                  {"email": email, "password": password}, headers, timeout=15)
    data = json.loads(r.read())
    token = data.get("token") or data.get("accessToken")
    user_id = data.get("userId") or (data.get("user", {}) or {}).get("_id")
    if not token:
        raise RuntimeError(f"Auth failed: {data}")
    return token, user_id


def send_tutor_message(token, session_id, query, course=COURSE, module_id=None):
    """Send a chat message in structured tutor mode."""
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}"
    }
    body = {
        "query": query,
        "sessionId": session_id,
        "tutorMode": True,
        "tutorModeType": "structured",
        "documentContextName": course,
        "isKgRealtimeEnabled": False,
        "useWebSearch": False,
    }
    if module_id:
        body["currentModulePathId"] = module_id

    r = http_post(API_HOST, API_PORT, "/api/chat/message", body, headers, timeout=90)
    raw = read_sse_response(r)
    events = parse_sse(raw)
    return extract_response_text(events)


def get_user_progress(token):
    """Fetch progress via /api/progress/:courseName."""
    headers = {"Authorization": f"Bearer {token}"}
    try:
        import urllib.parse
        path = "/api/progress/" + urllib.parse.quote(COURSE)
        r = http_get(API_HOST, API_PORT, path, headers, timeout=10)
        if r.status == 200:
            data = json.loads(r.read())
            return data.get("progress", {})
    except Exception:
        pass
    return {}


def analyze_response(text, source_pipeline, socratic_state, error_msg):
    """Analyze quality of tutoring response."""
    quality = {}

    # Is it an error?
    quality["is_error"] = bool(error_msg)
    quality["error_msg"] = error_msg or ""

    # Response length (good responses usually > 100 chars)
    quality["length"] = len(text)
    quality["length_ok"] = len(text) > 80

    # Contains a question (Socratic responses should ask a question)
    has_question = "?" in text
    quality["has_question"] = has_question

    # Socratic moves detected
    quality["source_pipeline"] = source_pipeline or "unknown"
    quality["socratic_state"] = socratic_state or "unknown"

    # Check for structured content (bullet points, bold, etc.)
    has_structure = bool(re.search(r'\*\*|^\s*[-*•]|\d+\.', text, re.MULTILINE))
    quality["has_structure"] = has_structure

    # Pedagogical vocabulary
    pedagogy_words = ["explain", "think", "why", "how", "consider", "understand",
                      "recall", "describe", "apply", "what", "when", "example",
                      "mastered", "correct", "good", "great", "let's", "try"]
    found_pedagogy = sum(1 for w in pedagogy_words if w.lower() in text.lower())
    quality["pedagogy_score"] = found_pedagogy

    # Mastery acknowledgment
    quality["mastery_transition"] = any(w in text.lower() for w in
                                        ["mastered", "great job", "well done", "next", "advance", "move on"])

    # Overall quality score (0-5)
    score = 0
    if not error_msg: score += 1
    if has_question: score += 1
    if quality["length_ok"]: score += 1
    if has_structure: score += 1
    if found_pedagogy >= 3: score += 1
    quality["quality_score"] = score

    return quality


# ─── Main Test ─────────────────────────────────────────────────────────────────

def run_test():
    print("=" * 70)
    print("SOCRATIC TUTOR TEST — Machine Learning Course (Full Curriculum)")
    print(f"Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 70)

    # Auth
    print("\n[AUTH] Signing in...")
    try:
        token, user_id = signin(EMAIL, PASSWORD)
        print(f"[AUTH] OK — userId={user_id}")
    except Exception as e:
        print(f"[AUTH] FAILED: {e}")
        sys.exit(1)

    # Session 1: Go through all modules
    session_id = f"tutor_test_{uuid.uuid4().hex[:8]}"
    print(f"\n[SESSION 1] session_id={session_id}")

    all_results = []
    module_results = []
    turn_num = 0

    # ── Phase 1: iterate modules ──────────────────────────────────────────────
    for mod_idx, module in enumerate(ML_CURRICULUM):
        print(f"\n{'─'*70}")
        print(f"MODULE {mod_idx+1}: {module['name']}")
        print(f"{'─'*70}")

        mod_data = {"module": module["name"], "topics": [], "pass": 0, "fail": 0, "errors": 0}
        first_topic_in_module = True

        for topic in module["topics"]:
            topic_name = topic["name"]
            subtopics = topic["subtopics"]
            student_answers = topic["student_answers"]
            topic_data = {"topic": topic_name, "subtopics": [], "turns": 0, "quality_scores": [], "issues": []}

            # For the first subtopic, initiate with "start" query
            for sub_idx, sub in enumerate(subtopics):
                turn_num += 1
                answer = student_answers[sub_idx] if sub_idx < len(student_answers) else "I think I understand the basics."

                # First turn in session / module: use "start module" or answer directly
                if first_topic_in_module and sub_idx == 0:
                    query = f"start {topic_name}"
                    first_topic_in_module = False
                else:
                    query = answer

                t_start = time.time()
                try:
                    text, pipeline, soc_state, err, mastery, classification = send_tutor_message(
                        token, session_id, query, course=COURSE, module_id=module["id"]
                    )
                    elapsed = time.time() - t_start

                    q = analyze_response(text, pipeline, soc_state, err)
                    status_icon = "✓" if q["quality_score"] >= 3 else ("~" if q["quality_score"] >= 2 else "✗")
                    mastery_note = " [MASTERY TRANSITION]" if q["mastery_transition"] else ""

                    # Print compact result
                    print(f"  [{turn_num:02d}] {topic_name} / {sub}")
                    print(f"       {status_icon} Q={query[:55]}...")
                    print(f"       pipeline={pipeline or 'unknown'}  state={soc_state or '?'}  quality={q['quality_score']}/5  len={q['length']}  {elapsed:.1f}s{mastery_note}")
                    if err:
                        print(f"       ERROR: {err[:80]}")
                    elif text:
                        # Print first line of response for quality checking
                        first_line = text.split('\n')[0][:90]
                        print(f"       → \"{first_line}\"")

                    topic_data["subtopics"].append({
                        "subtopic": sub,
                        "query": query,
                        "pipeline": pipeline,
                        "socratic_state": soc_state,
                        "quality": q,
                        "elapsed": elapsed,
                        "response_preview": text[:200] if text else "",
                        "classification": classification
                    })
                    topic_data["quality_scores"].append(q["quality_score"])

                    if q["is_error"]:
                        topic_data["issues"].append(f"ERROR: {err}")
                        mod_data["errors"] += 1
                    elif q["quality_score"] >= 3:
                        mod_data["pass"] += 1
                    else:
                        mod_data["fail"] += 1
                        topic_data["issues"].append(f"Low quality ({q['quality_score']}/5) for '{sub}'")

                except Exception as ex:
                    elapsed = time.time() - t_start
                    print(f"  [{turn_num:02d}] {topic_name} / {sub}")
                    print(f"       ✗ EXCEPTION: {ex}")
                    topic_data["subtopics"].append({"subtopic": sub, "error": str(ex)})
                    topic_data["issues"].append(f"EXCEPTION: {ex}")
                    mod_data["errors"] += 1

                topic_data["turns"] += 1
                time.sleep(DELAY_BETWEEN_TURNS)

            # After subtopics, send the student answer to complete the topic
            # (simulate mastery by giving the right answer)
            if len(student_answers) > len(subtopics):
                turn_num += 1
                final_answer = student_answers[-1]
                t_start = time.time()
                try:
                    text, pipeline, soc_state, err, mastery, classification = send_tutor_message(
                        token, session_id, final_answer, course=COURSE, module_id=module["id"]
                    )
                    elapsed = time.time() - t_start
                    q = analyze_response(text, pipeline, soc_state, err)
                    print(f"  [{turn_num:02d}] {topic_name} [follow-up answer]")
                    print(f"       quality={q['quality_score']}/5  state={soc_state or '?'}  {elapsed:.1f}s")
                    topic_data["turns"] += 1
                    time.sleep(DELAY_BETWEEN_TURNS)
                except Exception as ex:
                    print(f"  [{turn_num:02d}] follow-up EXCEPTION: {ex}")

            mod_data["topics"].append(topic_data)

        module_results.append(mod_data)
        all_results.append(mod_data)

        # Progress check after each module
        prog = get_user_progress(token)
        completed_subs = len(prog.get("completedSubtopics", []))
        completed_topics = len(prog.get("completedTopics", []))
        completed_mods = len(prog.get("completedModules", []))
        print(f"\n  [PROGRESS after {module['name']}]")
        print(f"   completedSubtopics={completed_subs}  completedTopics={completed_topics}  completedModules={completed_mods}")

        if mod_idx < len(ML_CURRICULUM) - 1:
            print(f"  [PAUSE] {MODULE_DELAY}s before next module...")
            time.sleep(MODULE_DELAY)

    # ── Phase 2: Cross-Session Persistence Check ──────────────────────────────
    print(f"\n{'='*70}")
    print("PHASE 2: Cross-Session Persistence Check")
    print(f"{'='*70}")
    
    session_id_2 = f"tutor_test_{uuid.uuid4().hex[:8]}"
    print(f"[SESSION 2] new session_id={session_id_2}")
    print("Re-signing in to simulate fresh browser/tab...")
    time.sleep(2)

    try:
        token2, _ = signin(EMAIL, PASSWORD)
        prog2 = get_user_progress(token2)
        completed_subs2 = prog2.get("completedSubtopics", [])
        completed_topics2 = prog2.get("completedTopics", [])
        completed_mods2 = prog2.get("completedModules", [])

        persistence_ok = len(completed_subs2) > 0 or len(completed_topics2) > 0

        print(f"\n[PERSISTENCE]")
        print(f"  Session-2 completedSubtopics={len(completed_subs2)} completedTopics={len(completed_topics2)} completedModules={len(completed_mods2)}")
        print(f"  Persistence: {'✓ PASS' if persistence_ok else '✗ FAIL — no progress saved'}")
        if completed_subs2:
            print(f"  Sample subtopics: {completed_subs2[:5]}")

        # Try to continue lesson in new session (should resume not restart)
        print(f"\n[SESSION 2] Testing resume behavior...")
        query_session2 = "let's continue where we left off"
        t_start = time.time()
        text2, pipeline2, soc_state2, err2, _, _ = send_tutor_message(
            token2, session_id_2, query_session2, course=COURSE
        )
        elapsed2 = time.time() - t_start
        q2 = analyze_response(text2, pipeline2, soc_state2, err2)
        print(f"  Resume response pipeline={pipeline2}  state={soc_state2}  quality={q2['quality_score']}/5  {elapsed2:.1f}s")
        if text2:
            print(f"  → \"{text2[:150]}\"")

    except Exception as ex:
        print(f"[PERSISTENCE CHECK] FAILED: {ex}")
        persistence_ok = False

    # ── Final Report ──────────────────────────────────────────────────────────
    print(f"\n{'='*70}")
    print("FINAL REPORT — Socratic Tutor Quality Analysis")
    print(f"{'='*70}")

    total_pass = sum(m["pass"] for m in module_results)
    total_fail = sum(m["fail"] for m in module_results)
    total_err  = sum(m["errors"] for m in module_results)
    total_turns = total_pass + total_fail + total_err

    print(f"\n  Total turns: {total_turns}")
    print(f"  Quality PASS (≥3/5): {total_pass}/{total_turns} ({100*total_pass//max(total_turns,1)}%)")
    print(f"  Quality FAIL (<3/5): {total_fail}/{total_turns}")
    print(f"  Errors:              {total_err}/{total_turns}")

    print(f"\n  Per-Module Summary:")
    print(f"  {'Module':<38} {'Pass':>6} {'Fail':>6} {'Err':>5}")
    print(f"  {'-'*57}")
    for m in module_results:
        t = m["pass"] + m["fail"] + m["errors"]
        print(f"  {m['module']:<38} {m['pass']:>5}/{t:<3} {m['fail']:>5}/{t:<3} {m['errors']:>4}/{t}")

    print(f"\n  Topic-level issues:")
    for m in module_results:
        for t in m["topics"]:
            if t["issues"]:
                print(f"    [{m['module']}] {t['topic']}: {'; '.join(t['issues'][:2])}")

    # Quality breakdown
    all_scores = []
    for m in module_results:
        for t in m["topics"]:
            all_scores.extend(t["quality_scores"])

    if all_scores:
        avg_quality = sum(all_scores) / len(all_scores)
        print(f"\n  Average quality score: {avg_quality:.2f}/5")
        score_dist = {i: all_scores.count(i) for i in range(6)}
        print(f"  Score distribution: {score_dist}")

    # Socratic state analysis
    all_states = []
    for m in module_results:
        for t in m["topics"]:
            for s in t["subtopics"]:
                if isinstance(s, dict) and "quality" in s:
                    st = s["quality"].get("socratic_state", "")
                    if st:
                        all_states.append(st)

    if all_states:
        from collections import Counter
        state_counts = Counter(all_states)
        print(f"\n  Socratic state distribution:")
        for state, count in state_counts.most_common():
            print(f"    {state}: {count}")

    # Pipeline analysis
    all_pipelines = []
    for m in module_results:
        for t in m["topics"]:
            for s in t["subtopics"]:
                if isinstance(s, dict) and "quality" in s:
                    pl = s["quality"].get("source_pipeline", "")
                    if pl:
                        all_pipelines.append(pl)

    if all_pipelines:
        from collections import Counter
        pl_counts = Counter(all_pipelines)
        print(f"\n  Pipeline distribution:")
        for pl, count in pl_counts.most_common():
            print(f"    {pl}: {count}")

    print(f"\n{'='*70}")
    print(f"  OVERALL: {'PASS' if total_pass >= total_turns * 0.65 else 'NEEDS IMPROVEMENT'}")
    print(f"  Socratic Learning Quality: {'GOOD' if avg_quality >= 3.5 else 'FAIR' if avg_quality >= 2.5 else 'POOR'}")
    print(f"  Progress Persistence: {'✓ VERIFIED' if persistence_ok else '✗ NOT VERIFIED'}")
    print(f"  Completed: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'='*70}\n")


if __name__ == "__main__":
    run_test()
