const { checkOllamaHealth } = require('./ollamaHealthService');

const SGLANG_ENABLED = process.env.SGLANG_ENABLED === 'true';

// Base preferred fallback order. We'll expose a chain starting from the
// preferred provider and following the global priority: Gemini -> Groq -> SGLang -> Ollama
const BASE_PROVIDER_PRIORITY = ['gemini', 'groq', 'sglang', 'ollama'];
// Backwards-compatible export name
const PROVIDER_FALLBACK_ORDER = BASE_PROVIDER_PRIORITY.slice();

function normalizeProvider(provider) {
    if (typeof provider !== 'string') return 'ollama';
    const normalized = provider.trim().toLowerCase();
    if (normalized === 'local_llm') return 'ollama';
    if (BASE_PROVIDER_PRIORITY.includes(normalized)) return normalized;
    return 'ollama';
}

function getProviderChain(preferredProvider) {
    const preferred = normalizeProvider(preferredProvider);
    // Build chain starting with preferred, then append remaining providers in BASE_PROVIDER_PRIORITY order.
    const list = BASE_PROVIDER_PRIORITY.slice();
    // If SGLang isn't enabled, remove it from chain
    if (!SGLANG_ENABLED) {
        const idx = list.indexOf('sglang');
        if (idx !== -1) list.splice(idx, 1);
    }
    // Ensure uniqueness and preferred-first ordering
    const ordered = [preferred, ...list.filter(p => p !== preferred)];
    return ordered;
}

function getApiKeyForProvider(provider, preferredProvider, userApiKey) {
    const preferred = normalizeProvider(preferredProvider);
    if (provider === 'gemini') {
        return process.env.GEMINI_API_KEY || (preferred === 'gemini' ? userApiKey : null) || null;
    }
    return null;
}

async function resolveProviderByPreference({
    preferredProvider,
    userApiKey = null,
    userOllamaUrl = null,
    skipOllamaHealthCheck = false,
}) {
    const preferred = normalizeProvider(preferredProvider);
    const chain = getProviderChain(preferred);

    const ollamaCandidates = [userOllamaUrl, process.env.OLLAMA_API_BASE_URL]
        .filter((url) => typeof url === 'string' && url.trim())
        .map((url) => url.trim().replace(/\/+$/, ''));

    let workingOllamaUrl = null;
    for (const candidate of ollamaCandidates) {
        if (skipOllamaHealthCheck || await checkOllamaHealth(candidate)) {
            workingOllamaUrl = candidate;
            break;
        }
    }

    const availability = {
        ollama: Boolean(workingOllamaUrl),
        gemini: !SGLANG_ENABLED && Boolean(process.env.GEMINI_API_KEY || (preferred === 'gemini' && userApiKey)),
        groq: Boolean(process.env.GROQ_API_KEY || (preferred === 'groq' && userApiKey)),
        sglang: SGLANG_ENABLED
    };

    return {
        chosenProvider: preferred,
        chain,
        availability,
        workingOllamaUrl,
        apiKey: getApiKeyForProvider(preferred, preferredProvider, userApiKey),
    };
}

module.exports = {
    PROVIDER_FALLBACK_ORDER,
    normalizeProvider,
    getProviderChain,
    getApiKeyForProvider,
    resolveProviderByPreference,
};
