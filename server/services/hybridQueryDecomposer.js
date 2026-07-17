/**
 * Hybrid Query Decomposer
 *
 * Problem: A single user query like
 *   "Explain sliding window and MPC in control systems. What are recent techniques?"
 * has two conceptually distinct parts:
 *   Part 1 — foundational/conceptual  → LLM pre-trained knowledge is sufficient
 *   Part 2 — temporal / "recent"      → needs web or academic search
 *
 * Without this service the whole query gets one binary routing decision
 * (either web search ON or OFF for everything) so the search results are
 * mixed with the conceptual explanation and the retrieval budget is wasted.
 *
 * This service:
 *   1. Splits the query into segments at natural sentence / clause boundaries
 *   2. Classifies each segment independently (heuristic-first, zero LLM calls)
 *   3. Returns a decomposition plan so the caller can fetch only what each
 *      segment needs, then pass ALL retrieved context to the LLM together
 *
 * Integration point: server/routes/chat/index.js — runs BEFORE the keyword
 * pre-check so it can set useWebSearch/useAcademicSearch selectively and
 * attach `hybridContext` to the request context for the LLM prompt builder.
 */

'use strict';

const log = require('../utils/logger');

// ─── Retrieval-need classifiers ───────────────────────────────────────────────

/** Patterns that signal the segment needs a live web search */
const WEB_PATTERNS = [
    /\b(latest|recent|current|now|today|this year|this month|this week|right now|as of|breaking|just happened|ongoing|new update)\b/i,
    /\b(news|headline|update|development|announcement|situation|crisis|trend|state of the art|sota)\b/i,
    /\b(what('s| is) (happening|new|the latest)|any news|tell me what happened|what happened recently)\b/i,
    /\b(20(2[4-9]|3\d))\b/,   // explicit recent year ≥ 2024
];

/** Patterns that signal the segment needs academic / scholarly retrieval */
const ACADEMIC_PATTERNS = [
    /\b(paper|papers|research|study|studies|survey|review|journal|arxiv|doi|citation|conference|proceedings)\b/i,
    /\b(peer.reviewed|scholarly|empirical|published|systematic review|meta.analysis)\b/i,
    /\b(according to research|literature shows|studies show|researchers found)\b/i,
];

/** Patterns that strongly indicate conceptual / foundational questions → LLM only */
const CONCEPTUAL_PATTERNS = [
    /^(what (is|are)|explain|describe|define|how does|how do|can you explain|tell me about|elaborate on|walk me through)/i,
    /\b(concept|principle|fundamentals?|basics?|overview|introduction|theory|definition|algorithm|technique|method)\b/i,
];

/**
 * Classify a single segment's retrieval need.
 * @returns {'web'|'academic'|'llm'} retrieval type
 */
function classifySegment(text) {
    const t = text.trim();
    if (!t) return 'llm';

    const needsWeb      = WEB_PATTERNS.some(p => p.test(t));
    const needsAcademic = ACADEMIC_PATTERNS.some(p => p.test(t));

    // If both web and academic signals fire, prefer academic (richer sources)
    if (needsAcademic) return 'academic';
    if (needsWeb)      return 'web';
    return 'llm';
}

// ─── Sentence / clause splitter ───────────────────────────────────────────────

/**
 * Split a query into conceptual segments at:
 *   - Sentence boundaries (. ! ?)
 *   - "Also," / "Additionally," / "Furthermore," conjunctions
 *   - Explicit list items ("1. ... 2. ...")
 *   - Newlines
 *
 * Filters out very short fragments that are just noise.
 */
function splitIntoSegments(query) {
    // Normalise
    let text = query.trim().replace(/\r\n/g, '\n');

    // Split on: sentence-ending punctuation, explicit connectives, newlines
    const rawParts = text.split(
        /(?<=[.!?])\s+(?=[A-Z])|(?:\n+)|(?:\.\s+)|(?:;\s*)|(?:\b(?:also|additionally|furthermore|moreover|secondly|finally|next|lastly),?\s+)/i
    );

    const segments = rawParts
        .map(s => s.trim().replace(/\.$/, '').trim())
        .filter(s => s.length > 10); // ignore very short fragments

    // If the split produced only 1 segment, try a softer split at question marks
    if (segments.length <= 1) {
        const byQuestion = text.split(/\?/).map(s => s.trim()).filter(s => s.length > 10);
        if (byQuestion.length > 1) return byQuestion;
    }

    return segments.length ? segments : [query.trim()];
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Decompose a query into typed segments.
 *
 * @param {string} query  — raw user query
 * @param {object} opts
 * @param {boolean} [opts.tutorMode=false]       — skip decomposition in tutor mode
 * @param {boolean} [opts.deepResearchMode=false] — skip; deep research owns its own retrieval
 * @param {boolean} [opts.userForcedWeb=false]   — user already toggled web search ON
 * @param {boolean} [opts.userForcedAcademic=false] — user already toggled academic ON
 *
 * @returns {{
 *   isHybrid: boolean,
 *   segments: Array<{ text: string, retrieval: 'web'|'academic'|'llm' }>,
 *   needsWeb: boolean,
 *   needsAcademic: boolean,
 *   searchQueries: { web: string[], academic: string[] }
 * }}
 */
function decomposeQuery(query, opts = {}) {
    const {
        tutorMode       = false,
        deepResearchMode = false,
        userForcedWeb   = false,
        userForcedAcademic = false,
    } = opts;

    // Don't decompose when other modes own the pipeline entirely
    if (tutorMode || deepResearchMode) {
        return _trivialResult(query);
    }

    const segments = splitIntoSegments(query);

    // Single-segment queries — no decomposition needed
    if (segments.length <= 1) {
        const ret = classifySegment(query);
        const needsWeb      = ret === 'web'      || userForcedWeb;
        const needsAcademic = ret === 'academic' || userForcedAcademic;
        return {
            isHybrid:     false,
            segments:     [{ text: query.trim(), retrieval: ret }],
            needsWeb,
            needsAcademic,
            searchQueries: {
                web:      needsWeb      ? [query.trim()] : [],
                academic: needsAcademic ? [query.trim()] : [],
            },
        };
    }

    // Multi-segment — classify each independently
    const typed = segments.map(text => ({ text, retrieval: classifySegment(text) }));

    const webSegments      = typed.filter(s => s.retrieval === 'web');
    const academicSegments = typed.filter(s => s.retrieval === 'academic');

    const needsWeb      = webSegments.length > 0      || userForcedWeb;
    const needsAcademic = academicSegments.length > 0 || userForcedAcademic;

    // Only "hybrid" if at least one segment needs retrieval AND at least one is LLM-only
    const hasLlmOnly = typed.some(s => s.retrieval === 'llm');
    const isHybrid   = (needsWeb || needsAcademic) && hasLlmOnly;

    // Build focused search queries — use the retrieval-needing segment text
    // rather than the entire query so search engines return more relevant results
    const webQueries      = userForcedWeb
        ? [query.trim()]
        : webSegments.map(s => s.text);

    const academicQueries = userForcedAcademic
        ? [query.trim()]
        : academicSegments.map(s => s.text);

    if (isHybrid) {
        log.info('HYBRID', `Query decomposed into ${typed.length} segments — web:${webSegments.length} academic:${academicSegments.length} llm-only:${typed.filter(s=>s.retrieval==='llm').length}`);
        typed.forEach((s, i) => log.debug('HYBRID', `  [${i+1}] (${s.retrieval}) "${s.text.substring(0, 60)}"`));
    }

    return {
        isHybrid,
        segments: typed,
        needsWeb,
        needsAcademic,
        searchQueries: { web: webQueries, academic: academicQueries },
    };
}

function _trivialResult(query) {
    return {
        isHybrid:     false,
        segments:     [{ text: query.trim(), retrieval: 'llm' }],
        needsWeb:     false,
        needsAcademic: false,
        searchQueries: { web: [], academic: [] },
    };
}

/**
 * Build the injected context block that is prepended to the LLM system prompt
 * when the query was hybrid-decomposed and retrieval results are available.
 *
 * @param {object} decomposition  — result of decomposeQuery()
 * @param {object} retrievedData
 * @param {string} [retrievedData.webText]       — web search result text
 * @param {string} [retrievedData.academicText]  — academic search result text
 * @returns {string}  formatted context block to inject into system prompt
 */
function buildHybridContextBlock(decomposition, retrievedData = {}) {
    if (!decomposition.isHybrid) return '';

    const lines = [
        '--- HYBRID RETRIEVAL CONTEXT ---',
        'The user\'s question has multiple parts. Retrieved information is provided below.',
        'Use it ONLY for the parts that require recent/searched knowledge.',
        'For foundational/conceptual parts, rely on your trained knowledge.',
        '',
    ];

    if (retrievedData.webText) {
        lines.push('## Web Search Results (use for recent/current information):');
        lines.push(retrievedData.webText.trim());
        lines.push('');
    }

    if (retrievedData.academicText) {
        lines.push('## Academic Sources (use for research citations):');
        lines.push(retrievedData.academicText.trim());
        lines.push('');
    }

    lines.push('--- END HYBRID RETRIEVAL CONTEXT ---');

    return lines.join('\n');
}

module.exports = { decomposeQuery, buildHybridContextBlock, classifySegment, splitIntoSegments };
