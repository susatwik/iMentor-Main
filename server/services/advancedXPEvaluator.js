// server/services/advancedXPEvaluator.js
const User = require('../models/User');
const { selectLLM } = require('./llmRouterService');
const geminiService = require('./geminiService');
const ollamaService = require('./ollamaService');
const groqService = require('./groqService');
const { analyzeQueryDepth } = require('./bloomScoringService');
const log = require('../utils/logger');
/**
 * Advanced XP Evaluator
 * Evaluates the quality of a student message and classifies its cognitive depth 
 * according to Bloom's Taxonomy.
 */
async function evaluateMessageQuality(userMessage, aiResponse, context = {}) {
    const { userId, topic = 'general' } = context;
    
    // Heuristic fallback level
    let fallbackLevel = 1;
    try {
        const analyzed = analyzeQueryDepth(userMessage);
        fallbackLevel = analyzed.level;
    } catch (err) {
        log.warn('XP_EVAL', `Heuristic bloom depth analysis failed: ${err.message}`);
    }
    try {
        const prompt = `You are evaluating a student's message in an academic chat session to determine its cognitive depth based on Bloom's Taxonomy.
Student Message: "${userMessage}"
AI Response: "${aiResponse}"
Bloom's Taxonomy Levels:
1. Remember: Retrieving, recalling, or recognizing knowledge from memory. (e.g., "What is...", "Define...", simple facts)
2. Understand: Constructing meaning from messages, explaining ideas or concepts. (e.g., "Explain why...", "Summarize...")
3. Apply: Using information in new situations or solving problems. (e.g., "How do I calculate...", "Use this to solve...")
4. Analyze: Drawing connections among ideas, breaking down concepts. (e.g., "Compare X and Y...", "What is the relationship...")
5. Evaluate: Justifying a stand or decision, critiquing. (e.g., "Assess the trade-offs...", "What are the pros and cons...")
6. Create: Producing new or original work, designing. (e.g., "Design a code structure to...", "Propose a plan for...")
Evaluate the student's message. Determine its Bloom's Taxonomy cognitive level (1 to 6).
Also check if the query shows genuine academic effort (versus spam, gibberish, or trivial greetings). If the query is low-quality, spam, or a simple greeting/thank you, classify it as level 1.
Return ONLY a JSON object in this exact format:
{
  "bloomsTaxonomyLevel": <integer between 1 and 6>,
  "reasoning": "brief explanation (max 50 words)"
}`;
        // Select the best model using the LLM router
        let chosenModel;
        try {
            const routingResult = await selectLLM(prompt, { userId, subject: topic });
            chosenModel = routingResult.chosenModel;
        } catch (routerError) {
            log.warn('XP_EVAL', `LLM Router selection failed, using default Gemini: ${routerError.message}`);
            chosenModel = { provider: 'gemini', modelId: 'gemini-2.0-flash' };
        }
        let evaluationText;
        let generationSuccess = false;
        // 1. SGLang/Ollama
        if (chosenModel.provider === 'sglang') {
            try {
                const sglangService = require('./sglangService');
                evaluationText = await sglangService.generateContentWithHistory([], prompt, null, {
                    model: chosenModel.modelId || 'Qwen/Qwen2.5-7B-Instruct-AWQ',
                    temperature: 0.2
                });
                generationSuccess = true;
            } catch (sglangError) {
                log.warn('XP_EVAL', `SGLang evaluation failed: ${sglangError.message}`);
            }
        }
        // 2. Groq
        else if (chosenModel.provider === 'groq' || chosenModel.provider === 'ollama') {
            try {
                const apiKey = process.env.GROQ_API_KEY;
                if (apiKey) {
                    evaluationText = await groqService.generateContentWithHistory([], prompt, null, {
                        model: chosenModel.modelId && chosenModel.modelId !== 'qwen2.5:3b' ? chosenModel.modelId : 'llama-3.1-8b-instant',
                        apiKey: apiKey,
                        temperature: 0.2
                    });
                    generationSuccess = true;
                }
            } catch (groqError) {
                log.warn('XP_EVAL', `Groq evaluation failed: ${groqError.message}`);
            }
        }
        // 3. Fallback: Gemini
        if (!generationSuccess) {
            try {
                const apiKey = process.env.GEMINI_API_KEY;
                if (!apiKey) {
                    throw new Error('GEMINI_API_KEY not configured');
                }
                evaluationText = await geminiService.generateContentWithHistory(
                    [],
                    prompt,
                    null,
                    { temperature: 0.2, apiKey, maxOutputTokens: 200 }
                );
                generationSuccess = true;
            } catch (geminiError) {
                log.error('XP_EVAL', `Gemini evaluation fallback failed: ${geminiError.message}`);
            }
        }
        if (generationSuccess && evaluationText) {
            const jsonMatch = evaluationText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                const level = parseInt(parsed.bloomsTaxonomyLevel, 10);
                if (Number.isInteger(level) && level >= 1 && level <= 6) {
                    return {
                        bloomsTaxonomyLevel: level,
                        reasoning: parsed.reasoning || 'Evaluated successfully via LLM'
                    };
                }
            }
        }
    } catch (err) {
        log.error('XP_EVAL', `Advanced XP evaluation encountered error: ${err.message}`);
    }
    log.info('XP_EVAL', `Falling back to heuristic evaluation (Level: ${fallbackLevel})`);
    return {
        bloomsTaxonomyLevel: fallbackLevel,
        reasoning: 'Heuristic keyword analysis fallback'
    };
}
module.exports = {
    evaluateMessageQuality
};
