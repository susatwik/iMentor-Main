// server/services/semanticIntentService.js

/**
 * Semantic Intent Service
 * Implements a pure JS TF-IDF base classifier for retrieval routing.
 * Fulfills Path 1.2.1: Context-aware ML routing.
 */

const intents = {
    "VECTOR": [
        "What is the definition of", "Tell me about this document", "Extract facts from",
        "Summarize the PDF", "Specific details from the course material",
        "Exact quote about", "Factual information on"
    ],
    "GRAPH": [
        "How does X relate to Y", "What is the connection between", "Influence of X on Y",
        "Multi-hop relationship", "Tracing the impact of", "Correlations between",
        "The hierarchy of", "Complex dependencies"
    ],
    "WEB": [
        "Current news about", "Latest research in 2026", "Recent events regarding",
        "General internet search for", "Real-time updates on", "External info on",
        "Who is currently", "What happened yesterday"
    ],
    "HYBRID": [
        "Compare the document info with web results", "Synthesis of facts and relationships",
        "Provide a comprehensive report using all sources", "Validate paper content with real-time news",
        "A multi-perspective analysis of"
    ]
};

function tokenize(text) {
    return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(t => t.length > 2);
}

function calculateTF(tokens) {
    const tf = {};
    tokens.forEach(token => {
        tf[token] = (tf[token] || 0) + 1;
    });
    return tf;
}

function classifyIntent(query) {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return 'VECTOR';

    let bestIntent = 'VECTOR';
    let maxScore = -1;

    for (const [intentName, corpus] of Object.entries(intents)) {
        let intentScore = 0;
        const corpusTokens = corpus.flatMap(tokenize);

        // Simple TF-IDF like matching (Overlap + Weighting)
        queryTokens.forEach(qToken => {
            const occurrences = corpusTokens.filter(cToken => cToken === qToken).length;
            if (occurrences > 0) {
                // Term frequency in corpus acts as weight
                intentScore += (1 + Math.log10(occurrences));
            }
        });

        // Normalize by intent corpus size to avoid bias towards larger corpora
        const normalizedScore = intentScore / (Math.log10(corpusTokens.length) + 1);

        if (normalizedScore > maxScore) {
            maxScore = normalizedScore;
            bestIntent = intentName;
        }
    }

    console.log(`[SemanticIntent] Query: "${query}" -> Best: ${bestIntent} (Score: ${maxScore.toFixed(4)})`);
    return bestIntent;
}

module.exports = { classifyIntent };
