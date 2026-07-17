const log = require('../utils/logger');
const axios = require('axios');

const SERVER_API_KEY = process.env.OPENAI_API_KEY;
const DEFAULT_MODEL = 'gpt-4o';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

/**
 * Generate chat completion with history using OpenAI.
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
        log.error('AI', 'OpenAI API key is not configured.');
        throw new Error('OpenAI API key is missing. Please configure OPENAI_API_KEY.');
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
        const response = await axios.post(OPENAI_API_URL, {
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
            (status === 401 || msg.includes('invalid') || msg.includes('unauthorized')) ? 'API key is invalid or unauthorized' :
            (status === 429 || msg.includes('rate limit') || msg.includes('quota')) ? 'Rate limit or quota exceeded' :
            (status === 403) ? 'Access denied — API key lacks permissions' :
            'Unexpected error';
        log.warn('AI', `OpenAI failure: ${reason}`);
        throw new Error(`OpenAI API failure: ${error.message}`);
    }
}

/**
 * Generate single text completion using OpenAI.
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
