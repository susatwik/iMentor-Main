// server/services/bountyService.js
const BountyQuestion = require('../models/BountyQuestion');
const GamificationProfile = require('../models/GamificationProfile');
const knowledgeStateService = require('./knowledgeStateService');
const { selectLLM } = require('./llmRouterService');
const geminiService = require('./geminiService');
const groqService = require('./groqService');
const log = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

/**
 * Analyze user's knowledge gaps using Contextual Memory (StudentKnowledgeState)
 * Much faster and more accurate than re-analyzing chat history each time
 * @param {string} userId - User ID
 * @returns {Promise<Object>} - Knowledge gaps analysis
 */
async function analyzeKnowledgeGaps(userId) {
    try {
        // log.info('SYSTEM', `Analyzing gaps for user ${userId}`);

        // Get struggling topics from contextual memory
        const strugglingTopics = await knowledgeStateService.getStrugglingTopics(userId);

        if (strugglingTopics && strugglingTopics.length > 0) {
            // Sort by lowest mastery (most struggling first)
            const sortedTopics = strugglingTopics
                .sort((a, b) => (a.masteryScore || 0) - (b.masteryScore || 0))
                .slice(0, 5);

            // log.info('SYSTEM', `Found ${sortedTopics.length} struggling topics`);

            return {
                weakTopics: sortedTopics.map(t => t.conceptName || t.topic || 'General Knowledge'),
                masteryScores: sortedTopics.reduce((acc, t) => {
                    acc[t.conceptName || t.topic] = t.masteryScore || 0;
                    return acc;
                }, {}),
                misconceptions: sortedTopics.flatMap(t => t.misconceptions || []).slice(0, 5),
                weaknesses: sortedTopics.flatMap(t => t.weaknesses || []).slice(0, 5),
                analysisSource: 'contextual_memory',
                analysisDate: new Date()
            };
        }

        // Fallback: Check knowledge state directly if service returned empty
        try {
            const StudentKnowledgeState = require('../models/StudentKnowledgeState');
            const state = await StudentKnowledgeState.findOne({ userId });

            if (state && state.concepts && state.concepts.length > 0) {
                // Find struggling concepts (mastery < 60)
                const strugglingConcepts = state.concepts
                    .filter(c => c.masteryScore < 60)
                    .sort((a, b) => a.masteryScore - b.masteryScore)
                    .slice(0, 5);

                if (strugglingConcepts.length > 0) {
                    // log.info('SYSTEM', `Found ${strugglingConcepts.length} struggling concepts (DB)`);
                    return {
                        weakTopics: strugglingConcepts.map(c => c.conceptName),
                        masteryScores: strugglingConcepts.reduce((acc, c) => {
                            acc[c.conceptName] = c.masteryScore;
                            return acc;
                        }, {}),
                        misconceptions: strugglingConcepts.flatMap(c => c.misconceptions || []),
                        weaknesses: strugglingConcepts.flatMap(c => c.weaknesses || []),
                        analysisSource: 'knowledge_state_db',
                        analysisDate: new Date()
                    };
                }
            }

            // Check focus areas as last resort
            if (state && state.focusAreas && state.focusAreas.length > 0) {
                return {
                    weakTopics: state.focusAreas.slice(0, 3).map(f => f.topic || 'General Knowledge'),
                    masteryScores: {},
                    misconceptions: [],
                    weaknesses: [],
                    analysisSource: 'focus_areas',
                    analysisDate: new Date()
                };
            }
        } catch (err) {
            log.warn('SYSTEM', `Knowledge state fallback failed: ${err.message}`);
        }

        // Final fallback
        // log.info('SYSTEM', `No memory found for ${userId}, using default topic`);
        return {
            weakTopics: ['General Knowledge'],
            masteryScores: {},
            misconceptions: [],
            weaknesses: [],
            analysisSource: 'default',
            analysisDate: new Date()
        };

    } catch (error) {
        log.error('SYSTEM', 'Error analyzing knowledge gaps', error);
        return {
            weakTopics: ['General Knowledge'],
            masteryScores: {},
            misconceptions: [],
            weaknesses: [],
            analysisSource: 'error_fallback',
            analysisDate: new Date()
        };
    }
}

/**
 * Generate a bounty question based on knowledge gaps
 * @param {string} userId - User ID
 * @param {Object} gapAnalysis - Knowledge gap data
 * @returns {Promise<Object>} - Generated bounty question
 */
async function generateBountyQuestion(userId, gapAnalysis) {
    try {
        if (!gapAnalysis || !gapAnalysis.weakTopics || gapAnalysis.weakTopics.length === 0) {
            log.warn('SYSTEM', `No knowledge gaps for user ${userId}`);
            return null;
        }

        // Select weakest topic
        const targetTopic = gapAnalysis.weakTopics[0];

        // Determine difficulty based on user level
        const profile = await GamificationProfile.findOne({ userId });
        const userLevel = profile?.level || 1;

        let difficulty = 'easy';
        if (userLevel >= 10) difficulty = 'expert';
        else if (userLevel >= 7) difficulty = 'hard';
        else if (userLevel >= 4) difficulty = 'medium';

        // Generate question using AI
        const systemPrompt = `You are an expert academic tutor specializing in ${targetTopic}. 
Your task is to generate highly accurate, challenging, and pedagogical multiple-choice questions that strictly follow the provided topic. 
Do NOT generate general knowledge questions unless the topic is "General Knowledge". 
Focus on technical details and concepts within the context of ${targetTopic}.`;

        const prompt = `As a ${difficulty} level expert, generate a challenging multiple-choice question about "${targetTopic}".
The student has shown weakness in this area based on their recent learning patterns.

Return ONLY a JSON object with this exact structure (no other text):
{
  "questionText": "Specific technical question about ${targetTopic}?",
  "questionType": "multiple_choice",
  "options": ["Accurate option text", "Plausible distractor", "Another distractor", "Fourth option"],
  "correctAnswer": "Option X",
  "explanation": "Brief pedagogical explanation of why the answer is correct.",
  "creditReward": ${difficulty === 'expert' ? 25 : (difficulty === 'hard' ? 15 : (difficulty === 'medium' ? 10 : 5))},
  "xpBonus": ${difficulty === 'expert' ? 25 : (difficulty === 'hard' ? 15 : (difficulty === 'medium' ? 10 : 5))}
}`;

        const { chosenModel } = await selectLLM(prompt, { user: { _id: userId }, subject: targetTopic });

        let questionData;
        let generationSuccess = false;

        if (chosenModel.provider === 'ollama') {
            try {
                // log.info('SYSTEM', 'Attempting bounty generation with Ollama...');
                const ollamaService = require('./ollamaService');
                const response = await ollamaService.generateContentWithHistory(
                    [],      // empty chat history
                    prompt,  // the bounty question prompt
                    systemPrompt,    // added system prompt
                    {
                        model: chosenModel.provider === 'ollama' ? chosenModel.modelId : 'llama3.2:latest',
                        ollamaUrl: process.env.OLLAMA_API_BASE_URL || 'http://localhost:11434',
                        temperature: 0.7
                    }
                );
                const jsonMatch = response.match(/\{[\s\S]*\}/);
                questionData = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
                if (questionData) {
                    generationSuccess = true;
                    // log.success('SYSTEM', 'Ollama generation successful');
                }
            } catch (ollamaError) {
                log.info('SYSTEM', 'Falling back from Ollama...');
            }
        } else if (chosenModel.provider === 'groq') {
            try {
                // log.info('SYSTEM', 'Attempting bounty generation with Groq...');
                const apiKey = process.env.GROQ_API_KEY;
                if (!apiKey) {
                    throw new Error('Groq API key not configured');
                }
                const response = await groqService.generateContentWithHistory(
                    [],
                    prompt,
                    systemPrompt,
                    {
                        model: chosenModel.modelId || 'llama-3.1-8b-instant',
                        apiKey: apiKey,
                        temperature: 0.7
                    }
                );
                const jsonMatch = response.match(/\{[\s\S]*\}/);
                questionData = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
                if (questionData) {
                    generationSuccess = true;
                    // log.success('SYSTEM', 'Groq generation successful');
                }
            } catch (groqError) {
                log.info('SYSTEM', 'Falling back from Groq...');
            }
        }

        // Fallback to Gemini if Ollama failed or if Gemini was selected
        if (!generationSuccess) {
            try {
                // log.info('SYSTEM', 'Attempting bounty generation with Gemini...');
                const apiKey = process.env.GEMINI_API_KEY;
                if (!apiKey) {
                    log.error('SYSTEM', 'GEMINI_API_KEY not configured');
                    throw new Error('Gemini API key not configured');
                }
                const response = await geminiService.generateContentWithHistory(
                    [],      // empty chat history
                    prompt,  // the bounty question prompt
                    systemPrompt,    // added system prompt
                    { temperature: 0.7, apiKey }  // options with API key
                );
                const jsonMatch = response.match(/\{[\s\S]*\}/);
                questionData = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
                if (questionData) {
                    generationSuccess = true;
                    // log.success('SYSTEM', 'Gemini generation successful');
                }
            } catch (geminiError) {
                log.error('SYSTEM', 'Gemini generation failed', geminiError);
            }
        }

        if (!questionData) {
            // Fallback question
            questionData = {
                questionText: `Explain a practical application of ${targetTopic} in real-world scenarios.`,
                questionType: 'open_ended',
                options: [],
                correctAnswer: '',
                explanation: 'This tests understanding of practical applications.',
                creditReward: 15,
                learningCreditsBonus: 10
            };
        }

        // Save bounty to database
        const bountyId = `bounty_${uuidv4()}`;
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 24); // 24 hour expiry

        const bounty = new BountyQuestion({
            bountyId,
            userId,
            topic: targetTopic,
            difficulty,
            knowledgeGap: `Weak in ${targetTopic} based on recent activity`,
            questionText: questionData.questionText,
            questionType: questionData.questionType,
            options: questionData.options || [],
            correctAnswer: questionData.correctAnswer,
            explanation: questionData.explanation,
            creditReward: questionData.creditReward,
            xpBonus: questionData.xpBonus || 0,
            expiresAt,
            generationMethod: 'gap_based',
            sessionAnalysisData: gapAnalysis
        });

        await bounty.save();

        log.success('SYSTEM', `Generated bounty ${bountyId} for ${userId} (${targetTopic})`);

        return bounty;

    } catch (error) {
        log.error('SYSTEM', 'Bounty generation error', error);
        return null;
    }
}

/**
 * Generate a bounty for a single user if they need one
 * @param {string} userId - User ID
 * @returns {Promise<Object|null>} - Generated bounty or null
 */
async function generateBountyForUser(userId) {
    try {
        const existingBounties = await BountyQuestion.countDocuments({
            userId,
            status: 'active'
        });

        if (existingBounties >= 3) {
            return null;
        }

        const gapAnalysis = await analyzeKnowledgeGaps(userId);
        return await generateBountyQuestion(userId, gapAnalysis);
    } catch (error) {
        log.error('SYSTEM', `Error generating bounty for ${userId}: ${error.message}`);
        return null;
    }
}

/**
 * Periodic bounty generation for all active users
 * @returns {Promise<number>} - Number of bounties generated
 */
async function generatePeriodicBounties() {
    try {
        log.info('SYSTEM', 'Starting periodic bounty generation...');

        // Get all active users (users with recent activity)
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const activeProfiles = await GamificationProfile.find({
            updatedAt: { $gte: sevenDaysAgo }
        }).limit(100); // Process max 100 users per run

        let generatedCount = 0;

        for (const profile of activeProfiles) {
            try {
                // Check if user already has active bounties
                const existingBounties = await BountyQuestion.countDocuments({
                    userId: profile.userId,
                    status: 'active'
                });

                if (existingBounties >= 3) {
                    continue; // Skip if user has 3+ active bounties
                }

                // Analyze knowledge gaps
                const gapAnalysis = await analyzeKnowledgeGaps(profile.userId, 7);

                if (gapAnalysis) {
                    // Generate bounty
                    const bounty = await generateBountyQuestion(profile.userId, gapAnalysis);
                    if (bounty) {
                        generatedCount++;
                    }
                }

            } catch (userError) {
                log.error('SYSTEM', `Error processing user ${profile.userId}`, userError);
            }
        }

        log.success('SYSTEM', `Generated ${generatedCount} total bounties`);

        return generatedCount;

    } catch (error) {
        log.error('SYSTEM', 'Periodic generation failure', error);
        return 0;
    }
}

/**
 * Award learning credits to user
 * @param {string} userId - User ID
 * @param {number} amount - Credits to award
 * @param {string} reason - Reason for award
 * @param {string} bountyId - Optional bounty ID
 * @returns {Promise<number>} - New credit balance
 */
async function awardCredits(userId, amount, reason, bountyId = '') {
    try {
        const profile = await GamificationProfile.findOne({ userId });

        if (!profile) {
            throw new Error('Gamification profile not found');
        }

        // Update both legacy and new fields
        profile.learningCredits += amount;
        profile.totalLearningCredits = (profile.totalLearningCredits || 0) + amount;

        // Add to legacy creditsHistory
        profile.creditsHistory.push({
            amount,
            reason,
            bountyId,
            timestamp: new Date()
        });

        // Add to new learningCreditsHistory
        if (!profile.learningCreditsHistory) {
            profile.learningCreditsHistory = [];
        }
        profile.learningCreditsHistory.push({
            amount,
            reason,
            bountyId,
            topic: '',
            timestamp: new Date()
        });

        // Keep history manageable
        if (profile.creditsHistory.length > 100) {
            profile.creditsHistory = profile.creditsHistory.slice(-100);
        }
        if (profile.learningCreditsHistory.length > 100) {
            profile.learningCreditsHistory = profile.learningCreditsHistory.slice(-100);
        }

        await profile.save();

        // log.info('SYSTEM', `Awarded ${amount} credits to ${userId}`);

        return profile.learningCredits;

    } catch (error) {
        log.error('SYSTEM', 'Error awarding credits', error);
        throw error;
    }
}

/**
 * Submit bounty answer
 * @param {string} bountyId - Bounty ID
 * @param {string} userId - User ID
 * @param {string} answer - User's answer
 * @returns {Promise<Object>} - Result with credits awarded
 */
async function submitBountyAnswer(bountyId, userId, answer) {
    try {
        // log.info('SYSTEM', `User ${userId} submitting answer for ${bountyId}`);

        const bounty = await BountyQuestion.findOne({ bountyId, userId });

        if (!bounty) {
            throw new Error('Bounty not found');
        }

        if (bounty.status !== 'active') {
            throw new Error('Bounty is not active');
        }

        if (bounty.isExpired()) {
            bounty.status = 'expired';
            await bounty.save();
            throw new Error('Bounty has expired');
        }

        // Submit answer
        const isCorrect = bounty.submit(answer);
        await bounty.save();

        // log.info('SYSTEM', `Bounty ${bountyId}: ${isCorrect ? 'CORRECT' : 'INCORRECT'}`);

        let creditsAwarded = 0;
        let xpAwarded = 0;
        let newCreditsBalance = 0;
        let newXPTotal = 0;
        let newLevel = 0;
        let leveledUp = false;

        if (isCorrect) {
            // Award credits
            creditsAwarded = bounty.creditReward;
            try {
                newCreditsBalance = await awardCredits(userId, creditsAwarded, 'bounty_completed', bountyId);
                // log.info('SYSTEM', `Awarded ${creditsAwarded} credits to ${userId}`);
            } catch (creditError) {
                log.error('SYSTEM', 'Failed to award credits', creditError);
                throw new Error('Failed to award credits');
            }

            // Award bonus XP
            if (bounty.xpBonus > 0) {
                try {
                    const gamificationService = require('./gamificationService');
                    const xpResult = await gamificationService.awardXP(userId, bounty.xpBonus, 'bounty_question', bounty.topic);
                    xpAwarded = bounty.xpBonus;
                    newXPTotal = xpResult.newXP;
                    newLevel = xpResult.newLevel;
                    leveledUp = xpResult.leveledUp;
                    // log.info('SYSTEM', `Awarded ${xpAwarded} XP to ${userId}`);
                } catch (xpError) {
                    log.error('SYSTEM', 'Failed to award XP', xpError);
                    // Don't throw - credits already awarded
                }
            }
        }

        log.success('SYSTEM', `Bounty submission complete for ${userId}`);

        return {
            isCorrect,
            creditsAwarded,
            xpAwarded,
            newCreditsBalance,
            newXPTotal,
            newLevel,
            leveledUp,
            explanation: bounty.explanation,
            correctAnswer: bounty.correctAnswer
        };

    } catch (error) {
        log.error('SYSTEM', 'Error submitting bounty', error);
        throw error;
    }
}

/**
 * Get active bounties for user
 * @param {string} userId - User ID
 * @returns {Promise<Array>} - Active bounties
 */
async function getActiveBounties(userId) {
    try {
        // Expire old bounties first
        await BountyQuestion.expireOldBounties();

        const bounties = await BountyQuestion.find({
            userId,
            status: 'active'
        }).sort({ creditReward: -1, expiresAt: 1 });

        return bounties;

    } catch (error) {
        log.error('SYSTEM', 'Error getting bounties', error);
        return [];
    }
}

module.exports = {
    analyzeKnowledgeGaps,
    generateBountyQuestion,
    generatePeriodicBounties,
    generateBountyForUser,
    awardCredits,
    submitBountyAnswer,
    getActiveBounties
};
