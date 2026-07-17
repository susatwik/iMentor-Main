/**
 * Hard Pedagogical Controller for Tutor Mode
 * 
 * Enforces teaching behavior. Controls which pedagogical action the LLM
 * is allowed to take based on the student's mastery score and cognitive level.
 */

const TEACHING_ACTIONS = {
    TEACH: 'TEACH',
    ASK_QUESTION: 'ASK_QUESTION',
    GIVE_HINT: 'GIVE_HINT',
    REFRAME_CONCEPT: 'REFRAME_CONCEPT',
    USE_ANALOGY: 'USE_ANALOGY',
    CHALLENGE_REASONING: 'CHALLENGE_REASONING',
    SCAFFOLD: 'SCAFFOLD',
    ADVANCE_LEVEL: 'ADVANCE_LEVEL',
    COMPLETE_SUBTOPIC: 'COMPLETE_SUBTOPIC'
};

// Student understanding classifications
const UNDERSTANDING_LEVELS = {
    CORRECT: 'CORRECT',                     // Full understanding, correct answer
    PARTIAL: 'PARTIAL',                     // Some understanding, incomplete answer
    WRONG: 'WRONG',                         // Incorrect answer with misconception
    INCOMPLETE: 'INCOMPLETE',               // Vague or no clear answer
    NO_RESPONSE: 'NO_RESPONSE'              // "I don't know"
};

/**
 * Determine the exact teaching action based on classification data.
 * Implements adaptive pedagogy: responds differently to different understanding levels.
 */
function determineTeachingAction({
    score,
    cumulativeMastery,
    cognitiveLevel,
    attempts,
    classification,
    suggestedMove,
    masteryThreshold = 4.0
}) {
    // 1. Check for Subtopic Completion (highest priority)
    if (cumulativeMastery >= masteryThreshold) {
        return {
            action: TEACHING_ACTIONS.COMPLETE_SUBTOPIC,
            reasoning: 'Mastery threshold reached'
        };
    }

    // 2. Trust the classifier's suggested move if it's specific
    if (suggestedMove === 'SCAFFOLD') {
        return {
            action: TEACHING_ACTIONS.SCAFFOLD,
            reasoning: 'Scaffolding needed for gap'
        };
    }
    if (suggestedMove === 'ADVANCE' && score >= 1.5) {
        return {
            action: TEACHING_ACTIONS.ADVANCE_LEVEL,
            reasoning: 'Ready for next cognitive level'
        };
    }

    // 3. Handle Repeated Failures (Frustration/Stuck Loop)
    if (attempts >= 2 && score < 1.0) {
        return {
            action: (attempts % 2 === 0) ? TEACHING_ACTIONS.USE_ANALOGY : TEACHING_ACTIONS.REFRAME_CONCEPT,
            reasoning: `Repeated failures (${attempts}): changing approach`
        };
    }

    // 4. Normal Score-Based Flow
    if (score < 0.5) {
        return {
            action: TEACHING_ACTIONS.GIVE_HINT,
            reasoning: 'Score too low: provide hint'
        };
    } else if (score >= 0.5 && score < 1.0) {
        return {
            action: TEACHING_ACTIONS.SCAFFOLD,
            reasoning: 'Partial understanding: scaffold'
        };
    } else if (score >= 1.0 && score < 1.5) {
        return {
            action: TEACHING_ACTIONS.ASK_QUESTION,
            reasoning: 'Basic understanding: deepen with question'
        };
    } else if (score >= 1.5 && score < 2.0) {
        return {
            action: TEACHING_ACTIONS.CHALLENGE_REASONING,
            reasoning: 'Good understanding: challenge further'
        };
    } else { // score >= 2.0
        return {
            action: TEACHING_ACTIONS.ADVANCE_LEVEL,
            reasoning: 'Strong understanding: advance level'
        };
    }
}

/**
 * Classify student response and determine adaptive action
 * This is the core of adaptive teaching.
 */
function classifyStudentUnderstanding(studentResponse, lastQuestion, classification, score) {
    const response = {
        classification,
        score: score || 0.5,
        adaptiveAction: null,
        nextQuestion: null,
        shouldAdvance: false,
        shouldRepeat: false,
        shouldSimplify: false,
        hint: null
    };

    // Handle different classification types
    if (classification === UNDERSTANDING_LEVELS.CORRECT) {
        response.adaptiveAction = 'DEEPEN';
        response.shouldAdvance = true;
        response.nextQuestion = 'Move to deeper understanding or next concept';
        response.score = 2.0;
    } else if (classification === UNDERSTANDING_LEVELS.PARTIAL) {
        response.adaptiveAction = 'CLARIFY';
        response.shouldRepeat = true;
        response.nextQuestion = 'Ask about the missing part';
        response.score = 1.0;
    } else if (classification === UNDERSTANDING_LEVELS.WRONG) {
        response.adaptiveAction = 'CORRECT_GENTLY';
        response.shouldRepeat = true;
        response.shouldSimplify = true;
        response.nextQuestion = 'Provide gentle correction and simpler question';
        response.score = 0.5;
    } else if (classification === UNDERSTANDING_LEVELS.INCOMPLETE) {
        response.adaptiveAction = 'SCAFFOLD';
        response.shouldRepeat = true;
        response.hint = 'Provide a hint to guide thinking';
        response.score = 0.75;
    } else if (classification === UNDERSTANDING_LEVELS.NO_RESPONSE) {
        response.adaptiveAction = 'SIMPLIFY_AND_HINT';
        response.hint = 'Provide a simple hint';
        response.shouldSimplify = true;
        response.score = 0.25;
    }

    return response;
}

/**
 * Validate that tutor output follows Socratic principles
 * Prevents answer dumping and enforces question-based engagement
 */
function validateTutorOutput(responseText, isTeachingPhase = false) {
    if (!responseText || responseText.trim().length === 0) {
        return {
            isValid: false,
            error: 'Empty response',
            message: 'Response is empty. Tutor must provide teaching content and question.'
        };
    }

    const text = responseText.toLowerCase();
    
    // Answer-leakage detection
    const answerLeakKeywords = [
        'the answer is',
        'correct answer is',
        'basically, it is',
        'in conclusion, the answer is',
        'so the answer to',
        'therefore, the solution is'
    ];

    for (let keyword of answerLeakKeywords) {
        if (text.includes(keyword)) {
            return {
                isValid: false,
                error: 'Answer leakage detected',
                message: `Tutor revealed answer with phrase: "${keyword}". Use hints instead.`
            };
        }
    }

    // If teaching phase, we expect explanation + question
    if (isTeachingPhase) {
        // Must have reasonable length for teaching
        if (responseText.trim().split('\n').length < 2) {
            return {
                isValid: false,
                error: 'Insufficient teaching content',
                message: 'Teaching phase needs concept + example + question structure'
            };
        }

        // Engagement phase MUST end with or contain a question
        if (!responseText.includes('?')) {
            return {
                isValid: false,
                error: 'Missing Socratic question',
                message: 'Tutor must end teaching with a Socratic question'
            };
        }

        // Check for lecture-mode (too long response)
        const sentences = responseText.split(/[.!?]+/).filter(s => s.trim().length > 0);
        if (sentences.length > 8) {
            return {
                isValid: false,
                error: 'Response too long',
                message: 'Teaching response exceeds 8 sentences. Keep it concise.'
            };
        }

        return {
            isValid: true,
            message: 'Valid teaching response with Socratic question'
        };
    }

    // For engagement (responding to student answer)
    if (!responseText.includes('?')) {
        return {
            isValid: false,
            error: 'Missing engagement question',
            message: 'Response to student must include a follow-up question'
        };
    }

    // Check word count (max 150 words per requirement)
    const wordCount = responseText.split(/\s+/).length;
    if (wordCount > 150) {
        return {
            isValid: false,
            error: 'Response too verbose',
            message: `Response is ${wordCount} words. Limit to 150 words max.`
        };
    }

    return {
        isValid: true,
        message: 'Valid Socratic engagement'
    };
}

/**
 * Detect if student is expressing "I don't know"
 */
function detectConfusion(studentResponse) {
    const confusionPatterns = [
        /i don't know/i,
        /i'm not sure/i,
        /i don't understand/i,
        /i'm confused/i,
        /what do you mean/i,
        /can you explain/i,
        /i'm lost/i,
        /i don't get it/i,
        /idk/i
    ];

    for (let pattern of confusionPatterns) {
        if (pattern.test(studentResponse)) {
            return true;
        }
    }
    return false;
}

/**
 * Suggest next question complexity based on performance
 */
function suggestNextQuestionComplexity(classification, score, currentLevel) {
    if (score >= 1.8) {
        return {
            complexity: 'ADVANCED',
            level: 'L3_CRITICAL',
            message: 'Student ready for edge cases and limitations'
        };
    } else if (score >= 1.2) {
        return {
            complexity: 'INTERMEDIATE',
            level: 'L2_APPLICATION',
            message: 'Student ready for real-world application'
        };
    } else if (score >= 0.8) {
        return {
            complexity: 'FOUNDATIONAL',
            level: 'L1_CONCEPT',
            message: 'Student needs reinforcement of basics'
        };
    } else {
        return {
            complexity: 'ELEMENTARY',
            level: 'L0_BASIC',
            message: 'Student needs simpler explanation or hint'
        };
    }
}

module.exports = {
    TEACHING_ACTIONS,
    UNDERSTANDING_LEVELS,
    determineTeachingAction,
    classifyStudentUnderstanding,
    validateTutorOutput,
    detectConfusion,
    suggestNextQuestionComplexity
};
