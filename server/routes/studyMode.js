// server/routes/studyMode.js
/**
 * Study Mode API Routes
 * ─────────────────────
 * Provides endpoints for:
 *   GET  /api/study-mode/questions/:course/:subtopicId   — retrieve cached question bank
 *   POST /api/study-mode/questions/:course/:subtopicId   — (re)generate questions on-demand
 *   GET  /api/study-mode/skill-tree/:course              — retrieve skill tree JSON
 *   POST /api/study-mode/skill-tree/:course              — (re)generate skill tree on-demand
 *
 * All heavy computation is delegated to the Python RAG service.
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const log = require('../utils/logger');

const RAG_URL = process.env.PYTHON_RAG_SERVICE_URL || 'http://127.0.0.1:2001';
const RAG_TIMEOUT = parseInt(process.env.RAG_TIMEOUT_MS || '30000', 10);

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Decode URL-encoded course name and normalise it.
 * e.g. "Machine%20Learning" → "Machine Learning"
 */
function decodeCourse(raw) {
  return decodeURIComponent(raw).trim();
}

function ragError(res, err, fallbackMsg) {
  const status = err?.response?.status || 502;
  const message = err?.response?.data?.detail || err?.message || fallbackMsg;
  log.error('StudyMode', `RAG proxy error: ${message}`);
  return res.status(status).json({ success: false, error: message });
}

// ─── Study Questions ──────────────────────────────────────────────────────────

/**
 * @route   GET /api/study-mode/questions/:course/:subtopicId
 * @desc    Retrieve cached study questions (MCQ + SA + flashcards) for a subtopic.
 *          Returns { success, cached, data } where data has .mcq, .short_answer, .flashcards
 * @access  Private
 */
router.get('/questions/:course/:subtopicId', async (req, res) => {
  const course = decodeCourse(req.params.course);
  const { subtopicId } = req.params;

  try {
    const { data } = await axios.get(
      `${RAG_URL}/study-questions/${encodeURIComponent(course)}/${encodeURIComponent(subtopicId)}`,
      { timeout: RAG_TIMEOUT }
    );
    return res.json(data);
  } catch (err) {
    return ragError(res, err, 'Failed to retrieve study questions.');
  }
});

/**
 * @route   POST /api/study-mode/questions/:course/:subtopicId
 * @desc    Trigger on-demand (re)generation of study questions for one subtopic.
 *          Body: { topicId, topicName, subtopicName, teachingContext?, force? }
 * @access  Private
 */
router.post('/questions/:course/:subtopicId', async (req, res) => {
  const course = decodeCourse(req.params.course);
  const { subtopicId } = req.params;
  const {
    topicId,
    topicName,
    subtopicName,
    teachingContext = '',
    force = false,
  } = req.body;

  if (!topicId || !topicName || !subtopicName) {
    return res.status(400).json({
      success: false,
      error: 'topicId, topicName, and subtopicName are required.',
    });
  }

  try {
    const { data } = await axios.post(
      `${RAG_URL}/study-questions/subtopic`,
      {
        course,
        topic_id: topicId,
        topic_name: topicName,
        subtopic_id: subtopicId,
        subtopic_name: subtopicName,
        teaching_context: teachingContext,
        force,
      },
      { timeout: RAG_TIMEOUT }
    );
    return res.json(data);
  } catch (err) {
    return ragError(res, err, 'Failed to generate study questions.');
  }
});

/**
 * @route   POST /api/study-mode/questions/:course/batch
 * @desc    Trigger background generation of study questions for ALL subtopics.
 *          Body: { modules: [...], delay?: number }
 * @access  Private
 */
router.post('/questions/:course/batch', async (req, res) => {
  const course = decodeCourse(req.params.course);
  const { modules, delay = 1.0 } = req.body;

  if (!Array.isArray(modules) || modules.length === 0) {
    return res.status(400).json({ success: false, error: 'modules array is required.' });
  }

  try {
    const { data } = await axios.post(
      `${RAG_URL}/study-questions/course`,
      { course, modules, delay },
      { timeout: RAG_TIMEOUT }
    );
    return res.json(data);
  } catch (err) {
    return ragError(res, err, 'Failed to start batch study-questions generation.');
  }
});

// ─── Skill Tree ───────────────────────────────────────────────────────────────

/**
 * @route   GET /api/study-mode/skill-tree/:course
 * @desc    Retrieve the cached skill tree for a course.
 *          Returns { success, cached, data: [ { subtopic_id, prerequisites,
 *            unlocks, difficulty_score, skill_level, estimated_study_hours,
 *            learning_outcomes } ] }
 * @access  Private
 */
router.get('/skill-tree/:course', async (req, res) => {
  const course = decodeCourse(req.params.course);

  try {
    const { data } = await axios.get(
      `${RAG_URL}/skill-tree/${encodeURIComponent(course)}`,
      { timeout: RAG_TIMEOUT }
    );
    return res.json(data);
  } catch (err) {
    return ragError(res, err, 'Failed to retrieve skill tree.');
  }
});

/**
 * @route   POST /api/study-mode/skill-tree/:course
 * @desc    Trigger (re)generation of the skill tree for a course.
 *          Body: { modules: [...], force?: boolean }
 * @access  Private
 */
router.post('/skill-tree/:course', async (req, res) => {
  const course = decodeCourse(req.params.course);
  const { modules, force = false } = req.body;

  if (!Array.isArray(modules) || modules.length === 0) {
    return res.status(400).json({ success: false, error: 'modules array is required.' });
  }

  try {
    const { data } = await axios.post(
      `${RAG_URL}/skill-tree/generate`,
      { course, modules, force },
      { timeout: RAG_TIMEOUT }
    );
    return res.json(data);
  } catch (err) {
    return ragError(res, err, 'Failed to generate skill tree.');
  }
});

module.exports = router;
