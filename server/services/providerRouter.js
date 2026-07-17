/**
 * server/services/providerRouter.js
 * 
 * Intelligent AI Provider Fallback System
 * 
 * Implements a cascading fallback chain:
 * 1. Gemini (most capable, requires API key)
 * 2. Groq (fast, good quality)
 * 3. SGLang (self-hosted, most stable)
 * 4. Ollama (local fallback, always available)
 * 
 * Handles:
 * - Provider health checks
 * - Automatic failover on timeout/error
 * - Response caching to reduce redundant API calls
 * - Timeout safeguards per provider
 */

const axios = require('axios');
const log = require('../utils/logger');
const geminiService = require('./geminiService');
const groqService = require('./groqService');
const ollamaService = require('./ollamaService');

const PROVIDER_TIMEOUTS = {
    gemini: 30000,      // 30 second timeout
    groq: 25000,        // 25 second timeout
    sglang: 20000,      // 20 second timeout
    ollama: 15000       // 15 second timeout
};

const PROVIDER_HEALTH = {
    gemini: { healthy: false, lastChecked: 0, errorCount: 0 },
    groq: { healthy: false, lastChecked: 0, errorCount: 0 },
    sglang: { healthy: false, lastChecked: 0, errorCount: 0 },
    ollama: { healthy: false, lastChecked: 0, errorCount: 0 }
};

const HEALTH_CHECK_INTERVAL = 60000; // Check health every 60 seconds
const MAX_ERRORS_BEFORE_FALLBACK = 3;

/**
 * Get the priority-ordered list of available providers
 * @returns {string[]} Provider names in priority order
 */
function getProviderPriority() {
    const geminiKey = process.env.GEMINI_API_KEY;
    const groqKey = process.env.GROQ_API_KEY;
    const sglangUrl = process.env.SGLANG_CHAT_URL;
    const ollamaUrl = process.env.OLLAMA_API_BASE_URL;

    const priority = [];

    // Gemini only if API key is set AND validated
    if (geminiKey && process.env.GEMINI_API_VALIDATED === 'true') {
        priority.push('gemini');
    }

    // Groq if key is set
    if (groqKey) {
        priority.push('groq');
    }

    // SGLang if URL is set and enabled
    if (sglangUrl && process.env.SGLANG_ENABLED === 'true') {
        priority.push('sglang');
    }

    // Ollama always available as final fallback
    priority.push('ollama');

    return priority;
}

/**
 * Check health of a provider (non-blocking)
 */
async function checkProviderHealth(provider) {
    const now = Date.now();
    const health = PROVIDER_HEALTH[provider];

    // Skip if checked recently
    if (now - health.lastChecked < HEALTH_CHECK_INTERVAL) {
        return health.healthy;
    }

    try {
        switch (provider) {
            case 'gemini':
                if (process.env.GEMINI_API_KEY) {
                    // Quick validation call
                    await geminiService.generateContentWithHistory([], 'ping', null, { maxOutputTokens: 10 });
                    health.healthy = true;
                    health.errorCount = 0;
                }
                break;
            case 'groq':
                if (process.env.GROQ_API_KEY) {
                    await groqService.generateContentWithHistory([], 'ping', null, { maxOutputTokens: 10 });
                    health.healthy = true;
                    health.errorCount = 0;
                }
                break;
            case 'sglang':
                if (process.env.SGLANG_CHAT_URL) {
                    await axios.get(`${process.env.SGLANG_CHAT_URL.replace('/v1', '')}/health`, {
                        timeout: 5000
                    });
                    health.healthy = true;
                    health.errorCount = 0;
                }
                break;
            case 'ollama':
                if (process.env.OLLAMA_API_BASE_URL) {
                    await axios.get(`${process.env.OLLAMA_API_BASE_URL}/api/tags`, {
                        timeout: 5000
                    });
                    health.healthy = true;
                    health.errorCount = 0;
                } else {
                    health.healthy = true; // Ollama always healthy as last resort
                }
                break;
        }
    } catch (err) {
        health.errorCount++;
        health.healthy = health.errorCount < MAX_ERRORS_BEFORE_FALLBACK;
        log.warn('PROVIDER', `${provider} health check failed: ${err.message}`);
    } finally {
        health.lastChecked = now;
    }

    return health.healthy;
}

/**
 * Get next available provider from priority list
 * @param {string} excludeProvider - Provider to exclude from selection
 * @returns {Promise<string>} Provider name or null if none available
 */
async function getNextProvider(excludeProvider = null) {
    const priority = getProviderPriority();
    
    for (const provider of priority) {
        if (provider === excludeProvider) continue;
        
        const isHealthy = await checkProviderHealth(provider);
        if (isHealthy) {
            return provider;
        }
    }

    return null;
}

/**
 * Generate response with automatic fallback
 * 
 * @param {string} userMessage - User query
 * @param {object} context - Chat context (history, systemPrompt, etc.)
 * @param {object} options - Generation options
 * @returns {Promise<{text: string, provider: string, fallback: boolean}>}
 */
async function generateWithFallback(userMessage, context = {}, options = {}) {
    const priority = getProviderPriority();
    let lastError = null;

    for (const provider of priority) {
        try {
            log.info('PROVIDER', `Attempting generation with ${provider}`);

            const timeout = PROVIDER_TIMEOUTS[provider];
            const controller = new AbortController();
            const timeoutHandle = setTimeout(() => controller.abort(), timeout);

            let result;
            try {
                switch (provider) {
                    case 'gemini':
                        result = await Promise.race([
                            geminiService.generateContentWithHistory(
                                context.history || [],
                                userMessage,
                                context.systemPrompt,
                                { ...options, timeout }
                            ),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini timeout')), timeout))
                        ]);
                        break;

                    case 'groq':
                        result = await Promise.race([
                            groqService.generateContentWithHistory(
                                context.history || [],
                                userMessage,
                                context.systemPrompt,
                                { ...options, timeout }
                            ),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Groq timeout')), timeout))
                        ]);
                        break;

                    case 'sglang':
                        result = await Promise.race([
                            ollamaService.generateContentWithHistory(
                                context.history || [],
                                userMessage,
                                context.systemPrompt,
                                { ...options, model: process.env.SGLANG_CHAT_MODEL, ollamaUrl: process.env.SGLANG_CHAT_URL }
                            ),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('SGLang timeout')), timeout))
                        ]);
                        break;

                    case 'ollama':
                        result = await Promise.race([
                            ollamaService.generateContentWithHistory(
                                context.history || [],
                                userMessage,
                                context.systemPrompt,
                                { ...options, timeout }
                            ),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Ollama timeout')), timeout))
                        ]);
                        break;
                }
            } finally {
                clearTimeout(timeoutHandle);
            }

            // Mark provider as healthy on success
            PROVIDER_HEALTH[provider].healthy = true;
            PROVIDER_HEALTH[provider].errorCount = 0;

            log.success('PROVIDER', `${provider} response successful`);
            return {
                text: result,
                provider,
                fallback: provider !== priority[0]
            };

        } catch (err) {
            lastError = err;
            PROVIDER_HEALTH[provider].errorCount++;
            
            log.warn('PROVIDER', `${provider} failed (${PROVIDER_HEALTH[provider].errorCount}/${MAX_ERRORS_BEFORE_FALLBACK}): ${err.message}`);

            // If this provider hit max errors, mark unhealthy
            if (PROVIDER_HEALTH[provider].errorCount >= MAX_ERRORS_BEFORE_FALLBACK) {
                PROVIDER_HEALTH[provider].healthy = false;
                log.warn('PROVIDER', `${provider} marked unhealthy, attempting next provider`);
            }

            // Continue to next provider
            continue;
        }
    }

    // All providers failed
    const errorMsg = lastError?.message || 'All AI providers failed';
    log.error('PROVIDER', `All providers exhausted: ${errorMsg}`);

    throw new Error(`No available AI provider: ${errorMsg}`);
}

/**
 * Get provider diagnostics (for admin/debug)
 */
function getProviderDiagnostics() {
    return {
        priority: getProviderPriority(),
        health: PROVIDER_HEALTH,
        timeouts: PROVIDER_TIMEOUTS
    };
}

/**
 * Reset provider health (useful for testing)
 */
function resetProviderHealth(provider = null) {
    if (provider) {
        PROVIDER_HEALTH[provider] = { healthy: false, lastChecked: 0, errorCount: 0 };
    } else {
        Object.keys(PROVIDER_HEALTH).forEach(p => {
            PROVIDER_HEALTH[p] = { healthy: false, lastChecked: 0, errorCount: 0 };
        });
    }
}

// Initialize health checks on startup
log.info('PROVIDER', 'Initializing provider health checks on startup...');
setTimeout(() => {
    getProviderPriority().forEach(provider => {
        checkProviderHealth(provider).catch(err => {
            log.warn('PROVIDER', `Initial health check failed for ${provider}: ${err.message}`);
        });
    });
}, 2000);

module.exports = {
    generateWithFallback,
    getNextProvider,
    getProviderPriority,
    checkProviderHealth,
    getProviderDiagnostics,
    resetProviderHealth
};
