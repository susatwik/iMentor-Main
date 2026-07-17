// server/services/teachingPolicyService.js
// Full adaptive teaching policy — deterministic, no external calls.

const { normalizeMasteryScore } = require('./teachingReflectionService');

/**
 * Cognitive level order used to determine when to advance or downgrade.
 */
// Aligned with socraticTutorService.js / tutorStateMachine.js cognitive labels
const COGNITIVE_ORDER = ['L1_CONCEPT', 'L2_APPLICATION', 'L3_CRITICAL', 'L4_EVALUATION'];
const COGNITIVE_LABELS = {
    L1_CONCEPT: 'recall',
    L2_APPLICATION: 'application',
    L3_CRITICAL: 'analysis',
    L4_EVALUATION: 'evaluation'
};

/** Map legacy enum values for backward compatibility */
function normalizeCognitiveLevel(level) {
    const aliases = {
        L2_COMPREHENSION: 'L2_APPLICATION',
        L3_APPLICATION: 'L3_CRITICAL'
    };
    const normalized = aliases[level] || level || 'L1_CONCEPT';
    return COGNITIVE_ORDER.includes(normalized) ? normalized : 'L1_CONCEPT';
}

/**
 * Map an action to a prose instruction injected into the LLM system prompt.
 */
const ACTION_INSTRUCTIONS = {
    EXPLAIN_CONCEPT: 'Provide a clear, concise explanation of the current concept in EXACTLY TWO short paragraphs before asking any question.',
    ASK_QUESTION: 'Ask one focused, short Socratic question to probe the student\'s understanding.',
    GIVE_HINT: 'Offer a one-sentence hint without giving away the answer. Break the problem into exactly one smaller part.',
    SIMPLIFY_PROBLEM: 'Simplify the current question — use a single simple analogy or a concrete 1-sentence example.',
    ADVANCE_DIFFICULTY: 'The student has demonstrated solid understanding. Raise the difficulty briefly and target a higher cognitive objective with a concise question.',
    RETEACH_CONCEPT: 'The student seems stuck. Re-explain the concept using EXACTLY ONE simple analogy and a 2-sentence summary.',
    REVIEW_PREREQUISITES: 'Before proceeding, briefly (max 3 sentences) review the prerequisite concept the student is missing.',
    SUMMARISE_AND_ADVANCE: 'Summarise progress in 3 concise bullet points, then briefly introduce the next sub-topic.',
    ENCOURAGE: 'Offer a 1-sentence, genuine encouragement. Normalise the struggle.',
    METACOGNITIVE_PROMPT: 'Ask a short reflection question ("What part was clearest?").',
};

/**
 * Decide the next teaching action based on session state.
 * Returns an action key (string) and an instruction string for the LLM system prompt.
 */
function decideTeachingAction({
    masteryScore = 0,
    consecutiveWrong = 0,
    hintUsage = 0,
    hintsGiven = 0,
    cognitiveLevel = 'L1_CONCEPT',
    currentStep = null,
    remainingSteps = null,
    turnCount = 0,
    emotionalState = null,
    understandingLevel = null,
    isFirstTurn = false
} = {}) {
    const mastery = normalizeMasteryScore(masteryScore);
    const wrong = Math.max(consecutiveWrong, 0);
    const hints = Math.max(hintUsage, hintsGiven, 0);
    const normalizedLevel = normalizeCognitiveLevel(cognitiveLevel);
    const levelIdx = COGNITIVE_ORDER.indexOf(normalizedLevel);
    const safeIdx = levelIdx === -1 ? 0 : levelIdx;

    // ── Emotional state overrides ──────────────────────────────────────────────
    const isFrustrated = emotionalState === 'FRUSTRATION' || emotionalState === 'FRUSTRATED' || emotionalState === 'ANXIETY';
    if (isFrustrated) {
        if (wrong >= 2 || hints >= 2) {
            return build('ENCOURAGE', mastery, normalizedLevel);
        }
    }
    const isBored = emotionalState === 'BOREDOM' || emotionalState === 'BORED';
    if (isBored && mastery > 0.55 && safeIdx < COGNITIVE_ORDER.length - 1) {
        return build('ADVANCE_DIFFICULTY', mastery, normalizedLevel);
    }

    // ── First turn — Socratic elicitation before exposition ───────────────────
    if (isFirstTurn || turnCount === 0) {
        return build('ASK_QUESTION', mastery, normalizedLevel);
    }

    // ── Progress-ratio heuristic (curriculum-guided mode) ────────────────────
    if (Number.isInteger(currentStep) && Number.isInteger(remainingSteps)) {
        const total = currentStep + remainingSteps + 1;
        const ratio = total > 0 ? currentStep / total : 0;

        if (ratio < 0.20) return build('ASK_QUESTION', mastery, normalizedLevel);
        if (ratio < 0.50) return build('ASK_QUESTION', mastery, normalizedLevel);
        if (ratio < 0.80) {
            if (wrong >= 2) return build('GIVE_HINT', mastery, normalizedLevel);
            return build('ASK_QUESTION', mastery, normalizedLevel);
        }
        return build('SUMMARISE_AND_ADVANCE', mastery, normalizedLevel);
    }

    // ── Stuck detection ───────────────────────────────────────────────────────
    if (wrong >= 4) return build('RETEACH_CONCEPT', mastery, normalizedLevel);
    if (wrong >= 3 && hints >= 3) return build('REVIEW_PREREQUISITES', mastery, normalizedLevel);
    if (wrong >= 2) return build('GIVE_HINT', mastery, normalizedLevel);
    if (hints >= 4) return build('SIMPLIFY_PROBLEM', mastery, normalizedLevel);

    // ── Understanding level (from StudentKnowledgeState) ─────────────────────
    if (understandingLevel === 'MISUNDERSTOOD' || understandingLevel === 'CONFUSED' || understandingLevel === 'MISCONCEPTION') {
        return wrong >= 2 ? build('RETEACH_CONCEPT', mastery, normalizedLevel) : build('GIVE_HINT', mastery, normalizedLevel);
    }

    // ── Mastery-based routing ─────────────────────────────────────────────────
    if (mastery < 0.25 && wrong >= 1) return build('GIVE_HINT', mastery, normalizedLevel);
    if (mastery >= 0.85 && safeIdx < COGNITIVE_ORDER.length - 1) {
        return build('ADVANCE_DIFFICULTY', mastery, normalizedLevel);
    }
    if (mastery >= 0.75 && turnCount > 0 && turnCount % 8 === 0) {
        return build('METACOGNITIVE_PROMPT', mastery, normalizedLevel);
    }

    return build('ASK_QUESTION', mastery, normalizedLevel);
}

/**
 * Build the full policy decision object.
 */
function build(action, mastery, cognitiveLevel) {
    return {
        action,
        instruction: ACTION_INSTRUCTIONS[action] || ACTION_INSTRUCTIONS['ASK_QUESTION'],
        cognitiveLabel: COGNITIVE_LABELS[cognitiveLevel] || 'recall',
        mastery: Math.round(mastery * 100),
    };
}

/**
 * Determine whether the session should advance to the next cognitive level.
 */
function shouldAdvanceCognitiveLevel({
    masteryScore = 0,
    consecutiveWrong = 0,
    turnCount = 0,
    consecutiveCorrectAtLevel = 0
} = {}) {
    if (consecutiveCorrectAtLevel >= 2 && consecutiveWrong === 0) return true;
    return normalizeMasteryScore(masteryScore) >= 0.8 && consecutiveWrong === 0 && turnCount >= 3;
}

/**
 * Determine whether the session should downgrade cognitive level (struggling student).
 */
function shouldDowngradeCognitiveLevel({ masteryScore = 0, consecutiveWrong = 0 } = {}) {
    return consecutiveWrong >= 3 || normalizeMasteryScore(masteryScore) < 0.2;
}

module.exports = {
    decideTeachingAction,
    shouldAdvanceCognitiveLevel,
    shouldDowngradeCognitiveLevel,
    normalizeCognitiveLevel,
    COGNITIVE_ORDER,
    ACTION_INSTRUCTIONS,
};
