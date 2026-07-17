const cache = require('./skillTreeCacheService');
const UserSkillTree = require('../models/UserSkillTree');
const UploadedCurriculum = require('../models/UploadedCurriculum');
const QuestionBank = require('../models/QuestionBank');
const StudentKnowledgeState = require('../models/StudentKnowledgeState');
const GamificationProfile = require('../models/GamificationProfile');
const SkillTree = require('../models/SkillTree');
const log = require('../utils/logger');

async function getSkillTree(userId, courseName) {
  const cacheKey = `${courseName}`;
  const cached = await cache.get('skilltree', cacheKey);
  if (cached) {
    log.info('SKILL_TREE', `Cache hit for ${courseName}`);
    return cached;
  }

  const mongo = await UserSkillTree.findOne({ userId, courseName }).lean();
  if (mongo) {
    await cache.set('skilltree', mongo, cacheKey);
    log.info('SKILL_TREE', `Mongo hit for ${courseName}`);
    return mongo;
  }

  return null;
}

async function saveSkillTree(userId, courseName, treeData) {
  const doc = await UserSkillTree.findOneAndUpdate(
    { userId, courseName },
    { $set: { ...treeData, userId, courseName, updatedAt: new Date() } },
    { upsert: true, new: true }
  );
  const cacheKey = `${courseName}`;
  await cache.set('skilltree', doc.toObject(), cacheKey);
  return doc;
}

async function getOrFetchQuestions(course, curriculumHash, skillNodeId, count = 5) {
  if (!curriculumHash) {
    const curriculum = await UploadedCurriculum.findOne({ courseTitle: course }).lean();
    if (curriculum) curriculumHash = curriculum.hash;
  }

  const existing = await QuestionBank.find({
    course,
    curriculumHash,
    skillNodeId
  }).lean();

  if (existing.length >= count) {
    const shuffled = existing.sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }

  return existing;
}

async function generateQuestions(course, curriculumHash, skillNodeId, questions) {
  if (!questions || questions.length === 0) return;
  const docs = questions.map(q => ({
    ...q,
    course,
    curriculumHash,
    skillNodeId
  }));
  await QuestionBank.insertMany(docs, { ordered: false });
}

async function getKnowledgeState(userId, course, conceptIds) {
  const cached = await cache.get('knowledge', userId, course);
  if (cached) return cached;

  const state = await StudentKnowledgeState.findOne({ userId }).lean();
  if (state) {
    await cache.set('knowledge', state, userId, course);
  }
  return state;
}

async function getAnalytics(userId, course) {
  const cached = await cache.get('analytics', userId, course);
  if (cached) return cached;

  const profile = await GamificationProfile.findOne({ userId }).lean();
  const knowledgeState = await StudentKnowledgeState.findOne({ userId }).lean();

  const analytics = {
    xp: profile?.totalXP || 0,
    level: profile?.level || 1,
    stars: profile?.totalStars || 0,
    streak: profile?.currentStreak || 0,
    completedCourses: profile?.completedCourses || [],
    weakAreas: knowledgeState?.currentFocusAreas || [],
    strongAreas: [],
    recommendations: []
  };

  await cache.set('analytics', analytics, userId, course);
  return analytics;
}

async function getResumeState(userId, course) {
  const cached = await cache.get('resume', userId, course);
  if (cached) return cached;

  const tree = await UserSkillTree.findOne({ userId, courseName: course }).lean();
  if (!tree) return null;

  const resume = {
    currentNode: null,
    unlockedNodes: (tree.nodes || []).filter(n => n.unlocked).map(n => n.id),
    masteredNodes: (tree.nodes || []).filter(n => n.mastered).map(n => n.id),
    currentModule: null,
    progress: tree.analytics?.completionPercentage || 0,
    mastery: tree.analytics?.masteryPercentage || 0,
    lastAccessed: tree.updatedAt,
    mapPosition: tree.resumeState?.mapPosition || { x: 0, y: 0, zoom: 1 },
    assessmentResult: tree.assessmentResult
  };

  await cache.set('resume', resume, userId, course);
  return resume;
}

async function preloadSkillTrees() {
  const preloadLog = [];
  const startTime = Date.now();
  const stats = { total: 0, cached: 0, mongoFound: 0, generated: 0, questionBanksGenerated: 0, failed: 0 };
  try {
    log.info('SKILL_TREE', 'Background skill tree preloader started...');
    const axios = require('axios');
    const protocol = process.env.PROTOCOL || 'http';
    const port = process.env.PORT || 5001;
    const baseUrl = `${protocol}://127.0.0.1:${port}/api`;

    let subjects = [];
    try {
      const res = await axios.get(`${baseUrl}/subjects`, { timeout: 10000 });
      subjects = res.data?.subjects || [];
    } catch {
      log.warn('SKILL_TREE', 'Could not fetch subjects from API, trying AdminDocument fallback');
      try {
        const AdminDocument = require('../models/AdminDocument');
        const docs = await AdminDocument.find({}).select('originalName').lean().catch(() => []);
        subjects = docs.map(d => d.originalName).filter(Boolean);
      } catch { /* ignore */ }
    }

    if (subjects.length === 0) {
      log.warn('SKILL_TREE', 'No subjects found for preloading.');
      return;
    }

    stats.total = subjects.length;
    log.info('SKILL_TREE', `Preloading assets for ${subjects.length} subjects...`);

    const adminId = '000000000000000000000000';

    for (const subject of subjects) {
      try {
        const cached = await cache.get('skilltree', subject);
        if (cached && cached.nodes && cached.nodes.length > 0) {
          stats.cached++;
          continue;
        }

        const mongoTree = await UserSkillTree.findOne({ courseName: subject }).lean();
        if (mongoTree) {
          await cache.set('skilltree', mongoTree, subject);
          stats.mongoFound++;
        }

        const modulesRes = await axios.get(`${baseUrl}/curriculum?course=${encodeURIComponent(subject)}`, { timeout: 10000 }).catch(() => null);
        const modules = modulesRes?.data?.modules || modulesRes?.data?.curriculum?.modules || [];

        const treeRes = await axios.post(`${baseUrl}/skill-tree/generate`, {
          source: 'course', courseName: subject, modules
        }, { timeout: 60000, headers: { 'x-auth-user-id': adminId } }).catch(() => null);

        if (treeRes?.data?.skillTree) {
          stats.generated++;
          preloadLog.push(`Generated skill tree for "${subject}"`);

          const treeId = treeRes.data.skillTree._id;
          const questionBankCount = await QuestionBank.countDocuments({ course: subject }).catch(() => 0);
          if (questionBankCount < 5) {
            const assessRes = await axios.post(`${baseUrl}/skill-tree/assessment`, { treeId }, { timeout: 30000, headers: { 'x-auth-user-id': adminId } }).catch(() => null);
            if (assessRes?.data?.questions?.length > 0) {
              stats.questionBanksGenerated++;
              preloadLog.push(`Generated question bank for "${subject}"`);
            }
          }
        } else {
          stats.failed++;
          preloadLog.push(`Could not generate "${subject}"`);
        }
      } catch (e) {
        stats.failed++;
        preloadLog.push(`Error for "${subject}": ${e.message}`);
      }
    }

    const elapsed = Date.now() - startTime;
    log.success('SKILL_TREE', `Preloader finished in ${elapsed}ms: ${stats.total} courses, ${stats.cached} cached, ${stats.mongoFound} mongo, ${stats.generated} generated, ${stats.questionBanksGenerated} qbanks, ${stats.failed} failed`);
  } catch (error) {
    log.warn('SKILL_TREE', `Preloader error: ${error.message}`);
  }
}

async function validateAllCourses() {
  const startTime = Date.now();
  const report = { total: 0, skillTreesAvailable: 0, questionBanksAvailable: 0, assessmentsAvailable: 0, analyticsAvailable: 0, cacheHits: 0, assetsRegenerated: 0, assetsReused: 0, repairs: [] };

  try {
    const axios = require('axios');
    const protocol = process.env.PROTOCOL || 'http';
    const port = process.env.PORT || 5001;
    const baseUrl = `${protocol}://127.0.0.1:${port}/api`;

    const res = await axios.get(`${baseUrl}/subjects`, { timeout: 10000 }).catch(() => ({ data: { subjects: [] } }));
    const subjects = res.data?.subjects || [];

    report.total = subjects.length;
    log.info('VALIDATION', `Validating ${subjects.length} courses...`);

    for (const subject of subjects) {
      const courseReport = { subject, skillTree: false, questionBank: false, assessment: false, analytics: false, tutor: false, resume: false };

      const cached = await cache.get('skilltree', subject);
      if (cached) {
        report.cacheHits++;
        courseReport.skillTree = true;
        courseReport.analytics = !!(cached.analytics);
        courseReport.resume = !!(cached.resumeState);
      }

      const mongoTree = await UserSkillTree.findOne({ courseName: subject }).lean();
      if (mongoTree) {
        courseReport.skillTree = true;
        if (!cached) await cache.set('skilltree', mongoTree, subject);
        courseReport.analytics = !!(mongoTree.analytics);
        courseReport.resume = !!(mongoTree.resumeState);
        if (mongoTree.assessmentResult) courseReport.assessment = true;
      }

      if (!courseReport.skillTree) {
        log.warn('VALIDATION', `Missing skill tree for "${subject}" - repairing`);
        try {
          const modulesRes = await axios.get(`${baseUrl}/curriculum?course=${encodeURIComponent(subject)}`, { timeout: 10000 }).catch(() => null);
          const modules = modulesRes?.data?.modules || [];
          const treeRes = await axios.post(`${baseUrl}/skill-tree/generate`, { source: 'course', courseName: subject, modules }, { timeout: 60000 }).catch(() => null);
          if (treeRes?.data?.skillTree) {
            courseReport.skillTree = true;
            report.assetsRegenerated++;
            report.repairs.push(`Regenerated skill tree for "${subject}"`);
          }
        } catch (e) { /* ignore */ }
      } else {
        report.assetsReused++;
        report.skillTreesAvailable++;
      }

      if (courseReport.skillTree) report.skillTreesAvailable++;

      const qbCount = await QuestionBank.countDocuments({ course: subject }).catch(() => 0);
      if (qbCount >= 3) {
        courseReport.questionBank = true;
        report.questionBanksAvailable++;
        if (courseReport.skillTree) report.assessmentsAvailable++;
      } else if (courseReport.skillTree) {
        report.repairs.push(`Missing question bank for "${subject}" (${qbCount} found)`);
      }

      if (courseReport.analytics) report.analyticsAvailable++;
    }

    report.elapsed = Date.now() - startTime;
    log.success('VALIDATION', JSON.stringify(report, null, 2));
    return report;
  } catch (error) {
    log.warn('VALIDATION', `Validation error: ${error.message}`);
    return report;
  }
}

module.exports = {
  getSkillTree, saveSkillTree,
  getOrFetchQuestions, generateQuestions,
  getKnowledgeState, getAnalytics, getResumeState,
  preloadSkillTrees, validateAllCourses
};
