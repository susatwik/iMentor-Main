// server/services/knowledgeStateService.js

const StudentKnowledgeState = require('../models/StudentKnowledgeState');
const ChatHistory = require('../models/ChatHistory');
const log = require('../utils/logger');
const geminiService = require('./geminiService');
const ollamaService = require('./ollamaService');
const groqService = require('./groqService');
const neo4j = require('../config/neo4j');

/**
 * Knowledge State Service
 * Manages student's long-term knowledge profile across sessions
 */
class KnowledgeStateService {
    constructor() {
        this.updateQueue = new Map(); // Queue updates to avoid race conditions
    }

    clamp01(value) {
        const numericValue = Number(value);
        if (Number.isNaN(numericValue)) return 0;
        return Math.max(0, Math.min(1, numericValue));
    }

    /**
     * Synchronize the user profile's conceptMastery map to StudentKnowledgeState and Neo4j
     * @param {ObjectId} userId 
     * @param {StudentKnowledgeState} knowledgeState 
     */
    async syncUserConceptMastery(userId, knowledgeState) {
        try {
            const User = require('../models/User'); // Import dynamically to avoid circular dependencies
            const user = await User.findById(userId);
            if (!user || !user.profile) return;

            const conceptMastery = user.profile.conceptMastery;
            if (!conceptMastery || !(conceptMastery instanceof Map || typeof conceptMastery === 'object')) {
                return;
            }

            const masteryEntries = conceptMastery instanceof Map 
                ? Array.from(conceptMastery.entries()) 
                : Object.entries(conceptMastery);

            let changed = false;
            const now = new Date();

            for (const [rawTopic, score] of masteryEntries) {
                // Topic name from DB map might have '-' instead of '.' (since dot notation is safe key)
                const topic = rawTopic.replace(/-/g, '.');
                
                // Map score to difficulty and understandingLevel
                let difficulty = 'medium';
                if (score >= 80) difficulty = 'low';
                else if (score < 50) difficulty = 'high';

                let understandingLevel = 'learning';
                if (score >= 90) understandingLevel = 'mastered';
                else if (score >= 70) understandingLevel = 'comfortable';
                else if (score < 40) understandingLevel = 'struggling';

                const existingConcept = knowledgeState.getConcept(topic);
                const conceptData = {
                    conceptName: topic,
                    masteryScore: score,
                    masteryScoreNormalized: score / 100,
                    difficulty,
                    understandingLevel,
                    lastInteractionDate: now
                };

                if (existingConcept) {
                    if (existingConcept.masteryScore !== score) {
                        conceptData.totalInteractions = (existingConcept.totalInteractions || 0) + 1;
                        knowledgeState.updateConcept(conceptData);
                        changed = true;
                    }
                } else {
                    conceptData.firstExposureDate = now;
                    conceptData.totalInteractions = 1;
                    knowledgeState.updateConcept(conceptData);
                    changed = true;
                }

                // Sync topic mastery to Neo4j
                await this.syncConceptToNeo4j(userId, {
                    name: topic,
                    mastery: score,
                    difficulty
                });
            }

            // Sync learning style and total sessions count
            if (user.profile.learningStyle && user.profile.learningStyle !== 'Not Specified') {
                const mappedStyle = user.profile.learningStyle.toLowerCase().replace('/', '_');
                if (knowledgeState.learningProfile.dominantLearningStyle !== mappedStyle) {
                    knowledgeState.learningProfile.dominantLearningStyle = mappedStyle;
                    changed = true;
                }
            }

            if (user.profile.quizAttempts !== undefined && knowledgeState.engagementMetrics.totalSessions < user.profile.quizAttempts) {
                knowledgeState.engagementMetrics.totalSessions = user.profile.quizAttempts;
                changed = true;
            }

            if (changed) {
                knowledgeState.markModified('concepts');
                knowledgeState.markModified('learningProfile');
                knowledgeState.markModified('engagementMetrics');
                await knowledgeState.save();
                log.info('SYSTEM', `Successfully synced user concept masteries for ${userId}`);
            }
        } catch (error) {
            log.error('SYSTEM', `Error syncing concept masteries for user ${userId}`, error);
        }
    }

    /**
     * Get or create student knowledge state
     * @param {ObjectId} userId - Student's user ID
     * @returns {Promise<StudentKnowledgeState>}
     */
    async getOrCreateKnowledgeState(userId) {
        try {
            let knowledgeState = await StudentKnowledgeState.findOne({ userId });

            if (!knowledgeState) {
                log.info('SYSTEM', `Initializing knowledge state for ${userId}`);
                knowledgeState = new StudentKnowledgeState({
                    userId,
                    knowledgeSummary: 'New student - no learning history yet.',
                    engagementMetrics: {
                        lastActiveDate: new Date()
                    }
                });
                await knowledgeState.save();

                // Initialize in Neo4j
                try {
                    await neo4j.runQuery(
                        'MERGE (s:Student {id: $userId}) SET s.lastUpdated = datetime()',
                        { userId: userId.toString() }
                    );
                } catch (e) {
                    log.warn('SYSTEM', `Neo4j init failed for ${userId}: ${e.message}`);
                }
            }

            // Sync user profile stats on retrieve
            await this.syncUserConceptMastery(userId, knowledgeState);

            return knowledgeState;
        } catch (error) {
            log.error('SYSTEM', `Error getting knowledge state for ${userId}`, error);
            throw error;
        }
    }

    /**
     * Analyze a conversation and extract knowledge insights
     * @param {string} sessionId - Chat session ID
     * @param {ObjectId} userId - Student's user ID
     * @param {Array} messages - Chat messages
     * @param {Object} llmConfig - LLM configuration
     * @returns {Promise<Object>} Extracted insights
     */
    async analyzeConversationForInsights(sessionId, userId, messages, llmConfig) {
        try {
            if (!messages || messages.length < 2) {
                return null; // Not enough conversation to analyze
            }

            // Format conversation for analysis
            const conversationText = messages.map(msg => {
                const role = msg.role === 'user' ? 'Student' : 'Tutor';
                const text = msg.parts?.[0]?.text || '';
                return `${role}: ${text}`;
            }).join('\n\n');

            const analysisPrompt = `You are an expert educational psychologist and knowledge engineer. Analyze the following tutoring session to track the student's mastery of specific, granular concepts.

CRITICAL RULES:
1. Concepts must be granular (e.g., "recursion.base_case", "recursion.recursive_step", "gradient_descent.learning_rate")
2. mastery MUST be 0-100 (integers only, NO negative values)
3. difficulty MUST be exactly one of: "low", "medium", "high" (NO other values like "N/A")
4. inferredLearningStyle MUST be exactly one of: "visual", "auditory", "kinesthetic", "reading_writing", "mixed", "unknown"

Analyze the following conversation and extract:
1. **Concepts Discussed**: List granular concepts mentioned
2. **Mastery Score**: A score from 0 to 100 representing their current understanding (0 if not exposed, 100 if mastered).
3. **Difficulty**: Assessed difficulty for THIS student - MUST be "low", "medium", or "high" ONLY.
4. **Strengths**: Specific aspects they grasped well.
5. **Weaknesses**: Specific aspects they struggled with.
6. **Misconceptions**: Any incorrect beliefs detected.
7. **Learning Style Inferred**: How they seem to learn best - MUST be one of: "visual", "auditory", "kinesthetic", "reading_writing", "mixed", "unknown"

CONVERSATION:
${conversationText}

Respond with a JSON object in this exact format (NO deviations):
{
  "concepts": [
    {
      "name": "string (granular.name)",
      "mastery": number (0-100, NO negatives),
      "difficulty": "low|medium|high" (ONLY these 3 values),
      "evidence": "brief reasoning",
      "misconceptions": ["string"],
      "strengths": ["string"],
      "weaknesses": ["string"]
    }
  ],
  "inferredLearningStyle": "visual|auditory|kinesthetic|reading_writing|mixed|unknown" (ONLY these 6 values),
  "summary": "2-3 sentence summary of progress",
  "overallEngagement": "low|medium|high"
}`;

            const { callWithFallback } = require('./llmFallbackService');
            const fallbackResult = await callWithFallback({
                userQuery: analysisPrompt,
                preferredProvider: llmConfig.llmProvider || 'sglang',
                preferLocalFirst: true,
                userApiKeys: { gemini: llmConfig.apiKey, groq: llmConfig.apiKey },
                ollamaUrl: llmConfig.ollamaUrl,
                options: {
                    model: llmConfig.sglangModel || llmConfig.ollamaModel || llmConfig.groqModel || llmConfig.geminiModel,
                    geminiModel: llmConfig.geminiModel
                }
            });
            response = fallbackResult.text;

            // Parse JSON response
            const insights = this.parseJSON(response);

            // Sanitize and validate insights
            if (insights && insights.concepts) {
                insights.concepts = insights.concepts.map(c => {
                    // Ensure mastery is 0-100
                    c.mastery = Math.max(0, Math.min(100, parseInt(c.mastery) || 0));

                    // Ensure difficulty is valid enum
                    if (!['low', 'medium', 'high'].includes(c.difficulty)) {
                        c.difficulty = 'medium'; // Default
                    }

                    return c;
                });

                // Ensure learning style is valid enum
                const validStyles = ['visual', 'auditory', 'kinesthetic', 'reading_writing', 'mixed', 'unknown'];
                if (!validStyles.includes(insights.inferredLearningStyle)) {
                    insights.inferredLearningStyle = 'mixed'; // Default
                }
            }

            log.info('AI', `Extracted ${insights.concepts?.length || 0} concepts for ${sessionId}`);

            return insights;
        } catch (error) {
            log.error('AI', `Analysis failed for ${sessionId}`, error);
            return null;
        }
    }

    /**
     * Update student knowledge state based on session insights
     * @param {ObjectId} userId - Student's user ID
     * @param {string} sessionId - Chat session ID
     * @param {Object} insights - Extracted insights from conversation
     * @returns {Promise<StudentKnowledgeState>}
     */
    async updateKnowledgeStateFromInsights(userId, sessionId, insights) {
        try {
            if (!insights) {
            log.warn('SYSTEM', `No insights to update for ${userId}`);
                return null;
            }

            const knowledgeState = await this.getOrCreateKnowledgeState(userId);
            const now = new Date();

            // Cache old mastery scores for velocity calculation
            const oldMasteryMap = new Map();
            knowledgeState.concepts.forEach(c => oldMasteryMap.set(c.conceptName, c.masteryScore));

            // Update concepts
            if (insights.concepts && Array.isArray(insights.concepts)) {
                for (const conceptInsight of insights.concepts) {
                    // Validate concept insight data
                    if (!conceptInsight.name || typeof conceptInsight.name !== 'string') {
                        log.warn('SYSTEM', 'Invalid concept name skipped');
                        continue;
                    }

                    const existingConcept = knowledgeState.getConcept(conceptInsight.name);
                    const newMastery = Math.max(0, Math.min(100, parseInt(conceptInsight.mastery) || 0));

                    let conceptToUpdate;
                    if (existingConcept) {
                        // Calculate velocity: (New - Old) / Interactions
                        const oldMastery = existingConcept.masteryScore;
                        const interactions = existingConcept.totalInteractions + 1;
                        existingConcept.learningVelocity = (newMastery - oldMastery) / interactions;

                        // Update fields
                        existingConcept.masteryScore = newMastery;
                        existingConcept.masteryScoreNormalized = this.clamp01(newMastery / 100);
                        existingConcept.difficulty = conceptInsight.difficulty || existingConcept.difficulty;
                        existingConcept.totalInteractions = interactions;
                        existingConcept.lastInteractionDate = now;
                        conceptToUpdate = existingConcept;
                    } else {
                        // Add new concept
                        const newConcept = {
                            conceptName: conceptInsight.name,
                            masteryScore: newMastery,
                            masteryScoreNormalized: this.clamp01(newMastery / 100),
                            difficulty: conceptInsight.difficulty || 'medium',
                            learningVelocity: newMastery / 1, // First jump
                            totalInteractions: 1,
                            lastInteractionDate: now,
                            firstExposureDate: now,
                            strengths: [],
                            weaknesses: [],
                            misconceptions: [],
                            tutorNotes: []
                        };
                        knowledgeState.concepts.push(newConcept);
                        conceptToUpdate = knowledgeState.concepts[knowledgeState.concepts.length - 1];
                    }

                    // Map mastery to understanding level
                    if (newMastery >= 90) conceptToUpdate.understandingLevel = 'mastered';
                    else if (newMastery >= 70) conceptToUpdate.understandingLevel = 'comfortable';
                    else if (newMastery >= 40) conceptToUpdate.understandingLevel = 'learning';
                    else conceptToUpdate.understandingLevel = 'struggling';

                    conceptToUpdate.confidenceScore = newMastery / 100;
                    conceptToUpdate.masteryScoreNormalized = this.clamp01(newMastery / 100);

                    // CRITICAL: Prevent contradictory states
                    // Rule 1: Mastered concepts cannot have high difficulty
                    if (conceptToUpdate.understandingLevel === 'mastered' && conceptToUpdate.difficulty === 'high') {
                        conceptToUpdate.difficulty = 'low';
                        log.info('SYSTEM', `Auto-corrected ${conceptInsight.name} mastery level`);
                    }

                    // Rule 2: Struggling concepts with low mastery should have at least medium difficulty
                    if (conceptToUpdate.understandingLevel === 'struggling' && conceptToUpdate.difficulty === 'low' && newMastery < 40) {
                        conceptToUpdate.difficulty = 'medium';
                        // log.info('SYSTEM', `Auto-corrected ${conceptInsight.name} difficulty`);
                    }

                    // Rule 3: High mastery (>80) with high difficulty is contradictory
                    if (newMastery > 80 && conceptToUpdate.difficulty === 'high') {
                        conceptToUpdate.difficulty = 'medium';
                        // log.info('SYSTEM', `Auto-corrected ${conceptInsight.name} mastery conflict`);
                    }

                    // Add strengths/weaknesses
                    if (conceptInsight.strengths) {
                        conceptInsight.strengths.forEach(s => {
                            if (!conceptToUpdate.strengths.some(ex => ex.aspect === s)) {
                                conceptToUpdate.strengths.push({ aspect: s, evidence: conceptInsight.evidence, detectedAt: now });
                            }
                        });
                    }

                    if (conceptInsight.weaknesses) {
                        conceptInsight.weaknesses.forEach(w => {
                            if (!conceptToUpdate.weaknesses.some(ex => ex.aspect === w)) {
                                conceptToUpdate.weaknesses.push({ aspect: w, evidence: conceptInsight.evidence, detectedAt: now });
                                // Track recurring struggles
                                this.updateRecurringStruggles(knowledgeState, w, conceptInsight.name);
                            }
                        });
                    }

                    // Add misconceptions
                    if (conceptInsight.misconceptions) {
                        conceptInsight.misconceptions.forEach(m => {
                            if (!conceptToUpdate.misconceptions.some(ex => ex.description === m && ex.stillPresent)) {
                                conceptToUpdate.misconceptions.push({ description: m, stillPresent: true });
                            }
                        });
                    }

                    if (conceptInsight.evidence) {
                        conceptToUpdate.tutorNotes.push({
                            note: conceptInsight.evidence,
                            sessionId,
                            timestamp: now
                        });
                    }

                    // SYNC TO NEO4J
                    await this.syncConceptToNeo4j(userId, conceptInsight);
                }
            }

            // Update overall learning velocity
            const totalMastery = knowledgeState.concepts.reduce((sum, c) => sum + c.masteryScore, 0);
            const avgMastery = knowledgeState.concepts.length > 0 ? totalMastery / knowledgeState.concepts.length : 0;
            knowledgeState.engagementMetrics.learningVelocity = avgMastery / (knowledgeState.engagementMetrics.totalSessions + 1);

            // Update learning profile
            if (insights.inferredLearningStyle) {
                knowledgeState.learningProfile.dominantLearningStyle = insights.inferredLearningStyle;
            }

            // Session insights - Update existing or push new
            const existingSessionIdx = knowledgeState.sessionInsights.findIndex(s => s.sessionId === sessionId);
            const sessionData = {
                sessionId,
                date: now,
                keyObservations: [insights.summary].filter(Boolean),
                conceptsCovered: insights.concepts?.map(c => c.name) || [],
                struggledWith: insights.concepts?.flatMap(c => c.weaknesses || []) || []
            };

            if (existingSessionIdx !== -1) {
                knowledgeState.sessionInsights[existingSessionIdx] = sessionData;
            } else {
                knowledgeState.sessionInsights.push(sessionData);
            }

            knowledgeState.engagementMetrics.totalSessions += 1;
            knowledgeState.engagementMetrics.lastActiveDate = now;
            knowledgeState.knowledgeSummary = insights.summary || knowledgeState.knowledgeSummary;

            await knowledgeState.save();
            return knowledgeState;
        } catch (error) {
            log.error('SYSTEM', `Update failed for ${userId}`, error);
            throw error;
        }
    }

    /**
     * Update recurring struggles tracker
     */
    updateRecurringStruggles(knowledgeState, pattern, conceptName) {
        const existingStruggle = knowledgeState.recurringStruggles.find(s =>
            s.pattern.toLowerCase().includes(pattern.toLowerCase()) ||
            pattern.toLowerCase().includes(s.pattern.toLowerCase())
        );

        if (existingStruggle) {
            existingStruggle.occurrences += 1;
            existingStruggle.lastDetected = new Date();
            if (!existingStruggle.examples.includes(conceptName)) {
                existingStruggle.examples.push(conceptName);
            }
        } else {
            knowledgeState.recurringStruggles.push({
                pattern,
                occurrences: 1,
                firstDetected: new Date(),
                lastDetected: new Date(),
                examples: [conceptName]
            });
        }
    }

    /**
     * Event-based memory update (no LLM calls)
     * @param {ObjectId} userId
     * @param {string} sessionId
     * @param {string} eventType - student_answer_correct|student_answer_wrong|hint_used|concept_mastered
     * @param {Object} data
     */
    async updateKnowledgeFromTutorEvent(userId, sessionId, eventType, data = {}) {
        try {
            const conceptNameRaw = data.conceptName || data.topic || data.teachingUnit || 'general';
            const conceptName = String(conceptNameRaw).trim();
            if (!conceptName) return null;

            const knowledgeState = await this.getOrCreateKnowledgeState(userId);
            const now = new Date();
            const normalizedName = conceptName.toLowerCase();

            let concept = knowledgeState.concepts.find(c => c.conceptName.toLowerCase() === normalizedName);
            if (!concept) {
                knowledgeState.concepts.push({
                    conceptName,
                    understandingLevel: 'not_exposed',
                    masteryScore: 0,
                    masteryScoreNormalized: 0,
                    difficulty: 'medium',
                    totalInteractions: 0,
                    successfulInteractions: 0,
                    lastInteractionDate: now,
                    firstExposureDate: now,
                    strengths: [],
                    weaknesses: [],
                    misconceptions: [],
                    tutorNotes: []
                });
                concept = knowledgeState.concepts[knowledgeState.concepts.length - 1];
            }

            let currentNormalized = typeof concept.masteryScoreNormalized === 'number'
                ? concept.masteryScoreNormalized
                : this.clamp01((concept.masteryScore || 0) / 100);

            const deltaByEvent = {
                student_answer_correct: 0.05,
                student_answer_wrong: -0.03,
                hint_used: -0.02
            };

            if (eventType === 'concept_mastered') {
                currentNormalized = Math.max(currentNormalized, 0.9);
            } else {
                currentNormalized += (deltaByEvent[eventType] || 0);
            }

            currentNormalized = this.clamp01(currentNormalized);
            concept.masteryScoreNormalized = Number(currentNormalized.toFixed(3));
            concept.masteryScore = Math.round(currentNormalized * 100);
            concept.totalInteractions = (concept.totalInteractions || 0) + 1;
            if (eventType === 'student_answer_correct') {
                concept.successfulInteractions = (concept.successfulInteractions || 0) + 1;
            }
            concept.lastInteractionDate = now;

            if (currentNormalized >= 0.9) concept.understandingLevel = 'mastered';
            else if (currentNormalized >= 0.7) concept.understandingLevel = 'comfortable';
            else if (currentNormalized >= 0.4) concept.understandingLevel = 'learning';
            else concept.understandingLevel = 'struggling';

            if (eventType === 'student_answer_wrong' || eventType === 'hint_used') {
                this.updateRecurringStruggles(knowledgeState, conceptName, conceptName);
            }

            knowledgeState.knowledgeSummary = `Recent focus: ${conceptName} (${concept.masteryScore}% mastery)`;

            const existingSessionIdx = knowledgeState.sessionInsights.findIndex(s => s.sessionId === sessionId);
            if (existingSessionIdx !== -1) {
                const existing = knowledgeState.sessionInsights[existingSessionIdx];
                if (!existing.conceptsCovered.includes(conceptName)) {
                    existing.conceptsCovered.push(conceptName);
                }
                if ((eventType === 'student_answer_wrong' || eventType === 'hint_used') && !existing.struggledWith.includes(conceptName)) {
                    existing.struggledWith.push(conceptName);
                }
            } else {
                knowledgeState.sessionInsights.push({
                    sessionId,
                    date: now,
                    keyObservations: [`Event: ${eventType}`],
                    conceptsCovered: [conceptName],
                    breakthroughMoments: eventType === 'concept_mastered' ? [conceptName] : [],
                    struggledWith: (eventType === 'student_answer_wrong' || eventType === 'hint_used') ? [conceptName] : []
                });
            }

            await knowledgeState.save();

            await this.syncConceptToNeo4j(userId, {
                name: conceptName,
                mastery: concept.masteryScore,
                difficulty: concept.difficulty || 'medium'
            });

            return {
                conceptName,
                masteryScore: concept.masteryScore,
                masteryScoreNormalized: concept.masteryScoreNormalized,
                understandingLevel: concept.understandingLevel
            };
        } catch (error) {
            log.warn('SYSTEM', `Event-based update failed for ${userId}: ${error.message}`);
            return null;
        }
    }

    /**
     * Sync a concept mastery to Neo4j
     */
    async syncConceptToNeo4j(userId, conceptInsight) {
        try {
            const relationshipType =
                conceptInsight.mastery >= 80 ? 'MASTERED' :
                    conceptInsight.mastery >= 40 ? 'IMPROVING_IN' : 'STRUGGLES_WITH';

            // Delete old relationships of these types to avoid contradictions
            await neo4j.runQuery(`
                MATCH (s:Student {id: $userId})-[r:MASTERED|IMPROVING_IN|STRUGGLES_WITH]->(c:Concept {name: $conceptName})
                DELETE r
            `, { userId: userId.toString(), conceptName: conceptInsight.name });

            // Create new relationship
            await neo4j.runQuery(`
                MERGE (s:Student {id: $userId})
                MERGE (c:Concept {name: $conceptName})
                MERGE (s)-[r:${relationshipType}]->(c)
                SET r.mastery = $mastery,
                    r.difficulty = $difficulty,
                    r.lastUpdated = timestamp()
            `, {
                userId: userId.toString(),
                conceptName: conceptInsight.name,
                mastery: conceptInsight.mastery,
                difficulty: conceptInsight.difficulty || 'medium'
            });
        } catch (error) {
            log.warn('SYSTEM', `Neo4j sync failed: ${conceptInsight.name}`);
        }
    }

    /**
     * Get prerequisites for a concept from Neo4j
     */
    async getPrerequisites(conceptName) {
        try {
            const result = await neo4j.runQuery(`
                MATCH (c:Concept {name: $conceptName})-[:REQUIRES]->(pre:Concept)
                RETURN pre.name as name
            `, { conceptName });

            return result.records.map(record => record.get('name'));
        } catch (error) {
            log.warn('SYSTEM', `Prerequisite fetch failed for ${conceptName}`);
            return [];
        }
    }

    /**
     * Check if a student has mastered prerequisites for a concept
     */
    async checkPrerequisitesMastery(userId, conceptName) {
        const prerequisites = await this.getPrerequisites(conceptName);
        if (prerequisites.length === 0) return { allMastered: true, missing: [] };

        const knowledgeState = await StudentKnowledgeState.findOne({ userId });
        if (!knowledgeState) return { allMastered: false, missing: prerequisites };

        const missing = [];
        for (const pre of prerequisites) {
            const concept = knowledgeState.concepts.find(c => c.conceptName.toLowerCase() === pre.toLowerCase());
            if (!concept || concept.masteryScore < 60) {
                missing.push(pre);
            }
        }

        return {
            allMastered: missing.length === 0,
            missing: missing
        };
    }

    /**
     * Get contextual memory for a student
     * @param {ObjectId} userId - Student's user ID
     * @returns {Promise<string>} Formatted context string
     */
    async getContextualMemory(userId) {
        try {
            const User = require('../models/User');
            const user = await User.findById(userId);
            const knowledgeState = await StudentKnowledgeState.findOne({ userId });

            if (!knowledgeState && !user) {
                return null;
            }

            const struggling = knowledgeState ? knowledgeState.concepts.filter(c => c.difficulty === 'high' || c.masteryScore < 70) : [];
            const mastered = knowledgeState ? knowledgeState.concepts.filter(c => c.masteryScore >= 85) : [];
            const dominantStyle = knowledgeState ? knowledgeState.learningProfile.dominantLearningStyle : 'unknown';
            const velocity = knowledgeState ? knowledgeState.engagementMetrics.learningVelocity : 0;

            let context = `=== STUDENT CONTEXTUAL MEMORY ===\n`;
            context += `Overall Learning Velocity: ${velocity.toFixed(2)} pts/session\n`;
            context += `Preferred Style: ${dominantStyle}\n\n`;

            // Read from user profile global lists
            const globalStrongTopics = user?.profile?.strongTopics || [];
            const globalWeakTopics = user?.profile?.weakTopics || [];

            if (globalStrongTopics.length > 0 || mastered.length > 0) {
                const combinedStrongs = Array.from(new Set([
                    ...globalStrongTopics,
                    ...mastered.map(c => c.conceptName)
                ]));

                context += `STRENGTHS (Mastered or highly accurate concepts):\n`;
                combinedStrongs.slice(0, 8).forEach(t => {
                    context += `- ${t} (Strong Mastery)\n`;
                });
                context += '\n';

                context += `IMPORTANT INSTRUCTIONS FOR STRONG/MASTERED TOPICS:\n`;
                context += `- If the student asks about any of these topics, briefly acknowledge their competence and immediately direct them towards advanced applications, structural design trade-offs, or complex edge cases.\n`;
                context += `- Ask challenging, high-level questions that require deep technical reasoning. Reduce assistance and hints.\n\n`;
            }

            if (globalWeakTopics.length > 0 || struggling.length > 0) {
                const combinedWeaks = Array.from(new Set([
                    ...globalWeakTopics,
                    ...struggling.map(c => c.conceptName)
                ]));

                context += `WEAKNESSES (Concepts requiring simplified analogies, step-by-step guidance):\n`;
                combinedWeaks.slice(0, 8).forEach(t => {
                    context += `- ${t} (Needs Remediation)\n`;
                });
                context += '\n';

                context += `MANDATORY INSTRUCTIONS FOR WEAK/STRUGGLING TOPICS:\n`;
                context += `- If the student asks about any of these topics, you MUST slow down and break down the concepts into simpler subtopics.\n`;
                context += `- Use clear real-world analogies and step-by-step walk-throughs.\n`;
                context += `- Check understanding frequently and provide helpful hints. Do not skip straight to code or complex setups.\n\n`;
            }

            if (knowledgeState && knowledgeState.recurringStruggles.length > 0) {
                const topStruggle = knowledgeState.recurringStruggles.sort((a, b) => b.occurrences - a.occurrences)[0];
                context += `CRITICAL PATTERN: Student frequently ${topStruggle.pattern}\n\n`;
            }

            context += `=== END CONTEXT ===\n`;
            return context;
        } catch (error) {
            log.error('SYSTEM', `Memory read failed for ${userId}`, error);
            return null;
        }
    }

    /**
     * Update knowledge real-time during session
     */
    async updateKnowledgeRealTime(userId, sessionId, eventType, data, llmConfig) {
        log.info('SYSTEM', `Real-time knowledge update (${eventType})`);

        if (eventType === 'TUTOR_ASSESSMENT') {
            const { conceptName, classification, reasoning } = data;
            if (!conceptName || !classification) return;

            try {
                const knowledgeState = await this.getOrCreateKnowledgeState(userId);
                const now = new Date();

                // Map classification to mastery change
                // CORRECT: +15, PARTIAL: +5, MISCONCEPTION: -10, VAGUE: 0
                const masteryAdjustments = {
                    'CORRECT': 15,
                    'PARTIAL': 5,
                    'MISCONCEPTION': -10,
                    'VAGUE': 0
                };

                const adjustment = masteryAdjustments[classification] || 0;
                let existingConcept = knowledgeState.getConcept(conceptName);

                if (existingConcept) {
                    // Update existing
                    const oldMastery = existingConcept.masteryScore;
                    existingConcept.masteryScore = Math.max(0, Math.min(100, oldMastery + adjustment));
                    existingConcept.masteryScoreNormalized = this.clamp01(existingConcept.masteryScore / 100);
                    existingConcept.totalInteractions += 1;
                    existingConcept.lastInteractionDate = now;

                    // Update understanding level
                    if (existingConcept.masteryScore >= 90) existingConcept.understandingLevel = 'mastered';
                    else if (existingConcept.masteryScore >= 70) existingConcept.understandingLevel = 'comfortable';
                    else if (existingConcept.masteryScore >= 40) existingConcept.understandingLevel = 'learning';
                    else existingConcept.understandingLevel = 'struggling';

                    existingConcept.tutorNotes.push({
                        note: `Real-time assessment: ${classification}. Reasoning: ${reasoning}`,
                        sessionId,
                        timestamp: now
                    });
                } else {
                    // Add new
                    const initialMastery = Math.max(0, adjustment);
                    knowledgeState.concepts.push({
                        conceptName,
                        understandingLevel: initialMastery >= 40 ? 'learning' : 'struggling',
                        masteryScore: initialMastery,
                        masteryScoreNormalized: this.clamp01(initialMastery / 100),
                        difficulty: 'medium',
                        totalInteractions: 1,
                        lastInteractionDate: now,
                        firstExposureDate: now,
                        tutorNotes: [{
                            note: `Initial real-time assessment: ${classification}. Reasoning: ${reasoning}`,
                            sessionId,
                            timestamp: now
                        }]
                    });
                }

                await knowledgeState.save();

                // Sync to Neo4j
                await this.syncConceptToNeo4j(userId, {
                    name: conceptName,
                    mastery: existingConcept ? existingConcept.masteryScore : Math.max(0, adjustment),
                    difficulty: 'medium'
                });

                log.info('SYSTEM', `Updated ${conceptName} mastery real-time`);
            } catch (error) {
                log.error('SYSTEM', 'Real-time update failed', error);
            }
        }
    }

    /**
     * Parse JSON from LLM response
     */
    parseJSON(response) {
        if (!response || typeof response !== 'string') {
            throw new Error('Invalid JSON input: response is empty or not a string');
        }
        try {
            return JSON.parse(response);
        } catch {
            const jsonMatch = response.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
            if (jsonMatch) return JSON.parse(jsonMatch[1]);
            const objectMatch = response.match(/\{[\s\S]*\}/);
            if (objectMatch) return JSON.parse(objectMatch[0]);
            throw new Error('Could not parse JSON');
        }
    }

    /**
     * Process session end
     */
    async processSessionEnd(sessionId, userId, llmConfig) {
        try {
            log.info('SYSTEM', `Finalizing session memory for ${sessionId}`);
            const chatHistory = await ChatHistory.findOne({ sessionId, userId });
            if (!chatHistory || chatHistory.messages.length < 2) return;

            const insights = await this.analyzeConversationForInsights(sessionId, userId, chatHistory.messages, llmConfig);
            if (!insights) return;

            await this.updateKnowledgeStateFromInsights(userId, sessionId, insights);

            // Mark chat history as analyzed
            await ChatHistory.findOneAndUpdate({ sessionId }, {
                $set: {
                    'sessionMetadata.insightsGenerated': true,
                    summary: insights.summary
                }
            });

        } catch (error) {
            log.error('SYSTEM', `Session finalization failed for ${sessionId}`, error);
        }
    }

    /**
     * Get struggling topics for a user (for acknowledgment prepending)
     * @param {ObjectId} userId - Student's user ID
     * @returns {Promise<Array>} Array of struggling topics
     */
    async getStrugglingTopics(userId) {
        try {
            const knowledgeState = await StudentKnowledgeState.findOne({ userId });

            if (!knowledgeState || knowledgeState.concepts.length === 0) {
                return [];
            }

            // Return concepts with mastery < 70 or difficulty === 'high'
            const struggling = knowledgeState.concepts.filter(c =>
                c.difficulty === 'high' || c.masteryScore < 70
            );

            return struggling;
        } catch (error) {
            log.error('SYSTEM', 'Error getting struggling topics', error);
            return [];
        }
    }
    /**
     * Get a natural language acknowledgment prefix for struggling topics
     * @param {string} userId - User ID
     * @param {string} query - Student query
     * @returns {Promise<string>} Acknowledgment string or empty string
     */
    async getAcknowledgmentPrefix(userId, query) {
        try {
            const strugglingTopics = await this.getStrugglingTopics(userId);
            if (!strugglingTopics || strugglingTopics.length === 0) return '';

            const queryLower = query.toLowerCase();
            for (const topic of strugglingTopics) {
                const topicKeyword = topic.conceptName.split('.')[0].toLowerCase();
                if (queryLower.includes(topicKeyword)) {
                    return `I remember you found ${topicKeyword} challenging before, so let me explain it differently...\n\n`;
                }
            }
        } catch (error) {
            log.error('SYSTEM', 'Error generating acknowledgment', error);
        }
        return '';
    }
}

module.exports = new KnowledgeStateService();
