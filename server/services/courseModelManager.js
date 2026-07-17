/**
 * Course Model Manager
 * Implements Task 2.1.3: Multi-Course Model Management
 * Handles the registration, status tracking, and A/B switching of fine-tuned SLMs.
 */

const CourseModelRegistry = require('../models/CourseModelRegistry');

/**
 * Registers a new training intent for a course
 */
async function registerNewCourseModel(courseId, courseName, baseModel) {
    console.log(`[CourseModelManager] Registering new model intent for course [${courseName}]...`);

    // Create the expected Ollama tag name (e.g., imentor-cs101-qwen:v1.0.0)
    const sanitizedCourse = courseName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const ollamaTag = `imentor-${sanitizedCourse}-${baseModel.split('-')[0]}:latest`;

    const newRegistry = new CourseModelRegistry({
        courseId,
        courseName,
        baseModel,
        ollamaTag,
        modelStatus: 'training'
    });

    await newRegistry.save();
    return newRegistry;
}

/**
 * Updates a model's status (e.g., from 'training' to 'active' after QLoRA finishes)
 */
async function setModelStatus(courseId, status) {
    const validStatuses = ['training', 'active', 'archived', 'failed'];
    if (!validStatuses.includes(status)) throw new Error("Invalid model status.");

    const modelRecord = await CourseModelRegistry.findOneAndUpdate(
        { courseId },
        { modelStatus: status },
        { new: true, sort: { createdAt: -1 } } // Get latest
    );

    if (status === 'active') {
        console.log(`[CourseModelManager] Model for ${courseId} is now ACTIVE and routing traffic.`);
        // In a real system, trigger the router cache to clear and map this course
    }

    return modelRecord;
}

/**
 * Retrieves the currently active SLM tag for a specific course
 */
async function getActiveModelForCourse(courseId) {
    const activeModel = await CourseModelRegistry.findOne({ courseId, modelStatus: 'active' }).sort({ createdAt: -1 });
    return activeModel ? activeModel.ollamaTag : null;
}

/**
 * Retrieves all registered models from the registry
 */
async function listAllModels() {
    return await CourseModelRegistry.find().sort({ createdAt: -1 });
}

/**
 * Synchronizes with the local Ollama instance to find new models or update status
 */
async function syncOllamaModels() {
    const axios = require('axios');
    const primaryUrl = (process.env.OLLAMA_API_BASE_URL || 'http://172.180.15.92:11434').replace(/\/+$/, '');
    const remoteUrl = (process.env.OLLAMA_REMOTE_TUNNEL_URL || 'https://payroll-preferences-lobby-convert.trycloudflare.com').replace(/\/+$/, '');
    const localUrl = 'http://localhost:11400';

    const endpoints = [primaryUrl, localUrl, remoteUrl];
    let lastError = null;

    for (const baseUrl of endpoints) {
        try {
            console.log(`[CourseModelManager] Attempting sync from: ${baseUrl}...`);
            const response = await axios.get(`${baseUrl}/api/tags`, { timeout: 3000 });
            const ollamaModels = response.data.models || [];
            
            const results = {
                source: baseUrl,
                found: ollamaModels.length,
                added: 0,
                updated: 0
            };

            for (const model of ollamaModels) {
                const tagName = model.name;
                const existing = await CourseModelRegistry.findOne({ ollamaTag: tagName });
                
                if (!existing && tagName.startsWith('imentor-')) {
                    const parts = tagName.split('-');
                    const courseName = parts[1] || 'Unknown';
                    
                    const newRepo = new CourseModelRegistry({
                        courseId: courseName.toLowerCase(),
                        courseName: courseName,
                        baseModel: 'unknown',
                        ollamaTag: tagName,
                        modelStatus: 'active',
                        lastTrainedAt: model.modified_at
                    });
                    await newRepo.save();
                    results.added++;
                } else if (existing && existing.modelStatus === 'training') {
                    existing.modelStatus = 'active';
                    if (model.modified_at) existing.lastTrainedAt = model.modified_at;
                    await existing.save();
                    results.updated++;
                }
            }
            
            console.info(`[CourseModelManager] Sync successful from ${baseUrl}`);
            return results;

        } catch (error) {
            console.warn(`[CourseModelManager] Sync failed for ${baseUrl}: ${error.message}`);
            lastError = error;
        }
    }
    
    throw new Error(`Ollama sync failed on all endpoints. Last error: ${lastError.message}`);
}

module.exports = {
    registerNewCourseModel,
    setModelStatus,
    getActiveModelForCourse,
    listAllModels,
    syncOllamaModels
};
