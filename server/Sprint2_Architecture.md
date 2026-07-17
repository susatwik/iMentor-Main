# Sprint 2 Architecture Document — iMentor
**Date:** July 14, 2026

## 1. System Overview

Sprint 2 delivers the **adaptive assessment and question generation pipeline** — a multi-tier content delivery system that produces high-quality, replay-safe, deduplicated MCQ assessments for the skill-tree game mode. The system combines:

- **Concept Question Bank** (MongoDB) — persistent, shared, schema-validated question store with analytics tracking
- **Semantic duplicate detection** via embedding-based cosine similarity (threshold 0.82) against the Python RAG service
- **Multi-provider LLM fallback chain** (SGLang → Groq → Gemini → OpenAI → Ollama → Template) guaranteeing a response under any condition
- **Redis caching** keyed by course:concept for fast warm-start
- **Replay protection** through per-level `seenQuestions` tracking, LRU selection, and attempt counting
- **Evaluation Agent** (AI-first with weighted fallback) for determining student proficiency levels
- **Answer distribution validation** via chi-squared testing to prevent positional bias

## 2. Component Architecture

### 2.1 Evaluation Agent

**File:** `server/services/evaluationAgentService.js`

Entry point: `evaluateAssessment({ responses, course, topic })` — orchestrates the full assessment pipeline.

**`agentEvaluate({ question, userAnswer, correctAnswer, modelAnswer, concepts, bloomLevel, difficulty, type })`**
- Multi-agent weighted ensemble for per-question scoring
- **MCQ mode** (type === 'mcq'): `basic` (0.7) → `keyword` (0.2) → `llm` (0.1)
  - `basicEvaluate`: exact letter match (charAt(0)), returns binary correct + score 0/10
  - `keywordEvaluate`: concept coverage (40%) + model keyword matching (25%) + length scoring (20%) + match density (15%)
  - `llmEvaluate`: delegates to `aiEvaluationService.evaluateAnswer()`
- **Descriptive mode**: `llm` (0.6) → `keyword` (0.3) → `basic` (0.1)
- Confidence-weighted combination across all functioning agents
- Bloom × difficulty multiplier: `0.5 + (bloomWeight / MAX_BLOOM_WEIGHT) * 0.25 + (difficultyWeight / MAX_DIFFICULTY_WEIGHT) * 0.25`
- Returns: `{ score, rawScore, confidence, weightedMultiplier, basicCorrect, strengths, weaknesses, misconceptions, feedback, source, agentsUsed }`

**`determineLevelWithAgent({ responses, course, topic })`**
- AI-powered level determination using `callWithFallback()`
- Builds a structured prompt with grading details, Bloom taxonomy levels, difficulty, confidence
- LLM returns JSON: `{ level, confidence, reasoning, conceptMastery, recommendation }`
- Allowed levels: `Beginner | Intermediate | Advanced | Expert`
- Falls back to `null` on failure (triggers weighted scoring)

**`determineLevelWeighted(gradingDetails)`**
- Fallback function: `weightedPercent = sum(score * bloomWeight * difficultyWeight) / sum(10 * bloomWeight * difficultyWeight) * 100`
- Thresholds: Expert ≥ 85%, Advanced ≥ 65%, Intermediate ≥ 40%, else Beginner

**`evaluateAssessment()`** — main pipeline:
1. Per-question: `agentEvaluate()` → `computeWeightedScore()`
2. MCQ correct threshold: `basicCorrect === true` (strict), descriptive threshold: `score >= 5`
3. Level determination: `determineLevelWithAgent()` first, `determineLevelWeighted()` fallback
4. Builds Bloom profile, concept mastery map, strengths/weaknesses/misconceptions
5. Returns comprehensive assessment: `{ level, levelSource, score, scorePercent, weightedPercent, bloomProfile, conceptMastery, strengths, weakAreas, misconceptions, gradingDetails, ... }`

### 2.2 Concept Question Bank

**File:** `server/services/conceptQuestionBankService.js`

**`ensureQuestionsForConcept({ course, concept, topic, moduleName, forceGenerate })`**
- Cache-first strategy: Redis → MongoDB → LLM Generate → Template fallback
- Cache key: `concept_qb:{course}:{conceptKey}` (TTL: 7 days)
- Only generates if count < 10 and forceGenerate is false
- Returns array of persisted question objects

**`generateConceptQuestions({ course, concept, topic, moduleName })`**
- Target: 30 questions per concept (TARGET_QUESTIONS_PER_CONCEPT)
- Batch size: 10, with gradual temperature increase (0.7 + batch * 0.05)
- Bloom distribution: remember(4), understand(6), apply(8), analyze(6), evaluate(4), create(2)
- Difficulty distribution: easy(10), medium(12), hard(8)
- Prompt asks for MCQ with exactly 4 distinct plausible options, even answer distribution
- Validation: parses JSON, normalizes fields, filters malformed questions, applies `shuffleOptions()`
- Fallback: 30 template questions via `generateFallbackQuestions()` if LLM returns zero

**`saveQuestionsToBank(questions, { course, concept, topic, moduleName })`**
- Checks each question via `checkDuplicate()` before inserting
- Uses `findOneAndUpdate` with `$setOnInsert` to avoid re-inserting exact duplicates
- Fields stored: all 9 MCQ fields + generatedBy, model, pipelineVersion, conceptTags

**`selectQuestionsForLevel({ course, concept, count, seenQuestionIds, userId })`**
- Priority sort for replay protection:
  1. Unseen before seen
  2. Lowest usageCount first
  3. Oldest lastUsedAt first
  4. Random tiebreaker
- Returns `{ question, options, correctIndex, explanation, difficulty, bloomLevel, learningObjective, estimatedTime, confidence, _id }`

**`recordQuestionAttempt(questionId, userId, correct)`**
- Increments usageCount, conditionally increments successCount
- Updates lastUsedAt
- Appends to studentHistory (capped at 50 entries)

**`getQuestionAnalytics(concept, course)`**
- Returns: `{ total, totalUsage, overallSuccessRate, byDifficulty, byBloom, lastGeneratedAt }`

### 2.3 Content Generation Pipeline

**File:** `server/services/contentGenerationService.js`

**`generateOrRetrieveLevelQuestions(topic, levelId, levelName, difficulty, gameId, seenQuestions)`** — primary entry point for level questions:

1. **Concept Question Bank** — calls `conceptQuestionBankService.ensureQuestionsForConcept()`, then `selectQuestionsForLevel()` with seenQuestionIds filter. If ≥3 questions returned, uses these directly
2. **Redis cache** — key `skilltree:questions:{topic}:{levelId|levelName}`. Used only when concept bank is unavailable
3. **Legacy QuestionBank** (MongoDB) — queries by course + subtopic/topic match, limit 5
4. **LLM generation** — `generateLevelQuestions()` via `callWithFallback()` with concept-specific prompt rules (questions must test the concept, not topic names). Auto-saves to both ConceptQuestionBank and legacy QuestionBank
5. **Template fallback** — 5 concept-agnostic questions via `generateFallbackQuestions()`

At each stage: questions run through `shuffleOptions()` + `validateAnswerDistribution()` (chi-squared test, threshold ≤ 7.815 for 4 categories at α=0.05)

### 2.4 Route Layer

**File:** `server/routes/gamification.js`

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/skill-tree/level-questions` | Fetch level questions (see flow §3.1) |
| POST | `/skill-tree/record-answers` | Track question attempts via `recordQuestionAttempt()` |
| GET | `/skill-tree/analytics` | Get question analytics |
| PUT | `/games/:gameId/level/:levelId` | Update level progress, increment attempts, unlock next level |
| POST | `/skill-tree/diagnostic` | Generate Socratic diagnostic questions |
| POST | `/skill-tree/diagnostic/submit` | Submit diagnostic, determine starting level |
| POST | `/skill-tree/generate-levels` | Build personalized skill tree |
| POST | `/skill-tree/games` | Create/get skill tree game |
| DELETE | `/games/:gameId` | Delete game (save to history for replay) |

**File:** `server/routes/questionBank.js`

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/concept/generate` | Force-generate concept question bank |
| GET | `/concept/:course/:concept` | Fetch questions for concept |
| GET | `/concept/analytics` | Get aggregated analytics |
| DELETE | `/concept/:id` | Remove a concept bank question |

### 2.5 Provider Fallback Chain

**File:** `server/services/llmFallbackService.js`

**`callWithFallback()`** — universal LLM dispatch:

1. Build chain: `[preferredProvider, ...DEFAULT_CHAIN.filter(p !== preferred)]`
2. Default chains:
   - Local-first: `['sglang', 'groq', 'gemini', 'openai', 'ollama']`
   - Cloud-first: `['groq', 'gemini', 'openai', 'sglang', 'ollama']`
3. Per-provider health checks (cached): SGLang `/health` endpoint, Ollama health endpoint
4. Per-provider API key validation (placeholder detection)
5. Per-provider timeouts: SGLang(5s), Groq(15s), Gemini(15s), OpenAI(15s), Ollama(20s)
6. On success: `{ text, provider, model, thinking, wasFailover }`
7. On all-fail: graceful error message

Model resolution: SGLang → `Qwen/Qwen2.5-7B-Instruct-AWQ`, Groq → `llama-3.1-8b-instant`, Gemini → `gemini-2.0-flash`, OpenAI → `gpt-4o`, Ollama → `qwen3.5:9b`

## 3. Data Flow Diagrams

### 3.1 Level Question Request Flow

```
POST /skill-tree/level-questions { topic, levelId, levelName, difficulty, gameId }
    │
    ├─ 1. Check SkillTree pre-computed MCQs (assessmentQuestions)
    │      ├─ Found → filter seenQuestions, select 5 unseen, cache to game, return
    │      └─ Not found → continue
    │
    ├─ 2. Check game state (SkillTreeGame.findById)
    │      ├─ attempts === 0 && cached questions exist → return cached
    │      └─ attempts > 0 (retry) → collect seenQuestions, continue to pipeline
    │
    └─ 3. generateOrRetrieveLevelQuestions()
           │
           ├─ a. ConceptQuestionBank
           │      ├─ ensureQuestionsForConcept (Redis → MongoDB → LLM → Template)
           │      └─ selectQuestionsForLevel (unseen → lowest usage → LRU → random)
           │      └─ ≥3 found → shuffleOptions + validateAnswerDistribution → return
           │
           ├─ b. Redis cache (fallback)
           │      └─ key: skilltree:questions:{topic}:{levelId}
           │
           ├─ c. Legacy QuestionBank (fallback)
           │      └─ MongoDB query by course + subtopic/topic match
           │
           ├─ d. LLM generation (fallback)
           │      └─ callWithFallback() → save to ConceptQuestionBank + legacy
           │
           └─ e. Template fallback
                  └─ 5 generic questions → return
```

### 3.2 Question Bank Generation Flow

```
POST /concept/generate { course, concept, topic, moduleName }
    │
    └─ ensureQuestionsForConcept(forceGenerate: true)
           │
           ├─ generateConceptQuestions()
           │      ├─ Build prompt with Bloom + difficulty distribution targets
           │      ├─ callWithFallback() (batches of 10, temp 0.7-1.05)
           │      └─ Parse JSON → normalize → shuffleOptions
           │      └─ If 0 returned → generateFallbackQuestions() (30 templates)
           │
           └─ saveQuestionsToBank()
                  ├─ checkDuplicate() per question
                  │    └─ semanticSimilarity.checkQuestionDuplicate(text, existing, 0.82)
                  │         └─ Python RAG /embed → cosine similarity
                  └─ findOneAndUpdate with $setOnInsert → return saved docs
```

### 3.3 Assessment Evaluation Flow

```
POST /skill-tree/diagnostic/submit { topic, answers }
    │
    └─ skillTreeService.submitSkillAssessment() / inline grading
           │
           ├─ Per answer: lookup SkillTree for correctAnswer → compare
           ├─ Score → level mapping: 5=Expert, 4=Advanced, 2-3=Intermediate, <2=Beginner
           └─ Store assessment result

Evaluation Agent flow (for detailed assessment):
    evaluateAssessment({ responses, course, topic })
        │
        ├─ Per response → agentEvaluate()
        │      ├─ MCQ: basic(0.7) + keyword(0.2) + llm(0.1)
        │      └─ Desc: llm(0.6) + keyword(0.3) + basic(0.1)
        │
        ├─ computeWeightedScore(score × bloomWeight × difficultyWeight)
        │
        ├─ Level determination
        │      ├─ determineLevelWithAgent() → callWithFallback() LLM
        │      └─ Fallback: determineLevelWeighted() (Bloom × difficulty thresholds)
        │
        └─ Build result: { level, score, bloomProfile, conceptMastery, strengths, weaknesses, ... }
```

## 4. Data Models

### 4.1 ConceptQuestionBank Schema

**File:** `server/models/ConceptQuestionBank.js`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `course` | String | Yes | Indexed |
| `concept` | String | Yes | Indexed |
| `topic` | String | No | Default '' |
| `moduleName` | String | No | Default '' |
| `question` | String | Yes | The MCQ text |
| `options` | [String] | Yes | Exactly 4 elements, validated |
| `correctIndex` | Number | Yes | 0–3, validated |
| `explanation` | String | No | Detailed explanation |
| `difficulty` | String | No | `easy` / `medium` / `hard` |
| `bloomLevel` | String | No | `remember` / `understand` / `apply` / `analyze` / `evaluate` / `create` |
| `learningObjective` | String | No | Assessed knowledge description |
| `estimatedTime` | String | No | `30s` / `60s` / `90s` / `120s` |
| `confidence` | Number | No | 0.0–1.0 |
| `usageCount` | Number | No | Default 0 |
| `successCount` | Number | No | Default 0 |
| `lastUsedAt` | Date | No | Null until first use |
| `studentHistory` | [StudentResult] | No | Capped at 50 entries |
| `conceptTags` | [String] | No | Derived from concept + topic |
| `generatedBy` | String | No | Provider name |
| `model` | String | No | Model name |
| `pipelineVersion` | String | No | `v2` |
| `generatedAt` | Date | No | Generation timestamp |

Indexes: `{ course: 1, concept: 1 }`, `{ usageCount: 1 }`

Virtual: `successRate` = usageCount > 0 ? `(successCount / usageCount) * 100` : 0

### 4.2 SkillTreeGame Schema (relevant fields)

**File:** `server/models/SkillTreeGame.js`

| Field | Type | Notes |
|-------|------|-------|
| `userId` | ObjectId | Ref User, indexed |
| `topic` | String | Unique per user (compound index) |
| `assessmentResult.level` | String | Beginner/Intermediate/Advanced/Expert |
| `levels[].id` | Number | Level position |
| `levels[].name` | String | Level display name |
| `levels[].questions` | [Object] | Cached questions `{ question, options, correctIndex, explanation }` |
| `levels[].seenQuestions` | [String] | Question texts already shown (replay dedup) |
| `levels[].attempts` | Number | Incremented on each level completion |
| `levels[].status` | String | `locked` / `unlocked` / `completed` |
| `levels[].stars` | Number | 0–3 |
| `levels[].creditsEarned` | Number | Credits on first completion |

Pre-save hook: computes `completedLevels` and `totalStars` from levels array.

## 5. Key Algorithms

### 5.1 Question Selection (Replay Protection)

**File:** `server/services/conceptQuestionBankService.js:selectQuestionsForLevel()`

All questions annotated with: `_usageCount`, `_seen` (in seenQuestionIds set), `_lastUsed`, `_successRate`, `_random`.

Multi-key sort (ascending):
1. `_seen` (false before true — unseen first)
2. `_usageCount` (lowest first — least-used first)
3. `_lastUsed` (oldest first — LRU)
4. `_random` (deterministic tiebreaker)

Take first `count` items. Returns trimmed question objects with `_id` for analytics tracking.

This ensures: students see questions they haven't encountered → then least frequently used → then oldest used → then random.

### 5.2 Duplicate Detection

**File:** `server/services/conceptQuestionBankService.js:checkDuplicate()`

1. Calls `semanticSimilarity.checkQuestionDuplicate(newText, existingTexts, 0.82)`
2. Semantic similarity service (`server/services/semanticSimilarityService.js`):
   - Embeds both texts via Python RAG service (`POST /embed`)
   - Caches embeddings in-memory (1000-entry LRU)
   - Computes cosine similarity between embedding vectors
   - Returns `{ isDuplicate: boolean, similarity: number, matchedQuestion: string }` if similarity ≥ 0.82
3. On service failure, falls back to exact string match (case-insensitive trimmed comparison)

Used by `saveQuestionsToBank()` before each insert to maintain a deduplicated shared bank across all students.

### 5.3 Answer Distribution Validation

**File:** `server/services/contentGenerationService.js:validateAnswerDistribution()`

```
Count correct indices {A: n0, B: n1, C: n2, D: n3}
ideal = total / 4
chiSq = Σ ((count[i] - ideal)² / ideal) for i=0..3
balanced = chiSq ≤ 7.815
```

Threshold 7.815 corresponds to χ² critical value for 3 degrees of freedom at α = 0.05. This ensures correct answers are evenly distributed across A/B/C/D to prevent positional guessing bias.

Also in `conceptQuestionBankService.js:validateEvenDistribution()` (same algorithm).

### 5.4 Level Determination (Evaluation Agent)

**File:** `server/services/evaluationAgentService.js:evaluateAssessment()`

Two-phase approach:

**Phase 1 — AI agent (primary):**
```
determineLevelWithAgent({ responses, course, topic })
→ LLM prompt with all grading details, Bloom levels, difficulty, confidence
→ Returns parsed JSON { level, confidence, reasoning, conceptMastery, recommendation }
```

**Phase 2 — Weighted scoring (fallback):**
```
determineLevelWeighted(gradingDetails)
totalWeightedScore = Σ (correct ? 10 * bloomWeight * difficultyWeight : 0)
totalMaxWeightedScore = Σ (10 * bloomWeight * difficultyWeight)
weightedPercent = totalWeightedScore / totalMaxWeightedScore * 100

Levels: ≥85% → Expert, ≥65% → Advanced, ≥40% → Intermediate, else → Beginner
```

Bloom weights: remember(1.0), understand(1.5), apply(2.0), analyze(2.5), evaluate(3.0), create(3.5)
Difficulty weights: easy(1.0), medium(1.5), hard(2.0)

MCQ correct assessment: strict `basicCorrect === true` (exact letter match)
Descriptive correct assessment: `score >= 5`

## 6. Integration Points

| Integration | Details |
|-------------|---------|
| Python RAG Service | `POST /embed` for semantic similarity embeddings; URL from `PYTHON_RAG_SERVICE_URL` env |
| Redis | Concept bank cache (`concept_qb:*`), level question cache (`skilltree:questions:*`), level cache |
| MongoDB | ConceptQuestionBank, SkillTreeGame, SkillTree, QuestionBank, Lecture, Assessment, Quiz |
| SGLang | Primary LLM provider (local GPU), OpenAI-compatible REST API |
| Groq / Gemini / OpenAI | Cloud fallback providers with API key validation |
| Ollama | Last-resort fallback; also used for embeddings via Python RAG |
| Neo4j | Skill tree level generation from curriculum structure |
| GamificationProfile | XP/credits awarded on level completion; deleted game history for replay detection |

## 7. File Reference

| File | Role |
|------|------|
| `server/services/evaluationAgentService.js` | Evaluation Agent: `agentEvaluate()`, `determineLevelWithAgent()`, `determineLevelWeighted()`, `evaluateAssessment()` |
| `server/services/conceptQuestionBankService.js` | Concept Question Bank: `ensureQuestionsForConcept()`, `generateConceptQuestions()`, `saveQuestionsToBank()`, `selectQuestionsForLevel()`, `recordQuestionAttempt()`, `getQuestionAnalytics()`, `shuffleOptions()`, `validateEvenDistribution()`, `checkDuplicate()` |
| `server/models/ConceptQuestionBank.js` | Mongoose schema with 9 MCQ fields + analytics fields + virtuals |
| `server/services/contentGenerationService.js` | Content pipeline: `generateOrRetrieveLevelQuestions()`, `generateOrRetrieveSkillTreeLevels()`, `generateOrRetrieveLecture()`, `validateAnswerDistribution()` |
| `server/routes/gamification.js` | Level questions, record answers, analytics, level update, skill tree game CRUD |
| `server/routes/questionBank.js` | Concept generation, fetch, analytics, delete |
| `server/services/llmFallbackService.js` | `callWithFallback()` provider chain: SGLang → Groq → Gemini → OpenAI → Ollama → error |
| `server/services/semanticSimilarityService.js` | `checkQuestionDuplicate()` with embedding cosine similarity (threshold 0.82) |
| `server/models/SkillTreeGame.js` | Game state: levels, seenQuestions, attempts, cached questions |
