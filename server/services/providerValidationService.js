const axios = require('axios');
const log = require('../utils/logger');

async function fetchOllamaModels(ollamaUrl) {
  const base = String(ollamaUrl || process.env.OLLAMA_API_BASE_URL || 'http://localhost:11434').trim().replace(/\/+$/, '');
  const response = await axios.get(`${base}/api/tags`, { timeout: 7000 });
  const models = Array.isArray(response.data?.models)
    ? response.data.models.map(m => m.name).filter(Boolean)
    : [];
  return { provider: 'ollama', endpoint: base, models };
}

async function fetchGroqModels(apiKey) {
  const response = await axios.get('https://api.groq.com/openai/v1/models', {
    timeout: 7000,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    }
  });
  const models = Array.isArray(response.data?.data)
    ? response.data.data.map(m => m.id).filter(Boolean)
    : [];
  return { provider: 'groq', models };
}

async function fetchGeminiModels(apiKey) {
  const response = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, {
    timeout: 7000,
  });
  const models = Array.isArray(response.data?.models)
    ? response.data.models.map(m => m.name?.replace('models/', '')).filter(Boolean)
    : [];
  return { provider: 'gemini', models };
}

async function fetchAvailableModels({ provider, apiKey, ollamaUrl }) {
  if (provider === 'ollama') {
    return fetchOllamaModels(ollamaUrl);
  }
  if (provider === 'groq') {
    if (!apiKey) throw new Error('API key required for Groq validation.');
    return fetchGroqModels(apiKey);
  }
  if (provider === 'gemini') {
    if (!apiKey) throw new Error('API key required for Gemini validation.');
    return fetchGeminiModels(apiKey);
  }
  throw new Error(`Unsupported provider: ${provider}`);
}

async function validateProviderConnection({ provider, apiKey, ollamaUrl }) {
  try {
    const data = await fetchAvailableModels({ provider, apiKey, ollamaUrl });
    return {
      ok: true,
      provider,
      endpoint: data.endpoint,
      models: data.models || [],
      message: 'Connection validated successfully.'
    };
  } catch (error) {
    const msg = error.response?.data?.error?.message || error.response?.data?.error || error.message;
    log.warn('AI', `Provider validation failed for ${provider}: ${msg}`);
    return {
      ok: false,
      provider,
      models: [],
      message: msg || 'Validation failed.'
    };
  }
}

module.exports = {
  validateProviderConnection,
  fetchAvailableModels,
};
