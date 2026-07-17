const { callWithFallback } = require('./llmFallbackService');
const { evaluateAnswer } = require('./aiEvaluationService');
const log = require('../utils/logger');

const BLOOM_LEVELS = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'];
const BLOOM_WEIGHTS = {
  remember: 1.0,
  understand: 1.5,
  apply: 2.0,
  analyze: 2.5,
  evaluate: 3.0,
  create: 3.5,
};

const DIFFICULTY_WEIGHTS = {
  easy: 1.0,
  medium: 1.5,
  hard: 2.0,
};

const MAX_BLOOM_WEIGHT = Math.max(...Object.values(BLOOM_WEIGHTS));
const MAX_DIFFICULTY_WEIGHT = Math.max(...Object.values(DIFFICULTY_WEIGHTS));

// Agent-based evaluation combining LLM + weighted analysis
async function agentEvaluate({ question, userAnswer, correctAnswer, modelAnswer, concepts, bloomLevel, difficulty, type }) {
  // For MCQ, give highest weight to basic evaluator (exact letter match)
  // For descriptive, give highest weight to LLM + keyword evaluators
  const isMcq = type === 'mcq';
  const agents = isMcq ? [
    { name: 'basic', fn: () => basicEvaluate(question, userAnswer, correctAnswer, modelAnswer, type), weight: 0.7 },
    { name: 'keyword', fn: () => keywordEvaluate(question, userAnswer, modelAnswer, concepts, bloomLevel), weight: 0.2 },
    { name: 'llm', fn: () => llmEvaluate(question, userAnswer, modelAnswer, concepts, bloomLevel), weight: 0.1 },
  ] : [
    { name: 'llm', fn: () => llmEvaluate(question, userAnswer, modelAnswer, concepts, bloomLevel), weight: 0.6 },
    { name: 'keyword', fn: () => keywordEvaluate(question, userAnswer, modelAnswer, concepts, bloomLevel), weight: 0.3 },
    { name: 'basic', fn: () => basicEvaluate(question, userAnswer, correctAnswer, modelAnswer, type), weight: 0.1 },
  ];

  let combinedScore = 0;
  let combinedConfidence = 0;
  let totalWeight = 0;
  let usedSource = 'none';
  let basicCorrect = null; // Track basic evaluator's binary result
  const allFindings = { strengths: [], weaknesses: [], misconceptions: [], feedback: '' };

  for (const agent of agents) {
    try {
      const result = await agent.fn();
      if (result && result.score !== undefined && result.confidence > 0) {
        const confidenceWeight = result.confidence * agent.weight;
        combinedScore += result.score * confidenceWeight;
        combinedConfidence += result.confidence * confidenceWeight;
        totalWeight += confidenceWeight;

        if (agent.name === 'basic' && result.correct !== undefined) {
          basicCorrect = result.correct;
        }

        if (result.strengths) allFindings.strengths.push(...result.strengths);
        if (result.weaknesses) allFindings.weaknesses.push(...result.weaknesses);
        if (result.misconceptions) allFindings.misconceptions.push(...result.misconceptions);
        if (result.feedback) allFindings.feedback = result.feedback;

        if (agent.weight > 0.3) usedSource = result.source || agent.name;
      }
    } catch (e) {
      log.warn('EVAL_AGENT', `Agent ${agent.name} failed: ${e.message}`);
    }
  }

  const finalScore = totalWeight > 0 ? Math.round((combinedScore / totalWeight) * 10) / 10 : 0;
  const finalConfidence = totalWeight > 0 ? Math.round((combinedConfidence / totalWeight) * 100) / 100 : 0;

  // Apply Bloom × difficulty weight multiplier
  const bloomWeight = BLOOM_WEIGHTS[bloomLevel] || 1.0;
  const difficultyWeight = DIFFICULTY_WEIGHTS[difficulty] || 1.0;
  const weightedMultiplier = 0.5 + (bloomWeight / MAX_BLOOM_WEIGHT) * 0.25 + (difficultyWeight / MAX_DIFFICULTY_WEIGHT) * 0.25;
  const weightedScore = Math.min(10, Math.round(finalScore * weightedMultiplier * 10) / 10);

  return {
    score: weightedScore,
    rawScore: finalScore,
    confidence: finalConfidence,
    weightedMultiplier,
    bloomWeight,
    difficultyWeight,
    basicCorrect,
    strengths: [...new Set(allFindings.strengths)].slice(0, 5),
    weaknesses: [...new Set(allFindings.weaknesses)].slice(0, 5),
    misconceptions: [...new Set(allFindings.misconceptions)].slice(0, 3),
    feedback: allFindings.feedback || assessmentFeedback(weightedScore),
    source: usedSource,
    agentsUsed: agents.filter(a => a.weight > 0).map(a => a.name),
  };
}

async function llmEvaluate(question, userAnswer, modelAnswer, concepts, bloomLevel) {
  try {
    const result = await evaluateAnswer(question, userAnswer, modelAnswer, concepts, bloomLevel);
    if (result && result.score !== undefined) {
      result.source = 'ai';
      return result;
    }
    return null;
  } catch {
    return null;
  }
}

function keywordEvaluate(question, userAnswer, modelAnswer, concepts, bloomLevel) {
  const normalized = (userAnswer || '').toLowerCase().trim();
  const modelLower = (modelAnswer || '').toLowerCase();

  if (!normalized) {
    return { score: 0, confidence: 1.0, strengths: [], weaknesses: ['No answer provided'], misconceptions: [], feedback: 'No answer was submitted.', source: 'keyword' };
  }

  const conceptKeywords = (concepts || []).filter(c => c);
  const matchedKeywords = conceptKeywords.filter(kw => normalized.includes(kw.toLowerCase()));
  const coverageScore = conceptKeywords.length > 0 ? (matchedKeywords.length / conceptKeywords.length) * 10 : 5;

  const modelWords = modelLower.split(/\s+/).filter(w => w.length > 3);
  const uniqueSignificant = [...new Set(modelWords)];
  const keywordMatches = uniqueSignificant.filter(w => normalized.includes(w));
  const keywordScore = uniqueSignificant.length > 0 ? (keywordMatches.length / Math.min(uniqueSignificant.length, 30)) * 10 : 5;

  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  const lengthScore = Math.min(10, wordCount * 1.5);

  const rawScore = coverageScore * 0.40 + keywordScore * 0.25 + lengthScore * 0.20 + (Math.min(10, keywordMatches.length * 2)) * 0.15;
  const score = Math.min(10, Math.max(0, Math.round(rawScore * 10) / 10));
  const confidence = Math.min(1.0, (coverageScore / 10) * 0.5 + (keywordScore / 10) * 0.3 + 0.2);

  const strengths = [];
  const weaknesses = [];
  if (matchedKeywords.length >= 2) strengths.push(`Covers concepts: ${matchedKeywords.slice(0, 3).join(', ')}`);
  if (wordCount >= 20) strengths.push('Provides thorough explanation');
  if (keywordMatches.length >= 3) strengths.push('Uses appropriate terminology');
  if (keywordScore < 4) weaknesses.push('Missing key terminology');
  if (wordCount < 8) weaknesses.push('Answer too brief — expand for full credit');
  if (conceptKeywords.length > matchedKeywords.length) {
    const missing = conceptKeywords.filter(kw => !normalized.includes(kw.toLowerCase())).slice(0, 3);
    weaknesses.push(`Missing concepts: ${missing.join(', ')}`);
  }

  return {
    score, confidence,
    strengths, weaknesses,
    misconceptions: [],
    feedback: assessmentFeedback(score),
    source: 'keyword',
  };
}

function basicEvaluate(question, userAnswer, correctAnswer, modelAnswer, type) {
  if (type === 'mcq' && correctAnswer) {
    const userChoice = (userAnswer || '').trim().charAt(0).toUpperCase();
    const correctChoice = (correctAnswer || '').trim().charAt(0).toUpperCase();
    const correct = userChoice === correctChoice;
    return {
      correct,
      score: correct ? 10 : 0,
      confidence: 0.8,
      strengths: correct ? ['Correct answer'] : [],
      weaknesses: correct ? [] : ['Incorrect answer'],
      misconceptions: [],
      feedback: correct ? 'Correct.' : 'Incorrect.',
      source: 'basic',
    };
  }
  return null;
}

function assessmentFeedback(score) {
  if (score >= 9) return 'Excellent answer demonstrating deep understanding.';
  if (score >= 7) return 'Good answer with solid understanding. Minor improvements possible.';
  if (score >= 5) return 'Adequate answer. Review key concepts and add more detail.';
  if (score >= 3) return 'Partial understanding shown. Significant gaps remain.';
  return 'Answer needs substantial improvement. Review foundational concepts.';
}

// Compute weighted score from evaluation results for skill placement
function computeWeightedScore(evaluation, questionMeta) {
  const bloomWeight = BLOOM_WEIGHTS[questionMeta.bloomLevel || 'understand'] || 1.0;
  const difficultyWeight = DIFFICULTY_WEIGHTS[questionMeta.difficulty || 'medium'] || 1.5;

  const questionScore = evaluation.score / 10;

  const weightedContribution = questionScore * bloomWeight * difficultyWeight;
  const maxContribution = 10 * bloomWeight * difficultyWeight;

  return {
    weightedScore: Math.round(weightedContribution * 100) / 100,
    maxWeightedScore: Math.round(maxContribution * 100) / 100,
    normalizedScore: maxContribution > 0 ? Math.round((weightedContribution / maxContribution) * 100) : 0,
    bloomLevel: questionMeta.bloomLevel,
    difficulty: questionMeta.difficulty,
    confidence: evaluation.confidence,
  };
}

// ── Evaluation Agent: AI-powered level determination ──────────────────
// Determines learner's starting level by analyzing concept mastery,
// Bloom level, difficulty, confidence, and learning objectives.
// Falls back to weighted scoring (Bloom × difficulty) if agent fails.

async function determineLevelWithAgent({ responses, course, topic }) {
  const gradingDetails = (responses || []).map(r => ({
    question: r.question,
    bloomLevel: r.bloomLevel || 'understand',
    difficulty: r.difficulty || 'medium',
    concepts: r.concepts || [],
    correct: r.correct === true,
    confidence: r.confidence || 0.8,
    learningObjective: r.learningObjective || '',
    score: r.score || 0,
  }));

  try {
    const { callWithFallback } = require('./llmFallbackService');
    const prompt = `You are an expert educational evaluator determining a learner's knowledge level.

Assessment Context:
- Course: ${course || 'Unknown'}
- Topic: ${topic || 'Unknown'}
- Total Questions: ${gradingDetails.length}

Performance Data:
${JSON.stringify(gradingDetails.map(g => ({
  bloomLevel: g.bloomLevel,
  difficulty: g.difficulty,
  concepts: g.concepts,
  correct: g.correct,
  confidence: g.confidence,
  learningObjective: g.learningObjective ? g.learningObjective.substring(0, 100) : '',
})), null, 2)}

Analyze the learner's performance considering:
1. Concept Mastery — which concepts were correct vs incorrect
2. Bloom's Taxonomy Level — are they answering higher-order questions correctly?
3. Difficulty Distribution — do they handle hard questions?
4. Confidence — how reliable is the assessment data?
5. Learning Objectives — which objectives are met vs missed?

Return ONLY valid JSON:
{
  "level": "Beginner|Intermediate|Advanced|Expert",
  "confidence": 0-100,
  "reasoning": "brief explanation focusing on concept mastery, bloom levels, and difficulty",
  "conceptMastery": { "mastered": ["concept1"], "developing": ["concept2"], "needsWork": ["concept3"] },
  "recommendation": "actionable next step for the learner"
}`;

    const providerHealth = require('./providerHealthCache');
    const healthyProviders = providerHealth.getHealthyProviders(['sglang', 'groq', 'gemini', 'openai', 'ollama']);
    const preferredProvider = healthyProviders.length > 0 ? healthyProviders[0] : 'sglang';
    const result = await callWithFallback({
      userQuery: prompt,
      systemPrompt: 'You are an expert educational evaluator. Return ONLY valid JSON.',
      chatHistory: [],
      preferredProvider,
      options: { temperature: 0.3, maxOutputTokens: 1024, timeout: 30000 },
    });

    const text = typeof result?.text === 'string' ? result.text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in LLM response');

    const parsed = JSON.parse(jsonMatch[0]);
    const allowed = new Set(['Beginner', 'Intermediate', 'Advanced', 'Expert']);
    const level = allowed.has(parsed.level) ? parsed.level : null;
    if (!level) throw new Error(`Invalid level: ${parsed.level}`);

    log.info('EVAL_AGENT', `Agent determined level: ${level} (confidence: ${parsed.confidence}) for ${topic}`);
    return {
      level,
      confidence: Math.min(100, Math.max(0, parseInt(parsed.confidence) || 0)),
      reasoning: parsed.reasoning || '',
      conceptMastery: parsed.conceptMastery || { mastered: [], developing: [], needsWork: [] },
      recommendation: parsed.recommendation || '',
      source: result?.provider || 'unknown',
    };
  } catch (err) {
    log.warn('EVAL_AGENT', `Agent level determination failed: ${err.message}. Falling back to weighted scoring.`);
    return null;
  }
}

function determineLevelWeighted(gradingDetails) {
  let totalWeightedScore = 0;
  let totalMaxWeightedScore = 0;

  for (const g of gradingDetails) {
    const bloomWeight = BLOOM_WEIGHTS[g.bloomLevel || 'understand'] || 1.0;
    const difficultyWeight = DIFFICULTY_WEIGHTS[g.difficulty || 'medium'] || 1.5;
    const questionScore = g.correct ? 10 : 0;
    totalWeightedScore += questionScore * bloomWeight * difficultyWeight;
    totalMaxWeightedScore += 10 * bloomWeight * difficultyWeight;
  }

  const weightedPercent = totalMaxWeightedScore > 0
    ? Math.round((totalWeightedScore / totalMaxWeightedScore) * 100)
    : 0;

  let level = 'Beginner';
  if (weightedPercent >= 85) level = 'Expert';
  else if (weightedPercent >= 65) level = 'Advanced';
  else if (weightedPercent >= 40) level = 'Intermediate';

  log.info('EVAL_AGENT', `Weighted fallback level: ${level} (weighted: ${weightedPercent}%)`);
  return { level, weightedPercent };
}

// Main entry point: evaluate all responses and return assessment results
async function evaluateAssessment({ responses, course, topic }) {
  const gradingDetails = [];
  const agentResults = [];
  let totalWeightedScore = 0;
  let totalMaxScore = 0;

  for (const r of responses) {
    const evalResult = await agentEvaluate({
      question: r.question,
      userAnswer: r.userAnswer || r.answer || '',
      correctAnswer: r.correctAnswer,
      modelAnswer: r.modelAnswer,
      concepts: r.concepts || [],
      bloomLevel: r.bloomLevel || 'understand',
      difficulty: r.difficulty || 'medium',
      type: r.type || 'mcq',
    });

    const isMcq = r.type === 'mcq';
    const isCorrectThreshold = isMcq
      ? (evalResult.basicCorrect === true)
      : evalResult.score >= 5;

    // For MCQ correct answers, use full score for weighted calculation
    const adjustedScore = (isMcq && evalResult.basicCorrect === true) ? 10 : evalResult.score;
    const weighted = computeWeightedScore({ ...evalResult, score: adjustedScore }, r);
    totalWeightedScore += weighted.weightedScore;
    totalMaxScore += weighted.maxWeightedScore;

    gradingDetails.push({
      question: r.question,
      userAnswer: r.userAnswer || r.answer || '',
      correct: isCorrectThreshold,
      score: evalResult.score,
      bloomLevel: r.bloomLevel || 'understand',
      difficulty: r.difficulty || 'medium',
      confidence: evalResult.confidence,
      weightedScore: weighted.weightedScore,
      maxWeightedScore: weighted.maxWeightedScore,
      explanation: evalResult.feedback,
      strengths: evalResult.strengths,
      weaknesses: evalResult.weaknesses,
      misconceptions: evalResult.misconceptions,
      source: evalResult.source,
    });

    agentResults.push(evalResult);
  }

  const weightedPercent = totalMaxScore > 0 ? Math.round((totalWeightedScore / totalMaxScore) * 100) : 0;
  const rawCorrectCount = gradingDetails.filter(g => g.correct).length;
  const rawPercent = gradingDetails.length > 0 ? Math.round((rawCorrectCount / gradingDetails.length) * 100) : 0;

  // Level determination: try AI agent first, fall back to weighted scoring
  let level = 'Beginner';
  let levelSource = 'weighted_fallback';
  let levelConfidence = 0;
  let levelReasoning = '';
  let conceptMasteryResult = { mastered: [], developing: [], needsWork: [] };

  const agentResult = await determineLevelWithAgent({
    responses: responses.map(r => ({
      ...r,
      correct: gradingDetails.find(g => g.question === r.question)?.correct || false,
    })),
    course,
    topic,
  });

  if (agentResult) {
    level = agentResult.level;
    levelSource = 'evaluation_agent';
    levelConfidence = agentResult.confidence;
    levelReasoning = agentResult.reasoning;
    conceptMasteryResult = agentResult.conceptMastery || { mastered: [], developing: [], needsWork: [] };
  } else {
    const weighted = determineLevelWeighted(gradingDetails);
    level = weighted.level;
    levelSource = 'weighted_scoring';
  }

  // Collect strengths/weaknesses across all evaluations
  const allStrengths = [...new Set(agentResults.flatMap(r => r.strengths || []))].slice(0, 5);
  const allWeaknesses = [...new Set(agentResults.flatMap(r => r.weaknesses || []))].slice(0, 5);
  const allMisconceptions = [...new Set(agentResults.flatMap(r => r.misconceptions || []))].slice(0, 3);

  // Bloom profile
  const bloomScores = {};
  BLOOM_LEVELS.forEach(l => { bloomScores[l] = { correct: 0, total: 0 }; });
  for (const g of gradingDetails) {
    const bl = BLOOM_LEVELS.includes(g.bloomLevel) ? g.bloomLevel : 'understand';
    bloomScores[bl].total++;
    if (g.correct) bloomScores[bl].correct++;
  }

  const highestBloomAttempted = [...BLOOM_LEVELS].reverse().find(l => bloomScores[l].total > 0) || 'understand';

  // Build concept mastery map from agent output + bloom profile
  const conceptMastery = {};
  if (conceptMasteryResult.mastered?.length) {
    conceptMasteryResult.mastered.forEach(c => {
      conceptMastery[c] = { mastery: 90, needsReview: false };
    });
  }
  if (conceptMasteryResult.developing?.length) {
    conceptMasteryResult.developing.forEach(c => {
      conceptMastery[c] = { mastery: 60, needsReview: false };
    });
  }
  if (conceptMasteryResult.needsWork?.length) {
    conceptMasteryResult.needsWork.forEach(c => {
      conceptMastery[c] = { mastery: 25, needsReview: true };
    });
  }

  return {
    level,
    levelSource,
    levelConfidence,
    levelReasoning,
    score: rawCorrectCount,
    maxScore: gradingDetails.length,
    scorePercent: rawPercent,
    weightedPercent,
    overallPercentage: rawPercent,
    confidence: Math.round(agentResults.reduce((a, r) => a + r.confidence, 0) / agentResults.length * 100),
    bloomProfile: Object.fromEntries(
      Object.entries(bloomScores).map(([l, v]) => [l, {
        score: v.total > 0 ? Math.round(v.correct / v.total * 100) : 0,
        mastered: v.total > 0 && v.correct === v.total,
        attempted: v.total,
      }])
    ),
    conceptMastery,
    highestBloomLevel: highestBloomAttempted,
    strengths: allStrengths,
    weakAreas: allWeaknesses,
    misconceptions: allMisconceptions,
    feedback: gradingDetails.map(g => `${g.question.substring(0, 50)}... Score: ${g.score}/10`).join('\n'),
    recommendation: levelSource === 'evaluation_agent' && levelReasoning
      ? levelReasoning
      : weightedPercent >= 70 ? 'Ready to advance to next topic.' : 'Review weak areas before proceeding.',
    proficiencyLevel: level,
    suggestedRevisionTopics: allWeaknesses,
    learningReadiness: weightedPercent >= 40 ? 'ready' : 'needs_preparation',
    gradingDetails,
    sourcesUsed: [...new Set(gradingDetails.map(g => g.source))],
  };
}

module.exports = {
  agentEvaluate,
  computeWeightedScore,
  evaluateAssessment,
  determineLevelWithAgent,
  determineLevelWeighted,
};
