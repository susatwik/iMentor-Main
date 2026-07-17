const log = require('../utils/logger');
const axios = require('axios');

const ONE_MINUTE = 60_000;
const FIVE_MINUTES = 300_000;

const COOLDOWN_DURATIONS = {
  rate_limited: FIVE_MINUTES,
  quota_exceeded: FIVE_MINUTES,
  connection_refused: FIVE_MINUTES,
  auth_failure: Infinity,
  model_not_found: FIVE_MINUTES,
  timeout: ONE_MINUTE,
  unknown: 30_000,
};

const HEALTH_REFRESH_MS = ONE_MINUTE;

class ProviderHealthCache {
  constructor() {
    this._cache = {};
    this._startupChecked = false;
  }

  _entry(provider) {
    if (!this._cache[provider]) {
      this._cache[provider] = {
        healthy: true,
        checked: false,
        cooldownUntil: 0,
        reason: null,
        latencySum: 0,
        latencyCount: 0,
        successCount: 0,
        failCount: 0,
        lastLatency: 0,
        failureType: null,
      };
    }
    return this._cache[provider];
  }

  isHealthy(provider) {
    const e = this._entry(provider);
    if (e.cooldownUntil > Date.now()) return false;
    if (!e.checked) {
      if (provider === 'sglang' && process.env.SGLANG_ENABLED !== 'true') return false;
      if (!['ollama', 'sglang'].includes(provider) && !this._hasApiKey(provider)) return false;
      return true;
    }
    return e.healthy;
  }

  _hasApiKey(provider) {
    switch (provider) {
      case 'gemini': return !!(process.env.GEMINI_API_KEY && !['your_gemini_api_key', 'placeholder', ''].includes(process.env.GEMINI_API_KEY.trim().toLowerCase()));
      case 'groq': return !!(process.env.GROQ_API_KEY && !['your_groq_api_key_here', 'placeholder', ''].includes(process.env.GROQ_API_KEY.trim().toLowerCase()));
      case 'openai': return !!(process.env.OPENAI_API_KEY && !['placeholder', ''].includes(process.env.OPENAI_API_KEY.trim().toLowerCase()));
      default: return true;
    }
  }

  getHealthyProviders(preferredOrder) {
    const healthy = preferredOrder.filter(p => this.isHealthy(p));
    const sorted = [...healthy].sort((a, b) => {
      const ea = this._entry(a);
      const eb = this._entry(b);
      const scoreA = this._score(ea);
      const scoreB = this._score(eb);
      return scoreB - scoreA;
    });
    return sorted;
  }

  _score(e) {
    if (!e.latencyCount) return 0.5;
    const avgLatency = e.latencySum / e.latencyCount;
    const totalCalls = e.successCount + e.failCount;
    const successRate = totalCalls > 0 ? e.successCount / totalCalls : 0.5;
    const latencyScore = Math.max(0, 1 - avgLatency / 60000);
    return 0.6 * successRate + 0.4 * latencyScore;
  }

  recordSuccess(provider, latencyMs) {
    const e = this._entry(provider);
    e.healthy = true;
    e.checked = true;
    e.cooldownUntil = 0;
    e.reason = null;
    e.failureType = null;
    e.successCount++;
    e.latencySum += latencyMs;
    e.latencyCount++;
    e.lastLatency = latencyMs;
  }

  recordFailure(provider, reason) {
    const e = this._entry(provider);
    e.healthy = false;
    e.checked = true;
    e.failCount++;

    let failureType = 'unknown';
    const lower = (reason || '').toLowerCase();
    if (lower.includes('rate limit') || lower.includes('429')) failureType = 'rate_limited';
    else if (lower.includes('quota') || lower.includes('tpd')) failureType = 'quota_exceeded';
    else if (lower.includes('connection refused') || lower.includes('econnrefused') || lower.includes('fetch failed')) failureType = 'connection_refused';
    else if (lower.includes('api key') || lower.includes('auth') || lower.includes('401') || lower.includes('403')) failureType = 'auth_failure';
    else if (lower.includes('model not found') || lower.includes('model does not exist') || lower.includes('404')) failureType = 'model_not_found';
    else if (lower.includes('timeout')) failureType = 'timeout';

    const duration = COOLDOWN_DURATIONS[failureType] || COOLDOWN_DURATIONS.unknown;
    e.cooldownUntil = isFinite(duration) ? Date.now() + duration : Infinity;
    e.reason = reason;
    e.failureType = failureType;
  }

  getProviderStatus(name) {
    const e = this._entry(name);
    if (!e.checked) return { healthy: this.isHealthy(name), status: 'not_checked', latency: 0 };
    if (e.cooldownUntil > Date.now()) {
      const remaining = Math.round((e.cooldownUntil - Date.now()) / 1000);
      return { healthy: false, status: `cooldown_${remaining}s`, reason: e.reason, latency: e.lastLatency, failureType: e.failureType };
    }
    return { healthy: e.healthy, status: e.healthy ? 'healthy' : 'unhealthy', latency: e.lastLatency, avgLatency: e.latencyCount > 0 ? Math.round(e.latencySum / e.latencyCount) : 0, successCount: e.successCount, failCount: e.failCount };
  }

  async checkHealthAtStartup() {
    const results = {};
    const checks = [];

    for (const provider of ['sglang', 'groq', 'gemini', 'openai', 'ollama']) {
      if (!this._hasApiKey(provider) && provider !== 'ollama' && provider !== 'sglang') {
        this._entry(provider).healthy = false;
        this._entry(provider).checked = true;
        this._entry(provider).reason = 'api_key_missing';
        results[provider] = { healthy: false, reason: 'API key missing' };
        continue;
      }
      checks.push(this._checkSingle(provider, results));
    }

    await Promise.allSettled(checks);
    this._startupChecked = true;
    return results;
  }

  async _checkSingle(provider, results) {
    try {
      if (provider === 'sglang') {
        if (process.env.SGLANG_ENABLED !== 'true') {
          this._entry(provider).healthy = false;
          this._entry(provider).checked = true;
          results[provider] = { healthy: false, reason: 'SGLANG_ENABLED !== true' };
          return;
        }
        const sglangUrl = process.env.SGLANG_CHAT_URL || 'http://localhost:8000/v1';
        const baseUrl = sglangUrl.replace(/\/v1\/?$/, '');
        await axios.get(`${baseUrl}/health`, { timeout: 3000 });
        this._entry(provider).healthy = true;
        this._entry(provider).checked = true;
        results[provider] = { healthy: true };
        return;
      }

      if (provider === 'ollama') {
        const ollamaUrl = process.env.OLLAMA_URL || `http://localhost:${process.env.OLLAMA_PORT || 11434}`;
        const resp = await axios.get(`${ollamaUrl.replace(/\/+$/, '')}/api/tags`, { timeout: 3000 });
        const ok = resp.status === 200 && Array.isArray(resp.data?.models);
        this._entry(provider).healthy = ok;
        this._entry(provider).checked = true;
        results[provider] = { healthy: ok, models: (resp.data?.models || []).map(m => m.name) };
        return;
      }

      results[provider] = { healthy: true };
      this._entry(provider).checked = true;
    } catch (e) {
      this._entry(provider).healthy = false;
      this._entry(provider).checked = true;
      this._entry(provider).reason = e.message;
      results[provider] = { healthy: false, reason: e.message };
    }
  }

  async getStartupHealthSummary() {
    if (!this._startupChecked) await this.checkHealthAtStartup();
    const summary = {};
    for (const provider of ['sglang', 'groq', 'gemini', 'openai', 'ollama']) {
      summary[provider] = this.getProviderStatus(provider);
    }
    return summary;
  }
}

const instance = new ProviderHealthCache();
module.exports = instance;
