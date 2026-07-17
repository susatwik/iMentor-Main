/**
 * server/services/knowledgeAnalyzer.js
 * 
 * Knowledge Analyzer Service
 * 
 * Analyzes student responses to detect:
 * - Prior knowledge (what they already know)
 * - Confidence level
 * - Weak areas / misconceptions
 * - Learning patterns
 * 
 * Returns structured insights for adaptive learning
 */

const log = require('../utils/logger');
const geminiService = require('./geminiService');
const groqService = require('./groqService');
const StudentKnowledgeState = require('../models/StudentKnowledgeState');

// Regex patterns for knowledge detection
const PATTERNS = {
    // Confidence signals
    highConfidence: /confident|sure|absolutely|definitely|100%|certain/i,
    lowConfidence: /not\s+sure|confused|unsure|struggling|difficult|hard|not\s+clear/i,
    
    // Mastery signals
    masterySignal: /i\s+(?:already\s+)?know|i\s+understand|i\s+learned|familiar\s+with|worked\s+with|used|built/i,
    
    // Weak area signals
    weakSignal: /i\s+(?:don't|dont|do\s+not)\s+(?:understand|know|get|follow)|confused|struggling|don't\s+see|why|can't|cannot/i,
    
    // Prior knowledge claim
    priorKnowledge: /i\s+took|course|class|studied|background|experience|worked|built/i,
};

class KnowledgeAnalyzer {
    constructor() {
        this.cache = new Map();
    }

    /**
     * Analyze student response to extract knowledge insights
     * @param {string} studentQuery - Student's message
     * @param {string} topic - Topic being discussed
     * @param {object} previousContext - Context from previous interactions
     * @returns {Promise<object>} Analyzed insights
     */
    async analyzeStudentResponse(studentQuery, topic, previousContext = {}) {
        if (!studentQuery || typeof studentQuery !== 'string') {
            return {
                priorKnowledge: null,
                confidence: 'medium',
                weakAreas: [],
                misconceptions: [],
                understandingLevel: 'unknown'
            };
        }

        try {
            const lowerQuery = studentQuery.toLowerCase();

            // Quick local analysis first
            const localAnalysis = {
                priorKnowledge: this._detectPriorKnowledge(lowerQuery),
                confidence: this._detectConfidence(lowerQuery),
                claimsMastery: PATTERNS.masterySignal.test(lowerQuery),
                claimsWeakness: PATTERNS.weakSignal.test(lowerQuery),
            };

            // For longer responses, use LLM for deeper analysis
            if (studentQuery.length > 100) {
                return await this._deepAnalyzeWithLLM(studentQuery, topic, localAnalysis);
            }

            return {
                ...localAnalysis,
                weakAreas: localAnalysis.claimsWeakness ? [topic] : [],
                misconceptions: [],
                understandingLevel: this._mapConfidenceToLevel(localAnalysis.confidence)
            };
        } catch (error) {
            log.warn('KNOWLEDGE_ANALYZER', `Analysis failed: ${error.message}`);
            return {
                priorKnowledge: null,
                confidence: 'medium',
                weakAreas: [],
                misconceptions: [],
                understandingLevel: 'unknown'
            };
        }
    }

    /**
     * Detect if student claims prior knowledge
     * @private
     */
    _detectPriorKnowledge(lowerQuery) {
        if (!PATTERNS.priorKnowledge.test(lowerQuery)) return null;

        // Extract what they claim to know
        const match = lowerQuery.match(/(?:took|course|class|studied|background|experience)\s+(?:in|with)?\s+([^.!?,]+)/i);
        if (match && match[1]) {
            return {
                topics: [match[1].trim()],
                claimedType: 'course_or_experience'
            };
        }

        return {
            topics: [],
            claimedType: 'vague_prior_knowledge'
        };
    }

    /**
     * Detect confidence level from student response
     * @private
     */
    _detectConfidence(lowerQuery) {
        if (PATTERNS.highConfidence.test(lowerQuery)) return 'high';
        if (PATTERNS.lowConfidence.test(lowerQuery)) return 'low';
        return 'medium';
    }

    /**
     * Map confidence to understanding level
     * @private
     */
    _mapConfidenceToLevel(confidence) {
        switch (confidence) {
            case 'high': return 'comfortable';
            case 'low': return 'struggling';
            case 'medium': return 'learning';
            default: return 'unknown';
        }
    }

    /**
     * Deep LLM-based analysis for longer responses
     * @private
     */
    async _deepAnalyzeWithLLM(studentQuery, topic, localAnalysis) {
        const prompt = `You are an educational analyst. Analyze this student response about "${topic}":

"${studentQuery}"

Return a JSON object with:
{
  "understandingLevel": "not_exposed|struggling|learning|comfortable|mastered",
  "weakAreas": ["list of specific weak areas"],
  "misconceptions": ["list of detected misconceptions"],
  "strengths": ["list of demonstrated strengths"],
  "suggestedFocus": "specific area to focus on next"
}

Be precise. Return only valid JSON.`;

        try {
            // Use fast LLM for analysis
            let analysis = null;
            
            // Try Groq first (fast)
            try {
                const result = await groqService.generateContentWithHistory(
                    [],
                    prompt,
                    'You are an educational analyst providing structured JSON analysis.',
                    {
                        model: 'llama-3.1-70b-versatile',
                        apiKey: process.env.GROQ_API_KEY,
                        temperature: 0.3,
                        max_tokens: 300
                    }
                );
                
                const jsonMatch = result.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    analysis = JSON.parse(jsonMatch[0]);
                }
            } catch (e) {
                log.warn('KNOWLEDGE_ANALYZER', `Groq analysis failed, trying Gemini: ${e.message}`);
                
                // Fallback to Gemini
                const result = await geminiService.generateContentWithHistory(
                    [],
                    prompt,
                    'You are an educational analyst providing structured JSON analysis.',
                    {
                        apiKey: process.env.GEMINI_API_KEY,
                        geminiModel: 'gemini-flash-latest'
                    }
                );
                
                const jsonMatch = result.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    analysis = JSON.parse(jsonMatch[0]);
                }
            }

            if (analysis) {
                return {
                    ...localAnalysis,
                    ...analysis,
                    priorKnowledge: localAnalysis.priorKnowledge
                };
            }
        } catch (error) {
            log.warn('KNOWLEDGE_ANALYZER', `LLM analysis failed: ${error.message}`);
        }

        // Fallback to local analysis
        return {
            ...localAnalysis,
            understandingLevel: this._mapConfidenceToLevel(localAnalysis.confidence),
            weakAreas: localAnalysis.claimsWeakness ? [topic] : [],
            misconceptions: [],
            strengths: localAnalysis.claimsMastery ? [`Understanding of ${topic}`] : []
        };
    }

    /**
     * Analyze student interactions to identify patterns
     * @param {ObjectId} userId - Student's user ID
     * @param {Array} messages - Recent chat messages
     * @returns {Promise<object>} Pattern insights
     */
    async analyzePatterns(userId, messages) {
        try {
            const knowledgeState = await StudentKnowledgeState.findOne({ userId });
            if (!knowledgeState) return null;

            const analysis = {
                commonStruggles: [],
                strengthAreas: [],
                learningStyleInferred: null,
                adaptiveRecommendations: []
            };

            // Analyze recurring struggles
            if (knowledgeState.recurringStruggles && knowledgeState.recurringStruggles.length > 0) {
                analysis.commonStruggles = knowledgeState.recurringStruggles
                    .sort((a, b) => b.occurrences - a.occurrences)
                    .slice(0, 3)
                    .map(s => s.pattern);
            }

            // Find strong concepts
            if (knowledgeState.concepts && knowledgeState.concepts.length > 0) {
                const strong = knowledgeState.concepts
                    .filter(c => c.masteryScore >= 80)
                    .map(c => c.conceptName);
                analysis.strengthAreas = strong;
            }

            // Infer learning style
            if (knowledgeState.learningProfile) {
                analysis.learningStyleInferred = knowledgeState.learningProfile.dominantLearningStyle;
                analysis.preferredDepth = knowledgeState.learningProfile.preferredDepth;
                analysis.learningPace = knowledgeState.learningProfile.learningPace;
            }

            // Generate recommendations
            if (knowledgeState.concepts) {
                const weak = knowledgeState.concepts
                    .filter(c => c.masteryScore < 50)
                    .sort((a, b) => a.masteryScore - b.masteryScore)
                    .slice(0, 2);
                
                analysis.adaptiveRecommendations = weak.map(c => ({
                    concept: c.conceptName,
                    reason: `Low mastery (${c.masteryScore}/100)`,
                    suggestedAction: c.masteryScore < 30 ? 'TEACH' : 'REVIEW'
                }));
            }

            return analysis;
        } catch (error) {
            log.warn('KNOWLEDGE_ANALYZER', `Pattern analysis failed: ${error.message}`);
            return null;
        }
    }

    /**
     * Update concept understanding based on student performance
     * @param {ObjectId} userId - Student's user ID
     * @param {string} conceptName - Concept being taught
     * @param {object} performance - Performance data { correct: bool, confidence: 0-1, difficulty: 'low'|'medium'|'high' }
     * @returns {Promise<void>}
     */
    async updateConceptMastery(userId, conceptName, performance) {
        try {
            const knowledgeState = await StudentKnowledgeState.findOne({ userId });
            if (!knowledgeState) return;

            // Find or create concept
            let concept = knowledgeState.concepts.find(c => c.conceptName === conceptName);
            
            if (!concept) {
                concept = {
                    conceptName,
                    category: 'intermediate',
                    understandingLevel: 'not_exposed',
                    masteryScore: 0,
                    masteryScoreNormalized: 0,
                    difficulty: performance.difficulty || 'medium',
                    successfulInteractions: 0,
                    totalInteractions: 0,
                    confidenceScore: 0,
                    learningVelocity: 0,
                    strengths: [],
                    weaknesses: [],
                    misconceptions: [],
                    lastInteractionDate: new Date(),
                    tutorNotes: []
                };
                knowledgeState.concepts.push(concept);
            }

            // Update interaction metrics
            concept.totalInteractions = (concept.totalInteractions || 0) + 1;
            if (performance.correct) {
                concept.successfulInteractions = (concept.successfulInteractions || 0) + 1;
            }

            // Calculate new mastery score (weighted towards recent performance)
            const successRate = concept.successfulInteractions / concept.totalInteractions;
            concept.masteryScore = Math.round(successRate * 100);
            concept.masteryScoreNormalized = successRate;

            // Update understanding level based on mastery
            if (concept.masteryScore >= 80) {
                concept.understandingLevel = 'mastered';
            } else if (concept.masteryScore >= 50) {
                concept.understandingLevel = 'comfortable';
            } else if (concept.masteryScore >= 20) {
                concept.understandingLevel = 'learning';
            } else {
                concept.understandingLevel = 'struggling';
            }

            // Update confidence
            concept.confidenceScore = Math.min(1, concept.confidenceScore + (performance.confidence || 0) * 0.1);

            // Track learning velocity (improvement rate)
            const previousScore = concept.masteryScore - (performance.correct ? 5 : 0);
            concept.learningVelocity = concept.masteryScore - previousScore;

            concept.lastInteractionDate = new Date();

            await knowledgeState.save();
            log.info('KNOWLEDGE_ANALYZER', `Updated mastery for ${conceptName}: ${concept.masteryScore}/100`);
        } catch (error) {
            log.warn('KNOWLEDGE_ANALYZER', `Failed to update concept mastery: ${error.message}`);
        }
    }
}

module.exports = new KnowledgeAnalyzer();
/**
 * server/services/knowledgeAnalyzer.js
 * 
 * Knowledge Analyzer Service
 * 
 * Analyzes student responses to detect:
 * - Prior knowledge (what they already know)
 * - Confidence level
 * - Weak areas / misconceptions
 * - Learning patterns
 * 
 * Returns structured insights for adaptive learning
 */

const log = require('../utils/logger');
const geminiService = require('./geminiService');
const groqService = require('./groqService');
const StudentKnowledgeState = require('../models/StudentKnowledgeState');

// Regex patterns for knowledge detection
const PATTERNS = {
    // Confidence signals
    highConfidence: /confident|sure|absolutely|definitely|100%|certain/i,
    lowConfidence: /not\s+sure|confused|unsure|struggling|difficult|hard|not\s+clear/i,
    
    // Mastery signals
    masterySignal: /i\s+(?:already\s+)?know|i\s+understand|i\s+learned|familiar\s+with|worked\s+with|used|built/i,
    
    // Weak area signals
    weakSignal: /i\s+(?:don't|dont|do\s+not)\s+(?:understand|know|get|follow)|confused|struggling|don't\s+see|why|can't|cannot/i,
    
    // Prior knowledge claim
    priorKnowledge: /i\s+took|course|class|studied|background|experience|worked|built/i,
};

class KnowledgeAnalyzer {
    constructor() {
        this.cache = new Map();
    }

    /**
     * Analyze student response to extract knowledge insights
     * @param {string} studentQuery - Student's message
     * @param {string} topic - Topic being discussed
     * @param {object} previousContext - Context from previous interactions
     * @returns {Promise<object>} Analyzed insights
     */
    async analyzeStudentResponse(studentQuery, topic, previousContext = {}) {
        if (!studentQuery || typeof studentQuery !== 'string') {
            return {
                priorKnowledge: null,
                confidence: 'medium',
                weakAreas: [],
                misconceptions: [],
                understandingLevel: 'unknown'
            };
        }

        try {
            const lowerQuery = studentQuery.toLowerCase();

            // Quick local analysis first
            const localAnalysis = {
                priorKnowledge: this._detectPriorKnowledge(lowerQuery),
                confidence: this._detectConfidence(lowerQuery),
                claimsMastery: PATTERNS.masterySignal.test(lowerQuery),
                claimsWeakness: PATTERNS.weakSignal.test(lowerQuery),
            };

            // For longer responses, use LLM for deeper analysis
            if (studentQuery.length > 100) {
                return await this._deepAnalyzeWithLLM(studentQuery, topic, localAnalysis);
            }

            return {
                ...localAnalysis,
                weakAreas: localAnalysis.claimsWeakness ? [topic] : [],
                misconceptions: [],
                understandingLevel: this._mapConfidenceToLevel(localAnalysis.confidence)
            };
        } catch (error) {
            log.warn('KNOWLEDGE_ANALYZER', `Analysis failed: ${error.message}`);
            return {
                priorKnowledge: null,
                confidence: 'medium',
                weakAreas: [],
                misconceptions: [],
                understandingLevel: 'unknown'
            };
        }
    }

    /**
     * Detect if student claims prior knowledge
     * @private
     */
    _detectPriorKnowledge(lowerQuery) {
        if (!PATTERNS.priorKnowledge.test(lowerQuery)) return null;

        // Extract what they claim to know
        const match = lowerQuery.match(/(?:took|course|class|studied|background|experience)\s+(?:in|with)?\s+([^.!?,]+)/i);
        if (match && match[1]) {
            return {
                topics: [match[1].trim()],
                claimedType: 'course_or_experience'
            };
        }

        return {
            topics: [],
            claimedType: 'vague_prior_knowledge'
        };
    }

    /**
     * Detect confidence level from student response
     * @private
     */
    _detectConfidence(lowerQuery) {
        if (PATTERNS.highConfidence.test(lowerQuery)) return 'high';
        if (PATTERNS.lowConfidence.test(lowerQuery)) return 'low';
        return 'medium';
    }

    /**
     * Map confidence to understanding level
     * @private
     */
    _mapConfidenceToLevel(confidence) {
        switch (confidence) {
            case 'high': return 'comfortable';
            case 'low': return 'struggling';
            case 'medium': return 'learning';
            default: return 'unknown';
        }
    }

    /**
     * Deep LLM-based analysis for longer responses
     * @private
     */
    async _deepAnalyzeWithLLM(studentQuery, topic, localAnalysis) {
        const prompt = `You are an educational analyst. Analyze this student response about "${topic}":

"${studentQuery}"

Return a JSON object with:
{
  "understandingLevel": "not_exposed|struggling|learning|comfortable|mastered",
  "weakAreas": ["list of specific weak areas"],
  "misconceptions": ["list of detected misconceptions"],
  "strengths": ["list of demonstrated strengths"],
  "suggestedFocus": "specific area to focus on next"
}

Be precise. Return only valid JSON.`;

        try {
            // Use fast LLM for analysis
            let analysis = null;
            
            // Try Groq first (fast)
            try {
                const result = await groqService.generateContentWithHistory(
                    [],
                    prompt,
                    'You are an educational analyst providing structured JSON analysis.',
                    {
                        model: 'llama-3.1-70b-versatile',
                        apiKey: process.env.GROQ_API_KEY,
                        temperature: 0.3,
                        max_tokens: 300
                    }
                );
                
                const jsonMatch = result.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    analysis = JSON.parse(jsonMatch[0]);
                }
            } catch (e) {
                log.warn('KNOWLEDGE_ANALYZER', `Groq analysis failed, trying Gemini: ${e.message}`);
                
                // Fallback to Gemini
                const result = await geminiService.generateContentWithHistory(
                    [],
                    prompt,
                    'You are an educational analyst providing structured JSON analysis.',
                    {
                        apiKey: process.env.GEMINI_API_KEY,
                        geminiModel: 'gemini-flash-latest'
                    }
                );
                
                const jsonMatch = result.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    analysis = JSON.parse(jsonMatch[0]);
                }
            }

            if (analysis) {
                return {
                    ...localAnalysis,
                    ...analysis,
                    priorKnowledge: localAnalysis.priorKnowledge
                };
            }
        } catch (error) {
            log.warn('KNOWLEDGE_ANALYZER', `LLM analysis failed: ${error.message}`);
        }

        // Fallback to local analysis
        return {
            ...localAnalysis,
            understandingLevel: this._mapConfidenceToLevel(localAnalysis.confidence),
            weakAreas: localAnalysis.claimsWeakness ? [topic] : [],
            misconceptions: [],
            strengths: localAnalysis.claimsMastery ? [`Understanding of ${topic}`] : []
        };
    }

    /**
     * Analyze student interactions to identify patterns
     * @param {ObjectId} userId - Student's user ID
     * @param {Array} messages - Recent chat messages
     * @returns {Promise<object>} Pattern insights
     */
    async analyzePatterns(userId, messages) {
        try {
            const knowledgeState = await StudentKnowledgeState.findOne({ userId });
            if (!knowledgeState) return null;

            const analysis = {
                commonStruggles: [],
                strengthAreas: [],
                learningStyleInferred: null,
                adaptiveRecommendations: []
            };

            // Analyze recurring struggles
            if (knowledgeState.recurringStruggles && knowledgeState.recurringStruggles.length > 0) {
                analysis.commonStruggles = knowledgeState.recurringStruggles
                    .sort((a, b) => b.occurrences - a.occurrences)
                    .slice(0, 3)
                    .map(s => s.pattern);
            }

            // Find strong concepts
            if (knowledgeState.concepts && knowledgeState.concepts.length > 0) {
                const strong = knowledgeState.concepts
                    .filter(c => c.masteryScore >= 80)
                    .map(c => c.conceptName);
                analysis.strengthAreas = strong;
            }

            // Infer learning style
            if (knowledgeState.learningProfile) {
                analysis.learningStyleInferred = knowledgeState.learningProfile.dominantLearningStyle;
                analysis.preferredDepth = knowledgeState.learningProfile.preferredDepth;
                analysis.learningPace = knowledgeState.learningProfile.learningPace;
            }

            // Generate recommendations
            if (knowledgeState.concepts) {
                const weak = knowledgeState.concepts
                    .filter(c => c.masteryScore < 50)
                    .sort((a, b) => a.masteryScore - b.masteryScore)
                    .slice(0, 2);
                
                analysis.adaptiveRecommendations = weak.map(c => ({
                    concept: c.conceptName,
                    reason: `Low mastery (${c.masteryScore}/100)`,
                    suggestedAction: c.masteryScore < 30 ? 'TEACH' : 'REVIEW'
                }));
            }

            return analysis;
        } catch (error) {
            log.warn('KNOWLEDGE_ANALYZER', `Pattern analysis failed: ${error.message}`);
            return null;
        }
    }

    /**
     * Update concept understanding based on student performance
     * @param {ObjectId} userId - Student's user ID
     * @param {string} conceptName - Concept being taught
     * @param {object} performance - Performance data { correct: bool, confidence: 0-1, difficulty: 'low'|'medium'|'high' }
     * @returns {Promise<void>}
     */
    async updateConceptMastery(userId, conceptName, performance) {
        try {
            const knowledgeState = await StudentKnowledgeState.findOne({ userId });
            if (!knowledgeState) return;

            // Find or create concept
            let concept = knowledgeState.concepts.find(c => c.conceptName === conceptName);
            
            if (!concept) {
                concept = {
                    conceptName,
                    category: 'intermediate',
                    understandingLevel: 'not_exposed',
                    masteryScore: 0,
                    masteryScoreNormalized: 0,
                    difficulty: performance.difficulty || 'medium',
                    successfulInteractions: 0,
                    totalInteractions: 0,
                    confidenceScore: 0,
                    learningVelocity: 0,
                    strengths: [],
                    weaknesses: [],
                    misconceptions: [],
                    lastInteractionDate: new Date(),
                    tutorNotes: []
                };
                knowledgeState.concepts.push(concept);
            }

            // Update interaction metrics
            concept.totalInteractions = (concept.totalInteractions || 0) + 1;
            if (performance.correct) {
                concept.successfulInteractions = (concept.successfulInteractions || 0) + 1;
            }

            // Calculate new mastery score (weighted towards recent performance)
            const successRate = concept.successfulInteractions / concept.totalInteractions;
            concept.masteryScore = Math.round(successRate * 100);
            concept.masteryScoreNormalized = successRate;

            // Update understanding level based on mastery
            if (concept.masteryScore >= 80) {
                concept.understandingLevel = 'mastered';
            } else if (concept.masteryScore >= 50) {
                concept.understandingLevel = 'comfortable';
            } else if (concept.masteryScore >= 20) {
                concept.understandingLevel = 'learning';
            } else {
                concept.understandingLevel = 'struggling';
            }

            // Update confidence
            concept.confidenceScore = Math.min(1, concept.confidenceScore + (performance.confidence || 0) * 0.1);

            // Track learning velocity (improvement rate)
            const previousScore = concept.masteryScore - (performance.correct ? 5 : 0);
            concept.learningVelocity = concept.masteryScore - previousScore;

            concept.lastInteractionDate = new Date();

            await knowledgeState.save();
            log.info('KNOWLEDGE_ANALYZER', `Updated mastery for ${conceptName}: ${concept.masteryScore}/100`);
        } catch (error) {
            log.warn('KNOWLEDGE_ANALYZER', `Failed to update concept mastery: ${error.message}`);
        }
    }
}

module.exports = new KnowledgeAnalyzer();
