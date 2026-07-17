// server/services/totOrchestrator.js

const { processAgenticRequest } = require('./agentService');
const geminiService = require('./geminiService');
const ollamaService = require('./ollamaService');
const { getProviderChain } = require('./providerPriorityService');
const { availableTools } = require('./toolRegistry');
const { PLANNER_PROMPT_TEMPLATE, EVALUATOR_PROMPT_TEMPLATE, createSynthesizerPrompt, CHAT_MAIN_SYSTEM_PROMPT } = require('../config/promptTemplates');
const log = require('../utils/logger');
const ReasoningLog = require('../models/ReasoningLog');
const { createStreamingManager } = require('./restrictedStreamingService'); // [Team 9 merge]
const ReasoningTelemetryLog = require('../models/ReasoningTelemetryLog');
const pruningService = require('./totPruningService');
const llmStreamingService = require('./llmStreamingService');
const decompositionService = require('./taskDecompositionService');
const TaskGraphManager = require('./taskGraphManager');
const { getFeatureFlagsSnapshot } = require('./debugFeatureFlagsService');
const { redisClient } = require('../config/redisClient');
const { safe, sanitizeGeneratedText } = require('../utils/promptSanitizer');

const TOT_STATE_TTL_SECONDS = Number(process.env.TOT_STATE_TTL_SECONDS || 21600);
const MAX_TOT_TASKS_NORMAL_CHAT = 1; // Limit to 1 — avoids parallel expensive branch generation

function isStepConfidenceEnabled() {
    return getFeatureFlagsSnapshot().ENABLE_STEP_CONFIDENCE;
}

function isDynamicBranchingEnabled() {
    return getFeatureFlagsSnapshot().ENABLE_DYNAMIC_BRANCHING;
}

async function loadToTState(sessionId) {
    if (!sessionId || !redisClient || !redisClient.isOpen) return null;
    try {
        const raw = await redisClient.get(`tot_state:${sessionId}`);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return {
            priorInsights: Array.isArray(parsed?.priorInsights) ? parsed.priorInsights.slice(0, 25) : [],
            branchHistory: Array.isArray(parsed?.branchHistory) ? parsed.branchHistory.slice(0, 30) : [],
            confidenceHistory: Array.isArray(parsed?.confidenceHistory) ? parsed.confidenceHistory.slice(0, 30) : [],
            updatedAt: Number(parsed?.updatedAt || Date.now())
        };
    } catch {
        return null;
    }
}

async function saveToTState(sessionId, state) {
    if (!sessionId || !redisClient || !redisClient.isOpen || !state) return;
    try {
        await redisClient.set(`tot_state:${sessionId}`, JSON.stringify({
            priorInsights: Array.isArray(state?.priorInsights) ? state.priorInsights.slice(0, 25) : [],
            branchHistory: Array.isArray(state?.branchHistory) ? state.branchHistory.slice(0, 30) : [],
            confidenceHistory: Array.isArray(state?.confidenceHistory) ? state.confidenceHistory.slice(0, 30) : [],
            updatedAt: Date.now()
        }), { EX: TOT_STATE_TTL_SECONDS });
    } catch {
        // non-blocking
    }
}

function normalizeText(v) {
    return String(v || '').toLowerCase();
}

function evaluateLogicalConsistency(step) {
    const thought = normalizeText(step.thought);
    const observation = normalizeText(step.observation);
    const action = normalizeText(step.action);
    if (!thought && !observation) return 0.45;
    const thoughtWords = thought.split(/\s+/).filter(w => w.length > 4);
    const overlap = thoughtWords.filter(w => observation.includes(w)).length;
    const overlapRatio = thoughtWords.length ? overlap / thoughtWords.length : 0.35;
    const actionBoost = action && (observation.includes(action) || thought.includes(action)) ? 0.1 : 0;
    return clamp(0.35 + overlapRatio + actionBoost, 0, 1);
}

function evaluateEvidence(step) {
    const observation = normalizeText(step.observation);
    const referencesCount = Array.isArray(step.references) ? step.references.length : 0;
    const hasStructuredEvidence = /(data|study|source|result|stat|citation|evidence|found|retriev)/i.test(observation);
    const lengthFactor = clamp((observation.length || 0) / 300, 0, 1);
    return clamp((referencesCount > 0 ? 0.4 : 0) + (hasStructuredEvidence ? 0.35 : 0.15) + (lengthFactor * 0.25), 0, 1);
}

function detectContradiction(step) {
    const observation = normalizeText(step.observation);
    const contradictionHints = ['however', 'but', 'contradict', 'inconsistent', 'conflict', 'not found', 'failed'];
    const hits = contradictionHints.filter(k => observation.includes(k)).length;
    return clamp(hits * 0.18, 0, 0.8);
}

function detectSpeculation(step) {
    const observation = normalizeText(step.observation);
    const speculativeHints = ['might', 'maybe', 'possibly', 'unclear', 'unknown', 'assume', 'guess'];
    const hits = speculativeHints.filter(k => observation.includes(k)).length;
    return clamp(hits * 0.15, 0, 0.7);
}

function weightedScore({ coherence, evidenceStrength, contradictionPenalty, uncertaintyPenalty }) {
    const base =
        (coherence * 0.4) +
        (evidenceStrength * 0.4) -
        (contradictionPenalty * 0.12) -
        (uncertaintyPenalty * 0.08);
    return Math.round(clamp(base, 0, 1) * 100);
}

function calculateStepConfidence(step) {
    const coherence = evaluateLogicalConsistency(step);
    const evidenceStrength = evaluateEvidence(step);
    const contradictionPenalty = detectContradiction(step);
    const uncertaintyPenalty = detectSpeculation(step);

    const stepConfidence = weightedScore({ coherence, evidenceStrength, contradictionPenalty, uncertaintyPenalty });
    return {
        stepConfidence,
        reasoningScore: Math.round(((coherence + evidenceStrength) / 2) * 100),
        uncertaintyFactors: [
            contradictionPenalty > 0.25 ? 'possible-contradiction' : null,
            uncertaintyPenalty > 0.25 ? 'speculative-language' : null,
            evidenceStrength < 0.4 ? 'weak-evidence' : null
        ].filter(Boolean)
    };
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

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function isPredictiveQuery(query = '') {
    const q = String(query).toLowerCase();
    return ['predict', 'forecast', 'future', 'next', 'risk', 'probability', 'what if', 'scenario', 'likely', 'outlook'].some(k => q.includes(k));
}

function userAskedForRecommendations(query = '') {
    const q = String(query).toLowerCase();
    return [
        'recommend', 'recommendation', 'what should i do', 'what should we do', 'solution',
        'how to solve', 'mitigate', 'mitigation', 'action plan', 'steps to prevent'
    ].some(k => q.includes(k));
}

async function buildReasoningModelForToT(query, finalContext, requestContext) {
    const smartLlm = getSmartLlmService(requestContext);
    const prompt = `Build a concise causal model.

QUESTION:
${safe(query)}

CONTEXT:
${safe(String(finalContext || '').slice(0, 4000))}

Return strict JSON only:
{
    "mechanisms":[
        {
            "driver":"...",
            "trigger":"...",
            "immediateReaction":"...",
            "secondaryEscalation":"...",
            "systemConsequence":"...",
            "chain":["trigger","immediate reaction","secondary escalation","system-level consequence"]
        }
    ],
  "variables":["..."],
  "relationships":[{"from":"A","to":"B","effect":"increases|decreases","why":"..."}],
  "feedbackLoops":["..."],
  "constraints":["..."],
  "assumptions":["..."],
  "uncertaintyFactors":["..."]
}

RULES:
- Minimum mechanisms: 4
- Every major cause must include explicit escalation chain elements.`;

    const raw = await smartLlm.generateContentWithHistory([], prompt, 'Return strict JSON only.', requestContext);
    const parsed = safeJsonParseFromText(raw, {}) || {};
    return {
        mechanisms: Array.isArray(parsed.mechanisms) ? parsed.mechanisms.slice(0, 8) : [],
        variables: Array.isArray(parsed.variables) ? parsed.variables.slice(0, 10) : [],
        relationships: Array.isArray(parsed.relationships) ? parsed.relationships.slice(0, 12) : [],
        feedbackLoops: Array.isArray(parsed.feedbackLoops) ? parsed.feedbackLoops.slice(0, 8) : [],
        constraints: Array.isArray(parsed.constraints) ? parsed.constraints.slice(0, 8) : [],
        assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions.slice(0, 8) : [],
        uncertaintyFactors: Array.isArray(parsed.uncertaintyFactors) ? parsed.uncertaintyFactors.slice(0, 8) : []
    };
}

async function simulateScenariosForToT(query, model, requestContext) {
    const predictive = isPredictiveQuery(query);

    const smartLlm = getSmartLlmService(requestContext);
    const prompt = `Generate three scenarios for this predictive question.

QUESTION:
${safe(query)}

MODEL:
${safe(JSON.stringify(model))}

Return strict JSON only:
{
  "scenarios": [
        {"name":"Scenario A (Most Likely)","trigger":"...","propagation":"...","globalEffects":"...","outcome":"stabilization|partial stabilization|collapse","likelihood":"High likelihood|Moderate likelihood|Low likelihood / high impact"},
        {"name":"Scenario B (System Stress)","trigger":"...","propagation":"...","globalEffects":"...","outcome":"stabilization|partial stabilization|collapse","likelihood":"High likelihood|Moderate likelihood|Low likelihood / high impact"},
        {"name":"Scenario C (Low Probability / High Impact)","trigger":"...","propagation":"...","globalEffects":"...","outcome":"stabilization|partial stabilization|collapse","likelihood":"High likelihood|Moderate likelihood|Low likelihood / high impact"}
  ]
}`;

    const raw = await smartLlm.generateContentWithHistory([], prompt, 'Return strict JSON only.', requestContext);
    const parsed = safeJsonParseFromText(raw, {}) || {};
    let scenarios = Array.isArray(parsed.scenarios) ? parsed.scenarios.slice(0, 3) : [];
    if (scenarios.length < 3) {
        scenarios = [
            { name: 'Scenario A (Most Likely)', trigger: 'Primary drivers continue', propagation: 'Linear system response', globalEffects: 'Manageable but meaningful impact', outcome: 'partial stabilization', likelihood: 'Moderate likelihood' },
            { name: 'Scenario B (System Stress)', trigger: 'Multiple adverse factors align', propagation: 'Cross-system amplification', globalEffects: 'High volatility and broad disruption', outcome: 'collapse', likelihood: 'Low likelihood / high impact' },
            { name: 'Scenario C (Low Probability / High Impact)', trigger: 'Tail-risk shock event', propagation: 'Rapid nonlinear escalation', globalEffects: 'Severe global spillovers', outcome: 'collapse', likelihood: 'Low likelihood / high impact' }
        ];
    }
    return { predictive, scenarios };
}

async function runSelfCritiqueForToT(query, model, scenarios, requestContext) {
    const smartLlm = getSmartLlmService(requestContext);
    const prompt = `Run a self-critique.

QUESTION:
${safe(query)}

MODEL:
${safe(JSON.stringify(model))}

SCENARIOS:
${safe(JSON.stringify(scenarios))}

Return strict JSON only:
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
    const raw = await smartLlm.generateContentWithHistory([], prompt, 'Return strict JSON only.', requestContext);
    return safeJsonParseFromText(raw, {}) || {};
}

async function extractKeyInsightForToT(query, model, scenarios, requestContext) {
    const smartLlm = getSmartLlmService(requestContext);
    const prompt = `Derive one synthesized non-obvious insight.

QUESTION:
${safe(query)}

MECHANISMS:
${safe(JSON.stringify(model.mechanisms || []))}

SCENARIOS:
${safe(JSON.stringify(scenarios || []))}

Return strict JSON only:
{ "keyInsight": "single high-value analytical insight" }`;
    const raw = await smartLlm.generateContentWithHistory([], prompt, 'Return strict JSON only.', requestContext);
    const parsed = safeJsonParseFromText(raw, {}) || {};
    return String(parsed.keyInsight || '').trim() ||
        'The biggest systemic risk is often escalation speed outrunning institutional response capacity.';
}

function calibrateConfidence({ planConfidence, model, critique, predictive }) {
    const evidenceStrength = clamp((planConfidence || 50) + (model.relationships.length * 1.5), 20, 95);
    const modelConsistency = clamp(40 + (model.relationships.length * 2) + (model.feedbackLoops.length * 2) - (model.assumptions.length * 1.5), 20, 95);
    const uncertaintyPenalty = -clamp((model.uncertaintyFactors.length * 2) + (model.assumptions.length * 1.5), 5, 30);
    const scenarioDependence = predictive ? -15 : -5;

    let confidence = Math.round(
        (evidenceStrength * 0.35) +
        (modelConsistency * 0.35) +
        ((100 + uncertaintyPenalty) * 0.2) +
        ((100 + scenarioDependence) * 0.1)
    );

    confidence = clamp(confidence, 20, predictive ? 85 : 95);

    return {
        confidence,
        basis: {
            evidence_strength: Number(evidenceStrength.toFixed(1)),
            model_consistency: Number(modelConsistency.toFixed(1)),
            uncertainty_penalty: Number(uncertaintyPenalty.toFixed(1)),
            scenario_dependence: Number(scenarioDependence.toFixed(1)),
            overstatement_risk: critique?.overstatementRisk || 'unknown'
        }
    };
}

/**
 * Smart LLM Service that handles automatic fallback between providers
 * @param {object} context - Request context containing keys and preferences
 * @returns {object} An object with a resilient generateContentWithHistory method
 */
function getSmartLlmService(context) {
    const preferred = context.llmProvider || 'ollama';
    let chain = [];

    chain = getProviderChain(preferred);

    log.info('AI', `Provider set to ${preferred}`);

    return {
        generateContentWithHistory: async (history, query, systemPrompt, options) => {
            let lastErr = null;
            for (const provider of chain) {
                let providerOptions = {
                    temperature: options.temperature || 0.7,
                    maxOutputTokens: options.maxOutputTokens || 2048
                };

                const service = provider === 'ollama' ? ollamaService : geminiService;

                if (provider === 'gemini') {
                    providerOptions.model = options.geminiModel || process.env.GEMINI_MODEL || 'gemini-2.0-flash';
                    providerOptions.apiKey = options.apiKey || process.env.GEMINI_API_KEY;
                } else if (provider === 'ollama') {
                    providerOptions.model = options.ollamaModel || process.env.OLLAMA_DEFAULT_MODEL || 'qwen3.5:9b';
                    providerOptions.ollamaUrl = options.ollamaUrl || process.env.OLLAMA_API_BASE_URL;
                    providerOptions.think = true; // qwen3 is a thinking model
                }

                log.info('AI', `Request -> ${provider.toUpperCase()} (${providerOptions.model || 'default'})`);

                try {
                    return await service.generateContentWithHistory(history, query, systemPrompt, providerOptions);
                } catch (err) {
                    lastErr = err;
                    log.warn(provider.toUpperCase(), `LLM request failed, trying fallback: ${err.message}`);
                }
            }

            throw lastErr || new Error('All providers failed in smart LLM fallback chain.');
        }
    };
}

async function isQueryComplex(query, requestContext) {
    // If a document context is active, always treat as complex
    if (requestContext.documentContextName) {
        // log.info('TOT', `Complexity Gate: COMPLEX (Doc context active)`);
        return true;
    }

    const lowerQuery = query.toLowerCase().trim();
    const wordCount = query.split(/\s+/).length;
    const questionMarkCount = (query.match(/\?/g) || []).length;

    // Signal 1: Analytical / conceptual keywords
    const complexityKeywords = [
        'explain', 'compare', 'contrast', 'analyze', 'analyse', 'evaluate',
        'how does', 'how do', 'how would', 'how can', 'how is',
        'why does', 'why do', 'why is', 'why are', 'why would',
        'what is the difference', 'what are the differences',
        'what is the relationship', 'what are the implications',
        'pros and cons', 'advantages and disadvantages',
        'step by step', 'in detail', 'in depth', 'elaborate',
        'describe the process', 'walk me through',
        'trade-off', 'tradeoff', 'when should i use',
        'design', 'implement', 'architecture', 'algorithm',
        'derive', 'prove', 'justify', 'critically',
        'impact', 'significance', 'implications',
        'relationship between', 'connect', 'correlat'
    ];
    const hasComplexKeyword = complexityKeywords.some(kw => lowerQuery.includes(kw));

    // Signal 2: Multi-part question (multiple question marks, or conjunctions suggesting parts)
    const multiPartIndicators = [' and ', ' also ', ' additionally ', ' furthermore ', ' as well as '];
    const hasMultipleParts = questionMarkCount > 1 || multiPartIndicators.some(ind => lowerQuery.includes(ind));

    // Signal 3: Sufficient length (more than a trivial greeting/factual lookup)
    const hasSubstantialLength = wordCount >= 8;

    // Signal 4: Simple queries that should NEVER be complex (greetings, factual lookups)
    const simplePatterns = [
        /^(hi|hello|hey|greetings|good morning|good evening|thanks|thank you|ok|okay|sure|yes|no|bye)\b/i,
        /^what is [a-z]+\??$/i,  // "What is X?" — simple definition
        /^define /i,
        /^who is /i,
        /^when (was|is|did) /i,
    ];
    const isObviouslySimple = simplePatterns.some(p => p.test(lowerQuery));

    if (isObviouslySimple && wordCount < 8) {
        // log.info('TOT', `Complexity Gate: SIMPLE`);
        return false;
    }

    // Bias toward COMPLEX: user explicitly opted into critical thinking mode
    // At least one signal is enough to classify as complex
    const isComplex = hasComplexKeyword || hasMultipleParts || hasSubstantialLength;

    // log.info('TOT', `Complexity Gate: ${isComplex ? 'COMPLEX' : 'SIMPLE'}`);
    return isComplex;
}

async function getHistoricalConfidence(userId) {
    try {
        if (!userId) return 70;
        const logs = await ReasoningLog.find({ userId }).sort({ createdAt: -1 }).limit(5).select('confidenceScore').lean();
        if (!logs || logs.length === 0) return 70;
        const avg = logs.reduce((sum, l) => sum + (Number(l.confidenceScore) || 0), 0) / logs.length;
        return Math.round(avg);
    } catch {
        return 70;
    }
}

async function saveReasoningTelemetry(payload) {
    try {
        if (!payload) return;
        await ReasoningTelemetryLog.create(payload);
    } catch {
        // non-blocking
    }
}

async function generatePlans(query, requestContext) {
    log.info('TOT', "Decomposing query...");

    // Calculate optimal branch count if needed (currently decomposition service handles its own branch count or defaults to 3)
    // Determine the current mode instructions for the planner
    let currentModeInstruction = "";
    const isAcademic = requestContext.isAcademicSearchEnabled;
    const isWeb = requestContext.isWebSearchEnabled;
    const docContext = requestContext.documentContextName;

    if (isAcademic) currentModeInstruction = "ADHERE TO MODE: ACADEMIC SEARCH is active. At least one task must be 'academic_search'.";
    else if (isWeb) currentModeInstruction = "ADHERE TO MODE: WEB SEARCH is active. At least one task must be 'web_search'.";
    else if (docContext) currentModeInstruction = `ADHERE TO MODE: DOCUMENT RAG for '${docContext}'. Prioritize 'rag_search'.`;
    else currentModeInstruction = "DEFAULT MODE: Choose tools like 'web_search' or 'academic_search' ONLY if necessary.";

    const toolsForPrompt = Object.entries(availableTools).map(([name, tool]) => ({ name, description: tool.description }));

    let branchCount = 3;
    if (isDynamicBranchingEnabled()) {
        try {
            const queryComplexity = await isQueryComplex(query, requestContext) ? 0.9 : 0.4;
            const historicalConfidence = await getHistoricalConfidence(requestContext.userId);
            const tokenBudget = Number(requestContext.maxOutputTokens) || 2048;
            branchCount = pruningService.calculateOptimalBranchCount({
                query,
                queryComplexity,
                tokenBudget,
                historicalConfidence,
                requestContext
            });
        } catch {
            branchCount = 3;
        }
    }

    const plans = await decompositionService.decomposeQuery(query, {
        ...requestContext,
        availableTools: toolsForPrompt,
        currentModeInstruction,
        branchCount
    });

    return plans;
}

async function evaluatePlans(plans, query, requestContext) {
    log.info('TOT', "Evaluating proposed plans...");
    if (!plans || plans.length === 0) throw new Error("No plans provided to evaluate.");
    if (plans.length === 1) {
        log.info('TOT', 'Single plan - selecting by default');
        return { winningPlan: plans[0], confidenceScore: 100, reasoning: "Only one plan provided." };
    }

    const { llmProvider, ...llmOptions } = requestContext;
    const smartLlm = getSmartLlmService(requestContext);
    const plansJsonString = JSON.stringify(plans, null, 2);

    const evaluatorPrompt = EVALUATOR_PROMPT_TEMPLATE.replace("{userQuery}", query).replace("{plansJsonString}", plansJsonString);

    const evaluatorOptions = { ...llmOptions };

    try {
        const responseText = await smartLlm.generateContentWithHistory(
            [], evaluatorPrompt, "You are an evaluating agent.", evaluatorOptions
        );
        const jsonMatch = responseText.match(/```(json)?\s*([\s\S]+?)\s*```/);
        const jsonString = jsonMatch ? jsonMatch[2] : responseText;
        const parsedResponse = JSON.parse(jsonString);

        if (parsedResponse.best_plan_name) {
            const winningPlan = plans.find(p => p.name === parsedResponse.best_plan_name);
            if (winningPlan) {
                log.success('TOT', `Plan approved: "${winningPlan.name}" (${parsedResponse.confidence_score}%)`);
                return {
                    winningPlan,
                    confidenceScore: parsedResponse.confidence_score || 0,
                    reasoning: parsedResponse.reasoning || ""
                };
            }
        }
    } catch (error) {
        log.error('TOT', "Evaluator failed to parse LLM response. Defaulting to first plan.", error);
    }

    log.warn('TOT', `Fallback strategy: "${plans[0].name}"`);
    return { winningPlan: plans[0], confidenceScore: 50, reasoning: "Defaulted to first plan." };
}

async function executePlan(plan, query, requestContext, streamCallback) {
    log.info('TOT', `Executing plan: "${plan.name}"`);

    // Normalize tasks for TaskGraphManager
    let tasks = [];
    if (plan.tasks) {
        tasks = plan.tasks;
    } else if (plan.steps) {
        // Backward compatibility for linear steps
        tasks = TaskGraphManager.convertFlatToDAG(plan.steps);
    }

    const allowResearchDepth = requestContext?.intent === 'research' || requestContext?.deepResearchContext === true;
    if (!allowResearchDepth && tasks.length > MAX_TOT_TASKS_NORMAL_CHAT) {
        const limitedTasks = tasks.slice(0, MAX_TOT_TASKS_NORMAL_CHAT);
        const keepIds = new Set(limitedTasks.map(t => t.id));
        tasks = limitedTasks.map(task => ({
            ...task,
            dependsOn: Array.isArray(task.dependsOn)
                ? task.dependsOn.filter(depId => keepIds.has(depId))
                : []
        }));
    }

    const graph = new TaskGraphManager(tasks);

    if (graph.hasCircularDependencies()) {
        log.warn('TOT', "Circular dependency detected in plan graph.");
    }

    const allReferences = [];
    const collectedContexts = [];
    const stepConfidences = [];
    let earlyAbortTriggered = false;

    const runTask = async (task) => {
        const taskId = task.id;
        // log.info('TOT', `Task: ${task.title}`);

        streamCallback({
            type: 'step_update',
            content: {
                stepId: taskId,
                title: task.title,
                status: 'processing',
                dependencies: task.dependsOn,
                timestamp: Date.now()
            }
        });

        const depContext = graph.getDependencyContext(taskId);
        let taskResult;
        let thought = task.description || task.title || 'Executing task';
        let action = task.type === 'tool' ? (task.tool_call?.tool_name || 'tool') : 'reasoning';
        let observation = '';

        try {
            if (task.type === 'tool' && task.tool_call) {
                const toolName = task.tool_call.tool_name;
                const toolParams = { ...task.tool_call.parameters, context: depContext };
                const tool = availableTools[toolName];
                action = toolName;

                if (tool) {
                    const result = await tool.execute(toolParams, requestContext);
                    observation = result.toolOutput || `Tool ${toolName} executed successfully.`;
                    taskResult = {
                        finalAnswer: observation || `Success.`,
                        thinking: `Executed ${toolName} for ${task.title}.`,
                        references: result.references || [],
                        status: 'completed'
                    };
                } else {
                    throw new Error(`Tool ${toolName} not found.`);
                }
            } else {
                // Reasoning or fallback to direct answer
                const smartLlm = getSmartLlmService(requestContext);
                const llmOptions = {
                    model: requestContext.ollamaModel || requestContext.geminiModel || process.env.OLLAMA_DEFAULT_MODEL || 'qwen3.5:9b',
                    apiKey: requestContext.apiKey,
                    ollamaUrl: requestContext.ollamaUrl,
                    think: true
                };

                const systemPrompt = `Task Context from previous steps:\n${depContext}\n\nTask Instruction: ${task.description}`;
                const response = await smartLlm.generateContentWithHistory([], query, systemPrompt, llmOptions);
                observation = response;

                const thinkingMatch = response.match(/<thinking>([\s\S]*?)<\/thinking>/i);
                taskResult = {
                    finalAnswer: thinkingMatch ? response.replace(/<thinking>[\s\S]*?<\/thinking>\s*/i, "").trim() : response,
                    thinking: thinkingMatch ? thinkingMatch[1].trim() : "Analysis complete.",
                    references: [],
                    status: 'completed'
                };
            }

            // Success
            graph.markTaskComplete(taskId, taskResult.finalAnswer);
            if (taskResult.references) allReferences.push(...taskResult.references);
            collectedContexts.push(`--- Task: ${task.title} ---\n${taskResult.finalAnswer}`);

            const legacyScore = pruningService.scoreStepConfidence(task, {
                ...taskResult,
                sourcePipeline: 'tot-task-success',
                tool_call: task.tool_call
            }, depContext);

            const confidenceDetails = isStepConfidenceEnabled()
                ? calculateStepConfidence({ thought, action, observation, references: taskResult.references })
                : { stepConfidence: legacyScore, reasoningScore: legacyScore, uncertaintyFactors: [] };

            stepConfidences.push(confidenceDetails.stepConfidence);

            streamCallback({
                type: 'step_update',
                content: {
                    stepId: taskId,
                    status: 'completed',
                    content: taskResult.thinking,
                    thought,
                    action,
                    observation: String(observation || '').slice(0, 700),
                    stepConfidence: confidenceDetails.stepConfidence,
                    reasoningScore: confidenceDetails.reasoningScore,
                    uncertaintyFactors: confidenceDetails.uncertaintyFactors,
                    timestamp: Date.now()
                }
            });

            if (isStepConfidenceEnabled() && pruningService.shouldAbortExecution(stepConfidences, stepConfidences.length - 1)) {
                earlyAbortTriggered = true;
            }

        } catch (error) {
            log.warn('TOT', `Task "${task.title}" failed.`);
            graph.markTaskFailed(taskId, error.message);

            const failedDetails = isStepConfidenceEnabled()
                ? calculateStepConfidence({ thought, action, observation: error.message, references: [] })
                : { stepConfidence: 20, reasoningScore: 20, uncertaintyFactors: ['execution-failure'] };
            stepConfidences.push(Math.min(failedDetails.stepConfidence, 25));

            streamCallback({
                type: 'step_update',
                content: {
                    stepId: taskId,
                    status: 'failed',
                    content: `Task could not be completed.`,
                    thought,
                    action,
                    observation: String(error.message || 'Task failed.'),
                    stepConfidence: Math.min(failedDetails.stepConfidence, 25),
                    reasoningScore: failedDetails.reasoningScore,
                    uncertaintyFactors: failedDetails.uncertaintyFactors,
                    timestamp: Date.now()
                }
            });
        }
    };

    // Parallel execution loop
    while (!graph.isFinished()) {
        const executable = graph.getExecutableTasks();
        if (executable.length === 0) {
            // Check if we're stuck (all pending but no executable)
            const activeCount = graph.tasks.filter(t => t.status === 'running').length;
            if (activeCount === 0) {
                const pendingCount = graph.tasks.filter(t => t.status === 'pending').length;
                if (pendingCount > 0) {
                    log.error('TOT', "Execution deadlock detected");
                }
                break;
            }
            // Wait a bit and check again (tasks are running)
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
        }

        // log.info('TOT', `Dispatching ${executable.length} tasks`);
        // Execute all currently ready tasks in parallel
        executable.forEach(t => t.status = 'running'); // Mark as running before dispatching

        // We don't use Promise.all here because we want to loop as soon as ANY task finishes
        // But for simplicity in this loop, we'll wait for THIS batch
        await Promise.all(executable.map(t => runTask(t)));

        if (earlyAbortTriggered) {
            const pendingTasks = graph.tasks.filter(t => t.status === 'pending');

            // Hard safety: keep at least one survived/completed path. We only prune remaining pending tasks.
            pendingTasks.forEach(p => {
                p.status = 'skipped';
                streamCallback({
                    type: 'step_update',
                    content: {
                        stepId: p.id,
                        title: p.title,
                        status: 'failed',
                        content: 'Pruned due to repeated low-confidence trajectory.',
                        timestamp: Date.now()
                    }
                });
            });

            break;
        }
    }

    const finalContext = collectedContexts.join("\n\n");
    return {
        finalContext,
        allReferences,
        finalStepStatuses: graph.tasks,
        stepConfidences,
        earlyAbortTriggered
    };
}

async function synthesizeFinalAnswer(originalQuery, finalContext, chatHistory, requestContext, onToken = null) {
    log.info('TOT', "Synthesizing response...");
    const { ...llmOptions } = requestContext;

    const synthesizerUserQuery = createSynthesizerPrompt(
        originalQuery, finalContext, 'tree_of_thought_synthesis'
    );

    const finalSystemPrompt = CHAT_MAIN_SYSTEM_PROMPT();

    if (onToken && requestContext.llmProvider === 'gemini') {
        const messagesForStreaming = [
            ...chatHistory.map(m => ({ role: m.role, content: Array.isArray(m.parts) ? m.parts[0].text : (m.text || m.content) })),
            { role: 'user', content: synthesizerUserQuery }
        ];

        return await llmStreamingService.streamCompletion({
            messages: messagesForStreaming,
            provider: requestContext.llmProvider,
            model: llmOptions.geminiModel || llmOptions.model,
            apiKey: llmOptions.apiKey,
            systemPrompt: finalSystemPrompt,
            onToken,
            options: llmOptions
        });
    } else {
        const smartLlm = getSmartLlmService(requestContext);
        return await smartLlm.generateContentWithHistory(
            chatHistory, synthesizerUserQuery, finalSystemPrompt, llmOptions
        );
    }
}

async function runCorrectionLoop(originalQuery, failureReason, requestContext, streamCallback, attempt = 1) {
    log.warn('AI', `Self-correction triggered: ${failureReason}`);

    streamCallback({
        type: 'step_update',
        content: {
            stepId: `correction_${attempt}`,
            title: `Self-Correction Attempt ${attempt}`,
            status: 'processing',
            content: `Triggering correction due to: ${failureReason}. Reflecting and revising strategy...`,
            timestamp: Date.now()
        }
    });

    // Strategy: Modify the query slightly to emphasize accuracy or handle the specific failure
    const revisedQuery = `I previously attempted to answer: "${originalQuery}" but encountered an issue: ${failureReason}. Please provide a more robust and corrected response.`;

    // In a real implementation, we would pass 'failureReason' back into generatePlans to get a better strategy.
    // For now, we reuse the standard flow but with awareness of the failure.
    const result = await processQueryWithToT_Streaming(revisedQuery, [], { ...requestContext, isInternalCorrection: true }, streamCallback, attempt);

    streamCallback({
        type: 'step_update',
        content: {
            stepId: `correction_${attempt}`,
            title: `Self-Correction Attempt ${attempt}`,
            status: result.finalAnswer ? 'completed' : 'failed',
            timestamp: Date.now()
        }
    });

    return result;
}

function aggregateStepConfidences(stepConfidences = [], fallback = 70) {
    if (!Array.isArray(stepConfidences) || stepConfidences.length === 0) return fallback;
    const avg = stepConfidences.reduce((a, b) => a + (Number(b) || 0), 0) / stepConfidences.length;
    return Math.round(avg);
}

async function saveReasoningLog(userId, sessionId, query, allSteps, confidenceScore, correctionsTriggered, sourcePipeline, telemetry = null) {
    try {
        if (!userId || !sessionId) return;
        const log = new ReasoningLog({
            userId,
            sessionId,
            query,
            steps: allSteps.map(s => ({
                stepId: s.stepId,
                title: s.title,
                status: s.status,
                content: s.content,
                thought: s.thought,
                action: s.action,
                observation: s.observation,
                stepConfidence: s.stepConfidence,
                reasoningScore: s.reasoningScore,
                uncertaintyFactors: s.uncertaintyFactors,
                timestamp: s.timestamp
            })),
            confidenceScore,
            correctionsTriggered,
            sourcePipeline,
            telemetry
        });
        await log.save();
        // log.success('AI', `Reasoning Log saved (ID: ${sessionId})`);
    } catch (error) {
        // log.error('AI', 'Reasoning Log save failed', error);
    }
}

async function processQueryWithToT_Streaming(query, chatHistory, requestContext, streamCallback, correctionAttempt = 0) {
    const orchestratorStart = Date.now();
    const allSteps = [];
    const previousToTState = await loadToTState(requestContext?.sessionId);

    // [Team 9 merge] Check if restricted streaming is enabled; create buffered or pass-through manager
    const isRestrictedStreaming = getFeatureFlagsSnapshot().RESTRICT_TOT_STREAMING;
    const streamingManager = createStreamingManager(isRestrictedStreaming);

    // [Team 9 merge] Route intermediate step events through the manager during planning/execution
    const intermediateStreamCallback = isRestrictedStreaming
        ? streamingManager.streamCallback
        : streamCallback;

    const emitStep = (step) => {
        intermediateStreamCallback({ type: 'step_update', content: step }); // [Team 9 merge]
        // Update local history
        const existingIndex = allSteps.findIndex(s => s.stepId === step.stepId);
        if (existingIndex >= 0) {
            allSteps[existingIndex] = { ...allSteps[existingIndex], ...step };
        } else {
            allSteps.push(step);
        }
    };

    const sendStatus = (status) => {
        intermediateStreamCallback({ type: 'status_update', content: status }); // [Team 9 merge]
    };

    const queryPreview = query.length > 30 ? query.substring(0, 30) + '...' : query;

    // STEP 1: Complexity Check
    emitStep({ stepId: 'complexity_check', title: 'Complexity Analysis', status: 'processing', timestamp: Date.now() });
    sendStatus(`Understanding question depth…`);
    const isComplex = await isQueryComplex(query, requestContext);
    emitStep({ stepId: 'complexity_check', status: 'completed', content: `Query detected as ${isComplex ? 'COMPLEX' : 'SIMPLE'}.`, timestamp: Date.now() });

    if (!isComplex && !requestContext.isInternalCorrection) {
        sendStatus(`Constructing direct explanation…`);
        const directResponse = await processAgenticRequest(
            query,
            chatHistory,
            requestContext.systemPrompt,
            { ...requestContext, forceSimple: true },
            (token) => {
                // token can be a string (legacy) or an object { type, content } from handleThinkingTags
                if (typeof token === 'object' && token !== null && token.type) {
                    streamCallback(token); // Already structured, pass through
                } else {
                    streamCallback({ type: 'token', content: token });
                }
            }
        );

        if (directResponse.thinking) {
            emitStep({ stepId: 'direct_answer', title: 'Direct Response Plan', status: 'completed', content: directResponse.thinking, timestamp: Date.now() });
        }

        // Save Log (Direct)
        const directConfidence = Number.isFinite(directResponse.confidenceScore) ? directResponse.confidenceScore : 72;
        saveReasoningLog(requestContext.userId, requestContext.sessionId, query, allSteps, directConfidence, 0, `tot-direct`);

        return {
            finalAnswer: directResponse.finalAnswer,
            thoughts: directResponse.thinking,
            references: directResponse.references,
            sourcePipeline: directResponse.sourcePipeline,
            confidenceScore: directConfidence,
            reasoningMeta: {
                ...(directResponse.reasoningMeta || {}),
                branchCount: 1,
                llmCallCount: Number(directResponse?.reasoningMeta?.llmCallCount || 1),
                reasoningDepth: 1,
                toolCalls: Number(directResponse?.reasoningMeta?.toolCalls || 0),
                tokenUsageEstimate: Math.ceil((query.length + (directResponse.finalAnswer || '').length) / 4),
                performanceDiagnostics: {
                    routingTime: 0,
                    llmTime: Date.now() - orchestratorStart,
                    toolTime: 0,
                    dbTime: 0,
                    redisTime: 0,
                }
            }
        };
    }

    // STEP 2: Planning
    emitStep({ stepId: 'planning', title: 'Strategy Formation', status: 'processing', timestamp: Date.now() });
    sendStatus(`Designing reasoning strategy…`);
    const rawPlans = await generatePlans(query, requestContext);

    // Prune plans before evaluation
    const plans = pruningService.pruneBeforeEvaluation(rawPlans, query);
    // log.info('TOT', `Strategies: ${rawPlans.length} -> ${plans.length}`);

    const dynamicBranchCount = isDynamicBranchingEnabled()
        ? pruningService.calculateOptimalBranchCount({
            query,
            queryComplexity: isComplex ? 0.9 : 0.4,
            tokenBudget: Number(requestContext.maxOutputTokens) || 2048,
            historicalConfidence: await getHistoricalConfidence(requestContext.userId),
            requestContext
        })
        : 3;

    emitStep({
        stepId: 'planning',
        status: 'completed',
        content: `Generated ${rawPlans.length} plans, pruned to ${plans.length} for evaluation.`,
        dynamicBranchCount,
        branchesPruned: Math.max(0, rawPlans.length - plans.length),
        timestamp: Date.now()
    });

    // STEP 3: Evaluation
    emitStep({ stepId: 'evaluation', title: 'Plan Evaluation', status: 'processing', timestamp: Date.now() });
    sendStatus(`Evaluating competing strategies…`);
    const { winningPlan, confidenceScore, reasoning } = await evaluatePlans(plans, query, requestContext);

    emitStep({
        stepId: 'evaluation',
        status: 'completed',
        content: `Best plan: "${winningPlan.name}". Confidence: ${confidenceScore}%. Reasoning: ${reasoning}`,
        timestamp: Date.now()
    });

    // STEP 4: Execution
    sendStatus(`Gathering contextual signals…`);
    const { finalContext, allReferences, finalStepStatuses, stepConfidences = [], earlyAbortTriggered = false } = await executePlan(winningPlan, query, requestContext, (update) => {
        if (update.type === 'step_update') {
            emitStep(update.content);
        }
    });

    // STEP 5: Modeling
    emitStep({ stepId: 'modeling', title: 'Building Reasoning Model', status: 'processing', timestamp: Date.now() });
    sendStatus(`Building causal model…`);
    const reasoningModel = await buildReasoningModelForToT(query, finalContext, requestContext);
    if (!Array.isArray(reasoningModel.mechanisms) || reasoningModel.mechanisms.length < 4) {
        const fallbackMechanisms = ['primary trigger pathway', 'institutional response pathway', 'escalation pathway', 'system spillover pathway']
            .map((name, idx) => ({
                driver: name,
                trigger: `Trigger ${idx + 1}`,
                immediateReaction: 'Immediate actor response',
                secondaryEscalation: 'Amplification through connected systems',
                systemConsequence: 'System-level instability',
                chain: ['trigger', 'immediate reaction', 'secondary escalation', 'system-level consequence']
            }));
        reasoningModel.mechanisms = fallbackMechanisms;
    }
    emitStep({
        stepId: 'modeling',
        status: 'completed',
        content: `Model includes ${reasoningModel.mechanisms.length} mechanisms, ${reasoningModel.variables.length} variables and ${reasoningModel.relationships.length} relationships.`,
        timestamp: Date.now()
    });

    // STEP 6: Scenario Simulation
    emitStep({ stepId: 'scenario_simulation', title: 'Scenario Simulation', status: 'processing', timestamp: Date.now() });
    sendStatus(`Testing escalation and stress scenarios…`);
    const scenarioBundle = await simulateScenariosForToT(query, reasoningModel, requestContext);
    emitStep({
        stepId: 'scenario_simulation',
        status: 'completed',
        content: `Generated ${scenarioBundle.scenarios.length} scenarios (${scenarioBundle.predictive ? 'predictive framing' : 'analytical framing'}).`,
        timestamp: Date.now()
    });

    // STEPS 7 + 7b: Self-Critique and Key Insight run in parallel (both depend on scenarios, not on each other)
    emitStep({ stepId: 'self_critique', title: 'Self-Critique', status: 'processing', timestamp: Date.now() });
    sendStatus(`Checking internal consistency & extracting key insight…`);

    const [critique, keyInsight] = await Promise.all([
        runSelfCritiqueForToT(query, reasoningModel, scenarioBundle.scenarios, requestContext),
        extractKeyInsightForToT(query, reasoningModel, scenarioBundle.scenarios, requestContext)
    ]);

    emitStep({
        stepId: 'self_critique',
        status: 'completed',
        content: `Assumption dependence: ${critique.assumptionDependence || 'unknown'}, overstatement risk: ${critique.overstatementRisk || 'unknown'}.`,
        timestamp: Date.now()
    });

    const allowRecommendations = userAskedForRecommendations(query);

    // STEP 8: Synthesis
    emitStep({ stepId: 'synthesis', title: 'Final Synthesis', status: 'processing', timestamp: Date.now() });
    sendStatus(`Integrating insights into final explanation…`);

    // [Team 9 merge] Flush all buffered intermediate steps before synthesis begins so the
    // client receives the full planning/execution trace before the final answer streams
    if (isRestrictedStreaming) {
        streamingManager.flushBufferedSteps(streamCallback);
    }

    const synthesisContext = `${finalContext}\n\n[REASONING MODEL]\n${JSON.stringify(reasoningModel)}\n\n[SCENARIOS]\n${JSON.stringify(scenarioBundle.scenarios)}\n\n[SELF-CRITIQUE]\n${JSON.stringify(critique)}\n\n[KEY INSIGHT]\n${keyInsight}\n\n[QUALITY REQUIREMENTS]\n- Convert causes into mechanisms with escalation chains\n- Include sections in this exact order: Core Drivers (Mechanisms), Escalation Chains, Scenario Modeling, Uncertainty Analysis, Key Insight\n- Include at least one conditional statement\n- Use qualitative likelihood only (High likelihood / Moderate likelihood / Low likelihood / high impact)\n- Acknowledge uncertainty explicitly\n- Avoid purely descriptive summaries\n- ${allowRecommendations ? 'Recommendations allowed because user requested solutions.' : 'Do not provide recommendations unless explicitly asked.'}`;
    const finalAnswerWithThinking = await synthesizeFinalAnswer(query, synthesisContext, chatHistory, requestContext, (token) => {
        if (streamCallback) streamCallback({ type: 'token', content: token });
    });

    const thinkingMatch = finalAnswerWithThinking.match(/<thinking>([\s\S]*?)<\/thinking>/i);
    const thinking = thinkingMatch ? thinkingMatch[1].trim() : null;
    let finalAnswer = thinking ? finalAnswerWithThinking.replace(/<thinking>[\s\S]*?<\/thinking>\s*/i, '').trim() : finalAnswerWithThinking;

    const missingMechanismSignals = !/Core Drivers \(Mechanisms\)|Escalation Chains|Scenario Modeling|Uncertainty Analysis|Key Insight/i.test(finalAnswer);
    const critiqueWantsRefine = critique?.needsRefinement === true;
    if ((missingMechanismSignals || critiqueWantsRefine) && !requestContext.isInternalCorrection) {
        const refineContext = `${synthesisContext}\n\n[REFINEMENT REQUIRED]\n- Ensure mechanisms and chains are explicit\n- Ensure scenario section has trigger, propagation, global effects, outcome, and qualitative likelihood\n- Ensure uncertainty and key insight are explicit\n- Ensure recommendation suppression rule is respected`;
        const refined = await synthesizeFinalAnswer(query, refineContext, chatHistory, requestContext, (token) => {
            if (streamCallback) streamCallback({ type: 'token', content: token });
        });
        const refinedThinkingMatch = refined.match(/<thinking>([\s\S]*?)<\/thinking>/i);
        finalAnswer = refinedThinkingMatch ? refined.replace(/<thinking>[\s\S]*?<\/thinking>\s*/i, '').trim() : refined;
    }

    finalAnswer = sanitizeGeneratedText(finalAnswer);

    emitStep({ stepId: 'synthesis', status: 'completed', content: thinking || "Synthesis complete.", timestamp: Date.now() });

    // STEP 9: Confidence Calibration
    emitStep({ stepId: 'confidence_calibration', title: 'Confidence Calibration', status: 'processing', timestamp: Date.now() });
    sendStatus(`Calibrating confidence…`);
    const confidenceResult = calibrateConfidence({
        planConfidence: confidenceScore,
        model: reasoningModel,
        critique,
        predictive: scenarioBundle.predictive
    });
    const aggregatedStepConfidence = aggregateStepConfidences(stepConfidences, confidenceResult.confidence);
    const finalConfidence = aggregatedStepConfidence;
    streamCallback({ type: 'confidence_score', content: confidenceResult.confidence });
    emitStep({
        stepId: 'confidence_calibration',
        status: 'completed',
        content: `Confidence ${confidenceResult.confidence}% (predictive cap ${scenarioBundle.predictive ? 'applied' : 'not applied'}).`,
        timestamp: Date.now()
    });

    // SELF-CORRECTION CHECK
    const allowCorrectionLoop = requestContext?.intent === 'research' || requestContext?.deepResearchContext === true;
    if (allowCorrectionLoop && !requestContext.isInternalCorrection && correctionAttempt < 2) {
        let failureReason = null;
        if (confidenceResult.confidence < 60) failureReason = `Low confidence score (${confidenceResult.confidence}%)`;
        else if (!finalAnswer || finalAnswer.length < 20) failureReason = "Empty or low-quality response";

        if (failureReason) {
            log.warn('AI', `Quality check failed: ${failureReason}`);
            return await runCorrectionLoop(query, failureReason, requestContext, streamCallback, correctionAttempt + 1);
        }
    }

    // Save Reasoning Log Async (Non-blocking)
    saveReasoningLog(
        requestContext.userId,
        requestContext.sessionId,
        query,
        allSteps,
        finalConfidence,
        correctionAttempt,
        `tot-${requestContext.llmProvider}`,
        {
            totalBranchesGenerated: rawPlans.length,
            branchesPruned: Math.max(0, rawPlans.length - plans.length),
            executionTime: Date.now() - orchestratorStart,
            tokensUsed: Math.ceil((query.length + (finalContext || '').length + (finalAnswer || '').length) / 4),
            finalConfidence,
            dynamicBranchCount,
            earlyAbortTriggered
        }
    );

    void saveReasoningTelemetry({
        userId: requestContext.userId,
        sessionId: requestContext.sessionId,
        sourcePipeline: `tot-${requestContext.llmProvider}`,
        totalBranchesGenerated: rawPlans.length,
        branchesPruned: Math.max(0, rawPlans.length - plans.length),
        executionTime: Date.now() - orchestratorStart,
        tokensUsed: Math.ceil((query.length + (finalContext || '').length + (finalAnswer || '').length) / 4),
        finalConfidence,
        metadata: {
            dynamicBranchCount,
            calibratedConfidence: confidenceResult.confidence,
            aggregatedStepConfidence,
            earlyAbortTriggered
        }
    });

    log.success('TOT', "Orchestration finish");
    const tokenUsageEstimate = Math.ceil((query.length + (finalContext || '').length + (finalAnswer || '').length) / 4);
    const toolCalls = Array.isArray(finalStepStatuses)
        ? finalStepStatuses.filter(step => {
            const text = `${step?.title || ''} ${step?.content || ''} ${step?.sourcePipeline || ''}`.toLowerCase();
            return text.includes('tool') || text.includes('search') || text.includes('rag') || text.includes('kg');
        }).length
        : 0;
    const llmCallCount = (Array.isArray(finalStepStatuses)
        ? finalStepStatuses.filter(step => String(step?.type || '').toLowerCase() === 'reasoning').length
        : 0) + 6 + (plans.length > 1 ? 1 : 0);
    const allowResearchDepth = requestContext?.intent === 'research' || requestContext?.deepResearchContext === true;
    const reasoningDepth = allowResearchDepth
        ? (Array.isArray(finalStepStatuses) ? finalStepStatuses.length : 1)
        : Math.min(MAX_TOT_TASKS_NORMAL_CHAT, Array.isArray(finalStepStatuses) ? finalStepStatuses.length : 1);
    const mergedPriorInsights = [
        ...(Array.isArray(previousToTState?.priorInsights) ? previousToTState.priorInsights : []),
        ...(Array.isArray(reasoningModel?.assumptions) ? reasoningModel.assumptions.slice(0, 5) : []),
        keyInsight || ''
    ].map(v => String(v || '').trim()).filter(Boolean);

    const mergedBranchHistory = [
        ...(Array.isArray(previousToTState?.branchHistory) ? previousToTState.branchHistory : []),
        ...(Array.isArray(rawPlans) ? rawPlans.map(p => p?.name).filter(Boolean) : []),
        winningPlan?.name || ''
    ].map(v => String(v || '').trim()).filter(Boolean);

    const mergedConfidenceHistory = [
        ...(Array.isArray(previousToTState?.confidenceHistory) ? previousToTState.confidenceHistory : []),
        finalConfidence
    ].filter(v => Number.isFinite(Number(v))).map(v => Number(v));

    const totStateSnapshot = {
        priorInsights: mergedPriorInsights.slice(-25),
        branchHistory: mergedBranchHistory.slice(-30),
        confidenceHistory: mergedConfidenceHistory.slice(-30)
    };

    void saveToTState(requestContext?.sessionId, totStateSnapshot);

    return {
        finalAnswer,
        thoughts: allSteps.map(s => `**${s.title}**\n${s.content || ''}`).join('\n\n'),
        references: allReferences,
        sourcePipeline: `tot-${requestContext.llmProvider}`,
        confidenceScore: confidenceResult.confidence,
        reasoningMeta: {
            reusedMemory: Boolean(previousToTState),
            dynamicBranchCount,
            branchesPruned: Math.max(0, rawPlans.length - plans.length),
            branchCount: rawPlans.length,
            llmCallCount,
            reasoningDepth,
            toolCalls,
            tokenUsageEstimate,
            aggregatedStepConfidence,
            finalConfidence,
            model: reasoningModel,
            scenarios: scenarioBundle.scenarios,
            performanceDiagnostics: {
                routingTime: 0,
                llmTime: Date.now() - orchestratorStart,
                toolTime: 0,
                dbTime: 0,
                redisTime: 0,
            },
            keyInsight,
            critique: {
                mechanismsShown: critique.mechanismsShown === true,
                chainsExplicit: critique.chainsExplicit === true,
                scenariosModeled: critique.scenariosModeled === true,
                uncertaintyAcknowledged: critique.uncertaintyAcknowledged === true,
                assumptionDependence: critique.assumptionDependence,
                overstatementRisk: critique.overstatementRisk,
                needsRefinement: critique.needsRefinement || false
            },
            agentState: totStateSnapshot,
            confidenceBasis: confidenceResult.basis
        }
    };
}

module.exports = {
    processQueryWithToT_Streaming
};
