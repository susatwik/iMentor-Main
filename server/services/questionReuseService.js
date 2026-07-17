const ConceptQuestion = require('../models/ConceptQuestion');
const semanticSimilarity = require('./semanticSimilarityService');

function normalizeText(value) {
  return String(value || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeQuestionRecord(question) {
  return {
    question_id: String(question?.question_id || ''),
    concept_id: String(question?.concept_id || ''),
    question_text: String(question?.question_text || ''),
    options: Array.isArray(question?.options) ? question.options : [],
    correct_answer: String(question?.correct_answer || ''),
    explanation: String(question?.explanation || ''),
    difficulty: String(question?.difficulty || 'medium').toLowerCase(),
    tags: Array.isArray(question?.tags) ? question.tags : [],
    usage_count: Number(question?.usage_count || question?.usageCount || 0),
    usageCount: Number(question?.usageCount || question?.usage_count || 0),
    last_used_at: question?.last_used_at || question?.lastUsedAt || null,
    lastUsedAt: question?.lastUsedAt || question?.last_used_at || null,
    source: String(question?.source || 'concept-question-bank')
  };
}

async function incrementQuestionUsage(questionId, delta = 1) {
  if (!questionId || !Number.isFinite(delta) || delta === 0) return null;
  return ConceptQuestion.updateOne(
    { question_id: String(questionId) },
    {
      $inc: { usage_count: delta, usageCount: delta },
      $set: { last_used_at: new Date(), lastUsedAt: new Date() }
    }
  ).catch(() => null);
}

async function findReusableQuestions({
  conceptId = null,
  subject = null,
  tags = [],
  questionText = '',
  limit = 5,
  similarityThreshold = 0.8
} = {}) {
  const normalizedQuestion = normalizeText(questionText);
  if (!conceptId) {
    console.log('[QUESTION REUSE LOOKUP]', {
      concept_id: null,
      question_bank_found: false,
      question_bank_source: 'blocked_missing_concept_id'
    });
    return [];
  }
  const query = { concept_id: String(conceptId) };

  const candidates = await ConceptQuestion.find(query).sort({ usage_count: -1, created_at: -1 }).lean();
  console.log('[QUESTION REUSE LOOKUP]', {
    concept_id: String(conceptId),
    question_bank_found: candidates.length > 0,
    question_bank_size: candidates.length,
    question_bank_source: 'ConceptQuestion'
  });
  if (candidates.length === 0) {
    return [];
  }

  const exact = candidates.filter(item => normalizeText(item.question_text) === normalizedQuestion);
  if (exact.length > 0) {
    return exact.slice(0, limit).map(normalizeQuestionRecord);
  }

  if (!questionText) {
    return candidates.slice(0, limit).map(normalizeQuestionRecord);
  }

  try {
    const existingTexts = candidates.map(item => item.question_text).filter(Boolean);
    const duplicateCheck = await semanticSimilarity.checkQuestionDuplicate(questionText, existingTexts, similarityThreshold);
    if (duplicateCheck.isDuplicate && duplicateCheck.matchedQuestion) {
      const matched = candidates.filter(item => normalizeText(item.question_text) === normalizeText(duplicateCheck.matchedQuestion));
      if (matched.length > 0) {
        return matched.slice(0, limit).map(normalizeQuestionRecord);
      }
    }
  } catch {
    // fall through to top usage-ranked candidates
  }

  return candidates.slice(0, limit).map(normalizeQuestionRecord);
}

async function validateQuestionUniqueness({
  questionText,
  conceptId = null,
  course = null,
  existingQuestions = [],
  threshold = 0.8
} = {}) {
  const normalized = normalizeText(questionText);
  if (!normalized) {
    return { duplicate: false, reason: 'empty-question', matchedQuestion: null, similarity: 0 };
  }

  const sameText = existingQuestions.find(q => normalizeText(q.question_text || q.question || q.text) === normalized);
  if (sameText) {
    return { duplicate: true, reason: 'exact', matchedQuestion: sameText.question_text || sameText.question || null, similarity: 1 };
  }

  try {
    const duplicateCheck = await semanticSimilarity.checkQuestionDuplicate(
      questionText,
      existingQuestions.map(q => q.question_text || q.question || q.text).filter(Boolean),
      threshold
    );
    if (duplicateCheck.isDuplicate) {
      return {
        duplicate: true,
        reason: 'semantic',
        matchedQuestion: duplicateCheck.matchedQuestion,
        similarity: duplicateCheck.similarity
      };
    }
  } catch (error) {
    return {
      duplicate: false,
      reason: `semantic-check-failed:${error.message}`,
      matchedQuestion: null,
      similarity: 0
    };
  }

  return {
    duplicate: false,
    reason: 'unique',
    matchedQuestion: null,
    similarity: 0
  };
}

module.exports = {
  normalizeText,
  findReusableQuestions,
  validateQuestionUniqueness,
  incrementQuestionUsage
};
