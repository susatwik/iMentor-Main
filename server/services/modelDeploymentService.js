/**
 * Model Deployment Service
 * Implements Task 2.2.3: Automatically uploads GGUF to local Ollama.
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

/**
 * Creates an Ollama Modelfile and registers the GGUF with the local Ollama instance
 */
async function deployModelToOllama(courseName, ggufPath, baseModelSlug = 'qwen2.5-1.5b') {
    return new Promise((resolve, reject) => {
        const sanitizedCourse = courseName.toLowerCase().replace(/[^a-z0-9]/g, '');
        const tagName = `imentor-${sanitizedCourse}-${baseModelSlug.split('-')[0]}:latest`;

        console.log(`[DeploymentService] Preparing deployment for tag: ${tagName}`);

        // 1. Generate the Modelfile
        const modelfileContent = `
FROM ${ggufPath}
SYSTEM """
You are a highly intelligent, specialized AI tutor for the course ${courseName}.
Answer questions clearly, concisely, and exclusively based on the provided 
academic curriculum that you were fine-tuned on.
"""
PARAMETER temperature 0.3
PARAMETER num_ctx 4096
        `;

        const tempModelfilePath = path.join(require('os').tmpdir(), `Modelfile_${sanitizedCourse}`);
        fs.writeFileSync(tempModelfilePath, modelfileContent.trim());

        // 2. Instruct Ollama to build the model
        console.log(`[DeploymentService] Executing: ollama create ${tagName} -f ${tempModelfilePath}`);

        exec(`ollama create ${tagName} -f "${tempModelfilePath}"`, (error, stdout, stderr) => {
            try { fs.unlinkSync(tempModelfilePath); } catch (e) { } // Cleanup

            if (error) {
                console.error(`[DeploymentService] Failed to create model in Ollama: ${error.message}`);
                console.warn(`[DeploymentService] Are you sure Ollama is installed and running? And the GGUF file exists at ${ggufPath}?`);
                // Rejecting for safety so we know it failed
                return reject(error);
            }

            if (stderr && !stderr.toLowerCase().includes('success')) {
                console.log(`[DeploymentService] Ollama output: ${stderr}`);
            }

            console.log(`[DeploymentService] Deployment Successful! Model ${tagName} is ready for inference.`);
            resolve(tagName);
        });
    });
}

module.exports = {
    deployModelToOllama
};
