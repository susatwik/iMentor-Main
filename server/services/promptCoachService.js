// server/services/promptCoachService.js
const geminiService = require('./geminiService');
const ollamaService = require('./ollamaService');
const groqService = require('./groqService');
const { PROMPT_COACH_TEMPLATE } = require('../config/promptTemplates');
const User = require('../models/User');
const { decrypt } = require('../utils/crypto');
const { resolveProviderByPreference } = require('./providerPriorityService');

const COACH_GEMINI_MODEL = process.env.PROMPT_COACH_GEMINI_MODEL || 'gemini-2.0-flash';
const COACH_OLLAMA_MODEL = process.env.PROMPT_COACH_OLLAMA_MODEL || 'phi3:instruct';
const COACH_GROQ_MODEL = process.env.PROMPT_COACH_GROQ_MODEL || 'llama-3.1-8b-instant';

/**
 * Analyzes a user's prompt using a lightweight, fast LLM based on their preference.
 * @param {string} userId - The ID of the user requesting the analysis.
 * @param {string} userPrompt - The raw prompt text from the user.
 * @returns {Promise<{improvedPrompt: string, explanation: string}>} The analyzed result.
 */
async function analyzePrompt(userId, userPrompt) {

    const user = await User.findById(userId).select('+encryptedApiKey preferredLlmProvider ollamaUrl apiKeyRequestStatus');

    if (!user) {
        throw new Error("User not found.");
    }

    if (user?.preferredLlmProvider === 'gemini' && user?.apiKeyRequestStatus === 'pending' && !user?.encryptedApiKey) {
        throw new Error('Your API key request is pending approval.');
    }


    const { preferredLlmProvider, ollamaUrl } = user;
    const userApiKey = user.encryptedApiKey ? decrypt(user.encryptedApiKey) : null;

    const providerResolution = await resolveProviderByPreference({
        preferredProvider: preferredLlmProvider,
        userApiKey,
        userOllamaUrl: ollamaUrl,
    });
    const activeProvider = providerResolution.chosenProvider;
    const promptForLlm = PROMPT_COACH_TEMPLATE.replace('{userPrompt}', userPrompt);

    let responseText;
    let llmOptions = {};

    console.log(`[PromptCoachService] Analyzing prompt for user ${userId} using provider: ${activeProvider} (preferred: ${preferredLlmProvider})`);

    try {
        if (activeProvider === 'ollama') {
            llmOptions = {
                model: COACH_OLLAMA_MODEL,
                ollamaUrl: providerResolution.workingOllamaUrl || ollamaUrl
            };
            responseText = await ollamaService.generateContentWithHistory([], promptForLlm, null, llmOptions);
        } else if (activeProvider === 'groq') {
            const apiKey = providerResolution.apiKey;
            llmOptions = {
                model: COACH_GROQ_MODEL,
                apiKey: apiKey
            };
            responseText = await groqService.generateContentWithHistory([], promptForLlm, null, llmOptions);
        } else { // Default to Gemini
            const apiKey = providerResolution.apiKey;

            if (!apiKey) {
                throw new Error("User has selected Gemini but has no API key configured (and no system default).");
            }
            llmOptions = {
                model: COACH_GEMINI_MODEL,
                apiKey: apiKey
            };
            // Note: The geminiService itself will use the correct model name.
            responseText = await geminiService.generateContentWithHistory([], promptForLlm, null, llmOptions);
        }

        // --- JSON Parsing Logic ---
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error("AI response did not contain a valid JSON object.");
        }
        const jsonString = jsonMatch[0];
        const parsedResponse = JSON.parse(jsonString);

        if (!parsedResponse.improvedPrompt || !parsedResponse.explanation) {
            throw new Error("AI response JSON is missing required 'improvedPrompt' or 'explanation' keys.");
        }

        return parsedResponse;

    } catch (error) {
        console.error(`[PromptCoachService] Error during prompt analysis: ${error.message}`);
        // Re-throw a user-friendly error
        throw new Error(`The AI Coach failed to analyze the prompt. ${error.message}`);
    }
}

module.exports = {
    analyzePrompt
};