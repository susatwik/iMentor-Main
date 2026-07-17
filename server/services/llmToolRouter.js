/**
 * server/services/llmToolRouter.js
 *
 * Fast LLM-based tool selection router.
 *
 * Uses Gemini Flash (gemini-2.0-flash / gemini-1.5-flash) to decide which tools
 * to activate for a user query. Called ONLY when the semantic router's confidence
 * is below the threshold — keeping total latency under 1 second for the routing
 * decision.
 *
 * Model choice for SGLang:
 *   If SGLANG_ENABLED=true, pull  Qwen/Qwen2.5-0.5B-Instruct-AWQ (~0.5 GB VRAM).
 *   This model is tiny enough to co-exist with the 14B chat model on the same GPU
 *   and returns a routing decision in < 200 ms.
 *   Pull command:  (SGLang does not have a pull CLI — just specify the model ID and
 *   SGLang downloads from HuggingFace automatically on first request.)
 *
 *   Environment variable:  SGLANG_ROUTER_MODEL=Qwen/Qwen2.5-0.5B-Instruct-AWQ
 *                          SGLANG_ROUTER_URL=http://localhost:8003/v1
 *
 * Fallback: Gemini Flash (already in use, no extra GPU cost, ~300 ms).
 */

const axios = require('axios');
const log   = require('../utils/logger');

// ── Tools the router can activate ────────────────────────────────────────────
const TOOL_DESCRIPTIONS = `
web_search       — user is asking about current events, recent news, live data, prices, or anything that changes over time
academic_search  — user is asking for peer-reviewed papers, scholarly research, citations, or arxiv papers
rag_retrieve     — user has uploaded a document and is asking questions about it
tot              — user's question is genuinely complex and requires multi-step reasoning (math proofs, code architecture, ethical dilemmas)
none             — a simple factual question, definition, or explanation that can be answered from training data
`.trim();

const SYSTEM_PROMPT = `You are a tool-selection router for an AI tutor chatbot.
Given a user query, output ONLY a valid JSON object — no prose, no markdown fences.

Format: {"tools": [...], "reason": "one short sentence"}

Available tools:
${TOOL_DESCRIPTIONS}

Rules:
- tools is an array; it can be empty (equivalent to "none") or contain multiple tools.
- Do NOT include "none" as a string in the tools array — use an empty array [].
- tot (Tree-of-Thought) is only for genuinely complex multi-step problems.
- If the query contains words like "news", "latest", "current", "today", "yesterday", "this week", "recently", "what is happening", always include web_search.
- If the user mentions uploading or analyzing a specific document they uploaded, include rag_retrieve.
- Keep reason concise (< 15 words).`;

// 3-shot examples
const FEW_SHOTS = [
    { role: 'user',      content: 'What is the capital of France?' },
    { role: 'assistant', content: '{"tools": [], "reason": "Simple factual lookup, no live data needed."}' },
    { role: 'user',      content: 'latest news about Israel and Iran conflict' },
    { role: 'assistant', content: '{"tools": ["web_search"], "reason": "Current geopolitical events require live news data."}' },
    { role: 'user',      content: 'find arxiv papers on transformer attention mechanisms' },
    { role: 'assistant', content: '{"tools": ["academic_search"], "reason": "User explicitly wants peer-reviewed academic papers."}' },
    { role: 'user',      content: 'prove the Riemann hypothesis step by step' },
    { role: 'assistant', content: '{"tools": ["tot"], "reason": "Complex mathematical proof requires deep multi-step reasoning."}' },
];

// ── Gemini Flash call ─────────────────────────────────────────────────────────
async function _callGeminiFlash(query) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('No GEMINI_API_KEY');

    // Prefer gemini-2.0-flash-lite (fastest/cheapest), fall back to 1.5-flash
    const model = process.env.LLM_ROUTER_MODEL || 'gemini-2.0-flash-lite';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

    const messages = [
        ...FEW_SHOTS.map(s => ({ role: s.role, parts: [{ text: s.content }] })),
        { role: 'user', parts: [{ text: query }] },
    ];

    const body = {
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: messages,
        generationConfig: { maxOutputTokens: 80, temperature: 0.0 },
    };

    const resp = await axios.post(url, body, { timeout: 3000 });
    const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    return text;
}

// ── SGLang small-model call (optional) ───────────────────────────────────────
async function _callSGLangRouter(query) {
    const baseURL = process.env.SGLANG_ROUTER_URL || process.env.SGLANG_CHAT_URL || 'http://localhost:8000/v1';
    const model   = process.env.SGLANG_ROUTER_MODEL || process.env.SGLANG_CHAT_MODEL || 'Qwen/Qwen2.5-7B-Instruct-AWQ';

    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...FEW_SHOTS,
        { role: 'user', content: query },
    ];

    const resp = await axios.post(`${baseURL}/chat/completions`, {
        model,
        messages,
        max_tokens:  80,
        temperature: 0.0,
        stream:      false,
    }, { timeout: 2000 });

    return resp.data?.choices?.[0]?.message?.content?.trim() || '';
}

// ── Parse LLM output ──────────────────────────────────────────────────────────
function _parse(text) {
    try {
        // Strip any accidental markdown fences
        const clean = text.replace(/```json?/gi, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(clean);
        if (Array.isArray(parsed.tools)) return parsed;
    } catch (e) { /* fall through */ }
    return null;
}

// ── Public API ─────────────────────────────────────────────────────────────────
/**
 * Route a query to the appropriate tools using a small LLM.
 * Called when semantic router confidence < threshold OR as a second opinion.
 *
 * @param {string} query
 * @returns {Promise<{ tools: string[], reason: string, source: string }>}
 */
async function routeWithLLM(query) {
    const start = Date.now();
    let rawText = '';
    let source  = 'none';

    // Try SGLang router first (no separate router instance needed — use chat endpoint)
    if (process.env.SGLANG_ENABLED === 'true') {
        try {
            rawText = await _callSGLangRouter(query);
            source  = 'sglang_router';
        } catch (e) {
            log.warn('LLM_ROUTER', `SGLang router failed: ${e.message}`);
        }
    }

    // Fall back to Gemini Flash only if admin has validated the key
    if (!rawText && process.env.GEMINI_API_VALIDATED === 'true') {
        try {
            rawText = await _callGeminiFlash(query);
            source  = 'gemini_flash';
        } catch (e) {
            log.warn('LLM_ROUTER', `Gemini Flash router failed: ${e.message}`);
        }
    }

    if (!rawText) {
        return { tools: [], reason: 'router unavailable', source: 'fallback' };
    }

    const parsed = _parse(rawText);
    const elapsed = Date.now() - start;

    if (parsed) {
        log.info('LLM_ROUTER', `[${source}] tools=${JSON.stringify(parsed.tools)} reason="${parsed.reason}" (${elapsed}ms)`);
        return { ...parsed, source };
    }

    log.warn('LLM_ROUTER', `Could not parse LLM router output: ${rawText}`);
    return { tools: [], reason: 'parse error', source };
}

module.exports = { routeWithLLM };
