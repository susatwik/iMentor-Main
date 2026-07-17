/**
 * Adaptive Scaffolding Service
 * Adjusts hint difficulty and teaching strategy based on student's progress
 * Mimics how Gemini/ChatGPT adapts its guidance
 */

const geminiService = require('./geminiService');
const ollamaService = require('./ollamaService');

/**
 * Determines the appropriate scaffolding level
 * @param {Object} tutorSession - TutorSession document
 * @param {String|null} emotionalState - Student's detected emotional state (CURIOUS/CONFIDENT/UNCERTAIN/FRUSTRATED/BORED)
 * @returns {String} - 'minimal', 'moderate', 'heavy'
 */
function determineScaffoldingLevel(tutorSession, emotionalState = null) {
    const { studentLevel, conversationContext, previousHints } = tutorSession;

    // Emotional state override — frustrated or bored students need maximum support
    if (emotionalState === 'FRUSTRATED' || emotionalState === 'BORED') {
        return 'heavy';
    }

    // Check recent comprehension levels
    const recentContext = conversationContext.slice(-3);
    const avgComprehension = recentContext.length > 0
        ? recentContext.reduce((sum, ctx) => sum + (ctx.comprehensionLevel || 0.5), 0) / recentContext.length
        : 0.5;

    // Check hint effectiveness
    const recentHints = previousHints.slice(-2);
    const effectiveHints = recentHints.filter(h => h.effectiveness === 'helpful').length;
    const confusingHints = recentHints.filter(h => h.effectiveness === 'confusing').length;

    // Confident students can handle minimal scaffolding even at moderate level
    if (emotionalState === 'CONFIDENT' && avgComprehension > 0.5) {
        return 'minimal';
    }

    // Uncertain students get a notch more support
    if (emotionalState === 'UNCERTAIN' && studentLevel !== 'advanced') {
        return 'heavy';
    }

    // Decision logic
    if (studentLevel === 'advanced' && avgComprehension > 0.7 && effectiveHints > confusingHints) {
        return 'minimal'; // Advanced students need less scaffolding
    } else if (studentLevel === 'beginner' || avgComprehension < 0.3 || confusingHints > 0) {
        return 'heavy'; // Beginners or struggling students need more support
    } else {
        return 'moderate'; // Everyone else
    }
}

/**
 * Generates adaptive hint based on scaffolding level
 * Uses LLM with context-aware instructions
 * @param {Object} params
 * @returns {String} - The adaptive hint
 */
async function generateAdaptiveHint({
    userQuery,
    correctAnswer,
    conversationHistory,
    tutorSession,
    llmConfig,
    emotionalState = null
}) {
    const llmService = llmConfig.provider === 'ollama' ? ollamaService : geminiService;

    const scaffoldLevel = determineScaffoldingLevel(tutorSession, emotionalState);
    const knowledgeGaps = tutorSession.knowledgeGaps.filter(g => !g.resolved).map(g => g.concept);
    const previousHints = tutorSession.previousHints.map(h => h.hint);

    // Build rich context for LLM
    const hintRequest = buildHintPrompt({
        userQuery,
        correctAnswer,
        scaffoldLevel,
        studentLevel: tutorSession.studentLevel,
        learningGoal: tutorSession.learningGoal,
        knowledgeGaps,
        previousHints,
        conversationHistory: conversationHistory.slice(-5),
        progressTracking: tutorSession.progressTracking
    });

    try {
        const hint = await llmService.generateContentWithHistory(
            [],
            hintRequest,
            getTutorSystemPrompt(scaffoldLevel),
            llmConfig
        );

        return hint.trim();
    } catch (error) {
        console.error('[AdaptiveScaffold] Error generating hint:', error);
        return "Let's break this down. What part of this concept are you most unsure about?";
    }
}

/**
 * Builds the hint generation prompt with rich context
 */
function buildHintPrompt({
    userQuery,
    correctAnswer,
    scaffoldLevel,
    studentLevel,
    learningGoal,
    knowledgeGaps,
    previousHints,
    conversationHistory,
    progressTracking
}) {
    return `
**Learning Context:**
- **Goal**: ${learningGoal}
- **Student Level**: ${studentLevel}
- **Scaffolding Required**: ${scaffoldLevel}

**Student's Current Question:**
${userQuery}

**Correct Understanding (DO NOT REVEAL DIRECTLY):**
${correctAnswer}

**Identified Knowledge Gaps:**
${knowledgeGaps.length > 0 ? knowledgeGaps.join(', ') : 'None identified yet'}

**Previous Hints Already Given:**
${previousHints.length > 0 ? previousHints.map((h, i) => `${i + 1}. ${h}`).join('\n') : 'None yet (this is the first interaction)'}

**Recent Conversation:**
${conversationHistory.map(msg => `${msg.role}: ${msg.content}`).join('\n')}

**Student's Progress:**
- Concepts Understood: ${progressTracking.conceptsUnderstood.join(', ') || 'None yet'}
- Struggling With: ${progressTracking.conceptsStruggling.join(', ') || 'None yet'}

**Your Task:**
Generate the NEXT hint that will guide the student toward the answer.

**Scaffolding Instructions for "${scaffoldLevel}" level:**
${getScaffoldingInstructions(scaffoldLevel)}

**IMPORTANT:**
- Do NOT give the answer directly
- Build on previous hints (don't repeat them)
- Use Socratic questions to guide thinking
- Provide examples or analogies if student is stuck (especially for ${scaffoldLevel} scaffolding)
- Adapt your language to the ${studentLevel} student level
`;
}

/**
 * Returns scaffolding instructions based on level
 */
function getScaffoldingInstructions(level) {
    const instructions = {
        minimal: `
- Ask thought-provoking questions only
- Give minimal guidance
- Let student struggle productively
- Only intervene if completely stuck`,

        moderate: `
- Provide guiding questions with small hints
- Give one concrete example if needed
- Break down the problem into smaller steps
- Offer partial explanations`,

        heavy: `
- Provide detailed step-by-step guidance
- Use multiple concrete examples and analogies
- Explain prerequisite concepts if needed
- Give more direct hints while still encouraging thinking
- Be patient and encouraging`
    };

    return instructions[level] || instructions.moderate;
}

/**
 * Returns system prompt tailored to scaffolding level
 */
function getTutorSystemPrompt(scaffoldLevel) {
    const basePrompt = `You are an expert AI tutor using adaptive scaffolding. Your goal is to guide students to discover answers themselves through Socratic questioning and appropriate support.`;

    const levelPrompts = {
        minimal: `${basePrompt} This student is ${scaffoldLevel === 'minimal' ? 'advanced and' : ''} showing good understanding. Use minimal scaffolding - challenge them with thought-provoking questions.`,
        moderate: `${basePrompt} Provide balanced support with guiding questions and occasional hints.`,
        heavy: `${basePrompt} This student needs significant support. Provide detailed scaffolding with examples, analogies, and step-by-step guidance while still encouraging active thinking.`
    };

    return levelPrompts[scaffoldLevel] || levelPrompts.moderate;
}

/**
 * Suggests next teaching action based on student's response
 * @param {String} studentResponse - Student's latest response
 * @param {Object} tutorSession - TutorSession document
 * @returns {String} - 'give_hint', 'ask_verification', 'provide_example', 'celebrate_progress'
 */
function suggestNextAction(studentResponse, tutorSession) {
    const lowerResponse = studentResponse.toLowerCase();

    // Student seems confused
    if (lowerResponse.includes('confused') || lowerResponse.includes("don't understand") || lowerResponse.includes('lost')) {
        return 'provide_example';
    }

    // Student is asking a question
    if (lowerResponse.includes('?') || lowerResponse.includes('what') || lowerResponse.includes('how')) {
        return 'give_hint';
    }

    // Student provided an answer - verify understanding
    if (studentResponse.length > 30 && !lowerResponse.includes('?')) {
        return 'ask_verification';
    }

    // Student shows progress
    if (tutorSession.progressTracking.successfulGuidance > 0) {
        return 'celebrate_progress';
    }

    // Default
    return 'give_hint';
}

module.exports = {
    determineScaffoldingLevel,
    generateAdaptiveHint,
    suggestNextAction
};
