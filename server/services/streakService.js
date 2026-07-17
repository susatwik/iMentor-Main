// server/services/streakService.js
const GamificationProfile = require('../models/GamificationProfile');
const { awardXP } = require('./gamificationService');
const log = require('../utils/logger');

/**
 * Update user's streak on login/activity
 * @param {string} userId - User ID
 * @returns {Promise<{currentStreak: number, isNewStreak: boolean, reward: object|null}>}
 */
async function updateStreak(userId) {
    try {
        let profile = await GamificationProfile.findOne({ userId });

        if (!profile) {
            profile = new GamificationProfile({ userId });
        }

        const today = new Date().setHours(0, 0, 0, 0);
        const lastActive = profile.lastActiveDate ?
            new Date(profile.lastActiveDate).setHours(0, 0, 0, 0) : null;

        let isNewStreak = false;
        let reward = null;

        if (!lastActive) {
            // First time user - initialize streak to 1
            profile.currentStreak = 1;
            profile.longestStreak = 1;
            isNewStreak = true;
            // log.info('SYSTEM', `New user ${userId} - streak initialized`);
        } else {
            const daysDiff = Math.floor((today - lastActive) / (1000 * 60 * 60 * 24));

            if (daysDiff === 0) {
                // Same day, no change to streak
                // log.info('SYSTEM', `Same-day activity for ${userId}`);
            } else if (daysDiff === 1) {
                // Consecutive day - increment streak
                profile.currentStreak += 1;
                profile.longestStreak = Math.max(profile.longestStreak, profile.currentStreak);
                isNewStreak = true;

                // log.info('SYSTEM', `Streak continued for ${userId}: ${profile.currentStreak} days`);

                // Check for streak rewards
                reward = await checkStreakReward(profile);
                if (reward) {
                    await grantStreakReward(userId, reward, profile);
                }

            } else if (daysDiff > 1) {
                // Streak broken
                const oldStreak = profile.currentStreak;
                profile.currentStreak = 1; // Start new streak
                log.info('SYSTEM', `Streak broken for ${userId}: ${oldStreak} -> 1`);
            }
        }

        profile.lastActiveDate = new Date();
        await profile.save();

        return {
            currentStreak: profile.currentStreak,
            longestStreak: profile.longestStreak,
            isNewStreak,
            reward,
            multiplier: getStreakMultiplier(profile.currentStreak)
        };

    } catch (error) {
        log.error('SYSTEM', 'Error updating streak', error);
        throw error;
    }
}

/**
 * Get XP multiplier based on current streak
 * @param {number} currentStreak - Current streak count
 * @returns {number} - Multiplier value
 */
function getStreakMultiplier(currentStreak) {
    if (currentStreak >= 6) return 1.5;
    if (currentStreak >= 3) return 1.2;
    return 1.0;
}

/**
 * Check if user has earned a streak reward
 * @param {GamificationProfile} profile - User's profile
 * @returns {object|null}
 */
async function checkStreakReward(profile) {
    const streak = profile.currentStreak;

    // Define streak milestones and rewards
    const rewardMilestones = {
        3: { type: 'bonus_xp', amount: 50, description: '3-day streak bonus' },
        7: { type: 'bonus_xp', amount: 150, description: '1-week streak bonus' },
        14: { type: 'bonus_xp', amount: 300, description: '2-week streak bonus' },
        30: { type: 'bonus_xp', amount: 1000, description: 'Month-long streak bonus!' },
        60: { type: 'bonus_xp', amount: 2500, description: '60-day legend!' },
        100: { type: 'bonus_xp', amount: 5000, description: '100-day master!' }
    };

    if (rewardMilestones[streak]) {
        // Check if already claimed
        const alreadyClaimed = profile.streakRewards.some(r => r.day === streak);
        if (!alreadyClaimed) {
            return {
                day: streak,
                ...rewardMilestones[streak]
            };
        }
    }

    return null;
}

/**
 * Grant streak reward to user
 * @param {string} userId - User ID
 * @param {object} reward - Reward object
 * @param {GamificationProfile} profile - User's profile
 */
async function grantStreakReward(userId, reward, profile) {
    try {
        switch (reward.type) {
            case 'bonus_xp':
                await awardXP(userId, reward.amount, 'streak_bonus', 'streak');
                log.success('SYSTEM', `Granted ${reward.amount} XP for ${reward.day}-day streak`);
                break;

            case 'unlock_resource':
                // Future implementation: unlock special documents or mini-courses
                // log.info('SYSTEM', `Unlocked resource: ${reward.resourceId}`);
                break;
        }

        // Record that reward was claimed
        profile.streakRewards.push({
            day: reward.day,
            reward: reward.description,
            unlockedAt: new Date()
        });

    } catch (error) {
        log.error('SYSTEM', 'Error granting streak reward', error);
    }
}

/**
 * Get streak statistics for a user
 * @param {string} userId - User ID
 * @returns {Promise<object>}
 */
async function getStreakStats(userId) {
    try {
        const profile = await GamificationProfile.findOne({ userId });

        if (!profile) {
            return {
                currentStreak: 0,
                longestStreak: 0,
                multiplier: 1.0,
                nextMilestone: 3,
                streakRewards: []
            };
        }

        // Calculate next milestone
        const milestones = [3, 7, 14, 30, 60, 100];
        const nextMilestone = milestones.find(m => m > profile.currentStreak) || 100;

        return {
            currentStreak: profile.currentStreak,
            longestStreak: profile.longestStreak,
            multiplier: getStreakMultiplier(profile.currentStreak),
            nextMilestone,
            daysToNextMilestone: nextMilestone - profile.currentStreak,
            streakRewards: profile.streakRewards,
            lastActiveDate: profile.lastActiveDate
        };

    } catch (error) {
        log.error('SYSTEM', 'Error getting streak stats', error);
        return { currentStreak: 0, longestStreak: 0, multiplier: 1.0 };
    }
}

/**
 * Check if user is at risk of losing streak
 * @param {string} userId - User ID
 * @returns {Promise<{atRisk: boolean, hoursRemaining: number}>}
 */
async function checkStreakRisk(userId) {
    try {
        const profile = await GamificationProfile.findOne({ userId });

        if (!profile || !profile.lastActiveDate) {
            return { atRisk: false, hoursRemaining: 0 };
        }

        const now = new Date();
        const lastActive = new Date(profile.lastActiveDate);
        const hoursSinceActive = Math.floor((now - lastActive) / (1000 * 60 * 60));

        // At risk if more than 18 hours have passed
        const atRisk = hoursSinceActive >= 18 && hoursSinceActive < 24;
        const hoursRemaining = atRisk ? 24 - hoursSinceActive : 0;

        return {
            atRisk,
            hoursRemaining,
            currentStreak: profile.currentStreak,
            lastActiveDate: lastActive
        };

    } catch (error) {
        log.error('SYSTEM', 'Error checking streak risk', error);
        return { atRisk: false, hoursRemaining: 0 };
    }
}

module.exports = {
    updateStreak,
    getStreakMultiplier,
    getStreakStats,
    checkStreakRisk
};
