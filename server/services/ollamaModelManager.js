/**
 * DEPRECATED — Ollama model manager shim.
 * Ollama has been fully removed. SGLang manages its own models.
 * This shim exists for backward compatibility — ensureModel is now a no-op.
 */

async function ensureModel(modelName) {
    // SGLang models are managed via Docker — no runtime pulling needed.
    return true;
}

module.exports = { ensureModel };
