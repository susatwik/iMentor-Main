const log = require('../utils/logger');
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { getCurriculumStructure } = require('../services/socraticTutorService');
// Note: authMiddleware is already applied at the mount point in server.js

/**
 * Continuously calculates and updates student's learning stage.
 * Based on: Quiz scores, concept mastery, and course completion.
 */
async function updateDynamicLearningStage(user, courseName) {
    if (!user.profile) user.profile = {};

    // 1. Quiz Scores
    const quizScores = user.profile.quizScores || [];
    let avgQuizScore = 50; // default/starting
    if (quizScores.length > 0) {
        const sum = quizScores.reduce((acc, q) => acc + q.score, 0);
        avgQuizScore = sum / quizScores.length;
    }

    // 2. Concept Mastery
    let masteredCount = 0;
    let totalConceptsEvaluated = 0;
    if (user.profile.conceptMastery) {
        const masteryMap = user.profile.conceptMastery instanceof Map
            ? user.profile.conceptMastery
            : new Map(Object.entries(user.profile.conceptMastery));
        totalConceptsEvaluated = masteryMap.size;
        for (const val of masteryMap.values()) {
            if (val >= 70) masteredCount++;
        }
    }

    // 3. Course Completion
    let completedSubtopicsCount = 0;
    if (user.curriculumProgress && courseName) {
        const progress = user.curriculumProgress.get(courseName);
        completedSubtopicsCount = progress?.completedSubtopics?.length || 0;
    }

    // Calculate score
    const masteryRatio = totalConceptsEvaluated > 0 ? (masteredCount / totalConceptsEvaluated) : 0;
    const completionScore = Math.min(100, completedSubtopicsCount * 5); // caps at 20 subtopics completed

    const adaptationScore = (avgQuizScore * 0.4) + (masteryRatio * 100 * 0.4) + (completionScore * 0.2);

    const oldStage = user.profile.learningStage || 'Beginner';
    let newStage = 'Beginner';

    if (adaptationScore >= 75 || avgQuizScore >= 85) {
        newStage = 'Advanced';
    } else if (adaptationScore >= 45 || avgQuizScore >= 60) {
        newStage = 'Intermediate';
    } else {
        newStage = 'Beginner';
    }

    user.profile.learningStage = newStage;
    user.profile.learningLevel = newStage.toUpperCase();
    user.markModified('profile');
    
    log.info('USER', `Learning stage dynamically updated from ${oldStage} to ${newStage} (Score: ${adaptationScore.toFixed(1)})`);
    return newStage;
}

/**
 * Automatically recalculates parent topic and module completion
 * when subtopics or topics are updated, and updates the overall course completion percentage.
 */
async function recalculateProgress(user, courseName) {
    const courseProgress = user.curriculumProgress.get(courseName);
    if (!courseProgress) return;

    try {
        const structure = await getCurriculumStructure(courseName);
        if (!structure || !structure.modules || structure.modules.length === 0) {
            return;
        }

        const completedSubtopics = courseProgress.completedSubtopics || [];
        const completedTopics = courseProgress.completedTopics || [];
        const completedModules = courseProgress.completedModules || [];

        let modified = false;

        // 1. Subtopics -> Topics completion
        structure.modules.forEach(m => {
            if (m.topics) {
                m.topics.forEach(t => {
                    if (t.subtopics && t.subtopics.length > 0) {
                        const allDone = t.subtopics.every(sub => completedSubtopics.includes(sub.id));
                        if (allDone && !completedTopics.includes(t.id)) {
                            completedTopics.push(t.id);
                            modified = true;
                        }
                    }
                });
            }
        });

        // 2. Topics -> Modules completion
        structure.modules.forEach(m => {
            if (m.topics && m.topics.length > 0) {
                const allDone = m.topics.every(t => completedTopics.includes(t.id));
                if (allDone && !completedModules.includes(m.id)) {
                    completedModules.push(m.id);
                    modified = true;
                }
            }
        });

        if (modified) {
            courseProgress.completedTopics = completedTopics;
            courseProgress.completedModules = completedModules;
            user.curriculumProgress.set(courseName, courseProgress);
            user.markModified('curriculumProgress');
        }
    } catch (err) {
        log.error('TUTOR', `Error in recalculateProgress: ${err.message}`);
    }
}


// @desc    Get curriculum progress for a specific course
// @route   GET /api/progress/:courseName
// @access  Private
router.get('/:courseName', async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const courseName = req.params.courseName;
        const progress = user.curriculumProgress ? user.curriculumProgress.get(courseName) : null;

        const parsedQuizResults = {};
        if (progress?.quizResults) {
            for (const [key, val] of progress.quizResults.entries()) {
                try {
                    parsedQuizResults[key] = typeof val === 'string' && (val.startsWith('{') || val.startsWith('"')) ? JSON.parse(val) : val;
                } catch (e) {
                    parsedQuizResults[key] = val;
                }
            }
        }

        res.status(200).json({
            success: true,
            progress: {
                completedTopics: progress?.completedTopics || [],
                completedModules: progress?.completedModules || [],
                completedSubtopics: progress?.completedSubtopics || [],
                quizResults: parsedQuizResults,
                quizIndex: progress?.quizIndex || 0
            }
        });
    } catch (error) {
        log.error('TUTOR', `Progress fetch error: ${error.message}`);
        res.status(500).json({ success: false, message: 'Server error fetching progress' });
    }
});

// @desc    Update quiz results and index
// @route   POST /api/progress/quiz
// @access  Private
router.post('/quiz', async (req, res) => {
    try {
        const { courseName, quizResults, quizIndex } = req.body;

        if (!courseName) {
            return res.status(400).json({ success: false, message: 'Missing courseName' });
        }

        // log.info('TUTOR', `Quiz progress update: ${courseName}`);

        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (!user.curriculumProgress) {
            user.curriculumProgress = new Map();
        }

        let courseProgress = user.curriculumProgress.get(courseName);
        if (!courseProgress) {
            courseProgress = {
                completedTopics: [],
                completedModules: [],
                completedSubtopics: [],
                quizResults: new Map(),
                quizIndex: 0
            };
        }

        if (quizResults !== undefined) {
            // Replace the results to allow for clearing/resetting
            const serializedResults = new Map();
            Object.entries(quizResults).forEach(([key, qRes]) => {
                if (qRes && typeof qRes === 'object') {
                    serializedResults.set(key, JSON.stringify(qRes));
                } else if (typeof qRes === 'string') {
                    serializedResults.set(key, qRes);
                }
            });
            courseProgress.quizResults = serializedResults;

            // Update user profile metrics
            if (!user.profile) user.profile = {};
            if (!user.profile.conceptMastery) user.profile.conceptMastery = new Map();
            if (!user.profile.strongTopics) user.profile.strongTopics = [];
            if (!user.profile.weakTopics) user.profile.weakTopics = [];
            if (!user.profile.quizScores) user.profile.quizScores = [];

            let correctCount = 0;
            let totalCount = 0;

            Object.entries(quizResults).forEach(([key, qRes]) => {
                if (qRes && typeof qRes === 'object') {
                    totalCount++;
                    const isCorrect = qRes.result === 'correct';
                    if (isCorrect) correctCount++;

                    const topic = qRes.topic;
                    if (topic) {
                        const cleanTopic = topic.replace(/\./g, '-');
                        let currentMastery = 50;
                        if (user.profile.conceptMastery instanceof Map) {
                            currentMastery = user.profile.conceptMastery.get(cleanTopic) || 50;
                        } else if (user.profile.conceptMastery && typeof user.profile.conceptMastery === 'object') {
                            currentMastery = user.profile.conceptMastery[cleanTopic] || 50;
                        }

                        let newMastery = isCorrect
                            ? Math.min(100, currentMastery + 15)
                            : Math.max(0, currentMastery - 10);

                        if (user.profile.conceptMastery instanceof Map) {
                            user.profile.conceptMastery.set(cleanTopic, newMastery);
                        } else {
                            user.profile.conceptMastery[cleanTopic] = newMastery;
                        }

                        if (newMastery >= 70) {
                            if (!user.profile.strongTopics.includes(topic)) {
                                user.profile.strongTopics.push(topic);
                            }
                            user.profile.weakTopics = user.profile.weakTopics.filter(t => t !== topic);
                        } else {
                            if (!user.profile.weakTopics.includes(topic)) {
                                user.profile.weakTopics.push(topic);
                            }
                            user.profile.strongTopics = user.profile.strongTopics.filter(t => t !== topic);
                        }
                    }
                }
            });

            if (totalCount > 0) {
                const overallScore = Math.round((correctCount / totalCount) * 100);

                // Find if there is a very recent attempt for this course (within last 30 minutes)
                const lastAttemptIndex = user.profile.quizScores.slice().reverse().findIndex(q => q.courseName === courseName);
                const actualIndex = lastAttemptIndex !== -1 ? user.profile.quizScores.length - 1 - lastAttemptIndex : -1;
                const lastAttempt = actualIndex !== -1 ? user.profile.quizScores[actualIndex] : null;

                const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

                if (lastAttempt && lastAttempt.date > thirtyMinutesAgo) {
                    // Update the existing recent attempt instead of pushing a new one
                    lastAttempt.score = overallScore;
                    lastAttempt.date = new Date();
                } else {
                    // Create a new attempt
                    user.profile.quizAttempts = (user.profile.quizAttempts || 0) + 1;
                    user.profile.quizScores.push({
                        courseName,
                        score: overallScore,
                        date: new Date()
                    });
                }

                const currentConf = user.profile.confidenceLevel || 50;
                user.profile.confidenceLevel = overallScore >= 70
                    ? Math.min(100, currentConf + 5)
                    : Math.max(0, currentConf - 5);

                user.profile.lastQuizDate = new Date();
            } else {
                // quizResults is empty (user reset the quiz)
                // Expire the last attempt's date so that the next question answer starts a new attempt
                const lastAttemptIndex = user.profile.quizScores.slice().reverse().findIndex(q => q.courseName === courseName);
                const actualIndex = lastAttemptIndex !== -1 ? user.profile.quizScores.length - 1 - lastAttemptIndex : -1;
                if (actualIndex !== -1) {
                    user.profile.quizScores[actualIndex].date = new Date(0);
                }
            }

            user.markModified('profile');
            await updateDynamicLearningStage(user, courseName);
        }

        if (quizIndex !== undefined) {
            courseProgress.quizIndex = quizIndex;
        }

        await recalculateProgress(user, courseName);
        user.curriculumProgress.set(courseName, courseProgress);
        user.markModified('curriculumProgress');
        await user.save();

        // Sync progress state to StudentKnowledgeState collection and Neo4j
        try {
            const knowledgeStateService = require('../services/knowledgeStateService');
            const knowledgeState = await knowledgeStateService.getOrCreateKnowledgeState(req.user.id);
            await knowledgeStateService.syncUserConceptMastery(req.user.id, knowledgeState);
        } catch (syncError) {
            log.error('TUTOR', 'Failed syncing progress to StudentKnowledgeState after quiz submit', syncError);
        }

        const parsedQuizResults = {};
        if (courseProgress.quizResults) {
            for (const [key, val] of courseProgress.quizResults.entries()) {
                try {
                    parsedQuizResults[key] = typeof val === 'string' && (val.startsWith('{') || val.startsWith('"')) ? JSON.parse(val) : val;
                } catch (e) {
                    parsedQuizResults[key] = val;
                }
            }
        }

        res.status(200).json({
            success: true,
            quizResults: parsedQuizResults,
            quizIndex: courseProgress.quizIndex
        });

    } catch (error) {
        log.error('TUTOR', `Quiz progress update failure: ${error.message}`);
        res.status(500).json({ success: false, message: 'Server error updating quiz progress' });
    }
});

// @desc    Update progress (mark items as completed)
// @route   POST /api/progress/update
// @access  Private
router.post('/update', async (req, res) => {
    try {
        const { courseName, type, id } = req.body; // type: 'module', 'topic', 'subtopic'

        if (!courseName || !type || (!id && type !== 'sync')) {
            return res.status(400).json({ success: false, message: 'Missing fields' });
        }

        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Initialize map if it doesn't exist
        if (!user.curriculumProgress) {
            user.curriculumProgress = new Map();
        }

        // Get or create progress object for this course
        let courseProgress = user.curriculumProgress.get(courseName);
        if (!courseProgress) {
            courseProgress = {
                completedTopics: [],
                completedModules: [],
                completedSubtopics: []
            };
        }

        // Initialize arrays if they don't exist in the retrieved object (safety check)
        if (!courseProgress.completedTopics) courseProgress.completedTopics = [];
        if (!courseProgress.completedModules) courseProgress.completedModules = [];
        if (!courseProgress.completedSubtopics) courseProgress.completedSubtopics = [];

        let updated = false;

        // Add ID if not already present
        if (type === 'topic') {
            if (!courseProgress.completedTopics.includes(id)) {
                courseProgress.completedTopics.push(id);
                updated = true;
            }
        } else if (type === 'module') {
            if (!courseProgress.completedModules.includes(id)) {
                courseProgress.completedModules.push(id);
                updated = true;
            }
        } else if (type === 'subtopic') {
            if (!courseProgress.completedSubtopics.includes(id)) {
                courseProgress.completedSubtopics.push(id);
                updated = true;
            }
        } else if (type === 'sync') {
            // Replace (not merge) — allows clearing progress by passing empty arrays
            const { completedTopics, completedModules, completedSubtopics } = req.body;
            if (Array.isArray(completedTopics)) courseProgress.completedTopics = [...new Set(completedTopics)];
            if (Array.isArray(completedModules)) courseProgress.completedModules = [...new Set(completedModules)];
            if (Array.isArray(completedSubtopics)) courseProgress.completedSubtopics = [...new Set(completedSubtopics)];
            updated = true;
        }

        if (updated) {
            await recalculateProgress(user, courseName);
            user.curriculumProgress.set(courseName, courseProgress);
            user.markModified('curriculumProgress');
            await user.save();

            // Sync progress state to StudentKnowledgeState collection and Neo4j
            try {
                const knowledgeStateService = require('../services/knowledgeStateService');
                const knowledgeState = await knowledgeStateService.getOrCreateKnowledgeState(req.user.id);
                await knowledgeStateService.syncUserConceptMastery(req.user.id, knowledgeState);
            } catch (syncError) {
                log.error('TUTOR', 'Failed syncing progress to StudentKnowledgeState', syncError);
            }
        }

        res.status(200).json({
            success: true,
            progress: courseProgress
        });

    } catch (error) {
        log.error('TUTOR', `Progress update failure: ${error.message}`);
        res.status(500).json({ success: false, message: 'Server error updating progress' });
    }
});

module.exports = router;
