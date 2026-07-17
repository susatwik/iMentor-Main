const axios = require('axios');
const mongoose = require('mongoose');
const { redisClient } = require('../config/redisClient');
const log = require('../utils/logger');
const { discoverOllamaModel } = require('./enhancedLectureService');

async function checkProvider(name, url, timeout = 3000) {
  try {
    const resp = await axios.get(url, { timeout });
    return { name, reachable: true, status: resp.status };
  } catch (e) {
    return { name, reachable: false, error: e.message };
  }
}

async function runHealthCheck() {
  const results = [];

  results.push({ name: 'MongoDB', reachable: mongoose.connection.readyState === 1 });

  try {
    if (redisClient && redisClient.isOpen) {
      await redisClient.ping();
      results.push({ name: 'Redis', reachable: true });
    } else {
      results.push({ name: 'Redis', reachable: false, error: 'client not open' });
    }
  } catch (e) {
    results.push({ name: 'Redis', reachable: false, error: e.message });
  }

  try {
    const neo4j = require('../config/neo4j');
    const result = await neo4j.runQuery('RETURN 1');
    results.push({ name: 'Neo4j', reachable: result.records.length > 0 });
  } catch (e) {
    results.push({ name: 'Neo4j', reachable: false, error: e.message });
  }

  const ollamaUrl = process.env.OLLAMA_URL || `http://localhost:${process.env.OLLAMA_PORT || 11434}`;
  const ollamaCheck = await checkProvider('SGLang', (process.env.SGLANG_CHAT_URL || 'http://localhost:8000/v1').replace('/v1', '') + '/get_server_info', 3000);
  results.push(ollamaCheck);

  if (process.env.GROQ_API_KEY) {
    results.push({ name: 'Groq', reachable: true, note: 'API key configured' });
  } else {
    results.push({ name: 'Groq', reachable: false, error: 'API key missing' });
  }

  if (process.env.GEMINI_API_KEY) {
    results.push({ name: 'Gemini', reachable: true, note: 'API key configured' });
  } else {
    results.push({ name: 'Gemini', reachable: false, error: 'API key missing' });
  }

  if (process.env.OPENAI_API_KEY) {
    results.push({ name: 'OpenAI', reachable: true, note: 'API key configured' });
  } else {
    results.push({ name: 'OpenAI', reachable: false, error: 'API key missing' });
  }

  const ollamaModel = await discoverOllamaModel();
  if (ollamaModel) {
    results.push({ name: 'Ollama (reachable)', reachable: true });
    results.push({ name: 'Ollama (model)', reachable: true, model: ollamaModel });

    try {
      const resp = await axios.post(`${ollamaUrl.replace(/\/+$/, '')}/api/generate`, {
        model: ollamaModel,
        prompt: 'Reply with one word: OK',
        stream: false,
        options: { num_predict: 10, temperature: 0 },
      }, { timeout: 30000 });
      const ok = resp.data?.response?.trim()?.toLowerCase() === 'ok';
      results.push({ name: 'Ollama (test gen)', reachable: ok, response: resp.data?.response?.trim() });
      if (!ok) results.push({ name: 'Ollama (test gen)', reachable: false, error: `unexpected response: ${resp.data?.response}` });
    } catch (e) {
      results.push({ name: 'Ollama (test gen)', reachable: false, error: e.message });
    }
  } else {
    results.push({ name: 'Ollama', reachable: false, error: 'no model discovered' });
  }

  return results;
}

async function logHealthSummary() {
  const results = await runHealthCheck();
  log.info('HEALTH', '===== STARTUP HEALTH CHECK =====');
  for (const r of results) {
    const icon = r.reachable ? '✓' : '✗';
    const detail = r.model ? `model=${r.model}` : r.error ? `error=${r.error}` : r.note || '';
    log.info('HEALTH', `  ${icon} ${r.name}${detail ? ' — ' + detail : ''}`);
  }
  log.info('HEALTH', '================================');
  return results;
}

module.exports = { runHealthCheck, logHealthSummary };
