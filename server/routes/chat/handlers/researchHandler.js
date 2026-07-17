// server/routes/chat/handlers/researchHandler.js
// Handles deep research mode requests.
const deepResearchOrchestrator = require('../../../services/deepResearchOrchestrator');
const log = require('../../../utils/logger');
const { streamEvent } = require('../helpers');

/**
 * @param {object} req  - Express request
 * @param {object} res  - Express response
 * @param {object} ctx  - Request context built by index.js
 */
async function handle(req, res, ctx) {
    const { query, userId, performanceTracker, capturePerformance } = ctx;

    log.info('RESEARCH', `Deep Research requested: "${query}"`);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    try {
        const deepResearchStart = Date.now();
        const researchResult = await deepResearchOrchestrator.runDeepResearch(
            query,
            {
                forceRefresh: req.body.forceRefresh === true,
                userId: userId,
                researchConfig: req.body.researchConfig || null
            },
            (progressStep) => {
                streamEvent(res, { type: 'deep_research_update', content: progressStep });
            }
        );
        performanceTracker.addLlm(Date.now() - deepResearchStart);
        if (researchResult?.performanceDiagnostics) {
            performanceTracker.merge(researchResult.performanceDiagnostics);
        }
        capturePerformance({
            intent: 'research',
            reasoningDepth: 1,
            llmCallCount: 1,
            tokenUsageEstimate: Math.ceil(String(researchResult?.researchReport?.fullReport || '').length / 4),
            branchCount: 1,
            toolCalls: 0,
        });

        streamEvent(res, { type: 'research_complete', content: researchResult });
        return res.end();
    } catch (err) {
        log.error('RESEARCH', 'Deep Research Error:', err);
        capturePerformance({ intent: 'research', reasoningDepth: 1, llmCallCount: 1, branchCount: 1, toolCalls: 0 });
        streamEvent(res, { type: 'error', content: err.message });
        return res.end();
    }
}

module.exports = { handle };
