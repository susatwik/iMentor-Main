/**
 * DEPRECATED — Ollama health shim: delegates to SGLang health check.
 * Ollama has been fully removed. This shim exists for backward compatibility.
 */

const sglangService = require('./sglangService');

async function checkOllamaHealth() {
    return sglangService.checkHealth('chat');
}

module.exports = { checkOllamaHealth };
