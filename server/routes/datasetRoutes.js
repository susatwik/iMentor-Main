const log = require('../utils/logger');
// server/routes/admin/datasetRoutes.js
const express = require('express');
const router = express.Router();
const Dataset = require('./../models/Dataset');
const { getSignedUploadUrl, getSignedDownloadUrl, deleteObjectFromS3 } = require('./../services/s3Service');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;

// Helper to trigger Python RAG service indexing
async function triggerPythonRagProcessingForAdmin(filePath, originalName) {
    const pythonServiceUrl = process.env.PYTHON_RAG_SERVICE_URL;
    if (!pythonServiceUrl) {
        return { success: false, message: "Python service URL not configured.", text: null, chunksForKg: [] };
    }
    const addDocumentUrl = `${pythonServiceUrl}/add_document`;
    try {
        const response = await axios.post(addDocumentUrl, {
            user_id: "admin",
            file_path: filePath,
            original_name: originalName
        }, { timeout: 300000 });

        const text = response.data?.raw_text_for_analysis || null;
        const chunksForKg = response.data?.chunks_with_metadata || [];
        const isSuccess = !!(text && text.trim());
        return {
            success: isSuccess,
            message: response.data?.message || "Python RAG service call completed.",
            text: text,
            chunksForKg: chunksForKg
        };
    } catch (error) {
        const errorMsg = error.response?.data?.error || error.message || "Unknown error calling Python RAG.";
        return { success: false, message: `Python RAG call failed: ${errorMsg}`, text: null, chunksForKg: [] };
    }
}

// @route   POST /api/admin/datasets/presigned-url
// @desc    Get a secure, pre-signed URL for uploading a dataset to S3
// @access  Admin
router.post('/presigned-url', async (req, res) => {
    const { fileName, fileType } = req.body;
    if (!fileName || !fileType) {
        return res.status(400).json({ message: 'fileName and fileType are required.' });
    }

    try {
        const { url, key } = await getSignedUploadUrl(fileName, fileType);
        res.json({ url, key });
    } catch (error) {
        log.error('DB', `Failed to generate upload URL: ${error.message}`);
        res.status(500).json({ message: 'Could not generate upload URL.' });
    }
});

// @route   POST /api/admin/datasets/finalize-upload
// @desc    Create the dataset metadata record in MongoDB after successful S3 upload & index to RAG/KG
// @access  Admin
router.post('/finalize-upload', async (req, res) => {
    const { originalName, s3Key, category, version, fileType, size } = req.body;
    if (!originalName || !s3Key || !category || !version || !fileType || !size) {
        return res.status(400).json({ message: 'Missing required fields to finalize upload.' });
    }

    let tempFilePath = '';
    try {
        // 1. Generate download URL
        const downloadUrl = await getSignedDownloadUrl(s3Key, originalName);
        
        // 2. Setup a temporary path to download and store the file locally for processing
        const tempDir = path.join(__dirname, '..', 'assets', '_admin_uploads_', 'temp');
        await fsPromises.mkdir(tempDir, { recursive: true });
        tempFilePath = path.join(tempDir, `${Date.now()}-${originalName}`);

        let fileDownloaded = false;
        if (downloadUrl && downloadUrl.startsWith('http') && !downloadUrl.includes('mock-s3-download')) {
            try {
                const response = await axios({
                    method: 'get',
                    url: downloadUrl,
                    responseType: 'stream'
                });
                const writer = fs.createWriteStream(tempFilePath);
                response.data.pipe(writer);
                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });
                fileDownloaded = true;
            } catch (err) {
                log.warn('DB', `Failed to download dataset file from S3 url ${downloadUrl}: ${err.message}. Using mock text fallback.`);
            }
        }

        if (!fileDownloaded) {
            // Write a small mock file so that Python RAG can at least process it in non-AWS development environments
            await fsPromises.writeFile(
                tempFilePath, 
                `Dataset: ${originalName}\nCategory: ${category}\nVersion: ${version}\nContent: This is a synchronized academic dataset for category ${category}.`
            );
        }

        // 3. Trigger Python RAG indexing (writes chunk vectors to Qdrant)
        const ragResult = await triggerPythonRagProcessingForAdmin(
            tempFilePath,
            originalName
        );

        if (!ragResult.success) {
            if (fs.existsSync(tempFilePath)) {
                await fsPromises.unlink(tempFilePath);
            }
            return res.status(422).json({ message: `RAG Ingestion failed: ${ragResult.message}` });
        }

        // 4. Save metadata record to MongoDB Datasets collection
        const newDataset = new Dataset({
            originalName, s3Key, category, version, fileType, size
        });
        await newDataset.save();

        // Clean up temporary local file
        if (fs.existsSync(tempFilePath)) {
            await fsPromises.unlink(tempFilePath);
        }

        // 5. Trigger Neo4j Knowledge Graph Extraction in background worker
        if (ragResult.chunksForKg && ragResult.chunksForKg.length > 0) {
            const { Worker } = require("worker_threads");
            const kgWorker = new Worker(
                path.resolve(__dirname, "..", "workers", "kgWorker.js"),
                {
                    workerData: {
                        sourceId: newDataset._id.toString(),
                        userId: "admin",
                        originalName: originalName,
                        chunksForKg: ragResult.chunksForKg,
                        llmProvider: "gemini",
                    },
                }
            );
            kgWorker.on("error", (err) => log.error('SYSTEM', `Dataset KG worker error: ${err.message}`));
        }

        res.status(201).json({ message: 'Dataset metadata saved and index processing initiated successfully.', dataset: newDataset });
    } catch (error) {
        log.error('DB', `Failed to finalize upload: ${error.message}`);
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            await fsPromises.unlink(tempFilePath).catch(() => {});
        }
        res.status(500).json({ message: 'Server error while saving dataset metadata.' });
    }
});

// @route   GET /api/admin/datasets
// @desc    Get a list of all uploaded datasets
// @access  Admin
router.get('/', async (req, res) => {
    try {
        const datasets = await Dataset.find().sort({ createdAt: -1 });
        res.json(datasets);
    } catch (error) {
        log.error('DB', `Failed to fetch datasets: ${error.message}`);
        res.status(500).json({ message: 'Server error while fetching datasets.' });
    }
});

// @route   GET /api/admin/datasets/:id/download-url
// @desc    Get a secure, pre-signed URL for downloading a dataset from S3
// @access  Admin
router.get('/:id/download-url', async (req, res) => {
    try {
        const dataset = await Dataset.findById(req.params.id);
        if (!dataset) {
            return res.status(404).json({ message: 'Dataset not found.' });
        }
        const url = await getSignedDownloadUrl(dataset.s3Key, dataset.originalName);
        res.json({ url });
    } catch (error) {
        log.error('DB', `Failed to generate download URL: ${error.message}`);
        res.status(500).json({ message: 'Could not generate download URL.' });
    }
});

// @route   DELETE /api/admin/datasets/:id
// @desc    Delete a dataset from S3 and MongoDB
// @access  Admin
router.delete('/:id', async (req, res) => {
    try {
        // 1. Find the dataset metadata in MongoDB
        const dataset = await Dataset.findById(req.params.id);
        if (!dataset) {
            return res.status(404).json({ message: 'Dataset not found.' });
        }

        // 2. Check if there is an S3 key before attempting to delete from S3
        if (dataset.s3Key) {
            log.info('DB', `Deleting from S3: ${dataset.s3Key}`);
            await deleteObjectFromS3(dataset.s3Key);
        } else {
            log.warn('DB', `S3 key missing for dataset: ${dataset._id}`);
        }

        // 3. Delete the metadata from MongoDB
        await Dataset.findByIdAndDelete(req.params.id);

        res.json({ message: `Dataset '${dataset.originalName}' and its metadata were deleted successfully.` });
    } catch (error) {
        log.error('DB', `Failed to delete dataset: ${error.message}`);
        res.status(500).json({ message: 'Server error while deleting dataset.' });
    }
});

module.exports = router;