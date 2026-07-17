const log = require('../utils/logger');
const axios = require('axios');

const SERVER_API_KEY = process.env.ANTHROPIC_API_KEY;
const DEFAULT_MODEL = 'claude-3-sonnet-20240229';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

/**
 * Generate chat completion with history using Anthropic Claude.
 * @param {Array} chatHistory - Previous messages
 * @param {string} currentUserQuery - Current message
 * @param {string} systemPromptText - Optional system prompt
 * @param {object} options - Options including model, maxOutputTokens, apiKey
 * @returns {Promise<string>} Generated response
 */
async function generateContentWithHistory(
    chatHistory,
    currentUserQuery,
    systemPromptText = null,
    options = {}
) {
    const apiKeyToUse = options.apiKey || SERVER_API_KEY;
    const modelToUse = options.model || DEFAULT_MODEL;

    if (!apiKeyToUse) {
        log.error('AI', 'Anthropic API key is not configured.');
        throw new Error('Anthropic API key is missing. Please configure ANTHROPIC_API_KEY.');
    }

    const messages = [];

    if (chatHistory && Array.isArray(chatHistory)) {
        chatHistory.forEach(msg => {
            const role = msg.role === 'model' ? 'assistant' : msg.role;
            const content = Array.isArray(msg.parts) ? msg.parts[0].text : (msg.text || msg.content);
            if ((role === 'user' || role === 'assistant') && content) {
                messages.push({ role, content });
            }
        });
    }

    messages.push({ role: 'user', content: currentUserQuery });

    const body = {
        model: modelToUse,
        max_tokens: options.maxOutputTokens || 4096,
        messages
    };

    if (systemPromptText) {
        body.system = systemPromptText;
    }

    try {
        const response = await axios.post(ANTHROPIC_API_URL, body, {
            headers: {
                'x-api-key': apiKeyToUse,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            },
            timeout: 60000
        });

        return response.data?.content?.[0]?.text || '';
    } catch (error) {
        const status = error.response?.status || 500;
        const msg = error.message?.toLowerCase() || '';
        const reason =
            (status === 401 || msg.includes('invalid') || msg.includes('unauthorized')) ? 'API key is invalid or unauthorized' :
            (status === 429 || msg.includes('rate limit') || msg.includes('overloaded')) ? 'Rate limit or quota exceeded' :
            (status === 403) ? 'Access denied — API key lacks permissions' :
            'Unexpected error';
        log.warn('AI', `Claude failure: ${reason}`);
        throw new Error(`Claude API failure: ${error.message}`);
    }
}

/**
 * Generate single text completion using Claude.
 * @param {string} prompt - The prompt to send
 * @param {object} config - Configuration including model, apiKey
 * @returns {Promise<string>} Generated text
 */
async function generateText(prompt, config = {}) {
    return generateContentWithHistory([], prompt, null, config);
}

module.exports = {
    generateContentWithHistory,
    generateText
};
