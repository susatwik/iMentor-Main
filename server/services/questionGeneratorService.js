// server/services/questionGeneratorService.js
const { callWithFallback } = require('./llmFallbackService');
const { getCurriculumStructure } = require('./socraticTutorService');
const { queryPythonRagService } = require('./ragQueryService');
const log = require('../utils/logger');

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
    try {
        const learningStage = user?.profile?.learningStage || 'Beginner';

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

        const preferredProvider = process.env.NODE_ENV === 'development' ? 'ollama' : 'sglang';
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

        return questions.map((q, idx) => {
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

    } catch (err) {
        log.warn('QUESTION_GENERATOR', `Socratic quiz generation failed: ${err.message}. Generating resilient offline fallback questions.`);
        return generateSocraticOfflineFallback({ courseName, moduleName: moduleName || moduleId });
    }
}

/**
 * Generate Skill Tree Level Questions: 6 MCQs (3 Easy, 2 Medium, 1 Hard)
 */
async function generateSkillTreeQuestions({ topic, levelId, levelName, difficulty, user, seenQuestions = [] }) {
    try {
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

        const preferredProvider = process.env.NODE_ENV === 'development' ? 'ollama' : 'sglang';
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

function generateSocraticOfflineFallback({ courseName, moduleName }) {
    const questions = [];
    const targetModName = moduleName || 'this module';
    
    // 7 MCQs
    for (let i = 1; i <= 7; i++) {
        questions.push({
            instruction: `Foundational multiple-choice question ${i} regarding the core principles of ${targetModName} in ${courseName}.`,
            type: 'MCQ',
            options: [
                `Option A: An approach that focuses on baseline optimization of ${targetModName}.`,
                `Option B: The primary methodology establishing structural behavior and workflow standard.`,
                `Option C: A secondary option representing an alternative implementation technique.`,
                `Option D: A legacy framework with limited compatibility.`
            ],
            correctIndex: 1,
            output: `Option B is correct because it aligns with the standard best practices and theoretical foundations of ${targetModName}.`,
            topic: targetModName,
            difficulty: 'Beginner',
            hint: `Focus on the primary methodology and core architecture.`
        });
    }

    // 3 Descriptive
    for (let i = 8; i <= 10; i++) {
        questions.push({
            instruction: `Explain the practical significance and architectural trade-offs of implementing ${targetModName} within the broader context of ${courseName}.`,
            type: 'Descriptive',
            output: `The ideal explanation should describe the core mechanisms of ${targetModName}, evaluate trade-offs like speed vs resource usage, and discuss integration with other subsystems in ${courseName}.`,
            topic: targetModName,
            difficulty: 'Beginner',
            hint: `Consider trade-offs, scalability, and system integration.`
        });
    }

    return questions;
}

module.exports = {
    generateSocraticQuiz,
    generateSkillTreeQuestions
};
