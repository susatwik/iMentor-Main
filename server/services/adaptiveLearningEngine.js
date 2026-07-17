/**
 * server/services/adaptiveLearningEngine.js
 * 
 * Adaptive Learning Engine
 * 
 * Decides whether to:
 * - TEACH (introduce/reteach a topic)
 * - REVIEW (reinforce known material)
 * - ADVANCE (move to harder material)
 * - SKIP (already mastered, move to next topic)
 * 
 * Uses mastery scores, learning speed, and student history to make decisions
 */

const log = require('../utils/logger');
const StudentKnowledgeState = require('../models/StudentKnowledgeState');
const learningSpeedDetector = require('./learningSpeedDetector');

const ADAPTIVE_ACTIONS = {
    TEACH: 'TEACH',
    REVIEW: 'REVIEW',
    ADVANCE: 'ADVANCE',
    SKIP: 'SKIP',
    CHALLENGE: 'CHALLENGE', // For fast learners - give challenging problems
    RETEACH: 'RETEACH', // For struggling students - reteach fundamentals
};

class AdaptiveLearningEngine {
    /**
     * Determine adaptive action for a topic
     * @param {ObjectId} userId - Student's user ID
     * @param {string} topic - Topic to assess
     * @param {string} learningSpeed - 'slow_methodical' | 'moderate' | 'fast_paced' | 'variable'
     * @returns {Promise<object>} { action, reasoning, masteryScore, recommendation }
     */
    async determineAction(userId, topic, learningSpeed) {
        try {
            const knowledgeState = await StudentKnowledgeState.findOne({ userId });
            if (!knowledgeState) {
                return {
                    action: ADAPTIVE_ACTIONS.TEACH,
                    reasoning: 'No knowledge state found - starting fresh',
                    masteryScore: 0,
                    recommendation: 'Introduce topic from fundamentals'
                };
            }

            // Find concept in knowledge state
            const concept = knowledgeState.concepts?.find(
                c => c.conceptName.toLowerCase() === topic.toLowerCase()
            );

            // If not in knowledge state, it's new
            if (!concept) {
                return {
                    action: ADAPTIVE_ACTIONS.TEACH,
                    reasoning: 'Topic not yet introduced',
                    masteryScore: 0,
                    recommendation: 'Introduce topic with foundational concepts',
                    prerequisites: await this._getPrerequisiteConcepts(topic)
                };
            }

            // Mastery-based decision
            const masteryScore = concept.masteryScore || 0;

            // Speed-adjusted thresholds
            const thresholds = this._getThresholds(learningSpeed);

            if (masteryScore >= thresholds.skip) {
                // Topic is mastered
                return {
                    action: ADAPTIVE_ACTIONS.SKIP,
                    reasoning: `Mastery score (${masteryScore}) exceeds skip threshold (${thresholds.skip})`,
                    masteryScore,
                    recommendation: 'Move to next topic - this one is mastered',
                    nextTopics: await this._getNextTopics(knowledgeState, topic)
                };
            }

            if (masteryScore >= thresholds.advance) {
                // Ready to advance
                return {
                    action: ADAPTIVE_ACTIONS.ADVANCE,
                    reasoning: `Mastery score (${masteryScore}) is ready for advancement`,
                    masteryScore,
                    recommendation: 'Brief review then move to advanced concepts',
                    advancedConcepts: await this._getAdvancedConcepts(topic)
                };
            }

            if (masteryScore >= thresholds.review) {
                // Need review
                return {
                    action: ADAPTIVE_ACTIONS.REVIEW,
                    reasoning: `Mastery score (${masteryScore}) needs reinforcement`,
                    masteryScore,
                    recommendation: 'Provide targeted review of weak areas',
                    weakAreas: concept.weaknesses || []
                };
            }

            if (masteryScore < thresholds.reteach) {
                // Need fundamental reteaching
                return {
                    action: ADAPTIVE_ACTIONS.RETEACH,
                    reasoning: `Mastery score (${masteryScore}) is critically low`,
                    masteryScore,
                    recommendation: 'Reteach fundamentals with concrete examples',
                    struggledWith: concept.struggledWith || [],
                    misconceptions: concept.misconceptions || []
                };
            }

            // Default: teach/practice
            return {
                action: ADAPTIVE_ACTIONS.TEACH,
                reasoning: `Mastery score (${masteryScore}) indicates learning phase`,
                masteryScore,
                recommendation: 'Continue teaching with practice examples',
                currentFocus: concept.weaknesses?.slice(0, 2) || []
            };
        } catch (error) {
            log.warn('ADAPTIVE_ENGINE', `Failed to determine action: ${error.message}`);
            return {
                action: ADAPTIVE_ACTIONS.TEACH,
                reasoning: `Error: ${error.message}`,
                masteryScore: 0,
                recommendation: 'Default to teaching approach'
            };
        }
    }

    /**
     * Get speed-adjusted mastery thresholds
     * @private
     */
    _getThresholds(learningSpeed) {
        const baseThresholds = {
            skip: 80,        // Skip mastered topics
            advance: 65,     // Ready for next level
            review: 40,      // Needs reinforcement
            reteach: 20      // Needs fundamental reteaching
        };

        // Adjust based on learning speed
        switch (learningSpeed) {
            case 'fast_paced':
                // Fast learners need higher thresholds to move on
                return {
                    skip: 75,      // Can skip at 75% (confident)
                    advance: 55,   // Move quickly to advanced
                    review: 30,    // Skip reviews they don't need
                    reteach: 10    // Only reteach if critically low
                };
            case 'slow_methodical':
                // Slow learners should achieve higher mastery before advancing
                return {
                    skip: 85,      // Higher threshold to ensure mastery
                    advance: 70,   // More conservative advancement
                    review: 50,    // Frequent review threshold
                    reteach: 30    // Reteach earlier
                };
            case 'variable':
                // Variable learners - use balanced thresholds
                return {
                    skip: 80,
                    advance: 60,
                    review: 40,
                    reteach: 25
                };
            default: // moderate
                return baseThresholds;
        }
    }

    /**
     * Get prerequisite concepts for a topic
     * @private
     */
    async _getPrerequisiteConcepts(topic) {
        // This would ideally query a curriculum graph
        // For now, return common prerequisites by topic
        const prerequisites = {
            'recursion': ['functions', 'base cases', 'call stack'],
            'binary search': ['arrays', 'sorting', 'time complexity'],
            'dynamic programming': ['recursion', 'memoization', 'optimization'],
            'graphs': ['trees', 'adjacency matrix', 'traversal'],
            'linked lists': ['pointers', 'memory allocation', 'data structures basics'],
        };

        const topicLower = topic.toLowerCase();
        for (const [key, prereqs] of Object.entries(prerequisites)) {
            if (topicLower.includes(key.toLowerCase())) {
                return prereqs;
            }
        }

        return [];
    }

    /**
     * Get next recommended topics based on current mastery
     * @private
     */
    async _getNextTopics(knowledgeState, currentTopic) {
        // Find concepts with mastery >= 70 (ready for advancement)
        const readyTopics = knowledgeState.concepts
            ?.filter(c => c.masteryScore >= 70 && c.conceptName !== currentTopic)
            .map(c => c.conceptName)
            .slice(0, 3) || [];

        // Find concepts that build on current one
        // This would use curriculum graph in a full implementation
        const relatedTopics = knowledgeState.concepts
            ?.filter(c => {
                const relates = c.relatedConcepts?.find(
                    r => r.conceptName === currentTopic && 
                    (r.relationship === 'builds_on' || r.relationship === 'related_to')
                );
                return relates;
            })
            .map(c => c.conceptName)
            .slice(0, 3) || [];

        return [...readyTopics, ...relatedTopics].slice(0, 3);
    }

    /**
     * Get advanced concepts that build on the current topic
     * @private
     */
    async _getAdvancedConcepts(topic) {
        const advancedMap = {
            'arrays': ['2D arrays', 'array rotation', 'sliding window'],
            'linked lists': ['circular linked lists', 'doubly linked lists', 'LRU cache'],
            'stacks': ['monotonic stack', 'expression evaluation', 'backtracking'],
            'recursion': ['backtracking', 'divide and conquer', 'dynamic programming'],
            'trees': ['AVL trees', 'Red-Black trees', 'segment trees'],
            'graphs': ['strongly connected components', 'minimum spanning tree', 'topological sort'],
        };

        const topicLower = topic.toLowerCase();
        for (const [key, advanced] of Object.entries(advancedMap)) {
            if (topicLower.includes(key.toLowerCase())) {
                return advanced;
            }
        }

        return ['Advanced variations', 'Real-world applications'];
    }

    /**
     * Get detailed adaptive plan for a learning session
     * @param {ObjectId} userId
     * @param {string} topic
     * @returns {Promise<object>} Detailed adaptive plan
     */
    async getAdaptivePlan(userId, topic) {
        try {
            const knowledgeState = await StudentKnowledgeState.findOne({ userId });
            const speedWithConfidence = await learningSpeedDetector.getSpeedWithConfidence(userId);
            const speed = speedWithConfidence.speed;

            const action = await this.determineAction(userId, topic, speed);
            const speedParams = learningSpeedDetector.getAdaptiveParameters(speed);

            return {
                topic,
                action: action.action,
                reasoning: action.reasoning,
                masteryScore: action.masteryScore,
                learningSpeed: speed,
                speedConfidence: speedWithConfidence.confidence,
                adaptiveParameters: speedParams,
                recommendation: action.recommendation,
                nextSteps: this._planNextSteps(action.action, speedParams),
                additionalInfo: {
                    prerequisites: action.prerequisites,
                    advancedConcepts: action.advancedConcepts,
                    weakAreas: action.weakAreas,
                    misconceptions: action.misconceptions
                }
            };
        } catch (error) {
            log.warn('ADAPTIVE_ENGINE', `Failed to get adaptive plan: ${error.message}`);
            return {
                topic,
                action: ADAPTIVE_ACTIONS.TEACH,
                reasoning: `Error: ${error.message}`,
                recommendation: 'Default teaching approach'
            };
        }
    }

    /**
     * Plan next steps based on action
     * @private
     */
    _planNextSteps(action, speedParams) {
        const stepPlans = {
            [ADAPTIVE_ACTIONS.TEACH]: [
                'Introduce the concept',
                `Provide ${speedParams.examplesPerConcept} concrete examples`,
                `Allow ${speedParams.practiceRounds} practice rounds`,
                'Check understanding before moving on'
            ],
            [ADAPTIVE_ACTIONS.REVIEW]: [
                'Remind of key concepts',
                'Address weak areas identified',
                'Practice problem focusing on gaps',
                'Quick assessment'
            ],
            [ADAPTIVE_ACTIONS.ADVANCE]: [
                'Brief review of prerequisites',
                'Introduce advanced concepts',
                'Provide application examples',
                'Challenging practice problems'
            ],
            [ADAPTIVE_ACTIONS.SKIP]: [
                'Move to next topic',
                'Preserve session momentum',
                'Possibly provide an extension challenge'
            ],
            [ADAPTIVE_ACTIONS.RETEACH]: [
                'Identify misconceptions',
                'Start with concrete fundamentals',
                `Provide ${Math.max(speedParams.examplesPerConcept, 4)} varied examples`,
                'Slow down pace significantly',
                'More frequent checks for understanding'
            ],
            [ADAPTIVE_ACTIONS.CHALLENGE]: [
                'Present challenging problems',
                'Minimal scaffolding',
                'Let student struggle productively',
                'Provide hints only if stuck after effort'
            ]
        };

        return stepPlans[action] || stepPlans[ADAPTIVE_ACTIONS.TEACH];
    }

    /**
     * Check if student is ready to skip a topic based on mastery
     * @param {ObjectId} userId
     * @param {string} topic
     * @returns {Promise<boolean>}
     */
    async isTopicMastered(userId, topic) {
        try {
            const knowledgeState = await StudentKnowledgeState.findOne({ userId });
            if (!knowledgeState) return false;

            const concept = knowledgeState.concepts?.find(
                c => c.conceptName.toLowerCase() === topic.toLowerCase()
            );

            if (!concept) return false;

            return (concept.masteryScore || 0) >= 80;
        } catch (error) {
            log.warn('ADAPTIVE_ENGINE', `Failed to check mastery: ${error.message}`);
            return false;
        }
    }

    /**
     * Get topics that should be skipped in current session
     * @param {ObjectId} userId
     * @param {Array} suggestedTopics - Topics being considered
     * @returns {Promise<Array>} Topics that can be safely skipped
     */
    async getTopicsToSkip(userId, suggestedTopics) {
        try {
            const toSkip = [];

            for (const topic of suggestedTopics) {
                const isMastered = await this.isTopicMastered(userId, topic);
                if (isMastered) {
                    toSkip.push(topic);
                }
            }

            return toSkip;
        } catch (error) {
            log.warn('ADAPTIVE_ENGINE', `Failed to get skip topics: ${error.message}`);
            return [];
        }
    }
}

module.exports = new AdaptiveLearningEngine();

/**
 * server/services/adaptiveLearningEngine.js
 * 
 * Adaptive Learning Engine
 * 
 * Decides whether to:
 * - TEACH (introduce/reteach a topic)
 * - REVIEW (reinforce known material)
 * - ADVANCE (move to harder material)
 * - SKIP (already mastered, move to next topic)
 * 
 * Uses mastery scores, learning speed, and student history to make decisions
 */

const log = require('../utils/logger');
const StudentKnowledgeState = require('../models/StudentKnowledgeState');
const learningSpeedDetector = require('./learningSpeedDetector');

const ADAPTIVE_ACTIONS = {
    TEACH: 'TEACH',
    REVIEW: 'REVIEW',
    ADVANCE: 'ADVANCE',
    SKIP: 'SKIP',
    CHALLENGE: 'CHALLENGE', // For fast learners - give challenging problems
    RETEACH: 'RETEACH', // For struggling students - reteach fundamentals
};

class AdaptiveLearningEngine {
    /**
     * Determine adaptive action for a topic
     * @param {ObjectId} userId - Student's user ID
     * @param {string} topic - Topic to assess
     * @param {string} learningSpeed - 'slow_methodical' | 'moderate' | 'fast_paced' | 'variable'
     * @returns {Promise<object>} { action, reasoning, masteryScore, recommendation }
     */
    async determineAction(userId, topic, learningSpeed) {
        try {
            const knowledgeState = await StudentKnowledgeState.findOne({ userId });
            if (!knowledgeState) {
                return {
                    action: ADAPTIVE_ACTIONS.TEACH,
                    reasoning: 'No knowledge state found - starting fresh',
                    masteryScore: 0,
                    recommendation: 'Introduce topic from fundamentals'
                };
            }

            // Find concept in knowledge state
            const concept = knowledgeState.concepts?.find(
                c => c.conceptName.toLowerCase() === topic.toLowerCase()
            );

            // If not in knowledge state, it's new
            if (!concept) {
                return {
                    action: ADAPTIVE_ACTIONS.TEACH,
                    reasoning: 'Topic not yet introduced',
                    masteryScore: 0,
                    recommendation: 'Introduce topic with foundational concepts',
                    prerequisites: await this._getPrerequisiteConcepts(topic)
                };
            }

            // Mastery-based decision
            const masteryScore = concept.masteryScore || 0;

            // Speed-adjusted thresholds
            const thresholds = this._getThresholds(learningSpeed);

            if (masteryScore >= thresholds.skip) {
                // Topic is mastered
                return {
                    action: ADAPTIVE_ACTIONS.SKIP,
                    reasoning: `Mastery score (${masteryScore}) exceeds skip threshold (${thresholds.skip})`,
                    masteryScore,
                    recommendation: 'Move to next topic - this one is mastered',
                    nextTopics: await this._getNextTopics(knowledgeState, topic)
                };
            }

            if (masteryScore >= thresholds.advance) {
                // Ready to advance
                return {
                    action: ADAPTIVE_ACTIONS.ADVANCE,
                    reasoning: `Mastery score (${masteryScore}) is ready for advancement`,
                    masteryScore,
                    recommendation: 'Brief review then move to advanced concepts',
                    advancedConcepts: await this._getAdvancedConcepts(topic)
                };
            }

            if (masteryScore >= thresholds.review) {
                // Need review
                return {
                    action: ADAPTIVE_ACTIONS.REVIEW,
                    reasoning: `Mastery score (${masteryScore}) needs reinforcement`,
                    masteryScore,
                    recommendation: 'Provide targeted review of weak areas',
                    weakAreas: concept.weaknesses || []
                };
            }

            if (masteryScore < thresholds.reteach) {
                // Need fundamental reteaching
                return {
                    action: ADAPTIVE_ACTIONS.RETEACH,
                    reasoning: `Mastery score (${masteryScore}) is critically low`,
                    masteryScore,
                    recommendation: 'Reteach fundamentals with concrete examples',
                    struggledWith: concept.struggledWith || [],
                    misconceptions: concept.misconceptions || []
                };
            }

            // Default: teach/practice
            return {
                action: ADAPTIVE_ACTIONS.TEACH,
                reasoning: `Mastery score (${masteryScore}) indicates learning phase`,
                masteryScore,
                recommendation: 'Continue teaching with practice examples',
                currentFocus: concept.weaknesses?.slice(0, 2) || []
            };
        } catch (error) {
            log.warn('ADAPTIVE_ENGINE', `Failed to determine action: ${error.message}`);
            return {
                action: ADAPTIVE_ACTIONS.TEACH,
                reasoning: `Error: ${error.message}`,
                masteryScore: 0,
                recommendation: 'Default to teaching approach'
            };
        }
    }

    /**
     * Get speed-adjusted mastery thresholds
     * @private
     */
    _getThresholds(learningSpeed) {
        const baseThresholds = {
            skip: 80,        // Skip mastered topics
            advance: 65,     // Ready for next level
            review: 40,      // Needs reinforcement
            reteach: 20      // Needs fundamental reteaching
        };

        // Adjust based on learning speed
        switch (learningSpeed) {
            case 'fast_paced':
                // Fast learners need higher thresholds to move on
                return {
                    skip: 75,      // Can skip at 75% (confident)
                    advance: 55,   // Move quickly to advanced
                    review: 30,    // Skip reviews they don't need
                    reteach: 10    // Only reteach if critically low
                };
            case 'slow_methodical':
                // Slow learners should achieve higher mastery before advancing
                return {
                    skip: 85,      // Higher threshold to ensure mastery
                    advance: 70,   // More conservative advancement
                    review: 50,    // Frequent review threshold
                    reteach: 30    // Reteach earlier
                };
            case 'variable':
                // Variable learners - use balanced thresholds
                return {
                    skip: 80,
                    advance: 60,
                    review: 40,
                    reteach: 25
                };
            default: // moderate
                return baseThresholds;
        }
    }

    /**
     * Get prerequisite concepts for a topic
     * @private
     */
    async _getPrerequisiteConcepts(topic) {
        // This would ideally query a curriculum graph
        // For now, return common prerequisites by topic
        const prerequisites = {
            'recursion': ['functions', 'base cases', 'call stack'],
            'binary search': ['arrays', 'sorting', 'time complexity'],
            'dynamic programming': ['recursion', 'memoization', 'optimization'],
            'graphs': ['trees', 'adjacency matrix', 'traversal'],
            'linked lists': ['pointers', 'memory allocation', 'data structures basics'],
        };

        const topicLower = topic.toLowerCase();
        for (const [key, prereqs] of Object.entries(prerequisites)) {
            if (topicLower.includes(key.toLowerCase())) {
                return prereqs;
            }
        }

        return [];
    }

    /**
     * Get next recommended topics based on current mastery
     * @private
     */
    async _getNextTopics(knowledgeState, currentTopic) {
        // Find concepts with mastery >= 70 (ready for advancement)
        const readyTopics = knowledgeState.concepts
            ?.filter(c => c.masteryScore >= 70 && c.conceptName !== currentTopic)
            .map(c => c.conceptName)
            .slice(0, 3) || [];

        // Find concepts that build on current one
        // This would use curriculum graph in a full implementation
        const relatedTopics = knowledgeState.concepts
            ?.filter(c => {
                const relates = c.relatedConcepts?.find(
                    r => r.conceptName === currentTopic && 
                    (r.relationship === 'builds_on' || r.relationship === 'related_to')
                );
                return relates;
            })
            .map(c => c.conceptName)
            .slice(0, 3) || [];

        return [...readyTopics, ...relatedTopics].slice(0, 3);
    }

    /**
     * Get advanced concepts that build on the current topic
     * @private
     */
    async _getAdvancedConcepts(topic) {
        const advancedMap = {
            'arrays': ['2D arrays', 'array rotation', 'sliding window'],
            'linked lists': ['circular linked lists', 'doubly linked lists', 'LRU cache'],
            'stacks': ['monotonic stack', 'expression evaluation', 'backtracking'],
            'recursion': ['backtracking', 'divide and conquer', 'dynamic programming'],
            'trees': ['AVL trees', 'Red-Black trees', 'segment trees'],
            'graphs': ['strongly connected components', 'minimum spanning tree', 'topological sort'],
        };

        const topicLower = topic.toLowerCase();
        for (const [key, advanced] of Object.entries(advancedMap)) {
            if (topicLower.includes(key.toLowerCase())) {
                return advanced;
            }
        }

        return ['Advanced variations', 'Real-world applications'];
    }

    /**
     * Get detailed adaptive plan for a learning session
     * @param {ObjectId} userId
     * @param {string} topic
     * @returns {Promise<object>} Detailed adaptive plan
     */
    async getAdaptivePlan(userId, topic) {
        try {
            const knowledgeState = await StudentKnowledgeState.findOne({ userId });
            const speedWithConfidence = await learningSpeedDetector.getSpeedWithConfidence(userId);
            const speed = speedWithConfidence.speed;

            const action = await this.determineAction(userId, topic, speed);
            const speedParams = learningSpeedDetector.getAdaptiveParameters(speed);

            return {
                topic,
                action: action.action,
                reasoning: action.reasoning,
                masteryScore: action.masteryScore,
                learningSpeed: speed,
                speedConfidence: speedWithConfidence.confidence,
                adaptiveParameters: speedParams,
                recommendation: action.recommendation,
                nextSteps: this._planNextSteps(action.action, speedParams),
                additionalInfo: {
                    prerequisites: action.prerequisites,
                    advancedConcepts: action.advancedConcepts,
                    weakAreas: action.weakAreas,
                    misconceptions: action.misconceptions
                }
            };
        } catch (error) {
            log.warn('ADAPTIVE_ENGINE', `Failed to get adaptive plan: ${error.message}`);
            return {
                topic,
                action: ADAPTIVE_ACTIONS.TEACH,
                reasoning: `Error: ${error.message}`,
                recommendation: 'Default teaching approach'
            };
        }
    }

    /**
     * Plan next steps based on action
     * @private
     */
    _planNextSteps(action, speedParams) {
        const stepPlans = {
            [ADAPTIVE_ACTIONS.TEACH]: [
                'Introduce the concept',
                `Provide ${speedParams.examplesPerConcept} concrete examples`,
                `Allow ${speedParams.practiceRounds} practice rounds`,
                'Check understanding before moving on'
            ],
            [ADAPTIVE_ACTIONS.REVIEW]: [
                'Remind of key concepts',
                'Address weak areas identified',
                'Practice problem focusing on gaps',
                'Quick assessment'
            ],
            [ADAPTIVE_ACTIONS.ADVANCE]: [
                'Brief review of prerequisites',
                'Introduce advanced concepts',
                'Provide application examples',
                'Challenging practice problems'
            ],
            [ADAPTIVE_ACTIONS.SKIP]: [
                'Move to next topic',
                'Preserve session momentum',
                'Possibly provide an extension challenge'
            ],
            [ADAPTIVE_ACTIONS.RETEACH]: [
                'Identify misconceptions',
                'Start with concrete fundamentals',
                `Provide ${Math.max(speedParams.examplesPerConcept, 4)} varied examples`,
                'Slow down pace significantly',
                'More frequent checks for understanding'
            ],
            [ADAPTIVE_ACTIONS.CHALLENGE]: [
                'Present challenging problems',
                'Minimal scaffolding',
                'Let student struggle productively',
                'Provide hints only if stuck after effort'
            ]
        };

        return stepPlans[action] || stepPlans[ADAPTIVE_ACTIONS.TEACH];
    }

    /**
     * Check if student is ready to skip a topic based on mastery
     * @param {ObjectId} userId
     * @param {string} topic
     * @returns {Promise<boolean>}
     */
    async isTopicMastered(userId, topic) {
        try {
            const knowledgeState = await StudentKnowledgeState.findOne({ userId });
            if (!knowledgeState) return false;

            const concept = knowledgeState.concepts?.find(
                c => c.conceptName.toLowerCase() === topic.toLowerCase()
            );

            if (!concept) return false;

            return (concept.masteryScore || 0) >= 80;
        } catch (error) {
            log.warn('ADAPTIVE_ENGINE', `Failed to check mastery: ${error.message}`);
            return false;
        }
    }

    /**
     * Get topics that should be skipped in current session
     * @param {ObjectId} userId
     * @param {Array} suggestedTopics - Topics being considered
     * @returns {Promise<Array>} Topics that can be safely skipped
     */
    async getTopicsToSkip(userId, suggestedTopics) {
        try {
            const toSkip = [];

            for (const topic of suggestedTopics) {
                const isMastered = await this.isTopicMastered(userId, topic);
                if (isMastered) {
                    toSkip.push(topic);
                }
            }

            return toSkip;
        } catch (error) {
            log.warn('ADAPTIVE_ENGINE', `Failed to get skip topics: ${error.message}`);
            return [];
        }
    }
}

module.exports = new AdaptiveLearningEngine();
