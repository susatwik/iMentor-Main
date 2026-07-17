const UserScore = require('../models/UserScore');

const BLOOM_LEVELS = {
    REMEMBER: 1,
    UNDERSTAND: 2,
    APPLY: 3,
    ANALYZE: 4,
    EVALUATE: 5,
    CREATE: 6
};

// Keyword mapping for heuristic analysis
const KEYWORD_MAP = {
    [BLOOM_LEVELS.REMEMBER]: ['what is', 'define', 'list', 'recall', 'who', 'when', 'where', 'describe', 'identify'],
    [BLOOM_LEVELS.UNDERSTAND]: ['explain', 'summarize', 'interpret', 'classify', 'compare', 'contrast', 'outline', 'predict'],
    [BLOOM_LEVELS.APPLY]: ['how to', 'apply', 'use', 'demonstrate', 'solve', 'implement', 'calculate', 'build', 'show me'],
    [BLOOM_LEVELS.ANALYZE]: ['analyze', 'why', 'examine', 'break down', 'differentiate', 'investigate', 'relationship between'],
    [BLOOM_LEVELS.EVALUATE]: ['evaluate', 'critique', 'assess', 'justify', 'defend', 'judge', 'best way to', 'pros and cons'],
    [BLOOM_LEVELS.CREATE]: ['create', 'design', 'compose', 'generate', 'invent', 'propose', 'plan', 'develop a new']
};

/**
 * Analyzes the query depth based on Bloom's Taxonomy.
 * Returns a level (1-6) and the category name.
 */
function analyzeQueryDepth(query) {
    const lowerQuery = query.toLowerCase();

    // Iterate from highest complexity to lowest
    for (let level = 6; level >= 1; level--) {
        const keywords = KEYWORD_MAP[level];
        if (keywords.some(k => lowerQuery.includes(k))) {
            return { level, category: getCategoryName(level) };
        }
    }

    // Default to Understand (Level 2) if unclear, or Remember (Level 1)
    return { level: 1, category: 'remember' };
}

function getCategoryName(level) {
    const names = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'];
    return names[level - 1];
}

/**
 * Updates the user's score based on the Bloom's level and optional XP multiplier.
 *
 * @param {string}  userId        - MongoDB user ID
 * @param {string}  query         - Raw student response (used as fallback for heuristic)
 * @param {number|null} overrideLevel  - LLM-supplied Bloom level (1-6); null → keyword heuristic
 * @param {number}  xpMultiplier  - LLM-supplied quality multiplier (0.5–3.0); default 1.0
 */
async function updateUserScore(userId, query, overrideLevel = null, xpMultiplier = 1.0) {
    try {
        const parsedOverride = Number(overrideLevel);
        const hasValidOverride = Number.isFinite(parsedOverride) && parsedOverride >= 1 && parsedOverride <= 6;
        const { level, category } = hasValidOverride
            ? {
                level: Math.round(parsedOverride),
                category: getCategoryName(Math.round(parsedOverride))
            }
            : analyzeQueryDepth(query);

        // Clamp multiplier to a safe range (1.0 when not provided)
        const safeMultiplier = Number.isFinite(Number(xpMultiplier))
            ? Math.max(0.5, Math.min(3.0, Number(xpMultiplier)))
            : 1.0;

        // XP Calculation: (Base + Level * 5) * xpMultiplier, rounded to nearest integer
        const baseXP = 10 + (level * 5);
        const xpReward = Math.round(baseXP * safeMultiplier);

        let userScore = await UserScore.findOne({ userId });
        if (!userScore) {
            userScore = new UserScore({ userId });
        }

        userScore.totalXP += xpReward;
        userScore.cognitiveProfile[category] = (userScore.cognitiveProfile[category] || 0) + 1;
        userScore.lastActive = new Date();

        await userScore.save();

        const source = hasValidOverride ? 'LLM' : 'Heuristic';
        console.log(`[BloomScoring] User ${userId} | Source: ${source} | Bloom: ${level} (${category}) | Multiplier: ${safeMultiplier}x | +${xpReward} XP`);
        return userScore;
    } catch (error) {
        console.error('[BloomScoring] Failed to update score:', error);
        return null;
    }
}

module.exports = {
    analyzeQueryDepth,
    updateUserScore,
    BLOOM_LEVELS
};
