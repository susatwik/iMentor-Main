// server/routes/learning.js
const express = require('express');
const router = express.Router();
const { redisClient } = require('../config/redisClient');
const axios = require('axios');
const socraticService = require('../services/socraticLearningService');
const { authMiddleware } = require('../middleware/authMiddleware');
const log = require('../utils/logger');
 
// ===== EXISTING LEARNING ROUTES =====
 
// @route   GET /api/learning/recommendations/:sessionId
// @desc    Get cached recommendations for a new session.
// @access  Private
router.get('/recommendations/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const cacheKey = `recommendations:${sessionId}`;
 
    try {
        if (redisClient && redisClient.isOpen) {
            const cachedData = await redisClient.get(cacheKey);
  
            console.log(`[Learning Route] GET recommendations for session ${sessionId}:`);
            console.log(`  - Cache Key: ${cacheKey}`);
            console.log(`  - Data from Redis: ${cachedData ? cachedData.substring(0, 100) + '...' : 'null'}`);
 
            if (cachedData) {
                console.log(`[Learning Route] Cache HIT for recommendations on session ${sessionId}.`);
                await redisClient.del(cacheKey);
                return res.status(200).json({ recommendations: JSON.parse(cachedData) });
            }
        }
        console.log(`[Learning Route] Cache MISS for recommendations on session ${sessionId}.`);
        res.status(200).json({ recommendations: [] });
    } catch (error) {
        console.error(`Error fetching recommendations from cache for session ${sessionId}:`, error);
        res.status(500).json({ message: 'Server error retrieving recommendations.' });
    }
});
  
// @route   POST /api/learning/find-document
// @desc    Perform a JIT RAG search for a recommended topic.
// @access  Private
router.post('/find-document', async (req, res) => {
    const { topic } = req.body;
    const userId = req.user._id.toString();
  
    if (!topic) {
        return res.status(400).json({ message: 'Topic is required.' });
    }
 
    const pythonServiceUrl = process.env.PYTHON_RAG_SERVICE_URL;
    if (!pythonServiceUrl) {
        return res.status(500).json({ message: 'RAG service is not configured.' });
    }
    const searchUrl = `${pythonServiceUrl}/query`;
 
    try {
        console.log(`[Learning Route] Performing JIT RAG search for topic: "${topic}" for user ${userId}`);
        const response = await axios.post(searchUrl, {
            query: topic,
            user_id: userId,
            k: 1
        });
 
        const docs = response.data?.retrieved_documents_list;
        if (docs && docs.length > 0) {
            const bestDoc = docs[0].metadata?.file_name || docs[0].metadata?.original_name;
            if (bestDoc) {
                return res.status(200).json({ documentName: bestDoc });
            }
        }
 
        res.status(404).json({ message: 'No relevant document could be found for that topic.' });
  
    } catch (error) {
        const errorMsg = error.response?.data?.error || error.message;
        console.error(`[Learning Route] RAG search failed for topic "${topic}":`, errorMsg);
        res.status(500).json({ message: 'Failed to find a relevant document.' });
    }
});
 
// ===== NEW SOCRATIC LEARNING ROUTES =====
 
// @route   GET /api/learning/progress/:userId
// @desc    Get student's learning progress and adaptive metrics
// @access  Private
router.get('/progress/:userId',authMiddleware, async (req, res) => {
  try {
    const progress = await socraticService.getStudentProgress(req.params.userId);
    if (!progress) {
      return res.status(404).json({ error: 'Student profile not found' });
    }
    res.json(progress);
  } catch (err) {
    log.error('SOCRATIC', `Progress fetch failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});
 
// @route   POST /api/learning/record-answer
// @desc    Record student answer and update performance metrics
// @access  Private
router.post('/record-answer',authMiddleware, async (req, res) => {
  try {
    const { userId, subtopicId, subtopicName, isCorrect } = req.body;
    
    if (!userId || !subtopicId || !subtopicName || isCorrect === undefined) {
      return res.status(400).json({ error: 'Missing required fields: userId, subtopicId, subtopicName, isCorrect' });
    }
    
    const result = await socraticService.recordAnswer(userId, subtopicId, subtopicName, isCorrect);
    log.info('SOCRATIC', `Recorded answer for ${subtopicName}: ${isCorrect ? 'CORRECT' : 'INCORRECT'}`);
    res.json(result);
  } catch (err) {
    log.error('SOCRATIC', `Record answer failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});
 
// @route   GET /api/learning/adaptive-prompt/:userId/:subtopicId/:subtopicName
// @desc    Get adaptive system prompt based on student performance
// @access  Private
router.get('/adaptive-prompt/:userId/:subtopicId/:subtopicName',authMiddleware, async (req, res) => {
  try {
    const { userId, subtopicId, subtopicName } = req.params;
    const decodedSubtopicName = decodeURIComponent(subtopicName);
    
    const prompt = await socraticService.getAdaptivePrompt(userId, subtopicId, decodedSubtopicName);
    if (!prompt) {
      return res.status(404).json({ error: 'Could not generate adaptive prompt' });
    }
    
    res.json({ systemPrompt: prompt });
  } catch (err) {
    log.error('SOCRATIC', `Adaptive prompt failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});
 
// @route   POST /api/learning/init-profile
// @desc    Initialize student learning profile for a course/subject
// @access  Private
router.post('/init-profile', authMiddleware, async (req, res) => {
  try {
    const { userId, courseId, subject } = req.body;
    
    if (!userId || !courseId || !subject) {
      return res.status(400).json({ error: 'Missing required fields: userId, courseId, subject' });
    }
    
    const profile = await socraticService.getOrCreateProfile(userId, courseId, subject);
    log.info('SOCRATIC', `Initialized profile for user ${userId} in course ${courseId}`);
    res.json(profile);
  } catch (err) {
    log.error('SOCRATIC', `Profile init failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});
 
module.exports = router;
 
 