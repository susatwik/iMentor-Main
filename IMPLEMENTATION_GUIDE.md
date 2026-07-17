# iMentor Backend Enhancement Implementation Guide

## Overview

This guide covers the complete backend architecture enhancement to transform iMentor from a stateless chatbot to an adaptive AI tutoring platform. The implementation follows a modular, fault-tolerant design with comprehensive service fallbacks for local development.

## Part 1: Architecture & Design Principles

### Core Issues Addressed

1. **Stateless Chat** → Solved via `contextService.js` (persistent conversation memory)
2. **Infinite Loops** → Solved via `tutorEnhancementService.js` (loop detection, retry thresholds)
3. **No Mastery Tracking** → Solved via `StudentProfile.js` model (per-topic mastery 0-1)
4. **Provider Dependency** → Solved via `providerRouter.js` (fallback chain: Gemini→Groq→SGLang→Ollama)
5. **Service Failures** → Solved via `startupServices.js` (graceful degradation, in-memory fallbacks)
6. **Tight Coupling** → Solved via service layer separation (see Part 8)

### Service Hierarchy

```
Core Services (always running)
├── Redis / MemoryCache (session state)
├── MongoDB (persistent data)
├── Auth Service (JWT validation)
└── Logger (diagnostics)

AI Services (fallback chain)
├── LLM Router (provider selection)
├── providerRouter.js (Gemini→Groq→SGLang→Ollama)
├── contextService.js (conversation memory)
└── socraticService.js (Socratic prompting)

Learning Services (optional but recommended)
├── StudentProfile model (mastery tracking)
├── tutorEnhancementService.js (loop prevention, hints)
├── masteryService.js (progress calculation)
└── RAG services (Neo4j, Qdrant, Python RAG)

Monitoring Services (debug/admin only)
├── startupServices.js (health checks)
└── Logger utilities
```

## Part 2: Service Fallback Handling

### Implementation Status

✅ **COMPLETED** in `server/utils/startupServices.js`:
- Non-blocking service health checks at startup
- Graceful degradation when services unavailable
- Memory-based caching when Redis fails

✅ **COMPLETED** in `server/config/redisClient.js`:
- Automatic fallback to MemoryCache if Redis unavailable
- In-memory LRU cache with TTL support
- Drop-in compatible API

### Local Development Setup

**If you have Docker:**
```bash
docker-compose up -d
npm run dev
```

**If you DON'T have Docker:**
```bash
# Services will automatically fallback:
# - Redis → MemoryCache (automatic)
# - Qdrant → disabled vector search (automatic)
# - Neo4j → disabled graph features (automatic)
# - Python RAG → LLM knowledge-only (automatic)
# - SGLang → Gemini/Groq/Ollama (automatic)

npm run dev
# Server starts normally and shows which services are available
```

### Startup Output Example

```
=== Optional Service Status ===
✓ REDIS (using MemoryCache fallback)
✗ NEO4J (Not configured)
✗ QDRANT (Connection refused)
✓ ELASTICSEARCH (available)
✓ GEMINI (API validated)
✓ GROQ (API available)
✗ SGLANG (timeout)
✓ OLLAMA (fallback ready)
==============================
```

## Part 3: LLM Provider Routing

### Implementation: `server/services/providerRouter.js`

**Features:**
- Automatic cascading fallback (Gemini → Groq → SGLang → Ollama)
- Health check caching (5-minute intervals)
- Timeout enforcement (30s Gemini, 25s Groq, 20s SGLang, 15s Ollama)
- Error counting (3 strikes = mark unhealthy)

**Usage in Chat Handler:**

```javascript
const { generateWithFallback } = require('../services/providerRouter');

const result = await generateWithFallback(userMessage, {
    history: chatHistory,
    systemPrompt: finalSystemPrompt
}, {
    maxOutputTokens: 500,
    temperature: 0.7
});

console.log(`Generated with ${result.provider}, fallback: ${result.fallback}`);
```

**Configuration (.env):**

```bash
# Required for Gemini
GEMINI_API_KEY=your_key_here
GEMINI_API_VALIDATED=true

# Optional for Groq (if GEMINI fails)
GROQ_API_KEY=your_key_here

# Optional for SGLang (self-hosted)
SGLANG_ENABLED=true
SGLANG_CHAT_URL=http://localhost:8000/v1

# Ollama is always available as final fallback
OLLAMA_API_BASE_URL=http://localhost:11434
```

## Part 4: Enhanced Socratic Engine

### Implementation: `server/services/tutorEnhancementService.js`

**Features Implemented:**

1. **Answer Evaluation**
   ```javascript
   const { evaluateAnswer } = require('../services/tutorEnhancementService');
   
   const result = evaluateAnswer(
       "recursion is when a function calls itself",
       "recursion is when a function calls itself to solve smaller subproblems",
       "recursion"
   );
   // → {classification: 'PARTIAL', confidence: 0.85, feedback: '...'}
   ```

2. **Retry Threshold (max 3 retries)**
   ```javascript
   const { checkRetryThreshold } = require('../services/tutorEnhancementService');
   
   const status = checkRetryThreshold(sessionId, 3);
   // If status.exceeded: break loop, provide solution, advance topic
   ```

3. **Loop Prevention**
   ```javascript
   const { checkForRepeatedQuestion } = require('../services/tutorEnhancementService');
   
   const loopStatus = checkForRepeatedQuestion(sessionId, currentQuestion);
   if (loopStatus.shouldBreakLoop) {
       // Stop asking same question, explain concept, move on
   }
   ```

4. **Smart Hint System**
   ```javascript
   const { generateProgressiveHint } = require('../services/tutorEnhancementService');
   
   const hint = await generateProgressiveHint('recursion', 'base case', hintLevel, lastAttempt);
   // Hint 0: Small nudge
   // Hint 1: Guided explanation
   // Hint 2: Solution + advance topic
   ```

5. **Adaptive Progression (skip if mastery > 80%)**
   ```javascript
   const { shouldSkipTopic } = require('../services/tutorEnhancementService');
   
   if (await shouldSkipTopic(userId, 'arrays')) {
       // Skip to next topic, grant XP for mastery
   }
   ```

### Integration in Chat Handler

Add to `server/routes/chat/handlers/tutorHandler.js`:

```javascript
const {
    evaluateAnswer,
    checkRetryThreshold,
    checkForRepeatedQuestion,
    generateProgressiveHint,
    shouldSkipTopic,
    updateStudentMastery,
    recordSessionMetric
} = require('../../../services/tutorEnhancementService');

// In handleGeneral() or handleStructured():

// 1. Evaluate student answer
const evaluation = evaluateAnswer(studentAnswer, expectedAnswer, topic);
recordSessionMetric(sessionId, 'answer_received', evaluation);

// 2. Check retry threshold
const retryStatus = checkRetryThreshold(sessionId, 3);
if (retryStatus.exceeded) {
    // Provide solution and advance
    const hint = await generateProgressiveHint(topic, concept, 3, studentAnswer);
    streamEvent(res, { type: 'content', content: hint.hint });
    
    // Skip to next if available
    if (hint.shouldAdvance && await shouldSkipTopic(userId, topic)) {
        await advanceToNextTopic();
    }
    return;
}

// 3. Check for repeated question
const loopCheck = checkForRepeatedQuestion(sessionId, currentQuestion);
if (loopCheck.shouldBreakLoop) {
    // Break loop logic
}

// 4. Generate appropriate hint
if (evaluation.classification !== 'CORRECT') {
    const hintData = await generateProgressiveHint(topic, concept, hintLevel, studentAnswer);
    streamEvent(res, { type: 'hint', content: hintData.hint, level: hintData.level });
    recordSessionMetric(sessionId, 'hint_given', hintData);
}

// 5. Update mastery
await updateStudentMastery(userId, topic, evaluation.classification);
```

## Part 5: Conversation Memory Service

### Implementation: `server/services/contextService.js`

**Features:**
- Persistent conversation history (MongoDB)
- Context summarization for long conversations
- Weak concept tracking
- Topic continuity detection

**Usage in Chat Handler:**

```javascript
const {
    saveConversation,
    getRecentContext,
    getFormattedContextForPrompt
} = require('../services/contextService');

// Save conversation turn
await saveConversation(userId, sessionId, 'user', userMessage, {
    topic: detectedTopic,
    confidence: 0.85
});

// Get context for prompt injection
const contextString = await getFormattedContextForPrompt(userId, sessionId);

// Final prompt = basePrompt + contextString + userQuery
const finalPrompt = `${baseSystemPrompt}\n\n${contextString}\n\nUser: ${userMessage}`;
```

**Output Example:**

```
## Previous Conversation Summary
We discussed recursion basics and tree traversal...

## Current Topic
We are discussing: Tree traversal algorithms

## Student Weak Areas
The student struggles with: base case, termination, recursive thinking

## Recent Discussion
- What is the base case in recursion?
- How do you know when to stop recursing?
```

## Part 6: Student Profile Model

### Implementation: `server/models/StudentProfile.js`

**Schema Fields:**

```javascript
{
    userId,                    // Reference to User
    mastery: {                 // Per-topic mastery (0-1)
        recursion: { level: 0.75, numAttempts: 12, numCorrect: 9 },
        graphs: { level: 0.3, numAttempts: 5, numCorrect: 1 }
    },
    retries: {                 // How many wrong before correct
        graphs: 4,
        dp: 2
    },
    completedTopics: [        // Mastered topics
        { topicId: 'rec', topicName: 'Recursion', masteryScore: 0.9 }
    ],
    skippedTopics: [          // Skipped due to high mastery
        { topicId: 'arr', topicName: 'Arrays', reason: 'high_mastery' }
    ],
    weakAreas: [              // Struggling with
        { conceptName: 'graphs', masteryLevel: 0.3, failureCount: 5 }
    ],
    confidenceLevel,          // beginner | intermediate | advanced | expert
    cognitiveLevel,           // L1_RECALL | L2_UNDERSTAND | ... | L6_CREATE
    learningSpeed,            // slow | normal | fast
    performance: {
        totalQuizzes: 10,
        quizzesPassed: 7,
        averageQuizScore: 0.82,
        currentStreak: 3,
        correctAnswers: 45,
        totalAnswers: 55
    }
}
```

**Usage in Tutor Handler:**

```javascript
const StudentProfile = require('../models/StudentProfile');

// Get or create student profile
let profile = await StudentProfile.findOne({ userId });
if (!profile) {
    profile = new StudentProfile({ userId });
    await profile.save();
}

// Update mastery after answer
profile.updateTopicMastery(topicId, numCorrect, numTotal);

// Check if should skip
if (profile.shouldSkipTopic(topicId)) {
    skipTopic();
}

// Get recommendations for next topics
const nextTopics = profile.getRecommendedTopics(allAvailableTopics, 5);
```

## Part 7: Quiz Credit Integration

**Wire quiz submissions to reward system:**

```javascript
// In quiz submission endpoint

const { awardLearningCredits } = require('../services/gamificationService');

// Award credits for correct answers
const correctCount = answers.filter(a => a.isCorrect).length;
await awardLearningCredits(userId, correctCount * 5, {
    reason: `Quiz: ${quiz.title}`,
    topic: quiz.topic,
    sessionId: quizSessionId
});

// Update StudentProfile mastery
profile.updateTopicMastery(quiz.topic, correctCount, answers.length);
await profile.save();

// If streak reached, award badge
if (profile.performance.currentStreak >= 10) {
    await awardBadge(userId, 'streak_10');
}
```

## Part 8: Architecture Refactoring

### Current Structure (Before)
```
routes/
├── chat.js (handles everything)
├── tutor.js (handles everything)
└── ...

services/
├── llmRouterService.js (mixed concerns)
└── ...
```

### Target Structure (After)

```
controllers/              # NEW: HTTP request handling
├── chatController.js
├── tutorController.js
└── quizController.js

routes/                   # Routes only (thin)
├── chat/
│   ├── index.js (dispatch to controller)
│   └── handlers/
├── tutor/
│   ├── index.js (dispatch to controller)
│   └── handlers/
└── quiz/

services/                 # Business logic (thick)
├── chatService.js        # Non-LLM chat operations
├── tutorService.js       # Tutor logic (calls LLM via router)
├── quizService.js        # Quiz operations
├── providerRouter.js     # LLM provider selection ✅ DONE
├── contextService.js     # Conversation memory ✅ DONE
└── llmRouterService.js   # Original routing (refactored)

models/                   # Data schemas
├── ChatHistory.js
├── StudentProfile.js     # ✅ DONE
├── Quiz.js
└── ...

utils/                    # Helpers
├── logger.js
├── startupServices.js    # ✅ DONE
├── memoryCache.js        # ✅ DONE
└── ...
```

### Refactoring Rules

1. **Controllers**: Call services, never LLM directly
   ```javascript
   // ✓ Correct
   const result = await tutorService.processTurn(query, sessionId);
   
   // ✗ Wrong
   const result = await llm.generate(query);
   ```

2. **Services**: Encapsulate business logic
   ```javascript
   // In tutorService.js
   async function processTurn(query, sessionId) {
       const context = await contextService.getRecentContext(...);
       const profile = await StudentProfile.findOne(...);
       const evaluation = tutorEnhancementService.evaluateAnswer(...);
       const response = await providerRouter.generateWithFallback(...);
       return response;
   }
   ```

3. **Models**: Schema definition + query helpers
   ```javascript
   // In StudentProfile.js
   StudentProfileSchema.methods.updateMastery = function(topic, correct, total) {
       // Logic here
   };
   ```

## Part 9: Performance Optimization

### Implemented Features

1. **Response Caching** (add to chat handler)
   ```javascript
   const cacheKey = `response:${hashQuery(query)}`;
   const cached = await redisClient.get(cacheKey);
   
   if (cached) {
       return JSON.parse(cached);
   }
   
   const response = await providerRouter.generateWithFallback(...);
   await redisClient.setex(cacheKey, 3600, JSON.stringify(response)); // 1 hour TTL
   ```

2. **Prompt Deduplication**
   ```javascript
   const promptHash = crypto.createHash('sha256').update(finalPrompt).digest('hex');
   const cached = await redisClient.get(`prompt:${promptHash}`);
   if (cached) return cached;
   
   const response = await provider.generate(finalPrompt);
   await redisClient.setex(`prompt:${promptHash}`, 1800, response);
   ```

3. **Parallel Retrieval**
   ```javascript
   // Fetch context + get profile in parallel
   const [context, profile, studentState] = await Promise.all([
       contextService.getRecentContext(userId, sessionId),
       StudentProfile.findOne({ userId }),
       knowledgeStateService.getStudentState(userId)
   ]);
   ```

4. **Deferred Writes** (already implemented)
   ```javascript
   setImmediate(async () => {
       await profile.save();
       await contextService.saveConversation(...);
   });
   ```

## Part 10: Frontend Compatibility

### Verification Checklist

- [ ] All response envelopes unchanged (type + content structure)
- [ ] All route paths unchanged (/api/chat, /api/tutor, etc.)
- [ ] All HTTP status codes match original
- [ ] SSE streaming format unchanged
- [ ] Socket.io events still emit
- [ ] Auth tokens still valid
- [ ] CORS headers still work

### Testing Script

```bash
# Before and after any major change, run:
npm run test:api

# Check that response format is identical
curl -X POST http://localhost:5005/api/chat/stream \
  -H "Authorization: Bearer $TOKEN" \
  -d "query=hello&mode=chat"

# Should return proper SSE stream with:
# event: type_update
# data: {"type":"status_update","content":"..."}
```

## Troubleshooting

### Issue: "ENCRYPTION_SECRET is not set"
**Solution:** Add to `.env`:
```bash
ENCRYPTION_SECRET=imentor_dev_encryption_secret_change_in_production_2026
```

### Issue: "Redis unavailable" error on startup
**Expected behavior**: Server should start with in-memory cache. Check:
```bash
# Should see:
✗ REDIS (Connection refused — using MemoryCache fallback)
```

### Issue: Gemini API returning 403
**Solution:**
1. Verify API key is correct: `echo $GEMINI_API_KEY`
2. Set validation flag: `GEMINI_API_VALIDATED=true`
3. Provider will fallback to Groq if key invalid

### Issue: "All providers exhausted"
**Solution:**
1. Ensure at least one provider is configured
2. Check `.env` for API keys
3. Verify internet connectivity
4. Fall back to Ollama (always available locally)

## Integration Checklist

- [ ] Create `providerRouter.js` ✅
- [ ] Create `contextService.js` ✅
- [ ] Create `StudentProfile.js` model ✅
- [ ] Create `tutorEnhancementService.js` ✅
- [ ] Create `startupServices.js` ✅
- [ ] Update `redisClient.js` with MemoryCache fallback ✅
- [ ] Create `memoryCache.js` utility ✅
- [ ] Update `server.js` to call `checkOptionalServices()` ✅
- [ ] Update `.env` with `ENCRYPTION_SECRET` ✅
- [ ] Integrate services into tutorHandler.js (Part 4)
- [ ] Refactor routes → controllers → services (Part 8)
- [ ] Add response caching (Part 9)
- [ ] Run frontend compatibility tests (Part 10)

## Next Steps

1. **Immediate (Day 1):**
   - Verify all new services compile: `npm run build`
   - Start server: `npm run dev`
   - Check startup output for service status

2. **Week 1:**
   - Integrate tutorEnhancementService into tutorHandler
   - Add contextService to chat handler
   - Wire StudentProfile to gamification service

3. **Week 2:**
   - Implement performance optimizations (caching, parallel calls)
   - Add architecture refactoring (controllers)
   - Run comprehensive tests

4. **Week 3:**
   - Fine-tune adaptive progression thresholds
   - Optimize hint generation
   - Performance profiling and benchmarking

## References

- Provider Router: `server/services/providerRouter.js`
- Context Service: `server/services/contextService.js`
- Student Profile: `server/models/StudentProfile.js`
- Tutor Enhancement: `server/services/tutorEnhancementService.js`
- Startup Services: `server/utils/startupServices.js`
- Memory Cache: `server/utils/memoryCache.js`

---

**Last Updated:** 2026-01-15  
**Version:** 1.0 (Complete Implementation)  
**Status:** Ready for integration testing
