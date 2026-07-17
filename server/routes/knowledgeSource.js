const log = require('../utils/logger');
// server/routes/knowledgeSource.js
const express = require('express');
const router = express.Router();
// const { Worker } = require('worker_threads');  // TODO: v2 — re-enable for analysis/KG workers
const path = require('path');
const axios = require('axios');
// const User = require('../models/User');  // TODO: v2 — re-enable for analysis workers
const AdminDocument = require('../models/AdminDocument');
const KnowledgeSource = require('../models/KnowledgeSource');
const Job = require('../models/Job');
// const { decrypt } = require('../utils/crypto');  // TODO: v2 — re-enable for analysis workers
const { auditLog } = require('../utils/logger');
const fs = require('fs').promises;
// const { resolveProviderByPreference } = require('../services/providerPriorityService');  // TODO: v2

// --- HELPER FOR PYTHON SERVICE DELETION ---
async function callPythonDeletionEndpoint(endpointPath, userId, documentName) {
    const pythonServiceUrl = process.env.PYTHON_RAG_SERVICE_URL;
    if (!pythonServiceUrl) {
        log.warn('DB', `Python deletion skipped for ${documentName}: URL not configured.`);
        return { success: false, message: "Python service URL not configured." };
    }
    const deleteUrl = `${pythonServiceUrl.replace(/\/$/, '')}${endpointPath}`;
    try {
        await axios.delete(deleteUrl, {
            data: { user_id: userId, document_name: documentName },
            timeout: 30000
        });
        return { success: true, message: `Successfully requested deletion from ${endpointPath}` };
    } catch (error) {
        const errorMsg = error.response?.data?.error || error.message;
        log.error('DB', `Python deletion error (${documentName}): ${errorMsg}`);
        return { success: false, message: errorMsg };
    }
}


// @route   POST /api/knowledge-sources
// @desc    Add a new URL-based knowledge source
// @access  Private
router.post('/', async (req, res) => {
    const { type, content } = req.body;
    const userId = req.user._id;

    if (type !== 'url' || !content) {
        return res.status(400).json({ message: "Request must be for type 'url' and include 'content'." });
    }

    let newSource;
    try {
        // --- THIS IS THE FIX ---
        // 1. Check if this exact URL already exists for this user.
        const existingSource = await KnowledgeSource.findOne({ userId, sourceUrl: content });
        if (existingSource) {
            // 2. If it exists, inform the user and stop execution.
            log.warn('DB', `User attempted to re-add existing URL: ${content}`);
            return res.status(409).json({ 
                message: `This URL has already been added. Title: "${existingSource.title}"`,
                source: existingSource
            });
        }
        // --- END OF FIX ---

        // Create initial record in DB to track progress
        newSource = new KnowledgeSource({
            userId,
            sourceType: 'webpage', // Initial type, will be corrected by Python
            title: content, 
            sourceUrl: content,
            status: 'processing_extraction',
        });
        await newSource.save();

        auditLog(req, 'KNOWLEDGE_SOURCE_URL_INGEST_SUCCESS', {
            url: content
        });

        // Immediately respond to the user so the UI doesn't hang
        const newJob = new Job({
            userId,
            jobType: 'knowledge_source',
            status: 'queued',
            sourceId: newSource._id
        });
        await newJob.save();

        res.status(202).json({ 
            message: "Upload job created",
            jobId: newJob._id.toString()
        });

        // --- Start background processing ---
        newJob.status = 'processing';
        await newJob.save();
        
        const pythonServiceUrl = process.env.PYTHON_RAG_SERVICE_URL;
        if (!pythonServiceUrl) throw new Error("Python service URL not configured.");

        // 1. Call Python to extract text from URL
        const extractionResponse = await axios.post(`${pythonServiceUrl}/process_url`, {
            url: content,
            user_id: userId.toString(),
        }, { timeout: 300000 }); // 5 min timeout for scraping/transcription

        const { text_content, title, source_type } = extractionResponse.data;
        if (!text_content) throw new Error("Failed to extract text from the URL source.");
        
        // 2. Call Python to add the extracted content to Qdrant and get KG chunks
        const addDocumentResponse = await axios.post(`${pythonServiceUrl}/add_document`, {
            user_id: userId.toString(),
            file_path: '',
            original_name: title,
            text_content_override: text_content
        }, { timeout: 300000 });

        const { num_chunks_added_to_qdrant } = addDocumentResponse.data;

        if (num_chunks_added_to_qdrant === 0) {
            throw new Error("No embeddings generated for the URL content. It might be too short or failed processing.");
        }

        // 3. Update the KnowledgeSource record in MongoDB with final details
        const sourceDoc = await KnowledgeSource.findById(newSource._id);
        if (!sourceDoc) throw new Error(`KnowledgeSource with ID ${newSource._id} disappeared during processing.`);

        sourceDoc.textContent = text_content;
        sourceDoc.title = title;
        sourceDoc.sourceType = source_type;
        sourceDoc.status = 'completed';   // Document is ready for RAG queries immediately
        sourceDoc.kgStatus = 'skipped_no_chunks'; // KG disabled for user docs — future version
        await sourceDoc.save();

        log.success('DB', `URL source '${title}' indexed → ${num_chunks_added_to_qdrant} chunks in Qdrant`);

        // Document analysis (FAQ/Topics/Mindmap) — commented out, not needed at this point.
        // Will be integrated in future versions.
        // const analysisWorker = new Worker(path.resolve(__dirname, '../workers/analysisWorker.js'), { 
        //     workerData: { ...workerBaseData, textForAnalysis: raw_text_for_analysis }
        // });

        // KG extraction for user docs — commented out, will be integrated in future versions.
        // const kgWorker = new Worker(path.resolve(__dirname, '../workers/kgWorker.js'), { 
        //     workerData: { ...workerBaseData, chunksForKg }
        // });

        // Update job status
        await Job.updateOne({ _id: newJob._id }, { $set: { status: 'completed' } });

    } catch (error) {
        log.error('DB', `Failed to process URL source: ${error.message}`);
        
        let shouldSendResponse = !res.headersSent;

        if (newSource) {
            await KnowledgeSource.updateOne({ _id: newSource._id }, {
                $set: { status: 'failed', failureReason: error.message }
            });
            // Try to update Job status too
            try {
                await Job.updateOne({ sourceId: newSource._id }, {
                    $set: { status: 'failed', error: error.message }
                });
            } catch (jobErr) {
                // Ignore job tracking update err
            }
        }
        
        // If headers not sent, send error to client
        if (shouldSendResponse) {
             res.status(500).json({ message: error.message || "Server error processing URL." });
        }
    }
});

// @route   GET /api/knowledge-sources
// @desc    Get all knowledge sources for the user (files, urls) and admin (subjects)
// @access  Private
router.get('/', async (req, res) => {
    try {
        const userId = req.user._id;

        const userSourcesPromise = KnowledgeSource.find({ userId }).sort({ createdAt: -1 }).lean();
        const adminSubjectsPromise = AdminDocument.find().sort({ originalName: 1 }).select('originalName createdAt').lean();

        const [userSources, adminSubjects] = await Promise.all([userSourcesPromise, adminSubjectsPromise]);

        const formattedAdminSubjects = adminSubjects.map(doc => ({
            _id: `admin_${doc._id}`,
            sourceType: 'subject',
            title: doc.originalName,
            status: 'completed',
            createdAt: doc.createdAt
        }));

        res.json([...formattedAdminSubjects, ...userSources]);
    } catch (error) {
        log.error('DB', `Failed to fetch knowledge sources: ${error.message}`);
        res.status(500).json({ message: "Server error while fetching knowledge sources." });
    }
});


// @route   DELETE /api/knowledge-sources/:sourceId
// @desc    Delete a knowledge source and all its associated data
// @access  Private
router.delete('/:sourceId', async (req, res) => {
    const { sourceId } = req.params;
    const userId = req.user._id.toString();
    const username = req.user.username;

    try {
        const source = await KnowledgeSource.findOne({ _id: sourceId, userId });
        if (!source) {
            return res.status(404).json({ message: "Knowledge source not found or you do not have permission to delete it." });
        }

        log.info('DB', `Deleting source: '${source.title}'`);

        auditLog(req, 'KNOWLEDGE_SOURCE_DELETE_SUCCESS', {
            sourceId: sourceId,
            sourceTitle: source.title,
            sourceType: source.sourceType
        });

        // 1. Delete from Vector DB (Qdrant) and Graph DB (Neo4j) via Python service
        await callPythonDeletionEndpoint(`/delete_qdrant_document_data`, userId, source.title);
        await callPythonDeletionEndpoint(`/kg/${userId}/${encodeURIComponent(source.title)}`, userId, source.title);

        if (source.sourceType === 'document' && source.serverFilename) {
            const sanitizedUsername = username.replace(/[^a-zA-Z0-9_-]/g, '_');
            const sourcePath = path.join(__dirname, '..', 'assets', sanitizedUsername, 'document', source.serverFilename);
            const backupDir = path.join(__dirname, '..', 'backup_assets', sanitizedUsername, 'document');
            
            await fs.mkdir(backupDir, { recursive: true });
            const backupPath = path.join(backupDir, source.serverFilename);
            
            try {
                await fs.rename(sourcePath, backupPath);
                log.info('DB', `Backed up file for '${source.title}'`);
            } catch (fileError) {
                if (fileError.code !== 'ENOENT') {
                    log.warn('DB', `Backup failed for '${source.title}': ${fileError.message}`);
                }
            }
        }

        await KnowledgeSource.deleteOne({ _id: sourceId });
        log.success('DB', `Deleted knowledge source: '${source.title}'`);

        res.status(200).json({ message: `Successfully deleted '${source.title}'.` });
    } catch (error) {
        log.error('DB', `Failed to delete source '${sourceId}': ${error.message}`);
        res.status(500).json({ message: "An error occurred while deleting the knowledge source." });
    }
});


module.exports = router;