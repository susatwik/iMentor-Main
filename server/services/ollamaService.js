const axios = require('axios');

function getBaseUrl() {
    return process.env.OLLAMA_API_BASE_URL || `http://localhost:${process.env.OLLAMA_PORT || 11434}`;
}

function getDefaultModel() {
    return process.env.OLLAMA_DEFAULT_MODEL || 'qwen2.5-coder:7b';
}

async function checkHealth() {
    try {
        const resp = await axios.get(`${getBaseUrl()}/api/tags`, { timeout: 3000 });
        return resp.status === 200 && Array.isArray(resp.data?.models);
    } catch {
        return false;
    }
}

async function generateContent(chatHistory, currentQuery, systemPrompt, options = {}) {
    const model = options.model || getDefaultModel();
    const messages = [];
    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    if (Array.isArray(chatHistory)) {
        for (const msg of chatHistory) {
            const role = msg.role === 'assistant' ? 'assistant' : 'user';
            const content = msg.content || msg.text || '';
            if (content) messages.push({ role, content });
        }
    }
    if (currentQuery) {
        messages.push({ role: 'user', content: currentQuery });
    }

    try {
        const resp = await axios.post(`${getBaseUrl()}/api/chat`, {
            model,
            messages,
            stream: false,
            options: {
                temperature: options.temperature ?? 0.3,
                num_predict: options.maxOutputTokens ?? options.maxTokens ?? 4096,
            }
        }, { timeout: 300000 });

        return resp.data?.message?.content || '';
    } catch (err) {
        throw new Error(`Ollama error: ${err.message}`);
    }
}

const SGLANG_ENABLED = false;

module.exports = {
    generateContentWithHistory: generateContent,
    generateContent: (prompt, options = {}) =>
        generateContent([], typeof prompt === 'string' ? prompt : prompt.prompt, null, options),
    streamChat: () => { throw new Error('Ollama streaming not implemented in shim'); },
    checkHealth,
    SGLANG_ENABLED,
    DEFAULT_MAX_OUTPUT_TOKENS_OLLAMA_KG: 2000,
    DEFAULT_MAX_OUTPUT_TOKENS_OLLAMA: 2000,
};