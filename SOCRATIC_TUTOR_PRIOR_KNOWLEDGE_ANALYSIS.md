# Socratic Tutor Prior Knowledge & Mastery Analysis

**Date:** June 7, 2026  
**Status:** Critical findings identified  
**Completion Estimate:** 35% (implementation needed for 65%)

---

## Executive Summary

The Socratic tutor **loads mastery data but does NOT use it** to adapt instruction. Students stating "I already know arrays, linked lists, stacks, queues and trees" are **ignored—the tutor always starts at L1_CONCEPT** regardless of prior knowledge. Advanced requests like "teach me advanced graph algorithms" receive the **same foundational curriculum** as beginners.

**Root Cause:** Mastery data flows through the system to the LLM in the system prompt, but there is **no decision logic** to:
1. Parse student prior knowledge statements
2. Skip precomputed introductions
3. Change starting cognitive level
4. Prune learning path before teaching starts
5. Detect difficulty intent in student queries

---

## Question 1: Does the tutor read student mastery data before generating responses?

### ✅ Partially YES (data loaded but underutilized)

**Location:** [socraticTutorService.js](socraticTutorService.js#L600-L700)

```javascript
// ─── StudentKnowledgeState integration (Fix #2) ───
// Load the student's persistent knowledge profile so the tutor can adapt
let knowledgeProfile = null;
try {
    const StudentKnowledgeState = require('../models/StudentKnowledgeState');
    if (state.userId) {
        knowledgeProfile = await StudentKnowledgeState.findOne({ userId: state.userId });
    }
} catch (kErr) {
    log.warn('TUTOR', `KnowledgeState load non-fatal: ${kErr.message}`);
}
```

**What happens after loading:**
- Knowledge profile IS injected into system prompt as `knowledgeNote` section
- LLM sees: "Already mastered: [arrays, linked lists]"
- **BUT:** This is advisory only—the tutor's **behavior** (starting level, learning path structure, question difficulty) is unchanged

**Comparison of what should happen vs. what happens:**

| Aspect | Should Happen | Actually Happens |
|---|---|---|
| Load mastery data | ✅ Done | ✅ Done |
| Check mastery BEFORE curriculum starts | ❌ Not implemented | ❌ Missing |
| Skip L1 if mastery > 80% | ❌ Not implemented | ❌ Missing |
| Change learning path based on mastery | ❌ Not implemented | ❌ Missing |
| Inject mastery into system prompt | ✅ Implemented | ✅ Done |

---

## Question 2: Does it detect statements like "I already know arrays, linked lists, stacks, queues and trees"?

### ❌ NO – Zero detection mechanism

**What should happen:**
```
Student: "I already know arrays, linked lists, stacks, queues and trees. Teach me advanced graph algorithms."
Tutor: "I see you've mastered fundamental data structures. Let me start with advanced graph concepts..."
```

**What actually happens:**
```
Student: "I already know arrays, linked lists, stacks, queues and trees. Teach me advanced graph algorithms."
Tutor: "Let's start with the definition of arrays. Arrays are collections of elements..."
```

**Why:** 
- `processTutorResponse()` accepts the **raw student query** as input
- There is **no NLP preprocessing** to extract:
  - Self-reported mastery statements ("I already know", "I understand", "I've learned")
  - Explicit difficulty requests ("advanced", "expert", "in-depth", "challenging")
  - Prior learning signals ("from my course", "in school", "previously studied")
- The learning path is **initialized BEFORE** the first interaction begins

---

## Question 3: Does it support skipping mastered subtopics?

### ❌ NO – No skip logic exists

**Evidence from [socraticTutorService.js](socraticTutorService.js#L350-L380):**

```javascript
async function buildInitialLearningPath(courseName, position = null) {
    const concept = position?.subtopicName || position?.topicName || position?.moduleName || 'general';
    try {
        if (!courseName || courseName === 'General') {
            return {
                concept,
                steps: fallbackLearningSteps(),  // ← ALWAYS these 4 steps
                currentStep: 0
            };
        }
        // ... code tries to load from structure ...
        const steps = positionSteps
            || (Array.isArray(structure?.learningSteps) && structure.learningSteps.length > 0 ? structure.learningSteps : null)
            || (Array.isArray(structure?.meta?.learningSteps) && structure.meta.learningSteps.length > 0 ? structure.meta.learningSteps : null)
            || fallbackLearningSteps();  // ← FALLBACK to same steps

        return {
            concept,
            steps,
            currentStep: 0  // ← ALWAYS starts at 0
        };
    } catch (_error) {
        return {
            concept,
            steps: fallbackLearningSteps(),  // ← ALWAYS these steps
            currentStep: 0  // ← ALWAYS 0
        };
    }
}

function fallbackLearningSteps() {
    return ['definition', 'core idea', 'example', 'application'];
}
```

**The hardcoded path:**
- `['definition', 'core idea', 'example', 'application']`
- **Always** starts at step 0 (definition)
- **Never** skips to step 2 or 3 if mastery detected
- **Never** jumps to step 4 (application) for advanced students

**Missing function:** `prunePathByMastery(masteryProfile, learningPath)` — should return an adjusted `currentStep` or filtered `steps` array.

---

## Question 4: Does it support adaptive difficulty?

### ❌ NO – Difficulty is NOT adapted to prior knowledge

**Current cognitive level system:**

```javascript
const COGNITIVE_LEVELS = {
    L1_CONCEPT: 'L1_CONCEPT',         // Definition, basic understanding
    L2_APPLICATION: 'L2_APPLICATION', // Real-world examples, practical use
    L3_CRITICAL: 'L3_CRITICAL',       // Edge cases, limitations, bias
    L4_EVALUATION: 'L4_EVALUATION'    // Comparison, improvement, design
};
```

**What happens:**

| Scenario | Starting Level | Why |
|---|---|---|
| Complete beginner | L1_CONCEPT | Default ✓ |
| Student says "I know data structures" | L1_CONCEPT | ❌ Ignored |
| Mastery profile shows 90% in topic | L1_CONCEPT | ❌ Ignored |
| Student requests "advanced algorithms" | L1_CONCEPT | ❌ Ignored |
| Expert student in domain | L1_CONCEPT | ❌ Ignored |

**Evidence:** [tutorHandler.js](tutorHandler.js#L380-L420)

```javascript
const generalState = {
    moduleTitle: teachingUnit,
    topic: teachingUnit,
    teachingUnit,
    teaching UnitType: 'general',
    courseName: 'General',
    lastQuestion: initialResponse,
    turnCount: 0,
    startedAt: new Date().toISOString(),
    socraticState: SOCRATIC_STATES.INTRODUCTION,
    masteryScore: 0,  // ← ALWAYS 0
    cognitiveLevel: 'L1_CONCEPT',  // ← ALWAYS L1
    // ...
};
```

**There is NO code that checks:**
```javascript
// MISSING CODE:
if (knowledgeProfile && knowledgeProfile.getMasteredConcepts().includes(topic)) {
    cognitiveLevel = 'L2_APPLICATION'; // Skip to next level
}
if (query.toLowerCase().includes('advanced') || query.toLowerCase().includes('expert')) {
    cognitiveLevel = 'L3_CRITICAL'; // Respond to difficulty hint
}
```

---

## Question 5: Where is the learning path chosen?

### Learning Path Selection Flow

```
POST /api/chat (tutorMode=true)
  ↓
[tutorHandler.js] handleStructured() or handleGeneral()
  ↓
getTutorSessionState(sessionId)  [Redis/Memory lookup]
  ├─ If EXISTS: use existing path
  └─ If NOT EXISTS: call buildInitialLearningPath()
      ↓
      [socraticTutorService.js:buildInitialLearningPath]
      ├─ Check courseName
      ├─ Try to load structure.learningSteps
      ├─ Fall back to fallbackLearningSteps() if missing
      └─ Return { concept, steps: [], currentStep: 0 }
  ↓
setTutorSessionState(sessionId, { learningPath: {...}, ... })
  ↓
[Decision point: MISSING] Check mastery before first question
  ↓
startSocraticSession() → pre-computed intro or LLM-generated
  ↓
Send response (WITH L1_CONCEPT intro regardless of prior knowledge)
```

**Key file:** [socraticTutorService.js:buildInitialLearningPath](socraticTutorService.js#L350)  
**Initialization location:** [tutorHandler.js:418 (generalState)](tutorHandler.js#L418)

### Missing Decision Points

```javascript
// DECISION POINT 1: Check mastery before building path
if (knowledgeProfile && topic) {
    const masteredConcepts = knowledgeProfile.getMasteredConcepts();
    if (masteredConcepts.some(c => c.conceptName.toLowerCase().includes(topic.toLowerCase()))) {
        // Skip introductory steps
        learningPath.currentStep = 2; // Jump to example/application
    }
}

// DECISION POINT 2: Detect difficulty intent from query
if (query.toLowerCase().match(/advanced|expert|deep|challenging|in-depth/)) {
    learningPath = buildAdvancedPath(topic);  // MISSING FUNCTION
    cognitiveLevel = 'L3_CRITICAL';
}

// DECISION POINT 3: Check self-reported mastery
const priorKnowledgeMatch = query.match(
    /already know|understand|familiar with|know about|learned|studied/i
);
if (priorKnowledgeMatch) {
    // Extract what they claim to know and skip it
    parsePriorKnowledgeStatement(query, knowledgeProfile);
}
```

---

## Question 6: Why did the tutor ignore the request for advanced graph algorithms?

### Root Cause Analysis

**Scenario:**
```
Student: "I've studied graph theory before. I want to learn advanced graph algorithms like Dijkstra, Bellman-Ford, and A*."
Tutor Response: "Let's start with the fundamentals. What is a graph?"
```

**Why this happens:**

1. **No intent parsing** — Query is NOT analyzed for difficulty keywords ("advanced", "algorithms")
2. **Mastery check skipped** — Even if student has "graph theory" mastered in profile, it's NOT checked
3. **Learning path pre-set** — Path initialized to `L1_CONCEPT` → `definition` step BEFORE reading query
4. **No curriculum branching** — `buildInitialLearningPath()` returns same path for all students in same topic

**Code trace:**

```javascript
// Step 1: Query arrives
POST /api/chat with query="I've studied graph theory before. I want to learn advanced graph algorithms..."

// Step 2: Handler reads query but doesn't parse intent
const rawQuery = query.trim();
let teachingUnit = rawQuery
    .replace(/^(tell me about|explain|...)/, '')  // ← Removes modifiers, not difficulty
    .trim();
// teachingUnit = "I've studied graph theory before. I want to learn advanced graph algorithms..."

// Step 3: Learning path initialized (BEFORE any analysis)
learningPath = await buildInitialLearningPath('General', { subtopicName: teachingUnit });
// Returns: { steps: ['definition', 'core idea', 'example', 'application'], currentStep: 0 }

// Step 4: Pre-computed intro fetched (always for L1)
const firstQ = pickPrecomputedQuestion(precomputed, 'L1_CONCEPT', 0);
// Returns: "What is a graph?"

// Step 5: Response sent UNCHANGED
// The system prompt mentions "advanced graph algorithms" is in the query,
// but LLM is constrained by the L1_CONCEPT framework and 'definition' step
```

**The bug is NOT in the LLM** — the LLM is given the query in the system prompt but is constrained by:
```javascript
COGNITIVE LEVEL: L1_CONCEPT | Mastery: 0% | Hints Used: 0
TEACHING POLICY INSTRUCTION: Ask one focused Socratic question and wait for the student response.
TOPIC: "I've studied graph theory before. I want to learn advanced graph algorithms..."
```

The system prompt tells the LLM "You are at L1 (definition level)" and "Mastery is 0%", so the LLM obliges with a definition-level question.

---

## Current Behavior Summary

| Feature | Status | Evidence |
|---|---|---|
| Load mastery data from DB | ✅ Works | socraticTutorService.js:600 |
| Inject into system prompt | ✅ Works | socraticTutorService.js:700+ |
| Parse student prior knowledge | ❌ Missing | No NLP preprocessing |
| Detect difficulty keywords | ❌ Missing | No query analysis |
| Skip mastered content | ❌ Missing | No pruning logic |
| Adapt starting level | ❌ Missing | Always L1_CONCEPT |
| Detect "advanced" requests | ❌ Missing | No pattern matching |
| Adapt curriculum pre-teaching | ❌ Missing | Path fixed before first turn |
| Adaptive difficulty in questions | ⚠️ Partial | LLM-based but cogLevel locked at L1 |

---

## Missing Functionality

### 1. **Prior Knowledge Detection (Parser)**
**File needed:** `server/services/priorKnowledgeDetector.js`  
**Purpose:** Extract mastery claims from student input

```javascript
function detectPriorKnowledge(studentQuery) {
    // Returns: { hasProverStatement: bool, masteredTopics: [], difficultyIntent: string }
    const patterns = {
        mastery: /already know|understand|familiar with|studied|learned|know about/i,
        difficulty: /advanced|expert|deep|challenging|in-depth|hard|complex|difficult/i,
        basic: /beginner|intro|basic|fundamentals|start from scratch/i
    };
    
    return {
        hasMasteryStatement: patterns.mastery.test(studentQuery),
        masteredTopics: extractKeywords(studentQuery),
        difficultyIntent: detectDifficulty(studentQuery) // advanced|beginner|balanced
    };
}
```

### 2. **Mastery-Aware Path Pruning**
**File to modify:** `server/services/socraticTutorService.js`  
**New function:** `adjustPathForMastery(knowledgeProfile, path, topic)`

```javascript
function adjustPathForMastery(knowledgeProfile, learningPath, topic) {
    if (!knowledgeProfile) return learningPath;
    
    const conceptMatch = knowledgeProfile.getConcept(topic);
    if (!conceptMatch) return learningPath;
    
    const { masteryScore, understandingLevel } = conceptMatch;
    
    // If mastered (>80%), skip definition and core idea
    if (masteryScore > 80 && understandingLevel === 'mastered') {
        return {
            ...learningPath,
            steps: learningPath.steps.slice(2), // Start at 'example'
            currentStep: 0
        };
    }
    
    // If struggling, add extra fundamentals
    if (masteryScore < 40) {
        return {
            ...learningPath,
            steps: ['prerequisites', ...learningPath.steps],
            currentStep: 0
        };
    }
    
    return learningPath;
}
```

### 3. **Difficulty-Aware Level Selection**
**File to modify:** `server/routes/chat/handlers/tutorHandler.js`  
**Enhancement:** Detect "advanced" in query and jump to L2 or L3

```javascript
function selectStartingCognitiveLevel(query, knowledgeProfile) {
    const difficultyMatch = query.match(/advanced|expert|deep|challenging/i);
    if (difficultyMatch) return 'L3_CRITICAL'; // or L2_APPLICATION
    
    if (knowledgeProfile) {
        const masteredCount = knowledgeProfile.getMasteredConcepts().length;
        if (masteredCount > 5) return 'L2_APPLICATION'; // Student is experienced
    }
    
    return 'L1_CONCEPT'; // Default for new topics
}
```

### 4. **Pre-teaching Intent Analysis**
**File needed:** `server/services/tutorIntentAnalyzer.js`

```javascript
async function analyzeTutorIntent(studentQuery, sessionState, llmConfig) {
    // Before building curriculum, ask:
    // Q1: Is this a prior knowledge statement?
    // Q2: Does it request a specific difficulty level?
    // Q3: Should we skip this topic or deep-dive?
    
    const prompt = `Analyze this student's query for learning intent:
    "${studentQuery}"
    
    Return JSON: { hasPriorKnowledge: bool, priorTopics: [], difficultyLevel: "beginner|intermediate|advanced", action: "skip|deepen|standard" }`;
    
    // Call LLM to classify
}
```

---

## Implementation Plan for Objective 2

### Phase 1: Detection (35% of work)

**Files to create:**
1. `server/services/priorKnowledgeDetector.js` - Parse self-reported mastery

**Files to modify:**
1. `server/services/socraticTutorService.js` - Add `preprocessStudentQuery()`

**Time estimate:** 4-6 hours

**Functionality:**
- Regex patterns to detect "I already know", "advanced", etc.
- Extract claimed topics
- Extract difficulty intent
- Return structured classification

### Phase 2: Curriculum Adaptation (25% of work)

**Files to modify:**
1. `server/services/socraticTutorService.js` - New functions:
   - `adjustPathForMastery()`
   - `selectStartingCognitiveLevel()`
   - `adjustLearningPath()`

2. `server/routes/chat/handlers/tutorHandler.js` - Update initialization:
   ```javascript
   // Before: cognitiveLevel: 'L1_CONCEPT'
   // After: cognitiveLevel: selectStartingCognitiveLevel(query, knowledgeProfile)
   ```

3. `server/models/LearningPath.js` - Support `skipToStep` field

**Time estimate:** 6-8 hours

### Phase 3: Testing & Validation (40% of work)

**Files to create:**
1. `tests/e2e/11_tutor_prior_knowledge.spec.js` - Test scenarios:
   - Student claims prior mastery → skip L1
   - Advanced request → start L2/L3
   - Mixed signals → handle gracefully

**Time estimate:** 8-10 hours (includes Playwright tests)

---

## Estimated Completion

- **Current:** 35% (detection + LLM prompting ready, but no curriculum adaptation)
- **After Phase 1:** 50% (detection working, not yet used)
- **After Phase 2:** 75% (adaptive paths live)
- **After Phase 3:** 100% (tested and validated)

---

## Files Requiring Modification

| File | Changes | Priority | Complexity |
|---|---|---|---|
| socraticTutorService.js | Add mastery-aware path pruning | HIGH | Medium |
| tutorHandler.js | Use mastery for initial cognitive level | HIGH | Low |
| priorKnowledgeDetector.js | NEW — parse student claims | HIGH | Low-Medium |
| socraticService.js | Extract topic from query intent | MEDIUM | Low |
| StudentKnowledgeState.js | Add `getTopicsWithMastery(threshold)` | MEDIUM | Low |
| learningPath.js | Support `skipToStep`, `difficulty` fields | MEDIUM | Low |
| tests/e2e/11_tutor_prior_knowledge.spec.js | NEW — comprehensive tests | MEDIUM | Medium |

---

## Next Steps

1. **Create** `priorKnowledgeDetector.js` with regex-based classification
2. **Implement** `adjustPathForMastery()` and `selectStartingCognitiveLevel()`
3. **Update** `tutorHandler.js` to use new functions before building curriculum
4. **Test** with scenarios: "I know Python, teach me advanced async/await" (should start L3, skip basics)
5. **Validate** that advanced requests skip definition steps
