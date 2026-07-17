/**
 * Training Data Generator Service
 * Implements Task 2.1.2: Q&A pair generation from course materials
 * Formats the extracted text chunks into HuggingFace JSONL instructional format.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

/**
 * Invokes the Python qa_generator.py script to turn raw text chunks into Q&A pairs
 * @param {Array} textChunks - Array of raw text strings
 * @param {String} courseName - Target course for prompt conditioning
 * @returns {Array} List of { instruction, output } objects
 */
async function generateQaPairs(textChunks, courseName) {
    console.log(`[DataGenerator] Generating Q&A pairs for ${textChunks.length} chunks of [${courseName}]...`);

    const pythonScript = path.join(__dirname, '../rag_service/qa_generator.py');
    let allPairs = [];

    for (let i = 0; i < textChunks.length; i++) {
        const chunk = textChunks[i];
        try {
            // Write chunk to a temp file to pass to python to avoid command line limits
            const tempInputPath = path.join(__dirname, `../../data/temp_chunk_${i}.txt`);
            fs.mkdirSync(path.dirname(tempInputPath), { recursive: true });
            fs.writeFileSync(tempInputPath, chunk);

            // Using python script to process chunk via file path (Best Practice: avoids CLI arg limits)
            const { stdout, stderr } = await execFileAsync('python', [pythonScript, '--file', tempInputPath, '--course', courseName]);

            if (stderr && !stderr.includes('[QA_Generator]')) {
                console.warn(`[DataGenerator-PyWarn] ${stderr}`);
            }

            try {
                // Find JSON output in stdout (it might have other prints, but we ensured stdout only prints JSON)
                const parsed = JSON.parse(stdout.trim());
                if (Array.isArray(parsed)) {
                    allPairs.push(...parsed);
                }
            } catch (err) {
                console.error(`[DataGenerator] Could not parse Python output: ${err.message}`);
                console.log("Stdout was:", stdout.substring(0, 100));
            }

            // Cleanup temp
            if (fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath);

        } catch (error) {
            console.error(`[DataGenerator] Chunk ${i} failed: ${error.message}`);
        }
    }

    return allPairs;
}

/**
 * Saves the Q&A pairs to a JSONL file ready for the QLoRA fine-tuner
 */
function createJsonlDataset(qaPairs, courseName) {
    const datasetId = uuidv4();
    const fileName = `${courseName.replace(/\s+/g, '_')}_${datasetId}.jsonl`;
    const outputPath = path.join(__dirname, '../../data/datasets', fileName); // Assumes folder exists

    console.log(`[DataGenerator] Formatting ${qaPairs.length} pairs into JSONL...`);

    // Ensure directory exists structurally
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // Write JSONL
    let jsonlContent = "";
    for (const pair of qaPairs) {
        jsonlContent += JSON.stringify({
            messages: [
                { role: "system", content: `You are an expert interactive tutor for ${courseName}.` },
                { role: "user", content: pair.instruction },
                { role: "assistant", content: pair.output }
            ]
        }) + "\n";
    }

    fs.writeFileSync(outputPath, jsonlContent);
    console.log(`[DataGenerator] Successfully created dataset: ${outputPath}`);

    return outputPath;
}

module.exports = {
    generateQaPairs,
    createJsonlDataset
};
