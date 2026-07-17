/**
 * Continuous Learning Scheduler
 * Implements Task 2.4.3 part 1: Automated Model Updates
 */

const cron = require('node-cron');
const { trainIncrementalAdapter } = require('./incrementalTrainer');
const { getAllCourses } = require('./courseModelManager'); // Hypothetical helper for getting all courses in DB

/**
 * Starts the background polling for model updates
 */
function startContinuousLearningSchedule() {
    console.log(`[CronScheduler] Continuous Learning loop activated (Weekly).`);

    // Run every Sunday at midnight
    cron.schedule('0 0 * * 0', async () => {
        console.log(`[CronScheduler] Weekly cron trigger initiating. Checking for pending training datasets...`);
        try {
            // For each tracked course, if there is a pending augmented dataset, trigger training
            const courses = await getAllCourses(); // From courseModelManager
            for (const course of courses) {
                if (course.status === 'pending_update') {
                    console.log(`[CronScheduler] Found pending updates for ${course.courseId}. Starting incremental job.`);
                    // The dataset path would ideally be pulled from the database or known location
                    const datasetPath = `data/datasets/${course.courseId}_augmented.jsonl`;
                    await trainIncrementalAdapter(course.courseId, datasetPath);
                }
            }
        } catch (e) {
            console.error(`[CronScheduler] Error during scheduled training loop: ${e.message}`);
        }
    });
}

/**
 * Manually forces a training loop for a specific course
 */
async function forceTrainingLoop(courseId, datasetPath) {
    console.log(`[CronScheduler] Forcing immediate training loop for [${courseId}].`);
    return await trainIncrementalAdapter(courseId, datasetPath);
}

module.exports = {
    startContinuousLearningSchedule,
    forceTrainingLoop
};
