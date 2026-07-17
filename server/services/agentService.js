const log         = require('../utils/logger');
const sglangCaps  = require('./sglangCapabilities');
// server/services/agentService.js
const {
  CHAT_MAIN_SYSTEM_PROMPT,
  createSynthesizerPrompt,
  createAgenticSystemPrompt,
} = require("../config/promptTemplates.js");
const { availableTools } = require("./toolRegistry.js");
const toolChainOrchestrator = require("./toolChainOrchestrator.js");
const {
  createModelContext,
  createAgenticContext,
} = require("../protocols/contextProtocols.js");
const geminiService = require("./geminiService.js");
const ollamaService = require("./ollamaService.js");
const llmStreamingService = require("./llmStreamingService.js");
const { redisClient } = require('../config/redisClient');
const { getAgentState, updateAgentState } = require('./agentStateService');
const { safe, sanitizeGeneratedText } = require('../utils/promptSanitizer');

// Lazy-load to avoid circular dependency
let _fallbackService = null;
function getFallbackService() {
  if (!_fallbackService) {
    try { _fallbackService = require('./llmFallbackService'); } catch { _fallbackService = null; }
  }
  return _fallbackService;
}

/**
 * Fast LLM call for overhead tasks (decomposition, classification, critique, routing).
 * Uses the fastest available small model (Groq llama-3.1-8b-instant > small Ollama > Gemini Flash).
 * Falls back to the regular llmService if the fast path is unavailable.
 *
 * @param {string} prompt - The prompt text
 * @param {string|null} systemPrompt - Optional system prompt
 * @param {Array} chatHistory - Chat history (passed to fallback only)
 * @param {object} llmService - The regular LLM service (fallback)
 * @param {object} llmOptions - Regular LLM options (fallback)
 * @param {object} requestContext - Contains user API keys, ollamaUrl etc.
 * @returns {Promise<string>} LLM response text
 */
async function fastLlmCall(prompt, systemPrompt, chatHistory, llmService, llmOptions, requestContext = {}) {
  const fb = getFallbackService();
  if (fb && typeof fb.callFast === 'function') {
    try {
      const result = await fb.callFast({
        prompt,
        systemPrompt,
        userApiKeys: {
          gemini: llmOptions.apiKey && llmOptions.geminiModel ? llmOptions.apiKey : process.env.GEMINI_API_KEY,
          groq:   process.env.GROQ_API_KEY,
        },
        ollamaUrl: llmOptions.ollamaUrl || process.env.OLLAMA_API_BASE_URL,
        options: { maxOutputTokens: 2048, temperature: 0.3 },
      });
      if (result && typeof result === 'string' && result.trim().length > 0) {
        return result;
      }
    } catch (e) {
      log.warn('AI', `Fast LLM call failed, falling back to primary: ${e.message}`);
    }
  }
  // Fallback: use the regular (potentially larger) model
  // Guard: don't call null service (sglang path) or unvalidated Gemini
  if (!llmService) {
    log.warn('AI', 'fastLlmCall: primary fast path failed and no safe fallback (sglang provider) — returning empty routing response');
    return '';
  }
  if (llmService === geminiService && process.env.GEMINI_API_VALIDATED !== 'true') {
    log.warn('AI', 'fastLlmCall: Gemini not admin-validated — skipping fallback to avoid crash');
    return '';
  }
  return llmService.generateContentWithHistory(chatHistory, prompt, systemPrompt, llmOptions);
}

const MAX_SUB_QUERIES = 8;
const MAX_REASONING_PASSES = 3;
const MAX_REASONING_PASSES_RESEARCH = 8;
const REASONING_TIMEOUT_MS = Number(process.env.REASONING_PASS_TIMEOUT_MS || 25000);
const MIN_REASONING_DIMENSIONS = 5;
const MAX_REASONING_DIMENSIONS = 8;
const MAX_CRITIQUE_LOOPS = 1;
const REASONING_MEMORY_TTL_SECONDS = Number(process.env.REASONING_MEMORY_TTL_SECONDS || 21600);
const RESEARCH_ONLY_TOOLS = new Set(['web_search', 'academic_search']);

function withTimeout(promise, timeoutMs, label = 'operation') {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

function safeJsonParseFromText(text, fallback = null) {
  try {
    if (!text || typeof text !== 'string') return fallback;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const candidate = fenced ? fenced[1] : text;
    const objMatch = candidate.match(/\{[\s\S]*\}/);
    return JSON.parse(objMatch ? objMatch[0] : candidate);
  } catch {
    return fallback;
  }
}

function normalizeChatText(msg) {
  if (!msg) return '';
  if (Array.isArray(msg.parts) && msg.parts[0]?.text) return msg.parts[0].text;
  return msg.text || msg.content || '';
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function emitStatus(onToken, content) {
  if (typeof onToken === 'function') onToken({ type: 'status_update', content });
}

function emitStep(onToken, stepId, title, status, content = '') {
  if (typeof onToken !== 'function') return;
  onToken({
    type: 'step_update',
    content: {
      stepId,
      title,
      status,
      content,
      timestamp: Date.now()
    }
  });
}

function emitConfidence(onToken, confidenceScore) {
  if (typeof onToken === 'function') onToken({ type: 'confidence_score', content: confidenceScore });
}

function tokenizeTopic(text = '') {
  const stop = new Set(['the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'in', 'on', 'at', 'with', 'is', 'are', 'be', 'by', 'from', 'that', 'this', 'it', 'as', 'how', 'what', 'why']);
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .filter(w => w.length > 2 && !stop.has(w))
  );
}

function topicSimilarity(a = '', b = '') {
  const ta = tokenizeTopic(a);
  const tb = tokenizeTopic(b);
  if (!ta.size || !tb.size) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection += 1;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function isPredictiveQuery(query = '') {
  const q = String(query).toLowerCase();
  return [
    'predict', 'forecast', 'future', 'next', 'risk', 'probability', 'what if',
    'scenario', 'likely', 'chance', 'outlook', 'over the next', 'in the coming'
  ].some(k => q.includes(k));
}

function userAskedForRecommendations(query = '') {
  const q = String(query).toLowerCase();
  return [
    'recommend', 'recommendation', 'what should i do', 'what should we do', 'how to solve',
    'solution', 'mitigate', 'mitigation', 'action plan', 'steps to prevent', 'how can i avoid'
  ].some(k => q.includes(k));
}

function buildFallbackDimensions(userQuery = '') {
  const q = userQuery.toLowerCase();
  const defaults = [
    'core causal mechanisms',
    'stakeholder incentives and behavior',
    'system constraints and bottlenecks',
    'risk and failure pathways',
    'trade-offs and second-order effects',
    'historical or analogous patterns',
    'intervention levers and mitigations',
    'uncertainty boundaries'
  ];
  if (q.includes('economic') || q.includes('market') || q.includes('finance')) {
    defaults[1] = 'market and institutional incentive dynamics';
  }
  return defaults.slice(0, MIN_REASONING_DIMENSIONS);
}

async function loadReasoningMemory(sessionId) {
  if (!sessionId || !redisClient || !redisClient.isOpen) return null;
  try {
    const raw = await redisClient.get(`reasoning_state:${sessionId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveReasoningMemory(sessionId, payload) {
  if (!sessionId || !redisClient || !redisClient.isOpen || !payload) return;
  try {
    await redisClient.set(`reasoning_state:${sessionId}`, JSON.stringify(payload), { EX: REASONING_MEMORY_TTL_SECONDS });
  } catch {
    // non-blocking
  }
}

function isComplexQuery(userInput = '') {
  const input = String(userInput || '').trim();
  if (!input) return false;

  const lower = input.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  const analyticKeywords = [
    'explain in detail', 'analyze', 'analyse', 'design', 'evaluate', 'strategy', 'compare', 'contrast',
    'trade-off', 'tradeoff', 'predict', 'forecast', 'risk', 'architecture', 'framework', 'plan',
    'multi-step', 'step by step', 'implications', 'root cause', 'pros and cons'
  ];
  const hasAnalyticKeyword = analyticKeywords.some(k => lower.includes(k));

  const comparativePhrases = ['compare', 'versus', 'vs', 'difference between', 'similarities', 'contrast'];
  const hasComparative = comparativePhrases.some(p => lower.includes(p));

  const multiIntentConnectors = [' and ', ' also ', ' additionally ', ' furthermore ', ' as well as ', ', then ', ';'];
  const hasMultiIntent = multiIntentConnectors.some(c => lower.includes(c)) || (input.match(/\?/g) || []).length > 1;

  const reasoningDimensionSignals = ['historical', 'financial', 'technical', 'ethical', 'operational', 'market', 'legal', 'social', 'risk'];
  const dimensionHits = reasoningDimensionSignals.filter(s => lower.includes(s)).length;

  const simplePatterns = [/^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|bye)\b/i, /^what is [^?.!]{1,30}\??$/i, /^define [^?.!]{1,40}\??$/i];
  if (simplePatterns.some(p => p.test(input)) && wordCount < 10) return false;

  if (dimensionHits > 3) return true;
  if (hasComparative && hasMultiIntent) return true;
  if (hasAnalyticKeyword && wordCount >= 10) return true;
  if (hasMultiIntent && wordCount >= 18) return true;

  return false;
}

async function runMultiPassReasoning({ userQuery, chatHistory, llmService, llmOptions, finalSystemPrompt, onToken, requestContext }) {
  let llmCallCount = 0;
  const sessionId = requestContext?.sessionId;
  const existingAgentState = await getAgentState(sessionId);
  const previousMemoryEnvelope = await loadReasoningMemory(sessionId);
  const previousState = previousMemoryEnvelope?.reasoningState || null;
  const querySimilarity = previousMemoryEnvelope?.lastQuery
    ? topicSimilarity(userQuery, previousMemoryEnvelope.lastQuery)
    : 0;
  const shouldReuseMemory = !!previousState && querySimilarity >= 0.4; // topic shift <= 60%

  emitStep(onToken, 'complexity_analysis', 'Complexity Analysis', 'processing', 'Estimating reasoning depth and uncertainty profile.');
  emitStatus(onToken, '🧠 Decomposing problem structure...');
  emitStep(onToken, 'complexity_analysis', 'Complexity Analysis', 'completed', shouldReuseMemory ? `Follow-up detected (${Math.round(querySimilarity * 100)}% topical overlap).` : 'New reasoning thread detected.');

  // 1) Decompose Problem into reasoning dimensions (mandatory 5-8)
  emitStep(onToken, 'decomposition', 'Decomposing Problem', 'processing', 'Generating reasoning dimensions.');
  const decomposePrompt = `You are a reasoning architect.

USER QUESTION:
${safe(userQuery)}

PRIOR REASONING STATE (optional):
${shouldReuseMemory ? JSON.stringify({
    dimensions: previousState.dimensions,
    model: previousState.model,
  insights: [...(previousState.insights?.slice(0, 8) || []), ...(existingAgentState?.priorInsights?.slice(0, 6) || [])]
  }) : safe('None')}

REQUIREMENTS:
- Return JSON only.
- Create ${MIN_REASONING_DIMENSIONS}-${MAX_REASONING_DIMENSIONS} distinct REASONING DIMENSIONS (not generic topics).
- Each dimension must be causal/analytic and non-overlapping.
- Include whether this is predictive reasoning.

FORMAT:
{
  "objective": "short objective",
  "predictive": true,
  "dimensions": ["..."],
  "scopeNotes": ["..."]
}`;

  llmCallCount += 1;
  const decompositionRaw = await withTimeout(
    fastLlmCall(decomposePrompt, 'Return strict JSON only.', chatHistory, llmService, llmOptions, requestContext),
    REASONING_TIMEOUT_MS,
    'decomposition phase'
  );
  const decompositionObj = safeJsonParseFromText(decompositionRaw, {}) || {};
  let dimensions = Array.isArray(decompositionObj.dimensions)
    ? decompositionObj.dimensions.map(d => String(d || '').trim()).filter(Boolean)
    : [];

  if (shouldReuseMemory && Array.isArray(previousState?.dimensions)) {
    dimensions = [...previousState.dimensions, ...dimensions];
  }

  // de-duplicate + enforce bounds
  const unique = [];
  for (const d of dimensions) {
    const norm = d.toLowerCase();
    if (!unique.some(u => u.toLowerCase() === norm)) unique.push(d);
  }
  dimensions = unique.slice(0, MAX_REASONING_DIMENSIONS);
  if (dimensions.length < MIN_REASONING_DIMENSIONS) {
    const fallback = buildFallbackDimensions(userQuery);
    for (const f of fallback) {
      if (dimensions.length >= MIN_REASONING_DIMENSIONS) break;
      if (!dimensions.some(d => d.toLowerCase() === f.toLowerCase())) dimensions.push(f);
    }
  }
  dimensions = dimensions.slice(0, MAX_REASONING_DIMENSIONS);

  const predictive = decompositionObj.predictive === true || isPredictiveQuery(userQuery);
  const allowRecommendations = userAskedForRecommendations(userQuery);
  emitStep(onToken, 'decomposition', 'Decomposing Problem', 'completed', `Mapped ${dimensions.length} reasoning dimensions.`);

  // 2) Build Causal Reasoning Model (mandatory)
  emitStatus(onToken, '🔎 Mapping causal relationships...');
  emitStep(onToken, 'modeling', 'Building Reasoning Model', 'processing', 'Constructing variables, causal links, and constraints.');
  const modelPrompt = `Create a causal reasoning model for this question.

QUESTION:
${safe(userQuery)}

DIMENSIONS:
${safe(JSON.stringify(dimensions))}

RETURN JSON ONLY:
{
  "mechanisms": [
    {
      "driver": "...",
      "trigger": "...",
      "immediateReaction": "...",
      "secondaryEscalation": "...",
      "systemConsequence": "...",
      "chain": ["trigger", "immediate reaction", "secondary escalation", "system-level consequence"]
    }
  ],
  "variables": ["..."],
  "relationships": [{"from":"A","to":"B","effect":"increases|decreases","why":"..."}],
  "feedbackLoops": ["..."],
  "constraints": ["..."],
  "assumptions": ["..."],
  "uncertaintyFactors": ["..."]
}

RULES:
- Minimum mechanisms: 4
- Every major cause must include an explicit escalation chain.`;

  llmCallCount += 1;
  const modelRaw = await withTimeout(
    fastLlmCall(modelPrompt, 'Return strict JSON only.', chatHistory, llmService, llmOptions, requestContext),
    REASONING_TIMEOUT_MS,
    'modeling phase'
  );
  const modelObj = safeJsonParseFromText(modelRaw, {}) || {};
  const model = {
    mechanisms: Array.isArray(modelObj.mechanisms) ? modelObj.mechanisms.slice(0, 8) : [],
    variables: Array.isArray(modelObj.variables) ? modelObj.variables.slice(0, 12) : [],
    relationships: Array.isArray(modelObj.relationships) ? modelObj.relationships.slice(0, 14) : [],
    feedbackLoops: Array.isArray(modelObj.feedbackLoops) ? modelObj.feedbackLoops.slice(0, 8) : [],
    constraints: Array.isArray(modelObj.constraints) ? modelObj.constraints.slice(0, 10) : [],
    assumptions: Array.isArray(modelObj.assumptions) ? modelObj.assumptions.slice(0, 10) : [],
    uncertaintyFactors: Array.isArray(modelObj.uncertaintyFactors) ? modelObj.uncertaintyFactors.slice(0, 10) : []
  };
  if (model.mechanisms.length < 4) {
    const fallbackMechanisms = dimensions.slice(0, 4).map((d, idx) => ({
      driver: d,
      trigger: `Trigger condition ${idx + 1} for ${d}`,
      immediateReaction: `Immediate actor response in ${d}`,
      secondaryEscalation: 'Secondary escalation through coupled systems',
      systemConsequence: 'System-level instability if not contained',
      chain: ['trigger', 'immediate reaction', 'secondary escalation', 'system-level consequence']
    }));
    model.mechanisms = [...model.mechanisms, ...fallbackMechanisms].slice(0, 8);
  }
  emitStep(onToken, 'modeling', 'Building Reasoning Model', 'completed', `Model built with ${model.variables.length} variables and ${model.relationships.length} causal links.`);

  // 3) Iterative Analysis Loop
  emitStatus(onToken, '📊 Evaluating competing scenarios...');
  emitStep(onToken, 'analysis_loop', 'Iterative Analysis Loop', 'processing', 'Testing dimensions against model assumptions.');

  const reasoningState = {
    dimensions,
    model,
    insights: [],
    contradictions: [],
    scenarios: [],
    confidenceBasis: {}
  };

  const allowResearchDepth = requestContext?.intent === 'research' || requestContext?.deepResearchContext === true;
  // ADAPTIVE REASONING DEPTH: scale passes to actual complexity
  const queryWordCount = userQuery.trim().split(/\s+/).length;
  const adaptivePassCap = allowResearchDepth
    ? MAX_REASONING_PASSES_RESEARCH
    : (queryWordCount < 20 ? Math.min(2, MAX_REASONING_PASSES) : MAX_REASONING_PASSES);
  const passes = Math.min(adaptivePassCap, Math.max(1, dimensions.length));
  for (let i = 0; i < passes; i++) {
    const dimension = dimensions[i];
    emitStatus(onToken, `🔍 Analyzing dimension ${i + 1}/${passes}: ${dimension}...`);

    const loopPrompt = `Iterative reasoning pass ${i + 1}/${passes}.

QUESTION:
${safe(userQuery)}

ACTIVE DIMENSION:
${safe(dimension)}

MODEL SNAPSHOT:
${safe(JSON.stringify({
      variables: model.variables,
      relationships: model.relationships.slice(0, 8),
      assumptions: model.assumptions,
      uncertaintyFactors: model.uncertaintyFactors
    }))}

PRIOR INSIGHTS:
${safe(JSON.stringify(reasoningState.insights.slice(-8)))}

RETURN JSON ONLY:
{
  "dimensionSummary":"2-3 sentence analysis",
  "insights":["..."],
  "contradictions":["..."],
  "conditional":"If X then Y because..."
}`;

    llmCallCount += 1;
    const loopRaw = await withTimeout(
      fastLlmCall(loopPrompt, 'Return strict JSON only.', chatHistory, llmService, llmOptions, requestContext),
      REASONING_TIMEOUT_MS,
      `analysis pass ${i + 1}`
    );
    const loopObj = safeJsonParseFromText(loopRaw, {}) || {};
    const insightPack = Array.isArray(loopObj.insights) ? loopObj.insights.slice(0, 3) : [];
    const contradictionPack = Array.isArray(loopObj.contradictions) ? loopObj.contradictions.slice(0, 2) : [];
    const summary = String(loopObj.dimensionSummary || '').trim();
    const conditional = String(loopObj.conditional || '').trim();

    if (summary) reasoningState.insights.push(`[${dimension}] ${summary}`);
    if (conditional) reasoningState.insights.push(`[Conditional] ${conditional}`);
    reasoningState.insights.push(...insightPack.map(s => String(s)));
    reasoningState.contradictions.push(...contradictionPack.map(s => String(s)));
  }
  reasoningState.insights = reasoningState.insights.slice(0, 40);
  reasoningState.contradictions = reasoningState.contradictions.slice(0, 20);
  emitStep(onToken, 'analysis_loop', 'Iterative Analysis Loop', 'completed', `Completed ${passes} reasoning passes.`);

  // 4-5-6) PARALLELIZED: Scenario Modeling + Insight Extraction + Self-Critique
  // These three phases are independent — they all read from reasoningState/model/dimensions
  // but don't depend on each other's output. Running in parallel saves ~6-10s.
  emitStatus(onToken, '🧪 Simulating scenarios, extracting insights, and self-critiquing in parallel...');
  emitStep(onToken, 'scenario_simulation', 'Scenario Simulation', 'processing', 'Generating baseline, stress, and tail-risk cases.');
  emitStep(onToken, 'insight_extraction', 'Insight Extraction', 'processing', 'Deriving non-obvious insight from interaction effects.');
  emitStep(onToken, 'self_critique', 'Self-Critique', 'processing', 'Testing assumptions, causality, and over-claim risk.');

  const scenarioPrompt = `Build three scenarios for this ${predictive ? 'predictive' : 'analytical'} question.

QUESTION:
${safe(userQuery)}

MODEL:
${safe(JSON.stringify(model))}

INSIGHTS:
${safe(JSON.stringify(reasoningState.insights.slice(0, 16)))}

Return strict JSON only:
{
  "scenarios": [
    {"name":"Scenario A (Most Likely)","trigger":"...","propagation":"...","globalEffects":"...","outcome":"stabilization|partial stabilization|collapse","likelihood":"High likelihood|Moderate likelihood|Low likelihood / high impact"},
    {"name":"Scenario B (System Stress)","trigger":"...","propagation":"...","globalEffects":"...","outcome":"stabilization|partial stabilization|collapse","likelihood":"High likelihood|Moderate likelihood|Low likelihood / high impact"},
    {"name":"Scenario C (Low Probability / High Impact)","trigger":"...","propagation":"...","globalEffects":"...","outcome":"stabilization|partial stabilization|collapse","likelihood":"High likelihood|Moderate likelihood|Low likelihood / high impact"}
  ]
}`;

  const insightPrompt = `Derive one non-obvious synthesized insight from interaction effects.

QUESTION:
${safe(userQuery)}

MECHANISMS:
${safe(JSON.stringify(model.mechanisms))}

INSIGHTS SO FAR:
${safe(JSON.stringify(reasoningState.insights.slice(0, 16)))}

Return strict JSON only:
{ "keyInsight": "one concise insight" }`;

  const critiquePrompt = `Evaluate reasoning quality. Return strict JSON only.

QUESTION:
${safe(userQuery)}

REASONING STATE:
${safe(JSON.stringify(reasoningState))}

CHECKS:
- are mechanisms explicit (minimum 4)
- are escalation chains explicit per major cause
- are scenarios modeled with trigger, propagation, effects, and outcome
- is uncertainty acknowledged
- assumption dependence
- missing counterarguments
- causal clarity
- overstatement risk

FORMAT:
{
  "mechanismsShown": true,
  "chainsExplicit": true,
  "scenariosModeled": true,
  "uncertaintyAcknowledged": true,
  "assumptionDependence":"low|medium|high",
  "missingCounterarguments":["..."],
  "causalityGaps":["..."],
  "overstatementRisk":"low|medium|high",
  "needsRefinement": true,
  "refinementGuidance":"..."
}`;

  // Run all three in parallel — each is a separate LLM call with no cross-dependency
  llmCallCount += 3;
  const [scenarioRaw, insightRaw, critiqueRaw] = await Promise.all([
    withTimeout(
      fastLlmCall(scenarioPrompt, 'Return strict JSON only.', chatHistory, llmService, llmOptions, requestContext),
      REASONING_TIMEOUT_MS,
      'scenario modeling phase'
    ),
    withTimeout(
      fastLlmCall(insightPrompt, 'Return strict JSON only.', chatHistory, llmService, llmOptions, requestContext),
      REASONING_TIMEOUT_MS,
      'insight extraction phase'
    ),
    withTimeout(
      fastLlmCall(critiquePrompt, 'Return strict JSON only.', chatHistory, llmService, llmOptions, requestContext),
      REASONING_TIMEOUT_MS,
      'self-critique phase'
    ),
  ]);

  // Process scenario results
  const scenarioObj = safeJsonParseFromText(scenarioRaw, {}) || {};
  let scenarios = Array.isArray(scenarioObj.scenarios) ? scenarioObj.scenarios.slice(0, 3) : [];
  if (scenarios.length < 3) {
    const fallback = [
      { name: 'Scenario A (Most Likely)', trigger: 'Current trajectory persists', propagation: 'Primary drivers continue with manageable friction', globalEffects: 'Moderate impact with uneven distribution', outcome: 'partial stabilization', likelihood: 'Moderate likelihood' },
      { name: 'Scenario B (System Stress)', trigger: 'Multiple risk drivers align', propagation: 'Amplification across dependent systems', globalEffects: 'High volatility and broader social/economic disruption', outcome: 'collapse', likelihood: 'Low likelihood / high impact' },
      { name: 'Scenario C (Low Probability / High Impact)', trigger: 'Tail-risk shock event', propagation: 'Rapid nonlinear escalation with institutional lag', globalEffects: 'Severe but uncertain downstream effects', outcome: 'collapse', likelihood: 'Low likelihood / high impact' }
    ];
    scenarios = fallback;
  }
  emitStep(onToken, 'scenario_simulation', 'Scenario Simulation', 'completed', 'Generated 3 scenario tracks.');
  reasoningState.scenarios = scenarios;

  // Process insight results
  const insightObj = safeJsonParseFromText(insightRaw, {}) || {};
  const keyInsight = String(insightObj.keyInsight || '').trim() ||
    'The highest systemic risk is often escalation speed exceeding coordination and response capacity.';
  emitStep(onToken, 'insight_extraction', 'Insight Extraction', 'completed', 'Key insight extracted.');

  // Process critique results
  const critiqueObj = safeJsonParseFromText(critiqueRaw, {}) || {};
  const needsRefinement = critiqueObj.needsRefinement === true;
  const critiqueSummary = `Assumption dependence: ${critiqueObj.assumptionDependence || 'unknown'}, overstatement risk: ${critiqueObj.overstatementRisk || 'unknown'}.`;
  emitStep(onToken, 'self_critique', 'Self-Critique', 'completed', critiqueSummary);

  // 7) Final synthesis with quality enforcement
  emitStatus(onToken, '🧩 Integrating insights...');
  emitStep(onToken, 'final_synthesis', 'Final Synthesis', 'processing', 'Constructing final explanation with explicit uncertainty.');

  const synthesisPrompt = `Synthesize a high-quality answer.

QUESTION:
${safe(userQuery)}

REASONING STATE:
${safe(JSON.stringify(reasoningState))}

KEY INSIGHT:
${safe(keyInsight)}

CRITIQUE:
${safe(JSON.stringify(critiqueObj))}

ALLOW RECOMMENDATIONS:
${allowRecommendations ? 'YES (user requested solutions)' : 'NO (suppress recommendations)'}

MANDATORY QUALITY RULES:
1) Include causal explanation (because/therefore style logic).
2) Include at least one non-obvious insight.
3) Include at least one conditional statement (If...then...).
4) Explicitly acknowledge uncertainty and assumptions.
5) Avoid repetition and purely descriptive summaries.
6) Use this exact section structure:
   - Core Drivers (Mechanisms)
   - Escalation Chains
   - Scenario Modeling
   - Uncertainty Analysis
   - Key Insight
7) If user did not ask for solutions, do not include recommendations.

Respond in strict JSON only:
{
  "answer":"final user-facing response",
  "qualityChecklist":{
    "mechanismsShown":true,
    "chainsExplicit":true,
    "scenariosModeled":true,
    "causalExplanations":true,
    "nonObviousInsight":true,
    "conditionalStatement":true,
    "uncertaintyAcknowledged":true,
    "recommendationRuleHonored":true,
    "structureFollowed":true,
    "keyInsightIncluded":true,
    "nonRepetitive":true,
    "notPurelyDescriptive":true
  }
}`;

  llmCallCount += 1;
  let synthesisRaw = await withTimeout(
    llmService.generateContentWithHistory(chatHistory, synthesisPrompt, finalSystemPrompt, llmOptions),
    REASONING_TIMEOUT_MS,
    'final synthesis phase'
  );
  let synthesisObj = safeJsonParseFromText(synthesisRaw, null);
  let finalAnswer = synthesisObj?.answer || String(synthesisRaw || '').trim();
  let qualityChecklist = synthesisObj?.qualityChecklist || {};

  const missingQuality = [
    'mechanismsShown',
    'chainsExplicit',
    'scenariosModeled',
    'causalExplanations',
    'nonObviousInsight',
    'conditionalStatement',
    'uncertaintyAcknowledged',
    'recommendationRuleHonored',
    'structureFollowed',
    'keyInsightIncluded',
    'nonRepetitive',
    'notPurelyDescriptive'
  ].filter(key => qualityChecklist[key] !== true);

  let critiqueLoops = 0;
  if ((needsRefinement || missingQuality.length > 0) && critiqueLoops < MAX_CRITIQUE_LOOPS) {
    critiqueLoops += 1;
    const refinePrompt = `Refine this draft once.

QUESTION:
${safe(userQuery)}

CURRENT DRAFT:
${safe(finalAnswer)}

MISSING CHECKS:
${safe(missingQuality.join(', ') || 'none')}

REFINEMENT GUIDANCE:
${safe(critiqueObj.refinementGuidance || 'Strengthen causal links and calibrate claims.')}

Return strict JSON only:
{
  "answer":"refined final response",
  "qualityChecklist":{
    "mechanismsShown":true,
    "chainsExplicit":true,
    "scenariosModeled":true,
    "causalExplanations":true,
    "nonObviousInsight":true,
    "conditionalStatement":true,
    "uncertaintyAcknowledged":true,
    "recommendationRuleHonored":true,
    "structureFollowed":true,
    "keyInsightIncluded":true,
    "nonRepetitive":true,
    "notPurelyDescriptive":true
  }
}`;

    llmCallCount += 1;
    const refineRaw = await withTimeout(
      llmService.generateContentWithHistory(chatHistory, refinePrompt, finalSystemPrompt, llmOptions),
      REASONING_TIMEOUT_MS,
      'refinement phase'
    );
    const refineObj = safeJsonParseFromText(refineRaw, null);
    if (refineObj?.answer) {
      finalAnswer = refineObj.answer;
      qualityChecklist = refineObj.qualityChecklist || qualityChecklist;
    }
  }

  emitStep(onToken, 'final_synthesis', 'Final Synthesis', 'completed', 'Final explanation assembled.');

  // 7) Confidence calibration
  emitStatus(onToken, '📏 Calibrating confidence...');
  emitStep(onToken, 'confidence_calibration', 'Confidence Calibration', 'processing', 'Scoring consistency, evidence, and uncertainty.');

  const evidenceStrength = clamp(
    40 + (reasoningState.insights.length * 1.5) + (predictive ? 4 : 2) - (reasoningState.contradictions.length * 1.8),
    20,
    92
  );
  const modelConsistency = clamp(
    35 + (model.relationships.length * 2.2) + (model.feedbackLoops.length * 2) - (reasoningState.contradictions.length * 2.5),
    15,
    92
  );
  const uncertaintyPenalty = -clamp(
    (model.assumptions.length * 2) + (model.uncertaintyFactors.length * 2.5),
    4,
    30
  );
  const scenarioDependence = predictive ? -15 : -5;

  let confidenceScore = Math.round(
    (evidenceStrength * 0.35) +
    (modelConsistency * 0.35) +
    ((100 + uncertaintyPenalty) * 0.2) +
    ((100 + scenarioDependence) * 0.1)
  );
  confidenceScore = clamp(confidenceScore, 20, predictive ? 85 : 95);

  const confidenceBasis = {
    evidence_strength: Number(evidenceStrength.toFixed(1)),
    model_consistency: Number(modelConsistency.toFixed(1)),
    uncertainty_penalty: Number(uncertaintyPenalty.toFixed(1)),
    scenario_dependence: Number(scenarioDependence.toFixed(1)),
    predictive_cap_applied: predictive
  };
  reasoningState.keyInsight = keyInsight;
  reasoningState.confidenceBasis = confidenceBasis;
  emitStep(onToken, 'confidence_calibration', 'Confidence Calibration', 'completed', `Confidence calibrated at ${confidenceScore}%.`);
  emitConfidence(onToken, confidenceScore);

  emitStatus(onToken, '✍️ Formulating explanation...');

  await saveReasoningMemory(sessionId, {
    lastQuery: userQuery,
    reasoningState: {
      dimensions: reasoningState.dimensions,
      model: {
        variables: reasoningState.model.variables,
        relationships: reasoningState.model.relationships.slice(0, 10),
        feedbackLoops: reasoningState.model.feedbackLoops,
        constraints: reasoningState.model.constraints,
        assumptions: reasoningState.model.assumptions,
        uncertaintyFactors: reasoningState.model.uncertaintyFactors
      },
      insights: reasoningState.insights.slice(0, 20),
      contradictions: reasoningState.contradictions.slice(0, 10),
      scenarios: reasoningState.scenarios,
      confidenceBasis,
      keyInsight
    },
    updatedAt: Date.now()
  });

  const updatedAgentState = await updateAgentState(sessionId, {
    lastReasoningModel: llmOptions?.model || llmOptions?.geminiModel || llmOptions?.mistralModel || llmOptions?.anthropicModel || null,
    priorInsights: reasoningState.insights.slice(0, 20),
    branchHistory: dimensions.slice(0, 8),
    confidenceHistory: [
      ...(Array.isArray(existingAgentState?.confidenceHistory) ? existingAgentState.confidenceHistory.slice(-29) : []),
      confidenceScore
    ]
  });

  return {
    finalAnswer: sanitizeGeneratedText(finalAnswer),
    sourcePipeline: 'agent-cognitive-reasoning-v2',
    reasoningMeta: {
      reusedMemory: shouldReuseMemory,
      topicSimilarity: Number(querySimilarity.toFixed(2)),
      predictive,
      critiqueApplied: critiqueLoops,
      qualityChecklist,
      confidenceScore,
      llmCallCount,
      reasoningDepth: passes,
      branchCount: dimensions.length,
      toolCalls: 0,
      performanceDiagnostics: {
        routingTime: 0,
        llmTime: 0,
        toolTime: 0,
        dbTime: 0,
        redisTime: 0,
      },
      agentState: updatedAgentState,
      reasoningState: {
        dimensions: reasoningState.dimensions,
        model,
        insights: reasoningState.insights.slice(0, 20),
        contradictions: reasoningState.contradictions.slice(0, 10),
        scenarios: reasoningState.scenarios,
        confidenceBasis,
        keyInsight
      }
    }
  };
}

function parseToolCall(responseText) {
  try {
    const jsonMatch = responseText.match(/```(json)?\s*([\s\S]+?)\s*```/);
    const jsonString = jsonMatch ? jsonMatch[2] : responseText;
    const jsonResponse = JSON.parse(jsonString);
    if (jsonResponse && typeof jsonResponse.tool_call !== "undefined") {
      return jsonResponse.tool_call;
    }
    return null;
  } catch (e) {
    log.warn('AI', `Failed to parse tool call from model. Response truncated.`);
    // Fallback for non-JSON responses that contain the tool name
    if (typeof responseText === 'string' && responseText.toLowerCase().includes("generate_document")) {
      log.info('AI', "Fallback: Detected 'generate_document' manually.");
      return { tool_name: 'generate_document', parameters: {} }; // Parameters will be extracted from query later
    }
    return null;
  }
}

async function processAgenticRequest(
  userQuery,
  chatHistory,
  clientSystemPrompt,
  requestContext,
  onToken = null
) {
  const serviceStart = Date.now();
  const {
    llmProvider,
    ollamaModel,
    ollamaUrl,
    apiKey,
  } = requestContext;

  const groqService = require("./groqService");
  const llmService = llmProvider === "ollama" ? ollamaService
                    : llmProvider === "sglang" ? null  // answer generation uses llmStreamingService
                    : llmProvider === "groq" ? groqService
                    : geminiService;

  const llmOptions = {
    ...(llmProvider === "ollama" && {
      model: ollamaModel || process.env.OLLAMA_DEFAULT_MODEL || 'qwen3.5:9b',
      think: true,
    }),
    ...(llmProvider === "sglang" && { model: process.env.SGLANG_CHAT_MODEL || 'Qwen/Qwen2.5-7B-Instruct-AWQ' }),
    ...(llmProvider === "gemini" && { geminiModel: requestContext.geminiModel || process.env.GEMINI_MODEL || 'gemini-2.0-flash' }),
    ...(llmProvider === "groq" && { model: requestContext.groqModel || process.env.GROQ_MODEL || 'llama-3.1-8b-instant' }),
    apiKey: apiKey,
    ollamaUrl: ollamaUrl,
  };

  // Multi-pass reasoning only activates via explicit ToT toggle (criticalThinkingEnabled),
  // not from auto-detected query complexity. The ToT orchestrator handles the toggle path.
  const shouldUseMultiPassReasoning = false;

  if (shouldUseMultiPassReasoning) {
    try {
      emitStatus(onToken, 'Designing reasoning strategy...');
      const finalSystemPrompt = CHAT_MAIN_SYSTEM_PROMPT();
      const orchestrated = await runMultiPassReasoning({
        userQuery,
        chatHistory,
        llmService,
        llmOptions,
        finalSystemPrompt,
        onToken,
        requestContext
      });

      return {
        finalAnswer: orchestrated.finalAnswer,
        thinking: null,
        references: [],
        sourcePipeline: orchestrated.sourcePipeline || 'agent-cognitive-reasoning-v2',
        confidenceScore: orchestrated.reasoningMeta?.confidenceScore || null,
        reasoningMeta: {
          ...orchestrated.reasoningMeta
        }
      };
    } catch (mpErr) {
      log.warn('AI', `Multi-pass reasoning failed, fallback to single-pass/tool path: ${mpErr.message}`);
    }
  }

  const toolCatalog = requestContext?.intent === 'research'
    ? availableTools
    : Object.fromEntries(Object.entries(availableTools).filter(([name]) => !RESEARCH_ONLY_TOOLS.has(name)));

  const modelContext = createModelContext({ availableTools: toolCatalog });
  const agenticContext = createAgenticContext({
    systemPrompt: clientSystemPrompt,
  });
  const routerSystemPrompt = createAgenticSystemPrompt(
    modelContext,
    agenticContext,
    { userQuery, ...requestContext }
  );

  log.info('AI', `Query Routing via ${llmProvider}...`);

  // Router call — use fast model (classification task, doesn't need full model)
  const routerResponseText = await fastLlmCall(
    "Analyze the query and decide on an action.",
    routerSystemPrompt,
    [],
    llmService,
    llmOptions,
    requestContext
  );
  let toolCall = parseToolCall(routerResponseText);

  if (toolCall && (toolCall.tool_name === 'direct_answer' || toolCall.tool_name === 'none')) {
    log.info('AI', `Intercepted tool call "${toolCall.tool_name}" — treating as direct response`);
    toolCall = null;
  }

  // --- DETERMINISTIC CODE OVERRIDE ---
  if (requestContext?.intent === 'code' && !requestContext?.isWebSearchEnabled && !requestContext?.isAcademicSearchEnabled && !requestContext?.documentContextName) {
    log.info('AI', `[CODE_OVERRIDE] intent="code" — forcing direct_answer`);
    toolCall = null;
  }

  if ((!toolCall || !toolCall.tool_name) && requestContext?.intent === 'research') {
    toolCall = {
      tool_name: requestContext?.isAcademicSearchEnabled ? 'academic_search' : 'web_search',
      parameters: { query: userQuery }
    };
  }

  if (toolCall && RESEARCH_ONLY_TOOLS.has(toolCall.tool_name) && requestContext?.intent !== 'research') {
    log.info('AI', `Research tool blocked by deterministic intent gate: ${toolCall.tool_name}`);
    toolCall = null;
  }

  // --- DETERMINISTIC RAG OVERRIDE ---
  // When a document is selected, the LLM router MUST pick rag_search.
  // Small routing LLMs sometimes pick kg_search or direct_answer instead — override them.
  if (requestContext?.documentContextName) {
    const picked = toolCall?.tool_name;
    if (picked !== 'rag_search') {
      log.info('AI', `[RAG_OVERRIDE] documentContextName="${requestContext.documentContextName}" set but LLM picked "${picked}" — forcing rag_search`);
      toolCall = { tool_name: 'rag_search', parameters: { query: userQuery } };
    }
  }

  // --- INTERCEPT LOGIC FOR DOCUMENT GENERATION ---
  if (toolCall && toolCall.tool_name === "generate_document") {
    // ... (logic remains same, return immediate action)
    const topicMatch = userQuery.match(/(?:on|about|regarding)\s+(.+)/i);
    const docTypeMatch = userQuery.match(/\b(pptx|docx)\b/i);

    const topic = toolCall.parameters?.topic || (topicMatch ? topicMatch[1].trim() : userQuery);
    const doc_type = toolCall.parameters?.doc_type || (docTypeMatch ? docTypeMatch[0].toLowerCase() : 'docx');

    if (onToken) onToken(`I'm starting the generation for your ${doc_type.toUpperCase()}...`);

    return {
      finalAnswer: sanitizeGeneratedText(`I'm starting the generation for your ${safe(doc_type).toUpperCase()} on "${safe(topic)}". The download should begin automatically in a moment.`),
      thinking: `User requested document generation. Tool call: ${JSON.stringify(toolCall)}.`,
      references: [],
      sourcePipeline: `agent-generate_document`,
      action: { type: "DOWNLOAD_DOCUMENT", payload: { topic, docType: doc_type } },
    };
  }

  if (requestContext.forceSimple === true || !toolCall || !toolCall.tool_name) {
    const finalSystemPrompt = CHAT_MAIN_SYSTEM_PROMPT();

    let directAnswer;
    const fb = getFallbackService();
    if (fb && typeof fb.callWithFallback === 'function') {
      const fallbackResult = await fb.callWithFallback({
        chatHistory,
        userQuery,
        systemPrompt: finalSystemPrompt,
        options: {
          ...llmOptions,
          geminiModel: llmOptions.geminiModel,
          groqModel: llmOptions.groqModel,
          model: llmOptions.model
        },
        preferredProvider: llmProvider,
        preferLocalFirst: llmProvider === 'sglang' || llmProvider === 'ollama',
        userApiKeys: {
          gemini: llmOptions.apiKey && llmProvider === 'gemini' ? llmOptions.apiKey : process.env.GEMINI_API_KEY,
          groq: llmOptions.apiKey && llmProvider === 'groq' ? llmOptions.apiKey : process.env.GROQ_API_KEY
        },
        ollamaUrl: llmOptions.ollamaUrl || process.env.OLLAMA_API_BASE_URL,
        onToken: onToken
      });
      directAnswer = fallbackResult.thinking 
        ? `<thinking>\n${fallbackResult.thinking}\n</thinking>\n${fallbackResult.text}`
        : fallbackResult.text;
    } else {
      if (onToken) {
        // STREAMING PATH — all providers now supported via unified streaming service
        const messagesForStreaming = [
          ...chatHistory.map(m => ({ role: m.role, content: Array.isArray(m.parts) ? m.parts[0].text : (m.text || m.content) })),
          { role: 'user', content: userQuery }
        ];

        const isThinkingModel = /qwen3|qwq|deepseek.*r1|gemma3|gemma-3/i.test(llmOptions.model || llmOptions.geminiModel || '');

        if (llmProvider === 'gemini' || llmProvider === 'groq' || llmProvider === 'anthropic' || llmProvider === 'mistral') {
          directAnswer = await llmStreamingService.streamCompletion({
            messages: messagesForStreaming,
            provider: llmProvider,
            model: llmOptions.geminiModel || llmOptions.model,
            apiKey: llmOptions.apiKey,
            systemPrompt: finalSystemPrompt,
            onToken: onToken,
            options: { ...llmOptions, handleThinkingTags: isThinkingModel }
          });
        } else if (llmProvider === 'ollama') {
          // Router uses its own streamChat which handles thinking models natively
          directAnswer = await ollamaService.streamChat(
            chatHistory,
            userQuery,
            finalSystemPrompt,
            llmOptions,
            (token) => {
              if (typeof token === 'string') {
                onToken({ type: 'token', content: token });
              } else {
                onToken(token);
              }
            }
          );
        } else if (llmProvider === 'sglang') {
          directAnswer = await llmStreamingService.streamCompletion({
            messages: messagesForStreaming,
            provider: 'sglang',
            model: llmOptions.model,
            systemPrompt: finalSystemPrompt,
            onToken: onToken,
            options: llmOptions,
          });
        } else {
          // Unknown provider — try unified streaming, fall back to non-streaming
          try {
            directAnswer = await llmStreamingService.streamCompletion({
              messages: messagesForStreaming,
              provider: llmProvider,
              model: llmOptions.model,
              apiKey: llmOptions.apiKey,
              systemPrompt: finalSystemPrompt,
              onToken: onToken,
              options: llmOptions,
            });
          } catch {
            if (!llmService) throw new Error(`No streaming support for provider: ${llmProvider}`);
            directAnswer = await llmService.generateContentWithHistory(
              chatHistory, userQuery, finalSystemPrompt, llmOptions
            );
          }
        }
      } else {
        // NON-STREAMING PATH
        if (!llmService) {
          // SGLang via direct REST
          const axios = require('axios');
          const sglUrl  = process.env.SGLANG_CHAT_URL   || 'http://localhost:8000/v1';
          const sglModel = process.env.SGLANG_CHAT_MODEL || 'Qwen/Qwen2.5-7B-Instruct-AWQ';
          const msgs = [
            ...(finalSystemPrompt ? [{ role: 'system', content: finalSystemPrompt }] : []),
            ...chatHistory.map(m => ({ role: m.role === 'model' ? 'assistant' : m.role, content: Array.isArray(m.parts) ? m.parts[0].text : (m.text || m.content) })),
            { role: 'user', content: userQuery },
          ];
          const r = await axios.post(`${sglUrl}/chat/completions`, {
            model: sglModel, messages: msgs,
            max_tokens: Math.min(4096, Math.max(512, sglangCaps.getModelMaxContext() - Math.ceil(msgs.map(m => m.content).join(' ').length / 3.5) - 256)),
            temperature: 0.7, stream: false,
          }, { timeout: 60000 });
          directAnswer = r.data?.choices?.[0]?.message?.content?.trim() || '';
        } else {
          directAnswer = await llmService.generateContentWithHistory(
            chatHistory,
            userQuery,
            finalSystemPrompt,
            llmOptions
          );
        }
      }
    }

    const thinkingMatch = directAnswer.match(/<thinking>([\s\S]*?)<\/thinking>/i);
    const thinking = thinkingMatch ? thinkingMatch[1].trim() : null;
    const mainContent = thinking
      ? directAnswer.replace(/<thinking>[\s\S]*?<\/thinking>\s*/i, "").trim()
      : directAnswer;

    const updatedAgentState = await updateAgentState(requestContext?.sessionId, {
      lastReasoningModel: llmOptions.model || llmOptions.geminiModel || llmOptions.mistralModel || llmOptions.anthropicModel || null,
      priorInsights: [mainContent.slice(0, 240)],
      branchHistory: [],
      confidenceHistory: []
    });

    return {
      finalAnswer: sanitizeGeneratedText(mainContent),
      thinking: thinking,
      references: [],
      sourcePipeline: requestContext.forceSimple ? `${llmProvider}-agent-direct-bypass` : `${llmProvider}-agent-direct-no-tool`,
      reasoningMeta: {
        branchCount: 1,
        llmCallCount: 1,
        reasoningDepth: 1,
        toolCalls: 0,
        performanceDiagnostics: {
          routingTime: 0,
          llmTime: Date.now() - serviceStart,
          toolTime: 0,
          dbTime: 0,
          redisTime: 0,
        },
        agentState: updatedAgentState,
      }
    };
  }

  log.info('AI', `Decision: Tool Call -> ${toolCall.tool_name}`);
  const mainTool = toolCatalog[toolCall.tool_name];
  if (!mainTool) {
    return {
      finalAnswer:
        "I tried to use a tool that doesn't exist. Please try again.",
      references: [],
      sourcePipeline: "agent-error-unknown-tool",
    };
  }

  try {
    // Plan a tool chain (may add complementary tools)
    const chain = toolChainOrchestrator.planToolChain(
      toolCall.tool_name,
      toolCall.parameters,
      requestContext
    );

    let toolOutput, toolReferences, pipeline;
    let toolTimeMs = 0;

    if (chain.length > 1) {
      // Execute the full chain
      log.info('AI', `Executing tool chain: ${chain.map(s => s.toolName).join(' → ')}`);
      const chainResult = await toolChainOrchestrator.executeToolChain(chain, requestContext);

      toolOutput = chainResult.finalOutput;
      toolReferences = chainResult.allReferences;
      pipeline = `${llmProvider}-agent-chain-${chain.map(s => s.toolName).join('+')}`;
      toolTimeMs = chainResult.totalDuration || 0;

      log.success('AI', `Tool chain completed successfully (${chainResult.totalDuration}ms)`);
    } else {
      // Single tool — still use retry/fallback via orchestrator
      const execution = await toolChainOrchestrator.executeWithRetry(
        toolCall.tool_name,
        toolCall.parameters,
        requestContext
      );

      if (!execution.success) {
        throw new Error(execution.error || 'Tool execution failed after retries.');
      }

      toolOutput = execution.result.toolOutput;
      toolReferences = execution.result.references || [];
      pipeline = `${llmProvider}-agent-${execution.toolName}`;
      toolTimeMs = Number(execution.result?.duration || execution.duration || 0);

      if (execution.wasFailover) {
        pipeline += `-fallback-from-${execution.originalTool}`;
      }
    }

    if (
      toolCall.tool_name === "rag_search" &&
      requestContext.criticalThinkingEnabled
    ) {
      pipeline += "+kg_enhanced";
    }

    log.info('AI', "Synthesizing final response...");

    const finalSystemPrompt = CHAT_MAIN_SYSTEM_PROMPT();
    const synthesizerUserQuery = createSynthesizerPrompt(
      userQuery,
      toolOutput,
      toolCall.tool_name
    );

    let finalAnswerWithThinking;
    const fb = getFallbackService();
    if (fb && typeof fb.callWithFallback === 'function') {
      const fallbackResult = await fb.callWithFallback({
        chatHistory,
        userQuery: synthesizerUserQuery,
        systemPrompt: finalSystemPrompt,
        options: {
          ...llmOptions,
          geminiModel: llmOptions.geminiModel,
          groqModel: llmOptions.groqModel,
          model: llmOptions.model
        },
        preferredProvider: llmProvider,
        preferLocalFirst: llmProvider === 'sglang' || llmProvider === 'ollama',
        userApiKeys: {
          gemini: llmOptions.apiKey && llmProvider === 'gemini' ? llmOptions.apiKey : process.env.GEMINI_API_KEY,
          groq: llmOptions.apiKey && llmProvider === 'groq' ? llmOptions.apiKey : process.env.GROQ_API_KEY
        },
        ollamaUrl: llmOptions.ollamaUrl || process.env.OLLAMA_API_BASE_URL,
        onToken: onToken
      });
      finalAnswerWithThinking = fallbackResult.thinking 
        ? `<thinking>\n${fallbackResult.thinking}\n</thinking>\n${fallbackResult.text}`
        : fallbackResult.text;
    } else {
      if (llmProvider === 'sglang') {
        // SGLang: llmService is null — use streaming service or direct REST
        if (onToken) {
          const synthMessages = [
            ...chatHistory.map(m => ({ role: m.role === 'model' ? 'assistant' : m.role, content: Array.isArray(m.parts) ? m.parts[0].text : (m.text || m.content) })),
            { role: 'user', content: synthesizerUserQuery }
          ];
          finalAnswerWithThinking = await llmStreamingService.streamCompletion({
            messages: synthMessages,
            provider: 'sglang',
            model: llmOptions.model,
            systemPrompt: finalSystemPrompt,
            onToken: onToken,
            options: llmOptions,
          });
        } else {
          const axios = require('axios');
          const sglUrl = process.env.SGLANG_CHAT_URL || 'http://localhost:8000/v1';
          const sglModel = process.env.SGLANG_CHAT_MODEL || 'Qwen/Qwen2.5-7B-Instruct-AWQ';
          const synthMsgs = [
            ...(finalSystemPrompt ? [{ role: 'system', content: finalSystemPrompt }] : []),
            ...chatHistory.map(m => ({ role: m.role === 'model' ? 'assistant' : m.role, content: Array.isArray(m.parts) ? m.parts[0].text : (m.text || m.content) })),
            { role: 'user', content: synthesizerUserQuery }
          ];
          const sglResp = await axios.post(`${sglUrl}/chat/completions`, {
            model: sglModel, messages: synthMsgs,
            max_tokens: Math.min(4096, Math.max(512, sglangCaps.getModelMaxContext() - Math.ceil(synthMsgs.map(m => m.content).join(' ').length / 3.5) - 256)),
            temperature: 0.7, stream: false
          }, { timeout: 60000 });
          finalAnswerWithThinking = sglResp.data?.choices?.[0]?.message?.content?.trim() || '';
        }
      } else {
        finalAnswerWithThinking = await llmService.generateContentWithHistory(
          chatHistory,
          synthesizerUserQuery,
          finalSystemPrompt,
          llmOptions
        );
      }
    }

    const thinkingMatch = finalAnswerWithThinking.match(
      /<thinking>([\s\S]*?)<\/thinking>/i
    );
    const thinking = thinkingMatch ? thinkingMatch[1].trim() : null;
    const finalAnswer = thinking
      ? finalAnswerWithThinking
        .replace(/<thinking>[\s\S]*?<\/thinking>\s*/i, "")
        .trim()
      : finalAnswerWithThinking;

    return {
      finalAnswer: sanitizeGeneratedText(finalAnswer),
      thinking,
      references: toolReferences,
      sourcePipeline: pipeline,
      reasoningMeta: {
        branchCount: chain.length,
        llmCallCount: 2,
        reasoningDepth: chain.length,
        toolCalls: chain.length,
        performanceDiagnostics: {
          routingTime: 0,
          llmTime: 0,
          toolTime: toolTimeMs,
          dbTime: 0,
          redisTime: 0,
        }
      }
    };
  } catch (error) {
    log.error('AI', `Tool execution failed: ${toolCall.tool_name}`, error);
    return {
      finalAnswer: `I encountered an unexpected issue while trying to help you. It seems like one of my internal tools is currently unavailable. Please try again or rephrase your request!`,
      references: [],
      thinking: null,
      sourcePipeline: `agent-error-tool-failed`,
    };
  }
}

module.exports = {
  processAgenticRequest,
  isComplexQuery,
};