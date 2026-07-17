/**
 * server/services/providerHealthMonitor.js
 * 
 * Tracks provider health metrics for intelligent routing:
 * - Success/failure counts
 * - Average latency
 * - Last success/failure timestamps
 * - Timeout counts
 * - Rate limit (429) counts
 * - Availability score
 * 
 * Automatically reduces priority of unhealthy providers
 */

const log = require('../utils/logger');
const { redisClient, isRedisConnected } = require('../config/redisClient');

const HEALTH_KEY_PREFIX = 'provider:health:';
const HEALTH_TTL = 86400 * 7; // 7 days

const DEFAULT_HEALTH = {
    totalRequests: 0,
    successCount: 0,
    failureCount: 0,
    timeoutCount: 0,
    rateLimitCount: 0,
    errorCount: 0,
    totalLatencyMs: 0,
    lastSuccess: null,
    lastFailure: null,
    lastError: null,
    availability: 1.0,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
};

const PROVIDERS = ['sglang', 'groq', 'gemini', 'openai', 'ollama', 'anthropic', 'mistral'];

function getHealthKey(provider) {
    return `${HEALTH_KEY_PREFIX}${provider}`;
}

async function loadHealth(provider) {
    if (!isRedisConnected()) return { ...DEFAULT_HEALTH };

    try {
        const data = await redisClient.get(getHealthKey(provider));
        if (data) {
            const parsed = JSON.parse(data);
            return { ...DEFAULT_HEALTH, ...parsed };
        }
    } catch (e) {
        log.warn('AI', `[HealthMonitor] Load failed for ${provider}: ${e.message}`);
    }
    return { ...DEFAULT_HEALTH };
}

async function saveHealth(provider, health) {
    if (!isRedisConnected()) return;

    try {
        await redisClient.setEx(getHealthKey(provider), HEALTH_TTL, JSON.stringify(health));
    } catch (e) {
        log.warn('AI', `[HealthMonitor] Save failed for ${provider}: ${e.message}`);
    }
}

async function recordSuccess(provider, latencyMs) {
    const health = await loadHealth(provider);
    health.totalRequests++;
    health.successCount++;
    health.totalLatencyMs += latencyMs;
    health.lastSuccess = new Date().toISOString();
    health.consecutiveSuccesses++;
    health.consecutiveFailures = 0;
    health.availability = calculateAvailability(health);
    await saveHealth(provider, health);
}

async function recordFailure(provider, error, latencyMs = 0) {
    const health = await loadHealth(provider);
    health.totalRequests++;
    health.failureCount++;
    health.totalLatencyMs += latencyMs;
    health.lastFailure = new Date().toISOString();
    health.lastError = error?.message || String(error);
    health.consecutiveFailures++;
    health.consecutiveSuccesses = 0;

    // Classify error type
    const errMsg = (error?.message || String(error)).toLowerCase();
    if (errMsg.includes('timeout') || errMsg.includes('econnrefused') || errMsg.includes('etimedout')) {
        health.timeoutCount++;
    }
    if (errMsg.includes('429') || errMsg.includes('rate limit') || errMsg.includes('quota exceeded')) {
        health.rateLimitCount++;
    }
    health.errorCount++;

    health.availability = calculateAvailability(health);
    await saveHealth(provider, health);

    log.warn('AI', `[HealthMonitor] ${provider} failure recorded: ${health.lastError} (availability: ${(health.availability * 100).toFixed(1)}%)`);
}

function calculateAvailability(health) {
    if (health.totalRequests === 0) return 1.0;

    const successRate = health.successCount / health.totalRequests;
    const recentFailurePenalty = Math.min(0.3, health.consecutiveFailures * 0.05);
    const rateLimitPenalty = Math.min(0.2, health.rateLimitCount * 0.02);
    const timeoutPenalty = Math.min(0.2, health.timeoutCount * 0.03);

    let availability = successRate - recentFailurePenalty - rateLimitPenalty - timeoutPenalty;

    // Never go below 0.05 (5%) to allow recovery
    return Math.max(0.05, Math.min(1.0, availability));
}

function isProviderAvailable(provider, threshold = 0.3) {
    // Synchronous check - uses cached/loaded health
    // For async check, use getHealth()
    return true; // Actual check happens in getHealth()
}

async function getHealth(provider) {
    const health = await loadHealth(provider);
    return {
        provider,
        available: health.availability >= 0.3 && health.consecutiveFailures < 5,
        availability: health.availability,
        successRate: health.totalRequests > 0 ? health.successCount / health.totalRequests : 1.0,
        avgLatencyMs: health.successCount > 0 ? Math.round(health.totalLatencyMs / health.successCount) : 0,
        totalRequests: health.totalRequests,
        successCount: health.successCount,
        failureCount: health.failureCount,
        timeoutCount: health.timeoutCount,
        rateLimitCount: health.rateLimitCount,
        consecutiveFailures: health.consecutiveFailures,
        consecutiveSuccesses: health.consecutiveSuccesses,
        lastSuccess: health.lastSuccess,
        lastFailure: health.lastFailure,
        lastError: health.lastError,
    };
}

async function getAllHealth() {
    const results = {};
    for (const provider of PROVIDERS) {
        results[provider] = await getHealth(provider);
    }
    return results;
}

async function getHealthyProviders(minAvailability = 0.3) {
    const allHealth = await getAllHealth();
    return Object.entries(allHealth)
        .filter(([_, h]) => h.available && h.availability >= minAvailability)
        .sort((a, b) => b[1].availability - a[1].availability)
        .map(([provider]) => provider);
}

async function resetHealth(provider = null) {
    if (provider) {
        if (!isRedisConnected()) return;
        await redisClient.del(getHealthKey(provider));
        log.info('AI', `[HealthMonitor] Reset health for ${provider}`);
    } else {
        if (!isRedisConnected()) return;
        const keys = await redisClient.keys(`${HEALTH_KEY_PREFIX}*`);
        if (keys.length) await redisClient.del(keys);
        log.info('AI', `[HealthMonitor] Reset health for all providers`);
    }
}

// Middleware wrapper for automatic health tracking
function withHealthTracking(provider, fn) {
    return async (...args) => {
        const start = Date.now();
        try {
            const result = await fn(...args);
            await recordSuccess(provider, Date.now() - start);
            return result;
        } catch (error) {
            await recordFailure(provider, error, Date.now() - start);
            throw error;
        }
    };
}

// Get provider score for routing (used by intelligent router)
async function getProviderScore(provider, context = {}) {
    const health = await getHealth(provider);

    let score = health.availability * 100;

    // Latency factor (lower is better)
    const avgLatency = health.avgLatencyMs || 5000;
    score += Math.max(0, 50 - avgLatency / 100);

    // Failure penalties
    score -= health.consecutiveFailures * 10;
    score -= health.rateLimitCount * 5;
    score -= health.timeoutCount * 8;

    // Context bonuses
    if (context.preferLocal && (provider === 'ollama' || provider === 'sglang')) score += 10;
    if (context.preferCloud && !(provider === 'ollama' || provider === 'sglang')) score += 10;
    if (context.routingMode === 'fastest' && (provider === 'groq' || provider === 'sglang')) score += 15;
    if (context.routingMode === 'quality' && (provider === 'sglang' || provider === 'gemini')) score += 15;
    if (context.routingMode === 'cheapest' && (provider === 'ollama' || provider === 'sglang')) score += 20;

    return {
        provider,
        score: Math.max(0, score),
        health,
    };
}

module.exports = {
    recordSuccess,
    recordFailure,
    getHealth,
    getAllHealth,
    getHealthyProviders,
    getProviderScore,
    resetHealth,
    withHealthTracking,
    calculateAvailability,
    DEFAULT_HEALTH,
    PROVIDERS,
};