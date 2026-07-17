// server/routes/deepResearch.js
// Express route for the deep research orchestrator.
// Exposes research functionality via REST API.
// Protected by authMiddleware (mounted in server.js).

const express = require('express');
const router = express.Router();
const deepResearchOrchestrator = require('../services/deepResearchOrchestrator');
const factCheckingService = require('../services/factCheckingService');
const ResearchCache = require('../models/ResearchCache');
const ResearchJob = require('../models/ResearchJob');
const { enqueueResearchJob, getJobStatus, listUserJobs } = require('../workers/researchWorker');

/**
 * POST /api/deep-research/start
 * FIRE-AND-FORGET: Create a research job and return immediately.
 * Body: { query, nature, depth }
 * nature: 'general' | 'academic' | 'research'
 * depth:  'low' | 'medium' | 'high'
 */
router.post('/start', async (req, res) => {
    const { query, nature = 'academic', depth = 'medium' } = req.body;
    const userId = req.user?._id || req.user?.userId;

    if (!query || typeof query !== 'string' || query.trim().length < 5) {
        return res.status(400).json({ success: false, message: 'A research query of at least 5 characters is required.' });
    }

    const validNatures = ['general', 'academic', 'research'];
    const validDepths  = ['low', 'medium', 'high'];
    if (!validNatures.includes(nature)) {
        return res.status(400).json({ success: false, message: `nature must be one of: ${validNatures.join(', ')}` });
    }
    if (!validDepths.includes(depth)) {
        return res.status(400).json({ success: false, message: `depth must be one of: ${validDepths.join(', ')}` });
    }

    try {
        const job = await enqueueResearchJob({ query: query.trim(), nature, depth, userId });
        return res.status(202).json({
            success: true,
            message: 'Research job queued. It will run in the background.',
            jobId:   job._id,
            query:   job.query,
            nature:  job.nature,
            depth:   job.depth,
            status:  job.status,
        });
    } catch (err) {
        console.error('[DeepResearch] Failed to enqueue job:', err.message);
        return res.status(500).json({ success: false, message: 'Failed to start research job.', error: err.message });
    }
});

/**
 * GET /api/deep-research/jobs
 * List all research jobs for the authenticated user.
 */
router.get('/jobs', async (req, res) => {
    const userId = req.user?._id || req.user?.userId;
    try {
        const jobs = await listUserJobs(userId, 100);
        return res.status(200).json({ success: true, data: jobs });
    } catch (err) {
        return res.status(500).json({ success: false, message: 'Failed to list research jobs.', error: err.message });
    }
});

/**
 * GET /api/deep-research/jobs/:jobId
 * Get status and (if completed) result reference for a specific job.
 */
router.get('/jobs/:jobId', async (req, res) => {
    const userId = req.user?._id || req.user?.userId;
    try {
        const jobStatus = await getJobStatus(req.params.jobId, userId);
        if (!jobStatus) {
            return res.status(404).json({ success: false, message: 'Job not found.' });
        }
        // If completed, also fetch the report from ResearchCache
        let report = null;
        if (jobStatus.status === 'completed' && jobStatus.resultId) {
            report = await ResearchCache.findById(jobStatus.resultId)
                .select('query title researchReport sources evidenceProfile providerBreakdown overallConfidenceScore createdAt')
                .lean();
        }
        return res.status(200).json({ success: true, data: { ...jobStatus, report } });
    } catch (err) {
        return res.status(500).json({ success: false, message: 'Failed to get job status.', error: err.message });
    }
});

/**
 * GET /api/deep-research/jobs/:jobId/report
 * Fetch the full cached research report for a completed job.
 */
router.get('/jobs/:jobId/report', async (req, res) => {
    const userId = req.user?._id || req.user?.userId;
    try {
        const job = await ResearchJob.findOne({ _id: req.params.jobId, userId }).lean();
        if (!job) return res.status(404).json({ success: false, message: 'Job not found.' });
        if (job.status !== 'completed' || !job.resultId) {
            return res.status(425).json({ success: false, message: `Job is ${job.status}. Report not ready yet.` });
        }
        const report = await ResearchCache.findById(job.resultId).lean();
        if (!report) return res.status(404).json({ success: false, message: 'Report not found in cache.' });
        return res.status(200).json({ success: true, data: report });
    } catch (err) {
        return res.status(500).json({ success: false, message: 'Failed to fetch report.', error: err.message });
    }
});


router.post('/search', async (req, res) => {
    const { query, depthLevel, conversationHistory } = req.body;
    const userId = req.user?._id || req.user?.userId;

    if (!query || typeof query !== 'string' || query.trim().length < 3) {
        return res.status(400).json({
            success: false,
            message: 'A research query of at least 3 characters is required.',
        });
    }

    try {
        console.log(`[DeepResearch Route] Research request from user ${userId}: "${query.substring(0, 80)}..."`);

        const result = await deepResearchOrchestrator.runDeepResearch(query.trim(), {
            userId,
            depthOverride: depthLevel,
            conversationHistory,
        });

        const bundle = result.researchBundle || {};
        const report = result.researchReport || {};
        return res.status(200).json({
            success: true,
            data: {
                synthesizedResult: report.executiveSummary?.analyticalOverview || report.title || 'Research complete.',
                sources: bundle.sources || [],
                sourceBreakdown: {
                    total: bundle.sources?.length || 0,
                    local: bundle.localSourceCount || 0,
                    online: bundle.onlineSourceCount || 0,
                },
                metadata: {
                    query: bundle.query,
                    mode: bundle.mode,
                    confidenceScore: bundle.overallConfidenceScore,
                },
            },
        });
    } catch (error) {
        console.error('[DeepResearch Route] Research failed:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Deep research encountered an error.',
            error: error.message,
        });
    }
});

/**
 * POST /api/deep-research/report
 * Enhanced research with full report generation (Task 1.3.2).
 * Returns: synthesis, citation graph, contradictions, fact-check, markdown report.
 * Body: { query, depthLevel?, reportStyle?, includeFactCheck?, conversationHistory? }
 */
router.post('/report', async (req, res) => {
    const { query, depthLevel, reportStyle, includeFactCheck, conversationHistory } = req.body;
    const userId = req.user?._id || req.user?.userId;

    if (!query || typeof query !== 'string' || query.trim().length < 3) {
        return res.status(400).json({
            success: false,
            message: 'A research query of at least 3 characters is required.',
        });
    }

    try {
        console.log(`[DeepResearch Route] Enhanced report request from user ${userId}: "${query.substring(0, 80)}..."`);

        const result = await deepResearchOrchestrator.runDeepResearch(query.trim(), {
            userId,
            depthOverride: depthLevel || 'deep',
            reportStyle: reportStyle || 'academic',
            includeFactCheck: includeFactCheck !== false,
            conversationHistory,
        });

        const bundle = result.researchBundle || {};
        const report = result.researchReport || {};
        return res.status(200).json({
            success: true,
            data: {
                synthesizedResult: report.executiveSummary?.analyticalOverview || report.title || 'Research complete.',
                report,
                factCheck: bundle.verifiedClaimsData || [],
                sources: bundle.sources || [],
                sourceBreakdown: {
                    total: bundle.sources?.length || 0,
                    local: bundle.localSourceCount || 0,
                    online: bundle.onlineSourceCount || 0,
                },
                metadata: {
                    query: bundle.query,
                    mode: bundle.mode,
                    confidenceScore: bundle.overallConfidenceScore,
                    depthLevel: options?.depthOverride || 'deep',
                },
            },
        });
    } catch (error) {
        console.error('[DeepResearch Route] Enhanced report failed:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Enhanced research report encountered an error.',
            error: error.message,
        });
    }
});

/**
 * POST /api/deep-research/fact-check
 * Standalone fact-check endpoint for any text against sources.
 * Body: { text, sources?, query? }
 */
router.post('/fact-check', async (req, res) => {
    const { text, sources, query } = req.body;

    if (!text || typeof text !== 'string' || text.trim().length < 10) {
        return res.status(400).json({
            success: false,
            message: 'Text of at least 10 characters is required for fact-checking.',
        });
    }

    try {
        const start = Date.now();
        const sourcesInput = (sources && sources.length > 0)
            ? sources
            : [{ id: 1, citationIndex: 1, abstract: text.trim(), evidenceCategory: 'user-provided', sourceType: 'text' }];
        const userId = req.user?._id || req.user?.userId;
        const claims = await factCheckingService.verifyCorpusClaims(sourcesInput, query || 'General fact check', userId);
        const verifiedCount = claims.filter(c => c.strength_of_evidence === 'Strong').length;
        const flaggedCount = claims.filter(c => c.uncertainty_level === 'High').length;

        return res.status(200).json({
            success: true,
            data: {
                overallReliability: verifiedCount > flaggedCount ? 'High' : 'Moderate',
                summary: `Verified ${claims.length} claims from provided text.`,
                totalClaims: claims.length,
                verifiedCount,
                flaggedCount,
                claims,
                flaggedClaims: claims.filter(c => c.uncertainty_level === 'High'),
                checkDurationMs: Date.now() - start,
            },
        });
    } catch (error) {
        console.error('[DeepResearch Route] Fact-check failed:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Fact-checking encountered an error.',
            error: error.message,
        });
    }
});

/**
 * GET /api/deep-research/history
 * Get user's research history — returns both job records and older cache entries.
 */
router.get('/history', async (req, res) => {
    const userId = req.user?._id || req.user?.userId;
    try {
        // Primary: ResearchJob records (includes status, nature, depth)
        const jobs = await listUserJobs(userId, 100);

        // Legacy: ResearchCache entries not associated with a job
        const legacy = await ResearchCache.find({ userId })
            .select('query title overallConfidenceScore sources createdAt evidenceProfile')
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();

        return res.status(200).json({
            success: true,
            data: {
                jobs,
                legacy: legacy.map(h => ({
                    _id:          h._id,
                    query:        h.query,
                    title:        h.title || h.query,
                    confidenceScore: h.overallConfidenceScore,
                    totalSources: h.sources?.length || 0,
                    createdAt:    h.createdAt,
                })),
            },
        });
    } catch (error) {
        console.error('[DeepResearch Route] History fetch failed:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch research history.' });
    }
});


/**
 * GET /api/deep-research/cache/:queryHash
 * Retrieve a specific cached research result.
 */
router.get('/cache/:queryHash', async (req, res) => {
    const userId = req.user?._id || req.user?.userId;
    const { queryHash } = req.params;

    try {
        const cached = await ResearchCache.findOne({ queryHash, userId }).lean();
        if (!cached) {
            return res.status(404).json({ success: false, message: 'Research result not found in cache.' });
        }

        return res.status(200).json({
            success: true,
            data: {
                query: cached.query,
                synthesizedResult: cached.synthesizedResult,
                sources: cached.sources,
                sourceBreakdown: cached.sourceBreakdown,
                metadata: { ...cached.metadata, fromCache: true },
            },
        });
    } catch (error) {
        console.error('[DeepResearch Route] Cache retrieval failed:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to retrieve cached result.' });
    }
});

module.exports = router;
