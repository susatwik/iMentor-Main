// server/routes/sessionRoutes.js
// Extracted from chat.js — Session management endpoints (history, list, delete, stats)
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const log = require('../utils/logger');
const ChatHistory = require('../models/ChatHistory');
const User = require('../models/User');
const { analyzeAndRecommend } = require('../services/sessionAnalysisService');
const { analyzePrompt } = require('../services/promptCoachService');
const { decrypt } = require('../utils/crypto');
const { redisClient } = require('../config/redisClient');

// @route   POST /api/chat/history
// @desc    Finalize previous session + create new one
// @access  Private
router.post('/history', async (req, res) => {
    const { previousSessionId, skipAnalysis, courseName, courseId, moduleId, title, isTutorMode, tutorModeType, forceNewChat } = req.body;
    const userId = req.user._id;
    const newSessionId = uuidv4();

    log.info('SYSTEM', `POST /history requested: course=${courseName}, force=${forceNewChat}`);

    // Date-based check: Reuse today's session for the course if forceNewChat is false
    if (courseName && !forceNewChat) {
        try {
            const existingSession = await ChatHistory.findOne({
                userId,
                courseName: courseName,
                isTutorMode: isTutorMode || false
            }).sort({ updatedAt: -1 });

            if (existingSession) {
                const today = new Date();
                const sessionDate = new Date(existingSession.updatedAt);
                const isToday = today.getFullYear() === sessionDate.getFullYear() &&
                                today.getMonth() === sessionDate.getMonth() &&
                                today.getDate() === sessionDate.getDate();

                if (isToday) {
                    log.info('CHAT', `Reusing existing session ${existingSession.sessionId} for course ${courseName} updated today`);
                    return res.status(200).json({
                        message: 'Reused today\'s session.',
                        newSessionId: existingSession.sessionId,
                        studyPlanSuggestion: null
                    });
                }
            }
        } catch (err) {
            log.error('SYSTEM', 'Failed checking for existing session', err);
        }
    }

    const responsePayload = {
        message: 'New session started.',
        newSessionId: newSessionId,
        studyPlanSuggestion: null
    };

    try {
        if (previousSessionId && !skipAnalysis) {
            const previousSession = await ChatHistory.findOne({ sessionId: previousSessionId, userId: userId });

            if (previousSession && previousSession.messages?.length > 1) {
                log.info('CHAT', `Will finalize previous session '${previousSessionId}' in background...`);

                // Fire-and-forget background analysis
                setImmediate(async () => {
                    try {
                        const user = await User.findById(userId).select('profile preferredLlmProvider ollamaModel ollamaUrl +encryptedApiKey');
                        const llmConfig = {
                            llmProvider: user?.preferredLlmProvider || 'local_llm',
                            ollamaModel: user?.ollamaModel || process.env.OLLAMA_DEFAULT_MODEL,
                            apiKey: user?.encryptedApiKey ? decrypt(user.encryptedApiKey) : null,
                            ollamaUrl: user?.ollamaUrl || null
                        };

                        const { summary, knowledgeGaps, recommendations, keyTopics } = await analyzeAndRecommend(
                            previousSession.messages, previousSession.summary,
                            llmConfig.llmProvider, llmConfig.ollamaModel, llmConfig.apiKey, llmConfig.ollamaUrl
                        );

                        await ChatHistory.updateOne(
                            { sessionId: previousSessionId, userId: userId },
                            { $set: { summary: summary } }
                        );

                        if (knowledgeGaps && knowledgeGaps.size > 0) {
                            user.profile.performanceMetrics.clear();
                            knowledgeGaps.forEach((score, topic) => {
                                user.profile.performanceMetrics.set(topic.replace(/\./g, '-'), score);
                            });
                            await user.save();
                            log.info('CHAT', `Updated user performance metrics (${knowledgeGaps.size} gaps)`);

                            let mostSignificantGap = null;
                            let lowestScore = 1.1;
                            knowledgeGaps.forEach((score, topic) => {
                                if (score < lowestScore) {
                                    lowestScore = score;
                                    mostSignificantGap = topic;
                                }
                            });

                            if (mostSignificantGap && lowestScore < 0.6) {
                                log.warn('CHAT', `Gap detected: "${mostSignificantGap}" (Score: ${lowestScore})`);
                                responsePayload.studyPlanSuggestion = {
                                    topic: mostSignificantGap,
                                    reason: 'Analysis of your last session shows this is a key area for improvement.'
                                };
                            }
                        }

                        if (keyTopics && keyTopics.length > 0 && !responsePayload.studyPlanSuggestion) {
                            const primaryTopic = keyTopics[0];
                            log.info('CHAT', `Focused topic: "${primaryTopic}"`);
                            responsePayload.studyPlanSuggestion = {
                                topic: primaryTopic,
                                reason: `Your last session focused on ${primaryTopic}. Would you like to create a structured study plan to master it?`
                            };
                        }

                        if (redisClient && redisClient.isOpen && recommendations && recommendations.length > 0) {
                            const cacheKey = `recommendations:${previousSessionId}`;
                            await redisClient.set(cacheKey, JSON.stringify(recommendations), { EX: 3600 });
                            log.info('CHAT', `Cached ${recommendations.length} recommendations in background`);
                        }
                    } catch (bgError) {
                        log.error('SYSTEM', 'Background finalization of session failed', bgError);
                    }
                });
            }
        }

        await ChatHistory.create({
            userId,
            sessionId: newSessionId,
            messages: [],
            courseName: courseName || null,
            courseId: courseId || null,
            moduleId: moduleId || null,
            title: title || (courseName ? (moduleId ? `${courseName.replace(/\.[^.]+$/, '')} - ${moduleId}` : `${courseName.replace(/\.[^.]+$/, '')} Chat`) : 'New Chat'),
            isTutorMode: isTutorMode || false,
            tutorModeType: tutorModeType || null
        });
        log.success('CHAT', 'New session initialized instantly');
        res.status(200).json(responsePayload);

    } catch (error) {
        log.error('SYSTEM', 'Finalize-and-create-new failed', error);
        if (!res.headersSent) {
            try {
                await ChatHistory.create({
                    userId,
                    sessionId: newSessionId,
                    messages: [],
                    courseName: courseName || null,
                    courseId: courseId || null,
                    moduleId: moduleId || null,
                    title: title || (courseName ? (moduleId ? `${courseName.replace(/\.[^.]+$/, '')} - ${moduleId}` : `${courseName.replace(/\.[^.]+$/, '')} Chat`) : 'New Chat'),
                    isTutorMode: isTutorMode || false,
                    tutorModeType: tutorModeType || null
                });
                responsePayload.message = 'New session started, but analysis of previous session failed.';
                res.status(200).json(responsePayload);
            } catch (fallbackError) {
                res.status(500).json({ message: 'A critical error occurred while creating a new session.' });
            }
        }
    }
});

// @route   GET /api/chat/sessions
// @desc    List all chat sessions for current user
// @access  Private
router.get('/sessions', async (req, res) => {
    try {
        const sessions = await ChatHistory.aggregate([
            { $match: { userId: req.user._id } },
            { $sort: { updatedAt: -1 } },
            { $project: {
                sessionId: 1,
                createdAt: 1,
                updatedAt: 1,
                title: { $ifNull: ['$title', null] },
                isTutorMode: { $ifNull: ['$isTutorMode', false] },
                tutorModeType: { $ifNull: ['$tutorModeType', null] },
                courseName: { $ifNull: ['$courseName', null] },
                messageCount: { $size: { $ifNull: ['$messages', []] } },
                firstMessages: { $slice: [{ $ifNull: ['$messages', []] }, 5] }
            }}
        ]);

        const sessionSummaries = sessions.map(session => {
            const firstUserMessage = session.firstMessages?.find(m => m.role === 'user');
            let preview = session.title;
            if (!preview) {
                preview = firstUserMessage?.parts?.[0]?.text?.substring(0, 75) || 'Chat Session';
                if (preview.length === 75) preview += '...';
            }
            return {
                sessionId: session.sessionId,
                createdAt: session.createdAt,
                updatedAt: session.updatedAt,
                messageCount: session.messageCount,
                preview,
                isTutorMode: session.isTutorMode,
                tutorModeType: session.tutorModeType,
                courseName: session.courseName
            };
        });
        res.status(200).json(sessionSummaries);
    } catch (error) {
        log.error('CHAT', `Failed to retrieve chat sessions: ${error.message}`);
        res.status(500).json({ message: 'Failed to retrieve chat sessions.' });
    }
});

// @route   DELETE /api/chat/cleanup/empty
// @desc    Delete empty chats (0 messages) for current user
// @access  Private
router.delete('/cleanup/empty', async (req, res) => {
    try {
        const result = await ChatHistory.deleteEmptyChats(req.user._id);
        res.status(200).json({ success: true, ...result });
    } catch (error) {
        log.error('SYSTEM', 'Error cleaning empty chats', error);
        res.status(500).json({ message: 'Failed to clean empty chats.' });
    }
});

// @route   GET /api/chat/stats
// @desc    Get chat stats for current user
// @access  Private
router.get('/stats', async (req, res) => {
    try {
        const stats = await ChatHistory.getChatStats(req.user._id);
        res.status(200).json(stats);
    } catch (error) {
        log.error('SYSTEM', 'Error getting chat stats', error);
        res.status(500).json({ message: 'Failed to get chat stats.' });
    }
});

// @route   GET /api/chat/session/:sessionId
// @desc    Get a specific chat session with messages
// @access  Private
router.get('/session/:sessionId', async (req, res) => {
    try {
        const session = await ChatHistory.findOne({ sessionId: req.params.sessionId, userId: req.user._id }).lean();
        if (!session) return res.status(404).json({ message: 'Chat session not found or access denied.' });

        const messagesForFrontend = (session.messages || []).map(msg => ({
            id: msg._id || uuidv4(),
            sender: msg.role === 'model' ? 'bot' : 'user',
            text: msg.parts?.[0]?.text || '',
            thinking: msg.thinking,
            references: msg.references,
            timestamp: msg.timestamp,
            source_pipeline: msg.source_pipeline,
            confidenceScore: msg.confidenceScore ?? null,
            reasoningMeta: msg.reasoningMeta || null,
            logId: msg.logId || null
        }));

        res.status(200).json({
            ...session,
            messages: messagesForFrontend,
            isTutorMode: session.isTutorMode || false,
            tutorModeType: session.tutorModeType || null,
            courseName: session.courseName || null
        });
    } catch (error) {
        log.error('DB', `Chat fetch failed (Session: ${req.params.sessionId})`, error);
        res.status(500).json({ message: 'Failed to retrieve chat session details.' });
    }
});

// @route   DELETE /api/chat/session/:sessionId
// @desc    Delete a chat session
// @access  Private
router.delete('/session/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const userId = req.user._id;
    try {
        const result = await ChatHistory.deleteOne({ sessionId: sessionId, userId: userId });
        if (redisClient && redisClient.isOpen) {
            const cacheKey = `session:${sessionId}`;
            await redisClient.del(cacheKey);
        }
        if (result.deletedCount === 0) {
            return res.status(404).json({ message: 'Chat session not found.' });
        }
        res.status(200).json({ message: 'Chat session deleted successfully.' });
    } catch (error) {
        res.status(500).json({ message: 'Server error while deleting chat session.' });
    }
});

// @route   POST /api/chat/analyze-prompt
// @desc    Analyze a user's prompt and suggest improvements
// @access  Private
router.post('/analyze-prompt', async (req, res) => {
    const { prompt } = req.body;
    const userId = req.user._id;

    log.info('CHAT', 'PROMPT_COACH_REQUESTED', {
        userId: userId?.toString?.() || 'unknown',
        promptLength: prompt ? prompt.length : 0
    });

    if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ message: "'prompt' field is missing or invalid." });
    }

    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt.length < 3) {
        return res.status(400).json({ message: 'Prompt must be at least 3 characters long.' });
    }

    try {
        const analysis = await analyzePrompt(userId, trimmedPrompt);
        res.status(200).json(analysis);
    } catch (error) {
        log.error('SYSTEM', 'Prompt analysis failed', error);
        res.status(500).json({ message: error.message || 'Server error during prompt analysis.' });
    }
});

module.exports = router;
