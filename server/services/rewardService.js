const log = require('../utils/logger');
const Credit = require('../models/Credit');

/**
 * Persist a reward credit audit entry to the database.
 * @param {string|Object} userId - User ID or object supporting toString().
 * @param {number} amount - Amount of credits awarded.
 * @param {string} reason - Reason for the award.
 * @param {string} topic - Related learning topic.
 * @param {string} source - Source of the award (e.g. learning_credit, xp, badge).
 * @param {object} [meta] - Optional metadata for tracing.
 * @returns {Promise<Credit>}
 */
async function recordCreditAward(userId, amount, reason = 'learning progress', topic = 'general', source = 'learning_credit', meta = {}) {
    try {
        const credit = new Credit({
            userId,
            amount: Math.round(amount),
            reason,
            topic,
            source,
            meta
        });
        await credit.save();
        return credit;
    } catch (error) {
        log.error('SYSTEM', 'Failed to record credit award', error);
        throw error;
    }
}

/**
 * Retrieve recent credit awards for a user.
 * @param {string|Object} userId
 * @param {number} limit
 * @returns {Promise<Credit[]>}
 */
async function getRecentCreditHistory(userId, limit = 20) {
    try {
        return await Credit.find({ userId })
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();
    } catch (error) {
        log.error('SYSTEM', 'Failed to load recent credit history', error);
        return [];
    }
}

module.exports = {
    recordCreditAward,
    getRecentCreditHistory
};
