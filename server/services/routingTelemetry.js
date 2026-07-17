/**
 * server/services/routingTelemetry.js
 * 
 * Telemetry logging for routing decisions
 * Logs: provider, model, latency, task, complexity, routing reason, fallback count, estimated tokens, mode
 */

const log = require('../utils/logger');
const { redisClient, isRedisConnected } = require('../config/redisClient');

const TELEMETRY_KEY_PREFIX = 'routing:telemetry:';
const TELEMETRY_TTL = 86400 * 30; // 30 days
const BATCH_SIZE = 100;
const FLUSH_INTERVAL_MS = 5000;

let telemetryBuffer = [];
let flushTimer = null;

function getTelemetryKey(date = new Date()) {
    const d = date.toISOString().split('T')[0];
    return `${TELEMETRY_KEY_PREFIX}${d}`;
}

function createTelemetryEntry(decision, context = {}) {
    return {
        timestamp: new Date().toISOString(),
        timestampMs: Date.now(),

        // Core routing decision
        provider: decision.provider,
        model: decision.model,
        modelDetails: decision.modelDetails || {},

        // Task analysis
        taskType: decision.taskType,
        complexity: decision.complexity,
        complexityScore: decision.complexityScore,
        reasoningDepth: decision.reasoningDepth,

        // Token estimates
        estimatedInputTokens: decision.estimatedTokens,
        estimatedOutputTokens: decision.estimatedOutputTokens,
        contextWindowNeeded: decision.contextWindowNeeded,

        // Routing metadata
        routingMode: decision.routingMode,
        providerScore: decision.providerScore,
        providerReasons: decision.providerReasons,
        latencyBudget: decision.latencyBudget,
        estimatedLatencyMs: decision.estimatedLatencyMs,

        // Fallback tracking
        fallbackCount: decision.fallbackCount || 0,
        wasFailover: decision.wasFailover || false,
        previousProvider: decision.previousProvider || null,

        // Context
        userId: context.userId || null,
        sessionId: context.sessionId || null,
        tutorMode: context.tutorMode || false,
        deepResearchMode: context.deepResearchMode || false,
        criticalThinkingEnabled: context.criticalThinkingEnabled || false,
        useReAct: context.useReAct || false,
        documentContextName: context.documentContextName || null,

        // Performance
        routingTimeMs: decision.routingTimeMs,
    };
}

async function logRoutingDecision(decision, context = {}) {
    const entry = createTelemetryEntry(decision, context);

    // Log to console (structured)
    log.info('AI', `[ROUTING_TELEMETRY] ${JSON.stringify({
        provider: entry.provider,
        model: entry.model,
        task: entry.taskType,
        complexity: entry.complexity,
        mode: entry.routingMode,
        score: entry.providerScore,
        reason: entry.providerReasons,
        tokens: `${entry.estimatedInputTokens}->${entry.estimatedOutputTokens}`,
        fallback: entry.fallbackCount,
        latencyMs: entry.routingTimeMs,
    })}`);

    // Buffer for batch Redis write
    telemetryBuffer.push(entry);

    if (telemetryBuffer.length >= BATCH_SIZE) {
        await flushTelemetryBuffer();
    } else if (!flushTimer) {
        flushTimer = setTimeout(() => flushTelemetryBuffer(), FLUSH_INTERVAL_MS);
    }
}

async function flushTelemetryBuffer() {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }

    if (telemetryBuffer.length === 0) return;

    const toFlush = [...telemetryBuffer];
    telemetryBuffer = [];

    if (!isRedisConnected()) {
        // Re-buffer if Redis not available
        telemetryBuffer.unshift(...toFlush);
        return;
    }

    try {
        const todayKey = getTelemetryKey();
        const pipeline = redisClient.multi();

        for (const entry of toFlush) {
            pipeline.rPush(todayKey, JSON.stringify(entry));
        }

        pipeline.expire(todayKey, TELEMETRY_TTL);
        await pipeline.exec();

        log.debug('AI', `[Telemetry] Flushed ${toFlush.length} entries to Redis`);
    } catch (e) {
        log.warn('AI', `[Telemetry] Flush failed: ${e.message}`);
        // Re-buffer on failure
        telemetryBuffer.unshift(...toFlush);
    }
}

async function getTelemetryStats(days = 7) {
    if (!isRedisConnected()) return { error: 'Redis not connected' };

    try {
        const keys = [];
        for (let i = 0; i < days; i++) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            keys.push(getTelemetryKey(date));
        }

        const results = [];
        for (const key of keys) {
            const entries = await redisClient.lRange(key, 0, -1);
            for (const entry of entries) {
                try {
                    results.push(JSON.parse(entry));
                } catch { /* skip invalid */ }
            }
        }

        // Aggregate
        const byProvider = {};
        const byTask = {};
        const byComplexity = {};
        const byMode = {};

        let totalLatency = 0;
        let totalFallbacks = 0;

        for (const r of results) {
            // By provider
            byProvider[r.provider] = (byProvider[r.provider] || 0) + 1;

            // By task
            byTask[r.taskType] = (byTask[r.taskType] || 0) + 1;

            // By complexity
            byComplexity[r.complexity] = (byComplexity[r.complexity] || 0) + 1;

            // By mode
            byMode[r.routingMode] = (byMode[r.routingMode] || 0) + 1;

            totalLatency += r.routingTimeMs;
            totalFallbacks += r.fallbackCount;
        }

        return {
            totalRequests: results.length,
            avgRoutingLatencyMs: results.length ? Math.round(totalLatency / results.length) : 0,
            totalFallbacks,
            fallbackRate: results.length ? (totalFallbacks / results.length * 100).toFixed(1) + '%' : '0%',
            byProvider,
            byTask,
            byComplexity,
            byMode,
            periodDays: days,
        };
    } catch (e) {
        log.error('AI', `[Telemetry] Stats failed: ${e.message}`);
        return { error: e.message };
    }
}

async function getRecentDecisions(limit = 50) {
    if (!isRedisConnected()) return [];

    try {
        const todayKey = getTelemetryKey();
        const entries = await redisClient.lRange(todayKey, -limit, -1);
        return entries.map(e => JSON.parse(e)).reverse();
    } catch (e) {
        log.warn('AI', `[Telemetry] Recent decisions failed: ${e.message}`);
        return [];
    }
}

async function getProviderPerformance(provider, days = 7) {
    const stats = await getTelemetryStats(days);
    if (stats.error) return stats;

    const providerEntries = [];
    // Note: This is a simplified version; in production you'd want to query more efficiently
    // For now, we just return aggregated stats
    return {
        provider,
        requests: stats.byProvider[provider] || 0,
        avgRoutingLatencyMs: stats.avgRoutingLatencyMs,
    };
}

// Graceful shutdown
process.on('SIGTERM', async () => {
    await flushTelemetryBuffer();
});
process.on('SIGINT', async () => {
    await flushTelemetryBuffer();
});

module.exports = {
    logRoutingDecision,
    getTelemetryStats,
    getRecentDecisions,
    getProviderPerformance,
    flushTelemetryBuffer,
    createTelemetryEntry,
};