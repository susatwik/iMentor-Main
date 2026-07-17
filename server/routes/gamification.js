// server/routes/gamification.js
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const gamificationService = require('../services/gamificationService');
const skillTreeService = require('../services/skillTreeService');
const streakService = require('../services/streakService');
const energyService = require('../services/energyService');
const badgeService = require('../services/badgeService');
const BossBattle = require('../models/BossBattle');
const ConceptContribution = require('../models/ConceptContribution');
const SkillTreeGame = require('../models/SkillTreeGame');
const SkillTree = require('../models/SkillTree');
const { selectLLM, LLMRouter } = require('../services/llmRouterService');
const geminiService = require('../services/geminiService');
const ollamaService = require('../services/ollamaService');
const groqService = require('../services/groqService');
const { getCurriculumStructure } = require('../services/socraticTutorService');
const log = require('../utils/logger');

// All routes require authentication
router.use(authMiddleware);

// ===== User Profile & Stats =====

// @route   GET /api/gamification/profile
// @desc    Get user's complete gamification profile
router.get('/profile', async (req, res) => {
    try {
        const userId = req.user._id;

        const [stats, skillTreeStats, streakStats] = await Promise.all([
            gamificationService.getUserStats(userId),
            skillTreeService.getSkillTreeStats(userId),
            streakService.getStreakStats(userId)
        ]);

        res.json({
            ...stats,
            skillTree: skillTreeStats,
            streak: streakStats
        });

    } catch (error) {
        log.error('SYSTEM', `Gamification profile fetch error: ${error.message}`);
        res.status(500).json({ message: 'Error fetching gamification profile' });
    }
});

//===== Skill Tree =====

// @route   GET /api/gamification/skill-tree
// @desc    Get user's skill tree state (for fog-of-war visualization)
router.get('/skill-tree', async (req, res) => {
    try {
        const skillTree = await skillTreeService.getUserSkillTree(req.user._id);
        res.json({ skillTree });

    } catch (error) {
        log.error('SYSTEM', 'Error fetching skill tree', error);
        res.status(500).json({ message: 'Error fetching skill tree' });
    }
});

// @route   GET /api/gamification/skill/:skillId/assessment
// @desc    Get assessment questions for a skill
router.get('/skill/:skillId/assessment', async (req, res) => {
    try {
        const questions = await skillTreeService.getSkillAssessment(
            req.user._id,
            req.params.skillId
        );

        if (!questions) {
            return res.status(403).json({ message: 'Skill is locked or not found' });
        }

        // If a gameId was provided and the questions are generated (not fallback),
        // save them to the game's level entry the first time only.
        const { gameId, levelId, levelName } = req.query;
        if (gameId && questions.length > 0) {
            try {
                const game = await SkillTreeGame.findOne({ _id: gameId, userId: req.user._id });
                if (game) {
                    // identify level by id or name
                    const idx = typeof levelId !== 'undefined'
                        ? game.levels.findIndex(l => String(l.id) === String(levelId))
                        : game.levels.findIndex(l => l.name === levelName);

                    if (idx !== -1) {
                        // Save questions only if not already present
                        if (!game.levels[idx].questions || game.levels[idx].questions.length === 0) {
                            game.levels[idx].questions = questions;
                            await game.save();
                        }
                        // If questions exist, return those instead of AI fallback
                        const existingQ = game.levels[idx].questions;
                        if (existingQ && existingQ.length > 0) {
                            return res.json({ questions: existingQ });
                        }
                    }
                }
            } catch (saveErr) {
                log.warn('SYSTEM', `Failed to persist generated questions: ${saveErr.message}`);
            }
        }

        res.json({ questions });

    } catch (error) {
        log.error('SYSTEM', `Assessment fetch error: ${error.message}`);
        res.status(500).json({ message: 'Error fetching assessment' });
    }
});

// @route   POST /api/gamification/skill/:skillId/assessment
// @desc    Submit assessment answers
router.post('/skill/:skillId/assessment', async (req, res) => {
    try {
        const { answers } = req.body;

        if (!Array.isArray(answers)) {
            return res.status(400).json({ message: 'Answers must be an array' });
        }

        const result = await skillTreeService.submitSkillAssessment(
            req.user._id,
            req.params.skillId,
            answers
        );

        res.json(result);

    } catch (error) {
        log.error('SYSTEM', 'Error submitting assessment', error);
        res.status(500).json({ message: 'Error submitting assessment' });
    }
});

// @route   POST /api/gamification/skill-tree/check-topic
// @desc    Check if a topic is already active or was previously played
router.post('/skill-tree/check-topic', async (req, res) => {
    try {
        const { topic } = req.body;
        if (!topic || !topic.trim()) {
            return res.status(400).json({ message: 'Topic is required' });
        }

        const userId = req.user._id;
        const normalizedTopic = topic.trim();

        // Check if there's an active game with this topic (case-insensitive)
        const activeGame = await SkillTreeGame.findOne({
            userId,
            topic: { $regex: new RegExp(`^${normalizedTopic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
        });

        if (activeGame) {
            return res.json({
                status: 'active',
                message: 'This game is already present'
            });
        }

        // Check if this topic was previously played and deleted with >5 levels completed
        const GamificationProfile = require('../models/GamificationProfile');
        const profile = await GamificationProfile.findOne({ userId });

        if (profile && profile.deletedGames && profile.deletedGames.length > 0) {
            const topicGames = profile.deletedGames.filter(
                g => g.topic && g.topic.toLowerCase() === normalizedTopic.toLowerCase()
            );
            const previousGame = topicGames.reduce((best, current) => {
                if (!best) return current;
                return (current.completedLevels || 0) > (best.completedLevels || 0) ? current : best;
            }, null);

            if (previousGame && (previousGame.completedLevels || 0) > 5) {
                return res.json({
                    status: 'replay',
                    message: 'You already played this game, if you want to play again then use credits',
                    completedLevels: previousGame.completedLevels,
                    totalCredits: profile.totalLearningCredits || 0,
                    replayCost: 100
                });
            }
        }

        // Topic is fresh — no issues
        res.json({ status: 'ok' });

    } catch (error) {
        log.error('SYSTEM', `Check topic error: ${error.message}`);
        res.status(500).json({ message: 'Error checking topic' });
    }
});

// @route   POST /api/gamification/skill-tree/spend-credits
// @desc    Deduct credits for replaying a previously completed topic
router.post('/skill-tree/spend-credits', async (req, res) => {
    try {
        const { topic, amount } = req.body;
        if (!topic || !amount || amount <= 0) {
            return res.status(400).json({ message: 'Topic and valid amount are required' });
        }

        const userId = req.user._id;
        const GamificationProfile = require('../models/GamificationProfile');
        const profile = await GamificationProfile.findOne({ userId });

        if (!profile) {
            return res.status(404).json({ message: 'Profile not found' });
        }

        if ((profile.totalLearningCredits || 0) < amount) {
            return res.status(400).json({ message: 'Not enough credits', totalCredits: profile.totalLearningCredits || 0 });
        }

        // Deduct credits
        profile.totalLearningCredits = (profile.totalLearningCredits || 0) - amount;
        profile.learningCreditsHistory.push({
            amount: -amount,
            reason: 'spent',
            topic: topic.trim(),
            timestamp: new Date()
        });

        // Find the saved game data for this topic and restore it
        const normalizedTopic = topic.trim().toLowerCase();
        const deletedEntry = (profile.deletedGames || []).find(
            g => g.topic && g.topic.toLowerCase() === normalizedTopic
        );

        let restoredGameId = null;

        if (deletedEntry && deletedEntry.savedGameData && deletedEntry.savedGameData.levels) {
            // Restore the game from the saved snapshot
            const restoredGame = new SkillTreeGame({
                userId,
                topic: deletedEntry.topic,
                assessmentResult: deletedEntry.savedGameData.assessmentResult || {},
                levels: deletedEntry.savedGameData.levels || []
            });
            await restoredGame.save();
            restoredGameId = restoredGame._id;
            log.success('SYSTEM', `Restored game "${deletedEntry.topic}" for user ${userId}`);
        }

        await profile.save();

        res.json({
            success: true,
            totalCredits: profile.totalLearningCredits,
            restoredGameId
        });

    } catch (error) {
        log.error('SYSTEM', `Spend credits error: ${error.message}`);
        res.status(500).json({ message: 'Error spending credits' });
    }
});

// @route   POST /api/gamification/skill-tree/diagnostic
// @desc    Generate Socratic diagnostic questions for a topic
router.post('/skill-tree/diagnostic', async (req, res) => {
    try {
        const { topic } = req.body;

        if (!topic || !topic.trim()) {
            return res.status(400).json({ message: 'Topic is required' });
        }

        // 1. Try to find pre-computed skills for this course/topic
        // We match by 'course' field or 'category'
        let skills = await SkillTree.find({ 
            $or: [
                { course: { $regex: new RegExp(topic, 'i') } },
                { category: { $regex: new RegExp(topic, 'i') } }
            ],
            isActive: true,
            'assessmentQuestions.0': { $exists: true }
        }).lean();

        // 2. If no skills found for this specific subject, fall back to LLM (legacy path)
        if (!skills || skills.length === 0) {
            log.info('GAMIFICATION', `No pre-computed skills found for "${topic}", falling back to LLM generation`);
            // ... [Keep legacy LLM generation as fallback for custom topics]
            return generateDiagnosticWithLLM(topic, req, res);
        }

        // 3. Selection Strategy: 2 Beginners, 2 Intermediate, 1 Advanced
        const beginnerSkills = skills.filter(s => s.difficulty === 'beginner');
        const intermediateSkills = skills.filter(s => s.difficulty === 'intermediate');
        const advancedSkills = skills.filter(s => s.difficulty === 'advanced' || s.difficulty === 'expert');

        const selectedSkills = [];
        
        // Helper to pick random items
        const pickRandom = (arr, num) => {
            const shuffled = [...arr].sort(() => 0.5 - Math.random());
            return shuffled.slice(0, num);
        };

        selectedSkills.push(...pickRandom(beginnerSkills, 2));
        selectedSkills.push(...pickRandom(intermediateSkills, 2));
        selectedSkills.push(...pickRandom(advancedSkills, 1));

        // Fill up to 5 if any category is empty
        if (selectedSkills.length < 5) {
            const remainingNeeded = 5 - selectedSkills.length;
            const notSelected = skills.filter(s => !selectedSkills.find(ss => ss.skillId === s.skillId));
            selectedSkills.push(...pickRandom(notSelected, remainingNeeded));
        }

        // 4. Extract one random question from each selected skill
        const questions = selectedSkills.map(skill => {
            const q = skill.assessmentQuestions[Math.floor(Math.random() * skill.assessmentQuestions.length)];
            return {
                    question: q.question,
                    options: q.options || [],
                    correctIndex: correctIdx !== -1 ? correctIdx : 0,
                    explanation: q.explanation || ''
                };
        });

        log.success('GAMIFICATION', `Served ${questions.length} pre-computed diagnostic questions for "${topic}"`);
        res.json({ questions });

    } catch (error) {
        log.error('SYSTEM', `Diagnostic serve error: ${error.message}`);
        res.status(500).json({ message: 'Error fetching diagnostic questions' });
    }
});

// Helper for legacy LLM fallback — generates diagnostic questions via LLM for custom topics
async function generateDiagnosticWithLLM(topic, req, res) {
    try {
        const prompt = `You are an expert educator assessing a student's knowledge of "${topic}".

Generate exactly 5 diagnostic multiple-choice questions to assess the student's level.
Use this mix: 2 beginner, 2 intermediate, 1 advanced question.

CRITICAL INSTRUCTIONS:
1. Each question must be directly about "${topic}".
2. Provide exactly 4 options per question.
3. Do NOT prefix options with "A.", "B.", etc. - just plain text.
4. One option must be clearly correct.
5. Return ONLY valid JSON - no markdown, no explanation outside JSON.

JSON format:
[
  {
    "question": "Question text here?",
    "options": ["Option 1", "Option 2", "Option 3", "Option 4"],
    "correctAnswer": "Option 1",
    "level": "beginner",
    "explanation": "Why Option 1 is correct."
  }
]`;

        let responseText = await groqService.generateContentWithHistory([], prompt, null, {});

        responseText = responseText.replace(/```json|```/g, '').trim();
        const jsonMatch = responseText.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (!jsonMatch) throw new Error('Groq returned non-JSON response');

        const parsed = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(parsed) || parsed.length === 0) {
            throw new Error('Groq returned empty question array');
        }

        const questions = parsed.slice(0, 5).map((q, i) => ({
            question: q.question,
            options: q.options,
            level: q.level || (i < 2 ? 'beginner' : i < 4 ? 'intermediate' : 'advanced'),
            skillId: null,
            correctAnswer: q.correctAnswer,
            explanation: q.explanation || '',
            type: 'mcq'
        }));

        log.success('GAMIFICATION', `Groq generated ${questions.length} diagnostic questions for "${topic}"`);
        return res.json({ questions });

    } catch (err) {
        log.error('GAMIFICATION', `generateDiagnosticWithLLM error for "${topic}": ${err.message}`);
        return res.status(500).json({ 
            message: 'Unable to generate questions. Please try again.' 
        });
    }
}

// @route   POST /api/gamification/skill-tree/diagnostic/submit
// @desc    Submit diagnostic answers and get assessment result
router.post('/skill-tree/diagnostic/submit', async (req, res) => {
    try {
        const { topic, answers } = req.body;

        if (!topic || !answers || !Array.isArray(answers)) {
            return res.status(400).json({ message: 'Topic and answers are required' });
        }

        // 1. Instant Grading for MCQ
        let score = 0;
        const gradingDetails = [];

        // Fetch DB skills for pre-configured courses (skillId is set)
        const skillIds = answers.map(a => a.skillId).filter(Boolean);
        const skillsFound = skillIds.length > 0
            ? await SkillTree.find({ skillId: { $in: skillIds } }).lean()
            : [];

        // Map for quick lookup
        const skillMap = {};
        skillsFound.forEach(s => skillMap[s.skillId] = s);

        for (const submission of answers) {
            let isCorrect = false;
            let explanation = '';

            if (submission.skillId && skillMap[submission.skillId]) {
                // Pre-configured course: grade against DB
                const skill = skillMap[submission.skillId];
                const questionData = skill.assessmentQuestions.find(q => q.question === submission.question);
                if (questionData) {
                    isCorrect = submission.answer.trim().toLowerCase() === questionData.correctAnswer.trim().toLowerCase() ||
                                submission.answer.charAt(0).toUpperCase() === questionData.correctAnswer.charAt(0).toUpperCase();
                    explanation = questionData.explanation || '';
                }
            } else if (submission.correctAnswer) {
                // Custom topic (LLM-generated): grade using correctAnswer embedded in answer submission
                isCorrect = submission.answer.trim().toLowerCase() === submission.correctAnswer.trim().toLowerCase();
                explanation = submission.explanation || '';
            }

            if (isCorrect) score++;
            gradingDetails.push({
                question: submission.question,
                correct: isCorrect,
                explanation
            });
        }

        // 2. Map score to level
        let level = 'Beginner';
        if (score >= 5) level = 'Expert';
        else if (score >= 4) level = 'Advanced';
        else if (score >= 2) level = 'Intermediate';

        const result = {
            level: level,
            score: score,
            total: answers.length,
            summary: `You answered ${score} out of ${answers.length} questions correctly. Based on your performance in "${topic}", we've placed you at the ${level} level.`,
            strengths: gradingDetails.filter(d => d.correct).map(d => d.question.substring(0, 50) + '...'),
            improvements: gradingDetails.filter(d => !d.correct).map(d => d.question.substring(0, 50) + '...'),
            recommendedStartingPoint: level === 'Beginner' ? 'Module 1: Fundamentals' : 'Module 2: Advanced Concepts',
            gradingDetails: gradingDetails
        };

        // 3. Store the assessment result for future use (Crucial for Skill Tree progression)
        await skillTreeService.storeUserTopicAssessment(req.user._id, topic, result, answers);

        log.success('GAMIFICATION', `Diagnostic submitted for "${topic}": Score ${score}/${answers.length} -> ${level}`);
        res.json(result);

    } catch (error) {
        log.error('SYSTEM', `Diagnostic submission error: ${error.message}`);
        res.status(500).json({ message: 'Error processing diagnostic results' });
    }
});

// @route   POST /api/gamification/skill-tree/generate-levels
// @desc    Generate personalized skill tree levels based on topic and assessment
router.post('/skill-tree/generate-levels', async (req, res) => {
    try {
        const { topic, assessmentResult, answers } = req.body;

        if (!topic) {
            return res.status(400).json({ message: 'Topic is required' });
        }

        const knowledgeLevel = assessmentResult?.level || 'Beginner';
        let levels = [];

        // ── BRANCH 1: Admin Course → use the Neo4j curriculum map ────────────────
        const curriculumStructure = await getCurriculumStructure(topic).catch(() => null);
        const isAdminCourse = curriculumStructure?.modules?.length > 0;

        if (isAdminCourse) {
            log.info('AI', `[SkillTree] Topic "${topic}" matched Admin Course — loading Neo4j curriculum map`);
            let levelIndex = 1;
            for (const mod of curriculumStructure.modules) {
                for (const topicNode of (mod.topics || [])) {
                    for (const sub of (topicNode.subtopics || [])) {
                        const subName = sub.name || sub.id || `Subtopic ${levelIndex}`;
                        const diff = levelIndex <= 10 ? 'easy' : levelIndex <= 20 ? 'medium' : 'hard';
                        levels.push({
                            id: levelIndex,
                            name: subName,
                            description: `${topicNode.name || mod.name} › ${subName}`,
                            difficulty: diff,
                            status: levelIndex === 1 ? 'unlocked' : 'locked',
                            stars: 0,
                            credits: levelIndex * 10,
                            // Bind pre-existing subtopic questions if any
                            subtopic_id: sub.id,
                            topic_name: topicNode.name,
                            module_name: mod.name,
                            isAdminCourse: true
                        });
                        levelIndex++;
                    }
                }
            }

            // Apply diagnostic level jump: if not beginner, unlock already-acquired subtopics
            if (knowledgeLevel !== 'Beginner' && levels.length > 0) {
                const skipCount = knowledgeLevel === 'Expert' ? Math.floor(levels.length * 0.6) :
                    knowledgeLevel === 'Advanced' ? Math.floor(levels.length * 0.4) :
                    knowledgeLevel === 'Intermediate' ? Math.floor(levels.length * 0.2) : 0;
                for (let i = 0; i < skipCount && i < levels.length; i++) {
                    levels[i].status = 'unlocked';
                    levels[i].skippedByDiagnostic = true;
                }
                if (skipCount > 0) {
                    log.info('AI', `[SkillTree] ${knowledgeLevel} diagnostic — unlocked first ${skipCount} levels for "${topic}"`);
                }
            }

            log.success('AI', `[SkillTree] Built ${levels.length}-level map from Neo4j for "${topic}"`);
        }

        // ── BRANCH 2: Custom Topic → dynamically generate map via LLM ─────────────
        if (!isAdminCourse) {
            log.info('AI', `[SkillTree] Topic "${topic}" is custom — generating levels via LLM`);
            const totalLevels = knowledgeLevel === 'Expert' ? 20 :
                knowledgeLevel === 'Advanced' ? 25 :
                    knowledgeLevel === 'Intermediate' ? 30 : 35;

            try {
                const prompt = `You are a curriculum expert creating a highly personalized, gamified skill tree for learning "${topic}".
Current Student Knowledge Level: "${knowledgeLevel}"

Generate a structured learning path with ${totalLevels} levels that feels like a professional educational course.
CRITICAL: Do NOT use generic placeholders like "Introduction to ${topic}". Be specific to the sub-topics of "${topic}".
Each level must have a unique, descriptive name and a clear learning objective in the description.

Progression:
1. Levels 1-10: Basic building blocks and foundational concepts of ${topic}.
2. Levels 11-20: Intermediate techniques, common patterns, and practical implementation.
3. Levels 21-${totalLevels}: Advanced optimization, complex architectures, and expert-level problem solving.

JSON Structure (Return ONLY the array):
[
  {
    "id": 1,
    "name": "Specific Sub-topic Name",
    "description": "Clear learning objective for this specific sub-topic",
    "difficulty": "easy",
    "status": "unlocked",
    "stars": 0
  },
  ...
]

Generate exactly ${totalLevels} UNIQUE levels for: ${topic}`;

               const response = await groqService.generateContentWithHistory([], prompt, null, {});

                // Try to parse JSON from response
                const jsonMatch = response.match(/\[[\s\S]*\]/);
                if (jsonMatch) {
                    let jsonString = jsonMatch[0];
                    try {
                        levels = JSON.parse(jsonString);
                    } catch (parseErr) {
                        log.warn('AI', `First JSON parse attempt for levels failed: ${parseErr.message}. Attempting repair...`);
                        try {
                            const repaired = jsonString.replace(/[\n\r\t]/g, (m) => {
                                if (m === '\n') return '\\n';
                                if (m === '\r') return '\\r';
                                if (m === '\t') return '\\t';
                                return m;
                            });
                            levels = JSON.parse(repaired);
                        } catch (secondErr) {
                            log.error('AI', `Repaired JSON for levels still unparseable: ${secondErr.message}`);
                        }
                    }

                    if (Array.isArray(levels) && levels.length > 0) {
                        levels = levels.map((level, idx) => ({
                            id: level.id || idx + 1,
                            name: level.name || `${topic} - Level ${idx + 1}`,
                            description: level.description || `Master ${topic} concepts`,
                            difficulty: level.difficulty || (idx < 10 ? 'easy' : idx < 20 ? 'medium' : 'hard'),
                            status: idx === 0 ? 'unlocked' : 'locked',
                            stars: 0,
                            credits: (idx + 1) * 10
                        }));
                    }
                }
            } catch (aiError) {
                log.error('AI', 'Level generation failed', aiError);
            }
        }

        // If AI fails or parsing fails, return error instead of fallback
        if (levels.length === 0) {
            log.warn('AI', `AI returned no levels for ${topic}`);
            return res.status(503).json({ message: 'Unable to connect to AI service. Please try again later.' });
        }

        res.json({ levels, isAdminCourse });

    } catch (error) {
        log.error('SYSTEM', 'Error generating levels', error);
        res.status(500).json({ message: 'Error generating skill tree levels' });
    }
});

// Helper function to generate meaningful fallback level names
function generateFallbackLevelNames(topic, totalLevels) {
    const stages = [
        'Introduction to', 'Basics of', 'Understanding', 'Exploring', 'Learning',
        'Fundamentals of', 'Core Concepts', 'Key Principles', 'Essential', 'Building Blocks',
        'Intermediate', 'Developing', 'Practicing', 'Applying', 'Working with',
        'Advanced', 'Deep Dive into', 'Mastering', 'Expert Level', 'Professional'
    ];

    const suffixes = [
        'Concepts', 'Techniques', 'Methods', 'Approaches', 'Skills',
        'Strategies', 'Applications', 'Patterns', 'Practices', 'Principles'
    ];

    return Array.from({ length: totalLevels }, (_, i) => {
        const stageIdx = Math.floor(i / 5) % stages.length;
        const suffixIdx = i % suffixes.length;
        return `${stages[stageIdx]} ${topic} ${suffixes[suffixIdx]}`;
    });
}

// @route   POST /api/gamification/skill-tree/level-questions
// @desc    Generate quiz questions for a specific level
router.post('/skill-tree/level-questions', async (req, res) => {
    try {
        const { topic, levelId, levelName, difficulty, gameId } = req.body;

        // Accept either a numeric `levelId` or a `levelName` from frontend.
        if (!topic || (!levelId && !levelName)) {
            return res.status(400).json({ message: 'Topic and level identifier (levelId or levelName) are required' });
        }

        // 1. Try to find pre-computed technical MCQs for this skill
        // We match by name or skillId, and ensure it belongs to the right course
        const skillNode = await SkillTree.findOne({
            $and: [
                { $or: [{ skillId: levelName }, { name: levelName }] },
                { course: { $regex: new RegExp(topic, 'i') } }
            ],
            isActive: true,
            'assessmentQuestions.0': { $exists: true }
        }).lean();

        if (skillNode && skillNode.assessmentQuestions && skillNode.assessmentQuestions.length > 0) {
            log.success('GAMIFICATION', `Serving ${skillNode.assessmentQuestions.length} pre-computed technical MCQs for level "${levelName}" in "${topic}"`);
            
            // 1.1 Fetch current game state to track seen questions
            let seenQuestions = [];
            let game = null;
            if (gameId) {
                game = await SkillTreeGame.findOne({ _id: gameId, userId: req.user._id });
                if (game) {
                    const level = typeof levelId !== 'undefined'
                        ? game.levels.find(l => String(l.id) === String(levelId))
                        : game.levels.find(l => l.name === levelName);
                    seenQuestions = level?.seenQuestions || [];
                }
            }

            // 1.2 Filter out already seen questions
            const unseenMCQs = skillNode.assessmentQuestions.filter(q => !seenQuestions.includes(q.question));
            
            // 1.3 Select 5 questions (prioritize unseen, fallback to repeats if pool exhausted)
            let selectedPool = unseenMCQs.length >= 5 
                ? unseenMCQs.sort(() => 0.5 - Math.random()).slice(0, 5)
                : skillNode.assessmentQuestions.sort(() => 0.5 - Math.random()).slice(0, 5);

            // Format questions for frontend
            const questions = selectedPool.map(q => {
                let correctIdx = -1;
                if (q.options) {
                    correctIdx = q.options.findIndex(opt => 
                        opt.trim().toLowerCase() === q.correctAnswer.trim().toLowerCase() ||
                        opt.trim().startsWith(q.correctAnswer) ||
                        (q.correctAnswer.length === 1 && opt.trim().startsWith(q.correctAnswer.toUpperCase() + ')'))
                    );
                }
                if (correctIdx === -1 && q.correctAnswer && /^[A-D]$/i.test(q.correctAnswer.trim())) {
                    correctIdx = q.correctAnswer.trim().toUpperCase().charCodeAt(0) - 65;
                }
                return {
                    question: q.question,
                    options: q.options || [],
                    correctIndex: correctIdx !== -1 ? correctIdx : 0,
                    explanation: q.explanation || '',
                    hints: q.hints || []
                };
            });

            // 1.4 Update seenQuestions and cached questions in DB
            if (game) {
                const levelIdx = typeof levelId !== 'undefined'
                    ? game.levels.findIndex(l => String(l.id) === String(levelId))
                    : game.levels.findIndex(l => l.name === levelName);
                
                if (levelIdx !== -1) {
                    const newSeen = selectedPool.map(q => q.question);
                    game.levels[levelIdx].seenQuestions = Array.from(new Set([...seenQuestions, ...newSeen]));
                    game.levels[levelIdx].questions = questions; // cache for first attempt
                    await game.save();
                }
            }

            return res.json({ questions, cached: true });
        }

        let seenQuestionsForLevel = [];   // tracks question texts already shown, for dedup on retry

        // 2. Check if this level already has saved questions in the database (for replay/retry)
        if (gameId) {
            try {
                const game = await SkillTreeGame.findOne({ _id: gameId, userId: req.user._id });
                if (game) {
                    const levelIdx = typeof levelId !== 'undefined'
                        ? game.levels.findIndex(l => String(l.id) === String(levelId))
                        : game.levels.findIndex(l => l.name === levelName);
                    
                    if (levelIdx !== -1) {
                        const lvl = game.levels[levelIdx];
                        const isRetry = (lvl.attempts || 0) > 0;

                        // Collect all previously seen question texts (for prompt exclusion)
                        seenQuestionsForLevel = Array.isArray(lvl.seenQuestions) ? lvl.seenQuestions : [];

                        // Only serve cached questions on the FIRST attempt if not already served from SkillTree.
                        // On retry, fall through to generate a fresh set via LLM.
                        if (!isRetry && lvl.questions && lvl.questions.length > 0) {
                            log.info('SYSTEM', `Returning cached questions for "${levelName || levelId}"`);
                            return res.json({ questions: lvl.questions, cached: true });
                        }
                    }
                }
            } catch (cacheErr) {
                log.warn('SYSTEM', `Error checking cached questions: ${cacheErr.message}`);
                // Continue to generate new questions
            }
        }

        const prompt = `You are a strict technical interviewer creating a quiz for "${topic}".
Level: "${levelName}" (Level ${levelId})
Difficulty: "${difficulty || 'medium'}"

Generate 5 UNIQUE, TOUGH, and DISTINCT multiple-choice questions specifically for this level: "${levelName}".
Do NOT generate generic questions. Do NOT repeat questions from other levels.
${seenQuestionsForLevel.length > 0 ? `\nIMPORTANT — PREVIOUSLY SHOWN QUESTIONS (DO NOT REPEAT OR PARAPHRASE ANY OF THESE):\n${seenQuestionsForLevel.slice(-15).map((q, i) => `${i + 1}. ${q}`).join('\n')}\nGenerate completely DIFFERENT questions that test other aspects of "${levelName}".\n` : ''}
CRITICAL INSTRUCTIONS:
1. Questions must be directly related to "${levelName}".
2. Ensure ONE correct answer.
3. Provide a detailed technical explanation.
4. Do NOT prefix options with letters like "A.", "B.", "C.", "D.". Just provide the plain option text.

JSON Structure (Return ONLY the array):
[
  {
    "question": "Specific question text...",
    "options": ["First option text", "Second option text", "Third option text", "Fourth option text"],
    "correctIndex": 0,
    "explanation": "Why this is correct..."
  }
]`;


        let responseText = '';
        let questions = [];
        let generationSuccess = false;

        try {
            const LLM_TIMEOUT_MS = 30000;
            const llmTimeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('LLM_TIMEOUT')), LLM_TIMEOUT_MS)
            );
            responseText = await Promise.race([
               groqService.generateContentWithHistory([], prompt, null, {}),
                llmTimeoutPromise
            ]);
            generationSuccess = true;
            log.success('AI', 'Level questions generation successful');
        } catch (llmErr) {
            if (llmErr.message === 'LLM_TIMEOUT') {
                log.warn('AI', `Level questions generation timed out after 30s for "${levelName}"`);
                return res.status(503).json({
                    message: 'Question generation is taking too long. Please try again in a moment.',
                    aiGenerationFailed: true
                });
            }
            log.error('AI', `Level questions generation failed: ${llmErr.message}`);
        }

        if (generationSuccess && responseText) {
            try {
                const jsonMatch = responseText.match(/\[[\s\S]*\]/);
                if (jsonMatch) {
                    const jsonString = jsonMatch[0];
                    try {
                        questions = JSON.parse(jsonString);
                    } catch (parseErr) {
                        log.warn('AI', `First JSON parse attempt for questions failed: ${parseErr.message}. Attempting repair...`);
                        try {
                            // Replace unescaped control characters like newlines within strings
                            const repaired = jsonString.replace(/[\n\r\t]/g, (m) => {
                                if (m === '\n') return '\\n';
                                if (m === '\r') return '\\r';
                                if (m === '\t') return '\\t';
                                return m;
                            });
                            questions = JSON.parse(repaired);
                        } catch (secondErr) {
                            log.error('AI', `Repaired JSON for questions still unparseable: ${secondErr.message}`);
                        }
                    }
                }
            } catch (outerError) {
                log.error('AI', 'Error in level questions processing logic', outerError);
            }
        }

        // Normalize questions: ensure options array and a valid 0-based correctIndex
        const normalize = (qs) => {
            if (!Array.isArray(qs)) return [];
            return qs.map((q, qi) => {
                const out = {
                    question: typeof q.question === 'string' ? q.question : (q.prompt || q.text || `Question ${qi + 1}`),
                    options: Array.isArray(q.options) ? q.options.map(o => String(o).replace(/^[A-Da-d][.):\-]\s*/, '')) : (q.options ? [String(q.options)] : []),
                    explanation: q.explanation || q.explain || q.explanations || ''
                };

                // Determine correctIndex from multiple possible formats
                let idx = undefined;
                if (typeof q.correctIndex === 'number' && Number.isFinite(q.correctIndex)) {
                    idx = parseInt(q.correctIndex);
                } else if (typeof q.correctIndex === 'string' && /^\d+$/.test(q.correctIndex.trim())) {
                    idx = parseInt(q.correctIndex.trim());
                } else if (typeof q.correctIndex === 'string' && /^[A-Da-d]$/.test(q.correctIndex.trim())) {
                    idx = q.correctIndex.trim().toUpperCase().charCodeAt(0) - 65;
                } else if (typeof q.answer === 'string' && /^[A-Da-d]$/.test(q.answer.trim())) {
                    idx = q.answer.trim().toUpperCase().charCodeAt(0) - 65;
                } else if (typeof q.correct === 'string' && /^[A-Da-d]$/.test(q.correct.trim())) {
                    idx = q.correct.trim().toUpperCase().charCodeAt(0) - 65;
                } else if (typeof q.correct === 'string' && q.correct.trim().length > 0) {
                    // try match by option text
                    const matchIdx = out.options.findIndex(opt => opt.trim().toLowerCase() === q.correct.trim().toLowerCase());
                    if (matchIdx !== -1) idx = matchIdx;
                } else if (typeof q.answer === 'string' && q.answer.trim().length > 0) {
                    const matchIdx = out.options.findIndex(opt => opt.trim().toLowerCase() === q.answer.trim().toLowerCase());
                    if (matchIdx !== -1) idx = matchIdx;
                }

                // If still undefined but options exist and there is a 'correctOption' field
                if (typeof idx === 'undefined' && typeof q.correctOption === 'string') {
                    const letter = q.correctOption.trim().charAt(0);
                    if (/^[A-Da-d]$/.test(letter)) idx = letter.toUpperCase().charCodeAt(0) - 65;
                }

                // Ensure idx is within range
                if (typeof idx === 'number' && (idx < 0 || idx >= out.options.length)) {
                    idx = undefined;
                }

                out.correctIndex = idx;
                return out;
            });
        };

        questions = normalize(questions);

        // If any question lacks a valid numeric correctIndex, treat as generation failure
        const invalid = questions.some(q => typeof q.correctIndex !== 'number' || Number.isNaN(q.correctIndex));
        if (invalid && questions.length > 0) {
            log.warn('AI', `Missing correctIndex for ${topic} - ${levelName}`);
            // We'll treat this as failed so we can send an error
            questions = [];
        }

        // If AI generation produced no questions, return an explicit error so
        // the frontend can show a clear message instead of placeholder/fallback MCQs.
        if (!questions || questions.length === 0) {
            log.warn('AI', `No questions generated for ${topic} - ${levelName}`);
            return res.status(503).json({ message: 'AI Service Unavailable: Could not generate questions. Please try again.', aiGenerationFailed: true });
        }

        // If we successfully generated questions and a gameId was provided,
        // persist them to the game's level into the database.
        if (questions.length > 0 && gameId) {
            try {
                const game = await SkillTreeGame.findOne({ _id: gameId, userId: req.user._id });
                if (game) {
                    const idx = typeof levelId !== 'undefined'
                        ? game.levels.findIndex(l => String(l.id) === String(levelId))
                        : game.levels.findIndex(l => l.name === levelName);

                    if (idx !== -1) {
                        // Overwrite active questions with fresh batch
                        game.levels[idx].questions = questions;
                        // Accumulate all shown question texts for future dedup
                        const newQTexts = questions.map(q => q.question).filter(Boolean);
                        const existingSeen = Array.isArray(game.levels[idx].seenQuestions) ? game.levels[idx].seenQuestions : [];
                        game.levels[idx].seenQuestions = [...new Set([...existingSeen, ...newQTexts])];
                        await game.save();
                        log.info('SYSTEM', `Saved ${questions.length} questions for "${levelName || levelId}" (total seen: ${game.levels[idx].seenQuestions.length})`);
                    } else {
                        log.warn('SYSTEM', `Level ${levelId}/${levelName} not found in game ${gameId}`);
                    }
                }
            } catch (saveErr) {
                // If saving fails, we should still return the generated questions to the user!
                log.warn('SYSTEM', `Failed to persist level questions: ${saveErr.message}`);
            }
        }

        res.json({ questions });

    } catch (error) {
        log.error('SYSTEM', 'Error generating level questions', error);
        res.status(500).json({ message: 'Error generating level questions' });
    }
});

// ===== Skill Tree Game Persistence =====

// @route   POST /api/gamification/skill-tree/games
// @desc    Create a new skill tree game for the user (or return existing)
router.post('/skill-tree/games', async (req, res) => {
    try {
        const userId = req.user._id;
        const { topic, assessmentResult, levels } = req.body;

        if (!topic) {
            return res.status(400).json({ message: 'Topic is required' });
        }

        // Try to find existing game for user+topic
        let game = await SkillTreeGame.findOne({ userId, topic });
        if (game) {
            // Optionally update assessment or levels if provided
            if (assessmentResult) game.assessmentResult = assessmentResult;
            if (Array.isArray(levels) && levels.length > 0) {
                // Merge provided levels with existing, keeping the highest stars/score
                const provided = levels;
                provided.forEach(p => {
                    const idx = game.levels.findIndex(l => String(l.id) === String(p.id) || l.name === p.name);
                    if (idx !== -1) {
                        const existing = game.levels[idx];
                        existing.stars = Math.max(existing.stars || 0, p.stars || 0);
                        existing.score = Math.max(existing.score || 0, p.score || 0);
                        existing.totalQuestions = p.totalQuestions || existing.totalQuestions;
                        existing.attempts = Math.max(existing.attempts || 0, p.attempts || 0);
                        if (p.status === 'completed') existing.status = 'completed';
                        else if (p.status === 'unlocked' && existing.status !== 'completed') existing.status = 'unlocked';
                        game.levels[idx] = existing;
                    } else {
                        game.levels.push(p);
                    }
                });
            }
            await game.save();
            return res.json({ game });
        }

        // Create new game
        game = new SkillTreeGame({
            userId,
            topic,
            assessmentResult: assessmentResult || {},
            levels: Array.isArray(levels) ? levels : []
        });

        await game.save();

        res.status(201).json({ game });

    } catch (error) {
        log.error('SYSTEM', 'Error creating skill tree game', error);
        res.status(500).json({ message: 'Error creating skill tree game' });
    }
});

// @route   GET /api/gamification/skill-tree/games
// @desc    Get all saved skill tree games for the user
router.get('/skill-tree/games', async (req, res) => {
    try {
        const userId = req.user._id;
        const games = await SkillTreeGame.find({ userId }).sort({ updatedAt: -1 });
        res.json({ games });
    } catch (error) {
        log.error('SYSTEM', 'Error fetching skill tree games', error);
        res.status(500).json({ message: 'Error fetching skill tree games' });
    }
});

// @route   DELETE /api/gamification/skill-tree/games/:gameId
// @desc    Delete a saved skill tree game (saves topic + completed levels to profile history)
router.delete('/skill-tree/games/:gameId', async (req, res) => {
    try {
        const userId = req.user._id;
        const { gameId } = req.params;

        // Fetch the game before deleting so we can save its history
        const game = await SkillTreeGame.findOne({ _id: gameId, userId });
        if (!game) return res.status(404).json({ message: 'Game not found' });

        const completedLevels = game.levels ? game.levels.filter(l => l.status === 'completed').length : 0;
        const totalLevels = game.levels ? game.levels.length : 0;

        // Save/update deleted game history: keep only the best completed-level count per topic
        const GamificationProfile = require('../models/GamificationProfile');
        let profile = await GamificationProfile.findOne({ userId });
        if (!profile) {
            profile = new GamificationProfile({ userId });
        }

        if (!Array.isArray(profile.deletedGames)) {
            profile.deletedGames = [];
        }

        const normalizedDeletedTopic = (game.topic || '').toLowerCase();
        const existingIdx = profile.deletedGames.findIndex(
            g => g.topic && g.topic.toLowerCase() === normalizedDeletedTopic
        );

        const gameSnapshot = {
            topic: game.topic,
            completedLevels,
            totalLevels,
            savedGameData: {
                assessmentResult: game.assessmentResult,
                levels: game.levels
            },
            deletedAt: new Date()
        };

        if (existingIdx === -1) {
            // No existing record for this topic, add it
            profile.deletedGames.push(gameSnapshot);
            await profile.save();
        } else {
            const existing = profile.deletedGames[existingIdx];
            // Replace only if the new deleted game has higher completed levels
            if ((completedLevels || 0) > (existing.completedLevels || 0)) {
                profile.deletedGames[existingIdx] = gameSnapshot;
                await profile.save();
            }
            // Otherwise keep existing DB record unchanged
        }

        await SkillTreeGame.deleteOne({ _id: gameId, userId });
        res.json({ success: true });
    } catch (error) {
        log.error('SYSTEM', 'Error deleting skill tree game', error);
        res.status(500).json({ message: 'Error deleting skill tree game' });
    }
});

// @route   PUT /api/gamification/skill-tree/games/:gameId/level/:levelId
// @desc    Update a single level's progress within a game
router.put('/skill-tree/games/:gameId/level/:levelId', async (req, res) => {
    try {
        const userId = req.user._id;
        const { gameId, levelId } = req.params;
        const update = req.body; // { status, stars, score, attempts, completedAt }

        // log.info('SYSTEM', `Level update: gameId=${gameId}, levelId=${levelId}`);

        const game = await SkillTreeGame.findOne({ _id: gameId, userId });
        if (!game) return res.status(404).json({ message: 'Game not found' });

        const levelIndex = game.levels.findIndex(l => String(l.id) === String(levelId) || String(l._id) === String(levelId) || l.name === levelId);
        if (levelIndex === -1) return res.status(404).json({ message: 'Level not found in game' });

        const level = game.levels[levelIndex];
        // log.info('SYSTEM', `Before update: stars=${level.stars}, status=${level.status}`);

        // Apply safe updates: preserve higher stars/score and don't downgrade status
        if (typeof update.stars !== 'undefined') {
            level.stars = Math.max(level.stars || 0, update.stars || 0);
        }
        if (typeof update.score !== 'undefined') {
            level.score = Math.max(level.score || 0, update.score || 0);
        }
        if (typeof update.totalQuestions !== 'undefined') {
            level.totalQuestions = update.totalQuestions;
        }
        // Attempts increment (take max)
        if (typeof update.attempts !== 'undefined') {
            level.attempts = Math.max(level.attempts || 0, update.attempts || 0);
        } else {
            level.attempts = (level.attempts || 0) + 1;
        }

        // Status: only move forward to 'unlocked' or 'completed' but never back to 'locked'
        // Only mark as completed if user earned at least 1 star
        if (typeof update.status !== 'undefined') {
            if (update.status === 'completed' && level.stars > 0) {
                level.status = 'completed';
            } else if (update.status === 'unlocked' && level.status !== 'completed') {
                level.status = 'unlocked';
            }
        }

        // Calculate credits earned (only on first completion)
        // 1 star = 5 credits, 2 stars = 8 credits, 3 stars = 10 credits
        let creditsEarned = 0;
        const isFirstCompletion = level.status === 'completed' && !level.completedAt;
        if (isFirstCompletion) {
            creditsEarned = level.stars === 3 ? 10 : level.stars === 2 ? 8 : level.stars === 1 ? 5 : 0;
            level.creditsEarned = creditsEarned; // Store credits earned on first completion
            level.completedAt = new Date();

            // Award learning credits to profile history (don't block level save on failure)
            if (creditsEarned > 0) {
                try {
                    await gamificationService.awardLearningCredits(req.user._id, creditsEarned, 'skill_tree_completion', game.topic);
                } catch (awardError) {
                    log.error('SYSTEM', 'Failed to award credits', awardError);
                }
                // Also award Bloom's XP: 3★ = 20 XP, 2★ = 15 XP, 1★ = 10 XP
                try {
                    const xpToAward = level.stars === 3 ? 20 : level.stars === 2 ? 15 : 10;
                    await gamificationService.awardXP(req.user._id, xpToAward, 'application', game.topic);
                } catch (xpError) {
                    log.warn('SYSTEM', 'Failed to award XP for skill tree level', xpError);
                }
            }
        }

        game.levels[levelIndex] = level;
        // If this level was marked completed with stars, unlock the next locked level (if any)
        if (level.status === 'completed' && level.stars > 0) {
            // find next by position in array
            const nextIndex = levelIndex + 1;
            if (game.levels[nextIndex] && game.levels[nextIndex].status === 'locked') {
                game.levels[nextIndex].status = 'unlocked';
            }
        }

        log.success('SYSTEM', `Updated level ${levelId}: stars=${level.stars}, status=${level.status}`);

        // Mark levels array as modified to ensure Mongoose saves changes
        game.markModified('levels');
        await game.save();
        log.info('SYSTEM', 'Game saved successfully');

        // Record progress in the user's gamification profile
        try {
            // Use atomic mark to prevent duplicate credit awards on retries
            const didMark = await gamificationService.markLevelCreditsAwardedIfNot(
                userId,
                game.topic,
                levelId
            );
            const shouldAwardProfileCredits = didMark && level.stars > 0 && level.status === 'completed';
            await gamificationService.recordSkillTreeProgress(
                userId,
                game.topic,
                levelId,
                level.stars || 0,
                level.score || 0,
                level.totalQuestions || 0,
                shouldAwardProfileCredits
            );
        } catch (profileErr) {
            log.error('SYSTEM', 'Failed to record profile progress', profileErr);
        }

        res.json({ game, creditsEarned });
    } catch (error) {
        log.error('SYSTEM', 'Error updating level progress', error);
        res.status(500).json({ message: 'Error updating level progress' });
    }
});

// @route   POST /api/gamification/skill-tree/games/:gameId/save
// @desc    Save entire game state (levels array) for resume
router.post('/skill-tree/games/:gameId/save', async (req, res) => {
    try {
        const userId = req.user._id;
        const { gameId } = req.params;
        const { levels, assessmentResult } = req.body;

        const game = await SkillTreeGame.findOne({ _id: gameId, userId });
        if (!game) return res.status(404).json({ message: 'Game not found' });

        if (Array.isArray(levels)) {
            // Merge provided levels with existing, preserve higher stars/score
            const provided = levels;
            provided.forEach(p => {
                const idx = game.levels.findIndex(l => String(l.id) === String(p.id) || l.name === p.name);
                if (idx !== -1) {
                    const existing = game.levels[idx];
                    existing.stars = Math.max(existing.stars || 0, p.stars || 0);
                    existing.score = Math.max(existing.score || 0, p.score || 0);
                    existing.totalQuestions = p.totalQuestions || existing.totalQuestions;
                    existing.attempts = Math.max(existing.attempts || 0, p.attempts || 0);
                    if (p.status === 'completed') existing.status = 'completed';
                    else if (p.status === 'unlocked' && existing.status !== 'completed') existing.status = 'unlocked';
                    game.levels[idx] = existing;
                } else {
                    game.levels.push(p);
                }
            });
        }
        if (assessmentResult) game.assessmentResult = assessmentResult;

        await game.save();

        res.json({ game });
    } catch (error) {
        log.error('SYSTEM', 'Error saving game state', error);
        res.status(500).json({ message: 'Error saving game state' });
    }
});

// @route   POST /api/gamification/skill-tree/complete-level
// @desc    Save level completion progress
router.post('/skill-tree/complete-level', async (req, res) => {
    try {
        const { topic, levelId, stars, score, totalQuestions } = req.body;

        // Atomically mark credits awarded if not already, to avoid race conditions
        const didMark = await gamificationService.markLevelCreditsAwardedIfNot(req.user._id, topic, levelId);

        // Record progress (preserve creditsAwarded if mark succeeded)
        await gamificationService.recordSkillTreeProgress(
            req.user._id,
            topic,
            levelId,
            stars,
            score,
            totalQuestions,
            didMark
        );

        // Award Learning Credits only if our atomic mark succeeded
        let learningCreditsEarned = 0;
        if (didMark && stars > 0) {
            learningCreditsEarned = stars === 3 ? 10 : stars === 2 ? 8 : 5;
            await gamificationService.awardLearningCredits(req.user._id, learningCreditsEarned, 'application', topic);
        }

        res.json({
            success: true,
            learningCreditsEarned,
            message: `Level ${levelId} completed with ${stars} stars!`
        });

    } catch (error) {
        log.error('SYSTEM', 'Error completing level', error);
        res.status(500).json({ message: 'Error saving level progress' });
    }
});

// ===== Skill Tree Games (Additional Endpoints) =====

// @route   GET /api/gamification/skill-tree/games/:gameId
// @desc    Get a specific saved game
router.get('/skill-tree/games/:gameId', async (req, res) => {
    try {
        const game = await SkillTreeGame.findOne({
            _id: req.params.gameId,
            userId: req.user._id
        });

        if (!game) {
            return res.status(404).json({ message: 'Game not found' });
        }

        res.json({ game });
    } catch (error) {
        log.error('SYSTEM', 'Error fetching skill tree game', error);
        res.status(500).json({ message: 'Error fetching game' });
    }
});

// (Duplicate PUT /skill-tree/games/:gameId/level/:levelId removed — merged into the handler above)

// (Duplicate DELETE route removed — handled above)

// ===== Leaderboards =====

// @route   GET /api/gamification/leaderboard/:topic
// @desc    Get topic-specific leaderboard
router.get('/leaderboard/:topic', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const leaderboard = await gamificationService.getTopicLeaderboard(
            req.params.topic,
            limit
        );

        res.json({ leaderboard });

    } catch (error) {
        log.error('SYSTEM', 'Error fetching leaderboard', error);
        res.status(500).json({ message: 'Error fetching leaderboard' });
    }
});



// ===== Concept Crafting =====

// @route   POST /api/gamification/craft-concept
// @desc    Submit user-created learning content
router.post('/craft-concept', async (req, res) => {
    try {
        const { topic, type, content } = req.body;

        if (!topic || !type || !content) {
            return res.status(400).json({ message: 'Topic, type, and content are required' });
        }

        // AI evaluation prompt
        const evaluationPrompt = `Evaluate this student-created learning content:

Topic: ${topic}
Type: ${type}
Title: ${content.title}
Content: ${content.body || content.front + ' ' + content.back}

Rate on these criteria (0-100 each):
1. Accuracy: Is the content factually correct?
2. Clarity: Is it easy to understand?
3. Creativity: Is it memorable/original?

Return JSON:
{
  "accuracyScore": <0-100>,
  "clarityScore": <0-100>,
  "creativityScore": <0-100>,
  "feedback": "brief constructive feedback (max 100 words)"
}`;

        const { chosenModel } = await selectLLM(evaluationPrompt, { user: req.user });

        let evaluationText;
        if (chosenModel.provider === 'gemini') {
            evaluationText = await geminiService.generateContent(evaluationPrompt, {
                temperature: 0.4
            });
        } else {
            evaluationText = await require('./services/ollamaService').generateContent(
                evaluationPrompt,
                chosenModel.modelId,
                { temperature: 0.4 }
            );
        }

        // Parse AI evaluation
        const jsonMatch = evaluationText.match(/\{[\s\S]*\}/);
        let aiEvaluation = {
            accuracyScore: 70,
            clarityScore: 70,
            creativityScore: 70,
            feedback: 'Good effort!',
            evaluatedAt: new Date()
        };

        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[0]);
                aiEvaluation = {
                    ...parsed,
                    overallScore: Math.round((parsed.accuracyScore + parsed.clarityScore + parsed.creativityScore) / 3),
                    evaluatedAt: new Date()
                };
            } catch (e) {
                log.warn('AI', 'Failed to parse AI evaluation');
            }
        }

        // Create contribution
        const contribution = new ConceptContribution({
            userId: req.user._id,
            topic,
            type,
            content,
            aiEvaluation
        });

        await contribution.save();

        // Award Learning Credits
        const learningCreditsEarned = contribution.calculateXP();
        if (learningCreditsEarned > 0) {
            await gamificationService.awardLearningCredits(req.user._id, learningCreditsEarned, 'crafting', topic);
        }

        res.json({
            contribution,
            earnedLearningCredits: learningCreditsEarned,
            evaluation: aiEvaluation
        });

    } catch (error) {
        log.error('SYSTEM', 'Error crafting concept', error);
        res.status(500).json({ message: 'Error creating concept contribution' });
    }
});

// @route   GET /api/gamification/my-contributions
// @desc    Get user's concept contributions
router.get('/my-contributions', async (req, res) => {
    try {
        const contributions = await ConceptContribution.find({ userId: req.user._id })
            .sort({ createdAt: -1 })
            .limit(20);

        res.json({ contributions });

    } catch (error) {
        log.error('SYSTEM', 'Error fetching contributions', error);
        res.status(500).json({ message: 'Error fetching contributions' });
    }
});

// ===== Energy & Streak =====

// @route   GET /api/gamification/energy
// @desc    Get current energy status
router.get('/energy', async (req, res) => {
    try {
        const profile = await gamificationService.getOrCreateProfile(req.user._id);
        const breakStatus = await energyService.checkBreakStatus(req.user._id);

        res.json({
            currentEnergy: profile.currentEnergy,
            fatigueScore: profile.fatigueScore,
            onBreak: breakStatus.onBreak,
            breakRemaining: breakStatus.remainingMinutes
        });

    } catch (error) {
        log.error('SYSTEM', 'Error fetching energy', error);
        res.status(500).json({ message: 'Error fetching energy status' });
    }
});

// @route   GET /api/gamification/streak
// @desc    Get current streak info
router.get('/streak', async (req, res) => {
    try {
        const streakStats = await streakService.getStreakStats(req.user._id);
        res.json(streakStats);

    } catch (error) {
        log.error('SYSTEM', 'Error fetching streak', error);
        res.status(500).json({ message: 'Error fetching streak' });
    }
});

// ===== Bounty Questions System =====

const bountyService = require('../services/bountyService');

// @route   GET /api/gamification/bounties
// @desc    Get active bounty questions for user (auto-generates if none exist)
router.get('/bounties', async (req, res) => {
    try {
        let bounties = await bountyService.getActiveBounties(req.user._id);

        // Auto-generate a bounty if user has none
        if (bounties.length === 0) {
            log.info('SYSTEM', `User ${req.user._id} has no bounties, auto-generating...`);
            try {
                const newBounty = await bountyService.generateBountyForUser(req.user._id);
                if (newBounty) {
                    bounties = [newBounty];
                }
            } catch (error) {
                log.error('SYSTEM', 'Bounty auto-generation failed', error);
                // Return empty array if auto-generation fails
            }
        }

        res.json({ bounties });

    } catch (error) {
        log.error('SYSTEM', 'Error fetching bounties', error);
        res.status(500).json({ message: 'Error fetching bounty questions' });
    }
});

// @route   POST /api/gamification/bounty/:bountyId/submit
// @desc    Submit answer to bounty question
router.post('/bounty/:bountyId/submit', async (req, res) => {
    try {
        const { answer } = req.body;

        if (!answer) {
            return res.status(400).json({ message: 'Answer is required' });
        }

        // log.info('SYSTEM', `User ${req.user._id} submitting bounty ${req.params.bountyId}`);

        const result = await bountyService.submitBountyAnswer(
            req.params.bountyId,
            req.user._id,
            answer
        );

        log.success('SYSTEM', `Bounty result: ${result.isCorrect ? 'CORRECT' : 'INCORRECT'}, Credits: ${result.creditsAwarded}`);

        res.json({
            success: true,
            ...result,
            message: result.isCorrect
                ? `Correct! You earned ${result.creditsAwarded} credits and ${result.learningCreditsAwarded} Learning Credits!`
                : 'Incorrect answer. Better luck next time!'
        });

    } catch (error) {
        log.error('SYSTEM', 'Error submitting bounty', error);
        res.status(400).json({ message: error.message || 'Error submitting answer' });
    }
});

// @route   GET /api/gamification/credits
// @desc    Get user's learning credits balance
router.get('/credits', async (req, res) => {
    try {
        const GamificationProfile = require('../models/GamificationProfile');
        const profile = await GamificationProfile.findOne({ userId: req.user._id });

        if (!profile) {
            return res.json({ credits: 0, history: [] });
        }

        res.json({
            credits: profile.learningCredits || 0,
            history: profile.creditsHistory?.slice(-20).reverse() || []
        });

    } catch (error) {
        log.error('SYSTEM', 'Error fetching credits balance', error);
        res.status(500).json({ message: 'Error fetching credits' });
    }
});

// @route   POST /api/gamification/generate-bounty
// @desc    Manually trigger bounty generation (for testing)
router.post('/generate-bounty', async (req, res) => {
    try {
        const gapAnalysis = await bountyService.analyzeKnowledgeGaps(req.user._id, 7);

        if (!gapAnalysis) {
            return res.status(404).json({ message: 'Not enough data to generate bounty' });
        }

        const bounty = await bountyService.generateBountyQuestion(req.user._id, gapAnalysis);


        if (!bounty) {
            return res.status(500).json({ message: 'Failed to generate bounty' });
        }

        res.json({ bounty, message: 'Bounty question generated successfully' });

    } catch (error) {
        log.error('SYSTEM', 'Error generating manual bounty', error);
        res.status(500).json({ message: 'Error generating bounty question' });
    }
});

// ===== Boss Battles System =====

const bossBattleService = require('../services/bossBattleService');

// @route   GET /api/gamification/boss-battles
// @desc    Get active boss battles for user (auto-generates if none exist)
router.get('/boss-battles', async (req, res) => {
    try {
        let battles = await bossBattleService.getActiveBattles(req.user._id);

        // Auto-generate a battle if user has none
        if (battles.length === 0) {
            log.info('SYSTEM', `User ${req.user._id} has no battles, auto-generating...`);
            try {
                const newBattle = await bossBattleService.createBossBattle(req.user._id);
                battles = [newBattle];
            } catch (error) {
                log.error('SYSTEM', 'Boss battle auto-generation failed', error);
                // Return empty array if auto-generation fails
            }
        }

        res.json({ battles });

    } catch (error) {
        log.error('SYSTEM', 'Error fetching boss battles', error);
        res.status(500).json({ message: 'Error fetching boss battles' });
    }
});

// @route   GET /api/gamification/boss-battle/:battleId
// @desc    Get specific boss battle (sanitized)
router.get('/boss-battle/:battleId', async (req, res) => {
    try {
        const battle = await bossBattleService.getBattle(req.params.battleId, req.user._id);

        if (!battle) {
            return res.status(404).json({ message: 'Boss battle not found' });
        }

        res.json({ battle });

    } catch (error) {
        log.error('SYSTEM', 'Error fetching boss battle', error);
        res.status(500).json({ message: 'Error fetching boss battle' });
    }
});

// @route   GET /api/gamification/boss-battles/history
// @desc    Get boss battle history
router.get('/boss-battles/history', async (req, res) => {
    try {
        const history = await bossBattleService.getBattleHistory(req.user._id, 20);
        res.json({ history });

    } catch (error) {
        log.error('SYSTEM', 'Error fetching battle history', error);
        res.status(500).json({ message: 'Error fetching history' });
    }
});

// @route   POST /api/gamification/boss-battle/create
// @desc    Create a new boss battle
router.post('/boss-battle/create', async (req, res) => {
    try {
        const { topic, difficulty } = req.body;

        const battle = await bossBattleService.createBossBattle(
            req.user._id,
            topic,
            difficulty
        );

        res.json({ battle, message: 'Boss battle created successfully' });

    } catch (error) {
        log.error('SYSTEM', 'Error creating battle', error);
        res.status(500).json({ message: 'Error creating boss battle' });
    }
});

// @route   POST /api/gamification/boss-battle/:battleId/submit
// @desc    Submit answers for a boss battle
router.post('/boss-battle/:battleId/submit', async (req, res) => {
    try {
        const { answers } = req.body;

        // log.info('SYSTEM', `Boss battle submission received for ${req.params.battleId}`);

        if (!answers) {
            log.warn('SYSTEM', 'No answers provided for boss battle');
            return res.status(400).json({ message: 'Answers are required. Please provide an answers array.' });
        }

        if (!Array.isArray(answers)) {
            log.warn('SYSTEM', `Invalid answers format: ${typeof answers}`);
            return res.status(400).json({ message: `Answers must be an array, received: ${typeof answers}` });
        }

        if (answers.length === 0) {
            log.warn('SYSTEM', 'Empty answers array provided');
            return res.status(400).json({ message: 'Answers array cannot be empty' });
        }

        log.info('SYSTEM', `Submitting boss battle ${req.params.battleId} (${answers.length} answers)`);

        const result = await bossBattleService.submitBattle(
            req.params.battleId,
            req.user._id,
            answers
        );

        log.success('SYSTEM', `Battle result: ${result.status}, Score: ${result.score}%`);

        res.json({
            success: true,
            ...result,
            message: result.status === 'completed'
                ? `Victory! You scored ${result.score}% and earned ${result.earnedLearningCredits} Learning Credits!${result.leveledUp ? ' You leveled up!' : ''}`
                : `Battle failed with ${result.score}%. Review the revision plan and try again!`
        });

    } catch (error) {
        log.error('SYSTEM', 'Error submitting battle', error);
        res.status(400).json({ message: error.message || 'Error submitting battle' });
    }
});

// ===== Badges System =====

// @route   GET /api/gamification/badges
// @desc    Get all user's earned badges
router.get('/badges', async (req, res) => {
    try {
        const badges = await badgeService.getUserBadges(req.user._id);
        res.json({ badges });

    } catch (error) {
        log.error('SYSTEM', 'Error fetching badges', error);
        res.status(500).json({ message: 'Error fetching badges' });
    }
});

// @route   GET /api/gamification/badges/all
// @desc    Get all available badges (for showcase)
router.get('/badges/all', async (req, res) => {
    try {
        const allBadges = badgeService.getAllBadges();
        const userBadges = await badgeService.getUserBadges(req.user._id);
        const earnedIds = userBadges.map(b => b.badgeId);

        // Mark which badges are earned
        const badges = allBadges.map(badge => ({
            ...badge,
            earned: earnedIds.includes(badge.badgeId),
            earnedAt: userBadges.find(b => b.badgeId === badge.badgeId)?.earnedAt || null
        }));

        res.json({ badges });

    } catch (error) {
        log.error('SYSTEM', 'Error fetching all badges', error);
        res.status(500).json({ message: 'Error fetching badge catalog' });
    }
});

// @route   POST /api/gamification/check-badges
// @desc    Manual trigger to check and award new badges
router.post('/check-badges', async (req, res) => {
    try {
        const newBadges = await badgeService.checkAndAwardBadges(req.user._id);

        res.json({
            newBadges,
            count: newBadges.length,
            message: newBadges.length > 0 ? `Earned ${newBadges.length} new badges!` : 'No new badges'
        });

    } catch (error) {
        log.error('SYSTEM', 'Error checking badges', error);
        res.status(500).json({ message: 'Error checking badges' });
    }
});

// ===== Skill Tree Visual Map =====

// @route   GET /api/gamification/skill-tree-map
// @desc    Get skill tree with all connections for visualization (fog-of-war map)
router.get('/skill-tree-map', async (req, res) => {
    try {
        const skillTree = await skillTreeService.getUserSkillTree(req.user._id);

        // Build connection map for edges
        const connections = [];
        skillTree.forEach(skill => {
            if (skill.prerequisites && skill.prerequisites.length > 0) {
                skill.prerequisites.forEach(prereqId => {
                    connections.push({
                        from: prereqId,
                        to: skill.skillId,
                        type: skill.status === 'locked' ? 'blocked' : 'active'
                    });
                });
            }
        });

        res.json({
            skills: skillTree,
            connections,
            mapMetadata: {
                totalSkills: skillTree.length,
                unlockedCount: skillTree.filter(s => s.status !== 'locked').length,
                masteredCount: skillTree.filter(s => s.status === 'mastered').length
            }
        });

    } catch (error) {
        log.error('SYSTEM', 'Error fetching skill tree map', error);
        res.status(500).json({ message: 'Error fetching skill tree map' });
    }
});

// @route   GET /api/gamification/skill/:skillId/details
// @desc    Get detailed information about a specific skill
router.get('/skill/:skillId/details', async (req, res) => {
    try {
        const { skillId } = req.params;
        const SkillTree = require('../models/SkillTree');

        const skill = await SkillTree.findOne({ skillId, isActive: true });
        if (!skill) {
            return res.status(404).json({ message: 'Skill not found' });
        }

        const unlockStatus = await skillTreeService.isSkillUnlocked(req.user._id, skillId);
        const profile = await require('../models/GamificationProfile').findOne({ userId: req.user._id });
        const mastery = profile ? profile.skillMastery.get(skillId) || 0 : 0;

        res.json({
            skill: {
                ...skill.toObject(),
                unlocked: unlockStatus.unlocked,
                mastery,
                blockedBy: unlockStatus.blockedBy,
                masteryThreshold: skill.masteryThreshold
            }
        });

    } catch (error) {
        log.error('SYSTEM', 'Error fetching skill details', error);
        res.status(500).json({ message: 'Error fetching skill details' });
    }
});

// @route   GET /api/gamification/skill/:skillId/unlock-path
// @desc    Get the path of skills needed to unlock a locked skill
router.get('/skill/:skillId/unlock-path', async (req, res) => {
    try {
        const { skillId } = req.params;
        const SkillTree = require('../models/SkillTree');
        const userId = req.user._id;

        const skill = await SkillTree.findOne({ skillId, isActive: true });
        if (!skill) {
            return res.status(404).json({ message: 'Skill not found' });
        }

        const unlockStatus = await skillTreeService.isSkillUnlocked(userId, skillId);

        if (unlockStatus.unlocked) {
            return res.json({
                unlocked: true,
                path: []
            });
        }

        // Build unlock path
        const path = [];
        const visited = new Set();

        async function buildPath(currentSkillId) {
            if (visited.has(currentSkillId)) return;
            visited.add(currentSkillId);

            const current = await SkillTree.findOne({ skillId: currentSkillId });
            if (!current) return;

            const currentUnlock = await skillTreeService.isSkillUnlocked(userId, currentSkillId);

            path.push({
                skillId: currentSkillId,
                name: current.name,
                unlocked: currentUnlock.unlocked,
                mastery: currentUnlock.masteryPercentage || 0,
                required: current.masteryThreshold
            });

            if (current.prerequisites) {
                for (const prereqId of current.prerequisites) {
                    await buildPath(prereqId);
                }
            }
        }

        await buildPath(skillId);

        res.json({
            unlocked: false,
            path: path.reverse()
        });

    } catch (error) {
        log.error('SYSTEM', 'Error fetching unlock path', error);
        res.status(500).json({ message: 'Error fetching unlock path' });
    }
});

// @route   POST /api/gamification/skill/:skillId/checkpoint
// @desc    Mark a checkpoint achievement for a skill
router.post('/skill/:skillId/checkpoint', async (req, res) => {
    try {
        const { skillId } = req.params;
        const { checkpointType, data } = req.body; // checkpointType: 'assessment', 'reading', 'practice'

        const userId = req.user._id;
        const profile = await require('../models/GamificationProfile').findOne({ userId });

        if (!profile) {
            return res.status(404).json({ message: 'Profile not found' });
        }

        // Log the checkpoint achievement
        const checkpoint = {
            skillId,
            checkpointType,
            achievedAt: new Date(),
            data
        };

        // Could extend profile with checkpoint tracking
        log.info('SYSTEM', `Checkpoint recorded for ${skillId}: ${checkpointType}`);

        res.json({
            message: 'Checkpoint recorded',
            checkpoint
        });

    } catch (error) {
        log.error('SYSTEM', 'Error recording checkpoint', error);
        res.status(500).json({ message: 'Error recording checkpoint' });
    }
});

module.exports = router;

