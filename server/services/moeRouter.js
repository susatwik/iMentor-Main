const CourseModelRegistry = require('../models/CourseModelRegistry');

/**
 * Mixture of Experts (MoE) Router
 * Routes queries to the most appropriate fine-tuned model adapter based on context.
 */

// Cache for active models to avoid DB hits on every request
let modelCache = new Map();
const CACHE_TTL_MS = 60 * 1000;

async function getSpecializedModel(courseId) {
    if (!courseId) return null;

    if (modelCache.has(courseId)) {
        const cached = modelCache.get(courseId);
        if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
            return cached.modelId;
        }
    }

    try {
        // Find the latest active model for this course in our new Path 2 registry
        const activeModel = await CourseModelRegistry.findOne({
            $or: [{ courseId: courseId }, { courseName: new RegExp(courseId, 'i') }],
            modelStatus: 'active'
        }).sort({ createdAt: -1 });

        if (activeModel && activeModel.ollamaTag) {
            const specializedModelId = activeModel.ollamaTag;
            modelCache.set(courseId, { modelId: specializedModelId, timestamp: Date.now() });
            console.log(`[MoE Router] Specialized model found in registry: ${specializedModelId}`);
            return specializedModelId;
        }
    } catch (error) {
        console.error(`[MoE Router] Error finding specialized model:`, error);
    }

    return null;
}

module.exports = {
    getSpecializedModel
};
