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
  // Code: presence of code keywords or backticks/brackets
  const codeSignals = ['def ', 'function ', 'class ', 'import ', 'const ', 'var ', 'let ', '```', '#!/', 'algorithm', 'implement', 'debug', 'runtime', 'compile'];
  if (codeSignals.some(s => q.includes(s))) score += 2;

  // Math: equations, formulas, or mathematical terminology
  const mathSignals = ['equation', 'formula', 'integral', 'derivative', 'matrix', 'vector', 'probability', 'calculus', 'theorem', 'proof', '\\frac', '\\sum', 'differentiat', 'eigenvalu'];
  if (mathSignals.some(s => q.includes(s))) score += 1;

  // Deep research: multi-source, comparative, survey-like
  const researchSignals = ['research', 'literature', 'survey', 'state of the art', 'compare approaches', 'recent advances', 'paper', 'study'];
  if (researchSignals.some(s => q.includes(s))) score += 3;

  return Math.max(0, Math.min(100, score));
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
    : calculateComplexityScore({ tokenEstimate, reasoningMode });

  let provider = userPreference || 'ollama';
  let strategy = 'manual_provider_default';

  // Global priority: ollama > groq > gemini
  // Always prefer Ollama when it's active

  if (isOllamaActive) {
    // Ollama is available — always prefer it
    provider = 'ollama';
    if (localMode) {
      strategy = 'local_mode_ollama';
    } else if (reasoningMode === 'deep_research') {
      strategy = 'deep_research_ollama';
    } else if (score >= 70) {
      strategy = 'complex_reasoning_ollama';
    } else {
      strategy = 'ollama_default';
    }
  } else if (reasoningMode === 'deep_research') {
    // Ollama unavailable: fallback to Groq first, then Gemini for very large contexts
    if (tokenEstimate > 5000) {
      provider = 'gemini';
      strategy = 'deep_research_high_tokens_gemini_fallback';
    } else {
      provider = 'groq';
      strategy = 'deep_research_groq_fallback';
    }
  } else if (score >= 70) {
    if (tokenEstimate > 5000) {
      provider = 'gemini';
      strategy = 'complex_high_tokens_gemini_fallback';
    } else {
      provider = 'groq';
      strategy = 'complex_reasoning_groq_fallback';
    }
  } else if (score <= 35 || latencyBudget === 'low') {
    provider = 'groq';
    strategy = 'simple_query_groq_fallback';
  } else {
    provider = 'groq';
    strategy = 'standard_groq_fallback';
  }

  const selected = pickModelFromCatalog(catalog, provider)
    || pickModelFromCatalog(catalog, userPreference || provider)
    || { modelId: null, provider };

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
  };

  log.info('AI', `Model routing decision: ${JSON.stringify(decision)}`);
  return decision;
}

module.exports = {
  calculateComplexityScore,
  selectModel,
};
