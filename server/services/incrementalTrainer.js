/**
 * Incremental Trainer Orchestrator
 * Implements Task 2.4.3 part 2: Triggers the Python fine-tuning container.
 */

const { exec } = require('child_process');
const { getActiveModelForCourse } = require('./courseModelManager');

/**
 * Submits a new JSONL dataset to the existing Python QLoRA fine_tuner.py
 */
async function trainIncrementalAdapter(courseId, newDatasetJsonl) {
    console.log(`[IncrementalTrainer] Submitting incremental fine-tuning job for [${courseId}]...`);

    const baseModel = await getActiveModelForCourse(courseId) || 'qwen2.5-1.5b-instruct';

    return new Promise((resolve, reject) => {
        // The command maps to the existing fine_tuner.py in the server/rag_service dir
        const command = `python server/rag_service/fine_tuner.py --model ${baseModel} --data ${newDatasetJsonl} --course ${courseId}`;
        console.log(`[IncrementalTrainer] Executing: ${command}`);

        const child = exec(command, { cwd: require('path').join(__dirname, '../../') }, (error, stdout, stderr) => {
            if (error) {
                console.error(`[IncrementalTrainer] Fine-Tuning Failed. Error: ${error.message}`);
                console.log(`[IncrementalTrainer] Stack trace: ${stderr}`);
                return reject(error);
            }

            console.log(`[IncrementalTrainer] Training complete. New adapter extracted.`);
            resolve(true);
        });

        // Optional: Pipe stdout for real-time training observation in logs
        if (child.stdout) child.stdout.pipe(process.stdout);
        if (child.stderr) child.stderr.pipe(process.stderr);
    });
}

module.exports = {
    trainIncrementalAdapter
};
