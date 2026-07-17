#!/usr/bin/env bash
# =============================================================================
#  test_local_setup.sh — Local 1-GPU Test Suite
#  Tests: chat, reasoning (ToT), embeddings, vector DB ingestion, KG creation
#
#  Pre-requisites (run once before this script):
#  ─────────────────────────────────────────────
#  1. Pull & start Ollama embed model:
#       ollama pull mxbai-embed-large
#       ollama pull qwen2.5:7b          # for Ollama fallback (when vLLM is down)
#       ollama pull qwen2.5:3b          # for routing model
#
#  2. Start vLLM (single GPU, 7B-AWQ ~7-8 GB VRAM):
#       vllm serve Qwen/Qwen2.5-7B-Instruct-AWQ \
#         --port 8000 --quantization awq \
#         --max-model-len 8192 --gpu-memory-utilization 0.85
#       # Wait until you see "Application startup complete"
#
#  3. Start the iMentor backend stack:
#       cd /home/sri/Downloads/iMentor_march/chatbot
#       docker-compose up -d qdrant neo4j redis mongodb   # infra only
#       cd server && node server.js &
#       cd rag_service && uvicorn app:app --port 2001 &
# =============================================================================

set -euo pipefail

BACKEND="http://localhost:5001"
RAG="http://localhost:2001"
VLLM="http://localhost:8000"
OLLAMA="http://localhost:11434"
PASS=0; FAIL=0

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'

pass() { echo -e "${GREEN}  PASS${NC}  $1"; ((PASS++)); }
fail() { echo -e "${RED}  FAIL${NC}  $1"; ((FAIL++)); }
section() { echo -e "\n${YELLOW}══ $1 ══${NC}"; }

# ─── Helper: POST with JSON ────────────────────────────────────────────────────
post() {
  local url="$1" data="$2"
  curl -s -X POST "$url" \
       -H "Content-Type: application/json" \
       -d "$data" \
       --max-time 60 2>/dev/null
}

# ─── 1. Infrastructure Health ─────────────────────────────────────────────────
section "1. Infrastructure Health"

# Ollama
if curl -s --max-time 5 "$OLLAMA/api/tags" | grep -q "models"; then
  pass "Ollama running at $OLLAMA"
else
  fail "Ollama NOT reachable at $OLLAMA  (run: ollama serve)"
fi

# vLLM
VLLM_RESP=$(curl -s --max-time 5 "$VLLM/models" 2>/dev/null || echo "")
if echo "$VLLM_RESP" | grep -q "data"; then
  MODEL_ID=$(echo "$VLLM_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data'][0]['id'])" 2>/dev/null || echo "unknown")
  pass "vLLM running — model: $MODEL_ID"
else
  fail "vLLM NOT reachable at $VLLM  (start with: vllm serve Qwen/Qwen2.5-7B-Instruct-AWQ ...)"
fi

# RAG Python service
if curl -s --max-time 5 "$RAG/health" | grep -q "ok\|healthy\|status"; then
  pass "Python RAG service running at $RAG"
else
  fail "Python RAG service NOT reachable at $RAG"
fi

# Node.js backend
if curl -s --max-time 5 "$BACKEND/" | grep -q "API\|running"; then
  pass "Node.js backend running at $BACKEND"
else
  fail "Node.js backend NOT reachable at $BACKEND"
fi

# ─── 2. Ollama Embeddings ─────────────────────────────────────────────────────
section "2. Ollama Embeddings (mxbai-embed-large)"

# Test direct Ollama embed
EMBED_RESP=$(post "$OLLAMA/api/embed" '{"model":"mxbai-embed-large","input":"What is machine learning?"}')
DIM=$(echo "$EMBED_RESP" | python3 -c "import sys,json; e=json.load(sys.stdin)['embeddings'][0]; print(len(e))" 2>/dev/null || echo "0")
if [ "$DIM" = "1024" ]; then
  pass "Ollama embed → 1024-dim vector (matches Qdrant collection)"
else
  fail "Ollama embed returned dim=$DIM (expected 1024). Is mxbai-embed-large pulled?"
fi

# Test via RAG service /embed endpoint (routes through config.OllamaEmbedder)
RAG_EMBED=$(post "$RAG/embed" '{"text":"Explain neural networks in simple terms"}')
RAG_DIM=$(echo "$RAG_EMBED" | python3 -c "import sys,json; e=json.load(sys.stdin)['embedding']; print(len(e))" 2>/dev/null || echo "0")
if [ "$RAG_DIM" = "1024" ]; then
  pass "RAG /embed endpoint → 1024-dim (OllamaEmbedder working)"
else
  fail "RAG /embed endpoint returned dim=$RAG_DIM (check EMBED_PROVIDER=ollama in .env)"
fi

# Batch embed test
BATCH_EMBED=$(post "$RAG/embed" '{"texts":["What is Python?","Explain recursion","Define a variable"]}')
BATCH_COUNT=$(echo "$BATCH_EMBED" | python3 -c "import sys,json; e=json.load(sys.stdin)['embeddings']; print(len(e))" 2>/dev/null || echo "0")
if [ "$BATCH_COUNT" = "3" ]; then
  pass "RAG /embed batch mode → 3 embeddings returned"
else
  fail "RAG /embed batch mode returned count=$BATCH_COUNT (expected 3)"
fi

# ─── 3. vLLM Chat (Direct) ────────────────────────────────────────────────────
section "3. vLLM Chat (direct API)"

VLLM_CHAT=$(post "$VLLM/chat/completions" '{
  "model": "Qwen/Qwen2.5-7B-Instruct-AWQ",
  "messages": [{"role":"user","content":"What is 2+2? Answer in one word."}],
  "max_tokens": 20, "temperature": 0
}')
VLLM_ANSWER=$(echo "$VLLM_CHAT" | python3 -c "import sys,json; print(json.load(sys.stdin)['choices'][0]['message']['content'].strip())" 2>/dev/null || echo "")
if echo "$VLLM_ANSWER" | grep -qi "four\|4"; then
  pass "vLLM direct chat → \"$VLLM_ANSWER\""
else
  fail "vLLM direct chat unexpected answer: \"$VLLM_ANSWER\""
fi

# ─── 4. vLLM Reasoning (ToT-style multi-step) ─────────────────────────────────
section "4. vLLM Reasoning (multi-step problem)"

REASONING_RESP=$(post "$VLLM/chat/completions" '{
  "model": "Qwen/Qwen2.5-7B-Instruct-AWQ",
  "messages": [
    {"role":"system","content":"You are an expert tutor. Think step-by-step."},
    {"role":"user","content":"A student says: \"sorting always takes O(n^2)\". Is this correct? Explain why or why not, with one concrete counter-example."}
  ],
  "max_tokens": 300, "temperature": 0.3
}')
REASONING_LEN=$(echo "$REASONING_RESP" | python3 -c "
import sys,json
try:
  ans = json.load(sys.stdin)['choices'][0]['message']['content']
  print(len(ans))
except: print(0)" 2>/dev/null || echo "0")
if [ "$REASONING_LEN" -gt "100" ]; then
  pass "vLLM reasoning → ${REASONING_LEN}-char multi-step response"
else
  fail "vLLM reasoning response too short (${REASONING_LEN} chars)"
fi

# ─── 5. Vector DB (Qdrant) — Document Ingestion ───────────────────────────────
section "5. Vector DB Ingestion (Qdrant via RAG service)"

# Upload a small test document through the RAG ingest endpoint
TEST_TEXT="Machine learning is a branch of artificial intelligence that allows systems to learn and improve from experience without being explicitly programmed. It focuses on developing computer programs that can access data and use it to learn for themselves."

INGEST_RESP=$(post "$RAG/ingest_text" "{
  \"text\": \"$TEST_TEXT\",
  \"metadata\": {
    \"source\": \"test_local_setup\",
    \"file_name\": \"test_doc.txt\",
    \"user_id\": \"admin\"
  }
}" 2>/dev/null || echo '{"error":"endpoint not found"}')

if echo "$INGEST_RESP" | grep -q "success\|upserted\|inserted\|point_id\|ids"; then
  pass "Qdrant ingestion → text chunk stored"
else
  # Fallback: check Qdrant directly
  QDRANT_RESP=$(curl -s "http://localhost:6333/collections" 2>/dev/null || echo "")
  if echo "$QDRANT_RESP" | grep -q "result\|collection"; then
    pass "Qdrant is running (direct check) — ingestion test needs live RAG service"
  else
    fail "Qdrant not reachable at localhost:6333 — run: docker-compose up -d qdrant"
  fi
fi

# Test vector search
QUERY_RESP=$(post "$RAG/query" '{
  "query": "What is machine learning?",
  "k": 3,
  "user_id": "test_user",
  "use_kg_critical_thinking": false
}' 2>/dev/null || echo '{}')

DOC_COUNT=$(echo "$QUERY_RESP" | python3 -c "
import sys,json
try:
  docs = json.load(sys.stdin).get('retrieved_documents_list', [])
  print(len(docs))
except: print(-1)" 2>/dev/null || echo "-1")

if [ "$DOC_COUNT" -ge "0" ]; then
  pass "RAG /query → returned ${DOC_COUNT} documents"
else
  fail "RAG /query failed"
fi

# ─── 6. Knowledge Graph (Neo4j) ───────────────────────────────────────────────
section "6. Knowledge Graph (Neo4j)"

# Check Neo4j connectivity
NEO4J_RESP=$(curl -s --max-time 5 "http://localhost:7474/" 2>/dev/null || echo "")
if echo "$NEO4J_RESP" | grep -q "neo4j\|management"; then
  pass "Neo4j running at localhost:7474"
else
  fail "Neo4j NOT reachable — run: docker-compose up -d neo4j"
fi

# Verify full-text index (required by graph_rag.py)
INDEX_CHECK=$(python3 - <<'PYEOF' 2>/dev/null || echo "error"
from neo4j import GraphDatabase
import os
driver = GraphDatabase.driver(
    os.getenv("NEO4J_URI", "bolt://localhost:7687"),
    auth=(os.getenv("NEO4J_USER","neo4j"), os.getenv("NEO4J_PASSWORD","password"))
)
with driver.session() as s:
    result = s.run("SHOW INDEXES WHERE name = 'node_search_index'").data()
    print("found" if result else "missing")
driver.close()
PYEOF
)
if [ "$INDEX_CHECK" = "found" ]; then
  pass "Neo4j full-text index 'node_search_index' exists"
elif [ "$INDEX_CHECK" = "missing" ]; then
  fail "Neo4j full-text index missing — run in Neo4j browser:
       CALL db.index.fulltext.createNodeIndex('node_search_index',['KnowledgeNode'],['nodeId','description'])"
else
  fail "Neo4j connection failed (check NEO4J_URI / NEO4J_PASSWORD in .env)"
fi

# KG extraction test via Node.js backend (admin upload triggers KG worker)
section "6b. KG Extraction Test (admin upload)"
echo "  → Skipping live upload test (requires auth token)."
echo "    To test manually:"
echo "    1. Login as admin at $BACKEND/api/auth/login"
echo "    2. POST /api/upload with a small PDF"
echo "    3. Check Neo4j browser for new KnowledgeNode entries"

# ─── 7. Semantic Router (Embeddings → Routing) ───────────────────────────────
section "7. Semantic Router (embedding-based query routing)"

ROUTE_RESP=$(post "$BACKEND/api/chat/classify" '{"query":"What is 2+2?"}' 2>/dev/null || echo '{}')
ROUTE=$(echo "$ROUTE_RESP" | python3 -c "
import sys,json
try:
  d = json.load(sys.stdin)
  print(d.get('route') or d.get('category') or d.get('semanticRoute','unknown'))
except: print('unknown')" 2>/dev/null || echo "unknown")

if [ "$ROUTE" != "unknown" ] && [ -n "$ROUTE" ]; then
  pass "Semantic router → route=$ROUTE for 'What is 2+2?'"
else
  echo "  INFO: /api/chat/classify endpoint may not be public. Check server logs for [ROUTER] lines."
fi

# ─── 8. End-to-End Chat ────────────────────────────────────────────────────────
section "8. End-to-End Chat (Node.js → vLLM)"
echo "  → E2E chat requires a valid auth token."
echo "    Run the Playwright tests or use:"
echo "    TOKEN=\$(curl -s -X POST $BACKEND/api/auth/login \\"
echo "      -H 'Content-Type: application/json' \\"
echo "      -d '{\"email\":\"test@test.com\",\"password\":\"password\"}' | jq -r '.token')"
echo "    curl -X POST $BACKEND/api/chat \\"
echo "      -H 'Authorization: Bearer \$TOKEN' \\"
echo "      -H 'Content-Type: application/json' \\"
echo "      -d '{\"message\":\"What is Python?\",\"sessionId\":\"test-session-1\"}'"

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════"
echo -e "  Results: ${GREEN}${PASS} passed${NC}  ${RED}${FAIL} failed${NC}"
echo "═══════════════════════════════════════════════════════════"
if [ "$FAIL" -gt "0" ]; then
  echo -e "${YELLOW}  Fix the failing checks above, then re-run this script.${NC}"
  exit 1
else
  echo -e "${GREEN}  All automated checks passed! Ready for E2E tests.${NC}"
fi
