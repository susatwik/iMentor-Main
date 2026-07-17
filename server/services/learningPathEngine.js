/**
 * server/services/learningPathEngine.js
 * 
 * Learning Path Engine
 * 
 * Determines the optimal sequence of topics based on:
 * - Student's mastery of prerequisites
 * - Prior knowledge
 * - Learning speed
 * - Subject curriculum structure
 * - Student's goals
 * 
 * Does NOT follow a fixed sequence - dynamically adapts
 */

const log = require('../utils/logger');
const StudentKnowledgeState = require('../models/StudentKnowledgeState');
const LearningPath = require('../models/LearningPath');

// Generic subject curriculum structures
const CURRICULUM_GRAPHS = {
    DSA: {
        // Data Structures & Algorithms
        modules: {
            'Fundamentals': {
                topics: ['variables', 'operators', 'loops', 'conditionals', 'functions'],
                order: 0
            },
            'Data Structures': {
                topics: ['arrays', 'linked lists', 'stacks', 'queues', 'hash tables', 'trees', 'graphs'],
                order: 1,
                prerequisites: ['Fundamentals']
            },
            'Algorithms': {
                topics: ['sorting', 'searching', 'dynamic programming', 'greedy', 'backtracking'],
                order: 2,
                prerequisites: ['Data Structures']
            },
            'Advanced': {
                topics: ['segment trees', 'fenwick trees', 'tries', 'advanced graphs'],
                order: 3,
                prerequisites: ['Algorithms']
            }
        },
        topicDependencies: {
            'recursion': ['functions'],
            'binary search': ['arrays', 'sorting'],
            'dynamic programming': ['recursion'],
            'graphs': ['trees', 'adjacency lists'],
            'linked lists': ['pointers'],
            'binary trees': ['trees basics'],
            'AVL trees': ['binary trees'],
            'DFS': ['graphs', 'stacks'],
            'BFS': ['graphs', 'queues'],
        }
    },
    DBMS: {
        modules: {
            'Basics': {
                topics: ['database concepts', 'data models', 'schema design'],
                order: 0
            },
            'SQL': {
                topics: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'JOINs', 'aggregation'],
                order: 1,
                prerequisites: ['Basics']
            },
            'Advanced SQL': {
                topics: ['subqueries', 'window functions', 'stored procedures', 'transactions'],
                order: 2,
                prerequisites: ['SQL']
            },
            'Optimization': {
                topics: ['indexing', 'query optimization', 'normalization'],
                order: 3,
                prerequisites: ['Advanced SQL']
            }
        },
        topicDependencies: {
            'JOINs': ['SELECT basics'],
            'subqueries': ['SELECT basics', 'JOINs'],
            'transactions': ['UPDATE', 'DELETE'],
            'stored procedures': ['SQL basics'],
            'indexing': ['schema design'],
            'query optimization': ['indexing']
        }
    },
    // Add more subjects as needed
};

class LearningPathEngine {
    /**
     * Generate dynamic learning path for student
     * @param {ObjectId} userId - Student's user ID
     * @param {string} subject - Subject ('DSA', 'DBMS', etc.)
     * @returns {Promise<Array>} Ordered list of topics to learn
     */
    async generateLearningPath(userId, subject = 'DSA') {
        try {
            const knowledgeState = await StudentKnowledgeState.findOne({ userId });
            if (!knowledgeState) {
                return this._getDefaultPath(subject);
            }

            const curriculum = CURRICULUM_GRAPHS[subject] || CURRICULUM_GRAPHS.DSA;
            const masteryConcepts = new Set(
                knowledgeState.concepts
                    ?.filter(c => c.masteryScore >= 80)
                    .map(c => c.conceptName.toLowerCase()) || []
            );

            // Generate path based on mastery and prerequisites
            const path = this._computeDynamicPath(
                curriculum,
                masteryConcepts,
                knowledgeState
            );

            // Save to database for tracking
            await this._saveLearningPath(userId, subject, path);

            return path;
        } catch (error) {
            log.warn('LEARNING_PATH', `Failed to generate path: ${error.message}`);
            return this._getDefaultPath(subject);
        }
    }

    /**
     * Compute dynamic path based on current mastery
     * @private
     */
    _computeDynamicPath(curriculum, masteryConcepts, knowledgeState) {
        const path = [];
        const visited = new Set();

        // Get all topics from curriculum
        const allTopics = [];
        for (const module of Object.values(curriculum.modules)) {
            allTopics.push(...module.topics);
        }

        // Topic to check: those not yet mastered
        const unmastered = allTopics.filter(t => !masteryConcepts.has(t.toLowerCase()));

        // Sort by prerequisites: topics with no unmet prerequisites come first
        const sorted = this._topologicalSort(
            unmastered,
            curriculum.topicDependencies,
            masteryConcepts
        );

        return sorted;
    }

    /**
     * Topological sort: topics with met prerequisites first
     * @private
     */
    _topologicalSort(topics, dependencies, masteryConcepts) {
        const sorted = [];
        const inProgress = new Set();
        const done = new Set(masteryConcepts);

        const visit = (topic) => {
            if (done.has(topic.toLowerCase())) return;
            if (inProgress.has(topic.toLowerCase())) return; // Cycle detected

            inProgress.add(topic.toLowerCase());

            // Visit prerequisites first
            const deps = dependencies[topic.toLowerCase()] || [];
            for (const dep of deps) {
                visit(dep);
            }

            inProgress.delete(topic.toLowerCase());
            done.add(topic.toLowerCase());
            sorted.push(topic);
        };

        for (const topic of topics) {
            visit(topic);
        }

        return sorted;
    }

    /**
     * Get default path for subject
     * @private
     */
    _getDefaultPath(subject) {
        const curriculum = CURRICULUM_GRAPHS[subject] || CURRICULUM_GRAPHS.DSA;
        const path = [];

        const modules = Object.values(curriculum.modules)
            .sort((a, b) => a.order - b.order);

        for (const module of modules) {
            path.push(...module.topics);
        }

        return path;
    }

    /**
     * Get next recommended topic for student
     * @param {ObjectId} userId
     * @param {string} subject
     * @returns {Promise<string>} Next topic to study
     */
    async getNextTopic(userId, subject = 'DSA') {
        try {
            const path = await this.generateLearningPath(userId, subject);
            if (path.length === 0) {
                return 'Challenge: Advanced Problems'; // All topics mastered
            }

            // First topic in path is the next one
            return path[0];
        } catch (error) {
            log.warn('LEARNING_PATH', `Failed to get next topic: ${error.message}`);
            return 'arrays'; // Safe default
        }
    }

    /**
     * Get multiple next topics to recommend
     * @param {ObjectId} userId
     * @param {string} subject
     * @param {number} count - Number of topics to return
     * @returns {Promise<Array>}
     */
    async getNextTopics(userId, subject = 'DSA', count = 5) {
        try {
            const path = await this.generateLearningPath(userId, subject);
            return path.slice(0, count);
        } catch (error) {
            log.warn('LEARNING_PATH', `Failed to get next topics: ${error.message}`);
            return ['arrays', 'linked lists', 'stacks', 'queues', 'trees'];
        }
    }

    /**
     * Check if prerequisites are met for a topic
     * @param {ObjectId} userId
     * @param {string} topic
     * @param {string} subject
     * @returns {Promise<object>} { metPrerequisites: boolean, missingPrerequisites: Array }
     */
    async checkPrerequisites(userId, topic, subject = 'DSA') {
        try {
            const knowledgeState = await StudentKnowledgeState.findOne({ userId });
            if (!knowledgeState) {
                return { metPrerequisites: false, missingPrerequisites: ['any prerequisite'] };
            }

            const curriculum = CURRICULUM_GRAPHS[subject] || CURRICULUM_GRAPHS.DSA;
            const masteryConcepts = new Set(
                knowledgeState.concepts
                    ?.filter(c => c.masteryScore >= 50) // 50% for prerequisites
                    .map(c => c.conceptName.toLowerCase()) || []
            );

            const prerequisites = curriculum.topicDependencies[topic.toLowerCase()] || [];
            const missing = prerequisites.filter(
                p => !masteryConcepts.has(p.toLowerCase())
            );

            return {
                metPrerequisites: missing.length === 0,
                missingPrerequisites: missing,
                recommendedFirstSteps: missing.length > 0 
                    ? await this._getRecommendedPathToPrerequisite(missing[0], subject)
                    : []
            };
        } catch (error) {
            log.warn('LEARNING_PATH', `Failed to check prerequisites: ${error.message}`);
            return { metPrerequisites: false, missingPrerequisites: [] };
        }
    }

    /**
     * Get recommended path to a specific prerequisite
     * @private
     */
    async _getRecommendedPathToPrerequisite(topic, subject) {
        const curriculum = CURRICULUM_GRAPHS[subject] || CURRICULUM_GRAPHS.DSA;
        const prerequisites = curriculum.topicDependencies[topic.toLowerCase()] || [];

        // Return a path: prerequisite's prerequisites + prerequisite itself
        return [...prerequisites, topic];
    }

    /**
     * Save learning path to database
     * @private
     */
    async _saveLearningPath(userId, subject, path) {
        try {
            await LearningPath.findOneAndUpdate(
                { userId, subject },
                {
                    userId,
                    subject,
                    topicSequence: path,
                    lastUpdated: new Date()
                },
                { upsert: true, new: true }
            );
        } catch (error) {
            log.warn('LEARNING_PATH', `Failed to save path: ${error.message}`);
        }
    }

    /**
     * Get curriculum structure for display
     * @param {string} subject
     * @returns {object} Curriculum structure
     */
    getCurriculumStructure(subject = 'DSA') {
        return CURRICULUM_GRAPHS[subject] || CURRICULUM_GRAPHS.DSA;
    }

    /**
     * Register custom curriculum for a subject
     * @param {string} subject - Subject name
     * @param {object} curriculum - Curriculum structure
     */
    registerCurriculum(subject, curriculum) {
        CURRICULUM_GRAPHS[subject] = curriculum;
        log.info('LEARNING_PATH', `Registered curriculum for ${subject}`);
    }

    /**
     * Skip already mastered topics in a topic list
     * @param {Array} topics - Topics to filter
     * @param {Set} masteryConcepts - Mastered topic names
     * @returns {Array} Filtered topics (excluding mastered)
     */
    skipMasteredTopics(topics, masteryConcepts) {
        if (!masteryConcepts) return topics;

        return topics.filter(t => !masteryConcepts.has(t.toLowerCase()));
    }

    /**
     * Get progress percentage through curriculum
     * @param {ObjectId} userId
     * @param {string} subject
     * @returns {Promise<number>} Progress 0-100
     */
    async getProgressPercentage(userId, subject = 'DSA') {
        try {
            const knowledgeState = await StudentKnowledgeState.findOne({ userId });
            if (!knowledgeState) return 0;

            const curriculum = CURRICULUM_GRAPHS[subject] || CURRICULUM_GRAPHS.DSA;
            const totalTopics = Object.values(curriculum.modules)
                .reduce((sum, m) => sum + m.topics.length, 0);

            const masteredTopics = knowledgeState.concepts
                ?.filter(c => c.masteryScore >= 80)
                .length || 0;

            return Math.round((masteredTopics / totalTopics) * 100);
        } catch (error) {
            log.warn('LEARNING_PATH', `Failed to get progress: ${error.message}`);
            return 0;
        }
    }
}

module.exports = new LearningPathEngine();
/**
 * server/services/learningPathEngine.js
 * 
 * Learning Path Engine
 * 
 * Determines the optimal sequence of topics based on:
 * - Student's mastery of prerequisites
 * - Prior knowledge
 * - Learning speed
 * - Subject curriculum structure
 * - Student's goals
 * 
 * Does NOT follow a fixed sequence - dynamically adapts
 */

const log = require('../utils/logger');
const StudentKnowledgeState = require('../models/StudentKnowledgeState');
const LearningPath = require('../models/LearningPath');

// Generic subject curriculum structures
const CURRICULUM_GRAPHS = {
    DSA: {
        // Data Structures & Algorithms
        modules: {
            'Fundamentals': {
                topics: ['variables', 'operators', 'loops', 'conditionals', 'functions'],
                order: 0
            },
            'Data Structures': {
                topics: ['arrays', 'linked lists', 'stacks', 'queues', 'hash tables', 'trees', 'graphs'],
                order: 1,
                prerequisites: ['Fundamentals']
            },
            'Algorithms': {
                topics: ['sorting', 'searching', 'dynamic programming', 'greedy', 'backtracking'],
                order: 2,
                prerequisites: ['Data Structures']
            },
            'Advanced': {
                topics: ['segment trees', 'fenwick trees', 'tries', 'advanced graphs'],
                order: 3,
                prerequisites: ['Algorithms']
            }
        },
        topicDependencies: {
            'recursion': ['functions'],
            'binary search': ['arrays', 'sorting'],
            'dynamic programming': ['recursion'],
            'graphs': ['trees', 'adjacency lists'],
            'linked lists': ['pointers'],
            'binary trees': ['trees basics'],
            'AVL trees': ['binary trees'],
            'DFS': ['graphs', 'stacks'],
            'BFS': ['graphs', 'queues'],
        }
    },
    DBMS: {
        modules: {
            'Basics': {
                topics: ['database concepts', 'data models', 'schema design'],
                order: 0
            },
            'SQL': {
                topics: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'JOINs', 'aggregation'],
                order: 1,
                prerequisites: ['Basics']
            },
            'Advanced SQL': {
                topics: ['subqueries', 'window functions', 'stored procedures', 'transactions'],
                order: 2,
                prerequisites: ['SQL']
            },
            'Optimization': {
                topics: ['indexing', 'query optimization', 'normalization'],
                order: 3,
                prerequisites: ['Advanced SQL']
            }
        },
        topicDependencies: {
            'JOINs': ['SELECT basics'],
            'subqueries': ['SELECT basics', 'JOINs'],
            'transactions': ['UPDATE', 'DELETE'],
            'stored procedures': ['SQL basics'],
            'indexing': ['schema design'],
            'query optimization': ['indexing']
        }
    },
    // Add more subjects as needed
};

class LearningPathEngine {
    /**
     * Generate dynamic learning path for student
     * @param {ObjectId} userId - Student's user ID
     * @param {string} subject - Subject ('DSA', 'DBMS', etc.)
     * @returns {Promise<Array>} Ordered list of topics to learn
     */
    async generateLearningPath(userId, subject = 'DSA') {
        try {
            const knowledgeState = await StudentKnowledgeState.findOne({ userId });
            if (!knowledgeState) {
                return this._getDefaultPath(subject);
            }

            const curriculum = CURRICULUM_GRAPHS[subject] || CURRICULUM_GRAPHS.DSA;
            const masteryConcepts = new Set(
                knowledgeState.concepts
                    ?.filter(c => c.masteryScore >= 80)
                    .map(c => c.conceptName.toLowerCase()) || []
            );

            // Generate path based on mastery and prerequisites
            const path = this._computeDynamicPath(
                curriculum,
                masteryConcepts,
                knowledgeState
            );

            // Save to database for tracking
            await this._saveLearningPath(userId, subject, path);

            return path;
        } catch (error) {
            log.warn('LEARNING_PATH', `Failed to generate path: ${error.message}`);
            return this._getDefaultPath(subject);
        }
    }

    /**
     * Compute dynamic path based on current mastery
     * @private
     */
    _computeDynamicPath(curriculum, masteryConcepts, knowledgeState) {
        const path = [];
        const visited = new Set();

        // Get all topics from curriculum
        const allTopics = [];
        for (const module of Object.values(curriculum.modules)) {
            allTopics.push(...module.topics);
        }

        // Topic to check: those not yet mastered
        const unmastered = allTopics.filter(t => !masteryConcepts.has(t.toLowerCase()));

        // Sort by prerequisites: topics with no unmet prerequisites come first
        const sorted = this._topologicalSort(
            unmastered,
            curriculum.topicDependencies,
            masteryConcepts
        );

        return sorted;
    }

    /**
     * Topological sort: topics with met prerequisites first
     * @private
     */
    _topologicalSort(topics, dependencies, masteryConcepts) {
        const sorted = [];
        const inProgress = new Set();
        const done = new Set(masteryConcepts);

        const visit = (topic) => {
            if (done.has(topic.toLowerCase())) return;
            if (inProgress.has(topic.toLowerCase())) return; // Cycle detected

            inProgress.add(topic.toLowerCase());

            // Visit prerequisites first
            const deps = dependencies[topic.toLowerCase()] || [];
            for (const dep of deps) {
                visit(dep);
            }

            inProgress.delete(topic.toLowerCase());
            done.add(topic.toLowerCase());
            sorted.push(topic);
        };

        for (const topic of topics) {
            visit(topic);
        }

        return sorted;
    }

    /**
     * Get default path for subject
     * @private
     */
    _getDefaultPath(subject) {
        const curriculum = CURRICULUM_GRAPHS[subject] || CURRICULUM_GRAPHS.DSA;
        const path = [];

        const modules = Object.values(curriculum.modules)
            .sort((a, b) => a.order - b.order);

        for (const module of modules) {
            path.push(...module.topics);
        }

        return path;
    }

    /**
     * Get next recommended topic for student
     * @param {ObjectId} userId
     * @param {string} subject
     * @returns {Promise<string>} Next topic to study
     */
    async getNextTopic(userId, subject = 'DSA') {
        try {
            const path = await this.generateLearningPath(userId, subject);
            if (path.length === 0) {
                return 'Challenge: Advanced Problems'; // All topics mastered
            }

            // First topic in path is the next one
            return path[0];
        } catch (error) {
            log.warn('LEARNING_PATH', `Failed to get next topic: ${error.message}`);
            return 'arrays'; // Safe default
        }
    }

    /**
     * Get multiple next topics to recommend
     * @param {ObjectId} userId
     * @param {string} subject
     * @param {number} count - Number of topics to return
     * @returns {Promise<Array>}
     */
    async getNextTopics(userId, subject = 'DSA', count = 5) {
        try {
            const path = await this.generateLearningPath(userId, subject);
            return path.slice(0, count);
        } catch (error) {
            log.warn('LEARNING_PATH', `Failed to get next topics: ${error.message}`);
            return ['arrays', 'linked lists', 'stacks', 'queues', 'trees'];
        }
    }

    /**
     * Check if prerequisites are met for a topic
     * @param {ObjectId} userId
     * @param {string} topic
     * @param {string} subject
     * @returns {Promise<object>} { metPrerequisites: boolean, missingPrerequisites: Array }
     */
    async checkPrerequisites(userId, topic, subject = 'DSA') {
        try {
            const knowledgeState = await StudentKnowledgeState.findOne({ userId });
            if (!knowledgeState) {
                return { metPrerequisites: false, missingPrerequisites: ['any prerequisite'] };
            }

            const curriculum = CURRICULUM_GRAPHS[subject] || CURRICULUM_GRAPHS.DSA;
            const masteryConcepts = new Set(
                knowledgeState.concepts
                    ?.filter(c => c.masteryScore >= 50) // 50% for prerequisites
                    .map(c => c.conceptName.toLowerCase()) || []
            );

            const prerequisites = curriculum.topicDependencies[topic.toLowerCase()] || [];
            const missing = prerequisites.filter(
                p => !masteryConcepts.has(p.toLowerCase())
            );

            return {
                metPrerequisites: missing.length === 0,
                missingPrerequisites: missing,
                recommendedFirstSteps: missing.length > 0 
                    ? await this._getRecommendedPathToPrerequisite(missing[0], subject)
                    : []
            };
        } catch (error) {
            log.warn('LEARNING_PATH', `Failed to check prerequisites: ${error.message}`);
            return { metPrerequisites: false, missingPrerequisites: [] };
        }
    }

    /**
     * Get recommended path to a specific prerequisite
     * @private
     */
    async _getRecommendedPathToPrerequisite(topic, subject) {
        const curriculum = CURRICULUM_GRAPHS[subject] || CURRICULUM_GRAPHS.DSA;
        const prerequisites = curriculum.topicDependencies[topic.toLowerCase()] || [];

        // Return a path: prerequisite's prerequisites + prerequisite itself
        return [...prerequisites, topic];
    }

    /**
     * Save learning path to database
     * @private
     */
    async _saveLearningPath(userId, subject, path) {
        try {
            await LearningPath.findOneAndUpdate(
                { userId, subject },
                {
                    userId,
                    subject,
                    topicSequence: path,
                    lastUpdated: new Date()
                },
                { upsert: true, new: true }
            );
        } catch (error) {
            log.warn('LEARNING_PATH', `Failed to save path: ${error.message}`);
        }
    }

    /**
     * Get curriculum structure for display
     * @param {string} subject
     * @returns {object} Curriculum structure
     */
    getCurriculumStructure(subject = 'DSA') {
        return CURRICULUM_GRAPHS[subject] || CURRICULUM_GRAPHS.DSA;
    }

    /**
     * Register custom curriculum for a subject
     * @param {string} subject - Subject name
     * @param {object} curriculum - Curriculum structure
     */
    registerCurriculum(subject, curriculum) {
        CURRICULUM_GRAPHS[subject] = curriculum;
        log.info('LEARNING_PATH', `Registered curriculum for ${subject}`);
    }

    /**
     * Skip already mastered topics in a topic list
     * @param {Array} topics - Topics to filter
     * @param {Set} masteryConcepts - Mastered topic names
     * @returns {Array} Filtered topics (excluding mastered)
     */
    skipMasteredTopics(topics, masteryConcepts) {
        if (!masteryConcepts) return topics;

        return topics.filter(t => !masteryConcepts.has(t.toLowerCase()));
    }

    /**
     * Get progress percentage through curriculum
     * @param {ObjectId} userId
     * @param {string} subject
     * @returns {Promise<number>} Progress 0-100
     */
    async getProgressPercentage(userId, subject = 'DSA') {
        try {
            const knowledgeState = await StudentKnowledgeState.findOne({ userId });
            if (!knowledgeState) return 0;

            const curriculum = CURRICULUM_GRAPHS[subject] || CURRICULUM_GRAPHS.DSA;
            const totalTopics = Object.values(curriculum.modules)
                .reduce((sum, m) => sum + m.topics.length, 0);

            const masteredTopics = knowledgeState.concepts
                ?.filter(c => c.masteryScore >= 80)
                .length || 0;

            return Math.round((masteredTopics / totalTopics) * 100);
        } catch (error) {
            log.warn('LEARNING_PATH', `Failed to get progress: ${error.message}`);
            return 0;
        }
    }
}

module.exports = new LearningPathEngine();
