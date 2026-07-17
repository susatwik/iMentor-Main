// server/middleware/contextualMemoryMiddleware.js

const knowledgeStateService = require('../services/knowledgeStateService');
const { generateTutorSystemPrompt } = require('../prompts/tutorSystemPrompt');
const { redisClient } = require('../config/redisClient');
const log = require('../utils/logger');

// Cache TTL: 10 minutes per user
const MEMORY_CACHE_TTL = 600;
const activeAnalysisJobs = new Set();

/**
 * Middleware to inject contextual memory into chat requests
 * This enriches the request with student's knowledge state for personalized tutoring
 */
async function injectContextualMemory(req, res, next) {
    // log.info('SYSTEM', 'Contextual Memory Middleware triggered');
    try {
        const userId = req.user?._id || req.user?.id;
        const { query, tutorMode, messageCount } = req.body;

        // Lightweight gating: contextual memory is only worth it for tutor-like flows.
        // This avoids prompt/token bloat for non-tutor endpoints.
        const isTutorLikeMode = (tutorMode === 'tutor' || tutorMode === 'tutorMode' || tutorMode === 'quizMode' || tutorMode === 'studyMode' || tutorMode === 'socratic');


        if (!userId) {
            // No user context, skip memory injection
            // log.warn('SYSTEM', 'No user ID found for memory injection');
            req.contextualMemory = {
                knowledgeContext: null,
                systemPrompt: generateTutorSystemPrompt(null, tutorMode),
                hasMemory: false
            };
            return next();
        }

        // log.info('SYSTEM', `Loading memory for user: ${userId}`);

        // Check if user has opted out of contextual memory
        // Merged into the main memory cache key to save a Redis round-trip
        const StudentKnowledgeState = require('../models/StudentKnowledgeState');
        const memoryCacheKey = `ctx:memory:${userId}`;
        const forceRefresh = messageCount && (Number(messageCount) % 5 === 0);

        // Try to read the unified cache (optout flag + memory data in one key)
        if (!forceRefresh && redisClient && redisClient.isOpen) {
            try {
                const cached = await redisClient.get(memoryCacheKey);
                if (cached) {
                    const parsed = JSON.parse(cached);
                    // If optout flag is stored in the unified cache, honour it
                    if (parsed._optedOut === true) {
                        req.contextualMemory = {
                            knowledgeContext: null,
                            systemPrompt: generateTutorSystemPrompt(null, tutorMode),
                            hasMemory: false,
                            optedOut: true
                        };
                        return next();
                    }
                    const { knowledgeContext: cachedCtx, userExpertise: cachedExpertise } = parsed;
                    const advancedRecognition = require('../services/advancedUserRecognitionService');
                    let systemPrompt = generateTutorSystemPrompt(cachedCtx, tutorMode);
                    if (cachedExpertise?.isReturningExpert) {
                        systemPrompt = advancedRecognition.generateExpertiseAwareSystemPrompt(systemPrompt, cachedExpertise);
                    }
                    req.contextualMemory = {
                        knowledgeContext: cachedCtx,
                        systemPrompt,
                        hasMemory: !!cachedCtx,
                        optedOut: false,
                        userExpertise: cachedExpertise,
                        expertAcknowledgment: advancedRecognition.generateExpertAcknowledgment(cachedExpertise, query),
                        fromCache: true
                    };
                    return next();
                }
            } catch (cacheErr) {
                log.warn('SYSTEM', `Memory cache read error: ${cacheErr.message}`);
            }
        }

        // Get student's knowledge state context (expensive — only on cache miss / every 5th msg)
        if (!isTutorLikeMode) {
            req.contextualMemory = {
                knowledgeContext: null,
                systemPrompt: generateTutorSystemPrompt(null, tutorMode),
                hasMemory: false,
                optedOut: false
            };
            return next();
        }
        // First check optout status (single DB query, result stored in unified cache)
        const userKnowledgeState = await StudentKnowledgeState.findOne({ userId }).select('memoryOptOut');
        const isOptedOut = userKnowledgeState?.memoryOptOut === true;

        if (isOptedOut) {
            // Store optout flag in the unified cache so next request is a single Redis read
            if (redisClient && redisClient.isOpen) {
                try {
                    await redisClient.setEx(memoryCacheKey, MEMORY_CACHE_TTL, JSON.stringify({ _optedOut: true }));
                } catch (_) { /* non-critical */ }
            }
            req.contextualMemory = {
                knowledgeContext: null,
                systemPrompt: generateTutorSystemPrompt(null, tutorMode),
                hasMemory: false,
                optedOut: true
            };
            return next();
        }

        // Token/prompt budget control: cap the amount of contextual memory we inject.
        const knowledgeContext = await knowledgeStateService.getContextualMemory(userId, query);
        const MAX_CONTEXT_CHARS = 4500; // rough safety budget before prompt inflation
        const budgetedKnowledgeContext = typeof knowledgeContext === 'string'
            ? (knowledgeContext.length > MAX_CONTEXT_CHARS ? knowledgeContext.slice(0, MAX_CONTEXT_CHARS) + '\n...[truncated]' : knowledgeContext)
            : knowledgeContext;

        // NEW: Check user's expertise level for adaptive responses
        const advancedRecognition = require('../services/advancedUserRecognitionService');
        const userExpertise = await advancedRecognition.checkUserExpertiseLevel(userId, query);

        // Persist to Redis cache (store the budgeted context to reduce prompt inflation on cache hits)
        if (redisClient && redisClient.isOpen) {
            try {
                await redisClient.setEx(
                    memoryCacheKey,
                    MEMORY_CACHE_TTL,
                    JSON.stringify({ knowledgeContext: budgetedKnowledgeContext, userExpertise })
                );
            } catch (cacheSetErr) {
                log.warn('SYSTEM', `Memory cache write error: ${cacheSetErr.message}`);
            }
        }


        // Generate system prompt with contextual memory AND expertise awareness
        // (use budgeted/truncated memory to cap prompt size)
        let systemPrompt = generateTutorSystemPrompt(budgetedKnowledgeContext, tutorMode);

        // Enhance system prompt for returning experts
        if (userExpertise.isReturningExpert) {
            systemPrompt = advancedRecognition.generateExpertiseAwareSystemPrompt(systemPrompt, userExpertise);
            log.info('SYSTEM', `Enhanced prompt for ${userExpertise.expertiseLevel} student`);
        }

        // Generate acknowledgment prefix if user is asking about mastered topics
        const expertAcknowledgment = advancedRecognition.generateExpertAcknowledgment(userExpertise, query);

        // Attach to request for use in chat handler
        req.contextualMemory = {
            knowledgeContext,
            systemPrompt,
            hasMemory: !!knowledgeContext,
            optedOut: false,
            userExpertise, // NEW: Include expertise data
            expertAcknowledgment // NEW: Include acknowledgment prefix
        };

        log.success('SYSTEM', `Injected memory for ${userId} (${userExpertise.expertiseLevel})`);

        // Debug: Show what's in the knowledge context
        // log.info('SYSTEM', 'Knowledge context loaded');


        next();
    } catch (error) {
        log.error('SYSTEM', 'Error injecting contextual memory', error);

        // CRITICAL: Don't block the request, just proceed without memory (graceful degradation)
        req.contextualMemory = {
            knowledgeContext: null,
            systemPrompt: generateTutorSystemPrompt(null, req.body?.tutorMode),
            hasMemory: false,
            error: true
        };
        next();
    }
}

/**
 * Background task to analyze session and update knowledge state
 * Call this after a chat response is sent (non-blocking)
 */
async function analyzeAndUpdateKnowledgeState(sessionId, userId, llmConfig) {
    const jobKey = `${sessionId}:${userId}`;
    if (activeAnalysisJobs.has(jobKey)) {
        return;
    }

    activeAnalysisJobs.add(jobKey);
    try {
        log.info('SYSTEM', `Background analysis for session ${sessionId}`);

        if (!sessionId || !userId || !llmConfig) {
            return;
        }

        const ChatHistory = require('../models/ChatHistory');
        const chatHistory = await ChatHistory.findOne({ sessionId, userId }).select('messages');
        if (!chatHistory || !Array.isArray(chatHistory.messages) || chatHistory.messages.length < 2) {
            return;
        }

        const insights = await knowledgeStateService.analyzeConversationForInsights(
            sessionId,
            userId,
            chatHistory.messages,
            llmConfig
        );

        if (!insights) {
            return;
        }

        await knowledgeStateService.updateKnowledgeStateFromInsights(userId, sessionId, insights);

        // Refresh contextual-memory cache on next request
        if (redisClient && redisClient.isOpen) {
            try {
                await redisClient.del(`ctx:memory:${userId}`);
            } catch (cacheErr) {
                log.warn('SYSTEM', `Memory cache invalidation error: ${cacheErr.message}`);
            }
        }
    } catch (error) {
        log.error('SYSTEM', `Error in background analysis: ${sessionId}`, error);
    } finally {
        activeAnalysisJobs.delete(jobKey);
    }
}

/**
 * Update session metadata in ChatHistory
 */
async function updateSessionMetadata(sessionId, metadata) {
    try {
        const ChatHistory = require('../models/ChatHistory');

        await ChatHistory.findOneAndUpdate(
            { sessionId },
            {
                $set: {
                    'sessionMetadata.tutorModeActive': metadata.tutorMode || false,
                    'sessionMetadata.sessionDuration': metadata.duration || 0,
                    updatedAt: new Date()
                }
            }
        );

        // log.info('SYSTEM', `Updated metadata for session ${sessionId}`);
    } catch (error) {
        log.error('SYSTEM', 'Error updating session metadata', error);
    }
}

/**
 * Trigger knowledge state analysis after N messages
 * This allows real-time updates during long sessions
 */
async function triggerPeriodicAnalysis(sessionId, userId, messageCount, llmConfig) {
    if (!sessionId || !userId || !llmConfig) return;

    log.info('SYSTEM', `Triggering memory analysis (msg ${messageCount || 'n/a'})`);

    // Run in background
    setImmediate(() => {
        analyzeAndUpdateKnowledgeState(sessionId, userId, llmConfig);
    });
}

module.exports = {
    injectContextualMemory,
    analyzeAndUpdateKnowledgeState,
    updateSessionMetadata,
    triggerPeriodicAnalysis
};
