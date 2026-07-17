/**
 * Drift Detection Service
 * Implements Task 2.4.2 part 2: Automated Concept Drift Detection
 * Re-triggers fine-tuning if accuracy drops below a threshold.
 */

const { getTopPerformingModelForCategory } = require('./modelPerformanceAnalyzer');
const { setModelStatus } = require('./courseModelManager');

const DRIFT_THRESHOLD_ACCURACY = 80.0;

/**
 * Scans active models for performance regressions
 */
async function detectModelDrift(courseId) {
    console.log(`[DriftDetection] Scanning SLA metrics for course [${courseId}]...`);

    const stats = await getTopPerformingModelForCategory(courseId);
    if (!stats || stats.sampleSize < 50) {
        return; // Not enough data to trigger an alarm
    }

    if (stats.averageScore < (DRIFT_THRESHOLD_ACCURACY / 10)) { // Assuming scores are 1-10 mapped to 10-100%
        console.warn(`[DriftDetection] ALERT: Model ${stats.modelName} has degraded to ${stats.averageScore * 10}%. Triggering retraining loop.`);

        // Flag model for targeted retraining
        await setModelStatus(courseId, 'failed');

        // In a real system: trigger continuousLearningScheduler.js
        return true;
    }

    return false;
}

module.exports = {
    detectModelDrift
};
