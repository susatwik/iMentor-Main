// server/services/advancedUserRecognitionService.js

const ChatHistory = require('../models/ChatHistory');
const StudentKnowledgeState = require('../models/StudentKnowledgeState');
const log = require('../utils/logger');

/**
 * Analyzes user's historical interactions to determine if they've already
 * demonstrated strong understanding of foundational concepts
 */
async function checkUserExpertiseLevel(userId, currentQuery) {
    try {
        // Get user's knowledge state
        const knowledgeState = await StudentKnowledgeState.findOne({ userId });

        if (!knowledgeState) {
            return {
                isReturningExpert: false,
                expertiseLevel: 'beginner',
                masteredConcepts: [],
                shouldSkipBasics: false
            };
        }

        // Extract topic from current query
        const queryTopic = extractTopicFromQuery(currentQuery);

        // Check if user has mastered concepts related to this topic
        const masteredConcepts = knowledgeState.concepts
            .filter(c => c.masteryScore >= 80 && isRelatedTopic(c.conceptName, queryTopic))
            .map(c => c.conceptName);

        // Get recent session count
        const recentSessions = await ChatHistory.countDocuments({
            userId,
            createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } // Last 30 days
        });

        // Determine expertise level
        const expertiseLevel = determineExpertiseLevel(masteredConcepts.length, recentSessions);
        const isReturningExpert = expertiseLevel === 'advanced' || expertiseLevel === 'expert';

        // Check if query is asking about a topic they've already mastered
        const shouldSkipBasics = masteredConcepts.length > 0 &&
            isIntroductoryQuestion(currentQuery) &&
            masteredConcepts.some(concept =>
                currentQuery.toLowerCase().includes(concept.toLowerCase())
            );

        log.info('SYSTEM', `User expertise: ${expertiseLevel} (${masteredConcepts.length} concepts)`);

        return {
            isReturningExpert,
            expertiseLevel,
            masteredConcepts,
            shouldSkipBasics,
            sessionCount: recentSessions
        };

    } catch (error) {
        log.error('SYSTEM', 'Error checking user expertise', error);
        return {
            isReturningExpert: false,
            expertiseLevel: 'beginner',
            masteredConcepts: [],
            shouldSkipBasics: false
        };
    }
}

/**
 * Generates an advanced-level response prefix for returning experts
 */
function generateExpertAcknowledgment(userExpertise, currentQuery) {
    if (!userExpertise.shouldSkipBasics) {
        return null;
    }

    const { masteredConcepts, expertiseLevel } = userExpertise;

    const acknowledgments = [
        `I see you've already mastered ${masteredConcepts[0]}. Let's dive into the advanced aspects and practical applications.`,
        `Since you're already familiar with the core concepts of ${masteredConcepts[0]}, I'll focus on optimization techniques and real-world scenarios.`,
        `You've demonstrated strong understanding of ${masteredConcepts[0]}. Let's explore advanced patterns and edge cases.`,
        `Given your expertise in ${masteredConcepts[0]}, let's skip the basics and discuss implementation strategies and best practices.`
    ];

    // Select acknowledgment based on expertise level
    const index = expertiseLevel === 'expert' ? 3 :
        expertiseLevel === 'advanced' ? 2 : 1;

    return acknowledgments[Math.min(index, acknowledgments.length - 1)] + '\n\n';
}

/**
 * Extracts the main topic from a user query
 */
function extractTopicFromQuery(query) {
    const lowerQuery = query.toLowerCase();

    // Remove common question words
    const cleanQuery = lowerQuery
        .replace(/^(what is|explain|tell me about|how does|describe|what's|who is|can you explain)\s+/i, '')
        .replace(/\?$/, '')
        .trim();

    // Extract key terms (simple implementation - can be enhanced with NLP)
    const words = cleanQuery.split(' ');

    // Return first 2-3 significant words as topic
    return words.slice(0, Math.min(3, words.length)).join(' ');
}

/**
 * Checks if two topics are related
 */
function isRelatedTopic(concept, queryTopic) {
    const conceptLower = concept.toLowerCase();
    const queryLower = queryTopic.toLowerCase();

    // Direct match
    if (conceptLower.includes(queryLower) || queryLower.includes(conceptLower)) {
        return true;
    }

    // Related terms mapping (can be expanded)
    const relatedTerms = {
        'machine learning': ['ml', 'neural network', 'deep learning', 'ai', 'model training'],
        'react': ['jsx', 'hooks', 'components', 'state management', 'redux'],
        'python': ['django', 'flask', 'pandas', 'numpy', 'data science'],
        'javascript': ['js', 'node', 'typescript', 'async', 'promises'],
        'database': ['sql', 'mongodb', 'nosql', 'queries', 'indexing']
    };

    for (const [mainTopic, related] of Object.entries(relatedTerms)) {
        if (conceptLower.includes(mainTopic) || queryLower.includes(mainTopic)) {
            return related.some(term =>
                conceptLower.includes(term) || queryLower.includes(term)
            );
        }
    }

    return false;
}

/**
 * Checks if a query is asking for introductory/basic information
 */
function isIntroductoryQuestion(query) {
    const introPatterns = [
        /^what is/i,
        /^explain/i,
        /^tell me about/i,
        /^how does.*work/i,
        /^describe/i,
        /^what's/i,
        /^can you explain/i,
        /^introduce/i,
        /basics of/i,
        /fundamentals of/i,
        /introduction to/i
    ];

    return introPatterns.some(pattern => pattern.test(query));
}

/**
 * Determines user's expertise level based on mastered concepts and session count
 */
function determineExpertiseLevel(masteredCount, sessionCount) {
    if (masteredCount >= 10 && sessionCount >= 20) {
        return 'expert';
    } else if (masteredCount >= 5 && sessionCount >= 10) {
        return 'advanced';
    } else if (masteredCount >= 2 || sessionCount >= 5) {
        return 'intermediate';
    } else {
        return 'beginner';
    }
}

/**
 * Generates an enhanced system prompt that accounts for user's expertise
 */
function generateExpertiseAwareSystemPrompt(basePrompt, userExpertise) {
    if (!userExpertise.isReturningExpert) {
        return basePrompt;
    }

    const expertiseContext = `
USER EXPERTISE CONTEXT:
- Expertise Level: ${userExpertise.expertiseLevel.toUpperCase()}
- Mastered Concepts: ${userExpertise.masteredConcepts.join(', ')}
- Active Sessions (30 days): ${userExpertise.sessionCount}

INSTRUCTION: This is a returning user with demonstrated expertise. When they ask introductory questions about topics they've already mastered:
1. Briefly acknowledge their existing knowledge
2. Skip basic definitions and foundational explanations
3. Focus on:
   - Advanced applications and use cases
   - Optimization techniques
   - Edge cases and gotchas
   - Real-world implementation patterns
   - Best practices and anti-patterns
4. Use technical terminology appropriate for their level
5. Provide code examples that demonstrate advanced patterns

`;

    return expertiseContext + '\n' + basePrompt;
}

module.exports = {
    checkUserExpertiseLevel,
    generateExpertAcknowledgment,
    generateExpertiseAwareSystemPrompt,
    isIntroductoryQuestion,
    extractTopicFromQuery
};
