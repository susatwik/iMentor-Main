/**
 * Standalone Offline Job Runner
 * Used to manually trigger heavy LLM tasks (KG extraction, session analysis, retraining)
 * without waiting for the 2 AM cron window.
 */
const dotenv = require('dotenv');
const path = require('path');
const axios = require('axios');
const mongoose = require('mongoose');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

const fs = require('fs');
const log = require('../utils/logger');
const connectDB = require('../config/db');
const { runNightlyEvaluator } = require('../jobs/nightlySessionEvaluator');
const { checkAndRetrainModels } = require('../jobs/continuousLearningScheduler');

/**
 * Walk server/assets/{username}/document/ for each user and send any PDF
 * that is not already indexed in Qdrant to the Python /add_document endpoint.
 *
 * Idempotent: the Python service uses file_name as a dedup key; re-sending
 * an already-indexed file causes no harm (upsert).
 *
 * Usage: node runOfflineJobs.js reindex
 */
async function reindexUserUploads() {
    const pythonServiceUrl = process.env.PYTHON_RAG_SERVICE_URL || 'http://localhost:2001';
    const assetsRoot = path.join(__dirname, '../assets');

    if (!fs.existsSync(assetsRoot)) {
        console.log('  assets/ directory not found — skipping user PDF re-index.');
        return;
    }

    // Resolve user_id from username via MongoDB
    const User = require('../models/User');

    const userDirs = fs.readdirSync(assetsRoot).filter(d =>
        fs.statSync(path.join(assetsRoot, d)).isDirectory()
    );

    let totalSent = 0, totalFailed = 0;

    for (const username of userDirs) {
        const docDir = path.join(assetsRoot, username, 'document');
        if (!fs.existsSync(docDir)) continue;

        // The folder name is derived from email: email.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '_')
        // Reverse-match by fetching all users and comparing their derived folder name
        const allUsers = await User.find({}, 'email _id').lean();
        const user = allUsers.find(u => {
            const folderName = (u.email || '').split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '_');
            return folderName === username;
        });
        if (!user) {
            console.log(`  [reindex] No user found for folder '${username}' — skipping.`);
            continue;
        }
        const userId = String(user._id);

        const files = fs.readdirSync(docDir).filter(f =>
            /\.(pdf|docx|txt|md)$/i.test(f)
        );

        for (const filename of files) {
            const filePath = path.join(docDir, filename);
            try {
                const resp = await axios.post(`${pythonServiceUrl}/add_document`, {
                    user_id: userId,
                    file_path: filePath,
                    original_name: filename,
                }, { timeout: 120000 });
                const added = resp.data?.num_chunks_added_to_qdrant ?? 0;
                console.log(`  [reindex] ${username}/${filename} → ${added} chunks (${resp.data?.status})`);
                totalSent++;
            } catch (err) {
                console.error(`  [reindex] FAILED ${username}/${filename}: ${err.message}`);
                totalFailed++;
            }
        }
    }

    console.log(`  Re-index complete: ${totalSent} files sent, ${totalFailed} failed.`);
}

async function run() {
    console.log('🚀 Starting Manual Offline Jobs...');
    
    if (!process.env.MONGO_URI) {
        console.error('❌ MONGO_URI not found in .env');
        process.exit(1);
    }

    try {
        await connectDB(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        const jobType = process.argv[2] || 'all';

        if (jobType === 'nightly' || jobType === 'all') {
            console.log('\n--- 🌙 Running Nightly Session Evaluator ---');
            await runNightlyEvaluator();

            console.log('\n--- 🔍 Running RAG Material Pipeline (Discovery & Cleanup) ---');
            try {
                const pythonServiceUrl = process.env.PYTHON_RAG_SERVICE_URL || 'http://localhost:2001';
                const response = await axios.post(`${pythonServiceUrl}/pipeline/run`);
                console.log('✅ RAG Pipeline Response:', response.data.message);
            } catch (error) {
                console.error('❌ Failed to trigger RAG Pipeline:', error.message);
            }
        }

        if (jobType === 'retrain' || jobType === 'all') {
            console.log('\n--- Running Model Retraining Check ---');
            await checkAndRetrainModels();
        }

        // ── User PDF re-index: index any user-uploaded PDFs not yet in Qdrant ──
        if (jobType === 'reindex' || jobType === 'all') {
            console.log('\n--- Re-indexing unprocessed user uploads into Qdrant ---');
            await reindexUserUploads();
        }

        console.log('\n All requested manual jobs completed successfully.');
        process.exit(0);
    } catch (error) {
        console.error('\n❌ Error running offline jobs:', error);
        process.exit(1);
    }
}

run();
