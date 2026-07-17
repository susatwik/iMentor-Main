const express = require('express');
const router = express.Router();
const socraticTutorService = require('../services/socraticTutorService');
const { authMiddleware } = require('../middleware/authMiddleware');

/**
 * @route   POST /api/tutor/start
 * @desc    Initialize a Socratic tutor session for a topic
 * @access  Private
 */
router.post('/start', authMiddleware, async (req, res) => {
  const { topic, context, llmConfig, position } = req.body;

  if (!topic) {
    return res.status(400).json({ error: 'Topic is required to start a session.' });
  }

  try {
    const response = await socraticTutorService.startSocraticSession(topic, context, llmConfig, position);
    res.status(200).json({ response });
  } catch (error) {
    console.error('[Tutor Route] Start failed:', error);
    res.status(500).json({ error: error.message || 'Failed to start tutor session.' });
  }
});

/**
 * @route   POST /api/tutor/message
 * @desc    Process a student message and return an adaptive response
 * @access  Private
 */
router.post('/message', authMiddleware, async (req, res) => {
  const { message, sessionId, llmConfig } = req.body;

  if (!message || !sessionId) {
    return res.status(400).json({ error: 'Message and sessionId are required.' });
  }

  try {
    const result = await socraticTutorService.processTutorResponse(
      message,
      sessionId,
      llmConfig,
      (progress) => {
        console.log(`[Tutor ${sessionId}] ${progress}`);
      }
    );

    if (!result) {
      return res.status(404).json({ error: 'Session not found or expired.' });
    }

    res.status(200).json(result);
  } catch (error) {
    console.error('[Tutor Route] Message failed:', error);
    res.status(500).json({ error: error.message || 'Failed to process tutor message.' });
  }
});

module.exports = router;
