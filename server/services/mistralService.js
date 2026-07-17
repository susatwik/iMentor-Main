// mistralService — Mistral AI via REST API
// Follows the same interface as groqService/claudeService
const log = require('../utils/logger');
const axios = require('axios');

const SERVER_API_KEY = process.env.MISTRAL_API_KEY;
const DEFAULT_MODEL = 'mistral-large-latest';
const MISTRAL_API_URL = 'https://api.mistral.ai/v1/chat/completions';

async function generateContentWithHistory(
    chatHistory,
    currentUserQuery,
    systemPromptText = null,
    options = {}
) {
    const apiKeyToUse = options.apiKey || SERVER_API_KEY;
    const modelToUse = options.model || DEFAULT_MODEL;

    if (!apiKeyToUse) {
        log.error('AI', 'Mistral API key is not configured.');
        throw new Error('Mistral API key is missing. Please configure MISTRAL_API_KEY.');
    }

    const messages = [];

    if (systemPromptText) {
        messages.push({ role: 'system', content: systemPromptText });
    }

    if (chatHistory && Array.isArray(chatHistory)) {
        chatHistory.forEach(msg => {
            const role = msg.role === 'model' ? 'assistant' : msg.role;
            const content = Array.isArray(msg.parts) ? msg.parts[0].text : (msg.text || msg.content);
            if (role && content) {
                messages.push({ role, content });
            }
        });
    }

    messages.push({ role: 'user', content: currentUserQuery });

    try {
        const response = await axios.post(MISTRAL_API_URL, {
            model: modelToUse,
            messages,
            max_tokens: options.maxOutputTokens || 4096,
            temperature: options.temperature || 0.7
        }, {
            headers: {
                'Authorization': `Bearer ${apiKeyToUse}`,
                'Content-Type': 'application/json'
            },
            timeout: 60000
        });

        return response.data?.choices?.[0]?.message?.content || '';
    } catch (error) {
        const status = error.response?.status || 500;
        const msg = error.message?.toLowerCase() || '';
        const reason =
            (status === 401 || msg.includes('invalid') || msg.includes('unauthorized')) ? 'API key invalid or unauthorized' :
            (status === 429 || msg.includes('rate limit') || msg.includes('quota')) ? 'Rate limit or quota exceeded' :
            (status === 403) ? 'Access denied' :
            'Unexpected error';
        log.warn('AI', `Mistral failure: ${reason}`);
        throw new Error(`Mistral API failure: ${error.message}`);
    }
}

async function generateText(prompt, config = {}) {
    return generateContentWithHistory([], prompt, null, config);
}

module.exports = {
    generateContentWithHistory,
    generateText
};
