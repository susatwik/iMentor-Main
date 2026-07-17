// server/services/neo4jCleanupService.js
const { runQuery, isConnected } = require('../config/neo4j');
const { logger } = require('../utils/logger');

/**
 * Cleanup orphaned curriculum nodes in Neo4j (T6-11/17)
 * This handles the "Deletion Cascade" for knowledge graph nodes.
 */
async function deleteCourseNodes(userId, originalName) {
    if (!userId || !originalName) {
        logger.warn('[Neo4jCleanup] userId and originalName are required for cleanup');
        return { success: false, message: 'Missing parameters' };
    }

    if (!isConnected()) {
        logger.warn('[Neo4jCleanup] Cleanup skipped: Neo4j is not connected.');
        return { success: false, message: 'Neo4j connection is unavailable.' };
    }

    const logPrefix = `[Neo4jCleanup Doc: ${originalName}, User: ${userId}]`;
    logger.info(`${logPrefix} Starting curriculum node cleanup...`);

    try {
        // Step 1: Delete nodes explicitly tagged with this document
        // KnowledgeNodes use 'documentName', Curriculum nodes (Topic/Module/Subtopic) use 'course'
        const deleteQuery = `
            MATCH (n)
            WHERE (n:Topic OR n:Module OR n:Subtopic OR n:Syllabus OR n:KnowledgeNode)
            AND (
                n.course = $originalName OR 
                n.documentName = $originalName
            )
            AND (n.userId = $userId OR n.userId IS NULL OR n.userId = 'admin')
            DETACH DELETE n
        `;

        const result = await runQuery(deleteQuery, { userId, originalName });

        // Note: Result records might be empty for DETACH DELETE, 
        // but we can check the summary if runQuery returned it.
        // For now, we assume if no error, it matched what was there.

        logger.info(`${logPrefix} Cleanup query executed successfully.`);

        return {
            success: true,
            message: 'Curriculum nodes cleaned up successfully'
        };
    } catch (error) {
        logger.error(`${logPrefix} Cleanup failed: ${error.message}`);
        return {
            success: false,
            message: `Cleanup error: ${error.message}`
        };
    }
}

module.exports = { deleteCourseNodes };
