// server/services/routingCache.js

const { redisClient } = require("../config/redisClient");

const memoryCache = new Map();

async function getCachedRoute(query) {
    const key = `route:${query.toLowerCase().trim()}`;
    if (redisClient && redisClient.isOpen) {
        try {
            return await redisClient.get(key);
        } catch (err) {
            console.error("[RoutingCache] Redis get error:", err);
        }
    }
    return memoryCache.get(key);
}

async function setCachedRoute(query, route) {
    const key = `route:${query.toLowerCase().trim()}`;
    if (redisClient && redisClient.isOpen) {
        try {
            await redisClient.set(key, route, {
                EX: 3600 // 1 hour
            });
        } catch (err) {
            console.error("[RoutingCache] Redis set error:", err);
        }
    } else {
        memoryCache.set(key, route);
        setTimeout(() => memoryCache.delete(key), 3600000);
    }
}

module.exports = { getCachedRoute, setCachedRoute };

