/**
 * ReAct Framework Orchestrator
 * 
 * Implements the ReAct (Reasoning and Acting) pattern for the Socratic Tutor:
 * 1. CLASSIFY - Analyze student response and understanding level
 * 2. MOVE - Determine next pedagogical action based on classification
 * 3. GENERATE - Create adaptive follow-up question
 * 
 * This orchestrator coordinates the three-step reasoning loop that adapts
 * the tutoring experience based on real-time student performance.
 */

const geminiService = require('./geminiService');
const ollamaService = require('./ollamaService');
const log = require('../utils/logger');
const {
    SOCRATIC_CLASSIFICATION_PROMPT,
    SOCRATIC_QUESTION_GENERATION_PROMPT
} = require('../config/promptTemplates');
const llmStreamingService = require('./llmStreamingService');
const { determineTeachingAction, validateTutorOutput, TEACHING_ACTIONS } = require('./pedagogicalEngine');
const { redisClient } = require('../config/redisClient');

// ============================================================================
// CONSTANTS - Cognitive Framework
// ============================================================================

const COGNITIVE_LEVELS = {
    L1_CONCEPT: 'L1_CONCEPT',         // Definition, basic understanding
    L2_APPLICATION: 'L2_APPLICATION', // Real-world examples, practical use
    L3_CRITICAL: 'L3_CRITICAL',       // Edge cases, limitations, bias
    L4_EVALUATION: 'L4_EVALUATION'    // Comparison, improvement, design
};

const PEDAGOGICAL_MOVES = {
    STAY: 'STAY',                     // Stay at current level (refine/correct)
    ADVANCE_LEVEL: 'ADVANCE_LEVEL',   // Move up the ladder (L1 -> L2, etc.)
    JUMP_LEVEL: 'JUMP_LEVEL',         // Skip a level (L1 -> L3) for advanced students
    COMPLETE: 'COMPLETE'              // Subtopic mastery achieved
};

const SCORE_SYSTEM = {
    PARTIAL: 0.5,
    BASIC: 1.0,
    REASONING: 1.5,
    APPLICATION: 2.0,
    ADVANCED: 2.5
};

const MASTERY_THRESHOLD = 4.0;        // Cumulative score needed for mastery
const MIN_COGNITIVE_LEVELS_COVERED = 2; // Minimum number of unique levels touched

// ============================================================================
// STEP 1: CLASSIFY - Analyze Student Understanding
// ============================================================================

/**
 * Classify student response using LLM-based analysis
 * 
 * @param {string} studentResponse - Student's answer
 * @param {string} moduleTitle - Current teaching module
 * @param {string} lastQuestion - Previous question asked
 * @param {Object} llmConfig - LLM configuration
 * @returns {Object} - { classification, reasoning, score, recommendedAction }
 */
async function classifyStudentUnderstanding(studentResponse, moduleTitle, lastQuestion, llmConfig, groundTruth = "") {
    const { llmService, llmOptions } = getLLMService(llmConfig);
    const prompt = SOCRATIC_CLASSIFICATION_PROMPT(moduleTitle, lastQuestion, studentResponse, groundTruth);

    try {
        const response = await llmService.generateContentWithHistory([], prompt, "Return only raw JSON output as specified in the instruction.", llmOptions);
        
        let cleaned = response.trim();
        // Remove markdown code blocks if present
        if (cleaned.startsWith('```json')) {
            cleaned = cleaned.replace(/^```json/, '').replace(/```$/, '').trim();
        } else if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```/, '').replace(/```$/, '').trim();
        }

        const assessment = JSON.parse(cleaned);
        
        // Normalize assessment structure
        return {
            score: assessment.score || 0.5,
            classification: assessment.classification || 'VAGUE',
            studentLevel: assessment.student_level || 'beginner',
            masteryLevel: assessment.mastery_level || 'weak',
            reasoning: assessment.reasoning || '',
            suggestedMove: assessment.suggested_move || 'STAY'
        };
    } catch (err) {
        log.error('TUTOR', `Classification failed: ${err.message}`);
        // Fallback assessment
        return {
            score: 0.5,
            classification: 'VAGUE',
            studentLevel: 'beginner',
            masteryLevel: 'weak',
            reasoning: 'Error during classification.',
            suggestedMove: 'STAY'
        };
    }
}

// ============================================================================
// STEP 2: MOVE - Determine Pedagogical Action
// ============================================================================

/**
 * Determine next pedagogical move based on student performance
 * 
 * This implements the adaptive logic that decides whether to:
 * - STAY at current level (for poor responses)
 * - ADVANCE to next level (for good responses)
 * - JUMP a level (for excellent responses)
 * - COMPLETE (when mastery is achieved)
 * 
 * @param {Object} classification - Classification result from Step 1
 * @param {string} currentLevel - Current cognitive level
 * @param {number} currentScore - Cumulative mastery score
 * @param {Array} history - Array of previous { level, score } entries
 * @returns {string} - One of PEDAGOGICAL_MOVES
 */
function determineAdaptiveMove(classification, currentLevel, currentScore, history) {
    const { score, gaps } = classification;

    // If response was poor/wrong, stay and refine
    if (score < 1.0) return PEDAGOGICAL_MOVES.STAY;

    // Calculate level progression
    const levels = Object.values(COGNITIVE_LEVELS);
    const currentIndex = levels.indexOf(currentLevel);

    // If score is high (>= 2.0) and we aren't at the end, consider jumping
    if (score >= 2.0 && currentIndex < levels.length - 2) {
        return PEDAGOGICAL_MOVES.JUMP_LEVEL;
    }

    // Default: Move to next level if available, otherwise stay/complete
    if (currentIndex < levels.length - 1) {
        return PEDAGOGICAL_MOVES.ADVANCE_LEVEL;
    }

    return PEDAGOGICAL_MOVES.STAY; // At L4, we stay until mastery score triggers COMPLETE
}

/**
 * Check if mastery has been achieved
 * 
 * @param {number} masteryScore - Cumulative mastery score
 * @param {string} currentLevel - Current cognitive level
 * @param {Array} history - Array of previous { level, score } entries
 * @returns {boolean} - True if mastery achieved
 */
function checkMasteryAchieved(masteryScore, currentLevel, history) {
    const levelsCovered = new Set([...history.map(h => h.level), currentLevel]);
    return masteryScore >= MASTERY_THRESHOLD &&
        (levelsCovered.size >= MIN_COGNITIVE_LEVELS_COVERED ||
            currentLevel === COGNITIVE_LEVELS.L4_EVALUATION);
}

/**
 * Calculate next cognitive level based on pedagogical move
 * 
 * @param {string} currentLevel - Current cognitive level
 * @param {string} pedagogicalMove - Move from determineAdaptiveMove
 * @returns {string} - Next cognitive level
 */
function calculateNextLevel(currentLevel, pedagogicalMove) {
    const levels = Object.values(COGNITIVE_LEVELS);
    const currentIndex = levels.indexOf(currentLevel);

    if (pedagogicalMove === PEDAGOGICAL_MOVES.ADVANCE_LEVEL && currentIndex < levels.length - 1) {
        return levels[currentIndex + 1];
    } else if (pedagogicalMove === PEDAGOGICAL_MOVES.JUMP_LEVEL && currentIndex < levels.length - 2) {
        return levels[currentIndex + 2]; // Skip one level
    }

    // STAY keeps same level
    return currentLevel;
}

// ============================================================================
// STEP 3: GENERATE - Create Adaptive Follow-up Question
// ============================================================================

/**
 * Generate a Socratic follow-up question based on assessment.
 */
async function generateSocraticFollowUp(assessment, pedagogicalMove, moduleTitle, lastQuestion, studentResponse, turnCount, llmConfig, position, currentLevel, currentScore, context = "", onToken = null, usedQuestions = []) {
    // Check Redis-backed offline question bank first
    const course = position?.courseName || position?.course;
    const lookupId = position?.topicId || position?.subtopicId;
    if (course && lookupId) {
        try {
            const key = `im_cache:socratic_precompute:${course.toLowerCase()}:${lookupId.toLowerCase()}`;
            const cached = await redisClient.get(key);
            if (cached) {
                const pc = JSON.parse(cached);
                const levelMap = {
                    L1_CONCEPT: 'easy',
                    L2_APPLICATION: 'medium',
                    L3_CRITICAL: 'hard',
                    L4_EVALUATION: 'expert'
                };
                const bucket = levelMap[currentLevel] || 'easy';
                const questions = pc.questions?.[bucket];
                if (Array.isArray(questions) && questions.length > 0) {
                    const unusedQ = questions.find(q => q && q.question && !usedQuestions.includes(q.question));
                    if (unusedQ) {
                        log.info('TUTOR', `ReAct: using cached question at level ${currentLevel} for ${course}/${lookupId}`);
                        return unusedQ.question;
                    }
                }
            }
        } catch (err) {
            log.warn('TUTOR', `Failed to fetch precomputed follow-up in ReAct: ${err.message}`);
        }
    }

    const { llmService, llmOptions } = getLLMService(llmConfig);
    
    // Prepare classification string for prompt
    const classification = `${assessment.classification} (Level: ${assessment.studentLevel}, Mastery: ${assessment.masteryLevel})`;
    
    const prompt = SOCRATIC_QUESTION_GENERATION_PROMPT(
        classification,
        pedagogicalMove,
        moduleTitle,
        lastQuestion,
        studentResponse,
        currentLevel,
        currentScore,
        context
    );

    const systemPrompt = `You are iMentor, a supportive Study Mode Tutor. 
FOLLOW ALL PEDAGOGICAL RULES. 
Focus strictly on: ${moduleTitle}.
Tone: Calm, professional, encouraging.
Formatting: Use clean Markdown. No emojis.`;

    try {
        if (onToken && llmConfig.llmProvider === 'gemini') {
            return await llmStreamingService.streamCompletion({
                messages: [{ role: 'user', content: prompt }],
                provider: llmConfig.llmProvider,
                model: llmOptions.model || llmOptions.geminiModel,
                apiKey: llmOptions.apiKey,
                systemPrompt,
                onToken,
                options: { ...llmOptions, temperature: 0.6 }
            });
        }

        const response = await llmService.generateContentWithHistory([], prompt, systemPrompt, { ...llmOptions, temperature: 0.6 });
        return cleanResponse(response);
    } catch (err) {
        log.error('TUTOR', `Generation failed: ${err.message}`);
        return `Interesting point! Let's think about how **${moduleTitle}** applies here. Can you expand on that?`;
    }
}

/**
 * Clean LLM response to ensure no internal thinking leaks
 */
function cleanResponse(text) {
    if (!text) return "";
    return text
        .replace(/^(Thinking Process|Thought|Analysis|Reasoning|Internal Monologue|Thought Process):?\s*/i, '')
        .replace(/\n(Thinking Process|Thought|Analysis|Reasoning|Internal Monologue|Thought Process):?\s*/i, '\n')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .trim();
}

// ============================================================================
// ORCHESTRATOR - Main ReAct Cycle
// ============================================================================

/**
 * Execute the complete ReAct cycle: Classify → Move → Generate
 * 
 * This is the main orchestration function that coordinates all three steps
 * of the ReAct framework.
 * 
 * @param {Object} params - Orchestration parameters
 * @param {string} params.studentResponse - Student's answer
 * @param {string} params.moduleTitle - Current teaching module
 * @param {string} params.lastQuestion - Previous question
 * @param {Object} params.llmConfig - LLM configuration
 * @param {number} params.masteryScore - Current mastery score
 * @param {string} params.cognitiveLevel - Current cognitive level
 * @param {Array} params.history - Previous interactions
 * @param {number} params.turnCount - Conversation turn count
 * @param {Object} params.position - Curriculum position
 * @param {Function} params.onProgress - Progress callback
 * @returns {Object} - ReAct cycle result
 */
async function executeReActCycle({
    studentResponse,
    moduleTitle,
    lastQuestion,
    llmConfig,
    masteryScore = 0,
    cognitiveLevel = COGNITIVE_LEVELS.L1_CONCEPT,
    history = [],
    turnCount = 0,
    position = null,
    onProgress,
    groundTruth = "",
    context = "",
    onToken = null,
    usedQuestions = []
}) {
    const cycleStartTime = Date.now();
    const activeGroundTruth = groundTruth || context;

    // ========================================================================
    // STEP 1: CLASSIFY - Analyze student understanding
    // ========================================================================
    if (onProgress) onProgress('Analyzing depth of answer...');

    const classifyStart = Date.now();
    const assessment = await classifyStudentUnderstanding(
        studentResponse,
        moduleTitle,
        lastQuestion,
        llmConfig,
        activeGroundTruth
    );
    const classifyTime = Date.now() - classifyStart;

    const { score, classification } = assessment;

    // ========================================================================
    // STEP 2: MOVE - Determine pedagogical action
    // ========================================================================
    if (onProgress) onProgress('Determining pedagogical strategy...');

    const moveStart = Date.now();

    // Update mastery score (only add positive scores)
    const newMasteryScore = masteryScore + (score || 0);

    // Track attempts for misconception tracking
    let attempts = 0;
    if (history.length > 0) {
        let fails = 0;
        for (let i = history.length - 1; i >= 0; i--) {
            if ((history[i].score || 0) < 1.0) fails++;
            else break;
        }
        attempts = fails;
    }

    // Determine adaptive move through strictly controlled Pedagogical Engine
    const adaptiveMove = determineTeachingAction({
        score: score || 0,
        cumulativeMastery: newMasteryScore,
        cognitiveLevel,
        attempts,
        classification,
        suggestedMove: assessment.suggestedMove,
        masteryThreshold: MASTERY_THRESHOLD
    });

    // Check for mastery completion
    const isMastered = (adaptiveMove === TEACHING_ACTIONS.COMPLETE_SUBTOPIC);

    // For backwards compatibility mapping of levels, jump/advance map
    let convertedMoveForLevel = PEDAGOGICAL_MOVES.STAY;
    if (adaptiveMove === TEACHING_ACTIONS.ADVANCE_LEVEL) convertedMoveForLevel = PEDAGOGICAL_MOVES.ADVANCE_LEVEL;
    
    // Calculate next cognitive level
    const nextLevel = calculateNextLevel(cognitiveLevel, convertedMoveForLevel);

    const moveTime = Date.now() - moveStart;

    // Debug logging
    // log.info('TUTOR', `Cycle complete: ${classification} (${score}) -> ${adaptiveMove}`);
    
    // If mastery achieved, return completion message
    if (isMastered) {
        if (onProgress) onProgress('Verifying mastery...');
        log.success('TUTOR', `Mastery achieved: ${position?.subtopicName || moduleTitle}`);

        return {
            followUpQuestion: `Outstanding! You've shown strong mastery of **${position?.subtopicName || moduleTitle}**. Let's move onto the next topic!`,
            classification,
            reasoning: assessment.reasoning,
            pedagogicalMove: TEACHING_ACTIONS.COMPLETE_SUBTOPIC,
            isMastered: true,
            socraticState: 'MASTERY_ACHIEVED',
            nextLevel: nextLevel,
            masteryScore: newMasteryScore,
            steps: buildThinkingSteps(classification, score, assessment.reasoning, adaptiveMove, cognitiveLevel, nextLevel, newMasteryScore)
        };
    }

    // ========================================================================
    // STEP 3: GENERATE - Create adaptive follow-up question
    // ========================================================================
    if (onProgress) onProgress(`Generating Level ${nextLevel.split('_')[0].substring(1)} Question...`);

    const generateStart = Date.now();
    const followUp = await generateSocraticFollowUp(
        assessment,
        adaptiveMove,
        moduleTitle,
        lastQuestion,
        studentResponse,
        turnCount,
        llmConfig,
        position,
        nextLevel,
        newMasteryScore,
        context,
        onToken,
        usedQuestions
    );
    const generateTime = Date.now() - generateStart;

    if (onProgress) onProgress('Finalizing response...');

    const totalTime = Date.now() - cycleStartTime;
    log.info('TUTOR', `Follow-up ready (${nextLevel}) [${totalTime}ms]`);

    // ========================================================================
    // RETURN RESULT
    // ========================================================================
    return {
        followUpQuestion: followUp,
        classification,
        score,
        studentLevel: assessment.studentLevel,
        masteryLevel: assessment.masteryLevel,
        reasoning: assessment.reasoning,
        pedagogicalMove: adaptiveMove,
        isMastered: false,
        socraticState: nextLevel,
        nextLevel: nextLevel,
        masteryScore: newMasteryScore,
        steps: []
    };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get LLM service based on configuration
 */
function getLLMService(llmConfig) {
    // ⚠️ FIX: declare llmService with let to prevent global variable leak
    let llmService;

    llmService = llmConfig.llmProvider === 'ollama' ? ollamaService : geminiService;

    const llmOptions = {
        ...(llmConfig.llmProvider === 'ollama' && {
            model: llmConfig.ollamaModel || process.env.OLLAMA_DEFAULT_MODEL || 'qwen3.5:9b',
            think: true,
        }),
        ...(llmConfig.llmProvider === 'gemini' && { geminiModel: llmConfig.geminiModel || process.env.GEMINI_MODEL || 'gemini-2.0-flash' }),
        apiKey: llmConfig.apiKey,
        ollamaUrl: llmConfig.ollamaUrl
    };

    return { llmService, llmOptions };
}

/**
 * Build structured thinking steps for UI display
 */
function buildThinkingSteps(classification, score, reasoning, adaptiveMove, currentLevel, nextLevel, masteryScore) {
    const steps = [
        {
            stepId: 'thought',
            title: '🔍 Thought: Analyzing Understanding',
            content: `Identified **${classification}** level response (Score: ${score}). Evaluating depth and logical consistency.`
        },
        {
            stepId: 'classification',
            title: '📊 Classification: Reasoning Check',
            content: reasoning || 'Student demonstrated a solid grasp of the core concept.'
        },
        {
            stepId: 'decision',
            title: `🎯 Decision: ${adaptiveMove}`,
            content: `Mastery Progress: ${masteryScore.toFixed(1)}/${MASTERY_THRESHOLD}. Transitioning logic to ${nextLevel.split('_')[1] || 'CONCEPT'}.`
        }
    ];

    if (adaptiveMove === 'COMPLETE') {
        steps.push({
            stepId: 'action',
            title: '🏆 Action: Mastery Achieved',
            content: 'Topic mastered! Preparing curriculum transition and next introduction.'
        });
    } else {
        steps.push({
            stepId: 'action',
            title: '💡 Action: Generating Question',
            content: `Creating a Level ${nextLevel.split('_')[1] || 'CONCEPT'} Socratic question to guide the student deeper.`
        });
    }

    return steps;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    // Main orchestrator
    executeReActCycle,

    // Individual steps (for granular control)
    classifyStudentUnderstanding,
    determineAdaptiveMove,
    generateSocraticFollowUp,

    // Helper functions
    checkMasteryAchieved,
    calculateNextLevel,

    // Constants
    COGNITIVE_LEVELS,
    PEDAGOGICAL_MOVES,
    SCORE_SYSTEM,
    MASTERY_THRESHOLD,
    MIN_COGNITIVE_LEVELS_COVERED
};
