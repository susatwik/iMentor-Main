/**
 * Model Evaluator Service
 * Implements Task 2.4.1: Automated Evaluation Pipeline
 * Runs a suite of hold-out questions after a fine-tuning job to score accuracy.
 */

const { setModelStatus } = require('./courseModelManager');
const { execFile } = require('child_process');
const util = require('util');
const path = require('path');
const execFileAsync = util.promisify(execFile);

/**
 * Triggers the Python evaluation suite against a newly deployed SLM
 */
async function runAutomatedEvaluation(courseId, ollamaTag) {
    console.log(`[ModelEvaluator] Commencing evaluation suite for newly tuned ${ollamaTag}...`);

    const pythonScript = path.join(__dirname, '../rag_service/evaluation_suite.py');
    const testDataPath = path.join(__dirname, '../../data/test_set.jsonl'); // Assuming standardized path

    let parsedMetrics = null;

    try {
        const { stdout, stderr } = await execFileAsync('python', [
            pythonScript,
            '--model', ollamaTag,
            '--course', courseId
        ]);

        if (stderr) console.warn(`[ModelEvaluator-PyWarn] ${stderr}`);

        const lines = stdout.trim().split('\n');
        const jsonLine = lines[lines.length - 1]; // Assume the last line is the JSON
        parsedMetrics = JSON.parse(jsonLine);

    } catch (error) {
        console.error(`[ModelEvaluator] Python Evaluation Suite Error: ${error.message}`);
        parsedMetrics = {
            model: ollamaTag,
            metrics: { accuracy: 0, latencyAvgMs: 0 },
            passed: false
        };
    }

    if (parsedMetrics.passed) {
        console.log(`[ModelEvaluator] Tests passed! Promoting ${ollamaTag} to ACTIVE status.`);
        await setModelStatus(courseId, 'active');
    } else {
        console.warn(`[ModelEvaluator] Tests failed (Regression Detected). Marking model as FAILED.`);
        await setModelStatus(courseId, 'failed');
    }

    return parsedMetrics;
}

module.exports = {
    runAutomatedEvaluation
};
