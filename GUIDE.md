# iMentor Admin & User Guide

> Complete reference for setting up, running, and maintaining the iMentor platform.
> Written for a new admin with no prior knowledge of the architecture.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [First-Time Setup](#2-first-time-setup)
3. [Adding a New Course (Offline Bootstrap)](#3-adding-a-new-course-offline-bootstrap)
4. [Starting the Web App](#4-starting-the-web-app)
5. [What Happens During a Student Session](#5-what-happens-during-a-student-session)
6. [Maintenance: Adding Material to an Existing Course](#6-maintenance-adding-material-to-an-existing-course)
7. [Maintenance: Turning the App Off and On](#7-maintenance-turning-the-app-off-and-on)
8. [Student Progress, XP, and Knowledge Graphs](#8-student-progress-xp-and-knowledge-graphs)
9. [Monitoring and Health Checks](#9-monitoring-and-health-checks)
10. [Port Reference](#10-port-reference)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. System Overview

iMentor is made of several cooperating services:

```
Browser
  └── Frontend  (React/Vite, port 3000)
        └── Node.js API  (Express, port 5001)
              ├── Python RAG Service  (FastAPI, port 2001)
              │     ├── Qdrant     — vector search (course document chunks)
              │     ├── Neo4j      — curriculum graph + concept relationships
              │     └── Redis      — speed cache for teaching notes & sessions
              ├── MongoDB   — user accounts, chat history, XP, gamification
              └── SGLang    — local LLM for all inference (port 8000)
```

**Three kinds of data live in different stores:**

| Store | What it holds |
|---|---|
| MongoDB | Users, chat history, skill-tree progress, XP, badges |
| Neo4j | Curriculum structure (Module → Topic → Subtopic) + teaching_context on each node |
| Qdrant | Raw document chunks (for RAG search) + STN permanent backup |
| Redis | Hot cache: teaching notes (5 ms lookups), session state, routing cache |

---

## 2. First-Time Setup

### 2.1 Prerequisites

```bash
# Required on the host machine
docker          # Docker Engine 24+
docker compose  # Compose v2 (docker compose, not docker-compose)
conda           # Miniconda or Anaconda (for the Python RAG service)
node            # Node.js 20+
npm
```

### 2.2 Clone and configure environment

```bash
cd /home/sri/Downloads/iMentor_march/chatbot

# Copy the example env file and fill it in
cp server/.env.example server/.env
```

Open `server/.env` and set **at minimum**:

```env
JWT_SECRET=<run: openssl rand -hex 32>
ENCRYPTION_SECRET=<run: openssl rand -hex 32>

NEO4J_PASSWORD=your_password          # must match docker-compose.yml NEO4J_AUTH
MONGO_URI=mongodb://localhost:27017/imentor

ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=secure_password
ADMIN_SETUP_KEY=any_random_string

# LLM keys — at least one required for cloud fallback
GEMINI_API_KEY=...                    # optional but recommended
GROQ_API_KEY=...                      # optional
```

For the Python RAG service, also set in `server/rag_service/` (or add to `server/.env` which it reads):

```env
SGLANG_ENABLED=true
SGLANG_HEAVY_URL=http://localhost:8000/v1
SGLANG_HEAVY_MODEL=Qwen/Qwen2.5-7B-Instruct-AWQ

# Only set to true after you have confirmed the key works
GEMINI_API_VALIDATED=false
GEMINI_API_KEY=...
```

### 2.3 Create the Python conda environment

```bash
conda create -n imentor python=3.11 -y
conda activate imentor
pip install -r server/rag_service/requirements.txt
pip install pdfplumber pydantic networkx pyvis openai requests
```

### 2.4 Install Node dependencies

```bash
cd server && npm install && cd ..
cd frontend && npm install && cd ..
```

### 2.5 Start Docker infrastructure (first time)

```bash
docker compose up -d mongo redis neo4j qdrant elasticsearch sglang
```

Wait ~60 seconds for all containers to become healthy:

```bash
docker ps --filter "name=imentor" --format "{{.Names}}: {{.Status}}"
```

All entries should show `healthy` or `Up`.

> **Note:** Ollama has been fully removed from the project. All LLM inference uses SGLang,
> and embeddings use SentenceTransformers (CPU). No Ollama dependency remains.

SGLang downloads the model on first start — this can take 10–20 minutes on a cold cache.

### 2.6 Create Neo4j full-text index (one time)

Open the Neo4j browser at `http://localhost:7474`, log in (`neo4j` / your password), and run:

```cypher
CALL db.index.fulltext.createNodeIndex(
  'node_search_index',
  ['KnowledgeNode'],
  ['nodeId', 'description']
)
```

This enables graph-based search (GraphRAG) during student sessions.

---

## 3. Adding a New Course (Offline Bootstrap)

This is the most important admin task. It runs **once per course** and populates all databases.

### 3.1 Prepare your course folder

Create a folder under `server/course_bootstrap/`:

```
server/course_bootstrap/Machine Learning/
├── syllabus.csv          ← REQUIRED
├── Lecture_01_Intro.pdf  ← optional but improves quality
├── Lecture_02_Regression.pdf
└── ...
```

**`syllabus.csv` format** (four columns):

```csv
Module,Lecture Number,Lecture Topic,Subtopics
Module 1,1,Introduction to ML,"Supervised learning, unsupervised learning, reinforcement learning"
Module 1,2,Linear Regression,"Cost function, gradient descent, normal equation"
Module 2,3,Neural Networks,"Layers, activation functions, forward propagation"
```

Rules:
- `Subtopics` column: comma-separated list, quoted if they contain commas
- Lecture files are matched to syllabus entries by filename number (`Lecture_01_…` → Lecture 1)
- Supported file types: `.pdf`, `.md`, `.txt`, `.rst`
- Without PDFs, the system still works — LLM generates notes from its own knowledge

### 3.2 Start the RAG service (must be running before bootstrap)

```bash
conda activate imentor
cd server/rag_service
uvicorn app:app --host 0.0.0.0 --port 2001 --reload
# Leave this terminal open
```

### 3.3 Run the bootstrap (new terminal)

```bash
cd /home/sri/Downloads/iMentor_march/chatbot
conda activate imentor

python bootstrap_course.py "Machine Learning" \
  --course-dir  "server/course_bootstrap/Machine Learning/" \
  --materials-dir "server/course_bootstrap/Machine Learning/"
```

**What this does, in order:**

| Step | What happens | Where data goes |
|---|---|---|
| 1. Load course files | PDF/md → plain text per lecture | memory only |
| 2. Extract concept graph | SGLang builds Concept + Relationship objects | memory only |
| 3A. Syllabus → Neo4j | Module/Topic/Subtopic nodes created | **Neo4j** |
| 3A. PDFs → Qdrant | Chunks embedded + stored with topic metadata | **Qdrant** |
| 3A. STN invalidation | Stale teaching notes cleared | Redis + disk |
| 3A. STN from KG | concept-aware teaching notes generated (background) | **Redis + disk + Qdrant stn_notes + Neo4j** |
| 3B. Lecture HTML | Per-concept notes + mermaid diagrams rendered | `lectures/` folder |

Expected duration: 5–30 minutes depending on course size and whether SGLang is warm.

### 3.4 Verify the bootstrap worked

```bash
# Check Neo4j has curriculum nodes
curl http://localhost:2001/curriculum/traverse/machine%20learning | python3 -m json.tool | head -40

# Check Qdrant has chunks
curl http://localhost:6333/collections | python3 -m json.tool

# Check STN cache is warm
curl "http://localhost:2001/stn/machine%20learning/gradient_descent"

# Check lecture HTML was generated
ls lectures/Machine\ Learning/
```

### 3.5 Skip flags (for partial re-runs)

```bash
# Re-run only lecture HTML (PDFs already in Qdrant)
python bootstrap_course.py "Machine Learning" \
  --course-dir "server/course_bootstrap/Machine Learning/" \
  --skip-rag

# Re-run only RAG/Neo4j (lecture HTML already generated)
python bootstrap_course.py "Machine Learning" \
  --course-dir "server/course_bootstrap/Machine Learning/" \
  --skip-lecture
```

---

## 4. Starting the Web App

### 4.1 Every-day startup (quickest path)

```bash
cd /home/sri/Downloads/iMentor_march/chatbot
./startup.sh
```

This script:
1. Kills any stale processes on ports 2001, 5001, 3000
2. Starts Docker infrastructure (`docker compose up -d`)
3. Opens three gnome-terminal tabs:
   - **Tab 1** — Python RAG service (port 2001)
   - **Tab 2** — Node.js backend (port 5001, waits for RAG health)
   - **Tab 3** — Vite frontend (port 3000)

### 4.2 Manual startup (if startup.sh unavailable)

**Terminal 1 — Docker + RAG service:**
```bash
docker compose up -d mongo redis neo4j qdrant elasticsearch sglang
sleep 30
conda activate imentor
cd server/rag_service
uvicorn app:app --host 0.0.0.0 --port 2001 --reload
```

**Terminal 2 — Node.js backend (after RAG is up):**
```bash
cd server
npm run dev
```

**Terminal 3 — Frontend:**
```bash
cd frontend
npm run dev
```

### 4.3 Confirm everything is running

```bash
curl http://localhost:2001/health   # RAG: {"status":"ok",...}
curl http://localhost:5001/health   # Node: {"status":"ok",...}
curl http://localhost:3000          # Frontend: HTML page
```

Open browser: **http://localhost:3000**

Default login: `ultra.boy7@gmail.com` / `123456`

---

## 5. What Happens During a Student Session

Understanding this helps you debug and tune:

```
Student sends message
  │
  ├─ Node.js classifies intent (tutor / chat / research)
  │
  ├─ TUTOR MODE:
  │    ├─ Neo4j  → "what topic is student on? what's next? prerequisites?"
  │    ├─ Redis  → fast STN lookup (~5 ms)
  │    │    └─ MISS → Qdrant stn_notes (~50 ms)
  │    │         └─ MISS → live Qdrant search (~300 ms)
  │    ├─ Socratic state machine → L1→L2→L3→L4 cognitive levels
  │    └─ LLM (SGLang/Gemini/Groq) → streamed Socratic response
  │
  ├─ RAG CHAT MODE:
  │    ├─ Qdrant semantic search → top-k document chunks
  │    ├─ (optional) Neo4j GraphRAG → related concept facts
  │    └─ LLM → streamed answer with citations
  │
  └─ After session:
       ├─ knowledgeStateService → updates concept mastery scores (MongoDB)
       ├─ XP awarded based on answer quality (MongoDB GamificationProfile)
       └─ Tutor session state saved to Redis (1-hour TTL)
```

---

## 6. Maintenance: Adding Material to an Existing Course

### When you add new PDFs or update existing ones:

1. Place new files in `server/course_bootstrap/<CourseName>/`

2. Re-run the RAG pipeline (Qdrant re-ingest + STN refresh):

```bash
# RAG service must be running first
python bootstrap_course.py "Machine Learning" \
  --course-dir "server/course_bootstrap/Machine Learning/" \
  --materials-dir "server/course_bootstrap/Machine Learning/" \
  --skip-lecture
```

This automatically:
- Re-ingests new chunks to Qdrant
- Calls `invalidate_course_stn()` — clears stale Redis + disk teaching notes
- Triggers re-generation of STN from the new KG (background thread)

3. Optionally regenerate lecture HTML if content changed significantly:

```bash
python bootstrap_course.py "Machine Learning" \
  --course-dir "server/course_bootstrap/Machine Learning/" \
  --skip-rag
```

### When you add a new course:

Follow Section 3 from scratch. Each course is fully independent.

### Force-regenerate STN for a course (e.g. after LLM upgrade):

```bash
# Call the RAG service directly
curl -X POST http://localhost:2001/course/stn_from_kg \
  -H "Content-Type: application/json" \
  -d '{"course_name": "Machine Learning", "concepts": [], "force": true}'
```

Or re-run bootstrap with `--skip-lecture` — the `invalidate_course_stn` call clears the cache so everything regenerates.

---

## 7. Maintenance: Turning the App Off and On

### Clean shutdown:

```bash
# Kill app processes (RAG, Node, Vite)
lsof -ti:2001 | xargs kill -9 2>/dev/null || true
lsof -ti:5001 | xargs kill -9 2>/dev/null || true
lsof -ti:3000 | xargs kill -9 2>/dev/null || true
pkill -f "uvicorn" 2>/dev/null || true
pkill -f "nodemon" 2>/dev/null || true

# Stop Docker (keeps all data)
docker compose stop

# OR: stop + remove containers but KEEP volumes (data survives)
docker compose down
```

> **Never run `docker compose down -v`** — this deletes all volumes (MongoDB, Neo4j, Qdrant, Redis data).

### Restart after shutdown:

```bash
./startup.sh
```

Redis cache will be cold after a Docker restart. The first few student queries will be slower (~300 ms instead of ~5 ms) while STN notes are re-warmed from the disk backup and re-loaded to Redis. This is automatic — no manual action needed.

### After a Redis flush (data loss):

STN notes survive in two places:
1. **Disk backup**: `server/Cpurses/_stn_backup/<course>/`
2. **Qdrant `stn_notes` collection** (permanent)

Both are read automatically on the next cache miss — Redis re-warms itself.

---

## 8. Student Progress, XP, and Knowledge Graphs

### How XP works

XP is awarded via `ConceptContribution` when a student submits an answer that gets AI-evaluated:

```
AI evaluates answer → overallScore (0–100)
XP = floor(overallScore / 10) + creativityBonus
Cap: 15 XP per contribution
```

Level formula: `Level = floor(sqrt(totalXP / 10)) + 1`

The tutor's Socratic state machine also tracks cognitive levels per subtopic:
- **L1** — recall/definition
- **L2** — application/examples
- **L3** — critical thinking/edge cases
- **L4** — design/evaluation

Mastery threshold: cumulative score ≥ 4.0 within a subtopic → marked mastered → advance to next subtopic.

### Viewing a student's knowledge state

```bash
# Via API (authenticated)
curl -H "Authorization: Bearer <token>" \
  http://localhost:5001/api/chat/knowledge-state

# Export full knowledge state (student privacy endpoint)
curl -H "Authorization: Bearer <token>" \
  http://localhost:5001/api/chat/knowledge-state/export
```

In MongoDB (`imentor` database, `gamificationprofiles` collection):
```js
db.gamificationprofiles.findOne({ userId: ObjectId("...") })
// Fields: totalXP, level, badges, skillTreeProgress, masteryPercentages
```

### Knowledge graph per student (GraphRAG)

When a student uploads a personal document, `graph_rag.extract_and_store_graph` runs:
1. LLM extracts entities + relationships from the document
2. `KnowledgeNode` and `RELATED_TO` edges stored in Neo4j tagged with `userId`
3. During that student's RAG queries, their personal graph is searched alongside course chunks

To view a student's graph in Neo4j browser (`http://localhost:7474`):
```cypher
MATCH (n:KnowledgeNode {userId: "student_user_id"})
OPTIONAL MATCH (n)-[r:RELATED_TO]-(m)
RETURN n, r, m LIMIT 100
```

### Mind maps

Mind maps are stored per document in MongoDB (`user.uploadedDocuments[].analysis.mindmap`) as Mermaid code. The frontend renders them via `GET /api/mindmap`. They are generated during document upload processing — no manual step needed.

---

## 9. Monitoring and Health Checks

### Quick status check

```bash
# All services at once
echo "=== RAG ===" && curl -s http://localhost:2001/health
echo "=== Node ===" && curl -s http://localhost:5001/health
echo "=== Qdrant ===" && curl -s http://localhost:6333/readyz
echo "=== Neo4j ===" && curl -s http://localhost:7474/
echo "=== Redis ===" && docker exec imentor-redis redis-cli ping
echo "=== SGLang ===" && curl -s http://localhost:8000/health
```

### Prometheus + Grafana (optional)

If you started the monitoring containers:
```bash
docker compose up -d prometheus grafana
```

- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3001` (default login: admin / admin)

### STN cache hit rate

```bash
# How many STN keys are in Redis right now
docker exec imentor-redis redis-cli --scan --pattern "im_cache:subtopic_notes:*" | wc -l
```

### SGLang model status

```bash
curl http://localhost:8000/v1/models | python3 -m json.tool
```

---

## 10. Port Reference

| Port | Service | Notes |
|---|---|---|
| 3000 | Frontend (Vite) | Student/admin web UI |
| 5001 | Node.js backend | Main API |
| 2001 | Python RAG service | Course ingestion, STN, GraphRAG |
| 8000 | SGLang LLM | All LLM inference (STN, lectures, KG, chat) |
| 27017 | MongoDB | Users, chat, XP |
| 6379 | Redis | Speed cache |
| 7687 | Neo4j (Bolt) | Curriculum + concept graph |
| 7474 | Neo4j (Browser) | Admin UI for graph inspection |
| 6333 | Qdrant | Vector search UI + API |
| 9200 | Elasticsearch | Full-text search |
| 9090 | Prometheus | Metrics (optional) |
| 3001 | Grafana | Dashboards (optional) |

---

## 11. Troubleshooting

### RAG service fails to start

```bash
# Check conda env is active
conda activate imentor
python -c "import uvicorn, fastapi, qdrant_client, neo4j; print('OK')"

# Check .env is present
ls server/.env
```

### STN notes not generating

```bash
# Is SGLang running?
curl http://localhost:8000/health

# Check RAG service logs for "No LLM available"
# If SGLang is down and GEMINI_API_VALIDATED=false, generation silently fails.
# Fix: either start SGLang or set GEMINI_API_VALIDATED=true in server/.env
```

### Tutor giving generic answers (no course context)

The STN cache is cold and live Qdrant search is also empty. Steps:
1. Confirm the course was bootstrapped: `curl http://localhost:2001/curriculum/traverse/<course_name>`
2. Re-run the bootstrap with `--skip-lecture`
3. Wait for STN background thread to finish (check RAG service logs for `STN DONE`)

### Neo4j connection refused

```bash
docker ps | grep neo4j           # Is container running?
docker logs imentor-neo4j | tail -20
# Common fix: wait longer — Neo4j takes 30–60 s to become ready
```

### "No relevant graph connections found" in GraphRAG

The full-text index is missing. Run the Cypher in Section 2.6.

### Frontend shows blank page

```bash
# Is Vite running?
curl http://localhost:3000
# Is Node backend up?
curl http://localhost:5001/health
# Check CORS — FRONTEND_URL in server/.env must match the browser URL
```

### Redis data lost after restart

This is expected if `docker compose down -v` was run.
Re-run bootstrap for each course to repopulate STN notes. Qdrant and disk backups are not affected by Redis loss.

---

*Generated 2026-03-28. Update this file when architecture changes.*
 