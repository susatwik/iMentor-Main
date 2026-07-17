// server/utils/jobTracker.js
const Job = require('../models/Job');
const KnowledgeSource = require('../models/KnowledgeSource');
const log = require('./logger');

async function checkAndUpdateJobCompletion(jobId, sourceId) {
    if (!jobId || !sourceId) return;

    try {
        const source = await KnowledgeSource.findById(sourceId);
        if (!source) return;

        // If either analysis or KG extraction completely failed due to critical reasons
        if (source.status === 'failed' || source.kgStatus === 'failed_critical') {
            await Job.findByIdAndUpdate(jobId, {
                status: 'failed',
                error: source.failureReason || "Background extraction process failed."
            });
            return;
        }

        // For a successful upload: main status is 'completed'
        // and kgStatus is either 'completed', 'failed_extraction' (still want to return completed but with logs), or 'skipped_no_chunks'
        if (source.status === 'completed' && 
           ['completed', 'skipped_no_chunks', 'failed_extraction'].includes(source.kgStatus)) {
            await Job.findByIdAndUpdate(jobId, {
                status: 'completed',
                completedAt: new Date()
            });
            log.success('SYSTEM', `Job ${jobId} tracking updated to completed.`);
        }
    } catch (error) {
        log.error('SYSTEM', `Failed to update job tracker for jobId ${jobId}: ${error.message}`);
    }
}

module.exports = {
    checkAndUpdateJobCompletion
};
