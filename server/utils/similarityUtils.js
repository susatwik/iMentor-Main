const ALIAS_MAP = {
    'ml': 'machine learning',
    'ai': 'artificial intelligence',
    'dbms': 'database management system',
    'sql': 'structured query language',
    'js': 'javascript',
    'ts': 'typescript',
    'reactjs': 'react',
    'vuejs': 'vue',
    'node': 'nodejs',
    'nlp': 'natural language processing',
    'cv': 'computer vision',
    'k8s': 'kubernetes',
    'aws': 'amazon web services',
    'gcp': 'google cloud platform'
};

const STOP_WORDS = new Set(['fundamentals', 'basics', 'programming', 'developer', 'roadmap', 'introduction', 'intro', 'advanced', 'course', 'tutorial', 'guide']);

/**
 * Normalizes a topic string by removing stop words and resolving aliases.
 */
function normalizeAndResolveAlias(topic) {
    if (!topic) return '';
    
    // Split PascalCase into spaces first
    let spaced = topic.replace(/([a-z])([A-Z])/g, '$1 $2');
    
    let normalized = spaced.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .trim();

    let tokens = normalized.split(/\s+/);
    
    // Resolve full string alias first
    if (ALIAS_MAP[normalized]) {
        normalized = ALIAS_MAP[normalized];
        tokens = normalized.split(/\s+/);
    }
    
    // Remove stop words and resolve individual token aliases
    tokens = tokens.map(t => ALIAS_MAP[t] || t).filter(t => !STOP_WORDS.has(t));
    
    return tokens.join(' ');
}

/**
 * Dice Coefficient for token overlap
 */
function getDiceCoefficient(s1, s2) {
    const bigrams = (str) => {
        const set = new Set();
        for (let i = 0; i < str.length - 1; i++) {
            set.add(str.substring(i, i + 2));
        }
        return set;
    };
    
    // If strings are short words, check exact match or substring
    if (s1.length < 3 || s2.length < 3) {
        return s1 === s2 || s1.includes(s2) || s2.includes(s1) ? 1.0 : 0.0;
    }
    
    const bg1 = bigrams(s1);
    const bg2 = bigrams(s2);
    let intersection = 0;
    
    for (const bg of bg1) {
        if (bg2.has(bg)) intersection++;
    }
    
    return (2.0 * intersection) / (bg1.size + bg2.size);
}

/**
 * Token intersection ratio
 */
function getTokenOverlapRatio(norm1, norm2) {
    const set1 = new Set(norm1.split(' '));
    const set2 = new Set(norm2.split(' '));
    if (set1.size === 0 || set2.size === 0) return 0;
    
    let overlap = 0;
    for (const t of set1) {
        if (set2.has(t)) overlap++;
    }
    return overlap / Math.max(set1.size, set2.size);
}

/**
 * Calculates text similarity between two topics.
 * Returns a score between 0 and 1.
 */
function calculateTopicSimilarity(topic1, topic2) {
    const norm1 = normalizeAndResolveAlias(topic1);
    const norm2 = normalizeAndResolveAlias(topic2);

    if (norm1 === norm2) return 1.0;
    if (!norm1 || !norm2) return 0;

    const dice = getDiceCoefficient(norm1, norm2);
    const tokenOverlap = getTokenOverlapRatio(norm1, norm2);

    // Combine both metrics
    const tokens1 = norm1.split(' ').length;
    const tokens2 = norm2.split(' ').length;
    
    if (tokens1 > 1 || tokens2 > 1) {
        return (dice * 0.5) + (tokenOverlap * 0.5);
    }
    
    return dice;
}

module.exports = {
    normalizeAndResolveAlias,
    calculateTopicSimilarity
};
