// server/services/questionGeneratorService.js
const { callWithFallback } = require('./llmFallbackService');
const { getCurriculumStructure } = require('./socraticTutorService');
const { queryPythonRagService } = require('./ragQueryService');
const { redisClient } = require('../config/redisClient');
const log = require('../utils/logger');

const QUIZ_CACHE_TTL = 3600; // 1 hour
const SEEN_QUESTIONS_TTL = 30 * 24 * 3600; // 30 days
const MAX_CONTEXT_LENGTH = 2500; // Truncate context to reduce prompt size

/**
 * Get Redis key for tracking seen questions per user per course/module
 */
function getSeenQuizQuestionsKey(userId, courseName, moduleName) {
    const mod = moduleName || 'general';
    return `seen_quiz_questions:${userId}:${courseName}:${mod}`;
}

/**
 * Get previously seen question texts for replay protection
 */
async function getSeenQuizQuestions(userId, courseName, moduleName) {
    if (!userId || !redisClient?.isOpen) return [];
    try {
        const key = getSeenQuizQuestionsKey(userId, courseName, moduleName);
        const val = await redisClient.get(key);
        if (val) return JSON.parse(val);
    } catch (e) { /* ignore */ }
    return [];
}

/**
 * Add new question texts to seen set
 */
async function addSeenQuizQuestions(userId, courseName, moduleName, questionTexts) {
    if (!userId || !redisClient?.isOpen || !questionTexts?.length) return;
    try {
        const key = getSeenQuizQuestionsKey(userId, courseName, moduleName);
        const existing = await getSeenQuizQuestions(userId, courseName, moduleName);
        const combined = [...new Set([...existing, ...questionTexts])].slice(-100); // Keep last 100
        await redisClient.setEx(key, SEEN_QUESTIONS_TTL, JSON.stringify(combined));
    } catch (e) { /* ignore */ }
}

/**
 * Shared Question Generator Service
 * Centralizes the adaptive quiz generation logic, ensuring:
 *  - Unified LLM invocation via callWithFallback
 *  - Proper curriculum hierarchy fallback when PDF RAG context is missing
 *  - Exact question layout structure and difficulty distributions
 */

/**
 * Generate Socratic Quiz: 10 questions (7 MCQs, 3 Descriptive)
 */
async function generateSocraticQuiz({ courseName, moduleId, moduleName, user }) {
    const t0 = Date.now();
    let cacheKey = null; // accessible in both try and catch blocks
    try {
        const learningStage = user?.profile?.learningStage || 'Beginner';
        const userId = user?._id;

        // ── REPLAY PROTECTION: Get previously seen question IDs for this user/course/module ──────────────────
        let seenQuestionIds = [];
        if (userId && redisClient) {
            const seenKey = `quiz:seen:${userId}:${courseName}:${moduleId || moduleName || 'all'}`;
            try {
                const seen = await redisClient.get(seenKey);
                if (seen) {
                    seenQuestionIds = JSON.parse(seen);
                    log.info('QUIZ', `Replay protection: ${seenQuestionIds.length} questions already seen for ${courseName}/${moduleName || moduleId || 'all'}`);
                }
            } catch (e) {
                log.warn('QUIZ', `Failed to get seen questions: ${e.message}`);
            }
        }

        // ── CACHE CHECK ──────────────────────────────────────────────────
        if (redisClient) {
            const stage = learningStage;
            const mod = moduleId || moduleName || 'all';
            cacheKey = `quiz:socratic:${courseName}:${mod}:${stage}`;
            try {
                const cached = await redisClient.get(cacheKey);
                if (cached) {
                    const parsed = JSON.parse(cached);
                    log.info('QUIZ', `Quiz cache HIT for ${cacheKey} (${Date.now() - t0}ms)`);
                    return { ...parsed, _source: 'redis_cache', source: 'redis_cache', generatedBy: 'redis', generatedAt: parsed.generatedAt || new Date().toISOString() };
                }
            } catch (cacheErr) {
                log.warn('QUIZ', `Redis cache read failed: ${cacheErr.message}`);
            }
        }

        // ── UNIFIED PIPELINE CHECK ─────────────────────────────────────────
        // Try contentGenerationService (Redis → MongoDB → Provider → Template)
        try {
            const cg = require('./contentGenerationService');
            // Pass seenQuestionIds for replay protection
            const pipelineResult = await cg.generateOrRetrieveQuiz(courseName, moduleName || moduleId || 'all', user?._id, seenQuestionIds);
            if (pipelineResult && pipelineResult.questions && pipelineResult.questions.length > 0) {
                const stage = learningStage;
                const normalized = pipelineResult.questions.map((q, idx) => {
                    const isMCQ = Array.isArray(q.options) && q.options.length > 0;
                    return {
                        instruction: q.question || `Question ${idx + 1}`,
                        type: isMCQ ? 'MCQ' : 'Descriptive',
                        options: isMCQ ? (q.options || []).map(o => String(o).replace(/^[A-Da-d][.):\-]\s*/, '')) : undefined,
                        correctIndex: isMCQ ? (typeof q.correctIndex === 'number' ? q.correctIndex : 0) : undefined,
                        output: q.explanation || '',
                        topic: courseName || 'General',
                        difficulty: q.difficulty || stage || 'Beginner',
                        hint: '',
                    };
                });
                const now = new Date().toISOString();
                log.info('QUIZ', `Pipeline quiz HIT for ${courseName}/${moduleName || moduleId || 'all'} via ${pipelineResult._source} (${Date.now() - t0}ms)`);

                // Store new question texts for replay protection
                if (userId && pipelineResult.questions) {
                    const questionTexts = pipelineResult.questions.map(q => q.question).filter(Boolean);
                    await addSeenQuizQuestions(userId, courseName, moduleId || moduleName || 'all', questionTexts);
                }
                
                return {
                    questions: normalized,
                    source: pipelineResult._source || 'mongodb',
                    generatedBy: pipelineResult.generatedBy || 'pipeline',
                    model: pipelineResult.model || 'unknown',
                    pipelineVersion: pipelineResult.pipelineVersion || 'v2',
                    generatedAt: pipelineResult.generatedAt || now,
                    _source: pipelineResult._source || 'mongodb',
                };
            }
        } catch (pipelineErr) {
            log.warn('QUIZ', `Pipeline quiz miss, falling through to direct generation: ${pipelineErr.message}`);
        }

        // 1. Determine target difficulty and specific instructions based on history
        const quizScores = user?.profile?.quizScores || [];
        const sameContextAttempts = quizScores.filter(q => 
            q.courseName === courseName && 
            (!moduleId || q.moduleId === moduleId)
        );

        let targetDifficulty = learningStage;
        let stageSpecificPrompt = '';

        if (sameContextAttempts.length > 0) {
            const latestAttempt = sameContextAttempts.sort((a, b) => new Date(b.date) - new Date(a.date))[0];
            const prevScore = latestAttempt.score;

            if (prevScore <= 40) {
                targetDifficulty = 'Beginner';
                stageSpecificPrompt = `
- The student's previous score on this quiz was ${prevScore}%. Focus on FOUNDATIONAL questions, basic terminology, and core concepts.
- Include a helpful hint within the question text to guide the student towards the correct path.
- Keep the questions encouraging and not overly complex.
`;
            } else if (prevScore <= 75) {
                targetDifficulty = 'Intermediate';
                stageSpecificPrompt = `
- The student's previous score on this quiz was ${prevScore}%. Focus on APPLICATION questions, explaining "why" mechanisms work, and predicting behavior under normal changes.
- Formulate questions that require the student to apply concepts to straightforward scenarios or compare two basic approaches/mechanisms.
- Do not provide direct hints, but keep the scope well-defined.
`;
            } else {
                targetDifficulty = 'Advanced';
                stageSpecificPrompt = `
- The student's previous score on this quiz was ${prevScore}%. Focus on ADVANCED REASONING questions, system architecture, trade-offs, edge cases, scalability, optimization, and complex predictions.
- Formulate questions that ask them to analyze system-wide trade-offs under constraints, predict outcomes of multi-variable parameter modifications, or debug/optimize a scenario.
- Questions should demand deep, detailed technical reasoning. Do not provide hints.
`;
            }
        } else {
            if (learningStage === 'Beginner') {
                stageSpecificPrompt = `
- The student is a BEGINNER. Focus on basic terminology, core concepts, and intuitive understanding.
- Formulate questions that ask for reflection, simple explanations of basic mechanisms, or use of analogies.
- Include a helpful hint within the question text to guide the student towards the correct path.
- Keep the questions encouraging and not overly complex.
`;
            } else if (learningStage === 'Intermediate') {
                stageSpecificPrompt = `
- The student is at an INTERMEDIATE stage. Focus on standard applications, explaining "why" mechanisms work, and predicting behavior under normal changes.
- Formulate questions that require the student to apply concepts to straightforward scenarios or compare two basic approaches/mechanisms.
- Do not provide direct hints, but keep the scope well-defined.
`;
            } else {
                stageSpecificPrompt = `
- The student is ADVANCED. Focus on system architecture, trade-offs, edge cases, scalability, optimization, and complex predictions.
- Formulate questions that ask them to analyze system-wide trade-offs under constraints, predict outcomes of multi-variable parameter modifications, or debug/optimize a scenario.
- Questions should demand deep, detailed technical reasoning.
`;
            }
        }

        // 2. Inject rolling weak/strong topic instructions (cutoff: 70%)
        const weakTopics = user?.profile?.weakTopics || [];
        const strongTopics = user?.profile?.strongTopics || [];
        let compositionPrompt = '';

        if (weakTopics.length > 0) {
            compositionPrompt += `\n- The student struggles with the following topics: ${weakTopics.join(', ')}. Allocate at least 4 questions directly testing these weak topics to provide reinforcement, but explain them with simpler scaffolding or hints.\n`;
        }
        if (strongTopics.length > 0) {
            compositionPrompt += `\n- The student has mastered or performs strongly in the following topics: ${strongTopics.join(', ')}. If any questions are generated for these topics, make them highly challenging (Advanced scenario-based questions) to test the depth of their mastery.\n`;
        }

        const t1 = Date.now();

        // 3. Build search query and retrieve RAG context
        let searchQuery = '';
        let completedModules = [];
        const progress = user?.curriculumProgress?.get(courseName);
        completedModules = progress?.completedModules || [];

        if (completedModules.length > 0 && !moduleId && !moduleName) {
            searchQuery = `Explain core concepts, definitions, design trade-offs, architecture, and mechanisms for the following completed modules: ${completedModules.join(', ')} of course ${courseName}.`;
        } else if (moduleName || moduleId) {
            searchQuery = `Explain core concepts, definitions, design trade-offs, architecture, and mechanisms for module: ${moduleName || moduleId} of course ${courseName}.`;
        } else {
            searchQuery = `Explain core concepts, definitions, design trade-offs, architecture, and mechanisms for the entire course ${courseName}.`;
        }

        let contextText = 'No course material context available.';
        let ragResult = null;
        try {
            ragResult = await queryPythonRagService(
                searchQuery,
                courseName,
                true, // enable Neo4j graph search
                null,
                5,
                user?._id
            );
            if (ragResult && ragResult.toolOutput) {
                contextText = ragResult.toolOutput;
            }
        } catch (ragError) {
            log.warn('QUIZ', `RAG query failed: ${ragError.message}. Falling back to curriculum metadata.`);
        }

        // Check if context is empty or uninformative and use curriculum structure metadata fallback
        if (!ragResult || !ragResult.toolOutput || ragResult.toolOutput.trim() === '' || ragResult.toolOutput.includes('No context found') || ragResult.toolOutput === 'No course material context available.') {
            const structure = await getCurriculumStructure(courseName);
            if (structure && structure.modules && structure.modules.length > 0) {
                let fallbackParts = [];
                const targetMod = structure.modules.find(m => m.id === moduleId || m.name === moduleName || m.id === moduleName);
                
                if (targetMod) {
                    fallbackParts.push(`Module: ${targetMod.name}`);
                    if (targetMod.description) fallbackParts.push(`Description: ${targetMod.description}`);
                    if (targetMod.topics && targetMod.topics.length > 0) {
                        const topicsList = targetMod.topics.map(t => {
                            let topicStr = `- Topic: ${t.name}`;
                            if (t.subtopics && t.subtopics.length > 0) {
                                topicStr += ` (Subtopics: ${t.subtopics.map(s => s.name).join(', ')})`;
                            }
                            return topicStr;
                        }).join('\n');
                        fallbackParts.push(`Topics to cover:\n${topicsList}`);
                    }
                } else {
                    fallbackParts.push(`Course Curriculum Structure for ${courseName}:`);
                    structure.modules.forEach(m => {
                        let mStr = `- Module: ${m.name}`;
                        if (m.topics && m.topics.length > 0) {
                            mStr += ` (Topics: ${m.topics.map(t => t.name).join(', ')})`;
                        }
                        fallbackParts.push(mStr);
                    });
                }
                contextText = fallbackParts.join('\n\n');
            }
        }

        // Truncate context to avoid oversized prompts
        if (contextText.length > MAX_CONTEXT_LENGTH) {
            contextText = contextText.substring(0, MAX_CONTEXT_LENGTH) + '\n...[context truncated]';
        }

        const t2 = Date.now();

        // 4. Construct Socratic generator prompt
        const prompt = `You are a Socratic tutor generating an academic quiz.
Based on the following course material context, generate exactly 10 diverse, true Socratic questions tailored to the student's current learning stage: "${targetDifficulty}".

Course Name: ${courseName}
${moduleName ? `Module: ${moduleName}` : ''}

Context:
"${contextText}"

QUIZ COMPOSITION RULES:
- Generate exactly 10 questions.
- Exactly 7 questions must be Multiple Choice Questions (type: "MCQ") with 4 choices.
- Exactly 3 questions must be Descriptive Questions (type: "Descriptive").
- MCQ questions MUST include an array of 4 strings in 'options' and a 0-based integer 'correctIndex'. Do not prefix options with letters like "A)", "B)", etc.
- Descriptive questions MUST NOT contain 'options' or 'correctIndex'.

SOCRATIC QUESTION TYPES TO CHOOSE FROM:
1. Reflection Question: Ask the student to reflect on their intuition or explain how a concept relates to what they've seen.
2. Reasoning Question: Ask the student to explain the underlying "why" or the mathematical/logical necessity behind a concept.
3. Prediction Question: Ask the student to predict the behavioral/system changes if a constraint, mechanism, or parameter is modified.
4. Comparison/Trade-off Question: Ask the student to compare two alternative approaches or evaluate design trade-offs.
5. Application Question: Ask the student to apply the concept to analyze a practical scenario or solve a problem.

LEARNING STAGE ADAPTATION GUIDELINES:${stageSpecificPrompt}
${compositionPrompt}

Return ONLY a valid JSON array of 10 objects. Do NOT include markdown blocks (like \`\`\`json) or extra text.
JSON format:
[
  {
    "instruction": "The Socratic question text",
    "type": "MCQ",
    "options": ["First option", "Second option", "Third option", "Fourth option"],
    "correctIndex": 0,
    "output": "A detailed explanation of why the correct choice is correct.",
    "topic": "Specific topic name",
    "difficulty": "${targetDifficulty}",
    "hint": "A helpful hint (if student is Beginner/Intermediate, else empty string)"
  },
  {
    "instruction": "A descriptive reasoning question text",
    "type": "Descriptive",
    "output": "The ideal detailed answer containing key factual points that a student should touch upon.",
    "topic": "Specific topic name",
    "difficulty": "${targetDifficulty}",
    "hint": "A helpful hint (if student is Beginner/Intermediate, else empty string)"
  }
]
`;

        const t3 = Date.now();
        log.info('QUIZ', `[PROFILE] stage=${t1-t0}ms rag=${t2-t1}ms total=${t3-t0}ms - calling LLM`);

        // Skip unhealthy providers via health cache
        const providerHealth = require('./providerHealthCache');
        const providerChain = ['sglang', 'groq', 'gemini', 'openai', 'ollama'];
        const healthyProviders = providerHealth.getHealthyProviders(providerChain);
        const preferredProvider = healthyProviders.length > 0
          ? healthyProviders[0]
          : (process.env.NODE_ENV === 'development' ? 'ollama' : 'sglang');

        const fallbackResult = await callWithFallback({
            userQuery: prompt,
            preferredProvider,
            preferLocalFirst: true
        });

        const t4 = Date.now();
        log.info('QUIZ', `[PROFILE] LLM completed in ${t4-t3}ms via ${fallbackResult.provider || 'unknown'}`);

        if (fallbackResult.provider === 'none') {
            throw new Error('All LLM providers are offline/unavailable.');
        }

        const responseText = fallbackResult.text;
        let cleanText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        const questions = JSON.parse(cleanText);

        if (!Array.isArray(questions) || questions.length === 0) {
            throw new Error('LLM did not return a valid array of questions.');
        }

        const normalized = questions.map((q, idx) => {
            const isMCQ = q.type === 'MCQ' || (Array.isArray(q.options) && q.options.length > 0);
            return {
                instruction: q.instruction || q.question || `Question ${idx + 1}`,
                type: isMCQ ? 'MCQ' : 'Descriptive',
                options: isMCQ ? (q.options || []).map(o => String(o).replace(/^[A-Da-d][.):\-]\s*/, '')) : undefined,
                correctIndex: isMCQ ? (typeof q.correctIndex === 'number' ? q.correctIndex : 0) : undefined,
                output: q.output || q.explanation || '',
                topic: q.topic || 'General',
                difficulty: q.difficulty || targetDifficulty,
                hint: q.hint || ''
            };
        });

        const provider = fallbackResult.provider || 'unknown';
        const model = fallbackResult.model || 'unknown';
        const now = new Date().toISOString();
        const resultPayload = {
            questions: normalized,
            source: provider,
            generatedBy: provider,
            model,
            pipelineVersion: 'v2',
            generatedAt: now,
            _source: provider,
        };

        // ── CACHE STORE ──────────────────────────────────────────────────
        if (redisClient && cacheKey) {
            try {
                await redisClient.setEx(cacheKey, QUIZ_CACHE_TTL, JSON.stringify(resultPayload));
                log.info('QUIZ', `Quiz cache saved for ${cacheKey} (TTL: ${QUIZ_CACHE_TTL}s)`);
            } catch (cacheErr) {
                log.warn('QUIZ', `Redis cache write failed: ${cacheErr.message}`);
            }
        }

        log.info('QUIZ', `[PROFILE] total=${Date.now()-t0}ms - returning ${normalized.length} questions`);
        return resultPayload;

    } catch (err) {
        log.warn('QUESTION_GENERATOR', `Socratic quiz generation failed: ${err.message}. Generating resilient offline fallback questions.`);
        const fallbackQuestions = generateSocraticOfflineFallback({ courseName, moduleName: moduleName || moduleId });
        const now = new Date().toISOString();
        const fallbackPayload = {
            questions: fallbackQuestions,
            source: 'template',
            generatedBy: 'template',
            model: 'fallback',
            pipelineVersion: 'v2',
            generatedAt: now,
            _source: 'template',
        };
        if (redisClient && cacheKey) {
            try {
                await redisClient.setEx(cacheKey, QUIZ_CACHE_TTL, JSON.stringify(fallbackPayload));
                log.info('QUIZ', `Fallback quiz cache saved for ${cacheKey} (TTL: ${QUIZ_CACHE_TTL}s)`);
            } catch (cacheErr) {
                log.warn('QUIZ', `Redis cache write for fallback failed: ${cacheErr.message}`);
            }
        }
        return fallbackPayload;
    }
}

/**
 * Generate Skill Tree Level Questions: 6 MCQs (3 Easy, 2 Medium, 1 Hard)
 */
async function generateSkillTreeQuestions({ topic, levelId, levelName, difficulty, user, seenQuestions = [] }) {
    try {
        // 0. Try unified pipeline (Redis → MongoDB → Provider Chain → Template)
        try {
            const cg = require('./contentGenerationService');
            const pipelineResult = await cg.generateOrRetrieveLevelQuestions(topic, levelId, levelName, difficulty, null, seenQuestions);
            if (pipelineResult && pipelineResult.questions && pipelineResult.questions.length > 0) {
                // Add MCQ-level session fields
                const questions = pipelineResult.questions.map((q, qi) => ({
                    ...q,
                    difficulty: q.difficulty || difficulty || 'medium',
                    _provider: pipelineResult._source || 'pipeline',
                }));
                log.info('QUESTION_GENERATOR', `Pipeline skill tree questions HIT for ${topic}/${levelName} via ${pipelineResult._source}`);
                return questions;
            }
        } catch (pipelineErr) {
            log.warn('QUESTION_GENERATOR', `Pipeline skill tree miss, falling through: ${pipelineErr.message}`);
        }

        // 1. Fetch RAG Context
        const searchQuery = `Explain core concepts, definitions, design trade-offs, architecture, and practical code examples for: ${levelName} under the topic: ${topic}.`;
        let contextText = 'No course material context available.';
        let ragResult = null;

        try {
            ragResult = await queryPythonRagService(
                searchQuery,
                topic,
                true,
                null,
                5,
                user?._id
            );
            if (ragResult && ragResult.toolOutput) {
                contextText = ragResult.toolOutput;
            }
        } catch (ragError) {
            log.warn('QUESTION_GENERATOR', `RAG query failed for skill tree: ${ragError.message}. Falling back to curriculum metadata.`);
        }

        // Use curriculum fallback if RAG context is missing
        if (!ragResult || !ragResult.toolOutput || ragResult.toolOutput.trim() === '' || ragResult.toolOutput.includes('No context found') || ragResult.toolOutput === 'No course material context available.') {
            const structure = await getCurriculumStructure(topic);
            if (structure && structure.modules && structure.modules.length > 0) {
                let fallbackParts = [];
                // Find module or topic matching levelName
                let foundMatch = false;
                structure.modules.forEach(m => {
                    if (m.name.toLowerCase() === levelName.toLowerCase()) {
                        fallbackParts.push(`Module: ${m.name}`);
                        if (m.description) fallbackParts.push(`Description: ${m.description}`);
                        if (m.topics && m.topics.length > 0) {
                            const topicsList = m.topics.map(t => {
                                let topicStr = `- Topic: ${t.name}`;
                                if (t.subtopics && t.subtopics.length > 0) {
                                    topicStr += ` (Subtopics: ${t.subtopics.map(s => s.name).join(', ')})`;
                                }
                                return topicStr;
                            }).join('\n');
                            fallbackParts.push(`Topics to cover:\n${topicsList}`);
                        }
                        foundMatch = true;
                    } else if (m.topics) {
                        m.topics.forEach(t => {
                            if (t.name.toLowerCase() === levelName.toLowerCase() || String(t.id) === String(levelId)) {
                                fallbackParts.push(`Topic: ${t.name}`);
                                if (t.description) fallbackParts.push(`Description: ${t.description}`);
                                if (t.subtopics && t.subtopics.length > 0) {
                                    fallbackParts.push(`Subtopics: ${t.subtopics.map(s => s.name).join(', ')}`);
                                }
                                foundMatch = true;
                            }
                        });
                    }
                });

                if (!foundMatch) {
                    fallbackParts.push(`Course Curriculum Structure for ${topic}:`);
                    structure.modules.forEach(m => {
                        let mStr = `- Module: ${m.name}`;
                        if (m.topics && m.topics.length > 0) {
                            mStr += ` (Topics: ${m.topics.map(t => t.name).join(', ')})`;
                        }
                        fallbackParts.push(mStr);
                    });
                }
                contextText = fallbackParts.join('\n\n');
            }
        }

        // 2. Construct Curved MCQ Generation Prompt
        const prompt = `You are a strict technical interviewer creating a quiz for "${topic}".
Level/Subtopic: "${levelName}" (Level ID: ${levelId})
Course Context:
"${contextText}"

Generate exactly 6 UNIQUE, TOUGH, and DISTINCT multiple-choice questions specifically for this level: "${levelName}".
Do NOT generate generic questions. Do NOT repeat questions from other levels.

CURVED DIFFICULTY DISTRIBUTION:
- Questions 1, 2, 3: Easy/Beginner difficulty level. Focus on basic definitions, terminology, core mechanics.
- Questions 4, 5: Medium/Intermediate difficulty level. Focus on standard applications, trade-offs, code snippet behavior, or predicting outcomes of parameter changes.
- Question 6: Hard/Advanced difficulty level. Focus on complex scenarios, edge cases, system architecture, scalability, or multi-variable optimization.

${seenQuestions.length > 0 ? `\nIMPORTANT — PREVIOUSLY SHOWN QUESTIONS (DO NOT REPEAT OR PARAPHRASE ANY OF THESE):\n${seenQuestions.slice(-15).map((q, i) => `${i + 1}. ${q}`).join('\n')}\nGenerate completely DIFFERENT questions.\n` : ''}

CRITICAL INSTRUCTIONS:
1. Questions must be directly related to "${levelName}".
2. Ensure ONE correct answer.
3. Provide a detailed technical explanation.
4. Do NOT prefix options with letters like "A.", "B.", "C.", "D.". Just provide the plain option text.

JSON Structure (Return ONLY the array of 6 objects):
[
  {
    "question": "Specific question text...",
    "options": ["First option text", "Second option text", "Third option text", "Fourth option text"],
    "correctIndex": 0,
    "explanation": "Why this is correct..."
  }
]`;

        const providerHealth = require('./providerHealthCache');
        const providerChain = ['sglang', 'groq', 'gemini', 'openai', 'ollama'];
        const healthyProviders = providerHealth.getHealthyProviders(providerChain);
        const preferredProvider = healthyProviders.length > 0
          ? healthyProviders[0]
          : (process.env.NODE_ENV === 'development' ? 'ollama' : 'sglang');

        const fallbackResult = await callWithFallback({
            userQuery: prompt,
            preferredProvider,
            preferLocalFirst: true
        });

        if (fallbackResult.provider === 'none') {
            throw new Error('All LLM providers are offline/unavailable.');
        }

        const responseText = fallbackResult.text;
        let cleanText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        const questions = JSON.parse(cleanText);

        if (!Array.isArray(questions) || questions.length === 0) {
            throw new Error('LLM did not return a valid array of questions.');
        }

        // Normalize questions: ensure options array and a valid 0-based correctIndex
        return questions.map((q, qi) => {
            const out = {
                question: typeof q.question === 'string' ? q.question : (q.prompt || q.text || `Question ${qi + 1}`),
                options: Array.isArray(q.options) ? q.options.map(o => String(o).replace(/^[A-Da-d][.):\-]\s*/, '')) : (q.options ? [String(q.options)] : []),
                explanation: q.explanation || q.explain || q.explanations || ''
            };

            // Normalize correctIndex
            let idx = undefined;
            if (typeof q.correctIndex === 'number' && Number.isFinite(q.correctIndex)) {
                idx = parseInt(q.correctIndex);
            } else if (typeof q.correctIndex === 'string' && /^\d+$/.test(q.correctIndex.trim())) {
                idx = parseInt(q.correctIndex.trim());
            } else if (typeof q.correctIndex === 'string' && /^[A-Da-d]$/.test(q.correctIndex.trim())) {
                idx = q.correctIndex.trim().toUpperCase().charCodeAt(0) - 65;
            } else if (typeof q.answer === 'string' && /^[A-Da-d]$/.test(q.answer.trim())) {
                idx = q.answer.trim().toUpperCase().charCodeAt(0) - 65;
            } else if (typeof q.correct === 'string' && /^[A-Da-d]$/.test(q.correct.trim())) {
                idx = q.correct.trim().toUpperCase().charCodeAt(0) - 65;
            } else if (typeof q.correct === 'string' && q.correct.trim().length > 0) {
                const matchIdx = out.options.findIndex(opt => opt.trim().toLowerCase() === q.correct.trim().toLowerCase());
                if (matchIdx !== -1) idx = matchIdx;
            } else if (typeof q.answer === 'string' && q.answer.trim().length > 0) {
                const matchIdx = out.options.findIndex(opt => opt.trim().toLowerCase() === q.answer.trim().toLowerCase());
                if (matchIdx !== -1) idx = matchIdx;
            }

            if (typeof idx === 'undefined' && typeof q.correctOption === 'string') {
                const letter = q.correctOption.trim().charAt(0);
                if (/^[A-Da-d]$/.test(letter)) idx = letter.toUpperCase().charCodeAt(0) - 65;
            }

            if (typeof idx === 'number' && (idx < 0 || idx >= out.options.length)) {
                idx = undefined;
            }

            out.correctIndex = typeof idx === 'number' && !Number.isNaN(idx) ? idx : 0;
            return out;
        });

    } catch (err) {
        log.warn('QUESTION_GENERATOR', `Skill Tree questions generation failed: ${err.message}. Generating resilient offline fallback questions.`);
        return generateOfflineFallbackQuestions({ topic, levelName, difficulty });
    }
}

function generateOfflineFallbackQuestions({ topic, levelName, difficulty }) {
    return [
        {
            question: `What is the primary definition or fundamental concept of ${levelName} in ${topic}?`,
            options: [
                `A foundational method for configuring and processing ${levelName} components.`,
                `The core theoretical framework establishing how ${levelName} operates within ${topic}.`,
                `An auxiliary system designed for optimizing database queries.`,
                `A deprecated protocol replaced by modern cloud-native architectures.`
            ],
            correctIndex: 1,
            explanation: `The core concept of ${levelName} represents the main theoretical and functional framework for its implementation within ${topic}.`
        },
        {
            question: `Which of the following represents a key characteristic or component of ${levelName}?`,
            options: [
                `High latency and low throughput.`,
                `Requirement for manual human intervention at every execution step.`,
                `Dynamic scaling, structural abstraction, and modular integrity.`,
                `Total isolation from other subsystems in ${topic}.`
            ],
            correctIndex: 2,
            explanation: `${levelName} emphasizes modular integrity, proper abstraction, and the capability to scale components dynamically.`
        },
        {
            question: `When deploying or using ${levelName}, what is a standard first step or prerequisite?`,
            options: [
                `Defining the input data schema, objectives, and configuration parameters.`,
                `De-provisioning all compute resources to save energy.`,
                `Bypassing safety protocols to speed up initialization.`,
                `Migrating the entire infrastructure to a legacy database system.`
            ],
            correctIndex: 0,
            explanation: `A successful start requires clearly defining the input schema, configuration parameters, and overall learning objectives.`
        },
        {
            question: `Which trade-off is most commonly encountered when optimizing ${levelName} for performance?`,
            options: [
                `Balancing execution speed against accuracy and resource consumption.`,
                `Sacrificing usability entirely to improve system security.`,
                `Trading modularity for increased complexity without performance benefits.`,
                `Increasing network overhead while decreasing parallel processing capability.`
            ],
            correctIndex: 0,
            explanation: `Optimizing ${levelName} typically involves trade-offs between execution speed, computational resources, and accuracy.`
        },
        {
            question: `How does ${levelName} contribute to the robustness of a system in ${topic}?`,
            options: [
                `By introducing random failures to test system resilience.`,
                `Through error encapsulation, validation checking, and adaptive feedback loops.`,
                `By strictly hardcoding all operational parameters to prevent change.`,
                `Through excessive logging that consumes all disk space.`
            ],
            correctIndex: 1,
            explanation: `Error encapsulation, robust validation checks, and adaptive feedback loops are key to the stability of ${levelName}.`
        },
        {
            question: `At an advanced level, how should one address scalability constraints in ${levelName}?`,
            options: [
                `Avoid parallelization and run all processes sequentially on a single thread.`,
                `Implement distributed partitioning, load balancing, and concurrent processing pipelines.`,
                `Downgrade to a simpler model that does not support high concurrency.`,
                `Increase system synchronization locks to force serialized database access.`
            ],
            correctIndex: 1,
            explanation: `Advanced scaling for ${levelName} requires distributed partitioning, effective load balancing, and concurrent pipeline architectures.`
        }
    ];
}

function classifySubject(courseName = '', moduleName = '') {
    const text = `${courseName} ${moduleName}`.toLowerCase();
    if (/(machine learning|artificial intelligence|neural|deep learning|nlp|computer vision|data science|regression|classification|clustering|reinforcement|supervised|unsupervised|transformer|llm|gpt|bert|cnn|rnn|gan)/.test(text))
        return 'AI_ML';
    if (/(python|java|javascript|react|node|express|docker|kubernetes|api|rest|graphql|sql|nosql|algorithm|data structure|programming|software|web|database|cloud|microservice|frontend|backend|fullstack)/.test(text))
        return 'CS';
    if (/(accounting|finance|economics|marketing|management|business|entrepreneurship|strategy|supply chain|operations|hr|organizational|leadership)/.test(text))
        return 'BUSINESS';
    if (/(biology|chemistry|physics|environmental|genetics|ecology|cell|molecular|biochemistry|quantum|thermodynamics|electromagnetism|organic|inorganic)/.test(text))
        return 'SCIENCE';
    if (/(calculus|algebra|geometry|statistics|probability|trigonometry|linear|differential|integral|theorem|proof|matrix|vector|function)/.test(text))
        return 'MATH';
    if (/(history|literature|philosophy|psychology|sociology|anthropology|political|geography|linguistics|cultural|ethics)/.test(text))
        return 'HUMANITIES';
    return 'GENERAL';
}

const SUBJECT_TEMPLATES = {
    AI_ML: {
        mcqQuestions: [
            { instruction: 'Which of the following best describes supervised learning?', options: ['Learning from labeled data with known outcomes', 'Learning without any training labels', 'Learning through trial and error with rewards', 'Learning from unlabeled data to find patterns'], correctIndex: 0, output: 'Supervised learning uses labeled training data with known target outputs to learn a mapping from inputs to outputs.', hint: 'Think about whether the model sees correct answers during training.' },
            { instruction: 'What is the primary purpose of a loss function in machine learning?', options: ['To measure how well the model performs', 'To increase model complexity', 'To add more training data', 'To visualize model architecture'], correctIndex: 0, output: 'A loss function quantifies the difference between predicted and actual values, guiding optimization during training.', hint: 'Consider what metric drives the learning process.' },
            { instruction: 'How does backpropagation contribute to neural network training?', options: ['It computes gradients by propagating error backward through the network', 'It forwards data through the network layers', 'It initializes network weights randomly', 'It augments the training dataset'], correctIndex: 0, output: 'Backpropagation calculates the gradient of the loss with respect to each weight using the chain rule, enabling gradient descent updates.', hint: 'Trace how error information flows through the network.' },
            { instruction: 'What distinguishes a transformer architecture from traditional RNNs?', options: ['Self-attention mechanisms replacing sequential recurrence', 'Faster training on CPUs', 'Smaller model sizes overall', 'No need for training data'], correctIndex: 0, output: 'Transformers use self-attention to process all positions in parallel, avoiding the sequential bottleneck of RNNs.', hint: 'Consider parallel vs sequential processing.' },
            { instruction: 'Which technique helps prevent overfitting in neural networks?', options: ['Dropout regularization', 'Increasing model layers', 'Training for more epochs', 'Removing validation data'], correctIndex: 0, output: 'Dropout randomly deactivates neurons during training, forcing the network to learn redundant representations and reducing overfitting.', hint: 'Think about methods that add noise or constrain the model.' },
            { instruction: 'What is the role of the activation function in a neural network?', options: ['To introduce non-linearity into the model', 'To normalize input data', 'To reduce the number of parameters', 'To initialize weights'], correctIndex: 0, output: 'Activation functions like ReLU or sigmoid introduce non-linear transformations, allowing networks to learn complex patterns.', hint: 'Without this, deep networks would be equivalent to linear models.' },
            { instruction: 'What does the F1-score measure in classification tasks?', options: ['The harmonic mean of precision and recall', 'The accuracy of positive predictions only', 'The total number of correct predictions', 'The ratio of true negatives to false positives'], correctIndex: 0, output: 'The F1-score balances precision and recall, providing a single metric for model performance especially useful with imbalanced datasets.', hint: 'It combines two key metrics into one.' },
        ],
        descriptiveQuestions: [
            { instruction: 'Explain how gradient descent optimizes model parameters. Describe the role of the learning rate and what happens when it is too high or too low.', output: 'Gradient descent iteratively adjusts parameters in the direction of the negative gradient of the loss function. The learning rate controls step size: too high causes oscillation or divergence, too low leads to slow convergence and potential stalling in local minima.', hint: 'Consider the analogy of walking down a hill with different step sizes.' },
            { instruction: 'Compare and contrast supervised, unsupervised, and reinforcement learning. Provide a concrete use case for each paradigm.', output: 'Supervised learning uses labeled data (e.g., email spam classification). Unsupervised learning finds patterns in unlabeled data (e.g., customer segmentation). Reinforcement learning learns via rewards and penalties in an environment (e.g., game-playing AI).', hint: 'Think about what kind of feedback signal is available during training.' },
            { instruction: 'Describe the bias-variance tradeoff in machine learning. How does model complexity affect generalization performance?', output: 'Bias measures how far predictions deviate from true values on average; variance measures prediction sensitivity to training data. Simple models have high bias (underfitting). Complex models have high variance (overfitting). The goal is to find the sweet spot that minimizes total error.', hint: 'Draw a U-shaped curve for error vs model complexity.' },
        ],
    },
    CS: {
        mcqQuestions: [
            { instruction: 'What is the time complexity of binary search on a sorted array?', options: ['O(log n)', 'O(n)', 'O(n log n)', 'O(n²)'], correctIndex: 0, output: 'Binary search repeatedly divides the search space in half, resulting in logarithmic O(log n) time complexity.', hint: 'How many times can you divide n by 2 until you reach 1?' },
            { instruction: 'Which data structure operates on a Last-In-First-Out (LIFO) principle?', options: ['Stack', 'Queue', 'Array', 'Hash table'], correctIndex: 0, output: 'A stack follows LIFO ordering — the last element added is the first to be removed, like a stack of plates.', hint: 'Think about what happens when you press Ctrl+Z in an editor.' },
            { instruction: 'What does ACID stand for in database transactions?', options: ['Atomicity, Consistency, Isolation, Durability', 'Availability, Consistency, Integration, Durability', 'Atomicity, Concurrency, Isolation, Distribution', 'Accuracy, Consistency, Isolation, Durability'], correctIndex: 0, output: 'ACID properties ensure reliable database transactions: Atomicity (all or nothing), Consistency (valid state), Isolation (concurrent independence), Durability (persisted once committed).', hint: 'Each property guarantees a specific aspect of transaction reliability.' },
            { instruction: 'What is the primary difference between REST and GraphQL?', options: ['GraphQL lets clients request exactly the data they need', 'REST is always faster than GraphQL', 'GraphQL does not use HTTP', 'REST only supports GET requests'], correctIndex: 0, output: 'GraphQL clients specify exact field requirements in queries, eliminating over-fetching and under-fetching common with REST endpoints.', hint: 'Compare who controls the response structure.' },
            { instruction: 'Which HTTP status code indicates a resource was created successfully?', options: ['201 Created', '200 OK', '301 Moved', '404 Not Found'], correctIndex: 0, output: 'HTTP 201 Created is returned after successful resource creation, typically after a POST request.', hint: 'It is not the generic success code 200.' },
            { instruction: 'What is encapsulation in object-oriented programming?', options: ['Bundling data and methods that operate on that data, restricting direct access', 'Inheriting properties from a parent class', 'Overloading methods with different parameters', 'Converting one data type to another'], correctIndex: 0, output: 'Encapsulation bundles data with related methods and hides internal state, exposing only controlled interfaces.', hint: 'Think about private fields and public getters/setters.' },
            { instruction: 'What does a load balancer do in a distributed system?', options: ['Distributes incoming traffic across multiple servers', 'Balances the load time of web pages', 'Loads software onto servers automatically', 'Balances data between databases'], correctIndex: 0, output: 'A load balancer distributes requests across multiple backend servers to ensure availability, scalability, and fault tolerance.', hint: 'Think about directing traffic efficiently.' },
        ],
        descriptiveQuestions: [
            { instruction: 'Explain the concept of Big O notation and analyze the time and space complexity of a recursive Fibonacci implementation.', output: 'Big O describes worst-case algorithm growth. Recursive Fibonacci runs in O(2^n) time (exponential) and O(n) space (call stack) — highly inefficient compared to O(n) iterative or memoized versions.', hint: 'Count how many function calls are made for fib(5).' },
            { instruction: 'Describe how version control systems like Git manage collaborative development. Explain branching, merging, and conflict resolution.', output: 'Git tracks changes as commits in a DAG. Branches allow parallel development lines. Merging integrates changes; conflicts occur when changes overlap and must be resolved manually. Good practices include feature branches and pull requests.', hint: 'Think about multiple developers editing the same files simultaneously.' },
            { instruction: 'Explain the principles of RESTful API design. What makes an API truly RESTful in terms of statelessness, resource naming, and HTTP methods?', options: '', output: 'REST APIs use stateless operations, resource-oriented URLs (nouns not verbs), standard HTTP methods (GET/POST/PUT/DELETE), and represent resources in JSON or XML. Statelessness means each request contains all needed context.', hint: 'What are the constraints Field defined in his dissertation?' },
        ],
    },
    BUSINESS: {
        mcqQuestions: [
            { instruction: 'What does NPV (Net Present Value) measure in capital budgeting?', options: ['The present value of future cash flows minus initial investment', 'The total revenue of a project', 'The payback period of an investment', 'The accounting profit of a firm'], correctIndex: 0, output: 'NPV calculates the difference between the present value of cash inflows and outflows, helping evaluate investment profitability.', hint: 'Consider the time value of money.' },
            { instruction: 'Which of the following is a characteristic of a perfectly competitive market?', options: ['Many buyers and sellers with homogeneous products', 'A single seller dominating the market', 'High barriers to entry', 'Differentiated products'], correctIndex: 0, output: 'Perfect competition features many firms selling identical products with no barriers to entry, resulting in price-taking behavior.', hint: 'Think about markets with minimal friction.' },
            { instruction: 'What does the DuPont analysis decompose Return on Equity (ROE) into?', options: ['Profit margin, asset turnover, and financial leverage', 'Revenue, cost, and profit', 'Assets, liabilities, and equity', 'Growth, stability, and liquidity'], correctIndex: 0, output: 'DuPont analysis breaks ROE into three components to identify drivers of shareholder returns.', hint: 'Think of it as a three-part formula.' },
            { instruction: 'What is the purpose of a SWOT analysis?', options: ['To evaluate Strengths, Weaknesses, Opportunities, and Threats', 'To calculate financial ratios', 'To measure employee satisfaction', 'To analyze supply chain efficiency'], correctIndex: 0, output: 'SWOT analysis assesses internal strengths/weaknesses and external opportunities/threats to inform strategic planning.', hint: 'It combines internal and external perspectives.' },
            { instruction: 'What is the law of diminishing marginal returns?', options: ['Adding more of one input yields decreasing increments of output', 'Total output always increases proportionally', 'Costs decrease as production scales', 'Demand increases as price decreases'], correctIndex: 0, output: 'The law states that adding more of a variable input to fixed inputs eventually yields smaller increases in output.', hint: 'Think about adding workers to a fixed-size factory.' },
            { instruction: 'What distinguishes a bond from a stock?', options: ['A bond is debt, a stock represents ownership equity', 'Bonds always pay higher returns than stocks', 'Stocks have fixed maturity dates', 'Bonds represent company ownership'], correctIndex: 0, output: 'Bonds are debt instruments (company owes money), while stocks represent equity ownership in the company.', hint: 'One is lending, the other is owning.' },
            { instruction: 'What does the current ratio measure in financial analysis?', options: ['A company ability to pay short-term obligations', 'Long-term profitability', 'Market share percentage', 'Inventory turnover rate'], correctIndex: 0, output: 'The current ratio (current assets / current liabilities) measures a company short-term liquidity and ability to meet obligations.', hint: 'Short-term assets vs short-term debts.' },
        ],
        descriptiveQuestions: [
            { instruction: 'Explain Porter Five Forces framework and how it helps analyze industry competitiveness. Apply it to a technology company like Apple.', output: 'Porter Five Forces: threat of new entrants, bargaining power of buyers, bargaining power of suppliers, threat of substitutes, and industry rivalry. For Apple: strong brand loyalty reduces buyer power, ecosystem lock-in raises switching costs, and vertical integration controls suppliers.', hint: 'Think about what makes an industry more or less profitable.' },
            { instruction: 'Describe the difference between operating leverage and financial leverage. How does each affect business risk and return?', options: '', output: 'Operating leverage relates to fixed vs variable costs — higher fixed costs amplify profit swings. Financial leverage involves using debt to amplify returns and risks. Both magnify outcomes but from different sources.', hint: 'One is about cost structure, the other about capital structure.' },
            { instruction: 'Explain the concept of elasticity of demand and its implications for pricing strategy. Give examples of elastic vs inelastic goods.', output: 'Price elasticity of demand measures how quantity demanded changes with price. Elastic goods (luxuries, substitutes available) see large demand drops with price increases. Inelastic goods (necessities, insulin) see little change. Companies set higher prices for inelastic goods.', hint: 'Consider how much behavior changes when price goes up.' },
        ],
    },
    SCIENCE: {
        mcqQuestions: [
            { instruction: 'What is the central dogma of molecular biology?', options: ['DNA → RNA → Protein', 'Protein → RNA → DNA', 'RNA → DNA → Protein', 'DNA → Protein → RNA'], correctIndex: 0, output: 'The central dogma describes genetic information flow from DNA to RNA (transcription) to protein (translation).', hint: 'Think about the direction of genetic information transfer.' },
            { instruction: 'What does the Heisenberg uncertainty principle state?', options: ['The more precisely position is known, the less precisely momentum can be known', 'Energy and mass are equivalent', 'Light behaves as both particle and wave', 'Entropy always increases'], correctIndex: 0, output: 'The Heisenberg uncertainty principle states a fundamental limit: the more accurately one property is measured, the less accurately the complementary property can be known.', hint: 'It is about measurement limits at quantum scales.' },
            { instruction: 'What is the primary purpose of photosynthesis in plants?', options: ['To convert light energy into chemical energy (glucose)', 'To absorb water from the soil', 'To reproduce through spores', 'To transport minerals through the stem'], correctIndex: 0, output: 'Photosynthesis converts light energy into chemical energy stored as glucose, using carbon dioxide and water while releasing oxygen.', hint: 'It is how plants make their own food.' },
            { instruction: 'Which law of thermodynamics states that entropy of an isolated system always increases?', options: ['Second law of thermodynamics', 'First law of thermodynamics', 'Third law of thermodynamics', 'Zeroth law of thermodynamics'], correctIndex: 0, output: 'The second law states that the total entropy of an isolated system never decreases over time, driving natural processes toward disorder.', hint: 'Think about why heat cannot spontaneously flow from cold to hot.' },
            { instruction: 'What is the pH scale measuring?', options: ['The concentration of hydrogen ions in a solution', 'The temperature of a solution', 'The density of a liquid', 'The electrical conductivity of water'], correctIndex: 0, output: 'pH measures hydrogen ion concentration on a logarithmic scale from 0 (highly acidic) to 14 (highly basic), with 7 being neutral.', hint: 'Lower values mean more acidic (more H+ ions).' },
            { instruction: 'What is natural selection?', options: ['Organisms with advantageous traits are more likely to survive and reproduce', 'Humans selectively breed organisms for desired traits', 'Species change randomly without any pattern', 'All organisms evolve toward complexity'], correctIndex: 0, output: 'Natural selection is the differential survival and reproduction of individuals due to differences in phenotype, driving adaptive evolution.', hint: 'It is the primary mechanism Darwin described.' },
            { instruction: 'What does E = mc² describe?', options: ['Energy and mass are interchangeable', 'Energy equals mass times velocity', 'Electromagnetic wave propagation', 'Electric field strength'], correctIndex: 0, output: 'Einstein equation shows mass and energy are equivalent, with a small amount of mass convertible into a large amount of energy.', hint: 'Think about nuclear reactions.' },
        ],
        descriptiveQuestions: [
            { instruction: 'Explain the process of cellular respiration and its role in energy production. Describe the three main stages involved.', output: 'Cellular respiration: glycolysis (cytoplasm, breaks glucose into pyruvate), Krebs cycle (mitochondria, produces electron carriers), and electron transport chain (mitochondrial membrane, generates ATP). Overall: C₆H₁₂O₆ + 6O₂ → 6CO₂ + 6H₂O + ATP.', hint: 'Trace the journey of a glucose molecule to energy.' },
            { instruction: 'Describe the Bohr model of the atom and its limitations. How did the quantum mechanical model improve our understanding?', output: 'Bohr model: electrons orbit the nucleus in fixed energy levels. Limitations: could not explain multi-electron atoms, chemical bonding, or the uncertainty principle. Quantum model: electrons exist in probability clouds (orbitals) described by wave functions.', hint: 'Think about electrons as waves, not just particles.' },
            { instruction: 'Explain the greenhouse effect and its role in climate change. How do human activities affect this natural process?', output: 'Greenhouse gases (CO₂, CH₄, H₂O) trap infrared radiation from Earth surface, keeping the planet warm. Human activities — burning fossil fuels, deforestation, agriculture — increase these gas concentrations, enhancing the effect and causing global warming.', hint: 'It is a natural process that is being amplified by human activity.' },
        ],
    },
    MATH: {
        mcqQuestions: [
            { instruction: 'What is the derivative of f(x) = x³?', options: ['3x²', 'x²', '3x³', 'x⁴/4'], correctIndex: 0, output: 'Using the power rule, d/dx(xⁿ) = nxⁿ⁻¹, so d/dx(x³) = 3x².', hint: 'Apply the power rule: bring down the exponent and subtract one.' },
            { instruction: 'What is the determinant of a 2×2 matrix [[a, b], [c, d]]?', options: ['ad - bc', 'a + d', 'ab + cd', 'ac - bd'], correctIndex: 0, output: 'The determinant of a 2×2 matrix is ad - bc, representing the scaling factor of the linear transformation.', hint: 'Multiply the main diagonal and subtract the other diagonal.' },
            { instruction: 'What does the Fundamental Theorem of Calculus state?', options: ['Integration and differentiation are inverse operations', 'Every continuous function is differentiable', 'All integrals are definite', 'Derivatives always exist for continuous functions'], correctIndex: 0, output: 'The Fundamental Theorem connects differential and integral calculus, showing they are inverse processes.', hint: 'It bridges the two main branches of calculus.' },
            { instruction: 'What is the probability of rolling a sum of 7 with two fair six-sided dice?', options: ['1/6', '1/12', '1/36', '5/36'], correctIndex: 0, output: 'There are 6 combinations summing to 7 out of 36 total outcomes: (1,6),(2,5),(3,4),(4,3),(5,2),(6,1). So 6/36 = 1/6.', hint: 'Count all pairs that sum to 7.' },
            { instruction: 'What is the formula for conditional probability P(A|B)?', options: ['P(A∩B) / P(B)', 'P(A∪B) / P(B)', 'P(A) × P(B)', 'P(A) + P(B)'], correctIndex: 0, output: 'Conditional probability P(A|B) = P(A∩B) / P(B), representing the probability of A given B has occurred.', hint: 'Think about restricting the sample space to B.' },
            { instruction: 'What is a vector projection?', options: ['The component of one vector along the direction of another', 'The cross product of two vectors', 'The dot product of two vectors', 'The magnitude of a vector'], correctIndex: 0, output: 'The projection of vector a onto vector b gives the component of a that lies in the direction of b.', hint: 'Think about the shadow of one vector on another.' },
            { instruction: 'What does the Central Limit Theorem state?', options: ['Sample means approach a normal distribution as sample size increases', 'All data is normally distributed', 'Variance equals the mean', 'Large samples guarantee accuracy'], correctIndex: 0, output: 'The Central Limit Theorem states that the distribution of sample means approximates a normal distribution as sample size grows, regardless of population shape.', hint: 'It is the foundation of many statistical inference methods.' },
        ],
        descriptiveQuestions: [
            { instruction: 'Explain the concept of a limit in calculus. Why is the limit definition important for understanding continuity and derivatives?', output: 'A limit describes the value a function approaches as input approaches a point. It formalizes continuity (limit equals function value) and derivatives (limit of difference quotient). Without limits, calculus lacks rigorous foundations.', hint: 'Consider approaching a value without necessarily reaching it.' },
            { instruction: 'Describe the difference between combinations and permutations. Provide formulas and real-world examples of each.', output: 'Permutations count ordered arrangements: P(n,r) = n!/(n-r)!. Combinations count unordered selections: C(n,r) = n!/(r!(n-r)!). Example: combination lock order matters (permutation), lottery numbers do not (combination).', hint: 'Does order matter in the counting problem?' },
            { instruction: 'Explain the concept of eigenvalues and eigenvectors. Why are they important in data science and machine learning applications?', output: 'Eigenvectors are non-zero vectors that scale (not rotate) under a linear transformation; eigenvalues are the scaling factors. Used in PCA for dimensionality reduction, Google PageRank, spectral clustering, and physics stability analysis.', hint: 'Think about directions that do not change under transformation.' },
        ],
    },
    HUMANITIES: {
        mcqQuestions: [
            { instruction: 'What is the Socratic method of teaching?', options: ['Asking questions to stimulate critical thinking and expose contradictions', 'Lecturing students on established facts', 'Memorization of texts through repetition', 'Learning through observation and imitation'], correctIndex: 0, output: 'The Socratic method uses probing questions to guide learners to discover truths and examine their own assumptions.', hint: 'Think about teaching through dialogue, not monologue.' },
            { instruction: 'What is the social contract theory in political philosophy?', options: ['Individuals consent to give up some freedoms in exchange for protection and order', 'Contracts between businesses and society', 'The agreement between employer and employee', 'International trade agreements'], correctIndex: 0, output: 'Social contract theory (Hobbes, Locke, Rousseau) argues that people trade some liberties for societal benefits and protection under a governing authority.', hint: 'Think about why we accept laws and government.' },
            { instruction: 'What does the term Renaissance mean and what period did it cover?', options: ['Rebirth of classical art and learning (14th-17th century)', 'The age of exploration (15th-16th century)', 'The period of religious reform (16th century)', 'The industrial revolution (18th-19th century)'], correctIndex: 0, output: 'The Renaissance was a cultural rebirth of classical ideals in art, science, and literature spanning the 14th to 17th centuries.', hint: 'It literally means rebirth.' },
            { instruction: 'What is cognitive dissonance in psychology?', options: ['Mental discomfort from holding contradictory beliefs', 'The ability to focus on multiple tasks', 'A memory enhancement technique', 'The process of learning a new language'], correctIndex: 0, output: 'Cognitive dissonance theory (Festinger) explains the discomfort experienced when holding conflicting cognitions, motivating attitude change.', hint: 'Think about the discomfort of inconsistency.' },
            { instruction: 'What is a sonnet in poetry?', options: ['A 14-line poem with a specific rhyme scheme', 'A five-line humorous poem', 'A narrative poem about heroes', 'A poem without rhyme or meter'], correctIndex: 0, output: 'A sonnet is a 14-line poem, typically in iambic pentameter, with structured rhyme schemes like Shakespearean (ABAB CDCD EFEF GG) or Petrarchan (ABBAABBA CDECDE).', hint: 'Shakespeare wrote many of these.' },
            { instruction: 'What does GDP measure in economics?', options: ['The total value of goods and services produced in a country', 'The stock market performance', 'The national debt level', 'The average income of citizens'], correctIndex: 0, output: 'Gross Domestic Product measures the monetary value of all finished goods and services produced within a country borders in a specific period.', hint: 'It is the broadest measure of economic output.' },
            { instruction: 'What is the Sapir-Whorf hypothesis in linguistics?', options: ['Language shapes thought and perception of reality', 'All languages share a universal grammar', 'Languages evolve independently of culture', 'Written language precedes spoken language'], correctIndex: 0, output: 'The Sapir-Whorf hypothesis proposes that the structure of a language influences its speakers worldview and cognitive processes.', hint: 'Does the language you speak affect how you think?' },
        ],
        descriptiveQuestions: [
            { instruction: 'Explain the concept of checks and balances in democratic government. Provide examples from the US Constitution.', output: 'Checks and balances divide power among legislative (Congress makes laws), executive (President enforces laws), and judicial (Courts interpret laws) branches. Examples: presidential veto, Senate confirmation, judicial review (Marbury v. Madison).', hint: 'Think about how each branch limits the others.' },
            { instruction: 'Describe the difference between nature and nurture in developmental psychology. How do modern perspectives integrate both influences?', output: 'Nature emphasizes genetic and biological factors; nurture emphasizes environment and experience. Modern epigenetics shows that environment can alter gene expression, and twin studies reveal heritability estimates for traits, supporting an interactionist model.', hint: 'Both play important and interconnected roles.' },
            { instruction: 'Explain the concept of cultural relativism and its importance in anthropological research. What are its limitations?', output: 'Cultural relativism evaluates cultures on their own terms without imposing external judgments. It prevents ethnocentrism and bias in research. Limitations: can lead to moral relativism where harmful practices are unquestioned, and complete objectivity is impossible.', hint: 'Seek to understand before judging.' },
        ],
    },
    GENERAL: {
        mcqQuestions: [
            { instruction: 'What is the primary purpose of formative assessment in education?', options: ['To monitor student learning and provide ongoing feedback', 'To assign final grades at the end of a course', 'To rank students against each other', 'To certify competency for graduation'], correctIndex: 0, output: 'Formative assessment monitors learning progress during instruction, providing feedback to improve teaching and learning.', hint: 'It happens during learning, not at the end.' },
            { instruction: 'What does the term critical thinking involve?', options: ['Analyzing facts objectively to form a reasoned judgment', 'Accepting information without question', 'Memorizing facts for exams', 'Disagreeing with every argument'], correctIndex: 0, output: 'Critical thinking involves careful analysis, evaluation of evidence, and logical reasoning to form well-supported conclusions.', hint: 'It is about thinking about your thinking.' },
            { instruction: 'What is the difference between correlation and causation?', options: ['Correlation does not imply causation', 'Causation always implies correlation', 'They are interchangeable terms', 'Correlation is stronger than causation'], correctIndex: 0, output: 'Two variables can be correlated without one causing the other (spurious correlation). Establishing causation requires controlled experiments and ruling out confounding variables.', hint: 'Ice cream sales and drowning incidents are correlated — does that mean ice cream causes drowning?' },
            { instruction: 'What is a key principle of effective time management?', options: ['Prioritizing tasks based on importance and urgency', 'Doing all tasks as they come without planning', 'Focusing only on urgent tasks', 'Working longer hours without breaks'], correctIndex: 0, output: 'Effective time management involves the Eisenhower Matrix: prioritize by importance and urgency, delegate low-importance tasks, and eliminate unnecessary ones.', hint: 'Not all tasks are equally important.' },
            { instruction: 'What is the purpose of peer review in academic research?', options: ['To evaluate the quality and validity of research before publication', 'To promote research among colleagues', 'To provide feedback on writing style', 'To approve research funding'], correctIndex: 0, output: 'Peer review subjects research to scrutiny by independent experts, ensuring methodological rigor, validity, and contribution to the field.', hint: 'It is a quality control mechanism.' },
            { instruction: 'What does the 80/20 rule (Pareto principle) state?', options: ['Roughly 80% of effects come from 20% of causes', '80% of work should be done in 20% of time', '20% of results are important, 80% are trivial', '80% of people produce 20% of output'], correctIndex: 0, output: 'The Pareto principle observes that approximately 80% of outcomes result from 20% of inputs, emphasizing focus on high-impact activities.', hint: 'Focus on the vital few, not the trivial many.' },
            { instruction: 'What is the scientific method?', options: ['A systematic process of observation, hypothesis, experimentation, and conclusion', 'A fixed set of rules that never changes', 'A method only used in physics and chemistry', 'An unsystematic approach to discovery'], correctIndex: 0, output: 'The scientific method is an empirical approach: observe → question → hypothesize → experiment → analyze → conclude (with replication and peer review).', hint: 'It is the foundation of all empirical science.' },
        ],
        descriptiveQuestions: [
            { instruction: 'Explain the concept of systems thinking and how it differs from reductionist approaches to problem-solving.', output: 'Systems thinking views problems as parts of an interconnected whole, emphasizing relationships, feedback loops, and emergent properties rather than reducing to individual components. It is essential for complex problems like climate change.', hint: 'Consider the forest, not just individual trees.' },
            { instruction: 'Describe the difference between intrinsic and extrinsic motivation. How can educators leverage both types effectively?', output: 'Intrinsic motivation comes from internal satisfaction (curiosity, mastery); extrinsic motivation from external rewards (grades, praise). Effective education balances both: foster intrinsic through autonomy and relevance, use extrinsic strategically without undermining internal drive.', hint: 'Are you doing it because you enjoy it or because of a reward?' },
            { instruction: 'Explain the concept of opportunity cost and its importance in decision-making across personal finance, business, and public policy.', output: 'Opportunity cost is the value of the best alternative foregone when making a choice. Every decision has trade-offs. In finance: investing in stocks vs bonds. In policy: spending on healthcare vs education. Recognizing it leads to better allocation decisions.', hint: 'What are you giving up by choosing this option?' },
        ],
    },
};

function generateSocraticOfflineFallback({ courseName, moduleName }) {
    const questions = [];
    const targetModName = moduleName || courseName || 'this module';
    const subject = classifySubject(courseName, moduleName);
    const templates = SUBJECT_TEMPLATES[subject] || SUBJECT_TEMPLATES.GENERAL;

    const shuffledMCQ = [...templates.mcqQuestions].sort(() => Math.random() - 0.5);
    const shuffledDesc = [...templates.descriptiveQuestions].sort(() => Math.random() - 0.5);

    for (let i = 0; i < Math.min(7, shuffledMCQ.length); i++) {
        const tpl = shuffledMCQ[i];
        const idx = questions.length + 1;
        const instruction = tpl.instruction
            .replace(/\bcourse\b/gi, courseName || 'this course')
            .replace(/\bmodule\b/gi, targetModName);

        questions.push({
            id: `q-${idx}`,
            instruction,
            type: 'MCQ',
            options: tpl.options.map((opt, oi) => {
                const label = String.fromCharCode(65 + oi);
                return `${label}: ${opt}`;
            }),
            correctIndex: tpl.correctIndex,
            output: tpl.output,
            topic: targetModName,
            difficulty: 'Beginner',
            hint: tpl.hint,
        });
    }

    for (let i = 0; i < Math.min(3, shuffledDesc.length); i++) {
        const tpl = shuffledDesc[i];
        const idx = questions.length + 1;
        const instruction = tpl.instruction
            .replace(/\bcourse\b/gi, courseName || 'this course')
            .replace(/\bmodule\b/gi, targetModName);

        questions.push({
            id: `q-${idx}`,
            instruction,
            type: 'Descriptive',
            output: tpl.output,
            topic: targetModName,
            difficulty: 'Beginner',
            hint: tpl.hint || 'Consider the key concepts and their relationships.',
        });
    }

    return questions;
}

/**
 * Store seen question IDs for replay protection
 * @param {string} userId - User ID
 * @param {string} courseName - Course name
 * @param {string} moduleKey - Module identifier (moduleId, moduleName, or 'all')
 * @param {Array} questions - Array of question objects
 */
async function storeSeenQuestions(userId, courseName, moduleKey, questions) {
    if (!userId || !redisClient || !questions?.length) return;
    
    try {
        const seenKey = `quiz:seen:${userId}:${courseName}:${moduleKey}`;
        const existing = await redisClient.get(seenKey);
        let seenIds = existing ? JSON.parse(existing) : [];
        
        // Extract question IDs from the questions array
        const newIds = questions
            .map(q => q._id || q._conceptQuestionId || q.id || q.question?.substring(0, 100))
            .filter(Boolean);
        
        if (newIds.length > 0) {
            // Combine and deduplicate, keep last 100
            const combined = [...new Set([...seenIds, ...newIds])].slice(-100);
            await redisClient.setEx(`quiz:seen:${userId}:${courseName}:${moduleKey}`, 30 * 24 * 3600, JSON.stringify(combined));
            log.info('QUIZ', `Stored ${newIds.length} seen question IDs for ${courseName}/${moduleKey}`);
        }
    } catch (e) {
        log.warn('QUIZ', `Failed to store seen questions: ${e.message}`);
    }
}

module.exports = {
    generateSocraticQuiz,
    generateSkillTreeQuestions,
    storeSeenQuestions,
    getSeenQuizQuestions,
    addSeenQuizQuestions,
    generateSocraticOfflineFallback,
};
