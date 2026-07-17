/**
 * Model Performance Analyzer
 * Implements Task 1.2.1 part 2: Create model performance tracking per query type
 * and A/B testing framework for model selection.
 */

const LLMPerformanceLog = require('../models/LLMPerformanceLog');

/**
 * A/B Testing Framework: Randomly selects a model variant for a query category
 * @param {String} category - The query intent category
 * @param {Array} baselineModels - List of default models
 * @param {Array} experimentalModels - List of models to test against the baseline
 */
function abTestModelSelection(category, baselineModels, experimentalModels) {
    // Determine if user enters the A/B test cohort (e.g., 20% of traffic)
    const isInExperimentalCohort = Math.random() < 0.20;

    if (isInExperimentalCohort && experimentalModels.length > 0) {
        // Randomly assign one of the experimental models
        const variantIndex = Math.floor(Math.random() * experimentalModels.length);
        const selectedModel = experimentalModels[variantIndex];

        console.log(`[A/B Test] Routing category '${category}' to experimental model: ${selectedModel}`);
        return {
            selectedModel,
            isExperimental: true
        };
    }

    // Default baseline assignment
    const defaultModel = baselineModels[0]; // Assuming highest priority is first
    return {
        selectedModel: defaultModel,
        isExperimental: false
    };
}

/**
 * Aggregates performance logs from MongoDB to determine the historically 
 * highest-rated model for a specific query category.
 */
async function getTopPerformingModelForCategory(category) {
    try {
        const pipeline = [
            { $match: { interactionType: category, userRating: { $exists: true, $ne: null } } },
            {
                $group: {
                    _id: "$modelProvider",
                    averageScore: { $avg: "$userRating" },
                    latencyAvg: { $avg: "$latencyMs" },
                    count: { $sum: 1 }
                }
            },
            { $sort: { averageScore: -1, latencyAvg: 1 } },
            { $limit: 1 } // Get the absolute best
        ];

        const results = await LLMPerformanceLog.aggregate(pipeline);

        if (results && results.length > 0) {
            return {
                modelName: results[0]._id,
                averageScore: results[0].averageScore,
                sampleSize: results[0].count
            };
        }
        return null; // No sufficient data yet
    } catch (error) {
        console.error(`[PerformanceAnalyzer] Failed to aggregate stats for ${category}: ${error.message}`);
        return null;
    }
}

module.exports = {
    abTestModelSelection,
    getTopPerformingModelForCategory,
    getBestModelForCategory: getTopPerformingModelForCategory
};
