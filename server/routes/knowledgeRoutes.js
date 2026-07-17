// server/routes/knowledgeRoutes.js
// Extracted from chat.js — Student knowledge state endpoints
const express = require('express');
const router = express.Router();
const log = require('../utils/logger');
const knowledgeStateService = require('../services/knowledgeStateService');

// @route   GET /api/chat/knowledge-state
// @desc    Get student's knowledge state (long-term memory profile)
// @access  Private
router.get('/knowledge-state', async (req, res) => {
    const userId = req.user._id;

    try {
        const knowledgeState = await knowledgeStateService.getOrCreateKnowledgeState(userId);

        const summary = knowledgeState.generateQuickSummary();
        const strugglingConcepts = knowledgeState.getStrugglingConcepts();
        const masteredConcepts = knowledgeState.getMasteredConcepts();

        res.status(200).json({
            success: true,
            summary,
            textSummary: knowledgeState.knowledgeSummary,
            strugglingConcepts: strugglingConcepts.map(c => ({
                conceptName: c.conceptName,
                masteryScore: c.masteryScore,
                difficulty: c.difficulty,
                misconceptions: c.misconceptions
            })),
            masteredConcepts: masteredConcepts.map(c => ({
                conceptName: c.conceptName,
                masteryScore: c.masteryScore
            })),
            learningProfile: knowledgeState.learningProfile,
            currentFocusAreas: knowledgeState.currentFocusAreas,
            recurringStruggles: knowledgeState.recurringStruggles,
            sessionInsights: knowledgeState.sessionInsights,
            recommendations: knowledgeState.recommendations.filter(r => !r.actedUpon)
        });
    } catch (error) {
        log.error('DB', 'Fetch knowledge state failed', error);
        res.status(500).json({ message: 'Failed to retrieve knowledge state' });
    }
});

// @route   POST /api/chat/knowledge-state/reset
// @desc    Reset student's knowledge state (privacy control)
// @access  Private
router.post('/knowledge-state/reset', async (req, res) => {
    const userId = req.user._id;

    try {
        const StudentKnowledgeState = require('../models/StudentKnowledgeState');
        await StudentKnowledgeState.findOneAndDelete({ userId });

        res.status(200).json({
            success: true,
            message: 'Your learning memory has been reset successfully'
        });
    } catch (error) {
        log.error('DB', 'Reset knowledge state failed', error);
        res.status(500).json({ message: 'Failed to reset knowledge state' });
    }
});

// @route   GET /api/chat/knowledge-state/export
// @desc    Export student's knowledge state (privacy control)
// @access  Private
router.get('/knowledge-state/export', async (req, res) => {
    const userId = req.user._id;

    try {
        const knowledgeState = await knowledgeStateService.getOrCreateKnowledgeState(userId);

        res.status(200).json({
            success: true,
            data: {
                exportedAt: new Date().toISOString(),
                userId: userId.toString(),
                learningProfile: knowledgeState.learningProfile,
                concepts: knowledgeState.concepts,
                masteredTopics: knowledgeState.masteredTopics,
                recurringStruggles: knowledgeState.recurringStruggles,
                sessionInsights: knowledgeState.sessionInsights,
                engagementMetrics: knowledgeState.engagementMetrics,
                recommendations: knowledgeState.recommendations
            }
        });
    } catch (error) {
        log.error('DB', 'Export knowledge state failed', error);
        res.status(500).json({ message: 'Failed to export knowledge state' });
    }
});

module.exports = router;
