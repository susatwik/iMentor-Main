// server/services/contextManager.js
// Feature 1.5.2: Context Window Management
// Provides intelligent pruning, summarization, and prioritization
// to handle 10x longer conversations efficiently.

const log = require('../utils/logger');
const geminiService = require('./geminiService');
const groqService = require('./groqService');

// Lazy-load to avoid circular dependency
let _fallbackService = null;
function getFallbackService() {
    if (!_fallbackService) {
        try { _fallbackService = require('./llmFallbackService'); } catch { _fallbackService = null; }
    }
    return _fallbackService;
}

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

// Conservative token budget (leaves headroom for system prompt + RAG context + new reply)
const MAX_CONTEXT_TOKENS = 12000;  // max tokens for history sent to LLM (RTX A4000 16GB, ctx=16384)
const SUMMARY_TRIGGER_TOKENS = 10000;  // trigger summarization above this
const ALWAYS_KEEP_RECENT_COUNT = 6;      // always keep last N message pairs
const MIN_MESSAGES_TO_SUMMARIZE = 10;    // don't summarize tiny histories
const PINNED_ROLES = new Set(['system']);

// ─────────────────────────────────────────────────────────────
// TOKEN ESTIMATION
// ─────────────────────────────────────────────────────────────

/**
 * Lightweight token estimator — roughly 1 token per 4 characters.
 * Avoids external tiktoken dependency.
 * @param {string} text
 * @returns {number} estimated token count
 */
function estimateTokens(text) {
    if (!text || typeof text !== 'string') return 0;
    return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens for a single message object { role, parts: [{text}] }
 */
function estimateMessageTokens(msg) {
    const textContent = (msg.parts || []).map(p => p.text || '').join(' ');
    return estimateTokens(textContent) + 4; // +4 for role overhead
}

/**
 * Estimate total tokens for an array of messages.
 */
function estimateTotalTokens(messages) {
    return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

// ─────────────────────────────────────────────────────────────
// RELEVANCE SCORING
// ─────────────────────────────────────────────────────────────

/**
 * Score a message for relevance to the current query.
 * Higher = more relevant = less likely to be pruned.
 * @param {object} msg - message object
 * @param {string} currentQuery - latest user query
 * @returns {number} relevance score (0-100)
 */
function scoreRelevance(msg, currentQuery) {
    const text = (msg.parts || []).map(p => p.text || '').join(' ').toLowerCase();
    const query = (currentQuery || '').toLowerCase();

    if (!text || !query) return 0;

    // Extract significant words (ignore short filler words)
    const queryWords = query.split(/\s+/).filter(w => w.length > 3);
    if (queryWords.length === 0) return 0;

    const matchCount = queryWords.filter(word => text.includes(word)).length;
    const score = Math.round((matchCount / queryWords.length) * 100);

    return score;
}

// ─────────────────────────────────────────────────────────────
// SUMMARIZATION
// ─────────────────────────────────────────────────────────────

/**
 * Summarize a block of old messages using the cheapest available LLM.
 * Returns a compact string summary.
 * @param {Array} messages - old messages to compress
 * @param {object} llmConfig - LLM provider config
 * @returns {Promise<string>} summary text
 */
async function summarizeHistory(messages, llmConfig = {}) {
    if (!messages || messages.length === 0) return '';

    const GROQ_MAX_TRANSCRIPT_TOKENS = 3500; // safe limit under Groq's 6k TPM

    // Build a readable transcript for the LLM
    const allLines = messages.map(msg => {
        const role = msg.role === 'model' ? 'AI' : 'Student';
        const text = (msg.parts || []).map(p => p.text || '').join(' ').substring(0, 300); // cap each msg
        return `${role}: ${text}`;
    });

    // Split into chunks that fit within Groq's token limit
    const chunks = [];
    let currentChunk = [];
    let currentTokens = 0;

    for (const line of allLines) {
        const lineTokens = estimateTokens(line);
        if (currentTokens + lineTokens > GROQ_MAX_TRANSCRIPT_TOKENS && currentChunk.length > 0) {
            chunks.push(currentChunk.join('\n'));
            currentChunk = [];
            currentTokens = 0;
        }
        currentChunk.push(line);
        currentTokens += lineTokens;
    }
    if (currentChunk.length > 0) chunks.push(currentChunk.join('\n'));

    const buildPrompt = (transcript) =>
        `You are a conversation summarizer. Below is a transcript of an educational chat session.

Create a CONCISE factual summary (max 150 words) capturing:
1. Topics discussed and key concepts explained
2. Student's understanding demonstrated
3. Any important context (questions, misconceptions corrected)

Do NOT include greetings or filler. Be factual and dense.

TRANSCRIPT:\n${transcript}\n\nSUMMARY:`;

    const summaries = [];

    for (const chunk of chunks) {
        let summary = null;

        // Prefer llmFallbackService.callFast() — uses fastest available provider
        const fallback = getFallbackService();
        if (fallback && typeof fallback.callFast === 'function') {
            try {
                summary = await fallback.callFast(buildPrompt(chunk), 'summarization');
            } catch (e) {
                log.warn('SYSTEM', `callFast summarization failed: ${e.message}`);
            }
        }

        // Fallback: Groq direct
        if (!summary && process.env.GROQ_API_KEY) {
            try {
                summary = await groqService.generateContentWithHistory(
                    [], buildPrompt(chunk), null,
                    { model: 'llama-3.1-8b-instant', apiKey: process.env.GROQ_API_KEY, maxOutputTokens: 300, temperature: 0.3 }
                );
            } catch (e) {
                log.warn('SYSTEM', `Groq summarization failed: ${e.message}`);
            }
        }

        // Fallback to Gemini Flash
        if (!summary && process.env.GEMINI_API_KEY) {
            try {
                summary = await geminiService.generateContentWithHistory(
                    [], buildPrompt(chunk), null,
                    { geminiModel: 'gemini-flash-latest', apiKey: process.env.GEMINI_API_KEY, maxOutputTokens: 300 }
                );
            } catch (e) {
                log.warn('SYSTEM', `Gemini summarization failed: ${e.message}`);
            }
        }

        if (summary) summaries.push(summary.trim());
    }

    if (summaries.length > 0) {
        // If multiple chunks were summarized, do a final merge summary
        const merged = summaries.length === 1
            ? summaries[0]
            : summaries.join(' | ');

        log.info('SYSTEM', `Condensed ${messages.length} messages into summary`);
        return merged;
    }

    // Fallback: naive truncation of each message
    return messages.map(msg => {
        const text = (msg.parts || []).map(p => p.text || '').join(' ');
        return text.substring(0, 80).trim();
    }).join(' | ');
}

// ─────────────────────────────────────────────────────────────
// INTELLIGENT PRUNING
// ─────────────────────────────────────────────────────────────

/**
 * Prune a message history array to fit within token budget.
 *
 * Strategy:
 *   1. Always keep the last ALWAYS_KEEP_RECENT_COUNT message pairs (most recent context).
 *   2. From older messages, keep those most RELEVANT to the current query.
 *   3. Drop oldest/least-relevant messages until we fit within MAX_CONTEXT_TOKENS.
 *
 * @param {Array} messages - full chat history [{role, parts}]
 * @param {string} currentQuery - current user query (for relevance scoring)
 * @param {number} [tokenBudget] - max tokens allowed
 * @returns {Array} pruned message array
 */
function pruneHistory(messages, currentQuery = '', tokenBudget = MAX_CONTEXT_TOKENS) {
    if (!messages || messages.length === 0) return [];

    const totalTokens = estimateTotalTokens(messages);

    // Fast path: already within budget
    if (totalTokens <= tokenBudget) {
        // log.info('SYSTEM', 'Context within budget');
        return messages;
    }

    // Split: recent (protected) vs older (candidates for pruning)
    const recentMessages = messages.slice(-ALWAYS_KEEP_RECENT_COUNT * 2);
    const olderMessages = messages.slice(0, -ALWAYS_KEEP_RECENT_COUNT * 2);

    // Score older messages by relevance to current query
    const scored = olderMessages.map((msg, idx) => ({
        msg,
        idx,
        relevance: scoreRelevance(msg, currentQuery),
        tokens: estimateMessageTokens(msg)
    }));

    // Sort by relevance descending (most relevant first)
    scored.sort((a, b) => b.relevance - a.relevance);

    // Greedily add older messages until we hit budget
    const recentTokens = estimateTotalTokens(recentMessages);
    let remainingBudget = tokenBudget - recentTokens;
    const keptOlder = [];

    for (const item of scored) {
        if (item.tokens <= remainingBudget) {
            keptOlder.push(item);
            remainingBudget -= item.tokens;
        }
        if (remainingBudget <= 0) break;
    }

    // Re-sort kept older messages back into original order
    keptOlder.sort((a, b) => a.idx - b.idx);
    const keptOlderMsgs = keptOlder.map(item => item.msg);

    const prunedCount = olderMessages.length - keptOlderMsgs.length;
    const finalTokens = estimateTotalTokens([...keptOlderMsgs, ...recentMessages]);

    log.info('SYSTEM', `Pruned ${prunedCount} messages for context optimization`);

    return [...keptOlderMsgs, ...recentMessages];
}

// ─────────────────────────────────────────────────────────────
// CONTEXT PRIORITIZATION (MAIN ENTRY POINT)
// ─────────────────────────────────────────────────────────────

/**
 * Build an optimized context array for the LLM.
 *
 * - For short histories: pass through with light pruning
 * - For long histories (>SUMMARY_TRIGGER_TOKENS): auto-summarize old part,
 *   then append the recent messages verbatim
 * - Injects existing DB summary as a pinned context message if present
 *
 * @param {object} options
 * @param {Array}  options.messages       - Full DB message history
 * @param {string} options.currentQuery   - Latest user query
 * @param {string} options.existingSummary - Previously stored summary (from ChatHistory.summary)
 * @param {object} options.llmConfig      - LLM config for on-the-fly summarization
 * @param {boolean} options.needsRecall   - Whether query suggests the user wants earlier context recalled
 * @returns {Promise<{ historyForLlm: Array, newSummary: string|null }>}
 *   historyForLlm — ready-to-send message array
 *   newSummary    — newly generated summary (save back to DB), or null if unchanged
 */
async function buildOptimalContext({ messages, currentQuery, existingSummary = '', llmConfig = {}, needsRecall = false }) {
    if (!messages || messages.length === 0) {
        return { historyForLlm: [], newSummary: null };
    }

    const totalTokens = estimateTotalTokens(messages);
    // log.info('SYSTEM', `Estimated context tokens: ~${totalTokens}`);

    let historyForLlm = [];
    let newSummary = null;

    // ── CASE 1: History fits in budget ────────────────────────────────────────
    if (totalTokens <= SUMMARY_TRIGGER_TOKENS) {
        // log.info('SYSTEM', 'Within token budget');
        historyForLlm = pruneHistory(messages, currentQuery, MAX_CONTEXT_TOKENS);

        // Prepend existing summary if recall is needed
        if (existingSummary && needsRecall) {
            historyForLlm = buildSummaryInjection(existingSummary, historyForLlm);
        }

        return { historyForLlm, newSummary: null };
    }

    // ── CASE 2: History is too long — summarize old part ─────────────────────
    const recentMessages = messages.slice(-ALWAYS_KEEP_RECENT_COUNT * 2);
    const olderMessages = messages.slice(0, -ALWAYS_KEEP_RECENT_COUNT * 2);

    if (olderMessages.length >= MIN_MESSAGES_TO_SUMMARIZE) {
        log.info('SYSTEM', `Triggering summarization of ${olderMessages.length} older messages`);

        // Generate a fresh condensed summary of the older messages
        const condensedSummary = await summarizeHistory(olderMessages, llmConfig);

        // Merge with any existing summary for continuity
        const mergedSummary = existingSummary
            ? `${existingSummary}\n\n[Continued]: ${condensedSummary}`
            : condensedSummary;

        newSummary = mergedSummary;

        // Build: [summary injection] + [recent messages]
        historyForLlm = buildSummaryInjection(mergedSummary, recentMessages);

        // log.info('SYSTEM', 'Context optimized successfully');
    } else {
        // Not enough old messages to summarize — just prune by relevance
        historyForLlm = pruneHistory(messages, currentQuery, MAX_CONTEXT_TOKENS);

        if (existingSummary && needsRecall) {
            historyForLlm = buildSummaryInjection(existingSummary, historyForLlm);
        }
    }

    return { historyForLlm, newSummary };
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Create messages that inject a summary into the LLM context.
 * Uses a user/model exchange so the LLM treats it as established context.
 */
function buildSummaryInjection(summary, appendMessages = []) {
    if (!summary) return appendMessages;

    const injected = [
        {
            role: 'user',
            parts: [{ text: `[CONVERSATION HISTORY SUMMARY]\n${summary}\n[END SUMMARY]` }]
        },
        {
            role: 'model',
            parts: [{ text: 'Understood. I have reviewed the conversation history and will maintain continuity.' }]
        },
        ...appendMessages
    ];

    return injected;
}

/**
 * Convenience: check if history needs management (over threshold).
 * Use this for quick pre-flight checks.
 */
function needsContextManagement(messages) {
    return estimateTotalTokens(messages) > SUMMARY_TRIGGER_TOKENS;
}

// ─────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────

module.exports = {
    buildOptimalContext,
    pruneHistory,
    summarizeHistory,
    estimateTokens,
    estimateMessageTokens,
    estimateTotalTokens,
    needsContextManagement,
    MAX_CONTEXT_TOKENS,
    SUMMARY_TRIGGER_TOKENS,
};
