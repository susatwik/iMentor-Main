/**
 * server/services/tutorEnhancementService.js
 * 
 * Advanced Tutor Engine Enhancements
 * 
 * Features:
 * - Loop prevention (detect and break infinite question cycles)
 * - Answer evaluation (CORRECT/PARTIAL/WRONG classification)
 * - Retry threshold enforcement (max 3 retries per question)
 * - Adaptive progression (skip topics if mastery > 80%)
 * - Smart hint generation (progressive: small → guided → solution)
 * - Repeated question detection
 * - Session metrics tracking
 */

const log = require('../utils/logger');
const StudentProfile = require('../models/StudentProfile');

// Session tracking for loop detection
const SESSION_METRICS = new Map();

/**
 * Initialize session metrics
 */
function initializeSessionMetrics(sessionId) {
    SESSION_METRICS.set(sessionId, {
        sessionId,
        questionsAsked: [],
        currentQuestion: null,
        retryCount: 0,
        correctAnswers: 0,
        incorrectAnswers: 0,
        hintLevel: 0, // 0=no hint, 1=small hint, 2=guided, 3=solution
        createdAt: Date.now(),
        lastActivityAt: Date.now()
    });
}

/**
 * Get session metrics
 */
function getSessionMetrics(sessionId) {
    return SESSION_METRICS.get(sessionId);
}

/**
 * Evaluate student answer
 * 
 * @param {string} studentAnswer - Student's response
 * @param {string} correctAnswer - Expected answer (from tutoring system)
 * @param {string} topic - Topic being tested
 * @returns {object} {classification, confidence, feedback}
 * 
 * Classifications:
 * - CORRECT: Student clearly understands
 * - PARTIAL: Student has partial understanding
 * - INCORRECT: Student doesn't understand
 * - INCOMPLETE: No clear answer provided
 */
function evaluateAnswer(studentAnswer, correctAnswer, topic) {
    const answer = studentAnswer.trim().toLowerCase();
    const correct = correctAnswer.trim().toLowerCase();

    // Empty answer = incomplete
    if (!answer || answer.length < 2) {
        return {
            classification: 'INCOMPLETE',
            confidence: 1.0,
            feedback: 'I need more information. Can you try answering again?'
        };
    }

    // Calculate similarity (simple keyword matching + length)
    const answerWords = answer.split(/\s+/);
    const correctWords = correct.split(/\s+/);
    
    let matchedWords = 0;
    for (const word of answerWords) {
        if (correctWords.some(cw => cw.includes(word) || word.includes(cw))) {
            matchedWords++;
        }
    }

    const similarity = matchedWords / Math.max(answerWords.length, correctWords.length);

    // Classification based on similarity
    if (similarity >= 0.8) {
        return {
            classification: 'CORRECT',
            confidence: similarity,
            feedback: 'Excellent! You understand this concept.'
        };
    } else if (similarity >= 0.5) {
        return {
            classification: 'PARTIAL',
            confidence: similarity,
            feedback: 'You\'re on the right track, but let me clarify a few things.'
        };
    } else {
        return {
            classification: 'INCORRECT',
            confidence: 1 - similarity,
            feedback: 'Not quite. Let me explain this better.'
        };
    }
}

/**
 * Check for repeated questions (loop detection)
 * 
 * @param {string} sessionId - Session ID
 * @param {string} currentQuestion - Current question text
 * @returns {object} {isRepeated, frequency, shouldBreakLoop}
 */
function checkForRepeatedQuestion(sessionId, currentQuestion) {
    const metrics = getSessionMetrics(sessionId);
    if (!metrics) {
        return { isRepeated: false, frequency: 0, shouldBreakLoop: false };
    }

    // Count how many times this exact question (or similar) was asked
    const questionHash = currentQuestion.substring(0, 50).toLowerCase();
    const frequency = metrics.questionsAsked.filter(q => 
        q.hash === questionHash || 
        (q.text && q.text.substring(0, 50).toLowerCase() === questionHash)
    ).length;

    // Break loop if same question asked 3+ times
    const shouldBreakLoop = frequency >= 3;

    return {
        isRepeated: frequency > 0,
        frequency,
        shouldBreakLoop
    };
}

/**
 * Generate progressive hints
 * 
 * Hint progression:
 * 1st wrong answer → Small hint (point in right direction)
 * 2nd wrong answer → Guided explanation (work through example)
 * 3rd wrong answer → Concise solution + move on
 * 
 * @param {string} topic - Topic being taught
 * @param {string} concept - Specific concept
 * @param {number} hintLevel - Current hint level (0-3)
 * @param {string} lastAttempt - Student's last attempt
 * @returns {Promise<{hint: string, level: number, shouldAdvance: boolean}>}
 */
async function generateProgressiveHint(topic, concept, hintLevel, lastAttempt) {
    const hints = {
        0: `Think about the fundamentals of ${concept}. What is the key idea here?`,
        1: `Let me walk you through this step-by-step. First, consider ${topic}...`,
        2: `Here's how to solve this: [Concise explanation]. Now let's move to the next concept.`,
        3: `Let me give you the solution so we can progress: [Solution]. Let's build on this knowledge.`
    };

    const nextLevel = Math.min(hintLevel + 1, 3);
    const hint = hints[nextLevel] || hints[3];

    // After hint level 2, student should advance to next topic
    const shouldAdvance = nextLevel >= 2;

    return {
        hint,
        level: nextLevel,
        shouldAdvance
    };
}

/**
 * Check if student should skip topic (adaptive progression)
 * 
 * @param {string} userId - User ID
 * @param {string} topic - Topic to check
 * @returns {Promise<boolean>} true if mastery > 80%
 */
async function shouldSkipTopic(userId, topic) {
    try {
        const profile = await StudentProfile.findOne({ userId });
        if (!profile) return false;

        return profile.shouldSkipTopic(topic);
    } catch (err) {
        log.warn('TUTOR', `Skip topic check failed: ${err.message}`);
        return false;
    }
}

/**
 * Update student mastery based on answer
 * 
 * @param {string} userId - User ID
 * @param {string} topic - Topic
 * @param {string} classification - Answer classification (CORRECT/PARTIAL/INCORRECT)
 * @returns {Promise<object>} Updated mastery state
 */
async function updateStudentMastery(userId, topic, classification) {
    try {
        let profile = await StudentProfile.findOne({ userId });
        if (!profile) {
            // Create new profile if doesn't exist
            profile = new StudentProfile({ userId });
        }

        // Calculate points based on classification
        const pointMap = {
            'CORRECT': 1,
            'PARTIAL': 0.5,
            'INCORRECT': 0,
            'INCOMPLETE': -0.25
        };

        const points = pointMap[classification] || 0;
        profile.updateTopicMastery(topic, points, 1);

        await profile.save();

        return {
            masteryLevel: profile.mastery.get(topic)?.level || 0,
            confidenceLevel: profile.confidenceLevel,
            topic
        };
    } catch (err) {
        log.error('TUTOR', `Mastery update failed: ${err.message}`);
        return null;
    }
}

/**
 * Record session metrics for analytics
 * 
 * @param {string} sessionId - Session ID
 * @param {string} action - Action to record (question_asked, answer_received, hint_given, etc.)
 * @param {object} data - Additional data
 */
function recordSessionMetric(sessionId, action, data = {}) {
    const metrics = getSessionMetrics(sessionId);
    if (!metrics) {
        initializeSessionMetrics(sessionId);
    }

    const current = getSessionMetrics(sessionId);
    current.lastActivityAt = Date.now();

    switch (action) {
        case 'question_asked':
            current.currentQuestion = data.question;
            current.retryCount = 0;
            current.hintLevel = 0;
            current.questionsAsked.push({
                text: data.question,
                hash: data.question.substring(0, 50).toLowerCase(),
                timestamp: Date.now()
            });
            break;

        case 'answer_received':
            current.retryCount++;
            if (data.classification === 'CORRECT') {
                current.correctAnswers++;
            } else {
                current.incorrectAnswers++;
            }
            break;

        case 'hint_given':
            current.hintLevel = data.level || current.hintLevel + 1;
            break;

        case 'topic_advanced':
            current.currentQuestion = null;
            current.retryCount = 0;
            current.hintLevel = 0;
            break;
    }
}

/**
 * Cleanup session metrics (for garbage collection)
 * 
 * @param {string} sessionId - Session ID
 */
function cleanupSessionMetrics(sessionId) {
    SESSION_METRICS.delete(sessionId);
}

/**
 * Get session summary for analytics
 * 
 * @param {string} sessionId - Session ID
 * @returns {object} Session metrics summary
 */
function getSessionSummary(sessionId) {
    const metrics = getSessionMetrics(sessionId);
    if (!metrics) return null;

    const totalAttempts = metrics.correctAnswers + metrics.incorrectAnswers;
    const accuracy = totalAttempts > 0 ? metrics.correctAnswers / totalAttempts : 0;

    return {
        sessionId,
        duration: Date.now() - metrics.createdAt,
        questionsAsked: metrics.questionsAsked.length,
        correctAnswers: metrics.correctAnswers,
        incorrectAnswers: metrics.incorrectAnswers,
        accuracy: (accuracy * 100).toFixed(2) + '%',
        hintsGiven: Math.floor(metrics.hintLevel),
        topics: [...new Set(metrics.questionsAsked.map(q => q.topic))].length
    };
}

/**
 * Enforce retry threshold
 * 
 * @param {string} sessionId - Session ID
 * @param {number} maxRetries - Max retries allowed (default 3)
 * @returns {object} {exceeded: boolean, retriesRemaining: number}
 */
function checkRetryThreshold(sessionId, maxRetries = 3) {
    const metrics = getSessionMetrics(sessionId);
    if (!metrics) {
        return { exceeded: false, retriesRemaining: maxRetries };
    }

    const retriesRemaining = maxRetries - metrics.retryCount;
    return {
        exceeded: metrics.retryCount >= maxRetries,
        retriesRemaining: Math.max(0, retriesRemaining),
        retryCount: metrics.retryCount
    };
}

module.exports = {
    initializeSessionMetrics,
    getSessionMetrics,
    evaluateAnswer,
    checkForRepeatedQuestion,
    generateProgressiveHint,
    shouldSkipTopic,
    updateStudentMastery,
    recordSessionMetric,
    cleanupSessionMetrics,
    getSessionSummary,
    checkRetryThreshold
};
/**
 * server/services/tutorEnhancementService.js
 * 
 * Advanced Tutor Engine Enhancements
 * 
 * Features:
 * - Loop prevention (detect and break infinite question cycles)
 * - Answer evaluation (CORRECT/PARTIAL/WRONG classification)
 * - Retry threshold enforcement (max 3 retries per question)
 * - Adaptive progression (skip topics if mastery > 80%)
 * - Smart hint generation (progressive: small → guided → solution)
 * - Repeated question detection
 * - Session metrics tracking
 */

const log = require('../utils/logger');
const StudentProfile = require('../models/StudentProfile');

// Session tracking for loop detection
const SESSION_METRICS = new Map();

/**
 * Initialize session metrics
 */
function initializeSessionMetrics(sessionId) {
    SESSION_METRICS.set(sessionId, {
        sessionId,
        questionsAsked: [],
        currentQuestion: null,
        retryCount: 0,
        correctAnswers: 0,
        incorrectAnswers: 0,
        hintLevel: 0, // 0=no hint, 1=small hint, 2=guided, 3=solution
        createdAt: Date.now(),
        lastActivityAt: Date.now()
    });
}

/**
 * Get session metrics
 */
function getSessionMetrics(sessionId) {
    return SESSION_METRICS.get(sessionId);
}

/**
 * Evaluate student answer
 * 
 * @param {string} studentAnswer - Student's response
 * @param {string} correctAnswer - Expected answer (from tutoring system)
 * @param {string} topic - Topic being tested
 * @returns {object} {classification, confidence, feedback}
 * 
 * Classifications:
 * - CORRECT: Student clearly understands
 * - PARTIAL: Student has partial understanding
 * - INCORRECT: Student doesn't understand
 * - INCOMPLETE: No clear answer provided
 */
function evaluateAnswer(studentAnswer, correctAnswer, topic) {
    const answer = studentAnswer.trim().toLowerCase();
    const correct = correctAnswer.trim().toLowerCase();

    // Empty answer = incomplete
    if (!answer || answer.length < 2) {
        return {
            classification: 'INCOMPLETE',
            confidence: 1.0,
            feedback: 'I need more information. Can you try answering again?'
        };
    }

    // Calculate similarity (simple keyword matching + length)
    const answerWords = answer.split(/\s+/);
    const correctWords = correct.split(/\s+/);
    
    let matchedWords = 0;
    for (const word of answerWords) {
        if (correctWords.some(cw => cw.includes(word) || word.includes(cw))) {
            matchedWords++;
        }
    }

    const similarity = matchedWords / Math.max(answerWords.length, correctWords.length);

    // Classification based on similarity
    if (similarity >= 0.8) {
        return {
            classification: 'CORRECT',
            confidence: similarity,
            feedback: 'Excellent! You understand this concept.'
        };
    } else if (similarity >= 0.5) {
        return {
            classification: 'PARTIAL',
            confidence: similarity,
            feedback: 'You\'re on the right track, but let me clarify a few things.'
        };
    } else {
        return {
            classification: 'INCORRECT',
            confidence: 1 - similarity,
            feedback: 'Not quite. Let me explain this better.'
        };
    }
}

/**
 * Check for repeated questions (loop detection)
 * 
 * @param {string} sessionId - Session ID
 * @param {string} currentQuestion - Current question text
 * @returns {object} {isRepeated, frequency, shouldBreakLoop}
 */
function checkForRepeatedQuestion(sessionId, currentQuestion) {
    const metrics = getSessionMetrics(sessionId);
    if (!metrics) {
        return { isRepeated: false, frequency: 0, shouldBreakLoop: false };
    }

    // Count how many times this exact question (or similar) was asked
    const questionHash = currentQuestion.substring(0, 50).toLowerCase();
    const frequency = metrics.questionsAsked.filter(q => 
        q.hash === questionHash || 
        (q.text && q.text.substring(0, 50).toLowerCase() === questionHash)
    ).length;

    // Break loop if same question asked 3+ times
    const shouldBreakLoop = frequency >= 3;

    return {
        isRepeated: frequency > 0,
        frequency,
        shouldBreakLoop
    };
}

/**
 * Generate progressive hints
 * 
 * Hint progression:
 * 1st wrong answer → Small hint (point in right direction)
 * 2nd wrong answer → Guided explanation (work through example)
 * 3rd wrong answer → Concise solution + move on
 * 
 * @param {string} topic - Topic being taught
 * @param {string} concept - Specific concept
 * @param {number} hintLevel - Current hint level (0-3)
 * @param {string} lastAttempt - Student's last attempt
 * @returns {Promise<{hint: string, level: number, shouldAdvance: boolean}>}
 */
async function generateProgressiveHint(topic, concept, hintLevel, lastAttempt) {
    const hints = {
        0: `Think about the fundamentals of ${concept}. What is the key idea here?`,
        1: `Let me walk you through this step-by-step. First, consider ${topic}...`,
        2: `Here's how to solve this: [Concise explanation]. Now let's move to the next concept.`,
        3: `Let me give you the solution so we can progress: [Solution]. Let's build on this knowledge.`
    };

    const nextLevel = Math.min(hintLevel + 1, 3);
    const hint = hints[nextLevel] || hints[3];

    // After hint level 2, student should advance to next topic
    const shouldAdvance = nextLevel >= 2;

    return {
        hint,
        level: nextLevel,
        shouldAdvance
    };
}

/**
 * Check if student should skip topic (adaptive progression)
 * 
 * @param {string} userId - User ID
 * @param {string} topic - Topic to check
 * @returns {Promise<boolean>} true if mastery > 80%
 */
async function shouldSkipTopic(userId, topic) {
    try {
        const profile = await StudentProfile.findOne({ userId });
        if (!profile) return false;

        return profile.shouldSkipTopic(topic);
    } catch (err) {
        log.warn('TUTOR', `Skip topic check failed: ${err.message}`);
        return false;
    }
}

/**
 * Update student mastery based on answer
 * 
 * @param {string} userId - User ID
 * @param {string} topic - Topic
 * @param {string} classification - Answer classification (CORRECT/PARTIAL/INCORRECT)
 * @returns {Promise<object>} Updated mastery state
 */
async function updateStudentMastery(userId, topic, classification) {
    try {
        let profile = await StudentProfile.findOne({ userId });
        if (!profile) {
            // Create new profile if doesn't exist
            profile = new StudentProfile({ userId });
        }

        // Calculate points based on classification
        const pointMap = {
            'CORRECT': 1,
            'PARTIAL': 0.5,
            'INCORRECT': 0,
            'INCOMPLETE': -0.25
        };

        const points = pointMap[classification] || 0;
        profile.updateTopicMastery(topic, points, 1);

        await profile.save();

        return {
            masteryLevel: profile.mastery.get(topic)?.level || 0,
            confidenceLevel: profile.confidenceLevel,
            topic
        };
    } catch (err) {
        log.error('TUTOR', `Mastery update failed: ${err.message}`);
        return null;
    }
}

/**
 * Record session metrics for analytics
 * 
 * @param {string} sessionId - Session ID
 * @param {string} action - Action to record (question_asked, answer_received, hint_given, etc.)
 * @param {object} data - Additional data
 */
function recordSessionMetric(sessionId, action, data = {}) {
    const metrics = getSessionMetrics(sessionId);
    if (!metrics) {
        initializeSessionMetrics(sessionId);
    }

    const current = getSessionMetrics(sessionId);
    current.lastActivityAt = Date.now();

    switch (action) {
        case 'question_asked':
            current.currentQuestion = data.question;
            current.retryCount = 0;
            current.hintLevel = 0;
            current.questionsAsked.push({
                text: data.question,
                hash: data.question.substring(0, 50).toLowerCase(),
                timestamp: Date.now()
            });
            break;

        case 'answer_received':
            current.retryCount++;
            if (data.classification === 'CORRECT') {
                current.correctAnswers++;
            } else {
                current.incorrectAnswers++;
            }
            break;

        case 'hint_given':
            current.hintLevel = data.level || current.hintLevel + 1;
            break;

        case 'topic_advanced':
            current.currentQuestion = null;
            current.retryCount = 0;
            current.hintLevel = 0;
            break;
    }
}

/**
 * Cleanup session metrics (for garbage collection)
 * 
 * @param {string} sessionId - Session ID
 */
function cleanupSessionMetrics(sessionId) {
    SESSION_METRICS.delete(sessionId);
}

/**
 * Get session summary for analytics
 * 
 * @param {string} sessionId - Session ID
 * @returns {object} Session metrics summary
 */
function getSessionSummary(sessionId) {
    const metrics = getSessionMetrics(sessionId);
    if (!metrics) return null;

    const totalAttempts = metrics.correctAnswers + metrics.incorrectAnswers;
    const accuracy = totalAttempts > 0 ? metrics.correctAnswers / totalAttempts : 0;

    return {
        sessionId,
        duration: Date.now() - metrics.createdAt,
        questionsAsked: metrics.questionsAsked.length,
        correctAnswers: metrics.correctAnswers,
        incorrectAnswers: metrics.incorrectAnswers,
        accuracy: (accuracy * 100).toFixed(2) + '%',
        hintsGiven: Math.floor(metrics.hintLevel),
        topics: [...new Set(metrics.questionsAsked.map(q => q.topic))].length
    };
}

/**
 * Enforce retry threshold
 * 
 * @param {string} sessionId - Session ID
 * @param {number} maxRetries - Max retries allowed (default 3)
 * @returns {object} {exceeded: boolean, retriesRemaining: number}
 */
function checkRetryThreshold(sessionId, maxRetries = 3) {
    const metrics = getSessionMetrics(sessionId);
    if (!metrics) {
        return { exceeded: false, retriesRemaining: maxRetries };
    }

    const retriesRemaining = maxRetries - metrics.retryCount;
    return {
        exceeded: metrics.retryCount >= maxRetries,
        retriesRemaining: Math.max(0, retriesRemaining),
        retryCount: metrics.retryCount
    };
}

module.exports = {
    initializeSessionMetrics,
    getSessionMetrics,
    evaluateAnswer,
    checkForRepeatedQuestion,
    generateProgressiveHint,
    shouldSkipTopic,
    updateStudentMastery,
    recordSessionMetric,
    cleanupSessionMetrics,
    getSessionSummary,
    checkRetryThreshold
};
