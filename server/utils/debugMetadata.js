const { getFeatureFlagsSnapshot } = require('../services/debugFeatureFlagsService');

function normalizeNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function buildDebugMetadata(debugContext = {}) {
  const featureFlags = getFeatureFlagsSnapshot();

  return {
    routing: {
      provider: debugContext.routing?.provider || 'unknown',
      modelId: debugContext.routing?.modelId || 'unknown',
      strategy: debugContext.routing?.strategy || 'unknown',
      complexityScore: normalizeNumber(debugContext.routing?.complexityScore, 0),
      reasoningMode: debugContext.routing?.reasoningMode || 'standard',
      tokenEstimate: normalizeNumber(debugContext.routing?.tokenEstimate, 0),
      latencyBudget: debugContext.routing?.latencyBudget || 'balanced',
    },
    performance: {
      routingTime: normalizeNumber(debugContext.performance?.routingTime, 0),
      llmTime: normalizeNumber(debugContext.performance?.llmTime, 0),
      toolTime: normalizeNumber(debugContext.performance?.toolTime, 0),
      dbTime: normalizeNumber(debugContext.performance?.dbTime, 0),
      redisTime: normalizeNumber(debugContext.performance?.redisTime, 0),
      totalTime: normalizeNumber(debugContext.performance?.totalTime, 0),
    },
    reasoning: {
      branchCount: normalizeNumber(debugContext.reasoning?.branchCount, 1),
      branchesPruned: normalizeNumber(debugContext.reasoning?.branchesPruned, 0),
      stepConfidences: Array.isArray(debugContext.reasoning?.stepConfidences)
        ? debugContext.reasoning.stepConfidences.map((value) => normalizeNumber(value, 0))
        : [],
      finalConfidence: normalizeNumber(debugContext.reasoning?.finalConfidence, 0),
      correctionLoops: normalizeNumber(debugContext.reasoning?.correctionLoops, 0),
    },
    redis: {
      redisHit: Boolean(debugContext.redis?.redisHit),
      loadedState: Boolean(debugContext.redis?.loadedState),
      priorInsightsCount: normalizeNumber(debugContext.redis?.priorInsightsCount, 0),
      branchHistoryCount: normalizeNumber(debugContext.redis?.branchHistoryCount, 0),
    },
    featureFlags,
  };
}

module.exports = {
  buildDebugMetadata,
};
