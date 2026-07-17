const rateLimit = require('express-rate-limit');

const RATE_LIMIT_ERROR_RESPONSE = {
  success: false,
  error: 'Too many requests. Please try again later.'
};

/**
 * Create a rate limiter with Redis-backed store for horizontal scaling.
 * Falls back to in-memory store if Redis or rate-limit-redis is unavailable.
 */
const createLimiter = (maxRequestsPerMinute, prefix = 'rl') => {
  const options = {
    windowMs: 60 * 1000,
    max: maxRequestsPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    message: RATE_LIMIT_ERROR_RESPONSE,
    validate: false,
    keyGenerator: (req) => {
      // Use userId if authenticated, otherwise fall back to IP
      return req.user?.userId || req.ip;
    }
  };

  // Attempt to use Redis-backed store for multi-instance deployments
  try {
    const { RedisStore } = require('rate-limit-redis');
    const { redisClient } = require('../config/redisClient');
    if (redisClient && redisClient.isOpen) {
      options.store = new RedisStore({
        sendCommand: (...args) => redisClient.sendCommand(args),
        prefix: `rate-limit:${prefix}:`
      });
    }
  } catch (e) {
    // rate-limit-redis not installed or Redis unavailable — using in-memory store
    // This is acceptable for single-instance deployments
  }

  return rateLimit(options);
};

const authLimiter = createLimiter(30, 'auth');
const chatLimiter = createLimiter(60, 'chat');
const researchLimiter = createLimiter(5, 'research');
const toolsLimiter = createLimiter(5, 'tools');
// STT/Whisper: tight limit to protect GPU — keyed by userId (auth'd) or IP (guest)
const sttLimiter = createLimiter(6, 'stt');

module.exports = {
  authLimiter,
  chatLimiter,
  researchLimiter,
  toolsLimiter,
  sttLimiter
};
