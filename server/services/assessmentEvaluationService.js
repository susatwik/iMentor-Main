const { safeParseLLMJson } = require('../utils/safeParseLLMJson');
const { LLMRouter } = require('./llmRouterService');

function normalizeText(value) {
  return String(value || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function buildRuleBasedAssessment({ gradingDetails = [], weightedScore = 0, maxPossibleWeightedScore = 0, rawScore = 0 }) {
  const total = Array.isArray(gradingDetails) ? gradingDetails.length : 0;
  const scorePercent = maxPossibleWeightedScore > 0
    ? Math.round((weightedScore / maxPossibleWeightedScore) * 100)
    : 0;
  const difficultyWeight = maxPossibleWeightedScore > 0
    ? Number((weightedScore / maxPossibleWeightedScore).toFixed(2))
    : 0;

  const level = rawScore >= Math.max(5, Math.ceil(total * 0.8))
    ? 'Expert'
    : rawScore >= Math.max(4, Math.ceil(total * 0.6))
      ? 'Advanced'
      : rawScore >= Math.max(2, Math.ceil(total * 0.4))
        ? 'Intermediate'
        : 'Beginner';

  const correctCount = gradingDetails.filter(item => item?.correct).length;
  const wrongCount = gradingDetails.length - correctCount;

  return {
    level,
    score: rawScore,
    maxScore: total,
    difficultyWeight,
    feedback: wrongCount > 0
      ? 'Review the missed concepts and try a few more practice questions.'
      : 'Excellent work. Your answers show strong understanding.',
    reasoning: `Rule-based fallback used because AI evaluation was unavailable. ${correctCount}/${gradingDetails.length} answers were correct.`,
    recommendation: level === 'Beginner'
      ? 'Revisit foundational material before moving on.'
      : level === 'Intermediate'
        ? 'Practice mixed difficulty questions to strengthen consistency.'
        : 'Move to more advanced and application-based questions.'
  };
}

function buildRepositoryMatchAssessment({ gradingDetails = [], weightedScore = 0, maxPossibleWeightedScore = 0, rawScore = 0 }) {
  const result = buildRuleBasedAssessment({
    gradingDetails,
    weightedScore,
    maxPossibleWeightedScore,
    rawScore
  });
  return {
    ...result,
    feedback: 'Assessment matched against the repository answer bank.',
    reasoning: `Repository answer match resolved the assessment using ${gradingDetails.length} graded responses.`
  };
}

async function evaluateAssessmentSubmission({
  topic,
  gradingDetails = [],
  weightedScore = 0,
  maxPossibleWeightedScore = 0,
  rawScore = 0,
  userId = null
}) {
  const scorePercent = maxPossibleWeightedScore > 0
    ? Math.round((weightedScore / maxPossibleWeightedScore) * 100)
    : 0;
  const difficultyWeight = maxPossibleWeightedScore > 0
    ? Number((weightedScore / maxPossibleWeightedScore).toFixed(2))
    : 0;

  const prompt = `You are an educational assessment evaluator.

Evaluate the learner's knowledge level.

Consider:

* difficulty of questions
* correctness of answers
* evidence of advanced understanding
* weaknesses revealed by mistakes

Return JSON only:

{
"level":"Beginner|Intermediate|Advanced|Expert",
"confidence":0-100,
"reasoning":"short explanation",
"strengths":[],
"weakAreas":[],
"feedback":"short actionable feedback",
"recommendation":"one actionable next step"
}`;

  const payload = { topic, scorePercent, gradingDetails };
  let fallbackReason = null;

  try {
    const responseText = await Promise.race([
      LLMRouter.generate({
        query: `${prompt}\n\nAssessment data:\n${JSON.stringify(payload)}`,
        systemPrompt: null,
        chatHistory: [],
        userId,
        deepResearchContext: false
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Assessment agent timeout')), 60000))
    ]);

    const parsed = safeParseLLMJson(
      typeof responseText === 'string' ? responseText : JSON.stringify(responseText),
      { topic }
    );

    const allowedLevels = new Set(['Beginner', 'Intermediate', 'Advanced', 'Expert']);
    const level = typeof parsed?.level === 'string' ? parsed.level.trim() : '';
    const confidence = Number(parsed?.confidence);
    const reasoning = typeof parsed?.reasoning === 'string' ? parsed.reasoning.trim() : '';
    const feedback = typeof parsed?.feedback === 'string' ? parsed.feedback.trim() : '';
    const recommendation = typeof parsed?.recommendation === 'string' ? parsed.recommendation.trim() : '';
    const strengths = Array.isArray(parsed?.strengths)
      ? parsed.strengths.map(item => String(item).trim()).filter(Boolean)
      : [];
    const weakAreas = Array.isArray(parsed?.weakAreas)
      ? parsed.weakAreas.map(item => String(item).trim()).filter(Boolean)
      : [];

    if (!allowedLevels.has(level)) throw new Error('Invalid assessment level');
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) throw new Error('Invalid assessment confidence');

    return {
      evaluationMethod: 'agent',
      fallbackReason: null,
      level,
      confidence,
      reasoning,
      strengths,
      weakAreas,
      feedback: feedback || 'Assessment completed successfully.',
      recommendation: recommendation || 'Continue with slightly more advanced practice.',
      score: rawScore,
      maxScore: gradingDetails.length,
      difficultyWeight,
      scorePercent
    };
  } catch (error) {
    fallbackReason = error.message;
  }

  // Repository answer match fallback.
  if (gradingDetails.length > 0 && gradingDetails.every(item => normalizeText(item.correctAnswer))) {
    const repositoryMatch = buildRepositoryMatchAssessment({
      gradingDetails,
      weightedScore,
      maxPossibleWeightedScore,
      rawScore
    });
    return {
      evaluationMethod: 'repository_match',
      fallbackReason,
      ...repositoryMatch,
      confidence: 72,
      strengths: gradingDetails.filter(d => d.correct).map(d => d.question.substring(0, 50) + '...'),
      weakAreas: gradingDetails.filter(d => !d.correct).map(d => d.question.substring(0, 50) + '...')
    };
  }

  const ruleBased = buildRuleBasedAssessment({
    gradingDetails,
    weightedScore,
    maxPossibleWeightedScore,
    rawScore
  });

  return {
    evaluationMethod: 'rule_based',
    fallbackReason,
    ...ruleBased,
    confidence: 55,
    strengths: gradingDetails.filter(d => d.correct).map(d => d.question.substring(0, 50) + '...'),
    weakAreas: gradingDetails.filter(d => !d.correct).map(d => d.question.substring(0, 50) + '...')
  };
}

module.exports = {
  evaluateAssessmentSubmission
};
