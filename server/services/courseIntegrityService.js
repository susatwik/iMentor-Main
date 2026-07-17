const axios = require('axios');
const AdminDocument = require('../models/AdminDocument');
const { redisClient } = require('../config/redisClient');
const log = require('../utils/logger');

function computeIntegrityDiff(dbCourses = [], graphCourses = [], redisCourses = []) {
  const dbSet = new Set(dbCourses);
  const graphSet = new Set(graphCourses);
  const redisSet = new Set(redisCourses);

  return {
    missingInGraph: dbCourses.filter(c => !graphSet.has(c)),
    staleInGraph: graphCourses.filter(c => !dbSet.has(c)),
    missingInRedis: dbCourses.filter(c => !redisSet.has(c)),
    staleInRedis: redisCourses.filter(c => !dbSet.has(c)),
    emptyStructure: [] // populated by deep check
  };
}

async function fetchGraphCourses(pythonServiceUrl) {
  if (!pythonServiceUrl) return [];
  try {
    const response = await axios.get(`${pythonServiceUrl}/curriculum/courses`, { timeout: 5000 });
    if (response.data?.success && Array.isArray(response.data?.courses)) {
      return response.data.courses;
    }
  } catch (error) {
    log.warn('SYSTEM', `Course graph fetch failed: ${error.message}`);
  }
  return [];
}

/**
 * Deep-check: for each course in the graph, verify it has at least one module
 * with at least one topic. Returns a list of course names that are structurally empty.
 */
async function deepValidateCourses(pythonServiceUrl, graphCourses) {
  if (!pythonServiceUrl || graphCourses.length === 0) return [];
  const emptyStructure = [];
  for (const course of graphCourses) {
    try {
      const response = await axios.get(
        `${pythonServiceUrl}/curriculum/${encodeURIComponent(course)}/structure`,
        { timeout: 8000 }
      );
      const modules = response.data?.curriculum?.modules || response.data?.modules || [];
      const hasTopics = modules.some(m => Array.isArray(m.topics) && m.topics.length > 0);
      if (!hasTopics) {
        emptyStructure.push(course);
        log.warn('SYSTEM', `Deep validation: course '${course}' has no topics in graph.`);
      }
    } catch (err) {
      log.warn('SYSTEM', `Deep validation failed for '${course}': ${err.message}`);
    }
  }
  return emptyStructure;
}

async function readRedisCourses() {
  if (!redisClient || !redisClient.isOpen) return [];
  try {
    const raw = await redisClient.get('curriculum:courses');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeRedisCourses(courses) {
  if (!redisClient || !redisClient.isOpen) return;
  try {
    await redisClient.setEx('curriculum:courses', 3600, JSON.stringify(courses));
  } catch (error) {
    log.warn('SYSTEM', `Failed to refresh curriculum Redis cache: ${error.message}`);
  }
}

/**
 * Invalidate per-course Redis structure caches for the given list of courses.
 */
async function invalidateCurriculumCaches(courses = []) {
  if (!redisClient || !redisClient.isOpen || courses.length === 0) return 0;
  let deleted = 0;
  for (const course of courses) {
    try {
      deleted += await redisClient.del(`curriculum:structure:${encodeURIComponent(course)}`);
    } catch (e) {
      log.warn('SYSTEM', `Cache invalidation failed for '${course}': ${e.message}`);
    }
  }
  return deleted;
}

async function attemptGraphRepair({
  pythonServiceUrl,
  missingInGraph = [],
  staleInGraph = [],
  emptyStructure = [],
  dbCourses = [],
  allowGraphDelete = false,
}) {
  const repair = {
    removedStale: [],
    staleDeletionSkipped: [],
    attemptedRebuild: false,
    rebuildReport: null,
    cacheKeysInvalidated: 0
  };

  if (!pythonServiceUrl) return repair;

  // --- Remove stale courses from the graph (opt-in only) ---
  if (allowGraphDelete && dbCourses.length > 0) {
    for (const staleCourse of staleInGraph) {
      try {
        await axios.delete(`${pythonServiceUrl}/curriculum/${encodeURIComponent(staleCourse)}`, { timeout: 8000 });
        repair.removedStale.push(staleCourse);
        log.info('SYSTEM', `Removed stale graph course: '${staleCourse}'`);
      } catch (error) {
        log.warn('SYSTEM', `Failed removing stale graph course '${staleCourse}': ${error.message}`);
      }
    }
  } else if (staleInGraph.length > 0) {
    repair.staleDeletionSkipped = [...staleInGraph];
    log.warn('SYSTEM', `Skipped stale graph deletion for safety (allowGraphDelete=${allowGraphDelete}, dbCourses=${dbCourses.length}).`);
  }

  // --- Attempt rebuild validation for missing or empty courses ---
  const coursesToCheck = [...new Set([...missingInGraph, ...emptyStructure])];
  if (coursesToCheck.length > 0) {
    repair.attemptedRebuild = true;
    try {
      // POST /curriculum/rebuild now exists — validates graph and reports which courses
      // need a fresh CSV upload via /curriculum/upload.
      const rebuildResponse = await axios.post(
        `${pythonServiceUrl}/curriculum/rebuild`,
        { courses: dbCourses },
        { timeout: 30000 }
      );
      repair.rebuildReport = rebuildResponse.data;
      if (repair.rebuildReport?.missing?.length > 0 || repair.rebuildReport?.emptyStructure?.length > 0) {
        log.warn('SYSTEM', `Courses needing re-upload: ${JSON.stringify(repair.rebuildReport.missing || [])} | empty: ${JSON.stringify(repair.rebuildReport.emptyStructure || [])}`);
      }
    } catch (rebuildError) {
      log.warn('SYSTEM', `Graph rebuild check unavailable: ${rebuildError.message}`);
    }
  }

  // --- Invalidate Redis caches for repaired/stale/empty courses ---
  const toInvalidate = [...repair.removedStale, ...emptyStructure, ...missingInGraph];
  repair.cacheKeysInvalidated = await invalidateCurriculumCaches(toInvalidate);

  return repair;
}

async function verifyCoursesIntegrity({
  pythonServiceUrl = process.env.PYTHON_RAG_SERVICE_URL,
  allowGraphDelete = process.env.ENABLE_COURSE_INTEGRITY_DELETE === 'true',
} = {}) {
  const startedAt = Date.now();
  const dbCourses = await AdminDocument.distinct('originalName');
  let graphCourses = await fetchGraphCourses(pythonServiceUrl);
  const redisCourses = await readRedisCourses();

  const diff = computeIntegrityDiff(dbCourses, graphCourses, redisCourses);

  // Deep structure validation: detect courses that exist in Neo4j but have no topics
  diff.emptyStructure = await deepValidateCourses(pythonServiceUrl, graphCourses);

  const hasMismatch = diff.missingInGraph.length > 0
    || diff.staleInGraph.length > 0
    || diff.missingInRedis.length > 0
    || diff.staleInRedis.length > 0
    || diff.emptyStructure.length > 0;

  let repair = { removedStale: [], attemptedRebuild: false, cacheKeysInvalidated: 0 };
  if (hasMismatch) {
    log.warn('SYSTEM', 'Course integrity mismatch detected:', diff);
    repair = await attemptGraphRepair({
      pythonServiceUrl,
      missingInGraph: diff.missingInGraph,
      staleInGraph: diff.staleInGraph,
      emptyStructure: diff.emptyStructure,
      dbCourses,
      allowGraphDelete,
    });

    // Refresh graph courses after repair attempt before updating Redis cache.
    graphCourses = await fetchGraphCourses(pythonServiceUrl);
    log.info('SYSTEM', 'Course integrity repair attempted:', repair);
  }

  // IMPORTANT: curriculum:courses cache must reflect Neo4j curriculum graph courses,
  // not AdminDocument names. Writing DB document names here causes syllabus subjects
  // to disappear from UI after relog/startup.
  if (graphCourses.length > 0) {
    await writeRedisCourses(graphCourses);
  } else {
    log.warn('SYSTEM', 'Skipping curriculum:courses cache refresh because graphCourses is empty.');
  }

  const summary = {
    ok: !hasMismatch,
    dbCourseCount: dbCourses.length,
    graphCourseCount: graphCourses.length,
    redisCourseCount: redisCourses.length,
    mismatch: diff,
    repair,
    durationMs: Date.now() - startedAt,
  };

  log.info('SYSTEM', 'verifyCoursesIntegrity completed:', summary);
  return summary;
}

module.exports = {
  verifyCoursesIntegrity,
  computeIntegrityDiff,
  invalidateCurriculumCaches,
};
