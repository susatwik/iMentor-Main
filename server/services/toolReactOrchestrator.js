const log = require('../utils/logger');
const { getAgentState, updateAgentState } = require('./agentStateService');
/**
 * ReAct Agent Orchestrator (Multi-Step Tool Use)
 * 
 * Implements a generic Reasoning + Acting loop where the agent:
 * 1. Reasons about the current state.
 * 2. Selects a tool to execute (Action).
 * 3. Observes the tool's output.
 * 4. Repeats until the task is complete (Final Answer).
 */

const { availableTools } = require('./toolRegistry');
const { createReActSystemPrompt } = require('./reactToolSelector');
const { CHAT_MAIN_SYSTEM_PROMPT, createSynthesizerPrompt } = require('../config/promptTemplates');
const geminiService = require('./geminiService');
const ollamaService = require('./ollamaService');
const llmStreamingService = require('./llmStreamingService');

/**
 * Process a query using the ReAct (Reasoning + Acting) loop.
 * 
 * @param {string} userQuery - The user's original query.
 * @param {Array} chatHistory - Previous messages.
 * @param {Object} requestContext - Context including APIs, models, etc.
 * @param {Function} streamCallback - Optional callback for streaming updates.
 * @returns {Object} Result with finalAnswer, thinking trace, references.
 */
async function processQueryWithReAct(userQuery, chatHistory, requestContext, streamCallback = null) {
    const { llmProvider, apiKey, ollamaUrl, sessionId } = requestContext;
    const llmService = llmProvider === 'ollama' ? ollamaService : geminiService;

    // LLM Config
    const llmOptions = {
        ...(llmProvider === 'ollama' && {
            model: requestContext.ollamaModel || process.env.OLLAMA_DEFAULT_MODEL || 'qwen3.5:9b',
            think: true,
        }),
        ...(llmProvider === 'gemini' && { geminiModel: requestContext.geminiModel || process.env.GEMINI_MODEL || 'gemini-2.0-flash' }),
        apiKey: apiKey,
        ollamaUrl: ollamaUrl,
        temperature: 0.2
    };

    const maxIterations = 5;
    let iteration = 0;
    let contextTrace = [];
    let allReferences = [];

    // Load previous session state — makes agent stateful across user messages
    if (sessionId) {
        try {
            const prevState = await getAgentState(sessionId);
            if (Array.isArray(prevState.branchHistory) && prevState.branchHistory.length > 0) {
                // Seed contextTrace with the last 3 steps from the previous request for continuity
                contextTrace = prevState.branchHistory.slice(-3);
                log.info('AI', `ReAct: Restored ${contextTrace.length} prior steps for session ${sessionId}`);
            }
            if (Array.isArray(prevState.priorInsights) && prevState.priorInsights.length > 0) {
                allReferences = [...prevState.priorInsights];
            }
        } catch (stateErr) {
            log.warn('AI', `ReAct: Could not load prior state: ${stateErr.message}`);
        }
    }
    let finalAnswerText = null;
    let finalThinking = "";

    log.info('AI', `Starting ReAct loop for: "${userQuery.substring(0, 50)}..."`);

    if (streamCallback) {
        streamCallback({
            type: 'step_update',
            content: {
                stepId: 'react_start',
                title: 'Initiating ReAct Agent',
                status: 'processing',
                timestamp: Date.now()
            }
        });
    }

    while (iteration < maxIterations) {
        iteration++;
        // log.info('AI', `ReAct Iteration ${iteration}`);

        if (streamCallback) {
            streamCallback({
                type: 'step_update',
                content: {
                    stepId: `react_step_${iteration}`,
                    title: `Step ${iteration}: Reasoning`,
                    status: 'processing',
                    timestamp: Date.now()
                }
            });
        }

        // 1. Construct Prompt
        let fullContextString = "";
        if (contextTrace.length > 0) {
            fullContextString = contextTrace.map(step =>
                `Step ${step.stepNumber}:\n` +
                `Thought: ${step.thought}\n` +
                `Action: ${step.action} (${JSON.stringify(step.params)})\n` +
                `Observation: ${step.observation}\n`
            ).join('\n---\n');
        }

        const systemPrompt = createReActSystemPrompt(userQuery, fullContextString);
        const userPrompt = contextTrace.length === 0
            ? `Original Query: "${userQuery}"\nBegin your reasoning.`
            : `Here is the history of your actions so far:\n\n${fullContextString}\n\nBased on these observations, determine the next step or provided the final answer.`;

        try {
            // 2. Call LLM
            // log.info('AI', "Prompting ReAct Agent...");
            const llmResponse = await llmService.generateContentWithHistory(
                [],
                userPrompt,
                systemPrompt,
                llmOptions
            );

            // 3. Parse Response
            let parsedAction = null;
            try {
                const jsonMatch = llmResponse.match(/```json\s*([\s\S]+?)\s*```/);
                const jsonString = jsonMatch ? jsonMatch[1] : llmResponse;
                parsedAction = JSON.parse(jsonString);
            } catch (jsonError) {
                log.warn('AI', "ReAct JSON parse failed, treating as final answer.");
                finalAnswerText = llmResponse;
                parsedAction = { final_answer: llmResponse }; // Fallback
            }

            // 4. Execute Action or Return Final Answer

            // Branch A: Final Answer
            if (parsedAction.final_answer) {
                log.success('AI', "ReAct reached final answer.");
                finalThinking = parsedAction.thought || "Reached conclusion.";

                if (streamCallback) {
                    streamCallback({
                        type: 'step_update',
                        content: {
                            stepId: `react_step_${iteration}`,
                            title: `Step ${iteration}: Final Conclusion`,
                            status: 'completed',
                            content: finalThinking,
                            timestamp: Date.now()
                        }
                    });
                }

                // If streaming is enabled, we synthesize the final answer to stream it
                if (streamCallback && llmProvider === 'gemini') {
                    const synthesizerUserQuery = createSynthesizerPrompt(
                        userQuery,
                        `Reasoning history:\n${fullContextString}\n\nFinal Conclusion: ${parsedAction.final_answer}`,
                        'react_synthesis'
                    );

                    finalAnswerText = await llmStreamingService.streamCompletion({
                        messages: [{ role: 'user', content: synthesizerUserQuery }],
                        provider: llmProvider,
                        model: llmOptions.geminiModel || llmOptions.model,
                        apiKey: apiKey,
                        systemPrompt: CHAT_MAIN_SYSTEM_PROMPT(),
                        onToken: (token) => {
                            streamCallback({ type: 'token', content: token });
                        },
                        options: llmOptions
                    });
                } else {
                    finalAnswerText = parsedAction.final_answer;
                }

                break; // Exit loop
            }

            // Branch B: Tool Execution
            if (parsedAction.tool_call) {
                const toolName = parsedAction.tool_call.tool_name;
                const toolParams = parsedAction.tool_call.parameters;
                const thought = parsedAction.thought || "Running tool...";

                log.info('AI', `Selected Tool: ${toolName}`);

                if (streamCallback) {
                    // Update the "Reasoning" step to show the thought
                    streamCallback({
                        type: 'step_update',
                        content: {
                            stepId: `react_step_${iteration}`,
                            title: `Step ${iteration}: ${thought.substring(0, 50)}...`,
                            status: 'processing',
                            content: thought,
                            timestamp: Date.now()
                        }
                    });
                }

                const tool = availableTools[toolName];
                let observation = "";

                if (!tool) {
                    observation = `Error: Tool '${toolName}' not found. Please select a valid tool from the list.`;
                } else {
                    try {
                        // Notify UI of tool execution
                        if (streamCallback) {
                            streamCallback({ type: 'status_update', content: `Executing ${toolName}...` });
                        }

                        const toolResult = await tool.execute(toolParams, requestContext);
                        observation = toolResult.toolOutput || "Tool executed successfully but returned no text.";

                        // Collect references
                        if (toolResult.references && Array.isArray(toolResult.references)) {
                            allReferences.push(...toolResult.references);
                        }
                    } catch (toolError) {
                        observation = `Error executing tool '${toolName}': ${toolError.message}`;
                    }
                }

                // Append to Context Trace
                contextTrace.push({
                    stepNumber: iteration,
                    thought: thought,
                    action: toolName,
                    params: toolParams,
                    observation: observation
                });

                // Mark step as completed in UI
                if (streamCallback) {
                    streamCallback({
                        type: 'step_update',
                        content: {
                            stepId: `react_step_${iteration}`,
                            title: `Step ${iteration}: Executed ${toolName}`,
                            status: 'completed',
                            content: `**Thought:** ${thought}\n**Action:** ${toolName}\n**Observation:** ${observation.substring(0, 150)}...`,
                            timestamp: Date.now()
                        }
                    });
                }

            } else if (!finalAnswerText) {
                log.warn('AI', "ReAct response missing tool_call or final_answer.");
                break;
            }

        } catch (error) {
            log.error('AI', `ReAct Loop Error (Iter ${iteration}): ${error.message}`);
            if (streamCallback) {
                streamCallback({
                    type: 'step_update',
                    content: {
                        stepId: `react_step_${iteration}`,
                        title: `Step ${iteration}: Error`,
                        status: 'failed',
                        content: error.message,
                        timestamp: Date.now()
                    }
                });
            }
            break;
        }
    }

    if (!finalAnswerText) {
        finalAnswerText = "I was unable to complete the multi-step reasoning process within the limit. However, here is what I found so far:\n\n" +
            contextTrace.map(s => `- Tried ${s.action}: ${s.observation.substring(0, 100)}...`).join('\n');
    }

    // Deduplicate references
    const uniqueRefs = [];
    const refMap = new Map();
    allReferences.forEach(ref => {
        const key = ref.url || ref.source;
        if (!refMap.has(key)) {
            refMap.set(key, true);
            uniqueRefs.push(ref);
        }
    });

    // Formatting thinking trace
    const fullThinkingTrace = contextTrace.map(step =>
        `**Step ${step.stepNumber}:**\n*Thought:* ${step.thought}\n*Action:* ${step.action}\n*Observation:* ${step.observation.length > 200 ? step.observation.substring(0, 200) + '...' : step.observation}`
    ).join('\n\n') + `\n\n**Final Thought:** ${finalThinking}`;

    // Persist agent state for cross-request continuity
    if (sessionId) {
        try {
            await updateAgentState(sessionId, {
                branchHistory: contextTrace.slice(-5),     // keep last 5 steps
                priorInsights: uniqueRefs.slice(0, 15),    // keep up to 15 refs
                lastReasoningModel: llmProvider
            });
        } catch (saveErr) {
            log.warn('AI', `ReAct: Could not persist state: ${saveErr.message}`);
        }
    }

    return {
        finalAnswer: finalAnswerText,
        thinking: fullThinkingTrace,
        references: uniqueRefs,
        sourcePipeline: `react-${llmProvider}-multistep`
    };
}

module.exports = {
    processQueryWithReAct
};
