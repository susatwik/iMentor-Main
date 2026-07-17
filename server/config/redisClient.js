// server/config/redisClient.js
const { createClient } = require('redis');
const log = require('../utils/logger');
const MemoryCache = require('../utils/memoryCache');
const dotenv = require('dotenv');
dotenv.config();

const redisUrl = process.env.REDIS_URL;
let redisClient = null;
let fallbackCache = null;

if (!redisUrl) {
    log.warn('REDIS', "REDIS_URL not found in .env, using in-memory cache fallback.");
    fallbackCache = new MemoryCache(5000); // 5000 key limit
    redisClient = fallbackCache;
} else {
    redisClient = createClient({ 
        url: redisUrl,
        socket: {
            reconnectStrategy: (retries) => Math.min(retries * 100, 3000)
        }
    });

    if (redisClient) {
        redisClient.on('error', (err) => {
            if (err.code !== 'ECONNREFUSED') {
                log.error('REDIS', 'Redis Client Error', err);
            } else {
                log.warn('REDIS', 'Connection refused - will use in-memory fallback');
                fallbackCache = new MemoryCache(5000);
                redisClient = fallbackCache;
            }
        });
        redisClient.on('connect', () => log.success('REDIS', 'Redis client connected successfully.'));
        redisClient.on('reconnecting', () => log.info('REDIS', 'Redis client is reconnecting...'));
    }
}

const connectRedis = async () => {
    if (!redisClient) {
        log.warn('REDIS', 'No Redis client configured');
        return;
    }

    // If using memory fallback, just ping
    if (fallbackCache === redisClient) {
        log.info('REDIS', 'Using in-memory cache fallback (Redis not available)');
        await redisClient.ping();
        return;
    }

    // Otherwise connect to Redis
    if (redisClient && !redisClient.isOpen) {
        try {
            log.info('REDIS', 'Attempting to connect to Redis...');
            await redisClient.connect();
        } catch (err) {
            log.warn('REDIS', 'Failed to connect to Redis, switching to in-memory fallback');
            if (!fallbackCache) {
                fallbackCache = new MemoryCache(5000);
            }
            redisClient = fallbackCache;
        }
    }
};

module.exports = { redisClient, connectRedis, MemoryCache };
