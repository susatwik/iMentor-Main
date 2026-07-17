// server/services/bossBattleService.js
// RELOAD TRIGGER: 2026-02-08 - Integrated Contextual Memory
const BossBattle = require('../models/BossBattle');
const GamificationProfile = require('../models/GamificationProfile');
const knowledgeStateService = require('./knowledgeStateService');
const { selectLLM } = require('./llmRouterService');
const geminiService = require('./geminiService');
const groqService = require('./groqService');
const gamificationService = require('./gamificationService');
const badgeService = require('./badgeService');
const log = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

/**
 * Identify user's weak topics from Contextual Memory (StudentKnowledgeState)
 * Much faster and more accurate than re-analyzing chat history each time
 * @param {string} userId - User ID
 * @returns {Promise<Object>} - Weak topic info with mastery score
 */
async function identifyWeakTopic(userId) {
    try {
        // log.info('SYSTEM', `Identifying weak topic for ${userId}`);

        // Get struggling topics from contextual memory
        const strugglingTopics = await knowledgeStateService.getStrugglingTopics(userId);

        if (strugglingTopics && strugglingTopics.length > 0) {
            // Sort by lowest mastery (most struggling first)
            const sortedTopics = strugglingTopics
                .sort((a, b) => (a.masteryScore || 0) - (b.masteryScore || 0));

            const weakestTopic = sortedTopics[0];
            const topicName = weakestTopic.conceptName || weakestTopic.topic || 'General Knowledge';

                // log.info('SYSTEM', `Weak topic: ${topicName}`);

            return {
                topic: topicName,
                masteryScore: weakestTopic.masteryScore || 0,
                misconceptions: weakestTopic.misconceptions || [],
                source: 'contextual_memory'
            };
        }

        // Fallback: Check knowledge state directly if service returned empty
        try {
            const StudentKnowledgeState = require('../models/StudentKnowledgeState');
            const state = await StudentKnowledgeState.findOne({ userId });

            if (state && state.concepts && state.concepts.length > 0) {
                // Find the concept with lowest mastery
                const strugglingConcept = state.concepts
                    .filter(c => c.masteryScore < 60)
                    .sort((a, b) => a.masteryScore - b.masteryScore)[0];

                if (strugglingConcept) {
                    // log.info('SYSTEM', `Found weak concept (DB): ${strugglingConcept.conceptName}`);
                    return {
                        topic: strugglingConcept.conceptName,
                        masteryScore: strugglingConcept.masteryScore,
                        misconceptions: strugglingConcept.misconceptions || [],
                        source: 'knowledge_state_db'
                    };
                }
            }

            // Check focus areas as last resort
            if (state && state.focusAreas && state.focusAreas.length > 0) {
                const focusTopic = state.focusAreas[0].topic || 'General Knowledge';
                // log.info('SYSTEM', `Using focus area: ${focusTopic}`);
                return {
                    topic: focusTopic,
                    masteryScore: 50,
                    misconceptions: [],
                    source: 'focus_areas'
                };
            }
        } catch (err) {
            log.warn('SYSTEM', `Knowledge state fallback failed: ${err.message}`);
        }

        // Final fallback
        // log.info('SYSTEM', `No memory found for ${userId}, using default topic`);
        return {
            topic: 'General Knowledge',
            masteryScore: 50,
            misconceptions: [],
            source: 'default'
        };

    } catch (error) {
        log.error('SYSTEM', 'Error identifying weak topic', error);
        return {
            topic: 'General Knowledge',
            masteryScore: 50,
            misconceptions: [],
            source: 'error_fallback'
        };
    }
}

/**
 * Generate boss battle questions using AI
 */
async function generateBattleQuestions(topic, difficulty, count = 5) {
    try {
        const systemPrompt = `You are an expert academic tutor specializing in ${topic}. 
Your task is to generate highly accurate, challenging, and pedagogical multiple-choice questions that STRICTLY focus on ${topic}. 

CRITICAL RULES:
1. ALL questions MUST be directly related to ${topic}
2. DO NOT generate general knowledge questions unless the topic is "General Knowledge"
3. DO NOT generate questions about unrelated topics like geography, history, or literature
4. Focus on technical details, concepts, and problem-solving ONLY within the context of ${topic}
5. Every question should test understanding of ${topic} specifically

If you cannot generate enough topic-specific questions, refuse to generate off-topic questions and return fewer questions instead.`;

        const prompt = `Generate exactly ${count} challenging multiple-choice questions EXCLUSIVELY about "${topic}".

TOPIC FOCUS: ${topic}
DIFFICULTY: ${difficulty}

MANDATORY REQUIREMENTS:
- Every single question MUST be about ${topic}
- NO off-topic questions (e.g., if topic is "TIME_COMPLEXITY", do NOT ask about capitals, planets, etc.)
- Questions should test deep technical understanding of ${topic}
- Each question must include the topic name or related concepts

Return ONLY a JSON array with this exact structure (no other text):
[
  {
    "questionText": "Specific technical question about ${topic}?",
    "options": ["Accurate option text", "Plausible distractor", "Another distractor", "Fourth option"],
    "correctAnswer": "Option X",
    "explanation": "Brief explanation relating to ${topic}"
  }
]

Difficulty Guidance for "${difficulty}":
- Easy: Basic concepts and definitions of ${topic}
- Medium: Application of ${topic} principles and intermediate concepts
- Hard: Complex problem-solving and advanced ${topic} theories
- Expert: Cutting-edge research, intricate edge cases in ${topic}

VERIFY: Before finalizing, check that EVERY question is strictly about ${topic}.`;


        log.info('SYSTEM', `Generating ${count} questions for ${topic} (${difficulty})`);

        const { chosenModel } = await selectLLM(prompt, { user: { _id: 'system' }, subject: topic });
        // log.info('SYSTEM', `Selected model: ${chosenModel.provider}`);

        let response;
        let generationSuccess = false;

        // Try Ollama first if selected
        if (chosenModel.provider === 'ollama') {
            try {
                // log.info('SYSTEM', 'Attempting battle generation with Ollama...');
                const ollamaService = require('./ollamaService');
                response = await ollamaService.generateContentWithHistory(
                    [],              // empty chat history
                    prompt,          // the question generation prompt
                    systemPrompt,    // added system prompt
                    {
                        model: chosenModel.modelId || 'llama3.2:latest',
                        ollamaUrl: process.env.OLLAMA_API_BASE_URL || 'http://localhost:11434',
                        temperature: 0.7
                    }
                );
                generationSuccess = true;
                // log.success('SYSTEM', 'Ollama generation successful');
            } catch (ollamaError) {
                log.info('SYSTEM', 'Falling back from Ollama...');
            }
        }

        // Try Groq if selected
        else if (chosenModel.provider === 'groq') {
            try {
                // log.info('SYSTEM', 'Attempting battle generation with Groq...');
                const apiKey = process.env.GROQ_API_KEY;
                if (!apiKey) {
                    throw new Error('Groq API key not configured');
                }

                response = await groqService.generateContentWithHistory(
                    [],
                    prompt,
                    systemPrompt,
                    {
                        model: chosenModel.modelId || 'llama-3.1-8b-instant',
                        apiKey: apiKey,
                        temperature: 0.7
                    }
                );
                generationSuccess = true;
                // log.success('SYSTEM', 'Groq generation successful');
            } catch (groqError) {
                log.info('SYSTEM', 'Falling back from Groq...');
            }
        }

        // Fallback to Gemini if Ollama failed or if Gemini was selected
        if (!generationSuccess) {
            try {
                // log.info('SYSTEM', 'Attempting battle generation with Gemini...');
                const apiKey = process.env.GEMINI_API_KEY;
                if (!apiKey) {
                    log.error('SYSTEM', 'GEMINI_API_KEY not configured');
                    throw new Error('Gemini API key not configured');
                }
                response = await geminiService.generateContentWithHistory(
                    [],              // empty chat history
                    prompt,          // the question generation prompt
                    systemPrompt,    // added system prompt
                    { temperature: 0.7, apiKey }  // options with API key
                );
                generationSuccess = true;
                // log.success('SYSTEM', 'Gemini generation successful');
            } catch (geminiError) {
                log.error('SYSTEM', 'Gemini generation failed', geminiError);
                throw new Error('Both Ollama and Gemini failed to generate questions');
            }
        }

        // log.info('SYSTEM', `Received AI response (${response?.length} bytes)`);

        // Extract JSON array
        const jsonMatch = response.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
            log.error('SYSTEM', 'Failed to parse AI response');
            throw new Error('Failed to parse AI response - no JSON array found');
        }

        const questions = JSON.parse(jsonMatch[0]);

        // Validate questions
        if (!Array.isArray(questions) || questions.length === 0) {
            log.warn('SYSTEM', `Invalid questions format for ${topic}`);
            throw new Error('Invalid questions format');
        }

        log.success('SYSTEM', `Generated ${questions.length} valid questions for ${topic}`);

        const formattedQuestions = questions.map(q => ({
            questionText: q.questionText,
            options: q.options,
            correctAnswer: q.correctAnswer,
            explanation: q.explanation || '',
            userAnswer: '',
            isCorrect: false,
            timeSpent: 0
        }));

        // Ensure we have exactly the requested count
        if (formattedQuestions.length < count) {
            log.warn('SYSTEM', `Only got ${formattedQuestions.length}/${count} questions, adding fallbacks`);
            const fallbacks = generateFallbackQuestions(topic, count - formattedQuestions.length);
            return [...formattedQuestions, ...fallbacks];
        }

        return formattedQuestions.slice(0, count); // Return exactly 'count' questions

    } catch (error) {
        log.error('SYSTEM', 'Error generating questions', error);
        // Fallback questions
        return generateFallbackQuestions(topic, count);
    }
}

/**
 * Fallback questions if AI fails
 */
function generateFallbackQuestions(topic, count) {
    const topicQuestions = {
        'General Knowledge': [
            {
                questionText: 'What is the capital of France?',
                options: ['Paris', 'London', 'Berlin', 'Madrid'],
                correctAnswer: 'Paris',
                explanation: 'Paris is the capital and largest city of France.'
            },
            {
                questionText: 'Which planet is known as the Red Planet?',
                options: ['Mars', 'Venus', 'Jupiter', 'Saturn'],
                correctAnswer: 'Mars',
                explanation: 'Mars appears red due to iron oxide on its surface.'
            },
            {
                questionText: 'What is the largest ocean on Earth?',
                options: ['Pacific Ocean', 'Atlantic Ocean', 'Indian Ocean', 'Arctic Ocean'],
                correctAnswer: 'Pacific Ocean',
                explanation: 'The Pacific Ocean covers about 46% of Earth\'s water surface.'
            },
            {
                questionText: 'Who wrote "Romeo and Juliet"?',
                options: ['William Shakespeare', 'Charles Dickens', 'Jane Austen', 'Mark Twain'],
                correctAnswer: 'William Shakespeare',
                explanation: 'Shakespeare wrote this tragedy around 1594-1596.'
            },
            {
                questionText: 'What is the chemical symbol for gold?',
                options: ['Au', 'Ag', 'Fe', 'Cu'],
                correctAnswer: 'Au',
                explanation: 'Au comes from the Latin word "aurum" meaning gold.'
            }
        ],
        'Python': [
            {
                questionText: 'Which keyword is used to define a function in Python?',
                options: ['def', 'function', 'define', 'func'],
                correctAnswer: 'def',
                explanation: 'The "def" keyword is used to define functions in Python.'
            },
            {
                questionText: 'What is the output of: type([1, 2, 3])?',
                options: ['<class \'list\'>', '<class \'tuple\'>', '<class \'dict\'>', '<class \'set\'>'],
                correctAnswer: '<class \'list\'>',
                explanation: 'Square brackets [] create a list object in Python.'
            },
            {
                questionText: 'Which method adds an element to the end of a list?',
                options: ['append()', 'add()', 'insert()', 'push()'],
                correctAnswer: 'append()',
                explanation: 'The append() method adds elements to the end of a list.'
            },
            {
                questionText: 'What does the "pass" statement do?',
                options: ['Does nothing, acts as placeholder', 'Exits a loop', 'Raises an exception', 'Returns None'],
                correctAnswer: 'Does nothing, acts as placeholder',
                explanation: 'pass is a null operation used as a placeholder in Python.'
            },
            {
                questionText: 'How do you create a dictionary in Python?',
                options: ['{}', '[]', '()', 'dict[]'],
                correctAnswer: '{}',
                explanation: 'Curly braces {} are used to create dictionaries in Python.'
            }
        ],
        'JavaScript': [
            {
                questionText: 'Which keyword declares a block-scoped variable?',
                options: ['let', 'var', 'const', 'Both let and const'],
                correctAnswer: 'Both let and const',
                explanation: 'Both let and const create block-scoped variables, unlike var.'
            },
            {
                questionText: 'What does === check for?',
                options: ['Value and type equality', 'Value equality only', 'Type equality only', 'Reference equality'],
                correctAnswer: 'Value and type equality',
                explanation: 'The === operator checks both value and type without coercion.'
            },
            {
                questionText: 'Which method adds elements to the end of an array?',
                options: ['push()', 'pop()', 'shift()', 'unshift()'],
                correctAnswer: 'push()',
                explanation: 'push() adds one or more elements to the end of an array.'
            },
            {
                questionText: 'What is a closure in JavaScript?',
                options: ['Function with access to outer scope', 'Loop termination', 'Error handling', 'Object method'],
                correctAnswer: 'Function with access to outer scope',
                explanation: 'A closure gives a function access to its outer scope.'
            },
            {
                questionText: 'Which keyword creates an asynchronous function?',
                options: ['async', 'await', 'promise', 'callback'],
                correctAnswer: 'async',
                explanation: 'The async keyword declares an asynchronous function.'
            }
        ],
        'time_complexity': [
            {
                questionText: 'What is the time complexity of binary search?',
                options: ['O(log n)', 'O(n)', 'O(n log n)', 'O(n²)'],
                correctAnswer: 'O(log n)',
                explanation: 'Binary search divides the search space in half each iteration, resulting in logarithmic time complexity.'
            },
            {
                questionText: 'Which sorting algorithm has O(n log n) average time complexity?',
                options: ['Merge Sort', 'Bubble Sort', 'Selection Sort', 'Insertion Sort'],
                correctAnswer: 'Merge Sort',
                explanation: 'Merge sort uses divide-and-conquer and consistently achieves O(n log n) time complexity.'
            },
            {
                questionText: 'What is the time complexity of accessing an element in a hash table (average case)?',
                options: ['O(1)', 'O(log n)', 'O(n)', 'O(n log n)'],
                correctAnswer: 'O(1)',
                explanation: 'Hash tables provide constant-time average case access through direct addressing.'
            },
            {
                questionText: 'What is the worst-case time complexity of QuickSort?',
                options: ['O(n²)', 'O(n log n)', 'O(n)', 'O(log n)'],
                correctAnswer: 'O(n²)',
                explanation: 'QuickSort degrades to O(n²) when the pivot selection is poor, creating unbalanced partitions.'
            },
            {
                questionText: 'Which operation on a balanced BST has O(log n) time complexity?',
                options: ['Search, Insert, Delete', 'Only Search', 'Only Insert', 'Only Delete'],
                correctAnswer: 'Search, Insert, Delete',
                explanation: 'All three operations traverse the tree height, which is log n in a balanced BST.'
            }
        ],
        'data structures': [
            {
                questionText: 'Which data structure uses LIFO (Last In First Out)?',
                options: ['Stack', 'Queue', 'Array', 'Tree'],
                correctAnswer: 'Stack',
                explanation: 'Stacks follow LIFO principle where the last element added is the first to be removed.'
            },
            {
                questionText: 'What is the time complexity of inserting at the head of a linked list?',
                options: ['O(1)', 'O(n)', 'O(log n)', 'O(n log n)'],
                correctAnswer: 'O(1)',
                explanation: 'Inserting at the head only requires updating the head pointer, constant time operation.'
            },
            {
                questionText: 'Which data structure is best for implementing a priority queue?',
                options: ['Heap', 'Array', 'Stack', 'Linked List'],
                correctAnswer: 'Heap',
                explanation: 'Heaps provide O(log n) insertion and O(1) access to max/min element, ideal for priority queues.'
            },
            {
                questionText: 'What is a complete binary tree?',
                options: ['All levels filled except possibly last, which is filled left to right', 'All nodes have 0 or 2 children', 'All leaf nodes at same level', 'All internal nodes have 2 children'],
                correctAnswer: 'All levels filled except possibly last, which is filled left to right',
                explanation: 'A complete binary tree has all levels fully filled except possibly the last level, which fills from left to right.'
            },
            {
                questionText: 'Which data structure allows efficient search, insert, and delete in O(log n)?',
                options: ['Balanced BST', 'Array', 'Linked List', 'Hash Table'],
                correctAnswer: 'Balanced BST',
                explanation: 'Balanced Binary Search Trees maintain O(log n) operations by keeping tree height balanced.'
            }
        ],
        'algorithms': [
            {
                questionText: 'What algorithmic paradigm does merge sort use?',
                options: ['Divide and Conquer', 'Dynamic Programming', 'Greedy', 'Backtracking'],
                correctAnswer: 'Divide and Conquer',
                explanation: 'Merge sort divides the array into halves, recursively sorts them, then merges the results.'
            },
            {
                questionText: 'Which algorithm finds the shortest path in a weighted graph?',
                options: ['Dijkstra\'s Algorithm', 'Bubble Sort', 'Binary Search', 'DFS'],
                correctAnswer: 'Dijkstra\'s Algorithm',
                explanation: 'Dijkstra\'s algorithm efficiently finds shortest paths from a source to all vertices in weighted graphs.'
            },
            {
                questionText: 'What is dynamic programming primarily used for?',
                options: ['Optimization problems with overlapping subproblems', 'Sorting arrays', 'Searching trees', 'Network routing'],
                correctAnswer: 'Optimization problems with overlapping subproblems',
                explanation: 'Dynamic programming solves optimization problems by storing solutions to subproblems to avoid recomputation.'
            },
            {
                questionText: 'Which traversal visits nodes level by level?',
                options: ['BFS (Breadth-First Search)', 'DFS (Depth-First Search)', 'In-order', 'Pre-order'],
                correctAnswer: 'BFS (Breadth-First Search)',
                explanation: 'BFS explores nodes level by level using a queue, unlike DFS which explores depth-first.'
            },
            {
                questionText: 'What is the key principle of greedy algorithms?',
                options: ['Make locally optimal choice at each step', 'Try all possible solutions', 'Store all subproblem solutions', 'Divide problem into smaller parts'],
                correctAnswer: 'Make locally optimal choice at each step',
                explanation: 'Greedy algorithms make the best local choice at each step hoping to find a global optimum.'
            }
        ]
    };

    // Normalize topic name for lookup (lowercase, replace spaces with underscores)
    const normalizedTopic = topic.toLowerCase().replace(/\s+/g, '_');

    // Try exact match first
    let questionPool = topicQuestions[topic] || topicQuestions[normalizedTopic];

    // If no exact match, try partial matching for common topic keywords
    if (!questionPool) {
        const topicLower = topic.toLowerCase();
        if (topicLower.includes('time') || topicLower.includes('complexity') || topicLower.includes('big-o') || topicLower.includes('bigo')) {
            questionPool = topicQuestions['time_complexity'];
        } else if (topicLower.includes('data structure') || topicLower.includes('stack') || topicLower.includes('queue') || topicLower.includes('tree') || topicLower.includes('heap')) {
            questionPool = topicQuestions['data structures'];
        } else if (topicLower.includes('algorithm') || topicLower.includes('sort') || topicLower.includes('search') || topicLower.includes('graph')) {
            questionPool = topicQuestions['algorithms'];
        } else if (topicLower.includes('python')) {
            questionPool = topicQuestions['Python'];
        } else if (topicLower.includes('javascript') || topicLower.includes('js')) {
            questionPool = topicQuestions['JavaScript'];
        } else {
            // Last resort: use General Knowledge
            questionPool = topicQuestions['General Knowledge'];
            log.warn('SYSTEM', `No fallback questions for ${topic}, using GK`);
        }
    }


    // Return requested number of questions
    const questions = [];
    for (let i = 0; i < count && i < questionPool.length; i++) {
        questions.push({
            ...questionPool[i],
            userAnswer: '',
            isCorrect: false,
            timeSpent: 0
        });
    }

    // If we need more questions than available, repeat from start
    while (questions.length < count) {
        const idx = questions.length % questionPool.length;
        questions.push({
            ...questionPool[idx],
            userAnswer: '',
            isCorrect: false,
            timeSpent: 0
        });
    }

    return questions;
}

/**
 * Generate a thematic boss name based on the knowledge topic
 */
function generateBossName(topic, difficulty) {
    const formattedTopic = topic.split('.').pop().replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    
    const prefixes = [
        "The", "Lord of", "Master of", "Keeper of", "Architect of", 
        "Phantom of", "Warden of", "Emperor of", "Oracle of", "The Dreaded"
    ];
    
    const suffixes = [
        "Behemoth", "Titan", "Specter", "Overlord", "Entity", 
        "Construct", "Wraith", "Sentinel", "Guardian", "Colossus", "Leviathan"
    ];

    if (difficulty === 'hard') {
        prefixes.push("Grandmaster of", "Absolute", "The Unforgiving");
        suffixes.push("God", "Destroyer", "Omega");
    }

    const pattern = Math.floor(Math.random() * 3);
    if (pattern === 0) {
        return `${prefixes[Math.floor(Math.random() * prefixes.length)]} ${formattedTopic}`;
    } else if (pattern === 1) {
        return `${formattedTopic} ${suffixes[Math.floor(Math.random() * suffixes.length)]}`;
    } else {
        return `The ${formattedTopic} ${suffixes[Math.floor(Math.random() * suffixes.length)]}`;
    }
}

/**
 * Create a new boss battle for user
 */
async function createBossBattle(userId, topic = null, difficulty = null) {
    try {
        // Get user's level for difficulty calculation
        const profile = await GamificationProfile.findOne({ userId });
        const userLevel = profile?.level || 1;

        // Determine topic from contextual memory
        let topicInfo = null;
        if (!topic) {
            topicInfo = await identifyWeakTopic(userId);
            topic = topicInfo.topic || 'General Knowledge';
        }

        // Determine difficulty based on user level AND mastery score
        if (!difficulty) {
            // If we have mastery info, use it to calibrate difficulty
            if (topicInfo && topicInfo.masteryScore !== undefined) {
                // Lower mastery = easier questions to build confidence
                // Higher mastery but still struggling = harder questions to challenge
                if (topicInfo.masteryScore < 30) {
                    difficulty = 'easy';
                } else if (topicInfo.masteryScore < 50) {
                    difficulty = 'medium';
                } else {
                    difficulty = userLevel >= 10 ? 'hard' : 'medium';
                }
            } else {
                // Fallback to level-based difficulty
                difficulty = userLevel >= 10 ? 'hard' :
                    userLevel >= 5 ? 'medium' : 'easy';
            }
        }

        // Generate questions
        const questions = await generateBattleQuestions(topic, difficulty, 5);

        // Create battle
        const battleId = `battle_${uuidv4()}`;
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 48); // 48 hour expiry

        const battle = new BossBattle({
            userId,
            battleId,
            targetWeakness: topic,
            bossName: generateBossName(topic, difficulty),
            difficulty,
            questions,
            totalQuestions: questions.length,
            expiresAt,
            // Store contextual memory source for analytics
            analysisMeta: topicInfo ? {
                source: topicInfo.source,
                masteryScore: topicInfo.masteryScore,
                misconceptions: topicInfo.misconceptions?.slice(0, 3) || []
            } : null
        });

        await battle.save();

        log.success('SYSTEM', `Created battle ${battleId} for ${userId} on ${topic}`);

        return battle;

    } catch (error) {
        log.error('SYSTEM', 'Error creating battle', error);
        throw error;
    }
}

/**
 * AI-Powered Answer Evaluation
 * Uses Gemini to intelligently evaluate user answers
 */
async function evaluateAnswersWithAI(battle, userAnswers) {
    try {
        const prompt = `
You are an expert AI evaluator for educational assessments. Evaluate the user's answers to the following questions.

**Topic:** ${battle.targetWeakness}
**Difficulty:** ${battle.difficulty}

**Instructions:**
1. Compare each user answer with the correct answer and options
2. Determine if the answer is correct (even if phrased differently)
3. Provide detailed feedback explaining why it's correct or incorrect
4. Be lenient with minor variations in wording if the concept is correct

**Questions and Answers:**

${battle.questions.map((q, i) => `
Question ${i + 1}: ${q.questionText}
Options: ${q.options.join(', ')}
Correct Answer: ${q.correctAnswer}
User Answer: ${userAnswers[i]?.userAnswer || 'No answer provided'}
`).join('\n')}

**Output Format (JSON):**
Return a JSON array with one object per question:
[
  {
    "questionIndex": 0,
    "isCorrect": true/false,
    "aiExplanation": "Detailed explanation of why the answer is correct/incorrect",
    "conceptualUnderstanding": "assessment of user's understanding (good/partial/poor)"
  },
  ...
]
`;

        const llm = await selectLLM(prompt, { user: { _id: battle.userId }, subject: battle.targetWeakness });
        let response;
        let evalSuccess = false;
        if (llm.chosenModel.provider === 'ollama') {
            try {
                const ollamaService = require('./ollamaService');
                response = await ollamaService.generateContentWithHistory([], prompt, null, {
                    model: llm.chosenModel.modelId,
                    ollamaUrl: llm.chosenModel.workingUrl || process.env.OLLAMA_API_BASE_URL,
                    temperature: 0.3
                });
                evalSuccess = true;
            } catch (e) { log.warn('SYSTEM', `Ollama eval failed: ${e.message}`); }
        } else if (llm.chosenModel.provider === 'groq') {
            try {
                response = await groqService.generateContentWithHistory([], prompt, null, {
                    model: llm.chosenModel.modelId,
                    apiKey: process.env.GROQ_API_KEY,
                    temperature: 0.3
                });
                evalSuccess = true;
            } catch (e) { log.warn('SYSTEM', `Groq eval failed: ${e.message}`); }
        }
        if (!evalSuccess) {
            try {
                response = await geminiService.generateContentWithHistory([], prompt, null, {
                    apiKey: process.env.GEMINI_API_KEY,
                    temperature: 0.3
                });
            } catch (e) {
                log.warn('SYSTEM', `Gemini eval failed: ${e.message}`);
                return fallbackEvaluation(battle, userAnswers);
            }
        }

        // Parse JSON response
        const jsonMatch = response.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
            log.warn('SYSTEM', 'AI evaluation failed, using exact match');
            return fallbackEvaluation(battle, userAnswers);
        }

        const evaluations = JSON.parse(jsonMatch[0]);

        // log.info('SYSTEM', `AI evaluated ${evaluations.length} answers`);
        return evaluations;

    } catch (error) {
        log.error('SYSTEM', 'AI evaluation error', error);
        return fallbackEvaluation(battle, userAnswers);
    }
}

/**
 * Fallback evaluation using exact string comparison
 */
function fallbackEvaluation(battle, userAnswers) {
    return userAnswers.map((answer, index) => ({
        questionIndex: index,
        isCorrect: answer.userAnswer === battle.questions[index].correctAnswer,
        aiExplanation: battle.questions[index].explanation,
        conceptualUnderstanding: answer.userAnswer === battle.questions[index].correctAnswer ? 'good' : 'poor'
    }));
}

/**
 * Generate AI-powered revision plan for failed battles
 */
async function generateAIRevisionPlan(battle, evaluationResults) {
    try {
        const incorrectQuestions = battle.questions.filter((q, i) => !evaluationResults[i].isCorrect);

        const prompt = `
You are an educational advisor. A student failed a boss battle on "${battle.targetWeakness}".

**Performance:**
- Score: ${battle.score}%
- Correct: ${battle.correctAnswers}/${battle.totalQuestions}
- Difficulty: ${battle.difficulty}

**Weak Areas:**
${incorrectQuestions.map((q, i) => `
- ${q.questionText}
  User's answer: ${q.userAnswer}
  Correct answer: ${q.correctAnswer}
`).join('\n')}

**Create a personalized revision plan with:**
1. 3-5 specific topics to focus on
2. Suggested study materials or resources
3. Estimated retry days (2-7 days based on difficulty)
4. Actionable study tips

**Output Format (JSON):**
{
  "recommendedTopics": ["topic1", "topic2", ...],
  "suggestedDocuments": ["resource1", "resource2", ...],
  "estimatedRetryDays": 3,
  "aiSuggestions": "Detailed study plan and tips"
}
`;

        const llm = await selectLLM(prompt, { user: { _id: battle.userId }, subject: battle.targetWeakness });
        let response;
        let revSuccess = false;
        if (llm.chosenModel.provider === 'ollama') {
            try {
                const ollamaService = require('./ollamaService');
                response = await ollamaService.generateContentWithHistory([], prompt, null, {
                    model: llm.chosenModel.modelId,
                    ollamaUrl: llm.chosenModel.workingUrl || process.env.OLLAMA_API_BASE_URL,
                    temperature: 0.5
                });
                revSuccess = true;
            } catch (e) { log.warn('SYSTEM', `Ollama revision plan failed: ${e.message}`); }
        } else if (llm.chosenModel.provider === 'groq') {
            try {
                response = await groqService.generateContentWithHistory([], prompt, null, {
                    model: llm.chosenModel.modelId,
                    apiKey: process.env.GROQ_API_KEY,
                    temperature: 0.5
                });
                revSuccess = true;
            } catch (e) { log.warn('SYSTEM', `Groq revision plan failed: ${e.message}`); }
        }
        if (!revSuccess) {
            try {
                response = await geminiService.generateContentWithHistory([], prompt, null, {
                    apiKey: process.env.GEMINI_API_KEY,
                    temperature: 0.5
                });
            } catch (e) {
                log.warn('SYSTEM', `Gemini revision plan failed: ${e.message}`);
                return generateFallbackRevisionPlan(battle);
            }
        }

        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return generateFallbackRevisionPlan(battle);
        }

        const plan = JSON.parse(jsonMatch[0]);
        plan.estimatedRetryDate = new Date(Date.now() + plan.estimatedRetryDays * 24 * 60 * 60 * 1000);

        log.success('SYSTEM', 'Generated AI revision plan');
        return plan;

    } catch (error) {
        log.error('SYSTEM', 'Error generating revision plan', error);
        return generateFallbackRevisionPlan(battle);
    }
}

/**
 * Fallback revision plan
 */
function generateFallbackRevisionPlan(battle) {
    const incorrectQuestions = battle.questions.filter(q => !q.isCorrect);

    return {
        recommendedTopics: incorrectQuestions.map(q => q.questionText.substring(0, 50)),
        suggestedDocuments: [`Review ${battle.targetWeakness} fundamentals`],
        estimatedRetryDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        aiSuggestions: `Focus on understanding the core concepts of ${battle.targetWeakness}. Review the incorrect questions and practice similar problems.`
    };
}

/**
 * Submit answers for a battle
 */
async function submitBattle(battleId, userId, answers) {
    try {
        // log.info('SYSTEM', `User ${userId} submitting battle ${battleId}`);

        const battle = await BossBattle.findOne({ battleId, userId });

        if (!battle) {
            throw new Error('Battle not found');
        }

        if (battle.status !== 'active') {
            throw new Error('Battle is not active');
        }

        if (battle.isExpired()) {
            battle.status = 'expired';
            await battle.save();
            throw new Error('Battle has expired');
        }

        // log.info('SYSTEM', `Evaluating battle ${battleId}`);

        // AI-Powered Answer Evaluation
        const evaluationResults = await evaluateAnswersWithAI(battle, answers);

        // Update battle with AI evaluation results
        evaluationResults.forEach((result, index) => {
            if (battle.questions[index]) {
                battle.questions[index].userAnswer = answers[index].userAnswer;
                battle.questions[index].isCorrect = result.isCorrect;
                battle.questions[index].timeSpent = answers[index].timeSpent || 0;
                battle.questions[index].explanation = result.aiExplanation || battle.questions[index].explanation;
            }
        });

        // Calculate score
        battle.calculateScore();
        battle.completedAt = new Date();

        // Calculate total time
        battle.totalTimeSpent = battle.questions.reduce((sum, q) => sum + q.timeSpent, 0);

        log.info('SYSTEM', `Battle ${battleId} score: ${battle.score}% (${battle.correctAnswers}/${battle.totalQuestions})`);

        // Determine XP reward
        let earnedXP = 0;
        let newXPTotal = 0;
        let newLevel = 0;
        let leveledUp = false;

        if (battle.isPassed()) {
            battle.status = 'completed';
            // Base XP by difficulty
            const baseXP = battle.difficulty === 'hard' ? 15 :
                battle.difficulty === 'medium' ? 10 : 5;
            // Bonus for perfect score (boss battles are scored out of 100)
            const perfectBonus = battle.score === 100 ? 10 : 0;
            earnedXP = baseXP + perfectBonus;

            // Award XP with error handling
            try {
                const xpResult = await gamificationService.awardXP(userId, earnedXP, 'boss_battle', battle.targetWeakness);
                battle.earnedXP = earnedXP;
                newXPTotal = xpResult.newXP;
                newLevel = xpResult.newLevel;
                leveledUp = xpResult.leveledUp;
                log.success('SYSTEM', `Awarded ${earnedXP} XP to user ${userId} (Total: ${newXPTotal}, Lvl: ${newLevel}${leveledUp ? ' 🎉' : ''})`);
            } catch (xpError) {
                log.error('SYSTEM', 'Failed to award XP', xpError);
                throw new Error('Failed to award XP for boss battle');
            }

            // Check for badge
            try {
                const badge = await badgeService.checkBossBattleBadge(userId, battle);
                if (badge) {
                    battle.earnedBadge = badge.name;
                    log.success('SYSTEM', `User ${userId} earned badge: ${badge.name}`);
                }
            } catch (badgeError) {
                log.error('SYSTEM', 'Badge check failed', badgeError);
                // Don't throw - XP already awarded
            }

        } else {
            battle.status = 'failed';
            log.info('SYSTEM', `Battle ${battleId} failed (${battle.score}%)`);
            // Generate AI-powered revision plan
            battle.revisionPlan = await generateAIRevisionPlan(battle, evaluationResults);
        }

        await battle.save();
        log.success('SYSTEM', `Battle ${battleId} saved (${battle.status})`);

        // Update profile with completed battle
        if (battle.status === 'completed') {
            try {
                await GamificationProfile.findOneAndUpdate(
                    { userId },
                    {
                        $push: {
                            completedBattles: {
                                battleId: battle.battleId,
                                topic: battle.targetWeakness,
                                score: battle.score,
                                completedAt: battle.completedAt,
                                earnedBadge: battle.earnedBadge
                            }
                        }
                    }
                );
                // log.success('SYSTEM', `Updated gamification profile for user ${userId}`);
            } catch (profileError) {
                log.error('SYSTEM', 'Failed to update profile', profileError);
                // Don't throw - battle completion already saved
            }
        }

        // log.info('SYSTEM', `Battle submission complete for user ${userId}`);

        return {
            status: battle.status,
            score: battle.score,
            correctAnswers: battle.correctAnswers,
            totalQuestions: battle.totalQuestions,
            earnedXP,
            newXPTotal,
            newLevel,
            leveledUp,
            earnedBadge: battle.earnedBadge,
            revisionPlan: battle.revisionPlan
        };

    } catch (error) {
        log.error('SYSTEM', 'Error submitting battle', error);
        throw error;
    }
}

/**
 * Generate AI-powered revision plan
 */
/**
 * Get a specific battle by ID (sanitized)
 */
async function getBattle(battleId, userId) {
    try {
        const battle = await BossBattle.findOne({ battleId, userId });
        if (!battle) return null;

        // Don't send correct answers if battle is still active
        if (battle.status === 'active') {
            const sanitizedBattle = battle.toObject();
            sanitizedBattle.questions = sanitizedBattle.questions.map(q => ({
                _id: q._id,
                questionText: q.questionText,
                options: q.options
            }));
            return sanitizedBattle;
        }

        return battle;
    } catch (error) {
        log.error('SYSTEM', 'Error fetching battle', error);
        throw error;
    }
}

/**
 * Get active battles for user
 */
async function getActiveBattles(userId) {
    try {
        // Expire old battles first
        await BossBattle.expireOldBattles();

        const battles = await BossBattle.find({
            userId,
            status: 'active'
        }).sort({ generatedAt: -1 });

        return battles;
    } catch (error) {
        log.error('SYSTEM', 'Error fetching active battles', error);
        return [];
    }
}

/**
 * Get battle history
 */
async function getBattleHistory(userId, limit = 10) {
    try {
        const battles = await BossBattle.find({
            userId,
            status: { $in: ['completed', 'failed'] }
        }).sort({ completedAt: -1 }).limit(limit);

        return battles;
    } catch (error) {
        log.error('SYSTEM', 'Error fetching battle history', error);
        return [];
    }
}

module.exports = {
    createBossBattle,
    submitBattle,
    getActiveBattles,
    getBattleHistory,
    getBattle,
    identifyWeakTopic,
    generateBattleQuestions // Add for testing
};
