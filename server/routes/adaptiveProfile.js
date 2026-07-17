/**
 * server/routes/adaptiveProfile.js
 * 
 * Adaptive Learning Profile Routes
 * 
 * Endpoints for:
 * - GET /student/profile - Student's learning profile
 * - GET /student/mastery - Mastery scores by concept
 * - GET /student/learning-speed - Detected learning speed
 * - GET /student/learning-path - Recommended topics
 * - POST /student/update - Update profile data
 * - GET /student/weak-concepts - Concepts needing attention
 * - GET /student/next-topics - Next 5 recommended topics
 */

const express = require('express');
const router = express.Router();
const StudentKnowledgeState = require('../models/StudentKnowledgeState');
const StudentLearningProfile = require('../models/StudentLearningProfile');
const User = require('../models/User');
const knowledgeAnalyzer = require('../services/knowledgeAnalyzer');
const learningSpeedDetector = require('../services/learningSpeedDetector');
const adaptiveLearningEngine = require('../services/adaptiveLearningEngine');
const learningPathEngine = require('../services/learningPathEngine');
const { authMiddleware } = require('../middleware/authMiddleware');
const log = require('../utils/logger');

// Apply auth to all routes
router.use(authMiddleware);

/**
 * GET /student/profile
 * Get complete student learning profile
 */
router.get('/profile', async (req, res) => {
    try {
        const userId = req.user._id;
        
        const [knowledgeState, learningProfile, user] = await Promise.all([
            StudentKnowledgeState.findOne({ userId }),
            StudentLearningProfile.findOne({ userId }),
            User.findById(userId)
        ]);

        if (!knowledgeState) {
            return res.status(404).json({
                message: 'Learning profile not yet initialized',
                data: null
            });
        }

        res.json({
            success: true,
            data: {
                userId,
                userName: user?.username || 'Unknown',
                knowledgeState: {
                    totalConcepts: knowledgeState.concepts?.length || 0,
                    masteredConcepts: knowledgeState.concepts?.filter(c => c.masteryScore >= 80).length || 0,
                    learningProfile: knowledgeState.learningProfile,
                    masteredTopics: knowledgeState.masteredTopics || [],
                    currentFocusAreas: knowledgeState.currentFocusAreas || [],
                    engagementMetrics: knowledgeState.engagementMetrics,
                    knowledgeSummary: knowledgeState.knowledgeSummary
                },
                learningProfile: learningProfile ? {
                    overallProgress: learningProfile.overallProgress,
                    learningCurve: learningProfile.learningCurve?.slice(-10) || [],
                    subtopicProgress: learningProfile.subtopicProgress?.slice(0, 10) || []
                } : null
            }
        });
    } catch (error) {
        log.error('PROFILE', `Failed to get profile: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /student/mastery
 * Get mastery scores for all concepts
 */
router.get('/mastery', async (req, res) => {
    try {
        const userId = req.user._id;
        const knowledgeState = await StudentKnowledgeState.findOne({ userId });

        if (!knowledgeState || !knowledgeState.concepts) {
            return res.json({
                success: true,
                data: {
                    concepts: [],
                    summary: {
                        average: 0,
                        mastered: 0,
                        learning: 0,
                        struggling: 0
                    }
                }
            });
        }

        const concepts = knowledgeState.concepts.map(c => ({
            name: c.conceptName,
            masteryScore: c.masteryScore,
            level: c.understandingLevel,
            difficulty: c.difficulty,
            totalInteractions: c.totalInteractions || 0,
            successRate: c.successfulInteractions ? 
                Math.round((c.successfulInteractions / c.totalInteractions) * 100) : 0,
            lastInteractionDate: c.lastInteractionDate,
            confidenceScore: Math.round(c.confidenceScore * 100) || 0
        }));

        const summary = {
            average: Math.round(
                concepts.reduce((sum, c) => sum + c.masteryScore, 0) / concepts.length
            ) || 0,
            mastered: concepts.filter(c => c.masteryScore >= 80).length,
            learning: concepts.filter(c => c.masteryScore >= 50 && c.masteryScore < 80).length,
            struggling: concepts.filter(c => c.masteryScore < 50).length
        };

        res.json({
            success: true,
            data: {
                concepts: concepts.sort((a, b) => b.masteryScore - a.masteryScore),
                summary
            }
        });
    } catch (error) {
        log.error('MASTERY', `Failed to get mastery: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /student/learning-speed
 * Get detected learning speed
 */
router.get('/learning-speed', async (req, res) => {
    try {
        const userId = req.user._id;
        const speedWithConfidence = await learningSpeedDetector.getSpeedWithConfidence(userId);
        const adaptiveParams = learningSpeedDetector.getAdaptiveParameters(speedWithConfidence.speed);

        res.json({
            success: true,
            data: {
                speed: speedWithConfidence.speed,
                confidence: Math.round(speedWithConfidence.confidence * 100),
                details: speedWithConfidence.details,
                adaptiveParameters: adaptiveParams
            }
        });
    } catch (error) {
        log.error('LEARNING_SPEED', `Failed to get learning speed: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /student/weak-concepts
 * Get concepts that need attention
 */
router.get('/weak-concepts', async (req, res) => {
    try {
        const userId = req.user._id;
        const knowledgeState = await StudentKnowledgeState.findOne({ userId });

        if (!knowledgeState || !knowledgeState.concepts) {
            return res.json({ success: true, data: { weakConcepts: [] } });
        }

        const weakConcepts = knowledgeState.concepts
            .filter(c => c.masteryScore < 60)
            .sort((a, b) => a.masteryScore - b.masteryScore)
            .map(c => ({
                name: c.conceptName,
                masteryScore: c.masteryScore,
                weaknesses: c.weaknesses || [],
                misconceptions: c.misconceptions || [],
                suggestedAction: c.masteryScore < 30 ? 'RETEACH' : 'REVIEW',
                confidenceScore: Math.round(c.confidenceScore * 100) || 0
            }))
            .slice(0, 10);

        res.json({
            success: true,
            data: { weakConcepts }
        });
    } catch (error) {
        log.error('WEAK_CONCEPTS', `Failed to get weak concepts: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /student/next-topics
 * Get next recommended topics
 */
router.get('/next-topics', async (req, res) => {
    try {
        const userId = req.user._id;
        const subject = req.query.subject || 'DSA';
        const count = parseInt(req.query.count) || 5;

        const nextTopics = await learningPathEngine.getNextTopics(userId, subject, count);
        const progress = await learningPathEngine.getProgressPercentage(userId, subject);

        res.json({
            success: true,
            data: {
                nextTopics,
                subject,
                progressPercentage: progress
            }
        });
    } catch (error) {
        log.error('NEXT_TOPICS', `Failed to get next topics: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /student/learning-path
 * Get complete learning path
 */
router.get('/learning-path', async (req, res) => {
    try {
        const userId = req.user._id;
        const subject = req.query.subject || 'DSA';

        const path = await learningPathEngine.generateLearningPath(userId, subject);
        const progress = await learningPathEngine.getProgressPercentage(userId, subject);

        res.json({
            success: true,
            data: {
                path,
                subject,
                progressPercentage: progress,
                remainingTopics: path.length,
                completedPercentage: progress
            }
        });
    } catch (error) {
        log.error('LEARNING_PATH', `Failed to get learning path: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /student/update
 * Update student profile (called after learning sessions)
 * 
 * Body: {
 *   topic: string,
 *   correct: boolean,
 *   confidence: number (0-1),
 *   difficulty: 'low' | 'medium' | 'high',
 *   timeSeconds: number
 * }
 */
router.post('/update', async (req, res) => {
    try {
        const userId = req.user._id;
        const { topic, correct, confidence, difficulty, timeSeconds } = req.body;

        if (!topic || typeof correct !== 'boolean') {
            return res.status(400).json({
                success: false,
                message: 'topic and correct are required'
            });
        }

        // Update concept mastery
        await knowledgeAnalyzer.updateConceptMastery(userId, topic, {
            correct,
            confidence: confidence || 0.5,
            difficulty: difficulty || 'medium'
        });

        // Record learning event (invalidates speed cache)
        await learningSpeedDetector.recordLearningEvent(userId, {
            conceptName: topic,
            correct,
            timeSeconds: timeSeconds || 0
        });

        res.json({
            success: true,
            message: 'Profile updated successfully'
        });
    } catch (error) {
        log.error('UPDATE_PROFILE', `Failed to update profile: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /student/adaptive-plan/:topic
 * Get adaptive learning plan for a specific topic
 */
router.get('/adaptive-plan/:topic', async (req, res) => {
    try {
        const userId = req.user._id;
        const topic = req.params.topic;

        const plan = await adaptiveLearningEngine.getAdaptivePlan(userId, topic);

        // Check prerequisites
        const preReqCheck = await learningPathEngine.checkPrerequisites(userId, topic);

        res.json({
            success: true,
            data: {
                topic,
                adaptivePlan: plan,
                prerequisitesCheck: preReqCheck
            }
        });
    } catch (error) {
        log.error('ADAPTIVE_PLAN', `Failed to get adaptive plan: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /student/knowledge-analysis
 * Get AI-generated knowledge analysis patterns
 */
router.get('/knowledge-analysis', async (req, res) => {
    try {
        const userId = req.user._id;
        
        const analysis = await knowledgeAnalyzer.analyzePatterns(userId, []);

        res.json({
            success: true,
            data: analysis || {
                commonStruggles: [],
                strengthAreas: [],
                learningStyleInferred: 'unknown',
                adaptiveRecommendations: []
            }
        });
    } catch (error) {
        log.error('KNOWLEDGE_ANALYSIS', `Failed to analyze: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /student/curriculum/:subject
 * Get curriculum structure for a subject
 */
router.get('/curriculum/:subject', (req, res) => {
    try {
        const subject = req.params.subject.toUpperCase();
        const curriculum = learningPathEngine.getCurriculumStructure(subject);

        res.json({
            success: true,
            data: {
                subject,
                curriculum
            }
        });
    } catch (error) {
        log.error('CURRICULUM', `Failed to get curriculum: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
/**
 * server/routes/adaptiveProfile.js
 * 
 * Adaptive Learning Profile Routes
 * 
 * Endpoints for:
 * - GET /student/profile - Student's learning profile
 * - GET /student/mastery - Mastery scores by concept
 * - GET /student/learning-speed - Detected learning speed
 * - GET /student/learning-path - Recommended topics
 * - POST /student/update - Update profile data
 * - GET /student/weak-concepts - Concepts needing attention
 * - GET /student/next-topics - Next 5 recommended topics
 */

const express = require('express');
const router = express.Router();
const StudentKnowledgeState = require('../models/StudentKnowledgeState');
const StudentLearningProfile = require('../models/StudentLearningProfile');
const User = require('../models/User');
const knowledgeAnalyzer = require('../services/knowledgeAnalyzer');
const learningSpeedDetector = require('../services/learningSpeedDetector');
const adaptiveLearningEngine = require('../services/adaptiveLearningEngine');
const learningPathEngine = require('../services/learningPathEngine');
const { authMiddleware } = require('../middleware/authMiddleware');
const log = require('../utils/logger');

// Apply auth to all routes
router.use(authMiddleware);

/**
 * GET /student/profile
 * Get complete student learning profile
 */
router.get('/profile', async (req, res) => {
    try {
        const userId = req.user._id;
        
        const [knowledgeState, learningProfile, user] = await Promise.all([
            StudentKnowledgeState.findOne({ userId }),
            StudentLearningProfile.findOne({ userId }),
            User.findById(userId)
        ]);

        if (!knowledgeState) {
            return res.status(404).json({
                message: 'Learning profile not yet initialized',
                data: null
            });
        }

        res.json({
            success: true,
            data: {
                userId,
                userName: user?.username || 'Unknown',
                knowledgeState: {
                    totalConcepts: knowledgeState.concepts?.length || 0,
                    masteredConcepts: knowledgeState.concepts?.filter(c => c.masteryScore >= 80).length || 0,
                    learningProfile: knowledgeState.learningProfile,
                    masteredTopics: knowledgeState.masteredTopics || [],
                    currentFocusAreas: knowledgeState.currentFocusAreas || [],
                    engagementMetrics: knowledgeState.engagementMetrics,
                    knowledgeSummary: knowledgeState.knowledgeSummary
                },
                learningProfile: learningProfile ? {
                    overallProgress: learningProfile.overallProgress,
                    learningCurve: learningProfile.learningCurve?.slice(-10) || [],
                    subtopicProgress: learningProfile.subtopicProgress?.slice(0, 10) || []
                } : null
            }
        });
    } catch (error) {
        log.error('PROFILE', `Failed to get profile: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /student/mastery
 * Get mastery scores for all concepts
 */
router.get('/mastery', async (req, res) => {
    try {
        const userId = req.user._id;
        const knowledgeState = await StudentKnowledgeState.findOne({ userId });

        if (!knowledgeState || !knowledgeState.concepts) {
            return res.json({
                success: true,
                data: {
                    concepts: [],
                    summary: {
                        average: 0,
                        mastered: 0,
                        learning: 0,
                        struggling: 0
                    }
                }
            });
        }

        const concepts = knowledgeState.concepts.map(c => ({
            name: c.conceptName,
            masteryScore: c.masteryScore,
            level: c.understandingLevel,
            difficulty: c.difficulty,
            totalInteractions: c.totalInteractions || 0,
            successRate: c.successfulInteractions ? 
                Math.round((c.successfulInteractions / c.totalInteractions) * 100) : 0,
            lastInteractionDate: c.lastInteractionDate,
            confidenceScore: Math.round(c.confidenceScore * 100) || 0
        }));

        const summary = {
            average: Math.round(
                concepts.reduce((sum, c) => sum + c.masteryScore, 0) / concepts.length
            ) || 0,
            mastered: concepts.filter(c => c.masteryScore >= 80).length,
            learning: concepts.filter(c => c.masteryScore >= 50 && c.masteryScore < 80).length,
            struggling: concepts.filter(c => c.masteryScore < 50).length
        };

        res.json({
            success: true,
            data: {
                concepts: concepts.sort((a, b) => b.masteryScore - a.masteryScore),
                summary
            }
        });
    } catch (error) {
        log.error('MASTERY', `Failed to get mastery: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /student/learning-speed
 * Get detected learning speed
 */
router.get('/learning-speed', async (req, res) => {
    try {
        const userId = req.user._id;
        const speedWithConfidence = await learningSpeedDetector.getSpeedWithConfidence(userId);
        const adaptiveParams = learningSpeedDetector.getAdaptiveParameters(speedWithConfidence.speed);

        res.json({
            success: true,
            data: {
                speed: speedWithConfidence.speed,
                confidence: Math.round(speedWithConfidence.confidence * 100),
                details: speedWithConfidence.details,
                adaptiveParameters: adaptiveParams
            }
        });
    } catch (error) {
        log.error('LEARNING_SPEED', `Failed to get learning speed: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /student/weak-concepts
 * Get concepts that need attention
 */
router.get('/weak-concepts', async (req, res) => {
    try {
        const userId = req.user._id;
        const knowledgeState = await StudentKnowledgeState.findOne({ userId });

        if (!knowledgeState || !knowledgeState.concepts) {
            return res.json({ success: true, data: { weakConcepts: [] } });
        }

        const weakConcepts = knowledgeState.concepts
            .filter(c => c.masteryScore < 60)
            .sort((a, b) => a.masteryScore - b.masteryScore)
            .map(c => ({
                name: c.conceptName,
                masteryScore: c.masteryScore,
                weaknesses: c.weaknesses || [],
                misconceptions: c.misconceptions || [],
                suggestedAction: c.masteryScore < 30 ? 'RETEACH' : 'REVIEW',
                confidenceScore: Math.round(c.confidenceScore * 100) || 0
            }))
            .slice(0, 10);

        res.json({
            success: true,
            data: { weakConcepts }
        });
    } catch (error) {
        log.error('WEAK_CONCEPTS', `Failed to get weak concepts: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /student/next-topics
 * Get next recommended topics
 */
router.get('/next-topics', async (req, res) => {
    try {
        const userId = req.user._id;
        const subject = req.query.subject || 'DSA';
        const count = parseInt(req.query.count) || 5;

        const nextTopics = await learningPathEngine.getNextTopics(userId, subject, count);
        const progress = await learningPathEngine.getProgressPercentage(userId, subject);

        res.json({
            success: true,
            data: {
                nextTopics,
                subject,
                progressPercentage: progress
            }
        });
    } catch (error) {
        log.error('NEXT_TOPICS', `Failed to get next topics: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /student/learning-path
 * Get complete learning path
 */
router.get('/learning-path', async (req, res) => {
    try {
        const userId = req.user._id;
        const subject = req.query.subject || 'DSA';

        const path = await learningPathEngine.generateLearningPath(userId, subject);
        const progress = await learningPathEngine.getProgressPercentage(userId, subject);

        res.json({
            success: true,
            data: {
                path,
                subject,
                progressPercentage: progress,
                remainingTopics: path.length,
                completedPercentage: progress
            }
        });
    } catch (error) {
        log.error('LEARNING_PATH', `Failed to get learning path: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /student/update
 * Update student profile (called after learning sessions)
 * 
 * Body: {
 *   topic: string,
 *   correct: boolean,
 *   confidence: number (0-1),
 *   difficulty: 'low' | 'medium' | 'high',
 *   timeSeconds: number
 * }
 */
router.post('/update', async (req, res) => {
    try {
        const userId = req.user._id;
        const { topic, correct, confidence, difficulty, timeSeconds } = req.body;

        if (!topic || typeof correct !== 'boolean') {
            return res.status(400).json({
                success: false,
                message: 'topic and correct are required'
            });
        }

        // Update concept mastery
        await knowledgeAnalyzer.updateConceptMastery(userId, topic, {
            correct,
            confidence: confidence || 0.5,
            difficulty: difficulty || 'medium'
        });

        // Record learning event (invalidates speed cache)
        await learningSpeedDetector.recordLearningEvent(userId, {
            conceptName: topic,
            correct,
            timeSeconds: timeSeconds || 0
        });

        res.json({
            success: true,
            message: 'Profile updated successfully'
        });
    } catch (error) {
        log.error('UPDATE_PROFILE', `Failed to update profile: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /student/adaptive-plan/:topic
 * Get adaptive learning plan for a specific topic
 */
router.get('/adaptive-plan/:topic', async (req, res) => {
    try {
        const userId = req.user._id;
        const topic = req.params.topic;

        const plan = await adaptiveLearningEngine.getAdaptivePlan(userId, topic);

        // Check prerequisites
        const preReqCheck = await learningPathEngine.checkPrerequisites(userId, topic);

        res.json({
            success: true,
            data: {
                topic,
                adaptivePlan: plan,
                prerequisitesCheck: preReqCheck
            }
        });
    } catch (error) {
        log.error('ADAPTIVE_PLAN', `Failed to get adaptive plan: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /student/knowledge-analysis
 * Get AI-generated knowledge analysis patterns
 */
router.get('/knowledge-analysis', async (req, res) => {
    try {
        const userId = req.user._id;
        
        const analysis = await knowledgeAnalyzer.analyzePatterns(userId, []);

        res.json({
            success: true,
            data: analysis || {
                commonStruggles: [],
                strengthAreas: [],
                learningStyleInferred: 'unknown',
                adaptiveRecommendations: []
            }
        });
    } catch (error) {
        log.error('KNOWLEDGE_ANALYSIS', `Failed to analyze: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /student/curriculum/:subject
 * Get curriculum structure for a subject
 */
router.get('/curriculum/:subject', (req, res) => {
    try {
        const subject = req.params.subject.toUpperCase();
        const curriculum = learningPathEngine.getCurriculumStructure(subject);

        res.json({
            success: true,
            data: {
                subject,
                curriculum
            }
        });
    } catch (error) {
        log.error('CURRICULUM', `Failed to get curriculum: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
