// server/middleware/cacheMiddleware.js
const { redisClient } = require('../config/redisClient');

const cacheMiddleware = (durationInSeconds) => async (req, res, next) => {
    if (!redisClient || !redisClient.isOpen || req.method !== 'GET') {
        return next();
    }

    // Normalize URL for better cache hit-rate:
    // - include path
    // - include only stable query params
    // - ignore volatile params (timestamps, ids, message counters, etc.)
    const stableParams = [];

    const volatileParamRe = /^(sessionId|messageCount|t|timestamp|nonce|tracking|utm_|cacheBuster)$/i;


    for (const [k, v] of Object.entries(req.query || {})) {
        if (volatileParamRe.test(k)) continue;
        // Skip empty/undefined
        if (v === undefined || v === null || v === '') continue;
        stableParams.push([k, Array.isArray(v) ? v.join(',') : String(v)]);
    }

    stableParams.sort((a, b) => a[0].localeCompare(b[0]));
    const queryPart = stableParams.map(([k, v]) => `${k}=${v}`).join('&');

    // Prevent cross-user cache bleed for authenticated endpoints
    const userPart = req.user?.id || req.user?._id || 'anon';
    const key = `__express__${req.path}?${queryPart}|user:${userPart}`;
    try {
        const cachedResponse = await redisClient.get(key);
        if (cachedResponse) {
            res.setHeader('X-Cache', 'HIT');
            res.send(JSON.parse(cachedResponse));
            return;
        }

        res.setHeader('X-Cache', 'MISS');
        const originalSend = res.send;

        res.send = (body) => {
            // Only cache successful 2xx responses
            if (res.statusCode >= 200 && res.statusCode < 300) {
                redisClient.setEx(key, durationInSeconds, JSON.stringify(body)).catch(err => {
                    console.error(`Redis SETEX error for key ${key}:`, err);
                });
            }
            return originalSend.call(res, body);
        };
        next();
    } catch (err) {
        console.error('Redis cache middleware error:', err);
        next();
    }
};

module.exports = { cacheMiddleware };