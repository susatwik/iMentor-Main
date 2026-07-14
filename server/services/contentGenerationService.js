const { callWithFallback } = require('./llmFallbackService');
const { redisClient } = require('../config/redisClient');
const log = require('../utils/logger');
const Lecture = require('../models/Lecture');
const SkillTreeLevel = require('../models/SkillTreeLevel');
const QuestionBank = require('../models/QuestionBank');
const Assessment = require('../models/Assessment');
const QuizModel = require('../models/Quiz');
const ConceptMap = require('../models/ConceptMap');
const { runQuery: neo4jRun } = require('../config/neo4j');
const fs = require('fs');
const path = require('path');

const CACHE_TTL = 7 * 24 * 3600;
const LECTURES_DIR = path.join(__dirname, '..', '..', 'lectures');
const COURSE_BOOTSTRAP_DIR = path.join(__dirname, '..', '..', 'course_bootstrap');

const PIPELINE_VERSION = 'v2';

function logPipeline(step, detail) {
  const label = `[${step}]`;
  log.info('PIPELINE', `${label} ${detail}`);
}

function buildMetadata(provider, model) {
  return {
    generatedBy: provider || 'template',
    model: model || 'unknown',
    pipelineVersion: PIPELINE_VERSION,
    generatedAt: new Date().toISOString(),
    source: provider || 'template',
  };
}

async function getRedis(key) {
  try {
    if (redisClient && redisClient.isOpen) {
      const val = await redisClient.get(key);
      if (val) { logPipeline('CACHE HIT', key); return JSON.parse(val); }
    }
  } catch (e) { /* redis unavailable */ }
  logPipeline('CACHE MISS', key);
  return null;
}

async function setRedis(key, data) {
  try {
    if (redisClient && redisClient.isOpen) {
      await redisClient.setEx(key, CACHE_TTL, JSON.stringify(data));
      logPipeline('CACHED TO REDIS', key);
    }
  } catch (e) { /* ok */ }
}

// ── LECTURE GENERATION ────────────────────────────────────────────────

async function generateOrRetrieveLecture(course, subtopicId, subtopicName, topicName, moduleName) {
  const cacheKey = `lecture:${course}:${subtopicId || 'full'}`;

  // 1. Redis Cache
  const cached = await getRedis(cacheKey);
  if (cached) return { ...cached, _source: 'redis_cache' };

  // 2. MongoDB
  logPipeline('DATABASE', `Checking Lecture collection for ${course}/${subtopicId}`);
  const mongoQuery = subtopicId
    ? { course: { $regex: new RegExp(`^${escapeRegex(course)}$`, 'i') }, subtopicId }
    : { course: { $regex: new RegExp(`^${escapeRegex(course)}$`, 'i') }, contentType: 'full_lecture' };
  const mongoDoc = await Lecture.findOne(mongoQuery).lean();
  if (mongoDoc) {
    logPipeline('DATABASE HIT', `Lecture ${course}/${subtopicId}`);
    await setRedis(cacheKey, mongoDoc);
    return { ...mongoDoc, _source: 'mongodb' };
  }

  // 3. File-system lectures/ directory
  logPipeline('REPOSITORY', `Checking lectures/ directory for ${course}`);
  const stored = findStoredLecture(course, subtopicId);
  if (stored.markdown) {
    logPipeline('REPOSITORY HIT', `lectures/${course}`);
    const lectureData = {
      course, subtopicId, subtopicName: subtopicName || '',
      markdown: stored.markdown,
      html: stored.html || '',
      conceptMap: stored.conceptMap || '',
      contentType: subtopicId ? 'subtopic' : 'full_lecture',
      source: 'file_repository',
    };
    await Lecture.findOneAndUpdate(
      { course: { $regex: new RegExp(`^${escapeRegex(course)}$`, 'i') }, subtopicId: subtopicId || null },
      { $setOnInsert: lectureData },
      { upsert: true }
    );
    logPipeline('SAVED TO MONGO', `Lecture ${course}/${subtopicId}`);
    await setRedis(cacheKey, lectureData);
    return { ...lectureData, _source: 'file_repository' };
  }

  logPipeline('GENERATING', `Lecture for ${course}/${subtopicId} via LLM`);
  const generated = await generateLecture(course, subtopicId, subtopicName, topicName, moduleName);

  if (generated) {
    const provider = generated._provider || 'generated';
    const model = generated._model || 'unknown';
    const meta = buildMetadata(provider, model);
    const lectureData = {
      course, subtopicId: subtopicId || null,
      subtopicName: subtopicName || '',
      topicName: topicName || '',
      moduleName: moduleName || '',
      markdown: generated.markdown,
      html: generated.html || '',
      conceptMap: generated.conceptMap || '',
      contentType: subtopicId ? 'subtopic' : 'full_lecture',
      source: provider,
      ...meta,
      metadata: { wordCount: generated.markdown?.split(/\s+/).length || 0, generatedBy: provider, model, pipelineVersion: PIPELINE_VERSION },
    };
    await Lecture.findOneAndUpdate(
      { course: { $regex: new RegExp(`^${escapeRegex(course)}$`, 'i') }, subtopicId: subtopicId || null },
      { $set: lectureData },
      { upsert: true }
    );
    logPipeline('SAVED TO MONGO', `Lecture ${course}/${subtopicId}`);
    await setRedis(cacheKey, lectureData);
    logPipeline(`GENERATED VIA ${provider.toUpperCase()}`, `Lecture for ${course}/${subtopicId}`);
    return { ...lectureData, _source: provider };
  }

  // 6. Final fallback: concept-based template
  logPipeline('TEMPLATE FALLBACK', `Lecture for ${course}/${subtopicId}`);
  const fallback = generateFallbackLecture(course, subtopicId, subtopicName);
  await setRedis(cacheKey, fallback);
  return { ...fallback, _source: 'template_fallback' };
}

async function generateLecture(course, subtopicId, subtopicName, topicName, moduleName) {
  const name = subtopicName || subtopicId?.replace(/[_-]/g, ' ') || course;
  const prompt = `You are a professor creating a concise, engaging lecture note.

Course: ${course}
${moduleName ? `Module: ${moduleName}` : ''}
${topicName ? `Topic: ${topicName}` : ''}
Topic: ${name}

Write a comprehensive lecture note in Markdown covering:
1. A clear learning objective
2. Core concepts with definitions
3. Examples and applications
4. Key takeaways

Format in Markdown with headings (##), bullet points, and code blocks where relevant.`;

  try {
    const startTime = Date.now();
    const result = await callWithFallback({
      userQuery: prompt,
      systemPrompt: 'You are a university professor creating lecture notes. Respond in Markdown format.',
      chatHistory: [],
      preferredProvider: 'sglang',
      options: { temperature: 0.7, maxOutputTokens: 4096, timeout: 60000 },
    });
    const generationTime = Date.now() - startTime;
    const provider = result?.provider || 'unknown';
    logPipeline(`GENERATED VIA ${provider.toUpperCase()}`, `Lecture in ${generationTime}ms`);

    const text = result?.text || '';
    if (text && text.length > 50) {
      const html = simpleMarkdownToHtml(text);
      return { markdown: text, html, conceptMap: '', _provider: provider, _model: result?.model || 'unknown' };
    }
  } catch (e) {
    log.warn('PIPELINE', `Lecture generation failed: ${e.message}`);
  }
  return null;
}

function generateFallbackLecture(course, subtopicId, subtopicName) {
  const name = subtopicName || subtopicId?.replace(/[_-]/g, ' ') || course;
  return {
    markdown: `## ${name}\n\nThis lecture note covers fundamental concepts of ${name} within the context of ${course}.\n\n### Learning Objectives\n- Understand the core principles of ${name}\n- Identify key applications and use cases\n- Analyze practical implementations\n\n### Key Concepts\n- **Concept 1**: Foundation of ${name} in ${course}\n- **Concept 2**: Core methodologies and approaches\n- **Concept 3**: Practical applications and examples\n\n### Summary\n${name} is an essential topic in ${course}. Master these fundamentals before advancing to more complex material.`,
    html: '',
    conceptMap: '',
  };
}

// ── SKILL TREE LEVEL GENERATION ──────────────────────────────────────

async function generateOrRetrieveSkillTreeLevels(topic, assessmentResult) {
  const cacheKey = `skilltree:levels:${topic}`;

  // 1. Redis
  const cached = await getRedis(cacheKey);
  if (cached) return { ...cached, _source: 'redis_cache' };

  // 2. MongoDB
  logPipeline('DATABASE', `Checking SkillTreeLevel for ${topic}`);
  const mongoDoc = await SkillTreeLevel.findOne({
    topic: { $regex: new RegExp(`^${escapeRegex(topic)}$`, 'i') }
  }).lean();
  if (mongoDoc) {
    logPipeline('DATABASE HIT', `SkillTreeLevel ${topic}`);
    await setRedis(cacheKey, { levels: mongoDoc.levels, isAdminCourse: mongoDoc.isAdminCourse });
    return { levels: mongoDoc.levels, isAdminCourse: mongoDoc.isAdminCourse, _source: 'mongodb' };
  }

  // 3. Check Neo4j curriculum
  logPipeline('REPOSITORY', `Checking Neo4j curriculum for ${topic}`);
  const curriculumLevels = await buildCurriculumLevels(topic, assessmentResult);
  if (curriculumLevels.length > 0) {
    await persistSkillTreeLevels(topic, curriculumLevels, true, assessmentResult, 'neo4j', 'curriculum');
    await setRedis(cacheKey, { levels: curriculumLevels, isAdminCourse: true });
    return { levels: curriculumLevels, isAdminCourse: true, _source: 'neo4j' };
  }

  // 4. Generate via LLM
  logPipeline('GENERATING', `Skill tree levels for ${topic}`);
  const genResult = await generateSkillTreeLevels(topic, assessmentResult);
  const generatedLevels = genResult?.levels || [];
  const provider = genResult?._provider || 'unknown';
  const model = genResult?._model || 'unknown';
  if (generatedLevels.length > 0) {
    await persistSkillTreeLevels(topic, generatedLevels, false, assessmentResult, provider, model);
    await setRedis(cacheKey, { levels: generatedLevels, isAdminCourse: false, ...buildMetadata(provider, model) });
    logPipeline(`GENERATED VIA ${provider.toUpperCase()}`, `Skill tree levels for ${topic}`);
    return { levels: generatedLevels, isAdminCourse: false, _source: provider, ...buildMetadata(provider, model) };
  }

  // 5. Template fallback
  logPipeline('TEMPLATE FALLBACK', `Skill tree levels for ${topic}`);
  const fallback = generateFallbackLevels(topic, assessmentResult);
  await persistSkillTreeLevels(topic, fallback, false, assessmentResult, 'template', 'fallback');
  await setRedis(cacheKey, { levels: fallback, isAdminCourse: false, ...buildMetadata('template', 'fallback') });
  return { levels: fallback, isAdminCourse: false, _source: 'template_fallback', ...buildMetadata('template', 'fallback') };
}

async function buildCurriculumLevels(topic, assessmentResult) {
  try {
    const result = await neo4jRun(
      `MATCH (m:Module)
       WHERE toLower(m.course) = toLower($topic)
       OPTIONAL MATCH (m)-[:HAS_TOPIC]->(t:Topic)
       OPTIONAL MATCH (t)-[:HAS_SUBTOPIC]->(s:Subtopic)
       RETURN m.name AS module, COLLECT({topic: t.name, subtopics: COLLECT(s.name)}) AS topics
       ORDER BY m.name`,
      { topic }
    );
    if (result.records && result.records.length > 0) {
      const levels = [];
      let idx = 1;
      for (const row of result.records) {
        const mod = row.get('module');
        const topics = row.get('topics') || [];
        for (const t of topics) {
          const subs = (t.subtopics || []).filter(Boolean);
          if (subs.length > 0) {
            for (const s of subs) {
              levels.push({
                id: idx, name: s,
                description: `${t.topic || mod} › ${s}`,
                difficulty: idx <= 10 ? 'easy' : idx <= 20 ? 'medium' : 'hard',
                status: idx === 1 ? 'unlocked' : 'locked',
                stars: 0, credits: idx * 10,
                subtopicId: '', topicName: t.topic || '', moduleName: mod,
              });
              idx++;
            }
          } else {
            levels.push({
              id: idx, name: t.topic || `Topic ${idx}`,
              description: `${mod} › ${t.topic || `Topic ${idx}`}`,
              difficulty: idx <= 10 ? 'easy' : idx <= 20 ? 'medium' : 'hard',
              status: idx === 1 ? 'unlocked' : 'locked',
              stars: 0, credits: idx * 10,
              subtopicId: '', topicName: t.topic || '', moduleName: mod,
            });
            idx++;
          }
        }
      }

      const knowledgeLevel = assessmentResult?.level || 'Beginner';
      if (knowledgeLevel !== 'Beginner' && levels.length > 0) {
        const skipMap = { Beginner: 0, Intermediate: 0.2, Advanced: 0.4, Expert: 0.6 };
        const skip = Math.floor(levels.length * (skipMap[knowledgeLevel] || 0));
        for (let i = 0; i < skip && i < levels.length; i++) {
          levels[i].status = 'unlocked';
          levels[i].skippedByDiagnostic = true;
        }
      }
      return levels;
    }
  } catch (e) {
    log.warn('PIPELINE', `Neo4j curriculum query failed: ${e.message}`);
  }
  return [];
}

async function generateSkillTreeLevels(topic, assessmentResult) {
  const knowledgeLevel = assessmentResult?.level || 'Beginner';
  const totalLevels = { Beginner: 35, Intermediate: 30, Advanced: 25, Expert: 20 }[knowledgeLevel] || 35;

  const prompt = `You are a curriculum designer creating a gamified learning path.

Topic: "${topic}"
Student Level: ${knowledgeLevel}
Number of Levels: ${totalLevels}

Create a progression from fundamentals to advanced concepts.
Each level MUST have a unique, topic-specific name (NOT generic placeholders).

Return a JSON array of objects with: id (1-${totalLevels}), name (specific subtopic name), description (learning objective), difficulty (easy/medium/hard).

Valid JSON array only, no markdown.`;

  try {
    const startTime = Date.now();
    const result = await callWithFallback({
      userQuery: prompt,
      systemPrompt: 'You are a curriculum designer. Return ONLY valid JSON.',
      chatHistory: [],
      preferredProvider: 'sglang',
      options: { temperature: 0.7, maxOutputTokens: 4096, timeout: 60000 },
    });
    const generationTime = Date.now() - startTime;
    const provider = result?.provider || 'unknown';
    logPipeline(`GENERATED VIA ${provider.toUpperCase()}`, `Levels in ${generationTime}ms`);

    const text = result?.text || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      let parsed;
      try { parsed = JSON.parse(jsonMatch[0]); } catch { return []; }
      if (Array.isArray(parsed) && parsed.length > 0) {
        const levels = parsed.map((l, i) => ({
          id: l.id || i + 1,
          name: l.name || `${topic} Level ${i + 1}`,
          description: l.description || `Master ${topic} — Level ${i + 1}`,
          difficulty: l.difficulty || (i < 10 ? 'easy' : i < 20 ? 'medium' : 'hard'),
          status: i === 0 ? 'unlocked' : 'locked',
          stars: 0, credits: (i + 1) * 10,
          subtopicId: l.subtopicId || '', topicName: l.topicName || '', moduleName: l.moduleName || '',
        }));
        return { levels, _provider: provider, _model: result?.model || 'unknown' };
      }
    }
  } catch (e) {
    log.warn('PIPELINE', `Level generation failed: ${e.message}`);
  }
  return [];
}

function generateFallbackLevels(topic, assessmentResult) {
  const knowledgeLevel = assessmentResult?.level || 'Beginner';
  const totalLevels = { Beginner: 35, Intermediate: 30, Advanced: 25, Expert: 20 }[knowledgeLevel] || 35;
  const stages = [
    'Introduction to', 'Basics of', 'Understanding', 'Exploring', 'Learning',
    'Fundamentals of', 'Core Concepts', 'Key Principles', 'Essential', 'Building Blocks',
    'Intermediate', 'Developing', 'Practicing', 'Applying', 'Working with',
    'Advanced', 'Deep Dive into', 'Mastering', 'Expert Level', 'Professional',
  ];
  return Array.from({ length: totalLevels }, (_, i) => ({
    id: i + 1,
    name: `${stages[Math.floor(i / 5) % stages.length]} ${topic} ${['Concepts','Techniques','Methods','Approaches','Skills'][i % 5]}`,
    description: `Learn and master ${topic} — Level ${i + 1}`,
    difficulty: i < 10 ? 'easy' : i < 20 ? 'medium' : 'hard',
    status: i === 0 ? 'unlocked' : 'locked',
    stars: 0, credits: (i + 1) * 10,
    subtopicId: '', topicName: '', moduleName: '',
  }));
}

async function persistSkillTreeLevels(topic, levels, isAdminCourse, assessmentResult, provider, model) {
  const meta = buildMetadata(provider || 'unknown', model || 'unknown');
  try {
    await SkillTreeLevel.findOneAndUpdate(
      { topic: { $regex: new RegExp(`^${escapeRegex(topic)}$`, 'i') } },
      {
        $set: {
          topic, levels, isAdminCourse,
          ...meta,
          metadata: {
            totalLevels: levels.length,
            knowledgeLevel: assessmentResult?.level || 'Beginner',
            ...meta,
          },
          source: provider || 'generated',
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );
    logPipeline('SAVED TO MONGO', `SkillTreeLevel ${topic} (${levels.length} levels)`);
  } catch (e) {
    log.warn('PIPELINE', `Persist skill tree levels failed: ${e.message}`);
  }
}

// ── ANSWER OPTION SHUFFLE ─────────────────────────────────────────────
function shuffleOptions(question) {
  if (!question || !Array.isArray(question.options) || question.options.length !== 4) {
    return question;
  }
  const options = [...question.options];
  const originalIdx = typeof question.correctIndex === 'number' ? question.correctIndex : 0;
  const correctText = options[originalIdx];

  const indices = [0, 1, 2, 3];
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  return {
    ...question,
    options: indices.map(i => options[i]),
    correctIndex: indices.indexOf(originalIdx),
  };
}

function validateAnswerDistribution(questions) {
  const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const q of questions) {
    if (q.correctIndex >= 0 && q.correctIndex <= 3) counts[q.correctIndex]++;
  }
  const total = questions.filter(q => q.correctIndex >= 0 && q.correctIndex <= 3).length;
  const ideal = total / 4;
  let chiSq = 0;
  for (let i = 0; i < 4; i++) {
    chiSq += ideal > 0 ? ((counts[i] - ideal) ** 2) / ideal : 0;
  }
  const balanced = chiSq <= 7.815;
  logPipeline('SHUFFLE', `Distribution: ${JSON.stringify(counts)}, χ²=${chiSq.toFixed(3)}, balanced=${balanced}`);
  return { counts, chiSq, balanced };
}

// ── CONCEPT QUESTION BANK INTEGRATION ──────────────────────────────────

async function generateOrRetrieveLevelQuestions(topic, levelId, levelName, difficulty, gameId, seenQuestions) {
  const cacheKey = `skilltree:questions:${topic}:${levelId || levelName}`;
  let conceptBankTimedOut = false;

  // 1. Concept Question Bank — with timeout guard (max 8s)
  try {
    const conceptQbService = require('./conceptQuestionBankService');
    const conceptBank = await Promise.race([
      conceptQbService.ensureQuestionsForConcept({
        course: topic,
        concept: levelName || `Level ${levelId}`,
        topic,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Concept bank generation timed out (>8s)')), 8000)),
    ]);

    if (conceptBank && conceptBank.length > 0) {
      const seenTexts = (seenQuestions || []).map(s => String(s));
      const selected = await conceptQbService.selectQuestionsForLevel({
        course: topic,
        concept: levelName || `Level ${levelId}`,
        count: 5,
        seenQuestionIds: seenTexts,
      });

      if (selected.length >= 3) {
        const questions = selected.map(q => ({
          question: q.question,
          options: q.options,
          correctIndex: q.correctIndex,
          explanation: q.explanation || '',
          difficulty: q.difficulty || difficulty || 'medium',
          bloomLevel: q.bloomLevel || 'understand',
          learningObjective: q.learningObjective || '',
          estimatedTime: q.estimatedTime || '60s',
          confidence: typeof q.confidence === 'number' ? q.confidence : 0.8,
          _conceptQuestionId: q._id,
        }));
        logPipeline('DATABASE HIT', `ConceptQuestionBank questions for ${topic}/${levelName} (${selected.length} selected, ${conceptBank.length} total)`);
        const meta = buildMetadata('concept_question_bank', 'stored');
        return { questions, _source: 'concept_question_bank', cached: true, conceptTotal: conceptBank.length, ...meta };
      }
    }
  } catch (e) {
    conceptBankTimedOut = true;
    log.warn('PIPELINE', `Concept question bank timed out or failed, falling back: ${e.message}`);
  }

  // If concept bank timed out via LLM chain, skip the redundant LLM call in step 4
  // and go directly to cache sources → template fallback
  if (conceptBankTimedOut) {
    logPipeline('FAST FAILOVER', `Concept bank timed out — skipping LLM chain for ${topic}/${levelName}`);
  }

  // 2. Redis cache (only used when concept bank is unavailable)
  const cached = await getRedis(cacheKey);
  if (cached) {
    const meta = buildMetadata('redis_cache', 'stored');
    return { questions: cached, _source: 'redis_cache', cached: true, ...meta };
  }

  // 3. Legacy Question Bank reuse
  logPipeline('DATABASE', `Checking QuestionBank for ${topic} / ${levelName}`);
  const filter = {
    course: { $regex: new RegExp(escapeRegex(topic), 'i') },
    $or: [
      { subtopic: { $regex: new RegExp(escapeRegex(levelName || ''), 'i') } },
      { topic: { $regex: new RegExp(escapeRegex(levelName || ''), 'i') } },
    ],
  };
  const existing = await QuestionBank.find(filter).limit(5).lean();
  if (existing.length >= 3) {
    const questions = existing.map(q => ({
      question: q.question,
      options: q.options || [],
      correctIndex: findCorrectIndex(q),
      explanation: q.explanation || '',
      difficulty: q.difficulty || 'medium',
      bloomLevel: q.bloomLevel || 'understand',
      learningObjective: q.learningObjective || '',
      estimatedTime: q.estimatedTime || '60s',
      confidence: typeof q.confidence === 'number' ? q.confidence : 0.8,
    }));
    logPipeline('DATABASE HIT', `QuestionBank questions for ${topic}/${levelName}`);
    await setRedis(cacheKey, questions);
    const meta = buildMetadata('question_bank', 'stored');
    return { questions, _source: 'question_bank', cached: true, ...meta };
  }

  // 4. Generate via LLM (with shuffle + dup detection)
  // Skip LLM if concept bank already timed out — avoid redundant slow fallback
  if (conceptBankTimedOut) {
    logPipeline('SKIP LLM', `Concept bank timed out — using template fallback directly for ${topic}/${levelName}`);
    const fallback = generateFallbackQuestions(topic, levelName, difficulty).map(q => shuffleOptions(q));
    validateAnswerDistribution(fallback);
    await setRedis(cacheKey, fallback);
    const meta = buildMetadata('template', 'fallback');
    return { questions: fallback, _source: 'template_fallback', cached: false, ...meta };
  }

  logPipeline('GENERATING', `Level questions for ${topic}/${levelName}`);
  const generated = await generateLevelQuestions(topic, levelId, levelName, difficulty);
  if (generated.length > 0) {
    const shuffled = generated.map(q => shuffleOptions(q));
    validateAnswerDistribution(shuffled);

    await setRedis(cacheKey, shuffled);
    // Save to ConceptQuestionBank for future reuse
    try {
      const conceptQbService = require('./conceptQuestionBankService');
      await conceptQbService.saveQuestionsToBank(shuffled, {
        course: topic,
        concept: levelName || `Level ${levelId}`,
        topic,
        moduleName: '',
      });
    } catch (e) {
      log.warn('PIPELINE', `Saving to concept bank failed: ${e.message}`);
    }
    // Also save to legacy QuestionBank
    for (const q of shuffled) {
      try {
        await QuestionBank.findOneAndUpdate(
          { question: q.question, course: topic },
          {
            $setOnInsert: {
              question: q.question, options: q.options,
              correctIndex: q.correctIndex || 0,
              correctAnswer: String.fromCharCode(65 + (q.correctIndex || 0)),
              explanation: q.explanation || '', type: 'mcq',
              difficulty: q.difficulty || difficulty || 'medium',
              bloomLevel: q.bloomLevel || 'understand',
              learningObjective: q.learningObjective || '',
              estimatedTime: q.estimatedTime || '60s',
              confidence: typeof q.confidence === 'number' ? q.confidence : 0.8,
              course: topic, subtopic: levelName || '',
            },
          },
          { upsert: true }
        );
      } catch (e) { /* skip duplicates */ }
    }
    const provider = shuffled[0]?._provider || 'groq';
    const model = shuffled[0]?._model || 'unknown';
    logPipeline(`GENERATED VIA ${provider.toUpperCase()}`, `${shuffled.length} questions for ${topic}/${levelName}`);
    const meta = buildMetadata(provider, model);
    return { questions: shuffled, _source: provider, ...meta };
  }

  // 5. Template fallback questions
  logPipeline('TEMPLATE FALLBACK', `Level questions for ${topic}/${levelName}`);
  const fallback = generateFallbackQuestions(topic, levelName, difficulty).map(q => shuffleOptions(q));
  validateAnswerDistribution(fallback);
  await setRedis(cacheKey, fallback);
  const meta = buildMetadata('template', 'fallback');
  return { questions: fallback, _source: 'template_fallback', cached: false, ...meta };
}

async function generateLevelQuestions(topic, levelId, levelName, difficulty) {
  const name = levelName || `Level ${levelId}`;
  const prompt = `You are a technical interviewer creating concept-specific assessment questions.

Topic: "${topic}"
Subtopic: "${name}"
Difficulty: ${difficulty || 'medium'}

Generate 5 multiple-choice questions that test understanding of "${name}" — the actual concepts within this subtopic.

RULES (CRITICAL):
- NEVER reference course codes, topic titles, or subtopic names in questions.
- Questions must test the CONCEPT itself, not the name of the topic.
- Each question must be unique and concept-specific.
- Cover different aspects: definitions, applications, edge cases, comparisons.
- Every question must have a meaningful, detailed explanation.
- Distribute correct answers evenly across A, B, C, D — do NOT always put the correct answer first.

BAD example (topic name substitution):
  "What is the most fundamental concept in Selection Sort?"
  "What is the purpose of Binary Search?"

GOOD example (concept-specific):
  "Which statement correctly explains how Selection Sort selects the next element?"
  "Why does Binary Search require the input array to be sorted?"

Return JSON array where each object has ALL of these fields:
{
  "question": "string — the MCQ question, testing actual concept knowledge",
  "options": ["string", "string", "string", "string"] — exactly 4 options,
  "correctIndex": 0-3 — index of correct option (distribute evenly across 0,1,2,3),
  "explanation": "string — detailed explanation of why the answer is correct and why others are wrong",
  "difficulty": "easy|medium|hard",
  "bloomLevel": "remember|understand|apply|analyze|evaluate|create",
  "learningObjective": "string — what knowledge this question assesses",
  "estimatedTime": "30s|60s|90s|120s",
  "confidence": 0.0-1.0
}

EVERY OBJECT MUST HAVE ALL 9 FIELDS. Valid JSON array only, no markdown.`;

  try {
    const startTime = Date.now();
    const result = await callWithFallback({
      userQuery: prompt,
      systemPrompt: 'Return ONLY valid JSON array of 5 MCQ objects with all required fields.',
      chatHistory: [],
      preferredProvider: 'sglang',
      options: { temperature: 0.7, maxOutputTokens: 4096, timeout: 60000 },
    });
    const provider = result?.provider || 'unknown';
    logPipeline(`GENERATED USING ${provider.toUpperCase()}`, `Questions in ${Date.now() - startTime}ms`);

    const text = result?.text || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      let parsed;
      try { parsed = JSON.parse(jsonMatch[0]); } catch { return []; }
      if (Array.isArray(parsed)) {
        return parsed.map(q => ({
          question: q.question || '',
          options: (q.options || []).slice(0, 4).map(o => String(o).replace(/^[A-Da-d][.):\-]\s*/, '')),
          correctIndex: resolveCorrectIndex(q),
          explanation: q.explanation || '',
          difficulty: ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : difficulty || 'medium',
          bloomLevel: ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'].includes(q.bloomLevel) ? q.bloomLevel : 'understand',
          learningObjective: q.learningObjective || `Assess understanding of ${name}`,
          estimatedTime: ['30s', '60s', '90s', '120s'].includes(q.estimatedTime) ? q.estimatedTime : '60s',
          confidence: typeof q.confidence === 'number' && q.confidence >= 0 && q.confidence <= 1 ? q.confidence : 0.8,
          _provider: provider,
          _model: result?.model || 'unknown',
        })).filter(q => q.question && q.options.length === 4 && q.options.every(o => o));
      }
    }
  } catch (e) {
    log.warn('PIPELINE', `Question generation failed: ${e.message}`);
  }
  return [];
}

function generateFallbackQuestions(topic, levelName, difficulty) {
  const questions = [
    {
      question: `Which statement best describes a core concept related to this topic?`,
      options: ['A fundamental principle that governs related phenomena', 'An unrelated observation about the field', 'A historical anecdote with no current relevance', 'A subjective opinion about best practices'],
      correctIndex: 0,
      explanation: `Core principles form the foundation of any technical subject. Understanding these fundamentals is essential before exploring advanced applications.`,
      difficulty: difficulty || 'easy',
      bloomLevel: 'remember',
      learningObjective: `Recall foundational concepts in ${topic}`,
      estimatedTime: '30s',
      confidence: 0.9,
    },
    {
      question: `How would you apply a key technique from this area to solve a practical problem?`,
      options: ['Identify the relevant principles and adapt them to the context', 'Ignore established methods and invent a new approach', 'Use trial and error without any framework', 'Copy solutions from unrelated fields'],
      correctIndex: 1,
      explanation: `Practical application requires understanding underlying principles and adapting them appropriately to the specific context of the problem.`,
      difficulty: difficulty || 'medium',
      bloomLevel: 'apply',
      learningObjective: `Apply concepts from ${topic} to practical scenarios`,
      estimatedTime: '60s',
      confidence: 0.85,
    },
    {
      question: `What distinguishes an efficient approach from an inefficient one when solving problems in this domain?`,
      options: ['Algorithmic complexity and resource utilization', 'The number of lines of code', 'How modern the technology appears', 'Popularity among practitioners'],
      correctIndex: 0,
      explanation: `In technical domains, efficiency is measured by quantifiable metrics like time complexity, space complexity, and resource utilization rather than subjective factors.`,
      difficulty: difficulty || 'medium',
      bloomLevel: 'analyze',
      learningObjective: `Analyze efficiency tradeoffs in ${topic}`,
      estimatedTime: '60s',
      confidence: 0.85,
    },
    {
      question: `When evaluating competing solutions in this field, what is the most important criterion?`,
      options: ['Popularity of the approach', 'Simplicity of implementation', 'Correctness within the domain constraints', 'Novelty of the solution'],
      correctIndex: 2,
      explanation: `While simplicity, popularity, and novelty are secondary considerations, correctness within the problem's constraints is always the primary criterion for evaluating solutions.`,
      difficulty: difficulty || 'hard',
      bloomLevel: 'evaluate',
      learningObjective: `Evaluate solution quality in ${topic}`,
      estimatedTime: '90s',
      confidence: 0.8,
    },
    {
      question: `Which approach demonstrates the deepest understanding of this subject area?`,
      options: ['Repeating explanations without original thought', 'Being able to explain concepts and apply them to novel situations', 'Memorizing terminology without comprehension', 'Completing assignments without understanding why'],
      correctIndex: 1,
      explanation: `True mastery is demonstrated by the ability to not only recall and apply knowledge but also transfer it to novel situations and explain it to others.`,
      difficulty: difficulty || 'hard',
      bloomLevel: 'evaluate',
      learningObjective: `Demonstrate comprehensive understanding of ${topic}`,
      estimatedTime: '90s',
      confidence: 0.8,
    },
  ];
  return questions;
}

function resolveCorrectIndex(q) {
  if (typeof q.correctIndex === 'number' && q.correctIndex >= 0 && q.correctIndex < (q.options || []).length) return q.correctIndex;
  if (typeof q.correctIndex === 'string' && /^\d+$/.test(q.correctIndex)) return parseInt(q.correctIndex);
  if (typeof q.answer === 'string' && /^[A-Da-d]$/.test(q.answer)) return q.answer.toUpperCase().charCodeAt(0) - 65;
  if (typeof q.correct === 'string' && /^[A-Da-d]$/.test(q.correct)) return q.correct.toUpperCase().charCodeAt(0) - 65;
  return 0;
}

function findCorrectIndex(q) {
  if (typeof q.correctIndex === 'number') return q.correctIndex;
  const answer = q.correctAnswer || '';
  if (/^[A-Da-d]$/.test(answer)) return answer.toUpperCase().charCodeAt(0) - 65;
  if (q.options && answer) {
    const idx = q.options.findIndex(o => o.trim().toLowerCase() === answer.trim().toLowerCase());
    if (idx >= 0) return idx;
  }
  return 0;
}

// ── COURSE BOOTSTRAP ─────────────────────────────────────────────────

async function bootstrapCourse(courseName) {
  logPipeline('BOOTSTRAP', `Starting full bootstrap for "${courseName}"`);
  const results = { course: courseName, steps: {} };

  // 1. Generate skill tree levels
  try {
    const levels = await generateOrRetrieveSkillTreeLevels(courseName, { level: 'Beginner' });
    results.steps.skillTree = { status: 'ok', levels: levels.levels?.length || 0, source: levels._source };
  } catch (e) {
    results.steps.skillTree = { status: 'error', message: e.message };
  }

  // 2. Generate full lecture
  try {
    const lecture = await generateOrRetrieveLecture(courseName, null, '', '', '');
    results.steps.lecture = { status: 'ok', chars: lecture.markdown?.length || 0, source: lecture._source };
  } catch (e) {
    results.steps.lecture = { status: 'error', message: e.message };
  }

  logPipeline('BOOTSTRAP', `Completed for "${courseName}"`);
  return results;
}

// ── UTILITY FUNCTIONS ─────────────────────────────────────────────────

function escapeRegex(str) {
  return (str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function simpleMarkdownToHtml(md) {
  let html = md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(.+)$/gm, (m) => m.startsWith('<') ? m : `<p>${m}</p>`);
  return `<div class="lecture-content">${html}</div>`;
}

// ── KNOWLEDGE ASSESSMENT GENERATION ───────────────────────────────────

async function generateOrRetrieveAssessment(courseName, topic, userId) {
  const cacheKey = `assessment:${courseName}:${topic}`;

  const cached = await getRedis(cacheKey);
  if (cached) return { ...cached, _source: 'redis_cache' };

  logPipeline('DATABASE', `Checking Assessment collection for ${courseName}/${topic}`);
  const existing = await Assessment.findOne({ course: courseName, topic }).lean();
  if (existing) {
    logPipeline('DATABASE HIT', `Assessment ${courseName}/${topic}`);
    await setRedis(cacheKey, existing);
    return { ...existing, _source: 'mongodb' };
  }

  logPipeline('GENERATING', `Assessment for ${courseName}/${topic}`);
  const prompt = `You are creating a diagnostic assessment for "${topic}" within the course "${courseName}".

Generate 5 multiple-choice questions that assess actual knowledge of the subject matter — NOT course codes or topic names.

RULES:
- Questions must test concepts, not metadata.
- Cover different difficulty levels and Bloom's taxonomy levels.
- NEVER reference the course code, topic name, or subtopic name.
- Each question must have a detailed explanation.

Return JSON array with objects:
{
  "question": "string",
  "options": ["string", "string", "string", "string"],
  "correctIndex": 0-3,
  "explanation": "string",
  "difficulty": "easy|medium|hard",
  "bloomLevel": "remember|understand|apply|analyze|evaluate|create"
}

Valid JSON only.`;

  try {
    const result = await callWithFallback({
      userQuery: prompt,
      systemPrompt: 'Return ONLY valid JSON array of 5 MCQ objects.',
      chatHistory: [],
      preferredProvider: 'sglang',
      options: { temperature: 0.7, maxOutputTokens: 4096, timeout: 60000 },
    });
    const provider = result?.provider || 'unknown';
    logPipeline(`GENERATED VIA ${provider.toUpperCase()}`, `Assessment for ${courseName}/${topic}`);

    const text = result?.text || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      let parsed;
      try { parsed = JSON.parse(jsonMatch[0]); } catch { parsed = []; }
      if (Array.isArray(parsed) && parsed.length > 0) {
        const questions = parsed.map(q => ({
          question: q.question || '',
          options: (q.options || []).map(o => String(o).replace(/^[A-Da-d][.):\-]\s*/, '')),
          correctIndex: resolveCorrectIndex(q),
          explanation: q.explanation || '',
          difficulty: q.difficulty || 'medium',
          bloomLevel: q.bloomLevel || 'understand',
        })).filter(q => q.question && q.options.length >= 2);

        const meta = buildMetadata(provider, result?.model || 'unknown');
        const data = { course: courseName, topic, questions, ...meta, createdAt: new Date() };
        try {
          await Assessment.findOneAndUpdate({ course: courseName, topic }, { $setOnInsert: data }, { upsert: true });
          logPipeline('SAVED TO MONGO', `Assessment ${courseName}/${topic}`);
        } catch (e) { /* ok */ }
        await setRedis(cacheKey, data);
        return { ...data, _source: provider };
      }
    }
  } catch (e) {
    log.warn('PIPELINE', `Assessment generation failed: ${e.message}`);
  }

  // Fallback
  const fallback = generateFallbackQuestions(courseName, topic, 'medium');
  const meta = buildMetadata('template', 'fallback');
  const data = { course: courseName, topic, questions: fallback, ...meta, createdAt: new Date() };
  await setRedis(cacheKey, data);
  return { ...data, _source: 'template' };
}

// ── QUIZ GENERATION ───────────────────────────────────────────────────

async function generateOrRetrieveQuiz(courseName, moduleName, userId) {
  const cacheKey = `quiz:${courseName}:${moduleName || 'general'}`;

  const cached = await getRedis(cacheKey);
  if (cached) return { ...cached, _source: 'redis_cache' };

  logPipeline('DATABASE', `Checking Quiz collection for ${courseName}/${moduleName}`);
  const existing = await QuizModel.findOne({ course: courseName, module: moduleName }).lean();
  if (existing) {
    logPipeline('DATABASE HIT', `Quiz ${courseName}/${moduleName}`);
    await setRedis(cacheKey, existing);
    return { ...existing, _source: 'mongodb' };
  }

  logPipeline('GENERATING', `Quiz for ${courseName}/${moduleName}`);
  const prompt = `You are creating a module quiz for "${moduleName}" within the course "${courseName}".

Generate 5 multiple-choice questions that assess actual understanding of the module content.

RULES:
- Cover different Bloom's taxonomy levels (remember, understand, apply, analyze).
- Questions must be about the concepts taught in this module.
- NEVER reference course codes or module names in questions.
- Each question needs a detailed explanation.

Return JSON array with objects:
{
  "question": "string",
  "options": ["string", "string", "string", "string"],
  "correctIndex": 0-3,
  "explanation": "string",
  "difficulty": "easy|medium|hard",
  "bloomLevel": "remember|understand|apply|analyze"
}

Valid JSON only.`;

  try {
    const result = await callWithFallback({
      userQuery: prompt,
      systemPrompt: 'Return ONLY valid JSON array of 5 MCQ objects.',
      chatHistory: [],
      preferredProvider: 'sglang',
      options: { temperature: 0.7, maxOutputTokens: 4096, timeout: 60000 },
    });
    const provider = result?.provider || 'unknown';
    logPipeline(`GENERATED VIA ${provider.toUpperCase()}`, `Quiz for ${courseName}/${moduleName}`);

    const text = result?.text || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      let parsed;
      try { parsed = JSON.parse(jsonMatch[0]); } catch { parsed = []; }
      if (Array.isArray(parsed) && parsed.length > 0) {
        const questions = parsed.map(q => ({
          question: q.question || '',
          options: (q.options || []).map(o => String(o).replace(/^[A-Da-d][.):\-]\s*/, '')),
          correctIndex: resolveCorrectIndex(q),
          explanation: q.explanation || '',
          difficulty: q.difficulty || 'medium',
          bloomLevel: q.bloomLevel || 'understand',
        })).filter(q => q.question && q.options.length >= 2);

        const meta = buildMetadata(provider, result?.model || 'unknown');
        const data = { course: courseName, module: moduleName, questions, ...meta, createdAt: new Date() };
        try {
          await QuizModel.findOneAndUpdate({ course: courseName, module: moduleName }, { $setOnInsert: data }, { upsert: true });
          logPipeline('SAVED TO MONGO', `Quiz ${courseName}/${moduleName}`);
        } catch (e) { /* ok */ }
        await setRedis(cacheKey, data);
        return { ...data, _source: provider };
      }
    }
  } catch (e) {
    log.warn('PIPELINE', `Quiz generation failed: ${e.message}`);
  }

  const fallback = generateFallbackQuestions(courseName, moduleName, 'medium');
  const meta = buildMetadata('template', 'fallback');
  const data = { course: courseName, module: moduleName, questions: fallback, ...meta, createdAt: new Date() };
  await setRedis(cacheKey, data);
  return { ...data, _source: 'template' };
}

// ── CONCEPT MAP GENERATION ────────────────────────────────────────────

async function generateOrRetrieveConceptMap(courseName, topic) {
  const cacheKey = `conceptmap:${courseName}:${topic}`;

  const cached = await getRedis(cacheKey);
  if (cached) return { ...cached, _source: 'redis_cache' };

  logPipeline('DATABASE', `Checking ConceptMap collection for ${courseName}/${topic}`);
  const existing = await ConceptMap.findOne({ course: courseName, topic }).lean();
  if (existing) {
    logPipeline('DATABASE HIT', `ConceptMap ${courseName}/${topic}`);
    await setRedis(cacheKey, existing);
    return { ...existing, _source: 'mongodb' };
  }

  logPipeline('GENERATING', `ConceptMap for ${courseName}/${topic}`);
  const prompt = `You are creating a concept map for "${topic}" within "${courseName}".

Return a JSON object with:
{
  "concepts": [{"id": "string", "label": "string", "description": "string"}],
  "relationships": [{"sourceId": "string", "targetId": "string", "label": "string"}]
}

Describe 8-12 key concepts and how they relate to each other.
Use clear, descriptive labels for relationships.

Valid JSON only.`;

  try {
    const result = await callWithFallback({
      userQuery: prompt,
      systemPrompt: 'Return ONLY valid JSON concept map object.',
      chatHistory: [],
      preferredProvider: 'sglang',
      options: { temperature: 0.5, maxOutputTokens: 4096, timeout: 60000 },
    });
    const provider = result?.provider || 'unknown';
    logPipeline(`GENERATED VIA ${provider.toUpperCase()}`, `ConceptMap for ${courseName}/${topic}`);

    const text = result?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const map = JSON.parse(jsonMatch[0]);
        if (map.concepts && map.relationships && map.concepts.length >= 3) {
          const meta = buildMetadata(provider, result?.model || 'unknown');
          const data = { course: courseName, topic, ...map, ...meta, createdAt: new Date() };
          try {
            await ConceptMap.findOneAndUpdate({ course: courseName, topic }, { $setOnInsert: data }, { upsert: true });
            logPipeline('SAVED TO MONGO', `ConceptMap ${courseName}/${topic}`);
          } catch (e) { /* ok */ }
          await setRedis(cacheKey, data);
          return { ...data, _source: provider };
        }
      } catch (e) { /* not valid JSON */ }
    }
  } catch (e) {
    log.warn('PIPELINE', `ConceptMap generation failed: ${e.message}`);
  }

  // Fallback concept map
  const meta = buildMetadata('template', 'fallback');
  const data = {
    course: courseName, topic,
    concepts: [
      { id: 'c1', label: topic, description: `Core concept of ${topic}` },
      { id: 'c2', label: `${topic} Fundamentals`, description: `Foundational principles of ${topic}` },
      { id: 'c3', label: `${topic} Applications`, description: `Practical applications of ${topic}` },
    ],
    relationships: [
      { sourceId: 'c2', targetId: 'c1', label: 'supports' },
      { sourceId: 'c3', targetId: 'c1', label: 'extends' },
    ],
    ...meta, createdAt: new Date(),
  };
  await setRedis(cacheKey, data);
  return { ...data, _source: 'template' };
}

function findStoredLecture(courseName, subtopicId) {
  const result = { markdown: null, html: null, conceptMap: null };
  if (!fs.existsSync(LECTURES_DIR)) return result;

  const entries = fs.readdirSync(LECTURES_DIR);
  for (const entry of entries) {
    const entryPath = path.join(LECTURES_DIR, entry);
    if (!fs.statSync(entryPath).isDirectory()) continue;

    const lectureMdPath = path.join(entryPath, 'lecture.md');
    if (!fs.existsSync(lectureMdPath)) continue;

    const content = fs.readFileSync(lectureMdPath, 'utf8');
    const firstLine = content.split('\n')[0] || '';

    if (firstLine.toLowerCase().includes(courseName.toLowerCase()) ||
        entry.toLowerCase().includes(courseName.toLowerCase())) {

      result.markdown = content;
      const htmlPath = path.join(entryPath, 'lecture.html');
      const cmPath = path.join(entryPath, 'concept_map.html');
      result.html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : null;
      result.conceptMap = fs.existsSync(cmPath) ? cmPath : null;

      if (subtopicId && content) {
        const sectionMatch = content.match(new RegExp(`##[^\\n]*${escapeRegex(subtopicId)}[^\\n]*\\n[\\s\\S]*?(?=\\n##|$)`, 'i'));
        if (sectionMatch) result.markdown = sectionMatch[0];
      }
      return result;
    }
  }
  return result;
}

module.exports = {
  generateOrRetrieveLecture,
  generateOrRetrieveSkillTreeLevels,
  generateOrRetrieveLevelQuestions,
  generateOrRetrieveAssessment,
  generateOrRetrieveQuiz,
  generateOrRetrieveConceptMap,
  bootstrapCourse,
  shuffleOptions,
  validateAnswerDistribution,
  logPipeline,
};
