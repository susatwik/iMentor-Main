/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  DEPRECATED — Ollama shim: all calls redirect to SGLang               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Ollama has been fully removed from the project. This file exists solely as
 * a backward-compatible shim so that the ~30 files that still `require('./ollamaService')`
 * continue to work without individual edits.
 *
 * All exports delegate directly to sglangService.js.
 * TODO: grep for 'ollamaService' and update each caller to import sglangService directly,
 *       then delete this shim.
 */

const sglangService = require('./sglangService');

module.exports = {
    generateContentWithHistory: sglangService.generateContentWithHistory,
    generateContent: (prompt, options = {}) =>
        sglangService.generateContentWithHistory([], prompt, null, options),
    streamChat: sglangService.streamChat,
    checkHealth: sglangService.checkHealth,
    SGLANG_ENABLED: sglangService.SGLANG_ENABLED,
};
