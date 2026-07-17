/**
 * HOTFIX: Safer version of guidedLearningOrchestrator to prevent Gemini 500 errors
 * 
 * Issue: Multiple consecutive LLM calls in tutor mode can cause:
 * 1. Gemini rate limiting (503/500 errors)
 * 2. Context overflow
 * 3. JSON parsing failures
 * 
 * Fixes:
 * - Add retry logic with exponential backoff
 * - Limit conversation history to prevent context overflow
 * - Better error handling
 * - Graceful degradation
 */

const geminiService = require('./geminiService');
const ollamaService = require('./ollamaService');
const TutorSession = require('../models/TutorSession');
const {
    analyzeKnowledgeGaps,
    extractLearningGoal,
    assessHintEffectiveness
} = require('./knowledgeGapAnalyzer');
const {
    generateAdaptiveHint,
    suggestNextAction
} = require('./adaptiveScaffoldService');
const socraticTutorService = require('./socraticTutorService');

// CONFIGURATION: Limits to prevent API overload
const MAX_CONVERSATION_HISTORY = 10; // Limit history to last 10 messages
const RETRY_ATTEMPTS = 2; // Retry failed API calls
const RETRY_DELAY_MS = 1000; // Wait 1 second between retries

/**
 * Main entry point for guided learning mode (HOTFIX VERSION)
 */
async function processGuidedLearning(
    userQuery,
    correctAnswer,
    conversationHistory,
    llmConfig,
    sessionContext = {},
    streamCallback = null // New parameter for streaming
) {
    console.log(`[GuidedLearning] Starting LLM-driven tutoring for: "${userQuery}"`);

    try {
        // FIX 1: Limit conversation history to prevent context overflow
        const limitedHistory = conversationHistory.slice(-MAX_CONVERSATION_HISTORY);

        // FIX 2: Get or create tutor session (with error handling)
        let tutorSession;
        try {
            tutorSession = await getOrCreateTutorSession(
                userQuery,
                sessionContext,
                llmConfig
            );
        } catch (sessionError) {
            console.error('[GuidedLearning] Failed to create tutor session:', sessionError);
            // Fallback: Return simple guided response without session tracking
            const fallback = generateSimpleFallbackResponse(userQuery, correctAnswer);
            if (streamCallback) streamCallback({ type: 'answer', content: fallback.finalAnswer });
            return fallback;
        }

        // Add student's query
        tutorSession.addInteraction('student', userQuery);

        // FIX 3: Skip complex analysis on first interaction to reduce API calls
        let analysis = null;
        if (tutorSession.conversationContext.length > 1) {
            try {
                // Signal analysis start
                if (streamCallback) streamCallback({ type: 'status', content: 'Analyzing knowledge gaps...' });

                // Analyze with retry logic
                analysis = await retryWithBackoff(
                    () => analyzeKnowledgeGaps(
                        userQuery,
                        correctAnswer,
                        tutorSession.conversationContext.slice(-5), // Limit context
                        llmConfig
                    ),
                    RETRY_ATTEMPTS,
                    RETRY_DELAY_MS
                );

                // Update tutor session with analysis
                if (analysis.gaps && analysis.gaps.length > 0) {
                    analysis.gaps.forEach(gap => {
                        if (!tutorSession.knowledgeGaps.some(g => g.concept === gap)) {
                            tutorSession.knowledgeGaps.push({
                                concept: gap,
                                identified: new Date(),
                                resolved: false
                            });
                        }
                    });
                }

                // Update struggling concepts
                if (analysis.comprehensionLevel < 0.5) {
                    const struggleConcepts = analysis.gaps.slice(0, 2);
                    struggleConcepts.forEach(concept => {
                        if (!tutorSession.progressTracking.conceptsStruggling.includes(concept)) {
                            tutorSession.progressTracking.conceptsStruggling.push(concept);
                        }
                    });
                } else if (analysis.comprehensionLevel > 0.7) {
                    // Mark concepts as understood
                    const understoodConcepts = analysis.gaps.filter(gap =>
                        !tutorSession.progressTracking.conceptsUnderstood.includes(gap)
                    );
                    tutorSession.progressTracking.conceptsUnderstood.push(...understoodConcepts);
                }

            } catch (analysisError) {
                console.warn('[GuidedLearning] Analysis failed, skipping:', analysisError.message);
                // Continue without analysis
            }
        }

        // Assess student level
        const assessedLevel = tutorSession.assessStudentLevel();
        if (assessedLevel !== 'unknown') {
            tutorSession.studentLevel = assessedLevel;
        }

        // Build thinking message early for stream
        const thinkingMessage = buildThinkingMessage(tutorSession, analysis);
        if (streamCallback) {
            streamCallback({ type: 'thought', content: thinkingMessage });
            streamCallback({ type: 'status', content: 'Generating adaptive hint...' });
        }

        // FIX 4: Adaptive Socratic 2.0 Generation (Restored Architectural Flow)
        let socraticResult;
        let adaptiveHint; // [Bug fix Team1: was implicitly global]
        try {
            socraticResult = await socraticTutorService.processTutorResponse(
                userQuery,
                tutorSession.sessionId,
                llmConfig,
                (content, isChunk) => {
                    if (streamCallback) {
                        if (isChunk) streamCallback({ type: 'answer', content });
                        else streamCallback({ type: 'status', content });
                    }
                }
            );

            // Sync model state with the result (masteryScore, supportLevel, etc)
            if (socraticResult) {
                tutorSession.masteryScore = socraticResult.masteryScore;
                tutorSession.supportLevel = socraticResult.supportLevel || 'MINIMAL';
                tutorSession.emotionalState = socraticResult.emotionalState || 'CURIOUS';
            }

            adaptiveHint = socraticResult.followUpQuestion;
        } catch (hintError) {
            console.error('[GuidedLearning] Adaptive Socratic failed, using simple fallback:', hintError);
            adaptiveHint = generateSimpleSocraticQuestion(userQuery, tutorSession.studentLevel);
        }

        // Record the hint
        tutorSession.recordHint(adaptiveHint);

        // Add tutor's response
        const comprehensionLevel = analysis ? analysis.comprehensionLevel : null;
        tutorSession.addInteraction('tutor', adaptiveHint, comprehensionLevel);

        // Save session (with error handling)
        try {
            await tutorSession.save();
        } catch (saveError) {
            console.error('[GuidedLearning] Failed to save session:', saveError);
            // Continue anyway
        }

        const cleanedAnswer = adaptiveHint.replace(/\\n/g, '\n');

        return {
            finalAnswer: cleanedAnswer,
            text: cleanedAnswer, // Frontend compatibility alias
            thinking: thinkingMessage,
            sourcePipeline: 'guided_learning',
            action: {
                type: 'guided_learning',
                status: 'active',
                tutorSessionId: tutorSession._id,
                studentLevel: tutorSession.studentLevel,
                comprehensionLevel: comprehensionLevel,
                knowledgeGaps: tutorSession.knowledgeGaps.filter(g => !g.resolved).map(g => g.concept),
                learningGoal: tutorSession.learningGoal,
                progressTracking: tutorSession.progressTracking
            },
            tutorSession: {
                learningGoal: tutorSession.learningGoal,
                studentLevel: tutorSession.studentLevel,
                knowledgeGaps: tutorSession.knowledgeGaps,
                comprehensionLevel,
                tutorSessionId: tutorSession._id,
                progressTracking: tutorSession.progressTracking,
                courseName: sessionContext?.courseName || null,
                masteryProgress: sessionContext?.masteryProgress || null
            }
        };

    } catch (error) {
        console.error('[GuidedLearning] Critical error:', error);
        const fallback = generateSimpleFallbackResponse(userQuery, correctAnswer);
        if (streamCallback) streamCallback({ type: 'answer', content: fallback.finalAnswer });
        return fallback;
    }
}

/**
 * HELPER: Retry function with exponential backoff
 */
async function retryWithBackoff(fn, maxAttempts, baseDelay) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            if (attempt === maxAttempts) {
                throw error; // Give up after max attempts
            }

            const delay = baseDelay * Math.pow(2, attempt - 1); // Exponential backoff
            console.log(`[Retry] Attempt ${attempt} failed, retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

/**
 * HELPER: Simple fallback when all else fails
 */
function generateSimpleFallbackResponse(userQuery, correctAnswer) {
    const rawAnswer = `Let me ask you a question to help you think about this:\n\nWhat do you already know about "${extractKeyTopic(userQuery)}"?\n\n(Tutor Mode is active but simplified due to technical issues)`;
    return {
        finalAnswer: rawAnswer,
        thinking: 'Using simplified tutor mode due to API constraints',
        action: {
            type: 'guided_learning',
            status: 'fallback'
        }
    };
}

/**
 * HELPER: Generate simple Socratic question when hint generation fails
 */
function generateSimpleSocraticQuestion(query, studentLevel) {
    const topic = extractKeyTopic(query);

    const questions = {
        beginner: [
            `Let's break this down. What do you already know about ${topic}?`,
            `Before we dive in, can you tell me what you understand about ${topic} so far?`,
            `Great question! Let's start simple - what comes to mind when you think of ${topic}?`
        ],
        intermediate: [
            `What aspects of ${topic} are you most curious about?`,
            `Can you explain your current understanding of ${topic}?`,
            `What have you tried to understand about ${topic} so far?`
        ],
        advanced: [
            `What specific aspect of ${topic} would you like to explore?`,
            `How does ${topic} relate to what you already know?`,
            `What's your current hypothesis about ${topic}?`
        ]
    };

    const levelQuestions = questions[studentLevel] || questions.beginner;
    return levelQuestions[Math.floor(Math.random() * levelQuestions.length)];
}

/**
 * HELPER: Extract key topic from query
 */
function extractKeyTopic(query) {
    // Simple keyword extraction
    const words = query.toLowerCase().replace(/[?!.]/g, '').split(' ');
    const stopWords = ['what', 'is', 'are', 'the', 'a', 'an', 'how', 'why', 'when', 'where'];
    const meaningfulWords = words.filter(w => w.length > 3 && !stopWords.includes(w));
    return meaningfulWords.slice(0, 3).join(' ') || 'this topic';
}

// ... rest of the functions remain the same (getOrCreateTutorSession, build ThinkingMessage, etc.)

async function getOrCreateTutorSession(userQuery, sessionContext, llmConfig) {
    const { userId, sessionId, subject, course, documentContext } = sessionContext;

    // Try to find existing session
    let tutorSession = await TutorSession.findOne({
        userId,
        sessionId,
        status: 'active'
    }).sort({ updatedAt: -1 });

    if (tutorSession) {
        console.log(`[GuidedLearning] Continuing session: ${tutorSession._id}`);
        return tutorSession;
    }

    // Create new session
    console.log('[GuidedLearning] Creating new tutor session');

    // Extract learning goal (with fallback)
    let learningGoal;
    try {
        learningGoal = await extractLearningGoal(userQuery, llmConfig);
    } catch (error) {
        console.warn('[GuidedLearning] Failed to extract goal, using query');
        learningGoal = userQuery;
    }

    tutorSession = new TutorSession({
        userId,
        sessionId,
        learningGoal,
        studentLevel: 'unknown',
        subject: subject || documentContext || 'General Knowledge',
        course: course || documentContext || 'General Course',
        documentContext: documentContext || null,
        knowledgeGaps: [],
        conversationContext: [],
        previousHints: [],
        progressTracking: {
            totalInteractions: 0,
            successfulGuidance: 0,
            conceptsUnderstood: [],
            conceptsStruggling: []
        },
        // --- Adaptive Socratic 2.0 State ---
        masteryScore: 0,
        struggleCount: 0,
        emotionalState: 'CURIOUS',
        supportLevel: 'MINIMAL',
        // ----------------------------------
        status: 'active'
    });

    await tutorSession.save();
    console.log(`[GuidedLearning] Created new Adaptive Socratic session for ${tutorSession.subject}: ${tutorSession._id}`);

    return tutorSession;
}

function buildThinkingMessage(tutorSession, analysis) {
    const parts = [];

    parts.push(`🎓 **Tutor Mode Active**`);
    parts.push(`Learning Goal: ${tutorSession.learningGoal}`);
    parts.push(`Student Level: ${tutorSession.studentLevel}`);

    if (analysis) {
        parts.push(`Comprehension: ${(analysis.comprehensionLevel * 100).toFixed(0)}%`);
        if (analysis.gaps && analysis.gaps.length > 0) {
            parts.push(`Focus Areas: ${analysis.gaps.slice(0, 2).join(', ')}`);
        }
    }

    return parts.join('\n');
}

module.exports = {
    processGuidedLearning
};
