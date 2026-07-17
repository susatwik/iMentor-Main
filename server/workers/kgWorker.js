const log = require('../utils/logger');
// server/workers/kgWorker.js
const { workerData, parentPort } = require('worker_threads');
const mongoose = require('mongoose');

// --- REFACTORED MODELS ---
const KnowledgeSource = require('../models/KnowledgeSource');
const connectDB = require('../config/db');
const kgService = require('../services/kgService');
const { checkAndUpdateJobCompletion } = require('../utils/jobTracker');

async function runKgGeneration() {
    // --- REFACTORED DESTRUCTURING ---
    const { chunksForKg, userId, originalName, llmProvider, ollamaModel, sourceId } = workerData;
    let dbConnected = false;
    let overallSuccess = false;
    let finalMessage = "KG processing encountered an issue.";
    const logPrefix = `[KG Worker ${process.pid}, SourceID: ${sourceId}]`;

    try {
        log.info('DB', `KG Task: Processing ${chunksForKg ? chunksForKg.length : 0} chunks`);
        if (!process.env.MONGO_URI || !sourceId || !userId || !originalName) {
            throw new Error("Missing critical worker data (MONGO_URI, sourceId, userId, or originalName).");
        }

        await connectDB(process.env.MONGO_URI);
        dbConnected = true;
        // log.info('DB', 'Worker DB connected');

        // --- REFACTORED DB UPDATE LOGIC ---
        await KnowledgeSource.updateOne({ _id: sourceId }, { $set: { "kgStatus": "processing" } });
        // log.info('DB', 'Status: processing');

        if (!chunksForKg || chunksForKg.length === 0) {
            finalMessage = "No chunks provided for KG generation.";
            await KnowledgeSource.updateOne({ _id: sourceId }, { $set: { "kgStatus": "skipped_no_chunks" } });
            overallSuccess = true;
        } else {
            // NOTE: The `userId` and `originalName` are still passed to kgService for populating metadata in Neo4j.
            const kgExtractionResult = await kgService.generateAndStoreKg(chunksForKg, userId, originalName, llmProvider, ollamaModel);

            if (kgExtractionResult && kgExtractionResult.success) {
                await KnowledgeSource.updateOne(
                    { _id: sourceId }, 
                    { $set: { "kgStatus": "completed" } }
                );
                overallSuccess = true;
                finalMessage = kgExtractionResult.message || "KG generation and storage completed successfully.";
            } else {
                await KnowledgeSource.updateOne({ _id: sourceId }, { $set: { "kgStatus": "failed_extraction" } });
                finalMessage = kgExtractionResult?.message || "KG detailed extraction or storage failed.";
                overallSuccess = false;
            }
        }
        // --- END REFACTOR ---
        
        await checkAndUpdateJobCompletion(workerData.jobId, sourceId);

    } catch (error) {
        log.error('DB', `KG Critical Error: ${error.message}`, error);
        finalMessage = error.message || "Unknown critical error in KG worker.";
        overallSuccess = false;
        if (dbConnected && sourceId) {
            try {
                await KnowledgeSource.updateOne({ _id: sourceId }, { $set: { "kgStatus": "failed_critical" } });
                await checkAndUpdateJobCompletion(workerData.jobId, sourceId);
            } catch (dbUpdateError) {
                log.error('DB', 'Failed to update KG status to failed_critical');
            }
        }
    } finally {
        if (dbConnected) {
            await mongoose.disconnect();
        }
        log.success('DB', `KG Worker finished (Success: ${overallSuccess})`);
    }
}

runKgGeneration();