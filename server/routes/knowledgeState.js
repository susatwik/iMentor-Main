// server/routes/knowledgeState.js
/**
 * Knowledge State Management Routes
 * Provides endpoints for viewing, managing, and controlling student memory/profile
 */

const express = require('express');
const router = express.Router();
const StudentKnowledgeState = require('../models/StudentKnowledgeState');
const knowledgeStateService = require('../services/knowledgeStateService');
const log = require('../utils/logger');
const { auditLog } = require('../utils/logger');

/**
 * GET /api/knowledge-state
 * Get the current user's knowledge state profile
 */
router.get('/', async (req, res) => {
    try {
        const userId = req.user._id;
        const User = require('../models/User');
        const TutorSession = require('../models/TutorSession');
        const GamificationProfile = require('../models/GamificationProfile');
        
        const user = await User.findById(userId);
        const knowledgeState = await knowledgeStateService.getOrCreateKnowledgeState(userId);
        const tutorSessions = await TutorSession.find({ userId });
        const gamificationProfile = await GamificationProfile.findOne({ userId });

        // Generate a user-friendly summary
        const summary = knowledgeState.generateQuickSummary();

        // Calculate overall metrics on the fly and merge them into summary
        const totalQuizzes = user?.profile?.quizScores?.length || 0;
        const averageScore = totalQuizzes > 0 
            ? Math.round(user.profile.quizScores.reduce((sum, q) => sum + q.score, 0) / totalQuizzes)
            : 0;

        let mostImproved = 'N/A';
        let maxImprovement = 0;
        knowledgeState.concepts.forEach(c => {
            if (c.learningVelocity > maxImprovement) {
                maxImprovement = c.learningVelocity;
                mostImproved = c.conceptName;
            }
        });

        summary.totalQuizzes = totalQuizzes;
        summary.averageScore = averageScore;
        summary.mostImproved = mostImproved;
        summary.learningStage = user?.profile?.learningStage || 'Beginner';
        summary.strongTopics = user?.profile?.strongTopics || [];
        summary.weakTopics = user?.profile?.weakTopics || [];

        // Compute a quizHistoryTimeline (aggregating attempt history course-by-course)
        const quizHistoryTimeline = (user?.profile?.quizScores || []).map(q => ({
            courseName: q.courseName || q.course,
            module: q.module || 'all',
            moduleId: q.moduleId || 'all',
            score: q.score,
            difficulty: q.difficulty || 'Beginner',
            date: q.attemptDate || q.date,
            remediation: q.remediation
        })).sort((a, b) => new Date(b.date) - new Date(a.date));

        // 1. Dynamic Timeline compilation (merging sessionInsights, tutorSessions, quizScores, and skillTree completions)
        let timelineEvents = [];

        // Add pre-existing sessionInsights from DB
        if (knowledgeState.sessionInsights) {
            knowledgeState.sessionInsights.forEach(insight => {
                timelineEvents.push({
                    sessionId: insight.sessionId || `insight-${insight._id}`,
                    date: insight.date || insight.createdAt,
                    type: 'tutor-insight',
                    conceptsCovered: insight.conceptsCovered || [],
                    keyObservations: insight.keyObservations || [],
                    struggledWith: insight.struggledWith || [],
                    breakthroughMoments: insight.breakthroughMoments || []
                });
            });
        }

        // Add actual TutorSessions
        if (tutorSessions && tutorSessions.length > 0) {
            tutorSessions.forEach(session => {
                const concepts = session.progressTracking?.conceptsUnderstood || [session.topic].filter(Boolean);
                timelineEvents.push({
                    sessionId: session.sessionId,
                    date: session.createdAt || session.updatedAt,
                    type: 'tutor',
                    conceptsCovered: concepts,
                    keyObservations: [
                        `Completed tutor session in ${session.course || 'General'} on topic "${session.topic || 'General'}"`,
                        `Total interactions: ${session.progressTracking?.totalInteractions || 0}`,
                        `Emotional State: ${session.emotionalState || 'CURIOUS'}`
                    ],
                    struggledWith: session.progressTracking?.conceptsStruggling || [],
                    breakthroughMoments: session.masteryScore >= 3 ? ['Demonstrated solid mastery in discussions'] : []
                });
            });
        }

        // Add Quiz scores
        if (user?.profile?.quizScores && user.profile.quizScores.length > 0) {
            user.profile.quizScores.forEach((quiz, index) => {
                timelineEvents.push({
                    sessionId: `quiz-${quiz._id || index}-${new Date(quiz.date).getTime()}`,
                    date: quiz.attemptDate || quiz.date || new Date(),
                    type: 'quiz',
                    conceptsCovered: [quiz.module || 'Overview'].filter(Boolean),
                    keyObservations: [
                        `Completed quiz for ${quiz.courseName || quiz.course || 'course'}`,
                        `Module: ${quiz.module || 'Overview'}`,
                        `Scored ${quiz.score}% (${quiz.difficulty || 'standard'} difficulty)`
                    ].concat(quiz.remediation?.recommendation ? [`Recommendation: ${quiz.remediation.recommendation}`] : []),
                    struggledWith: quiz.weakTopics || [],
                    breakthroughMoments: quiz.score >= 80 ? [`Achieved ${quiz.score}% score on quiz`] : []
                });
            });
        }

        // Add Skill tree completions
        if (gamificationProfile && gamificationProfile.skillTreeProgress) {
            Object.entries(gamificationProfile.skillTreeProgress).forEach(([topic, topicData]) => {
                if (topicData && topicData.levels) {
                    Object.entries(topicData.levels).forEach(([levelId, levelData]) => {
                        timelineEvents.push({
                            sessionId: `skilltree-${topic}-${levelId}-${new Date(levelData.completedAt).getTime()}`,
                            date: levelData.completedAt || new Date(),
                            type: 'skill-tree',
                            conceptsCovered: [topic],
                            keyObservations: [
                                `Completed Skill Tree Level ${levelId} for topic "${topic}"`,
                                `Earned ${levelData.stars} stars with score ${levelData.score}/${levelData.totalQuestions || 6}`
                            ],
                            struggledWith: [],
                            breakthroughMoments: levelData.stars === 3 ? [`Perfect 3-star completion on level ${levelId}`] : []
                        });
                    });
                }
            });
        }

        // Sort chronological descending
        timelineEvents.sort((a, b) => new Date(b.date) - new Date(a.date));

        // 2. Dynamic Insights & Struggles Generation
        const compiledStruggles = [...(knowledgeState.recurringStruggles || [])];
        
        // Add dynamic struggles from quiz scores
        if (quizHistoryTimeline.length > 0) {
            const lowScoreQuizzes = quizHistoryTimeline.filter(q => q.score < 50);
            if (lowScoreQuizzes.length > 0) {
                const pattern = "Struggles with quiz assessments under timed or structured conditions";
                if (!compiledStruggles.some(s => s.pattern === pattern)) {
                    compiledStruggles.push({
                        pattern,
                        occurrences: lowScoreQuizzes.length,
                        firstDetected: new Date(),
                        lastDetected: new Date(),
                        examples: lowScoreQuizzes.map(q => q.module)
                    });
                }
            }
        }

        // Add dynamic struggles from tutor hints/struggles
        if (tutorSessions && tutorSessions.length > 0) {
            let totalHints = 0;
            let totalSessionsWithHints = 0;
            tutorSessions.forEach(s => {
                const hintsCount = s.previousHints?.length || s.progressTracking?.hintUsage || 0;
                if (hintsCount > 0) {
                    totalHints += hintsCount;
                    totalSessionsWithHints++;
                }
            });
            const avgHints = totalHints / tutorSessions.length;
            if (avgHints > 2) {
                const pattern = "Needs frequent tutor hints to solve conceptual problems";
                if (!compiledStruggles.some(s => s.pattern === pattern)) {
                    compiledStruggles.push({
                        pattern,
                        occurrences: totalSessionsWithHints,
                        firstDetected: new Date(),
                        lastDetected: new Date(),
                        examples: tutorSessions.filter(s => (s.previousHints?.length || 0) > 0).map(s => s.topic).filter(Boolean)
                    });
                }
            }
        }

        res.status(200).json({
            profile: {
                learningStyle: knowledgeState.learningProfile.dominantLearningStyle,
                learningPace: knowledgeState.learningProfile.learningPace,
                preferredDepth: knowledgeState.learningProfile.preferredDepth,
                challengeResponse: knowledgeState.learningProfile.challengeResponse
            },
            summary,
            concepts: knowledgeState.concepts.map(c => ({
                name: c.conceptName,
                mastery: c.masteryScore,
                difficulty: c.difficulty,
                understandingLevel: c.understandingLevel,
                lastPracticed: c.lastInteractionDate,
                learningVelocity: c.learningVelocity
            })),
            sessionInsights: timelineEvents,
            currentFocusAreas: knowledgeState.currentFocusAreas || [],
            recurringStruggles: compiledStruggles,
            engagementMetrics: knowledgeState.engagementMetrics,
            lastUpdated: knowledgeState.lastUpdated,
            quizHistoryTimeline
        });

        auditLog(req, 'KNOWLEDGE_STATE_VIEWED', { userId: userId.toString() });
    } catch (error) {
        log.error('DB', `Failed to fetch knowledge state: ${error.message}`);
        res.status(500).json({ message: 'Failed to retrieve knowledge state' });
    }
});

/**
 * GET /api/knowledge-state/export
 * Export the user's complete knowledge state as JSON
 */
router.get('/export', async (req, res) => {
    try {
        const userId = req.user._id;
        const knowledgeState = await StudentKnowledgeState.findOne({ userId }).lean();

        if (!knowledgeState) {
            return res.status(404).json({ message: 'No knowledge state found' });
        }

        // Remove internal MongoDB fields
        delete knowledgeState._id;
        delete knowledgeState.__v;

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="knowledge-state-${userId}-${Date.now()}.json"`);
        res.status(200).json(knowledgeState);

        auditLog(req, 'KNOWLEDGE_STATE_EXPORTED', { userId: userId.toString() });
    } catch (error) {
        log.error('DB', `Failed to export knowledge state: ${error.message}`);
        res.status(500).json({ message: 'Failed to export knowledge state' });
    }
});

/**
 * DELETE /api/knowledge-state/reset
 * Reset the user's knowledge state (privacy control)
 */
router.delete('/reset', async (req, res) => {
    try {
        const userId = req.user._id;
        const { confirmReset } = req.body;

        if (!confirmReset) {
            return res.status(400).json({
                message: 'Reset confirmation required. Send { "confirmReset": true } to proceed.'
            });
        }

        // Delete existing knowledge state
        await StudentKnowledgeState.deleteOne({ userId });

        // Reset user profile stats
        const User = require('../models/User');
        await User.findByIdAndUpdate(userId, {
            $set: {
                'profile.quizAttempts': 0,
                'profile.quizScores': [],
                'profile.conceptMastery': {},
                'profile.strongTopics': [],
                'profile.weakTopics': [],
                'profile.learningStage': 'Beginner',
                'profile.learningLevel': 'BEGINNER',
                'profile.confidenceLevel': 50,
                'profile.lastQuizDate': null
            }
        });

        // Create a fresh knowledge state
        const newKnowledgeState = await knowledgeStateService.getOrCreateKnowledgeState(userId);

        log.info('DB', `User ${userId} reset knowledge state and user profile metrics`);
        auditLog(req, 'KNOWLEDGE_STATE_RESET', { userId: userId.toString() });

        res.status(200).json({
            message: 'Knowledge state reset successfully',
            newState: {
                totalConcepts: 0,
                totalSessions: 0,
                createdAt: newKnowledgeState.createdAt
            }
        });
    } catch (error) {
        log.error('DB', `Failed to reset knowledge state: ${error.message}`);
        res.status(500).json({ message: 'Failed to reset knowledge state' });
    }
});

/**
 * PATCH /api/knowledge-state/opt-out
 * Opt out of contextual memory (privacy control)
 */
router.patch('/opt-out', async (req, res) => {
    try {
        const userId = req.user._id;
        const { optOut } = req.body;

        const knowledgeState = await knowledgeStateService.getOrCreateKnowledgeState(userId);

        // Add opt-out flag to the schema
        knowledgeState.memoryOptOut = optOut === true;
        await knowledgeState.save();

        // Invalidate the Redis cache so the new preference takes effect immediately
        // (contextualMemoryMiddleware caches this key at TTL=3600s)
        try {
            const { redisClient } = require('../config/redisClient');
            if (redisClient?.isOpen) {
                await redisClient.del(`memory:optout:${userId}`).catch(() => {});
            }
        } catch (_) {}

        log.info('DB', `User ${userId} ${optOut ? 'opted out of' : 'opted into'} context memory`);
        auditLog(req, 'KNOWLEDGE_STATE_OPT_OUT_CHANGED', {
            userId: userId.toString(),
            optOut
        });

        res.status(200).json({
            message: optOut
                ? 'You have opted out of contextual memory. The tutor will not remember your learning history.'
                : 'You have opted into contextual memory. The tutor will remember your learning history.',
            optOut
        });
    } catch (error) {
        log.error('DB', `Failed to update opt-out preference: ${error.message}`);
        res.status(500).json({ message: 'Failed to update memory preference' });
    }
});

/**
 * GET /api/knowledge-state/struggling
 * Get concepts the user is currently struggling with
 */
router.get('/struggling', async (req, res) => {
    try {
        const userId = req.user._id;
        const strugglingTopics = await knowledgeStateService.getStrugglingTopics(userId);

        res.status(200).json({
            count: strugglingTopics.length,
            topics: strugglingTopics.map(c => ({
                name: c.conceptName,
                mastery: c.masteryScore,
                difficulty: c.difficulty,
                misconceptions: c.misconceptions.filter(m => m.stillPresent).map(m => m.description),
                weaknesses: c.weaknesses.map(w => w.aspect)
            }))
        });
    } catch (error) {
        log.error('DB', `Failed to fetch struggling topics: ${error.message}`);
        res.status(500).json({ message: 'Failed to retrieve struggling topics' });
    }
});

/**
 * GET /api/knowledge-state/mastered
 * Get concepts the user has mastered
 */
router.get('/mastered', async (req, res) => {
    try {
        const userId = req.user._id;
        const knowledgeState = await StudentKnowledgeState.findOne({ userId });

        if (!knowledgeState) {
            return res.status(200).json({ count: 0, topics: [] });
        }

        const masteredConcepts = knowledgeState.getMasteredConcepts();

        res.status(200).json({
            count: masteredConcepts.length,
            topics: masteredConcepts.map(c => ({
                name: c.conceptName,
                mastery: c.masteryScore,
                masteredAt: c.lastInteractionDate,
                strengths: c.strengths.map(s => s.aspect)
            }))
        });
    } catch (error) {
        log.error('DB', `Failed to fetch mastered topics: ${error.message}`);
        res.status(500).json({ message: 'Failed to retrieve mastered topics' });
    }
});

/**
 * GET /api/knowledge-state/health-check
 * Validate knowledge state integrity
 */
router.get('/health-check', async (req, res) => {
    try {
        const userId = req.user._id;
        const knowledgeState = await StudentKnowledgeState.findOne({ userId });

        if (!knowledgeState) {
            return res.status(200).json({
                status: 'healthy',
                message: 'No knowledge state yet (new user)'
            });
        }

        const issues = [];

        // Check for contradictory states
        knowledgeState.concepts.forEach(c => {
            if (c.understandingLevel === 'mastered' && c.difficulty === 'high') {
                issues.push(`Contradiction: ${c.conceptName} is mastered but has high difficulty`);
            }
            if (c.masteryScore > 80 && c.difficulty === 'high') {
                issues.push(`Contradiction: ${c.conceptName} has high mastery (${c.masteryScore}) but high difficulty`);
            }
            if (c.masteryScore < 0 || c.masteryScore > 100) {
                issues.push(`Invalid mastery score: ${c.conceptName} has mastery ${c.masteryScore}`);
            }
        });

        res.status(200).json({
            status: issues.length === 0 ? 'healthy' : 'issues_detected',
            totalConcepts: knowledgeState.concepts.length,
            issues,
            lastUpdated: knowledgeState.lastUpdated
        });
    } catch (error) {
        log.error('DB', `Failed to check knowledge state health: ${error.message}`);
        res.status(500).json({ message: 'Failed to check knowledge state health' });
    }
});

module.exports = router;
