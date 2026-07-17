// server/services/skillTreeSyncService.js
/**
 * Skill Tree MongoDB Sync Service
 * ================================
 * Bridges the gap between Python-generated skill tree (stored in Neo4j + disk + Redis)
 * and the Node.js SkillTree MongoDB model used by the frontend/gamification system.
 *
 * Called after Python Stage 9 (skill tree generation) via POST /api/gamification/skill-tree/sync
 */

const fs = require('fs');
const path = require('path');
const SkillTree = require('../models/SkillTree');
const log = require('../utils/logger');

// Map Python skill_level strings to MongoDB difficulty enum
const DIFFICULTY_MAP = {
    'foundational': 'beginner',
    'intermediate': 'intermediate',
    'advanced': 'advanced',
    'expert': 'expert',
};

/**
 * Sync a Python-generated skill tree into the MongoDB SkillTree collection.
 * Upserts each node — creates new ones, updates existing ones.
 *
 * @param {string} course - Course name
 * @param {Array} skillTreeNodes - Array of skill tree nodes from Python generator
 * @returns {Promise<{created: number, updated: number, errors: number}>}
 */
async function syncSkillTreeToMongo(course, skillTreeNodes) {
    if (!course || !skillTreeNodes || !Array.isArray(skillTreeNodes)) {
        log.warn('SYSTEM', 'syncSkillTreeToMongo: invalid input — course or nodes missing');
        return { created: 0, updated: 0, errors: 0 };
    }

    let created = 0, updated = 0, errors = 0;

    // Build a tier map based on difficulty_score for visual positioning
    // Tier 1 = foundational (score 1-3), Tier 2 = intermediate (4-6), Tier 3 = advanced (7-10)
    const getTier = (score) => {
        if (score <= 3) return 1;
        if (score <= 6) return 2;
        return 3;
    };

    // Assign X positions per tier to spread nodes horizontally
    const tierCounters = {};

    for (const node of skillTreeNodes) {
        const skillId = node.subtopic_id;
        if (!skillId) {
            log.warn('SYSTEM', `syncSkillTreeToMongo: skipping node without subtopic_id`);
            errors++;
            continue;
        }

        const difficultyScore = node.difficulty_score || 5;
        const tier = getTier(difficultyScore);
        tierCounters[tier] = (tierCounters[tier] || 0) + 1;

        // Load assessment questions from disk if available (Stage 10: Study Questions integration)
        let assessmentQuestions = [];
        try {
            const questionsPath = path.join(__dirname, '..', 'course_bootstrap', course, '_study_questions', `${skillId}.json`);
            if (fs.existsSync(questionsPath)) {
                const questionsData = JSON.parse(fs.readFileSync(questionsPath, 'utf-8'));
                if (questionsData.mcq && Array.isArray(questionsData.mcq)) {
                    assessmentQuestions = questionsData.mcq.map(q => ({
                        difficulty: q.difficulty === 'beginner' ? 'easy' : (q.difficulty === 'advanced' ? 'hard' : 'medium'),
                        question: q.question,
                        options: q.options,
                        correctAnswer: q.correct_option,
                        explanation: q.explanation || ''
                    }));
                    log.info('SYSTEM', `Loaded ${assessmentQuestions.length} MCQs for skill: ${skillId}`);
                }
            }
        } catch (err) {
            log.warn('SYSTEM', `Failed to load assessment questions for ${skillId}: ${err.message}`);
        }

        const upsertData = {
            skillId: skillId,
            name: node.subtopic_name || skillId,
            description: (node.learning_outcomes || []).join('. ').substring(0, 500) || `Subtopic: ${node.subtopic_name}`,
            course: course,
            category: node.module_name || node.topic_name || course,
            prerequisites: node.prerequisites || [],
            masteryThreshold: 80, // Default mastery threshold
            assessmentQuestions: assessmentQuestions,
            estimatedHours: node.estimated_study_hours || 2,
            difficulty: DIFFICULTY_MAP[node.skill_level] || 'intermediate',
            position: {
                x: tierCounters[tier] * 150,
                y: tier * 200,
                tier: tier,
            },
            relatedTopics: [node.topic_name, node.module_name].filter(Boolean),
            isActive: true,
            updatedAt: new Date(),
        };

        try {
            const existing = await SkillTree.findOne({ skillId });
            if (existing) {
                // Update existing — now including assessmentQuestions if newly found/updated
                await SkillTree.updateOne(
                    { skillId },
                    {
                        $set: {
                            name: upsertData.name,
                            description: upsertData.description,
                            course: upsertData.course,
                            category: upsertData.category,
                            prerequisites: upsertData.prerequisites,
                            assessmentQuestions: upsertData.assessmentQuestions.length > 0 ? upsertData.assessmentQuestions : existing.assessmentQuestions,
                            estimatedHours: upsertData.estimatedHours,
                            difficulty: upsertData.difficulty,
                            relatedTopics: upsertData.relatedTopics,
                            isActive: true,
                            updatedAt: new Date(),
                            // Only update position if it wasn't manually overridden
                            ...(existing.position?.tier === upsertData.position.tier ? {} : { position: upsertData.position }),
                        }
                    }
                );
                updated++;
            } else {
                // Create new
                const newNode = new SkillTree(upsertData);
                await newNode.save();
                created++;
            }
        } catch (err) {
            if (err.message && err.message.includes('Circular dependency')) {
                // The pre-save hook detected a cycle — skip this node
                log.warn('SYSTEM', `syncSkillTreeToMongo: circular dependency for ${skillId}, skipping`);
            } else {
                log.error('SYSTEM', `syncSkillTreeToMongo: error upserting ${skillId}: ${err.message}`);
            }
            errors++;
        }
    }

    // Mark any nodes NOT in this skill tree as inactive (for this course category)
    const activeIds = skillTreeNodes.map(n => n.subtopic_id).filter(Boolean);
    const courseCategories = [...new Set(skillTreeNodes.map(n => n.module_name).filter(Boolean))];
    if (courseCategories.length > 0 && activeIds.length > 0) {
        try {
            const deactivated = await SkillTree.updateMany(
                {
                    category: { $in: courseCategories },
                    skillId: { $nin: activeIds },
                    isActive: true,
                },
                { $set: { isActive: false, updatedAt: new Date() } }
            );
            if (deactivated.modifiedCount > 0) {
                log.info('SYSTEM', `syncSkillTreeToMongo: deactivated ${deactivated.modifiedCount} stale nodes`);
            }
        } catch (err) {
            log.warn('SYSTEM', `syncSkillTreeToMongo: deactivation error: ${err.message}`);
        }
    }

    log.success('SYSTEM', `Skill tree synced to MongoDB for '${course}': ${created} created, ${updated} updated, ${errors} errors`);
    return { created, updated, errors };
}

module.exports = { syncSkillTreeToMongo };
