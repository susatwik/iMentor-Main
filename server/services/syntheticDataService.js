/**
 * Synthetic Data Service
 * Implements Task 2.3.2: Synthetic Data Generation
 * Uses high-parameter models (GPT-4/Gemini) to generate thousands of course-specific Q&A pairs.
 */

const geminiService = require('./geminiService');
const { createJsonlDataset } = require('./trainingDataGenerator');

/**
 * Automatically generates a batch of curriculum-aligned problem sets
 * @param {String} courseName - The subject matter
 * @param {String} difficulty - 'basic', 'intermediate', 'advanced'
 * @param {Number} count - Number of pairs to generate
 */
async function generateSyntheticProblemSets(courseName, difficulty, count = 10) {
    console.log(`[SyntheticData] Generating ${count} ${difficulty} problem sets for [${courseName}]...`);

    const generatorPrompt = `
    You are an expert curriculum designer for the course "${courseName}".
    Generate ${count} synthetic Q&A training pairs at a "${difficulty}" difficulty level.
    
    The output must strictly be a JSON array of objects with "instruction" and "output" keys.
    Format:
    [
        { "instruction": "A student asks...", "output": "The correct explanation is..." }
    ]
    `;

    try {
        const responseText = await geminiService.generateContentWithHistory(
            [], generatorPrompt, "You are a training data generator.", { maxOutputTokens: 2000 }
        );

        const jsonMatch = responseText.match(/\[[\s\S]*\]/);
        const qaPairs = JSON.parse(jsonMatch ? jsonMatch[0] : "[]");

        console.log(`[SyntheticData] Successfully generated ${qaPairs.length} synthetic pairs.`);
        return qaPairs;
    } catch (error) {
        console.error(`[SyntheticData] Failed to generate synthetic data: ${error.message}`);
        return [];
    }
}

module.exports = {
    generateSyntheticProblemSets
};
