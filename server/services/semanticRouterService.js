/**
 * server/services/semanticRouterService.js
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║              SEMANTIC ROUTER — Embedding-Based Query Routing             ║
 * ║                                                                           ║
 * ║  IMPORTANT: This is TABLE-BASED ROUTING using cosine similarity          ║
 * ║  NOT LLM-based routing. The qwen2.5:3b is ONLY a fallback when           ║
 * ║  table confidence is too low (<0.65).                                     ║
 * ║                                                                           ║
 * ║  Ollama's ONLY roles:                                                     ║
 * ║  1. mxbai-embed-large → embeddings for semantic similarity               ║
 * ║  2. qwen2.5:3b → fallback router when table fails (rare)                 ║
 * ║  Ollama is NEVER used for chat - all chat uses SGLang!                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Strategy:
 *   1. At startup, load pre-embedded route prototypes from routing_prototypes.json.
 *      If embeddings are empty (first run), call POST /embed to the Python RAG service
 *      to batch-embed all prototypes and persist them back to the JSON file.
 *
 *   2. At query time (getSemanticRoute):
 *      a. Compute query embedding via POST /embed (~5-10ms) using mxbai-embed-large
 *      b. Cosine similarity against all loaded prototypes (~1ms, pure JS)
 *      c. Average the top-N scores per route → pick winner
 *      d. Return { route, confidence, method: 'semantic' }
 *      e. Cache result in Redis (5min TTL)
 *
 *   3. Fallback: if Python service is unreachable or embedding fails,
 *      return { route: null, confidence: 0, method: 'semantic_unavailable' }
 *      so the caller falls through to keyword classification or LLM router.
 *
 * Cost: ~5-10ms per query (embedding call). The query embedding is the SAME
 * vector used by Qdrant for RAG — if we share it, the cost is ~0ms extra.
 * For now we keep it separate for simplicity; sharing is a Phase 1B optimization.
 *
 * Embedding Model: mxbai-embed-large (1024-dim) via Ollama (CPU-efficient)
 */

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const axios   = require('axios');
const log     = require('../utils/logger');
const { redisClient } = require('../config/redisClient');
const { ROUTING_THRESHOLDS } = require('../config/routingConfig');
const { routerCacheCounter } = require('../utils/metrics');

const PROTOTYPES_PATH = path.join(__dirname, '../data/routing_prototypes.json');
const EMBED_URL       = () => `${(process.env.PYTHON_RAG_SERVICE_URL || 'http://localhost:2001').trim()}/embed`;
const EMBED_TIMEOUT   = ROUTING_THRESHOLDS.EMBED_REQUEST_TIMEOUT_MS || 5000;
const CACHE_TTL       = ROUTING_THRESHOLDS.EMBEDDING_CACHE_TTL      || 600;  // 10min

// ── In-memory prototype store ─────────────────────────────────────────────────
// Populated at startup. Shape: Array<{ route: string, text: string, embedding: number[] }>
let _prototypes = [];
let _ready      = false;
let _initPromise = null;

// ── Prototype file hash (Issue 4.2) — included in Redis cache key so that ────
// stale routing decisions are automatically invalidated when prototypes change.
let _protoHash = 'nohash';
function _computeProtoHash() {
    try {
        const raw = fs.readFileSync(PROTOTYPES_PATH);
        return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8);
    } catch {
        return 'nohash';
    }
}

// ── Cosine similarity (pure JS, no dependencies) ──────────────────────────────
function cosineSimilarity(a, b) {
    if (a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot   += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

// ── Load + (if needed) embed prototypes at startup ────────────────────────────
async function _initPrototypes() {
    try {
        const raw = JSON.parse(fs.readFileSync(PROTOTYPES_PATH, 'utf8'));
        const allHaveEmbeddings = raw.prototypes.every(p => Array.isArray(p.embedding) && p.embedding.length > 0);

        if (allHaveEmbeddings) {
            _prototypes = raw.prototypes;
            _protoHash  = _computeProtoHash();
            _ready = true;
            log.success('AI', `[SemanticRouter] Loaded ${_prototypes.length} pre-embedded prototypes from JSON.`);
            return true;
        }

        // ── Embeddings are empty — compute them now via Python /embed ──────────
        log.info('AI', `[SemanticRouter] Prototypes not yet embedded. Calling Python /embed to initialize...`);

        const texts = raw.prototypes.map(p => p.text);
        const resp  = await axios.post(EMBED_URL(), { texts }, {
            headers:  { 'Content-Type': 'application/json' },
            timeout:  30000, // longer timeout for batch during startup
        });

        if (!resp.data?.embeddings || resp.data.embeddings.length !== texts.length) {
            throw new Error('Python /embed returned unexpected response shape');
        }

        // Attach embeddings and persist back to JSON
        const enriched = raw.prototypes.map((p, i) => ({ ...p, embedding: resp.data.embeddings[i] }));
        raw.prototypes = enriched;
        fs.writeFileSync(PROTOTYPES_PATH, JSON.stringify(raw, null, 2), 'utf8');

        _prototypes = enriched;
        _protoHash  = _computeProtoHash();
        _ready = true;
        log.success('AI', `[SemanticRouter] Embedded + persisted ${_prototypes.length} prototypes (dim=${resp.data.dim}).`);
        return true;

    } catch (err) {
        log.warn('AI', `[SemanticRouter] Init failed (will retry on first query): ${err.message}`);
        _ready = false;
        return false;
    }
}

// Call at module load (non-blocking — chat requests can proceed without waiting)
function init() {
    if (_initPromise) return _initPromise;
    _initPromise = _initPrototypes();
    return _initPromise;
}
init();

// ── Core routing function ──────────────────────────────────────────────────────

/**
 * Returns the semantic route for a query text.
 *
 * @param {string}   queryText    - The raw user query
 * @param {string}   [cacheKey]   - Optional Redis cache key (e.g. `sem:${userId}:${queryHash}`)
 * @returns {Promise<{ route: string|null, confidence: number, method: string, topMatches: object[] }>}
 */
async function getSemanticRoute(queryText, cacheKey = null) {
    const t0 = Date.now();

    // ── 1. Check Redis cache ─────────────────────────────────────────────────
    if (cacheKey && redisClient?.isOpen) {
        try {
            const cached = await redisClient.get(`semroute:${_protoHash}:${cacheKey}`);
            if (cached) {
                const result = JSON.parse(cached);
                log.info('AI', `[SemanticRouter] Cache HIT → route=${result.route} conf=${result.confidence.toFixed(2)} (${Date.now() - t0}ms)`);
                routerCacheCounter.inc({ result: 'hit' });
                return { ...result, method: 'semantic_cache_hit' };
            }
            routerCacheCounter.inc({ result: 'miss' });
        } catch (e) { /* cache miss is fine */ }
    }

    // ── 2. Ensure prototypes are ready (lazy init on first query) ────────────
    if (!cacheKey) routerCacheCounter.inc({ result: 'miss' });
    if (!_ready) {
        const ok = await _initPrototypes();
        if (!ok) {
            return { route: null, confidence: 0, method: 'semantic_unavailable', topMatches: [] };
        }
    }

    // ── 3. Embed the query ───────────────────────────────────────────────────
    let queryEmbedding;
    try {
        const resp = await axios.post(EMBED_URL(), { text: queryText }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: EMBED_TIMEOUT,
        });
        queryEmbedding = resp.data?.embedding;
        if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
            throw new Error('Invalid embedding response');
        }
    } catch (err) {
        log.warn('AI', `[SemanticRouter] /embed call failed: ${err.message} — falling through to keyword classifier`);
        return { route: null, confidence: 0, method: 'semantic_unavailable', topMatches: [] };
    }

    // ── 4. Cosine similarity against all prototypes ──────────────────────────
    const scores = _prototypes.map(proto => ({
        route:      proto.route,
        text:       proto.text,
        similarity: cosineSimilarity(queryEmbedding, proto.embedding),
    }));

    // ── 5. Aggregate per route: mean of top-3 scores per route ───────────────
    const routeMap = {};
    for (const s of scores) {
        if (!routeMap[s.route]) routeMap[s.route] = [];
        routeMap[s.route].push(s.similarity);
    }

    const routeScores = Object.entries(routeMap).map(([route, sims]) => {
        const sorted = sims.slice().sort((a, b) => b - a);
        const topN   = sorted.slice(0, 3);
        const mean   = topN.reduce((a, b) => a + b, 0) / topN.length;
        return { route, confidence: parseFloat(mean.toFixed(4)) };
    }).sort((a, b) => b.confidence - a.confidence);

    const best       = routeScores[0];
    const topMatches = routeScores.slice(0, 3);

    const elapsed = Date.now() - t0;
    log.info('AI', `[SemanticRouter] route=${best.route} conf=${best.confidence.toFixed(3)} (${elapsed}ms) | top3: ${topMatches.map(r => `${r.route}=${r.confidence.toFixed(2)}`).join(', ')}`);

    const result = {
        route:      best.confidence >= ROUTING_THRESHOLDS.SEMANTIC_FALLBACK ? best.route : null,
        confidence: best.confidence,
        method:     'semantic_embedding',
        topMatches,
        latencyMs:  elapsed,
    };

    // ── 6. Cache result ──────────────────────────────────────────────────────
    if (cacheKey && redisClient?.isOpen) {
        try {
            await redisClient.setEx(`semroute:${_protoHash}:${cacheKey}`, CACHE_TTL, JSON.stringify(result));
        } catch (e) { /* non-fatal */ }
    }

    return result;
}

/**
 * Determine if a route decision should activate direct_answer path.
 * Conditions: route === 'direct_answer' AND confidence > threshold
 */
function isDirectAnswer(routeResult) {
    return routeResult?.route === 'direct_answer'
        && routeResult?.confidence >= ROUTING_THRESHOLDS.SEMANTIC_DIRECT_ANSWER;
}

/**
 * Determine if a route decision should activate ToT.
 * Conditions: route === 'tot' AND confidence > threshold AND complexityScore > 85
 */
function isTotRoute(routeResult, complexityScore) {
    return routeResult?.route === 'tot'
        && routeResult?.confidence >= ROUTING_THRESHOLDS.SEMANTIC_TOT
        && (complexityScore || 0) >= ROUTING_THRESHOLDS.TOT_MIN_COMPLEXITY;
}

/**
 * Like isTotRoute but with a lower complexity threshold (Issue 1.2).
 * Used when the user EXPLICITLY enabled the ToT toggle — we respect their intent
 * with a lower gate (40) instead of the auto-activation gate (85).
 */
function isTotRouteUserExplicit(complexityScore) {
    return (complexityScore || 0) >= ROUTING_THRESHOLDS.TOT_USER_EXPLICIT_MIN_COMPLEXITY;
}

/**
 * Force-refresh prototype embeddings (admin use / testing).
 */
async function refreshPrototypes() {
    _ready = false;
    _initPromise = null;
    _prototypes = [];
    // Reset persisted embeddings to empty so they get re-generated
    try {
        const raw = JSON.parse(fs.readFileSync(PROTOTYPES_PATH, 'utf8'));
        raw.prototypes = raw.prototypes.map(p => ({ ...p, embedding: [] }));
        fs.writeFileSync(PROTOTYPES_PATH, JSON.stringify(raw, null, 2), 'utf8');
    } catch (e) {
        log.warn('AI', `[SemanticRouter] Could not reset prototypes JSON: ${e.message}`);
    }
    return init();
}

module.exports = {
    init,
    getSemanticRoute,
    isDirectAnswer,
    isTotRoute,
    isTotRouteUserExplicit,
    refreshPrototypes,
    // Exposed for testing
    _cosineSimilarity: cosineSimilarity,
};
