/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Daily Maintenance Jobs Runner
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * SCOPE: User-facing daily analytics only.
 *        Course pipeline (PDF→Qdrant, STN, skill tree) and model retraining
 *        are handled exclusively by `npm run offlinejobs`.
 *
 * RUNS DURING DAILY MAINTENANCE:
 *   1. User Analytics
 *      - Chat evaluations (XP scoring based on Bloom's taxonomy)
 *      - User KG creation/updates (separate from course KG)
 *      - Session analysis
 *      - Contextual memory updates
 *
 *   2. Skill Tree Question Generation
 *      - Generate new questions across all Bloom's levels (Remember→Create)
 *      - Spread across hardness levels (easy, medium, hard)
 *      - Non-duplicated QA pairs via semantic similarity check
 *      - Ensure retry questions differ from original attempts
 *
 * EXECUTION: Single command `node scripts/maintenanceJobs.js`
 * ═══════════════════════════════════════════════════════════════════════════
 */

const dotenv = require('dotenv');
const path = require('path');
const axios = require('axios');
const mongoose = require('mongoose');

dotenv.config({ path: path.join(__dirname, '../.env') });

const log = require('../utils/logger');
const connectDB = require('../config/db');

// Lazy-load heavy services
const getChatHistory = () => require('../models/ChatHistory');
const getUser = () => require('../models/User');
const getSkillTree = () => require('../models/SkillTree');
const getSkillTreeGame = () => require('../models/SkillTreeGame');
const getKgService = () => require('../services/kgExtractionService');
const getCuesService = () => require('../services/criticalThinkingService');
const getMemory = () => require('../middleware/contextualMemoryMiddleware');
const getXpEval = () => require('../services/advancedXPEvaluator');
const getBloomScoring = () => require('../services/bloomScoringService');
const semanticSimilarity = require('../services/semanticSimilarityService');

const BATCH_SIZE = parseInt(process.env.MAINTENANCE_BATCH_SIZE || '20', 10);
const LOOKBACK_HRS = parseInt(process.env.MAINTENANCE_LOOKBACK_HRS || '24', 10);

// ═══════════════════════════════════════════════════════════════════════════
// 1. USER ANALYTICS (Chat Evaluations + User KG + XP Scoring)
// ═══════════════════════════════════════════════════════════════════════════

async function processUserSession(session, llmConfig) {
    const { sessionId, userId, messages = [] } = session;
    const sessionTag = `session=${sessionId.slice(0, 8)} user=${userId.toString().slice(0, 8)}`;
    let kgCount = 0, cueCount = 0, xpAwarded = 0;

    try {
        const aiMessages = messages.filter(m =>
            (m.role === 'model' || m.sender === 'bot') && m.parts?.[0]?.text
        );

        if (!aiMessages.length) return { sessionId, kgCount: 0, cueCount: 0, xpAwarded: 0 };

        const { extractAndStoreKgFromText } = getKgService();
        const { generateCues } = getCuesService();
        const { triggerPeriodicAnalysis } = getMemory();
        const advancedXPEvaluator = getXpEval();
        const bloomScoring = getBloomScoring();

        // Extract USER KG from AI messages (separate from course KG)
        for (const msg of aiMessages) {
            const text = msg.parts[0].text;
            try {
                // User KG extraction (not course KG - different graph)
                await extractAndStoreKgFromText(text, sessionId, userId, llmConfig, 'user');
                kgCount++;
            } catch (e) {
                log.warn('MAINTENANCE', `${sessionTag} User KG extraction failed: ${e.message}`);
            }
        }

        // Generate critical thinking cues for last AI message
        const lastAiText = aiMessages[aiMessages.length - 1]?.parts?.[0]?.text;
        if (lastAiText) {
            try {
                await generateCues(lastAiText, llmConfig);
                cueCount++;
            } catch (e) {
                log.warn('MAINTENANCE', `${sessionTag} generateCues failed: ${e.message}`);
            }
        }

        // Session contextual memory analysis
        try {
            await triggerPeriodicAnalysis(sessionId, userId, messages.length, llmConfig);
        } catch (e) {
            log.warn('MAINTENANCE', `${sessionTag} triggerPeriodicAnalysis failed: ${e.message}`);
        }

        // XP scoring based on Bloom's taxonomy (follow-up questions only)
        const userMessages = messages.filter(m => m.role === 'user' && m.parts?.[0]?.text);
        
        // Skip first message (initial question), score follow-ups
        for (let i = 1; i < userMessages.length; i++) {
            const followUpMsg = userMessages[i];
            const correspondingAiMsg = aiMessages[i - 1];
            
            if (followUpMsg && correspondingAiMsg) {
                try {
                    const evaluation = await advancedXPEvaluator.evaluateMessageQuality(
                        followUpMsg.parts[0].text,
                        correspondingAiMsg.parts[0].text,
                        { 
                            userId, 
                            sessionId,
                            isFollowUp: true,  // Important: marks as follow-up for Bloom's scoring
                            topic: session.currentCourse || 'general'
                        }
                    );
                    
                    // Award XP based on Bloom's level + novelty check against user KG
                    const bloomLevel = evaluation.bloomsTaxonomyLevel || 1;
                    const novelty = await checkNoveltyAgainstUserKG(userId, followUpMsg.parts[0].text);
                    
                    if (novelty > 0.5) { // Only award for non-repetitive questions
                        const xp = bloomLevel * 10 * novelty; // Higher Bloom's level = more XP
                        xpAwarded += xp;
                        
                        await bloomScoring.recordBloomScore(userId, bloomLevel, followUpMsg.parts[0].text);
                    }
                } catch (e) {
                    log.warn('MAINTENANCE', `${sessionTag} XP evaluation failed: ${e.message}`);
                }
            }
        }

        log.info('MAINTENANCE', `${sessionTag} — userKG=${kgCount} cues=${cueCount} xp=${Math.round(xpAwarded)} ✓`);
        return { sessionId, kgCount, cueCount, xpAwarded };

    } catch (err) {
        log.error('MAINTENANCE', `${sessionTag} processing error: ${err.message}`);
        return { sessionId, kgCount: 0, cueCount: 0, xpAwarded: 0, error: err.message };
    }
}

async function checkNoveltyAgainstUserKG(userId, questionText) {
    // Use semantic similarity service to check novelty against user's personal KG
    try {
        const noveltyScore = await semanticSimilarity.checkNoveltyAgainstUserKG(userId, questionText);
        return noveltyScore;
    } catch (error) {
        log.warn('MAINTENANCE', `Novelty check failed for user ${userId}: ${error.message}`);
        return 1.0; // Default to novel on error
    }
}

async function runUserAnalytics() {
    console.log('\n═══ 👥 USER ANALYTICS (Chat Eval + User KG + XP) ═══');
    const startTime = Date.now();
    
    const llmConfig = {
        provider: process.env.SGLANG_ENABLED === 'true' ? 'sglang' : 'ollama',
        model: process.env.SGLANG_ENABLED === 'true'
            ? (process.env.SGLANG_HEAVY_MODEL || 'Qwen/Qwen2.5-7B-Instruct-AWQ')
            : (process.env.OLLAMA_DEFAULT_MODEL || 'qwen2.5:3b'),
        temperature: 0.3,
        maxTokens: 2048,
    };

    const since = new Date(Date.now() - LOOKBACK_HRS * 60 * 60 * 1000);
    let totalSessions = 0, processed = 0, errors = 0, totalXP = 0;

    try {
        const ChatHistory = getChatHistory();
        const cursor = ChatHistory.find({ updatedAt: { $gte: since } })
            .select('sessionId userId messages currentCourse')
            .lean()
            .cursor();

        let batch = [];

        for await (const session of cursor) {
            batch.push(session);
            totalSessions++;

            if (batch.length >= BATCH_SIZE) {
                const results = await Promise.allSettled(
                    batch.map(s => processUserSession(s, llmConfig))
                );
                results.forEach(r => {
                    if (r.status === 'fulfilled') { 
                        processed++; 
                        totalXP += r.value.xpAwarded || 0;
                    } else { 
                        errors++; 
                    }
                });
                batch = [];
            }
        }

        // Process remaining batch
        if (batch.length) {
            const results = await Promise.allSettled(
                batch.map(s => processUserSession(s, llmConfig))
            );
            results.forEach(r => {
                if (r.status === 'fulfilled') { 
                    processed++; 
                    totalXP += r.value.xpAwarded || 0;
                } else { 
                    errors++; 
                }
            });
        }

    } catch (err) {
        log.error('MAINTENANCE', `User analytics batch error: ${err.message}`);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`✅ User analytics complete in ${elapsed}s — sessions=${totalSessions} processed=${processed} errors=${errors} totalXP=${Math.round(totalXP)}`);
    
    return { status: 'success', totalSessions, processed, errors, totalXP, elapsed };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. SKILL TREE QUESTION GENERATION (Bloom's Taxonomy + Hardness Levels)
// ═══════════════════════════════════════════════════════════════════════════

const BLOOMS_LEVELS = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'];
const HARDNESS_LEVELS = ['easy', 'medium', 'hard'];

async function generateSkillTreeQuestions() {
    console.log('\n═══ 🌳 SKILL TREE QUESTION GENERATION ═══');
    const startTime = Date.now();
    
    try {
        const SkillTree = getSkillTree();
        const skills = await SkillTree.find({ isActive: true });
        
        let totalGenerated = 0;
        
        for (const skill of skills) {
            const existingQuestions = skill.assessmentQuestions || [];
            const existingQuestionsSet = new Set(existingQuestions.map(q => q.question.toLowerCase()));
            
            // Generate questions across all Bloom's levels and hardness levels
            for (const bloomLevel of BLOOMS_LEVELS) {
                for (const hardness of HARDNESS_LEVELS) {
                    const needed = 3; // Generate 3 questions per (Bloom's level, hardness) combination
                    
                    for (let i = 0; i < needed; i++) {
                        try {
                            const question = await generateUniqueQuestion(
                                skill, 
                                bloomLevel, 
                                hardness, 
                                existingQuestionsSet
                            );
                            
                            if (question) {
                                skill.assessmentQuestions.push(question);
                                existingQuestionsSet.add(question.question.toLowerCase());
                                totalGenerated++;
                            }
                        } catch (e) {
                            log.warn('MAINTENANCE', `Question generation failed for ${skill.skillId}: ${e.message}`);
                        }
                    }
                }
            }
            
            await skill.save();
        }
        
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`✅ Skill tree questions generated in ${elapsed}s — total=${totalGenerated}`);
        
        return { status: 'success', totalGenerated, elapsed };
    } catch (error) {
        log.error('MAINTENANCE', `Skill tree question generation failed: ${error.message}`);
        return { status: 'error', message: error.message };
    }
}

async function generateUniqueQuestion(skill, bloomLevel, hardness, existingQuestions) {
    // Call LLM to generate question based on skill, Bloom's level, and hardness
    // This should use SGLang or Ollama with a specific prompt
    
    const prompt = `Generate a ${hardness} difficulty question for the skill "${skill.name}" at Bloom's taxonomy level "${bloomLevel}".

Skill Description: ${skill.description}
Category: ${skill.category}

Requirements:
- Question must be at "${bloomLevel}" cognitive level (${getBloomDescription(bloomLevel)})
- Difficulty: ${hardness}
- Format: Multiple choice with 4 options
- Include explanation for correct answer
- Must be different from existing questions

Output as JSON:
{
  "question": "...",
  "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
  "correctAnswer": "A",
  "explanation": "...",
  "bloomLevel": "${bloomLevel}",
  "difficulty": "${hardness}"
}`;

    try {
        // Try up to 3 times to generate a unique question
        const maxRetries = 3;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            // Use SGLang/Ollama to generate the question
            const pythonServiceUrl = process.env.PYTHON_RAG_SERVICE_URL || 'http://localhost:2001';
            const response = await axios.post(`${pythonServiceUrl}/generate/question`, {
                prompt,
                skill_id: skill.skillId,
                bloom_level: bloomLevel,
                hardness,
                attempt_number: attempt
            });
            
            const generated = response.data.question;
            
            // Check for exact string duplicates first (fast)
            if (existingQuestions.has(generated.question.toLowerCase())) {
                log.info('MAINTENANCE', `Exact duplicate detected on attempt ${attempt + 1}, retrying...`);
                continue;
            }
            
            // Check for semantic duplicates (more thorough)
            const existingQuestionsArray = Array.from(existingQuestions);
            const duplicateCheck = await semanticSimilarity.checkQuestionDuplicate(
                generated.question,
                existingQuestionsArray,
                0.85 // Stricter threshold for question generation
            );
            
            if (duplicateCheck.isDuplicate) {
                log.info('MAINTENANCE', `Semantic duplicate detected (sim=${duplicateCheck.similarity.toFixed(3)}) on attempt ${attempt + 1}, retrying...`);
                continue;
            }
            
            // Unique question found!
            return generated;
        }
        
        // Failed to generate unique question after retries
        log.warn('MAINTENANCE', `Could not generate unique question for ${skill.skillId} after ${maxRetries} attempts`);
        return null;
        
    } catch (error) {
        throw new Error(`Question generation API call failed: ${error.message}`);
    }
}

function getBloomDescription(level) {
    const descriptions = {
        'remember': 'recall facts and basic concepts',
        'understand': 'explain ideas or concepts',
        'apply': 'use information in new situations',
        'analyze': 'draw connections among ideas',
        'evaluate': 'justify a stand or decision',
        'create': 'produce new or original work'
    };
    return descriptions[level] || '';
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

async function runAllMaintenanceJobs() {
    const jobStart = Date.now();
    console.log('🔧 ═══════════════════════════════════════════════════════════════');
    console.log('🔧  DAILY MAINTENANCE - Starting User Analytics Jobs');
    console.log('🔧  (Course pipeline & model retraining → run `npm run offlinejobs`)');
    console.log('🔧 ═══════════════════════════════════════════════════════════════\n');

    const results = {};

    try {
        // 1. User Analytics (User KG, XP scoring, evaluations)
        results.userAnalytics = await runUserAnalytics();

        // 2. Skill Tree Question Generation
        results.skillTreeQuestions = await generateSkillTreeQuestions();

        const totalElapsed = Math.round((Date.now() - jobStart) / 1000);

        console.log('\n🔧 ═══════════════════════════════════════════════════════════════');
        console.log(`🔧  MAINTENANCE COMPLETE in ${totalElapsed}s`);
        console.log('🔧 ═══════════════════════════════════════════════════════════════');
        console.log('\n📊 Summary:');
        console.log(`   User Analytics: ${results.userAnalytics.status} (${results.userAnalytics.processed} sessions)`);
        console.log(`   Skill Tree Qs:  ${results.skillTreeQuestions.status} (${results.skillTreeQuestions.totalGenerated} generated)`);
        console.log('\n✅ Daily maintenance complete\n');

        return results;
    } catch (error) {
        console.error('\n❌ MAINTENANCE FAILED:', error.message);
        throw error;
    }
}

// CLI execution
if (require.main === module) {
    (async () => {
        try {
            if (!process.env.MONGO_URI) {
                console.error('❌ MONGO_URI not found in .env');
                process.exit(1);
            }
            
            await connectDB(process.env.MONGO_URI);
            console.log('✅ Connected to MongoDB\n');
            
            await runAllMaintenanceJobs();
            
            process.exit(0);
        } catch (error) {
            console.error('\n❌ Fatal error:', error);
            process.exit(1);
        }
    })();
}

module.exports = {
    runAllMaintenanceJobs,
    runUserAnalytics,
    generateSkillTreeQuestions,
};
