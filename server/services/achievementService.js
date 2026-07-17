// server/services/achievementService.js
const User = require('../models/User');
const UserScore = require('../models/UserScore');

/**
 * Updates a user's daily streak.
 * Should be called when a user logs in.
 */
async function updateDailyStreak(userId) {
    try {
        const user = await User.findById(userId);
        if (!user) return null;

        const now = new Date();
        const lastLogin = user.streak.lastLoginDate;

        let newCurrent = user.streak.current;
        let newLongest = user.streak.longest;

        if (!lastLogin) {
            newCurrent = 1;
        } else {
            const msInDay = 1000 * 60 * 60 * 24;
            const nowDay = Math.floor(now.getTime() / msInDay);
            const lastLoginDay = Math.floor(lastLogin.getTime() / msInDay);
            const diffDays = nowDay - lastLoginDay;

            if (diffDays === 1) {
                newCurrent += 1;
            } else if (diffDays > 1) {
                newCurrent = 1;
            }
        }

        if (newCurrent > newLongest) {
            newLongest = newCurrent;
        }

        user.streak.current = newCurrent;
        user.streak.longest = newLongest;
        user.streak.lastLoginDate = now;

        await user.save();
        await checkStreakBadges(user);

        return user.streak;
    } catch (error) {
        console.error('Error updating daily streak:', error);
        return null;
    }
}

/**
 * Evaluates and awards badges for streaks.
 */
async function checkStreakBadges(user) {
    const streakBadges = [
        { id: 'streak_3', name: '3-Day Streak', threshold: 3, icon: '🔥' },
        { id: 'streak_7', name: '7-Day Streak', threshold: 7, icon: '🔥' },
        { id: 'streak_30', name: '30-Day Streak', threshold: 30, icon: '👑' }
    ];

    let awarded = false;
    for (const badge of streakBadges) {
        if (user.streak.current >= badge.threshold) {
            if (!user.badges.some(b => b.badgeId === badge.id)) {
                user.badges.push({
                    badgeId: badge.id,
                    name: badge.name,
                    description: `Logged in for ${badge.threshold} consecutive days.`,
                    icon: badge.icon,
                    earnedAt: new Date()
                });
                awarded = true;
            }
        }
    }

    if (awarded) {
        await user.save();
    }
}

/**
 * Evaluates and awards badges after a quiz/challenge is completed.
 */
async function checkActivityBadges(userId) {
    try {
        const user = await User.findById(userId);
        const score = await UserScore.findOne({ userId });

        if (!user || !score) return;

        let awarded = false;
        const assessmentsCompleted = score.completedAssessments || 0;

        const activityBadges = [
            { id: 'quiz_1', name: 'First Challenge', threshold: 1, icon: '🎯' },
            { id: 'quiz_10', name: '10 Challenges', threshold: 10, icon: '⭐' },
            { id: 'quiz_50', name: '50 Challenges', threshold: 50, icon: '🏆' }
        ];

        for (const badge of activityBadges) {
            if (assessmentsCompleted >= badge.threshold) {
                if (!user.badges.some(b => b.badgeId === badge.id)) {
                    user.badges.push({
                        badgeId: badge.id,
                        name: badge.name,
                        description: `Completed ${badge.threshold} challenges.`,
                        icon: badge.icon,
                        earnedAt: new Date()
                    });
                    awarded = true;
                }
            }
        }

        if (awarded) {
            await user.save();
        }

    } catch (error) {
        console.error('Error checking activity badges:', error);
    }
}

module.exports = {
    updateDailyStreak,
    checkActivityBadges
};
