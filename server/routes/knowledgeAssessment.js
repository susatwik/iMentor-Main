const express = require('express');
const router = express.Router();
const knowledgeAssessment = require('../services/knowledgeAssessmentService');
const log = require('../utils/logger');

router.post('/generate', async (req, res) => {
  try {
    const { course, module, topic } = req.body;
    if (!topic && !course) {
      return res.status(400).json({ message: 'Provide a course or topic for the assessment' });
    }
    const result = await knowledgeAssessment.generateDiagnosticAssessment({
      course, module, topic, userId: req.user?._id,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    log.error('ASSESS_ROUTE', `Generate error: ${error.message}`);
    res.status(500).json({ message: 'Failed to generate assessment', error: error.message });
  }
});

router.post('/submit', async (req, res) => {
  try {
    const { responses, topic, course, weakAreas, strengths } = req.body;
    if (!responses || !Array.isArray(responses) || responses.length === 0) {
      return res.status(400).json({ message: 'Responses array is required' });
    }
    const result = await knowledgeAssessment.evaluateAndClassify({
      responses, topic: topic || course, course, userId: req.user?._id, weakAreas, strengths,
    });
    res.json(result);
  } catch (error) {
    log.error('ASSESS_ROUTE', `Submit error: ${error.message}`);
    res.status(500).json({ message: 'Failed to evaluate assessment', error: error.message });
  }
});

router.get('/profile', async (req, res) => {
  try {
    const { topic } = req.query;
    const readiness = await knowledgeAssessment.generateLearningReadiness(req.user?._id, topic);
    const history = await knowledgeAssessment.getAssessmentHistory(req.user?._id, topic);
    res.json({ readiness, history });
  } catch (error) {
    log.error('ASSESS_ROUTE', `Profile error: ${error.message}`);
    res.status(500).json({ message: 'Failed to load profile', error: error.message });
  }
});

router.get('/history', async (req, res) => {
  try {
    const { topic } = req.query;
    const result = await knowledgeAssessment.getAssessmentHistory(req.user?._id, topic);
    res.json(result);
  } catch (error) {
    log.error('ASSESS_ROUTE', `History error: ${error.message}`);
    res.status(500).json({ message: 'Failed to load history', error: error.message });
  }
});

router.get('/blooms-taxonomy', async (req, res) => {
  try {
    const { topic } = req.query;
    const history = await knowledgeAssessment.getAssessmentHistory(req.user?._id, topic);
    const assessments = history.assessments || [];

    const bloomLevels = ['remember', 'understand', 'apply', 'analyze', 'evaluate'];
    const aggregated = bloomLevels.map(level => {
      const scores = assessments
        .filter(a => a.bloomProfile && a.bloomProfile[level])
        .map(a => a.bloomProfile[level].score);
      return {
        level,
        averageScore: scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
        assessmentsAttempted: scores.length,
        highestScore: scores.length > 0 ? Math.max(...scores) : 0,
      };
    });

    res.json({ bloomLevels: aggregated, totalAssessments: assessments.length });
  } catch (error) {
    log.error('ASSESS_ROUTE', `Bloom taxonomy error: ${error.message}`);
    res.status(500).json({ message: 'Failed to load Bloom\'s taxonomy data', error: error.message });
  }
});

module.exports = router;
