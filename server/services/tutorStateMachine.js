/**
 * Tutor State Machine Service
 *
 * Manages conversation state across turns in Tutor Mode.
 * Implements a state machine pattern with:
 * IDLE → TEACHING → QUESTIONING → WAITING_RESPONSE → EVALUATING → ADAPTING → PROGRESSING
 *
 * This ensures structured learning flow and prevents answer dumping.
 *
 * DUAL FSM NOTE — ownership boundary:
 *   • tutorStateMachine.js (this file) owns COURSE_STRUCTURED sessions.
 *     It tracks pedagogical state (are we teaching, questioning, evaluating?)
 *     and persists it per-session in Redis/MongoDB via TutorSession.
 *
 *   • reactOrchestrator.js owns Socratic *assessment scoring* using the same
 *     L1→L4 cognitive level labels and MASTERY_THRESHOLD = 4.0, but applies
 *     them to evaluate a student's answer quality — not to advance session flow.
 *
 *   The two machines share vocabulary (L1–L4, MASTERY_THRESHOLD) but are not
 *   in conflict: one controls "what stage of the lesson are we in", the other
 *   controls "how deeply does the student understand this answer".
 */

const { redisClient } = require('../config/redisClient');
const log = require('../utils/logger');
const TutorSession = require('../models/TutorSession');

// Define all tutor states
const TUTOR_STATES = {
    IDLE: 'IDLE',                           // Session started, no teaching begun
    TEACHING: 'TEACHING',                   // Tutor is explaining a concept
    QUESTIONING: 'QUESTIONING',             // Tutor has asked a question, waiting for response
    WAITING_RESPONSE: 'WAITING_RESPONSE',   // Explicitly waiting for student answer
    EVALUATING: 'EVALUATING',               // Analyzing student response
    ADAPTING: 'ADAPTING',                   // Determining next pedagogical action
    PROGRESSING: 'PROGRESSING'              // Moving to next concept or increasing difficulty
};

// Cognitive levels for progression
const COGNITIVE_LEVELS = {
    L1_CONCEPT: 'L1_CONCEPT',               // Definition, basic understanding
    L2_APPLICATION: 'L2_APPLICATION',       // Real-world examples, practical use
    L3_CRITICAL: 'L3_CRITICAL',             // Edge cases, limitations
    L4_EVALUATION: 'L4_EVALUATION'          // Comparison, improvement
};

const STATE_TTL = 3600; // 1 hour cache for state
const STATE_KEY_PREFIX = 'tutor:session';

function getStateKey(sessionId) {
    return `${STATE_KEY_PREFIX}:${sessionId}`;
}

function defaultLearningPath(topic = 'general') {
    return {
        concept: topic,
        steps: ['definition', 'core idea', 'example', 'application'],
        currentStep: 0
    };
}

function normalizeState(rawState = {}, sessionId = null) {
    const topic = rawState.topic || rawState.subtopic || rawState.subtopicName || rawState.teachingUnit || rawState.moduleTitle || 'general';
    const cognitiveLevel = rawState.cognitiveLevel || rawState.cognitiveLevelName || COGNITIVE_LEVELS.L1_CONCEPT;
    const learningPath = rawState.learningPath || defaultLearningPath(topic);
    const steps = Array.isArray(learningPath.steps) && learningPath.steps.length > 0
        ? learningPath.steps
        : defaultLearningPath(topic).steps;
    const currentStep = Number.isFinite(Number(learningPath.currentStep)) ? Number(learningPath.currentStep) : 0;

    return {
        ...rawState,
        sessionId: rawState.sessionId || sessionId,
        topic,
        cognitiveLevel,
        cognitiveLevelName: rawState.cognitiveLevelName || cognitiveLevel,
        consecutiveWrong: Number(rawState.consecutiveWrong || 0),
        hintsGiven: Number(rawState.hintsGiven || 0),
        masteryScore: Number(rawState.masteryScore || 0),
        turnCount: Number(rawState.turnCount || 0),
        learningPath: {
            concept: learningPath.concept || topic,
            steps,
            currentStep: Math.max(0, Math.min(currentStep, steps.length - 1))
        }
    };
}

async function persistSessionToMongo(state) {
    if (!state || !state.sessionId) return;
    try {
        await TutorSession.findOneAndUpdate(
            { sessionId: state.sessionId },
            {
                $set: {
                    sessionId: state.sessionId,
                    userId: state.userId || null,
                    topic: state.subtopic || state.topic || null,
                    cognitiveLevel: state.cognitiveLevelName || COGNITIVE_LEVELS.L1_CONCEPT,
                    masteryScore: state.masteryScore || 0,
                    attemptHistory: Array.isArray(state.attemptHistory) ? state.attemptHistory.slice(-100) : [],
                    state,
                    updatedAt: new Date()
                }
            },
            { upsert: true, setDefaultsOnInsert: true }
        );
    } catch (error) {
        log.warn('TUTOR_STATE', `Mongo session persist failed for ${state.sessionId}: ${error.message}`);
    }
}

/**
 * Initialize a new tutor session state
 */
async function initializeSession(sessionId, { moduleTitle, topic, subtopic, moduleId, topicId, subtopicId } = {}) {
    const resolvedTopic = topic || subtopic || moduleTitle || 'general';
    const initialLearningPath = defaultLearningPath(resolvedTopic);
    const initialState = {
        sessionId,
        state: TUTOR_STATES.IDLE,
        topic: resolvedTopic,
        cognitiveLevel: COGNITIVE_LEVELS.L1_CONCEPT,
        cognitiveLevelName: COGNITIVE_LEVELS.L1_CONCEPT,
        cognitiveLevelIndex: 0, // 0: L1, 1: L2, 2: L3, 3: L4
        masteryScore: 0,
        consecutiveCorrect: 0,
        consecutiveWrong: 0,
        turnCount: 0,
        lastQuestion: null,
        lastStudentResponse: null,
        responseClassification: null,
        responseScore: 0,
        
        // Teaching unit
        moduleTitle,
        topic,
        subtopic,
        moduleId,
        topicId,
        subtopicId,
        
        // History for adaptive learning
        attemptHistory: [], // { turn, state, classification, score, response }
        difficultyProgression: [], // Track how difficulty changed
        levelsVisited: [COGNITIVE_LEVELS.L1_CONCEPT],
        
        // Hints tracking
        hintsGiven: 0,
        maxHintsBeforeAnswer: 3,

        // Learning trajectory
        learningPath: initialLearningPath,
        
        // Timestamps
        createdAt: new Date(),
        lastActivityAt: new Date()
    };
    
    try {
        const key = getStateKey(sessionId);
        const normalizedState = normalizeState(initialState, sessionId);
        if (redisClient && redisClient.isOpen) {
            await redisClient.setEx(key, STATE_TTL, JSON.stringify(normalizedState));
        }
        await persistSessionToMongo(normalizedState);
        log.info('TUTOR_STATE', `Session initialized: ${sessionId} for ${subtopic || topic}`);
        return normalizedState;
    } catch (error) {
        log.error('TUTOR_STATE', `Failed to initialize session: ${error.message}`);
        throw error;
    }
}

/**
 * Get current session state
 */
async function getSessionState(sessionId) {
    try {
        const key = getStateKey(sessionId);
        const legacyKey = `tutor:sm:${sessionId}`;
        if (redisClient && redisClient.isOpen) {
            const data = await redisClient.get(key);
            if (data) return normalizeState(JSON.parse(data), sessionId);

            // Backward compatibility: migrate legacy key if found
            const legacyData = await redisClient.get(legacyKey);
            if (legacyData) {
                const normalizedLegacy = normalizeState(JSON.parse(legacyData), sessionId);
                await redisClient.setEx(key, STATE_TTL, JSON.stringify(normalizedLegacy));
                await redisClient.del(legacyKey);
                return normalizedLegacy;
            }
        }

        const persisted = await TutorSession.findOne({ sessionId }).lean();
        if (!persisted || !persisted.state) return null;

        const normalizedState = normalizeState(persisted.state, sessionId);

        if (redisClient && redisClient.isOpen) {
            await redisClient.setEx(key, STATE_TTL, JSON.stringify(normalizedState));
        }

        return normalizedState;
    } catch (error) {
        log.error('TUTOR_STATE', `Failed to retrieve session state: ${error.message}`);
        return null;
    }
}

/**
 * Update session state
 */
async function updateSessionState(sessionId, updates) {
    try {
        const currentState = await getSessionState(sessionId);
        if (!currentState) {
            log.warn('TUTOR_STATE', `Session not found: ${sessionId}`);
            return null;
        }
        
        const mergedState = {
            ...currentState,
            ...updates,
            lastActivityAt: new Date()
        };
        const newState = normalizeState(mergedState, sessionId);
        
        const key = getStateKey(sessionId);
        if (redisClient && redisClient.isOpen) {
            await redisClient.setEx(key, STATE_TTL, JSON.stringify(newState));
        }

        await persistSessionToMongo(newState);
        
        return newState;
    } catch (error) {
        log.error('TUTOR_STATE', `Failed to update session state: ${error.message}`);
        throw error;
    }
}

/**
 * Transition to next state in the teaching loop
 */
async function transitionState(sessionId, nextState) {
    if (!Object.values(TUTOR_STATES).includes(nextState)) {
        throw new Error(`Invalid state: ${nextState}`);
    }
    
    const state = await getSessionState(sessionId);
    if (!state) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const prevState = state.state;
    
    return updateSessionState(sessionId, {
        state: nextState,
        turnCount: state.turnCount + 1
    });
}

/**
 * Record student response and classification
 */
async function recordStudentResponse(sessionId, {
    studentResponse,
    classification, // 'CORRECT', 'PARTIAL', 'WRONG', 'INCOMPLETE'
    score, // Numeric score 0.0-2.0
    reasoning = null
}) {
    const state = await getSessionState(sessionId);
    if (!state) throw new Error(`Session not found: ${sessionId}`);
    
    // Update tracking counters
    let consecutiveCorrect = state.consecutiveCorrect;
    let consecutiveWrong = state.consecutiveWrong;
    let hintsGiven = state.hintsGiven;
    
    if (classification === 'CORRECT') {
        consecutiveCorrect += 1;
        consecutiveWrong = 0;
    } else if (classification === 'WRONG' || classification === 'INCOMPLETE') {
        consecutiveWrong += 1;
        consecutiveCorrect = 0;
    } else if (classification === 'PARTIAL') {
        // Neither full correct nor wrong
    }
    
    // Update mastery score
    const newMastery = Math.min(4.0, state.masteryScore + (score || 0));
    
    // Record in history
    const attempt = {
        turn: state.turnCount,
        state: state.state,
        classification,
        score: score || 0,
        response: studentResponse,
        reasoning,
        timestamp: new Date()
    };
    
    const updated = await updateSessionState(sessionId, {
        lastStudentResponse: studentResponse,
        responseClassification: classification,
        responseScore: score || 0,
        masteryScore: newMastery,
        consecutiveCorrect,
        consecutiveWrong,
        hintsGiven,
        attemptHistory: [...state.attemptHistory, attempt]
    });

    if (updated) {
        await persistSessionToMongo(updated);
    }

    return updated;
}

/**
 * Advance cognitive level
 */
async function advanceCognitiveLevel(sessionId) {
    const state = await getSessionState(sessionId);
    if (!state) throw new Error(`Session not found: ${sessionId}`);
    
    const levels = Object.values(COGNITIVE_LEVELS);
    let newIndex = Math.min(state.cognitiveLevelIndex + 1, levels.length - 1);
    const newLevel = levels[newIndex];
    
    const updatedState = await updateSessionState(sessionId, {
        cognitiveLevel: newLevel,
        cognitiveLevelName: newLevel,
        cognitiveLevelIndex: newIndex,
        consecutiveCorrect: 0,
        consecutiveWrong: 0
    });
    
    // Track level progression
    if (!updatedState.levelsVisited.includes(newLevel)) {
        updatedState.levelsVisited.push(newLevel);
    }
    
    log.info('TUTOR_STATE', `Advanced cognitive level: ${sessionId} → ${newLevel}`);
    return updatedState;
}

/**
 * Downgrade cognitive level by one step (temporary simplification)
 */
async function downgradeCognitiveLevel(sessionId) {
    const state = await getSessionState(sessionId);
    if (!state) throw new Error(`Session not found: ${sessionId}`);

    const levels = Object.values(COGNITIVE_LEVELS);
    const currentLevel = state.cognitiveLevelName || state.cognitiveLevel || COGNITIVE_LEVELS.L1_CONCEPT;
    const currentIndex = Math.max(0, levels.indexOf(currentLevel));
    const downgradedIndex = Math.max(0, currentIndex - 1);
    const downgradedLevel = levels[downgradedIndex];

    return updateSessionState(sessionId, {
        cognitiveLevel: downgradedLevel,
        cognitiveLevelName: downgradedLevel,
        cognitiveLevelIndex: downgradedIndex
    });
}

/**
 * Advance learning trajectory step when mastery is achieved
 */
async function advanceLearningStep(sessionId) {
    const state = await getSessionState(sessionId);
    if (!state) throw new Error(`Session not found: ${sessionId}`);

    const steps = state.learningPath?.steps || defaultLearningPath(state.topic).steps;
    const current = state.learningPath?.currentStep || 0;
    const nextStep = Math.min(current + 1, Math.max(0, steps.length - 1));

    return updateSessionState(sessionId, {
        learningPath: {
            concept: state.learningPath?.concept || state.topic,
            steps,
            currentStep: nextStep
        }
    });
}

/**
 * Check if student has achieved mastery
 */
async function checkMastery(sessionId, threshold = 4.0) {
    const state = await getSessionState(sessionId);
    if (!state) throw new Error(`Session not found: ${sessionId}`);
    
    return {
        achieved: state.masteryScore >= threshold,
        currentScore: state.masteryScore,
        threshold,
        requiredScore: Math.max(0, threshold - state.masteryScore)
    };
}

/**
 * Reset hints counter (when advancing level)
 */
async function resetHints(sessionId) {
    return updateSessionState(sessionId, {
        hintsGiven: 0
    });
}

/**
 * Increment hints counter
 */
async function incrementHints(sessionId) {
    const state = await getSessionState(sessionId);
    if (!state) throw new Error(`Session not found: ${sessionId}`);
    
    return updateSessionState(sessionId, {
        hintsGiven: state.hintsGiven + 1
    });
}

/**
 * Get learning flow summary for logging
 */
function getLearningFlowSummary(state) {
    return {
        state: state.state,
        topic: state.subtopic || state.topic,
        cognitiveLevel: state.cognitiveLevelName || state.cognitiveLevel,
        masteryScore: state.masteryScore.toFixed(2),
        turnCount: state.turnCount,
        consecutiveCorrect: state.consecutiveCorrect,
        consecutiveWrong: state.consecutiveWrong,
        lastClassification: state.responseClassification,
        learningPath: state.learningPath
    };
}

module.exports = {
    // States
    TUTOR_STATES,
    COGNITIVE_LEVELS,
    
    // State management
    initializeSession,
    getSessionState,
    updateSessionState,
    transitionState,
    recordStudentResponse,
    
    // Level progression
    advanceCognitiveLevel,
    downgradeCognitiveLevel,
    advanceLearningStep,
    checkMastery,
    
    // Hints
    resetHints,
    incrementHints,
    
    // Utilities
    getLearningFlowSummary
};
