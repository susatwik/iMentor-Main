// server/services/badgeService.js
const GamificationProfile = require('../models/GamificationProfile');
const log = require('../utils/logger');

/**
 * Badge Definitions
 * Each badge has criteria and rewards
 */
const BADGE_DEFINITIONS = {
    // XP Milestones
    'xp_novice': {
        name: 'XP Novice',
        description: 'Earned 100 total XP',
        criteria: { type: 'xp', threshold: 100 },
        icon: '🌟'
    },
    'xp_apprentice': {
        name: 'XP Apprentice',
        description: 'Earned 500 total XP',
        criteria: { type: 'xp', threshold: 500 },
        icon: '⭐'
    },
    'xp_expert': {
        name: 'XP Expert',
        description: 'Earned 2,000 total XP',
        criteria: { type: 'xp', threshold: 2000 },
        icon: '💫'
    },
    'xp_master': {
        name: 'XP Master',
        description: 'Earned 5,000 total XP',
        criteria: { type: 'xp', threshold: 5000 },
        icon: '🌠'
    },

    // Level Milestones
    'level_5': {
        name: 'Silver Rank',
        description: 'Reached Level 5',
        criteria: { type: 'level', threshold: 5 },
        icon: '🥈'
    },
    'level_10': {
        name: 'Gold Rank',
        description: 'Reached Level 10',
        criteria: { type: 'level', threshold: 10 },
        icon: '🥇'
    },
    'level_15': {
        name: 'Platinum Rank',
        description: 'Reached Level 15',
        criteria: { type: 'level', threshold: 15 },
        icon: '💎'
    },
    'level_20': {
        name: 'Diamond Rank',
        description: 'Reached Level 20',
        criteria: { type: 'level', threshold: 20 },
        icon: '💠'
    },

    // Streak Achievements
    'streak_warrior': {
        name: 'Streak Warrior',
        description: '7-day streak maintained',
        criteria: { type: 'streak', threshold: 7 },
        icon: '🔥'
    },
    'streak_champion': {
        name: 'Streak Champion',
        description: '30-day streak maintained',
        criteria: { type: 'streak', threshold: 30 },
        icon: '🏆'
    },
    'streak_legend': {
        name: 'Streak Legend',
        description: '100-day streak maintained',
        criteria: { type: 'streak', threshold: 100 },
        icon: '👑'
    },

    // Boss Battle Achievements
    'boss_slayer': {
        name: 'Boss Slayer',
        description: 'Defeated first boss battle',
        criteria: { type: 'boss_count', threshold: 1 },
        icon: '⚔️'
    },
    'boss_hunter': {
        name: 'Boss Hunter',
        description: 'Defeated 5 boss battles',
        criteria: { type: 'boss_count', threshold: 5 },
        icon: '🗡️'
    },
    'boss_legend': {
        name: 'Boss Legend',
        description: 'Defeated 10 boss battles',
        criteria: { type: 'boss_count', threshold: 10 },
        icon: '🛡️'
    },
    'perfect_battle': {
        name: 'Perfect Victory',
        description: 'Scored 100% on a boss battle',
        criteria: { type: 'perfect_score', threshold: 100 },
        icon: '💯'
    },

    // Bounty Achievements
    'bounty_hunter': {
        name: 'Bounty Hunter',
        description: 'Completed first bounty question',
        criteria: { type: 'bounty_count', threshold: 1 },
        icon: '🎯'
    },
    'bounty_master': {
        name: 'Bounty Master',
        description: 'Completed 10 bounty questions',
        criteria: { type: 'bounty_count', threshold: 10 },
        icon: '🏹'
    },

    // Credit Achievements
    'credit_collector': {
        name: 'Credit Collector',
        description: 'Earned 100 learning credits',
        criteria: { type: 'credits', threshold: 100 },
        icon: '💰'
    },
    'credit_mogul': {
        name: 'Credit Mogul',
        description: 'Earned 500 learning credits',
        criteria: { type: 'credits', threshold: 500 },
        icon: '💸'
    }
};

/**
 * Check all badges for a user and award new ones
 */
async function checkAndAwardBadges(userId) {
    try {
        const profile = await GamificationProfile.findOne({ userId });
        if (!profile) return [];

        const newBadges = [];
        const existingBadgeIds = profile.badges.map(b => b.badgeId);

        for (const [badgeId, badgeDef] of Object.entries(BADGE_DEFINITIONS)) {
            // Skip if already earned
            if (existingBadgeIds.includes(badgeId)) {
                continue;
            }

            // Check if user meets criteria
            const meetsCriteria = checkBadgeCriteria(profile, badgeDef.criteria);

            if (meetsCriteria) {
                // Award badge
                const badge = {
                    badgeId,
                    name: badgeDef.name,
                    earnedAt: new Date()
                };

                profile.badges.push(badge);
                newBadges.push({ ...badge, ...badgeDef });

                log.success('SYSTEM', `Awarded badge "${badgeDef.name}" to ${userId}`);
            }
        }

        if (newBadges.length > 0) {
            await profile.save();
        }

        return newBadges;

    } catch (error) {
        log.error('SYSTEM', 'Error checking badges', error);
        return [];
    }
}

/**
 * Check if user meets badge criteria
 */
function checkBadgeCriteria(profile, criteria) {
    switch (criteria.type) {
        case 'xp':
            return profile.totalXP >= criteria.threshold;

        case 'level':
            return profile.level >= criteria.threshold;

        case 'streak':
            return profile.longestStreak >= criteria.threshold;

        case 'boss_count':
            return profile.completedBattles.length >= criteria.threshold;

        case 'credits':
            return profile.learningCredits >= criteria.threshold;

        case 'bounty_count':
            // Count bounties from creditsHistory
            const bountyCompletions = profile.creditsHistory.filter(
                h => h.reason === 'bounty_completed'
            ).length;
            return bountyCompletions >= criteria.threshold;

        case 'perfect_score':
            // Check if user has any boss battle with 100% score
            return profile.completedBattles.some(battle => battle.score >= criteria.threshold);

        default:
            return false;
    }
}

/**
 * Special badge check for boss battles
 */
async function checkBossBattleBadge(userId, battle) {
    try {
        const profile = await GamificationProfile.findOne({ userId });
        if (!profile) return null;

        const newBadges = [];
        const existingBadgeIds = profile.badges.map(b => b.badgeId);

        // Check perfect score badge
        if (battle.score === 100 && !existingBadgeIds.includes('perfect_battle')) {
            const badgeDef = BADGE_DEFINITIONS['perfect_battle'];
            const badge = {
                badgeId: 'perfect_battle',
                name: badgeDef.name,
                earnedAt: new Date()
            };
            profile.badges.push(badge);
            newBadges.push({ ...badge, ...badgeDef });
        }

        // Check boss count badges
        const battleCount = profile.completedBattles.length + 1; // +1 for current

        if (battleCount === 1 && !existingBadgeIds.includes('boss_slayer')) {
            const badgeDef = BADGE_DEFINITIONS['boss_slayer'];
            const badge = {
                badgeId: 'boss_slayer',
                name: badgeDef.name,
                earnedAt: new Date()
            };
            profile.badges.push(badge);
            newBadges.push({ ...badge, ...badgeDef });
        }

        if (battleCount === 5 && !existingBadgeIds.includes('boss_hunter')) {
            const badgeDef = BADGE_DEFINITIONS['boss_hunter'];
            const badge = {
                badgeId: 'boss_hunter',
                name: badgeDef.name,
                earnedAt: new Date()
            };
            profile.badges.push(badge);
            newBadges.push({ ...badge, ...badgeDef });
        }

        if (battleCount === 10 && !existingBadgeIds.includes('boss_legend')) {
            const badgeDef = BADGE_DEFINITIONS['boss_legend'];
            const badge = {
                badgeId: 'boss_legend',
                name: badgeDef.name,
                earnedAt: new Date()
            };
            profile.badges.push(badge);
            newBadges.push({ ...badge, ...badgeDef });
        }

        if (newBadges.length > 0) {
            await profile.save();
            log.success('SYSTEM', `Awarded ${newBadges.length} boss battle badges to ${userId}`);
            return newBadges[0]; // Return first badge
        }

        return null;

    } catch (error) {
        log.error('SYSTEM', 'Error checking boss battle badge', error);
        return null;
    }
}

/**
 * Get all earned badges for a user
 */
async function getUserBadges(userId) {
    try {
        const profile = await GamificationProfile.findOne({ userId });
        if (!profile) return [];

        // Enrich with badge definitions
        const badges = profile.badges.map(badge => {
            const def = BADGE_DEFINITIONS[badge.badgeId];
            return {
                ...badge.toObject(),
                description: def?.description || '',
                icon: def?.icon || '🏅'
            };
        });

        return badges;

    } catch (error) {
        log.error('SYSTEM', 'Error getting user badges', error);
        return [];
    }
}

/**
 * Get all available badges (for showcase)
 */
function getAllBadges() {
    return Object.entries(BADGE_DEFINITIONS).map(([badgeId, def]) => ({
        badgeId,
        ...def
    }));
}

module.exports = {
    checkAndAwardBadges,
    checkBossBattleBadge,
    getUserBadges,
    getAllBadges,
    BADGE_DEFINITIONS
};
