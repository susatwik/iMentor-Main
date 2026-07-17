/**
 * server/services/learningSpeedDetector.js
 * 
 * Learning Speed Detector Service
 * 
 * Classifies students as slow, medium, or fast learners based on:
 * - Correct answers per concept
 * - Repeated mistakes (indicates slower pace)
 * - Speed of concept mastery
 * - Session engagement patterns
 * 
 * Dynamically adjusts classification as more data arrives
 */

const log = require('../utils/logger');
const StudentKnowledgeState = require('../models/StudentKnowledgeState');
const StudentLearningProfile = require('../models/StudentLearningProfile');

// Speed classification thresholds
const SPEED_THRESHOLDS = {
    FAST: {
        averageInteractionsPerConcept: 3, // Masters concepts in ~3 interactions
        masteryScoreGrowthRate: 20, // Gains ~20 points per interaction
        correctAnswerRatio: 0.85, // 85% correct answers
        sessionsToMastery: 2 // Achieves mastery in ~2 sessions
    },
    MEDIUM: {
        averageInteractionsPerConcept: 5, // ~5 interactions
        masteryScoreGrowthRate: 12, // ~12 points per interaction
        correctAnswerRatio: 0.70, // 70% correct
        sessionsToMastery: 4 // ~4 sessions
    },
    SLOW: {
        averageInteractionsPerConcept: 8, // ~8 interactions
        masteryScoreGrowthRate: 5, // ~5 points per interaction
        correctAnswerRatio: 0.55, // 55% correct
        sessionsToMastery: 6 // ~6 sessions
    }
};

const SPEED_CLASSIFICATIONS = {
    SLOW_METHODICAL: 'slow_methodical',
    MEDIUM: 'moderate',
    FAST_PACED: 'fast_paced',
    VARIABLE: 'variable'
};

class LearningSpeedDetector {
    constructor() {
        this.classificationCache = new Map();
    }

    /**
     * Detect current learning speed for a student
     * @param {ObjectId} userId - Student's user ID
     * @returns {Promise<string>} Speed classification: 'slow_methodical' | 'moderate' | 'fast_paced' | 'variable'
     */
    async detectLearningSpeed(userId) {
        try {
            // Check cache first
            const cached = this.classificationCache.get(userId.toString());
            if (cached && Date.now() - cached.timestamp < 3600000) { // 1 hour cache
                return cached.speed;
            }

            const knowledgeState = await StudentKnowledgeState.findOne({ userId });
            if (!knowledgeState || !knowledgeState.concepts || knowledgeState.concepts.length === 0) {
                return SPEED_CLASSIFICATIONS.MEDIUM; // Default for new students
            }

            const metrics = this._calculateSpeedMetrics(knowledgeState);
            const speed = this._classifySpeed(metrics);

            // Cache the result
            this.classificationCache.set(userId.toString(), {
                speed,
                timestamp: Date.now(),
                metrics
            });

            log.info('LEARNING_SPEED', `Student ${userId}: ${speed} (metrics: ${JSON.stringify(metrics)})`);

            return speed;
        } catch (error) {
            log.warn('LEARNING_SPEED', `Failed to detect speed for ${userId}: ${error.message}`);
            return SPEED_CLASSIFICATIONS.MEDIUM;
        }
    }

    /**
     * Calculate speed metrics from student's knowledge state
     * @private
     */
    _calculateSpeedMetrics(knowledgeState) {
        const concepts = knowledgeState.concepts || [];
        
        if (concepts.length === 0) {
            return {
                averageInteractionsPerConcept: 0,
                averageGrowthRate: 0,
                averageCorrectRatio: 0,
                masteryCount: 0,
                totalInteractions: 0
            };
        }

        // Calculate average interactions per concept
        const totalInteractions = concepts.reduce((sum, c) => sum + (c.totalInteractions || 0), 0);
        const averageInteractionsPerConcept = totalInteractions / concepts.length;

        // Calculate mastery growth rate (average learning velocity)
        const growthRates = concepts
            .filter(c => c.learningVelocity !== undefined)
            .map(c => c.learningVelocity || 0);
        const averageGrowthRate = growthRates.length > 0 
            ? growthRates.reduce((a, b) => a + b, 0) / growthRates.length 
            : 0;

        // Calculate success ratio
        const successfulInteractions = concepts.reduce((sum, c) => sum + (c.successfulInteractions || 0), 0);
        const averageCorrectRatio = totalInteractions > 0 ? successfulInteractions / totalInteractions : 0;

        // Count mastered concepts
        const masteryCount = concepts.filter(c => c.masteryScore >= 80).length;

        return {
            averageInteractionsPerConcept: Math.round(averageInteractionsPerConcept * 10) / 10,
            averageGrowthRate: Math.round(averageGrowthRate * 10) / 10,
            averageCorrectRatio: Math.round(averageCorrectRatio * 100) / 100,
            masteryCount,
            totalInteractions,
            totalConcepts: concepts.length
        };
    }

    /**
     * Classify speed based on calculated metrics
     * @private
     */
    _classifySpeed(metrics) {
        const {
            averageInteractionsPerConcept,
            averageGrowthRate,
            averageCorrectRatio
        } = metrics;

        // Calculate distance from each speed profile
        const distances = {};

        distances.fast = this._calculateDistance(
            averageInteractionsPerConcept,
            averageGrowthRate,
            averageCorrectRatio,
            SPEED_THRESHOLDS.FAST
        );

        distances.medium = this._calculateDistance(
            averageInteractionsPerConcept,
            averageGrowthRate,
            averageCorrectRatio,
            SPEED_THRESHOLDS.MEDIUM
        );

        distances.slow = this._calculateDistance(
            averageInteractionsPerConcept,
            averageGrowthRate,
            averageCorrectRatio,
            SPEED_THRESHOLDS.SLOW
        );

        // Check for variability (inconsistent patterns)
        const variance = this._calculateVariance(metrics);
        if (variance > 0.4) {
            return SPEED_CLASSIFICATIONS.VARIABLE;
        }

        // Find closest profile
        let closestProfile = 'fast';
        let minDistance = distances.fast;

        if (distances.medium < minDistance) {
            closestProfile = 'medium';
            minDistance = distances.medium;
        }

        if (distances.slow < minDistance) {
            closestProfile = 'slow';
            minDistance = distances.slow;
        }

        const speedMap = {
            fast: SPEED_CLASSIFICATIONS.FAST_PACED,
            medium: SPEED_CLASSIFICATIONS.MEDIUM,
            slow: SPEED_CLASSIFICATIONS.SLOW_METHODICAL
        };

        return speedMap[closestProfile];
    }

    /**
     * Calculate Euclidean distance from profile
     * @private
     */
    _calculateDistance(interactions, growthRate, correctRatio, profile) {
        const d1 = (interactions - profile.averageInteractionsPerConcept) ** 2;
        const d2 = (growthRate - profile.masteryScoreGrowthRate) ** 2;
        const d3 = (correctRatio - profile.correctAnswerRatio) ** 2;

        return Math.sqrt(d1 + d2 + d3);
    }

    /**
     * Calculate variance in learning patterns (to detect VARIABLE classification)
     * @private
     */
    _calculateVariance(metrics) {
        // Variance between concepts' mastery scores
        // This is a simplified check - a full implementation would track historical variance
        if (metrics.totalConcepts < 3) return 0;

        // If some concepts at 80+ and others at <30, that's variable
        const spread = Math.abs(
            (metrics.totalConcepts - metrics.masteryCount) / metrics.totalConcepts
        );

        return spread; // Range: 0-1, where 1 is high variance
    }

    /**
     * Get learning speed with confidence score
     * @param {ObjectId} userId
     * @returns {Promise<object>} { speed: string, confidence: 0-1, details: object }
     */
    async getSpeedWithConfidence(userId) {
        try {
            const speed = await this.detectLearningSpeed(userId);
            const cached = this.classificationCache.get(userId.toString());
            
            if (!cached) {
                return {
                    speed,
                    confidence: 0.3, // Low confidence if just defaulted
                    details: null
                };
            }

            // Confidence increases with more data points
            const { metrics } = cached;
            const dataPoints = metrics.totalConcepts;
            const confidence = Math.min(1, dataPoints / 10); // Full confidence at 10 concepts

            return {
                speed,
                confidence,
                details: metrics
            };
        } catch (error) {
            log.warn('LEARNING_SPEED', `Failed to get speed with confidence: ${error.message}`);
            return {
                speed: SPEED_CLASSIFICATIONS.MEDIUM,
                confidence: 0,
                details: null
            };
        }
    }

    /**
     * Record a learning event to update speed classification
     * @param {ObjectId} userId
     * @param {object} event - { conceptName: string, correct: boolean, timeSeconds: number }
     */
    async recordLearningEvent(userId, event) {
        try {
            // Invalidate cache to force recalculation
            this.classificationCache.delete(userId.toString());

            // Event recording happens in knowledgeStateService
            // This just ensures cache refresh on next call
            log.info('LEARNING_SPEED', `Recorded event for ${userId}, cache invalidated`);
        } catch (error) {
            log.warn('LEARNING_SPEED', `Failed to record learning event: ${error.message}`);
        }
    }

    /**
     * Get adaptive parameters based on learning speed
     * @param {string} speed - Speed classification
     * @returns {object} Adaptive parameters for tutoring
     */
    getAdaptiveParameters(speed) {
        const params = {
            slow_methodical: {
                scaffoldingLevel: 'SCAFFOLDED', // More detailed explanations
                examplesPerConcept: 3, // More examples
                reviewFrequency: 'frequent', // Regular reviews
                difficultyIncrement: 'slow', // Gradual progression
                hintLevel: 'detailed', // More detailed hints
                practiceRounds: 5, // More practice before advancing
                timePerQuestion: 60, // Allow more time
            },
            moderate: {
                scaffoldingLevel: 'GUIDED', // Balanced approach
                examplesPerConcept: 2,
                reviewFrequency: 'moderate',
                difficultyIncrement: 'moderate',
                hintLevel: 'balanced',
                practiceRounds: 3,
                timePerQuestion: 40,
            },
            fast_paced: {
                scaffoldingLevel: 'MINIMAL', // Less scaffolding
                examplesPerConcept: 1, // Fewer, more complex examples
                reviewFrequency: 'sparse', // Less review needed
                difficultyIncrement: 'fast', // Quick progression
                hintLevel: 'minimal', // Minimal hints, more challenge
                practiceRounds: 1, // Skip basics, move to challenges
                timePerQuestion: 20, // Time-limited challenges
            },
            variable: {
                scaffoldingLevel: 'GUIDED', // Default to balanced
                examplesPerConcept: 2,
                reviewFrequency: 'adaptive', // Adjust per concept
                difficultyIncrement: 'variable', // Vary by concept strength
                hintLevel: 'balanced',
                practiceRounds: 3,
                timePerQuestion: 40,
            }
        };

        return params[speed] || params.moderate;
    }
}

module.exports = new LearningSpeedDetector();
/**
 * server/services/learningSpeedDetector.js
 * 
 * Learning Speed Detector Service
 * 
 * Classifies students as slow, medium, or fast learners based on:
 * - Correct answers per concept
 * - Repeated mistakes (indicates slower pace)
 * - Speed of concept mastery
 * - Session engagement patterns
 * 
 * Dynamically adjusts classification as more data arrives
 */

const log = require('../utils/logger');
const StudentKnowledgeState = require('../models/StudentKnowledgeState');
const StudentLearningProfile = require('../models/StudentLearningProfile');

// Speed classification thresholds
const SPEED_THRESHOLDS = {
    FAST: {
        averageInteractionsPerConcept: 3, // Masters concepts in ~3 interactions
        masteryScoreGrowthRate: 20, // Gains ~20 points per interaction
        correctAnswerRatio: 0.85, // 85% correct answers
        sessionsToMastery: 2 // Achieves mastery in ~2 sessions
    },
    MEDIUM: {
        averageInteractionsPerConcept: 5, // ~5 interactions
        masteryScoreGrowthRate: 12, // ~12 points per interaction
        correctAnswerRatio: 0.70, // 70% correct
        sessionsToMastery: 4 // ~4 sessions
    },
    SLOW: {
        averageInteractionsPerConcept: 8, // ~8 interactions
        masteryScoreGrowthRate: 5, // ~5 points per interaction
        correctAnswerRatio: 0.55, // 55% correct
        sessionsToMastery: 6 // ~6 sessions
    }
};

const SPEED_CLASSIFICATIONS = {
    SLOW_METHODICAL: 'slow_methodical',
    MEDIUM: 'moderate',
    FAST_PACED: 'fast_paced',
    VARIABLE: 'variable'
};

class LearningSpeedDetector {
    constructor() {
        this.classificationCache = new Map();
    }

    /**
     * Detect current learning speed for a student
     * @param {ObjectId} userId - Student's user ID
     * @returns {Promise<string>} Speed classification: 'slow_methodical' | 'moderate' | 'fast_paced' | 'variable'
     */
    async detectLearningSpeed(userId) {
        try {
            // Check cache first
            const cached = this.classificationCache.get(userId.toString());
            if (cached && Date.now() - cached.timestamp < 3600000) { // 1 hour cache
                return cached.speed;
            }

            const knowledgeState = await StudentKnowledgeState.findOne({ userId });
            if (!knowledgeState || !knowledgeState.concepts || knowledgeState.concepts.length === 0) {
                return SPEED_CLASSIFICATIONS.MEDIUM; // Default for new students
            }

            const metrics = this._calculateSpeedMetrics(knowledgeState);
            const speed = this._classifySpeed(metrics);

            // Cache the result
            this.classificationCache.set(userId.toString(), {
                speed,
                timestamp: Date.now(),
                metrics
            });

            log.info('LEARNING_SPEED', `Student ${userId}: ${speed} (metrics: ${JSON.stringify(metrics)})`);

            return speed;
        } catch (error) {
            log.warn('LEARNING_SPEED', `Failed to detect speed for ${userId}: ${error.message}`);
            return SPEED_CLASSIFICATIONS.MEDIUM;
        }
    }

    /**
     * Calculate speed metrics from student's knowledge state
     * @private
     */
    _calculateSpeedMetrics(knowledgeState) {
        const concepts = knowledgeState.concepts || [];
        
        if (concepts.length === 0) {
            return {
                averageInteractionsPerConcept: 0,
                averageGrowthRate: 0,
                averageCorrectRatio: 0,
                masteryCount: 0,
                totalInteractions: 0
            };
        }

        // Calculate average interactions per concept
        const totalInteractions = concepts.reduce((sum, c) => sum + (c.totalInteractions || 0), 0);
        const averageInteractionsPerConcept = totalInteractions / concepts.length;

        // Calculate mastery growth rate (average learning velocity)
        const growthRates = concepts
            .filter(c => c.learningVelocity !== undefined)
            .map(c => c.learningVelocity || 0);
        const averageGrowthRate = growthRates.length > 0 
            ? growthRates.reduce((a, b) => a + b, 0) / growthRates.length 
            : 0;

        // Calculate success ratio
        const successfulInteractions = concepts.reduce((sum, c) => sum + (c.successfulInteractions || 0), 0);
        const averageCorrectRatio = totalInteractions > 0 ? successfulInteractions / totalInteractions : 0;

        // Count mastered concepts
        const masteryCount = concepts.filter(c => c.masteryScore >= 80).length;

        return {
            averageInteractionsPerConcept: Math.round(averageInteractionsPerConcept * 10) / 10,
            averageGrowthRate: Math.round(averageGrowthRate * 10) / 10,
            averageCorrectRatio: Math.round(averageCorrectRatio * 100) / 100,
            masteryCount,
            totalInteractions,
            totalConcepts: concepts.length
        };
    }

    /**
     * Classify speed based on calculated metrics
     * @private
     */
    _classifySpeed(metrics) {
        const {
            averageInteractionsPerConcept,
            averageGrowthRate,
            averageCorrectRatio
        } = metrics;

        // Calculate distance from each speed profile
        const distances = {};

        distances.fast = this._calculateDistance(
            averageInteractionsPerConcept,
            averageGrowthRate,
            averageCorrectRatio,
            SPEED_THRESHOLDS.FAST
        );

        distances.medium = this._calculateDistance(
            averageInteractionsPerConcept,
            averageGrowthRate,
            averageCorrectRatio,
            SPEED_THRESHOLDS.MEDIUM
        );

        distances.slow = this._calculateDistance(
            averageInteractionsPerConcept,
            averageGrowthRate,
            averageCorrectRatio,
            SPEED_THRESHOLDS.SLOW
        );

        // Check for variability (inconsistent patterns)
        const variance = this._calculateVariance(metrics);
        if (variance > 0.4) {
            return SPEED_CLASSIFICATIONS.VARIABLE;
        }

        // Find closest profile
        let closestProfile = 'fast';
        let minDistance = distances.fast;

        if (distances.medium < minDistance) {
            closestProfile = 'medium';
            minDistance = distances.medium;
        }

        if (distances.slow < minDistance) {
            closestProfile = 'slow';
            minDistance = distances.slow;
        }

        const speedMap = {
            fast: SPEED_CLASSIFICATIONS.FAST_PACED,
            medium: SPEED_CLASSIFICATIONS.MEDIUM,
            slow: SPEED_CLASSIFICATIONS.SLOW_METHODICAL
        };

        return speedMap[closestProfile];
    }

    /**
     * Calculate Euclidean distance from profile
     * @private
     */
    _calculateDistance(interactions, growthRate, correctRatio, profile) {
        const d1 = (interactions - profile.averageInteractionsPerConcept) ** 2;
        const d2 = (growthRate - profile.masteryScoreGrowthRate) ** 2;
        const d3 = (correctRatio - profile.correctAnswerRatio) ** 2;

        return Math.sqrt(d1 + d2 + d3);
    }

    /**
     * Calculate variance in learning patterns (to detect VARIABLE classification)
     * @private
     */
    _calculateVariance(metrics) {
        // Variance between concepts' mastery scores
        // This is a simplified check - a full implementation would track historical variance
        if (metrics.totalConcepts < 3) return 0;

        // If some concepts at 80+ and others at <30, that's variable
        const spread = Math.abs(
            (metrics.totalConcepts - metrics.masteryCount) / metrics.totalConcepts
        );

        return spread; // Range: 0-1, where 1 is high variance
    }

    /**
     * Get learning speed with confidence score
     * @param {ObjectId} userId
     * @returns {Promise<object>} { speed: string, confidence: 0-1, details: object }
     */
    async getSpeedWithConfidence(userId) {
        try {
            const speed = await this.detectLearningSpeed(userId);
            const cached = this.classificationCache.get(userId.toString());
            
            if (!cached) {
                return {
                    speed,
                    confidence: 0.3, // Low confidence if just defaulted
                    details: null
                };
            }

            // Confidence increases with more data points
            const { metrics } = cached;
            const dataPoints = metrics.totalConcepts;
            const confidence = Math.min(1, dataPoints / 10); // Full confidence at 10 concepts

            return {
                speed,
                confidence,
                details: metrics
            };
        } catch (error) {
            log.warn('LEARNING_SPEED', `Failed to get speed with confidence: ${error.message}`);
            return {
                speed: SPEED_CLASSIFICATIONS.MEDIUM,
                confidence: 0,
                details: null
            };
        }
    }

    /**
     * Record a learning event to update speed classification
     * @param {ObjectId} userId
     * @param {object} event - { conceptName: string, correct: boolean, timeSeconds: number }
     */
    async recordLearningEvent(userId, event) {
        try {
            // Invalidate cache to force recalculation
            this.classificationCache.delete(userId.toString());

            // Event recording happens in knowledgeStateService
            // This just ensures cache refresh on next call
            log.info('LEARNING_SPEED', `Recorded event for ${userId}, cache invalidated`);
        } catch (error) {
            log.warn('LEARNING_SPEED', `Failed to record learning event: ${error.message}`);
        }
    }

    /**
     * Get adaptive parameters based on learning speed
     * @param {string} speed - Speed classification
     * @returns {object} Adaptive parameters for tutoring
     */
    getAdaptiveParameters(speed) {
        const params = {
            slow_methodical: {
                scaffoldingLevel: 'SCAFFOLDED', // More detailed explanations
                examplesPerConcept: 3, // More examples
                reviewFrequency: 'frequent', // Regular reviews
                difficultyIncrement: 'slow', // Gradual progression
                hintLevel: 'detailed', // More detailed hints
                practiceRounds: 5, // More practice before advancing
                timePerQuestion: 60, // Allow more time
            },
            moderate: {
                scaffoldingLevel: 'GUIDED', // Balanced approach
                examplesPerConcept: 2,
                reviewFrequency: 'moderate',
                difficultyIncrement: 'moderate',
                hintLevel: 'balanced',
                practiceRounds: 3,
                timePerQuestion: 40,
            },
            fast_paced: {
                scaffoldingLevel: 'MINIMAL', // Less scaffolding
                examplesPerConcept: 1, // Fewer, more complex examples
                reviewFrequency: 'sparse', // Less review needed
                difficultyIncrement: 'fast', // Quick progression
                hintLevel: 'minimal', // Minimal hints, more challenge
                practiceRounds: 1, // Skip basics, move to challenges
                timePerQuestion: 20, // Time-limited challenges
            },
            variable: {
                scaffoldingLevel: 'GUIDED', // Default to balanced
                examplesPerConcept: 2,
                reviewFrequency: 'adaptive', // Adjust per concept
                difficultyIncrement: 'variable', // Vary by concept strength
                hintLevel: 'balanced',
                practiceRounds: 3,
                timePerQuestion: 40,
            }
        };

        return params[speed] || params.moderate;
    }
}

module.exports = new LearningSpeedDetector();
