// server/routes/admin.js
const express = require('express');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const AdminDocument = require('../models/AdminDocument');
const axios = require('axios');
const User = require('../models/User');
const ChatHistory = require('../models/ChatHistory');
const { cacheMiddleware } = require('../middleware/cacheMiddleware');
const { redisClient } = require('../config/redisClient');
const LLMConfiguration = require('../models/LLMConfiguration');
const UserFeedback = require('../models/UserFeedback');
const { encrypt } = require('../utils/crypto');
const log = require('../utils/logger');
const { auditLog } = require('../utils/logger');
const LLMPerformanceLog = require('../models/LLMPerformanceLog');
const CourseAdapterMapping = require('../models/CourseAdapterMapping');
const StudentKnowledgeState = require('../models/StudentKnowledgeState');
const TutorSession = require('../models/TutorSession');
const SkillTreeGame = require('../models/SkillTreeGame');
const GamificationProfile = require('../models/GamificationProfile');
const { safeCascadeDeleteCourse } = require('../services/courseCascadeDeletionService');

const router = express.Router();

// @route   GET /api/admin/system-performance
// @desc    Dynamic GPU/LLM health — pulls live data from nvidia-smi + SGLang
router.get('/system-performance', async (req, res) => {
  try {
    // ── 1. nvidia-smi live GPU metrics
    let gpuData = { name: 'Unknown', memTotal: 0, memUsed: 0, memFree: 0, utilGpu: 0, utilMem: 0 };
    try {
      const { stdout } = await execAsync(
        'nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,utilization.memory --format=csv,noheader,nounits'
      );
      const parts = stdout.trim().split(',').map(s => s.trim());
      gpuData = {
        name: parts[0],
        memTotal: parseInt(parts[1], 10),
        memUsed:  parseInt(parts[2], 10),
        memFree:  parseInt(parts[3], 10),
        utilGpu:  parseInt(parts[4], 10),
        utilMem:  parseInt(parts[5], 10),
      };
    } catch (e) { log.warn('SYSTEM', 'nvidia-smi unavailable: ' + e.message); }

    // ── 2. SGLang live server info (last_gen_throughput + memory_usage)
    const SGLANG_URL = process.env.SGLANG_CHAT_URL
      ? process.env.SGLANG_CHAT_URL.replace('/v1', '')
      : 'http://localhost:8000';

    let sglang = { status: 'unknown', model: 'unknown', contextLength: 0, quantization: 'unknown',
                   maxRunningRequests: 0, actualTokPerSec: null, memWeight: 0, memKvcache: 0,
                   memGraph: 0, tokenCapacity: 0, maxTotalTokens: 0 };
    try {
      const sgResp = await axios.get(`${SGLANG_URL}/get_server_info`, { timeout: 3000 });
      const info = sgResp.data;
      const state = (info.internal_states || [])[0] || {};
      sglang = {
        status: info.status || 'unknown',
        version: info.version,
        model: info.served_model_name || state.model_path || 'unknown',
        contextLength: info.context_length || state.context_length || 0,
        quantization: state.quantization || 'unknown',
        maxRunningRequests: state.max_running_requests || 0,
        actualTokPerSec: state.last_gen_throughput != null ? parseFloat(state.last_gen_throughput.toFixed(2)) : null,
        memWeight:    state.memory_usage ? state.memory_usage.weight   : 0,
        memKvcache:   state.memory_usage ? state.memory_usage.kvcache  : 0,
        memGraph:     state.memory_usage ? state.memory_usage.graph    : 0,
        tokenCapacity: info.max_total_num_tokens || state.memory_usage?.token_capacity || 0,
      };
    } catch (e) { log.warn('SYSTEM', 'SGLang unreachable: ' + e.message); }

    // ── 3. Recent chat logs
    const recentChats = await LLMPerformanceLog.find({}).sort({ createdAt: -1 }).limit(50);
    const latencies = recentChats.map(c => c.latency || c.responseTime || 0).filter(l => l > 0);
    const avgLatency = latencies.length ? Math.round(latencies.reduce((a,b) => a+b) / latencies.length) : 0;
    const maxLatency = latencies.length ? Math.max(...latencies) : 0;
    const minLatency = latencies.length ? Math.min(...latencies) : 0;

    // ── 4. Derived metrics
    // RTX A4000 memory bandwidth: 448 GB/s; model weights ~3.5 GB at 4-bit
    const MEM_BW_GBs = 448;
    const WEIGHT_GB = sglang.memWeight > 0 ? sglang.memWeight : 3.5;
    const theoreticalMax = Math.round(MEM_BW_GBs / WEIGHT_GB);
    const actualTok = sglang.actualTokPerSec;
    const efficiency = actualTok != null ? ((actualTok / theoreticalMax) * 100).toFixed(1) : null;
    const memUsedGb  = (gpuData.memUsed / 1024).toFixed(1);
    const memTotalGb = (gpuData.memTotal / 1024).toFixed(1);
    const memPct = gpuData.memTotal > 0 ? Math.round((gpuData.memUsed / gpuData.memTotal) * 100) : 0;

    // ── 5. Dynamic issue detection
    const issues = [];
    if (actualTok != null && actualTok < theoreticalMax * 0.3) {
      const effPct = parseFloat(efficiency);
      const idlePct = (100 - effPct).toFixed(0);
      issues.push({
        severity: 'CRITICAL',
        component: 'GPU Token Generation',
        issue: `Low throughput: ${actualTok} tok/s actual vs ${theoreticalMax} tok/s theoretical (${efficiency}% efficiency, ${idlePct}% GPU idle)`,
        rootCause: 'AWQ dequantization kernels on Ampere (A4000) do not saturate memory bandwidth at batch=1',
        recommendation: 'Enable speculative decoding (EAGLE + 1.5B draft) or switch to Qwen2.5-3B-AWQ for 2× speedup',
      });
    }
    if (memPct >= 95) {
      issues.push({
        severity: 'HIGH',
        component: 'GPU Memory',
        issue: `GPU VRAM near capacity: ${memUsedGb} GB / ${memTotalGb} GB (${memPct}% used)`,
        rootCause: 'Large KV cache + model weights filling available VRAM',
        recommendation: 'Reduce context length or enable CPU offload',
      });
    }
    if (sglang.status !== 'ready') {
      issues.push({
        severity: 'HIGH',
        component: 'SGLang Server',
        issue: `SGLang server status: ${sglang.status}`,
        rootCause: 'Server not in ready state',
        recommendation: 'Check SGLang container logs: docker logs chatbot-sglang',
      });
    }

    // ── 6. Overall health
    const healthStatus = issues.some(i => i.severity === 'CRITICAL') ? 'critical'
                       : issues.some(i => i.severity === 'HIGH')     ? 'warning'
                       : issues.length > 0                           ? 'degraded'
                       : 'healthy';

    res.json({
      timestamp: new Date().toISOString(),
      healthStatus,
      gpu: {
        name:              gpuData.name,
        memoryBandwidth:   '448 GB/s',
        memUsedMb:         gpuData.memUsed,
        memTotalMb:        gpuData.memTotal,
        memFreeMb:         gpuData.memFree,
        memUsedGb,
        memTotalGb,
        memUsedPercent:    memPct,
        gpuUtilPercent:    gpuData.utilGpu,
        memUtilPercent:    gpuData.utilMem,
      },
      llm: {
        status:            sglang.status,
        model:             sglang.model,
        contextLength:     sglang.contextLength,
        quantization:      sglang.quantization,
        maxRunningRequests: sglang.maxRunningRequests,
        tokenCapacity:     sglang.tokenCapacity,
        throughput: {
          actualTokPerSec:      actualTok,
          theoreticalMaxTokPerSec: theoreticalMax,
          efficiencyPercent:    efficiency,
        },
        vramBreakdown: {
          weightGb:   sglang.memWeight,
          kvcacheGb:  sglang.memKvcache,
          graphGb:    sglang.memGraph,
          totalAllocGb: parseFloat((sglang.memWeight + sglang.memKvcache + sglang.memGraph).toFixed(2)),
        },
      },
      performance: {
        recentChatsAnalyzed: recentChats.length,
        avgResponseLatencyMs: avgLatency,
        minResponseLatencyMs: minLatency,
        maxResponseLatencyMs: maxLatency,
      },
      issues,
    });
  } catch (error) {
    log.error('SYSTEM', `Failed to fetch system performance: ${error.message}`);
    res.status(500).json({ message: 'Server error while fetching system performance.' });
  }
});

/* ====== Model feedback routes ======= */

// @route   GET /api/admin/feedback-stats
// @desc    Get aggregated feedback stats for each model
router.get('/feedback-stats', async (req, res) => {
  try {
    const stats = await LLMPerformanceLog.aggregate([
      {
        $group: {
          _id: '$chosenModelId', // Group by the model's ID
          positive: { $sum: { $cond: [{ $eq: ['$userFeedback', 'positive'] }, 1, 0] } },
          negative: { $sum: { $cond: [{ $eq: ['$userFeedback', 'negative'] }, 1, 0] } },
          none: { $sum: { $cond: [{ $eq: ['$userFeedback', 'none'] }, 1, 0] } },
          total: { $sum: 1 }
        }
      },
      {
        $project: { // Reshape the output
          modelId: '$_id',
          feedback: {
            positive: '$positive',
            negative: '$negative',
            none: '$none'
          },
          totalResponses: '$total',
          _id: 0
        }
      }
    ]);
    res.json(stats);
  } catch (error) {
    log.error('SYSTEM', `Failed to fetch feedback stats: ${error.message}`);
    res.status(500).json({ message: 'Server error while fetching feedback stats.' });
  }
});
/* ====== END Model feedback routes ===== */

/* ====== LLM Management Routes ====== */

// GET /api/admin/llms - List all LLM configurations
router.get('/llms', async (req, res) => {
  try {
    const configs = await LLMConfiguration.find();
    res.json(configs);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch LLM configurations.' });
  }
});

// POST /api/admin/llms - Create a new LLM configuration
router.post('/llms', async (req, res) => {
  try {
    const newConfig = new LLMConfiguration(req.body);
    await newConfig.save();
    res.status(201).json(newConfig);
  } catch (error) {
    res.status(400).json({ message: 'Failed to create LLM configuration.', error: error.message });
  }
});

// PUT /api/admin/llms/:id - Update an LLM configuration
router.put('/llms/:id', async (req, res) => {
  try {
    const updatedConfig = await LLMConfiguration.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!updatedConfig) return res.status(404).json({ message: 'LLM configuration not found.' });
    res.json(updatedConfig);
  } catch (error) {
    res.status(400).json({ message: 'Failed to update LLM configuration.', error: error.message });
  }
});

// DELETE /api/admin/llms/:id - Delete an LLM configuration
router.delete('/llms/:id', async (req, res) => {
  try {
    const deletedConfig = await LLMConfiguration.findByIdAndDelete(req.params.id);
    if (!deletedConfig) return res.status(404).json({ message: 'LLM configuration not found.' });
    res.json({ message: 'LLM configuration deleted successfully.' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to delete LLM configuration.' });
  }
});


/* ====== END LLM Managemet Routes =====  */

const CACHE_DURATION_SECONDS = 30;
// --- NEW Dashboard Stats Route ---
// @route   GET /api/admin/dashboard-stats
// @desc    Get key statistics for the admin dashboard
router.get('/dashboard-stats', cacheMiddleware(CACHE_DURATION_SECONDS), async (req, res) => {
  try {
    const yesterday    = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      totalAdminDocs,
      totalSessions,
      pendingApiKeys,
      activeSessions,
      totalMessages,
      tutorModeSessions,
      activeUsersToday,
      newUsersLast7Days,
    ] = await Promise.all([
      User.countDocuments(),
      AdminDocument.countDocuments(),
      ChatHistory.countDocuments(),
      User.countDocuments({ apiKeyRequestStatus: 'pending' }),
      ChatHistory.countDocuments({ 'messages.0': { $exists: true } }),
      ChatHistory.aggregate([
        { $match: { 'messages.0': { $exists: true } } },
        { $project: { c: { $size: '$messages' } } },
        { $group: { _id: null, total: { $sum: '$c' } } }
      ]).then(r => r[0]?.total || 0),
      ChatHistory.countDocuments({ isTutorMode: true }),
      ChatHistory.distinct('userId', { updatedAt: { $gte: yesterday } }).then(ids => ids.length),
      User.countDocuments({ createdAt: { $gte: sevenDaysAgo } }),
    ]);

    res.json({
      totalUsers,
      totalAdminDocs,
      totalSessions,
      pendingApiKeys,
      activeSessions,
      totalMessages,
      tutorModeSessions,
      activeUsersToday,
      newUsersLast7Days,
    });
  } catch (error) {
    log.error('SYSTEM', `Failed to fetch dashboard stats: ${error.message}`);
    res.status(500).json({ message: 'Server error while fetching dashboard stats.' });
  }
});

// @route   GET /api/admin/learning-profiles
// @desc    Get learning profiles for all students (read-only, paginated)
router.get('/learning-profiles', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const search = (req.query.search || '').trim();
    const skip = (page - 1) * limit;

    const userFilter = { isAdmin: { $ne: true } };
    if (search) {
      userFilter.$or = [
        { email: { $regex: search, $options: 'i' } },
        { username: { $regex: search, $options: 'i' } },
        { 'profile.name': { $regex: search, $options: 'i' } }
      ];
    }

    const users = await User.find(userFilter)
      .select('_id email username profile.name profile.quizScores profile.quizAttempts profile.learningStage curriculumProgress createdAt')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const userIds = users.map(user => user._id);
    const [states, sessionCounts, skillTreeGames, gamificationProfiles] = await Promise.all([
      StudentKnowledgeState.find({ userId: { $in: userIds } }).lean(),
      TutorSession.aggregate([
        { $match: { userId: { $in: userIds } } },
        { $group: { _id: '$userId', count: { $sum: 1 } } }
      ]),
      SkillTreeGame.find({ userId: { $in: userIds } }).lean(),
      GamificationProfile.find({ userId: { $in: userIds } }).lean()
    ]);

    const stateByUserId = new Map(states.map(state => [state.userId.toString(), state]));
    const sessionCountsMap = new Map(sessionCounts.map(item => [item._id?.toString(), item.count]));
    
    const skillTreeByUserId = new Map();
    skillTreeGames.forEach(g => {
      const uid = g.userId.toString();
      if (!skillTreeByUserId.has(uid)) skillTreeByUserId.set(uid, []);
      skillTreeByUserId.get(uid).push(g);
    });

    // Helper function to extract all quiz scores (nested and in Maps)
    const getQuizScoresHelper = (user) => {
      const scores = [];
      if (user.profile && Array.isArray(user.profile.quizScores)) {
        user.profile.quizScores.forEach(q => {
          if (typeof q.score === 'number') scores.push(q.score);
        });
      }
      if (user.curriculumProgress) {
        const entries = user.curriculumProgress instanceof Map
          ? Array.from(user.curriculumProgress.values())
          : Object.values(user.curriculumProgress);
        entries.forEach(progress => {
          if (progress && progress.quizResults) {
            const results = progress.quizResults instanceof Map
              ? Array.from(progress.quizResults.values())
              : Object.values(progress.quizResults);
            results.forEach(val => {
              try {
                const parsed = typeof val === 'string' && (val.startsWith('{') || val.startsWith('"')) ? JSON.parse(val) : val;
                const score = typeof parsed === 'object' ? parsed.score : parseFloat(parsed);
                if (!isNaN(score)) scores.push(score);
              } catch (e) {}
            });
          }
        });
      }
      return scores;
    };

    const profiles = users.map((user) => {
      const state = stateByUserId.get(user._id.toString());
      const concepts = Array.isArray(state?.concepts) ? state.concepts : [];
      const masteredCount = concepts.filter(c => c.masteryScore >= 85 || c.understandingLevel === 'mastered').length;
      const strugglingCount = concepts.filter(c => c.masteryScore < 70 || c.difficulty === 'high').length;

      const allQuizScores = getQuizScoresHelper(user);
      const averageQuizScore = allQuizScores.length
        ? Math.round(allQuizScores.reduce((acc, curr) => acc + curr, 0) / allQuizScores.length)
        : null;

      const totalTutorSessions = sessionCountsMap.get(user._id.toString()) || 0;

      let activeCourse = 'None';
      if (user.curriculumProgress) {
        const courses = Object.keys(user.curriculumProgress);
        if (courses.length > 0) {
          activeCourse = courses[0];
        }
      }

      // Skill Tree completions
      const studentGames = skillTreeByUserId.get(user._id.toString()) || [];
      const completedLevels = studentGames.reduce((sum, g) => sum + (g.completedLevels || 0), 0);
      const totalStars = studentGames.reduce((sum, g) => sum + (g.totalStars || 0), 0);

      return {
        user: {
          id: user._id,
          email: user.email,
          username: user.username,
          name: user.profile?.name || '',
          joinedAt: user.createdAt,
          learningStage: user.profile?.learningStage || 'Beginner'
        },
        hasProfile: !!state,
        learningProfile: state?.learningProfile || null,
        knowledgeSummary: state?.knowledgeSummary || '',
        averageQuizScore,
        totalTutorSessions,
        activeCourse,
        summary: {
          totalConcepts: concepts.length,
          mastered: masteredCount,
          struggling: strugglingCount,
          recurringStruggles: Array.isArray(state?.recurringStruggles) ? state.recurringStruggles.length : 0,
          sessionInsights: Array.isArray(state?.sessionInsights) ? state.sessionInsights.length : 0
        },
        engagementMetrics: state?.engagementMetrics || null,
        skillTreeProgress: {
          completedLevels,
          totalStars,
          gamesCount: studentGames.length
        },
        lastUpdated: state?.lastUpdated || null
      };
    });

    const totalStudents = await User.countDocuments(userFilter);

    res.status(200).json({
      page,
      limit,
      totalStudents,
      totalPages: Math.ceil(totalStudents / limit),
      profiles
    });
  } catch (error) {
    log.error('SYSTEM', `Failed to fetch learning profiles: ${error.message}`);
    res.status(500).json({ message: 'Server error while fetching learning profiles.' });
  }
});

// @route   GET /api/admin/learning-profiles/:userId
// @desc    Get full learning profile for one student (read-only)
router.get('/learning-profiles/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ message: 'User ID is required.' });
    }

    const user = await User.findOne({ _id: userId, isAdmin: { $ne: true } })
      .select('_id email username profile curriculumProgress createdAt')
      .lean();

    if (!user) {
      return res.status(404).json({ message: 'Student not found.' });
    }

    const [knowledgeState, tutorSessions, skillTreeGames, gamificationProfile] = await Promise.all([
      StudentKnowledgeState.findOne({ userId: user._id }).lean(),
      TutorSession.find({ userId: user._id }).sort({ updatedAt: -1 }).lean(),
      SkillTreeGame.find({ userId: user._id }).lean(),
      GamificationProfile.findOne({ userId: user._id }).lean()
    ]);

    // Helper function to extract all quiz scores (nested and in Maps)
    const getQuizScoresHelper = (userObj) => {
      const scores = [];
      if (userObj.profile && Array.isArray(userObj.profile.quizScores)) {
        userObj.profile.quizScores.forEach(q => {
          if (typeof q.score === 'number') scores.push(q.score);
        });
      }
      if (userObj.curriculumProgress) {
        const entries = userObj.curriculumProgress instanceof Map
          ? Array.from(userObj.curriculumProgress.values())
          : Object.values(userObj.curriculumProgress);
        entries.forEach(progress => {
          if (progress && progress.quizResults) {
            const results = progress.quizResults instanceof Map
              ? Array.from(progress.quizResults.values())
              : Object.values(progress.quizResults);
            results.forEach(val => {
              try {
                const parsed = typeof val === 'string' && (val.startsWith('{') || val.startsWith('"')) ? JSON.parse(val) : val;
                const score = typeof parsed === 'object' ? parsed.score : parseFloat(parsed);
                if (!isNaN(score)) scores.push(score);
              } catch (e) {}
            });
          }
        });
      }
      return scores;
    };

    const allScores = getQuizScoresHelper(user);
    const averageQuizScore = allScores.length
      ? Math.round(allScores.reduce((acc, curr) => acc + curr, 0) / allScores.length)
      : null;
    const totalQuizAttempts = allScores.length;
    const bestQuizScore = allScores.length ? Math.max(...allScores) : null;
    const latestQuizScore = Array.isArray(user.profile?.quizScores) && user.profile.quizScores.length
      ? user.profile.quizScores[user.profile.quizScores.length - 1].score
      : (allScores.length ? allScores[allScores.length - 1] : null);

    // Tutor session calculations
    let totalSessionDuration = 0;
    const sessionsTimeline = tutorSessions.map(session => {
      let duration = 0;
      if (session.conversationContext && session.conversationContext.length >= 2) {
        const first = new Date(session.conversationContext[0].timestamp);
        const last = new Date(session.conversationContext[session.conversationContext.length - 1].timestamp);
        duration = Math.round((last - first) / 60000);
      } else {
        duration = Math.round((new Date(session.updatedAt) - new Date(session.createdAt)) / 60000);
      }
      duration = Math.max(1, duration);
      totalSessionDuration += duration;

      return {
        sessionId: session.sessionId,
        topic: session.topic || session.subject || 'General Socratic Chat',
        duration,
        interactions: session.progressTracking?.totalInteractions || 0,
        cognitiveLevel: session.cognitiveLevel || 'L1_CONCEPT',
        masteryScore: session.masteryScore || 0,
        status: session.status || 'active',
        date: session.updatedAt
      };
    });

    // Course curriculum progress calculations
    const courseProgress = [];
    if (user.curriculumProgress) {
      const curriculumEntries = user.curriculumProgress instanceof Map
        ? Array.from(user.curriculumProgress.entries())
        : Object.entries(user.curriculumProgress);
      for (const [courseName, progress] of curriculumEntries) {
        const completedSubtopics = progress.completedSubtopics || [];
        const completedTopics = progress.completedTopics || [];
        const completedModules = progress.completedModules || [];
        
        // Est. total module/topic count fallbacks
        const totalModules = completedModules.length > 0 ? completedModules.length + 2 : 4;
        const totalTopics = completedTopics.length > 0 ? completedTopics.length + 4 : 8;
        const totalSubtopics = completedSubtopics.length > 0 ? completedSubtopics.length + 8 : 16;
        
        const completionPercent = totalSubtopics > 0
          ? Math.round((completedSubtopics.length / totalSubtopics) * 100)
          : 0;

        courseProgress.push({
          courseName,
          completedSubtopicsCount: completedSubtopics.length,
          totalSubtopics,
          completedTopicsCount: completedTopics.length,
          totalTopics,
          completedModulesCount: completedModules.length,
          totalModules,
          completionPercent,
          lastActiveDate: progress.lastActiveDate
        });
      }
    }

    // Skill Tree Progress
    let totalCompletedLevels = 0;
    let totalStarsEarned = 0;
    const skillTreeData = skillTreeGames.map(game => {
      totalCompletedLevels += (game.completedLevels || 0);
      totalStarsEarned += (game.totalStars || 0);
      return {
        topic: game.topic,
        completedLevels: game.completedLevels,
        totalLevels: game.levels?.length || 0,
        totalStars: game.totalStars,
        assessmentLevel: game.assessmentResult?.level || 'Beginner'
      };
    });

    // Gamification profile data
    const gamification = gamificationProfile ? {
      totalLearningCredits: gamificationProfile.totalLearningCredits || 0,
      level: gamificationProfile.level || 1,
      currentStreak: gamificationProfile.currentStreak || 0,
      longestStreak: gamificationProfile.longestStreak || 0,
      currentEnergy: gamificationProfile.currentEnergy || 100,
      badges: gamificationProfile.badges || []
    } : {
      totalLearningCredits: 0,
      level: 1,
      currentStreak: 0,
      longestStreak: 0,
      currentEnergy: 100,
      badges: []
    };

    // Combined learning timeline
    const timelineEvents = [];
    const quizScoresArray = user.profile?.quizScores || [];
    quizScoresArray.forEach(q => {
      timelineEvents.push({
        type: 'quiz',
        title: `Quiz in ${q.course || q.courseName || 'General'}`,
        detail: `Score: ${q.score}% - Module: ${q.module || 'All'}`,
        score: q.score,
        date: q.date || q.attemptDate || new Date()
      });
    });

    tutorSessions.forEach(session => {
      timelineEvents.push({
        type: 'tutor',
        title: `Socratic Tutoring in ${session.topic || session.subject || 'General'}`,
        detail: `${session.progressTracking?.totalInteractions || 0} interactions, Cognitive Level: ${session.cognitiveLevel || 'L1_CONCEPT'}`,
        score: Math.round(session.masteryScore * 20),
        date: session.updatedAt || session.createdAt
      });
    });

    skillTreeGames.forEach(game => {
      if (game.levels) {
        game.levels.forEach(lvl => {
          if (lvl.status === 'completed' && lvl.completedAt) {
            timelineEvents.push({
              type: 'skill',
              title: `Skill Level Completed: ${lvl.name}`,
              detail: `Topic: ${game.topic} - Stars: ${lvl.stars || 0}/3`,
              score: lvl.score,
              date: lvl.completedAt
            });
          }
        });
      }
    });

    timelineEvents.sort((a, b) => new Date(b.date) - new Date(a.date));

    if (!knowledgeState) {
      return res.status(200).json({
        user: {
          id: user._id,
          email: user.email,
          username: user.username,
          name: user.profile?.name || '',
          quizScores: user.profile?.quizScores || [],
          averageQuizScore,
          totalQuizAttempts,
          bestQuizScore,
          latestQuizScore,
          joinedAt: user.createdAt,
          learningStage: user.profile?.learningStage || 'Beginner'
        },
        profile: {
          dominantLearningStyle: user.profile?.learningStyle || 'unknown',
          learningPace: 'moderate',
          preferredDepth: 'balanced',
          challengeResponse: 'needs_encouragement',
          questioningBehavior: 'asks_when_stuck'
        },
        summary: {
          totalConcepts: 0,
          mastered: 0,
          learning: 0,
          struggling: 0,
          notExposed: 0,
          recentFocus: [],
          topStruggles: [],
          avgLearningVelocity: 0
        },
        concepts: [],
        currentFocusAreas: [],
        recurringStruggles: [],
        sessionInsights: [],
        engagementMetrics: {
          totalSessions: tutorSessions.length,
          totalSessionDuration
        },
        masteredTopics: [],
        courseCurriculumProgress: courseProgress,
        recommendations: [],
        textSummary: '',
        lastUpdated: null,
        gamification,
        skillTree: {
          completedLevels: totalCompletedLevels,
          totalStars: totalStarsEarned,
          games: skillTreeData
        },
        tutorSessionsList: sessionsTimeline,
        timeline: timelineEvents
      });
    }

    const concepts = Array.isArray(knowledgeState.concepts) ? knowledgeState.concepts : [];
    const mastered = concepts.filter(c => c.masteryScore >= 85 || c.understandingLevel === 'mastered').length;
    const learning = concepts.filter(c => c.understandingLevel === 'learning').length;
    const struggling = concepts.filter(c => c.masteryScore < 70 || c.understandingLevel === 'struggling' || c.difficulty === 'high').length;
    const notExposed = concepts.filter(c => c.understandingLevel === 'not_exposed').length;

    const avgLearningVelocity = concepts.length
      ? parseFloat((concepts.reduce((acc, curr) => acc + (curr.learningVelocity || 0), 0) / concepts.length).toFixed(3))
      : 0;

    res.status(200).json({
      user: {
        id: user._id,
        email: user.email,
        username: user.username,
        name: user.profile?.name || '',
        quizScores: user.profile?.quizScores || [],
        averageQuizScore,
        totalQuizAttempts,
        bestQuizScore,
        latestQuizScore,
        joinedAt: user.createdAt,
        learningStage: user.profile?.learningStage || 'Beginner'
      },
      profile: {
        dominantLearningStyle: knowledgeState.learningProfile?.dominantLearningStyle || user.profile?.learningStyle || 'unknown',
        learningPace: knowledgeState.learningProfile?.learningPace || 'moderate',
        preferredDepth: knowledgeState.learningProfile?.preferredDepth || 'balanced',
        challengeResponse: knowledgeState.learningProfile?.challengeResponse || 'needs_encouragement',
        questioningBehavior: knowledgeState.learningProfile?.questioningBehavior || 'asks_when_stuck'
      },
      summary: {
        totalConcepts: concepts.length,
        mastered,
        learning,
        struggling,
        notExposed,
        recentFocus: (knowledgeState.currentFocusAreas || []).slice(0, 5).map(f => f.topic),
        topStruggles: (knowledgeState.recurringStruggles || []).slice(0, 5).map(s => s.pattern),
        avgLearningVelocity
      },
      concepts: concepts.map(c => ({
        name: c.conceptName,
        mastery: c.masteryScore,
        masteryNormalized: c.masteryScoreNormalized,
        difficulty: c.difficulty,
        understandingLevel: c.understandingLevel,
        learningVelocity: c.learningVelocity,
        confidenceScore: c.confidenceScore,
        strengths: c.strengths || [],
        weaknesses: c.weaknesses || [],
        misconceptions: c.misconceptions || [],
        lastPracticed: c.lastInteractionDate,
        firstExposureDate: c.firstExposureDate
      })),
      currentFocusAreas: knowledgeState.currentFocusAreas || [],
      recurringStruggles: knowledgeState.recurringStruggles || [],
      sessionInsights: knowledgeState.sessionInsights || [],
      engagementMetrics: {
        ...knowledgeState.engagementMetrics,
        totalSessions: Math.max(tutorSessions.length, knowledgeState.engagementMetrics?.totalSessions || 0),
        totalSessionDuration
      },
      masteredTopics: knowledgeState.masteredTopics || [],
      courseCurriculumProgress: courseProgress,
      recommendations: knowledgeState.recommendations || [],
      textSummary: knowledgeState.knowledgeSummary || '',
      lastUpdated: knowledgeState.lastUpdated || null,
      gamification,
      skillTree: {
        completedLevels: totalCompletedLevels,
        totalStars: totalStarsEarned,
        games: skillTreeData
      },
      tutorSessionsList: sessionsTimeline,
      timeline: timelineEvents
    });
  } catch (error) {
    log.error('SYSTEM', `Failed to fetch student learning profile detail: ${error.message}`);
    res.status(500).json({ message: 'Server error while fetching learning profile details.' });
  }
});

// @route   GET /api/admin/cohort-analytics
// @desc    Get cohort-wide performance analytics
router.get('/cohort-analytics', async (req, res) => {
  try {
    const students = await User.find({ isAdmin: { $ne: true } })
      .select('_id email username profile curriculumProgress')
      .lean();

    const knowledgeStates = await StudentKnowledgeState.find({}).lean();
    const tutorSessions = await TutorSession.find({ userId: { $ne: null } })
      .select('userId progressTracking.totalInteractions updatedAt createdAt')
      .lean();

    const skillTreeGames = await SkillTreeGame.find({}).lean();
    const gamificationProfiles = await GamificationProfile.find({}).lean();

    // Helper to calculate quiz scores
    const getQuizScoresHelper = (userObj) => {
      const scores = [];
      if (userObj.profile && Array.isArray(userObj.profile.quizScores)) {
        userObj.profile.quizScores.forEach(q => {
          if (typeof q.score === 'number') scores.push(q.score);
        });
      }
      if (userObj.curriculumProgress) {
        const entries = userObj.curriculumProgress instanceof Map
          ? Array.from(userObj.curriculumProgress.values())
          : Object.values(userObj.curriculumProgress);
        entries.forEach(progress => {
          if (progress && progress.quizResults) {
            const results = progress.quizResults instanceof Map
              ? Array.from(progress.quizResults.values())
              : Object.values(progress.quizResults);
            results.forEach(val => {
              try {
                const parsed = typeof val === 'string' && (val.startsWith('{') || val.startsWith('"')) ? JSON.parse(val) : val;
                const score = typeof parsed === 'object' ? parsed.score : parseFloat(parsed);
                if (!isNaN(score)) scores.push(score);
              } catch (e) {}
            });
          }
        });
      }
      return scores;
    };

    // 1. Student counts per course & Average course-wide quiz score + completion %
    const courseData = {};
    students.forEach(student => {
      const activeCourses = student.curriculumProgress ? Object.keys(student.curriculumProgress) : [];
      activeCourses.forEach(course => {
        if (!courseData[course]) {
          courseData[course] = { studentCount: 0, quizScoresSum: 0, quizScoresCount: 0, completionPercentSum: 0 };
        }
        courseData[course].studentCount++;
        
        const prog = student.curriculumProgress[course] || {};
        const completedSub = prog.completedSubtopics || [];
        const totalSub = completedSub.length > 0 ? completedSub.length + 8 : 16;
        const completion = totalSub > 0 ? (completedSub.length / totalSub) * 100 : 0;
        courseData[course].completionPercentSum += completion;
      });

      const quizzes = getQuizScoresHelper(student);
      quizzes.forEach(score => {
        // Fallback to active course name or 'General'
        const course = activeCourses[0] || 'General';
        if (!courseData[course]) {
          courseData[course] = { studentCount: 0, quizScoresSum: 0, quizScoresCount: 0, completionPercentSum: 0 };
        }
        courseData[course].quizScoresSum += score;
        courseData[course].quizScoresCount++;
      });
    });

    const courseAnalytics = Object.keys(courseData).map(course => {
      const data = courseData[course];
      return {
        course,
        studentCount: data.studentCount,
        averageQuizScore: data.quizScoresCount > 0 ? Math.round(data.quizScoresSum / data.quizScoresCount) : null,
        averageCompletionPercent: data.studentCount > 0 ? Math.round(data.completionPercentSum / data.studentCount) : 0
      };
    });

    // 2. Most Difficult and Most Mastered Topics
    const conceptMasteryMap = {};
    knowledgeStates.forEach(ks => {
      const concepts = ks.concepts || [];
      concepts.forEach(c => {
        if (!c.conceptName) return;
        if (!conceptMasteryMap[c.conceptName]) {
          conceptMasteryMap[c.conceptName] = { sum: 0, count: 0 };
        }
        conceptMasteryMap[c.conceptName].sum += (c.masteryScore || 0);
        conceptMasteryMap[c.conceptName].count++;
      });
    });

    const conceptAverages = Object.keys(conceptMasteryMap).map(name => {
      const data = conceptMasteryMap[name];
      return {
        conceptName: name,
        averageMastery: Math.round(data.sum / data.count),
        studentCount: data.count
      };
    });

    const mostDifficult = [...conceptAverages]
      .sort((a, b) => a.averageMastery - b.averageMastery)
      .slice(0, 5);

    const mostMastered = [...conceptAverages]
      .sort((a, b) => b.averageMastery - a.averageMastery)
      .slice(0, 5);

    // 3. Struggling Students (average score < 50% OR low concept count with high struggles)
    const strugglingStudents = [];
    students.forEach(student => {
      const quizzes = getQuizScoresHelper(student);
      if (quizzes.length > 0) {
        const avg = quizzes.reduce((sum, q) => sum + q, 0) / quizzes.length;
        if (avg < 50) {
          strugglingStudents.push({
            userId: student._id,
            username: student.username,
            name: student.profile?.name || '',
            email: student.email,
            averageQuizScore: Math.round(avg),
            quizAttemptsCount: quizzes.length
          });
        }
      }
    });

    // 4. Most Active Students (sorted by tutor session count + interactions)
    const studentActivity = {};
    tutorSessions.forEach(session => {
      const userIdStr = session.userId?.toString();
      if (!userIdStr) return;
      if (!studentActivity[userIdStr]) {
        studentActivity[userIdStr] = { sessionCount: 0, totalInteractions: 0 };
      }
      studentActivity[userIdStr].sessionCount++;
      studentActivity[userIdStr].totalInteractions += (session.progressTracking?.totalInteractions || 0);
    });

    const activeStudents = students.map(student => {
      const activity = studentActivity[student._id.toString()] || { sessionCount: 0, totalInteractions: 0 };
      return {
        userId: student._id,
        username: student.username,
        name: student.profile?.name || '',
        email: student.email,
        sessionCount: activity.sessionCount,
        totalInteractions: activity.totalInteractions
      };
    })
    .sort((a, b) => (b.sessionCount + b.totalInteractions) - (a.sessionCount + a.totalInteractions))
    .slice(0, 5);

    res.status(200).json({
      totalStudentsCount: students.length,
      courseAnalytics,
      mostDifficultTopics: mostDifficult,
      mostMasteredTopics: mostMastered,
      strugglingStudents,
      mostActiveStudents: activeStudents
    });
  } catch (error) {
    log.error('SYSTEM', `Failed to fetch cohort-analytics: ${error.message}`);
    res.status(500).json({ message: 'Server error while fetching cohort-analytics.' });
  }
});


// --- API Key Management Routes ---

// @route   GET /api/admin/key-requests
// @desc    Get all users with a pending API key request
router.get('/key-requests', cacheMiddleware(CACHE_DURATION_SECONDS), async (req, res) => {
  try {
    const requests = await User.find({ apiKeyRequestStatus: 'pending' })
      .select('email profile createdAt')
      .sort({ createdAt: -1 });
    res.json(requests);
  } catch (error) {
    log.error('SYSTEM', `Failed to fetch key requests: ${error.message}`);
    res.status(500).json({ message: 'Server error while fetching requests.' });
  }
});

// @route   POST /api/admin/key-requests/approve
router.post("/key-requests/approve", async (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ message: "User ID is required." });
  }

  try {
    const serverApiKey = process.env.GEMINI_API_KEY;
    if (!serverApiKey) {
      return res
        .status(500)
        .json({ message: "Server-side GEMINI_API_KEY is not configured." });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    user.encryptedApiKey = serverApiKey; // pre-save hook handles encryption
    user.apiKeyRequestStatus = "approved";
    user.preferredLlmProvider = "gemini";

    await user.save();

    auditLog(req, 'ADMIN_API_KEY_APPROVE', {
      targetUserId: userId,
      targetUserEmail: user.email
    });
    // --- NEW: Invalidate Redis Cache for pending requests and dashboard stats ---
    if (redisClient && redisClient.isOpen) {
      log.info('SYSTEM', "Redis cache invalidated for key-requests/dashboard");
    }
    // --- END NEW ---

    res.json({
      message: `API key request for ${user.email} has been approved.`,
    });
  } catch (error) {
    log.error('SYSTEM', `API key approval failed: ${error.message}`);
    res.status(500).json({ message: "Server error while approving request." });
  }
})
// @route   POST /api/admin/key-requests/reject
// @desc    Reject a user's API key request
router.post("/key-requests/reject", async (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ message: "User ID is required." });
  }

  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    user.apiKeyRequestStatus = "rejected";
    await user.save();

    auditLog(req, 'ADMIN_API_KEY_REJECT', {
      targetUserId: userId,
      targetUserEmail: user.email
    });
    // --- NEW: Invalidate Redis Cache for pending requests and dashboard stats ---
    if (redisClient && redisClient.isOpen) {
      log.info('SYSTEM', "Redis cache invalidated for key-requests/dashboard");
    }
    // --- END NEW ---

    res.json({
      message: `API key request for ${user.email} has been rejected.`,
    });
  } catch (error) {
    log.error('SYSTEM', `API key rejection failed: ${error.message}`);
    res.status(500).json({ message: "Server error while rejecting request." });
  }
});
// --- Document Management Routes ---

const ADMIN_UPLOAD_DIR_BASE = path.join(
  __dirname,
  "..",
  "assets",
  "_admin_uploads_"
);
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const allowedAdminMimeTypes = {
  "application/pdf": "docs",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docs",
  "text/plain": "docs",
  "text/markdown": "docs",
};
const allowedAdminExtensions = [".pdf", ".docx", ".txt", ".md"];

const adminStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const fileMimeType = file.mimetype.toLowerCase();
    const fileTypeSubfolder = allowedAdminMimeTypes[fileMimeType] || "others";
    const destinationPath = path.join(ADMIN_UPLOAD_DIR_BASE, fileTypeSubfolder);
    fs.mkdir(destinationPath, { recursive: true }, (err) => {
      if (err) return cb(err);
      cb(null, destinationPath);
    });
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const fileExt = path.extname(file.originalname).toLowerCase();
    const sanitizedBaseName = path
      .basename(file.originalname, fileExt)
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .substring(0, 100);
    cb(null, `${timestamp}-${sanitizedBaseName}${fileExt}`);
  },
});
const adminFileFilter = (req, file, cb) => {
  const fileExt = path.extname(file.originalname).toLowerCase();
  const mimeType = file.mimetype.toLowerCase();
  if (
    allowedAdminMimeTypes[mimeType] &&
    allowedAdminExtensions.includes(fileExt)
  ) {
    cb(null, true);
  } else {
    const error = new multer.MulterError("LIMIT_UNEXPECTED_FILE_TYPE_ADMIN");
    error.message = `Invalid file type. Allowed: ${allowedAdminExtensions.join(
      ", "
    )}`;
    cb(error, false);
  }
};
const adminUpload = multer({ storage: adminStorage, fileFilter: adminFileFilter, limits: { fileSize: MAX_FILE_SIZE } });
async function triggerPythonRagProcessingForAdmin(filePath, originalName) {
  const pythonServiceUrl = process.env.PYTHON_RAG_SERVICE_URL;
  if (!pythonServiceUrl) {
    return { success: false, message: "Python service URL not configured.", text: null, chunksForKg: [] };
  }
  const addDocumentUrl = `${pythonServiceUrl}/add_document`;
  try {
    const response = await axios.post(addDocumentUrl, {
      user_id: "admin",
      file_path: filePath, original_name: originalName
    }, { timeout: 300000 });

    const text = response.data?.raw_text_for_analysis || null;
    const chunksForKg = response.data?.chunks_with_metadata || [];
    const isSuccess = !!(text && text.trim());
    return {
      success: isSuccess,
      message: response.data?.message || "Python RAG service call completed.",
      text: text,
      chunksForKg: chunksForKg
    };
  } catch (error) {
    const errorMsg = error.response?.data?.error || error.message || "Unknown error calling Python RAG.";
    return { success: false, message: `Python RAG call failed: ${errorMsg}`, text: null, chunksForKg: [] };
  }
}
async function callPythonDeletionEndpoint(
  method,
  endpointPath,
  userId,
  originalName
) {
  const pythonServiceUrl =
    process.env.PYTHON_RAG_SERVICE_URL || "http://localhost:5000";
  const deleteUrl = `${pythonServiceUrl.replace(/\/$/, "")}${endpointPath}`;
  try {
    await axios.delete(deleteUrl, {
      data: { user_id: userId, document_name: originalName },
      timeout: 30000,
    });
    return {
      success: true,
      message: `Successfully requested deletion from ${endpointPath}`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Python service call failed for ${endpointPath}: ${error.message}`,
    };
  }
}

// @route   POST /api/admin/documents/upload
router.post(
  "/documents/upload",
  adminUpload.single("file"),
  async (req, res) => {
    if (!req.file) {
      return res
        .status(400)
        .json({ message: "No file uploaded or file type rejected." });
    }
    const {
      filename: serverFilename,
      originalname: originalName,
      path: tempServerPath,
    } = req.file;
    let adminDocRecord;
    try {
      if (await AdminDocument.exists({ originalName: originalName })) {
        await fsPromises.unlink(tempServerPath);
        return res
          .status(409)
          .json({ message: `Document '${originalName}' already exists.` });
      }

      const ragResult = await triggerPythonRagProcessingForAdmin(
        tempServerPath,
        originalName
      );
      if (!ragResult.success) {
        await fsPromises.unlink(tempServerPath);
        return res.status(422).json({ message: ragResult.message });
      }

      adminDocRecord = new AdminDocument({
        filename: serverFilename,
        originalName: originalName,
        text: ragResult.text,
      });
      await adminDocRecord.save();
      await fsPromises.unlink(tempServerPath);

      // --- ADDED AUDIT LOG ---
      auditLog(req, 'ADMIN_DOCUMENT_UPLOAD_SUCCESS', {
        originalName: originalName,
        serverFilename: serverFilename
      });
      // --- END ---

      res.status(202).json({
        message: `Admin document '${originalName}' uploaded. Background processing initiated.`,
      });

      const { Worker } = require("worker_threads");
      const analysisWorker = new Worker(
        path.resolve(__dirname, "..", "workers", "adminAnalysisWorker.js"),
        {
          workerData: {
            adminDocumentId: adminDocRecord._id.toString(),
            originalName: originalName,
            textForAnalysis: ragResult.text,
          },
        }
      );
      analysisWorker.on("error", (err) => log.error('SYSTEM', `Admin analysis worker error: ${err.message}`));

      if (ragResult.chunksForKg && ragResult.chunksForKg.length > 0) {
        const kgWorker = new Worker(
          path.resolve(__dirname, "..", "workers", "kgWorker.js"),
          {
            workerData: {
              sourceId: adminDocRecord._id.toString(), // <-- This is the new, correct property
              userId: "admin",
              originalName: originalName,
              chunksForKg: ragResult.chunksForKg,
              llmProvider: "gemini",
            },
          }
        );
        kgWorker.on("error", (err) => log.error('SYSTEM', `Admin KG worker error: ${err.message}`));
      } else {
        log.warn('SYSTEM', `Skipping KG for '${originalName}': No chunks available`);
        await AdminDocument.updateOne(
          { _id: adminDocRecord._id },
          { $set: { kgStatus: "skipped_no_chunks" } }
        );
      }
    } catch (error) {
      log.error('SYSTEM', `Admin upload failed: ${error.message}`);
      if (tempServerPath && fs.existsSync(tempServerPath))
        await fsPromises.unlink(tempServerPath).catch((unlinkErr) => {
          log.warn('SYSTEM', `Failed to remove temp upload ${tempServerPath}: ${unlinkErr.message}`);
        });
      if (!res.headersSent) {
        res
          .status(500)
          .json({ message: "Server error during admin document upload." });
      }
    }
  }
);

// @route   GET /api/admin/documents
router.get('/documents', cacheMiddleware(CACHE_DURATION_SECONDS), async (req, res) => {
  try {
    const adminDocs = await AdminDocument.find().sort({ uploadedAt: -1 })
      .select('originalName filename uploadedAt analysisUpdatedAt analysis.faq analysis.topics analysis.mindmap');
    const documentsList = adminDocs.map(doc => ({
      originalName: doc.originalName, serverFilename: doc.filename, uploadedAt: doc.uploadedAt,
      analysisUpdatedAt: doc.analysisUpdatedAt,
      hasFaq: !!(doc.analysis?.faq?.trim()),
      hasTopics: !!(doc.analysis?.topics?.trim()),
      hasMindmap: !!(doc.analysis?.mindmap?.trim()),
    }));
    res.json({ documents: documentsList });
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching admin documents.' });
  }
});

// @route   DELETE /api/admin/documents/:serverFilename
router.delete("/documents/:serverFilename", async (req, res) => {
  const { serverFilename } = req.params;
  if (!serverFilename) {
    return res.status(400).json({ message: "Server filename is required." });
  }
  try {
    const docToDelete = await AdminDocument.findOne({
      filename: serverFilename,
    });
    if (!docToDelete) {
      return res
        .status(404)
        .json({ message: `Admin document '${serverFilename}' not found.` });
    }

    const originalName = docToDelete.originalName;
    const userId = "admin";

    await callPythonDeletionEndpoint(
      "DELETE",
      `/delete_qdrant_document_data`,
      userId,
      originalName
    );
    await callPythonDeletionEndpoint(
      "DELETE",
      `/kg/${userId}/${encodeURIComponent(originalName)}`,
      userId,
      originalName
    );
    await AdminDocument.deleteOne({ _id: docToDelete._id });

    auditLog(req, 'ADMIN_DOCUMENT_DELETE_SUCCESS', {
      originalName: originalName,
      serverFilename: serverFilename
    });

    res
      .status(200)
      .json({
        message: `Admin document '${originalName}' and all associated data deleted.`,
      });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Server error during admin document deletion." });
  }
});

// @route   GET /api/admin/documents/:serverFilename/analysis
router.get("/documents/:serverFilename/analysis", async (req, res) => {
  const { serverFilename } = req.params;
  if (!serverFilename)
    return res
      .status(400)
      .json({ message: "Server filename parameter is required." });
  try {
    const adminDoc = await AdminDocument.findOne({
      filename: serverFilename,
    }).select("originalName analysis analysisUpdatedAt");
    if (!adminDoc)
      return res
        .status(404)
        .json({ message: `Admin document '${serverFilename}' not found.` });
    res.status(200).json({
      originalName: adminDoc.originalName,
      analysis: adminDoc.analysis || { faq: "", topics: "", mindmap: "" },
      analysisUpdatedAt: adminDoc.analysisUpdatedAt,
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Server error retrieving admin document analysis." });
  }
});

// @route   GET /api/admin/documents/by-original-name/:originalName/analysis
router.get(
  "/documents/by-original-name/:originalName/analysis",
  async (req, res) => {
    const { originalName } = req.params;
    if (!originalName)
      return res
        .status(400)
        .json({ message: "Original name parameter is required." });
    try {
      const decodedOriginalName = decodeURIComponent(originalName);
      const adminDoc = await AdminDocument.findOne({
        originalName: decodedOriginalName,
      }).select("originalName filename analysis analysisUpdatedAt");
      if (!adminDoc) {
        return res
          .status(404)
          .json({
            message: `Admin document '${decodedOriginalName}' not found.`,
          });
      }
      res.status(200).json({
        originalName: adminDoc.originalName,
        serverFilename: adminDoc.filename,
        analysis: adminDoc.analysis || { faq: "", topics: "", mindmap: "" },
        analysisUpdatedAt: adminDoc.analysisUpdatedAt,
      });
    } catch (error) {
      res
        .status(500)
        .json({
          message: "Server error while retrieving analysis by original name.",
        });
    }
  }
);

// --- User & Chat Management Routes ---

// @route   GET /api/admin/users-with-chats
// @desc    Get all users and their chat session summaries
router.get('/users-with-chats', cacheMiddleware(CACHE_DURATION_SECONDS), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const pipeline = [
      {
        $group: {
          _id: "$userId",
          sessions: {
            $push: {
              sessionId: "$sessionId",
              updatedAt: "$updatedAt",
              summary: { $ifNull: ["$summary", "No summary available."] },
              messageCount: { $size: { $ifNull: ["$messages", []] } }
            }
          },
          latestUpdate: { $max: "$updatedAt" }
        }
      },
      { $sort: { latestUpdate: -1 } },
      { $skip: skip },
      { $limit: limit },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "userInfo"
        }
      },
      {
        $unwind: { path: "$userInfo", preserveNullAndEmptyArrays: true }
      },
      {
        $project: {
          _id: 0,
          user: {
            _id: "$_id",
            email: { $ifNull: ["$userInfo.email", "Unknown Email"] },
            name: { $ifNull: ["$userInfo.profile.name", "N/A"] }
          },
          sessions: 1
        }
      }
    ];

    const results = await ChatHistory.aggregate(pipeline);

    const totalCountData = await ChatHistory.aggregate([
      { $group: { _id: "$userId" } },
      { $count: "count" }
    ]);
    const total = totalCountData.length > 0 ? totalCountData[0].count : 0;

    res.json({
      data: results,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    log.error('SYSTEM', `Failed to fetch users with chats: ${error.message}`);
    res.status(500).json({ message: 'Server error while fetching user chat data.' });
  }
});


// @route   GET /api/admin/negative-feedback
// @desc    Get all log entries with negative feedback
router.get('/negative-feedback', async (req, res) => {
  try {
    const negativeFeedback = await LLMPerformanceLog.find({ userFeedback: 'negative' })
      .populate('userId', 'email') // Optionally get user email
      .sort({ createdAt: -1 })
      .limit(100); // Limit to the last 100 to prevent performance issues

    res.json(negativeFeedback);
  } catch (error) {
    log.error('SYSTEM', `Failed to fetch negative feedback: ${error.message}`);
    res.status(500).json({ message: 'Server error while fetching negative feedback.' });
  }
});


// ── User Product Feedback ──────────────────────────────────────────────────────

// @route   GET /api/admin/user-feedback
// @desc    List all product-level feedback (bugs, features, general) submitted by users
// @query   sortBy: 'createdAt'|'email'  order: 'asc'|'desc'  page: number  limit: number
router.get('/user-feedback', async (req, res) => {
  try {
    const { sortBy = 'createdAt', order = 'desc', page = 1, limit = 50 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    // Fetch with user email populated
    const items = await UserFeedback.find()
      .populate('userId', 'email name')
      .select('-adminNote -__v')
      .lean();

    // Sort in-memory so we can sort by populated user.email
    items.sort((a, b) => {
      let valA, valB;
      if (sortBy === 'email') {
        valA = (a.userId?.email || '').toLowerCase();
        valB = (b.userId?.email || '').toLowerCase();
      } else {
        valA = new Date(a.createdAt).getTime();
        valB = new Date(b.createdAt).getTime();
      }
      return order === 'asc' ? (valA > valB ? 1 : -1) : (valA < valB ? 1 : -1);
    });

    const total = items.length;
    const paginated = items.slice(skip, skip + Number(limit));

    return res.json({ total, page: Number(page), limit: Number(limit), feedback: paginated });
  } catch (err) {
    log.error('ADMIN', `user-feedback list error: ${err.message}`);
    return res.status(500).json({ message: 'Failed to fetch user feedback.' });
  }
});

// @route   PATCH /api/admin/user-feedback/:id
// @desc    Update feedback status and optional admin note
router.patch('/user-feedback/:id', async (req, res) => {
  try {
    const { status, adminNote } = req.body;
    const allowed = ['open', 'acknowledged', 'resolved', 'wont-fix'];
    if (status && !allowed.includes(status)) {
      return res.status(400).json({ message: 'Invalid status value.' });
    }
    const update = {};
    if (status) { update.status = status; if (status === 'resolved') update.resolvedAt = new Date(); }
    if (adminNote !== undefined) update.adminNote = adminNote;

    const doc = await UserFeedback.findByIdAndUpdate(req.params.id, update, { new: true })
      .populate('userId', 'email name').lean();
    if (!doc) return res.status(404).json({ message: 'Feedback entry not found.' });
    return res.json(doc);
  } catch (err) {
    log.error('ADMIN', `user-feedback update error: ${err.message}`);
    return res.status(500).json({ message: 'Failed to update feedback.' });
  }
});

// @route   GET /api/admin/user-feedback/attachment/:filename
// @desc    Serve a feedback attachment file (admin-only)
router.get('/user-feedback/attachment/:filename', (req, res) => {
  const { filename } = req.params;
  if (!/^[\w.\-]+$/.test(filename)) return res.status(400).json({ message: 'Invalid filename.' });
  const filePath = path.join(__dirname, '../uploads/feedback', filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ message: 'Attachment not found.' });
  res.sendFile(filePath);
});

// ── END User Product Feedback ──────────────────────────────────────────────────

// --- Course Materials Upload Routes ---

// Configure storage for course materials (PDFs) - saved to Cpurses/<courseName>/
const CPURSES_DIR = path.join(__dirname, '..', 'Cpurses');
const materialsStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const courseName = req.params.courseName || 'default';
    const sanitizedCourse = courseName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const destinationPath = path.join(CPURSES_DIR, sanitizedCourse);
    fs.mkdir(destinationPath, { recursive: true }, (err) => {
      if (err) return cb(err);
      cb(null, destinationPath);
    });
  },
  filename: (req, file, cb) => {
    // Keep original filename for Resource matching (R1.pdf, R2.pdf, etc.)
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, sanitizedName);
  }
});

const materialsUpload = multer({
  storage: materialsStorage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit per file
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.pdf', '.docx', '.pptx', '.txt'];
    if (allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Allowed: ${allowedExts.join(', ')}`), false);
    }
  }
});

// @route   POST /api/admin/course/:courseName/materials
// @desc    Upload course materials (PDFs) to Cpurses folder
router.post('/course/:courseName/materials', materialsUpload.array('files', 20), async (req, res) => {
  const { courseName } = req.params;

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ message: 'No files uploaded.' });
  }

  const uploadedFiles = req.files.map(f => ({
    originalName: f.originalname,
    savedAs: f.filename,
    path: f.path,
    size: f.size
  }));

  auditLog(req, 'COURSE_MATERIALS_UPLOAD', {
    courseName,
    fileCount: uploadedFiles.length,
    files: uploadedFiles.map(f => f.originalName)
  });

  res.status(201).json({
    success: true,
    message: `${uploadedFiles.length} file(s) uploaded to course '${courseName}'`,
    courseName,
    folder: path.join(CPURSES_DIR, courseName.replace(/[^a-zA-Z0-9_-]/g, '_')),
    files: uploadedFiles
  });
});

// @route   GET /api/admin/course/:courseName/materials
// @desc    List materials in a course folder
router.get('/course/:courseName/materials', async (req, res) => {
  const { courseName } = req.params;
  const sanitizedCourse = courseName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const courseFolder = path.join(CPURSES_DIR, sanitizedCourse);

  try {
    if (!fs.existsSync(courseFolder)) {
      return res.json({ courseName, materials: [] });
    }

    const files = await fsPromises.readdir(courseFolder);
    const materials = [];

    for (const filename of files) {
      const filePath = path.join(courseFolder, filename);
      const stats = await fsPromises.stat(filePath);
      if (stats.isFile()) {
        materials.push({
          filename,
          size: stats.size,
          modifiedAt: stats.mtime
        });
      }
    }

    res.json({ courseName, folder: courseFolder, materials });
  } catch (error) {
    log.error('SYSTEM', `Failed to list course materials: ${error.message}`);
    res.status(500).json({ message: 'Failed to list course materials.' });
  }
});

// @route   POST /api/admin/course/:courseName/ingest
// @desc    Trigger unified ingestion: CSV → Neo4j + Materials → Qdrant
router.post('/course/:courseName/ingest', async (req, res) => {
  const pythonServiceUrl = process.env.PYTHON_RAG_SERVICE_URL;
  const { courseName } = req.params;

  if (!pythonServiceUrl) {
    return res.status(503).json({ message: 'Python RAG service URL not configured.' });
  }

  // Determine paths
  const sanitizedCourse = courseName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const materialsFolder = path.join(CPURSES_DIR, sanitizedCourse);

  // Get syllabus path from request body or use default
  let syllabusPath = req.body.syllabus_csv_path;
  if (!syllabusPath) {
    // Default: look for syllabus in the data folder
    syllabusPath = path.join(__dirname, '..', 'rag_service', 'data', 'machine_learning_syllabus.csv');
  }

  // Validate materials folder exists
  if (!fs.existsSync(materialsFolder)) {
    return res.status(400).json({
      message: `Materials folder not found. Please upload materials first.`,
      expectedFolder: materialsFolder
    });
  }

  try {
    // Call Python unified ingestion endpoint
    const response = await axios.post(
      `${pythonServiceUrl}/course/ingest`,
      {
        course_name: courseName,
        syllabus_csv_path: syllabusPath,
        materials_folder: materialsFolder,
        user_id: 'admin'
      },
      { timeout: 300000 } // 5 minute timeout for large ingestions
    );

    // --- RESET PROGRESS FOR ALL USERS (Curriculum Updated) ---
    // Since ingestion usually changes the curriculum/QA-pairs, we reset the quiz index to 1 (0) for everyone.
    try {
      const updateObj = {};
      updateObj[`curriculumProgress.${courseName}.quizIndex`] = 0;
      updateObj[`curriculumProgress.${courseName}.quizResults`] = {};

      const resetResult = await User.updateMany(
        { [`curriculumProgress.${courseName}`]: { $exists: true } },
        { $set: updateObj }
      );
      log.info('SYSTEM', `Reset quiz progress for ${resetResult.modifiedCount} users in '${courseName}'`);
    } catch (resetErr) {
      console.error(`[Admin] Failed to reset user progress after ingestion: ${resetErr.message}`);
    }
    // --- END RESET ---

    auditLog(req, 'COURSE_INGEST', {
      courseName,
      syllabusPath,
      materialsFolder,
      neo4j: response.data.neo4j,
      qdrantDocsProcessed: response.data.qdrant?.documents_processed?.length || 0
    });

    res.status(201).json(response.data);

  } catch (error) {
    console.error('Error during course ingestion:', error.response?.data || error.message);
    const errorMessage = error.response?.data?.error || error.message || 'Course ingestion failed.';
    res.status(error.response?.status || 500).json({ message: errorMessage });
  }
});







// @route   GET /api/admin/course/:courseName/visualization
// @desc    Get curriculum visualization data for admin
router.get('/course/:courseName/visualization', async (req, res) => {
  const pythonServiceUrl = process.env.PYTHON_RAG_SERVICE_URL;

  if (!pythonServiceUrl) {
    return res.status(503).json({ message: 'Python RAG service URL not configured.' });
  }

  try {
    const response = await axios.get(
      `${pythonServiceUrl}/course/${encodeURIComponent(req.params.courseName)}/visualization`,
      { timeout: 30000 }
    );
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching visualization:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      message: error.response?.data?.error || 'Failed to get visualization.'
    });
  }
});

// --- End Course Materials Routes ---


// --- Curriculum Graph Routes (Module/Topic/Subtopic Schema) ---

// Configure multer for syllabus CSV uploads
const syllabusStorage = multer.memoryStorage();
const syllabusUpload = multer({
  storage: syllabusStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.toLowerCase().endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'), false);
    }
  }
});


// @route   POST /api/admin/syllabus/upload
// @desc    Upload a syllabus CSV and build curriculum graph in Neo4j (NEW normalized schema)
router.post('/syllabus/upload', syllabusUpload.single('file'), async (req, res) => {
  const pythonServiceUrl = process.env.PYTHON_RAG_SERVICE_URL;

  if (!pythonServiceUrl) {
    return res.status(503).json({ message: 'Python RAG service URL not configured.' });
  }

  if (!req.file) {
    return res.status(400).json({ message: 'No CSV file uploaded.' });
  }

  const courseName = req.body.courseName;
  if (!courseName || !courseName.trim()) {
    return res.status(400).json({ message: 'Course name is required.' });
  }

  try {
    const FormData = require('form-data');
    const formData = new FormData();

    // Append the file buffer as a file
    formData.append('file', req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype
    });
    formData.append('courseName', courseName.trim());

    // Forward to Python service - using NEW /curriculum/upload endpoint
    const response = await axios.post(
      `${pythonServiceUrl}/curriculum/upload`,
      formData,
      {
        headers: formData.getHeaders(),
        timeout: 60000 // 60 second timeout
      }
    );

    auditLog(req, 'CURRICULUM_GRAPH_UPLOAD', {
      courseName: courseName.trim(),
      filename: req.file.originalname,
      modulesCreated: response.data.modules_created,
      topicsCreated: response.data.topics_created,
      subtopicsCreated: response.data.subtopics_created
    });

    res.status(201).json(response.data);

  } catch (error) {
    console.error('Error uploading curriculum to Python service:', error.response?.data || error.message);
    const errorMessage = error.response?.data?.error || error.message || 'Failed to process curriculum.';
    res.status(error.response?.status || 500).json({ message: errorMessage });
  }
});

// @route   GET /api/admin/syllabus/courses/:courseName
// @desc    Get curriculum structure for a course
router.get('/syllabus/courses/:courseName', async (req, res) => {
  const pythonServiceUrl = process.env.PYTHON_RAG_SERVICE_URL;

  if (!pythonServiceUrl) {
    return res.status(503).json({ message: 'Python RAG service URL not configured.' });
  }

  try {
    // Use NEW /curriculum/<course>/structure endpoint
    const response = await axios.get(
      `${pythonServiceUrl}/curriculum/${encodeURIComponent(req.params.courseName)}/structure`,
      { timeout: 30000 }
    );
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching curriculum structure:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      message: error.response?.data?.error || 'Failed to fetch curriculum structure.'
    });
  }
});

// @route   DELETE /api/admin/syllabus/courses/:courseName
// @desc    Delete all curriculum data for a course
router.delete('/syllabus/courses/:courseName', async (req, res) => {
  const pythonServiceUrl = process.env.PYTHON_RAG_SERVICE_URL;

  if (!pythonServiceUrl) {
    return res.status(503).json({ message: 'Python RAG service URL not configured.' });
  }

  try {
    const cascadeResult = await safeCascadeDeleteCourse({
      courseName: req.params.courseName,
      pythonServiceUrl,
      initiatedByUserId: req.user?._id?.toString?.() || 'admin'
    });

    const primaryResponse = cascadeResult.graph.response || {
      success: cascadeResult.graph.deleted,
      deleted_count: cascadeResult.db.userProgressRemoved,
      message: cascadeResult.graph.deleted
        ? 'Course deleted via cascade cleanup.'
        : 'Course cleanup completed with partial failures. See cascade report.'
    };

    auditLog(req, 'CURRICULUM_GRAPH_DELETE', {
      courseName: req.params.courseName,
      deletedCount: primaryResponse.deleted_count,
      cascadeErrors: cascadeResult.errors.length
    });

    res.json({ ...primaryResponse, cascade: cascadeResult });
  } catch (error) {
    console.error('Error deleting curriculum graph:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      message: error.response?.data?.error || 'Failed to delete curriculum graph.'
    });
  }
});

// --- End Curriculum Graph Routes ---


/* ============================================================
   2.1.3 Multi-Model Management — Course ↔ Adapter Mapping
   ============================================================ */

// GET /api/admin/adapters
// Returns list of all available LLM configs that can act as adapters (fine-tuned or any)
// The frontend uses this to populate the adapter selection dropdown.
router.get('/adapters', async (req, res) => {
  try {
    const adapters = await LLMConfiguration.find().sort({ provider: 1, displayName: 1 }).lean();
    res.json(adapters);
  } catch (error) {
    console.error('[MultiModel] Error fetching adapters:', error);
    res.status(500).json({ message: 'Failed to fetch adapters.' });
  }
});

// GET /api/admin/course-adapters
// Returns all course ↔ adapter mappings
router.get('/course-adapters', async (req, res) => {
  try {
    const mappings = await CourseAdapterMapping.find().sort({ updatedAt: -1 }).lean();
    res.json(mappings);
  } catch (error) {
    console.error('[MultiModel] Error fetching course adapter mappings:', error);
    res.status(500).json({ message: 'Failed to fetch course adapter mappings.' });
  }
});

// POST /api/admin/course-adapters
// Create a new course ↔ adapter mapping (prevents duplicate course mappings)
router.post('/course-adapters', async (req, res) => {
  const { courseId, adapterName, baseModel, provider, version, description } = req.body;

  if (!courseId || !adapterName || !baseModel) {
    return res.status(400).json({ message: 'courseId, adapterName, and baseModel are required.' });
  }

  try {
    // Prevent duplicate course mappings
    const existing = await CourseAdapterMapping.findOne({ courseId: courseId.trim() });
    if (existing) {
      return res.status(409).json({
        message: `A mapping for course '${courseId}' already exists. Use PUT to update it.`,
      });
    }

    // Validate adapter exists in LLMConfiguration
    const adapterExists = await LLMConfiguration.findOne({ modelId: adapterName });
    if (!adapterExists) {
      console.warn(`[MultiModel] Adapter '${adapterName}' not found in LLMConfiguration, saving anyway.`);
    }

    const mapping = new CourseAdapterMapping({
      courseId: courseId.trim(),
      adapterName: adapterName.trim(),
      baseModel: baseModel.trim(),
      provider: provider || 'fine-tuned',
      version: version || 'v1.0',
      description: description || '',
      history: [{ adapterName, baseModel, version: version || 'v1.0', changedBy: 'admin' }],
    });

    await mapping.save();

    auditLog(req, 'COURSE_ADAPTER_CREATE', { courseId, adapterName, baseModel });
    res.status(201).json(mapping);
  } catch (error) {
    console.error('[MultiModel] Error creating course adapter mapping:', error);
    res.status(500).json({ message: 'Failed to create course adapter mapping.', error: error.message });
  }
});

// GET /api/admin/course-adapters/:courseId
// Retrieve the mapped adapter for a specific course
router.get('/course-adapters/:courseId', async (req, res) => {
  try {
    const mapping = await CourseAdapterMapping.findOne({ courseId: req.params.courseId }).lean();
    if (!mapping) {
      return res.status(404).json({ message: `No adapter mapping found for course '${req.params.courseId}'.` });
    }
    res.json(mapping);
  } catch (error) {
    console.error('[MultiModel] Error fetching course adapter mapping:', error);
    res.status(500).json({ message: 'Failed to fetch course adapter mapping.' });
  }
});

// PUT /api/admin/course-adapters/:courseId
// Update the adapter mapping for an existing course (appends to version history)
router.put('/course-adapters/:courseId', async (req, res) => {
  const { adapterName, baseModel, provider, version, description, isActive } = req.body;

  try {
    const mapping = await CourseAdapterMapping.findOne({ courseId: req.params.courseId });
    if (!mapping) {
      return res.status(404).json({ message: `No adapter mapping found for course '${req.params.courseId}'.` });
    }

    // Push to version history before updating
    mapping.history.push({
      adapterName: mapping.adapterName,
      baseModel: mapping.baseModel,
      version: mapping.version,
      changedBy: 'admin',
    });

    if (adapterName !== undefined) mapping.adapterName = adapterName.trim();
    if (baseModel !== undefined) mapping.baseModel = baseModel.trim();
    if (provider !== undefined) mapping.provider = provider;
    if (version !== undefined) mapping.version = version.trim();
    if (description !== undefined) mapping.description = description;
    if (isActive !== undefined) mapping.isActive = isActive;

    await mapping.save();

    auditLog(req, 'COURSE_ADAPTER_UPDATE', { courseId: req.params.courseId, adapterName, baseModel });
    res.json(mapping);
  } catch (error) {
    console.error('[MultiModel] Error updating course adapter mapping:', error);
    res.status(500).json({ message: 'Failed to update course adapter mapping.', error: error.message });
  }
});

// DELETE /api/admin/course-adapters/:courseId
// Remove the adapter mapping for a course
router.delete('/course-adapters/:courseId', async (req, res) => {
  try {
    const deleted = await CourseAdapterMapping.findOneAndDelete({ courseId: req.params.courseId });
    if (!deleted) {
      return res.status(404).json({ message: `No adapter mapping found for course '${req.params.courseId}'.` });
    }
    auditLog(req, 'COURSE_ADAPTER_DELETE', { courseId: req.params.courseId });
    res.json({ message: `Adapter mapping for course '${req.params.courseId}' deleted successfully.` });
  } catch (error) {
    console.error('[MultiModel] Error deleting course adapter mapping:', error);
    res.status(500).json({ message: 'Failed to delete course adapter mapping.' });
  }
});

/* ============================================================
   END 2.1.3 Multi-Model Management
   ============================================================ */


module.exports = router;