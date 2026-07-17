// server/services/energyService.js
const GamificationProfile = require('../models/GamificationProfile');
const ChatHistory = require('../models/ChatHistory');
const log = require('../utils/logger');

/**
 * Detect fatigue from user's response patterns
 * @param {string} userId - User ID
 * @param {string} sessionId - Current session ID
 * @returns {Promise<{fatigueScore: number, indicators: Array}>}
 */
async function detectFatigue(userId, sessionId) {
    try {
        const session = await ChatHistory.findOne({ sessionId });
        if (!session || session.messages.length < 5) {
            return { fatigueScore: 0, indicators: [] };
        }

        const recentMessages = session.messages.slice(-10);
        const indicators = [];
        let fatigueScore = 0;

        // 1. Check response time trend (if timestamps available)
        const responseTimes = calculateResponseTimes(recentMessages);
        if (responseTimes.trend === 'increasing') {
            fatigueScore += 20;
            indicators.push('Slowing response times');
        }

        // 2. Check message length decline
        const userMessages = recentMessages.filter(m => m.role === 'user');
        if (userMessages.length >= 5) {
            const avgEarlyLength = averageLength(userMessages.slice(0, Math.floor(userMessages.length / 2)));
            const avgRecentLength = averageLength(userMessages.slice(-Math.floor(userMessages.length / 2)));

            if (avgRecentLength < avgEarlyLength * 0.6) {
                fatigueScore += 25;
                indicators.push('Shorter messages');
            }
        }

        // 3. Check for repeated questions (confusion indicator)
        const questionSimilarity = checkRepeatedQuestions(userMessages);
        if (questionSimilarity > 0.5) {
            fatigueScore += 15;
            indicators.push('Repeated questions');
        }

        // 4. Check session duration
        const sessionDuration = Date.now() - new Date(session.createdAt).getTime();
        const hoursDuration = sessionDuration / (1000 * 60 * 60);

        if (hoursDuration > 2) {
            fatigueScore += 20;
            indicators.push(`Long session (${hoursDuration.toFixed(1)}h)`);
        }

        // 5. Check message frequency (rapid-fire indicates stress)
        const avgTimeBetweenMessages = calculateAvgTimeBetween(recentMessages);
        if (avgTimeBetweenMessages < 30) { // Less than 30 seconds between messages
            fatigueScore += 10;
            indicators.push('Rapid messaging');
        }

        fatigueScore = Math.min(100, fatigueScore); // Cap at 100

        // log.info('SYSTEM', `Fatigue detected for user ${userId}: ${fatigueScore}%`);

        return { fatigueScore, indicators };

    } catch (error) {
        log.error('SYSTEM', 'Error detecting fatigue', error);
        return { fatigueScore: 0, indicators: [] };
    }
}

/**
 * Update user's energy bar based on fatigue
 * @param {string} userId - User ID
 * @param {number} fatigueScore - Fatigue score (0-100)
 * @returns {Promise<{currentEnergy: number, forcedBreak: boolean, breakUntil: Date|null}>}
 */
async function updateEnergyBar(userId, fatigueScore) {
    try {
        let profile = await GamificationProfile.findOne({ userId });

        if (!profile) {
            profile = new GamificationProfile({ userId });
        }

        // Energy depletion based on fatigue
        let energyDrain = 5; // Base drain per interaction

        if (fatigueScore > 70) {
            energyDrain = 15; // High fatigue = rapid energy drain
        } else if (fatigueScore > 50) {
            energyDrain = 10;
        }

        profile.currentEnergy = Math.max(0, profile.currentEnergy - energyDrain);
        profile.fatigueScore = fatigueScore;
        profile.lastEnergyUpdate = new Date();

        // Force break if energy depleted
        let forcedBreak = false;
        let breakUntil = null;

        if (profile.currentEnergy === 0 && !profile.forcedBreakUntil) {
            profile.forcedBreakUntil = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
            forcedBreak = true;
            breakUntil = profile.forcedBreakUntil;
            log.warn('SYSTEM', `Forcing break for ${userId} until ${breakUntil}`);
        }

        await profile.save();

        return {
            currentEnergy: profile.currentEnergy,
            fatigueScore,
            forcedBreak,
            breakUntil
        };

    } catch (error) {
        log.error('SYSTEM', 'Error updating energy bar', error);
        throw error;
    }
}

/**
 * Regenerate energy during breaks
 * @param {string} userId - User ID
 * @returns {Promise<{currentEnergy: number, breakEnded: boolean}>}
 */
async function regenerateEnergy(userId) {
    try {
        const profile = await GamificationProfile.findOne({ userId });

        if (!profile) {
            return { currentEnergy: 100, breakEnded: false };
        }

        // Check if still on forced break
        if (profile.forcedBreakUntil && new Date() < profile.forcedBreakUntil) {
            return {
                currentEnergy: profile.currentEnergy,
                breakEnded: false,
                breakRemaining: Math.ceil((profile.forcedBreakUntil - new Date()) / (1000 * 60)) // minutes
            };
        }

        // Regenerate energy based on time passed
        const timeSinceUpdate = Date.now() - new Date(profile.lastEnergyUpdate).getTime();
        const minutesPassed = Math.floor(timeSinceUpdate / (1000 * 60));

        // Regenerate 10 energy per 15 minutes
        const energyToAdd = Math.floor(minutesPassed / 15) * 10;

        if (energyToAdd > 0) {
            profile.currentEnergy = Math.min(100, profile.currentEnergy + energyToAdd);
            profile.lastEnergyUpdate = new Date();

            // Clear forced break if energy is back
            if (profile.currentEnergy >= 30 && profile.forcedBreakUntil) {
                profile.forcedBreakUntil = null;
                log.success('SYSTEM', `Break ended for ${userId}, energy: ${profile.currentEnergy}%`);
            }

            await profile.save();
        }

        return {
            currentEnergy: profile.currentEnergy,
            breakEnded: !profile.forcedBreakUntil,
            energyAdded: energyToAdd
        };

    } catch (error) {
        log.error('SYSTEM', 'Error regenerating energy', error);
        return { currentEnergy: 100, breakEnded: true };
    }
}

/**
 * Check if user is currently on forced break
 * @param {string} userId - User ID
 * @returns {Promise<{onBreak: boolean, remainingMinutes: number}>}
 */
async function checkBreakStatus(userId) {
    try {
        const profile = await GamificationProfile.findOne({ userId });

        if (!profile || !profile.forcedBreakUntil) {
            return { onBreak: false, remainingMinutes: 0 };
        }

        const now = new Date();
        const breakUntil = new Date(profile.forcedBreakUntil);

        if (now >= breakUntil) {
            // Break expired, clear it
            profile.forcedBreakUntil = null;
            await profile.save();
            return { onBreak: false, remainingMinutes: 0 };
        }

        const remainingMs = breakUntil - now;
        const remainingMinutes = Math.ceil(remainingMs / (1000 * 60));

        return {
            onBreak: true,
            remainingMinutes,
            breakUntil
        };

    } catch (error) {
        log.error('SYSTEM', 'Error checking break status', error);
        return { onBreak: false, remainingMinutes: 0 };
    }
}

// Helper functions

function calculateResponseTimes(messages) {
    const times = [];
    for (let i = 1; i < messages.length; i++) {
        if (messages[i].timestamp && messages[i - 1].timestamp) {
            const diff = new Date(messages[i].timestamp) - new Date(messages[i - 1].timestamp);
            times.push(diff / 1000); // Convert to seconds
        }
    }

    if (times.length < 3) return { trend: 'stable', average: 0 };

    const early = times.slice(0, Math.floor(times.length / 2));
    const recent = times.slice(-Math.floor(times.length / 2));

    const avgEarly = early.reduce((a, b) => a + b, 0) / early.length;
    const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;

    return {
        trend: avgRecent > avgEarly * 1.3 ? 'increasing' : 'stable',
        average: avgRecent
    };
}

function averageLength(messages) {
    if (messages.length === 0) return 0;
    const totalLength = messages.reduce((sum, m) => sum + (m.parts?.[0]?.text?.length || 0), 0);
    return totalLength / messages.length;
}

function checkRepeatedQuestions(userMessages) {
    if (userMessages.length < 3) return 0;

    // Simple word overlap check
    const texts = userMessages.map(m => m.parts?.[0]?.text?.toLowerCase() || '');
    let similarityCount = 0;
    let totalComparisons = 0;

    for (let i = 0; i < texts.length - 1; i++) {
        for (let j = i + 1; j < texts.length; j++) {
            totalComparisons++;
            const similarity = calculateTextSimilarity(texts[i], texts[j]);
            if (similarity > 0.6) similarityCount++;
        }
    }

    return totalComparisons > 0 ? similarityCount / totalComparisons : 0;
}

function calculateTextSimilarity(text1, text2) {
    const words1 = new Set(text1.split(/\s+/));
    const words2 = new Set(text2.split(/\s+/));

    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);

    return union.size > 0 ? intersection.size / union.size : 0;
}

function calculateAvgTimeBetween(messages) {
    if (messages.length < 2) return 0;

    let totalTime = 0;
    let count = 0;

    for (let i = 1; i < messages.length; i++) {
        if (messages[i].timestamp && messages[i - 1].timestamp) {
            const diff = new Date(messages[i].timestamp) - new Date(messages[i - 1].timestamp);
            totalTime += diff / 1000; // seconds
            count++;
        }
    }

    return count > 0 ? totalTime / count : 0;
}

module.exports = {
    detectFatigue,
    updateEnergyBar,
    regenerateEnergy,
    checkBreakStatus
};
