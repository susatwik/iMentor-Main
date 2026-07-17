// server/services/cotService.js
const geminiService = require('./geminiService');
const ollamaService = require('./ollamaService');
const { logger } = require('../utils/logger');

/**
 * Reasoning tier classification.
 * Determines whether to use native thinking, prompt-based CoT, or skip CoT entirely.
 */
const REASONING_TIERS = {
    CONVERSATIONAL: 'conversational',   // "hi", "thanks" → skip CoT entirely
    ANALYTICAL: 'analytical',           // factual Q&A → lightweight prompt CoT
    RESEARCH: 'research',               // multi-step, deep analysis → native thinking or full CoT
    SOCRATIC: 'socratic',              // pedagogical → native thinking preferred
};

/**
 * Classify query into a reasoning tier based on complexity signals.
 */
function classifyReasoningTier(stepDescription, context, options = {}) {
    const text = (stepDescription || '').toLowerCase();
    const wordCount = text.split(/\s+/).length;
    
    // Short greetings / acknowledgments → skip CoT
    const conversationalPatterns = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|bye|good|great|nice)\b/;
    if (conversationalPatterns.test(text) || wordCount <= 3) {
        return REASONING_TIERS.CONVERSATIONAL;
    }
    
    // Socratic mode explicitly requested
    if (options.socraticMode || options.tutorMode) {
        return REASONING_TIERS.SOCRATIC;
    }
    
    // Deep research / complex multi-part questions
    if (options.deepResearch || options.useReAct || wordCount > 50 || 
        /compare|analyze|evaluate|explain.*detail|pros.*cons|trade.?off/i.test(text)) {
        return REASONING_TIERS.RESEARCH;
    }
    
    return REASONING_TIERS.ANALYTICAL;
}

/**
 * Detect if the model supports native thinking and return appropriate config.
 * Returns { useNative: boolean, thinkingConfig: object } 
 */
function getNativeThinkingConfig(llmProvider, llmOptions = {}) {
    const modelId = (llmOptions.model || '').toLowerCase();
    
    // Gemini 2.5 Flash/Pro — supports thinkingConfig
    if (llmProvider === 'gemini' && /gemini.*(2\.5|flash-thinking)/.test(modelId)) {
        return {
            useNative: true,
            thinkingConfig: { thinkingBudget: 8192 },
            provider: 'gemini'
        };
    }
    
    // Ollama with Qwen3 / DeepSeek-R1 — supports think: true 
    if (llmProvider === 'ollama' && /qwen3|deepseek.*r1|qwq/.test(modelId)) {
        return {
            useNative: true,
            ollamaThink: true,
            provider: 'ollama'
        };
    }
    
    // Claude 3.5/3.7 Sonnet with extended_thinking
    if (llmProvider === 'claude' && /claude.*(3\.[57]|sonnet)/.test(modelId)) {
        return {
            useNative: true,
            extendedThinking: { budget_tokens: 8192 },
            provider: 'claude'
        };
    }
    
    return { useNative: false };
}

/**
 * Generates a structured reasoning step with confidence scoring and self-correction.
 * Now supports tiered reasoning and native thinking models.
 */
async function generateStructuredStep(stepDescription, context, options = {}) {
    const { llmProvider, llmOptions } = options;
    const llmService = llmProvider === 'ollama' ? ollamaService : geminiService;
    
    // --- Tier Check: skip CoT for trivial queries ---
    const tier = classifyReasoningTier(stepDescription, context, options);
    if (tier === REASONING_TIERS.CONVERSATIONAL) {
        return {
            thought: stepDescription,
            confidence_score: 0.9,
            corrected: false,
            metadata: { provider: llmProvider, tier, skippedCoT: true }
        };
    }
    
    // --- Native Thinking: use model's built-in reasoning if available ---
    const nativeConfig = getNativeThinkingConfig(llmProvider, llmOptions);
    if (nativeConfig.useNative && (tier === REASONING_TIERS.RESEARCH || tier === REASONING_TIERS.SOCRATIC)) {
        try {
            const enhancedOptions = { ...llmOptions };
            
            if (nativeConfig.thinkingConfig) {
                // Gemini 2.5: pass thinkingConfig in generation config
                enhancedOptions.thinkingConfig = nativeConfig.thinkingConfig;
            }
            if (nativeConfig.ollamaThink) {
                // Ollama Qwen3/DeepSeek: enable /think mode
                enhancedOptions.think = true;
            }
            if (nativeConfig.extendedThinking) {
                // Claude: extended thinking budget
                enhancedOptions.extended_thinking = nativeConfig.extendedThinking;
            }
            
            const nativePrompt = `Analyze this step carefully: "${stepDescription}"\n\nContext:\n${context}\n\nProvide your detailed reasoning and conclusion.`;
            const responseText = await llmService.generateContentWithHistory(
                [], nativePrompt,
                "You are an expert reasoning agent. Think step by step.",
                enhancedOptions
            );
            
            return {
                thought: responseText,
                confidence_score: 0.85,
                corrected: false,
                metadata: { provider: llmProvider, tier, nativeThinking: true, model: llmOptions?.model }
            };
        } catch (nativeErr) {
            logger.warn(`[CoT Service] Native thinking failed (${nativeErr.message}), falling back to prompt-based CoT`);
            // Fall through to prompt-based CoT
        }
    }

    const systemPrompt = `You are an expert reasoning agent. 
Your task is to provide a detailed, accurate thought process for the following specific step: "${stepDescription}".

**RULES:**
1. Provide a clear, step-by-step reasoning process.
2. Evaluate your own confidence in this specific thought (0.0 to 1.0).
3. If your confidence is below 0.7, explain why and attempt to "self-correct" or refine the thought within the 'thought' field.
4. RETURN ONLY A JSON OBJECT.

**SCHEMA:**
{
  "thought": "Your detailed reasoning here...",
  "confidence_score": 0.95,
  "corrected": false,
  "correction_reason": ""
}
`;

    const userPrompt = `Context gathered so far:\n${context}\n\nTask: ${stepDescription}`;

    try {
        const responseText = await llmService.generateContentWithHistory(
            [], // No chat history for isolated step reasoning
            userPrompt,
            systemPrompt,
            llmOptions
        );

        // Robust JSON extraction
        let jsonString = '';
        const fencedMatch = responseText.match(/```(json)?\s*(\{[\s\S]*?\})\s*```/);
        if (fencedMatch && fencedMatch[2]) {
            jsonString = fencedMatch[2];
        } else {
            const firstBrace = responseText.indexOf('{');
            const lastBrace = responseText.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace > firstBrace) {
                jsonString = responseText.substring(firstBrace, lastBrace + 1);
            }
        }

        if (!jsonString) {
            throw new Error("Invalid output format from LLM - no JSON found.");
        }

        const stepResult = JSON.parse(jsonString);

        // --- Self-Correction Hook ---
        // If the LLM itself reports low confidence but hasn't "corrected" it, we trigger an external reflection turn.
        if (stepResult.confidence_score < 0.7 && !stepResult.corrected) {
            logger.info(`[CoT Service] Low confidence detected (${stepResult.confidence_score}). Triggering self-correction loop.`);
            return await triggerReflection(stepResult, stepDescription, context, options);
        }

        return {
            ...stepResult,
            metadata: {
                provider: llmProvider,
                timestamp: new Date().toISOString()
            }
        };

    } catch (error) {
        logger.error(`[CoT Service] Error generating structured step: ${error.message}`);
        // Fallback to unstructured format so we don't break the chain
        return {
            thought: `Standard reasoning: Processed "${stepDescription}" based on available context.`,
            confidence_score: 0.5,
            corrected: false,
            metadata: { error: error.message }
        };
    }
}

/**
 * Triggers a second turn to refine a low-confidence thought.
 */
async function triggerReflection(initialResult, stepDescription, context, options) {
    const { llmProvider, llmOptions } = options;
    const llmService = llmProvider === 'ollama' ? ollamaService : geminiService;

    const reflectionPrompt = `You previously generated this thought for the task "${stepDescription}":
"${initialResult.thought}"

You marked your confidence as ${initialResult.confidence_score}. 
Please reflect on this thought. Identify potential errors, ambiguities, or missing information.
Provide a CORRECTED and highly accurate version of the reasoning.

RETURN ONLY THE JSON OBJECT WITH THE CORRECTED FLAG SET TO TRUE.
{
  "thought": "CORRECTED reasoning here...",
  "confidence_score": 0.9, 
  "corrected": true,
  "correction_reason": "Explanation of what was refined..."
}`;

    try {
        const responseText = await llmService.generateContentWithHistory(
            [],
            reflectionPrompt,
            "You are a self-reflecting reasoning agent.",
            llmOptions
        );

        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        const correctedResult = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);

        return {
            ...correctedResult,
            metadata: {
                provider: llmProvider,
                is_reflection: true,
                original_confidence: initialResult.confidence_score
            }
        };
    } catch (error) {
        logger.warn(`[CoT Service] Reflection loop failed: ${error.message}. Returning initial result.`);
        return initialResult;
    }
}

/**
 * Generates a ReAct-style reasoning step (Thought + Action).
 */
async function generateReActStep(stepDescription, context, availableTools = {}, options = {}) {
    const { llmProvider, llmOptions } = options;
    const llmService = llmProvider === 'ollama' ? ollamaService : geminiService;

    const toolDescriptions = Object.entries(availableTools)
        .map(([name, tool]) => `- ${name}: ${tool.description} (Params: ${tool.requiredParams.join(', ')})`)
        .join('\n');

    const systemPrompt = `You are a goal-oriented reasoning agent. 
You follow the ReAct framework: Thought, Action, Action Input, Observation.

**CURRENT TASK:** "${stepDescription}"

**AVAILABLE TOOLS:**
${toolDescriptions}

**RULES:**
1. Analyze the context and the current step.
2. Decide if you need to call a tool or if you can provide a "Final Answer" for this specific step.
3. If you call a tool, suggest ONLY ONE action at a time.
4. If the information you have is sufficient, provide a "Final Answer" for this step.
5. **BE CONCISE**: Your 'thought' should be a single, impactful sentence explaining the logic. This improves streaming speed.
6. RETURN ONLY A JSON OBJECT.

**SCHEMA:**
{
  "thought": "Your reasoning about what to do next...",
  "action": "tool_name_here" | "none",
  "action_input": { "param_name": "value" },
  "final_answer": "Summary of your conclusion IF no tool is needed",
  "confidence_score": 0.0-1.0
}
`;

    const userPrompt = `Context gathered so far (including observations):\n${context}\n\nWhat is your next Thought and Action?`;

    try {
        const responseText = await llmService.generateContentWithHistory(
            [],
            userPrompt,
            systemPrompt,
            llmOptions
        );

        let jsonString = '';
        const fencedMatch = responseText.match(/```(json)?\s*(\{[\s\S]*?\})\s*```/);
        jsonString = (fencedMatch && fencedMatch[2]) ? fencedMatch[2] : responseText.match(/\{[\s\S]*\}/)?.[0];

        if (!jsonString) throw new Error("No JSON found in ReAct step response.");

        const result = JSON.parse(jsonString);
        return {
            ...result,
            metadata: { provider: llmProvider, mode: 'react' }
        };
    } catch (error) {
        logger.error(`[CoT Service] ReAct step generation failed: ${error.message}`);
        return {
            thought: "Attempting to proceed with the best available information.",
            action: "none",
            final_answer: `Error in specialized reasoning: ${error.message}`,
            confidence_score: 0.1
        };
    }
}

module.exports = {
    generateStructuredStep,
    generateReActStep,
    classifyReasoningTier,
    getNativeThinkingConfig,
    REASONING_TIERS
};
