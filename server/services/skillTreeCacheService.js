const { redisClient } = require('../config/redisClient');
const log = require('../utils/logger');

const CACHE_TTL = 86400 * 7;

function makeKey(prefix, ...parts) {
  return `${prefix}:${parts.filter(Boolean).join(':')}`;
}

function isReady() {
  return redisClient && redisClient.isOpen;
}

async function get(prefix, ...parts) {
  try {
    if (!isReady()) return null;
    const val = await redisClient.get(makeKey(prefix, ...parts));
    return val ? JSON.parse(val) : null;
  } catch (e) {
    log.debug('CACHE', `Redis get failed: ${e.message}`);
    return null;
  }
}

async function set(prefix, data, ...parts) {
  try {
    if (!isReady()) return;
    await redisClient.setEx(makeKey(prefix, ...parts), CACHE_TTL, JSON.stringify(data));
  } catch (e) {
    log.debug('CACHE', `Redis set failed: ${e.message}`);
  }
}

async function del(prefix, ...parts) {
  try {
    if (!isReady()) return;
    await redisClient.del(makeKey(prefix, ...parts));
  } catch (e) {
    log.debug('CACHE', `Redis del failed: ${e.message}`);
  }
}

async function invalidateCourse(course) {
  try {
    if (!isReady()) return;
    const pattern = `${makeKey('skilltree', course)}*`;
    const keys = await redisClient.keys(pattern);
    if (keys.length > 0) await redisClient.del(keys);
  } catch (e) {
    log.debug('CACHE', `Redis invalidate failed: ${e.message}`);
  }
}

module.exports = { get, set, del, invalidateCourse, makeKey, CACHE_TTL };
