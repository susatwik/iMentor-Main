const express = require('express');
const router = express.Router();
const axios = require('axios');
const User = require('../models/User');
const { callWithFallback } = require('../services/llmFallbackService');
const log = require('../utils/logger');
const conceptQuestionBankService = require('../services/conceptQuestionBankService');

const QUIZ_GENERATE_TIMEOUT_MS = 40000; // Total timeout for quiz generation
const QUIZ_EVAL_PER_QUESTION_TIMEOUT_MS = 8000; // Per-question AI evaluation timeout
const QUIZ_SUBMIT_HARD_TIMEOUT_MS = 15000; // Hard outer timeout for entire submit request

const PYTHON_RAG_URL = process.env.PYTHON_RAG_SERVICE_URL || 'http://127.0.0.1:2005';

/**
 * Continuously calculates and updates student's learning stage.
 * Based on: Quiz scores, concept mastery, and course completion.
 */
async function updateDynamicLearningStage(user, courseName) {
    if (!user.profile) user.profile = {};

    // 1. Quiz Scores 70/30 weighted performance model
    const quizScores = user.profile.quizScores || [];
    let avgQuizScore = 50; // default/starting
    if (quizScores.length > 0) {
        const recentScore = quizScores[quizScores.length - 1].score;
        let historicalAverage = recentScore;
        if (quizScores.length > 1) {
            const priorAttempts = quizScores.slice(0, quizScores.length - 1);
            const priorSum = priorAttempts.reduce((acc, q) => acc + q.score, 0);
            historicalAverage = priorSum / priorAttempts.length;
        }
        avgQuizScore = (0.7 * recentScore) + (0.3 * historicalAverage);
    }

    const oldStage = user.profile.learningStage || 'Beginner';
    let newStage = 'Beginner';

    if (avgQuizScore >= 76) {
        newStage = 'Advanced';
    } else if (avgQuizScore >= 41) {
        newStage = 'Intermediate';
    } else {
        newStage = 'Beginner';
    }

    user.profile.learningStage = newStage;
    user.profile.learningLevel = newStage.toUpperCase();
    user.markModified('profile');
    
    log.info('USER', `Learning stage dynamically updated from ${oldStage} to ${newStage} (Weighted Score: ${avgQuizScore.toFixed(1)})`);
    return newStage;
}

// @route   GET /api/quiz/generate
// @desc    Generate adaptive Socratic questions based on course/module context
// @access  Private
router.get('/generate', async (req, res) => {
    const { courseName, moduleId, moduleName } = req.query;
    const userId = req.user._id;

    if (!courseName) {
        return res.status(400).json({ message: 'courseName is required.' });
    }

    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: 'User not found.' });

        const quizGenerator = require('../services/questionGeneratorService');

        // ── STEP 1: Redis Quiz Cache ─────────────────────────────────────────
        const { redisClient } = require('../config/redisClient');
        const cacheKey = `quiz:generate:${courseName}:${moduleId || moduleName || 'all'}`;
        if (redisClient?.isOpen) {
            try {
                const cached = await redisClient.get(cacheKey);
                if (cached) {
                    const parsed = JSON.parse(cached);
                    log.info('QUIZ', `Redis cache HIT for ${cacheKey}`);
                    return res.status(200).json({ success: true, ...parsed, _cache: 'redis' });
                }
            } catch (e) { log.warn('QUIZ', `Redis cache read failed: ${e.message}`); }
        }

        // ── STEP 2: MongoDB Quiz Cache ──────────────────────────────────────
        try {
            const Quiz = require('../models/Quiz');
            const existing = await Quiz.findOne({
                course: courseName,
                module: moduleId || moduleName || 'all'
            }).lean();
            if (existing?.questions?.length > 0) {
                log.info('QUIZ', `MongoDB quiz HIT for ${courseName}/${moduleId || moduleName || 'all'}`);
                if (redisClient?.isOpen) {
                    redisClient.setEx(cacheKey, 3600, JSON.stringify(existing)).catch(() => {});
                }
                return res.status(200).json({ success: true, questions: existing.questions, _cache: 'mongodb' });
            }
        } catch (e) { log.warn('QUIZ', `MongoDB quiz lookup failed: ${e.message}`); }

        // ── STEP 3: Concept Question Bank ────────────────────────────────────
        try {
            const ConceptQuestionBank = require('../models/ConceptQuestionBank');
            const bankQuestions = await ConceptQuestionBank.aggregate([
                { $match: { course: courseName } },
                { $sample: { size: 10 } }
            ]);
            if (bankQuestions?.length >= 4) {
                const formatted = bankQuestions.map(q => ({
                    instruction: q.question,
                    type: q.options?.length > 0 ? 'MCQ' : 'Descriptive',
                    options: q.options || [],
                    correctIndex: q.correctIndex ?? 0,
                    output: q.explanation || '',
                    topic: q.concept || q.topic || 'General',
                    difficulty: q.difficulty || 'medium',
                    hint: ''
                }));
                log.info('QUIZ', `Question bank HIT: ${formatted.length} questions for ${courseName}`);
                const payload = { questions: formatted, source: 'questionbank', generatedBy: 'questionbank' };
                if (redisClient?.isOpen) {
                    redisClient.setEx(cacheKey, 3600, JSON.stringify(payload)).catch(() => {});
                }
                return res.status(200).json({ success: true, ...payload, _cache: 'questionbank' });
            }
        } catch (e) { log.warn('QUIZ', `Question bank lookup failed: ${e.message}`); }

        // ── STEP 4: Replay protection ────────────────────────────────────────
        const seenQuestionIds = await quizGenerator.getSeenQuizQuestions(
            userId,
            courseName,
            moduleName || moduleId || 'all'
        );
        log.info('QUIZ', `Replay protection: ${seenQuestionIds.length} questions already seen for ${courseName}/${moduleName || moduleId || 'all'}`);

        // ── STEP 5: LLM Generation with provider health + timeout guard ──────
        const generationPromise = quizGenerator.generateSocraticQuiz({
            courseName,
            moduleId,
            moduleName,
            user,
            seenQuestionIds
        });

        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Quiz generation timed out after ' + (QUIZ_GENERATE_TIMEOUT_MS / 1000) + 's. Please try again.')), QUIZ_GENERATE_TIMEOUT_MS)
        );

        try {
            const questions = await Promise.race([generationPromise, timeoutPromise]);
            const payload = Array.isArray(questions) ? { questions } : questions;

            // Cache in Redis + MongoDB
            if (redisClient?.isOpen) {
                redisClient.setEx(cacheKey, 3600, JSON.stringify(payload)).catch(() => {});
            }
            try {
                const Quiz = require('../models/Quiz');
                await Quiz.findOneAndUpdate(
                    { course: courseName, module: moduleId || moduleName || 'all' },
                    { $set: { questions: payload.questions || [], source: payload.source || 'llm', generatedAt: new Date() } },
                    { upsert: true }
                );
            } catch (e) { log.warn('QUIZ', `MongoDB quiz save failed: ${e.message}`); }

            return res.status(200).json({ success: true, ...payload, _cache: 'llm' });
        } catch (llmError) {
            // ── STEP 6: Template Quiz Generator (final fallback) ─────────────
            log.warn('QUIZ', `LLM generation failed, generating template quiz: ${llmError.message}`);
            const templateQuestions = quizGenerator.generateSocraticOfflineFallback({ courseName, moduleName: moduleName || moduleId });
            const payload = {
                questions: templateQuestions,
                source: 'template',
                generatedBy: 'template_fallback'
            };
            // Cache template
            if (redisClient?.isOpen) {
                redisClient.setEx(cacheKey, 3600, JSON.stringify(payload)).catch(() => {});
            }
            return res.status(200).json({ success: true, ...payload, _cache: 'template' });
        }

    } catch (error) {
        log.error('QUIZ', 'Failed to generate Socratic quiz', error);
        res.status(500).json({ message: error.message || 'Failed to generate quiz.' });
    }
});

// @route   POST /api/quiz/submit
// @desc    Evaluate student answers, update topic mastery, and adapt learning stage
// @access  Private
router.post('/submit', async (req, res) => {
    const submitStart = Date.now();
    const { courseName, moduleId, moduleName, answers } = req.body;
    const userId = req.user._id;

    if (!courseName || !Array.isArray(answers) || answers.length === 0) {
        return res.status(400).json({ message: 'courseName and answers array are required.' });
    }

    // Hard outer timeout — never block the client for more than 15s
    let submitTimedOut = false;
    const submitTimer = setTimeout(() => {
        submitTimedOut = true;
        log.warn('QUIZ', `Submit hard timeout reached (${QUIZ_SUBMIT_HARD_TIMEOUT_MS}ms) for ${courseName}`);
    }, QUIZ_SUBMIT_HARD_TIMEOUT_MS);

    let feedbackList = [];
    let correctCount = 0;
    let overallScore = 0;

    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: 'User not found.' });

        feedbackList = [];
        correctCount = 0;

        // Ensure subdocument Map is initialized
        if (!user.profile.conceptMastery) {
            user.profile.conceptMastery = new Map();
        }

        // 1. Evaluate each answer
        for (let i = 0; i < answers.length; i++) {
            const { topic, instruction, output, studentAnswer, type, options, correctIndex } = answers[i];
            const isMCQ = type === 'MCQ' || (Array.isArray(options) && options.length > 0);

            let isCorrect = false;
            let score = 0;
            let feedbackText = '';

            if (isMCQ) {
                const correctOptionText = options[correctIndex];
                isCorrect = String(studentAnswer).trim() === String(correctIndex) || 
                            String(studentAnswer).trim() === String(correctOptionText).trim();
                score = isCorrect ? 100 : 0;
                feedbackText = isCorrect
                    ? `Correct! "${correctOptionText}" is the correct answer.`
                    : `Incorrect. The correct answer was: "${correctOptionText}".`;
            } else {
                const evalPrompt = `Evaluate the student's answer strictly against the expected document answer.
            
Question: "${instruction}"
Expected Answer: "${output}"
Student's Answer: "${studentAnswer || '(No answer provided)'}"

Return ONLY a valid JSON object with the following keys. Do NOT include markdown blocks (like \`\`\`json) or extra text.
JSON format:
{
  "result": "correct" or "incorrect",
  "score": 0 to 100 representing how complete and accurate the answer is,
  "feedbackText": "A constructive explanation of what was good and what was missing or incorrect."
}
`;
                // Hard per-question timeout + rule-based fallback
                const evalStart = Date.now();
                const evalPromise = (async () => {
                    const providerHealth = require('../services/providerHealthCache');
                    const healthyProviders = providerHealth.getHealthyProviders(['sglang', 'groq', 'gemini', 'openai', 'ollama']);
                    const preferredProvider = healthyProviders.length > 0
                      ? healthyProviders[0]
                      : (process.env.NODE_ENV === 'development' ? 'ollama' : 'sglang');
                    const fallbackResult = await callWithFallback({
                        userQuery: evalPrompt,
                        preferredProvider,
                        preferLocalFirst: true
                    });
                    const responseText = fallbackResult.text;
                    let cleanText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
                    return JSON.parse(cleanText);
                })();

                const evalTimeout = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('AI evaluation timed out')), QUIZ_EVAL_PER_QUESTION_TIMEOUT_MS)
                );

                try {
                    let evalResult;
                    if (submitTimedOut) throw new Error('Submit timed out, using rule-based fallback');
                    evalResult = await Promise.race([evalPromise, evalTimeout]);
                    const elapsed = Date.now() - evalStart;
                    if (elapsed > 5000) log.warn('QUIZ', `Slow AI evaluation for Q${i}: ${elapsed}ms`);
                    log.info('QUIZ', `[SUBMIT] Q${i} AI eval: ${evalResult.result} score=${evalResult.score} ${elapsed}ms`);

                    isCorrect = evalResult.result === 'correct' || evalResult.score >= 70;
                    score = evalResult.score;
                    feedbackText = evalResult.feedbackText;
                } catch (err) {
                    log.warn('QUIZ', `AI evaluation failed for Q${i}, using rule-based fallback: ${err.message}`);
                    // Rule-based fallback: compare student answer to expected answer
                    const sa = (studentAnswer || '').trim().toLowerCase();
                    const exp = (output || '').trim().toLowerCase();
                    const wordOverlap = sa.split(/\s+/).filter(w => exp.includes(w)).length;
                    const overlapRatio = exp.length > 0 ? wordOverlap / Math.max(sa.split(/\s+/).length, 1) : 0;
                    if (sa.length > 10 && overlapRatio >= 0.3) {
                        isCorrect = true;
                        score = Math.min(100, Math.round(overlapRatio * 100));
                        feedbackText = 'Your answer covers some expected concepts. Review the full expected answer for completeness.';
                    } else if (sa.length > 5) {
                        isCorrect = false;
                        score = Math.max(0, Math.round(overlapRatio * 50));
                        feedbackText = 'Your answer partially addresses the topic but misses key points from the expected answer.';
                    } else {
                        isCorrect = false;
                        score = 0;
                        feedbackText = 'No substantial answer provided. Please review the material and try again.';
                    }
                    log.info('QUIZ', `[SUBMIT] Q${i} rule-based fallback: correct=${isCorrect} score=${score} overlap=${overlapRatio.toFixed(2)}`);
                }

                isCorrect = evalResult.result === 'correct' || evalResult.score >= 70;
                score = evalResult.score;
                feedbackText = evalResult.feedbackText;
            }

            if (isCorrect) {
                correctCount++;
            }

            // Record question attempt for analytics (match by question text)
            if (instruction) {
                try {
                    const ConceptQuestionBank = require('../models/ConceptQuestionBank');
                    const matchedQuestion = await ConceptQuestionBank.findOne({
                        course: { $regex: new RegExp(`^${courseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
                        concept: { $regex: new RegExp(`^${topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
                        question: instruction
                    }).lean();
                    if (matchedQuestion?._id) {
                        await conceptQuestionBankService.recordQuestionAttempt(matchedQuestion._id, userId, isCorrect);
                    }
                } catch (e) {
                    log.warn('QUIZ', `Failed to record question attempt: ${e.message}`);
                }
            }

            feedbackList.push({
                questionIndex: i,
                topic: topic || 'General',
                result: isCorrect ? 'correct' : 'incorrect',
                score: score,
                feedbackText: feedbackText
            });

            // ── REPLAY PROTECTION: Store seen question for this user/course/module ──────────────
            if (instruction) {
                try {
                    await questionGeneratorService.addSeenQuizQuestions(
                        userId,
                        courseName,
                        moduleName || moduleId || 'all',
                        [instruction]
                    );
                } catch (e) {
                    log.warn('QUIZ', `Failed to store seen question: ${e.message}`);
                }
            }

            // Update local Concept Mastery Map (rolling update)
            if (topic) {
                const cleanTopic = topic.replace(/\./g, '-'); // prevent dot notation errors
                const currentMastery = user.profile.conceptMastery.get(cleanTopic) || 50;
                
                // If correct, boost mastery by 15-20 points. If wrong, drop by 10 points.
                let newMastery = isCorrect 
                    ? Math.min(100, currentMastery + 15 + Math.round(score / 20))
                    : Math.max(0, currentMastery - 10);

                user.profile.conceptMastery.set(cleanTopic, newMastery);
            }
        }

        // 2. Classify topics evaluated in this quiz attempt
        const topicScoresThisQuiz = {};
        feedbackList.forEach(fb => {
            if (fb.topic) {
                if (!topicScoresThisQuiz[fb.topic]) {
                    topicScoresThisQuiz[fb.topic] = [];
                }
                topicScoresThisQuiz[fb.topic].push(fb.score);
            }
        });

        const strongTopicsThisQuiz = [];
        const weakTopicsThisQuiz = [];
        Object.entries(topicScoresThisQuiz).forEach(([topic, scores]) => {
            const avg = scores.reduce((sum, s) => sum + s, 0) / scores.length;
            if (avg >= 70) {
                strongTopicsThisQuiz.push(topic);
            } else {
                weakTopicsThisQuiz.push(topic);
            }
        });

        // 3. Generate Socratic Remediation summary via LLM
        overallScore = Math.round((correctCount / answers.length) * 100);
        let remediation = {
            strength: "Attempted quiz questions.",
            weakness: "Requires further concept reinforcement.",
            reason: "N/A",
            recommendation: "Review the module notes and retake the quiz."
        };

        try {
            const providerHealth = require('../services/providerHealthCache');
            const healthyProviders = providerHealth.getHealthyProviders(['sglang', 'groq', 'gemini', 'openai', 'ollama']);
            const preferredProvider = healthyProviders.length > 0
              ? healthyProviders[0]
              : (process.env.NODE_ENV === 'development' ? 'ollama' : 'sglang');
            const remediationPrompt = `You are a Socratic learning auditor.
Evaluate the student's overall performance on this quiz for the course "${courseName}" and module "${moduleName || 'all'}".
Here is the breakdown of the quiz questions, student's answers, and evaluation feedback:
${JSON.stringify(feedbackList, null, 2)}

Provide a concise, constructive Socratic remediation plan.
You must return exactly a valid JSON object with the following keys. Do NOT include markdown formatting or extra text.
JSON format:
{
  "strength": "A one-sentence summary of what the student mastered or did well in this quiz.",
  "weakness": "A one-sentence summary of the main conceptual gap or area needing improvement.",
  "reason": "A one-sentence analysis of why the student made these mistakes (e.g., confusing terms, missing application step).",
  "recommendation": "An actionable, specific one-sentence recommendation for what they should study or practice next."
}
`;
            const fallbackRemediation = await callWithFallback({
                userQuery: remediationPrompt,
                preferredProvider,
                preferLocalFirst: true
            });
            let cleanRemediation = fallbackRemediation.text.replace(/```json/g, '').replace(/```/g, '').trim();
            remediation = JSON.parse(cleanRemediation);
        } catch (remError) {
            log.warn('QUIZ', `Failed generating remediation: ${remError.message}`);
        }

        // 4. Update overall User metrics
        user.profile.quizAttempts += 1;
        user.profile.quizScores.push({
            courseName,
            course: courseName,
            module: moduleName || 'all',
            moduleId: moduleId || 'all',
            score: overallScore,
            difficulty: user.profile.learningStage || 'Beginner',
            weakTopics: weakTopicsThisQuiz,
            strongTopics: strongTopicsThisQuiz,
            remediation,
            date: new Date(),
            attemptDate: new Date()
        });

        // 5. Recalculate global lists user.profile.strongTopics and user.profile.weakTopics
        const topicOccurrences = {};
        user.profile.quizScores.forEach(attempt => {
            const attemptStrongs = attempt.strongTopics || [];
            const attemptWeaks = attempt.weakTopics || [];
            
            attemptStrongs.forEach(t => {
                if (!topicOccurrences[t]) topicOccurrences[t] = { strongCount: 0, totalCount: 0 };
                topicOccurrences[t].strongCount += 1;
                topicOccurrences[t].totalCount += 1;
            });
            
            attemptWeaks.forEach(t => {
                if (!topicOccurrences[t]) topicOccurrences[t] = { strongCount: 0, totalCount: 0 };
                topicOccurrences[t].totalCount += 1;
            });
        });

        const globalStrongTopics = [];
        const globalWeakTopics = [];
        Object.entries(topicOccurrences).forEach(([t, data]) => {
            const avgScore = (data.strongCount / data.totalCount) * 100;
            if (avgScore >= 70) {
                globalStrongTopics.push(t);
            } else {
                globalWeakTopics.push(t);
            }
            const cleanTopic = t.replace(/\./g, '-');
            user.profile.conceptMastery.set(cleanTopic, Math.round(avgScore));
        });

        user.profile.strongTopics = globalStrongTopics;
        user.profile.weakTopics = globalWeakTopics;
        
        // Confidence level adjustment
        const currentConf = user.profile.confidenceLevel || 50;
        user.profile.confidenceLevel = overallScore >= 70
            ? Math.min(100, currentConf + 5)
            : Math.max(0, currentConf - 5);

        user.profile.lastQuizDate = new Date();

        // 6. Adapt student's Learning Stage continuously (uses the 70% recent / 30% historical model)
        const newStage = await updateDynamicLearningStage(user, courseName);

        // Save profile
        await user.save();

        // 7. Sync quiz/concept mastery updates to StudentKnowledgeState collection and Neo4j
        try {
            const knowledgeStateService = require('../services/knowledgeStateService');
            const knowledgeState = await knowledgeStateService.getOrCreateKnowledgeState(userId);
            
            // Add quiz failure topics to Student Focus tasks in Study Plan (currentFocusAreas)
            if (weakTopicsThisQuiz && weakTopicsThisQuiz.length > 0) {
                if (!knowledgeState.currentFocusAreas) {
                    knowledgeState.currentFocusAreas = [];
                }
                let focusChanged = false;
                weakTopicsThisQuiz.forEach(topic => {
                    const exists = knowledgeState.currentFocusAreas.some(f => f.topic.toLowerCase() === topic.toLowerCase());
                    if (!exists) {
                        knowledgeState.currentFocusAreas.push({
                            topic,
                            startedAt: new Date(),
                            priority: 'high',
                            reason: `Identified as a weak topic in quiz for ${courseName} - ${moduleName || 'all'}`
                        });
                        focusChanged = true;
                    } else {
                        const existingArea = knowledgeState.currentFocusAreas.find(f => f.topic.toLowerCase() === topic.toLowerCase());
                        if (existingArea && existingArea.priority !== 'high') {
                            existingArea.priority = 'high';
                            existingArea.reason = `Upgraded to high priority: Identified as a weak topic in quiz for ${courseName} - ${moduleName || 'all'}`;
                            focusChanged = true;
                        }
                    }
                });
                if (focusChanged) {
                    knowledgeState.markModified('currentFocusAreas');
                }
            }

            await knowledgeStateService.syncUserConceptMastery(userId, knowledgeState);
            await knowledgeState.save();
        } catch (syncError) {
            log.error('QUIZ', 'Failed syncing mastery to StudentKnowledgeState after quiz submit', syncError);
        }

        const totalElapsed = Date.now() - submitStart;
        clearTimeout(submitTimer);
        log.info('QUIZ', `[SUBMIT] ${courseName}/${moduleName || 'all'} complete: ${overallScore}% (${correctCount}/${answers.length}) ${totalElapsed}ms`);

        if (totalElapsed > 10000) {
            log.warn('QUIZ', `[SUBMIT_SLOW] ${courseName}/${moduleName || 'all'} took ${totalElapsed}ms (>10s)`);
        }

        // If submit timed out, return what we have rather than nothing
        if (submitTimedOut) {
            log.warn('QUIZ', `[SUBMIT_TIMEOUT] Returning partial results for ${courseName}`);
        }

        res.status(200).json({
            success: true,
            score: overallScore,
            correctCount,
            totalCount: answers.length,
            feedback: feedbackList,
            newStage: newStage,
            remediation,
            _elapsed: totalElapsed,
            _timedOut: submitTimedOut,
        });

        // ── REPLAY PROTECTION: Store seen questions after quiz submit ──────────────
        try {
            const questionGeneratorService = require('../services/questionGeneratorService');
            const questionTexts = answers
                .map(a => a.instruction || a.topic || a.output)
                .filter(Boolean);
            if (questionTexts.length > 0) {
                await questionGeneratorService.addSeenQuizQuestions(
                    userId,
                    courseName,
                    moduleName || 'general',
                    questionTexts
                );
            }
        } catch (e) {
            log.warn('QUIZ', `Failed to store seen quiz questions: ${e.message}`);
        }
    } catch (error) {
        clearTimeout(submitTimer);
        log.error('QUIZ', 'Failed submitting quiz evaluation', error);
        // Generate rule-based remediation on failure
        const fallbackRemediation = {
            strength: "Attempted quiz questions.",
            weakness: "Requires further concept reinforcement.",
            reason: "Evaluation could not be completed due to a system error.",
            recommendation: "Review the module notes and retake the quiz."
        };
        // Return partial results if we have any
        if (typeof correctCount !== 'undefined' && feedbackList.length > 0) {
            const partialScore = Math.round((correctCount / answers.length) * 100);
            return res.status(200).json({
                success: true,
                score: partialScore,
                correctCount,
                totalCount: answers.length,
                feedback: feedbackList,
                newStage: 'Beginner',
                remediation: fallbackRemediation,
                _partial: true,
                _elapsed: Date.now() - submitStart,
            });
        }
        res.status(500).json({ message: 'Failed to submit quiz.', error: error.message });
    }
});

// @route   GET /api/quiz/analytics
// @desc    Retrieve user learner model tracking analytics
// @access  Private
router.get('/analytics', async (req, res) => {
    const userId = req.user._id;
    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: 'User not found.' });

        // Convert Map to a standard plain object for json response
        const conceptMasteryObj = {};
        if (user.profile?.conceptMastery) {
            user.profile.conceptMastery.forEach((val, key) => {
                conceptMasteryObj[key] = val;
            });
        }

        // Aggregate analytics per course
        const coursesAnalytics = {};
        const curriculumProgress = user.curriculumProgress || new Map();

        for (const [courseName, progress] of curriculumProgress.entries()) {
            const completedSubtopics = progress.completedSubtopics || [];
            const completedModules = progress.completedModules || [];
            
            // Try to get total counts from python RAG service structure
            let totalSubtopics = 0;
            let totalModules = 0;
            try {
                const response = await axios.get(
                    `${PYTHON_RAG_URL}/curriculum/${encodeURIComponent(courseName)}/structure`,
                    { timeout: 3000 }
                );
                if (response.data?.success && response.data?.curriculum?.modules) {
                    const mods = response.data.curriculum.modules;
                    totalModules = mods.length;
                    mods.forEach(m => {
                        m.topics?.forEach(t => {
                            totalSubtopics += t.subtopics?.length || 0;
                        });
                    });
                }
            } catch (err) {
                // fallbacks if RAG service offline or slow
                totalModules = completedModules.length > 0 ? completedModules.length + 2 : 5;
                totalSubtopics = completedSubtopics.length > 0 ? completedSubtopics.length + 10 : 20;
            }

            const completionPercent = totalSubtopics > 0 
                ? Math.round((completedSubtopics.length / totalSubtopics) * 100)
                : 0;

            const moduleCompletionPercent = totalModules > 0
                ? Math.round((completedModules.length / totalModules) * 100)
                : 0;

            const parsedQuizResults = {};
            if (progress.quizResults) {
                for (const [key, val] of progress.quizResults.entries()) {
                    try {
                        parsedQuizResults[key] = typeof val === 'string' && (val.startsWith('{') || val.startsWith('"')) ? JSON.parse(val) : val;
                    } catch (e) {
                        parsedQuizResults[key] = val;
                    }
                }
            }

            coursesAnalytics[courseName] = {
                completedModulesCount: completedModules.length,
                totalModules,
                moduleCompletionPercent,
                completedSubtopicsCount: completedSubtopics.length,
                totalSubtopics,
                completionPercent,
                quizResults: parsedQuizResults,
                quizIndex: progress.quizIndex || 0
            };
        }

        res.status(200).json({
            success: true,
            analytics: {
                quizAttempts: user.profile?.quizAttempts || 0,
                quizScores: user.profile?.quizScores || [],
                conceptMastery: conceptMasteryObj,
                learningStage: user.profile?.learningStage || 'Beginner',
                weakTopics: user.profile?.weakTopics || [],
                strongTopics: user.profile?.strongTopics || [],
                confidenceLevel: user.profile?.confidenceLevel || 50,
                lastQuizDate: user.profile?.lastQuizDate || null,
                coursesAnalytics
            }
        });
    } catch (error) {
        log.error('QUIZ', 'Failed to retrieve quiz analytics', error);
        res.status(500).json({ message: 'Failed to fetch quiz analytics.', error: error.message });
    }
});

module.exports = router;
