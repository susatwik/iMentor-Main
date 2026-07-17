const log = require('../utils/logger');

function createPerformanceTracker(meta = {}) {
  const buckets = {
    routingTime: 0,
    llmTime: 0,
    toolTime: 0,
    dbTime: 0,
    redisTime: 0,
  };
  const startedAt = Date.now();

  const add = (key, ms) => {
    if (!Number.isFinite(ms) || ms < 0) return;
    buckets[key] += ms;
  };

  return {
    addRouting(ms) {
      add('routingTime', ms);
    },
    addLlm(ms) {
      add('llmTime', ms);
    },
    addTool(ms) {
      add('toolTime', ms);
    },
    addDb(ms) {
      add('dbTime', ms);
    },
    addRedis(ms) {
      add('redisTime', ms);
    },
    merge(snapshot = {}) {
      add('routingTime', Number(snapshot.routingTime) || 0);
      add('llmTime', Number(snapshot.llmTime) || 0);
      add('toolTime', Number(snapshot.toolTime) || 0);
      add('dbTime', Number(snapshot.dbTime) || 0);
      add('redisTime', Number(snapshot.redisTime) || 0);
    },
    toLogPayload(extra = {}) {
      return {
        routingTime: buckets.routingTime,
        llmTime: buckets.llmTime,
        toolTime: buckets.toolTime,
        dbTime: buckets.dbTime,
        redisTime: buckets.redisTime,
        totalTime: Date.now() - startedAt,
        ...meta,
        ...extra,
      };
    }
  };
}

function logPerformance({ routingTime = 0, llmTime = 0, toolTime = 0, dbTime = 0, redisTime = 0, totalTime = 0, ...meta }) {
  const payload = {
    routingTime,
    llmTime,
    toolTime,
    dbTime,
    redisTime,
    totalTime,
  };

  log.info('PERF', `logPerformance ${JSON.stringify(payload)}${Object.keys(meta).length ? ` meta=${JSON.stringify(meta)}` : ''}`);
  return payload;
}

module.exports = {
  createPerformanceTracker,
  logPerformance,
};
