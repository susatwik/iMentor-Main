/**
 * Intelligent Fact Checking Service
 *
 * Analyzes the final source corpus BEFORE synthesis to extract structured evidence,
 * perform causal analysis mechanisms, evaluate contradictions, and compute deep analytical confidence.
 */
const log = require('../utils/logger');
const { LLMRouter } = require('./llmRouterService');

/**
 * Attempt to repair a truncated JSON array by closing all open structures.
 */
function repairTruncatedJsonArray(raw = '') {
    let s = raw.trim();

    // Strip leading/trailing markdown fences
    s = s.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();

    // Find the outermost array
    const start = s.indexOf('[');
    if (start === -1) return null;
    s = s.slice(start);

    // Walk and track open braces / brackets to find the safe end
    let depth = 0;
    let inString = false;
    let escape = false;
    let lastCompleteObject = -1; // index of last '}' at depth 1

    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') {
            depth--;
            if (ch === '}' && depth === 1) lastCompleteObject = i; // closed an object inside the array
        }
    }

    // If well-formed, return as-is
    if (depth === 0) {
        try { JSON.parse(s); return s; } catch (_) { /* fall through */ }
    }

    // Truncated — cut to last complete object and close the array
    if (lastCompleteObject > 0) {
        const safe = s.slice(0, lastCompleteObject + 1) + ']';
        try { JSON.parse(safe); return safe; } catch (_) { /* fall through */ }
    }

    return null;
}

const factCheckingService = {
    /**
     * Pipeline to extract claims and verify them against the provided sources.
     * @param {Array}  sources – AcademicSource schema objects
     * @param {string} query   – core research topic
     * @param {string} userId  – for LLM routing context
     * @returns {Promise<Array>} Array of ClaimVerification objects (empty on failure)
     */
    async verifyCorpusClaims(sources, query, userId) {
        if (!sources || sources.length === 0) return [];

        // Limit to top 10 by credibility to keep context manageable for the 7B model
        const topSources = [...sources]
            .sort((a, b) => (b.credibilityScore || 0) - (a.credibilityScore || 0))
            .slice(0, 10);

        log.info('RESEARCH', `[FactChecking] Extracting claims for "${query.slice(0, 60)}" from ${topSources.length} sources`);

        // Build compact context — 400 chars per source to stay within 7B context window
        const sourceContext = topSources.map(s => {
            const text = (s.abstract || s.content || '').slice(0, 400);
            return `[Source ${s.citationIndex || s.id}] (${s.evidenceCategory || s.sourceType || 'unknown'}): ${text}`;
        }).join('\n\n');

        const prompt = `You are a research analyst extracting factual claims.

Research topic: "${query}"

Extract 5-8 key claims from these sources. For each claim provide causal analysis.

SOURCE CORPUS:
${sourceContext}

OUTPUT: strict JSON array only, no markdown, no explanation.
[
  {
    "claim": "Specific factual claim from the sources.",
    "mechanism": "Underlying mechanism.",
    "cause": "Direct causal driver.",
    "contributing_factors": "Additional factors.",
    "alternative_explanations": "Competing explanations.",
    "second_order_effects": "Long-term implications.",
    "supporting_data": "Quantitative evidence if any.",
    "timeframe": "Time period.",
    "affected_actors": ["Who is impacted"],
    "counter_evidence": "Disconfirming evidence.",
    "evidence_type": "Empirical | Theoretical | Historical | Market Signal | Speculative",
    "strength_of_evidence": "Strong | Moderate | Weak",
    "supportingSources": [1],
    "contradictingSources": [],
    "confidenceScore": 75
  }
]`;

        try {
            const response = await LLMRouter.generate({
                query: prompt,
                userId,
                deepResearchContext: true,
                systemPrompt: 'You are a fact-checker. Output only a strict JSON array. No markdown, no explanation.'
            });

            if (!response || typeof response !== 'string') {
                log.warn('RESEARCH', '[FactChecking] Empty or non-string response from LLM');
                return [];
            }

            // Try to extract and repair JSON array
            const arrayMatch = response.match(/\[[\s\S]*\]/);
            const raw = arrayMatch ? arrayMatch[0] : response;

            // Clean control characters
            const cleaned = raw.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, '');

            let claims;
            try {
                claims = JSON.parse(cleaned);
            } catch (_) {
                const repaired = repairTruncatedJsonArray(cleaned);
                if (repaired) {
                    claims = JSON.parse(repaired);
                    log.warn('RESEARCH', `[FactChecking] Repaired truncated JSON array (${claims.length} claims)`);
                } else {
                    log.warn('RESEARCH', '[FactChecking] JSON parse failed even after repair — returning empty');
                    return [];
                }
            }

            if (!Array.isArray(claims)) {
                log.warn('RESEARCH', '[FactChecking] Parsed result is not an array');
                return [];
            }

            log.info('RESEARCH', `[FactChecking] Extracted ${claims.length} claims successfully`);
            return claims;

        } catch (err) {
            log.warn('RESEARCH', `[FactChecking] Extraction failed: ${err.message}`);
            return [];
        }
    }
};

module.exports = factCheckingService;
