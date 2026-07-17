
// server/routes/chat/index.js
// Orchestrates the /message route by delegating to focused handler modules.
const { buildMemoryAwareSystemPrompt } = require('../../services/socraticService');
const contextService = require('../../services/contextService');
const express = require('express');
const ChatHistory = require('../../models/ChatHistory');
const User = require('../../models/User');
const { decrypt } = require('../../utils/crypto');
const { redisClient } = require('../../config/redisClient');
const { selectLLM } = require('../../services/llmRouterService');
const { buildOptimalContext } = require('../../services/contextManager');
const { createPerformanceTracker, logPerformance } = require('../../services/performanceDiagnosticsService');
const { calculateComplexityScore } = require('../../services/smartModelRouterService');
const { injectContextualMemory } = require('../../middleware/contextualMemoryMiddleware');
const { validateChatMessage } = require('../../middleware/requestValidation');
const { sttLimiter } = require('../../middleware/rateLimitMiddleware');
const { authMiddleware } = require('../../middleware/authMiddleware');
const { isDebugMode } = require('../../utils/debugMode');
const log = require('../../utils/logger');
const routerFeedback = require('../../services/routerFeedbackService');
const { routeQuery } = require('../../services/semanticRouter');
const { routeWithLLM } = require('../../services/llmToolRouter');
const { decomposeQuery, buildHybridContextBlock } = require('../../services/hybridQueryDecomposer');


const {
    streamEvent,
    detectNonAcademic,
    doesQuerySuggestRecall,
    TUTOR_MODE_TYPES,
    resolveTutorModeType,
    mapQueryIntent,
} = require('./helpers');

const quizHandler = require('./handlers/quizHandler');
const researchHandler = require('./handlers/researchHandler');
const codeHandler = require('./handlers/codeHandler');
const tutorHandler = require('./handlers/tutorHandler');
const standardHandler = require('./handlers/standardHandler');

const router = express.Router();

router.post('/message', validateChatMessage, injectContextualMemory, async (req, res) => {
    let {
        query, sessionId, useWebSearch, useAcademicSearch,
        systemPrompt: clientProvidedSystemInstruction, criticalThinkingEnabled,
        documentContextName, filter, bountyId, bountyAnswer, useReAct,
        deepResearchMode, tutorModeType, currentModulePathId,
        isKgRealtimeEnabled, userExplicitlyDisabledWebSearch,
        isAutoGreeting,  // silent auto-init flag: don't save user message to DB
    } = req.body;

    isAutoGreeting = isAutoGreeting === true;
    useReAct = useReAct === true;
    // Issue 1.2: capture whether the USER explicitly requested ToT before semantic routing
    // can mutate criticalThinkingEnabled. Used in standardHandler to apply the lower gate (40).
    const userRequestedToT = criticalThinkingEnabled;
    
    log.info('CHAT', `[ToT DEBUG] Raw criticalThinkingEnabled from client: ${req.body.criticalThinkingEnabled} (type: ${typeof req.body.criticalThinkingEnabled})`);
    log.info('CHAT', `[ToT DEBUG] userRequestedToT captured: ${userRequestedToT}`);

    let tutorMode = req.body.tutorMode || req.body.isTutorMode || req.body.tutor_mode;

    if (query) {
        const lowerQuery = query.toLowerCase();
        if (lowerQuery.startsWith('tutor:') || lowerQuery.startsWith('teach me') || lowerQuery.startsWith('learn ')) {
            tutorMode = true;
            log.info('CHAT', `Tutor Mode auto-enabled for: "${lowerQuery.substring(0, 30)}..."`);
        }
    }

    if (Object.values(TUTOR_MODE_TYPES).includes(tutorModeType)) {
        tutorMode = true;
    }

    if (tutorMode) {
        tutorModeType = resolveTutorModeType(tutorModeType, documentContextName);
        log.info('CHAT', `Resolved Tutor mode type: ${tutorModeType}`);
    }

    // Issue 1.3: track which toggles the system silently disabled so the frontend can surface a notice
    const disabledToggles = [];
    if (tutorMode && criticalThinkingEnabled) {
        log.warn('CHAT', 'Tutor Mode active: Forcing critical thinking OFF');
        criticalThinkingEnabled = false;
        disabledToggles.push('criticalThinking');
    }

    log.info('CHAT', `Message received (Tutor: ${tutorMode}, Critical: ${criticalThinkingEnabled})`);

    const userId = req.user._id;
    log.info('CHAT', 'User metadata audit logged.');

    if (!query || typeof query !== 'string' || query.trim() === '') {
        return res.status(400).json({ message: 'Query message text required.' });
    }
    if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ message: 'Session ID required.' });
    }

    const userMessageForDb = { role: 'user', parts: [{ text: query }], timestamp: new Date() };
    log.info('CHAT', `Processing query: "${query.substring(0, 50)}..."`);
    const startTime = Date.now();
    const debugEnabled = isDebugMode(req);
    res.locals.isDebugMode = debugEnabled;
    res.locals.debugContext = {
        routing: { latencyBudget: 'balanced' },
        performance: null,
        reasoning: null,
        redis: null
    };

    const performanceTracker = createPerformanceTracker({
        route: 'chat.message',
        sessionId,
        userId: userId.toString(),
        queryType: deepResearchMode ? 'deep_research' : (criticalThinkingEnabled || useReAct ? 'complex' : 'simple')
    });

    const capturePerformance = (extra = {}) => {
        const payload = performanceTracker.toLogPayload(extra);
        logPerformance(payload);
        if (debugEnabled) {
            res.locals.debugContext.performance = payload;
        }
        return payload;
    };

    const captureDebugFromResponse = (responseObject = {}) => {
        if (!debugEnabled || !responseObject || typeof responseObject !== 'object') return;

        const reasoningMeta = responseObject.reasoningMeta || {};
        const agentState = reasoningMeta.agentState || {};
        const confidenceHistory = Array.isArray(agentState.confidenceHistory) ? agentState.confidenceHistory : [];
        const stepConfidences = Array.isArray(reasoningMeta.stepConfidences)
            ? reasoningMeta.stepConfidences
            : confidenceHistory.slice(-3);

        const priorInsightsCount = Array.isArray(agentState.priorInsights)
            ? agentState.priorInsights.length
            : (Array.isArray(reasoningMeta?.reasoningState?.insights) ? reasoningMeta.reasoningState.insights.length : 0);

        const branchHistoryCount = Array.isArray(agentState.branchHistory)
            ? agentState.branchHistory.length
            : 0;

        const loadedState = Boolean(reasoningMeta.reusedMemory || priorInsightsCount > 0 || branchHistoryCount > 0);

        res.locals.debugContext.reasoning = {
            branchCount: responseObject.totalBranchesGenerated || reasoningMeta.branchCount || 1,
            branchesPruned: reasoningMeta.branchesPruned || 0,
            stepConfidences,
            finalConfidence: reasoningMeta.finalConfidence || reasoningMeta.aggregatedStepConfidence || reasoningMeta.confidenceScore || responseObject.confidenceScore || 0,
            correctionLoops: reasoningMeta.correctionLoops || reasoningMeta.critiqueApplied || 0,
            reusedMemory: Boolean(reasoningMeta.reusedMemory),
            topicSimilarity: Number(reasoningMeta.topicSimilarity || 0)
        };

        res.locals.debugContext.redis = {
            redisHit: loadedState,
            loadedState,
            priorInsightsCount,
            branchHistoryCount
        };
    };

    const captureRedisStateFromCache = async () => {
        if (!debugEnabled || !redisClient || !redisClient.isOpen) return;

        try {
            const [agentStateRaw, reasoningStateRaw] = await Promise.all([
                redisClient.get(`agent_state:${sessionId}`),
                redisClient.get(`reasoning_state:${sessionId}`)
            ]);
            const totStateRaw = await redisClient.get(`tot_state:${sessionId}`);

            const parsedAgentState = agentStateRaw ? JSON.parse(agentStateRaw) : null;
            const parsedReasoningState = reasoningStateRaw ? JSON.parse(reasoningStateRaw) : null;

            const priorInsightsFromAgent = Array.isArray(parsedAgentState?.priorInsights) ? parsedAgentState.priorInsights.length : 0;
            const branchHistoryFromAgent = Array.isArray(parsedAgentState?.branchHistory) ? parsedAgentState.branchHistory.length : 0;
            const priorInsightsFromReasoning = Array.isArray(parsedReasoningState?.reasoningState?.insights) ? parsedReasoningState.reasoningState.insights.length : 0;
            const branchHistoryFromReasoning = Array.isArray(parsedReasoningState?.reasoningState?.dimensions) ? parsedReasoningState.reasoningState.dimensions.length : 0;

            const priorInsightsCount = Math.max(priorInsightsFromAgent, priorInsightsFromReasoning);
            const branchHistoryCount = Math.max(branchHistoryFromAgent, branchHistoryFromReasoning);

            const parsedTotState = totStateRaw ? JSON.parse(totStateRaw) : null;
            const priorInsightsFromToT = Array.isArray(parsedTotState?.priorInsights) ? parsedTotState.priorInsights.length : 0;
            const branchHistoryFromToT = Array.isArray(parsedTotState?.branchHistory) ? parsedTotState.branchHistory.length : 0;

            const loadedState = Boolean(agentStateRaw || reasoningStateRaw || totStateRaw || priorInsightsCount > 0 || branchHistoryCount > 0 || priorInsightsFromToT > 0 || branchHistoryFromToT > 0);

            res.locals.debugContext.redis = {
                redisHit: loadedState,
                loadedState,
                priorInsightsCount: Math.max(priorInsightsCount, priorInsightsFromToT),
                branchHistoryCount: Math.max(branchHistoryCount, branchHistoryFromToT)
            };
        } catch {
            // non-blocking debug telemetry only
        }
    };

    // ── Hybrid sub-query decomposition (runs before keyword pre-check) ──────────
    // Splits multi-part queries and classifies each part independently so that
    // only the "recent / current" segments trigger web/academic search, while
    // foundational/conceptual segments are answered from LLM knowledge alone.
    const hybridDecomposition = decomposeQuery(query.trim(), {
        tutorMode:          !!tutorMode,
        deepResearchMode:   deepResearchMode === true,
        userForcedWeb:      !!useWebSearch,
        userForcedAcademic: !!useAcademicSearch,
    });

    if (hybridDecomposition.isHybrid && !userExplicitlyDisabledWebSearch) {
        // Only upgrade retrieval flags — never downgrade what the user set
        if (hybridDecomposition.needsWeb      && !useWebSearch)      useWebSearch      = true;
        if (hybridDecomposition.needsAcademic && !useAcademicSearch) useAcademicSearch = true;
        log.info('CHAT', `[HYBRID] Multi-part query detected — web:${useWebSearch} academic:${useAcademicSearch}`);
    }

    // ── Keyword pre-check: news / current-events (zero-latency, before embedding) ──
    const _q = query.trim().toLowerCase();
    const _isCurrentEventsQuery = (
        /\b(latest|recent|current|today|tonight|yesterday|this week|this month|this year|right now|as of|breaking|just happened|new update|ongoing)\b/.test(_q) ||
        /\b(news|headline|report|update|development|announcement|situation|crisis|conflict|war|election|summit|deal|attack|protest)\b/.test(_q) ||
        /\b(what('s| is) happening|tell me about.*news|any news|what happened|what's new)\b/.test(_q)
    );
    if (_isCurrentEventsQuery && !tutorMode && !useWebSearch && !userExplicitlyDisabledWebSearch) {
        useWebSearch = true;
        log.info('CHAT', `Keyword pre-check: current-events query → web search enabled`);
    }
    // Track whether webSearch was set by keyword pre-check (not routing) for feedback dedup
    const _keywordSetWebSearch = useWebSearch;

    // ── Issue 2.3: Skip semantic routing when toggle already determines the route ──────────
    // deepResearchMode intercepts before any orchestrator; tutorMode always goes to tutor handler.
    // Skipping saves 6–11ms (one Ollama /embed round-trip) on every toggled request.
    const skipSemanticRouting = deepResearchMode === true || tutorMode === true;

    // ── Semantic routing: Intent classification & rejection check ──────────────
    let semanticRouting = null;
    if (!skipSemanticRouting) {
    try {
        semanticRouting = await routeQuery(query.trim(), {
            userId,
            documentContext: documentContextName,
            hasUploadedFiles: !!documentContextName,
            // Pass currently-active tool flags so the semantic router can use them
            // as scoring priors (e.g. boost DOCUMENT_RAG when file is present,
            // confirm WEB_SEARCH intent when user already toggled it on).
            activeTools: {
                webSearch:     useWebSearch,
                academicSearch: useAcademicSearch,
                tot:           criticalThinkingEnabled,
                deepResearch:  deepResearchMode,
            },
            req, // [Optimization] Pass req to cache the query embedding
        });

        log.info('CHAT', `Semantic routing: ${semanticRouting.intent} (confidence: ${semanticRouting.confidence.toFixed(3)})`);

        // Rejection handling (non-academic queries)
        if (semanticRouting.shouldReject) {
            log.warn('CHAT', `Semantic router rejected: ${semanticRouting.intent}`);
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders();

            const rejectionText = semanticRouting.rejectionMessage;

            streamEvent(res, {
                type: 'final_answer',
                content: {
                    sender: 'bot', role: 'model',
                    text: rejectionText, parts: [{ text: rejectionText }],
                    timestamp: new Date(),
                    source_pipeline: 'semantic-router-rejection',
                    intent: semanticRouting.intent,
                    confidenceScore: Math.round(semanticRouting.confidence * 100)
                }
            });
            return res.end();
        }

        // Override tool flags based on semantic routing
        // When a document/course is selected (documentContextName), RAG takes priority —
        // do NOT let the semantic router override to web or academic search.
        if (semanticRouting.tools.includes('web_search') && !userExplicitlyDisabledWebSearch && !documentContextName) {
            useWebSearch = true;
            log.info('CHAT', 'Semantic router enabled web search');
        } else if (semanticRouting.tools.includes('web_search') && documentContextName) {
            log.info('CHAT', `Semantic router suggested web_search but documentContextName="${documentContextName}" is set — routing to RAG instead`);
        }
        if (semanticRouting.tools.includes('academic_search') && !documentContextName) {
            useAcademicSearch = true;
            log.info('CHAT', 'Semantic router enabled academic search');
        } else if (semanticRouting.tools.includes('academic_search') && documentContextName) {
            log.info('CHAT', `Semantic router suggested academic_search but documentContextName="${documentContextName}" is set — routing to RAG instead`);
        }
        if (semanticRouting.tools.includes('deep_research')) {
            // If the user has selected a course document, honour RAG over deep research
            if (!documentContextName) {
                deepResearchMode = true;
                log.info('CHAT', 'Semantic router enabled deep research');
            } else {
                log.info('CHAT', `Semantic router suggested deep_research but documentContextName="${documentContextName}" is set — routing to RAG instead`);
            }
        }
        if (semanticRouting.tools.includes('tot')) {
            criticalThinkingEnabled = true;
            log.info('CHAT', 'Semantic router enabled Tree-of-Thought');
        }

        // ── LLM Tool Router: second opinion when semantic confidence is low ──
        // Runs async (non-blocking for low-confidence cases that don't already
        // have explicit user flags set). Kicks in when confidence < 0.65.
        const LLM_ROUTER_THRESHOLD = 0.65;
        const needsLlmRouter = semanticRouting.confidence < LLM_ROUTER_THRESHOLD
            && !tutorMode
            && !useWebSearch && !useAcademicSearch; // only if tools not already set

        if (needsLlmRouter) {
            try {
                const llmRouting = await routeWithLLM(query.trim());
                if (llmRouting.tools.includes('web_search')) {
                    useWebSearch = true;
                    log.info('CHAT', `LLM router enabled web_search (semantic conf=${semanticRouting.confidence.toFixed(2)})`);
                }
                if (llmRouting.tools.includes('academic_search')) {
                    useAcademicSearch = true;
                    log.info('CHAT', `LLM router enabled academic_search`);
                }
                if (llmRouting.tools.includes('tot') && !criticalThinkingEnabled) {
                    criticalThinkingEnabled = true;
                    log.info('CHAT', `LLM router enabled ToT`);
                }
                if (llmRouting.tools.includes('deep_research') && !deepResearchMode && !documentContextName) {
                    deepResearchMode = true;
                    log.info('CHAT', `LLM router enabled deep_research`);
                }
            } catch (llmRouterErr) {
                log.warn('CHAT', `LLM router failed silently: ${llmRouterErr.message}`);
            }
        }

        // ── Router feedback: record Step-1 misses for cache improvement ──────
        if (semanticRouting.fallback === true) {
            const resolvedIntent = routerFeedback.inferIntent({
                deepResearchMode,
                useAcademicSearch,
                useWebSearch,
                criticalThinkingEnabled,
                userRequestedToT,
                keywordSetWebSearch: _keywordSetWebSearch,
            });
            if (resolvedIntent) {
                routerFeedback.recordMiss(query, semanticRouting.confidence, resolvedIntent, 'routing_waterfall');
            }
        }

    } catch (semanticErr) {
        log.error('CHAT', `Semantic routing failed: ${semanticErr.message}. Falling back to keyword detection.`);
        // Fallback to original keyword-based detection
        if (tutorMode) {
            const nonAcademicTopic = detectNonAcademic(query.trim());
            if (nonAcademicTopic) {
                log.warn('CHAT', `Academic filter blocked non-academic request: "${nonAcademicTopic}"`);
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.flushHeaders();

                const rejectionText = `I'm iMentor, an **academic AI tutor** — I'm only able to help with subjects like Mathematics, Science, Computer Science, Engineering, History, Economics, and other academic topics.\n\nIt looks like your message is about **"${nonAcademicTopic}"**, which is outside my scope.\n\n📚 Please ask me something related to your coursework or academic subjects and I'll be happy to help!`;

                streamEvent(res, {
                    type: 'final_answer',
                    content: {
                        sender: 'bot', role: 'model',
                        text: rejectionText, parts: [{ text: rejectionText }],
                        timestamp: new Date(),
                        source_pipeline: 'academic-filter-fallback',
                        confidenceScore: 100
                    }
                });
                return res.end();
            }
        }
    }
    } // end if (!skipSemanticRouting)

    // ── Academic subject gate (tutor mode only, zero LLM cost) ───────────────
    // LEGACY: Keeping as additional fallback if semantic routing fails
    if (tutorMode && !semanticRouting) {
        const nonAcademicTopic = detectNonAcademic(query.trim());
        if (nonAcademicTopic) {
            log.warn('CHAT', `Academic filter blocked non-academic request: "${nonAcademicTopic}"`);
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders();

            const rejectionText = `I'm iMentor, an **academic AI tutor** — I'm only able to help with subjects like Mathematics, Science, Computer Science, Engineering, History, Economics, and other academic topics.\n\nIt looks like your message is about **"${nonAcademicTopic}"**, which is outside my scope.\n\n📚 Please ask me something related to your coursework or academic subjects and I'll be happy to help!`;

            streamEvent(res, {
                type: 'final_answer',
                content: {
                    sender: 'bot', role: 'model',
                    text: rejectionText, parts: [{ text: rejectionText }],
                    timestamp: new Date(),
                    source_pipeline: 'academic-filter',
                    confidenceScore: 100
                }
            });
            return res.end();
        }
    }

    // ── Quiz fast-path (outside try — no session data needed) ────────────────
    const isQuizMode = tutorMode && tutorModeType === TUTOR_MODE_TYPES.ASSISTANT &&
        clientProvidedSystemInstruction &&
        (clientProvidedSystemInstruction.includes('quiz answer evaluator') ||
            clientProvidedSystemInstruction.includes('CORRECT ANSWER:'));

    if (isQuizMode) {
        return quizHandler.handle(res, {
            query, sessionId, userId,
            clientProvidedSystemInstruction,
            userMessageForDb,
        });
    }

    try {
        // ── Deep research intercept (no session data needed) ─────────────────
        if (deepResearchMode === true) {
            return researchHandler.handle(req, res, {
                query,
                userId: req.user.id || req.user._id,
                performanceTracker,
                capturePerformance,
            });
        }

        // ── Session & user validation (parallel) ──────────────────────────────
        const [chatSession, user] = await Promise.all([
            ChatHistory.findOne({ sessionId }),
            User.findById(userId)
                .select('+encryptedApiKey preferredLlmProvider ollamaModel ollamaUrl apiKeyRequestStatus modelRoutingMode selectedModelId')
                .lean()
        ]);

        if (chatSession && chatSession.userId.toString() !== userId.toString()) {
            log.warn('AUTH', `Unauthorized session access: User ${userId} -> Session ${sessionId}`);
            return res.status(403).json({ message: 'Unauthorized access to this chat session.' });
        }

        if (user?.preferredLlmProvider === 'gemini' && user?.apiKeyRequestStatus === 'pending' && !user?.encryptedApiKey) {
            log.warn('AUTH', `Access denied: Pending API key for user ${userId}`);
            const err = new Error('Your request for an API key is pending approval. You cannot start a conversation until the administrator approves your request.');
            err.status = 403;
            throw err;
        }

        const historyFromDb = chatSession ? chatSession.messages : [];
        const chatContext = {
            userId, subject: documentContextName,
            courseId: documentContextName || null,
            chatHistory: historyFromDb, user, tutorMode, tutorModeType,
            // [Optimization] Pass semantic routing result so selectLLM can pick the right SGLang endpoint
            semanticRouting,
            criticalThinkingEnabled,
            useReAct,
        };

        const routingStart = Date.now();
        const { chosenModel, logic: routerLogic, classification, routingDecision } = await selectLLM(query.trim(), chatContext);
        performanceTracker.addRouting(Date.now() - routingStart);

        const queryTokenCount = query.trim().split(/\s+/).filter(Boolean).length;
        const estimatedComplexityScore = Number(routingDecision?.complexityScore) || calculateComplexityScore({
            query: query.trim(),
            tokenEstimate: Math.ceil(query.trim().length / 3),
            reasoningMode: (criticalThinkingEnabled || useReAct) ? 'complex_reasoning' : 'standard'
        });

        const queryIntent = mapQueryIntent({
            tutorMode, deepResearchMode, classification, query: query.trim(),
            useWebSearch, useAcademicSearch, criticalThinkingEnabled, useReAct,
            semanticIntent: semanticRouting?.intent,
            isKgRealtimeEnabled: !!isKgRealtimeEnabled
        });
        // Never use fast path when user explicitly enables web search, academic search, or critical thinking
        // Also never skip RAG routing when a document context is selected
        const simpleFastPath = estimatedComplexityScore < 35 && queryTokenCount < 30 && 
            !useWebSearch && !useAcademicSearch && !criticalThinkingEnabled && !useReAct && !documentContextName;

        if (debugEnabled) {
            const tokenEstimate = Number(routingDecision?.tokenEstimate) || Math.ceil(query.trim().length / 3);
            res.locals.debugContext.routing = {
                provider: chosenModel?.provider || 'unknown',
                modelId: chosenModel?.modelId || 'unknown',
                strategy: routingDecision?.strategy || routerLogic || 'unknown',
                complexityScore: Number(routingDecision?.complexityScore || 0),
                reasoningMode: routingDecision?.reasoningMode || ((criticalThinkingEnabled || useReAct) ? 'complex_reasoning' : 'standard'),
                tokenEstimate,
                latencyBudget: routingDecision?.latencyBudget || 'balanced'
            };
        }

        const llmConfig = {
            llmProvider: chosenModel.provider,
            geminiModel: chosenModel.provider === 'gemini' ? chosenModel.modelId : null,
            ollamaModel: chosenModel.provider === 'ollama' ? (chosenModel.modelId.includes('/') ? chosenModel.modelId.split('/')[1] : chosenModel.modelId) : null,
            groqModel: chosenModel.provider === 'groq' ? chosenModel.modelId : null,
            apiKey: (user?.encryptedApiKey ? decrypt(user.encryptedApiKey) : null) ||
                (chosenModel.provider === 'groq' ? process.env.GROQ_API_KEY : process.env.GEMINI_API_KEY),
            ollamaUrl: chosenModel.workingUrl || user?.ollamaUrl || process.env.OLLAMA_API_BASE_URL
        };

        const summaryFromDb = chatSession ? chatSession.summary || '' : '';
        const needsRecall = doesQuerySuggestRecall(query.trim());

        const formattedDbMessages = historyFromDb.map(msg => ({
            role: msg.role,
            parts: msg.parts.map(part => ({ text: part.text || '' }))
        }));

        const { historyForLlm, newSummary } = await buildOptimalContext({
            messages: formattedDbMessages,
            currentQuery: query.trim(),
            existingSummary: summaryFromDb,
            llmConfig,
            needsRecall
        });

        if (newSummary) {
            ChatHistory.findOneAndUpdate(
                { sessionId, userId },
                { $set: { summary: newSummary, updatedAt: new Date() } },
                { upsert: false }
            ).catch(e => log.warn('SYSTEM', `Failed to persist summary: ${e.message}`));
        }

        let finalSystemPrompt = req.contextualMemory?.systemPrompt || clientProvidedSystemInstruction;

        if (tutorMode && tutorModeType === TUTOR_MODE_TYPES.ASSISTANT) {
            finalSystemPrompt = `You are iMentor, an academic AI tutor assistant. Your ONLY purpose is to help students with academic subjects: Mathematics, Physics, Chemistry, Biology, Computer Science, Engineering, History, Geography, Economics, Literature, and any other formal educational topic.

HARD RULES (never break these):
1. If the student asks about entertainment (movies, cricket, sports, celebrities, social media, games, food, fashion, jokes, or any non-academic topic) — you MUST politely decline and redirect them to academic content. Never answer such questions, even partially.
2. Explain the "why" behind concepts — don't just give answers. Encourage reasoning.
3. Keep tone encouraging, professional, and academic but accessible.
4. If unsure whether a topic is academic, ask the student to clarify its academic context.

REJECTION TEMPLATE (use when query is non-academic):
"I'm iMentor, an academic AI tutor. I can only assist with academic subjects. Your question about [topic] is outside my scope. Please ask me about your coursework or studies!"

` + (finalSystemPrompt || '');
        }

        if (tutorMode && tutorModeType === TUTOR_MODE_TYPES.GENERAL_SOCRATIC) {
            const wantsDirectExplanation = /\b(just explain|explain fully|full explanation|no questions|just tell me|direct answer|give me the answer|don't ask|do not ask)\b/i.test(query || '');
            finalSystemPrompt = `You are iMentor in General Socratic Mode.

Core behavior:
1. Keep every response academic, clear, and concise.
2. Default pattern: brief explanation (2-6 sentences) + exactly one focused Socratic follow-up question.
3. Build from the student's current understanding; avoid dumping long lectures unless asked.
4. If the student asks for a direct/full explanation (e.g., "just explain fully"), provide a complete explanation first, then add an optional check question only if helpful.
5. Never fabricate facts. If uncertain, say what is uncertain and suggest how to verify.
6. Maintain encouraging, professional tutor tone.

Current turn preference: ${wantsDirectExplanation ? 'DIRECT_EXPLANATION_REQUESTED' : 'SOCRATIC_LOOP_DEFAULT'}.

Output style:
- Use simple structure and short paragraphs.
- Prefer examples over abstract wording.
- Avoid roleplay or non-academic digressions.
` + (finalSystemPrompt || '');
        }

        const requestContext = {
            documentContextName, criticalThinkingEnabled, filter,
            userId: userId.toString(), sessionId,
            systemPrompt: finalSystemPrompt,
            isWebSearchEnabled: !!useWebSearch,
            isAcademicSearchEnabled: !!useAcademicSearch,
            isKgRealtimeEnabled: !!isKgRealtimeEnabled,  // Issue 1.1
            intent: queryIntent,
            complexityScore: estimatedComplexityScore,
            queryTokenCount,
            disabledToggles,  // Issue 1.3: toggles the system silently disabled
            ...llmConfig
        };

        // Build the shared context object passed to all post-session handlers
        const ctx = {
            query: query.trim(), sessionId, userId,
            useWebSearch, useAcademicSearch, criticalThinkingEnabled, useReAct,
            documentContextName, filter, bountyId, bountyAnswer,
            deepResearchMode, tutorMode, tutorModeType, currentModulePathId,
            clientProvidedSystemInstruction, finalSystemPrompt,
            user, chatSession, historyFromDb, historyForLlm,
            llmConfig, chosenModel, routerLogic, classification, routingDecision,
            queryIntent, estimatedComplexityScore, queryTokenCount, simpleFastPath,
            semanticRouting,   // full routing decision (intent, confidence, tools)
            requestContext, userMessageForDb,
            isAutoGreeting,    // silent auto-init: skip user message in DB write
            startTime, performanceTracker,
            capturePerformance, captureDebugFromResponse, captureRedisStateFromCache,
            debugEnabled,
            contextualMemory: req.contextualMemory,
            // ── New tracing/routing fields ──────────────────────────────────────────
            isKgRealtimeEnabled:           !!isKgRealtimeEnabled,          // Issue 1.1
            userRequestedToT,                                               // Issue 1.2
            disabledToggles,                                                // Issue 1.3
            userExplicitlyDisabledWebSearch: !!userExplicitlyDisabledWebSearch, // Issue 1.4
            hybridDecomposition,                                            // sub-query routing plan
            buildHybridContextBlock,                                        // helper for prompt injection
        };

        // ── Code routing ──────────────────────────────────────────────────────
        if (await codeHandler.handle(res, ctx)) return;

        // ── Tutor: General Socratic ───────────────────────────────────────────
        if (await tutorHandler.handleGeneral(res, ctx)) return;

        // ── Tutor: Course-Structured ──────────────────────────────────────────
        if (await tutorHandler.handleStructured(res, ctx)) return;

        // ── Standard / Advanced Reasoning ────────────────────────────────────
        await standardHandler.handle(res, ctx);

    } catch (error) {
        const elapsed = Date.now() - startTime;
        const errorText = (error.message || '').toLowerCase();
        const status = error.status || error.response?.status || 500;
        log.error('CHAT', `Request failed after ${elapsed}ms — query: "${(query || '').substring(0, 60)}" | status: ${status} | ${error.message}`, { stack: error.stack });

        const isAIServiceError =
            [401, 403, 404, 429, 503].includes(status) ||
            errorText.includes('rate limit') || errorText.includes('429') ||
            errorText.includes('quota exceeded') || errorText.includes('service unavailable') ||
            errorText.includes('invalid api key') || errorText.includes('authentication') ||
            errorText.includes('unauthorized') || errorText.includes('model not found') ||
            errorText.includes('is not found') || errorText.includes('not supported') ||
            errorText.includes('overloaded') || errorText.includes('econnreset') ||
            errorText.includes('econnrefused');

        if (isAIServiceError) {
            let reason = 'Service unavailable';
            if (status === 401 || errorText.includes('invalid api key') || errorText.includes('unauthorized') || errorText.includes('authentication')) {
                reason = 'API key is invalid or unauthorized';
            } else if (status === 403) {
                reason = 'Access denied — API key may lack permissions';
            } else if (status === 429 || errorText.includes('rate limit') || errorText.includes('quota exceeded')) {
                reason = 'API quota exceeded or rate limit reached';
            } else if (status === 503 || errorText.includes('overloaded') || errorText.includes('service unavailable')) {
                reason = 'AI service is temporarily overloaded or unavailable';
            } else if (status === 404 || errorText.includes('model not found') || errorText.includes('is not found') || errorText.includes('not supported')) {
                reason = 'AI model is not found or not supported — check model name in settings';
            } else if (errorText.includes('econnrefused') || errorText.includes('econnreset')) {
                reason = 'Cannot connect to AI service';
            }
            log.warn('AI', `Server busy or unavailable for ${sessionId}: ${reason}`);
        } else {
            log.error('SYSTEM', `Critical error in ${sessionId}`, { message: error.message, status });
        }

        let clientMessage = error.response?.data?.error || error.message || 'An internal error occurred while processing your message.';

        if (isAIServiceError) {
            clientMessage = 'It seems like the AI service is not working right now or is temporarily overwhelmed. Please wait a few moments and try again! 📚';
        }

        if (res.headersSent && !res.writableEnded) {
            streamEvent(res, { type: 'error', content: clientMessage });
            res.end();
        } else if (!res.headersSent) {
            res.status(status).json({
                message: clientMessage,
                error: (process.env.NODE_ENV === 'development' && !isAIServiceError) ? error.stack : undefined
            });
        }
    }
});

// ── Decomposed route mounts ───────────────────────────────────────────────────
const sessionRoutes = require('../sessionRoutes');
const knowledgeRoutes = require('../knowledgeRoutes');
const tutorRoutes = require('../tutorRoutes');

router.use('/', sessionRoutes);
router.use('/', knowledgeRoutes);
router.use('/', tutorRoutes);

// ── STT: proxy audio to Python Whisper service ────────────────────────────────
const multer = require('multer');
const axios  = require('axios');
const FormData = require('form-data');

const _sttUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max audio
}).single('audio');

router.post('/transcribe', authMiddleware, sttLimiter, (req, res) => {
    _sttUpload(req, res, async (err) => {
        if (err) return res.status(400).json({ message: err.message });
        if (!req.file) return res.status(400).json({ message: 'No audio file provided.' });

        const pythonUrl = process.env.PYTHON_RAG_SERVICE_URL;
        if (!pythonUrl) return res.status(503).json({ message: 'STT service not configured.' });

        try {
            const form = new FormData();
            form.append('audio', req.file.buffer, {
                filename: req.file.originalname || 'recording.webm',
                contentType: req.file.mimetype || 'audio/webm',
            });

            const response = await axios.post(`${pythonUrl}/stt/transcribe`, form, {
                headers: form.getHeaders(),
                timeout: 30000,
            });

            res.json(response.data); // { text, language }
        } catch (e) {
            const msg = e.response?.data?.detail || e.message;
            log.error('STT', `Whisper transcription failed: ${msg}`);
            res.status(500).json({ message: `Transcription failed: ${msg}` });
        }
    });
});

module.exports = router;

// server/routes/chat/index.js
// Orchestrates the /message route by delegating to focused handler modules.
const express = require('express');
const ChatHistory = require('../../models/ChatHistory');
const User = require('../../models/User');
const { decrypt } = require('../../utils/crypto');
const { redisClient } = require('../../config/redisClient');
const { selectLLM } = require('../../services/llmRouterService');
const { buildOptimalContext } = require('../../services/contextManager');
const { createPerformanceTracker, logPerformance } = require('../../services/performanceDiagnosticsService');
const { calculateComplexityScore } = require('../../services/smartModelRouterService');
const { injectContextualMemory } = require('../../middleware/contextualMemoryMiddleware');
const { buildMemoryAwareSystemPrompt } = require('../../services/socraticService');
const contextService = require('../../services/contextService');
const { validateChatMessage } = require('../../middleware/requestValidation');
const { sttLimiter } = require('../../middleware/rateLimitMiddleware');
const { authMiddleware } = require('../../middleware/authMiddleware');
const { isDebugMode } = require('../../utils/debugMode');
const log = require('../../utils/logger');
const routerFeedback = require('../../services/routerFeedbackService');
const { routeQuery } = require('../../services/semanticRouter');
const { routeWithLLM } = require('../../services/llmToolRouter');
const { decomposeQuery, buildHybridContextBlock } = require('../../services/hybridQueryDecomposer');

const {
    streamEvent,
    detectNonAcademic,
    doesQuerySuggestRecall,
    TUTOR_MODE_TYPES,
    resolveTutorModeType,
    mapQueryIntent,
} = require('./helpers');

const quizHandler = require('./handlers/quizHandler');
const researchHandler = require('./handlers/researchHandler');
const codeHandler = require('./handlers/codeHandler');
const tutorHandler = require('./handlers/tutorHandler');
const standardHandler = require('./handlers/standardHandler');

const router = express.Router();

router.post('/message', validateChatMessage, injectContextualMemory, async (req, res) => {
    let {
        query, sessionId, useWebSearch, useAcademicSearch,
        systemPrompt: clientProvidedSystemInstruction, criticalThinkingEnabled,
        documentContextName, filter, bountyId, bountyAnswer, useReAct,
        deepResearchMode, tutorModeType, currentModulePathId,
        isKgRealtimeEnabled, userExplicitlyDisabledWebSearch,
        isAutoGreeting,  // silent auto-init flag: don't save user message to DB
    } = req.body;

    isAutoGreeting = isAutoGreeting === true;
    useReAct = useReAct === true;
    // Issue 1.2: capture whether the USER explicitly requested ToT before semantic routing
    // can mutate criticalThinkingEnabled. Used in standardHandler to apply the lower gate (40).
    const userRequestedToT = criticalThinkingEnabled;
    
    log.info('CHAT', `[ToT DEBUG] Raw criticalThinkingEnabled from client: ${req.body.criticalThinkingEnabled} (type: ${typeof req.body.criticalThinkingEnabled})`);
    log.info('CHAT', `[ToT DEBUG] userRequestedToT captured: ${userRequestedToT}`);

    let tutorMode = req.body.tutorMode || req.body.isTutorMode || req.body.tutor_mode;

    if (query) {
        const lowerQuery = query.toLowerCase();
        if (lowerQuery.startsWith('tutor:') || lowerQuery.startsWith('teach me') || lowerQuery.startsWith('learn ')) {
            tutorMode = true;
            log.info('CHAT', `Tutor Mode auto-enabled for: "${lowerQuery.substring(0, 30)}..."`);
        }
    }

    if (Object.values(TUTOR_MODE_TYPES).includes(tutorModeType)) {
        tutorMode = true;
    }

    if (tutorMode) {
        tutorModeType = resolveTutorModeType(tutorModeType, documentContextName);
        log.info('CHAT', `Resolved Tutor mode type: ${tutorModeType}`);
    }

    // Issue 1.3: track which toggles the system silently disabled so the frontend can surface a notice
    const disabledToggles = [];
    if (tutorMode && criticalThinkingEnabled) {
        log.warn('CHAT', 'Tutor Mode active: Forcing critical thinking OFF');
        criticalThinkingEnabled = false;
        disabledToggles.push('criticalThinking');
    }

    log.info('CHAT', `Message received (Tutor: ${tutorMode}, Critical: ${criticalThinkingEnabled})`);

    const userId = req.user._id;
    log.info('CHAT', 'User metadata audit logged.');

    if (!query || typeof query !== 'string' || query.trim() === '') {
        return res.status(400).json({ message: 'Query message text required.' });
    }
    if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ message: 'Session ID required.' });
    }

    const userMessageForDb = { role: 'user', parts: [{ text: query }], timestamp: new Date() };
    log.info('CHAT', `Processing query: "${query.substring(0, 50)}..."`);
    const startTime = Date.now();
    const debugEnabled = isDebugMode(req);
    res.locals.isDebugMode = debugEnabled;
    res.locals.debugContext = {
        routing: { latencyBudget: 'balanced' },
        performance: null,
        reasoning: null,
        redis: null
    };

    const performanceTracker = createPerformanceTracker({
        route: 'chat.message',
        sessionId,
        userId: userId.toString(),
        queryType: deepResearchMode ? 'deep_research' : (criticalThinkingEnabled || useReAct ? 'complex' : 'simple')
    });

    const capturePerformance = (extra = {}) => {
        const payload = performanceTracker.toLogPayload(extra);
        logPerformance(payload);
        if (debugEnabled) {
            res.locals.debugContext.performance = payload;
        }
        return payload;
    };

    const captureDebugFromResponse = (responseObject = {}) => {
        if (!debugEnabled || !responseObject || typeof responseObject !== 'object') return;

        const reasoningMeta = responseObject.reasoningMeta || {};
        const agentState = reasoningMeta.agentState || {};
        const confidenceHistory = Array.isArray(agentState.confidenceHistory) ? agentState.confidenceHistory : [];
        const stepConfidences = Array.isArray(reasoningMeta.stepConfidences)
            ? reasoningMeta.stepConfidences
            : confidenceHistory.slice(-3);

        const priorInsightsCount = Array.isArray(agentState.priorInsights)
            ? agentState.priorInsights.length
            : (Array.isArray(reasoningMeta?.reasoningState?.insights) ? reasoningMeta.reasoningState.insights.length : 0);

        const branchHistoryCount = Array.isArray(agentState.branchHistory)
            ? agentState.branchHistory.length
            : 0;

        const loadedState = Boolean(reasoningMeta.reusedMemory || priorInsightsCount > 0 || branchHistoryCount > 0);

        res.locals.debugContext.reasoning = {
            branchCount: responseObject.totalBranchesGenerated || reasoningMeta.branchCount || 1,
            branchesPruned: reasoningMeta.branchesPruned || 0,
            stepConfidences,
            finalConfidence: reasoningMeta.finalConfidence || reasoningMeta.aggregatedStepConfidence || reasoningMeta.confidenceScore || responseObject.confidenceScore || 0,
            correctionLoops: reasoningMeta.correctionLoops || reasoningMeta.critiqueApplied || 0,
            reusedMemory: Boolean(reasoningMeta.reusedMemory),
            topicSimilarity: Number(reasoningMeta.topicSimilarity || 0)
        };

        res.locals.debugContext.redis = {
            redisHit: loadedState,
            loadedState,
            priorInsightsCount,
            branchHistoryCount
        };
    };

    const captureRedisStateFromCache = async () => {
        if (!debugEnabled || !redisClient || !redisClient.isOpen) return;

        try {
            const [agentStateRaw, reasoningStateRaw] = await Promise.all([
                redisClient.get(`agent_state:${sessionId}`),
                redisClient.get(`reasoning_state:${sessionId}`)
            ]);
            const totStateRaw = await redisClient.get(`tot_state:${sessionId}`);

            const parsedAgentState = agentStateRaw ? JSON.parse(agentStateRaw) : null;
            const parsedReasoningState = reasoningStateRaw ? JSON.parse(reasoningStateRaw) : null;

            const priorInsightsFromAgent = Array.isArray(parsedAgentState?.priorInsights) ? parsedAgentState.priorInsights.length : 0;
            const branchHistoryFromAgent = Array.isArray(parsedAgentState?.branchHistory) ? parsedAgentState.branchHistory.length : 0;
            const priorInsightsFromReasoning = Array.isArray(parsedReasoningState?.reasoningState?.insights) ? parsedReasoningState.reasoningState.insights.length : 0;
            const branchHistoryFromReasoning = Array.isArray(parsedReasoningState?.reasoningState?.dimensions) ? parsedReasoningState.reasoningState.dimensions.length : 0;

            const priorInsightsCount = Math.max(priorInsightsFromAgent, priorInsightsFromReasoning);
            const branchHistoryCount = Math.max(branchHistoryFromAgent, branchHistoryFromReasoning);

            const parsedTotState = totStateRaw ? JSON.parse(totStateRaw) : null;
            const priorInsightsFromToT = Array.isArray(parsedTotState?.priorInsights) ? parsedTotState.priorInsights.length : 0;
            const branchHistoryFromToT = Array.isArray(parsedTotState?.branchHistory) ? parsedTotState.branchHistory.length : 0;

            const loadedState = Boolean(agentStateRaw || reasoningStateRaw || totStateRaw || priorInsightsCount > 0 || branchHistoryCount > 0 || priorInsightsFromToT > 0 || branchHistoryFromToT > 0);

            res.locals.debugContext.redis = {
                redisHit: loadedState,
                loadedState,
                priorInsightsCount: Math.max(priorInsightsCount, priorInsightsFromToT),
                branchHistoryCount: Math.max(branchHistoryCount, branchHistoryFromToT)
            };
        } catch {
            // non-blocking debug telemetry only
        }
    };

    // ── Hybrid sub-query decomposition (runs before keyword pre-check) ──────────
    // Splits multi-part queries and classifies each part independently so that
    // only the "recent / current" segments trigger web/academic search, while
    // foundational/conceptual segments are answered from LLM knowledge alone.
    const hybridDecomposition = decomposeQuery(query.trim(), {
        tutorMode:          !!tutorMode,
        deepResearchMode:   deepResearchMode === true,
        userForcedWeb:      !!useWebSearch,
        userForcedAcademic: !!useAcademicSearch,
    });

    if (hybridDecomposition.isHybrid && !userExplicitlyDisabledWebSearch) {
        // Only upgrade retrieval flags — never downgrade what the user set
        if (hybridDecomposition.needsWeb      && !useWebSearch)      useWebSearch      = true;
        if (hybridDecomposition.needsAcademic && !useAcademicSearch) useAcademicSearch = true;
        log.info('CHAT', `[HYBRID] Multi-part query detected — web:${useWebSearch} academic:${useAcademicSearch}`);
    }

    // ── Keyword pre-check: news / current-events (zero-latency, before embedding) ──
    const _q = query.trim().toLowerCase();
    const _isCurrentEventsQuery = (
        /\b(latest|recent|current|today|tonight|yesterday|this week|this month|this year|right now|as of|breaking|just happened|new update|ongoing)\b/.test(_q) ||
        /\b(news|headline|report|update|development|announcement|situation|crisis|conflict|war|election|summit|deal|attack|protest)\b/.test(_q) ||
        /\b(what('s| is) happening|tell me about.*news|any news|what happened|what's new)\b/.test(_q)
    );
    if (_isCurrentEventsQuery && !tutorMode && !useWebSearch && !userExplicitlyDisabledWebSearch) {
        useWebSearch = true;
        log.info('CHAT', `Keyword pre-check: current-events query → web search enabled`);
    }
    // Track whether webSearch was set by keyword pre-check (not routing) for feedback dedup
    const _keywordSetWebSearch = useWebSearch;

    // ── Issue 2.3: Skip semantic routing when toggle already determines the route ──────────
    // deepResearchMode intercepts before any orchestrator; tutorMode always goes to tutor handler.
    // Skipping saves 6–11ms (one Ollama /embed round-trip) on every toggled request.
    const skipSemanticRouting = deepResearchMode === true || tutorMode === true;

    // ── Semantic routing: Intent classification & rejection check ──────────────
    let semanticRouting = null;
    if (!skipSemanticRouting) {
    try {
        semanticRouting = await routeQuery(query.trim(), {
            userId,
            documentContext: documentContextName,
            hasUploadedFiles: !!documentContextName,
            // Pass currently-active tool flags so the semantic router can use them
            // as scoring priors (e.g. boost DOCUMENT_RAG when file is present,
            // confirm WEB_SEARCH intent when user already toggled it on).
            activeTools: {
                webSearch:     useWebSearch,
                academicSearch: useAcademicSearch,
                tot:           criticalThinkingEnabled,
                deepResearch:  deepResearchMode,
            },
        });

        log.info('CHAT', `Semantic routing: ${semanticRouting.intent} (confidence: ${semanticRouting.confidence.toFixed(3)})`);

        // Rejection handling (non-academic queries)
        if (semanticRouting.shouldReject) {
            log.warn('CHAT', `Semantic router rejected: ${semanticRouting.intent}`);
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders();

            const rejectionText = semanticRouting.rejectionMessage;

            streamEvent(res, {
                type: 'final_answer',
                content: {
                    sender: 'bot', role: 'model',
                    text: rejectionText, parts: [{ text: rejectionText }],
                    timestamp: new Date(),
                    source_pipeline: 'semantic-router-rejection',
                    intent: semanticRouting.intent,
                    confidenceScore: Math.round(semanticRouting.confidence * 100)
                }
            });
            return res.end();
        }

        // Override tool flags based on semantic routing
        // When a document/course is selected (documentContextName), RAG takes priority —
        // do NOT let the semantic router override to web or academic search.
        if (semanticRouting.tools.includes('web_search') && !userExplicitlyDisabledWebSearch && !documentContextName) {
            useWebSearch = true;
            log.info('CHAT', 'Semantic router enabled web search');
        } else if (semanticRouting.tools.includes('web_search') && documentContextName) {
            log.info('CHAT', `Semantic router suggested web_search but documentContextName="${documentContextName}" is set — routing to RAG instead`);
        }
        if (semanticRouting.tools.includes('academic_search') && !documentContextName) {
            useAcademicSearch = true;
            log.info('CHAT', 'Semantic router enabled academic search');
        } else if (semanticRouting.tools.includes('academic_search') && documentContextName) {
            log.info('CHAT', `Semantic router suggested academic_search but documentContextName="${documentContextName}" is set — routing to RAG instead`);
        }
        if (semanticRouting.tools.includes('deep_research')) {
            // If the user has selected a course document, honour RAG over deep research
            if (!documentContextName) {
                deepResearchMode = true;
                log.info('CHAT', 'Semantic router enabled deep research');
            } else {
                log.info('CHAT', `Semantic router suggested deep_research but documentContextName="${documentContextName}" is set — routing to RAG instead`);
            }
        }
        if (semanticRouting.tools.includes('tot')) {
            criticalThinkingEnabled = true;
            log.info('CHAT', 'Semantic router enabled Tree-of-Thought');
        }

        // ── LLM Tool Router: second opinion when semantic confidence is low ──
        // Runs async (non-blocking for low-confidence cases that don't already
        // have explicit user flags set). Kicks in when confidence < 0.65.
        const LLM_ROUTER_THRESHOLD = 0.65;
        const needsLlmRouter = semanticRouting.confidence < LLM_ROUTER_THRESHOLD
            && !tutorMode
            && !useWebSearch && !useAcademicSearch; // only if tools not already set

        if (needsLlmRouter) {
            try {
                const llmRouting = await routeWithLLM(query.trim());
                if (llmRouting.tools.includes('web_search')) {
                    useWebSearch = true;
                    log.info('CHAT', `LLM router enabled web_search (semantic conf=${semanticRouting.confidence.toFixed(2)})`);
                }
                if (llmRouting.tools.includes('academic_search')) {
                    useAcademicSearch = true;
                    log.info('CHAT', `LLM router enabled academic_search`);
                }
                if (llmRouting.tools.includes('tot') && !criticalThinkingEnabled) {
                    criticalThinkingEnabled = true;
                    log.info('CHAT', `LLM router enabled ToT`);
                }
                if (llmRouting.tools.includes('deep_research') && !deepResearchMode && !documentContextName) {
                    deepResearchMode = true;
                    log.info('CHAT', `LLM router enabled deep_research`);
                }
            } catch (llmRouterErr) {
                log.warn('CHAT', `LLM router failed silently: ${llmRouterErr.message}`);
            }
        }

        // ── Router feedback: record Step-1 misses for cache improvement ──────
        if (semanticRouting.fallback === true) {
            const resolvedIntent = routerFeedback.inferIntent({
                deepResearchMode,
                useAcademicSearch,
                useWebSearch,
                criticalThinkingEnabled,
                userRequestedToT,
                keywordSetWebSearch: _keywordSetWebSearch,
            });
            if (resolvedIntent) {
                routerFeedback.recordMiss(query, semanticRouting.confidence, resolvedIntent, 'routing_waterfall');
            }
        }

    } catch (semanticErr) {
        log.error('CHAT', `Semantic routing failed: ${semanticErr.message}. Falling back to keyword detection.`);
        // Fallback to original keyword-based detection
        if (tutorMode) {
            const nonAcademicTopic = detectNonAcademic(query.trim());
            if (nonAcademicTopic) {
                log.warn('CHAT', `Academic filter blocked non-academic request: "${nonAcademicTopic}"`);
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.flushHeaders();

                const rejectionText = `I'm iMentor, an **academic AI tutor** — I'm only able to help with subjects like Mathematics, Science, Computer Science, Engineering, History, Economics, and other academic topics.\n\nIt looks like your message is about **"${nonAcademicTopic}"**, which is outside my scope.\n\n📚 Please ask me something related to your coursework or academic subjects and I'll be happy to help!`;

                streamEvent(res, {
                    type: 'final_answer',
                    content: {
                        sender: 'bot', role: 'model',
                        text: rejectionText, parts: [{ text: rejectionText }],
                        timestamp: new Date(),
                        source_pipeline: 'academic-filter-fallback',
                        confidenceScore: 100
                    }
                });
                return res.end();
            }
        }
    }
    } // end if (!skipSemanticRouting)

    // ── Academic subject gate (tutor mode only, zero LLM cost) ───────────────
    // LEGACY: Keeping as additional fallback if semantic routing fails
    if (tutorMode && !semanticRouting) {
        const nonAcademicTopic = detectNonAcademic(query.trim());
        if (nonAcademicTopic) {
            log.warn('CHAT', `Academic filter blocked non-academic request: "${nonAcademicTopic}"`);
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders();

            const rejectionText = `I'm iMentor, an **academic AI tutor** — I'm only able to help with subjects like Mathematics, Science, Computer Science, Engineering, History, Economics, and other academic topics.\n\nIt looks like your message is about **"${nonAcademicTopic}"**, which is outside my scope.\n\n📚 Please ask me something related to your coursework or academic subjects and I'll be happy to help!`;

            streamEvent(res, {
                type: 'final_answer',
                content: {
                    sender: 'bot', role: 'model',
                    text: rejectionText, parts: [{ text: rejectionText }],
                    timestamp: new Date(),
                    source_pipeline: 'academic-filter',
                    confidenceScore: 100
                }
            });
            return res.end();
        }
    }

    // ── Quiz fast-path (outside try — no session data needed) ────────────────
    const isQuizMode = tutorMode && tutorModeType === TUTOR_MODE_TYPES.ASSISTANT &&
        clientProvidedSystemInstruction &&
        (clientProvidedSystemInstruction.includes('quiz answer evaluator') ||
            clientProvidedSystemInstruction.includes('CORRECT ANSWER:'));

    if (isQuizMode) {
        return quizHandler.handle(res, {
            query, sessionId, userId,
            clientProvidedSystemInstruction,
            userMessageForDb,
        });
    }

    try {
        // ── Deep research intercept (no session data needed) ─────────────────
        if (deepResearchMode === true) {
            return researchHandler.handle(req, res, {
                query,
                userId: req.user.id || req.user._id,
                performanceTracker,
                capturePerformance,
            });
        }

        // ── Session & user validation (parallel) ──────────────────────────────
        const [chatSession, user] = await Promise.all([
            ChatHistory.findOne({ sessionId }),
            User.findById(userId)
                .select('+encryptedApiKey preferredLlmProvider ollamaModel ollamaUrl apiKeyRequestStatus modelRoutingMode selectedModelId')
                .lean()
        ]);

        if (chatSession && chatSession.userId.toString() !== userId.toString()) {
            log.warn('AUTH', `Unauthorized session access: User ${userId} -> Session ${sessionId}`);
            return res.status(403).json({ message: 'Unauthorized access to this chat session.' });
        }

        if (user?.preferredLlmProvider === 'gemini' && user?.apiKeyRequestStatus === 'pending' && !user?.encryptedApiKey) {
            log.warn('AUTH', `Access denied: Pending API key for user ${userId}`);
            const err = new Error('Your request for an API key is pending approval. You cannot start a conversation until the administrator approves your request.');
            err.status = 403;
            throw err;
        }

        const historyFromDb = chatSession ? chatSession.messages : [];
        const chatContext = {
            userId, subject: documentContextName,
            courseId: documentContextName || null,
            chatHistory: historyFromDb, user, tutorMode, tutorModeType
        };

        const routingStart = Date.now();
        const { chosenModel, logic: routerLogic, classification, routingDecision } = await selectLLM(query.trim(), chatContext);
        performanceTracker.addRouting(Date.now() - routingStart);

        const queryTokenCount = query.trim().split(/\s+/).filter(Boolean).length;
        const estimatedComplexityScore = Number(routingDecision?.complexityScore) || calculateComplexityScore({
            query: query.trim(),
            tokenEstimate: Math.ceil(query.trim().length / 3),
            reasoningMode: (criticalThinkingEnabled || useReAct) ? 'complex_reasoning' : 'standard'
        });

        const queryIntent = mapQueryIntent({
            tutorMode, deepResearchMode, classification, query: query.trim(),
            useWebSearch, useAcademicSearch, criticalThinkingEnabled, useReAct,
            semanticIntent: semanticRouting?.intent,
            isKgRealtimeEnabled: !!isKgRealtimeEnabled
        });
        // Never use fast path when user explicitly enables web search, academic search, or critical thinking
        // Also never skip RAG routing when a document context is selected
        const simpleFastPath = estimatedComplexityScore < 35 && queryTokenCount < 30 && 
            !useWebSearch && !useAcademicSearch && !criticalThinkingEnabled && !useReAct && !documentContextName;

        if (debugEnabled) {
            const tokenEstimate = Number(routingDecision?.tokenEstimate) || Math.ceil(query.trim().length / 3);
            res.locals.debugContext.routing = {
                provider: chosenModel?.provider || 'unknown',
                modelId: chosenModel?.modelId || 'unknown',
                strategy: routingDecision?.strategy || routerLogic || 'unknown',
                complexityScore: Number(routingDecision?.complexityScore || 0),
                reasoningMode: routingDecision?.reasoningMode || ((criticalThinkingEnabled || useReAct) ? 'complex_reasoning' : 'standard'),
                tokenEstimate,
                latencyBudget: routingDecision?.latencyBudget || 'balanced'
            };
        }

        const llmConfig = {
            llmProvider: chosenModel.provider,
            geminiModel: chosenModel.provider === 'gemini' ? chosenModel.modelId : null,
            ollamaModel: chosenModel.provider === 'ollama' ? (chosenModel.modelId.includes('/') ? chosenModel.modelId.split('/')[1] : chosenModel.modelId) : null,
            groqModel: chosenModel.provider === 'groq' ? chosenModel.modelId : null,
            apiKey: (user?.encryptedApiKey ? decrypt(user.encryptedApiKey) : null) ||
                (chosenModel.provider === 'groq' ? process.env.GROQ_API_KEY : process.env.GEMINI_API_KEY),
            ollamaUrl: chosenModel.workingUrl || user?.ollamaUrl || process.env.OLLAMA_API_BASE_URL
        };

        const summaryFromDb = chatSession ? chatSession.summary || '' : '';
        const needsRecall = doesQuerySuggestRecall(query.trim());

        const formattedDbMessages = historyFromDb.map(msg => ({
            role: msg.role,
            parts: msg.parts.map(part => ({ text: part.text || '' }))
        }));

        const { historyForLlm, newSummary } = await buildOptimalContext({
            messages: formattedDbMessages,
            currentQuery: query.trim(),
            existingSummary: summaryFromDb,
            llmConfig,
            needsRecall
        });

        if (newSummary) {
            ChatHistory.findOneAndUpdate(
                { sessionId, userId },
                { $set: { summary: newSummary, updatedAt: new Date() } },
                { upsert: false }
            ).catch(e => log.warn('SYSTEM', `Failed to persist summary: ${e.message}`));
        }

        // Load formatted conversation context (non-blocking — degrade gracefully)
        let formattedContext = '';
        try {
            formattedContext = await contextService.getFormattedContextForPrompt(userId, sessionId);
        } catch (err) {
            log.warn('CONTEXT', `Failed to assemble formatted context: ${err.message}`);
            formattedContext = '';
        }

        let finalSystemPrompt = buildMemoryAwareSystemPrompt(req.contextualMemory, clientProvidedSystemInstruction, tutorMode, query);
        if (formattedContext) finalSystemPrompt = `${finalSystemPrompt}\n\n${formattedContext}`;

        if (tutorMode && tutorModeType === TUTOR_MODE_TYPES.ASSISTANT) {
            finalSystemPrompt = `You are iMentor, an academic AI tutor assistant. Your ONLY purpose is to help students with academic subjects: Mathematics, Physics, Chemistry, Biology, Computer Science, Engineering, History, Geography, Economics, Literature, and any other formal educational topic.

HARD RULES (never break these):
1. If the student asks about entertainment (movies, cricket, sports, celebrities, social media, games, food, fashion, jokes, or any non-academic topic) — you MUST politely decline and redirect them to academic content. Never answer such questions, even partially.
2. Explain the "why" behind concepts — don't just give answers. Encourage reasoning.
3. Keep tone encouraging, professional, and academic but accessible.
4. If unsure whether a topic is academic, ask the student to clarify its academic context.

REJECTION TEMPLATE (use when query is non-academic):
"I'm iMentor, an academic AI tutor. I can only assist with academic subjects. Your question about [topic] is outside my scope. Please ask me about your coursework or studies!"

` + (finalSystemPrompt || '');
        }

        if (tutorMode && tutorModeType === TUTOR_MODE_TYPES.GENERAL_SOCRATIC) {
            const wantsDirectExplanation = /\b(just explain|explain fully|full explanation|no questions|just tell me|direct answer|give me the answer|don't ask|do not ask)\b/i.test(query || '');
            finalSystemPrompt = `You are iMentor in General Socratic Mode.

Core behavior:
1. Keep every response academic, clear, and concise.
2. Default pattern: brief explanation (2-6 sentences) + exactly one focused Socratic follow-up question.
3. Build from the student's current understanding; avoid dumping long lectures unless asked.
4. If the student asks for a direct/full explanation (e.g., "just explain fully"), provide a complete explanation first, then add an optional check question only if helpful.
5. Never fabricate facts. If uncertain, say what is uncertain and suggest how to verify.
6. Maintain encouraging, professional tutor tone.

Current turn preference: ${wantsDirectExplanation ? 'DIRECT_EXPLANATION_REQUESTED' : 'SOCRATIC_LOOP_DEFAULT'}.

Output style:
- Use simple structure and short paragraphs.
- Prefer examples over abstract wording.
- Avoid roleplay or non-academic digressions.
` + (finalSystemPrompt || '');
        }

        const requestContext = {
            documentContextName, criticalThinkingEnabled, filter,
            userId: userId.toString(), sessionId,
            systemPrompt: finalSystemPrompt,
            isWebSearchEnabled: !!useWebSearch,
            isAcademicSearchEnabled: !!useAcademicSearch,
            isKgRealtimeEnabled: !!isKgRealtimeEnabled,  // Issue 1.1
            intent: queryIntent,
            complexityScore: estimatedComplexityScore,
            queryTokenCount,
            disabledToggles,  // Issue 1.3: toggles the system silently disabled
            ...llmConfig
        };

        // Build the shared context object passed to all post-session handlers
        const ctx = {
            query: query.trim(), sessionId, userId,
            useWebSearch, useAcademicSearch, criticalThinkingEnabled, useReAct,
            documentContextName, filter, bountyId, bountyAnswer,
            deepResearchMode, tutorMode, tutorModeType, currentModulePathId,
            clientProvidedSystemInstruction, finalSystemPrompt,
            user, chatSession, historyFromDb, historyForLlm,
            llmConfig, chosenModel, routerLogic, classification, routingDecision,
            queryIntent, estimatedComplexityScore, queryTokenCount, simpleFastPath,
            semanticRouting,   // full routing decision (intent, confidence, tools)
            requestContext, userMessageForDb,
            isAutoGreeting,    // silent auto-init: skip user message in DB write
            startTime, performanceTracker,
            capturePerformance, captureDebugFromResponse, captureRedisStateFromCache,
            debugEnabled,
            contextualMemory: req.contextualMemory,
            // ── New tracing/routing fields ──────────────────────────────────────────
            isKgRealtimeEnabled:           !!isKgRealtimeEnabled,          // Issue 1.1
            userRequestedToT,                                               // Issue 1.2
            disabledToggles,                                                // Issue 1.3
            userExplicitlyDisabledWebSearch: !!userExplicitlyDisabledWebSearch, // Issue 1.4
            hybridDecomposition,                                            // sub-query routing plan
            buildHybridContextBlock,                                        // helper for prompt injection
        };

        // ── Code routing ──────────────────────────────────────────────────────
        if (await codeHandler.handle(res, ctx)) return;

        // ── Tutor: General Socratic ───────────────────────────────────────────
        if (await tutorHandler.handleGeneral(res, ctx)) return;

        // ── Tutor: Course-Structured ──────────────────────────────────────────
        if (await tutorHandler.handleStructured(res, ctx)) return;

        // ── Standard / Advanced Reasoning ────────────────────────────────────
        await standardHandler.handle(res, ctx);

    } catch (error) {
        const elapsed = Date.now() - startTime;
        const errorText = (error.message || '').toLowerCase();
        const status = error.status || error.response?.status || 500;
        log.error('CHAT', `Request failed after ${elapsed}ms — query: "${(query || '').substring(0, 60)}" | status: ${status} | ${error.message}`, { stack: error.stack });

        const isAIServiceError =
            [401, 403, 404, 429, 503].includes(status) ||
            errorText.includes('rate limit') || errorText.includes('429') ||
            errorText.includes('quota exceeded') || errorText.includes('service unavailable') ||
            errorText.includes('invalid api key') || errorText.includes('authentication') ||
            errorText.includes('unauthorized') || errorText.includes('model not found') ||
            errorText.includes('is not found') || errorText.includes('not supported') ||
            errorText.includes('overloaded') || errorText.includes('econnreset') ||
            errorText.includes('econnrefused');

        if (isAIServiceError) {
            let reason = 'Service unavailable';
            if (status === 401 || errorText.includes('invalid api key') || errorText.includes('unauthorized') || errorText.includes('authentication')) {
                reason = 'API key is invalid or unauthorized';
            } else if (status === 403) {
                reason = 'Access denied — API key may lack permissions';
            } else if (status === 429 || errorText.includes('rate limit') || errorText.includes('quota exceeded')) {
                reason = 'API quota exceeded or rate limit reached';
            } else if (status === 503 || errorText.includes('overloaded') || errorText.includes('service unavailable')) {
                reason = 'AI service is temporarily overloaded or unavailable';
            } else if (status === 404 || errorText.includes('model not found') || errorText.includes('is not found') || errorText.includes('not supported')) {
                reason = 'AI model is not found or not supported — check model name in settings';
            } else if (errorText.includes('econnrefused') || errorText.includes('econnreset')) {
                reason = 'Cannot connect to AI service';
            }
            log.warn('AI', `Server busy or unavailable for ${sessionId}: ${reason}`);
        } else {
            log.error('SYSTEM', `Critical error in ${sessionId}`, { message: error.message, status });
        }

        let clientMessage = error.response?.data?.error || error.message || 'An internal error occurred while processing your message.';
        let providerDetail = null;

        if (isAIServiceError) {
            // Prefer a concise user-facing message; optionally include provider details in dev/debug mode
            providerDetail = (error.providerErrors && error.providerErrors.length)
                ? error.providerErrors.map(e => `${e.provider}:${e.model} -> ${e.message}`).join(' | ')
                : (error.lastError?.message || error.originalError?.message || error.message);

            if (process.env.SHOW_AI_ERRORS === 'true') {
                clientMessage = `AI provider error: ${providerDetail}`;
            } else {
                clientMessage = 'It seems like the AI service is not working right now or is temporarily overwhelmed. Please wait a few moments and try again! 📚';
            }
        }

        if (res.headersSent && !res.writableEnded) {
            // Stream a structured error so the frontend can optionally show provider details
            const payload = (process.env.SHOW_AI_ERRORS === 'true')
                ? { userMessage: clientMessage, providerDetail }
                : { userMessage: clientMessage };
            streamEvent(res, { type: 'error', content: payload });
            res.end();
        } else if (!res.headersSent) {
            res.status(status).json({
                message: clientMessage,
                error: (process.env.NODE_ENV === 'development' && !isAIServiceError) ? error.stack : undefined,
                aiError: (process.env.SHOW_AI_ERRORS === 'true') ? providerDetail : undefined
            });
        }
    }
});

// ── Decomposed route mounts ───────────────────────────────────────────────────
const sessionRoutes = require('../sessionRoutes');
const knowledgeRoutes = require('../knowledgeRoutes');
const tutorRoutes = require('../tutorRoutes');

router.use('/', sessionRoutes);
router.use('/', knowledgeRoutes);
router.use('/', tutorRoutes);

// ── STT: proxy audio to Python Whisper service ────────────────────────────────
const multer = require('multer');
const axios  = require('axios');
const FormData = require('form-data');

const _sttUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max audio
}).single('audio');

router.post('/transcribe', authMiddleware, (req, res) => {
    _sttUpload(req, res, async (err) => {
        if (err) return res.status(400).json({ message: err.message });
        if (!req.file) return res.status(400).json({ message: 'No audio file provided.' });

        const pythonUrl = process.env.PYTHON_RAG_SERVICE_URL;
        if (!pythonUrl) return res.status(503).json({ message: 'STT service not configured.' });

        try {
            const form = new FormData();
            form.append('audio', req.file.buffer, {
                filename: req.file.originalname || 'recording.webm',
                contentType: req.file.mimetype || 'audio/webm',
            });

            const response = await axios.post(`${pythonUrl}/stt/transcribe`, form, {
                headers: form.getHeaders(),
                timeout: 30000,
            });

            res.json(response.data); // { text, language }
        } catch (e) {
            const msg = e.response?.data?.detail || e.message;
            log.error('STT', `Whisper transcription failed: ${msg}`);
            res.status(500).json({ message: `Transcription failed: ${msg}` });
        }
    });
});

module.exports = router;
