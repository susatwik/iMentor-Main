
const SkillTreeGame = require('../models/SkillTreeGame');
const GamificationProfile = require('../models/GamificationProfile');
const User = require('../models/User');
const { logger } = require('../utils/logger');
const geminiService = require('./geminiService');
const socraticTutorService = require('./socraticTutorService');
const { decrypt } = require('../utils/crypto');

/**
 * Get internal LLM config for a user
 */
async function getUserLLMConfig(userId) {
    const user = await User.findById(userId).select('+encryptedApiKey preferredLlmProvider ollamaModel ollamaUrl openaiApiKey claudeApiKey').lean();
    if (!user) return {};

    return {
        llmProvider: user.preferredLlmProvider || 'gemini',
        apiKey: user.encryptedApiKey ? decrypt(user.encryptedApiKey) : process.env.GEMINI_API_KEY,
        ollamaModel: user.ollamaModel,
        ollamaUrl: user.ollamaUrl,
        openaiApiKey: user.openaiApiKey,
        claudeApiKey: user.claudeApiKey
    };
}

/**
 * Generate levels for a specific topic using AI
 */
async function generateLevels(userId, topic, assessmentResult, answers) {
    try {
        const knowledgeLevel = assessmentResult?.level || 'Beginner';
        const llmConfig = await getUserLLMConfig(userId);

        const prompt = `
            You are a curriculum designer for a gamified learning platform "iMentor".
            Generate a comprehensive learning path for the topic: "${topic}".
            The user's current knowledge level is: "${knowledgeLevel}".
            
            Based on the assessment summary: "${assessmentResult?.summary || ''}"
            
            RULES:
            1. Generate exactly 25 levels.
            2. For a ${knowledgeLevel} learner, start with appropriate concepts.
            3. Each level MUST have:
               - id: sequential number starting from 1
               - name: concise, catchy level title
               - description: what will be learned (max 100 chars)
               - difficulty: "easy" (levels 1-8), "medium" (levels 9-16), "hard" (levels 17-24), or "boss" (level 25)
            
            RETURN ONLY A JSON ARRAY like this:
            [
              { "id": 1, "name": "Title", "description": "...", "difficulty": "easy", "status": "unlocked" },
              ...
            ]
            Important: The FIRST level (id: 1) should have status: "unlocked", all others "locked".
        `;

        let responseText = await socraticTutorService.generateWithFallback([], prompt, null, llmConfig, { maxOutputTokens: 300 }); // [Optimization] JSON level array

        let levels = [];
        try {
            // Clean markdown if present
            const jsonMatch = responseText.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                levels = JSON.parse(jsonMatch[0]);
            } else {
                levels = JSON.parse(responseText);
            }
        } catch (parseErr) {
            logger.error('[SkillTreeGameService] JSON Parse Error:', parseErr);
            throw new Error('Failed to generate valid levels JSON');
        }

        // Ensure IDs and status are correct
        levels = levels.map((l, i) => ({
            ...l,
            id: i + 1,
            status: i === 0 ? 'unlocked' : 'locked',
            stars: 0,
            score: 0,
            attempts: 0
        }));

        return levels;

    } catch (error) {
        logger.error('[SkillTreeGameService] Error generating levels:', error);
        throw error;
    }
}

const { queryPythonRagService } = require('./ragQueryService');

/**
 * Generate 5 questions for a specific level or topic using AI and RAG ground truth.
 * Supports studentInsights for personalization and seenQuestions for retry deduplication.
 * @param {string} userId
 * @param {string} topic
 * @param {string} levelName
 * @param {string} difficulty
 * @param {object|null} studentInsights
 * @param {string[]} seenQuestions - question texts already shown to this user for this level
 */
async function generateDynamicQuestions(userId, topic, levelName, difficulty, studentInsights = null, seenQuestions = []) {
    try {
        let ragContext = "";
        try {
            // Attempt to get RAG context for the topic to ground the questions
            const ragResult = await queryPythonRagService(
                `Key concepts and facts about ${topic}: ${levelName}`,
                null, // No specific doc context
                false, // Critical thinking not needed for Q generation base
                { userId: userId.toString() }, // Search user's own docs
                3 // Get top 3 snippets for grounding
            );
            ragContext = ragResult.toolOutput;
            logger.info(`[SkillTreeGameService] Retrieved RAG context for grounding: ${ragContext.substring(0, 100)}...`);
        } catch (ragError) {
            logger.warn(`[SkillTreeGameService] RAG grounding failed, proceeding with general knowledge: ${ragError.message}`);
        }

        // Prepare personalization context
        let personalizationContext = "";
        if (studentInsights) {
            personalizationContext = `
            STUDENT PERSONALIZATION DATA:
            - Known Weaknesses: ${studentInsights.weaknesses?.join(', ') || 'None identified'}
            - Detected Misconceptions: ${studentInsights.misconceptions?.map(m => m.description).join(', ') || 'None identified'}
            - Understanding Level: ${studentInsights.understandingLevel || 'learning'}
            
            INSTRUCTION: Design the questions to specifically target and correct these weaknesses and misconceptions.
            `;
        }

        const prompt = `
            You are the "iMentor" Assessment Engine.
            Topic: "${topic}"
            Sub-topic/Level: "${levelName}"
            Difficulty: "${difficulty}"
            
            ${ragContext ? `GROUND TRUTH CONTEXT from user's study materials:\n"${ragContext}"\n` : ""}
            
            ${personalizationContext}
            
            ${seenQuestions.length > 0 ? `PREVIOUSLY SHOWN QUESTIONS (DO NOT REPEAT or paraphrase these):\n${seenQuestions.slice(-15).map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\nIMPORTANT: Generate completely DIFFERENT questions that test different aspects of the topic.\n` : ''}
            
            TASK: Generate 5 multiple-choice questions.
            RULES:
            1. Each question must have 4 options.
            2. Provide exactly one correctIndex (0-3).
            3. Provide a helpful explanation for the correct answer.
            4. Tone should be encouraging and educational.
            ${ragContext ? "5. IMPORTANT: Ground the questions in the provided context if possible." : ""}
            ${difficulty === 'boss' ? "6. BOSS MODE: Make questions challenging, requiring synthesis of multiple concepts." : ""}
            7. If personalization data is provided, ensure questions address those specific gaps.
            8. Return ONLY a JSON object with a "questions" key.
            
            Example format:
            {
              "questions": [
                {
                  "question": "What is...?",
                  "options": ["A", "B", "C", "D"],
                  "correctIndex": 0,
                  "explanation": "..."
                }
              ]
            }
        `;

        const llmConfig = await getUserLLMConfig(userId);
        let responseText = await socraticTutorService.generateWithFallback([], prompt, null, llmConfig, { maxOutputTokens: 300 }); // [Optimization] JSON question set

        try {
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            const data = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
            return data.questions || [];
        } catch (parseErr) {
            logger.error('[SkillTreeGameService] Question JSON Parse Error:', parseErr);
            throw new Error('Failed to generate valid questions JSON');
        }

    } catch (error) {
        logger.error('[SkillTreeGameService] Error generating questions:', error);
        throw error;
    }
}

/**
 * Update level progress and award credits
 */
async function updateLevelProgress(userId, gameId, levelId, progressData) {
    try {
        const game = await SkillTreeGame.findOne({ _id: gameId, userId });
        if (!game) throw new Error('Game not found');

        const levelIndex = game.levels.findIndex(l => l.id === parseInt(levelId));
        if (levelIndex === -1) throw new Error('Level not found');

        const level = game.levels[levelIndex];
        const isFirstCompletion = level.status !== 'completed' && progressData.status === 'completed';

        // Update level stats
        level.stars = Math.max(level.stars || 0, progressData.stars || 0);
        level.score = Math.max(level.score || 0, progressData.score || 0);
        level.status = progressData.status || level.status;
        level.completedAt = progressData.status === 'completed' ? new Date() : level.completedAt;
        level.attempts = (level.attempts || 0) + 1;

        // Unlock next level if completed
        if (progressData.status === 'completed' && levelIndex < game.levels.length - 1) {
            const nextLevel = game.levels[levelIndex + 1];
            if (nextLevel.status === 'locked') {
                nextLevel.status = 'unlocked';
            }
        }

        await game.save();

        let creditsEarned = 0;
        if (isFirstCompletion && progressData.stars > 0) {
            creditsEarned = progressData.stars === 3 ? 10 : progressData.stars === 2 ? 8 : 5;
            await awardLearningCredits(userId, creditsEarned, 'application', game.topic);
        }

        return {
            success: true,
            learningCreditsEarned: creditsEarned,
            game
        };

    } catch (error) {
        logger.error('[SkillTreeGameService] Error updating progress:', error);
        throw error;
    }
}

/**
 * Helper to award Learning Credits to GamificationProfile
 */
async function awardLearningCredits(userId, amount, reason, topic) {
    try {
        let profile = await GamificationProfile.findOne({ userId });
        if (!profile) {
            profile = new GamificationProfile({ userId });
        }

        profile.totalLearningCredits += amount;
        profile.learningCreditsHistory.push({
            amount,
            reason: reason || 'skill_tree_completion',
            topic,
            timestamp: new Date()
        });

        await profile.save();
        logger.info(`[SkillTreeGameService] Awarded ${amount} credits to user ${userId} for ${topic}`);
    } catch (error) {
        logger.error('[SkillTreeGameService] Error awarding credits:', error);
    }
}

/**
 * Generate a diagnostic quiz for a topic
 */
async function getDiagnosticQuiz(topic, userId) {
    try {
        const llmConfig = await getUserLLMConfig(userId);
        const prompt = `
            You are "iMentor" Diagnostic Assistant.
            Generate 5 open-ended, conceptual questions to assess a student's knowledge of the topic: "${topic}".
            
            RULES:
            1. Questions should range from basic to advanced.
            2. Questions must be open-ended (no multiple choice).
            3. Return ONLY a JSON object with a "questions" key containing an array of strings.
            
            Example:
            {
              "questions": [
                "What is the core purpose of...?",
                "How would you explain the relationship between...?",
                ...
              ]
            }
        `;

        const responseText = await socraticTutorService.generateWithFallback([], prompt, null, llmConfig, { maxOutputTokens: 300 }); // [Optimization] Diagnostic quiz JSON
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        const data = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);

        return {
            questions: (data.questions || []).map(q => ({ question: q }))
        };

    } catch (error) {
        logger.error('[SkillTreeGameService] Error generating diagnostic quiz:', error);
        throw error;
    }
}

/**
 * Evaluate diagnostic quiz answers to determine starting level
 */
async function evaluateDiagnosticQuiz(topic, answers, userId) {
    try {
        const llmConfig = await getUserLLMConfig(userId);
        const prompt = `
            You are "iMentor" Knowledge Assessor.
            Analyze these student answers for the topic: "${topic}".
            
            ANSWERS:
            ${answers.map((a, i) => `Q${i + 1}: ${a.question}\nA${i + 1}: ${a.answer}`).join('\n\n')}
            
            TASK: Determine the user's starting level (Beginner, Intermediate, or Advanced).
            Provide a short summary of their knowledge state.
            
            RULES:
            1. level: MUST be "Beginner", "Intermediate", or "Advanced".
            2. summary: A 2-sentence summary of what they know and what they should focus on.
            3. recommendedStartingPoint: A suggested module or topic to start with.
            4. Return ONLY a JSON object.
            
            Example:
            {
              "level": "Intermediate",
              "summary": "The user has a solid grasp of basic syntax but struggles with concurrency patterns.",
              "recommendedStartingPoint": "Advanced Control Flow",
              "strengths": ["Syntax", "Modularization"],
              "improvements": ["Async Patterns"]
            }
        `;

        const responseText = await socraticTutorService.generateWithFallback([], prompt, null, llmConfig, { maxOutputTokens: 300 }); // [Optimization] Evaluation JSON
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        return JSON.parse(jsonMatch ? jsonMatch[0] : responseText);

    } catch (error) {
        logger.error('[SkillTreeGameService] Error evaluating diagnostic quiz:', error);
        return {
            level: 'Beginner',
            summary: 'Starting fresh on this topic!',
            recommendedStartingPoint: 'Basics'
        };
    }
}

module.exports = {
    generateLevels,
    generateDynamicQuestions,
    updateLevelProgress,
    awardLearningCredits,
    getDiagnosticQuiz,
    evaluateDiagnosticQuiz
};