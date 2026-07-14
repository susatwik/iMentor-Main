const express = require('express');
const router = express.Router();
const QuestionBank = require('../models/QuestionBank');
const log = require('../utils/logger');

// @route   GET /api/question-bank
// @desc    List all questions, optionally filtered by course/difficulty/bloom
router.get('/', async (req, res) => {
    try {
        const { course, difficulty, bloomLevel, type, limit = 50, offset = 0 } = req.query;
        const filter = {};
        if (course) filter.course = { $regex: new RegExp(course, 'i') };
        if (difficulty) filter.difficulty = difficulty;
        if (bloomLevel) filter.bloomLevel = bloomLevel;
        if (type) filter.type = type;

        const [questions, total] = await Promise.all([
            QuestionBank.find(filter).sort({ course: 1, difficulty: 1 }).skip(+offset).limit(+limit).lean(),
            QuestionBank.countDocuments(filter),
        ]);

        res.json({ success: true, questions, total, offset: +offset, limit: +limit });
    } catch (err) {
        log.error('DB', `QuestionBank list failed: ${err.message}`);
        res.status(500).json({ success: false, message: err.message });
    }
});

// @route   GET /api/question-bank/courses
// @desc    List distinct courses that have questions
router.get('/courses', async (req, res) => {
    try {
        const courses = await QuestionBank.distinct('course');
        res.json({ success: true, courses });
    } catch (err) {
        log.error('DB', `QuestionBank courses failed: ${err.message}`);
        res.status(500).json({ success: false, message: err.message });
    }
});

// @route   GET /api/question-bank/:course
// @desc    Get questions for a specific course
router.get('/:course', async (req, res) => {
    try {
        const { course } = req.params;
        const { difficulty, bloomLevel, type, limit = 100 } = req.query;

        const filter = { course: { $regex: new RegExp(`^${escapeRegex(course)}$`, 'i') } };
        if (difficulty) filter.difficulty = difficulty;
        if (bloomLevel) filter.bloomLevel = bloomLevel;
        if (type) filter.type = type;

        const questions = await QuestionBank.find(filter).sort({ difficulty: 1, bloomLevel: 1 }).limit(+limit).lean();
        res.json({ success: true, course, questions, total: questions.length });
    } catch (err) {
        log.error('DB', `QuestionBank fetch for course failed: ${err.message}`);
        res.status(500).json({ success: false, message: err.message });
    }
});

// @route   POST /api/question-bank
// @desc    Add one or more questions to the QuestionBank
router.post('/', async (req, res) => {
    try {
        const { questions } = req.body;
        if (!questions || !Array.isArray(questions) || questions.length === 0) {
            return res.status(400).json({ success: false, message: 'questions array is required' });
        }

        const result = await QuestionBank.insertMany(
            questions.map(q => ({
                type: q.type || 'mcq',
                question: q.question,
                options: q.options || [],
                correctAnswer: q.correctAnswer || '',
                explanation: q.explanation || '',
                difficulty: q.difficulty || 'beginner',
                bloomLevel: q.bloomLevel || 'understand',
                skillNodeId: q.skillNodeId || '',
                course: q.course || '',
                module: q.module || '',
                topic: q.topic || '',
                subtopic: q.subtopic || '',
                tags: q.tags || [],
            }))
        );

        log.info('DB', `Inserted ${result.length} questions into QuestionBank`);
        res.json({ success: true, inserted: result.length });
    } catch (err) {
        log.error('DB', `QuestionBank insert failed: ${err.message}`);
        res.status(500).json({ success: false, message: err.message });
    }
});

// @route   DELETE /api/question-bank/:id
// @desc    Delete a question by ID
router.delete('/:id', async (req, res) => {
    try {
        const result = await QuestionBank.findByIdAndDelete(req.params.id);
        if (!result) return res.status(404).json({ success: false, message: 'Question not found' });
        res.json({ success: true, message: 'Question deleted' });
    } catch (err) {
        log.error('DB', `QuestionBank delete failed: ${err.message}`);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── Concept Question Bank Routes ───────────────────────────────────────

// @route   POST /api/question-bank/concept/generate
// @desc    Generate concept question bank for a specific concept (20-50 MCQs)
router.post('/concept/generate', async (req, res) => {
  try {
    const { course, concept, topic, moduleName } = req.body;
    if (!course || !concept) {
      return res.status(400).json({ success: false, message: 'course and concept are required' });
    }
    const conceptQbService = require('../services/conceptQuestionBankService');
    const questions = await conceptQbService.ensureQuestionsForConcept({
      course, concept, topic, moduleName, forceGenerate: true,
    });
    log.info('CONCEPT_QB', `Generated ${questions.length} questions for ${course}/${concept}`);
    res.json({ success: true, total: questions.length, concept, course });
  } catch (err) {
    log.error('CONCEPT_QB', `Generate failed: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route   GET /api/question-bank/concept/:course/:concept
// @desc    Get questions for a specific concept from the concept bank
router.get('/concept/:course/:concept', async (req, res) => {
  try {
    const { course, concept } = req.params;
    const { limit = 10, shuffle } = req.query;
    const ConceptQuestionBank = require('../models/ConceptQuestionBank');

    let query = ConceptQuestionBank.find({
      course: { $regex: new RegExp(escapeRegex(course), 'i') },
      concept: { $regex: new RegExp(escapeRegex(concept), 'i') },
    });

    if (shuffle === 'true') {
      query = query.sort({ usageCount: 1, lastUsedAt: 1 });
    } else {
      query = query.sort({ createdAt: -1 });
    }

    const questions = await query.limit(+limit || 10).lean();
    const total = await ConceptQuestionBank.countDocuments({
      course: { $regex: new RegExp(escapeRegex(course), 'i') },
      concept: { $regex: new RegExp(escapeRegex(concept), 'i') },
    });

    res.json({ success: true, questions, total });
  } catch (err) {
    log.error('CONCEPT_QB', `Fetch failed: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route   GET /api/question-bank/concept/analytics
// @desc    Get analytics for concept question bank
router.get('/concept/analytics', async (req, res) => {
  try {
    const { concept, course } = req.query;
    const conceptQbService = require('../services/conceptQuestionBankService');
    const analytics = await conceptQbService.getQuestionAnalytics(concept, course);
    res.json({ success: true, analytics });
  } catch (err) {
    log.error('CONCEPT_QB', `Analytics failed: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route   DELETE /api/question-bank/concept/:id
// @desc    Delete a concept bank question by ID
router.delete('/concept/:id', async (req, res) => {
  try {
    const ConceptQuestionBank = require('../models/ConceptQuestionBank');
    const result = await ConceptQuestionBank.findByIdAndDelete(req.params.id);
    if (!result) return res.status(404).json({ success: false, message: 'Question not found' });
    res.json({ success: true, message: 'Question deleted' });
  } catch (err) {
    log.error('CONCEPT_QB', `Delete failed: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
});

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = router;
