const axios = require('axios');
const User = require('../models/User');
const CourseAdapterMapping = require('../models/CourseAdapterMapping');
const { redisClient } = require('../config/redisClient');
const log = require('../utils/logger');

async function deleteRedisByPatterns(patterns = []) {
  const deletedKeys = [];
  if (!redisClient || !redisClient.isOpen) return deletedKeys;

  for (const pattern of patterns) {
    try {
      for await (const key of redisClient.scanIterator({ MATCH: pattern, COUNT: 100 })) {
        await redisClient.del(key);
        deletedKeys.push(key);
      }
    } catch (error) {
      log.warn('SYSTEM', `Redis pattern delete failed (${pattern}): ${error.message}`);
    }
  }

  return deletedKeys;
}

function buildCascadePatterns(courseName) {
  const encoded = encodeURIComponent(courseName);
  return {
    redisPatterns: [
      `curriculum:structure:${encoded}`,
      `curriculum:*${encoded}*`,
      `cache:*${encoded}*`,
    ],
    reasoningPatterns: [
      `reasoning_state:*${encoded}*`,
      `agent_state:*${encoded}*`,
    ]
  };
}

async function deleteCourseProgressFromUsers(courseName) {
  const users = await User.find({}).select('_id curriculumProgress');
  let updatedUsers = 0;

  for (const user of users) {
    if (!user.curriculumProgress || !user.curriculumProgress.has(courseName)) continue;
    user.curriculumProgress.delete(courseName);
    await user.save();
    updatedUsers += 1;
  }

  return updatedUsers;
}

async function safeCascadeDeleteCourse({ courseName, pythonServiceUrl = process.env.PYTHON_RAG_SERVICE_URL, initiatedByUserId = null }) {
  const result = {
    courseName,
    db: {
      userProgressRemoved: 0,
      adapterMappingsRemoved: 0,
    },
    graph: {
      deleted: false,
      response: null,
    },
    redis: {
      deletedKeys: [],
    },
    embeddings: {
      attempted: false,
      deleted: false,
    },
    reasoningCache: {
      deletedKeys: [],
    },
    errors: [],
  };

  try {
    result.db.userProgressRemoved = await deleteCourseProgressFromUsers(courseName);
  } catch (error) {
    result.errors.push(`DB progress cleanup failed: ${error.message}`);
  }

  try {
    const mappingResult = await CourseAdapterMapping.deleteMany({ courseId: courseName });
    result.db.adapterMappingsRemoved = Number(mappingResult?.deletedCount || 0);
  } catch (error) {
    result.errors.push(`Adapter mapping cleanup failed: ${error.message}`);
  }

  if (pythonServiceUrl) {
    try {
      const response = await axios.delete(`${pythonServiceUrl}/curriculum/${encodeURIComponent(courseName)}`, { timeout: 15000 });
      result.graph.deleted = true;
      result.graph.response = response.data;
    } catch (error) {
      result.errors.push(`Graph deletion failed: ${error.response?.data?.error || error.message}`);
    }

    try {
      result.embeddings.attempted = true;
      await axios.delete(
        `${pythonServiceUrl}/delete_qdrant_document_data`,
        {
          data: {
            user_id: initiatedByUserId || 'system',
            document_name: courseName,
          },
          timeout: 10000
        }
      );
      result.embeddings.deleted = true;
    } catch (error) {
      result.errors.push(`Embeddings cleanup skipped/failed: ${error.response?.data?.error || error.message}`);
    }
  }

  try {
    const patterns = buildCascadePatterns(courseName);
    result.redis.deletedKeys = await deleteRedisByPatterns(patterns.redisPatterns);
  } catch (error) {
    result.errors.push(`Redis curriculum cleanup failed: ${error.message}`);
  }

  try {
    const patterns = buildCascadePatterns(courseName);
    result.reasoningCache.deletedKeys = await deleteRedisByPatterns(patterns.reasoningPatterns);
  } catch (error) {
    result.errors.push(`Reasoning cache cleanup failed: ${error.message}`);
  }

  log.info('SYSTEM', `safeCascadeDeleteCourse result: ${JSON.stringify(result)}`);
  return result;
}

module.exports = {
  safeCascadeDeleteCourse,
  buildCascadePatterns,
};
