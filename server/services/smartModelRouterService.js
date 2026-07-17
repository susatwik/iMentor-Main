const log = require('../utils/logger');

function calculateComplexityScore({ query = '', tokenEstimate = 0, reasoningMode = 'standard' }) {
  const q = String(query || '').toLowerCase();
  let score = Math.min(100, Math.round((Number(tokenEstimate) || 0) / 20));

  const complexitySignals = ['analyze', 'compare', 'trade-off', 'predict', 'architecture', 'multi-step', 'reason'];
  const hits = complexitySignals.filter(s => q.includes(s)).length;
  score += hits * 8;

  if (reasoningMode === 'complex_reasoning') score += 20;
  if (reasoningMode === 'deep_research') score += 35;

  // --- Content-aware complexity boosts ---
  const codeSignals = ['def ', 'function ', 'class ', 'import ', 'const ', 'var ', 'let ', '```', '#!/', 'algorithm', 'implement', 'debug', 'runtime', 'compile'];
  if (codeSignals.some(s => q.includes(s))) score += 2;

  const mathSignals = ['equation', 'formula', 'integral', 'derivative', 'matrix', 'vector', 'probability', 'calculus', 'theorem', 'proof', '\\frac', '\\sum', 'differentiat', 'eigenvalu'];
  if (mathSignals.some(s => q.includes(s))) score += 1;

  const researchSignals = ['research', 'literature', 'survey', 'state of the art', 'compare approaches', 'recent advances', 'paper', 'study'];
  if (researchSignals.some(s => q.includes(s))) score += 3;

  return Math.max(0, Math.min(100, score));
}

function tuneParameters({ query = '', complexityScore = 50, reasoningMode = 'standard' }) {
  const q = String(query || '').toLowerCase();
  let temperature = 0.7;
  let maxOutputTokens = 4096;

  const mathSignals = ['equation', 'formula', 'integral', 'derivative', 'matrix', 'vector', 'probability', 'calculus', 'theorem', 'proof', '\\frac', '\\sum', 'differentiat', 'eigenvalu'];
  const codeSignals = ['def ', 'function ', 'class ', 'import ', 'const ', 'var ', 'let ', '```', '#!/', 'algorithm', 'implement', 'debug', 'runtime', 'compile'];

  if (codeSignals.some(s => q.includes(s)) || mathSignals.some(s => q.includes(s))) {
    temperature = 0.2; // low temperature for precise code/math outputs
  }

  if (reasoningMode === 'deep_research') {
    temperature = 0.2;
    maxOutputTokens = 8192;
  } else if (reasoningMode === 'complex_reasoning' || complexityScore >= 70) {
    temperature = 0.4;
    maxOutputTokens = 4096;
  }

  return { temperature, maxOutputTokens };
}

function pickModelFromCatalog(catalog = [], provider, fallbackModelId = null) {
  if (!Array.isArray(catalog) || catalog.length === 0) {
    return fallbackModelId ? { modelId: fallbackModelId, provider } : null;
  }

  const inProvider = catalog.filter(m => m.provider === provider);
  const preferred = inProvider.find(m => m.isDefault) || inProvider[0];
  if (preferred) {
    return {
      modelId: preferred.modelId,
      provider: preferred.provider,
      displayName: preferred.displayName,
    };
  }

  return fallbackModelId ? { modelId: fallbackModelId, provider } : null;
}

async function selectModel({
  query = '',
  complexityScore,
  reasoningMode,
  tokenEstimate,
  userPreference,
  latencyBudget,
  localMode = false,
  isOllamaActive = false,
  catalog = []
}) {
  const score = Number.isFinite(complexityScore)
    ? complexityScore
    : calculateComplexityScore({ query, tokenEstimate, reasoningMode });

  let provider = userPreference || 'ollama';
  let strategy = 'manual_provider_default';

  const GROQ_ENABLED = Boolean(process.env.GROQ_API_KEY);
  const GEMINI_ENABLED = Boolean(process.env.GEMINI_API_KEY);

  // Global priority: ollama > groq > gemini
  if (isOllamaActive) {
    provider = 'ollama';
    if (localMode) {
      strategy = 'local_mode_ollama';
    } else if (reasoningMode === 'deep_research') {
      if (GROQ_ENABLED || GEMINI_ENABLED) {
        provider = tokenEstimate > 5000 && GEMINI_ENABLED ? 'gemini' : (GROQ_ENABLED ? 'groq' : 'gemini');
        strategy = 'deep_research_hybrid_cloud_fallback';
      } else {
        strategy = 'deep_research_ollama';
      }
    } else if (score >= 75) {
      if (GROQ_ENABLED || GEMINI_ENABLED) {
        provider = tokenEstimate > 5000 && GEMINI_ENABLED ? 'gemini' : (GROQ_ENABLED ? 'groq' : 'gemini');
        strategy = 'high_complexity_hybrid_cloud_fallback';
      } else {
        strategy = 'complex_reasoning_ollama';
      }
    } else {
      strategy = 'ollama_default';
    }
  } else if (reasoningMode === 'deep_research') {
    if (tokenEstimate > 5000 && GEMINI_ENABLED) {
      provider = 'gemini';
      strategy = 'deep_research_high_tokens_gemini_fallback';
    } else if (GROQ_ENABLED) {
      provider = 'groq';
      strategy = 'deep_research_groq_fallback';
    } else {
      provider = GEMINI_ENABLED ? 'gemini' : 'ollama';
      strategy = 'deep_research_no_groq_fallback';
    }
  } else if (score >= 70) {
    if (tokenEstimate > 5000 && GEMINI_ENABLED) {
      provider = 'gemini';
      strategy = 'complex_high_tokens_gemini_fallback';
    } else if (GROQ_ENABLED) {
      provider = 'groq';
      strategy = 'complex_reasoning_groq_fallback';
    } else {
      provider = GEMINI_ENABLED ? 'gemini' : 'ollama';
      strategy = 'complex_no_groq_fallback';
    }
  } else if (score <= 35 || latencyBudget === 'low') {
    provider = GROQ_ENABLED ? 'groq' : (GEMINI_ENABLED ? 'gemini' : 'ollama');
    strategy = 'simple_query_groq_fallback';
  } else {
    provider = GROQ_ENABLED ? 'groq' : (GEMINI_ENABLED ? 'gemini' : 'ollama');
    strategy = 'standard_groq_fallback';
  }

  const selected = pickModelFromCatalog(catalog, provider)
    || pickModelFromCatalog(catalog, userPreference || provider)
    || { modelId: null, provider };

  const tunedParameters = tuneParameters({ query, complexityScore: score, reasoningMode });

  const decision = {
    provider: selected.provider || provider,
    modelId: selected.modelId,
    displayName: selected.displayName,
    strategy,
    complexityScore: score,
    reasoningMode: reasoningMode || 'standard',
    tokenEstimate: Number(tokenEstimate) || 0,
    latencyBudget: latencyBudget || 'balanced',
    taskType: reasoningMode === 'deep_research' ? 'research'
      : (score >= 70 ? 'complex_reasoning'
        : (score <= 35 ? 'simple_chat' : 'standard')),
    tunedParameters,
  };

  log.info('AI', `Model routing decision: ${JSON.stringify(decision)}`);
  return decision;
}

module.exports = {
  calculateComplexityScore,
  tuneParameters,
  selectModel,
};
