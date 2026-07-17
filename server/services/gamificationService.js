const GamificationProfile = require('../models/GamificationProfile');
const User = require('../models/User');
const { selectLLM } = require('./llmRouterService');
const geminiService = require('./geminiService');
const ollamaService = require('./ollamaService');
const groqService = require('./groqService');
const rewardService = require('./rewardService');
const log = require('../utils/logger');
const socketService = require('./socketService');


/**
 * Evaluate answer quality using AI analysis
 * @param {string} userMessage - The user's question/message
 * @param {string} aiResponse - The AI's response
 * @param {object} context - Additional context (sessionId, topic, etc.)
 * @returns {Promise<{score: number, reasoning: string}>}
 */
async function evaluateAnswerQuality(userMessage, aiResponse, context = {}) {
    try {
        const { user, topic = 'general' } = context;

        const prompt = `You are analyzing a student's learning interaction to determine the quality of their engagement.

Student Question/Message: "${userMessage}"

AI Tutor's Response: "${aiResponse}"

Analyze the student's question/message and rate their learning quality on this scale:
- Score 1 (Rote): Simple fact recall, memorization questions, yes/no queries
- Score 3 (Understanding): Shows reasoning, asks "why/how" questions, seeks clarification, explains concepts
- Score 10 (Application): Applies concepts to new problems, synthesizes ideas, transfers learning to novel scenarios

Return ONLY a JSON object in this exact format:
{
  "score": <1 or 3 or 10>,
  "reasoning": "brief explanation (max 50 words)"
}`;

        // Use LLM router to select best model
        const { chosenModel } = await selectLLM(prompt, { user, subject: topic });

        let evaluationText;
        let generationSuccess = false;

        // Try Ollama first
        if (chosenModel.provider === 'ollama') {
            try {
                // log.info('SYSTEM', "Attempting evaluation with Ollama...");
                const userDoc = await User.findById(user?._id).select('ollamaUrl');
                evaluationText = await ollamaService.generateContentWithHistory([], prompt, null, {
                    model: chosenModel.modelId,
                    ollamaUrl: userDoc?.ollamaUrl,
                    temperature: 0.3
                });
                generationSuccess = true;
                // log.success('SYSTEM', "Ollama evaluation successful");
            } catch (ollamaError) {
                log.warn('SYSTEM', `Ollama evaluation failed: ${ollamaError.message}`);
                // log.info('SYSTEM', "Evaluation fallback from Ollama...");
            }
        }

        else if (chosenModel.provider === 'groq') {
            try {
                // log.info('SYSTEM', "Attempting evaluation with Groq...");
                const apiKey = process.env.GROQ_API_KEY;
                if (!apiKey) {
                    throw new Error('Groq API key not configured');
                }
                evaluationText = await groqService.generateContentWithHistory([], prompt, null, {
                    model: chosenModel.modelId || 'llama-3.1-8b-instant',
                    apiKey: apiKey,
                    temperature: 0.3
                });
                generationSuccess = true;
                // log.success('SYSTEM', "Groq evaluation successful");
            } catch (groqError) {
                log.info('SYSTEM', "Falling back from Groq...");
            }
        }

        // Fallback to Gemini if Ollama failed or if Gemini was selected
        if (!generationSuccess) {
            try {
                // log.info('SYSTEM', "Attempting evaluation with Gemini...");
                const apiKey = process.env.GEMINI_API_KEY;
                if (!apiKey) {
                    log.error('SYSTEM', 'GEMINI_API_KEY not found');
                    return { score: 1, reasoning: 'rote' };
                }
                evaluationText = await geminiService.generateContentWithHistory(
                    [],      // empty chat history
                    prompt,  // the evaluation prompt
                    null,    // no system prompt
                    { temperature: 0.3, apiKey, maxOutputTokens: 200 }  // options with API key
                );
                generationSuccess = true;
                // log.success('SYSTEM', "Gemini evaluation successful");
            } catch (geminiError) {
            log.error('SYSTEM', 'Evaluation failed across providers');
            }
        }

        // Parse JSON response
        const jsonMatch = evaluationText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            log.warn('SYSTEM', 'Failed to parse AI evaluation response');
            return { score: 1, reasoning: 'rote' };
        }

        const evaluation = JSON.parse(jsonMatch[0]);

        // Validate score
        if (![1, 3, 10].includes(evaluation.score)) {
            evaluation.score = 1;
        }

        // log.info('SYSTEM', `Quality: ${evaluation.score} credits`);
        return evaluation;

    } catch (error) {
        log.error('SYSTEM', 'Quality evaluation error', error);
        // Fallback to basic evaluation
        return { score: 1, reasoning: 'rote' };
    }
}

/**
 * Award Learning Credits to a user and update their profile
 * @param {string} userId - User ID
 * @param {number} creditsAmount - Amount of Learning Credits to award
 * @param {string} reason - Reason for Learning Credits award
 * @param {string} topic - Related topic
 * @returns {Promise<{newCredits: number, newLevel: number, leveledUp: boolean}>}
 */
async function awardLearningCredits(userId, creditsAmount, reason, topic = '') {
    try {
        // log.info('SYSTEM', `Awarding ${creditsAmount} credits to ${userId}`);

        let profile = await GamificationProfile.findOne({ userId });

        // Create profile if doesn't exist
        if (!profile) {
            // log.info('SYSTEM', `Creating profile for ${userId}`);
            profile = new GamificationProfile({ userId });
        }

        const oldLevel = profile.level;
        const oldCredits = profile.totalLearningCredits;

        // Add Learning Credits
        profile.totalLearningCredits += Math.round(creditsAmount);

        // Update last active date for activity tracking
        profile.lastActiveDate = new Date();

        // Add to history
        profile.learningCreditsHistory.push({
            amount: Math.round(creditsAmount),
            reason,
            topic,
            timestamp: new Date()
        });

        // Keep history manageable (last 100 entries)
        if (profile.learningCreditsHistory.length > 100) {
            profile.learningCreditsHistory = profile.learningCreditsHistory.slice(-100);
        }

        // Calculate new level
        const newLevel = profile.calculateLevel();
        profile.level = newLevel;

        await profile.save();
        // log.info('SYSTEM', `Profile saved. Credits: ${oldCredits} -> ${profile.totalLearningCredits}`);

        // Also update User.level for consistency
        try {
            const User = require('../models/User');
            await User.findByIdAndUpdate(userId, { level: newLevel });
            // log.info('SYSTEM', `User level updated to ${newLevel}`);
        } catch (userUpdateError) {
            log.error('SYSTEM', 'User level update failed', userUpdateError);
            // Don't throw - profile already saved
        }

        const leveledUp = newLevel > oldLevel;

        if (leveledUp) {
            log.info('SYSTEM', `User ${userId} leveled up to ${newLevel}`);
        }

        // Check for new badges (async, don't block)
        const badgeService = require('./badgeService');
        badgeService.checkAndAwardBadges(userId).then(newBadges => {
            if (newBadges && newBadges.length > 0) {
                newBadges.forEach(badge => {
                    socketService.emitToUser(userId, 'badge_earned', badge);
                });
            }
        }).catch(err =>
            log.error('SYSTEM', 'Badge check failed', err)
        );

        // Emit credits awarded event
        try {
            socketService.emitToUser(userId, 'credits_awarded', { amount: Math.round(creditsAmount), newTotal: profile.totalLearningCredits, newLevel: profile.level, reason, topic });
        } catch (e) {
            log.error('SYSTEM', 'Credits socket event failed', e);
        }

        try {
            await rewardService.recordCreditAward(userId, creditsAmount, reason, topic, 'learning_credit', { level: profile.level });
        } catch (recordErr) {
            log.warn('SYSTEM', 'Learning credit audit record failed', recordErr);
        }

        return {
            newCredits: profile.totalLearningCredits,
            newLevel: profile.level,
            leveledUp,
            creditsForNextLevel: profile.getCreditsForNextLevel()
        };

    } catch (error) {
        log.error('SYSTEM', 'Error awarding credits', error);
        throw error;
    }
}

/**
 * Award XP points to a user and update XP-related fields
 * @param {string} userId
 * @param {number} xpAmount
 * @param {string} reason
 * @param {string} topic
 */
async function awardXP(userId, xpAmount, reason = 'application', topic = '') {
    try {
        // log.info('SYSTEM', `Awarding ${xpAmount} XP to ${userId}`);

        let profile = await GamificationProfile.findOne({ userId });
        if (!profile) {
            profile = new GamificationProfile({ userId });
        }

        const oldXP = profile.totalXP || 0;
        const oldXPLevel = profile.xpLevel || 1;

        profile.totalXP = (profile.totalXP || 0) + Math.round(xpAmount);

        // Update xp history
        profile.xpHistory = profile.xpHistory || [];
        profile.xpHistory.push({ amount: Math.round(xpAmount), reason, topic, timestamp: new Date() });
        if (profile.xpHistory.length > 100) profile.xpHistory = profile.xpHistory.slice(-100);

        // Update xp level
        const newXPLevel = profile.calculateXPLevel();
        profile.xpLevel = newXPLevel;

        await profile.save();

        // Emit socket event for XP
        socketService.emitToUser(userId, 'xp_awarded', { amount: xpAmount, newTotal: profile.totalXP, newLevel: newXPLevel, reason, topic });

        try {
            await rewardService.recordCreditAward(userId, xpAmount, reason, topic, 'xp', { xpLevel: newXPLevel });
        } catch (auditErr) {
            log.warn('SYSTEM', 'XP audit record failed', auditErr);
        }

        // log.info('SYSTEM', `XP: ${oldXP} -> ${profile.totalXP}`);

        return { newXP: profile.totalXP, newXPLevel, newLevel: newXPLevel, leveledUp: newXPLevel > oldXPLevel };
    } catch (error) {
        log.error('SYSTEM', 'XP award failure', error);
        throw error;
    }
}

/**
 * Get or create user's gamification profile
 * @param {string} userId - User ID
 * @returns {Promise<GamificationProfile>}
 */
async function getOrCreateProfile(userId) {
    try {
        let profile = await GamificationProfile.findOne({ userId });

        if (!profile) {
            profile = new GamificationProfile({ userId });
            await profile.save();

            // Also ensure User.level is set
            const User = require('../models/User');
            await User.findByIdAndUpdate(userId, { level: 1 });

            // log.info('SYSTEM', `Created profile for ${userId}`);
        } else {
            // Migrate old XP data to Learning Credits if needed
            let needsSave = false;

            if ((profile.totalXP > 0 || profile.totalXP === 0) && !profile.totalLearningCredits) {
                profile.totalLearningCredits = profile.totalXP || 0;
                needsSave = true;
                // log.info('SYSTEM', `Migrated XP for ${userId}`);
            }

            if (profile.xpHistory && profile.xpHistory.length > 0 && (!profile.learningCreditsHistory || profile.learningCreditsHistory.length === 0)) {
                profile.learningCreditsHistory = profile.xpHistory;
                profile.xpHistory = [];
                needsSave = true;
                // log.info('SYSTEM', `Migrated history for ${userId}`);
            }

            if (needsSave) {
                await profile.save();
            }
        }

        return profile;
    } catch (error) {
        log.error('SYSTEM', 'Profile get/create failure', error);
        throw error;
    }
}

/**
 * Get leaderboard for a specific topic
 * @param {string} topic - Topic name
 * @param {number} limit - Number of top users to return
 * @returns {Promise<Array>}
 */
async function getTopicLeaderboard(topic, limit = 10) {
    try {
        // Find all profiles that have score for this topic
        const profiles = await GamificationProfile.find({
            [`topicScores.${topic}`]: { $exists: true }
        })
            .populate('userId', 'profile.name email')
            .sort({ [`topicScores.${topic}`]: -1 })
            .limit(limit)
            .lean();

        return profiles.map((p, index) => ({
            rank: index + 1,
            userId: p.userId._id,
            name: p.userId.profile?.name || 'Anonymous',
            score: p.topicScores.get(topic) || 0,
            level: p.level,
            totalLearningCredits: p.totalLearningCredits
        }));

    } catch (error) {
        log.error('SYSTEM', 'Leaderboard fetch failure', error);
        return [];
    }
}

/**
 * Update topic score for leaderboard
 * @param {string} userId - User ID
 * @param {string} topic - Topic name
 * @param {number} score - Score to set
 */
async function updateTopicScore(userId, topic, score) {
    try {
        const profile = await getOrCreateProfile(userId);

        const currentScore = profile.topicScores.get(topic) || 0;

        // Only update if new score is higher
        if (score > currentScore) {
            profile.topicScores.set(topic, score);
            await profile.save();
            log.info('SYSTEM', `Updated topic score for ${userId} in ${topic}`);
        }

    } catch (error) {
        log.error('SYSTEM', 'Topic score update failure', error);
    }
}

/**
 * Award a badge to a user
 * @param {string} userId - User ID
 * @param {string} badgeId - Badge identifier
 * @param {string} badgeName - Badge display name
 */
async function awardBadge(userId, badgeId, badgeName) {
    try {
        const profile = await getOrCreateProfile(userId);

        // Check if badge already earned
        const alreadyHas = profile.badges.some(b => b.badgeId === badgeId);
        if (alreadyHas) {
            // log.info('SYSTEM', `User ${userId} already has badge ${badgeId}`);
            return false;
        }

        profile.badges.push({
            badgeId,
            name: badgeName,
            earnedAt: new Date()
        });

        await profile.save();
        log.info('SYSTEM', `Awarded badge ${badgeId} to ${userId}`);

        // Emit badge earned event via socket
        const badgeDef = require('./badgeService').BADGE_DEFINITIONS[badgeId];
        socketService.emitToUser(userId, 'badge_earned', {
            badgeId,
            name: badgeName,
            earnedAt: new Date(),
            ...badgeDef
        });

        return true;

    } catch (error) {
        log.error('SYSTEM', 'Badge award failure', error);
        return false;
    }
}

/**
 * Get user's full gamification stats
 * @param {string} userId - User ID
 * @returns {Promise<object>}
 */
async function getUserStats(userId) {
    try {
        const profile = await getOrCreateProfile(userId);
        const recentRewardHistory = await rewardService.getRecentCreditHistory(userId, 20);

        return {
            totalLearningCredits: profile.totalLearningCredits,
            level: profile.level,
            creditsForNextLevel: profile.getCreditsForNextLevel(),
            totalXP: profile.totalXP || 0,
            xpLevel: profile.xpLevel || profile.calculateXPLevel(),
            xpForNextLevel: profile.getXPForNextLevel(),
            currentStreak: profile.currentStreak,
            longestStreak: profile.longestStreak,
            currentEnergy: profile.currentEnergy,
            fatigueScore: profile.fatigueScore,
            unlockedSkills: profile.unlockedSkills,
            badges: profile.badges,
            recentCreditsHistory: profile.learningCreditsHistory.slice(-10).reverse(), // Last 10 Learning Credits awards
            learningCreditsHistory: profile.learningCreditsHistory || [], // Complete history for filtering
            recentXPHistory: (profile.xpHistory || []).slice(-10).reverse(),
            recentRewardHistory,
            topicScores: Object.fromEntries(profile.topicScores),
            learningCredits: profile.learningCredits || 0,  // Legacy field
            creditsHistory: profile.creditsHistory || []     // Legacy field
        };

    } catch (error) {
        log.error('SYSTEM', 'Stats fetch failure', error);
        throw error;
    }
}

/**
 * Record skill tree level completion progress
 * @param {string} userId - User ID
 * @param {string} topic - Topic name
 * @param {number} levelId - Level ID
 * @param {number} stars - Stars earned (0-3)
 * @param {number} score - Questions answered correctly
 * @param {number} totalQuestions - Total questions in level
 */
async function recordSkillTreeProgress(userId, topic, levelId, stars, score, totalQuestions, creditsAwarded = false) {
    try {
        const profile = await getOrCreateProfile(userId);


        // Initialize skillTreeProgress as a plain object if not exists
        if (!profile.skillTreeProgress || typeof profile.skillTreeProgress !== 'object') {
            profile.skillTreeProgress = {};
        }

        const topicKey = topic.toLowerCase();
        if (!profile.skillTreeProgress[topicKey]) {
            profile.skillTreeProgress[topicKey] = { levels: {} };
        }
        let topicProgress = profile.skillTreeProgress[topicKey];

        // Always use string for levelId key
        const levelKey = String(levelId);
        const existingLevel = topicProgress.levels[levelKey] || { stars: 0, score: 0, creditsAwarded: false };
        topicProgress.levels[levelKey] = {
            stars: Math.max(existingLevel.stars, stars),
            score: Math.max(existingLevel.score, score),
            totalQuestions,
            completedAt: new Date(),
            attempts: (existingLevel.attempts || 0) + 1,
            creditsAwarded: existingLevel.creditsAwarded || Boolean(creditsAwarded)
        };

        profile.skillTreeProgress[topicKey] = topicProgress;
        await profile.save();

        log.info('SYSTEM', `Recorded skill tree progress: ${userId} - ${topic} - ${levelId}`);

    } catch (error) {
        log.error('SYSTEM', 'Skill tree progress record failed', error);
        // Don't throw - this is not critical
    }
}

/**
 * Check if this is the first time a user completes a level
 * @param {string} userId - User ID
 * @param {string} topic - Topic name
 * @param {number} levelId - Level ID
 * @returns {boolean} True if first completion
 */
async function isFirstLevelCompletion(userId, topic, levelId) {
    try {
        const profile = await getOrCreateProfile(userId);


        if (!profile.skillTreeProgress || typeof profile.skillTreeProgress !== 'object') {
            return true; // No progress at all, definitely first time
        }

        const topicKey = topic.toLowerCase();
        const topicProgress = profile.skillTreeProgress[topicKey];

        if (!topicProgress || !topicProgress.levels) {
            return true; // No progress for this topic
        }

        // Always use string for levelId key
        const levelKey = String(levelId);
        const levelProgress = topicProgress.levels[levelKey];

        // First time eligible for credit if there's no record or credits haven't been awarded yet
        if (!levelProgress) return true;
        return !(levelProgress.creditsAwarded === true);

    } catch (error) {
        log.error('SYSTEM', 'First completion check failed', error);
        return true; // Default to true to award Learning Credits in case of error
    }
}

/**
 * Atomically mark that credits have been awarded for a specific skill-tree level.
 * Returns true if the mark was applied (i.e., credits have NOT been awarded before),
 * false if someone already marked it.
 */
async function markLevelCreditsAwardedIfNot(userId, topic, levelId) {
    try {
        const topicKey = String(topic).toLowerCase();
        const levelKey = String(levelId);

        // Filter ensures we only match profiles where creditsAwarded is not true for this level
        const filter = {
            userId,
            $or: [
                { [`skillTreeProgress.${topicKey}`]: { $exists: false } },
                { [`skillTreeProgress.${topicKey}.levels.${levelKey}.creditsAwarded`]: { $ne: true } }
            ]
        };

        const update = {
            $set: {
                // mark credits awarded
                [`skillTreeProgress.${topicKey}.levels.${levelKey}.creditsAwarded`]: true,
                // ensure we have a completedAt timestamp if not present
                [`skillTreeProgress.${topicKey}.levels.${levelKey}.completedAt`]: new Date()
            }
        };

        const updated = await GamificationProfile.findOneAndUpdate(filter, update, { new: true });
        return updated ? true : false;
    } catch (error) {
        log.error('SYSTEM', 'Marking level credits failed', error);
        return false;
    }
}

module.exports = {
    evaluateAnswerQuality,
    awardLearningCredits,
    awardXP,
    getOrCreateProfile,
    getTopicLeaderboard,
    updateTopicScore,
    awardBadge,
    getUserStats,
    recordSkillTreeProgress,
    isFirstLevelCompletion,
    markLevelCreditsAwardedIfNot
};
