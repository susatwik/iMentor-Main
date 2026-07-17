// server/services/teachingReflectionService.js
// Post-turn reflection: analyses what happened, produces a learning adjustment.

const MASTERY_SCORE_MAX = 5.0;

/**
 * Normalize mastery to 0–1 whether caller passes 0–1 or 0–5 scale.
 */
function normalizeMasteryScore(masteryScore = 0, max = MASTERY_SCORE_MAX) {
    const n = Number(masteryScore) || 0;
    if (n <= 1) return Math.max(0, Math.min(1, n));
    return Math.max(0, Math.min(1, n / max));
}

function normalizeCognitiveLevel(level) {
    const aliases = {
        L2_COMPREHENSION: 'L2_APPLICATION',
        L3_APPLICATION: 'L3_CRITICAL'
    };
    return aliases[level] || level || 'L1_CONCEPT';
}

/**
 * After each student turn, reflect on the teaching outcome and produce:
 *  - An adjustment action (or null if nothing needs changing)
 *  - A note to log for learning analytics
 *  - A recommended system-prompt patch that will be applied in the NEXT turn
 */
function reflectOnTeaching(state = {}) {
    const {
        consecutiveWrong = 0,
        hintsGiven = 0,
        masteryScore = 0,
        learningPath = null,
        turnCount = 0,
        lastAction = null,
        lastStudentResponse = '',
        cognitiveLevel = 'L1_CONCEPT',
        emotionalState = null,
        understandingLevel = null,
        sessionDurationMinutes = 0,
    } = state;

    const results = [];
    const masteryNorm = normalizeMasteryScore(masteryScore);
    const normalizedLevel = normalizeCognitiveLevel(cognitiveLevel);

    // ── 1. Persistent confusion detection ─────────────────────────────────────
    if (consecutiveWrong >= 3) {
        results.push({
            action: 'RETEACH_CONCEPT',
            note: `Student answered incorrectly ${consecutiveWrong} times in a row. Switching to re-teaching mode.`,
            promptPatch: 'The student is struggling. Start over with a 2-sentence explanation and a very simple, 1-sentence analogy before asking any question.',
            priority: 10,
        });
    }

    // ── 2. Hint overuse ───────────────────────────────────────────────────────
    if (hintsGiven >= 3 && lastAction !== 'SIMPLIFY_PROBLEM') {
        results.push({
            action: 'SIMPLIFY_PROBLEM',
            note: `${hintsGiven} hints given; problem may be beyond current level.`,
            promptPatch: 'Break the current problem into exactly one smaller, very simple step. Avoid complex detail.',
            priority: 8,
        });
    }

    // ── 3. Ready to skip ahead (strict: high normalized mastery + L4 + no struggles) ──
    if (
        masteryNorm >= 0.85 &&
        consecutiveWrong === 0 &&
        turnCount >= 4 &&
        normalizedLevel === 'L4_EVALUATION'
    ) {
        results.push({
            action: 'SKIP_AHEAD',
            note: `High mastery (${Math.round(masteryNorm * 100)}%) at L4. Student ready for next sub-topic.`,
            promptPatch: 'The student has demonstrated strong understanding at the evaluation level. Acknowledge this clearly, then introduce the next concept.',
            priority: 7,
        });
    }

    // ── 4. First-turn stumble ─────────────────────────────────────────────────
    if (learningPath && learningPath.currentStep === 0 && consecutiveWrong >= 2) {
        results.push({
            action: 'EXPLAIN_CONCEPT',
            note: 'Student struggled at the very start; need to provide foundational explanation first.',
            promptPatch: 'Before asking any more questions, provide a clear 2-paragraph introductory explanation of the fundamental idea.',
            priority: 9,
        });
    }

    // ── 5. Emotional state: frustration / anxiety ─────────────────────────────
    const isFrustrated = emotionalState === 'FRUSTRATION' || emotionalState === 'FRUSTRATED' || emotionalState === 'ANXIETY';
    if (isFrustrated) {
        results.push({
            action: 'ENCOURAGE',
            note: `Emotional state detected: ${emotionalState}. Inserting encouragement.`,
            promptPatch: 'Before your next question, offer a single sentence of genuine encouragement. Keep it very brief.',
            priority: 6,
        });
    }

    // ── 6. Long session fatigue ───────────────────────────────────────────────
    if (sessionDurationMinutes >= 30 && turnCount % 10 === 0 && turnCount > 0) {
        results.push({
            action: 'TAKE_BREAK_SUGGESTION',
            note: `Session running for ${sessionDurationMinutes} minutes. Suggest a break.`,
            promptPatch: 'After your response, gently suggest that the student take a short break if they feel tired — spaced practice improves retention.',
            priority: 3,
        });
    }

    // ── 7. Comprehension check after long explanation ─────────────────────────
    if (lastAction === 'EXPLAIN_CONCEPT' && consecutiveWrong === 0 && turnCount > 0) {
        results.push({
            action: 'ASK_COMPREHENSION_CHECK',
            note: 'Just explained a concept; checking if student understood.',
            promptPatch: 'You just provided an explanation. Now ask a single, short check question (max 15 words) to verify understanding.',
            priority: 4,
        });
    }

    if (results.length === 0) return null;

    // Return the highest-priority adjustment
    results.sort((a, b) => b.priority - a.priority);
    const top = results[0];
    return {
        action: top.action,
        note: top.note,
        promptPatch: top.promptPatch,
        allAdjustments: results.map(r => r.action),
    };
}

/**
 * Build a compact summary string of the session quality for logging.
 */
function buildSessionQualitySummary(state = {}) {
    const { masteryScore = 0, turnCount = 0, hintsGiven = 0, consecutiveWrong = 0 } = state;
    const mastery = Math.round(normalizeMasteryScore(masteryScore) * 100);
    const engagement = turnCount > 10 ? 'high' : turnCount > 4 ? 'medium' : 'low';
    const difficulty = consecutiveWrong >= 3 ? 'over-challenged' : hintsGiven >= 3 ? 'challenged' : 'appropriate';
    return `mastery=${mastery}% | turns=${turnCount} | engagement=${engagement} | difficulty=${difficulty}`;
}

module.exports = {
    reflectOnTeaching,
    buildSessionQualitySummary,
    normalizeMasteryScore,
};
