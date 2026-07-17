/**
 * Ollama Health Service
 * Checks if Ollama server is reachable by querying its API endpoint.
 */
const axios = require('axios');

async function checkOllamaHealth(url) {
    if (!url) return false;
    try {
        const baseUrl = url.replace(/\/+$/, '');
        const resp = await axios.get(`${baseUrl}/api/tags`, { timeout: 3000 });
        return resp.status === 200 && Array.isArray(resp.data?.models);
    } catch {
        return false;
    }
}

module.exports = { checkOllamaHealth };
