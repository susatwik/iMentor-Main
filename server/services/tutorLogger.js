/**
 * Tutor Logger Service
 * 
 * Provides human-readable logging for tutor mode interactions.
 * Replaces raw LLM dumps with structured learning flow logs.
 * 
 * Sample output:
 * [STUDENT INPUT] Topic: Variables | Message: "A variable stores data"
 * [TUTOR ACTION] State: TEACHING | Cognitive Level: L1_CONCEPT
 * [CONCEPT] A variable is a named container for storing values.
 * [EXAMPLE] Like a mailbox with an address (name) that holds letters (value).
 * [SOCRATIC QUESTION] If you wanted to store a number, what would you name that variable?
 * [WAITING FOR RESPONSE]
 */

const log = require('../utils/logger');

class TutorLogger {
    constructor(sessionId, userId) {
        this.sessionId = sessionId;
        this.userId = userId;
        this.turnNumber = 0;
    }

    /**
     * Log student input
     */
    logStudentInput(topic, message, classification = null) {
        this.turnNumber++;
        const logEntry = {
            turn: this.turnNumber,
            timestamp: new Date().toISOString(),
            type: 'STUDENT_INPUT',
            topic,
            message: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
            classification
        };

        log.info('TUTOR_FLOW', `[STUDENT INPUT] Turn ${this.turnNumber} | Topic: ${topic} | Classification: ${classification || 'pending'}`);
        return logEntry;
    }

    /**
     * Log tutor action (state transition and pedagogical move)
     */
    logTutorAction(currentState, cognitiveLevel, pedagogicalAction) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            type: 'TUTOR_ACTION',
            state: currentState,
            cognitiveLevel,
            action: pedagogicalAction
        };

        log.info('TUTOR_FLOW', `[TUTOR ACTION] State: ${currentState} | Level: ${cognitiveLevel} | Action: ${pedagogicalAction}`);
        return logEntry;
    }

    /**
     * Log teaching concept
     */
    logConcept(conceptText) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            type: 'CONCEPT',
            content: conceptText.substring(0, 150) + (conceptText.length > 150 ? '...' : '')
        };

        log.info('TUTOR_FLOW', `[CONCEPT] ${logEntry.content}`);
        return logEntry;
    }

    /**
     * Log intuition/example
     */
    logExample(exampleText) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            type: 'EXAMPLE',
            content: exampleText.substring(0, 150) + (exampleText.length > 150 ? '...' : '')
        };

        log.info('TUTOR_FLOW', `[EXAMPLE] ${logEntry.content}`);
        return logEntry;
    }

    /**
     * Log Socratic question
     */
    logSocraticQuestion(question) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            type: 'SOCRATIC_QUESTION',
            question: question.substring(0, 200) + (question.length > 200 ? '...' : '')
        };

        log.info('TUTOR_FLOW', `[SOCRATIC QUESTION] ${logEntry.question}`);
        return logEntry;
    }

    /**
     * Log that we're waiting for student response
     */
    logWaitingForResponse() {
        const logEntry = {
            timestamp: new Date().toISOString(),
            type: 'WAITING_FOR_RESPONSE',
            message: 'Waiting for student to respond...'
        };

        log.info('TUTOR_FLOW', `[WAITING FOR RESPONSE] Turn ${this.turnNumber}`);
        return logEntry;
    }

    /**
     * Log response evaluation
     */
    logResponseEvaluation(classification, score, reasoning) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            type: 'RESPONSE_EVALUATION',
            classification,
            score,
            reasoning: reasoning ? reasoning.substring(0, 100) : null
        };

        log.info('TUTOR_FLOW', `[EVALUATION] Classification: ${classification} | Score: ${score.toFixed(2)} | Reasoning: ${reasoning ? reasoning.substring(0, 50) + '...' : 'none'}`);
        return logEntry;
    }

    /**
     * Log adaptive move
     */
    logAdaptiveMove(move, reason) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            type: 'ADAPTIVE_MOVE',
            move,
            reason
        };

        log.info('TUTOR_FLOW', `[ADAPTIVE MOVE] ${move} | Reason: ${reason}`);
        return logEntry;
    }

    /**
     * Log progression to next level
     */
    logProgression(fromLevel, toLevel) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            type: 'PROGRESSION',
            fromLevel,
            toLevel
        };

        log.info('TUTOR_FLOW', `[PROGRESSION] Level: ${fromLevel} → ${toLevel}`);
        return logEntry;
    }

    /**
     * Log hint given
     */
    logHintGiven(hintNumber, hintText) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            type: 'HINT_GIVEN',
            hintNumber,
            content: hintText.substring(0, 150) + (hintText.length > 150 ? '...' : '')
        };

        log.info('TUTOR_FLOW', `[HINT ${hintNumber}] ${logEntry.content}`);
        return logEntry;
    }

    /**
     * Log mastery achieved
     */
    logMasteryAchieved(topic, score) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            type: 'MASTERY_ACHIEVED',
            topic,
            masteryScore: score
        };

        log.info('TUTOR_FLOW', `[MASTERY ACHIEVED] Topic: ${topic} | Score: ${score.toFixed(2)}`);
        return logEntry;
    }

    /**
     * Log session summary
     */
    logSessionSummary(learningFlowSummary) {
        const summary = {
            timestamp: new Date().toISOString(),
            type: 'SESSION_SUMMARY',
            ...learningFlowSummary
        };

        log.info('TUTOR_FLOW', `
[SESSION SUMMARY]
Topic: ${summary.topic}
Turns: ${summary.turnCount}
Mastery Score: ${summary.masteryScore}
Cognitive Level: ${summary.cognitiveLevel}
Consecutive Correct: ${summary.consecutiveCorrect}
Consecutive Wrong: ${summary.consecutiveWrong}
        `);
        return summary;
    }

    /**
     * Log answer leakage prevention (strict enforcement)
     */
    logAnswerLeakagePrevention(attempt, reason) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            type: 'ANSWER_LEAKAGE_PREVENTION',
            attempt,
            reason
        };

        log.warn('TUTOR_FLOW', `[ANSWER LEAKAGE BLOCKED] Attempt: ${attempt} | Reason: ${reason}`);
        return logEntry;
    }

    /**
     * Log validation error
     */
    logValidationError(errorType, details) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            type: 'VALIDATION_ERROR',
            errorType,
            details
        };

        log.error('TUTOR_FLOW', `[VALIDATION ERROR] Type: ${errorType} | Details: ${details}`);
        return logEntry;
    }

    /**
     * Format a complete interaction turn for analysis
     */
    formatCompleteTurn(studentInput, tutorResponse, state) {
        return {
            turn: this.turnNumber,
            timestamp: new Date().toISOString(),
            studentInput,
            tutorResponse,
            state,
            flowType: 'TEACH_QUESTION_WAIT_CYCLE'
        };
    }
}

module.exports = TutorLogger;
