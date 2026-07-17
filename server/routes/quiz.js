const express = require('express');
const router = express.Router();
const axios = require('axios');
const User = require('../models/User');
const { queryPythonRagService } = require('../services/ragQueryService');
const { getCurriculumStructure } = require('../services/socraticTutorService');
const geminiService = require('../services/geminiService');
const { callWithFallback } = require('../services/llmFallbackService');
const log = require('../utils/logger');

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

        const questionGeneratorService = require('../services/questionGeneratorService');
        const questions = await questionGeneratorService.generateSocraticQuiz({
            courseName,
            moduleId,
            moduleName,
            user
        });

        res.status(200).json({
            success: true,
            questions
        });

    } catch (error) {
        log.error('QUIZ', 'Failed to generate Socratic quiz', error);
        res.status(500).json({ message: 'Failed to generate quiz.', error: error.message });
    }
});

// @route   POST /api/quiz/submit
// @desc    Evaluate student answers, update topic mastery, and adapt learning stage
// @access  Private
router.post('/submit', async (req, res) => {
    const { courseName, moduleId, moduleName, answers } = req.body; // answers: [ { topic, instruction, output, studentAnswer } ]
    const userId = req.user._id;

    if (!courseName || !Array.isArray(answers) || answers.length === 0) {
        return res.status(400).json({ message: 'courseName and answers array are required.' });
    }

    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: 'User not found.' });

        const feedbackList = [];
        let correctCount = 0;

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
                let evalResult = { result: 'incorrect', score: 0, feedbackText: 'Evaluation failed.' };
                try {
                    const preferredProvider = process.env.NODE_ENV === 'development' ? 'ollama' : 'sglang';
                    const fallbackResult = await callWithFallback({
                        userQuery: evalPrompt,
                        preferredProvider,
                        preferLocalFirst: true
                    });
                    const responseText = fallbackResult.text;
                    let cleanText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
                    evalResult = JSON.parse(cleanText);
                } catch (err) {
                    log.warn('QUIZ', `Failed evaluating answer ${i}: ${err.message}`);
                }

                isCorrect = evalResult.result === 'correct' || evalResult.score >= 70;
                score = evalResult.score;
                feedbackText = evalResult.feedbackText;
            }

            if (isCorrect) {
                correctCount++;
            }

            feedbackList.push({
                questionIndex: i,
                topic: topic || 'General',
                result: isCorrect ? 'correct' : 'incorrect',
                score: score,
                feedbackText: feedbackText
            });

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
        const overallScore = Math.round((correctCount / answers.length) * 100);
        let remediation = {
            strength: "Attempted quiz questions.",
            weakness: "Requires further concept reinforcement.",
            reason: "N/A",
            recommendation: "Review the module notes and retake the quiz."
        };

        try {
            const preferredProvider = process.env.NODE_ENV === 'development' ? 'ollama' : 'sglang';
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

        res.status(200).json({
            success: true,
            score: overallScore,
            correctCount,
            totalCount: answers.length,
            feedback: feedbackList,
            newStage: newStage,
            remediation
        });

    } catch (error) {
        log.error('QUIZ', 'Failed submitting quiz evaluation', error);
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
