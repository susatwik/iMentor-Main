/**
 * Knowledge Gap Analyzer
 * Analyzes student responses to identify misconceptions and knowledge gaps
 * Uses LLM to understand where the student is struggling
 */

const geminiService = require('./geminiService');
const ollamaService = require('./ollamaService');

/**
 * Analyzes student's response to identify knowledge gaps
 * @param {String} studentResponse - The student's answer or question
 * @param {String} correctAnswer - The ground truth or expected understanding
 * @param {Array} conversationHistory - Recent conversation context
 * @param {Object} llmConfig - LLM configuration (provider, model, etc.)
 * @returns {Object} - { gaps: [String], comprehensionLevel: Number, misconceptions: [String] }
 */
async function analyzeKnowledgeGaps(studentResponse, correctAnswer, conversationHistory = [], llmConfig = {}) {
    const llmService = llmConfig.provider === 'ollama' ? ollamaService : geminiService;

    // Build analysis prompt with rich context
    const analysisPrompt = `
You are an educational assessment expert. Analyze the student's response to identify knowledge gaps.

**Correct Understanding:**
${correctAnswer}

**Student's Response:**
${studentResponse}

**Recent Conversation:**
${conversationHistory.slice(-3).map(msg => `${msg.role}: ${msg.content}`).join('\n')}

**Task:**
1. Identify specific concepts the student doesn't understand
2. Detect any misconceptions in their thinking
3. Rate their comprehension level (0.0 to 1.0)

**Output Format (JSON):**
{
  "gaps": ["concept 1 they're missing", "concept 2 they're missing"],
  "comprehensionLevel": 0.0-1.0,
  "misconceptions": ["misconception 1", "misconception 2"],
  "reasoning": "brief explanation of assessment"
}
`;

    try {
        const response = await llmService.generateContentWithHistory(
            [],
            analysisPrompt,
            "You are an expert educational assessor. Respond only with valid JSON.",
            llmConfig
        );

        // Parse JSON response
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const analysis = JSON.parse(jsonMatch[0]);
            return {
                gaps: analysis.gaps || [],
                comprehensionLevel: analysis.comprehensionLevel || 0.5,
                misconceptions: analysis.misconceptions || [],
                reasoning: analysis.reasoning || ''
            };
        }

        // Fallback if JSON parsing fails
        console.warn('[KnowledgeGapAnalyzer] Failed to parse LLM response as JSON');
        return {
            gaps: [],
            comprehensionLevel: 0.5,
            misconceptions: [],
            reasoning: 'Failed to analyze response'
        };

    } catch (error) {
        console.error('[KnowledgeGapAnalyzer] Error:', error);
        return {
            gaps: [],
            comprehensionLevel: 0.5,
            misconceptions: [],
            reasoning: 'Error during analysis'
        };
    }
}

/**
 * Extracts the core learning goal from a student's query
 * @param {String} query - The student's question
 * @param {Object} llmConfig - LLM configuration
 * @returns {String} - The extracted learning goal
 */
async function extractLearningGoal(query, llmConfig = {}) {
    const llmService = llmConfig.provider === 'ollama' ? ollamaService : geminiService;

    const goalPrompt = `
Extract the core learning goal from this student's question. Be concise and specific.

**Student Question:**
${query}

**Task:**
What is the student trying to learn or understand? Answer in one clear sentence.
`;

    try {
        const goal = await llmService.generateContentWithHistory(
            [],
            goalPrompt,
            "Extract learning goals concisely.",
            llmConfig
        );

        return goal.trim();
    } catch (error) {
        console.error('[KnowledgeGapAnalyzer] Error extracting goal:', error);
        return query; // Fallback to original query
    }
}

/**
 * Assesses the effectiveness of a hint based on student's follow-up response
 * @param {String} hint - The hint that was given
 * @param {String} studentFollowUp - Student's response after the hint
 * @param {Object} llmConfig - LLM configuration
 * @returns {String} - 'helpful', 'neutral', 'confusing'
 */
async function assessHintEffectiveness(hint, studentFollowUp, llmConfig = {}) {
    const llmService = llmConfig.provider === 'ollama' ? ollamaService : geminiService;

    const assessPrompt = `
Evaluate if this hint was effective in helping the student.

**Hint Given:**
${hint}

**Student's Follow-Up Response:**
${studentFollowUp}

**Task:**
Rate the hint's effectiveness. Reply with ONLY ONE WORD:
- "helpful" if student shows progress/understanding
- "neutral" if no clear change
- "confusing" if student seems more confused

Answer:`;

    try {
        const assessment = await llmService.generateContentWithHistory(
            [],
            assessPrompt,
            "Assess pedagogical effectiveness.",
            { ...llmConfig, maxOutputTokens: 10 }
        );

        const cleaned = assessment.toLowerCase().trim();
        if (cleaned.includes('helpful')) return 'helpful';
        if (cleaned.includes('confusing')) return 'confusing';
        return 'neutral';

    } catch (error) {
        console.error('[KnowledgeGapAnalyzer] Error assessing hint:', error);
        return 'unknown';
    }
}

module.exports = {
    analyzeKnowledgeGaps,
    extractLearningGoal,
    assessHintEffectiveness
};
