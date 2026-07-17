/**
 * server/utils/memoryCache.js
 * 
 * In-Memory Cache Fallback
 * 
 * Provides a drop-in replacement for Redis when it's unavailable
 * Used during local development when Redis is not running
 * 
 * Features:
 * - TTL support (automatic expiration)
 * - LRU eviction when memory limit reached
 * - JSON serialization for compatibility
 * - Promise-based API (compatible with redis client)
 */

class MemoryCache {
    constructor(maxSize = 1000, ttlCheckInterval = 60000) {
        this.store = new Map();
        this.maxSize = maxSize;
        this.ttl = new Map(); // Expiration times
        this.accessTimes = new Map(); // For LRU
        this.stats = {
            hits: 0,
            misses: 0,
            sets: 0,
            deletes: 0
        };

        // Periodically clean up expired keys
        this.cleanupInterval = setInterval(() => this.cleanup(), ttlCheckInterval);
    }

    /**
     * Set a key with optional TTL (in seconds)
     */
    async set(key, value, ttl = null) {
        // Enforce size limit with LRU eviction
        if (this.store.size >= this.maxSize && !this.store.has(key)) {
            this.evictLRU();
        }

        // Store JSON-serialized value
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        this.store.set(key, serialized);
        this.accessTimes.set(key, Date.now());

        if (ttl) {
            this.ttl.set(key, Date.now() + ttl * 1000);
        } else {
            this.ttl.delete(key);
        }

        this.stats.sets++;
        return 'OK';
    }

    /**
     * Get a key (returns null if expired or not found)
     */
    async get(key) {
        // Check if expired
        const expiresAt = this.ttl.get(key);
        if (expiresAt && Date.now() > expiresAt) {
            this.store.delete(key);
            this.ttl.delete(key);
            this.stats.misses++;
            return null;
        }

        const value = this.store.get(key);
        if (value === undefined) {
            this.stats.misses++;
            return null;
        }

        this.accessTimes.set(key, Date.now());
        this.stats.hits++;
        return value;
    }

    /**
     * Delete a key
     */
    async del(key) {
        const existed = this.store.has(key);
        this.store.delete(key);
        this.ttl.delete(key);
        this.accessTimes.delete(key);
        if (existed) this.stats.deletes++;
        return existed ? 1 : 0;
    }

    /**
     * Check if key exists
     */
    async exists(key) {
        // Check expiration first
        const expiresAt = this.ttl.get(key);
        if (expiresAt && Date.now() > expiresAt) {
            this.store.delete(key);
            this.ttl.delete(key);
            return 0;
        }
        return this.store.has(key) ? 1 : 0;
    }

    /**
     * Get all keys matching pattern
     */
    async keys(pattern) {
        const regex = new RegExp(pattern.replace(/\*/g, '.*'));
        const results = [];

        for (const key of this.store.keys()) {
            // Check expiration
            const expiresAt = this.ttl.get(key);
            if (expiresAt && Date.now() > expiresAt) {
                this.store.delete(key);
                this.ttl.delete(key);
                continue;
            }

            if (regex.test(key)) {
                results.push(key);
            }
        }

        return results;
    }

    /**
     * Increment a numeric value
     */
    async incr(key) {
        let value = 0;
        const current = this.store.get(key);
        if (current !== undefined) {
            value = parseInt(current, 10);
        }
        value++;
        await this.set(key, String(value));
        return value;
    }

    /**
     * Increment by amount
     */
    async incrby(key, amount) {
        let value = 0;
        const current = this.store.get(key);
        if (current !== undefined) {
            value = parseInt(current, 10);
        }
        value += amount;
        await this.set(key, String(value));
        return value;
    }

    /**
     * Get multiple keys
     */
    async mget(keys) {
        return Promise.all(keys.map(key => this.get(key)));
    }

    /**
     * Set multiple keys
     */
    async mset(keyValues) {
        const entries = [];
        for (let i = 0; i < keyValues.length; i += 2) {
            entries.push([keyValues[i], keyValues[i + 1]]);
        }
        for (const [key, value] of entries) {
            await this.set(key, value);
        }
        return 'OK';
    }

    /**
     * Expire a key in N seconds
     */
    async expire(key, ttl) {
        if (!this.store.has(key)) return 0;
        this.ttl.set(key, Date.now() + ttl * 1000);
        return 1;
    }

    /**
     * Get remaining TTL (in seconds)
     */
    async ttl(key) {
        const expiresAt = this.ttl.get(key);
        if (!expiresAt) return -1;

        const remaining = expiresAt - Date.now();
        return remaining > 0 ? Math.ceil(remaining / 1000) : -2;
    }

    /**
     * Clear all keys
     */
    async flushall() {
        this.store.clear();
        this.ttl.clear();
        this.accessTimes.clear();
        return 'OK';
    }

    /**
     * Get cache stats
     */
    getStats() {
        const hitRate = this.stats.hits + this.stats.misses > 0
            ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2)
            : 0;

        return {
            ...this.stats,
            hitRate: `${hitRate}%`,
            size: this.store.size,
            maxSize: this.maxSize
        };
    }

    /**
     * Remove least recently used item
     * @private
     */
    evictLRU() {
        let lruKey = null;
        let lruTime = Infinity;

        for (const [key, time] of this.accessTimes.entries()) {
            if (time < lruTime) {
                lruTime = time;
                lruKey = key;
            }
        }

        if (lruKey) {
            this.store.delete(lruKey);
            this.ttl.delete(lruKey);
            this.accessTimes.delete(lruKey);
        }
    }

    /**
     * Remove expired keys
     * @private
     */
    cleanup() {
        let removed = 0;
        const now = Date.now();

        for (const [key, expiresAt] of this.ttl.entries()) {
            if (now > expiresAt) {
                this.store.delete(key);
                this.ttl.delete(key);
                this.accessTimes.delete(key);
                removed++;
            }
        }

        return removed;
    }

    /**
     * Stop cleanup interval
     */
    destroy() {
        clearInterval(this.cleanupInterval);
    }

    /**
     * Provide compatibility with redis client methods
     */
    ping() {
        return Promise.resolve('PONG');
    }

    on(event, callback) {
        // No-op for compatibility
    }

    once(event, callback) {
        // No-op for compatibility
    }

    removeListener(event, callback) {
        // No-op for compatibility
    }

    connect() {
        return Promise.resolve();
    }

    disconnect() {
        this.destroy();
        return Promise.resolve();
    }
}

module.exports = MemoryCache;
/**
 * server/utils/memoryCache.js
 * 
 * In-Memory Cache Fallback
 * 
 * Provides a drop-in replacement for Redis when it's unavailable
 * Used during local development when Redis is not running
 * 
 * Features:
 * - TTL support (automatic expiration)
 * - LRU eviction when memory limit reached
 * - JSON serialization for compatibility
 * - Promise-based API (compatible with redis client)
 */

class MemoryCache {
    constructor(maxSize = 1000, ttlCheckInterval = 60000) {
        this.store = new Map();
        this.maxSize = maxSize;
        this.ttl = new Map(); // Expiration times
        this.accessTimes = new Map(); // For LRU
        this.stats = {
            hits: 0,
            misses: 0,
            sets: 0,
            deletes: 0
        };

        // Periodically clean up expired keys
        this.cleanupInterval = setInterval(() => this.cleanup(), ttlCheckInterval);
    }

    /**
     * Set a key with optional TTL (in seconds)
     */
    async set(key, value, ttl = null) {
        // Enforce size limit with LRU eviction
        if (this.store.size >= this.maxSize && !this.store.has(key)) {
            this.evictLRU();
        }

        // Store JSON-serialized value
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        this.store.set(key, serialized);
        this.accessTimes.set(key, Date.now());

        if (ttl) {
            this.ttl.set(key, Date.now() + ttl * 1000);
        } else {
            this.ttl.delete(key);
        }

        this.stats.sets++;
        return 'OK';
    }

    /**
     * Get a key (returns null if expired or not found)
     */
    async get(key) {
        // Check if expired
        const expiresAt = this.ttl.get(key);
        if (expiresAt && Date.now() > expiresAt) {
            this.store.delete(key);
            this.ttl.delete(key);
            this.stats.misses++;
            return null;
        }

        const value = this.store.get(key);
        if (value === undefined) {
            this.stats.misses++;
            return null;
        }

        this.accessTimes.set(key, Date.now());
        this.stats.hits++;
        return value;
    }

    /**
     * Delete a key
     */
    async del(key) {
        const existed = this.store.has(key);
        this.store.delete(key);
        this.ttl.delete(key);
        this.accessTimes.delete(key);
        if (existed) this.stats.deletes++;
        return existed ? 1 : 0;
    }

    /**
     * Check if key exists
     */
    async exists(key) {
        // Check expiration first
        const expiresAt = this.ttl.get(key);
        if (expiresAt && Date.now() > expiresAt) {
            this.store.delete(key);
            this.ttl.delete(key);
            return 0;
        }
        return this.store.has(key) ? 1 : 0;
    }

    /**
     * Get all keys matching pattern
     */
    async keys(pattern) {
        const regex = new RegExp(pattern.replace(/\*/g, '.*'));
        const results = [];

        for (const key of this.store.keys()) {
            // Check expiration
            const expiresAt = this.ttl.get(key);
            if (expiresAt && Date.now() > expiresAt) {
                this.store.delete(key);
                this.ttl.delete(key);
                continue;
            }

            if (regex.test(key)) {
                results.push(key);
            }
        }

        return results;
    }

    /**
     * Increment a numeric value
     */
    async incr(key) {
        let value = 0;
        const current = this.store.get(key);
        if (current !== undefined) {
            value = parseInt(current, 10);
        }
        value++;
        await this.set(key, String(value));
        return value;
    }

    /**
     * Increment by amount
     */
    async incrby(key, amount) {
        let value = 0;
        const current = this.store.get(key);
        if (current !== undefined) {
            value = parseInt(current, 10);
        }
        value += amount;
        await this.set(key, String(value));
        return value;
    }

    /**
     * Get multiple keys
     */
    async mget(keys) {
        return Promise.all(keys.map(key => this.get(key)));
    }

    /**
     * Set multiple keys
     */
    async mset(keyValues) {
        const entries = [];
        for (let i = 0; i < keyValues.length; i += 2) {
            entries.push([keyValues[i], keyValues[i + 1]]);
        }
        for (const [key, value] of entries) {
            await this.set(key, value);
        }
        return 'OK';
    }

    /**
     * Expire a key in N seconds
     */
    async expire(key, ttl) {
        if (!this.store.has(key)) return 0;
        this.ttl.set(key, Date.now() + ttl * 1000);
        return 1;
    }

    /**
     * Get remaining TTL (in seconds)
     */
    async ttl(key) {
        const expiresAt = this.ttl.get(key);
        if (!expiresAt) return -1;

        const remaining = expiresAt - Date.now();
        return remaining > 0 ? Math.ceil(remaining / 1000) : -2;
    }

    /**
     * Clear all keys
     */
    async flushall() {
        this.store.clear();
        this.ttl.clear();
        this.accessTimes.clear();
        return 'OK';
    }

    /**
     * Get cache stats
     */
    getStats() {
        const hitRate = this.stats.hits + this.stats.misses > 0
            ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2)
            : 0;

        return {
            ...this.stats,
            hitRate: `${hitRate}%`,
            size: this.store.size,
            maxSize: this.maxSize
        };
    }

    /**
     * Remove least recently used item
     * @private
     */
    evictLRU() {
        let lruKey = null;
        let lruTime = Infinity;

        for (const [key, time] of this.accessTimes.entries()) {
            if (time < lruTime) {
                lruTime = time;
                lruKey = key;
            }
        }

        if (lruKey) {
            this.store.delete(lruKey);
            this.ttl.delete(lruKey);
            this.accessTimes.delete(lruKey);
        }
    }

    /**
     * Remove expired keys
     * @private
     */
    cleanup() {
        let removed = 0;
        const now = Date.now();

        for (const [key, expiresAt] of this.ttl.entries()) {
            if (now > expiresAt) {
                this.store.delete(key);
                this.ttl.delete(key);
                this.accessTimes.delete(key);
                removed++;
            }
        }

        return removed;
    }

    /**
     * Stop cleanup interval
     */
    destroy() {
        clearInterval(this.cleanupInterval);
    }

    /**
     * Provide compatibility with redis client methods
     */
    ping() {
        return Promise.resolve('PONG');
    }

    on(event, callback) {
        // No-op for compatibility
    }

    once(event, callback) {
        // No-op for compatibility
    }

    removeListener(event, callback) {
        // No-op for compatibility
    }

    connect() {
        return Promise.resolve();
    }

    disconnect() {
        this.destroy();
        return Promise.resolve();
    }
}

module.exports = MemoryCache;
