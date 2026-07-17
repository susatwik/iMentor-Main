// server/services/fineTuningLoop.js
const { spawn } = require('child_process');
const path = require('path');
const { extractCourseData } = require('./courseDataExtractor');
const { evaluateModel, compareModels } = require('./modelEvaluator');
const FineTuningEvent = require('../models/FineTuningEvent');
const { logger } = require('../utils/logger');

/**
 * Continuous Fine-Tuning Loop
 * Periodically extracts data, fine-tunes, and evaluates models.
 */
async function startFineTuningCycle(courseId, options = {}) {
    const jobId = `job_${Date.now()}`;
    console.log(`[FinetuneLoop] Initiating cycle for ${courseId} (Job: ${jobId})...`);

    // 1. Create a tracking event
    const event = new FineTuningEvent({
        jobId,
        courseId,
        status: 'running',
        startedAt: new Date()
    });
    await event.save();

    try {
        // 2. Extract new data (e.g. from uploaded documents or feedback)
        const extractionSource = options.sourcePath || `datasets/${courseId}_raw.json`;
        const extraction = await extractCourseData(courseId, extractionSource);

        if (!extraction.success) {
            throw new Error(`Data extraction failed: ${extraction.error}`);
        }

        // 3. Trigger Fine-Tuning Script (fine_tuner.py)
        console.log(`[FinetuneLoop] Spawning fine_tuner.py for ${courseId}...`);

        await new Promise((resolve, reject) => {
            const scriptPath = path.resolve(__dirname, '../rag_service/fine_tuner.py');
            const pythonProcess = spawn('python', [
                scriptPath,
                '--course_id', courseId,
                '--dataset_path', extraction.path,
                '--job_id', jobId,
                '--subject', options.subject || 'general',
                '--merge' // Always merge for GGUF readiness
            ]);

            pythonProcess.stdout.on('data', (data) => {
                const msg = data.toString();
                console.log(`[FineTuner Process]: ${msg}`);
                event.logs.push({ message: msg.trim() });
            });

            pythonProcess.stderr.on('data', (data) => {
                console.warn(`[FineTuner Error]: ${data}`);
            });

            pythonProcess.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`Fine-tuning script exited with code ${code}`));
            });
        });

        // 4. Evaluate new model
        console.log("[FinetuneLoop] Training complete. Evaluating new model...");
        const modelId = `${courseId}_${jobId}`;
        const baselineId = options.baselineId || `${courseId}_stable`;

        // Mock test set - in production this would be a real benchmark file
        const testSet = options.testSet || [
            { question: "What are the core concepts of this course?", expectedAnswer: "The core concepts involve..." }
        ];

        const comparison = await compareModels(modelId, baselineId, testSet, { course: courseId });

        // 5. Finalize status
        event.status = 'completed';
        event.accuracy = comparison.accuracy;
        event.completedAt = new Date();
        await event.save();

        if (comparison.comparison?.shouldDeploy) {
            console.log(`[FinetuneLoop] SUCCESS: Model ${modelId} passed evaluation. Improvement: ${comparison.comparison.improvementPercent.toFixed(1)}%`);
        } else {
            console.warn(`[FinetuneLoop] WARNING: Model ${modelId} did not significantly improve over baseline.`);
        }

        return { success: true, jobId, evaluation: comparison };

    } catch (error) {
        console.error(`[FinetuneLoop] Cycle failed for ${courseId}:`, error.message);
        event.status = 'failed';
        event.error = error.message;
        await event.save();
        return { success: false, error: error.message };
    }
}

module.exports = { startFineTuningCycle };
