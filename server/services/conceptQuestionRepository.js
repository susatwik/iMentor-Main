const ConceptQuestion = require('../models/ConceptQuestion');
const QuestionUsage = require('../models/QuestionUsage');
const { validateQuestionUniqueness, incrementQuestionUsage } = require('./questionReuseService');

function normalizeString(v, fallback = '') {
  return v == null ? fallback : String(v);
}

function uniq(arr) {
  return Array.from(new Set((arr || []).map(x => String(x)).filter(Boolean)));
}

const QUESTION_DIFFICULTY_MAP = {
  easy: 'easy',
  medium: 'medium',
  hard: 'hard',
  beginner: 'easy',
  intermediate: 'medium',
  advanced: 'hard',
  expert: 'expert',
  boss: 'boss'
};

function normalizeQuestionDifficulty(difficulty, fallback = 'medium') {
  const key = String(difficulty || '').toLowerCase().trim();
  return QUESTION_DIFFICULTY_MAP[key] || fallback;
}

async function createQuestion(questionDoc) {
  if (!questionDoc) throw new Error('createQuestion requires questionDoc');
  const {
    question_id,
    concept_id,
    question_text,
    options,
    correct_answer,
    explanation,
    difficulty,
    bloom_level,
    tags,
    createdBy,
    version
  } = questionDoc;

  if (!question_id || !concept_id || !question_text) {
    throw new Error('createQuestion requires question_id, concept_id, question_text');
  }

  const doc = {
    question_id: String(question_id),
    concept_id: String(concept_id),
    conceptId: String(concept_id),
    question_text: normalizeString(question_text).trim(),
    question: normalizeString(question_text).trim(),
    options: Array.isArray(options) ? options.map(o => normalizeString(o)).filter(Boolean) : [],
    correct_answer: normalizeString(correct_answer),
    answer: normalizeString(correct_answer),
    explanation: normalizeString(explanation),
    source: normalizeString(questionDoc.source, 'concept-question-bank'),
    difficulty: normalizeQuestionDifficulty(difficulty, 'medium'),
    bloom_level: bloom_level || undefined,
    tags: uniq(tags),
    createdBy: normalizeString(createdBy),
    version: Number.isFinite(version) ? Number(version) : 1
  };

  return ConceptQuestion.findOneAndUpdate(
    { question_id: doc.question_id },
    { $setOnInsert: doc },
    { upsert: true, new: true }
  );
}

async function getQuestionById(question_id) {
  if (!question_id) return null;
  return ConceptQuestion.findOne({ question_id: String(question_id) }).lean();
}

async function getQuestionsByConcept(concept_id) {
  if (!concept_id) return [];
  return ConceptQuestion.find({ concept_id: String(concept_id) }).sort({ created_at: -1 }).lean();
}

async function getReusableQuestionsByConcept({ concept_id, question_text, limit = 5, threshold = 0.8 }) {
  if (!concept_id) return [];
  const questions = await getQuestionsByConcept(concept_id);
  if (questions.length === 0) return [];
  const uniqueness = await validateQuestionUniqueness({
    questionText: question_text,
    conceptId: concept_id,
    existingQuestions: questions,
    threshold
  });
  if (uniqueness.duplicate) {
    return questions
      .filter(q => String(q.question_text || '').trim().toLowerCase() === String(uniqueness.matchedQuestion || '').trim().toLowerCase())
      .slice(0, limit);
  }
  return questions.slice(0, limit);
}

async function getQuestionsByDifficulty(difficulty, concept_id = null) {
  if (!difficulty) return [];
  const query = { difficulty: normalizeQuestionDifficulty(difficulty, 'medium') };
  if (concept_id) {
    query.concept_id = String(concept_id);
  }
  return ConceptQuestion.find(query).sort({ created_at: -1 }).lean();
}

async function markQuestionUsage({ question_id, concept_id, usage_context, usage_metadata, userId }) {
  if (!question_id || !concept_id || !usage_context) {
    throw new Error('markQuestionUsage requires question_id, concept_id, usage_context');
  }
  const uid = userId != null ? String(userId) : String(usage_metadata?.userId || '');
  return QuestionUsage.create({
    question_id: String(question_id),
    concept_id: String(concept_id),
    userId: uid,
    usage_context: String(usage_context),
    usage_metadata: usage_metadata || {}
  });
}

async function getSeenQuestionIdsForUser({ userId, concept_id }) {
  if (!userId || !concept_id) return [];
  return QuestionUsage.find({
    userId: String(userId),
    concept_id: String(concept_id)
  }).distinct('question_id');
}

async function recordQuestionsServedToUser({ userId, concept_id, questions, usage_context = 'skill-tree-level' }) {
  if (!userId || !concept_id || !Array.isArray(questions) || questions.length === 0) return;
  const uid = String(userId);
  const docs = questions
    .map(q => q?.question_id)
    .filter(Boolean)
    .map(question_id => ({
      question_id: String(question_id),
      concept_id: String(concept_id),
      userId: uid,
      usage_context,
      usage_metadata: { userId: uid }
    }));
  if (docs.length === 0) return;
  await QuestionUsage.insertMany(docs, { ordered: false }).catch(() => {});
  await Promise.all(docs.map(doc => incrementQuestionUsage(doc.question_id, 1))).catch(() => {});
}

module.exports = {
  createQuestion,
  getQuestionsByConcept,
  getReusableQuestionsByConcept,
  getQuestionsByDifficulty,
  getQuestionById,
  markQuestionUsage,
  getSeenQuestionIdsForUser,
  recordQuestionsServedToUser
};
