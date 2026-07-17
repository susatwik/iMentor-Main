#!/usr/bin/env python3
"""
Average BTech Student — Full ML Curriculum Socratic Tutor Test
  - Simulates a realistic 3rd-year BTech CSE student
  - Knows CS fundamentals, has basic ML awareness, struggles on math derivations
  - Mixes: good answers, partially-correct, "I don't know", wrong answers
  - Tests: struggle escalation, mermaid visual aids, encouragement, mastery flow
  - Attempts ALL 4 modules across all subtopics
  - Clears prior progress, then does cross-session persistence check at end
"""

import http.client
import json
import uuid
import time
import re
import sys
from datetime import datetime
from collections import Counter

# ─── Config ────────────────────────────────────────────────────────────────────
API_HOST              = "localhost"
API_PORT              = 5001
EMAIL                 = "ultra.boy7@gmail.com"
PASSWORD              = "123456"
COURSE                = "Machine Learning"
DELAY_BETWEEN_TURNS   = 3.0   # seconds (let LLM breathe between calls)
MODULE_DELAY          = 5.0   # slightly longer between modules
LOG_FULL_RESPONSE     = False  # set True to see full tutor replies

# ─── Student answer profiles for each subtopic ────────────────────────────────
# Each entry: (query, student_quality)
# quality key: "good"|"partial"|"wrong"|"blank"
#
# Rule of thumb for average BTech student:
#   Intro topics → mostly "partial" with some "good"
#   Core algorithms → "partial" first try, "good" on second
#   Advanced (math-heavy) → "wrong" or "blank" first, "partial" second, "good" final
#   Very advanced → maybe never gets to "good" alone

# Format: list of (student_answer, expected_quality)
# The test script will keep answering until the bot signals MASTERY or max 4 turns per subtopic

CURRICULUM = [
    # ═══════════════════════════════════════════════════════════════════════════
    #  MODULE 1 — ML Foundations
    # ═══════════════════════════════════════════════════════════════════════════
    {
        "module_id": "module_1",
        "module_name": "Module 1: ML Foundations",
        "topics": [
            {
                "name": "Introduction to Machine Learning",
                "init_query": "start",  # opening message to kick off the subtopic
                "subtopics": [
                    {
                        "name": "Definition of ML",
                        "turns": [
                            "Machine learning is when computers learn by themselves from data, without us telling them every step to take.",
                            "It's a branch of AI where systems improve from experience — basically finding patterns in data automatically.",
                        ]
                    },
                    {
                        "name": "History of ML",
                        "turns": [
                            "I think ML has been around since the 80s? Maybe it started with neural networks.",
                            "Oh, it actually started in the 1950s with things like the perceptron, then went through AI winters because computers weren't powerful enough.",
                        ]
                    },
                    {
                        "name": "Applications of ML",
                        "turns": [
                            "ML is used in spam filters, recommendation systems, and image recognition like face detection.",
                            "Also natural language processing — things like Siri or chatbots, and medical diagnosis from X-rays.",
                        ]
                    },
                ]
            },
            {
                "name": "Learning Paradigms",
                "subtopics": [
                    {
                        "name": "Supervised Learning",
                        "turns": [
                            "Supervised learning is when the model trains on a labeled dataset where every input has a correct output.",
                            "For example, training a classifier on images labeled 'cat' or 'dog'. The model learns to map inputs to outputs.",
                        ]
                    },
                    {
                        "name": "Unsupervised Learning",
                        "turns": [
                            "I think it's when you don't have labels... the algorithm just groups similar data together?",
                            "Yes, clustering is one way — like K-means. The model finds structure without being told what to look for.",
                        ]
                    },
                    {
                        "name": "Reinforcement Learning",
                        "turns": [
                            "Hmm, reinforcement learning has an agent and an environment. The agent does actions and gets rewards or penalties.",
                            "So it learns by trial and error to maximize cumulative reward — like training a game-playing AI.",
                        ]
                    },
                ]
            },
            {
                "name": "Inductive Learning & Bias",
                "subtopics": [
                    {
                        "name": "Hypothesis Space",
                        "turns": [
                            "I'm not really sure what hypothesis space means in ML context.",
                            "I think it's the set of all models or functions the learning algorithm can possibly output given the data.",
                        ]
                    },
                    {
                        "name": "Inductive Bias",
                        "turns": [
                            "No idea honestly.",
                            "Inductive bias is the set of assumptions a model makes to generalize — like a linear model assumes a linear relationship?",
                        ]
                    },
                ]
            },
            {
                "name": "Bias-Variance Tradeoff",
                "subtopics": [
                    {
                        "name": "Overfitting",
                        "turns": [
                            "Overfitting is when the model memorizes the training data and doesn't work well on new data. High training accuracy, low test accuracy.",
                            "It usually happens with complex models and small datasets.",
                        ]
                    },
                    {
                        "name": "Underfitting",
                        "turns": [
                            "Underfitting is the opposite — the model is too simple, misses patterns in both training and test data.",
                            "Like fitting a straight line to curved data — it can't capture the complexity.",
                        ]
                    },
                ]
            },
            {
                "name": "Online & Active Learning",
                "subtopics": [
                    {
                        "name": "Online Learning",
                        "turns": [
                            "I think online learning means training the model on the internet... maybe web data?",
                            "Oh wait, it means updating the model incrementally as each new data point arrives, not batch training.",
                        ]
                    },
                    {
                        "name": "Active Learning",
                        "turns": [
                            "Active learning... the model actively picks which examples it wants labeled?",
                            "Right, the model queries a human expert to label the most uncertain or informative data points, saving labeling cost.",
                        ]
                    },
                    {
                        "name": "Transfer Learning",
                        "turns": [
                            "Using a pre-trained model and adapting it to a new task? Like using ImageNet weights for a different image problem.",
                            "Yes, the features learned on one domain can be reused — saves training time and data.",
                        ]
                    },
                ]
            },
        ]
    },

    # ═══════════════════════════════════════════════════════════════════════════
    #  MODULE 2 — Core Algorithms
    # ═══════════════════════════════════════════════════════════════════════════
    {
        "module_id": "module_2",
        "module_name": "Module 2: Core Algorithms",
        "topics": [
            {
                "name": "Linear Regression",
                "subtopics": [
                    {
                        "name": "Least Squares",
                        "turns": [
                            "Least squares fits a line by minimizing the sum of squared differences between predicted and actual values.",
                            "The formula is W = (X^T X)^-1 X^T y, so we're minimizing the residual sum of squares.",
                        ]
                    },
                ]
            },
            {
                "name": "Logistic Regression",
                "subtopics": [
                    {
                        "name": "Sigmoid Function",
                        "turns": [
                            "Sigmoid outputs a value between 0 and 1, used to convert a linear score into a probability.",
                            "The formula is 1 / (1 + e^-z). When z is large positive, output approaches 1; large negative, approaches 0.",
                        ]
                    },
                    {
                        "name": "Binary Classification",
                        "turns": [
                            "We threshold the sigmoid at 0.5 — above is class 1, below is class 0.",
                            "The model optimizes cross-entropy loss instead of MSE because it's better for probability outputs.",
                        ]
                    },
                ]
            },
            {
                "name": "Gradient Descent",
                "subtopics": [
                    {
                        "name": "Cost Optimization",
                        "turns": [
                            "We want to minimize the loss function. Gradient descent moves weights in the negative gradient direction.",
                            "The update rule is w = w - learning_rate * gradient. Small steps in the direction of steepest descent.",
                        ]
                    },
                ]
            },
            {
                "name": "Backpropagation",
                "subtopics": [
                    {
                        "name": "Chain Rule",
                        "turns": [
                            "The chain rule lets you compute derivatives of nested functions — like dL/dw = dL/da * da/dz * dz/dw.",
                            "In backprop we apply the chain rule backwards through layers to get each weight's gradient.",
                        ]
                    },
                    {
                        "name": "Gradient Flow",
                        "turns": [
                            "I think gradients flow backwards from the output layer to the input layer during training.",
                            "Yeah, each layer computes its local gradient and multiplies by the incoming gradient from the layer ahead — that's backprop.",
                        ]
                    },
                ]
            },
            {
                "name": "Support Vector Machines",
                "subtopics": [
                    {
                        "name": "Maximum Margin",
                        "turns": [
                            "SVM finds a hyperplane that separates classes with the maximum margin — the widest possible gap.",
                            "The support vectors are the closest data points to the decision boundary that determine the margin.",
                        ]
                    },
                    {
                        "name": "Kernel Trick",
                        "turns": [
                            "Kernels allow SVMs to work in higher-dimensional space without explicitly computing the transformation.",
                            "So you compute dot products in the transformed space implicitly — like RBF or polynomial kernels.",
                        ]
                    },
                ]
            },
            {
                "name": "Perceptron & Neural Networks",
                "subtopics": [
                    {
                        "name": "Perceptron Learning",
                        "turns": [
                            "The perceptron updates weights whenever it misclassifies — adds or subtracts the input vector.",
                            "It converges if the data is linearly separable, but fails otherwise.",
                        ]
                    },
                ]
            },
        ]
    },

    # ═══════════════════════════════════════════════════════════════════════════
    #  MODULE 3 — Advanced Methods
    # ═══════════════════════════════════════════════════════════════════════════
    {
        "module_id": "module_3",
        "module_name": "Module 3: Advanced Methods",
        "topics": [
            {
                "name": "Decision Trees",
                "subtopics": [
                    {
                        "name": "Entropy",
                        "turns": [
                            "Entropy measures the disorder or impurity in a set — high when classes are equally mixed, zero when pure.",
                            "Formula is -sum(p * log2(p)) — so a 50/50 split gives max entropy of 1.",
                        ]
                    },
                    {
                        "name": "Information Gain",
                        "turns": [
                            "Information gain is the reduction in entropy after a split on a feature.",
                            "We pick the feature with highest information gain at each node — that's the ID3 algorithm.",
                        ]
                    },
                ]
            },
            {
                "name": "Random Forests",
                "subtopics": [
                    {
                        "name": "Bagging",
                        "turns": [
                            "Bagging trains multiple models on different bootstrap samples and averages their predictions.",
                            "It reduces variance — the ensemble is more stable than any single model.",
                        ]
                    },
                    {
                        "name": "Feature Randomness",
                        "turns": [
                            "Random forests also randomly select a subset of features at each split, not just bootstrap samples.",
                            "This decorrelates the trees, making the ensemble more robust than plain bagging.",
                        ]
                    },
                ]
            },
            {
                "name": "Naive Bayes",
                "subtopics": [
                    {
                        "name": "Bayes Theorem",
                        "turns": [
                            "Bayes theorem: P(class|features) is proportional to P(features|class) * P(class).",
                            "Naive assumption is all features are conditionally independent given the class.",
                        ]
                    },
                ]
            },
            {
                "name": "Clustering",
                "subtopics": [
                    {
                        "name": "K-means",
                        "turns": [
                            "K-means picks K centroids randomly, assigns each point to nearest centroid, updates centroids, repeats.",
                            "It minimizes within-cluster sum of squares. Converges to a local optimum.",
                        ]
                    },
                    {
                        "name": "Hierarchical Clustering",
                        "turns": [
                            "Hierarchical clustering builds a dendrogram — either agglomerative bottom-up or divisive top-down.",
                            "In agglomerative: start with each point as its own cluster, merge the two closest at each step.",
                        ]
                    },
                ]
            },
            {
                "name": "Performance Metrics",
                "subtopics": [
                    {
                        "name": "Precision",
                        "turns": [
                            "Precision is TP divided by TP plus FP — of everything predicted positive, how many are actually positive.",
                            "High precision means few false alarms.",
                        ]
                    },
                    {
                        "name": "Recall",
                        "turns": [
                            "Recall is TP divided by TP plus FN — of all actual positives, how many did we find.",
                            "High recall means we catch most actual positives even if we have false alarms.",
                        ]
                    },
                    {
                        "name": "F1 Score",
                        "turns": [
                            "F1 is the harmonic mean of precision and recall — balances both.",
                            "Formula is 2 * precision * recall / (precision + recall).",
                        ]
                    },
                ]
            },
            {
                "name": "Cross Validation",
                "subtopics": [
                    {
                        "name": "K-Fold Validation",
                        "turns": [
                            "K-fold splits data into K folds, trains on K-1, tests on 1, rotates K times.",
                            "Gives a better estimate of generalization performance by using all data for both training and testing.",
                        ]
                    },
                ]
            },
        ]
    },

    # ═══════════════════════════════════════════════════════════════════════════
    #  MODULE 4 — Advanced Topics (student struggles more here)
    # ═══════════════════════════════════════════════════════════════════════════
    {
        "module_id": "module_4",
        "module_name": "Module 4: Advanced Topics",
        "topics": [
            {
                "name": "Regularization",
                "subtopics": [
                    {
                        "name": "L1 Regularization",
                        "turns": [
                            "L1 adds the absolute value of weights to the loss, which can make some weights exactly zero — sparse model.",
                            "So L1 selects features by zeroing out unimportant weights — useful when only a few features matter.",
                        ]
                    },
                    {
                        "name": "L2 Regularization",
                        "turns": [
                            "L2 adds squared weights to loss, which shrinks all weights but doesn't zero them.",
                            "L2 prefers small weights spread evenly — prevents any weight from dominating.",
                        ]
                    },
                ]
            },
            {
                "name": "Loss Functions & Optimizers",
                "subtopics": [
                    {
                        "name": "SGD",
                        "turns": [
                            "SGD updates weights on a mini-batch instead of the whole dataset — faster but noisier.",
                            "The noise actually helps escape local minima in practice.",
                        ]
                    },
                    {
                        "name": "Momentum",
                        "turns": [
                            "Momentum keeps a running average of past gradients so we don't zigzag as much.",
                            "It smooths updates and speeds up convergence, especially in directions of consistent gradient.",
                        ]
                    },
                    {
                        "name": "Adam Optimizer",
                        "turns": [
                            "I don't know Adam well... I think it adapts the learning rate for each parameter?",
                            "Adam combines momentum and per-parameter adaptive learning rates using first and second moment estimates.",
                        ]
                    },
                ]
            },
            {
                "name": "Ensemble Learning",
                "subtopics": [
                    {
                        "name": "Boosting",
                        "turns": [
                            "Boosting trains models sequentially where each new model focuses on examples the previous got wrong.",
                            "AdaBoost and Gradient Boosting are examples — reduce bias and can overfit if too many rounds.",
                        ]
                    },
                    {
                        "name": "Stacking",
                        "turns": [
                            "Stacking uses predictions from multiple base models as inputs to a meta-model.",
                            "The meta-model learns how to best combine the base predictions — powerful but computationally expensive.",
                        ]
                    },
                ]
            },
            {
                "name": "Dimensionality Reduction",
                "subtopics": [
                    {
                        "name": "PCA",
                        "turns": [
                            "PCA finds orthogonal axes that capture maximum variance in the data.",
                            "We compute eigenvectors of the covariance matrix — the top-k eigenvectors are the principal components.",
                        ]
                    },
                ]
            },
            {
                "name": "Convergence & Generalization",
                "subtopics": [
                    {
                        "name": "Generalization Gap",
                        "turns": [
                            "Generalization gap is the difference between training error and test error.",
                            "A large gap means overfitting — model learned noise specific to training data.",
                        ]
                    },
                    {
                        "name": "Early Stopping",
                        "turns": [
                            "Early stopping means we monitor validation loss and stop training when it starts to go up.",
                            "It's a form of regularization — prevents the model from overfitting by cutting training short.",
                        ]
                    },
                ]
            },
        ]
    },
]


# ─── HTTP Helpers ──────────────────────────────────────────────────────────────

def http_post(path, body, headers, timeout=90):
    conn = http.client.HTTPConnection(API_HOST, API_PORT, timeout=timeout)
    conn.request("POST", path, json.dumps(body), headers)
    return conn.getresponse()

def http_get(path, headers={}, timeout=15):
    conn = http.client.HTTPConnection(API_HOST, API_PORT, timeout=timeout)
    conn.request("GET", path, headers=headers)
    return conn.getresponse()

def parse_sse(raw_bytes):
    text = raw_bytes.decode("utf-8", errors="replace")
    events = []
    for line in text.split("\n"):
        line = line.strip()
        if line.startswith("data: "):
            data_str = line[6:]
            if data_str == "[DONE]": continue
            try:
                events.append(json.loads(data_str))
            except json.JSONDecodeError:
                pass
    return events

def read_sse_response(response, max_bytes=80000):
    try:
        raw = response.read(max_bytes)
    except http.client.IncompleteRead as e:
        raw = e.partial
    except Exception:
        raw = b""
    return raw

def extract_response(events):
    tokens, final_answer, error_msg = [], None, None
    source_pipeline = socratic_state = mastery_info = None
    has_visual_aid = False
    mermaid_found = False

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
                if c.get("isError"): error_msg = final_answer
            else:
                final_answer = str(c)
        elif t == "visual_aid":
            has_visual_aid = True
        elif t == "error":
            error_msg = c if isinstance(c, str) else str(c)

    text = final_answer or "".join(tokens)
    # Check for mermaid in response text
    if text and "```mermaid" in text.lower():
        mermaid_found = True

    return text, source_pipeline, socratic_state, error_msg, mastery_info, has_visual_aid, mermaid_found

def signin(email, password):
    headers = {"Content-Type": "application/json"}
    r = http_post("/api/auth/signin", {"email": email, "password": password}, headers, timeout=15)
    data = json.loads(r.read())
    token = data.get("token") or data.get("accessToken")
    user_id = data.get("_id") or data.get("userId") or (data.get("user", {}) or {}).get("_id")
    if not token:
        raise RuntimeError(f"Auth failed: {data}")
    return token, user_id

def clear_progress(user_id_str):
    """Clear ML curriculum progress directly in MongoDB."""
    try:
        from pymongo import MongoClient
        from bson import ObjectId
        client = MongoClient("mongodb://localhost:27017", serverSelectionTimeoutMS=5000)
        db = client["iMentorDB"]
        users = db["users"]
        result = users.update_one(
            {"_id": ObjectId(user_id_str)},
            {"$unset": {f"curriculumProgress.{COURSE}": ""}}
        )
        client.close()
        return result.modified_count == 1, f"modified={result.modified_count}"
    except Exception as e:
        return False, str(e)

def send_message(token, session_id, query, module_id=None):
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}"
    }
    body = {
        "query": query,
        "sessionId": session_id,
        "tutorMode": True,
        "tutorModeType": "structured",
        "documentContextName": COURSE,
        "isKgRealtimeEnabled": False,
        "useWebSearch": False,
    }
    if module_id:
        body["currentModulePathId"] = module_id
    r = http_post("/api/chat/message", body, headers, timeout=90)
    raw = read_sse_response(r)
    events = parse_sse(raw)
    return extract_response(events)

def get_progress(token):
    import urllib.parse
    path = "/api/progress/" + urllib.parse.quote(COURSE)
    headers = {"Authorization": f"Bearer {token}"}
    try:
        r = http_get(path, headers, timeout=10)
        if r.status == 200:
            data = json.loads(r.read())
            return data.get("progress", {})
    except Exception:
        pass
    return {}

def quality_of(text, source_pipeline, socratic_state, error_msg):
    q = {}
    q["is_error"] = bool(error_msg)
    q["length"] = len(text or "")
    q["length_ok"] = q["length"] > 60
    q["has_question"] = "?" in (text or "")
    q["source_pipeline"] = source_pipeline or "unknown"
    q["socratic_state"] = socratic_state or "unknown"
    q["has_structure"] = bool(re.search(r'\*\*|`|^\s*[-*•]|\d+\.', text or "", re.MULTILINE))
    q["has_mermaid"] = "```mermaid" in (text or "").lower()

    pedagogy = ["think", "why", "how", "consider", "recall", "describe", "apply",
                "what", "when", "example", "correct", "great", "well done", "try"]
    q["pedagogy_score"] = sum(1 for w in pedagogy if w.lower() in (text or "").lower())

    score = 0
    if not error_msg: score += 1
    if q["has_question"]: score += 1
    if q["length_ok"]: score += 1
    if q["has_structure"]: score += 1
    if q["pedagogy_score"] >= 3: score += 1
    q["quality_score"] = score
    return q


# ─── Main Test ─────────────────────────────────────────────────────────────────

def run_test():
    SEP = "=" * 72
    sep = "─" * 72

    print(SEP)
    print("  BTECH STUDENT — Full ML Curriculum Socratic Tutor Test")
    print(f"  Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(SEP)

    # ── Auth ──────────────────────────────────────────────────────────────────
    print("\n[AUTH] Signing in...")
    try:
        token, user_id = signin(EMAIL, PASSWORD)
        print(f"[AUTH] OK — userId={user_id}")
    except Exception as e:
        print(f"[AUTH] FAILED: {e}")
        sys.exit(1)

    # ── Clear prior ML progress ───────────────────────────────────────────────
    print("\n[RESET] Clearing existing ML progress...")
    ok, detail = clear_progress(user_id)
    print(f"[RESET] {'✓ cleared' if ok else '~ ' + detail}")

    # Confirm clean slate
    prog = get_progress(token)
    subs = prog.get("completedSubtopics", [])
    print(f"[RESET] After clear: completedSubtopics={len(subs)}  completedTopics={len(prog.get('completedTopics', []))}")

    # ── Session ───────────────────────────────────────────────────────────────
    session_id = f"btech_{uuid.uuid4().hex[:10]}"
    print(f"\n[SESSION] id={session_id}\n")

    # ── Tracking ──────────────────────────────────────────────────────────────
    results = []          # {module, topic, subtopic, turns, quality_scores, issues}
    turn_num = 0
    total_mermaid = 0
    total_errors = 0

    # ─────────────────────────────────────────────────────────────────────────
    for mod in CURRICULUM:
        print(f"\n{sep}")
        print(f"  {mod['module_name']}")
        print(sep)

        mod_stats = {"module": mod["module_name"], "pass": 0, "fail": 0, "errors": 0, "topics": []}

        for topic in mod["topics"]:
            topic_name = topic["name"]
            topic_stats = {
                "topic": topic_name, "subtopics": [],
                "quality_scores": [], "issues": []
            }

            for sub in topic["subtopics"]:
                sub_name = sub["name"]
                turns    = sub["turns"]
                max_turns = 4  # cap per subtopic

                sub_stats = {
                    "subtopic": sub_name, "turns_sent": 0, "quality_scores": [],
                    "final_state": None, "mermaid_seen": False, "errors": []
                }

                for t_idx, student_answer in enumerate(turns[:max_turns]):
                    turn_num += 1
                    sub_stats["turns_sent"] += 1

                    # First turn of first subtopic in the module → use "start" probe
                    if topic == mod["topics"][0] and sub == topic["subtopics"][0] and t_idx == 0:
                        query = f"Let's start {topic_name}"
                    else:
                        query = student_answer

                    t0 = time.time()
                    try:
                        text, pipeline, soc_state, err, mastery, vis_aid, mermaid_in_text = send_message(
                            token, session_id, query, module_id=mod["module_id"]
                        )
                        elapsed = time.time() - t0
                    except Exception as ex:
                        elapsed = time.time() - t0
                        err = str(ex)
                        text, pipeline, soc_state = "", "error", "ERROR"
                        vis_aid, mermaid_in_text, mastery = False, False, None
                        total_errors += 1

                    q = quality_of(text, pipeline, soc_state, err)
                    sub_stats["quality_scores"].append(q["quality_score"])
                    sub_stats["final_state"] = soc_state

                    if q["has_mermaid"] or mermaid_in_text:
                        sub_stats["mermaid_seen"] = True
                        total_mermaid += 1

                    icon = "✓" if q["quality_score"] >= 3 else ("~" if q["quality_score"] >= 2 else "✗")

                    print(f"\n  T{turn_num:03d} [{sub_name}] turn {t_idx+1}/{len(turns[:max_turns])}")
                    print(f"       Q: \"{query[:70]}\"")
                    print(f"       {icon} pipeline={pipeline or '?'}  state={soc_state or '?'}  "
                          f"quality={q['quality_score']}/5  len={q['length']}  {elapsed:.1f}s"
                          + ("  🗺 MERMAID" if q["has_mermaid"] else ""))
                    if err:
                        print(f"       ERROR: {err[:100]}")
                        sub_stats["errors"].append(err)
                        total_errors += 1
                    elif text:
                        # Show first 120 chars of response
                        preview = text.replace("\n", " ")[:120]
                        print(f"       → \"{preview}\"")

                    # Track pass/fail for module
                    if err:
                        mod_stats["errors"] += 1
                    elif q["quality_score"] >= 3:
                        mod_stats["pass"] += 1
                    else:
                        mod_stats["fail"] += 1

                    topic_stats["quality_scores"].append(q["quality_score"])

                    # Check mastery signal — if mastered, no need to send more turns
                    is_mastered = (
                        (mastery and mastery.get("current", 0) >= 3.5) or
                        soc_state in ("MASTERY_ACHIEVED",) or
                        (text and any(w in text.lower() for w in
                           ["mastered", "mastery achieved", "well done", "great job", "moving to"]))
                    )
                    if is_mastered:
                        print(f"       🏆 MASTERY signal detected — moving on")
                        break

                    time.sleep(DELAY_BETWEEN_TURNS)

                if sub_stats["errors"]:
                    topic_stats["issues"].extend(sub_stats["errors"][:1])

                topic_stats["subtopics"].append(sub_stats)
                mod_stats["topics"].append(sub_name)

            results.append(topic_stats)

        # Per-module progress snapshot
        prog = get_progress(token)
        c_subs  = len(prog.get("completedSubtopics", []))
        c_topics = len(prog.get("completedTopics", []))
        c_mods  = len(prog.get("completedModules", []))
        print(f"\n  [PROGRESS after {mod['module_name']}]")
        print(f"   subtopics={c_subs}  topics={c_topics}  modules={c_mods}")

        if mod != CURRICULUM[-1]:
            print(f"  [PAUSE {MODULE_DELAY}s before next module]")
            time.sleep(MODULE_DELAY)

    # ── Cross-Session Persistence Check ───────────────────────────────────────
    print(f"\n{SEP}")
    print("  CROSS-SESSION PERSISTENCE CHECK")
    print(SEP)

    session_id_2 = f"btech_{uuid.uuid4().hex[:10]}"
    print(f"\n[SESSION 2] new id={session_id_2}")

    try:
        token2, _ = signin(EMAIL, PASSWORD)
        prog2 = get_progress(token2)
        c_subs2   = prog2.get("completedSubtopics", [])
        c_topics2 = prog2.get("completedTopics", [])
        c_mods2   = prog2.get("completedModules", [])
        persistence_ok = len(c_subs2) > 0

        print(f"\n[PERSIST] completedSubtopics={len(c_subs2)}  topics={len(c_topics2)}  modules={len(c_mods2)}")
        print(f"[PERSIST] {'✓ PASS' if persistence_ok else '✗ FAIL — nothing saved'}")
        if c_subs2:
            print(f"[PERSIST] Sample: {c_subs2[:5]}")

        # Try resuming
        print(f"\n[SESSION 2] Resume test: 'let's continue from where I left off'")
        t0 = time.time()
        text2, pipe2, state2, err2, _, _, _ = send_message(
            token2, session_id_2, "let's continue from where I left off"
        )
        elapsed2 = time.time() - t0
        q2 = quality_of(text2, pipe2, state2, err2)
        print(f"[RESUME] pipeline={pipe2}  state={state2}  quality={q2['quality_score']}/5  {elapsed2:.1f}s")
        if text2:
            print(f"[RESUME] → \"{text2[:150]}\"")

    except Exception as ex:
        print(f"[PERSIST] FAILED: {ex}")
        persistence_ok = False

    # ── Final Report ──────────────────────────────────────────────────────────
    print(f"\n{SEP}")
    print("  FINAL REPORT")
    print(SEP)

    all_scores = [s for t in results for sub in t["subtopics"] for s in sub["quality_scores"]]
    all_states = [sub.get("final_state") for t in results for sub in t["subtopics"] if sub.get("final_state")]

    total_turns   = len(all_scores)
    total_pass    = sum(1 for s in all_scores if s >= 3)
    total_fail    = sum(1 for s in all_scores if 2 <= s < 3)
    total_low     = sum(1 for s in all_scores if s < 2)
    avg_quality   = sum(all_scores) / max(len(all_scores), 1)

    print(f"\n  Total turns completed : {turn_num}")
    print(f"  Total scored turns    : {total_turns}")
    print(f"  Pass (≥3/5)           : {total_pass}/{total_turns}  ({100*total_pass//max(total_turns,1)}%)")
    print(f"  Fair (2/5)            : {total_fail}/{total_turns}")
    print(f"  Low (<2/5)            : {total_low}/{total_turns}")
    print(f"  Errors                : {total_errors}")
    print(f"  Avg quality score     : {avg_quality:.2f}/5")
    print(f"  Mermaid diagrams seen : {total_mermaid}")

    print(f"\n  Topic quality summary:")
    print(f"  {'Topic':<40}  {'Avg Q':>6}  {'Issues'}")
    print(f"  {'-'*70}")
    for t in results:
        scores = t["quality_scores"]
        avg = sum(scores) / max(len(scores), 1)
        issues = "; ".join(t["issues"][:1]) if t["issues"] else "ok"
        bar = "█" * int(avg) + "░" * (5 - int(avg))
        print(f"  {t['topic']:<40}  {avg:>5.1f}   {bar}  {issues[:40]}")

    if all_states:
        state_counts = Counter(all_states)
        print(f"\n  Socratic state distribution (final per subtopic):")
        for s, c in state_counts.most_common():
            print(f"    {s:<30}: {c}")

    # Check mermaid specifically
    mermaid_topics = []
    for t in results:
        for sub in t["subtopics"]:
            if sub.get("mermaid_seen"):
                mermaid_topics.append(f"{t['topic']} / {sub['subtopic']}")
    if mermaid_topics:
        print(f"\n  Mermaid visual aids appeared in:")
        for mt in mermaid_topics:
            print(f"    • {mt}")
    else:
        print(f"\n  Mermaid: none triggered (need consecutiveWrong ≥ 2 on same subtopic)")

    # Final verdict
    print(f"\n{SEP}")
    verdict = "PASS" if avg_quality >= 3.0 and total_errors == 0 else (
              "FAIR" if avg_quality >= 2.5 else "NEEDS WORK")
    print(f"  Overall: {verdict}")
    print(f"  Avg quality: {avg_quality:.2f}/5 | Turns: {turn_num} | Errors: {total_errors}")
    print(f"  Mermaid diagrams: {total_mermaid}")
    print(f"  Progress persistence: {'✓ VERIFIED' if persistence_ok else '✗ NOT VERIFIED'}")
    print(f"  Completed: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{SEP}\n")


if __name__ == "__main__":
    run_test()
