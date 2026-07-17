const fs = require('fs');
const path = require('path');
const LLMPerformanceLog = require('../models/LLMPerformanceLog');

const DATASET_DIR = path.join(__dirname, '..', 'ml_datasets');
if (!fs.existsSync(DATASET_DIR)) {
    fs.mkdirSync(DATASET_DIR, { recursive: true });
}

/**
 * Exports chat logs for a specific course (document context) into a JSONL dataset for fine-tuning.
 * @param {string} courseId - The document context name (e.g., "Intro to Physics").
 * @param {number} minQualityScore - Optional filter (not yet implemented in logs, but good for future).
 */
async function exportCourseDataset(courseId) {
    console.log(`[DataPipeline] Exporting dataset for course: ${courseId}`);

    try {
        // Fetch logs for this course
        const logs = await LLMPerformanceLog.find({
            documentContext: courseId,
            response: { $exists: true, $ne: "" } // Ensure valid response
        }).lean();

        if (logs.length === 0) {
            console.log(`[DataPipeline] No logs found for ${courseId}.`);
            return null;
        }

        const jsonlPath = path.join(DATASET_DIR, `${courseId.replace(/[^a-z0-9]/gi, '_')}_training.jsonl`);
        const stream = fs.createWriteStream(jsonlPath, { flags: 'w' });

        let count = 0;
        for (const log of logs) {
            // Format for QLoRA / Instruct Tuning often uses:
            // {"text": "<s>[INST] {instruction} [/INST] {response} </s>"}
            // or specific chat templates. matching Qwen/Llama format.

            // Using a generic instruct format compatible with most SFT scripts:
            const instruction = `Answer the following question based on the course material for ${courseId}: ${log.query}`;
            const response = log.response;

            // Qwen-2.5-Instruct format approximation
            const text = `<|im_start|>user\n${instruction}<|im_end|>\n<|im_start|>assistant\n${response}<|im_end|>\n`;

            const entry = { text: text };
            stream.write(JSON.stringify(entry) + '\n');
            count++;
        }

        stream.end();
        console.log(`[DataPipeline] Successfully exported ${count} records to ${jsonlPath}`);
        return jsonlPath;

    } catch (error) {
        console.error(`[DataPipeline] Error exporting dataset:`, error);
        throw error;
    }
}

module.exports = {
    exportCourseDataset
};
