// server/routes/upload.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const axios = require('axios');
const { authMiddleware } = require('../middleware/authMiddleware');
const User = require('../models/User');
const KnowledgeSource = require('../models/KnowledgeSource');
const Job = require('../models/Job');
// const { Worker } = require('worker_threads');  // TODO: v2 — re-enable for analysis/KG workers
const { decrypt } = require('../utils/crypto');
const log = require('../utils/logger');
const { auditLog } = require('../utils/logger');
// const { resolveProviderByPreference } = require('../services/providerPriorityService');  // TODO: v2
const { validateFileUploadMeta } = require('../middleware/requestValidation');

const router = express.Router();

// --- Constants & Multer Config ---
const UPLOAD_DIR = path.join(__dirname, '..', 'assets');
const MAX_FILE_SIZE = 50 * 1024 * 1024; // Increased to 50MB for media
const allowedMimeTypes = {
    // Documents
    'application/pdf': { type: 'document', processor: 'ai_core' },
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { type: 'document', processor: 'ai_core' },
    'text/plain': { type: 'document', processor: 'ai_core' },
    'text/markdown': { type: 'document', processor: 'ai_core' },
    // Media
    'audio/mpeg': { type: 'audio', processor: 'media' },
    'audio/wav': { type: 'audio', processor: 'media' },
    'video/mp4': { type: 'video', processor: 'media' },
    'video/quicktime': { type: 'video', processor: 'media' },
    'image/png': { type: 'image', processor: 'media' },
    'image/jpeg': { type: 'image', processor: 'media' },
};
const allowedExtensions = Object.keys(allowedMimeTypes).flatMap(mime => {
    const extMap = { 'application/pdf': '.pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx', /* etc */ };
    return extMap[mime] || []; // Simplified, a full map would be needed
}); // This part can be improved if needed

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!req.user || !req.user.email) {
            return cb(new Error("Authentication error: User context not found for upload destination."));
        }
        const sanitizedUsername = req.user.email.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '_');
        const fileMimeType = file.mimetype.toLowerCase();
        const fileTypeSubfolder = allowedMimeTypes[fileMimeType]?.type || 'others';
        const destinationPath = path.join(UPLOAD_DIR, sanitizedUsername, fileTypeSubfolder);
        fs.mkdir(destinationPath, { recursive: true }).then(() => cb(null, destinationPath)).catch(cb);
    },
    filename: (req, file, cb) => {
        const timestamp = Date.now();
        const fileExt = path.extname(file.originalname).toLowerCase();
        const sanitizedBaseName = path.basename(file.originalname, fileExt)
                                      .replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 100);
        const uniqueFilename = `${timestamp}-${sanitizedBaseName}${fileExt}`;
        cb(null, uniqueFilename);
    }
});

const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

// ─── Document indexing status polling ────────────────────────────────────
// GET /api/upload/status/:jobId — returns current indexing status for a document upload job
router.get('/status/:jobId', authMiddleware, async (req, res) => {
    try {
        const job = await Job.findOne({ _id: req.params.jobId, userId: req.user._id }).lean();
        if (!job) {
            return res.status(404).json({ message: 'Job not found.' });
        }
        const source = job.sourceId
            ? await KnowledgeSource.findById(job.sourceId).select('title status failureReason').lean()
            : null;
        res.json({
            jobId: job._id,
            jobStatus: job.status,           // 'queued' | 'processing' | 'completed' | 'failed'
            documentTitle: source?.title || null,
            documentStatus: source?.status || null, // 'processing_extraction' | 'ready' | 'failed'
            failureReason: source?.failureReason || job.error || null,
        });
    } catch (error) {
        log.error('SYSTEM', `Status poll error: ${error.message}`);
        res.status(500).json({ message: 'Error checking job status.' });
    }
});

// ─── Serve generated documents ──────────────────────────────────────────
router.get('/generated/:filename', authMiddleware, (req, res) => {
    const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '');
    const filePath = path.join(__dirname, '..', 'assets', 'generated_docs', filename);
    res.download(filePath, filename, (err) => {
        if (err && !res.headersSent) {
            res.status(404).json({ message: 'Generated document not found.' });
        }
    });
});

// Main upload route
router.post('/', upload.single('file'), validateFileUploadMeta, async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "No file received." });
    const userId = req.user._id;
    const { originalname: originalName, path: serverPath, mimetype } = req.file;
    
    let newSource;
    try {
        const { type, processor } = allowedMimeTypes[mimetype.toLowerCase()] || {};
        if (!type || !processor) {
            throw new Error(`Unsupported file type: ${mimetype}`);
        }

        newSource = new KnowledgeSource({
            userId,
            sourceType: type,
            title: originalName,
            serverFilename: path.basename(serverPath),
            status: 'processing_extraction'
        });
        await newSource.save();

        auditLog(req, 'KNOWLEDGE_SOURCE_UPLOAD_SUCCESS', {
            sourceType: type,
            originalName: originalName,
            sizeBytes: req.file.size
        });

        const newJob = new Job({
            userId,
            jobType: 'upload',
            status: 'processing',
            sourceId: newSource._id
        });
        await newJob.save();

        const pythonServiceUrl = process.env.PYTHON_RAG_SERVICE_URL;
        if (!pythonServiceUrl) throw new Error("Python service URL not configured.");

        // Respond immediately — user can continue chatting while indexing runs in background
        res.status(202).json({
            message: "File received — indexing in background, you can continue chatting",
            jobId: newJob._id.toString()
        });

        // --- Background: index into Qdrant (live session — not deferred to offline jobs) ---
        setImmediate(async () => {
            try {
                let pythonEndpoint = '';
                let pythonPayload = {};

                if (processor === 'ai_core') {
                    pythonEndpoint = '/add_document';
                    pythonPayload = { user_id: userId.toString(), file_path: serverPath, original_name: originalName };
                } else if (processor === 'media') {
                    pythonEndpoint = '/process_media_file';
                    pythonPayload = { file_path: serverPath, media_type: type };
                }

                const extractionResponse = await axios.post(
                    `${pythonServiceUrl}${pythonEndpoint}`,
                    pythonPayload,
                    { timeout: 600000 }
                );

                const numChunks = extractionResponse.data?.num_chunks_added_to_qdrant ?? 0;
                log.success('SYSTEM', `[Upload] Indexed "${originalName}" → ${numChunks} chunks in Qdrant (user ${userId})`);

                await KnowledgeSource.updateOne({ _id: newSource._id }, { $set: { status: 'completed' } });
                await Job.updateOne({ _id: newJob._id }, { $set: { status: 'completed' } });

                // Document analysis — not needed at this point, reserved for future
                // const text_content = extractionResponse.data?.text_content
                //     || (processor === 'ai_core' ? extractionResponse.data?.raw_text_for_analysis : null);
                // const sourceDoc = await KnowledgeSource.findById(newSource._id);
                // sourceDoc.textContent = text_content;
                // sourceDoc.status = 'processing_analysis';
                // await sourceDoc.save();
                // const analysisWorker = new Worker(path.resolve(__dirname, '../workers/analysisWorker.js'), {
                //     workerData: { ...workerBaseData, textForAnalysis: text_content }
                // });

                // KG extraction for user docs — future version
                // const chunksForKg = extractionResponse.data?.chunks_with_metadata || [];
                // const kgWorker = new Worker(path.resolve(__dirname, '../workers/kgWorker.js'), {
                //     workerData: { ...workerBaseData, chunksForKg }
                // });

            } catch (bgErr) {
                log.error('SYSTEM', `[Upload] Qdrant indexing failed for "${originalName}": ${bgErr.message}`);
                await KnowledgeSource.updateOne({ _id: newSource._id }, { $set: { status: 'failed', failureReason: bgErr.message } }).catch(() => {});
                await Job.updateOne({ _id: newJob._id }, { $set: { status: 'failed', error: bgErr.message } }).catch(() => {});
            }
        });


    } catch (error) {
        

        log.error('SYSTEM', `File upload error: ${error.message}`);
        
        let shouldSendResponse = !res.headersSent;

        if (newSource) {
            await KnowledgeSource.updateOne({ _id: newSource._id }, {
                $set: { status: 'failed', failureReason: error.message }
            });
            // Also update Job if it exists but hasn't entered worker logic
            try {
                // If it already succeeded before crashing, we don't revert it. But usually it wouldn't hit this catch.
                await Job.updateOne({ sourceId: newSource._id }, {
                    $set: { status: 'failed', error: error.message }
                });
            } catch (jobErr) {
                // Ignore job tracking update err
            }
        }
        
        // If headers not sent, send error to client. This happens for initial errors.
        if (shouldSendResponse) {
        if (error.message && error.message.includes("E11000 duplicate key error")) {
            res.status(400).json({ message: "File already exists" });
        } else {
            res.status(500).json({ message: error.message || "Server error during file processing." });
        }
}

    }
});

// ─── Vision Analysis Endpoint ───────────────────────────────────────────
// POST /api/upload/analyze-image
// Accepts a base64-encoded image and a text prompt, sends to Gemini Vision
router.post('/analyze-image', authMiddleware, async (req, res) => {
    try {
        const { imageBase64, mimeType, prompt } = req.body;

        if (!imageBase64 || !mimeType) {
            return res.status(400).json({ message: 'imageBase64 and mimeType are required.' });
        }

        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)) {
            return res.status(400).json({ message: 'Unsupported image type. Use PNG, JPEG, WebP, or GIF.' });
        }

        // Limit to ~10MB base64 (approx 7.5MB raw image)
        if (imageBase64.length > 10 * 1024 * 1024) {
            return res.status(400).json({ message: 'Image too large. Max 10MB base64.' });
        }

        const { generateContentWithVision } = require('../services/geminiService');

        const textPrompt = prompt || 'Analyze this image in detail. Describe what you see, identify key concepts, and explain any educational content.';

        const result = await generateContentWithVision(textPrompt, {
            mimeType,
            data: imageBase64 // strip data URL prefix if present
                .replace(/^data:image\/\w+;base64,/, '')
        }, {
            apiKey: req.user?.geminiApiKey ? decrypt(req.user.geminiApiKey) : undefined,
            systemPrompt: 'You are an expert educational AI tutor. Analyze images from an academic perspective. Identify diagrams, equations, charts, text, or concepts and explain them clearly for a student.'
        });

        log.success('AI', `Vision analysis completed for user ${req.user._id} (${result.length} chars)`);

        res.json({
            analysis: result,
            model: process.env.GEMINI_VISION_MODEL || process.env.GEMINI_MODEL || 'gemini-2.0-flash'
        });
    } catch (error) {
        log.error('AI', `Vision analysis failed: ${error.message}`, error);
        res.status(error.status || 500).json({ message: error.message || 'Vision analysis failed.' });
    }
});

module.exports = router;