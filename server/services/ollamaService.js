/**
 * Ollama Service
 * Direct HTTP calls to Ollama's API for local LLM generation.
 */
const axios = require('axios');
const log = require('../utils/logger');

function resolveOllamaUrl(providedUrl) {
    return providedUrl
        || process.env.OLLAMA_URL
        || process.env.OLLAMA_API_BASE_URL
        || `http://localhost:${process.env.OLLAMA_PORT || 11434}`;
}

function resolveOllamaModel(options = {}) {
    return options.model
        || process.env.OLLAMA_MODEL
        || process.env.OLLAMA_DEFAULT_MODEL
        || 'qwen2.5-coder:7b';
}

async function generateContentWithHistory(chatHistory, currentUserQuery, systemPromptText = null, options = {}) {
    const baseUrl = resolveOllamaUrl(options.ollamaUrl).replace(/\/+$/, '');
    const model = resolveOllamaModel(options);
    const timeout = options.timeout || 30000;

    const messages = [];
    if (systemPromptText) {
        messages.push({ role: 'system', content: systemPromptText });
    }
    if (Array.isArray(chatHistory)) {
        for (const msg of chatHistory) {
            const role = msg.role === 'model' ? 'assistant' : (msg.role || 'user');
            const content = Array.isArray(msg.parts) ? msg.parts[0].text : (msg.text || msg.content || '');
            if (role && content) messages.push({ role, content });
        }
    }
    messages.push({ role: 'user', content: currentUserQuery });

    const resp = await axios.post(`${baseUrl}/api/chat`, {
        model,
        messages,
        stream: false,
        options: {
            temperature: options.temperature ?? 0.7,
            num_predict: options.maxOutputTokens ?? 4096,
        }
    }, { timeout });

    return resp.data?.message?.content || '';
}

async function streamChat(chatHistory, currentUserQuery, systemPromptText = null, options = {}, onToken) {
    const baseUrl = resolveOllamaUrl(options.ollamaUrl).replace(/\/+$/, '');
    const model = resolveOllamaModel(options);
    const timeout = options.timeout || 30000;

    const messages = [];
    if (systemPromptText) messages.push({ role: 'system', content: systemPromptText });
    if (Array.isArray(chatHistory)) {
        for (const msg of chatHistory) {
            const role = msg.role === 'model' ? 'assistant' : (msg.role || 'user');
            const content = Array.isArray(msg.parts) ? msg.parts[0].text : (msg.text || msg.content || '');
            if (role && content) messages.push({ role, content });
        }
    }
    messages.push({ role: 'user', content: currentUserQuery });

    const resp = await axios.post(`${baseUrl}/api/chat`, {
        model,
        messages,
        stream: false,
        options: {
            temperature: options.temperature ?? 0.7,
            num_predict: options.maxOutputTokens ?? 4096,
        }
    }, { timeout });

    const text = resp.data?.message?.content || '';
    if (onToken && typeof onToken === 'function') {
        onToken({ type: 'token', content: text });
    }
    return text;
}

async function checkHealth() {
    try {
        const url = resolveOllamaUrl().replace(/\/+$/, '');
        const resp = await axios.get(`${url}/api/tags`, { timeout: 3000 });
        return resp.status === 200 && Array.isArray(resp.data?.models);
    } catch {
        return false;
    }
}

module.exports = {
    generateContentWithHistory,
    generateContent: (prompt, options = {}) =>
        generateContentWithHistory([], prompt, null, options),
    streamChat,
    checkHealth,
};
