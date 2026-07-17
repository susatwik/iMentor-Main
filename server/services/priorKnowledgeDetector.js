/**
 * server/services/priorKnowledgeDetector.js
 * 
 * Prior Knowledge Detection Engine
 * 
 * Detects:
 * - Self-reported mastery statements
 * - Difficulty level intent
 * - Topics the student claims to know
 * 
 * Returns structured classification for curriculum adaptation
 */

const log = require('../utils/logger');

// ─── REGEX PATTERNS ────────────────────────────────────────────────────────

const PATTERNS = {
    // Prior knowledge signals
    mastery: {
        strong: /i\s+(already\s+)?know\s+(?:about\s+)?|i\s+understand(?:\s+about)?|i\s+am\s+familiar\s+with/i,
        moderate: /i\s+(have\s+)?studied|i\s+learned|i\s+took\s+(?:a\s+)?course|i\s+took\s+(?:a\s+)?class|from\s+(?:my|the)\s+course|previously\s+(?:studied|learned)/i,
        signal: /i\s+know|i\s+understand|i\s+studied|i\s+learned|familiar\s+with|prior\s+knowledge|background\s+in|expertise\s+in/i
    },

    // Difficulty level intent
    advanced: /advanced|expert|deep\s+(?:dive|understanding|learning)|in-depth|sophisticated|complex|challenging|hard\s+(?:version|problems)|more\s+(?:advanced|complex|challenging)|next\s+level|intermediate\s+(?:level|concepts)|beyond\s+basics/i,
    intermediate: /intermediate|intermediate\s+level|moving\s+(?:beyond|past)\s+basics|beyond\s+intro|step\s+up|level\s+up/i,
    beginner: /beginner|intro(?:duction)?|basics|fundamentals|start\s+from\s+scratch|never\s+learned|first\s+time|completely\s+new|brand\s+new|explain\s+like\s+i\s+(?:am\s+a|am\s+five|m\s+five|don't|dont|don\'t)\s+.*\s+(?:to|it)|eli(?:5|m5)|no\s+(?:prior\s+)?knowledge/i,

    // Topic extraction patterns
    topics: /(?:about\s+|with\s+|in\s+|on\s+|regarding\s+)?([a-zA-Z\s\-]+?)(?:\s+(?:already|studied|learned|know|understand|familiar|from|in|on|about)|$)/i,

    // Negation patterns (used to filter false positives)
    negation: /don't\s+(?:know|understand)|can't\s+(?:know|understand)|unable\s+to|not\s+(?:familiar|experienced|sure|confident)/i,

    // Teaching/explainer intent (skip mastery detection)
    explainerIntent: /explain|teach\s+me|tell\s+me|help\s+me\s+understand|how\s+do|what\s+(?:is|are)|why\s+(?:is|are)|show\s+me|demonstrate/i
};

// ─── DIFFICULTY LEVEL DETECTION ────────────────────────────────────────────

/**
 * Detect difficulty level intent from student query
 * @param {string} query - Student's query
 * @returns {string} "beginner" | "intermediate" | "advanced"
 */
function detectDifficultyLevel(query) {
    if (!query || typeof query !== 'string') return 'intermediate'; // Default safe fallback

    const lowerQuery = query.toLowerCase();

    // Check for explicit beginner intent
    if (PATTERNS.beginner.test(lowerQuery)) {
        log.info('PRIOR_KNOWLEDGE', `⏪ Beginner intent detected: "${query.substring(0, 50)}..."`);
        return 'beginner';
    }

    // Check for explicit advanced intent
    if (PATTERNS.advanced.test(lowerQuery)) {
        log.info('PRIOR_KNOWLEDGE', `⬆️  Advanced intent detected: "${query.substring(0, 50)}..."`);
        return 'advanced';
    }

    // Check for intermediate intent
    if (PATTERNS.intermediate.test(lowerQuery)) {
        log.info('PRIOR_KNOWLEDGE', `➡️  Intermediate intent detected: "${query.substring(0, 50)}..."`);
        return 'intermediate';
    }

    // Default: intermediate (balanced approach)
    return 'intermediate';
}

// ─── TOPIC EXTRACTION ──────────────────────────────────────────────────────

/**
 * Extract topics from a mastery statement
 * @param {string} query - Student's query
 * @returns {Array<string>} List of identified topics
 */
function extractMasteredTopics(query) {
    if (!query || typeof query !== 'string') return [];

    const topics = [];
    const lowerQuery = query.toLowerCase();

    // Extract topics after mastery keywords
    // Pattern 1: "I already know X, Y, and Z"
    const commaListMatch = lowerQuery.match(/(?:already\s+know|studied|learned|familiar\s+with)\s+([^.!?]+?)(?:\s+and\s+|,|$)/);
    if (commaListMatch && commaListMatch[1]) {
        const topicString = commaListMatch[1];
        const extractedTopics = topicString
            .split(/[,;]/)
            .map(t => t.trim())
            .filter(t => t.length > 2 && t.length < 50)
            .map(t => t.replace(/^(?:the|a|an)\s+/i, '').trim());
        topics.push(...extractedTopics);
    }

    // Pattern 2: "I know about [topic]"
    const aboutMatch = lowerQuery.match(/(?:know\s+about|familiar\s+with|studied|learned)\s+([a-zA-Z\s\-\.]+?)(?:\s+(?:and|in|from|for)|$)/);
    if (aboutMatch && aboutMatch[1]) {
        const topic = aboutMatch[1]
            .trim()
            .replace(/^(?:the|a|an)\s+/i, '')
            .trim();
        if (topic.length > 2 && topic.length < 50) {
            topics.push(topic);
        }
    }

    // Pattern 3: Keywords in query (arrays, linked lists, stacks, etc.)
    const keywordMatch = lowerQuery.match(/(?:arrays?|linked\s+lists?|stacks?|queues?|trees?|graphs?|algorithms?|data\s+structures?|sorting|searching|recursion|dynamic\s+programming|machine\s+learning|deep\s+learning|neural\s+networks?|python|javascript|java|c\+\+|rust|golang|go|typescript)/gi);
    if (keywordMatch) {
        topics.push(...keywordMatch.map(k => k.toLowerCase()));
    }

    // Deduplicate and filter
    const unique = [...new Set(topics)]
        .filter(t => t.length > 2)
        .slice(0, 10); // Cap at 10 topics

    return unique;
}

// ─── PRIOR KNOWLEDGE DETECTION ────────────────────────────────────────────

/**
 * Detect if student has explicitly stated prior knowledge
 * @param {string} query - Student's query
 * @returns {boolean} True if prior knowledge statement detected
 */
function hasPriorKnowledgeStatement(query) {
    if (!query || typeof query !== 'string') return false;

    const lowerQuery = query.toLowerCase();

    // Check for negation pattern first (false positive guard)
    if (PATTERNS.negation.test(lowerQuery)) {
        log.info('PRIOR_KNOWLEDGE', `❌ Negation detected, masking prior knowledge claim`);
        return false;
    }

    // Check if this is primarily an explainer query (e.g., "Explain arrays")
    // vs a mastery claim (e.g., "I know arrays, teach me advanced algorithms")
    const isExplainerIntent = PATTERNS.explainerIntent.test(lowerQuery);
    const hasMasterySignal = PATTERNS.mastery.signal.test(lowerQuery);

    // If it's an explainer query WITHOUT explicit mastery statement, treat as beginner
    if (isExplainerIntent && !hasMasterySignal) {
        log.info('PRIOR_KNOWLEDGE', `📚 Explainer intent detected (no mastery claim)`);
        return false;
    }

    // Check strong mastery signals
    if (PATTERNS.mastery.strong.test(lowerQuery)) {
        log.info('PRIOR_KNOWLEDGE_DETECTED', `✅ Strong mastery signal: "${query.substring(0, 60)}..."`);
        return true;
    }

    // Check moderate mastery signals
    if (PATTERNS.mastery.moderate.test(lowerQuery)) {
        log.info('PRIOR_KNOWLEDGE_DETECTED', `✅ Moderate mastery signal: "${query.substring(0, 60)}..."`);
        return true;
    }

    return false;
}

// ─── MAIN DETECTION FUNCTION ──────────────────────────────────────────────

/**
 * Detect prior knowledge and difficulty intent from student query
 * 
 * @param {string} studentQuery - The student's input query
 * @returns {Object} Classification object:
 *   {
 *     hasPriorKnowledge: boolean,
 *     masteredTopics: Array<string>,
 *     difficultyLevel: "beginner" | "intermediate" | "advanced",
 *     confidence: number (0-1),
 *     signals: {
 *       masteryStatement: boolean,
 *       advancedRequest: boolean,
 *       beginnerRequest: boolean
 *     }
 *   }
 */
function detectPriorKnowledge(studentQuery) {
    if (!studentQuery || typeof studentQuery !== 'string') {
        return {
            hasPriorKnowledge: false,
            masteredTopics: [],
            difficultyLevel: 'intermediate',
            confidence: 0.5,
            signals: {
                masteryStatement: false,
                advancedRequest: false,
                beginnerRequest: false
            }
        };
    }

    const query = studentQuery.trim();
    const lowerQuery = query.toLowerCase();

    // Detect prior knowledge
    const hasMastery = hasPriorKnowledgeStatement(query);
    const masteredTopics = hasMastery ? extractMasteredTopics(query) : [];

    // Detect difficulty level
    const difficultyLevel = detectDifficultyLevel(query);

    // Check for explicit advanced/beginner signals (for metadata)
    const advancedSignal = PATTERNS.advanced.test(lowerQuery);
    const beginnerSignal = PATTERNS.beginner.test(lowerQuery);

    // Calculate confidence score (0-1)
    // Higher if multiple signals align, lower if mixed signals
    let confidence = 0.5;
    if (hasMastery) confidence += 0.25;
    if (masteredTopics.length > 0) confidence += 0.15;
    if (advancedSignal || beginnerSignal) confidence += 0.1;
    confidence = Math.min(1.0, confidence);

    // Log detected state
    if (hasMastery || advancedSignal) {
        log.info('PRIOR_KNOWLEDGE_DETECTED', {
            hasPriorKnowledge: hasMastery,
            topics: masteredTopics,
            difficulty: difficultyLevel,
            confidence: Math.round(confidence * 100) + '%',
            query: query.substring(0, 80)
        });
    }

    if (advancedSignal) {
        log.info('ADVANCED_REQUEST_DETECTED', {
            difficultyLevel,
            query: query.substring(0, 80)
        });
    }

    return {
        hasPriorKnowledge: hasMastery,
        masteredTopics,
        difficultyLevel,
        confidence,
        signals: {
            masteryStatement: hasMastery,
            advancedRequest: advancedSignal,
            beginnerRequest: beginnerSignal
        }
    };
}

// ─── EXPORT ───────────────────────────────────────────────────────────────

module.exports = {
    detectPriorKnowledge,
    hasPriorKnowledgeStatement,
    extractMasteredTopics,
    detectDifficultyLevel,
    PATTERNS
};
/**
 * server/services/priorKnowledgeDetector.js
 * 
 * Prior Knowledge Detection Engine
 * 
 * Detects:
 * - Self-reported mastery statements
 * - Difficulty level intent
 * - Topics the student claims to know
 * 
 * Returns structured classification for curriculum adaptation
 */

const log = require('../utils/logger');

// ─── REGEX PATTERNS ────────────────────────────────────────────────────────

const PATTERNS = {
    // Prior knowledge signals
    mastery: {
        strong: /i\s+(already\s+)?know\s+(?:about\s+)?|i\s+understand(?:\s+about)?|i\s+am\s+familiar\s+with/i,
        moderate: /i\s+(have\s+)?studied|i\s+learned|i\s+took\s+(?:a\s+)?course|i\s+took\s+(?:a\s+)?class|from\s+(?:my|the)\s+course|previously\s+(?:studied|learned)/i,
        signal: /i\s+know|i\s+understand|i\s+studied|i\s+learned|familiar\s+with|prior\s+knowledge|background\s+in|expertise\s+in/i
    },

    // Difficulty level intent
    advanced: /advanced|expert|deep\s+(?:dive|understanding|learning)|in-depth|sophisticated|complex|challenging|hard\s+(?:version|problems)|more\s+(?:advanced|complex|challenging)|next\s+level|intermediate\s+(?:level|concepts)|beyond\s+basics/i,
    intermediate: /intermediate|intermediate\s+level|moving\s+(?:beyond|past)\s+basics|beyond\s+intro|step\s+up|level\s+up/i,
    beginner: /beginner|intro(?:duction)?|basics|fundamentals|start\s+from\s+scratch|never\s+learned|first\s+time|completely\s+new|brand\s+new|explain\s+like\s+i\s+(?:am\s+a|am\s+five|m\s+five|don't|dont|don\'t)\s+.*\s+(?:to|it)|eli(?:5|m5)|no\s+(?:prior\s+)?knowledge/i,

    // Topic extraction patterns
    topics: /(?:about\s+|with\s+|in\s+|on\s+|regarding\s+)?([a-zA-Z\s\-]+?)(?:\s+(?:already|studied|learned|know|understand|familiar|from|in|on|about)|$)/i,

    // Negation patterns (used to filter false positives)
    negation: /don't\s+(?:know|understand)|can't\s+(?:know|understand)|unable\s+to|not\s+(?:familiar|experienced|sure|confident)/i,

    // Teaching/explainer intent (skip mastery detection)
    explainerIntent: /explain|teach\s+me|tell\s+me|help\s+me\s+understand|how\s+do|what\s+(?:is|are)|why\s+(?:is|are)|show\s+me|demonstrate/i
};

// ─── DIFFICULTY LEVEL DETECTION ────────────────────────────────────────────

/**
 * Detect difficulty level intent from student query
 * @param {string} query - Student's query
 * @returns {string} "beginner" | "intermediate" | "advanced"
 */
function detectDifficultyLevel(query) {
    if (!query || typeof query !== 'string') return 'intermediate'; // Default safe fallback

    const lowerQuery = query.toLowerCase();

    // Check for explicit beginner intent
    if (PATTERNS.beginner.test(lowerQuery)) {
        log.info('PRIOR_KNOWLEDGE', `⏪ Beginner intent detected: "${query.substring(0, 50)}..."`);
        return 'beginner';
    }

    // Check for explicit advanced intent
    if (PATTERNS.advanced.test(lowerQuery)) {
        log.info('PRIOR_KNOWLEDGE', `⬆️  Advanced intent detected: "${query.substring(0, 50)}..."`);
        return 'advanced';
    }

    // Check for intermediate intent
    if (PATTERNS.intermediate.test(lowerQuery)) {
        log.info('PRIOR_KNOWLEDGE', `➡️  Intermediate intent detected: "${query.substring(0, 50)}..."`);
        return 'intermediate';
    }

    // Default: intermediate (balanced approach)
    return 'intermediate';
}

// ─── TOPIC EXTRACTION ──────────────────────────────────────────────────────

/**
 * Extract topics from a mastery statement
 * @param {string} query - Student's query
 * @returns {Array<string>} List of identified topics
 */
function extractMasteredTopics(query) {
    if (!query || typeof query !== 'string') return [];

    const topics = [];
    const lowerQuery = query.toLowerCase();

    // Extract topics after mastery keywords
    // Pattern 1: "I already know X, Y, and Z"
    const commaListMatch = lowerQuery.match(/(?:already\s+know|studied|learned|familiar\s+with)\s+([^.!?]+?)(?:\s+and\s+|,|$)/);
    if (commaListMatch && commaListMatch[1]) {
        const topicString = commaListMatch[1];
        const extractedTopics = topicString
            .split(/[,;]/)
            .map(t => t.trim())
            .filter(t => t.length > 2 && t.length < 50)
            .map(t => t.replace(/^(?:the|a|an)\s+/i, '').trim());
        topics.push(...extractedTopics);
    }

    // Pattern 2: "I know about [topic]"
    const aboutMatch = lowerQuery.match(/(?:know\s+about|familiar\s+with|studied|learned)\s+([a-zA-Z\s\-\.]+?)(?:\s+(?:and|in|from|for)|$)/);
    if (aboutMatch && aboutMatch[1]) {
        const topic = aboutMatch[1]
            .trim()
            .replace(/^(?:the|a|an)\s+/i, '')
            .trim();
        if (topic.length > 2 && topic.length < 50) {
            topics.push(topic);
        }
    }

    // Pattern 3: Keywords in query (arrays, linked lists, stacks, etc.)
    const keywordMatch = lowerQuery.match(/(?:arrays?|linked\s+lists?|stacks?|queues?|trees?|graphs?|algorithms?|data\s+structures?|sorting|searching|recursion|dynamic\s+programming|machine\s+learning|deep\s+learning|neural\s+networks?|python|javascript|java|c\+\+|rust|golang|go|typescript)/gi);
    if (keywordMatch) {
        topics.push(...keywordMatch.map(k => k.toLowerCase()));
    }

    // Deduplicate and filter
    const unique = [...new Set(topics)]
        .filter(t => t.length > 2)
        .slice(0, 10); // Cap at 10 topics

    return unique;
}

// ─── PRIOR KNOWLEDGE DETECTION ────────────────────────────────────────────

/**
 * Detect if student has explicitly stated prior knowledge
 * @param {string} query - Student's query
 * @returns {boolean} True if prior knowledge statement detected
 */
function hasPriorKnowledgeStatement(query) {
    if (!query || typeof query !== 'string') return false;

    const lowerQuery = query.toLowerCase();

    // Check for negation pattern first (false positive guard)
    if (PATTERNS.negation.test(lowerQuery)) {
        log.info('PRIOR_KNOWLEDGE', `❌ Negation detected, masking prior knowledge claim`);
        return false;
    }

    // Check if this is primarily an explainer query (e.g., "Explain arrays")
    // vs a mastery claim (e.g., "I know arrays, teach me advanced algorithms")
    const isExplainerIntent = PATTERNS.explainerIntent.test(lowerQuery);
    const hasMasterySignal = PATTERNS.mastery.signal.test(lowerQuery);

    // If it's an explainer query WITHOUT explicit mastery statement, treat as beginner
    if (isExplainerIntent && !hasMasterySignal) {
        log.info('PRIOR_KNOWLEDGE', `📚 Explainer intent detected (no mastery claim)`);
        return false;
    }

    // Check strong mastery signals
    if (PATTERNS.mastery.strong.test(lowerQuery)) {
        log.info('PRIOR_KNOWLEDGE_DETECTED', `✅ Strong mastery signal: "${query.substring(0, 60)}..."`);
        return true;
    }

    // Check moderate mastery signals
    if (PATTERNS.mastery.moderate.test(lowerQuery)) {
        log.info('PRIOR_KNOWLEDGE_DETECTED', `✅ Moderate mastery signal: "${query.substring(0, 60)}..."`);
        return true;
    }

    return false;
}

// ─── MAIN DETECTION FUNCTION ──────────────────────────────────────────────

/**
 * Detect prior knowledge and difficulty intent from student query
 * 
 * @param {string} studentQuery - The student's input query
 * @returns {Object} Classification object:
 *   {
 *     hasPriorKnowledge: boolean,
 *     masteredTopics: Array<string>,
 *     difficultyLevel: "beginner" | "intermediate" | "advanced",
 *     confidence: number (0-1),
 *     signals: {
 *       masteryStatement: boolean,
 *       advancedRequest: boolean,
 *       beginnerRequest: boolean
 *     }
 *   }
 */
function detectPriorKnowledge(studentQuery) {
    if (!studentQuery || typeof studentQuery !== 'string') {
        return {
            hasPriorKnowledge: false,
            masteredTopics: [],
            difficultyLevel: 'intermediate',
            confidence: 0.5,
            signals: {
                masteryStatement: false,
                advancedRequest: false,
                beginnerRequest: false
            }
        };
    }

    const query = studentQuery.trim();
    const lowerQuery = query.toLowerCase();

    // Detect prior knowledge
    const hasMastery = hasPriorKnowledgeStatement(query);
    const masteredTopics = hasMastery ? extractMasteredTopics(query) : [];

    // Detect difficulty level
    const difficultyLevel = detectDifficultyLevel(query);

    // Check for explicit advanced/beginner signals (for metadata)
    const advancedSignal = PATTERNS.advanced.test(lowerQuery);
    const beginnerSignal = PATTERNS.beginner.test(lowerQuery);

    // Calculate confidence score (0-1)
    // Higher if multiple signals align, lower if mixed signals
    let confidence = 0.5;
    if (hasMastery) confidence += 0.25;
    if (masteredTopics.length > 0) confidence += 0.15;
    if (advancedSignal || beginnerSignal) confidence += 0.1;
    confidence = Math.min(1.0, confidence);

    // Log detected state
    if (hasMastery || advancedSignal) {
        log.info('PRIOR_KNOWLEDGE_DETECTED', {
            hasPriorKnowledge: hasMastery,
            topics: masteredTopics,
            difficulty: difficultyLevel,
            confidence: Math.round(confidence * 100) + '%',
            query: query.substring(0, 80)
        });
    }

    if (advancedSignal) {
        log.info('ADVANCED_REQUEST_DETECTED', {
            difficultyLevel,
            query: query.substring(0, 80)
        });
    }

    return {
        hasPriorKnowledge: hasMastery,
        masteredTopics,
        difficultyLevel,
        confidence,
        signals: {
            masteryStatement: hasMastery,
            advancedRequest: advancedSignal,
            beginnerRequest: beginnerSignal
        }
    };
}

// ─── EXPORT ───────────────────────────────────────────────────────────────

module.exports = {
    detectPriorKnowledge,
    hasPriorKnowledgeStatement,
    extractMasteredTopics,
    detectDifficultyLevel,
    PATTERNS
};
