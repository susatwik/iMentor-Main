// server/services/tutorXpService.js
// ─────────────────────────────────────────────────────────────────────────────
// Live XP Service for Tutor Mode
//
// Three responsibilities:
//   1. computeTurnXp()          — pure function, zero I/O, runs on the hot path
//                                 Returns the XP delta to display immediately.
//   2. awardTurnXpAsync()       — persists XP to DB + emits socket event.
//                                 Scheduled via setImmediate — fires AFTER res.end().
//   3. scheduleQualityBonusAsync() — LLM quality eval → bonus XP → socket push.
//                                 Fully deferred, never touches the SSE stream.
//
// Zero latency contract:
//   ONLY computeTurnXp() runs before res.write(). Everything else fires in
//   setImmediate so it never touches the live response pipeline.
// ─────────────────────────────────────────────────────────────────────────────

const log = require('../utils/logger');

// ── XP lookup tables ──────────────────────────────────────────────────────────

// Cognitive level scales XP gain (not penalties — so higher levels don't punish more)
const LEVEL_MULT = {
    L1_CONCEPT:     1.0,
    L2_APPLICATION: 1.3,
    L3_CRITICAL:    1.6,
    L4_EVALUATION:  2.0,
};

// Base XP per classification (before level multiplier)
const BASE_XP = {
    CORRECT:       15,
    PARTIAL:        8,
    WRONG:         -5,
    MISCONCEPTION: -3,
    VAGUE:          0,
    NO_FOUNDATION:  0,
    UNKNOWN:        0,
    INCOMPLETE:     0,
};

const HINT_PENALTY    = -2;  // per hint used
const MAX_HINT_DEDUCT = -6;  // cap so heavy hint-users aren't crushed
const MASTERY_BONUS   = 20;  // flat bonus for achieving mastery on a subtopic

// ── 1. computeTurnXp — pure, no I/O ──────────────────────────────────────────

/**
 * Compute the XP delta for a single tutor turn.
 *
 * @param {string|object} classification - 'CORRECT'|'PARTIAL'|'WRONG'|... or { status }
 * @param {string}        cognitiveLevel - 'L1_CONCEPT'|'L2_APPLICATION'|'L3_CRITICAL'|'L4_EVALUATION'
 * @param {number}        hintsUsed      - number of hints given in this subtopic so far
 * @param {boolean}       isMastery      - true when this turn achieves mastery (adds flat bonus)
 * @returns {{ xp: number, label: string, type: 'gain'|'loss'|'neutral', classification: string, cognitiveLevel: string }}
 */
function computeTurnXp(classification, cognitiveLevel, hintsUsed = 0, isMastery = false) {
    const cls = typeof classification === 'object'
        ? (classification?.status || 'UNKNOWN')
        : (String(classification || 'UNKNOWN'));

    const base = BASE_XP[cls] ?? 0;
    const mult = LEVEL_MULT[cognitiveLevel] || 1.0;
    const hintDeduct = Math.max(MAX_HINT_DEDUCT, HINT_PENALTY * Math.max(0, hintsUsed));

    // Positive XP scales with cognitive level; negative penalties stay flat
    const scaled = base > 0
        ? Math.round(base * mult) + hintDeduct
        : base + hintDeduct;

    const masteryAdd = isMastery ? MASTERY_BONUS : 0;
    const xp = Math.max(-10, scaled) + masteryAdd;  // overall floor: -10 per turn

    const type  = xp > 0 ? 'gain' : xp < 0 ? 'loss' : 'neutral';
    const label = isMastery
        ? `+${xp} XP`
        : (xp >= 0 ? `+${xp} XP` : `${xp} XP`);

    return { xp, label, type, classification: cls, cognitiveLevel: cognitiveLevel || 'L1_CONCEPT' };
}

// ── 2. awardTurnXpAsync — fire-and-forget after res.end() ────────────────────

/**
 * Award XP (positive or negative) asynchronously via setImmediate.
 * Safe to call directly after res.end() — never blocks the response.
 *
 * @param {string} userId
 * @param {number} xpAmount   - can be negative (penalty)
 * @param {string} topic
 * @param {string} reason     - logged in xpHistory
 */
function awardTurnXpAsync(userId, xpAmount, topic, reason = 'tutor_turn') {
    if (!userId || xpAmount === 0) return;

    setImmediate(async () => {
        try {
            const gamificationService = require('./gamificationService');

            if (xpAmount > 0) {
                await gamificationService.awardXP(userId, xpAmount, reason, topic);
            } else {
                // Penalty: apply manually so we can floor at 0
                const GamificationProfile = require('../models/GamificationProfile');
                const socketService = require('./socketService');

                const profile = await GamificationProfile.findOne({ userId });
                if (profile) {
                    profile.totalXP = Math.max(0, (profile.totalXP || 0) + xpAmount);
                    profile.xpHistory = profile.xpHistory || [];
                    profile.xpHistory.push({ amount: xpAmount, reason, topic, timestamp: new Date() });
                    if (profile.xpHistory.length > 100) profile.xpHistory = profile.xpHistory.slice(-100);
                    await profile.save();

                    socketService.emitToUser(userId.toString(), 'xp_awarded', {
                        amount: xpAmount,
                        newTotal: profile.totalXP,
                        reason,
                        topic,
                    });
                }
            }
        } catch (err) {
            log.warn('TUTOR_XP', `awardTurnXpAsync failed (non-fatal): ${err.message}`);
        }
    });
}

// ── 3. scheduleQualityBonusAsync — fully deferred LLM eval + socket push ─────

/**
 * Schedules a quality evaluation of the student's message after the response
 * is sent.  Awards a bonus XP and emits 'xp_quality_bonus' socket event so the
 * frontend can show a toast notification — typically 1-5s after the SSE stream.
 *
 * Quality score mapping: 1→0 XP, 3→5 XP, 10→15 XP
 *
 * @param {string} userId
 * @param {string} userMessage    - student's message this turn
 * @param {string} aiResponse     - the tutor's reply (context for quality eval)
 * @param {string} topic
 * @param {object} [llmConfig]    - optional LLM config forwarded to evaluator
 */
function scheduleQualityBonusAsync(userId, userMessage, aiResponse, topic, llmConfig) {
    if (!userId || !userMessage) return;

    setImmediate(async () => {
        try {
            const { evaluateAnswerQuality, awardXP } = require('./gamificationService');
            const socketService = require('./socketService');

            const evaluation = await evaluateAnswerQuality(userMessage, aiResponse, {
                topic,
                user: { _id: userId },
                llmConfig,
            });

            // score 1 = rote memorisation → 0 bonus
            // score 3 = shows understanding → +5
            // score 10 = applies to novel problem → +15
            const bonusMap = { 1: 0, 3: 5, 10: 15 };
            const bonus = bonusMap[evaluation.score] ?? 0;

            if (bonus > 0) {
                await awardXP(userId, bonus, 'quality_bonus', topic);

                // Push a distinct event — frontend shows as toast, not updating existing message
                socketService.emitToUser(userId.toString(), 'xp_quality_bonus', {
                    amount: bonus,
                    score: evaluation.score,
                    reasoning: evaluation.reasoning,
                    topic,
                });
            }
        } catch (err) {
            log.warn('TUTOR_XP', `scheduleQualityBonusAsync failed (non-fatal): ${err.message}`);
        }
    });
}

module.exports = { computeTurnXp, awardTurnXpAsync, scheduleQualityBonusAsync, MASTERY_BONUS };
