
// const log         = require('../utils/logger');
// const sglangCaps  = require('./sglangCapabilities');
// const LLMConfiguration = require('../models/LLMConfiguration');
// const CourseAdapterMapping = require('../models/CourseAdapterMapping');
// const User = require('../models/User');
// const { checkOllamaHealth } = require('./ollamaHealthService');
// const geminiService = require('./geminiService');
// const ollamaService = require('./ollamaService');
// const llmStreamingService = require('./llmStreamingService');
// const { redisClient } = require('../config/redisClient');
// const { classifyQuery } = require('./queryClassifierService');
// const { selectModel, calculateComplexityScore } = require('./smartModelRouterService');
// const { resolveProviderByPreference, getProviderChain } = require('./providerPriorityService');
// const { getCachedRoutingDecision, cacheRoutingDecision } = require('./routingCacheService');

// // SGLang — lazy-imported so the server starts cleanly when SGLANG_ENABLED=false
// const SGLANG_ENABLED = process.env.SGLANG_ENABLED === 'true';

// const CLASSIFICATION_TTL = 300; // 5 min — tutor/subject context changes frequently
// const AUTO_ROUTING_TTL = 300;  // 5 min for auto smart-router decisions
// const CATALOG_REFRESH_INTERVAL = 60000; // 1 min catalog refresh

// const classificationCache = new Map();
// // Clear cache periodically to prevent memory leak
// setInterval(() => classificationCache.clear(), 60000);

// // --- Pre-loaded LLM Catalog (avoids per-request DB queries) ---
// let _catalogCache = [];
// let _catalogLastRefresh = 0;

// /**
//  * Pre-load the LLM catalog from MongoDB into memory.
//  * Called at startup and refreshed every 60 seconds.
//  */
// async function refreshCatalog() {
//     try {
//         _catalogCache = await LLMConfiguration.find({}).lean();
//         _catalogLastRefresh = Date.now();
//         // Only log on first load or when models exist (reduce noise)
//         if (_catalogCache.length > 0) {
//             log.info('AI', `LLM catalog refreshed: ${_catalogCache.length} models loaded`);
//         }
//     } catch (err) {
//         log.warn('AI', `Catalog refresh failed: ${err.message}`);
//     }
// }

// /**
//  * Get a model from the pre-loaded catalog by query filter.
//  * Falls back to DB if catalog is stale or empty.
//  */
// function catalogFind(filter) {
//     if (!_catalogCache.length) return null;
//     return _catalogCache.find(m => {
//         for (const [key, val] of Object.entries(filter)) {
//             if (key === '$in' || typeof val === 'object') continue;
//             // Handle array field membership (e.g. strengths)
//             if (Array.isArray(m[key])) {
//                 if (!m[key].includes(val)) return false;
//                 continue;
//             }
//             if (m[key] !== val) return false;
//         }
//         return true;
//     });
// }

// function catalogFindAll(filter) {
//     if (!_catalogCache.length) return [];
//     const providerList = filter.provider?.$in;
//     if (providerList) {
//         return _catalogCache.filter(m => providerList.includes(m.provider));
//     }
//     return _catalogCache.filter(m => {
//         for (const [key, val] of Object.entries(filter)) {
//             if (typeof val === 'object') continue;
//             if (m[key] !== val) return false;
//         }
//         return true;
//     });
// }

// function catalogExists(filter) {
//     return !!catalogFind(filter);
// }

// // Refresh catalog every minute
// setInterval(refreshCatalog, CATALOG_REFRESH_INTERVAL);
// // Initial load — call immediately (catalog populated before first request)
// refreshCatalog();

// /**
//  * Intelligently selects the best LLM for a given query and context.
//  */
// async function selectLLM(query, context) {
//   let user = context.user;
//   const { userId, subject } = context;

//   if (!user && userId) {
//     user = await User.findById(userId).lean();
//   }

//   const effectiveUserId = user?._id || userId;
//   // Include tutorMode + subject so routing decisions are context-aware
//   const cacheKey = `${query}_${effectiveUserId}_${context.tutorMode ? '1' : '0'}_${context.subject || ''}`;
//   const routingMode = user?.modelRoutingMode === 'auto' ? 'auto' : 'manual';
//   const selectedModelId = String(user?.selectedModelId || '').trim();

//   let preferredProvider = user?.preferredLlmProvider || 'ollama';
//   // 'local_llm' is the frontend alias for local inference — treat as 'ollama'
//   if (preferredProvider === 'local_llm') preferredProvider = 'ollama';
//   // When SGLang is enabled, always prefer local — never route to Gemini
//   if (SGLANG_ENABLED) preferredProvider = 'ollama';
//   const lowerQuery = query.toLowerCase();

//   const ollamaUrls = [
//     user?.ollamaUrl,
//     process.env.OLLAMA_API_BASE_URL
//   ].filter(url => url && typeof url === 'string');

//   let isOllamaActuallyUp = false;
//   let workingOllamaUrl = null;

//   // Probe all Ollama URLs concurrently — first healthy one wins
//   if (ollamaUrls.length > 0) {
//       const results = await Promise.allSettled(
//           ollamaUrls.map(async (url) => {
//               const trimmed = url.trim();
//               const healthy = await checkOllamaHealth(trimmed);
//               if (!healthy) throw new Error('unhealthy');
//               return trimmed;
//           })
//       );
//       const first = results.find(r => r.status === 'fulfilled');
//       if (first) {
//           isOllamaActuallyUp = true;
//           workingOllamaUrl = first.value;
//       }
//   }

//   if (routingMode !== 'auto' && selectedModelId) {
//     const manualModel = catalogFind({ modelId: selectedModelId }) || await LLMConfiguration.findOne({ modelId: selectedModelId }).lean();
//     if (manualModel) {
//       if (manualModel.provider === 'ollama' && !isOllamaActuallyUp) {
//         log.warn('AI', `Manual model ${selectedModelId} requested but Ollama is unreachable; falling back to provider routing.`);
//       } else {
//         log.info('AI', `Manual model selection active: ${manualModel.modelId}`);
//         return {
//           chosenModel: { ...manualModel, workingUrl: workingOllamaUrl },
//           logic: 'manual_model_selection',
//           modelRoutingMode: routingMode,
//         };
//       }
//     }
//   }

//   if (routingMode === 'auto') {
//     try {
//       // ── Check routing decision cache (Redis, 5-min TTL keyed by query hash+provider) ──
//       const cachedModelId = await getCachedRoutingDecision(`${cacheKey}:${preferredProvider}`);
//       if (cachedModelId) {
//         const cachedModel = catalogFind({ modelId: cachedModelId }) || await LLMConfiguration.findOne({ modelId: cachedModelId }).lean();
//         if (cachedModel) {
//           log.info('AI', `[RoutingCache] HIT — routing to ${cachedModelId}`);
//           return {
//             chosenModel: { ...cachedModel, workingUrl: workingOllamaUrl },
//             logic: 'routing_cache_hit',
//             modelRoutingMode: routingMode,
//           };
//         }
//       }

//       let autoDecision = null;
//       if (redisClient && redisClient.isOpen) {
//         const cached = await redisClient.get(`router:model:${cacheKey}`);
//         if (cached) {
//           autoDecision = JSON.parse(cached);
//         }
//       }

//       if (!autoDecision) {
//         const catalog = catalogFindAll({ provider: { $in: ['ollama', 'gemini'] } });
//         const catalogForAutoRoute = catalog.length ? catalog : await LLMConfiguration.find({ provider: { $in: ['ollama', 'gemini'] } }).lean();
//         const tokenEstimate = Math.ceil(query.length / 3) + ((Array.isArray(context.chatHistory) ? context.chatHistory.length : 0) * 40);
//         const reasoningMode = context.deepResearchContext
//           ? 'deep_research'
//           : ((context.criticalThinkingEnabled || context.useReAct) ? 'complex_reasoning' : 'standard');
//         const complexityScore = calculateComplexityScore({ query, tokenEstimate, reasoningMode });

//         autoDecision = await selectModel({
//           complexityScore,
//           reasoningMode,
//           tokenEstimate,
//           userPreference: preferredProvider,
//           latencyBudget: context.latencyBudget || 'balanced',
//           localMode: preferredProvider === 'ollama',
//           isOllamaActive: isOllamaActuallyUp,
//           catalog: catalogForAutoRoute,
//         });

//         if (redisClient && redisClient.isOpen) {
//           await redisClient.setEx(`router:model:${cacheKey}`, AUTO_ROUTING_TTL, JSON.stringify(autoDecision));
//         }
//       }

//       if (autoDecision?.modelId) {
//         const autoModel = catalogFind({ modelId: autoDecision.modelId }) || await LLMConfiguration.findOne({ modelId: autoDecision.modelId }).lean();
//         if (autoModel) {
//           // Persist routing decision to cache so future identical queries skip the heavy routing logic
//           await cacheRoutingDecision(`${cacheKey}:${preferredProvider}`, autoDecision.modelId);
//           return {
//             chosenModel: { ...autoModel, workingUrl: workingOllamaUrl },
//             logic: 'auto_smart_model_router',
//             modelRoutingMode: routingMode,
//             routingDecision: autoDecision,
//           };
//         }
//       }

//       if (autoDecision?.provider) {
//         preferredProvider = autoDecision.provider;
//       }
//     } catch (autoRoutingError) {
//       log.warn('AI', `Smart model routing failed, using legacy router: ${autoRoutingError.message}`);
//     }
//   }

//   const resolvedProvider = await resolveProviderByPreference({
//     preferredProvider,
//     userApiKey: null,
//     userOllamaUrl: user?.ollamaUrl || null,
//     skipOllamaHealthCheck: false,
//   });
//   preferredProvider = resolvedProvider.chosenProvider;
//   if (resolvedProvider.workingOllamaUrl) {
//     workingOllamaUrl = resolvedProvider.workingOllamaUrl;
//   }

//   // ── PRIORITY -1: SGLang (when deployed) ──────────────────────────────────────
//   // When SGLANG_ENABLED=true SGLang beats every other provider.
//   // semantic route from context determines which SGLang endpoint (chat / reason / heavy).
//   if (SGLANG_ENABLED) {
//     try {
//       const sglangService = require('./sglangService');
//       const semanticRoute = context.semanticRoute || context.queryIntent?.semanticRoute || null;
//       const endpoint = (semanticRoute === 'tot' || context.criticalThinkingEnabled || context.useReAct)
//           ? 'reason' : 'chat';
//       const modelId = endpoint === 'reason'
//           ? (process.env.SGLANG_REASON_MODEL || 'Qwen/Qwen2.5-14B-Instruct-AWQ')
//           : (process.env.SGLANG_CHAT_MODEL   || 'Qwen/Qwen2.5-14B-Instruct-AWQ');

//       log.info('AI', `[SGLang] PRIORITY-1 route → endpoint=${endpoint} model=${modelId}`);
//       return {
//         chosenModel: {
//           modelId,
//           provider:     'sglang',
//           displayName:  `SGLang ${modelId}`,
//           workingUrl:   endpoint === 'reason'
//               ? (process.env.SGLANG_REASON_URL || 'http://localhost:8000/v1')
//               : (process.env.SGLANG_CHAT_URL   || 'http://localhost:8000/v1'),
//           _sglangEndpoint: endpoint,
//           _sglangService:  sglangService,
//         },
//         logic:          `sglang_priority1_${endpoint}`,
//         modelRoutingMode: routingMode,
//       };
//     } catch (sglangErr) {
//       log.warn('AI', `[SGLang] Priority-1 routing failed (${sglangErr.message}) — falling back to Ollama/Gemini`);
//     }
//   }

//   // PRIORITY 0: Tutor Mode
//   if (context.tutorMode) {
//     const customTutorModel = catalogFind({ modelId: 'ai-tutor-custom:latest', provider: 'ollama' }) 
//         || await LLMConfiguration.findOne({ modelId: 'ai-tutor-custom:latest', provider: 'ollama' });
//       if (customTutorModel) {
//         log.info('AI', `Routing to specialized tutor model: ${customTutorModel.modelId}`);
//         const chosen = customTutorModel.toObject ? customTutorModel.toObject() : customTutorModel;
//         return { 
//           chosenModel: { ...chosen, workingUrl: workingOllamaUrl }, 
//           logic: 'tutor_mode_priority' 
//         };
//       }
//     }
  
//     // PRIORITY 0.5: Course-Specific Mapping
//     if (context.courseId) {
//       try {
//         const adapterMapping = await CourseAdapterMapping.findOne({
//           courseId: context.courseId,
//           isActive: true,
//         }).lean();
  
//         if (adapterMapping) {
//           const adapterConfig = await LLMConfiguration.findOne({ modelId: adapterMapping.adapterName }).lean();
//           const baseModelObj = adapterConfig || {
//             modelId: adapterMapping.adapterName,
//             provider: adapterMapping.provider || 'fine-tuned',
//             displayName: `${adapterMapping.adapterName} (${adapterMapping.version})`,
//             baseModel: adapterMapping.baseModel,
//           };
  
//           log.info('AI', `Routing to course adapter: ${baseModelObj.modelId}`);
  
//           return {
//             chosenModel: { ...baseModelObj, workingUrl: workingOllamaUrl },
//             logic: `course_adapter_mapping_${context.courseId}`,
//             adapterUsed: adapterMapping.adapterName,
//             adapterVersion: adapterMapping.version,
//           };
//         }
//     } catch (adapterErr) {
//       log.warn('AI', `Course adapter check failed: ${adapterErr.message}`);
//     }
//   }

//   if (subject) {
//     const fineTunedModel = catalogFind({ provider: 'fine-tuned', subjectFocus: subject })
//         || await LLMConfiguration.findOne({ provider: 'fine-tuned', subjectFocus: subject });
//     if (fineTunedModel) {
//       log.info('AI', `Routing to subject specialized model: ${fineTunedModel.modelId}`);
//       return { chosenModel: fineTunedModel, logic: 'subject_match_finetuned' };
//     }
//   }

//   let classification;
//   if (classificationCache.has(cacheKey)) {
//     classification = classificationCache.get(cacheKey);
//   } else if (redisClient && redisClient.isOpen) {
//     try {
//       const cached = await redisClient.get(`router:intent:${cacheKey}`);
//       if (cached) {
//         classification = JSON.parse(cached);
//         classificationCache.set(cacheKey, classification);
//       }
//     } catch (err) {
//       log.warn('AI', `Intent cache read failed: ${err.message}`);
//     }
//   }

//   if (!classification) {
//     try {
//       classification = await classifyQuery(query, {
//         preferredProvider,
//         enforcePreferredProvider: Boolean(context.deepResearchContext)
//       });
//     } catch (e) {
//       classification = { category: 'chat', confidence: 0, strength: 'chat' };
//     }
//     classificationCache.set(cacheKey, classification);
//     if (redisClient && redisClient.isOpen) {
//       try {
//         await redisClient.setEx(`router:intent:${cacheKey}`, CLASSIFICATION_TTL, JSON.stringify(classification));
//       } catch (err) {
//         log.warn('AI', `Intent cache write failed: ${err.message}`);
//       }
//     }
//   }

//   if (classification.confidence >= 0.5) {
//     log.info('AI', `Intent: ${classification.category} (Conf: ${classification.confidence.toFixed(1)})`);
//   }

//   if (classification.confidence >= 0.7 || classification.category !== 'chat') {
//     const specializedModel = catalogFind({ provider: preferredProvider, strengths: classification.strength })
//         || await LLMConfiguration.findOne({ provider: preferredProvider, strengths: classification.strength });

//     if (specializedModel) {
//       log.info('AI', `Specialized route: ${specializedModel.modelId} (${specializedModel.provider})`);
//       return {
//         chosenModel: specializedModel,
//         logic: `ml_classification_${classification.category}_${preferredProvider}`,
//         classification
//       };
//     }
//   }

//   // No fallback — use exactly the user's chosen provider. Fail clearly if unavailable.
//   const catalogModel = catalogFind({ provider: preferredProvider })
//       || await LLMConfiguration.findOne({ provider: preferredProvider }).then(m => m?.toObject?.() || m);
//   if (catalogModel) {
//     return {
//       chosenModel: { ...catalogModel, workingUrl: workingOllamaUrl },
//       logic: `catalog_strict_${preferredProvider}`,
//       classification
//     };
//   }

//   const defaultModelId = (SGLANG_ENABLED || preferredProvider === 'ollama' || preferredProvider === 'local_llm')
//     ? (process.env.SGLANG_CHAT_MODEL || 'Qwen/Qwen2.5-7B-Instruct-AWQ')
//     : (process.env.GEMINI_MODEL || 'gemini-2.0-flash');

//   return {
//     chosenModel: { modelId: defaultModelId, provider: SGLANG_ENABLED ? 'sglang' : preferredProvider, workingUrl: workingOllamaUrl },
//     logic: 'strict_hardcoded_default',
//     classification
//   };
// }

// const LLMRouter = {
//   async generate({ query, systemPrompt = null, chatHistory = [], userId = null, deepResearchContext = false, onToken = null }) {
//     try {
//       const { chosenModel } = await selectLLM(query, { userId, deepResearchContext });

//       let apiKey = chosenModel.apiKey;
//       if (!apiKey && chosenModel.provider === 'gemini') {
//         apiKey = process.env.GEMINI_API_KEY;
//       }

//       const llmOptions = {
//         apiKey,
//         model: chosenModel.modelId,
//         temperature: deepResearchContext ? 0.2 : 0.7,
//         maxOutputTokens: deepResearchContext ? 8192 : 4096,
//         ollamaUrl: chosenModel.workingUrl 
//       };

//       if (onToken) {
//         // STREAMING PATH — all providers now supported
//         const streamMessages = [...chatHistory, { role: 'user', content: query }];

//         if (chosenModel.provider === 'sglang') {
//           // Dynamic token calculation for SGLang to prevent context overflow
//           const allText = chatHistory.map(m => m.content).join(' ') + query + (systemPrompt || '');
//           const estimatedInputTokens = Math.ceil(allText.length / 4);
//           const modelMaxContext = sglangCaps.getModelMaxContext(); // live from /v1/models
//           const safetyBuffer = 200;
//           const availableForCompletion = Math.max(512, modelMaxContext - estimatedInputTokens - safetyBuffer);
//           const adjustedMaxTokens = Math.min(llmOptions.maxOutputTokens || 4096, availableForCompletion);
          
//           log.info('AI', `[SGLang Deep Research] Token budget: input≈${estimatedInputTokens} + completion=${adjustedMaxTokens} ≈ ${estimatedInputTokens + adjustedMaxTokens} / ${modelMaxContext}`);
          
//           return await chosenModel._sglangService.streamChat(
//             chatHistory, query, systemPrompt,
//             { model: chosenModel.modelId, ollamaUrl: chosenModel.workingUrl, maxTokens: adjustedMaxTokens },
//             onToken
//           );
//         }

//         if (chosenModel.provider === 'ollama') {
//           return await ollamaService.streamChat(
//             chatHistory,
//             query,
//             systemPrompt,
//             llmOptions,
//             (token) => {
//               if (typeof token === 'string') onToken({ type: 'token', content: token });
//               else onToken(token);
//             }
//           );
//         }

//         // All other providers go through the unified streaming service
//         return await llmStreamingService.streamCompletion({
//           messages: streamMessages,
//           provider: chosenModel.provider,
//           model: chosenModel.modelId,
//           apiKey: llmOptions.apiKey,
//           systemPrompt,
//           onToken,
//           options: llmOptions
//         });
//       }

//       const llmService = chosenModel.provider === 'sglang'
//           ? chosenModel._sglangService
//           : (chosenModel.provider === 'ollama' ? ollamaService : geminiService);

//       return await llmService.generateContentWithHistory(chatHistory, query, systemPrompt, llmOptions);
//     } catch (error) {
//       log.error('AI', `Generation failed: ${error.message}`);
//       throw error;
//     }
//   }
// };

// module.exports = { selectLLM, LLMRouter, refreshCatalog };






const log         = require('../utils/logger');
const sglangCaps  = require('./sglangCapabilities');
const LLMConfiguration = require('../models/LLMConfiguration');
const CourseAdapterMapping = require('../models/CourseAdapterMapping');
const User = require('../models/User');
const { checkOllamaHealth } = require('./ollamaHealthService');
const geminiService = require('./geminiService');
const ollamaService = require('./ollamaService');
const llmStreamingService = require('./llmStreamingService');
const { redisClient } = require('../config/redisClient');
const { classifyQuery } = require('./queryClassifierService');
const { selectModel, calculateComplexityScore, tuneParameters } = require('./smartModelRouterService');
const { resolveProviderByPreference, getProviderChain } = require('./providerPriorityService');
const { getCachedRoutingDecision, cacheRoutingDecision } = require('./routingCacheService');
const { truncateContextToWindow } = require('../utils/tokenOptimizer');

// SGLang — lazy-imported so the server starts cleanly when SGLANG_ENABLED=false
const SGLANG_ENABLED = process.env.SGLANG_ENABLED === 'true';

// Groq — available when API key is set
const GROQ_API_KEY = process.env.GROQ_API_KEY || null;
const GROQ_ENABLED = Boolean(GROQ_API_KEY);
const GROQ_MODEL   = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

const CLASSIFICATION_TTL = 300; // 5 min — tutor/subject context changes frequently
const AUTO_ROUTING_TTL = 300;  // 5 min for auto smart-router decisions
const CATALOG_REFRESH_INTERVAL = 60000; // 1 min catalog refresh

const classificationCache = new Map();
// Clear cache periodically to prevent memory leak
setInterval(() => classificationCache.clear(), 60000);

// --- Pre-loaded LLM Catalog (avoids per-request DB queries) ---
let _catalogCache = [];
let _catalogLastRefresh = 0;

/**
 * Pre-load the LLM catalog from MongoDB into memory.
 * Called at startup and refreshed every 60 seconds.
 */
async function refreshCatalog() {
    try {
        _catalogCache = await LLMConfiguration.find({}).lean();
        _catalogLastRefresh = Date.now();
        // Only log on first load or when models exist (reduce noise)
        if (_catalogCache.length > 0) {
            log.info('AI', `LLM catalog refreshed: ${_catalogCache.length} models loaded`);
        }
    } catch (err) {
        log.warn('AI', `Catalog refresh failed: ${err.message}`);
    }
}

/**
 * Get a model from the pre-loaded catalog by query filter.
 * Falls back to DB if catalog is stale or empty.
 */
function catalogFind(filter) {
    if (!_catalogCache.length) return null;
    return _catalogCache.find(m => {
        for (const [key, val] of Object.entries(filter)) {
            if (key === '$in' || typeof val === 'object') continue;
            // Handle array field membership (e.g. strengths)
            if (Array.isArray(m[key])) {
                if (!m[key].includes(val)) return false;
                continue;
            }
            if (m[key] !== val) return false;
        }
        return true;
    });
}

function catalogFindAll(filter) {
    if (!_catalogCache.length) return [];
    const providerList = filter.provider?.$in;
    if (providerList) {
        return _catalogCache.filter(m => providerList.includes(m.provider));
    }
    return _catalogCache.filter(m => {
        for (const [key, val] of Object.entries(filter)) {
            if (typeof val === 'object') continue;
            if (m[key] !== val) return false;
        }
        return true;
    });
}

function catalogExists(filter) {
    return !!catalogFind(filter);
}

// Refresh catalog every minute
setInterval(refreshCatalog, CATALOG_REFRESH_INTERVAL);
// Initial load — call immediately (catalog populated before first request)
refreshCatalog();

/**
 * Returns a synthetic Groq chosenModel object.
 * Used as fallback when SGLang is disabled and Ollama is unreachable.
 */
function groqFallbackModel(logic = 'groq_fallback') {
    return {
        chosenModel: {
            modelId:     GROQ_MODEL,
            provider:    'groq',
            displayName: `Groq ${GROQ_MODEL}`,
            workingUrl:  null,
        },
        logic,
    };
}

/**
 * Intelligently selects the best LLM for a given query and context.
 */
async function selectLLM(query, context) {
  let user = context.user;
  const { userId, subject } = context;

  if (!user && userId) {
    user = await User.findById(userId).lean();
  }

  const effectiveUserId = user?._id || userId;
  // Include tutorMode + subject so routing decisions are context-aware
  const cacheKey = `${query}_${effectiveUserId}_${context.tutorMode ? '1' : '0'}_${context.subject || ''}`;
  const routingMode = user?.modelRoutingMode === 'auto' ? 'auto' : 'manual';
  const selectedModelId = String(user?.selectedModelId || '').trim();

  let preferredProvider = user?.preferredLlmProvider || 'ollama';
  // 'local_llm' is the frontend alias for local inference — treat as 'ollama'
  if (preferredProvider === 'local_llm') preferredProvider = 'ollama';
  // When SGLang is enabled, always prefer local — never route to Gemini
  if (SGLANG_ENABLED) preferredProvider = 'ollama';
  const lowerQuery = query.toLowerCase();

  const ollamaUrls = [
    user?.ollamaUrl,
    process.env.OLLAMA_API_BASE_URL
  ].filter(url => url && typeof url === 'string');

  let isOllamaActuallyUp = false;
  let workingOllamaUrl = null;

  // Probe all Ollama URLs concurrently — first healthy one wins
  if (ollamaUrls.length > 0) {
      const results = await Promise.allSettled(
          ollamaUrls.map(async (url) => {
              const trimmed = url.trim();
              const healthy = await checkOllamaHealth(trimmed);
              if (!healthy) throw new Error('unhealthy');
              return trimmed;
          })
      );
      const first = results.find(r => r.status === 'fulfilled');
      if (first) {
          isOllamaActuallyUp = true;
          workingOllamaUrl = first.value;
      }
  }

  // ── EARLY GROQ FALLBACK ───────────────────────────────────────────────────
  // When SGLang is disabled AND Ollama is unreachable AND Groq key is available,
  // skip all routing logic and go straight to Groq. This prevents every downstream
  // path from crashing with a SGLang/Ollama error.
  if (!SGLANG_ENABLED && !isOllamaActuallyUp && GROQ_ENABLED) {
    log.info('AI', `[Router] SGLang disabled + Ollama unreachable → routing to Groq (${GROQ_MODEL})`);
    return groqFallbackModel('groq_early_fallback_no_local');
  }

  if (routingMode !== 'auto' && selectedModelId) {
    const manualModel = catalogFind({ modelId: selectedModelId }) || await LLMConfiguration.findOne({ modelId: selectedModelId }).lean();
    if (manualModel) {
      if (manualModel.provider === 'ollama' && !isOllamaActuallyUp) {
        log.warn('AI', `Manual model ${selectedModelId} requested but Ollama is unreachable; falling back to provider routing.`);
      } else {
        log.info('AI', `Manual model selection active: ${manualModel.modelId}`);
        return {
          chosenModel: { ...manualModel, workingUrl: workingOllamaUrl },
          logic: 'manual_model_selection',
          modelRoutingMode: routingMode,
        };
      }
    }
  }

  if (routingMode === 'auto') {
    try {
      // ── Check routing decision cache (Redis, 5-min TTL keyed by query hash+provider) ──
      const cachedModelId = await getCachedRoutingDecision(`${cacheKey}:${preferredProvider}`);
      if (cachedModelId) {
        const cachedModel = catalogFind({ modelId: cachedModelId }) || await LLMConfiguration.findOne({ modelId: cachedModelId }).lean();
        if (cachedModel) {
          // Don't use cached ollama decision if Ollama is now down
          if (cachedModel.provider === 'ollama' && !isOllamaActuallyUp) {
            log.warn('AI', `[RoutingCache] HIT for ollama but Ollama is down — skipping cache`);
          } else {
            log.info('AI', `[RoutingCache] HIT — routing to ${cachedModelId}`);
            return {
              chosenModel: { ...cachedModel, workingUrl: workingOllamaUrl },
              logic: 'routing_cache_hit',
              modelRoutingMode: routingMode,
            };
          }
        }
      }

      let autoDecision = null;
      if (redisClient && redisClient.isOpen) {
        const cached = await redisClient.get(`router:model:${cacheKey}`);
        if (cached) {
          autoDecision = JSON.parse(cached);
          // Invalidate cached ollama decision if Ollama is now down
          if (autoDecision?.provider === 'ollama' && !isOllamaActuallyUp) {
            log.warn('AI', `[AutoRoute] Cached decision was ollama but Ollama is down — recomputing`);
            autoDecision = null;
          }
        }
      }

      if (!autoDecision) {
        const catalog = catalogFindAll({ provider: { $in: ['ollama', 'gemini'] } });
        const catalogForAutoRoute = catalog.length ? catalog : await LLMConfiguration.find({ provider: { $in: ['ollama', 'gemini'] } }).lean();
        const tokenEstimate = Math.ceil(query.length / 3) + ((Array.isArray(context.chatHistory) ? context.chatHistory.length : 0) * 40);
        const reasoningMode = context.deepResearchContext
          ? 'deep_research'
          : ((context.criticalThinkingEnabled || context.useReAct) ? 'complex_reasoning' : 'standard');
        const complexityScore = calculateComplexityScore({ query, tokenEstimate, reasoningMode });

        autoDecision = await selectModel({
          query,
          complexityScore,
          reasoningMode,
          tokenEstimate,
          userPreference: preferredProvider,
          latencyBudget: context.latencyBudget || 'balanced',
          localMode: preferredProvider === 'ollama',
          isOllamaActive: isOllamaActuallyUp,
          catalog: catalogForAutoRoute,
        });

        if (redisClient && redisClient.isOpen) {
          await redisClient.setEx(`router:model:${cacheKey}`, AUTO_ROUTING_TTL, JSON.stringify(autoDecision));
        }
      }

      if (autoDecision?.modelId) {
        const autoModel = catalogFind({ modelId: autoDecision.modelId }) || await LLMConfiguration.findOne({ modelId: autoDecision.modelId }).lean();
        if (autoModel) {
          // Don't route to ollama if it's actually down
          if (autoModel.provider === 'ollama' && !isOllamaActuallyUp) {
            log.warn('AI', `[AutoRoute] selectModel chose ollama (${autoModel.modelId}) but Ollama is down — falling to Groq`);
            if (GROQ_ENABLED) return groqFallbackModel('groq_fallback_auto_ollama_down');
          } else {
            // Persist routing decision to cache so future identical queries skip the heavy routing logic
            await cacheRoutingDecision(`${cacheKey}:${preferredProvider}`, autoDecision.modelId);
            return {
              chosenModel: { ...autoModel, workingUrl: workingOllamaUrl },
              logic: 'auto_smart_model_router',
              modelRoutingMode: routingMode,
              routingDecision: autoDecision,
            };
          }
        }
      }

      if (autoDecision?.provider) {
        preferredProvider = autoDecision.provider;
      }
    } catch (autoRoutingError) {
      log.warn('AI', `Smart model routing failed, using legacy router: ${autoRoutingError.message}`);
    }
  }

  const resolvedProvider = await resolveProviderByPreference({
    preferredProvider,
    userApiKey: null,
    userOllamaUrl: user?.ollamaUrl || null,
    skipOllamaHealthCheck: false,
  });
  preferredProvider = resolvedProvider.chosenProvider;
  if (resolvedProvider.workingOllamaUrl) {
    workingOllamaUrl = resolvedProvider.workingOllamaUrl;
  }

  // ── PRIORITY -1: SGLang (when deployed) ──────────────────────────────────────
  // When SGLANG_ENABLED=true SGLang beats every other provider.
  // semantic route from context determines which SGLang endpoint (chat / reason / heavy).
  if (SGLANG_ENABLED) {
    try {
      const sglangService = require('./sglangService');
      const semanticRoute = context.semanticRoute || context.queryIntent?.semanticRoute || null;
      const endpoint = (semanticRoute === 'tot' || context.criticalThinkingEnabled || context.useReAct)
          ? 'reason' : 'chat';
      const modelId = endpoint === 'reason'
          ? (process.env.SGLANG_REASON_MODEL || 'Qwen/Qwen2.5-14B-Instruct-AWQ')
          : (process.env.SGLANG_CHAT_MODEL   || 'Qwen/Qwen2.5-14B-Instruct-AWQ');

      log.info('AI', `[SGLang] PRIORITY-1 route → endpoint=${endpoint} model=${modelId}`);
      return {
        chosenModel: {
          modelId,
          provider:     'sglang',
          displayName:  `SGLang ${modelId}`,
          workingUrl:   endpoint === 'reason'
              ? (process.env.SGLANG_REASON_URL || 'http://localhost:8000/v1')
              : (process.env.SGLANG_CHAT_URL   || 'http://localhost:8000/v1'),
          _sglangEndpoint: endpoint,
          _sglangService:  sglangService,
        },
        logic:          `sglang_priority1_${endpoint}`,
        modelRoutingMode: routingMode,
      };
    } catch (sglangErr) {
      log.warn('AI', `[SGLang] Priority-1 routing failed (${sglangErr.message}) — falling back to Ollama/Gemini`);
    }
  }

  // PRIORITY 0: Tutor Mode
  if (context.tutorMode) {
    const customTutorModel = catalogFind({ modelId: 'ai-tutor-custom:latest', provider: 'ollama' }) 
        || await LLMConfiguration.findOne({ modelId: 'ai-tutor-custom:latest', provider: 'ollama' });
      if (customTutorModel && isOllamaActuallyUp) {
        log.info('AI', `Routing to specialized tutor model: ${customTutorModel.modelId}`);
        const chosen = customTutorModel.toObject ? customTutorModel.toObject() : customTutorModel;
        return { 
          chosenModel: { ...chosen, workingUrl: workingOllamaUrl }, 
          logic: 'tutor_mode_priority' 
        };
      }
    }
  
    // PRIORITY 0.5: Course-Specific Mapping
    if (context.courseId) {
      try {
        const adapterMapping = await CourseAdapterMapping.findOne({
          courseId: context.courseId,
          isActive: true,
        }).lean();
  
        if (adapterMapping) {
          const adapterConfig = await LLMConfiguration.findOne({ modelId: adapterMapping.adapterName }).lean();
          const baseModelObj = adapterConfig || {
            modelId: adapterMapping.adapterName,
            provider: adapterMapping.provider || 'fine-tuned',
            displayName: `${adapterMapping.adapterName} (${adapterMapping.version})`,
            baseModel: adapterMapping.baseModel,
          };
  
          log.info('AI', `Routing to course adapter: ${baseModelObj.modelId}`);
  
          return {
            chosenModel: { ...baseModelObj, workingUrl: workingOllamaUrl },
            logic: `course_adapter_mapping_${context.courseId}`,
            adapterUsed: adapterMapping.adapterName,
            adapterVersion: adapterMapping.version,
          };
        }
    } catch (adapterErr) {
      log.warn('AI', `Course adapter check failed: ${adapterErr.message}`);
    }
  }

  if (subject) {
    const fineTunedModel = catalogFind({ provider: 'fine-tuned', subjectFocus: subject })
        || await LLMConfiguration.findOne({ provider: 'fine-tuned', subjectFocus: subject });
    if (fineTunedModel) {
      log.info('AI', `Routing to subject specialized model: ${fineTunedModel.modelId}`);
      return { chosenModel: fineTunedModel, logic: 'subject_match_finetuned' };
    }
  }

  let classification;
  if (classificationCache.has(cacheKey)) {
    classification = classificationCache.get(cacheKey);
  } else if (redisClient && redisClient.isOpen) {
    try {
      const cached = await redisClient.get(`router:intent:${cacheKey}`);
      if (cached) {
        classification = JSON.parse(cached);
        classificationCache.set(cacheKey, classification);
      }
    } catch (err) {
      log.warn('AI', `Intent cache read failed: ${err.message}`);
    }
  }

  if (!classification) {
    try {
      classification = await classifyQuery(query, {
        preferredProvider,
        enforcePreferredProvider: Boolean(context.deepResearchContext)
      });
    } catch (e) {
      classification = { category: 'chat', confidence: 0, strength: 'chat' };
    }
    classificationCache.set(cacheKey, classification);
    if (redisClient && redisClient.isOpen) {
      try {
        await redisClient.setEx(`router:intent:${cacheKey}`, CLASSIFICATION_TTL, JSON.stringify(classification));
      } catch (err) {
        log.warn('AI', `Intent cache write failed: ${err.message}`);
      }
    }
  }

  if (classification.confidence >= 0.5) {
    log.info('AI', `Intent: ${classification.category} (Conf: ${classification.confidence.toFixed(1)})`);
  }

  if (classification.confidence >= 0.7 || classification.category !== 'chat') {
    const specializedModel = catalogFind({ provider: preferredProvider, strengths: classification.strength })
        || await LLMConfiguration.findOne({ provider: preferredProvider, strengths: classification.strength });

    if (specializedModel) {
      // Don't use ollama specialized model if Ollama is down
      if (specializedModel.provider === 'ollama' && !isOllamaActuallyUp) {
        log.warn('AI', `[Router] Specialized ollama model found but Ollama is down — skipping`);
      } else {
        log.info('AI', `Specialized route: ${specializedModel.modelId} (${specializedModel.provider})`);
        return {
          chosenModel: specializedModel,
          logic: `ml_classification_${classification.category}_${preferredProvider}`,
          classification
        };
      }
    }
  }

  // No fallback — use exactly the user's chosen provider. Fail clearly if unavailable.
  const catalogModel = catalogFind({ provider: preferredProvider })
      || await LLMConfiguration.findOne({ provider: preferredProvider }).then(m => m?.toObject?.() || m);
  if (catalogModel) {
    // Don't route to ollama catalog model if Ollama is down
    if (catalogModel.provider === 'ollama' && !isOllamaActuallyUp) {
      log.warn('AI', `[Router] Catalog model is ollama but Ollama is down — falling to Groq`);
      if (GROQ_ENABLED) return groqFallbackModel('groq_fallback_catalog_ollama_down');
    } else {
      return {
        chosenModel: { ...catalogModel, workingUrl: workingOllamaUrl },
        logic: `catalog_strict_${preferredProvider}`,
        classification
      };
    }
  }

  // ── LAST RESORT: Groq → Gemini → hardcoded default ───────────────────────
  if (GROQ_ENABLED) {
    log.info('AI', `[Router] No provider available — last resort Groq fallback`);
    return groqFallbackModel('groq_last_resort');
  }

  const defaultModelId = (SGLANG_ENABLED || preferredProvider === 'ollama' || preferredProvider === 'local_llm')
    ? (process.env.SGLANG_CHAT_MODEL || 'Qwen/Qwen2.5-7B-Instruct-AWQ')
    : (process.env.GEMINI_MODEL || 'gemini-2.0-flash');

  return {
    chosenModel: { modelId: defaultModelId, provider: SGLANG_ENABLED ? 'sglang' : preferredProvider, workingUrl: workingOllamaUrl },
    logic: 'strict_hardcoded_default',
    classification
  };
}

const LLMRouter = {
  async generate({ query, systemPrompt = null, chatHistory = [], userId = null, deepResearchContext = false, onToken = null }) {
    try {
      const { chosenModel, routingDecision } = await selectLLM(query, { userId, deepResearchContext });

      let apiKey = chosenModel.apiKey;
      if (!apiKey && chosenModel.provider === 'gemini') {
        apiKey = process.env.GEMINI_API_KEY;
      }
      if (!apiKey && chosenModel.provider === 'groq') {
        apiKey = process.env.GROQ_API_KEY;
      }

      const tunedParams = routingDecision?.tunedParameters || tuneParameters({
        query,
        reasoningMode: deepResearchContext ? 'deep_research' : 'standard'
      });
      const temperature = tunedParams.temperature ?? (deepResearchContext ? 0.2 : 0.7);
      const maxOutputTokens = tunedParams.maxOutputTokens ?? (deepResearchContext ? 8192 : 4096);

      const llmOptions = {
        apiKey,
        model: chosenModel.modelId,
        temperature,
        maxOutputTokens,
        ollamaUrl: chosenModel.workingUrl 
      };

      let maxLimit = 24000;
      if (chosenModel.provider === 'gemini') maxLimit = 400000;
      else if (chosenModel.provider === 'groq' && chosenModel.modelId && chosenModel.modelId.includes('70b')) maxLimit = 120000;

      if (onToken) {
        // STREAMING PATH — all providers now supported
        const rawStreamMessages = [...chatHistory, { role: 'user', content: query }];
        const streamMessages = truncateContextToWindow(rawStreamMessages, maxLimit);
        const truncatedUserQuery = streamMessages[streamMessages.length - 1]?.content || query;
        const truncatedChatHistory = streamMessages.slice(0, -1);

        if (chosenModel.provider === 'sglang') {
          // Dynamic token calculation for SGLang to prevent context overflow
          const allText = truncatedChatHistory.map(m => m.content).join(' ') + truncatedUserQuery + (systemPrompt || '');
          const estimatedInputTokens = Math.ceil(allText.length / 4);
          const modelMaxContext = sglangCaps.getModelMaxContext(); // live from /v1/models
          const safetyBuffer = 200;
          const availableForCompletion = Math.max(512, modelMaxContext - estimatedInputTokens - safetyBuffer);
          const adjustedMaxTokens = Math.min(llmOptions.maxOutputTokens || 4096, availableForCompletion);
          
          log.info('AI', `[SGLang Deep Research] Token budget: input≈${estimatedInputTokens} + completion=${adjustedMaxTokens} ≈ ${estimatedInputTokens + adjustedMaxTokens} / ${modelMaxContext}`);
          
          return await chosenModel._sglangService.streamChat(
            truncatedChatHistory, truncatedUserQuery, systemPrompt,
            { model: chosenModel.modelId, ollamaUrl: chosenModel.workingUrl, maxTokens: adjustedMaxTokens },
            onToken
          );
        }

        if (chosenModel.provider === 'ollama') {
          return await ollamaService.streamChat(
            truncatedChatHistory,
            truncatedUserQuery,
            systemPrompt,
            llmOptions,
            (token) => {
              if (typeof token === 'string') onToken({ type: 'token', content: token });
              else onToken(token);
            }
          );
        }

        // All other providers (groq, gemini, anthropic, mistral) go through unified streaming
        return await llmStreamingService.streamCompletion({
          messages: streamMessages,
          provider: chosenModel.provider,
          model: chosenModel.modelId,
          apiKey: llmOptions.apiKey,
          systemPrompt,
          onToken,
          options: llmOptions
        });
      }

      const rawMessages = [...chatHistory, { role: 'user', content: query }];
      const optimizedMessages = truncateContextToWindow(rawMessages, maxLimit);
      const finalUserQuery = optimizedMessages[optimizedMessages.length - 1]?.content || query;
      const finalChatHistory = optimizedMessages.slice(0, -1);

      const llmService = chosenModel.provider === 'sglang'
          ? chosenModel._sglangService
          : (chosenModel.provider === 'ollama' ? ollamaService : geminiService);

      return await llmService.generateContentWithHistory(finalChatHistory, finalUserQuery, systemPrompt, llmOptions);
    } catch (error) {
      log.error('AI', `Generation failed: ${error.message}`);
      throw error;
    }
  }
};

module.exports = { selectLLM, LLMRouter, refreshCatalog };
