const { callWithFallback } = require('./llmFallbackService');
const log = require('../utils/logger');

const EVALUATION_SYSTEM_PROMPT = `You are an expert educational evaluator. Analyze the student's answer and return a structured evaluation.

Evaluate:
- correctness — is the answer factually correct?
- conceptual understanding — does the student grasp the underlying concept?
- reasoning quality — is the logic sound and well-structured?
- terminology usage — does the student use appropriate technical terms?
- confidence — how confident are you in this evaluation (0-1)?
- misconceptions — any incorrect beliefs revealed?
- explanation depth — superficial or deep?

Return valid JSON only. No markdown, no extra text:
{
  "score": 0-10,
  "blooms": "remember|understand|apply|analyze|evaluate",
  "strengths": ["strength1", "strength2"],
  "weaknesses": ["weakness1"],
  "misconceptions": ["misconception1"],
  "feedback": "constructive feedback string",
  "confidence": 0.0-1.0,
  "knowledgeGaps": ["gap1"]
}`;

function weightedEvaluation(question, userAnswer, modelAnswer, concepts, bloomLevel) {
  const normalized = userAnswer.toLowerCase().trim();
  const modelLower = (modelAnswer || '').toLowerCase();

  let coverageScore = 0;
  const conceptKeywords = (concepts || []);
  const matchedKeywords = conceptKeywords.filter(kw => normalized.includes(kw.toLowerCase()));
  coverageScore = conceptKeywords.length > 0
    ? Math.round((matchedKeywords.length / conceptKeywords.length) * 10)
    : 5;

  let keywordScore = 0;
  const modelWords = modelLower.split(/\s+/).filter(w => w.length > 3);
  const uniqueSignificant = [...new Set(modelWords)];
  const keywordMatches = uniqueSignificant.filter(w => normalized.includes(w));
  keywordScore = uniqueSignificant.length > 0
    ? Math.round((keywordMatches.length / Math.min(uniqueSignificant.length, 30)) * 10)
    : 5;

  const lengthScore = Math.min(10, Math.round(userAnswer.trim().split(/\s+/).length * 1.5));

  const modelTerms = (modelAnswer || '').match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [];
  const termMatches = modelTerms.filter(t => normalized.includes(t.toLowerCase()));
  const termScore = modelTerms.length > 0
    ? Math.round((termMatches.length / modelTerms.length) * 10)
    : 5;

  const rawScore = Math.round(
    coverageScore * 0.40 +
    keywordScore * 0.25 +
    lengthScore * 0.20 +
    termScore * 0.15
  );

  const score = Math.min(10, Math.max(0, rawScore));

  const bloomMap = ['remember', 'understand', 'apply', 'analyze', 'evaluate'];
  const bloomsIdx = bloomMap.indexOf(bloomLevel || 'understand');
  const demonstratedBloom = bloomsIdx >= 0
    ? bloomMap[Math.max(0, bloomsIdx - (score < 5 ? 1 : 0))]
    : 'understand';

  const strengths = [];
  const weaknesses = [];
  if (termMatches.length >= 2) strengths.push(`Used relevant terminology: ${termMatches.slice(0, 3).join(', ')}`);
  if (userAnswer.trim().split(/\s+/).length >= 20) strengths.push('Provided a detailed explanation');
  if (coverageScore >= 7) strengths.push('Covered key concepts effectively');
  if (keywordScore < 4) weaknesses.push('Missing key terminology from the expected answer');
  if (lengthScore < 4) weaknesses.push('Answer too brief — expand on your explanation');
  if (matchedKeywords.length < conceptKeywords.length) {
    const missing = conceptKeywords.filter(kw => !normalized.includes(kw.toLowerCase()));
    weaknesses.push(`Did not address: ${missing.slice(0, 3).join(', ')}`);
  }

  const feedback = score >= 8
    ? 'Strong answer demonstrating good understanding. Consider connecting concepts across topics.'
    : score >= 5
      ? 'Adequate answer with room for improvement. Focus on precision and completeness.'
      : 'Answer needs significant development. Review core concepts and try again with more detail.';

  return {
    score,
    blooms: demonstratedBloom,
    strengths,
    weaknesses,
    misconceptions: [],
    feedback,
    confidence: Math.round((score / 10) * 100) / 100,
    knowledgeGaps: weaknesses,
    source: 'weighted',
  };
}

async function aiEvaluation(question, userAnswer, modelAnswer, concepts, bloomLevel) {
  const userPrompt = `Evaluate this student answer:

Question: ${question}
Expected Answer (reference): ${modelAnswer || 'Not provided'}
Concepts being tested: ${(concepts || []).join(', ')}
Target Bloom's Level: ${bloomLevel || 'understand'}

Student Answer: ${userAnswer}

Return valid JSON with: score (0-10), blooms, strengths[], weaknesses[], misconceptions[], feedback, confidence (0-1), knowledgeGaps[]`;

  try {
    const providerHealth = require('./providerHealthCache');
    const healthyProviders = providerHealth.getHealthyProviders(['sglang', 'groq', 'gemini', 'openai', 'ollama']);
    const preferredProvider = healthyProviders.length > 0 ? healthyProviders[0] : 'ollama';
    const evalPromise = callWithFallback({
      userQuery: userPrompt,
      systemPrompt: EVALUATION_SYSTEM_PROMPT,
      chatHistory: [],
      preferredProvider,
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('AI evaluation timeout')), 10_000)
    );

    const response = await Promise.race([evalPromise, timeoutPromise]);

    const text = typeof response === 'string' ? response : (response.text || JSON.stringify(response));
    let parsed;
    try {
      const cleaned = text.replace(/```(?:json)?\s*/gi, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0].replace(/```(?:json)?\s*/gi, '').trim());
        } catch {
          return null;
        }
      } else {
        return null;
      }
    }

    if (typeof parsed.score !== 'number' || parsed.score < 0 || parsed.score > 10) return null;
    if (!Array.isArray(parsed.strengths)) parsed.strengths = [];
    if (!Array.isArray(parsed.weaknesses)) parsed.weaknesses = [];
    if (!Array.isArray(parsed.misconceptions)) parsed.misconceptions = [];

    parsed.source = 'ai';
    return parsed;
  } catch (err) {
    log.warn('AI_EVAL', `AI evaluation failed, will use weighted fallback: ${err.message}`);
    return null;
  }
}

async function evaluateAnswer(question, userAnswer, modelAnswer, concepts, bloomLevel) {
  if (!userAnswer || !userAnswer.trim()) {
    return {
      score: 0, blooms: 'remember',
      strengths: [], weaknesses: ['No answer provided'],
      misconceptions: [], feedback: 'No answer was submitted.',
      confidence: 1.0, knowledgeGaps: concepts || [],
      source: 'weighted',
    };
  }

  if (userAnswer.trim().length < 10) {
    return weightedEvaluation(question, userAnswer, modelAnswer, concepts, bloomLevel);
  }

  const aiResult = await aiEvaluation(question, userAnswer, modelAnswer, concepts, bloomLevel);

  if (aiResult) {
    log.info('AI_EVAL', `AI evaluation succeeded — score=${aiResult.score}, blooms=${aiResult.blooms}, confidence=${aiResult.confidence}`);
    return aiResult;
  }

  log.info('AI_EVAL', 'AI evaluation failed, using weighted fallback');
  const weighted = weightedEvaluation(question, userAnswer, modelAnswer, concepts, bloomLevel);
  weighted.source = 'weighted_fallback';
  return weighted;
}

module.exports = { evaluateAnswer, aiEvaluation, weightedEvaluation };
