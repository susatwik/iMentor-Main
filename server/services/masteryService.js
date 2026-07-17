/**
 * Mastery and progression utilities used by the Socratic tutoring flow.
 */

const MASTERY_SCORE_MAP = {
    CORRECT: 1.0,
    PARTIAL: 0.5,
    WRONG: 0.0,
    UNKNOWN: 0.0,
    INCOMPLETE: 0.0
};

function mapClassificationToMasteryScore(classification) {
    if (!classification) return 0;
    const status = typeof classification === 'object' ? classification.status || 'UNKNOWN' : classification;
    return MASTERY_SCORE_MAP[status] ?? 0;
}

function calculateMasteryProgress(state = {}, classification) {
    const score = mapClassificationToMasteryScore(classification);
    const base = Number(state.masteryScore || 0);
    const adjustment = score * 10;
    const nextScore = Math.min(100, Math.max(0, base + adjustment));

    return {
        previousMastery: base,
        delta: Math.round(adjustment * 10) / 10,
        newMastery: Math.round(nextScore * 10) / 10,
        achieved: nextScore >= 80,
        consecutiveCorrect: state.consecutiveCorrect || 0,
        cognitiveLevelName: state.cognitiveLevelName || state.cognitiveLevel || 'L1_CONCEPT'
    };
}

function shouldAdvanceToNextStep(state = {}, classification) {
    const masteryProgress = calculateMasteryProgress(state, classification);
    if (masteryProgress.achieved && masteryProgress.consecutiveCorrect >= 2) {
        return true;
    }
    if ((state.consecutiveCorrect || 0) >= 3 && masteryProgress.newMastery >= 75) {
        return true;
    }
    return false;
}

function recommendNextAction(state = {}, classification) {
    const masteryProgress = calculateMasteryProgress(state, classification);
    if (masteryProgress.achieved) {
        return 'The student is ready to move to the next subtopic or apply knowledge in a problem-solving exercise.';
    }
    if (masteryProgress.newMastery >= 60) {
        return 'The student benefits from a few more targeted questions to reinforce understanding before advancing.';
    }
    return 'The student should review the concept with a simpler example and focus on foundational reasoning steps.';
}

module.exports = {
    calculateMasteryProgress,
    shouldAdvanceToNextStep,
    recommendNextAction
};
/**
 * Mastery and progression utilities used by the Socratic tutoring flow.
 */

const MASTERY_SCORE_MAP = {
    CORRECT: 1.0,
    PARTIAL: 0.5,
    WRONG: 0.0,
    UNKNOWN: 0.0,
    INCOMPLETE: 0.0
};

function mapClassificationToMasteryScore(classification) {
    if (!classification) return 0;
    const status = typeof classification === 'object' ? classification.status || 'UNKNOWN' : classification;
    return MASTERY_SCORE_MAP[status] ?? 0;
}

function calculateMasteryProgress(state = {}, classification) {
    const score = mapClassificationToMasteryScore(classification);
    const base = Number(state.masteryScore || 0);
    const adjustment = score * 10;
    const nextScore = Math.min(100, Math.max(0, base + adjustment));

    return {
        previousMastery: base,
        delta: Math.round(adjustment * 10) / 10,
        newMastery: Math.round(nextScore * 10) / 10,
        achieved: nextScore >= 80,
        consecutiveCorrect: state.consecutiveCorrect || 0,
        cognitiveLevelName: state.cognitiveLevelName || state.cognitiveLevel || 'L1_CONCEPT'
    };
}

function shouldAdvanceToNextStep(state = {}, classification) {
    const masteryProgress = calculateMasteryProgress(state, classification);
    if (masteryProgress.achieved && masteryProgress.consecutiveCorrect >= 2) {
        return true;
    }
    if ((state.consecutiveCorrect || 0) >= 3 && masteryProgress.newMastery >= 75) {
        return true;
    }
    return false;
}

function recommendNextAction(state = {}, classification) {
    const masteryProgress = calculateMasteryProgress(state, classification);
    if (masteryProgress.achieved) {
        return 'The student is ready to move to the next subtopic or apply knowledge in a problem-solving exercise.';
    }
    if (masteryProgress.newMastery >= 60) {
        return 'The student benefits from a few more targeted questions to reinforce understanding before advancing.';
    }
    return 'The student should review the concept with a simpler example and focus on foundational reasoning steps.';
}

module.exports = {
    calculateMasteryProgress,
    shouldAdvanceToNextStep,
    recommendNextAction
};
