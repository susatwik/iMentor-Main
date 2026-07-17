/**
 * server/services/sglangCapabilities.js
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║          SGLang Capabilities — Live Model Metadata Cache                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Fetches /v1/models from the running SGLang server ONCE on startup and
 * caches the real max_model_len.  Every service that needs to compute a
 * safe token budget calls getModelMaxContext() — a synchronous getter that
 * returns the cached value (or the fallback until the fetch completes).
 *
 * Why not hardcode?
 *   The same code is used against different SGLang deployments:
 *     • 7B-AWQ  → 8192 tokens total
 *     • 14B-AWQ → 8192 tokens (--context-length arg)
 *     • 32B-AWQ → configurable (often 4096 on single GPU)
 *   Hardcoding the wrong value causes 400 "Requested token count exceeds
 *   model's maximum context length" errors on every single request.
 *
 * Usage (sync — safe anywhere):
 *   const { getModelMaxContext } = require('./sglangCapabilities');
 *   const limit = getModelMaxContext();   // e.g. 8192
 *
 * Usage (await at server boot to ensure ready before first request):
 *   await require('./sglangCapabilities').fetchModelCapabilities();
 */

'use strict';

const log = require('../utils/logger');

// ── Cached state ──────────────────────────────────────────────────────────────
let _maxContextTokens = 8192;   // safe fallback (real Qwen2.5-7B-AWQ limit)
let _fetchPromise     = null;
let _fetched          = false;
let _cachedModelId    = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip /v1 (or /v1/) suffix from a URL so we can build canonical paths. */
function _baseUrl() {
    const raw =
        process.env.SGLANG_CHAT_URL  ||
        process.env.SGLANG_HEAVY_URL ||
        'http://localhost:8000/v1';
    return raw.replace(/\/v1\/?$/, '');   // "http://localhost:8000"
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Synchronous getter — always safe to call.
 * Returns the live value once fetched, otherwise the last known good value.
 *
 * @param {number} [fallback=8192]
 * @returns {number}
 */
function getModelMaxContext(fallback = 8192) {
    return _fetched ? _maxContextTokens : fallback;
}

/**
 * Returns the model id string (e.g. "Qwen/Qwen2.5-7B-Instruct-AWQ") or null.
 * @returns {string|null}
 */
function getModelId() {
    return _cachedModelId;
}

/**
 * Fetch /v1/models once, cache max_model_len, and return it.
 * Subsequent calls return the same cached promise — only one HTTP request
 * is ever made per process lifetime.
 *
 * @returns {Promise<number>} resolved context length
 */
async function fetchModelCapabilities() {
    if (_fetchPromise) return _fetchPromise;

    _fetchPromise = (async () => {
        const url = `${_baseUrl()}/v1/models`;

        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const res = await fetch(url, {
                    signal: AbortSignal.timeout(5000),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);

                const data = await res.json();
                const model = data?.data?.[0];

                if (model?.max_model_len) {
                    _maxContextTokens = model.max_model_len;
                    _cachedModelId    = model.id || null;
                    _fetched          = true;
                    log.info('AI', `[SGLang Caps] model=${_cachedModelId}  max_context=${_maxContextTokens} tokens`);
                    return _maxContextTokens;
                }
                throw new Error('max_model_len missing from /v1/models response');

            } catch (err) {
                log.warn('AI', `[SGLang Caps] fetch attempt ${attempt}/3 failed: ${err.message}`);
                if (attempt < 3) {
                    await new Promise(r => setTimeout(r, 2000 * attempt));
                }
            }
        }

        // All attempts failed — keep existing default and mark as done so we
        // don't retry on every request.
        log.warn('AI', `[SGLang Caps] Could not reach SGLang; using fallback context=${_maxContextTokens}`);
        _fetched = true;
        return _maxContextTokens;
    })();

    return _fetchPromise;
}

// ── Auto-fetch on first require ───────────────────────────────────────────────
// Non-blocking — other code can safely require() this module before the fetch
// resolves.  If you need it ready before handling requests, await
// fetchModelCapabilities() in your server startup.
fetchModelCapabilities().catch(() => {});

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = { getModelMaxContext, getModelId, fetchModelCapabilities };
