/**
 * server/services/intelligentRouterService.js
 * 
 * Intelligent LLM Router - Sprint 3
 * 
 * Enhances routing decisions with:
 * 1. Task type classification
 * 2. Complexity estimation
 * 3. Intelligent model selection per provider
 * 4. Intelligent provider selection with health scoring
 * 4. Adaptive routing modes
 * 5. Prompt analysis without LLM calls
 * 6. Telemetry logging
 * 
 * PRESERVES: Existing fallback chain (SGLang → Groq → Gemini → OpenAI → Ollama → Template)
 * BACKWARD COMPATIBLE: All existing callers work unchanged
 */

const log = require('../utils/logger');
const LLMConfiguration = require('../models/LLMConfiguration');
const { redisClient, isRedisConnected } = require('../config/redisClient');
const providerHealthMonitor = require('./providerHealthMonitor');
const routingTelemetry = require('./routingTelemetry');

const SGLANG_ENABLED = process.env.SGLANG_ENABLED === 'true';

// ═══════════════════════════════════════════════════════════════════════════════
// TASK TYPE CLASSIFICATION (Task 2)
// ═══════════════════════════════════════════════════════════════════════════════

const TASK_TYPES = {
    MCQ_GENERATION: 'MCQ_GENERATION',
    LECTURE: 'LECTURE',
    QUIZ: 'QUIZ',
    ASSESSMENT: 'ASSESSMENT',
    CONCEPT_MAP: 'CONCEPT_MAP',
    SKILL_TREE: 'SKILL_TREE',
    CHAT: 'CHAT',
    RAG: 'RAG',
    EVALUATION: 'EVALUATION',
    SUMMARIZATION: 'SUMMARIZATION',
    EXPLANATION: 'EXPLANATION',
    PDF_ANALYSIS: 'PDF_ANALYSIS',
    IMAGE_ANALYSIS: 'IMAGE_ANALYSIS',
    CSV_ANALYSIS: 'CSV_ANALYSIS',
    UNKNOWN: 'UNKNOWN',
};

const TASK_KEYWORDS = {
    [TASK_TYPES.MCQ_GENERATION]: [
        'mcq', 'multiple choice', 'question generation', 'generate questions',
        'create quiz questions', 'test questions', 'exam questions'
    ],
    [TASK_TYPES.LECTURE]: [
        'lecture', 'generate lecture', 'create lecture', 'lesson plan',
        'teaching material', 'course content', 'syllabus to lecture'
    ],
    [TASK_TYPES.QUIZ]: [
        'quiz', 'practice quiz', 'take quiz', 'quiz me', 'assessment quiz'
    ],
    [TASK_TYPES.ASSESSMENT]: [
        'assessment', 'evaluate', 'test knowledge', 'check understanding',
        'knowledge check', 'skill assessment'
    ],
    [TASK_TYPES.CONCEPT_MAP]: [
        'concept map', 'mind map', 'knowledge graph', 'visualize concepts',
        'concept relationship', 'topic map'
    ],
    [TASK_TYPES.SKILL_TREE]: [
        'skill tree', 'learning path', 'prerequisite', 'curriculum',
        'learning progression', 'skill progression'
    ],
    [TASK_TYPES.RAG]: [
        'search', 'find in document', 'document says', 'from the pdf',
        'according to', 'retrieve', 'knowledge base'
    ],
    [TASK_TYPES.EVALUATION]: [
        'evaluate', 'grade', 'score', 'assess answer', 'check answer',
        'marking', 'rubric'
    ],
    [TASK_TYPES.SUMMARIZATION]: [
        'summarize', 'summary', 'tldr', 'in brief', 'key points',
        'condense', 'shorten'
    ],
    [TASK_TYPES.EXPLANATION]: [
        'explain', 'how does', 'why does', 'what is', 'describe',
        'elaborate', 'break down', 'clarify'
    ],
    [TASK_TYPES.PDF_ANALYSIS]: [
        'pdf', 'document', 'analyze document', 'read file', 'upload'
    ],
    [TASK_TYPES.IMAGE_ANALYSIS]: [
        'image', 'picture', 'diagram', 'chart', 'screenshot', 'photo'
    ],
    [TASK_TYPES.CSV_ANALYSIS]: [
        'csv', 'spreadsheet', 'data analysis', 'analyze data', 'dataset'
    ],
};

function classifyTaskType(query, context = {}) {
    const lowerQuery = (query || '').toLowerCase();
    const contextStr = JSON.stringify(context).toLowerCase();
    const combined = lowerQuery + ' ' + contextStr;

    // Check for explicit context flags first
    if (context.isMcqGeneration || context.taskType === TASK_TYPES.MCQ_GENERATION) {
        return TASK_TYPES.MCQ_GENERATION;
    }
    if (context.isLectureGeneration || context.taskType === TASK_TYPES.LECTURE) {
        return TASK_TYPES.LECTURE;
    }
    if (context.isQuizMode || context.taskType === TASK_TYPES.QUIZ) {
        return TASK_TYPES.QUIZ;
    }
    if (context.isAssessment || context.taskType === TASK_TYPES.ASSESSMENT) {
        return TASK_TYPES.ASSESSMENT;
    }
    if (context.isConceptMap || context.taskType === TASK_TYPES.CONCEPT_MAP) {
        return TASK_TYPES.CONCEPT_MAP;
    }
    if (context.isSkillTree || context.taskType === TASK_TYPES.SKILL_TREE) {
        return TASK_TYPES.SKILL_TREE;
    }
    if (context.deepResearchMode || context.taskType === TASK_TYPES.RAG) {
        return TASK_TYPES.RAG;
    }
    if (context.isEvaluation || context.taskType === TASK_TYPES.EVALUATION) {
        return TASK_TYPES.EVALUATION;
    }
    if (context.documentContextName && (context.hasUploadedFiles || context.ragContext)) {
        return TASK_TYPES.RAG;
    }

    // Keyword-based classification
    let bestMatch = TASK_TYPES.UNKNOWN;
    let bestScore = 0;

    for (const [taskType, keywords] of Object.entries(TASK_KEYWORDS)) {
        const score = keywords.reduce((acc, kw) => {
            return acc + (combined.includes(kw.toLowerCase()) ? 1 : 0);
        }, 0);
        if (score > bestScore) {
            bestScore = score;
            bestMatch = taskType;
        }
    }

    // Fallback: infer from query patterns
    if (bestMatch === TASK_TYPES.UNKNOWN) {
        if (lowerQuery.includes('?') || lowerQuery.length < 100) {
            bestMatch = TASK_TYPES.CHAT;
        } else if (lowerQuery.includes('explain') || lowerQuery.includes('how') || lowerQuery.includes('why')) {
            bestMatch = TASK_TYPES.EXPLANATION;
        } else {
            bestMatch = TASK_TYPES.CHAT;
        }
    }

    return bestMatch;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPLEXITY ESTIMATION (Task 3)
// ═══════════════════════════════════════════════════════════════════════════════

const COMPLEXITY_LEVELS = {
    SMALL: 'SMALL',
    MEDIUM: 'MEDIUM',
    LARGE: 'LARGE',
    VERY_LARGE: 'VERY_LARGE',
};

const REASONING_KEYWORDS = [
    'analyze', 'compare', 'contrast', 'evaluate', 'predict', 'reason',
    'trade-off', 'architecture', 'multi-step', 'synthesize', 'derive',
    'prove', 'critique', 'assess', 'weigh', 'debate', 'perspective',
    'implication', 'consequence', 'root cause', 'systemic', 'holistic'
];

const BLOOM_KEYWORDS = {
    remember: ['define', 'list', 'name', 'recall', 'identify', 'state'],
    understand: ['explain', 'describe', 'summarize', 'interpret', 'paraphrase'],
    apply: ['solve', 'calculate', 'demonstrate', 'use', 'execute', 'implement'],
    analyze: ['analyze', 'compare', 'contrast', 'distinguish', 'examine', 'investigate'],
    evaluate: ['evaluate', 'judge', 'critique', 'assess', 'justify', 'defend', 'recommend'],
    create: ['design', 'create', 'develop', 'construct', 'formulate', 'generate', 'build'],
};

function estimateTokens(text) {
    if (!text) return 0;
    // Rough estimation: ~3.5 chars per token for English
    return Math.ceil(text.length / 3.5);
}

function detectBloomLevel(query) {
    const lower = (query || '').toLowerCase();
    let maxLevel = 0;
    const levels = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'];
    for (let i = 0; i < levels.length; i++) {
        if (BLOOM_KEYWORDS[levels[i]].some(kw => lower.includes(kw))) {
            maxLevel = Math.max(maxLevel, i);
        }
    }
    return maxLevel; // 0-5
}

function countConcepts(query) {
    // Rough heuristic: count capitalized words, technical terms, nouns
    const words = (query || '').match(/\b[A-Z][a-z]+\b|\b[a-z]{5,}\b/g) || [];
    return new Set(words.map(w => w.toLowerCase())).size;
}

function detectChainOfThought(query) {
    const lower = (query || '').toLowerCase();
    return /step.by.step|chain.of.thought|think.through|reason.through|work.through|show.reasoning|show.work|step.by.step/.test(lower);
}

function estimateComplexity(query, context = {}) {
    const text = query || '';
    const tokenEstimate = estimateTokens(text) + estimateTokens(JSON.stringify(context));
    const reasoningHits = REASONING_KEYWORDS.filter(kw => text.toLowerCase().includes(kw)).length;
    const bloomLevel = detectBloomLevel(text);
    const conceptCount = countConcepts(text);
    const cotRequired = detectChainOfThought(text) || context.criticalThinkingEnabled || context.useReAct;
    const outputSizeHint = context.expectedOutputTokens || context.maxOutputTokens || 0;

    let score = 0;
    score += Math.min(30, tokenEstimate / 50);           // 0-30 for prompt length
    score += Math.min(25, reasoningHits * 5);            // 0-25 for reasoning keywords
    score += Math.min(20, bloomLevel * 4);               // 0-20 for Bloom level
    score += Math.min(15, conceptCount * 1.5);           // 0-15 for concept count
    score += cotRequired ? 15 : 0;                       // 15 for CoT requirement
    score += Math.min(15, outputSizeHint / 200);         // 0-15 for expected output

    // Context window pressure
    const totalContextEstimate = tokenEstimate + (context.chatHistory?.length || 0) * 100;
    if (totalContextEstimate > 8000) score += 10;
    if (totalContextEstimate > 16000) score += 15;

    let level = COMPLEXITY_LEVELS.SMALL;
    if (score >= 70) level = COMPLEXITY_LEVELS.VERY_LARGE;
    else if (score >= 50) level = COMPLEXITY_LEVELS.LARGE;
    else if (score >= 30) level = COMPLEXITY_LEVELS.MEDIUM;

    return {
        level,
        score: Math.round(score),
        factors: {
            tokenEstimate,
            reasoningHits,
            bloomLevel,
            conceptCount,
            cotRequired,
            outputSizeHint,
            totalContextEstimate,
        },
        reasoningDepth: cotRequired ? 'deep' : (bloomLevel >= 4 ? 'deep' : bloomLevel >= 2 ? 'medium' : 'shallow'),
        estimatedOutputTokens: Math.max(outputSizeHint, estimateOutputSize(level)),
        estimatedLatencyMs: estimateLatency(level),
        contextWindowNeeded: totalContextEstimate + estimateOutputSize(level),
    };
}

function estimateOutputSize(level) {
    const sizes = {
        [COMPLEXITY_LEVELS.SMALL]: 512,
        [COMPLEXITY_LEVELS.MEDIUM]: 2048,
        [COMPLEXITY_LEVELS.LARGE]: 4096,
        [COMPLEXITY_LEVELS.VERY_LARGE]: 8192,
    };
    return sizes[level] || 2048;
}

function estimateLatency(level) {
    const latencies = {
        [COMPLEXITY_LEVELS.SMALL]: 2000,
        [COMPLEXITY_LEVELS.MEDIUM]: 5000,
        [COMPLEXITY_LEVELS.LARGE]: 15000,
        [COMPLEXITY_LEVELS.VERY_LARGE]: 30000,
    };
    return latencies[level] || 5000;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODEL CATALOG & SELECTION (Task 4)
// ═══════════════════════════════════════════════════════════════════════════════

// Model tiers per provider - ONLY models configured in the project
const PROVIDER_MODEL_TIERS = {
    sglang: {
        [COMPLEXITY_LEVELS.SMALL]: { modelId: 'Qwen/Qwen2.5-7B-Instruct-AWQ', endpoint: 'chat', contextWindow: 8192 },
        [COMPLEXITY_LEVELS.MEDIUM]: { modelId: 'Qwen/Qwen2.5-7B-Instruct-AWQ', endpoint: 'chat', contextWindow: 8192 },
        [COMPLEXITY_LEVELS.LARGE]: { modelId: 'Qwen/Qwen2.5-14B-Instruct-AWQ', endpoint: 'reason', contextWindow: 8192 },
        [COMPLEXITY_LEVELS.VERY_LARGE]: { modelId: 'Qwen/Qwen2.5-35B-Instruct-AWQ', endpoint: 'heavy', contextWindow: 16384 },
    },
    groq: {
        [COMPLEXITY_LEVELS.SMALL]: { modelId: 'llama-3.1-8b-instant', contextWindow: 8192 },
        [COMPLEXITY_LEVELS.MEDIUM]: { modelId: 'llama-3.1-70b-versatile', contextWindow: 8192 },
        [COMPLEXITY_LEVELS.LARGE]: { modelId: 'llama-3.1-70b-versatile', contextWindow: 8192 },
        [COMPLEXITY_LEVELS.VERY_LARGE]: { modelId: 'llama-3.1-70b-versatile', contextWindow: 8192 },
    },
    gemini: {
        [COMPLEXITY_LEVELS.SMALL]: { modelId: 'gemini-2.0-flash', contextWindow: 1048576 },
        [COMPLEXITY_LEVELS.MEDIUM]: { modelId: 'gemini-2.0-flash', contextWindow: 1048576 },
        [COMPLEXITY_LEVELS.LARGE]: { modelId: 'gemini-1.5-pro', contextWindow: 2097152 },
        [COMPLEXITY_LEVELS.VERY_LARGE]: { modelId: 'gemini-1.5-pro', contextWindow: 2097152 },
    },
    openai: {
        [COMPLEXITY_LEVELS.SMALL]: { modelId: 'gpt-4o-mini', contextWindow: 128000 },
        [COMPLEXITY_LEVELS.MEDIUM]: { modelId: 'gpt-4o', contextWindow: 128000 },
        [COMPLEXITY_LEVELS.LARGE]: { modelId: 'gpt-4o', contextWindow: 128000 },
        [COMPLEXITY_LEVELS.VERY_LARGE]: { modelId: 'gpt-4o', contextWindow: 128000 },
    },
    ollama: {
        [COMPLEXITY_LEVELS.SMALL]: { modelId: 'qwen2.5:3b', contextWindow: 4096 },
        [COMPLEXITY_LEVELS.MEDIUM]: { modelId: 'qwen2.5:7b', contextWindow: 8192 },
        [COMPLEXITY_LEVELS.LARGE]: { modelId: 'qwen2.5:14b', contextWindow: 8192 },
        [COMPLEXITY_LEVELS.VERY_LARGE]: { modelId: 'qwen2.5:32b', contextWindow: 16384 },
    },
};

// Task-specific model preferences (some tasks prefer certain providers)
const TASK_PROVIDER_PREFERENCES = {
    [TASK_TYPES.MCQ_GENERATION]: ['sglang', 'gemini', 'groq'],
    [TASK_TYPES.LECTURE]: ['sglang', 'gemini', 'groq'],
    [TASK_TYPES.QUIZ]: ['sglang', 'groq', 'gemini'],
    [TASK_TYPES.ASSESSMENT]: ['sglang', 'gemini', 'groq'],
    [TASK_TYPES.CONCEPT_MAP]: ['sglang', 'gemini'],
    [TASK_TYPES.SKILL_TREE]: ['sglang', 'gemini'],
    [TASK_TYPES.CHAT]: ['sglang', 'groq', 'gemini', 'ollama'],
    [TASK_TYPES.RAG]: ['sglang', 'gemini', 'groq'],
    [TASK_TYPES.EVALUATION]: ['sglang', 'gemini', 'groq'],
    [TASK_TYPES.SUMMARIZATION]: ['sglang', 'groq', 'gemini'],
    [TASK_TYPES.EXPLANATION]: ['sglang', 'groq', 'gemini', 'ollama'],
    [TASK_TYPES.PDF_ANALYSIS]: ['sglang', 'gemini'],
    [TASK_TYPES.IMAGE_ANALYSIS]: ['gemini', 'sglang'],
    [TASK_TYPES.CSV_ANALYSIS]: ['sglang', 'gemini', 'groq'],
    [TASK_TYPES.UNKNOWN]: ['sglang', 'groq', 'gemini', 'ollama'],
};

async function getAvailableModelsFromCatalog(provider) {
    // Try to get from cached catalog in llmRouterService
    const { catalogFindAll } = require('./llmRouterService');
    const cached = catalogFindAll({ provider: { $in: [provider] } });
    if (cached && cached.length > 0) {
        return cached.map(m => m.modelId);
    }
    // Fallback to DB
    try {
        const models = await LLMConfiguration.find({ provider }).lean();
        return models.map(m => m.modelId);
    } catch {
        return [];
    }
}

function selectModelForProvider(provider, complexityLevel, taskType, availableModels = []) {
    const tiers = PROVIDER_MODEL_TIERS[provider];
    if (!tiers) return null;

    const preferredModel = tiers[complexityLevel] || tiers[COMPLEXITY_LEVELS.MEDIUM];
    const modelId = preferredModel.modelId;

    // Check if model is available in catalog
    if (availableModels.length > 0) {
        const exactMatch = availableModels.find(m => m === modelId);
        if (exactMatch) return { modelId: exactMatch, ...preferredModel };

        // Fallback: find any model from same provider that fits
        const fallback = availableModels[0];
        return { modelId: fallback, ...preferredModel };
    }

    // No catalog info - return configured default
    return { modelId, ...preferredModel };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROVIDER SELECTION & HEALTH SCORING (Task 5, 6)
// ═══════════════════════════════════════════════════════════════════════════════

const ROUTING_MODES = {
    AUTO: 'AUTO',
    FASTEST: 'FASTEST',
    CHEAPEST: 'CHEAPEST',
    QUALITY: 'QUALITY',
    LOCAL_ONLY: 'LOCAL_ONLY',
    CLOUD_ONLY: 'CLOUD_ONLY',
    BALANCED: 'BALANCED',
};

const PROVIDER_COST_RANK = {
    ollama: 1,      // Free (local)
    sglang: 1,      // Free (local GPU)
    groq: 2,        // Low cost
    gemini: 3,      // Medium cost
    openai: 4,      // Higher cost
};

const PROVIDER_LOCAL_PREFERENCE = {
    ollama: true,
    sglang: true,
    groq: false,
    gemini: false,
    openai: false,
};

async function scoreProvider(provider, context = {}) {
    const health = await providerHealthMonitor.getHealth(provider);
    const routingMode = context.routingMode || ROUTING_MODES.AUTO;
    const taskType = context.taskType || TASK_TYPES.UNKNOWN;
    const complexity = context.complexity || COMPLEXITY_LEVELS.MEDIUM;
    const preferLocal = context.preferLocal !== false;
    const contextWindowNeeded = context.contextWindowNeeded || 4096;

    // Base availability check
    if (!health.available) return { provider, score: -1000, reason: 'unavailable' };

    // Hard filters
    if (routingMode === ROUTING_MODES.LOCAL_ONLY && !PROVIDER_LOCAL_PREFERENCE[provider]) {
        return { provider, score: -1000, reason: 'cloud_provider_blocked' };
    }
    if (routingMode === ROUTING_MODES.CLOUD_ONLY && PROVIDER_LOCAL_PREFERENCE[provider]) {
        return { provider, score: -1000, reason: 'local_provider_blocked' };
    }

    // Context window check
    const modelInfo = PROVIDER_MODEL_TIERS[provider]?.[complexity];
    if (modelInfo && modelInfo.contextWindow < contextWindowNeeded) {
        return { provider, score: -500, reason: 'context_window_too_small' };
    }

    let score = 0;
    const reasons = [];

    // Health score (0-100)
    const healthScore = health.availability * 100;
    score += healthScore * 0.3;
    reasons.push(`health:${healthScore.toFixed(0)}`);

    // Latency score (inverse - lower is better)
    const avgLatency = health.avgLatencyMs || 5000;
    const latencyScore = Math.max(0, 100 - (avgLatency / 100));
    score += latencyScore * 0.25;
    reasons.push(`latency:${avgLatency.toFixed(0)}ms`);

    // Failure penalty
    const failureRate = health.totalRequests > 0 ? health.failureCount / health.totalRequests : 0;
    score -= failureRate * 100;
    reasons.push(`failure_rate:${(failureRate * 100).toFixed(1)}%`);

    // 429 penalty
    score -= health.rateLimitCount * 10;
    reasons.push(`rate_limits:${health.rateLimitCount}`);

    // Timeout penalty
    score -= health.timeoutCount * 15;
    reasons.push(`timeouts:${health.timeoutCount}`);

    // Cost preference
    if (routingMode === ROUTING_MODES.CHEAPEST || routingMode === ROUTING_MODES.BALANCED) {
        const costRank = PROVIDER_COST_RANK[provider] || 5;
        score += (6 - costRank) * 5;
        reasons.push(`cost_rank:${costRank}`);
    }

    // Quality preference
    if (routingMode === ROUTING_MODES.QUALITY || routingMode === ROUTING_MODES.BALANCED) {
        // SGLang and Gemini generally higher quality for complex tasks
        if (complexity === COMPLEXITY_LEVELS.LARGE || complexity === COMPLEXITY_LEVELS.VERY_LARGE) {
            if (provider === 'sglang' || provider === 'gemini') score += 15;
        }
        reasons.push('quality_bias');
    }

    // Speed preference
    if (routingMode === ROUTING_MODES.FASTEST || routingMode === ROUTING_MODES.BALANCED) {
        // Groq and SGLang typically fastest
        if (provider === 'groq' || provider === 'sglang') score += 10;
        reasons.push('speed_bias');
    }

    // Local preference
    if (preferLocal && PROVIDER_LOCAL_PREFERENCE[provider]) {
        score += 10;
        reasons.push('local_preference');
    }

    // Task-specific preferences
    const taskPrefs = TASK_PROVIDER_PREFERENCES[taskType] || [];
    const taskPrefIndex = taskPrefs.indexOf(provider);
    if (taskPrefIndex >= 0) {
        score += (taskPrefs.length - taskPrefIndex) * 3;
        reasons.push(`task_pref:${taskPrefIndex}`);
    }

    // SGLang priority when enabled
    if (SGLANG_ENABLED && provider === 'sglang') {
        score += 20;
        reasons.push('sglang_priority');
    }

    return { provider, score: Math.round(score), reasons: reasons.join(','), health };
}

async function selectBestProvider(providers, context) {
    const scored = await Promise.all(providers.map(p => scoreProvider(p, context)));
    scored.sort((a, b) => b.score - a.score);

    log.info('AI', `[IntelligentRouter] Provider scores: ${scored.map(s => `${s.provider}=${s.score}`).join(', ')}`);

    return scored[0] || { provider: 'ollama', score: 0, reasons: 'fallback' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ROUTING ENGINE (Task 1)
// ═══════════════════════════════════════════════════════════════════════════════

async function getIntelligentRoutingDecision(query, context = {}) {
    const startTime = Date.now();

    // 1. Classify task type
    const taskType = classifyTaskType(query, context);

    // 2. Estimate complexity
    const complexity = estimateComplexity(query, context);

    // 3. Determine routing mode
    const routingMode = context.routingMode || ROUTING_MODES.AUTO;

    // 4. Get available providers (from health monitor)
    const allProviders = ['sglang', 'groq', 'gemini', 'openai', 'ollama'];
    const healthChecks = await Promise.all(allProviders.map(p => providerHealthMonitor.getHealth(p)));
    const availableProviders = allProviders.filter((p, i) => healthChecks[i].available);

    // 5. Select best provider
    const providerDecision = await selectBestProvider(availableProviders, {
        taskType,
        complexity: complexity.level,
        routingMode,
        preferLocal: context.preferLocal,
        contextWindowNeeded: complexity.contextWindowNeeded,
    });

    // 6. Select best model for that provider
    const availableModels = await getAvailableModelsFromCatalog(providerDecision.provider);
    const modelDecision = selectModelForProvider(
        providerDecision.provider,
        complexity.level,
        taskType,
        availableModels
    );

    // 7. Build routing decision
    const decision = {
        taskType,
        complexity: complexity.level,
        complexityScore: complexity.score,
        provider: providerDecision.provider,
        model: modelDecision?.modelId || 'unknown',
        modelDetails: modelDecision,
        routingMode,
        providerScore: providerDecision.score,
        providerReasons: providerDecision.reasons,
        reasoningDepth: complexity.reasoningDepth,
        estimatedTokens: complexity.factors.tokenEstimate,
        estimatedOutputTokens: complexity.estimatedOutputTokens,
        estimatedLatencyMs: complexity.estimatedLatencyMs,
        contextWindowNeeded: complexity.contextWindowNeeded,
        latencyBudget: context.latencyBudget || 'balanced',
        fallbackCount: 0,
        routingTimeMs: Date.now() - startTime,
    };

    // 8. Log telemetry
    routingTelemetry.logRoutingDecision(decision, context);

    return decision;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
    TASK_TYPES,
    COMPLEXITY_LEVELS,
    ROUTING_MODES,
    classifyTaskType,
    estimateComplexity,
    selectModelForProvider,
    scoreProvider,
    selectBestProvider,
    getIntelligentRoutingDecision,
    PROVIDER_MODEL_TIERS,
};