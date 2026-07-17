const ConceptQuestionBank = require('../models/ConceptQuestionBank');
const { callWithFallback } = require('./llmFallbackService');
const semanticSimilarity = require('./semanticSimilarityService');
const log = require('../utils/logger');

const TARGET_QUESTIONS_PER_CONCEPT = 30;
const BLOOM_LEVELS = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];

const CACHE_TTL = 7 * 24 * 3600;

let redisClientInstance;
try {
  const redisModule = require('../config/redisClient');
  redisClientInstance = redisModule.redisClient;
} catch { }

async function getRedis(key) {
  try {
    if (redisClientInstance && redisClientInstance.isOpen) {
      const val = await redisClientInstance.get(key);
      if (val) return JSON.parse(val);
    }
  } catch { }
  return null;
}

async function setRedis(key, data) {
  try {
    if (redisClientInstance && redisClientInstance.isOpen) {
      await redisClientInstance.setEx(key, CACHE_TTL, JSON.stringify(data));
    }
  } catch { }
}

function shuffleOptions(question) {
  const options = [...question.options];
  const originalCorrectIndex = question.correctIndex;

  const correctText = options[originalCorrectIndex];

  const indices = [0, 1, 2, 3];
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  const shuffled = indices.map(i => options[i]);
  const newCorrectIndex = indices.indexOf(originalCorrectIndex);

  return {
    ...question,
    options: shuffled,
    correctIndex: newCorrectIndex,
    _shuffleApplied: true,
  };
}

function validateEvenDistribution(questions) {
  const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const q of questions) {
    const idx = q.correctIndex;
    if (idx >= 0 && idx <= 3) counts[idx]++;
  }
  const total = questions.length;
  const ideal = total / 4;
  let chiSq = 0;
  for (let i = 0; i < 4; i++) {
    chiSq += ((counts[i] - ideal) ** 2) / ideal;
  }
  const balanced = chiSq <= 7.815;
  log.info('CONCEPT_QB', `Distribution: ${JSON.stringify(counts)}, χ²=${chiSq.toFixed(2)}, balanced=${balanced}`);
  return { counts, chiSq, balanced };
}

async function checkDuplicate(questionText, existingQuestions) {
  try {
    const existingTexts = existingQuestions.map(q => q.question).filter(Boolean);
    if (existingTexts.length === 0) return { isDuplicate: false };

    const result = await semanticSimilarity.checkQuestionDuplicate(questionText, existingTexts, 0.82);
    return result;
  } catch {
    const exact = existingQuestions.some(q =>
      q.question?.toLowerCase().trim() === questionText.toLowerCase().trim()
    );
    return { isDuplicate: exact, similarity: exact ? 1 : 0 };
  }
}

async function ensureQuestionsForConcept({ course, concept, topic, moduleName, forceGenerate = false }) {
  const conceptKey = concept.toLowerCase().trim();
  const cacheKey = `concept_qb:${course}:${conceptKey}`;

  if (!forceGenerate) {
    const cached = await getRedis(cacheKey);
    if (cached && Array.isArray(cached) && cached.length >= 10) {
      log.info('CONCEPT_QB', `Cache hit: ${course}/${concept} (${cached.length} questions)`);
      return cached;
    }

    const existing = await ConceptQuestionBank.find({
      course: { $regex: new RegExp(`^${escapeRegex(course)}$`, 'i') },
      concept: { $regex: new RegExp(`^${escapeRegex(conceptKey)}$`, 'i') },
    }).lean();

    if (existing.length >= 10) {
      log.info('CONCEPT_QB', `DB hit: ${course}/${concept} (${existing.length} questions)`);
      await setRedis(cacheKey, existing);
      return existing;
    }
  }

  log.info('CONCEPT_QB', `Generating questions for ${course}/${concept}`);
  const generated = await generateConceptQuestions({ course, concept, topic, moduleName });

  if (generated.length > 0) {
    const saved = await saveQuestionsToBank(generated, { course, concept, topic, moduleName });
    if (saved.length > 0) {
      await setRedis(cacheKey, saved);
    }
    return saved.length > 0 ? saved : generated;
  }

  const existing = await ConceptQuestionBank.find({
    course: { $regex: new RegExp(`^${escapeRegex(course)}$`, 'i') },
    concept: { $regex: new RegExp(`^${escapeRegex(conceptKey)}$`, 'i') },
  }).lean();
  return existing;
}

function generateFallbackQuestions({ course, concept, topic, moduleName, count }) {
  const name = concept || topic || course;
  const fallbacks = [];

  const templates = [
    { q: `What is the primary purpose of ${name}?`, e: `${name} is a fundamental concept designed to address specific needs in ${course || 'this domain'}. Understanding its purpose is essential for building more complex knowledge.`, lo: `Define the core purpose of ${name}`, d: 'easy', bl: 'remember' },
    { q: `Which of the following best describes a key characteristic of ${name}?`, e: `Identifying the key characteristics of ${name} helps distinguish it from related concepts and clarifies when to apply it.`, lo: `Describe the key characteristics of ${name}`, d: 'easy', bl: 'understand' },
    { q: `In the context of ${course || 'computer science'}, which scenario best demonstrates the application of ${name}?`, e: `Real-world scenarios help connect theoretical knowledge of ${name} to practical implementation. Recognizing these patterns is crucial for effective problem-solving.`, lo: `Apply ${name} to real-world scenarios`, d: 'medium', bl: 'apply' },
    { q: `What is a common mistake when implementing ${name}?`, e: `Understanding common pitfalls when working with ${name} helps prevent errors and leads to more robust implementations.`, lo: `Identify common errors in implementing ${name}`, d: 'medium', bl: 'analyze' },
    { q: `How does ${name} compare to alternative approaches in ${course || 'this domain'}?`, e: `Comparative analysis of ${name} against alternatives develops critical thinking about trade-offs in design and implementation decisions.`, lo: `Compare ${name} with alternative approaches`, d: 'hard', bl: 'evaluate' },
    { q: `What is the time complexity of the most efficient implementation of ${name}?`, e: `Understanding the efficiency characteristics of ${name} is crucial for making informed decisions about when to use it in performance-critical applications.`, lo: `Analyze the efficiency of ${name}`, d: 'medium', bl: 'analyze' },
    { q: `Which of the following is NOT a valid use case for ${name}?`, e: `Knowing the limitations of ${name} is as important as knowing its strengths. This helps avoid applying it in inappropriate contexts.`, lo: `Recognize the limitations of ${name}`, d: 'medium', bl: 'understand' },
    { q: `What prerequisite knowledge is most important before learning ${name}?`, e: `${name} builds upon foundational concepts. Understanding the prerequisite knowledge helps create a structured learning path.`, lo: `Identify prerequisites for ${name}`, d: 'easy', bl: 'remember' },
    { q: `Design an approach to solve a complex problem using ${name}. What is the first step?`, e: `Solving complex problems with ${name} requires systematic thinking. Breaking down the problem is the first critical step toward an effective solution.`, lo: `Design solutions using ${name}`, d: 'hard', bl: 'create' },
    { q: `What is the relationship between ${name} and other concepts in ${course || 'this field'}?`, e: `Understanding how ${name} relates to other concepts builds a comprehensive mental model of the subject domain.`, lo: `Evaluate the role of ${name}`, d: 'hard', bl: 'evaluate' },
    { q: `What is the best data structure to use when implementing ${name}?`, e: `Choosing the right data structure for ${name} is critical for achieving optimal performance and maintainability.`, lo: `Select appropriate data structures for ${name}`, d: 'medium', bl: 'apply' },
    { q: `How does ${name} handle edge cases such as empty input or boundary conditions?`, e: `Robust implementations of ${name} must handle edge cases gracefully to prevent errors and ensure reliability.`, lo: `Analyze edge case handling in ${name}`, d: 'medium', bl: 'analyze' },
    { q: `Which testing strategy is most effective for validating a ${name} implementation?`, e: `Proper testing of ${name} requires a combination of unit tests, integration tests, and property-based testing to cover all scenarios.`, lo: `Design test strategies for ${name}`, d: 'hard', bl: 'create' },
    { q: `What is the memory usage profile of a typical ${name} implementation?`, e: `Understanding the memory characteristics of ${name} helps in resource-constrained environments and large-scale applications.`, lo: `Analyze memory usage of ${name}`, d: 'medium', bl: 'analyze' },
    { q: `Which of the following problems is best solved using ${name}?`, e: `Identifying the right problem domain for ${name} is essential for applying it effectively and avoiding unnecessary complexity.`, lo: `Apply ${name} to appropriate problems`, d: 'easy', bl: 'apply' },
    { q: `What is the key difference between ${name} and a related but distinct concept?`, e: `Understanding the distinctions between ${name} and similar concepts prevents confusion and leads to more precise problem-solving.`, lo: `Differentiate ${name} from related concepts`, d: 'medium', bl: 'understand' },
    { q: `How would you modify ${name} to improve its performance for large inputs?`, e: `Optimizing ${name} for large-scale inputs requires understanding its bottlenecks and applying algorithmic improvements.`, lo: `Optimize ${name} for performance`, d: 'hard', bl: 'create' },
    { q: `What invariant must hold true throughout the execution of ${name}?`, e: `Invariants in ${name} are properties that must always be true, and violating them leads to incorrect behavior.`, lo: `Identify invariants in ${name}`, d: 'hard', bl: 'evaluate' },
    { q: `Which of the following is a real-world system that commonly uses ${name}?`, e: `${name} is used in many real-world systems. Recognizing these applications helps bridge theory and practice.`, lo: `Recognize real-world applications of ${name}`, d: 'easy', bl: 'remember' },
    { q: `How does input size affect the behavior of ${name}?`, e: `The scalability of ${name} depends on how its time and space requirements grow with input size, which determines practical limits.`, lo: `Analyze scalability of ${name}`, d: 'medium', bl: 'analyze' },
    { q: `What is a common optimization technique for ${name}?`, e: `Optimizations for ${name} often involve trade-offs between time, space, and code complexity that must be carefully evaluated.`, lo: `Evaluate optimization techniques for ${name}`, d: 'hard', bl: 'evaluate' },
    { q: `How would you explain ${name} to someone with no technical background?`, e: `Teaching ${name} to non-technical audiences requires using analogies and simplified explanations while preserving accuracy.`, lo: `Explain ${name} using analogies`, d: 'easy', bl: 'understand' },
    { q: `What debugging approach would you use to find a bug in a ${name} implementation?`, e: `Debugging ${name} requires systematic isolation of the component and understanding the expected behavior at each step.`, lo: `Debug ${name} implementations`, d: 'medium', bl: 'apply' },
    { q: `Which academic paper or researcher is most associated with pioneering ${name}?`, e: `Understanding the origins of ${name} provides context for its development and the problems it was designed to solve.`, lo: `Recall the origins of ${name}`, d: 'easy', bl: 'remember' },
    { q: `What are two variants of ${name} and how do they differ?`, e: `Variants of ${name} exist to address different constraints or use cases. Comparing them helps in selecting the right approach.`, lo: `Compare variants of ${name}`, d: 'hard', bl: 'evaluate' },
    { q: `How would you parallelize an implementation of ${name}?`, e: `Parallelizing ${name} can provide significant speedups on multi-core systems but requires careful handling of dependencies and synchronization.`, lo: `Design a parallel version of ${name}`, d: 'hard', bl: 'create' },
    { q: `What metric is most important when evaluating the quality of a ${name} implementation?`, e: `Different metrics (speed, memory, readability, correctness) trade off against each other. The most important depends on the application context.`, lo: `Evaluate quality metrics for ${name}`, d: 'medium', bl: 'evaluate' },
    { q: `Which programming language features are most relevant when implementing ${name}?`, e: `Language features like generics, closures, or pattern matching can significantly affect how cleanly and efficiently ${name} can be expressed.`, lo: `Select language features for ${name}`, d: 'medium', bl: 'apply' },
    { q: `How does the choice of ${name} affect overall system architecture?`, e: `Architectural decisions around ${name} can have far-reaching implications for system maintainability, performance, and evolvability.`, lo: `Analyze architectural impact of ${name}`, d: 'hard', bl: 'analyze' },
    { q: `What future developments or research directions are most promising for ${name}?`, e: `${name} continues to evolve. Understanding emerging trends helps in making forward-looking design decisions.`, lo: `Evaluate future directions for ${name}`, d: 'hard', bl: 'create' },
  ];

  for (let i = 0; i < count; i++) {
    const t = templates[i % templates.length];
    fallbacks.push({
      question: t.q,
      options: generateFallbackOptions(name, t.d),
      correctIndex: 0,
      explanation: t.e,
      difficulty: t.d,
      bloomLevel: t.bl,
      learningObjective: t.lo,
      estimatedTime: `${[30, 60, 60, 90, 120][i % 5]}s`,
      confidence: 0.8,
      _provider: 'fallback',
      _model: 'template',
    });
  }

  return fallbacks.map(q => shuffleOptions(q));
}

function generateFallbackOptions(concept, difficulty) {
  const wrongAnswers = [
    `It is used primarily for data storage without any processing capabilities`,
    `It replaces all other approaches in ${concept}'s domain entirely`,
    `It has no practical application in modern ${concept} development`,
    `It is only relevant for theoretical study and not for real-world use`,
    `It can be implemented without understanding any underlying principles`,
    `Its performance degrades linearly with any input regardless of implementation`,
    `It only works for small-scale problems and cannot be scaled`,
    `It requires no memory allocation or resource management`,
  ];
  const shuffledWrongs = [...wrongAnswers].sort(() => Math.random() - 0.5);
  const correct = `Understanding ${concept} enables efficient problem-solving and forms a foundation for advanced topics in the domain.`;
  const distractors = shuffledWrongs.slice(0, 3);
  const allOptions = [correct, ...distractors];
  for (let i = allOptions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allOptions[i], allOptions[j]] = [allOptions[j], allOptions[i]];
  }
  return allOptions;
}

async function generateConceptQuestions({ course, concept, topic, moduleName }) {
  const name = concept || topic || course;
  const initialTarget = 10;
  const allQuestions = [];
  const bloomDistribution = [
    { level: 'remember', count: 4 },
    { level: 'understand', count: 6 },
    { level: 'apply', count: 8 },
    { level: 'analyze', count: 6 },
    { level: 'evaluate', count: 4 },
    { level: 'create', count: 2 },
  ];

  const difficultyDistribution = [
    { level: 'easy', count: 10 },
    { level: 'medium', count: 12 },
    { level: 'hard', count: 8 },
  ];

  const generationStart = Date.now();
  const GENERATION_TIMEOUT = 10_000;

  for (let batch = 0; batch < Math.ceil(initialTarget / 10); batch++) {
    if (Date.now() - generationStart > GENERATION_TIMEOUT) {
      log.info('CONCEPT_QB', `Generation timeout reached after ${Date.now() - generationStart}ms — stopping batch loop`);
      break;
    }
    const remaining = initialTarget - allQuestions.length;
    if (remaining <= 0) break;
    const count = Math.min(10, remaining);

    const bloomSample = bloomDistribution.map(b => ({
      ...b,
      count: Math.max(1, Math.round(b.count * (count / TARGET_QUESTIONS_PER_CONCEPT))),
    }));
    const difficultySample = difficultyDistribution.map(d => ({
      ...d,
      count: Math.max(1, Math.round(d.count * (count / TARGET_QUESTIONS_PER_CONCEPT))),
    }));

    const prompt = `You are an expert assessment designer creating high-quality multiple-choice questions.

Course: ${course || 'General'}
${topic ? `Topic: ${topic}` : ''}
${moduleName ? `Module: ${moduleName}` : ''}
Concept: ${name}

Generate exactly ${count} multiple-choice questions that deeply test understanding of "${name}".

REQUIREMENTS:
- Questions must test actual conceptual understanding, NOT trivial facts
- Cover a range of difficulties and Bloom's Taxonomy levels
- Each question must have exactly 4 distinct, plausible options
- Distribute correct answers evenly across positions (A, B, C, D)
- Provide detailed explanations that explain why the correct answer is right and why distractors are wrong

Bloom's distribution target:
${bloomSample.map(b => `- ${b.level}: ${b.count} questions`).join('\n')}

Difficulty distribution target:
${difficultySample.map(d => `- ${d.level}: ${d.count} questions`).join('\n')}

Return a JSON array of objects with this exact structure:
[
  {
    "question": "string — the MCQ question text",
    "options": ["option A", "option B", "option C", "option D"],
    "correctIndex": 0-3,
    "explanation": "string — detailed explanation",
    "difficulty": "easy|medium|hard",
    "bloomLevel": "remember|understand|apply|analyze|evaluate|create",
    "learningObjective": "string — what knowledge this assesses",
    "estimatedTime": "30s|60s|90s|120s",
    "confidence": 0.0-1.0
  }
]

Valid JSON array only, no markdown.`;

    try {
      const providerHealth = require('./providerHealthCache');
      const healthyProviders = providerHealth.getHealthyProviders(['sglang', 'groq', 'gemini', 'openai', 'ollama']);
      const preferredProvider = healthyProviders.length > 0 ? healthyProviders[0] : 'sglang';
      const result = await callWithFallback({
        userQuery: prompt,
        systemPrompt: 'Return ONLY valid JSON array of MCQ objects with all required fields.',
        chatHistory: [],
        preferredProvider,
        options: { temperature: 0.7 + batch * 0.05, maxOutputTokens: 8192 },
      });

      const text = result?.text || '';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        let parsed;
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          continue;
        }

        if (Array.isArray(parsed)) {
          const normalized = parsed
            .map(q => ({
              question: q.question || '',
              options: (q.options || []).slice(0, 4).map(o => String(o).replace(/^[A-Da-d][.):\-]\s*/, '')),
              correctIndex: resolveCorrectIndex(q),
              explanation: q.explanation || '',
              difficulty: ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : 'medium',
              bloomLevel: BLOOM_LEVELS.includes(q.bloomLevel) ? q.bloomLevel : 'understand',
              learningObjective: q.learningObjective || `Assess understanding of ${name}`,
              estimatedTime: ['30s', '60s', '90s', '120s'].includes(q.estimatedTime) ? q.estimatedTime : '60s',
              confidence: typeof q.confidence === 'number' && q.confidence >= 0 && q.confidence <= 1 ? q.confidence : 0.8,
              _provider: result?.provider || 'unknown',
              _model: result?.model || 'unknown',
            }))
            .filter(q => q.question && q.options.length === 4 && q.options.every(o => o))
            .map(q => shuffleOptions(q));

          allQuestions.push(...normalized);
        }
      }
    } catch (e) {
      log.warn('CONCEPT_QB', `Batch ${batch + 1} generation failed: ${e.message}`);
    }
  }

  // Fallback: if LLM returned no questions, use template questions
  if (allQuestions.length === 0) {
    log.info('CONCEPT_QB', `LLM providers exhausted — using template fallback for ${name}`);
    const templateQuestions = generateFallbackQuestions({ course, concept, topic, moduleName, count: initialTarget });
    allQuestions.push(...templateQuestions);
  }

  const distribution = validateEvenDistribution(allQuestions);
  log.info('CONCEPT_QB', `Generated ${allQuestions.length} questions for ${name} in ${Date.now() - generationStart}ms. Distribution balanced: ${distribution.balanced}`);

  // Fire-and-forget: generate remaining questions in background
  const existing = await ConceptQuestionBank.find({
    course: { $regex: new RegExp(`^${escapeRegex(course)}$`, 'i') },
    concept: { $regex: new RegExp(`^${escapeRegex(concept)}$`, 'i') },
  }).lean();
  if (existing.length < TARGET_QUESTIONS_PER_CONCEPT) {
    generateRemainingQuestions({ course, concept, topic, moduleName, allQuestions, existing });
  }

  return allQuestions;
}

async function generateRemainingQuestions({ course, concept, topic, moduleName, allQuestions, existing }) {
  const name = concept || topic || course;
  const totalExisting = allQuestions.length + existing.length;
  if (totalExisting >= TARGET_QUESTIONS_PER_CONCEPT) return;

  const existingTexts = new Set([
    ...existing.map(q => q.question?.toLowerCase().trim()),
    ...allQuestions.map(q => q.question?.toLowerCase().trim()),
  ]);

  const remainingCount = TARGET_QUESTIONS_PER_CONCEPT - totalExisting;
  const extraBatches = Math.ceil(remainingCount / 10);
  const persisted = [];

  for (let batch = 0; batch < extraBatches; batch++) {
    const count = Math.min(10, TARGET_QUESTIONS_PER_CONCEPT - totalExisting - persisted.length);
    if (count <= 0) break;

    const prompt = `You are an expert assessment designer creating high-quality multiple-choice questions.

Course: ${course || 'General'}
${topic ? `Topic: ${topic}` : ''}
${moduleName ? `Module: ${moduleName}` : ''}
Concept: ${name}

Generate exactly ${count} multiple-choice questions that deeply test understanding of "${name}".

REQUIREMENTS:
- Questions must test actual conceptual understanding, NOT trivial facts
- Each question must have exactly 4 distinct, plausible options
- Distribute correct answers evenly across positions (A, B, C, D)
- Provide detailed explanations

Return a JSON array of objects with:
["question", "options", "correctIndex", "explanation", "difficulty", "bloomLevel", "learningObjective", "estimatedTime", "confidence"]

Valid JSON array only, no markdown.`;

    try {
      const providerHealth = require('./providerHealthCache');
      const healthyProviders = providerHealth.getHealthyProviders(['sglang', 'groq', 'gemini', 'openai', 'ollama']);
      const preferredProvider = healthyProviders.length > 0 ? healthyProviders[0] : 'sglang';
      const result = await callWithFallback({
        userQuery: prompt,
        systemPrompt: 'Return ONLY valid JSON array of MCQ objects.',
        chatHistory: [],
        preferredProvider,
        options: { temperature: 0.8, maxOutputTokens: 8192 },
      });

      const text = result?.text || '';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        let parsed;
        try { parsed = JSON.parse(jsonMatch[0]); } catch { continue; }
        if (Array.isArray(parsed)) {
          const normalized = parsed
            .map(q => ({
              question: q.question || '',
              options: (q.options || []).slice(0, 4).map(o => String(o).replace(/^[A-Da-d][.):\-]\s*/, '')),
              correctIndex: resolveCorrectIndex(q),
              explanation: q.explanation || '',
              difficulty: ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : 'medium',
              bloomLevel: BLOOM_LEVELS.includes(q.bloomLevel) ? q.bloomLevel : 'understand',
              learningObjective: q.learningObjective || `Assess understanding of ${name}`,
              estimatedTime: ['30s', '60s', '90s', '120s'].includes(q.estimatedTime) ? q.estimatedTime : '60s',
              confidence: typeof q.confidence === 'number' && q.confidence >= 0 && q.confidence <= 1 ? q.confidence : 0.8,
              _provider: result?.provider || 'unknown',
              _model: result?.model || 'unknown',
            }))
            .filter(q => q.question && q.options.length === 4 && q.options.every(o => o) && !existingTexts.has(q.question.toLowerCase().trim()))
            .map(q => shuffleOptions(q));

          for (const question of normalized) {
            try {
              const doc = await ConceptQuestionBank.findOneAndUpdate(
                {
                  course: { $regex: new RegExp(`^${escapeRegex(course)}$`, 'i') },
                  concept: { $regex: new RegExp(`^${escapeRegex(concept)}$`, 'i') },
                  question: question.question,
                },
                {
                  $setOnInsert: {
                    course, concept, topic: topic || '', moduleName: moduleName || '',
                    question: question.question, options: question.options,
                    correctIndex: question.correctIndex, explanation: question.explanation,
                    difficulty: question.difficulty, bloomLevel: question.bloomLevel,
                    learningObjective: question.learningObjective, estimatedTime: question.estimatedTime,
                    confidence: question.confidence,
                    generatedBy: question._provider || '', model: question._model || '',
                    pipelineVersion: 'v2', generatedAt: new Date(),
                    conceptTags: [concept, topic].filter(Boolean),
                  },
                },
                { upsert: true, new: true }
              );
              persisted.push(doc.toObject());
              existingTexts.add(question.question.toLowerCase().trim());
            } catch { /* skip dup */ }
          }
        }
      }
    } catch { /* background gen failed silently */ }
  }

  if (persisted.length > 0) {
    const cacheKey = `concept_qb:${course}:${concept.toLowerCase().trim()}`;
    try {
      const allDocs = await ConceptQuestionBank.find({
        course: { $regex: new RegExp(`^${escapeRegex(course)}$`, 'i') },
        concept: { $regex: new RegExp(`^${escapeRegex(concept)}$`, 'i') },
      }).lean();
      await setRedis(cacheKey, allDocs);
    } catch { /* ok */ }
    log.info('CONCEPT_QB', `Background: persisted ${persisted.length} additional questions for ${name}`);
  }
}

async function saveQuestionsToBank(questions, { course, concept, topic, moduleName }) {
  const saved = [];
  const existing = await ConceptQuestionBank.find({
    course: { $regex: new RegExp(`^${escapeRegex(course)}$`, 'i') },
    concept: { $regex: new RegExp(`^${escapeRegex(concept)}$`, 'i') },
  }).lean();

  for (const q of questions) {
    try {
      const dupResult = await checkDuplicate(q.question, [...existing, ...saved]);

      if (dupResult.isDuplicate) {
        const matchedSim = dupResult.similarity ? ` (sim: ${dupResult.similarity.toFixed(3)})` : '';
        log.info('CONCEPT_QB', `Skipping duplicate: "${q.question.substring(0, 60)}..."${matchedSim}`);
        continue;
      }

      const doc = await ConceptQuestionBank.findOneAndUpdate(
        {
          course: { $regex: new RegExp(`^${escapeRegex(course)}$`, 'i') },
          concept: { $regex: new RegExp(`^${escapeRegex(concept)}$`, 'i') },
          question: q.question,
        },
        {
          $setOnInsert: {
            course,
            concept,
            topic: topic || '',
            moduleName: moduleName || '',
            question: q.question,
            options: q.options,
            correctIndex: q.correctIndex,
            explanation: q.explanation,
            difficulty: q.difficulty,
            bloomLevel: q.bloomLevel,
            learningObjective: q.learningObjective,
            estimatedTime: q.estimatedTime,
            confidence: q.confidence,
            generatedBy: q._provider || '',
            model: q._model || '',
            pipelineVersion: 'v2',
            generatedAt: new Date(),
            conceptTags: [concept, topic].filter(Boolean),
          },
        },
        { upsert: true, new: true }
      );
      saved.push(doc.toObject());
    } catch (e) {
      log.warn('CONCEPT_QB', `Save failed for question: ${e.message}`);
    }
  }

  log.info('CONCEPT_QB', `Saved ${saved.length}/${questions.length} questions to bank for ${course}/${concept}`);
  return saved;
}

async function selectQuestionsForLevel({ course, concept, count = 5, seenQuestionIds = [], userId }) {
  const allQuestions = await ensureQuestionsForConcept({ course, concept });

  if (allQuestions.length === 0) return [];

  const seenSet = new Set(seenQuestionIds.map(s => s.toLowerCase().trim()));

  const annotated = allQuestions.map(q => ({
    ...q,
    _usageCount: q.usageCount || 0,
    _seen: seenSet.has(q.question?.toLowerCase().trim()),
    _lastUsed: q.lastUsedAt ? new Date(q.lastUsedAt).getTime() : 0,
    _successRate: q.usageCount > 0 ? (q.successCount || 0) / q.usageCount : 0.5,
    _random: Math.random(),
  }));

  const unseenFirst = annotated.sort((a, b) => {
    if (a._seen !== b._seen) return a._seen ? 1 : -1;
    if (a._usageCount !== b._usageCount) return a._usageCount - b._usageCount;
    if (a._lastUsed !== b._lastUsed) return a._lastUsed - b._lastUsed;
    return a._random - b._random;
  });

  const selected = unseenFirst.slice(0, count);

  return selected.map(q => ({
    question: q.question,
    options: q.options,
    correctIndex: q.correctIndex,
    explanation: q.explanation,
    difficulty: q.difficulty,
    bloomLevel: q.bloomLevel,
    learningObjective: q.learningObjective,
    estimatedTime: q.estimatedTime,
    confidence: q.confidence,
    _id: q._id,
  }));
}

async function recordQuestionAttempt(questionId, userId, correct) {
  try {
    const q = await ConceptQuestionBank.findById(questionId);
    if (!q) return;

    q.usageCount = (q.usageCount || 0) + 1;
    if (correct) q.successCount = (q.successCount || 0) + 1;
    q.lastUsedAt = new Date();
    q.studentHistory.push({ userId, correct, answeredAt: new Date() });

    if (q.studentHistory.length > 50) {
      q.studentHistory = q.studentHistory.slice(-50);
    }

    await q.save();
  } catch (e) {
    log.warn('CONCEPT_QB', `Failed to record attempt: ${e.message}`);
  }
}

async function getQuestionAnalytics(concept, course) {
  const match = {};
  if (concept) match.concept = { $regex: new RegExp(escapeRegex(concept), 'i') };
  if (course) match.course = { $regex: new RegExp(`^${escapeRegex(course)}$`, 'i') };

  const questions = await ConceptQuestionBank.find(match).lean();
  const total = questions.length;
  const totalUsage = questions.reduce((s, q) => s + (q.usageCount || 0), 0);
  const totalCorrect = questions.reduce((s, q) => s + (q.successCount || 0), 0);
  const overallSuccessRate = totalUsage > 0 ? Math.round((totalCorrect / totalUsage) * 100) : 0;

  const byDifficulty = { easy: { total: 0, usage: 0, correct: 0 }, medium: { total: 0, usage: 0, correct: 0 }, hard: { total: 0, usage: 0, correct: 0 } };
  const byBloom = {};

  for (const q of questions) {
    const d = q.difficulty || 'medium';
    if (byDifficulty[d]) {
      byDifficulty[d].total++;
      byDifficulty[d].usage += q.usageCount || 0;
      byDifficulty[d].correct += q.successCount || 0;
    }
    const bl = q.bloomLevel || 'understand';
    if (!byBloom[bl]) byBloom[bl] = { total: 0, usage: 0, correct: 0 };
    byBloom[bl].total++;
    byBloom[bl].usage += q.usageCount || 0;
    byBloom[bl].correct += q.successCount || 0;
  }

  return {
    total,
    totalUsage,
    overallSuccessRate,
    byDifficulty,
    byBloom,
    lastGeneratedAt: questions.length > 0 ? questions[questions.length - 1].generatedAt : null,
  };
}

function resolveCorrectIndex(q) {
  if (typeof q.correctIndex === 'number' && q.correctIndex >= 0 && q.correctIndex < 4) return q.correctIndex;
  if (typeof q.correctIndex === 'string' && /^\d$/.test(q.correctIndex)) return parseInt(q.correctIndex);
  if (typeof q.answer === 'string' && /^[A-Da-d]$/.test(q.answer)) return q.answer.toUpperCase().charCodeAt(0) - 65;
  if (typeof q.correct === 'string' && /^[A-Da-d]$/.test(q.correct)) return q.correct.toUpperCase().charCodeAt(0) - 65;
  return 0;
}

function escapeRegex(str) {
  return (str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  ensureQuestionsForConcept,
  generateConceptQuestions,
  saveQuestionsToBank,
  selectQuestionsForLevel,
  recordQuestionAttempt,
  getQuestionAnalytics,
  shuffleOptions,
  validateEvenDistribution,
  checkDuplicate,
};
