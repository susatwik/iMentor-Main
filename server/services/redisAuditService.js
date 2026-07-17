const { redisClient } = require('../config/redisClient');
const log = require('../utils/logger');

async function keyExists(key) {
  if (!redisClient || !redisClient.isOpen) return false;
  try {
    const exists = await redisClient.exists(key);
    return exists === 1;
  } catch (err) {
    log.warn('SYSTEM', `Redis exists check failed for key ${key}: ${err.message}`);
    return false;
  }
}

async function auditRedisUsage() {
  const status = {
    redisAvailable: Boolean(redisClient && redisClient.isOpen),
    sessionState: false,
    reasoningState: false,
    courseGraphCache: false,
    modelRoutingCache: false,
  };

  if (!status.redisAvailable) {
    log.warn('SYSTEM', 'Redis usage audit skipped (Redis unavailable)');
    return status;
  }

  status.courseGraphCache = await keyExists('curriculum:courses');
  status.modelRoutingCache = await keyExists('router:model:audit-placeholder');

  try {
    for await (const _ of redisClient.scanIterator({ MATCH: 'tutor:sm:*', COUNT: 5 })) {
      status.sessionState = true;
      break;
    }

    if (!status.sessionState) {
    for await (const _ of redisClient.scanIterator({ MATCH: 'tutor:session:*', COUNT: 5 })) {
      status.sessionState = true;
      break;
    }
    }
  } catch (err) {
    log.warn('SYSTEM', `Redis tutor session scan failed: ${err.message}`);
  }

  try {
    for await (const _ of redisClient.scanIterator({ MATCH: 'reasoning_state:*', COUNT: 5 })) {
      status.reasoningState = true;
      break;
    }
  } catch (err) {
    log.warn('SYSTEM', `Redis reasoning-state scan failed: ${err.message}`);
  }

  log.info('SYSTEM', 'Redis usage audit:', status);
  return status;
}

module.exports = {
  auditRedisUsage,
};
