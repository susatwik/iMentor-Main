// server/routes/chat/handlers/tutorHandler.js
// Handles both Socratic tutor modes: General (no-course) and Course-Structured.
const ChatHistory = require('../../../models/ChatHistory');
const User = require('../../../models/User');
const {
    processTutorResponse,
    getTutorSessionState,
    setTutorSessionState,
    clearTutorSessionState,
    startSocraticSession,
    SOCRATIC_STATES,
    getSubtopicContext,
    resolveCurrentPosition,
    advanceToNextSubtopic,
    buildInitialLearningPath,
    saveUserProgress,
} = require('../../../services/socraticTutorService');
const tutorStateMachine = require('../../../services/tutorStateMachine');
const knowledgeStateService = require('../../../services/knowledgeStateService');
const socraticService = require('../../../services/socraticService');
const masteryService = require('../../../services/masteryService');
const axios = require('axios');
const { performWebSearch } = require('../../../services/webSearchService');
const socketService = require('../../../services/socketService');
const { triggerPeriodicAnalysis } = require('../../../middleware/contextualMemoryMiddleware');
const log = require('../../../utils/logger');
const { streamEvent, TUTOR_MODE_TYPES, emitTutorKnowledgeEvents } = require('../helpers');
const { computeTurnXp, awardTurnXpAsync, scheduleQualityBonusAsync } = require('../../../services/tutorXpService');
const tutorEnhancementService = require('../../../services/tutorEnhancementService');
const priorKnowledgeDetector = require('../../../services/priorKnowledgeDetector');
 
// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
 
function buildMessagesEach(userMessageForDb, aiMessageForDb, isAutoGreeting) {
    return isAutoGreeting ? [aiMessageForDb] : [userMessageForDb, aiMessageForDb];
}
 
function selectStartingCognitiveLevel(difficultyLevel, hasPriorKnowledge) {
    if (difficultyLevel === 'advanced') {
        log.info('TUTOR', `🚀 Advanced request → Starting at L3_CRITICAL`);
        return 'L3_CRITICAL';
    }
    if (difficultyLevel === 'beginner') {
        log.info('TUTOR', `📚 Beginner request → Starting at L1_CONCEPT`);
        return 'L1_CONCEPT';
    }
    if (hasPriorKnowledge && difficultyLevel === 'intermediate') {
        log.info('TUTOR', `⬆️  Prior knowledge detected → Starting at L2_APPLICATION`);
        return 'L2_APPLICATION';
    }
    return 'L1_CONCEPT';
}
 
// ─────────────────────────────────────────────────────────────────────────────
// GENERAL SOCRATIC (no course context)
// ─────────────────────────────────────────────────────────────────────────────
 
async function handleGeneral(res, ctx) {
    const {
        tutorMode, tutorModeType, query, sessionId, userId,
        llmConfig, chatSession, userMessageForDb, contextualMemory,
        isAutoGreeting,
    } = ctx;
 
    if (!tutorMode || tutorModeType !== TUTOR_MODE_TYPES.GENERAL_SOCRATIC) return false;
 
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
 
    const sendStatus = (status) => streamEvent(res, { type: 'status_update', content: status });
 
    let tutorState = await getTutorSessionState(sessionId);
 
    // ── Continue an active general Socratic loop ──────────────────────────────
    if (tutorState && (!tutorState.courseName || tutorState.courseName === 'General')) {
        sendStatus('Evaluating your understanding...');
 
        let smState = null;
        try {
            smState = await tutorStateMachine.getSessionState(sessionId);
            if (!smState) {
                smState = await tutorStateMachine.initializeSession(sessionId, {
                    topic: tutorState?.teachingUnit || tutorState?.moduleTitle || 'general'
                });
            }
        } catch (smErr) {
            log.warn('TUTOR', `State machine init failed (non-fatal): ${smErr.message}`);
        }
 
        let currentSmState = smState;
 
        // Enforce retry threshold
        try {
            const retryCheck = tutorEnhancementService.checkRetryThreshold(sessionId, 3);
            if (retryCheck && retryCheck.exceeded) {
                const hintInfo = await tutorEnhancementService.generateProgressiveHint(
                    tutorState?.teachingUnit || 'general',
                    tutorState?.teachingUnit || 'concept',
                    retryCheck.retryCount || 3,
                    query.trim()
                );
                tutorEnhancementService.recordSessionMetric(sessionId, 'hint_given', { level: hintInfo.level });
                const hintReply = {
                    sender: 'bot', role: 'model',
                    text: hintInfo.hint,
                    parts: [{ text: hintInfo.hint }],
                    timestamp: new Date(),
                    source_pipeline: 'tutor-retry-hint',
                    socraticState: SOCRATIC_STATES.HINT_GIVEN
                };
                streamEvent(res, { type: 'final_answer', content: hintReply });
                res.end();
                return true;
            }
        } catch (retryErr) {
            log.warn('TUTOR', `Retry threshold check failed: ${retryErr.message}`);
        }
 
        const tutorResult = await processTutorResponse(
            query.trim(),
            sessionId,
            llmConfig,
            (status) => sendStatus(status),
            (event) => {
                if (typeof event === 'string') {
                    streamEvent(res, { type: 'token', content: event });
                } else {
                    streamEvent(res, event);
                }
            }
        );
 
        if (tutorResult && tutorResult.classification) {
            try {
                const cls = tutorResult.classification;
                const statusStr = cls?.status || cls;
                let masteryData = null;
                const scoreMap = { CORRECT: 1.0, PARTIAL: 0.5, WRONG: 0, UNKNOWN: 0, INCOMPLETE: 0 };
                await tutorStateMachine.recordStudentResponse(sessionId, {
                    studentResponse: query.trim(),
                    classification: statusStr,
                    score: scoreMap[statusStr] ?? 0,
                    reasoning: cls?.reasoning || null
                });
                masteryData = await tutorStateMachine.checkMastery(sessionId);
                if (masteryData?.achieved) {
                    await tutorStateMachine.advanceLearningStep(sessionId);
                }
                const freshSmState = await tutorStateMachine.getSessionState(sessionId);
                currentSmState = freshSmState;
                if (freshSmState?.consecutiveCorrect >= 2) {
                    await tutorStateMachine.advanceCognitiveLevel(sessionId);
                    currentSmState = await tutorStateMachine.getSessionState(sessionId);
                    await tutorStateMachine.resetHints(sessionId);
                } else if (statusStr === 'WRONG' || statusStr === 'UNKNOWN') {
                    await tutorStateMachine.incrementHints(sessionId);
                }
                const conceptName = tutorState?.teachingUnit || tutorState?.subtopicName || tutorState?.moduleTitle || tutorResult?.moduleTitle || 'general';
                const hintUsed = statusStr === 'WRONG' || statusStr === 'UNKNOWN';
                await emitTutorKnowledgeEvents({ userId, sessionId, statusStr, conceptName, hintUsed, mastered: !!masteryData?.achieved });
            } catch (smUpdateErr) {
                log.warn('TUTOR', `State machine update failed (non-fatal): ${smUpdateErr.message}`);
            }
        }
 
        const _genCls = (() => { const c = tutorResult?.classification; return typeof c === 'object' ? (c?.status || 'UNKNOWN') : (c || 'UNKNOWN'); })();
        const _genCogLvl = currentSmState?.cognitiveLevelName || currentSmState?.cognitiveLevel || tutorState?.cognitiveLevel || 'L1_CONCEPT';
        const _genHints = tutorState?.hintsGiven || 0;
        const genXpResult = tutorResult ? computeTurnXp(_genCls, _genCogLvl, _genHints) : null;
        const _masteryProgress = masteryService.calculateMasteryProgress(currentSmState, _genCls);
 
        if (!tutorResult) {
            const fallbackReply = {
                sender: 'bot', role: 'model',
                text: "Let's restart this Socratic thread. What concept do you want to understand first?",
                parts: [{ text: "Let's restart this Socratic thread. What concept do you want to understand first?" }],
                timestamp: new Date(),
                source_pipeline: 'tutor-general-fallback',
                criticalThinkingCues: []
            };
            streamEvent(res, { type: 'final_answer', content: fallbackReply });
            res.end();
            setImmediate(async () => {
                try {
                    const _fallbackAiMsg = { role: 'model', parts: [{ text: fallbackReply.text }], timestamp: new Date(), source_pipeline: 'tutor-general-fallback' };
                    await ChatHistory.findOneAndUpdate(
                        { sessionId, userId },
                        {
                            $push: { messages: { $each: buildMessagesEach(userMessageForDb, _fallbackAiMsg, isAutoGreeting) } },
                            $set: { isTutorMode: true, tutorModeType: TUTOR_MODE_TYPES.GENERAL_SOCRATIC, updatedAt: new Date() }
                        },
                        { upsert: true }
                    );
                    const messageCount = (chatSession?.messages?.length || 0) + 2;
                    triggerPeriodicAnalysis(sessionId, userId, messageCount, llmConfig);
                } catch (err) {
                    log.error('TUTOR', `Deferred DB write failed: ${err.message}`);
                }
            });
            return true;
        }
 
        // ── Mastery / prior knowledge skip ────────────────────────────────────
        if (tutorResult.isMastered) {
            const masteredUnit = tutorState.teachingUnit || tutorState.moduleTitle || 'this concept';
            await clearTutorSessionState(sessionId);
 
            const masteryText = tutorResult.pedagogicalMove === 'SKIP_SUBTOPIC'
                ? tutorResult.followUpQuestion
                : `Great work — you've shown strong understanding of **${masteredUnit}**.\n\nDo you want to go one level deeper, apply it to a real example, or switch topics? Which option do you choose and why?`;
 
            const masteryReply = {
                sender: 'bot', role: 'model',
                text: masteryText, parts: [{ text: masteryText }],
                timestamp: new Date(),
                source_pipeline: 'tutor-general-mastery',
                socraticState: SOCRATIC_STATES.MASTERY_ACHIEVED,
                thinking: `General Socratic mastery achieved for ${masteredUnit}`,
                criticalThinkingCues: []
            };
            streamEvent(res, { type: 'final_answer', content: masteryReply });
            res.end();
            setImmediate(async () => {
                try {
                    const _masteryAiMsg = { role: 'model', parts: [{ text: masteryText }], timestamp: new Date(), source_pipeline: 'tutor-general-mastery' };
                    await ChatHistory.findOneAndUpdate(
                        { sessionId, userId },
                        {
                            $push: { messages: { $each: buildMessagesEach(userMessageForDb, _masteryAiMsg, isAutoGreeting) } },
                            $set: { isTutorMode: true, tutorModeType: TUTOR_MODE_TYPES.GENERAL_SOCRATIC, updatedAt: new Date() }
                        },
                        { upsert: true }
                    );
                    const messageCount = (chatSession?.messages?.length || 0) + 2;
                    triggerPeriodicAnalysis(sessionId, userId, messageCount, llmConfig);
                } catch (err) {
                    log.error('TUTOR', `Deferred DB write failed: ${err.message}`);
                }
            });
            return true;
        }
 
        const socraticReply = {
            sender: 'bot', role: 'model',
            text: tutorResult.followUpQuestion,
            parts: [{ text: tutorResult.followUpQuestion }],
            timestamp: new Date(),
            source_pipeline: `tutor-general-${(tutorResult.pedagogicalMove || 'socratic').toLowerCase()}`,
            socraticState: tutorResult.socraticState,
            thinking: `General Socratic mode. Move: ${tutorResult.pedagogicalMove}. ${tutorResult.reasoning || ''}`,
            criticalThinkingCues: [],
            masteryProgress: tutorResult.masteryProgress || _masteryProgress || null,
            steps: tutorResult.steps || [],
            confidenceScore: 85,
            xpDelta: genXpResult
        };
        streamEvent(res, { type: 'final_answer', content: socraticReply });
        res.end();
 
        setImmediate(async () => {
            try {
                const _socraticAiMsg = { role: 'model', parts: [{ text: tutorResult.followUpQuestion }], timestamp: new Date(), source_pipeline: socraticReply.source_pipeline };
                await ChatHistory.findOneAndUpdate(
                    { sessionId, userId },
                    {
                        $push: { messages: { $each: buildMessagesEach(userMessageForDb, _socraticAiMsg, isAutoGreeting) } },
                        $set: { isTutorMode: true, tutorModeType: TUTOR_MODE_TYPES.GENERAL_SOCRATIC, updatedAt: new Date() }
                    },
                    { upsert: true }
                );
                const messageCount = (chatSession?.messages?.length || 0) + 2;
                triggerPeriodicAnalysis(sessionId, userId, messageCount, llmConfig);
            } catch (err) {
                log.error('TUTOR', `Deferred DB write failed: ${err.message}`);
            }
            if (genXpResult) {
                const _gConceptName = tutorState?.teachingUnit || tutorState?.moduleTitle || 'general';
                awardTurnXpAsync(userId, genXpResult.xp, _gConceptName, `tutor_${_genCls.toLowerCase()}`);
                scheduleQualityBonusAsync(userId, query.trim(), tutorResult.followUpQuestion, _gConceptName, llmConfig);
            }
        });
 
        return true;
    }
 
    // ── Initialize a new general Socratic thread ──────────────────────────────
    sendStatus('Preparing Socratic session...');
 
    const rawQuery = query.trim();
 
    // ── Detect prior knowledge and difficulty intent ──────────────────────────
    const priorKnowledgeAnalysis = priorKnowledgeDetector.detectPriorKnowledge(rawQuery);
    const { hasPriorKnowledge, masteredTopics, difficultyLevel, signals } = priorKnowledgeAnalysis;
 
    if (hasPriorKnowledge) {
        log.info('TUTOR', `Prior Knowledge Profile:`);
        log.info('TUTOR', `  Topics: ${masteredTopics.join(', ') || 'N/A'}`);
        log.info('TUTOR', `  Difficulty: ${difficultyLevel}`);
        log.info('TUTOR', `  Confidence: ${Math.round(priorKnowledgeAnalysis.confidence * 100)}%`);
    } else if (signals.advancedRequest || signals.beginnerRequest) {
        log.info('TUTOR', `Difficulty Intent: ${difficultyLevel}`);
    }
 
    // ── Extract teaching unit ─────────────────────────────────────────────────
    let teachingUnit = rawQuery
        .replace(/^(tell me about|explain|what is|what us|how does|teach me|i want to learn about|describe|what's|who is|let'?s?\s*(start|go|begin|learn)\s*(with)?|start\s*(with)?|begin\s*(with)?)\s*/i, '')
        .replace(/\?$/, '')
        .trim();
    teachingUnit = teachingUnit
        ? teachingUnit.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ')
        : 'General AI Concepts';
 
    // ── SKIP: prior knowledge detected — jump straight to L2 question ─────────
    if (hasPriorKnowledge && rawQuery.trim().length > 20) {
        log.info('TUTOR', `⚡ Prior knowledge on init — skipping intro for "${teachingUnit}"`);
 
        const skipMsg = `Great — it's clear you already know **${teachingUnit}** well! ` +
            `No need to go over the basics. Let's jump to something more challenging. 🚀\n\n` +
            `Here's a deeper question: Can you think of a real-world scenario where **${teachingUnit}** ` +
            `would be the wrong choice, and what you would use instead?`;
 
        const generalState = {
            moduleTitle: teachingUnit,
            topic: teachingUnit,
            teachingUnit,
            teachingUnitType: 'general',
            courseName: 'General',
            lastQuestion: skipMsg,
            turnCount: 0,
            startedAt: new Date().toISOString(),
            socraticState: SOCRATIC_STATES.L2_APPLICATION,
            masteryScore: 2.0,
            cognitiveLevel: 'L2_APPLICATION',
            consecutiveWrong: 0,
            hintsGiven: 0,
            history: [],
            consecutiveCorrect: 0,
            learningPath: await buildInitialLearningPath('General', { subtopicName: teachingUnit }),
            priorKnowledgeAnalysis: { hasPriorKnowledge, masteredTopics, difficultyLevel, signals }
        };
        await setTutorSessionState(sessionId, generalState);
 
        const skipReply = {
            sender: 'bot', role: 'model',
            text: skipMsg,
            parts: [{ text: skipMsg }],
            timestamp: new Date(),
            source_pipeline: 'tutor-prior-knowledge-skip',
            socraticState: SOCRATIC_STATES.L2_APPLICATION,
            thinking: `Prior knowledge detected. Skipped intro, starting at L2.`,
            criticalThinkingCues: []
        };
 
        const aiMsgForDb = {
            role: 'model',
            parts: [{ text: skipMsg }],
            timestamp: new Date(),
            source_pipeline: 'tutor-prior-knowledge-skip'
        };
        await ChatHistory.findOneAndUpdate(
            { sessionId, userId },
            {
                $push: { messages: { $each: buildMessagesEach(userMessageForDb, aiMsgForDb, isAutoGreeting) } },
                $set: { isTutorMode: true, tutorModeType: TUTOR_MODE_TYPES.GENERAL_SOCRATIC, updatedAt: new Date() }
            },
            { upsert: true }
        );
 
        streamEvent(res, { type: 'final_answer', content: skipReply });
        res.end();
        return true;
    }
 
    // ── Normal flow: generate intro via LLM ───────────────────────────────────
    const contextForIntro = socraticService.buildPersonalizationContext(contextualMemory, query);
 
    let initialResponse = '';
    try {
        initialResponse = await startSocraticSession(
            teachingUnit,
            contextForIntro,
            llmConfig,
            null,
            (event) => {
                if (typeof event === 'string') {
                    streamEvent(res, { type: 'token', content: event });
                } else {
                    streamEvent(res, event);
                }
            }
        );
    } catch (err) {
        log.warn('TUTOR', `General Socratic init failed: ${err.message}`);
        initialResponse = `Let's explore **${teachingUnit}** together.\n\nTo begin, what do you already believe about this topic?`;
    }
 
    const startingCognitiveLevel = selectStartingCognitiveLevel(difficultyLevel, hasPriorKnowledge);
 
    const generalState = {
        moduleTitle: teachingUnit,
        topic: teachingUnit,
        teachingUnit,
        teachingUnitType: 'general',
        courseName: 'General',
        lastQuestion: initialResponse,
        turnCount: 0,
        startedAt: new Date().toISOString(),
        socraticState: SOCRATIC_STATES.INTRODUCTION,
        masteryScore: 0,
        cognitiveLevel: startingCognitiveLevel,
        consecutiveWrong: 0,
        hintsGiven: 0,
        history: [],
        consecutiveCorrect: 0,
        learningPath: await buildInitialLearningPath('General', { subtopicName: teachingUnit }),
        priorKnowledgeAnalysis: { hasPriorKnowledge, masteredTopics, difficultyLevel, signals }
    };
    await setTutorSessionState(sessionId, generalState);
 
    const introReply = {
        sender: 'bot', role: 'model',
        text: initialResponse, parts: [{ text: initialResponse }],
        timestamp: new Date(),
        source_pipeline: 'tutor-general-introduction',
        socraticState: SOCRATIC_STATES.INTRODUCTION,
        thinking: `General Socratic tutor initialized. Teaching unit: ${teachingUnit}`,
        criticalThinkingCues: []
    };
 
    const _genIntroAiMsg = {
        role: 'model', parts: [{ text: initialResponse }],
        timestamp: new Date(), source_pipeline: 'tutor-general-introduction'
    };
    await ChatHistory.findOneAndUpdate(
        { sessionId, userId },
        {
            $push: { messages: { $each: buildMessagesEach(userMessageForDb, _genIntroAiMsg, isAutoGreeting) } },
            $set: { isTutorMode: true, tutorModeType: TUTOR_MODE_TYPES.GENERAL_SOCRATIC, courseName: 'General', updatedAt: new Date() }
        },
        { upsert: true }
    );
 
    const messageCount = (chatSession?.messages?.length || 0) + 2;
    triggerPeriodicAnalysis(sessionId, userId, messageCount, llmConfig);
 
    streamEvent(res, { type: 'final_answer', content: introReply });
    res.end();
    return true;
}
 
// ─────────────────────────────────────────────────────────────────────────────
// COURSE-STRUCTURED SOCRATIC
// ─────────────────────────────────────────────────────────────────────────────
 
async function handleStructured(res, ctx) {
    const {
        tutorMode, tutorModeType, query, sessionId, userId,
        llmConfig, chatSession, userMessageForDb, contextualMemory,
        documentContextName, currentModulePathId, user: reqUser,
        isAutoGreeting,
    } = ctx;
 
    if (!tutorMode || tutorModeType !== TUTOR_MODE_TYPES.COURSE_STRUCTURED) return false;
 
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
 
    const sendStatus = (status) => streamEvent(res, { type: 'status_update', content: status });
 
    let tutorState = await getTutorSessionState(sessionId);
 
    // ── Topic shift detection ─────────────────────────────────────────────────
    if (tutorState) {
        const rawQuery = query.trim();
        const shiftKeywords = /^(tell me about|explain|what is|what us|how does|teach me|i want to learn about|describe|what's|who is|let'?s?\s*(start|go|begin|learn)\s*(with)?|start\s*(with)?|begin\s*(with)?)\s+/i;
        if (shiftKeywords.test(rawQuery)) {
            let extractedTopic = rawQuery.replace(shiftKeywords, '').replace(/\?$/, '').trim();
            if (extractedTopic && extractedTopic.length > 2 && extractedTopic.length < 50) {
                const currentUnit = (tutorState.teachingUnit || '').toLowerCase();
                const pivotTopic = extractedTopic.toLowerCase();
                const isRelated = currentUnit.includes(pivotTopic) || pivotTopic.includes(currentUnit) ||
                    (tutorState.moduleName && tutorState.moduleName.toLowerCase().includes(pivotTopic));
                if (!isRelated) {
                    log.info('TUTOR', `Topic shift detected: "${currentUnit}" -> "${extractedTopic}". Resetting.`);
                    await clearTutorSessionState(sessionId);
                    tutorState = null;
                }
            }
        }
    }
 
    // ── Continue an existing course lesson ────────────────────────────────────
    if (tutorState) {
        log.info('TUTOR', `Continuing lesson "${tutorState.teachingUnit}" (Turn ${tutorState.turnCount})`);
 
        let smState = null;
        try {
            smState = await tutorStateMachine.getSessionState(sessionId);
            if (!smState) {
                smState = await tutorStateMachine.initializeSession(sessionId, {
                    moduleTitle: tutorState?.moduleTitle,
                    topic: tutorState?.topicName || tutorState?.teachingUnit,
                    subtopic: tutorState?.subtopicName || tutorState?.teachingUnit,
                    moduleId: tutorState?.moduleId,
                    topicId: tutorState?.topicId,
                    subtopicId: tutorState?.subtopicId
                });
            }
        } catch (smErr) {
            log.warn('TUTOR', `State machine init failed (non-fatal): ${smErr.message}`);
        }
 
        let currentSmState = smState;
 
        let graphFacts = '';
        try {
            const PYTHON_RAG_SERVICE_URL = process.env.PYTHON_RAG_SERVICE_URL || 'http://localhost:2001';
            const graphRes = await axios.post(
                `${PYTHON_RAG_SERVICE_URL}/graph/search`,
                { query: query.trim(), user_id: userId, document_context: tutorState?.courseName || null },
                { timeout: 3000 }
            );
            if (graphRes.data?.facts) graphFacts = graphRes.data.facts;
        } catch (_gErr) {
            log.debug('TUTOR', `Graph search skipped (non-fatal): ${_gErr.message}`);
        }
 
        const augmentedQuery = graphFacts ? `${query.trim()}\n\n[Graph context: ${graphFacts}]` : query.trim();
 
        const tutorResult = await processTutorResponse(
            augmentedQuery,
            sessionId,
            llmConfig,
            sendStatus,
            (event) => {
                if (typeof event === 'string') {
                    streamEvent(res, { type: 'token', content: event });
                } else {
                    streamEvent(res, event);
                }
            }
        );
 
        if (tutorResult && tutorResult.classification) {
            try {
                const cls = tutorResult.classification;
                const statusStr = cls?.status || cls;
                let masteryData = null;
                const scoreMap = { CORRECT: 1.0, PARTIAL: 0.5, WRONG: 0, UNKNOWN: 0, INCOMPLETE: 0 };
                await tutorStateMachine.recordStudentResponse(sessionId, {
                    studentResponse: query.trim(),
                    classification: statusStr,
                    score: scoreMap[statusStr] ?? 0,
                    reasoning: cls?.reasoning || null
                });
                masteryData = await tutorStateMachine.checkMastery(sessionId);
                if (masteryData?.achieved) await tutorStateMachine.advanceLearningStep(sessionId);
                const freshSmState = await tutorStateMachine.getSessionState(sessionId);
                currentSmState = freshSmState;
                if (freshSmState?.consecutiveCorrect >= 2) {
                    await tutorStateMachine.advanceCognitiveLevel(sessionId);
                    currentSmState = await tutorStateMachine.getSessionState(sessionId);
                    await tutorStateMachine.resetHints(sessionId);
                } else if (statusStr === 'WRONG' || statusStr === 'UNKNOWN') {
                    await tutorStateMachine.incrementHints(sessionId);
                }
                const conceptName = tutorState?.teachingUnit || tutorState?.subtopicName || tutorState?.moduleTitle || tutorResult?.moduleTitle || 'general';
                const hintUsed = statusStr === 'WRONG' || statusStr === 'UNKNOWN';
                await emitTutorKnowledgeEvents({ userId, sessionId, statusStr, conceptName, hintUsed, mastered: !!masteryData?.achieved });
            } catch (smUpdateErr) {
                log.warn('TUTOR', `State machine update failed (non-fatal): ${smUpdateErr.message}`);
            }
        }
 
        const _strCls = (() => { const c = tutorResult?.classification; return typeof c === 'object' ? (c?.status || 'UNKNOWN') : (c || 'UNKNOWN'); })();
        const _strCogLvl = currentSmState?.cognitiveLevelName || currentSmState?.cognitiveLevel || tutorState?.cognitiveLevel || 'L1_CONCEPT';
        const _strHints = tutorState?.hintsGiven || 0;
        const xpResult = tutorResult ? computeTurnXp(_strCls, _strCogLvl, _strHints, !!tutorResult.isMastered) : null;
        const _masteryProgress = masteryService.calculateMasteryProgress(currentSmState, _strCls);
 
        if (!tutorResult) {
            log.error('TUTOR', 'Failed to generate tutor response - LLM service unavailable');
            const errorReply = {
                sender: 'bot', role: 'model',
                text: "I'm having trouble connecting to the AI service right now. Please try again in a moment.",
                parts: [{ text: "I'm having trouble connecting to the AI service right now. Please try again in a moment." }],
                timestamp: new Date(),
                source_pipeline: 'tutor-error-recovery',
                confidenceScore: 0,
                isError: true
            };
            streamEvent(res, { type: 'final_answer', content: errorReply });
            res.end();
            return true;
        }
 
        // ── Mastery handling ──────────────────────────────────────────────────
        if (tutorResult.isMastered) {
            log.success('SUCCESS', `Mastery achieved for: "${tutorState.teachingUnit || tutorResult.moduleTitle}"`);
 
            let finalReplyText = tutorResult.followUpQuestion;
            let nextTopicState = null;
            let advanceResult = null;
            let completedTopics = [];
 
            const courseName = tutorState.courseName || documentContextName;
            if (courseName && courseName !== 'General') {
                let completedSubtopics = [];
 
                try {
                    const currentUser = await User.findById(reqUser._id);
                    const userProgress = currentUser?.curriculumProgress?.get(courseName);
                    completedSubtopics = userProgress?.completedSubtopics || [];
                    completedTopics = userProgress?.completedTopics || [];
                } catch (e) {
                    log.warn('TUTOR', `Progress fetch failed: ${e.message}`);
                }
 
                const currentPosition = {
                    moduleIndex: tutorState.moduleIndex || 0,
                    topicIndex: tutorState.topicIndex || 0,
                    subtopicIndex: tutorState.subtopicIndex || 0,
                    subtopicId: tutorState.subtopicId,
                    subtopicName: tutorState.subtopicName,
                    topicId: tutorState.topicId,
                    topicName: tutorState.topicName,
                    moduleName: tutorState.moduleName,
                    teachingUnitId: tutorState.subtopicId || tutorState.topicId,
                    teachingUnitType: tutorState.teachingUnitType || 'subtopic',
                    isLastInTopic: tutorState.isLastInTopic || false,
                    isLastInModule: tutorState.isLastInModule || false
                };
 
                advanceResult = await advanceToNextSubtopic(courseName, currentPosition, completedSubtopics, completedTopics);
 
                if (advanceResult.completedSubtopics.length > completedSubtopics.length || advanceResult.topicJustCompleted || advanceResult.moduleJustCompleted) {
                    try {
                        const userToUpdate = await User.findById(reqUser._id);
                        if (userToUpdate) {
                            if (!userToUpdate.curriculumProgress) userToUpdate.curriculumProgress = new Map();
                            const existingProgress = userToUpdate.curriculumProgress.get(courseName) || {};
                            userToUpdate.curriculumProgress.set(courseName, {
                                completedSubtopics: advanceResult.completedSubtopics,
                                completedTopics: advanceResult.completedTopics,
                                completedModules: [
                                    ...new Set([
                                        ...(existingProgress.completedModules || []),
                                        ...(advanceResult.moduleJustCompleted && tutorState.moduleId ? [tutorState.moduleId] : [])
                                    ])
                                ],
                                lastActiveDate: new Date()
                            });
                            await userToUpdate.save();
                            log.info('DB', `Progress updated for ${courseName}.`);
                        }
                    } catch (updateErr) {
                        log.error('DB', `Failed to update progress: ${updateErr.message}`);
                    }
                }
 
                if (advanceResult.nextPosition && !advanceResult.nextPosition.isComplete) {
                    const nextUnit = advanceResult.nextPosition.teachingUnit;
                    log.info('TUTOR', `Advancing to next unit: "${nextUnit}"`);
                    sendStatus(`Preparing next lesson: ${nextUnit}...`);
 
                    let nextRagContext = '';
                    try {
                        const nextContextData = await getSubtopicContext(courseName, advanceResult.nextPosition.subtopicId, advanceResult.nextPosition.topicId);
                        if (nextContextData?.qdrant_chunks && nextContextData.qdrant_chunks.length > 0) {
                            nextRagContext = nextContextData.qdrant_chunks.map(chunk => chunk.text).join('\n\n').slice(0, 1500);
                        } else {
                            const searchResult = await performWebSearch(`${nextUnit} concept explanation`);
                            if (searchResult && searchResult.toolOutput) {
                                nextRagContext = `[WEB SEARCH CONTEXT]:\n${searchResult.toolOutput.slice(0, 1500)}`;
                            }
                        }
                    } catch (ctxErr) {
                        log.warn('TUTOR', `Next unit context failed: ${ctxErr.message}`);
                    }
 
                    let nextEnhancedContext = nextRagContext;
                    const nextMemoryContext = socraticService.buildPersonalizationContext(contextualMemory, query);
                    if (nextMemoryContext) nextEnhancedContext += `\n\n[STUDENT PROFILE]:\n${nextMemoryContext}`;
 
                    const nextIntro = await startSocraticSession(nextUnit, nextEnhancedContext, llmConfig, advanceResult.nextPosition);
 
                    let transitionParts = [];
                    transitionParts.push(`Great job! You've mastered **${tutorState.teachingUnit || tutorResult.moduleTitle}**.`);
                    if (advanceResult.topicJustCompleted) {
                        transitionParts.push(`We've also finished the whole topic on **${advanceResult.topicCompletedName}**.`);
                    }
                    transitionParts.push(`Let's move on to the next idea:\n\n${nextIntro}`);
                    finalReplyText = transitionParts.join(' ');
 
                    await clearTutorSessionState(sessionId);
                    nextTopicState = {
                        moduleId: advanceResult.nextPosition.moduleId,
                        moduleName: advanceResult.nextPosition.moduleName,
                        moduleIndex: advanceResult.nextPosition.moduleIndex,
                        topicId: advanceResult.nextPosition.topicId,
                        topicName: advanceResult.nextPosition.topicName,
                        topicIndex: advanceResult.nextPosition.topicIndex,
                        subtopicId: advanceResult.nextPosition.subtopicId,
                        subtopicName: advanceResult.nextPosition.subtopicName,
                        subtopicIndex: advanceResult.nextPosition.subtopicIndex,
                        teachingUnit: nextUnit,
                        teachingUnitType: advanceResult.nextPosition.teachingUnitType,
                        isLastInTopic: advanceResult.nextPosition.isLastInTopic,
                        isLastInModule: advanceResult.nextPosition.isLastInModule,
                        courseName,
                        moduleTitle: nextUnit,
                        lastQuestion: nextIntro,
                        turnCount: 0,
                        startedAt: new Date().toISOString(),
                        socraticState: SOCRATIC_STATES.INTRODUCTION,
                        masteryScore: 0,
                        cognitiveLevel: currentSmState?.cognitiveLevelName || currentSmState?.cognitiveLevel || 'L1_CONCEPT',
                        history: [],
                        consecutiveUnderstands: 0
                    };
                    await setTutorSessionState(sessionId, nextTopicState);
                } else if (advanceResult.nextPosition?.isComplete) {
                    await clearTutorSessionState(sessionId);
                    finalReplyText = `🎉 **Congratulations!**\n\nYou've mastered **${tutorState.teachingUnit || tutorResult.moduleTitle}** and completed the entire **${courseName}** curriculum!\n\nWould you like to:\n\n- **Review** any specific topic\n- Start a **new course**\n- Take a **final assessment**`;
                } else {
                    await clearTutorSessionState(sessionId);
                    finalReplyText = `🎉 **Mastery Achieved!** You've completed **${tutorState.teachingUnit || tutorResult.moduleTitle}**.\n\nWhat would you like to learn next?`;
                }
            } else {
                await clearTutorSessionState(sessionId);
            }
 
            const masteryReply = {
                sender: 'bot', role: 'model',
                text: finalReplyText, parts: [{ text: finalReplyText }],
                timestamp: new Date(),
                source_pipeline: 'tutor-mastery',
                socraticState: nextTopicState ? SOCRATIC_STATES.INTRODUCTION : tutorResult.socraticState,
                thinking: `Mastery achieved for "${tutorResult.moduleTitle}". Auto-advanced: ${nextTopicState ? 'Yes' : 'No'}.`,
                criticalThinkingCues: [],
                xpDelta: xpResult
            };
 
            const aiMessageForDb = {
                role: 'model', parts: [{ text: finalReplyText }],
                timestamp: new Date(), source_pipeline: 'tutor-mastery'
            };
            await ChatHistory.findOneAndUpdate(
                { sessionId, userId },
                {
                    $push: { messages: { $each: buildMessagesEach(userMessageForDb, aiMessageForDb, isAutoGreeting), $slice: -100 } },
                    $set: { isTutorMode: true, tutorModeType: 'structured', updatedAt: new Date() }
                },
                { upsert: true }
            );
 
            const messageCount = (chatSession?.messages?.length || 0) + 2;
            triggerPeriodicAnalysis(sessionId, userId, messageCount, llmConfig);
 
            let dbCompletedModules = [];
            try {
                const freshUser = await User.findById(reqUser._id).select('curriculumProgress');
                dbCompletedModules = freshUser?.curriculumProgress?.get(courseName)?.completedModules || [];
            } catch (_) {}
 
            const progressUpdate = {
                type: 'progress_update',
                content: {
                    courseName,
                    masteredSubtopicId: tutorState.subtopicId,
                    masteredSubtopicName: tutorState.subtopicName || tutorState.teachingUnit,
                    masteredTopicId: advanceResult?.topicJustCompleted ? tutorState.topicId : null,
                    masteredTopicName: advanceResult?.topicCompletedName || null,
                    masteredModuleId: advanceResult?.moduleJustCompleted ? tutorState.moduleId : null,
                    masteredModuleName: advanceResult?.moduleCompletedName || null,
                    completedSubtopics: advanceResult?.completedSubtopics || [],
                    completedTopics: advanceResult?.completedTopics || [],
                    completedModules: dbCompletedModules,
                    currentPosition: nextTopicState ? {
                        subtopicId: nextTopicState.subtopicId,
                        subtopicName: nextTopicState.subtopicName,
                        topicId: nextTopicState.topicId,
                        topicName: nextTopicState.topicName,
                        moduleId: nextTopicState.moduleId,
                        moduleName: nextTopicState.moduleName,
                        teachingUnit: nextTopicState.teachingUnit
                    } : null,
                    isCourseComplete: advanceResult?.nextPosition?.isComplete || false
                }
            };
            streamEvent(res, progressUpdate);
 
            masteryReply.currentPosition = progressUpdate.content.currentPosition;
            masteryReply.progressUpdate = progressUpdate.content;
 
            streamEvent(res, { type: 'final_answer', content: masteryReply });
            res.end();
 
            setImmediate(() => {
                if (xpResult) {
                    const _mConceptName = tutorState?.teachingUnit || tutorState?.subtopicName || 'general';
                    awardTurnXpAsync(userId, xpResult.xp, _mConceptName, 'tutor_mastery');
                    scheduleQualityBonusAsync(userId, query.trim(), finalReplyText, _mConceptName, llmConfig);
                }
            });
 
            return true;
        }
        // ── End mastery handling ──────────────────────────────────────────────
 
        log.success('TUTOR', `Follow-up generated (Move: ${tutorResult.pedagogicalMove})`);
 
        const socraticReply = {
            sender: 'bot', role: 'model',
            text: tutorResult.followUpQuestion,
            parts: [{ text: tutorResult.followUpQuestion }],
            timestamp: new Date(),
            source_pipeline: `tutor-${tutorResult.pedagogicalMove?.toLowerCase() || 'socratic'}`,
            socraticState: tutorResult.socraticState,
            thinking: `Classification: ${tutorResult.classification}. Move: ${tutorResult.pedagogicalMove}. ${tutorResult.reasoning || ''}`,
            criticalThinkingCues: [],
            masteryProgress: tutorResult.masteryProgress || _masteryProgress || null,
            steps: tutorResult.steps || [],
            confidenceScore: 85,
            xpDelta: xpResult,
            currentPosition: {
                subtopicId: tutorState.subtopicId,
                subtopicName: tutorState.subtopicName,
                topicId: tutorState.topicId,
                topicName: tutorState.topicName,
                moduleId: tutorState.moduleId,
                moduleName: tutorState.moduleName,
                teachingUnit: tutorState.teachingUnit,
                courseName: tutorState.courseName
            }
        };
 
        const aiMessageForDb = {
            role: 'model', parts: [{ text: tutorResult.followUpQuestion }],
            timestamp: new Date(), source_pipeline: socraticReply.source_pipeline
        };
        await ChatHistory.findOneAndUpdate(
            { sessionId, userId },
            {
                $push: { messages: { $each: buildMessagesEach(userMessageForDb, aiMessageForDb, isAutoGreeting), $slice: -100 } },
                $set: { isTutorMode: true, tutorModeType: 'structured', updatedAt: new Date() }
            },
            { upsert: true }
        );
 
        const messageCount = (chatSession?.messages?.length || 0) + 2;
        triggerPeriodicAnalysis(sessionId, userId, messageCount, llmConfig);
 
        streamEvent(res, { type: 'final_answer', content: socraticReply });
        res.end();
 
        setImmediate(() => {
            if (xpResult) {
                const _sConceptName = tutorState?.teachingUnit || tutorState?.subtopicName || 'general';
                awardTurnXpAsync(userId, xpResult.xp, _sConceptName, `tutor_${_strCls.toLowerCase()}`);
                scheduleQualityBonusAsync(userId, query.trim(), tutorResult.followUpQuestion, _sConceptName, llmConfig);
            }
        });
 
        return true;
    }
 
    // ── Auto-initialize new tutor session (curriculum-driven) ─────────────────
    const courseName = documentContextName || 'General';
    log.info('TUTOR', `Initializing new tutor session for ${courseName}`);
    sendStatus('Resolving curriculum position…');
 
    let completedSubtopics = [];
    let completedTopics = [];
    let completedModules = [];
 
    if (courseName !== 'General' && reqUser) {
        try {
            const currentUser = await User.findById(reqUser._id);
            const userProgress = currentUser?.curriculumProgress?.get(courseName);
            completedSubtopics = userProgress?.completedSubtopics || [];
            completedTopics = userProgress?.completedTopics || [];
            completedModules = userProgress?.completedModules || [];
        } catch (e) {
            log.warn('TUTOR', `Pre-init progress fetch failed: ${e.message}`);
        }
    }
 
    let position = null;
    let teachingUnit = '';
 
    if (courseName !== 'General') {
        try {
            position = await resolveCurrentPosition(courseName, completedSubtopics, completedTopics, currentModulePathId);
            if (position && position.teachingUnit) {
                teachingUnit = position.teachingUnit;
                log.info('TUTOR', `Lesson Plan: "${teachingUnit}"`);
            } else if (position?.isComplete) {
                const completionReply = {
                    sender: 'bot', role: 'model',
                    text: `🎉 **Congratulations!** You have completed the entire **${courseName}** ${currentModulePathId ? 'module' : 'curriculum'}!\n\nWould you like to:\n- **Review** any topic\n- Start a **different course**\n- Do some **practice questions**`,
                    parts: [{ text: `🎉 **Congratulations!** You have completed the entire **${courseName}** ${currentModulePathId ? 'module' : 'curriculum'}!` }],
                    timestamp: new Date(),
                    source_pipeline: 'tutor-completion',
                    socraticState: SOCRATIC_STATES.MASTERY_ACHIEVED,
                    thinking: 'All curriculum items mastered.',
                    criticalThinkingCues: []
                };
                const aiMessageForDb = { role: 'model', parts: [{ text: completionReply.text }], timestamp: new Date(), source_pipeline: 'tutor-completion' };
                await ChatHistory.findOneAndUpdate(
                    { sessionId, userId },
                    { $push: { messages: { $each: buildMessagesEach(userMessageForDb, aiMessageForDb, isAutoGreeting), $slice: -100 } } },
                    { upsert: true }
                );
                streamEvent(res, { type: 'final_answer', content: completionReply });
                res.end();
                return true;
            }
        } catch (err) {
            if (err.code === 'CURRICULUM_EMPTY') {
                log.error('TUTOR', `Curriculum empty for '${courseName}': ${err.message}`);
                streamEvent(res, { type: 'error', content: err.message });
                res.end();
                return true;
            }
            log.warn('TUTOR', `Position resolution failed: ${err.message}`);
        }
    }
 
    if (!teachingUnit) {
        const rawQuery = query.trim();
        let extracted = rawQuery
            .replace(/^(tell me about|explain|what is|what us|how does|teach me|i want to learn about|describe|what's|who is|let'?s?\s*(start|go|begin|learn)\s*(with)?|start\s*(with)?|begin\s*(with)?)\s*/i, '')
            .replace(/\?$/, '')
            .trim();
        extracted = extracted.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
        teachingUnit = (extracted && extracted.length > 2) ? extracted : (courseName !== 'General' ? courseName : 'General Concepts');
    }
 
    sendStatus(`Preparing lesson on ${teachingUnit}…`);
 
    let ragContext = '';
    let contextualMemoryText = '';
    let strugglingTopics = [];
 
    try {
        sendStatus('Loading student profile...');
        const [memoryContext, struggles] = await Promise.all([
            knowledgeStateService.getContextualMemory(userId, teachingUnit),
            knowledgeStateService.getStrugglingTopics(userId)
        ]);
        contextualMemoryText = memoryContext || '';
        strugglingTopics = struggles || [];
    } catch (memErr) {
        log.error('SYSTEM', 'Contextual memory fetch failed', memErr);
    }
 
    try {
        sendStatus('Gathering knowledge from course curriculum...');
        const subtopicId = position?.subtopicId;
        const topicId = position?.topicId;
        const contextData = await getSubtopicContext(courseName, subtopicId, topicId);
        if (contextData && contextData.qdrant_chunks && contextData.qdrant_chunks.length > 0) {
            ragContext = contextData.qdrant_chunks.map(chunk => chunk.text).join('\n\n').slice(0, 1500);
        }
    } catch (e) {
        log.warn('SYSTEM', `Context fetch failed: ${e.message}`);
    }
 
    ragContext = ragContext || '';
 
    let initialResponse = '';
    try {
        sendStatus(`Generating Socratic introduction for ${teachingUnit}...`);
        let enhancedContext = ragContext;
        const topicContext = position?.topicName ? `(part of ${position.topicName})` : '';
        const moduleContext = position?.moduleName ? `in ${position.moduleName}` : '';
        if (topicContext) enhancedContext += `\n\nThis subtopic ${topicContext} ${moduleContext}.`;
        if (contextualMemoryText) enhancedContext += `\n\n[STUDENT PROFILE FOR PERSONALIZATION]:\n${contextualMemoryText}`;
        if (strugglingTopics.length > 0) {
            const strugglingNames = strugglingTopics.map(t => t.conceptName || t.name).join(', ');
            enhancedContext += `\n\n[STUDENT STRUGGLES]: The student has previously struggled with: ${strugglingNames}.`;
        }
 
        if (position?.topicId && courseName !== 'General') {
            try {
                const PYTHON_RAG_SERVICE_URL = process.env.PYTHON_RAG_SERVICE_URL || 'http://localhost:2001';
                const prereqRes = await axios.post(
                    `${PYTHON_RAG_SERVICE_URL}/course/${encodeURIComponent(courseName)}/topic/${encodeURIComponent(position.topicId)}/missing-prerequisites`,
                    { completed_subtopic_ids: completedSubtopics },
                    { timeout: 5000 }
                );
                const missing = prereqRes.data?.missing_prerequisites || [];
                if (missing.length > 0) {
                    const names = missing.map(p => p.name || p.id).join(', ');
                    enhancedContext += `\n\n[PREREQUISITE ALERT]: Student may benefit from reviewing: ${names}.`;
                }
            } catch (prereqErr) {
                log.warn('TUTOR', `Prereq check skipped (non-fatal): ${prereqErr.message}`);
            }
        }
 
        initialResponse = await startSocraticSession(
            teachingUnit,
            enhancedContext,
            llmConfig,
            position,
            (event) => {
                if (typeof event === 'string') {
                    streamEvent(res, { type: 'token', content: event });
                } else {
                    streamEvent(res, event);
                }
            }
        );
        log.success('TUTOR', `LLM generation complete for ${teachingUnit}`);
    } catch (err) {
        log.error('TUTOR', `Error in startSocraticSession: ${err.message}`, err);
        initialResponse = `Let's dive into **${teachingUnit}**!\n\nTo get started, can you tell me what you already know about this topic?`;
    }
 
    // ── Detect prior knowledge and difficulty intent ──────────────────────────
    const rawQuery = query.trim();
    const priorKnowledgeAnalysis = priorKnowledgeDetector.detectPriorKnowledge(rawQuery);
    const { hasPriorKnowledge: structHasPriorKnowledge, masteredTopics: structMasteredTopics, difficultyLevel: structDifficultyLevel, signals: structSignals } = priorKnowledgeAnalysis;
 
    if (priorKnowledgeAnalysis.hasPriorKnowledge) {
        log.info('TUTOR', `Prior Knowledge Profile (Structured):`);
        log.info('TUTOR', `  Topics: ${structMasteredTopics.join(', ') || 'N/A'}`);
        log.info('TUTOR', `  Difficulty: ${structDifficultyLevel}`);
        log.info('TUTOR', `  Confidence: ${Math.round(priorKnowledgeAnalysis.confidence * 100)}%`);
    }
 
    const startingCognitiveLevel = selectStartingCognitiveLevel(structDifficultyLevel, structHasPriorKnowledge);
 
    const newTutorState = {
        moduleId: position?.moduleId || null,
        moduleName: position?.moduleName || null,
        moduleIndex: position?.moduleIndex ?? 0,
        moduleTitle: teachingUnit,
        topicId: position?.topicId || null,
        topicName: position?.topicName || null,
        topicIndex: position?.topicIndex ?? 0,
        subtopicId: position?.subtopicId || null,
        subtopicName: position?.subtopicName || null,
        subtopicIndex: position?.subtopicIndex ?? 0,
        teachingUnit,
        teachingUnitType: position?.teachingUnitType || 'topic',
        courseName,
        isLastInTopic: position?.isLastInTopic || false,
        isLastInModule: position?.isLastInModule || false,
        lastQuestion: initialResponse,
        turnCount: 0,
        startedAt: new Date().toISOString(),
        socraticState: SOCRATIC_STATES.INTRODUCTION,
        masteryScore: 0,
        cognitiveLevel: startingCognitiveLevel,
        topic: position?.subtopicName || position?.topicName || teachingUnit,
        consecutiveWrong: 0,
        hintsGiven: 0,
        history: [],
        learningPath: await buildInitialLearningPath(courseName, position),
        priorKnowledgeAnalysis: {
            hasPriorKnowledge: structHasPriorKnowledge,
            masteredTopics: structMasteredTopics,
            difficultyLevel: structDifficultyLevel,
            signals: structSignals
        }
    };
 
    await setTutorSessionState(sessionId, newTutorState);
 
    await saveUserProgress(userId.toString(), courseName, {
        completedSubtopics,
        completedTopics,
        completedModules,
        currentPosition: position,
        lastActiveDate: new Date().toISOString()
    });
 
    const introReply = {
        sender: 'bot', role: 'model',
        text: initialResponse, parts: [{ text: initialResponse }],
        timestamp: new Date(),
        source_pipeline: 'tutor-introduction',
        socraticState: SOCRATIC_STATES.INTRODUCTION,
        thinking: `Curriculum-driven tutor initialized. Teaching: "${teachingUnit}" in ${position?.moduleName || courseName}.`,
        currentPosition: position,
        criticalThinkingCues: []
    };
 
    const aiMessageForDb = {
        role: 'model', parts: [{ text: initialResponse }],
        timestamp: new Date(), source_pipeline: 'tutor-introduction'
    };
    await ChatHistory.findOneAndUpdate(
        { sessionId, userId },
        {
            $push: { messages: { $each: buildMessagesEach(userMessageForDb, aiMessageForDb, isAutoGreeting), $slice: -100 } },
            $set: { isTutorMode: true, tutorModeType: 'structured', courseName, updatedAt: new Date() }
        },
        { upsert: true }
    );
 
    streamEvent(res, { type: 'final_answer', content: introReply });
    res.end();
    return true;
}
 
module.exports = { handleGeneral, handleStructured };
 
