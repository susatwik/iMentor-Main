const log = require('../utils/logger');
const ResearchJob = require('../models/ResearchJob');
const deepResearchOrchestrator = require('../services/deepResearchOrchestrator');

/**
 * Research Worker
 *
 * Provides fire-and-forget deep research execution.
 *
 * Architecture:
 *  - NO external queue (Bull/BullMQ) required — uses Node.js setImmediate to
 *    yield to the event loop so the HTTP response is sent before the work begins.
 *  - Job state is persisted in MongoDB (ResearchJob model).
 *  - Frontend polls GET /api/deep-research/jobs/:jobId for status.
 *
 * Usage:
 *   const { enqueueResearchJob } = require('../workers/researchWorker');
 *   const job = await enqueueResearchJob({ query, nature, depth, userId });
 *   // Return { jobId: job._id } to the client immediately.
 */

/**
 * Create a ResearchJob document and schedule its execution asynchronously.
 *
 * @param {object} params
 * @param {string} params.query
 * @param {string} params.nature   – 'general' | 'academic' | 'research'
 * @param {string} params.depth    – 'low' | 'medium' | 'high'
 * @param {string} params.userId
 * @returns {Promise<ResearchJob>}  The created (queued) job document
 */
async function enqueueResearchJob({ query, nature = 'academic', depth = 'medium', userId }) {
    // Create the job document synchronously — returned to caller
    const job = await ResearchJob.create({
        userId,
        query:  query.trim(),
        nature,
        depth,
        status: 'queued',
        currentPhase: 'queued',
    });

    log.info('WORKER', `Research job enqueued: ${job._id} [${nature}/${depth}] "${query.slice(0, 60)}"`);

    // Yield control so the HTTP response can be sent before work starts
    setImmediate(() => _executeJob(job).catch(err => {
        log.error('WORKER', `Uncaught error in research job ${job._id}: ${err.message}`);
    }));

    return job;
}

/**
 * Internal: run the full research pipeline for a job.
 * This is always called inside setImmediate / asynchronously.
 */
async function _executeJob(job) {
    // Re-fetch to get a fresh Mongoose document with all methods
    const liveJob = await ResearchJob.findById(job._id);
    if (!liveJob) { log.warn('WORKER', `Job ${job._id} not found in DB`); return; }

    try {
        await liveJob.markRunning();
        log.info('WORKER', `Research job started: ${liveJob._id}`);

        // Run the pipeline; pass the live job doc for progress persistence
        const result = await deepResearchOrchestrator.runDeepResearch(
            liveJob.query,
            {
                userId:  liveJob.userId,
                nature:  liveJob.nature,
                depth:   liveJob.depth,
                jobDoc:  liveJob,
            },
            // onProgress callback — also persisted via jobDoc.addProgress inside orchestrator
            null
        );

        // Extract summary metrics for list views
        const bundle = result.researchBundle || {};
        const report = result.researchReport || {};
        const pb     = bundle.providerBreakdown || {};

        const meta = {
            totalSources:      bundle.sources?.length          || 0,
            academicSources:   bundle.onlineSourceCount        || 0,
            webSources:        (bundle.sources || []).filter(s => s.sourceType !== 'academic').length,
            confidenceScore:   bundle.overallConfidenceScore   || 0,
            reportTitle:       report.title                    || liveJob.query,
            openAlexCount:     pb.openAlex                     || 0,
            semanticCount:     pb.semanticScholar              || 0,
            arxivCount:        pb.arxiv                        || 0,
            webCount:          pb.web                          || 0,
            goldStandardCount: pb.goldStandard                 || 0,
            // Estimate pages: ~500 words/page; count section content words
            pageEstimate: estimatePages(report),
        };

        await liveJob.markCompleted(result.savedDocId || null, meta);
        log.success('WORKER', `Research job completed: ${liveJob._id} (${meta.totalSources} sources, ~${meta.pageEstimate} pages)`);

    } catch (err) {
        log.error('WORKER', `Research job failed: ${liveJob._id} — ${err.message}`);
        await liveJob.markFailed(err.message).catch(() => {});
    }
}

/**
 * Estimate page count from synthesised sections.
 * Assumes ~500 words per page.
 */
function estimatePages(report) {
    if (!report || !Array.isArray(report.sections)) return 0;
    const totalWords = report.sections.reduce((acc, s) => {
        const words = String(s.content || '').split(/\s+/).filter(Boolean).length;
        return acc + words;
    }, 0);
    return Math.max(1, Math.round(totalWords / 500));
}

/**
 * Get job status for a given user.
 * @param {string} jobId
 * @param {string} userId  – must match job.userId for security
 */
async function getJobStatus(jobId, userId) {
    const job = await ResearchJob.findOne({ _id: jobId, userId }).lean();
    if (!job) return null;

    return {
        jobId:       job._id,
        query:       job.query,
        nature:      job.nature,
        depth:       job.depth,
        status:      job.status,
        currentPhase: job.currentPhase,
        progress:    job.progress || [],
        resultId:    job.resultId,
        resultMeta:  job.resultMeta,
        error:       job.error,
        createdAt:   job.createdAt,
        startedAt:   job.startedAt,
        completedAt: job.completedAt,
    };
}

/**
 * List all research jobs for a user (newest first).
 */
async function listUserJobs(userId, limit = 50) {
    const jobs = await ResearchJob.find({ userId })
        .select('query nature depth status currentPhase resultMeta error createdAt completedAt')
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

    return jobs.map(j => ({
        jobId:       j._id,
        query:       j.query,
        nature:      j.nature,
        depth:       j.depth,
        status:      j.status,
        currentPhase: j.currentPhase,
        resultMeta:  j.resultMeta,
        error:       j.error,
        createdAt:   j.createdAt,
        completedAt: j.completedAt,
    }));
}

module.exports = {
    enqueueResearchJob,
    getJobStatus,
    listUserJobs,
};
