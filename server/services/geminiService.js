const log = require('../utils/logger');
// server/services/geminiService.js
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const tokenOptimizer = require('../utils/tokenOptimizer');

const SECONDARY_API_KEY = process.env.GEMINI_API_KEY;
const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-2.0-flash";

const DEFAULT_MAX_OUTPUT_TOKENS_CHAT = 8192;
const DEFAULT_MAX_OUTPUT_TOKENS_KG = 8192;

const baseSafetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

async function generateContentWithHistory(
    chatHistory,
    currentUserQuery,
    systemPromptText = null,
    options = {} // Now accepts { model, maxOutputTokens, apiKey }
) {
    const apiKeyToUse = options.apiKey || SECONDARY_API_KEY;
    let modelNameToUse = options.geminiModel || options.model || process.env.GEMINI_MODEL || MODEL_NAME;
    const originalName = modelNameToUse; // Keep the original name for potential retry

    // Ensure model name is correctly formatted
    if (modelNameToUse && !modelNameToUse.startsWith('models/')) {
        modelNameToUse = `models/${modelNameToUse}`;
    }

    if (!apiKeyToUse) {
        log.error('AI', "Gemini API key is not available.", null, "Check environment variables or user settings");
        throw new Error("Gemini API key is missing. Please configure it.");
    }

    try {
        const genAI = new GoogleGenerativeAI(apiKeyToUse);

        if (typeof currentUserQuery !== 'string' || currentUserQuery.trim() === '') {
            throw new Error("currentUserQuery must be a non-empty string.");
        }

        const optimizedSystemPrompt = tokenOptimizer.minifyPrompt(tokenOptimizer.injectSystemInstruction(systemPromptText));
        const optimizedQuery = tokenOptimizer.minifyPrompt(currentUserQuery);
        const optimizedHistory = tokenOptimizer.optimizeIncomingMessages(chatHistory || []);

        const generationConfig = {
            temperature: 0.7,
            maxOutputTokens: options.maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS_CHAT,
        };

        const model = genAI.getGenerativeModel({
            model: modelNameToUse,
            systemInstruction: { parts: [{ text: optimizedSystemPrompt }] },
            safetySettings: baseSafetySettings,
        });

        const historyForStartChat = optimizedHistory
            .map(msg => ({
                role: msg.role,
                parts: Array.isArray(msg.parts) ? msg.parts.map(part => ({ text: part.text || '' })) : [{ text: msg.text || '' }]
            }))
            .filter(msg => msg.role && msg.parts && msg.parts.length > 0 && typeof msg.parts[0].text === 'string');

        const chat = model.startChat({
            history: historyForStartChat,
            generationConfig: generationConfig,
        });

        // log.info('AI', `Gemini request initiated (history: ${historyForStartChat.length})`);

        const result = await chat.sendMessage(optimizedQuery);

        const response = result.response;
        const candidate = response?.candidates?.[0];

        if (candidate && (candidate.finishReason === 'STOP' || candidate.finishReason === 'MAX_TOKENS')) {
            const responseText = candidate?.content?.parts?.[0]?.text || "";
            if (candidate.finishReason === 'MAX_TOKENS') {
                log.warn('AI', "Gemini response was truncated due to token limit.");
            }
            const expandedResponse = tokenOptimizer.expandOutgoingResponse(responseText);
            log.success('AI', `Gemini response received (${responseText.length} chars, expanded to ${expandedResponse.length} chars)`);
            return expandedResponse;
        } else {
            const finishReason = candidate?.finishReason || 'UNKNOWN';
            const safetyRatings = candidate?.safetyRatings;
            log.warn('AI', `Gemini response issues: ${finishReason}`);
            let blockMessage = `AI response generation failed or was blocked.`;
            if (finishReason === 'SAFETY') {
                blockMessage += ` Reason: SAFETY.`;
                if (safetyRatings) {
                    const blockedCategories = safetyRatings.filter(r => r.blocked).map(r => r.category).join(', ');
                    if (blockedCategories) blockMessage += ` Blocked Categories: ${blockedCategories}.`;
                }
            } else if (finishReason) {
                blockMessage += ` Reason: ${finishReason}.`;
            }
            const error = new Error(blockMessage);
            error.status = 400;
            throw error;
        }
    } catch (error) {
        const status = error.status || 500;
        const msg = error?.message?.toLowerCase() || '';
        const reason =
            (status === 401 || msg.includes('api key not valid') || msg.includes('invalid') || msg.includes('unauthorized')) ? 'API key is invalid or unauthorized' :
                (status === 429 || msg.includes('rate limit') || msg.includes('quota')) ? 'API quota exceeded or rate limit reached' :
                    (status === 403) ? 'Access denied — API key lacks permissions' :
                        (msg.includes('overloaded') || status === 503) ? 'Service temporarily overloaded' :
                            (msg.includes('not found') || status === 404) ? 'AI model not found or unavailable' :
                                'Unexpected error';
        log.warn('AI', `Gemini call failed: ${reason}`);

        // Pass through the actual error message for better diagnostics
        let clientMessage = error.message || "Failed to get response from AI service.";

        // Simplified mapping, but prioritizing the real error
        if (error.message?.includes("API key not valid")) clientMessage = "Invalid Gemini API Key.";
        else if (error.message?.includes("model is overloaded")) clientMessage = "Gemini service is currently overloaded. Please wait a few moments.";

        const enhancedError = new Error(clientMessage);
        enhancedError.status = error.status || 500;
        enhancedError.originalError = error;
        throw enhancedError;
    }
};

/**
 * Generate text using Gemini (for analysis, no chat history)
 * @param {string} prompt - The prompt to send
 * @param {object} config - LLM configuration
 * @returns {Promise<string>} Generated text
 */
const generateText = async (prompt, config = {}) => {
    try {
        const apiKey = config.apiKey || process.env.GEMINI_API_KEY;
        const modelName = config.geminiModel || process.env.GEMINI_MODEL || MODEL_NAME;

        if (!apiKey) {
            throw new Error('Gemini API key is required');
        }

        const genAI = new GoogleGenerativeAI(apiKey);
        const optimizedSystemPrompt = tokenOptimizer.injectSystemInstruction(config.systemPrompt);
        const model = genAI.getGenerativeModel({
            model: modelName,
            systemInstruction: optimizedSystemPrompt
        });

        // log.info('AI', `Gemini text generation request (model: ${modelName})`);

        const optimizedPrompt = tokenOptimizer.minifyPrompt(prompt);
        const result = await model.generateContent(optimizedPrompt);
        const response = result.response;
        const text = response.text();

        return tokenOptimizer.expandOutgoingResponse(text);
    } catch (error) {
        log.error('AI', `Gemini generateText error: ${error.message}`, error);
        const enhancedError = new Error('Failed to generate text from AI service.');
        enhancedError.status = error.status || 500;
        enhancedError.originalError = error;
        throw enhancedError;
    }
};

/**
 * Generate content with vision (image analysis) using Gemini
 * Accepts image data as base64 or buffer and sends it alongside text to a vision-capable model.
 * @param {string} textPrompt - The text prompt / question about the image
 * @param {Object} imageData - { mimeType: 'image/png'|'image/jpeg', data: <base64 string> }
 * @param {Object} options - { model, apiKey, maxOutputTokens, systemPrompt }
 * @returns {Promise<string>} Generated text response
 */
const generateContentWithVision = async (textPrompt, imageData, options = {}) => {
    const apiKeyToUse = options.apiKey || SECONDARY_API_KEY;
    const modelNameToUse = options.model || process.env.GEMINI_VISION_MODEL || process.env.GEMINI_MODEL || MODEL_NAME;

    if (!apiKeyToUse) {
        throw new Error("Gemini API key is missing for vision request.");
    }

    if (!imageData || !imageData.mimeType || !imageData.data) {
        throw new Error("imageData must include { mimeType, data } for vision requests.");
    }

    try {
        const genAI = new GoogleGenerativeAI(apiKeyToUse);

        const optimizedSystemPrompt = tokenOptimizer.minifyPrompt(tokenOptimizer.injectSystemInstruction(options.systemPrompt));
        const optimizedTextPrompt = tokenOptimizer.minifyPrompt(textPrompt);

        const model = genAI.getGenerativeModel({
            model: modelNameToUse.startsWith('models/') ? modelNameToUse : `models/${modelNameToUse}`,
            systemInstruction: { parts: [{ text: optimizedSystemPrompt }] },
            safetySettings: baseSafetySettings,
        });

        const parts = [
            { text: optimizedTextPrompt },
            {
                inlineData: {
                    mimeType: imageData.mimeType,
                    data: imageData.data // base64-encoded image
                }
            }
        ];

        const result = await model.generateContent({ contents: [{ role: 'user', parts }] });
        const response = result.response;
        const candidate = response?.candidates?.[0];

        if (candidate && (candidate.finishReason === 'STOP' || candidate.finishReason === 'MAX_TOKENS')) {
            const responseText = candidate?.content?.parts?.[0]?.text || "";
            const expandedResponse = tokenOptimizer.expandOutgoingResponse(responseText);
            log.success('AI', `Gemini Vision response received (${responseText.length} chars, expanded to ${expandedResponse.length})`);
            return expandedResponse;
        } else {
            const finishReason = candidate?.finishReason || 'UNKNOWN';
            throw new Error(`Gemini Vision response blocked or failed. Reason: ${finishReason}`);
        }
    } catch (error) {
        log.error('AI', `Gemini Vision error: ${error.message}`, error);
        const enhancedError = new Error(error.message || 'Failed to analyze image with AI service.');
        enhancedError.status = error.status || 500;
        enhancedError.originalError = error;
        throw enhancedError;
    }
};

module.exports = {
    generateContentWithHistory,
    generateText,
    generateContentWithVision,
    DEFAULT_MAX_OUTPUT_TOKENS_KG
}