const express = require('express');
const router = express.Router();
const Job = require('../models/Job');
const log = require('../utils/logger');

// @route   GET /api/jobs/:id
// @desc    Get job status by ID
// @access  Private
router.get('/:id', async (req, res) => {
    try {
        const jobId = req.params.id;
        const userId = req.user._id;

        const job = await Job.findOne({ _id: jobId, userId: userId }).lean();

        if (!job) {
            return res.status(404).json({ message: "Job not found" });
        }

        const responseObj = {
            jobId: job._id.toString(),
            status: job.status
        };

        if (job.status === 'completed') {
            responseObj.completedAt = job.completedAt || job.updatedAt;
        } else if (job.status === 'failed') {
            responseObj.error = job.error;
        }

        return res.status(200).json(responseObj);
    } catch (error) {
        log.error('SYSTEM', `Error fetching job: ${error.message}`);
        res.status(500).json({ message: "Server error fetching job status" });
    }
});

module.exports = router;
