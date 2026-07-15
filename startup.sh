#!/bin/bash
# iMentor Startup Script — Development Mode
# 1. Kill processes on all relevant ports
# 2. Restart Docker infrastructure and wait for healthy
# 3. Launch RAG (Python) + Node.js + Frontend in gnome-terminal tabs

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONDA_ENV="imentor"
cd "$PROJECT_DIR"

# ─── Port configuration (must match server/.env & docker-compose.yml) ────────
# App service ports
RAG_PORT=2005
NODE_PORT=5005
FRONTEND_PORT=3005

# Docker host-mapped ports (shifted to avoid collisions)
MONGO_PORT=27018
REDIS_PORT=6380
NEO4J_BOLT_PORT=7688
NEO4J_HTTP_PORT=7475
QDRANT_HTTP_PORT=6335
QDRANT_GRPC_PORT=6336
ELASTIC_PORT=9201
SGLANG_PORT=8000

ALL_PORTS="$RAG_PORT $NODE_PORT $FRONTEND_PORT $MONGO_PORT $REDIS_PORT $NEO4J_BOLT_PORT $NEO4J_HTTP_PORT $QDRANT_HTTP_PORT $QDRANT_GRPC_PORT $ELASTIC_PORT $SGLANG_PORT"

# ══════════════════════════════════════════════════════════════════════════════
# 1. CLEANUP — kill processes on all ports + known process names
# ══════════════════════════════════════════════════════════════════════════════
echo "🧹 Cleaning up existing processes..."

# Kill by process name
pkill -f "nodemon" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true
pkill -f "uvicorn" 2>/dev/null || true
pkill -f "python app.py" 2>/dev/null || true

# Kill anything on our ports
for port in $ALL_PORTS; do
    lsof -ti:$port 2>/dev/null | xargs kill -9 2>/dev/null || true
done

sleep 1
echo "✅ Cleanup complete."

# Reload Caddy config immediately (zero-downtime — no terminal needed yet)
if systemctl is-active --quiet caddy 2>/dev/null; then
    systemctl reload caddy 2>/dev/null || true
fi
echo ""

# ══════════════════════════════════════════════════════════════════════════════
# 2. DOCKER — stop stale containers, start fresh, wait for health
# ══════════════════════════════════════════════════════════════════════════════
echo "🐳 Restarting Docker infrastructure..."

# Stop any existing containers (including orphans from removed services)
docker compose down --remove-orphans 2>/dev/null || true

# Start infrastructure + SGLang LLM server
docker compose up -d mongo redis neo4j qdrant elasticsearch sglang

echo "⏳ Waiting for Docker services to become healthy..."

# Function: wait for a specific container to be healthy
wait_healthy() {
    local container="$1"
    local timeout="${2:-90}"
    local elapsed=0
    while [ $elapsed -lt $timeout ]; do
        local status
        status=$(docker inspect --format='{{.State.Health.Status}}' "$container" 2>/dev/null || echo "missing")
        if [ "$status" = "healthy" ]; then
            echo "  ✅ $container is healthy"
            return 0
        fi
        sleep 3
        elapsed=$((elapsed + 3))
    done
    echo "  ⚠️  $container not healthy after ${timeout}s (status: $status) — continuing anyway"
    return 0
}

# Wait for each service
wait_healthy "chatbot-mongo"    60
wait_healthy "chatbot-redis"    30
wait_healthy "chatbot-neo4j"    90
wait_healthy "chatbot-qdrant"   60
wait_healthy "chatbot-elastic"  90

echo ""
echo "🤖 Waiting for SGLang LLM server (model download on first run may take a few minutes)..."
wait_healthy "chatbot-sglang"  300

# ── Validate Neo4j database name (Community Edition only supports 'neo4j') ──
NEO4J_DB=$(grep -E '^NEO4J_DATABASE=' "$PROJECT_DIR/server/.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')
if [ -n "$NEO4J_DB" ] && [ "$NEO4J_DB" != "neo4j" ]; then
    echo "  ⚠️  NEO4J_DATABASE=$NEO4J_DB in server/.env — Neo4j Community Edition only supports 'neo4j'"
    echo "  🔧 Auto-fixing: setting NEO4J_DATABASE=neo4j in server/.env"
    sed -i "s/^NEO4J_DATABASE=.*/NEO4J_DATABASE=neo4j/" "$PROJECT_DIR/server/.env"
fi

echo ""
echo "🔍 Docker container status:"
docker ps --filter "name=chatbot-" --format "  {{.Names}}: {{.Status}}"
echo ""

# ══════════════════════════════════════════════════════════════════════════════
# 3. LAUNCH SERVICE TERMINALS
# ══════════════════════════════════════════════════════════════════════════════
echo "🚀 Launching service terminals..."

# Detect conda init script location
CONDA_SH="$HOME/anaconda3/etc/profile.d/conda.sh"
if [ ! -f "$CONDA_SH" ]; then
    CONDA_SH="$HOME/miniconda3/etc/profile.d/conda.sh"
fi
if [ ! -f "$CONDA_SH" ]; then
    CONDA_SH="/opt/conda/etc/profile.d/conda.sh"
fi

gnome-terminal --window \
  --tab --title="🐍 RAG Service (Python)" --working-directory="$PROJECT_DIR" --command="bash -c '
    echo \"================================================\"
    echo \"  Tab 1: Python RAG Service (port $RAG_PORT)\"
    echo \"================================================\"
    echo \"\"
    # Initialize conda
    if [ -f \"$CONDA_SH\" ]; then
        source \"$CONDA_SH\"
        conda activate $CONDA_ENV
        echo \"✅ conda env: $CONDA_ENV\"
    else
        echo \"⚠️  conda not found — using system Python\"
    fi
    echo \"\"
    echo \"Starting RAG service on port $RAG_PORT...\"
    cd \"$PROJECT_DIR/server/rag_service\"
    uvicorn app:app --host 0.0.0.0 --port $RAG_PORT --reload
    exec bash
  '" \
  --tab --title="🟢 Node.js Server" --working-directory="$PROJECT_DIR" --command="bash -c '
    echo \"================================================\"
    echo \"  Tab 2: Node.js Backend (port $NODE_PORT)\"
    echo \"================================================\"
    echo \"\"
    echo \"Waiting for RAG service to start...\"
    for i in 1 2 3 4 5 6 7 8 9 10; do
        if curl -sf http://localhost:$RAG_PORT/health > /dev/null 2>&1; then
            echo \"✅ RAG service is up\"
            break
        fi
        echo \"  Waiting for RAG... (\$i/10)\"
        sleep 3
    done
    echo \"\"
    echo \"Starting Node.js server...\"
    cd \"$PROJECT_DIR/server\"
    npm run dev
    exec bash
  '" \
  --tab --title="⚛️  Frontend (Vite)" --working-directory="$PROJECT_DIR" --command="bash -c '
    echo \"================================================\"
    echo \"  Tab 3: Frontend (port $FRONTEND_PORT)\"
    echo \"================================================\"
    echo \"\"
    echo \"Waiting 8s for backend to start...\"
    sleep 8
    echo \"\"
    echo \"Starting Vite dev server...\"
    cd \"$PROJECT_DIR/frontend\"
    npm run dev
    exec bash
  '" \
  --tab --title="🛡️  Caddy + CrowdSec" --working-directory="$PROJECT_DIR" --command="bash -c '
    echo \"================================================\"
    echo \"  Tab 4: Caddy Proxy + CrowdSec Security\"
    echo \"================================================\"
    echo \"\"

    # ── Restart Caddy ──────────────────────────────────────
    echo \"♻  Reloading Caddy config...\"
    if systemctl is-active --quiet caddy 2>/dev/null; then
        sudo systemctl reload caddy && echo \"✅ Caddy reloaded (zero-downtime).\"
    else
        sudo systemctl start caddy && echo \"✅ Caddy started.\"
    fi

    # ── Restart CrowdSec ────────────────────────────────────
    echo \"\"
    echo \"♻  Restarting CrowdSec...\"
    sudo systemctl restart crowdsec && echo \"✅ CrowdSec engine running.\"
    sudo systemctl restart crowdsec-firewall-bouncer && echo \"✅ Firewall bouncer running.\"

    echo \"\"
    echo \"── Caddy status ──────────────────────────────────\"
    systemctl status caddy --no-pager -l | head -8

    echo \"\"
    echo \"── Active CrowdSec bans ──────────────────────────\"
    sudo cscli decisions list 2>/dev/null | head -20 || echo \"  (none yet)\"

    echo \"\"
    echo \"── Live Caddy access log (Ctrl+C to stop) ────────\"
    sleep 2
    sudo tail -f /var/log/caddy/imentor_access.log 2>/dev/null || journalctl -u caddy -f
    exec bash
  '"

echo ""
echo "✨ Terminals launched!"
echo ""
echo "🌐 Access iMentor at (via Caddy HTTPS):"
echo "   https://$(hostname -I | awk '{print $1}')"
echo "   https://localhost"
echo ""
echo "⚙️  Internal service ports (do NOT open these directly):"
echo "   Vite dev:  http://localhost:$FRONTEND_PORT  (proxied through Caddy)"
echo "   Backend:   http://localhost:$NODE_PORT       (proxied through Caddy)"
echo "   RAG API:   http://localhost:$RAG_PORT        (proxied through Caddy)"
echo "   SGLang:    http://localhost:$SGLANG_PORT/v1"
echo ""
echo "📦 Docker services:"
echo "   MongoDB:        localhost:$MONGO_PORT"
echo "   Redis:          localhost:$REDIS_PORT"
echo "   Neo4j Bolt:     localhost:$NEO4J_BOLT_PORT"
echo "   Neo4j HTTP:     localhost:$NEO4J_HTTP_PORT"
echo "   Qdrant:         localhost:$QDRANT_HTTP_PORT"
echo "   Elasticsearch:  localhost:$ELASTIC_PORT"
echo "   SGLang LLM:     localhost:$SGLANG_PORT"
echo ""
echo "🔑 Login: ultra.boy7@gmail.com / 123456"
echo ""
echo "🛡️  Security:"
echo "   Reverse proxy:  Caddy 2.x  (auto-TLS, security headers)"
echo "   Threat engine:  CrowdSec   (active bans: \$(sudo cscli decisions list 2>/dev/null | grep -c 'ban' || echo 0))"
echo "   Firewall:       UFW + iptables bouncer (ports 22/80/443/2000 only)"
echo "   Databases:      All bound to 127.0.0.1 — NOT internet-accessible"
echo ""
