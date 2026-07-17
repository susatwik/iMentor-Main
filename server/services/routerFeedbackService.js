/**
 * routerFeedbackService.js
 *
 * Saves queries that semantic router (Step 1) missed but downstream routing
 * correctly resolved. On the next cache rebuild, these examples are incorporated
 * into semantic_router_cache.json so the cosine router improves over time.
 *
 * Only records unambiguous specialist intents where the downstream decision
 * is reliable:
 *   DEEP_RESEARCH        — deepResearchMode set by routing
 *   ACADEMIC_SEARCH      — useAcademicSearch set by routing
 *   WEB_SEARCH           — useWebSearch set by routing
 *   MATHEMATICAL_REASONING — criticalThinkingEnabled set by routing (not user toggle)
 *
 * File: server/data/router_feedback.json
 * Format: [ { query, semanticConf, resolvedIntent, resolvedBy, timestamp } ]
 * Max: 500 entries (oldest pruned).
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const log  = require('../utils/logger');

const FEEDBACK_FILE = path.join(__dirname, '../data/router_feedback.json');
const MAX_ENTRIES   = 500;
// Only record these intents — others are too ambiguous from flag inference
const RECORDABLE_INTENTS = new Set([
    'DEEP_RESEARCH',
    'ACADEMIC_SEARCH',
    'WEB_SEARCH',
    'MATHEMATICAL_REASONING',
]);

// In-memory set of known queries for fast dedup (populated on first read)
let _knownQueries = null; // Set<string>
let _writeQueued  = false;

// ── Internal helpers ──────────────────────────────────────────────────────────

function _normKey(query) {
    return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

function _load() {
    try {
        if (!fs.existsSync(FEEDBACK_FILE)) return [];
        return JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8'));
    } catch {
        return [];
    }
}

function _initKnownSet(entries) {
    _knownQueries = new Set(entries.map(e => _normKey(e.query)));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record a semantic miss and its downstream-resolved intent.
 * Fire-and-forget (async, non-blocking). Never throws.
 *
 * @param {string} query           - Original user query
 * @param {number} semanticConf    - semanticRouting.confidence (e.g. 0.50)
 * @param {string} resolvedIntent  - One of RECORDABLE_INTENTS
 * @param {string} resolvedBy      - 'semantic_tools' | 'llm_router' | 'nli_step2'
 */
function recordMiss(query, semanticConf, resolvedIntent, resolvedBy) {
    if (!RECORDABLE_INTENTS.has(resolvedIntent)) return;
    if (!query || typeof query !== 'string' || query.trim().length < 5) return;

    // Lazily load known-query set from disk (once per process)
    if (_knownQueries === null) {
        _initKnownSet(_load());
    }

    const key = _normKey(query);
    if (_knownQueries.has(key)) return; // already saved
    _knownQueries.add(key);

    setImmediate(() => {
        try {
            const entries = _load();
            // Double-check after async gap
            if (entries.some(e => _normKey(e.query) === key)) return;

            entries.push({
                query:          query.trim(),
                semanticConf:   +semanticConf.toFixed(3),
                resolvedIntent,
                resolvedBy,
                timestamp:      new Date().toISOString(),
            });

            // Prune oldest if over limit
            const pruned = entries.length > MAX_ENTRIES
                ? entries.slice(entries.length - MAX_ENTRIES)
                : entries;

            fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(pruned, null, 2), 'utf8');
            log.info('ROUTER_FEEDBACK', `Saved miss → ${resolvedIntent}: "${query.substring(0, 55)}"`);
        } catch (err) {
            log.warn('ROUTER_FEEDBACK', `Failed to write feedback: ${err.message}`);
        }
    });
}

/**
 * Infer resolvedIntent from post-routing flag state.
 * Call this AFTER both semantic router and LLM router have run.
 *
 * @param {object} flags
 * @param {boolean} flags.deepResearchMode
 * @param {boolean} flags.useAcademicSearch
 * @param {boolean} flags.useWebSearch
 * @param {boolean} flags.criticalThinkingEnabled
 * @param {boolean} flags.userRequestedToT   — user's original ToT toggle (pre-routing)
 * @param {boolean} flags.keywordSetWebSearch — was webSearch set by keyword pre-check
 * @returns {string|null} resolved intent name, or null if ambiguous
 */
function inferIntent({ deepResearchMode, useAcademicSearch, useWebSearch, criticalThinkingEnabled, userRequestedToT, keywordSetWebSearch }) {
    if (deepResearchMode)    return 'DEEP_RESEARCH';
    if (useAcademicSearch)   return 'ACADEMIC_SEARCH';
    // Exclude webSearch that was already set by keyword pre-check (not routing)
    if (useWebSearch && !keywordSetWebSearch) return 'WEB_SEARCH';
    // Only credit routing-enabled ToT; skip user-toggled ToT
    if (criticalThinkingEnabled && !userRequestedToT) return 'MATHEMATICAL_REASONING';
    return null;
}

/**
 * Load all saved feedback entries (for use by rebuild script / admin).
 * @returns {Array}
 */
function loadFeedback() {
    return _load();
}

module.exports = { recordMiss, inferIntent, loadFeedback };
