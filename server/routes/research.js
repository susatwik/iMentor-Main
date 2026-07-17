const log = require('../utils/logger');
const express = require('express');
const router = express.Router();
const ResearchCache = require('../models/ResearchCache');
const { authMiddleware } = require('../middleware/authMiddleware');
const pdfExportService = require('../services/pdfExportService');
const { validateResearchExport } = require('../middleware/requestValidation');

/**
 * GET /api/research/history
 * Fetch light list of past research sessions for the logged-in user.
 */
router.get('/history', authMiddleware, async (req, res) => {
    try {
        const userId = req.user._id;
        const history = await ResearchCache.find({ userId })
            .select('query title createdAt overallConfidenceScore onlineSourceCount localSourceCount')
            .sort({ createdAt: -1 })
            .limit(50);

        res.json(history);
    } catch (error) {
        log.error('RESEARCH', `Research history fetch error: ${error.message}`);
        res.status(500).json({ message: "Failed to fetch research history." });
    }
});

/**
 * GET /api/research/:id
 * Fetch a full specific research report.
 */
router.get('/:id', authMiddleware, async (req, res) => {
    try {
        const report = await ResearchCache.findOne({
            _id: req.params.id,
            userId: req.user._id
        });

        if (!report) {
            return res.status(404).json({ message: "Research report not found." });
        }

        res.json(report);
    } catch (error) {
        log.error('RESEARCH', `Research report fetch error: ${error.message}`);
        res.status(500).json({ message: "Failed to fetch research report." });
    }
});

/**
 * POST /api/research/:id/export
 * Generate a professional academic PDF using Puppeteer.
 */
router.post('/:id/export', authMiddleware, validateResearchExport, async (req, res) => {
    try {
        const report = await ResearchCache.findById(req.params.id);

        if (!report) {
            return res.status(404).json({ message: "Research report not found for export." });
        }

        if (String(report.userId) !== String(req.user._id)) {
            return res.status(403).json({ message: 'Forbidden: You do not have access to this report.' });
        }

        const pdfBuffer = await pdfExportService.generateAcademicPDF(report);

        res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="DeepResearch_${report._id}.pdf"`,
            'Content-Length': pdfBuffer.length,
            'Content-Transfer-Encoding': 'binary',
            'Cache-Control': 'no-cache'
        });
        res.end(pdfBuffer);

    } catch (error) {
        log.error('RESEARCH', `PDF export failure: ${error.message}`);
        res.status(500).json({ message: "High-fidelity PDF generation failed." });
    }
});

/**
 * GET /api/research/:id/export
 * Legacy GET support for direct browser downloads.
 */
router.get('/:id/export', authMiddleware, async (req, res) => {
    try {
        const report = await ResearchCache.findById(req.params.id);

        if (!report) {
            return res.status(404).send("Report not found");
        }

        if (String(report.userId) !== String(req.user._id)) {
            return res.status(403).json({ message: 'Forbidden: You do not have access to this report.' });
        }

        const pdfBuffer = await pdfExportService.generateAcademicPDF(report);

        res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="DeepResearch_${report._id}.pdf"`,
            'Content-Length': pdfBuffer.length,
            'Content-Transfer-Encoding': 'binary',
            'Cache-Control': 'no-cache'
        });
        res.end(pdfBuffer);

    } catch (error) {
        log.error('RESEARCH', `PDF export (GET) failure: ${error.message}`);
        res.status(500).send("Export failed");
    }
});

module.exports = router;
