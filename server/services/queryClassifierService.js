/**
 * ML-Based Query Classification Service
 *
 * Routing waterfall (fastest → slowest):
 *   STEP 1  Semantic embedding router  (~10ms)   getSemanticRoute()   — 3-class cosine similarity
 *   STEP 2  Zero-shot NLI classifier   (~35ms)   zeroShotClassify()   — fine-grained 10-class local model ← NEW
 *   STEP 3  Keyword heuristics         (~0.1ms)  fallbackKeywordClassification()
 *   STEP 4  LLM fallback               (~50ms GPU)  SGLang chat / Ollama qwen3.5:2b / Gemini — LAST RESORT
 *
 * Step 2 replaces the gap where Step 1 returns "standard" with low confidence
 * but keyword matching is also weak — zero-shot NLI gives fine-grained intent
 * (code / creative / reasoning / web / academic / multilingual) without an LLM call.
 */

const log = require('../utils/logger');
const axios = require('axios');
const geminiService = require('./geminiService');
const { ensureModel } = require('./ollamaModelManager');
const { routeQuery, mapIntentToRoute } = require('./semanticRouter'); // [Team9] upgraded waterfall
const { routerMethodCounter, routerCacheCounter } = require('../utils/metrics');

const _RAG_SERVICE_URL = () => (process.env.PYTHON_RAG_SERVICE_URL || 'http://localhost:2001').trim();

// ── Route → queryClassifier category mapping ──────────────────────────────────
const SEMANTIC_ROUTE_TO_CATEGORY = {
    'direct_answer':   'chat',
    'standard':        'technical',
    'tot':             'reasoning',
    'web_search':      'web',
    'academic_search': 'academic',
    'research':        'research',
};

// ── Zero-shot NLI route → internal category ───────────────────────────────────
const ZSC_ROUTE_TO_STRENGTH = {
    'direct_answer':   'chat',
    'standard':        'technical',
    'tot':             'reasoning',
    'web_search':      'web',
    'academic_search': 'academic',
    'research':        'research',
};

// ── Zero-shot NLI caller ──────────────────────────────────────────────────────
// Calls POST /classify_intent on the Python RAG service.
// The endpoint runs a local cross-encoder/nli-deberta-v3-small model (~184 MB, CPU).
// Falls through silently on any error (network down, model not loaded yet, etc.)
const ZSC_TIMEOUT_MS = parseInt(process.env.ZSC_TIMEOUT_MS || '800', 10);
const ZSC_MIN_CONFIDENCE = parseFloat(process.env.ZSC_MIN_CONFIDENCE || '0.55');

async function zeroShotClassify(query) {
    try {
        const resp = await axios.post(
            `${_RAG_SERVICE_URL()}/classify_intent`,
            { query },
            { timeout: ZSC_TIMEOUT_MS, headers: { 'Content-Type': 'application/json' } },
        );
        const d = resp.data;
        if (!d || typeof d.confidence !== 'number') return null;
        return d;  // { label, confidence, route, category, method, all_scores, latency_ms }
    } catch (err) {
        log.debug('AI', `[ZSC] /classify_intent unavailable: ${err.message}`);
        return null;
    }
}

// Dedicated small model for semantic routing — fast, low VRAM, no thinking overhead
const ROUTER_MODEL = process.env.OLLAMA_ROUTER_MODEL || 'qwen3.5:2b';
const ROUTER_OLLAMA_URL = (process.env.OLLAMA_API_BASE_URL || 'http://localhost:11434').trim();

// Pull the router model in the background at module load time so it's ready on first request
let _routerModelReady = false;
let _routerModelPromise = null;
function _initRouterModel() {
    if (_routerModelPromise) return _routerModelPromise;
    _routerModelPromise = ensureModel(ROUTER_MODEL, ROUTER_OLLAMA_URL).then(ok => {
        _routerModelReady = ok;
        if (ok) log.success('AI', `Semantic router model ready: ${ROUTER_MODEL}`);
        else log.warn('AI', `Semantic router model ${ROUTER_MODEL} unavailable — will use keyword fallback`);
        return ok;
    });
    return _routerModelPromise;
}
_initRouterModel();

const QUERY_CATEGORIES = {
    CONVERSATION: {
        label: 'chat',
        description: 'Simple greetings, casual talk, and basic general knowledge questions',
        examples: [
            'Hi there!',
            'How are you today?',
            'What is the capital of Japan?',
            'Tell me a fun fact',
            'Who wrote Romeo and Juliet?',
            'Hello AI',
            'What day is it?',
            'Who are you?'
        ],
        strength: 'chat',
        confidence_threshold: 0.5
    },

    TECHNICAL: {
        label: 'technical',
        description: 'Academic subjects, specific domain knowledge (ML, AI, Science), advanced math, or technical theory',
        examples: [
            'Solve the Schrödinger equation for a hydrogen atom',
            'Calculate the double integral of e^(x+y)',
            'Explain the difference between General and Special Relativity',
            'Prove the Riemann Hypothesis basics',
            'Derive the Navier-Stokes equations',
            'What is the mathematical definition of a Hilbert space?',
            'Explain the biochemical path of ATP synthesis',
            'How do quantum gates work in a circuit?'
        ],
        strength: 'technical',
        confidence_threshold: 0.75
    },

    CODE: {
        label: 'code',
        description: 'Programming, architecture, debugging, scripts, and software logic',
        examples: [
            'Write a Python script for web scraping',
            'Debug this React useEffect hook',
            'How to implement a binary tree in C++',
            'Explain the MVC design pattern',
            'What is the difference between SQL and NoSQL?',
            'Create a CSS flexbox layout',
            'How to use Docker compose?',
            'Fix this memory leak in my Java app'
        ],
        strength: 'code',
        confidence_threshold: 0.7
    },

    CREATIVE: {
        label: 'creative',
        description: 'Fiction, poetry, roleplay, brainstorming, and artistic ideas',
        examples: [
            'Write a cyberpunk story about a hacker in Neo-Tokyo',
            'Compose a sonnet about the digital age',
            'Imagine you are a detective from the 1940s',
            'Brainstorm names for a new space exploration game',
            'Write a script for a movie about time travel',
            'Describe a sunset in a fantasy world with two moons',
            'Create a dialogue between a robot and a philosopher',
            'Write a haiku about the internet'
        ],
        strength: 'creative',
        confidence_threshold: 0.65
    },

    REASONING: {
        label: 'reasoning',
        description: 'Logic puzzles, analytical comparisons, and complex multi-step problems',
        examples: [
            'If 5 shirts take 5 hours to dry, how long do 10 shirts take?',
            'Compare the ethics of AI vs human decision making',
            'Analyze the economic impact of the industrial revolution',
            'Solve this riddle: I speak without a mouth...',
            'Should humanity colonize Mars? Give pros and cons',
            'What are the logical inconsistencies in this argument?',
            'Evaluate the impact of remote work on office culture',
            'How would you design a city from scratch?'
        ],
        strength: 'reasoning',
        confidence_threshold: 0.6
    },

    MULTILINGUAL: {
        label: 'multilingual',
        description: 'Translation, language learning, and multilingual grammar',
        examples: [
            'Translate this paragraph to German',
            'How do I say "I am hungry" in Korean?',
            'Explain the grammar of the future tense in Spanish',
            'What does this French idiom mean?',
            'Compare the alphabets of Hindi and Bengali',
            'Help me practice my Mandarin pronunciation',
            'Translate this between Japanese and Chinese',
            'What is the root of the word "education" in Latin?'
        ],
        strength: 'multilingual',
        confidence_threshold: 0.75
    }
};

async function classifyQuery(query, config = {}) {
    const startTime = Date.now();

    try {
        // ── STEP 1: Semantic embedding-based routing (fastest, ~10ms) ────────
        // Produces one of 3 coarse routes: direct_answer / standard / tot.
        // If confidence is high, return immediately.
        const cacheKey = query.slice(0, 80).replace(/\s+/g, '_');
        const semanticResult = await getSemanticRoute(query, cacheKey);

        if (
            semanticResult.route !== null &&
            semanticResult.confidence >= 0.72 &&
            semanticResult.method !== 'semantic_unavailable'
        ) {
            const mappedCategory = SEMANTIC_ROUTE_TO_CATEGORY[semanticResult.route] || 'chat';
            const strength       = getCategoryStrength(mappedCategory);
            const _elapsed = Date.now() - startTime;
            log.info('AI', `[ROUTER] ${JSON.stringify({ method: 'semantic', route: semanticResult.route, cat: mappedCategory, conf: semanticResult.confidence.toFixed(2), ms: _elapsed })}`);
            routerMethodCounter.inc({ method: 'semantic', route: semanticResult.route });
            return {
                category:           mappedCategory,
                confidence:         semanticResult.confidence,
                strength,
                reasoning:          `semantic_embedding_route:${semanticResult.route}`,
                semanticRoute:      semanticResult.route,
                semanticConfidence: semanticResult.confidence,
            };
        }

        // ── STEP 2: Zero-shot NLI classification (~20-50ms) ──────────────────
        // Runs a local cross-encoder/nli-deberta-v3-small model via Python /classify_intent.
        // Produces fine-grained 10-class intent (code/creative/reasoning/web/academic/…)
        // without any LLM API call. Used when Step 1 confidence is < 0.72.
        const zscResult = await zeroShotClassify(query);
        if (zscResult && zscResult.confidence >= ZSC_MIN_CONFIDENCE) {
            const category = zscResult.category || SEMANTIC_ROUTE_TO_CATEGORY[zscResult.route] || 'technical';
            const strength = getCategoryStrength(category);
            const _elapsed = Date.now() - startTime;
            log.info('AI', `[ROUTER] ${JSON.stringify({ method: 'zero_shot_nli', route: zscResult.route, cat: category, conf: zscResult.confidence.toFixed(2), label: zscResult.label, ms: _elapsed })}`);
            routerMethodCounter.inc({ method: 'zero_shot_nli', route: zscResult.route || category });
            return {
                category,
                confidence:         zscResult.confidence,
                strength,
                reasoning:          `zero_shot_nli:${zscResult.label}`,
                semanticRoute:      zscResult.route,
                semanticConfidence: zscResult.confidence,
                zscLabel:           zscResult.label,
                zscMethod:          zscResult.method,
            };
        }

        // ── STEP 3: Fast keyword classification (~0.1ms) ──────────────────────
        const keywordResult = fallbackKeywordClassification(query);
        if (keywordResult.confidence > 0.65 && keywordResult.reasoning !== 'default_fallback') {
            const _elapsed = Date.now() - startTime;
            log.info('AI', `[ROUTER] ${JSON.stringify({ method: 'keyword', cat: keywordResult.category, conf: keywordResult.confidence, ms: _elapsed })}`);
            routerMethodCounter.inc({ method: 'keyword', route: keywordResult.category });
            return keywordResult;
        }

        // ── STEP 4 (LAST RESORT): LLM classification (100-500ms) ─────────────
        // Only reached when semantic + zero-shot + keyword all fail.
        // Priority: SGLang (already-hot GPU) → Ollama (CPU fallback) → Gemini
        const prompt = buildClassificationPrompt(query);

        // Model priority: SGLang (hot GPU, ~50-100ms) → Ollama router model → Gemini
        const modelsToTry = [];
        if (process.env.SGLANG_ENABLED === 'true') {
            modelsToTry.push({ provider: 'sglang', name: process.env.SGLANG_CHAT_MODEL || 'Qwen/Qwen2.5-7B-Instruct', endpoint: 'chat' });
        }
        // Ollama as CPU fallback (only init if SGLang unavailable)
        if (modelsToTry.length === 0) {
            if (!_routerModelReady) await _initRouterModel();
            if (_routerModelReady) modelsToTry.push({ provider: 'ollama', name: ROUTER_MODEL });
        }
        if (process.env.GEMINI_API_KEY) {
            modelsToTry.push({ provider: 'gemini', name: process.env.GEMINI_MODEL || 'gemini-2.0-flash' });
        }

        if (modelsToTry.length === 0) {
            return fallbackKeywordClassification(query);
        }

        let response = null;
        let lastError = null;

        for (const model of modelsToTry) {
            try {
                if (model.provider === 'sglang') {
                    const sglangService = require('./sglangService');
                    response = await sglangService.generateContentWithHistory(
                        [],
                        prompt,
                        'You are a query classification expert. Your ENTIRE response must be a single JSON object. No text before or after. No markdown fences. Just raw JSON.',
                        {
                            model: model.name,
                            endpoint: model.endpoint || 'chat',
                            maxTokens: 150,
                            temperature: 0.1,
                        }
                    );
                } else if (model.provider === 'ollama') {
                    const ollamaService = require('./ollamaService');
                    response = await ollamaService.generateContentWithHistory(
                        [],
                        prompt,
                        'You are a query classification expert. Your ENTIRE response must be a single JSON object. No text before or after. No markdown fences. Just raw JSON.',
                        {
                            model: model.name,
                            ollamaUrl: ROUTER_OLLAMA_URL,
                            maxTokens: 150,
                            temperature: 0.1,
                            think: false   // no thinking chain — pure fast classification
                        }
                    );
                } else if (model.provider === 'gemini') {
                    response = await geminiService.generateContentWithHistory(
                        [],
                        prompt,
                        'You are a query classification expert. Respond with ONLY valid JSON.',
                        {
                            geminiModel: model.name,
                            maxTokens: 150,
                            temperature: 0.1,
                            apiKey: config.apiKey || process.env.GEMINI_API_KEY
                        }
                    );
                }

                if (response) {
                    // Try to extract JSON immediately; if it fails, try next model
                    let parsed = null;

                    // Try 1: Look for JSON in markdown code fence
                    const fencedMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
                    if (fencedMatch) {
                        try { parsed = JSON.parse(fencedMatch[1].trim()); } catch (e) { /* next */ }
                    }

                    // Try 2: Extract first balanced JSON object
                    if (!parsed) {
                        let depth = 0, start = -1;
                        for (let i = 0; i < response.length; i++) {
                            if (response[i] === '{') { if (depth === 0) start = i; depth++; }
                            else if (response[i] === '}') { depth--; if (depth === 0 && start !== -1) {
                                try { parsed = JSON.parse(response.slice(start, i + 1)); break; }
                                catch (e) { start = -1; }
                            }}
                        }
                    }

                    if (parsed && parsed.category) {
                        const _elapsed = Date.now() - startTime;
                        log.info('AI', `[ROUTER] ${JSON.stringify({ method: 'llm', model: model.name, cat: parsed.category, conf: parsed.confidence || 0.7, ms: _elapsed })}`);
                        routerMethodCounter.inc({ method: 'llm', route: parsed.category });
                        return {
                            category: parsed.category,
                            confidence: parsed.confidence || 0.7,
                            strength: getCategoryStrength(parsed.category),
                            reasoning: parsed.reasoning || 'ML-based classification'
                        };
                    }

                    // This model returned text but no valid JSON — try next model
                    log.warn('AI', `Classification model ${model.name} returned no valid JSON, trying next...`);
                    response = null;
                    continue;
                }
            } catch (err) {
                log.warn('AI', `Classification failed with ${model.name}: ${err.message.substring(0, 40)}`);
                lastError = err;
            }
        }

        // All LLM classifiers failed or returned no JSON — use keyword fallback
        return fallbackKeywordClassification(query);

    } catch (error) {
        log.error('AI', `Classification error: ${error.message}`);
        return fallbackKeywordClassification(query);
    }
}

/**
 * Build few-shot classification prompt
 */
function buildClassificationPrompt(query) {
    const categories = Object.keys(QUERY_CATEGORIES).map(key => {
        const cat = QUERY_CATEGORIES[key];
        return `${cat.label}: ${cat.description}`;
    }).join('\n');

    const examples = Object.keys(QUERY_CATEGORIES).map(key => {
        const cat = QUERY_CATEGORIES[key];
        return `Examples of ${cat.label}:\n${cat.examples.slice(0, 3).map(ex => `- "${ex}"`).join('\n')}`;
    }).join('\n\n');

    return `Classify the following query into one of these categories. 
IMPORTANT: favor 'technical' for specific, focused questions about academic subjects, science, algorithms, or specialized domains (unless it's a request for a script/code or a story/creative).
ONLY use 'chat' for greetings, casual conversation, or extremely generic non-academic questions.

CATEGORIES:
${categories}

EXAMPLES:
${examples}

---
Query to classify: "${query}"

Respond with ONLY JSON in this format:
{
  "category": "technical|code|creative|reasoning|multilingual|chat",
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation of why this category was chosen"
}`;
}

/**
 * Get strength mapping for category
 */
function getCategoryStrength(category) {
    const categoryKey = Object.keys(QUERY_CATEGORIES).find(
        key => QUERY_CATEGORIES[key].label === category.toLowerCase()
    );
    return categoryKey ? QUERY_CATEGORIES[categoryKey].strength : 'chat';
}

/**
 * Fallback keyword-based classification (original heuristic)
 */
function fallbackKeywordClassification(query) {
    const lowerQuery = query.toLowerCase();

    // Technical keywords (Specific academic/domain questions)
    const technicalKeywords = ['calculate', 'derive', 'equation', 'theorem', 'proof', 'quantum', 'relativity', 'physics', 'calculus', 'integral', 'biochemical', 'ml', 'machine learning', 'ai', 'artificial intelligence', 'algorithm', 'architecture', 'concept', 'explain the process of'];
    if (technicalKeywords.some(keyword => lowerQuery.includes(keyword))) {
        return { category: 'technical', confidence: 0.7, strength: 'technical', reasoning: 'keyword_fallback' };
    }

    // Code keywords
    const codeKeywords = ['code', 'python', 'javascript', 'java', 'html', 'css', 'react', 'function', 'variable', 'debug', 'git', 'api', 'server', 'database'];
    if (codeKeywords.some(keyword => lowerQuery.includes(keyword))) {
        return { category: 'code', confidence: 0.6, strength: 'code', reasoning: 'keyword_fallback' };
    }

    // Creative keywords
    const creativeKeywords = ['story', 'poem', 'imagine', 'creative', 'character', 'write', 'roleplay', 'creative', 'fictional'];
    if (creativeKeywords.some(keyword => lowerQuery.includes(keyword))) {
        return { category: 'creative', confidence: 0.6, strength: 'creative', reasoning: 'keyword_fallback' };
    }

    // Reasoning/Analytical keywords
    const reasoningKeywords = ['compare', 'contrast', 'analyze', 'evaluate', 'pros and cons', 'logical', 'riddle', 'puzzle'];
    if (reasoningKeywords.some(keyword => lowerQuery.includes(keyword))) {
        return { category: 'reasoning', confidence: 0.6, strength: 'reasoning', reasoning: 'keyword_fallback' };
    }

    // Multilingual keywords
    const multilingualKeywords = ['translate', 'translation', 'how to say', 'meaning in', 'language', 'spanish', 'french', 'german'];
    if (multilingualKeywords.some(keyword => lowerQuery.includes(keyword))) {
        return { category: 'multilingual', confidence: 0.7, strength: 'multilingual', reasoning: 'keyword_fallback' };
    }

    // Greeting / very short query — always chat, skip LLM classification
    const greetingPattern = /^(hi|hello|hey|hiya|howdy|sup|greetings|good\s*(morning|afternoon|evening|night)|what'?s up|yo|helo|hii+|hiiii*)[!?.,\s]*$/i;
    if (greetingPattern.test(query.trim()) || query.trim().split(/\s+/).length <= 3) {
        return { category: 'chat', confidence: 0.8, strength: 'chat', reasoning: 'greeting_shortcut' };
    }

    // Default to chat (Conversation)
    return { category: 'chat', confidence: 0.5, strength: 'chat', reasoning: 'default_fallback' };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    classifyQuery,
    QUERY_CATEGORIES
};

