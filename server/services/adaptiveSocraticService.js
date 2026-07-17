/**
 * server/services/adaptiveSocraticService.js
 * 
 * Adaptive Socratic Service
 * 
 * Enhanced Socratic teaching logic that incorporates:
 * - Student's mastery level
 * - Learning speed
 * - Prior knowledge
 * - Weak areas
 * - Adaptive difficulty adjustment
 * 
 * Wraps around existing socraticTutorService with adaptive layer
 */

const log = require('../utils/logger');
const StudentKnowledgeState = require('../models/StudentKnowledgeState');
const knowledgeAnalyzer = require('./knowledgeAnalyzer');
const learningSpeedDetector = require('./learningSpeedDetector');
const adaptiveLearningEngine = require('./adaptiveLearningEngine');
const adaptivePromptBuilder = require('./adaptivePromptBuilder');
const priorKnowledgeDetector = require('./priorKnowledgeDetector');

class AdaptiveSocraticService {
    /**
     * Prepare adaptive Socratic context before generating response
     * @param {ObjectId} userId - Student's user ID
     * @param {string} topic - Topic being taught
     * @param {string} studentQuery - Latest student query
     * @param {Array} recentMessages - Last few chat messages
     * @returns {Promise<object>} Adaptive context for prompting
     */
    async prepareAdaptiveContext(userId, topic, studentQuery, recentMessages = []) {
        try {
            // Gather all adaptive data in parallel
            const [
                knowledgeState,
                priorKnowledge,
                learningSpeed,
                adaptiveAction,
                concepts
            ] = await Promise.all([
                StudentKnowledgeState.findOne({ userId }),
                this._detectPriorKnowledge(studentQuery),
                learningSpeedDetector.detectLearningSpeed(userId),
                adaptiveLearningEngine.determineAction(userId, topic, 'moderate'),
                this._extractConceptsFromMessages(recentMessages)
            ]);

            const learningProfile = knowledgeState?.learningProfile || {};
            const concept = knowledgeState?.concepts?.find(
                c => c.conceptName.toLowerCase() === topic.toLowerCase()
            );

            const adaptiveContext = {
                userId,
                topic,
                student: {
                    learningSpeed,
                    learningStyle: learningProfile.dominantLearningStyle || 'unknown',
                    learningPace: learningProfile.learningPace || 'moderate',
                    preferredDepth: learningProfile.preferredDepth || 'balanced',
                    challengeResponse: learningProfile.challengeResponse || 'needs_encouragement'
                },
                topic_context: {
                    masteryScore: concept?.masteryScore || 0,
                    understandingLevel: concept?.understandingLevel || 'not_exposed',
                    totalInteractions: concept?.totalInteractions || 0,
                    lastInteractionDate: concept?.lastInteractionDate,
                    weaknesses: concept?.weaknesses || [],
                    misconceptions: concept?.misconceptions || [],
                    strengths: concept?.strengths || []
                },
                adaptive_action: adaptiveAction.action,
                adaptive_reasoning: adaptiveAction.reasoning,
                prior_knowledge_detected: priorKnowledge,
                confidence_from_query: this._estimateConfidence(studentQuery),
                previously_discussed_concepts: concepts
            };

            log.info('ADAPTIVE_SOCRATIC', 
                `Prepared context for ${userId} on "${topic}": action=${adaptiveAction.action}, mastery=${adaptiveContext.topic_context.masteryScore}`
            );

            return adaptiveContext;
        } catch (error) {
            log.warn('ADAPTIVE_SOCRATIC', `Failed to prepare context: ${error.message}`);
            return {
                userId,
                topic,
                student: { learningSpeed: 'moderate', learningStyle: 'unknown' },
                topic_context: { masteryScore: 0 },
                adaptive_action: 'TEACH',
                error: error.message
            };
        }
    }

    /**
     * Build adaptive system prompt using context
     * @param {object} adaptiveContext - From prepareAdaptiveContext()
     * @returns {Promise<string>} Adaptive system prompt
     */
    async buildSystemPrompt(adaptiveContext) {
        const {
            topic,
            student,
            topic_context,
            adaptive_action
        } = adaptiveContext;

        try {
            // Get prompt customized to adaptive action
            const prompt = await adaptivePromptBuilder.buildPrompt(
                adaptiveContext.userId,
                topic,
                adaptive_action,
                {
                    learningSpeed: student.learningSpeed,
                    masteryScore: topic_context.masteryScore,
                    learningStyle: student.learningStyle,
                    understandingLevel: topic_context.understandingLevel,
                    weakAreas: topic_context.weaknesses,
                    misconceptions: topic_context.misconceptions
                }
            );

            return prompt;
        } catch (error) {
            log.warn('ADAPTIVE_SOCRATIC', `Failed to build prompt: ${error.message}`);
            return `You are a Socratic tutor teaching about "${topic}".`;
        }
    }

    /**
     * Analyze student response and update profile
     * @param {ObjectId} userId
     * @param {string} topic
     * @param {string} studentMessage
     * @param {string} botResponse
     * @returns {Promise<void>}
     */
    async analyzeAndUpdate(userId, topic, studentMessage, botResponse) {
        try {
            // Analyze the response
            const analysis = await knowledgeAnalyzer.analyzeStudentResponse(
                studentMessage,
                topic,
                { botResponse }
            );

            // Determine if answer was correct based on analysis
            const isCorrect = analysis.understandingLevel === 'comfortable' || 
                              analysis.understandingLevel === 'mastered';

            // Extract confidence
            const confidence = analysis.confidence === 'high' ? 0.8 : 
                              analysis.confidence === 'low' ? 0.3 : 0.5;

            // Update mastery
            await knowledgeAnalyzer.updateConceptMastery(userId, topic, {
                correct: isCorrect,
                confidence,
                difficulty: 'medium'
            });

            // Record event for speed detection
            await learningSpeedDetector.recordLearningEvent(userId, {
                conceptName: topic,
                correct: isCorrect
            });

            log.info('ADAPTIVE_SOCRATIC', 
                `Updated ${topic}: correct=${isCorrect}, confidence=${confidence}`
            );
        } catch (error) {
            log.warn('ADAPTIVE_SOCRATIC', `Failed to analyze and update: ${error.message}`);
        }
    }

    /**
     * Determine if should ask follow-up or advance topic
     * @param {ObjectId} userId
     * @param {string} topic
     * @param {boolean} lastAnswerCorrect
     * @returns {Promise<object>} { shouldAdvance, nextAction, recommendation }
     */
    async determineNextMove(userId, topic, lastAnswerCorrect) {
        try {
            const plan = await adaptiveLearningEngine.getAdaptivePlan(userId, topic);

            return {
                shouldAdvance: plan.action === 'ADVANCE' || plan.action === 'SKIP',
                nextAction: plan.action,
                recommendation: plan.recommendation,
                nextTopics: plan.additionalInfo.advancedConcepts || [],
                masteryScore: plan.masteryScore
            };
        } catch (error) {
            log.warn('ADAPTIVE_SOCRATIC', `Failed to determine next move: ${error.message}`);
            return {
                shouldAdvance: false,
                nextAction: 'TEACH',
                recommendation: 'Continue with current topic'
            };
        }
    }

    /**
     * Detect prior knowledge from query
     * @private
     */
    async _detectPriorKnowledge(query) {
        try {
            return priorKnowledgeDetector.extractMasteredTopics(query).length > 0;
        } catch {
            return false;
        }
    }

    /**
     * Estimate confidence from query language
     * @private
     */
    _estimateConfidence(query) {
        if (!query) return 0.5;

        const highConfidenceWords = /sure|confident|definitely|absolutely|100%|certain/i;
        const lowConfidenceWords = /not sure|confused|unsure|struggling|help|confused/i;

        if (highConfidenceWords.test(query)) return 0.8;
        if (lowConfidenceWords.test(query)) return 0.3;
        return 0.5;
    }

    /**
     * Extract previously discussed concepts from messages
     * @private
     */
    _extractConceptsFromMessages(messages) {
        const concepts = new Set();

        if (!Array.isArray(messages)) return Array.from(concepts);

        for (const msg of messages) {
            const text = msg.parts?.[0]?.text || msg.text || '';
            
            // Simple pattern: capitalized terms (could be concepts)
            const matches = text.match(/\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)*\b/g);
            if (matches) {
                matches.forEach(m => concepts.add(m));
            }
        }

        return Array.from(concepts).slice(0, 5); // Top 5
    }

    /**
     * Check if student has mastered enough prerequisites
     * @param {ObjectId} userId
     * @param {string} topic
     * @returns {Promise<object>} { allMet: boolean, missing: Array }
     */
    async checkPrerequisites(userId, topic) {
        try {
            const knowledgeState = await StudentKnowledgeState.findOne({ userId });
            if (!knowledgeState) {
                return { allMet: false, missing: ['basic concepts'] };
            }

            // Common prerequisites map
            const prerequisites = {
                'recursion': ['functions', 'loops'],
                'binary search': ['arrays', 'sorting'],
                'dynamic programming': ['recursion'],
                'graphs': ['trees', 'adjacency lists'],
                'linked lists': ['pointers'],
                'binary trees': ['trees'],
            };

            const topicPrereqs = prerequisites[topic.toLowerCase()] || [];
            const missing = [];

            for (const prereq of topicPrereqs) {
                const concept = knowledgeState.concepts?.find(
                    c => c.conceptName.toLowerCase() === prereq.toLowerCase()
                );

                if (!concept || concept.masteryScore < 50) {
                    missing.push(prereq);
                }
            }

            return {
                allMet: missing.length === 0,
                missing
            };
        } catch (error) {
            log.warn('ADAPTIVE_SOCRATIC', `Failed to check prerequisites: ${error.message}`);
            return { allMet: true, missing: [] }; // Assume OK if check fails
        }
    }
}

module.exports = new AdaptiveSocraticService();
/**
 * server/services/adaptiveSocraticService.js
 * 
 * Adaptive Socratic Service
 * 
 * Enhanced Socratic teaching logic that incorporates:
 * - Student's mastery level
 * - Learning speed
 * - Prior knowledge
 * - Weak areas
 * - Adaptive difficulty adjustment
 * 
 * Wraps around existing socraticTutorService with adaptive layer
 */

const log = require('../utils/logger');
const StudentKnowledgeState = require('../models/StudentKnowledgeState');
const knowledgeAnalyzer = require('./knowledgeAnalyzer');
const learningSpeedDetector = require('./learningSpeedDetector');
const adaptiveLearningEngine = require('./adaptiveLearningEngine');
const adaptivePromptBuilder = require('./adaptivePromptBuilder');
const priorKnowledgeDetector = require('./priorKnowledgeDetector');

class AdaptiveSocraticService {
    /**
     * Prepare adaptive Socratic context before generating response
     * @param {ObjectId} userId - Student's user ID
     * @param {string} topic - Topic being taught
     * @param {string} studentQuery - Latest student query
     * @param {Array} recentMessages - Last few chat messages
     * @returns {Promise<object>} Adaptive context for prompting
     */
    async prepareAdaptiveContext(userId, topic, studentQuery, recentMessages = []) {
        try {
            // Gather all adaptive data in parallel
            const [
                knowledgeState,
                priorKnowledge,
                learningSpeed,
                adaptiveAction,
                concepts
            ] = await Promise.all([
                StudentKnowledgeState.findOne({ userId }),
                this._detectPriorKnowledge(studentQuery),
                learningSpeedDetector.detectLearningSpeed(userId),
                adaptiveLearningEngine.determineAction(userId, topic, 'moderate'),
                this._extractConceptsFromMessages(recentMessages)
            ]);

            const learningProfile = knowledgeState?.learningProfile || {};
            const concept = knowledgeState?.concepts?.find(
                c => c.conceptName.toLowerCase() === topic.toLowerCase()
            );

            const adaptiveContext = {
                userId,
                topic,
                student: {
                    learningSpeed,
                    learningStyle: learningProfile.dominantLearningStyle || 'unknown',
                    learningPace: learningProfile.learningPace || 'moderate',
                    preferredDepth: learningProfile.preferredDepth || 'balanced',
                    challengeResponse: learningProfile.challengeResponse || 'needs_encouragement'
                },
                topic_context: {
                    masteryScore: concept?.masteryScore || 0,
                    understandingLevel: concept?.understandingLevel || 'not_exposed',
                    totalInteractions: concept?.totalInteractions || 0,
                    lastInteractionDate: concept?.lastInteractionDate,
                    weaknesses: concept?.weaknesses || [],
                    misconceptions: concept?.misconceptions || [],
                    strengths: concept?.strengths || []
                },
                adaptive_action: adaptiveAction.action,
                adaptive_reasoning: adaptiveAction.reasoning,
                prior_knowledge_detected: priorKnowledge,
                confidence_from_query: this._estimateConfidence(studentQuery),
                previously_discussed_concepts: concepts
            };

            log.info('ADAPTIVE_SOCRATIC', 
                `Prepared context for ${userId} on "${topic}": action=${adaptiveAction.action}, mastery=${adaptiveContext.topic_context.masteryScore}`
            );

            return adaptiveContext;
        } catch (error) {
            log.warn('ADAPTIVE_SOCRATIC', `Failed to prepare context: ${error.message}`);
            return {
                userId,
                topic,
                student: { learningSpeed: 'moderate', learningStyle: 'unknown' },
                topic_context: { masteryScore: 0 },
                adaptive_action: 'TEACH',
                error: error.message
            };
        }
    }

    /**
     * Build adaptive system prompt using context
     * @param {object} adaptiveContext - From prepareAdaptiveContext()
     * @returns {Promise<string>} Adaptive system prompt
     */
    async buildSystemPrompt(adaptiveContext) {
        const {
            topic,
            student,
            topic_context,
            adaptive_action
        } = adaptiveContext;

        try {
            // Get prompt customized to adaptive action
            const prompt = await adaptivePromptBuilder.buildPrompt(
                adaptiveContext.userId,
                topic,
                adaptive_action,
                {
                    learningSpeed: student.learningSpeed,
                    masteryScore: topic_context.masteryScore,
                    learningStyle: student.learningStyle,
                    understandingLevel: topic_context.understandingLevel,
                    weakAreas: topic_context.weaknesses,
                    misconceptions: topic_context.misconceptions
                }
            );

            return prompt;
        } catch (error) {
            log.warn('ADAPTIVE_SOCRATIC', `Failed to build prompt: ${error.message}`);
            return `You are a Socratic tutor teaching about "${topic}".`;
        }
    }

    /**
     * Analyze student response and update profile
     * @param {ObjectId} userId
     * @param {string} topic
     * @param {string} studentMessage
     * @param {string} botResponse
     * @returns {Promise<void>}
     */
    async analyzeAndUpdate(userId, topic, studentMessage, botResponse) {
        try {
            // Analyze the response
            const analysis = await knowledgeAnalyzer.analyzeStudentResponse(
                studentMessage,
                topic,
                { botResponse }
            );

            // Determine if answer was correct based on analysis
            const isCorrect = analysis.understandingLevel === 'comfortable' || 
                              analysis.understandingLevel === 'mastered';

            // Extract confidence
            const confidence = analysis.confidence === 'high' ? 0.8 : 
                              analysis.confidence === 'low' ? 0.3 : 0.5;

            // Update mastery
            await knowledgeAnalyzer.updateConceptMastery(userId, topic, {
                correct: isCorrect,
                confidence,
                difficulty: 'medium'
            });

            // Record event for speed detection
            await learningSpeedDetector.recordLearningEvent(userId, {
                conceptName: topic,
                correct: isCorrect
            });

            log.info('ADAPTIVE_SOCRATIC', 
                `Updated ${topic}: correct=${isCorrect}, confidence=${confidence}`
            );
        } catch (error) {
            log.warn('ADAPTIVE_SOCRATIC', `Failed to analyze and update: ${error.message}`);
        }
    }

    /**
     * Determine if should ask follow-up or advance topic
     * @param {ObjectId} userId
     * @param {string} topic
     * @param {boolean} lastAnswerCorrect
     * @returns {Promise<object>} { shouldAdvance, nextAction, recommendation }
     */
    async determineNextMove(userId, topic, lastAnswerCorrect) {
        try {
            const plan = await adaptiveLearningEngine.getAdaptivePlan(userId, topic);

            return {
                shouldAdvance: plan.action === 'ADVANCE' || plan.action === 'SKIP',
                nextAction: plan.action,
                recommendation: plan.recommendation,
                nextTopics: plan.additionalInfo.advancedConcepts || [],
                masteryScore: plan.masteryScore
            };
        } catch (error) {
            log.warn('ADAPTIVE_SOCRATIC', `Failed to determine next move: ${error.message}`);
            return {
                shouldAdvance: false,
                nextAction: 'TEACH',
                recommendation: 'Continue with current topic'
            };
        }
    }

    /**
     * Detect prior knowledge from query
     * @private
     */
    async _detectPriorKnowledge(query) {
        try {
            return priorKnowledgeDetector.extractMasteredTopics(query).length > 0;
        } catch {
            return false;
        }
    }

    /**
     * Estimate confidence from query language
     * @private
     */
    _estimateConfidence(query) {
        if (!query) return 0.5;

        const highConfidenceWords = /sure|confident|definitely|absolutely|100%|certain/i;
        const lowConfidenceWords = /not sure|confused|unsure|struggling|help|confused/i;

        if (highConfidenceWords.test(query)) return 0.8;
        if (lowConfidenceWords.test(query)) return 0.3;
        return 0.5;
    }

    /**
     * Extract previously discussed concepts from messages
     * @private
     */
    _extractConceptsFromMessages(messages) {
        const concepts = new Set();

        if (!Array.isArray(messages)) return Array.from(concepts);

        for (const msg of messages) {
            const text = msg.parts?.[0]?.text || msg.text || '';
            
            // Simple pattern: capitalized terms (could be concepts)
            const matches = text.match(/\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)*\b/g);
            if (matches) {
                matches.forEach(m => concepts.add(m));
            }
        }

        return Array.from(concepts).slice(0, 5); // Top 5
    }

    /**
     * Check if student has mastered enough prerequisites
     * @param {ObjectId} userId
     * @param {string} topic
     * @returns {Promise<object>} { allMet: boolean, missing: Array }
     */
    async checkPrerequisites(userId, topic) {
        try {
            const knowledgeState = await StudentKnowledgeState.findOne({ userId });
            if (!knowledgeState) {
                return { allMet: false, missing: ['basic concepts'] };
            }

            // Common prerequisites map
            const prerequisites = {
                'recursion': ['functions', 'loops'],
                'binary search': ['arrays', 'sorting'],
                'dynamic programming': ['recursion'],
                'graphs': ['trees', 'adjacency lists'],
                'linked lists': ['pointers'],
                'binary trees': ['trees'],
            };

            const topicPrereqs = prerequisites[topic.toLowerCase()] || [];
            const missing = [];

            for (const prereq of topicPrereqs) {
                const concept = knowledgeState.concepts?.find(
                    c => c.conceptName.toLowerCase() === prereq.toLowerCase()
                );

                if (!concept || concept.masteryScore < 50) {
                    missing.push(prereq);
                }
            }

            return {
                allMet: missing.length === 0,
                missing
            };
        } catch (error) {
            log.warn('ADAPTIVE_SOCRATIC', `Failed to check prerequisites: ${error.message}`);
            return { allMet: true, missing: [] }; // Assume OK if check fails
        }
    }
}

module.exports = new AdaptiveSocraticService();
