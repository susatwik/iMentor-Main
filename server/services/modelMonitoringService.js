/**
 * Model Monitoring Service
 * Implements Task 2.4.2 part 1: Production Observability layer
 */

const LLMPerformanceLog = require('../models/LLMPerformanceLog');

/**
 * Logs every LLM interaction for downstream analysis
 */
async function logModelInference(courseId, ollamaTag, latencyMs, inputTokens, outputTokens) {
    // In production, this emits to Datadog/Prometheus or saves to MongoDB
    console.log(`[Monitoring] ${ollamaTag} completed inference in ${latencyMs}ms. (${inputTokens} in / ${outputTokens} out)`);

    try {
        const log = new LLMPerformanceLog({
            modelProvider: ollamaTag,
            interactionType: courseId,
            latencyMs,
            inputTokens,
            outputTokens
        });
        await log.save();
    } catch (e) {
        // Non-blocking log failure
        console.error(`[Monitoring] Failed to write inference log: ${e.message}`);
    }
}

module.exports = {
    logModelInference
};
