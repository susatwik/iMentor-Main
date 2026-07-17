/**
 * server/utils/startupServices.js
 * 
 * Graceful fallback handling for optional services
 * 
 * Ensures the server starts successfully even if:
 * - Redis is unavailable (uses in-memory cache fallback)
 * - Qdrant is unavailable (disables vector retrieval)
 * - Neo4j is unavailable (skips graph features)
 * - Elasticsearch is unavailable (disables full-text search)
 * - Python RAG service is unavailable (uses fallback modes)
 * - SGLang is unavailable (falls back to Gemini/Groq/Ollama)
 * 
 * CRITICAL: Do NOT crash the server for optional service failures
 */

const axios = require('axios');
const log = require('./logger');

// Service availability flags (checked at startup, updated dynamically)
const SERVICE_STATUS = {
    redis: { available: false, reason: null },
    neo4j: { available: false, reason: null },
    qdrant: { available: false, reason: null },
    elasticsearch: { available: false, reason: null },
    pythonRag: { available: false, reason: null },
    sglang: { available: false, reason: null },
    gemini: { available: false, reason: null },
    groq: { available: false, reason: null }
};

/**
 * Check all optional services at startup
 * Returns immediately without blocking server startup on failures
 */
async function checkOptionalServices() {
    log.info('SYSTEM', '=== Checking Optional Services (Non-blocking) ===');

    // Check each service in parallel, but don't await all (some may timeout)
    const checks = [
        checkRedis(),
        checkNeo4j(),
        checkQdrant(),
        checkElasticsearch(),
        checkPythonRag(),
        checkSGLang(),
        checkGemini(),
        checkGroq()
    ];

    // Race them all with a global timeout
    try {
        await Promise.race([
            Promise.all(checks),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Service checks timeout')), 30000)
            )
        ]).catch(() => {
            // Some services may fail — that's OK
            log.info('SYSTEM', 'Some optional services are unavailable (this is OK for local dev)');
        });
    } catch (err) {
        log.warn('SYSTEM', `Service check failed: ${err.message}`);
    }

    // Log summary
    logServiceStatusSummary();
    return SERVICE_STATUS;
}

/**
 * Check Redis availability
 */
async function checkRedis() {
    const url = process.env.REDIS_URL;
    if (!url) {
        SERVICE_STATUS.redis.available = false;
        SERVICE_STATUS.redis.reason = 'Not configured';
        return;
    }

    try {
        const { redisClient } = require('../config/redisClient');
        if (redisClient && redisClient.isOpen) {
            SERVICE_STATUS.redis.available = true;
            log.success('SYSTEM', '✓ Redis is available');
        } else {
            throw new Error('Redis client not initialized');
        }
    } catch (err) {
        SERVICE_STATUS.redis.available = false;
        SERVICE_STATUS.redis.reason = err.message;
        log.warn('SYSTEM', `✗ Redis unavailable: ${err.message} — using in-memory cache`);
    }
}

/**
 * Check Neo4j availability
 */
async function checkNeo4j() {
    const uri = process.env.NEO4J_URI;
    if (!uri) {
        SERVICE_STATUS.neo4j.available = false;
        SERVICE_STATUS.neo4j.reason = 'Not configured';
        return;
    }

    try {
        // Try a simple query
        const neo4j = require('neo4j-driver');
        const driver = neo4j.driver(uri, neo4j.auth.basic(
            process.env.NEO4J_USER || 'neo4j',
            process.env.NEO4J_PASSWORD || 'password'
        ), { connectionTimeout: 5000 });
        
        const session = driver.session();
        await session.run('RETURN 1');
        await session.close();
        await driver.close();

        SERVICE_STATUS.neo4j.available = true;
        log.success('SYSTEM', '✓ Neo4j Knowledge Graph is available');
    } catch (err) {
        SERVICE_STATUS.neo4j.available = false;
        SERVICE_STATUS.neo4j.reason = err.message;
        log.warn('SYSTEM', `✗ Neo4j unavailable: ${err.message} — skipping graph features`);
    }
}

/**
 * Check Qdrant availability
 */
async function checkQdrant() {
    const url = process.env.QDRANT_URL;
    if (!url) {
        SERVICE_STATUS.qdrant.available = false;
        SERVICE_STATUS.qdrant.reason = 'Not configured';
        return;
    }

    try {
        const response = await axios.get(`${url}/health`, { timeout: 5000 });
        if (response.status === 200) {
            SERVICE_STATUS.qdrant.available = true;
            log.success('SYSTEM', '✓ Qdrant Vector Store is available');
        }
    } catch (err) {
        SERVICE_STATUS.qdrant.available = false;
        SERVICE_STATUS.qdrant.reason = err.message;
        log.warn('SYSTEM', `✗ Qdrant unavailable: ${err.message} — disabling vector search`);
    }
}

/**
 * Check Elasticsearch availability
 */
async function checkElasticsearch() {
    const url = process.env.ELASTICSEARCH_URL;
    if (!url) {
        SERVICE_STATUS.elasticsearch.available = false;
        SERVICE_STATUS.elasticsearch.reason = 'Not configured';
        return;
    }

    try {
        const response = await axios.get(`${url}/_cluster/health`, { timeout: 5000 });
        if (response.status === 200) {
            SERVICE_STATUS.elasticsearch.available = true;
            log.success('SYSTEM', '✓ Elasticsearch is available');
        }
    } catch (err) {
        SERVICE_STATUS.elasticsearch.available = false;
        SERVICE_STATUS.elasticsearch.reason = err.message;
        log.warn('SYSTEM', `✗ Elasticsearch unavailable: ${err.message} — disabling full-text search`);
    }
}

/**
 * Check Python RAG service availability
 */
async function checkPythonRag() {
    const url = process.env.PYTHON_RAG_SERVICE_URL;
    if (!url) {
        SERVICE_STATUS.pythonRag.available = false;
        SERVICE_STATUS.pythonRag.reason = 'Not configured';
        return;
    }

    try {
        const response = await axios.get(`${url}/health`, { timeout: 7000 });
        if (response.data.status === 'ok') {
            SERVICE_STATUS.pythonRag.available = true;
            log.success('SYSTEM', '✓ Python RAG Service is available');
        }
    } catch (err) {
        SERVICE_STATUS.pythonRag.available = false;
        SERVICE_STATUS.pythonRag.reason = err.message;
        log.warn('SYSTEM', `✗ Python RAG Service unavailable: ${err.message} — falling back to LLM knowledge`);
    }
}

/**
 * Check SGLang availability
 */
async function checkSGLang() {
    const url = process.env.SGLANG_CHAT_URL;
    if (!url || process.env.SGLANG_ENABLED !== 'true') {
        SERVICE_STATUS.sglang.available = false;
        SERVICE_STATUS.sglang.reason = 'Not configured or disabled';
        return;
    }

    try {
        const healthUrl = url.replace('/v1', '') + '/health';
        const response = await axios.get(healthUrl, { timeout: 5000 });
        if (response.status === 200) {
            SERVICE_STATUS.sglang.available = true;
            log.success('SYSTEM', '✓ SGLang is available');
        }
    } catch (err) {
        SERVICE_STATUS.sglang.available = false;
        SERVICE_STATUS.sglang.reason = err.message;
        log.warn('SYSTEM', `✗ SGLang unavailable: ${err.message} — using provider fallback chain`);
    }
}

/**
 * Check Gemini API key validity
 */
async function checkGemini() {
    const key = process.env.GEMINI_API_KEY;
    const validated = process.env.GEMINI_API_VALIDATED === 'true';

    if (!key) {
        SERVICE_STATUS.gemini.available = false;
        SERVICE_STATUS.gemini.reason = 'API key not set';
        return;
    }

    if (!validated) {
        SERVICE_STATUS.gemini.available = false;
        SERVICE_STATUS.gemini.reason = 'API key not validated (set GEMINI_API_VALIDATED=true)';
        log.warn('SYSTEM', '✗ Gemini API key not validated — skipping Gemini');
        return;
    }

    try {
        // Quick validation call
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const client = new GoogleGenerativeAI(key);
        const model = client.getGenerativeModel({ model: 'gemini-2.0-flash' });
        
        await Promise.race([
            model.generateContent('test'),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Gemini timeout')), 5000)
            )
        ]);

        SERVICE_STATUS.gemini.available = true;
        log.success('SYSTEM', '✓ Gemini API is available');
    } catch (err) {
        SERVICE_STATUS.gemini.available = false;
        SERVICE_STATUS.gemini.reason = err.message;
        log.warn('SYSTEM', `✗ Gemini API unavailable: ${err.message}`);
    }
}

/**
 * Check Groq API key validity
 */
async function checkGroq() {
    const key = process.env.GROQ_API_KEY;
    if (!key) {
        SERVICE_STATUS.groq.available = false;
        SERVICE_STATUS.groq.reason = 'API key not set';
        return;
    }

    try {
        const { Groq } = require('groq-sdk');
        const client = new Groq({ apiKey: key });
        
        await Promise.race([
            client.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: 'test' }],
                max_tokens: 10
            }),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Groq timeout')), 5000)
            )
        ]);

        SERVICE_STATUS.groq.available = true;
        log.success('SYSTEM', '✓ Groq API is available');
    } catch (err) {
        SERVICE_STATUS.groq.available = false;
        SERVICE_STATUS.groq.reason = err.message;
        log.warn('SYSTEM', `✗ Groq API unavailable: ${err.message}`);
    }
}

/**
 * Log service status summary
 */
function logServiceStatusSummary() {
    log.info('SYSTEM', '=== Optional Service Status ===');
    Object.entries(SERVICE_STATUS).forEach(([service, status]) => {
        const symbol = status.available ? '✓' : '✗';
        const reason = status.reason ? ` (${status.reason})` : '';
        log.info('SYSTEM', `${symbol} ${service.toUpperCase()}${reason}`);
    });
    log.info('SYSTEM', '==============================');
}

/**
 * Get current service status
 */
function getServiceStatus() {
    return { ...SERVICE_STATUS };
}

/**
 * Check if a specific service is available
 */
function isServiceAvailable(service) {
    return SERVICE_STATUS[service]?.available || false;
}

module.exports = {
    checkOptionalServices,
    getServiceStatus,
    isServiceAvailable,
    SERVICE_STATUS
};
/**
 * server/utils/startupServices.js
 * 
 * Graceful fallback handling for optional services
 * 
 * Ensures the server starts successfully even if:
 * - Redis is unavailable (uses in-memory cache fallback)
 * - Qdrant is unavailable (disables vector retrieval)
 * - Neo4j is unavailable (skips graph features)
 * - Elasticsearch is unavailable (disables full-text search)
 * - Python RAG service is unavailable (uses fallback modes)
 * - SGLang is unavailable (falls back to Gemini/Groq/Ollama)
 * 
 * CRITICAL: Do NOT crash the server for optional service failures
 */

const axios = require('axios');
const log = require('./logger');

// Service availability flags (checked at startup, updated dynamically)
const SERVICE_STATUS = {
    redis: { available: false, reason: null },
    neo4j: { available: false, reason: null },
    qdrant: { available: false, reason: null },
    elasticsearch: { available: false, reason: null },
    pythonRag: { available: false, reason: null },
    sglang: { available: false, reason: null },
    gemini: { available: false, reason: null },
    groq: { available: false, reason: null }
};

/**
 * Check all optional services at startup
 * Returns immediately without blocking server startup on failures
 */
async function checkOptionalServices() {
    log.info('SYSTEM', '=== Checking Optional Services (Non-blocking) ===');

    // Check each service in parallel, but don't await all (some may timeout)
    const checks = [
        checkRedis(),
        checkNeo4j(),
        checkQdrant(),
        checkElasticsearch(),
        checkPythonRag(),
        checkSGLang(),
        checkGemini(),
        checkGroq()
    ];

    // Race them all with a global timeout
    try {
        await Promise.race([
            Promise.all(checks),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Service checks timeout')), 30000)
            )
        ]).catch(() => {
            // Some services may fail — that's OK
            log.info('SYSTEM', 'Some optional services are unavailable (this is OK for local dev)');
        });
    } catch (err) {
        log.warn('SYSTEM', `Service check failed: ${err.message}`);
    }

    // Log summary
    logServiceStatusSummary();
    return SERVICE_STATUS;
}

/**
 * Check Redis availability
 */
async function checkRedis() {
    const url = process.env.REDIS_URL;
    if (!url) {
        SERVICE_STATUS.redis.available = false;
        SERVICE_STATUS.redis.reason = 'Not configured';
        return;
    }

    try {
        const { redisClient } = require('../config/redisClient');
        if (redisClient && redisClient.isOpen) {
            SERVICE_STATUS.redis.available = true;
            log.success('SYSTEM', '✓ Redis is available');
        } else {
            throw new Error('Redis client not initialized');
        }
    } catch (err) {
        SERVICE_STATUS.redis.available = false;
        SERVICE_STATUS.redis.reason = err.message;
        log.warn('SYSTEM', `✗ Redis unavailable: ${err.message} — using in-memory cache`);
    }
}

/**
 * Check Neo4j availability
 */
async function checkNeo4j() {
    const uri = process.env.NEO4J_URI;
    if (!uri) {
        SERVICE_STATUS.neo4j.available = false;
        SERVICE_STATUS.neo4j.reason = 'Not configured';
        return;
    }

    try {
        // Try a simple query
        const neo4j = require('neo4j-driver');
        const driver = neo4j.driver(uri, neo4j.auth.basic(
            process.env.NEO4J_USER || 'neo4j',
            process.env.NEO4J_PASSWORD || 'password'
        ), { connectionTimeout: 5000 });
        
        const session = driver.session();
        await session.run('RETURN 1');
        await session.close();
        await driver.close();

        SERVICE_STATUS.neo4j.available = true;
        log.success('SYSTEM', '✓ Neo4j Knowledge Graph is available');
    } catch (err) {
        SERVICE_STATUS.neo4j.available = false;
        SERVICE_STATUS.neo4j.reason = err.message;
        log.warn('SYSTEM', `✗ Neo4j unavailable: ${err.message} — skipping graph features`);
    }
}

/**
 * Check Qdrant availability
 */
async function checkQdrant() {
    const url = process.env.QDRANT_URL;
    if (!url) {
        SERVICE_STATUS.qdrant.available = false;
        SERVICE_STATUS.qdrant.reason = 'Not configured';
        return;
    }

    try {
        const response = await axios.get(`${url}/health`, { timeout: 5000 });
        if (response.status === 200) {
            SERVICE_STATUS.qdrant.available = true;
            log.success('SYSTEM', '✓ Qdrant Vector Store is available');
        }
    } catch (err) {
        SERVICE_STATUS.qdrant.available = false;
        SERVICE_STATUS.qdrant.reason = err.message;
        log.warn('SYSTEM', `✗ Qdrant unavailable: ${err.message} — disabling vector search`);
    }
}

/**
 * Check Elasticsearch availability
 */
async function checkElasticsearch() {
    const url = process.env.ELASTICSEARCH_URL;
    if (!url) {
        SERVICE_STATUS.elasticsearch.available = false;
        SERVICE_STATUS.elasticsearch.reason = 'Not configured';
        return;
    }

    try {
        const response = await axios.get(`${url}/_cluster/health`, { timeout: 5000 });
        if (response.status === 200) {
            SERVICE_STATUS.elasticsearch.available = true;
            log.success('SYSTEM', '✓ Elasticsearch is available');
        }
    } catch (err) {
        SERVICE_STATUS.elasticsearch.available = false;
        SERVICE_STATUS.elasticsearch.reason = err.message;
        log.warn('SYSTEM', `✗ Elasticsearch unavailable: ${err.message} — disabling full-text search`);
    }
}

/**
 * Check Python RAG service availability
 */
async function checkPythonRag() {
    const url = process.env.PYTHON_RAG_SERVICE_URL;
    if (!url) {
        SERVICE_STATUS.pythonRag.available = false;
        SERVICE_STATUS.pythonRag.reason = 'Not configured';
        return;
    }

    try {
        const response = await axios.get(`${url}/health`, { timeout: 7000 });
        if (response.data.status === 'ok') {
            SERVICE_STATUS.pythonRag.available = true;
            log.success('SYSTEM', '✓ Python RAG Service is available');
        }
    } catch (err) {
        SERVICE_STATUS.pythonRag.available = false;
        SERVICE_STATUS.pythonRag.reason = err.message;
        log.warn('SYSTEM', `✗ Python RAG Service unavailable: ${err.message} — falling back to LLM knowledge`);
    }
}

/**
 * Check SGLang availability
 */
async function checkSGLang() {
    const url = process.env.SGLANG_CHAT_URL;
    if (!url || process.env.SGLANG_ENABLED !== 'true') {
        SERVICE_STATUS.sglang.available = false;
        SERVICE_STATUS.sglang.reason = 'Not configured or disabled';
        return;
    }

    try {
        const healthUrl = url.replace('/v1', '') + '/health';
        const response = await axios.get(healthUrl, { timeout: 5000 });
        if (response.status === 200) {
            SERVICE_STATUS.sglang.available = true;
            log.success('SYSTEM', '✓ SGLang is available');
        }
    } catch (err) {
        SERVICE_STATUS.sglang.available = false;
        SERVICE_STATUS.sglang.reason = err.message;
        log.warn('SYSTEM', `✗ SGLang unavailable: ${err.message} — using provider fallback chain`);
    }
}

/**
 * Check Gemini API key validity
 */
async function checkGemini() {
    const key = process.env.GEMINI_API_KEY;
    const validated = process.env.GEMINI_API_VALIDATED === 'true';

    if (!key) {
        SERVICE_STATUS.gemini.available = false;
        SERVICE_STATUS.gemini.reason = 'API key not set';
        return;
    }

    if (!validated) {
        SERVICE_STATUS.gemini.available = false;
        SERVICE_STATUS.gemini.reason = 'API key not validated (set GEMINI_API_VALIDATED=true)';
        log.warn('SYSTEM', '✗ Gemini API key not validated — skipping Gemini');
        return;
    }

    try {
        // Quick validation call
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const client = new GoogleGenerativeAI(key);
        const model = client.getGenerativeModel({ model: 'gemini-2.0-flash' });
        
        await Promise.race([
            model.generateContent('test'),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Gemini timeout')), 5000)
            )
        ]);

        SERVICE_STATUS.gemini.available = true;
        log.success('SYSTEM', '✓ Gemini API is available');
    } catch (err) {
        SERVICE_STATUS.gemini.available = false;
        SERVICE_STATUS.gemini.reason = err.message;
        log.warn('SYSTEM', `✗ Gemini API unavailable: ${err.message}`);
    }
}

/**
 * Check Groq API key validity
 */
async function checkGroq() {
    const key = process.env.GROQ_API_KEY;
    if (!key) {
        SERVICE_STATUS.groq.available = false;
        SERVICE_STATUS.groq.reason = 'API key not set';
        return;
    }

    try {
        const { Groq } = require('groq-sdk');
        const client = new Groq({ apiKey: key });
        
        await Promise.race([
            client.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: 'test' }],
                max_tokens: 10
            }),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Groq timeout')), 5000)
            )
        ]);

        SERVICE_STATUS.groq.available = true;
        log.success('SYSTEM', '✓ Groq API is available');
    } catch (err) {
        SERVICE_STATUS.groq.available = false;
        SERVICE_STATUS.groq.reason = err.message;
        log.warn('SYSTEM', `✗ Groq API unavailable: ${err.message}`);
    }
}

/**
 * Log service status summary
 */
function logServiceStatusSummary() {
    log.info('SYSTEM', '=== Optional Service Status ===');
    Object.entries(SERVICE_STATUS).forEach(([service, status]) => {
        const symbol = status.available ? '✓' : '✗';
        const reason = status.reason ? ` (${status.reason})` : '';
        log.info('SYSTEM', `${symbol} ${service.toUpperCase()}${reason}`);
    });
    log.info('SYSTEM', '==============================');
}

/**
 * Get current service status
 */
function getServiceStatus() {
    return { ...SERVICE_STATUS };
}

/**
 * Check if a specific service is available
 */
function isServiceAvailable(service) {
    return SERVICE_STATUS[service]?.available || false;
}

module.exports = {
    checkOptionalServices,
    getServiceStatus,
    isServiceAvailable,
    SERVICE_STATUS
};
