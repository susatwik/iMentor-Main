/**
 * Course Detection Service
 * Implements Task 2.5.1: Routing queries to Course SLMs
 * Inspects a user query to see if it matches an active SLM's domain.
 */

const { getActiveModelForCourse } = require('./courseModelManager');

const KNOWN_COURSES = ['computer science 101', 'physics 301', 'history 202'];

/**
 * Heuristically determines if a query is requesting course-specific knowledge
 */
async function detectCourseIntent(query) {
    if (!query) return null;
    const lowerQuery = query.toLowerCase();

    for (const course of KNOWN_COURSES) {
        // Fast keyword check
        const keywords = course.split(' ');
        if (keywords.some(kw => lowerQuery.includes(kw) && kw.length > 3)) {

            // If match found, check if an active SLM exists for it
            const activeTag = await getActiveModelForCourse(course);
            if (activeTag) {
                console.log(`[CourseDetector] Query belongs to [${course}], routing to custom SLM: ${activeTag}`);
                return { courseName: course, slmTag: activeTag };
            }
        }
    }

    return null; // Route to general models (Ollama Qwen / Gemini)
}

module.exports = {
    detectCourseIntent
};
