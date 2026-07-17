const { processQueryWithToT_Streaming } = require('./totOrchestrator');
const { processQueryWithReAct } = require('./toolReactOrchestrator');
const { processAgenticRequest } = require('./agentService');

/**
 * Unified adapter for reasoning mode execution.
 * Additive helper; does not alter existing routes/contracts.
 */
async function executeReasoningMode({ mode, query, chatHistory = [], requestContext = {}, streamCallback = null }) {
    if (mode === 'tot') {
        return processQueryWithToT_Streaming(query, chatHistory, requestContext, streamCallback);
    }
    if (mode === 'react') {
        return processQueryWithReAct(query, chatHistory, requestContext, streamCallback);
    }
    // "cot" falls back to existing agentic path to preserve compatibility
    return processAgenticRequest(query, chatHistory, requestContext.systemPrompt, requestContext, streamCallback);
}

module.exports = {
    executeReasoningMode
};
