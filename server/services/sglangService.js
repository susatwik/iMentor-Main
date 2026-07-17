/**
 * server/services/sglangService.js
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║            SGLang Service — OpenAI-Compatible LLM Wrapper               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * SGLang exposes an OpenAI-compatible REST API. This service wraps the standard
 * OpenAI SDK with a configurable baseURL pointing to SGLang endpoints.
 *
 * Models (AWQ 4-bit quantized — ~2x smaller VRAM, near-identical quality):
 *   SGLANG_CHAT_URL    — Day-shift 14B-AWQ  (~9 GB, GPU 0)   standard + direct_answer
 *   SGLANG_REASON_URL  — Day-shift 14B-AWQ  (~9 GB, GPU 1)   ToT / complex reasoning
 *   SGLANG_HEAVY_URL   — Night-shift 32B-AWQ (~18 GB, GPU 2)  offline STN + KG jobs
 *                      (single GPU — no tensor-parallel needed vs old 35B FP on 2 GPUs)
 *
 * This service is a DROP-IN PEER to ollamaService.js — it exposes the same
 * interface so llmRouterService.js can switch between them with a flag.
 *
 * Guard: SGLANG_ENABLED must be 'true' in .env or all calls throw a clear error.
 * During migration, keep Ollama as fallback; flip SGLANG_ENABLED=true when ready.
 */

const log         = require('../utils/logger');
const OpenAI      = require('openai');
const sglangCaps  = require('./sglangCapabilities');

const SGLANG_ENABLED = process.env.SGLANG_ENABLED === 'true';

// ── Lazy-initialized clients per endpoint ────────────────────────────────────
let _chatClient   = null;
let _reasonClient = null;
let _heavyClient  = null;

function _getClient(type = 'chat') {
    if (!SGLANG_ENABLED) {
        throw new Error('[SGLang] SGLANG_ENABLED=false. Set SGLANG_ENABLED=true in .env when SGLang is deployed.');
    }

    const urlMap = {
        chat:   process.env.SGLANG_CHAT_URL   || 'http://localhost:8000/v1',
        reason: process.env.SGLANG_REASON_URL || 'http://localhost:8000/v1',
        heavy:  process.env.SGLANG_HEAVY_URL  || 'http://localhost:8000/v1',
    };

    const baseURL = urlMap[type] || urlMap.chat;

    // SGLang doesn't require an API key but the OpenAI SDK mandates one — use dummy
    const opts = { baseURL, apiKey: 'sglang-no-auth', timeout: 300_000 };

    if (type === 'chat')   return _chatClient   || (_chatClient   = new OpenAI(opts));
    if (type === 'reason') return _reasonClient || (_reasonClient = new OpenAI(opts));
    if (type === 'heavy')  return _heavyClient  || (_heavyClient  = new OpenAI(opts));

    return new OpenAI(opts);
}

// ── Format history for OpenAI messages array ─────────────────────────────────
function _formatHistory(chatHistory = [], systemPrompt = null) {
    const messages = [];
    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    for (const msg of chatHistory) {
        messages.push({
            role:    msg.role === 'model' ? 'assistant' : 'user',
            content: msg.parts?.[0]?.text || msg.content || '',
        });
    }
    return messages;
}

/**
 * Generate a response (non-streaming).
 * Interface matches ollamaService.generateContentWithHistory.
 *
 * @param {Array}   chatHistory     - Message history [{ role, parts[{text}] }]
 * @param {string}  userQuery       - Current user message
 * @param {string}  systemPrompt    - System prompt (optional)
 * @param {object}  options         - { model, maxTokens, temperature, endpoint: 'chat'|'reason'|'heavy' }
 * @returns {Promise<string>} The assistant's response text
 */
async function generateContentWithHistory(chatHistory, userQuery, systemPrompt = null, options = {}) {
    const endpoint = options.endpoint || 'chat';
    const model    = options.model
        || (endpoint === 'heavy'  ? process.env.SGLANG_HEAVY_MODEL  : null)
        || (endpoint === 'reason' ? process.env.SGLANG_REASON_MODEL : null)
        || process.env.SGLANG_CHAT_MODEL
        || 'Qwen/Qwen2.5-14B-Instruct';

    const client   = _getClient(endpoint);
    const messages = _formatHistory(chatHistory, systemPrompt);
    messages.push({ role: 'user', content: userQuery });

    // Estimate input tokens and adjust maxTokens to prevent context overflow
    const allMessagesText = messages.map(m => m.content).join(' ');
    const estimatedInputTokens = Math.ceil(allMessagesText.length / 3.5); // ~3.5 chars/token for Qwen
    const modelMaxContext = sglangCaps.getModelMaxContext(); // live from /v1/models
    const safetyBuffer = 256;
    const availableForCompletion = Math.max(512, modelMaxContext - estimatedInputTokens - safetyBuffer);
    const maxTokens = Math.min(options.maxTokens || 4096, availableForCompletion);

    log.info('AI', `[SGLang] generate → endpoint=${endpoint} model=${model}`);
    log.info('AI', `[SGLang] Token budget: input≈${estimatedInputTokens} + completion=${maxTokens} ≈ ${estimatedInputTokens + maxTokens} / ${modelMaxContext}`);

    try {
        const completion = await client.chat.completions.create({
            model,
            messages,
            max_tokens:  maxTokens,
            temperature: options.temperature || 0.7,
            stream:      false,
        });

        const text = completion.choices?.[0]?.message?.content?.trim() || '';
        log.success('AI', `[SGLang] response received (${text.length} chars)`);
        return text;

    } catch (err) {
        log.error('AI', `[SGLang] generate failed: ${err.message}`);
        const enhanced = new Error(`SGLang error: ${err.message}`);
        enhanced.status = err.status || 503;
        throw enhanced;
    }
}

/**
 * Streaming generation.
 * Yields tokens via onToken callback, same interface as ollamaService.streamChat.
 *
 * @param {Array}    chatHistory
 * @param {string}   userQuery
 * @param {string}   systemPrompt
 * @param {object}   options       - { model, maxTokens, temperature, endpoint }
 * @param {Function} onToken       - Called with each token string or event object
 * @returns {Promise<{ finalAnswer: string }>}
 */
async function streamChat(chatHistory, userQuery, systemPrompt = null, options = {}, onToken = null) {
    const endpoint = options.endpoint || 'chat';
    const model    = options.model
        || (endpoint === 'reason' ? process.env.SGLANG_REASON_MODEL : null)
        || process.env.SGLANG_CHAT_MODEL
        || 'Qwen/Qwen2.5-14B-Instruct';

    const client   = _getClient(endpoint);
    const messages = _formatHistory(chatHistory, systemPrompt);
    messages.push({ role: 'user', content: userQuery });

    log.info('AI', `[SGLang] stream → endpoint=${endpoint} model=${model}`);

    // Compute safe token budget to avoid exceeding the model's 8192-token context window
    const allText = messages.map(m => m.content).join(' ');
    const estimatedInputTokens = Math.ceil(allText.length / 3.5);
    const modelMaxContext = 8192;
    const safetyBuffer = 256;
    const availableForCompletion = Math.max(512, modelMaxContext - estimatedInputTokens - safetyBuffer);
    const maxTokensForStream = Math.min(options.maxTokens || 4096, availableForCompletion);

    const chunks   = [];
    const stream   = await client.chat.completions.create({
        model,
        messages,
        max_tokens:  maxTokensForStream,
        temperature: options.temperature || 0.7,
        stream:      true,
    });

    for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
            chunks.push(delta);
            if (typeof onToken === 'function') {
                onToken({ type: 'token', content: delta });
            }
        }
    }

    const finalAnswer = chunks.join('');
    log.success('AI', `[SGLang] stream complete (${finalAnswer.length} chars)`);
    return { finalAnswer };
}

/**
 * Check SGLang endpoint health (ping /models).
 *
 * @param {'chat'|'reason'|'heavy'} endpoint
 * @returns {Promise<boolean>}
 */
async function checkHealth(endpoint = 'chat') {
    if (!SGLANG_ENABLED) return false;
    try {
        const client = _getClient(endpoint);
        await client.models.list();
        return true;
    } catch (e) {
        log.warn('AI', `[SGLang] Health check failed for endpoint=${endpoint}: ${e.message}`);
        return false;
    }
}

module.exports = {
    generateContentWithHistory,
    streamChat,
    checkHealth,
    SGLANG_ENABLED,
};
