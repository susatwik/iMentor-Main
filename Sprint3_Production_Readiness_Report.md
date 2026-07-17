# Sprint 3 Production Readiness Report

**Project:** iMentor  
**Date:** July 15, 2025  
**Version:** Sprint 3 - Intelligent LLM Router Implementation  
**Status:** ❌ NOT PRODUCTION READY (Critical issues found)

---

## Executive Summary

The Sprint 3 implementation adds an Intelligent LLM Router with task classification, complexity estimation, health-aware provider selection, and adaptive routing modes. While the core architecture is solid, **several production-critical issues must be resolved** before deployment.

**Overall Verdict:** ❌ **NOT PRODUCTION READY**

---

## 1. Intelligent Router Verification

### ✅ Router Invocation
- **File:** `server/services/llmRouterService.js:158-173`
- The Intelligent Router is invoked in `selectLLM()` when `routingMode === 'auto'`
- Logs task type, complexity, provider, model, score, and reasons

### ✅ AUTO Mode Works
- Routing decision is made and can return early via `intelligent_router_direct` logic (lines 203-232)
- Falls back to legacy smart model router if intelligent router fails (lines 235-290)

### ✅ Provider Selection Changes Based On Context
- **Task type** affects provider preference (TASK_PROVIDER_PREFERENCES in intelligentRouterService.js:323-339)
- **Complexity** selects model tier per provider (PROVIDER_MODEL_TIERS:289-320)
- **Prompt size/context length** affects context window check (line 427-431)
- **Reasoning requirements** (CoT, useReAct) affect complexity score (lines 224, 343)
- **Provider health** affects scoring (health score 30%, latency 25%, failure rate penalty)

### ✅ Model Selection Per Complexity
| Complexity | SGLang | Groq | Gemini | OpenAI | Ollama |
|------------|--------|------|--------|--------|--------|
| SMALL | 7B chat | 8B instant | 2.0 Flash | 4o-mini | 3B |
| MEDIUM | 7B chat | 70B versatile | 2.0 Flash | 4o | 7B |
| LARGE | 14B reason | 70B versatile | 1.5 Pro | 4o | 14B |
| VERY_LARGE | 35B heavy | 70B versatile | 1.5 Pro | 4o | 32B |

### ✅ Fallback Chain Preserved
The existing fallback chain in `llmRouterService.js` remains intact:
1. SGLang (Priority -1, when enabled)
2. Tutor Mode specialized model
3. Course Adapter Mapping
4. Subject Finetuned Model
5. ML Classification → Specialized Model
6. Catalog Strict (user's chosen provider)
7. Hardcoded Env Default

### ✅ Telemetry Records Every Decision
- **File:** `server/services/routingTelemetry.js`
- Logs: provider, model, task, complexity, mode, tokens, fallback count, latency, reasons
- Batched Redis writes (100 entries / 5s flush)

---

## 2. Fallback Chain Integrity

### ✅ Chain Order Verified
**File:** `server/services/llmFallbackService.js:180-181`
```
LOCAL_FIRST_CHAIN  = ['sglang', 'groq', 'gemini', 'openai', 'ollama']
CLOUD_FIRST_CHAIN  = ['groq', 'gemini', 'openai', 'sglang', 'ollama']
```

### ❌ CRITICAL: No Automated Failover Testing
- No unit/integration tests exist that force provider failures
- No chaos engineering to verify failover works under real conditions
- Manual testing required to verify each hop works

---

## 3. Concept Question Bank Pipeline

### ✅ All Generation Paths Use CQB First

| Flow | CQB Priority |
|------|--------------|
| **Quiz** (`generateOrRetrieveQuiz`:1033) | Step 1 (8s timeout) |
| **Assessment** (`generateOrRetrieveAssessment`:838) | Step 1 (8s timeout) |
| **Skill Tree** (`generateOrRetrieveLevelQuestions`:469) | Step 1 (8s timeout) |

### ✅ Pipeline Order Verified (Skill Tree Example)
```
1. ConceptQuestionBank (8s timeout)
   ↓ timeout/failure
2. Redis Cache
   ↓ miss
3. Legacy QuestionBank
   ↓ miss
4. LLM Generation → save to CQB + QuestionBank
   ↓ failure
5. Template Fallback
```

### ✅ Quiz Uses CQB with Replay Protection
- `questionGeneratorService.generateSocraticQuiz()`:64-77 fetches `seenQuestionIds`
- Passed to `contentGenerationService.generateOrRetrieveQuiz()`:101
- Passed to `conceptQuestionBankService.selectQuestionsForLevel()`:529
- Results stored via `storeSeenQuestions()`:35-43 (Redis, 30-day TTL, max 100 IDs)

### ❌ Assessment Replay Protection Incomplete
- `generateOrRetrieveAssessment`:836 gets `seenQuestionIds`
- Passes to `selectQuestionsForLevel`:854
- **BUT** no `addSeenQuestions` call after returning results
- Same for Skill Tree (`generateOrRetrieveLevelQuestions`)

---

## 4. Replay Protection

| Feature | Quiz | Assessment | Skill Tree |
|---------|------|------------|------------|
| Tracks seen questions | ✅ | ✅ (partial) | ✅ |
| Filters seen from selection | ✅ | ✅ | ✅ |
| Stores new question IDs | ✅ | ❌ Missing | ❌ Missing |
| Sorts by unseen → least used → oldest | ✅ | ✅ | ✅ |

---

## 5. Analytics Recording

| Metric | Quiz | Assessment | Skill Tree |
|--------|------|------------|------------|
| `usageCount` | ✅ | ✅ | ✅ |
| `successCount` | ✅ | ✅ | ✅ |
| `lastUsedAt` | ✅ | ✅ | ✅ |
| `studentHistory` | ✅ | ✅ | ✅ |

**Verified in:**
- Quiz: `routes/quiz.js:176-189` → `recordQuestionAttempt`
- Assessment: `routes/gamification.js:469-480` → `recordQuestionAttempt`
- Skill Tree: `routes/gamification.js:794-809` → `recordQuestionAttempt`

---

## 6. MongoDB Collections & Indexes

### ConceptQuestionBank
```javascript
// Models/ConceptQuestionBank.js:10-13, 43-44
Indexes: { course: 1, concept: 1 }, { usageCount: 1 }
```

### QuestionBank (Legacy)
```javascript
// Models/QuestionBank.js:29-31
Indexes: { course: 1, curriculumHash: 1, skillNodeId: 1 }
         { course: 1, subtopic: 1 }
         { type: 1, difficulty: 1, bloomLevel: 1 }
```

### ❌ Missing Indexes
- No compound index on `{ course: 1, concept: 1, usageCount: 1 }` for `selectQuestionsForLevel` sort
- No TTL index on `studentHistory.answeredAt` (capped at 50 but not auto-expired)

---

## 6. Redis Caching

### ✅ Cache Keys & TTL
| Cache | Key Pattern | TTL |
|-------|-------------|-----|
| Quiz | `quiz:{course}:{module}` | 1 hour (3600s) |
| Socratic Quiz | `quiz:socratic:{course}:{module}:{stage}` | 1 hour |
| Assessment | `assessment:{course}:{topic}` | 7 days |
| Skill Tree Questions | `skilltree:questions:{topic}:{level}` | 7 days |
| Seen Questions | `seen_questions:{user}:{course}:{concept}` | 30 days (max 100 IDs) |
| Routing Decision | `router:model:{queryHash}` | 5 min |
| Routing Cache | `routing_cache:{queryHash}` | 24 hours |

### ❌ Cache Invalidation Gaps
- No invalidation when new questions generated for existing concept
- No invalidation when question bank updated
- `seen_questions` keys never manually invalidated (relies on TTL)

---

## 7. Performance Benchmarks

| Operation | Expected Latency | Notes |
|-----------|-----------------|-------|
| **Router Decision (AUTO)** | ~5-15ms | Intelligent router + health checks |
| **Cold Generation (LLM)** | 3-10s | Depends on provider |
| **Warm (Redis Hit)** | 5-15ms | `routing_cache` or pipeline cache |
| **Concept Bank Hit** | 20-50ms | MongoDB + select logic |
| **Skill Tree Load** | 50-150ms | Multiple DB calls |
| **Quiz Generation** | 2-8s | Pipeline + LLM |
| **Provider Failover** | +5-15s per hop | Sequential in `callWithFallback` |

### ❌ No Benchmark Scripts
- No automated performance regression testing
- No SLA monitoring

---

## 8. Security Review

### ✅ No Secrets in Code
- No API keys, passwords, or tokens in source
- Environment variables used for all secrets

### ✅ No Stack Traces in Responses
- Centralized error handler: `server.js:317-325`
- Only `message` exposed, no stack traces

### ✅ Input Validation
- `express-mongo-sanitize` middleware (server.js:15)
- Helmet security headers (server.js:14)

### ❌ Security Vulnerabilities in Dependencies

| Package | Severity | Issue | Fix |
|---------|----------|-------|-----|
| axios 1.15.2 | **HIGH** | SSRF, Prototype Pollution, SSRF bypass | `npm audit fix` |
| ws 8.20.1 | **HIGH** | Memory disclosure, DoS | `npm audit fix` |
| uuid <11.1.1 | MODERATE | Buffer bounds check | `npm audit fix --force` |
| @opentelemetry/core | MODERATE | Memory allocation | Update @sentry/node |

**Action Required:** Run `npm audit fix` and test before production.

---

## 9. Regression Testing Checklist

| Feature | Status | Notes |
|---------|--------|-------|
| Login/Signup | ✅ | Unchanged |
| OTP Flow | ✅ | Unchanged |
| Course Explorer | ✅ | Unchanged |
| Lecture Generation | ✅ | Uses `generateOrRetrieveLecture` (unchanged) |
| Quiz Generation | ⚠️ | Now uses CQB pipeline - verify output format |
| Assessment | ⚠️ | Now uses CQB pipeline - verify output format |
| Skill Tree | ⚠️ | Uses CQB - verify replay protection |
| Concept Map | ✅ | Unchanged |
| Knowledge Graph | ✅ | Unchanged |
| CSV Upload | ✅ | Unchanged |
| CSV Reuse | ✅ | Unchanged |
| Question Replay | ⚠️ | Assessment/Skill Tree missing `addSeenQuestions` |
| LLM Fallback | ✅ | Unchanged |
| Evaluation Agent | ✅ | Unchanged |
| Analytics | ✅ | Unchanged |
| Provider Health | ✅ | New `providerHealthMonitor` |
| Router Telemetry | ✅ | New `routingTelemetry` |

---

## 10. Production Stability

### ❌ Critical Issues

| Issue | Impact | File |
|-------|--------|------|
| No `unhandledRejection` handler | Process can crash silently | `server.js` missing |
| Circular dependency | `contentGenerationService` ↔ `questionGeneratorService` | Dynamic require() works but risky |
| Circular dependency | `contentGenerationService` ↔ `conceptQuestionBankService` | Dynamic require() |
| No unhandled rejection handler | Production crashes possible | Add to `server.js` |
| Security vulnerabilities | 8 high, 18 moderate | Run `npm audit fix` |

### ⚠️ Warnings

| Issue | File |
|-------|------|
| Dynamic `require()` in hot paths | `contentGenerationService.js:1143, 1185, 1206` |
| `setInterval` without cleanup | `llmRouterService.js:26, 89` |
| `setTimeout` leak in routingTelemetry | `routingTelemetry.js:94` (timer not cleared on shutdown) |
| `console.log` in production code | `generationController.js:16`, tutor service |

---

## 11. Code Quality

| Check | Status |
|-------|--------|
| Dead code | ✅ Minimal |
| Duplicate logic | ⚠️ `getSeenQuestions`/`addSeenQuestions` duplicated in 2 files |
| Unreachable code | ✅ None found |
| Unused router decisions | ⚠️ `smartModelRouter` now secondary |
| Unused services | ⚠️ `providerRouter.js` unused (legacy) |
| Circular dependencies | ⚠️ 2 detected (see above) |

---

## 12. Build Verification

```
✅ server/server.js - Syntax OK
✅ All 86 service files - Syntax OK
✅ Frontend build - Not tested (out of scope)
```

---

## 13. Production Deployment Requirements

### Infrastructure
- [ ] MongoDB: Replica set, authentication, backup policy
- [ ] Redis: Cluster mode, persistence (AOF), maxmemory policy
- [ ] Neo4j: Cluster, backup, auth
- [ ] SGLang/Ollama: GPU instances, health endpoints
- [ ] Python RAG Service: Horizontal scaling, GPU

### Environment Variables (Required)
```
MONGO_URI, REDIS_URL, NEO4J_URI, PYTHON_RAG_SERVICE_URL
SGLANG_CHAT_URL, SGLANG_REASON_URL, SGLANG_ENABLED
GEMINI_API_KEY, GROQ_API_KEY, OPENAI_API_KEY
JWT_SECRET, EMAIL_*, SENTRY_DSN
```

---

## 14. Remaining Limitations

1. **Assessment/Skill Tree Replay** - Missing `addSeenQuestions` after generation
2. **Circular Dependencies** - Runtime `require()` works but is fragile
3. **Security Vulnerabilities** - 8 HIGH, 18 MODERATE in dependencies
4. **No Unhandled Rejection Handler** - Process can crash
5. **No Performance Benchmarks** - No regression detection
6. **Cache Invalidation** - Stale data possible after new generations
6. **No Chaos Testing** - Failover not verified under load
7. **Legacy Code** - `providerRouter.js`, `providerPriorityService.js` unused

---

## 15. Recommendations

### Before Production (Required)
1. Run `npm audit fix` and test all LLM calls
2. Add `process.on('unhandledRejection', ...)` to `server.js`
3. Add `process.on('uncaughtException', ...)` to `server.js`
4. Implement `addSeenQuestions` in Assessment and Skill Tree submit endpoints
4. Fix circular dependencies (extract shared code to new module)
5. Remove unused legacy services (`providerRouter.js`, `providerPriorityService.js`)

### Before Production (Recommended)
1. Add compound index `{ course: 1, concept: 1, usageCount: 1 }` on ConceptQuestionBank
2. Add TTL index on `studentHistory.answeredAt`
3. Implement cache invalidation on question generation
4. Add `npm audit fix` CI gate
5. Create performance benchmark suite
6. Add chaos testing (kill providers, verify failover)

---

## Final Verdict

**❌ NOT PRODUCTION READY**

**Blocking Issues:**
1. 8 HIGH + 18 MODERATE security vulnerabilities
2. No unhandled rejection/exception handlers
3. Circular dependencies with dynamic requires
4. Assessment/Skill Tree replay protection incomplete

**Timeline to Ready:** ~1-2 weeks with focused effort on security + stability fixes.

---

**Report Generated:** July 15, 2025  
**Next Review:** After security patches and stability fixes applied