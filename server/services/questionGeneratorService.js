const axios = require('axios');
const { callWithFallback } = require('./llmFallbackService');
const { getCurriculumStructure } = require('./socraticTutorService');
const log = require('../utils/logger');

const PYTHON_RAG_URL = process.env.PYTHON_RAG_SERVICE_URL || 'http://127.0.0.1:2001';

const BANNED_PHRASES = [
    'Foundational multiple-choice',
    'core principles',
    'baseline optimization',
    'primary methodology',
    'legacy framework',
    'architectural trade-off',
    'Option A',
    'Option B',
    'Option C',
    'Option D',
    'standard implementation approach',
    'core theoretical framework',
    'deprecated technique',
    'auxiliary optimization'
];

async function fetchLectureContent(courseName, moduleId, moduleName) {
    const structure = await getCurriculumStructure(courseName);
    if (!structure || !structure.modules || structure.modules.length === 0) {
        return null;
    }

    const targetMod = structure.modules.find(m => m.id === moduleId || m.name === moduleName || m.id === moduleName);
    const mods = targetMod ? [targetMod] : structure.modules;

    const modParts = mods.map(m => {
        let str = `## Module: ${m.name}\n${m.description ? m.description + '\n' : ''}`;
        if (m.topics) {
            for (const t of m.topics) {
                str += `\n### ${t.name}\n`;
                if (t.subtopics) {
                    for (const s of t.subtopics) {
                        str += `- **${s.name}**`;
                        if (s.description) str += `: ${s.description}`;
                        str += '\n';
                    }
                }
            }
        }
        return str;
    });

    const fullContext = modParts.join('\n\n');

    const lectureParts = [];
    const subtopicBatch = [];
    for (const mod of mods) {
        if (mod.topics) {
            for (const topic of mod.topics) {
                if (topic.subtopics) {
                    for (const sub of topic.subtopics) {
                        subtopicBatch.push({ topic: topic.name, sub });
                    }
                }
            }
        }
    }

    const MAX_CONCURRENT = 2;
    for (let i = 0; i < Math.min(subtopicBatch.length, 4); i += MAX_CONCURRENT) {
        const batch = subtopicBatch.slice(i, i + MAX_CONCURRENT);
        const batchResults = await Promise.allSettled(batch.map(({ topic, sub }) =>
            axios.get(
                `${PYTHON_RAG_URL}/curriculum/${encodeURIComponent(courseName)}/lecture/${encodeURIComponent(sub.id)}`,
                { timeout: 3000, params: { subtopic_name: sub.name, topic_name: topic } }
            ).then(resp => {
                if (resp.data && resp.data.markdown) {
                    const md = resp.data.markdown;
                    if (md.length > 300 && !md.includes('⚠️')) {
                        return { topic, subtopic: sub.name, content: md.slice(0, 2000) };
                    }
                }
                return null;
            }).catch(() => null)
        ));
        for (const r of batchResults) {
            if (r.status === 'fulfilled' && r.value) {
                const entry = `## ${r.value.subtopic}\n${r.value.content}`;
                if (!lectureParts.includes(entry)) {
                    lectureParts.push(entry);
                }
            }
        }
    }

    if (lectureParts.length > 0) {
        return `[[WITH_LECTURE]]\n${lectureParts.join('\n\n')}`;
    }

    return `[[CURRICULUM_ONLY]]\n${fullContext}`;
}

function parseLLMResponse(rawText, defaultDifficulty) {
    let text = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();

    // Strategy 1: direct parse
    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed;
        if (parsed.MCQ || parsed.Descriptive) {
            const combined = [
                ...(Array.isArray(parsed.MCQ) ? parsed.MCQ : []),
                ...(Array.isArray(parsed.Descriptive) ? parsed.Descriptive : [])
            ];
            if (combined.length > 0) return combined;
        }
    } catch {}

    // Strategy 2: repair typographic chars and try again
    const repaired = text
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u2013\u2014]/g, '-');

    try {
        const parsed = JSON.parse(repaired);
        if (Array.isArray(parsed)) return parsed;
        if (parsed.MCQ || parsed.Descriptive) {
            const combined = [
                ...(Array.isArray(parsed.MCQ) ? parsed.MCQ : []),
                ...(Array.isArray(parsed.Descriptive) ? parsed.Descriptive : [])
            ];
            if (combined.length > 0) return combined;
        }
    } catch {}

    // Strategy 3: try to find array bounds and extract with aggressive repair
    const arrStart = repaired.indexOf('[');
    const arrEnd = repaired.lastIndexOf(']');
    if (arrStart !== -1 && arrEnd > arrStart) {
        let arrText = repaired.slice(arrStart, arrEnd + 1);
        arrText = arrText
            .replace(/,\s*\]/g, ']')
            .replace(/,\s*}/g, '}')
            .replace(/([{,])\s*(\w+)\s*:/g, '$1"$2":')
            .replace(/:\s*'([^']*)'/g, ':"$1"');
        try {
            const parsed = JSON.parse(arrText);
            if (Array.isArray(parsed)) return parsed;
        } catch {}
    }

    // Strategy 4: wrap object in array if it's {MCQ:[], Descriptive:[]}
    const braceObj = repaired.match(/^\{[\s\S]*\}$/);
    if (braceObj) {
        try {
            const parsed = JSON.parse(braceObj[0]);
            if (parsed.MCQ || parsed.Descriptive) {
                const combined = [
                    ...(Array.isArray(parsed.MCQ) ? parsed.MCQ : []),
                    ...(Array.isArray(parsed.Descriptive) ? parsed.Descriptive : [])
                ];
                if (combined.length > 0) return combined;
            }
        } catch {}
    }

    // Strategy 5: extract individual objects with regex
    const items = [];
    const qRegex = /\{[^{]*?"(?:question|instruction)"\s*:\s*"[^"]*?"[^}]*?\}/gs;
    let match;
    while ((match = qRegex.exec(repaired)) !== null) {
        try {
            const item = JSON.parse(match[0]);
            if (item.question || item.instruction) {
                items.push(item);
            }
        } catch {}
    }
    if (items.length > 0) return items;

    // Strategy 6: loose extraction of any brace-delimited blocks
    const loose = text.match(/\{[^{}]*\}/gs);
    if (loose) {
        for (const block of loose) {
            try {
                const item = JSON.parse(block);
                if (item.question || item.instruction) {
                    items.push(item);
                }
            } catch {}
        }
    }
    return items.length > 0 ? items : null;
}

async function generateSocraticQuiz({ courseName, moduleId, moduleName, user }) {
    try {
        const learningStage = user?.profile?.learningStage || 'Beginner';
        const weakTopics = user?.profile?.weakTopics || [];
        const strongTopics = user?.profile?.strongTopics || [];

        let compositionPrompt = '';
        if (weakTopics.length > 0) {
            compositionPrompt += `\n- The student struggles with: ${weakTopics.join(', ')}. Allocate more questions to these topics with supportive scaffolding.\n`;
        }
        if (strongTopics.length > 0) {
            compositionPrompt += `\n- The student excels at: ${strongTopics.join(', ')}. Make questions on these topics challenging.\n`;
        }

        log.info('QUIZ', `Fetching lecture content for ${courseName} / ${moduleName || moduleId}`);
        const contextText = await fetchLectureContent(courseName, moduleId, moduleName);

        const hasLectureContent = contextText && contextText.startsWith('[[WITH_LECTURE]]');
        const curriculumOnly = contextText && contextText.startsWith('[[CURRICULUM_ONLY]]');
        const cleanContext = hasLectureContent
            ? contextText.replace('[[WITH_LECTURE]]\n', '')
            : curriculumOnly
                ? contextText.replace('[[CURRICULUM_ONLY]]\n', '')
                : contextText;

        const prompt = `Generate 10 questions (7 MCQ, 3 Descriptive) for "${courseName}"${moduleName ? ' module: ' + moduleName : ''}. Level: ${learningStage}.

Content:
${cleanContext}

Rules:
- Reference real subtopics, definitions, formulas, terms from content above
- MCQ: EXACTLY 4 plain text options, correctIndex (0-based), hint required
- Descriptive: output (expected answer), hint required
${compositionPrompt}
- BANNED phrases: core principles, baseline optimization, primary methodology, legacy framework, architectural trade-offs, standard implementation approach, core theoretical framework
- Return only valid JSON array. Example: [{"instruction":"What is ...?","type":"MCQ","options":["opt1","opt2","opt3","opt4"],"correctIndex":0,"output":"","topic":"subtopic","difficulty":"${learningStage}","hint":"..."}]`;

        const preferredProvider = process.env.NODE_ENV === 'development' ? 'ollama' : 'sglang';
        const modelOverride = process.env.TEST_OLLAMA_MODEL || undefined;
        const fallbackResult = await callWithFallback({
            userQuery: prompt,
            preferredProvider,
            preferLocalFirst: true,
            options: modelOverride ? { model: modelOverride, temperature: 0.3 } : { temperature: 0.3 }
        });

        if (fallbackResult.provider === 'none') {
            throw new Error('All LLM providers are offline/unavailable.');
        }

        const parsed = parseLLMResponse(fallbackResult.text, learningStage);
        if (!parsed || parsed.length === 0) {
            throw new Error('LLM did not return a valid array of questions.');
        }
        const questions = parsed;

        const containsBanned = (text) => {
            if (!text) return false;
            return BANNED_PHRASES.some(phrase => text.toLowerCase().includes(phrase.toLowerCase()));
        };

        const hasBanned = questions.some(q =>
            containsBanned(q.instruction) ||
            (Array.isArray(q.options) && q.options.some(o => containsBanned(o))) ||
            containsBanned(q.output) ||
            containsBanned(q.explanation)
        );

        if (hasBanned) {
            log.warn('QUIZ', 'Generated quiz contains banned placeholder phrases. Retrying once...');
            const retryResult = await callWithFallback({
                userQuery: prompt.replace('Return ONLY valid JSON array.', 'FATAL: Your previous response used placeholder phrases. This is FORBIDDEN. Every question MUST reference real subtopic names, real definitions, and real engineering concepts from the course content. Return ONLY valid JSON array.'),
                preferredProvider,
                preferLocalFirst: true,
                options: modelOverride ? { model: modelOverride, temperature: 0.3 } : { temperature: 0.3 }
            });
            if (retryResult.provider !== 'none') {
                const retryParsed = parseLLMResponse(retryResult.text, learningStage);
                if (retryParsed && retryParsed.length > 0) {
                    const retryHasBanned = retryParsed.some(q =>
                        containsBanned(q.instruction) ||
                        (Array.isArray(q.options) && q.options.some(o => containsBanned(o))) ||
                        containsBanned(q.output)
                    );
                    if (!retryHasBanned) {
                        return normalizeQuestions(retryParsed, learningStage);
                    }
                }
            }
            throw new Error('Retry still produced placeholder questions.');
        }

        return normalizeQuestions(questions, learningStage);

    } catch (err) {
        log.error('QUIZ', `Socratic quiz generation failed: ${err.message}`);
        if (err.message.includes('placeholder') || err.message.includes('banned')) {
            throw new Error('Quiz generation failed: could not produce lecture-derived questions. Try again later.');
        }
        throw new Error(`Quiz generation failed: ${err.message}`);
    }
}

function normalizeQuestions(questions, defaultDifficulty) {
    return questions.map((q, idx) => {
        const isMCQ = q.type === 'MCQ' || (Array.isArray(q.options) && q.options.length > 0);
        let correctIndex = undefined;
        if (isMCQ) {
            if (typeof q.correctIndex === 'number') {
                correctIndex = q.correctIndex;
            } else if (typeof q.answer === 'number') {
                correctIndex = q.answer;
            } else if (typeof q.answer === 'string' && /^\d+$/.test(q.answer)) {
                correctIndex = parseInt(q.answer);
            } else {
                correctIndex = 0;
            }
        }
        return {
            instruction: q.instruction || q.question || `Question ${idx + 1}`,
            type: isMCQ ? 'MCQ' : 'Descriptive',
            options: isMCQ ? (q.options || []).map(o => String(o).replace(/^[A-Da-d][.):\-]\s*/, '')) : undefined,
            correctIndex,
            output: q.output || q.answer_text || q.explanation || q.answerText || '',
            topic: q.topic || 'General',
            difficulty: q.difficulty || defaultDifficulty,
            hint: q.hint || ''
        };
    });
}

async function generateSkillTreeQuestions({ topic, levelId, levelName, difficulty, user, seenQuestions = [] }) {
    try {
        const searchQuery = `Explain core concepts, definitions, design trade-offs, architecture, and practical code examples for: ${levelName} under the topic: ${topic}.`;
        let contextText = 'No course material context available.';
        let ragResult = null;

        try {
            const { queryPythonRagService } = require('./ragQueryService');
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

        if (!ragResult || !ragResult.toolOutput || ragResult.toolOutput.trim() === '' || ragResult.toolOutput.includes('No context found') || ragResult.toolOutput === 'No course material context available.') {
            const structure = await getCurriculumStructure(topic);
            if (structure && structure.modules && structure.modules.length > 0) {
                let fallbackParts = [];
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

        return questions.map((q, qi) => {
            const out = {
                question: typeof q.question === 'string' ? q.question : (q.prompt || q.text || `Question ${qi + 1}`),
                options: Array.isArray(q.options) ? q.options.map(o => String(o).replace(/^[A-Da-d][.):\-]\s*/, '')) : (q.options ? [String(q.options)] : []),
                explanation: q.explanation || q.explain || q.explanations || ''
            };

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
        log.warn('QUESTION_GENERATOR', `Skill Tree questions generation failed: ${err.message}.`);
        throw new Error(`Skill tree question generation failed: ${err.message}`);
    }
}

module.exports = {
    generateSocraticQuiz,
    generateSkillTreeQuestions
};