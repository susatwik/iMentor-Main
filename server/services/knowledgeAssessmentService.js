const { callWithFallback } = require('./llmFallbackService');
const { evaluateAssessment } = require('./evaluationAgentService');
const AssessmentResult = require('../models/AssessmentResult');
const StudentKnowledgeState = require('../models/StudentKnowledgeState');
const QuestionBank = require('../models/QuestionBank');
const log = require('../utils/logger');
const { runQuery: neo4jRun } = require('../config/neo4j');

async function fetchCurriculumConcepts(course) {
  try {
    const result = await neo4jRun(
      `MATCH (m:Module)
       WHERE toLower(m.course) = toLower($course)
       OPTIONAL MATCH (m)-[:HAS_TOPIC]->(t:Topic)
       OPTIONAL MATCH (s:Subtopic)-[:PREREQUISITE_OF]->(t)
       RETURN COLLECT(DISTINCT m.name) AS modules,
              COLLECT(DISTINCT t.name) AS topics,
              COLLECT(DISTINCT s.name) AS subtopics`,
      { course }
    );
    if (result.records && result.records.length > 0) {
      const row = result.records[0].toObject();
      const all = [...(row.modules || []), ...(row.topics || []), ...(row.subtopics || [])]
        .filter(Boolean)
        .filter(n => n.length > 3 && !/^\d/.test(n));
      return [...new Set(all)];
    }
  } catch (e) {
    log.warn('KNOWLEDGE_ASSESS', `Neo4j curriculum fetch failed: ${e.message}`);
  }
  return [];
}

async function reuseOrGenerateQuestions({ course, module, topic, count = 5 }) {
  const searchTerm = topic || course || '';

  // 1. Reuse from Question Bank first
  if (searchTerm) {
    try {
      const filter = { course: { $regex: new RegExp(`^${escapeRegex(searchTerm)}$`, 'i') } };
      const existing = await QuestionBank.find(filter).sort({ difficulty: 1, bloomLevel: 1 }).lean();
      if (existing.length >= count) {
        const shuffled = existing.sort(() => Math.random() - 0.5).slice(0, count);
        log.info('KNOWLEDGE_ASSESS', `Reused ${shuffled.length} questions from Question Bank for "${searchTerm}"`);
        return shuffled.map((q, i) => ({
          id: `qb_${i}_${Date.now()}`,
          question: q.question,
          type: q.type || 'mcq',
          options: q.options || [],
          bloomLevel: q.bloomLevel || 'understand',
          difficulty: q.difficulty || 'medium',
          concepts: q.tags || q.concepts || [],
          correctAnswer: q.correctAnswer || '',
          modelAnswer: q.explanation || '',
        }));
      }
    } catch (qbErr) {
      log.warn('KNOWLEDGE_ASSESS', `Question Bank query failed: ${qbErr.message}`);
    }
  }

  return null;
}

async function generateDiagnosticAssessment({ course, module, topic, userId }) {
  // 1. Try Question Bank reuse
  const reused = await reuseOrGenerateQuestions({ course, module, topic });
  if (reused) {
    const now = new Date().toISOString();
    return {
      questions: reused, course, topic,
      source: 'question_bank',
      generatedBy: 'database',
      model: 'question_bank',
      pipelineVersion: 'v2',
      generatedAt: now,
      _source: 'question_bank',
    };
  }

  // 2. Try unified pipeline (Redis → MongoDB → Provider Chain → Template)
  try {
    const cg = require('./contentGenerationService');
    const result = await cg.generateOrRetrieveAssessment(course || topic, topic, userId);
    if (result && result.questions && result.questions.length > 0) {
      const questions = result.questions.map((q, i) => ({
        id: `assess_${i}_${Date.now()}`,
        question: q.question,
        type: 'mcq',
        options: q.options || [],
        bloomLevel: q.bloomLevel || 'understand',
        difficulty: q.difficulty || 'medium',
        concepts: [topic || course || 'general'],
        correctAnswer: String(q.options?.[q.correctIndex] || ''),
        modelAnswer: q.explanation || '',
      }));
      const now = new Date().toISOString();
      return {
        questions, course, topic,
        source: result._source || 'generated',
        generatedBy: result.generatedBy || 'pipeline',
        model: result.model || 'unknown',
        pipelineVersion: result.pipelineVersion || 'v2',
        generatedAt: result.generatedAt || now,
        _source: result._source || 'pipeline',
      };
    }
  } catch (e) {
    log.warn('KNOWLEDGE_ASSESS', `Pipeline generation failed, falling back to direct: ${e.message}`);
  }

  // 3. Fetch curriculum concepts for context-aware generation
  const concepts = await fetchCurriculumConcepts(course || topic || '');
  const conceptList = concepts.length > 0 ? concepts.slice(0, 15).join(', ') : (topic || course || 'general');

  const prompt = `You are an expert educational diagnostician. Generate a diagnostic assessment to evaluate a learner's current knowledge.

Course: ${course || 'General'}
${module ? `Module: ${module}` : ''}
${topic ? `Topic: ${topic}` : ''}
Key concepts to cover: ${conceptList}

Generate exactly 5 questions that span Bloom's Taxonomy levels:
- 1 Remember (recall facts, definitions)
- 1 Understand (explain concepts in own words)
- 1 Apply (use knowledge in a practical context)
- 1 Analyze (break down components, find patterns)
- 1 Evaluate (make judgments, critique, justify)

Rules:
- Each question must test a DIFFERENT concept from the key concepts list
- Questions must be about actual subject matter, NOT about course codes or course names
- Mix of MCQ and descriptive types (at least 2 MCQ, at least 1 descriptive)
- MCQs: provide 4 options (A, B, C, D), mark correctAnswer as the letter
- Descriptive: provide a modelAnswer for grading reference
- Tag each question with its bloomLevel and difficulty (easy/medium/hard)

Return valid JSON only:
{
  "questions": [
    {
      "question": "...",
      "type": "mcq" or "descriptive",
      "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
      "correctAnswer": "A",
      "modelAnswer": "...",
      "bloomLevel": "remember",
      "difficulty": "easy",
      "concepts": ["concept1", "concept2"]
    }
  ]
}`;

  try {
    const responseText = await callWithFallback({
      userQuery: prompt,
      systemPrompt: 'You are an educational assessment generator. Respond with valid JSON only.',
      chatHistory: [],
      preferredProvider: 'ollama',
    });

    const raw = typeof responseText === 'string' ? responseText : (responseText.text || JSON.stringify(responseText));
    let parsed;
    const text = raw;
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error('Could not parse LLM response as JSON');
    }

    const questions = (parsed.questions || []).slice(0, 5).map((q, i) => ({
      id: `diag_${i}_${Date.now()}`,
      question: q.question,
      type: q.type || 'mcq',
      options: q.options || [],
      bloomLevel: q.bloomLevel || 'understand',
      difficulty: q.difficulty || 'medium',
      concepts: q.concepts || [],
      correctAnswer: q.correctAnswer || '',
      modelAnswer: q.modelAnswer || '',
    }));

    const provider = typeof responseText === 'object' && responseText?.provider ? responseText.provider : 'unknown';
    const model = typeof responseText === 'object' && responseText?.model ? responseText.model : 'unknown';
    const now = new Date().toISOString();
    return {
      questions, course, topic,
      source: provider,
      generatedBy: provider,
      model,
      pipelineVersion: 'v2',
      generatedAt: now,
      _source: provider,
    };
  } catch (error) {
    log.error('KNOWLEDGE_ASSESS', `Diagnostic generation failed: ${error.message}. Using curriculum-based fallback.`);
    return generateOfflineAssessment({ course, topic, concepts });
  }
}

function generateOfflineAssessment({ course, topic, concepts = [] }) {
  const allConcepts = concepts.length > 0 ? concepts : ['fundamental principles', 'core concepts', 'practical applications', 'system architecture', 'design trade-offs'];

  const questionTemplates = [
    {
      bloomLevel: 'remember',
      difficulty: 'easy',
      question: allConcepts[0]
        ? `What is the definition of "${allConcepts[0]}" and why is it important in this field?`
        : `Describe a fundamental principle in this subject area and explain its significance.`,
      modelAnswer: `The student should define the core concept and explain its role within the subject domain.`,
      concepts: [allConcepts[0] || 'fundamentals'],
    },
    {
      bloomLevel: 'understand',
      difficulty: 'easy',
      question: allConcepts[1]
        ? `Explain how "${allConcepts[1]}" relates to "${allConcepts[0] || 'other core concepts'}". What is the relationship?`
        : `Describe the relationship between two major concepts in this subject. How do they interact?`,
      modelAnswer: `The student should explain the conceptual relationship and how concepts build upon each other.`,
      concepts: [allConcepts[1] || 'relationships', allConcepts[0] || 'foundations'],
    },
    {
      bloomLevel: 'apply',
      difficulty: 'medium',
      question: allConcepts[2]
        ? `Describe a practical scenario where "${allConcepts[2]}" would be applied. What steps are involved?`
        : `Provide a real-world application of the key principles in this subject. Outline the process.`,
      modelAnswer: `The student should describe a concrete application scenario with appropriate methodology.`,
      concepts: [allConcepts[2] || 'application'],
    },
    {
      bloomLevel: 'analyze',
      difficulty: 'medium',
      question: `Compare and contrast two different approaches or methods within this subject. What are their relative strengths in different contexts?`,
      modelAnswer: `The student should analyze multiple approaches, comparing their trade-offs and appropriate use cases.`,
      concepts: ['analysis', 'comparison'],
    },
    {
      bloomLevel: 'evaluate',
      difficulty: 'hard',
      question: `Evaluate a design or implementation decision in this field. What trade-offs must be considered, and how would you justify your choice?`,
      modelAnswer: `The student should critically evaluate options, weighing pros and cons and justifying their recommendation.`,
      concepts: ['evaluation', 'trade-offs'],
    },
  ];

  const questions = questionTemplates.map((t, i) => ({
    id: `offline_${i}_${Date.now()}`,
    question: t.question,
    type: 'descriptive',
    options: [],
    bloomLevel: t.bloomLevel,
    difficulty: t.difficulty,
    concepts: t.concepts,
    correctAnswer: '',
    modelAnswer: t.modelAnswer,
  }));

  const now = new Date().toISOString();
  return {
    questions, course, topic,
    source: 'curriculum_fallback',
    generatedBy: 'template',
    model: 'fallback',
    pipelineVersion: 'v2',
    generatedAt: now,
    _source: 'curriculum_fallback',
  };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function evaluateAndClassify({ responses, topic, course, userId, weakAreas: userWeakAreas, strengths: userStrengths }) {
  // Use agent-based evaluation combining LLM + keyword + basic evaluation
  // with Bloom/difficulty weighting and confidence scoring
  const agentResult = await evaluateAssessment({
    responses: responses.map(r => ({
      question: r.question,
      userAnswer: r.userAnswer || r.answer || '',
      correctAnswer: r.correctAnswer,
      modelAnswer: r.modelAnswer,
      concepts: r.concepts || [],
      bloomLevel: r.bloomLevel || 'understand',
      difficulty: r.difficulty || 'medium',
      type: r.type || 'mcq',
    })),
    course,
    topic: topic || course,
  });

  const strengths = [...new Set([...agentResult.strengths, ...(userStrengths || [])])].slice(0, 10);
  const weakAreas = [...new Set([...agentResult.weakAreas, ...(userWeakAreas || [])])].slice(0, 10);

  const result = {
    ...agentResult,
    strengths,
    weakAreas,
    topic: topic || course,
    course,
  };

  if (userId) {
    try {
      await AssessmentResult.create({
        userId, topic: topic || course || 'general', course,
        level: result.level,
        score: result.score,
        maxScore: result.maxScore,
        scorePercent: result.scorePercent,
        confidence: result.confidence,
        highestBloomLevel: result.highestBloomLevel,
        bloomProfile: result.bloomProfile,
        strengths, weakAreas,
        misconceptions: result.misconceptions,
        feedback: result.feedback,
        recommendation: result.recommendation,
        gradingDetails: result.gradingDetails,
      });

      await syncToKnowledgeState(userId, topic, { weakAreas, strengths, level: result.level });

      syncAssessmentToSkillTree(userId, course || topic || 'general', result.level, weakAreas, strengths)
        .catch(e => log.warn('KNOWLEDGE_ASSESS', `Skill tree sync: ${e.message}`));
    } catch (err) {
      log.warn('KNOWLEDGE_ASSESS', `Persist failed: ${err.message}`);
    }
  }

  return result;
}

async function syncToKnowledgeState(userId, topic, { weakAreas, strengths, level }) {
  const state = await StudentKnowledgeState.findOneAndUpdate(
    { userId },
    {},
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const now = new Date();
  state.engagementMetrics.totalSessions = (state.engagementMetrics.totalSessions || 0) + 1;
  state.engagementMetrics.lastActiveDate = now;

  weakAreas.forEach(area => {
    const existing = state.concepts.find(c => c.conceptName.toLowerCase() === area.toLowerCase());
    if (existing) {
      existing.understandingLevel = 'struggling';
      existing.masteryScore = Math.min(existing.masteryScore || 50, 40);
    } else {
      state.concepts.push({
        conceptName: area, understandingLevel: 'struggling', masteryScore: 20,
        category: 'fundamental', difficulty: 'medium',
      });
    }
  });

  strengths.forEach(area => {
    const existing = state.concepts.find(c => c.conceptName.toLowerCase() === area.toLowerCase());
    if (existing) {
      existing.understandingLevel = 'mastered';
      existing.masteryScore = Math.max(existing.masteryScore || 0, 85);
    } else {
      state.concepts.push({
        conceptName: area, understandingLevel: 'comfortable', masteryScore: 85,
        category: 'intermediate', difficulty: 'low',
      });
    }
  });

  try { await state.save(); } catch (e) { log.warn('KNOWLEDGE_ASSESS', `KnowledgeState sync error: ${e.message}`); }
}



async function generateLearningReadiness(userId, topic) {
  try {
    const query = { userId };
    if (topic) query.topic = topic;
    const latest = await AssessmentResult.findOne(query).sort({ createdAt: -1 });

    if (!latest) {
      return {
        readiness: 'unknown',
        message: 'No assessment data available. Take a diagnostic assessment to determine readiness.',
        recommendations: [{ area: 'assessment', action: 'Take a diagnostic assessment', priority: 'high' }],
      };
    }

    const recommendations = [];
    if (latest.level === 'Beginner' || latest.level === 'Intermediate') {
      recommendations.push({ area: 'foundation', action: 'Review core concepts with structured lecture notes', priority: 'high' });
    }
    if (latest.highestBloomLevel === 'remember' || latest.highestBloomLevel === 'understand') {
      recommendations.push({ area: 'application', action: 'Practice with scenario-based questions', priority: 'medium' });
    }
    (latest.weakAreas || []).forEach(area => {
      recommendations.push({ area: 'knowledge_gap', action: `Review ${area} with targeted practice`, priority: 'high' });
    });
    recommendations.push({
      area: 'progression',
      action: latest.level === 'Beginner' ? 'Progress to Intermediate material' : 'Attempt advanced analysis questions',
      priority: 'medium',
    });

    return {
      readiness: latest.level !== 'Beginner' ? 'ready' : 'needs_preparation',
      currentLevel: latest.level,
      highestBloomLevel: latest.highestBloomLevel,
      lastAssessed: latest.createdAt,
      recommendations,
    };
  } catch (error) {
    log.error('KNOWLEDGE_ASSESS', `Readiness check failed: ${error.message}`);
    return { readiness: 'error', message: error.message, recommendations: [] };
  }
}

async function getAssessmentHistory(userId, topic) {
  const query = { userId };
  if (topic) query.topic = topic;
  const assessments = await AssessmentResult.find(query).sort({ createdAt: -1 }).limit(20).lean();

  const sorted = [...assessments].reverse();
  const trend = sorted.length >= 2 ? sorted[sorted.length - 1].scorePercent - sorted[0].scorePercent : null;

  return { assessments: sorted, trend };
}

async function syncAssessmentToSkillTree(userId, topic, level, weakAreas, strengths) {
  try {
    const SkillTree = require('../models/SkillTree');
    const GamificationProfile = require('../models/GamificationProfile');

    const matchedNodes = await SkillTree.find({
      $or: [
        { course: { $regex: topic, $options: 'i' } },
        { category: { $regex: topic, $options: 'i' } },
      ],
      isActive: true,
    }).lean();

    if (!matchedNodes || matchedNodes.length === 0) return;

    const profile = await GamificationProfile.findOne({ userId });
    if (!profile) return;

    matchedNodes.forEach(node => {
      const nodeId = node.skillId?.toLowerCase() || '';
      const nodeName = node.name?.toLowerCase() || '';
      const nodeCategory = node.category?.toLowerCase() || '';

      const isStrong = strengths.some(s => {
        const sl = s.toLowerCase();
        return nodeId.includes(sl) || nodeName.includes(sl) || nodeCategory.includes(sl);
      });
      const isWeak = weakAreas.some(w => {
        const wl = w.toLowerCase();
        return nodeId.includes(wl) || nodeName.includes(wl) || nodeCategory.includes(wl);
      });

      if (isStrong) {
        profile.skillMastery.set(node.skillId, Math.min(100, (profile.skillMastery.get(node.skillId) || 0) + 20));
        if (!profile.unlockedSkills.includes(node.skillId)) {
          profile.unlockedSkills.push(node.skillId);
        }
      } else if (isWeak) {
        profile.skillMastery.set(node.skillId, Math.max(0, (profile.skillMastery.get(node.skillId) || 0) - 10));
      } else if (level !== 'Beginner') {
        if (!profile.unlockedSkills.includes(node.skillId)) {
          profile.unlockedSkills.push(node.skillId);
        }
      }
    });

    profile.markModified('skillMastery');
    profile.markModified('unlockedSkills');
    await profile.save();
    log.info('KNOWLEDGE_ASSESS', `Skill tree synced: ${matchedNodes.length} nodes evaluated for ${topic}`);
  } catch (e) {
    log.warn('KNOWLEDGE_ASSESS', `Skill tree sync error: ${e.message}`);
  }
}

module.exports = {
  generateDiagnosticAssessment,
  evaluateAndClassify,
  generateLearningReadiness,
  getAssessmentHistory,
  syncAssessmentToSkillTree,
};