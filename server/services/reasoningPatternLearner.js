/**
 * Reasoning Pattern Learner
 * Analyzes previous reasoning traces to optimize future prompts and behaviors.
 */

const ChatHistory = require('../models/ChatHistory');
const geminiService = require('./geminiService');

async function learnFromPatterns(userId) {
    console.log(`[PatternLearner] Analyzing reasoning history for user: ${userId}`);

    try {
        const history = await ChatHistory.find({ userId }).sort({ updatedAt: -1 }).limit(10);
        const thoughts = history.flatMap(h => h.messages.filter(m => m.thinking).map(m => m.thinking));

        if (thoughts.length < 5) return "Insufficient history for pattern learning.";

        const analysisPrompt = `
        Analyze the following reasoning traces from an AI assistant.
        Identify common biases, successful strategies, or areas where the reasoning was redundant.
        
        Traces:
        ${thoughts.join('\n\n---\n\n').substring(0, 4000)}
        
        **Task:**
        Provide a "Reasoning Optimization Instruction" (ROI) that can be added to the system prompt to improve future accuracy.
        `;

        const roi = await geminiService.generateContentWithHistory(
            [], analysisPrompt, "You are a meta-cognitive analyst.", { maxOutputTokens: 200 }
        );

        console.log(`[PatternLearner] Derived ROI: ${roi}`);
        return roi;
    } catch (error) {
        console.error('[PatternLearner] Failed:', error);
        return null;
    }
}

module.exports = { learnFromPatterns };
