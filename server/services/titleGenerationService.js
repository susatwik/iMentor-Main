/**
 * Title Generation Service
 * 
 * Transforms raw conversational user queries into professional,
 * academic-style research titles suitable for publication.
 * 
 * Uses LLM analysis with heuristic fallback and similarity validation
 * to ensure titles never mirror the raw query.
 */

const log = require('../utils/logger');
const { LLMRouter } = require('./llmRouterService');

// ================================================================
// ABBREVIATION EXPANSION MAP
// ================================================================
const ABBREVIATION_MAP = {
    'AI': 'Artificial Intelligence',
    'ML': 'Machine Learning',
    'DL': 'Deep Learning',
    'NLP': 'Natural Language Processing',
    'CV': 'Computer Vision',
    'IoT': 'Internet of Things',
    'VR': 'Virtual Reality',
    'AR': 'Augmented Reality',
    'SaaS': 'Software as a Service',
    'API': 'Application Programming Interface',
    'EV': 'Electric Vehicle',
    'EVs': 'Electric Vehicles',
    'LLM': 'Large Language Model',
    'LLMs': 'Large Language Models',
    'GPT': 'Generative Pre-trained Transformer',
    'AGI': 'Artificial General Intelligence',
    'GDP': 'Gross Domestic Product',
    'ROI': 'Return on Investment',
    'CRISPR': 'CRISPR-Cas9 Gene Editing',
    'mRNA': 'Messenger RNA',
    'ICT': 'Information and Communication Technology',
    'UX': 'User Experience',
    'UI': 'User Interface',
    'DevOps': 'Development and Operations',
    'fintech': 'Financial Technology',
    'edtech': 'Educational Technology',
    'biotech': 'Biotechnology',
    'nanotech': 'Nanotechnology'
};

// Words to strip from conversational queries
const CONVERSATIONAL_WORDS = [
    'actually', 'really', 'basically', 'literally', 'honestly',
    'just', 'simply', 'like', 'gonna', 'wanna', 'gotta',
    'kinda', 'sorta', 'maybe', 'probably', 'obviously',
    'definitely', 'seriously', 'totally', 'absolutely',
    'hey', 'so', 'well', 'okay', 'ok', 'right', 'yeah',
    'please', 'thanks', 'thank you', 'help me', 'tell me',
    'i want to know', 'can you', 'could you', 'would you',
    'what about', 'how about'
];

const titleGenerationService = {

    /**
     * Generate a professional academic title from a raw user query.
     * Uses LLM with heuristic fallback and similarity validation.
     * 
     * @param {string} rawQuery - The user's conversational research query
     * @param {string} userId - Optional user ID for LLM routing
     * @returns {Promise<string>} Academic-style research title
     */
    async generateAcademicTitle(rawQuery, userId = null) {
        if (!rawQuery || typeof rawQuery !== 'string') {
            return 'Untitled Research Report';
        }

        const cleanedQuery = rawQuery.trim();
        // log.info('AI', `Generating academic title for query...`);

        let generatedTitle;

        // Attempt 1: LLM-based generation
        try {
            generatedTitle = await this._generateWithLLM(cleanedQuery, userId);
            // log.info('AI', `LLM title: "${generatedTitle}"`);
        } catch (llmError) {
            log.warn('AI', `Title generation LLM failed, using heuristic`);
            generatedTitle = null;
        }

        // Attempt 2: Heuristic fallback
        if (!generatedTitle || generatedTitle.length < 10) {
            generatedTitle = this._generateHeuristicTitle(cleanedQuery);
            // log.info('AI', `Heuristic title: "${generatedTitle}"`);
        }

        // Validation: Ensure title is sufficiently different from raw query
        const similarity = this._calculateSimilarity(
            cleanedQuery.toLowerCase(),
            generatedTitle.toLowerCase()
        );

        if (similarity > 0.80) {
            // log.info('AI', 'Title too similar to query, refining...');
            // Try heuristic if LLM produced too-similar result
            const heuristicTitle = this._generateHeuristicTitle(cleanedQuery);
            const heuristicSimilarity = this._calculateSimilarity(
                cleanedQuery.toLowerCase(),
                heuristicTitle.toLowerCase()
            );

            if (heuristicSimilarity < similarity) {
                generatedTitle = heuristicTitle;
            } else {
                // Last resort: prefix with analytical framing
                generatedTitle = `A Comprehensive Analysis of ${this._expandAbbreviations(cleanedQuery)}`;
            }
        }

        // Enforce max 14 words
        generatedTitle = this._enforceWordLimit(generatedTitle, 14);

        // Ensure Title Case
        generatedTitle = this._toTitleCase(generatedTitle);

        log.success('AI', `Generated academic title: ${generatedTitle}`);
        return generatedTitle;
    },

    /**
     * Generate title using LLM.
     * @private
     */
    async _generateWithLLM(query, userId) {
        const prompt = `Convert this user research query into a professional academic research paper title.

QUERY: "${query}"

RULES:
1. Title Case formatting
2. No question marks or question phrasing
3. Expand all abbreviations (AI → Artificial Intelligence, ML → Machine Learning, etc.)
4. Remove conversational words (actually, really, basically, just, etc.)
5. Maximum 14 words
6. Must sound like a published academic paper title
7. Use analytical framing (e.g. "The Impact of...", "Assessing the Role of...", "Comparative Analysis of...")
8. Neutral, objective, scholarly tone

EXAMPLES:
- "Can AI actually replace Jobs" → "The Impact of Artificial Intelligence on Workforce Displacement and Employment Structures"
- "Will robots take over healthcare?" → "Assessing the Role of Robotics and Artificial Intelligence in Future Healthcare Systems"
- "is blockchain worth it for banks" → "Evaluating Blockchain Adoption and Value Proposition in Financial Institutions"
- "how does climate change affect food" → "Climate Change Impacts on Global Food Security and Agricultural Systems"
- "what's the deal with quantum computing" → "Current Developments and Future Prospects of Quantum Computing Technologies"

OUTPUT ONLY the title. No quotes, no explanation, no commentary.`;

        const responseText = await LLMRouter.generate({
            query: prompt,
            userId: userId,
            systemPrompt: 'You are an academic title generator. Output ONLY the title — no quotes, no explanation, no extra text. One line only.'
        });

        // Clean response
        let title = responseText.trim();

        // Remove surrounding quotes if present
        title = title.replace(/^["'""]|["'""]$/g, '');

        // Remove any trailing period
        title = title.replace(/\.\s*$/, '');

        // Remove markdown artifacts
        title = title.replace(/^#+\s*/, '');
        title = title.replace(/\*+/g, '');

        // Take only first line if multi-line
        title = title.split('\n')[0].trim();

        // Validate it's not empty or too short
        if (!title || title.length < 10) {
            throw new Error('LLM returned invalid title');
        }

        return title;
    },

    /**
     * Heuristic-based title generation (fallback).
     * Analyzes query structure and transforms it into academic framing.
     * @private
     */
    _generateHeuristicTitle(query) {
        // Step 1: Clean the query
        let cleaned = query.trim();

        // Remove question marks
        cleaned = cleaned.replace(/\?+/g, '');

        // Remove conversational words
        CONVERSATIONAL_WORDS.forEach(word => {
            const regex = new RegExp(`\\b${word}\\b`, 'gi');
            cleaned = cleaned.replace(regex, '');
        });

        // Collapse extra spaces
        cleaned = cleaned.replace(/\s+/g, ' ').trim();

        // Step 2: Expand abbreviations
        cleaned = this._expandAbbreviations(cleaned);

        // Step 3: Detect question type and apply academic framing
        const lowerQuery = query.toLowerCase();

        if (/^(can|will|could|would|should|is|are|does|do|has|have)\b/i.test(lowerQuery)) {
            // Yes/No → "Assessing..." or "Evaluating..."
            const subject = cleaned.replace(/^(can|will|could|would|should|is|are|does|do|has|have)\s+/i, '');
            return `Assessing ${this._capitalize(subject)}: Implications and Future Directions`;
        }

        if (/^(how|what|why|when|where)\b/i.test(lowerQuery)) {
            // Interrogative → "An Analysis of..."
            const subject = cleaned.replace(/^(how|what|why|when|where)\s+(is|are|does|do|did|has|have|about|the|'s)?\s*/i, '');
            return `An Analysis of ${this._capitalize(subject)}`;
        }

        if (/\bvs\.?\b|\bversus\b|\bcompared?\b|\bcomparison\b/i.test(lowerQuery)) {
            // Comparison → "A Comparative Study of..."
            return `A Comparative Study of ${cleaned}`;
        }

        if (/\bimpact\b|\beffect\b|\binfluence\b/i.test(lowerQuery)) {
            // Already analytical
            return `${this._capitalize(cleaned)}: A Systematic Review`;
        }

        if (/\bfuture\b|\btrend\b|\bprediction\b|\bforecast\b/i.test(lowerQuery)) {
            return `${this._capitalize(cleaned)}: Trends, Challenges, and Future Directions`;
        }

        // Default: wrap with analytical framing
        return `${this._capitalize(cleaned)}: A Comprehensive Review`;
    },

    /**
     * Expand known abbreviations into full forms.
     * @private
     */
    _expandAbbreviations(text) {
        let expanded = text;
        // Sort by length descending to match longer abbreviations first
        const sorted = Object.entries(ABBREVIATION_MAP)
            .sort((a, b) => b[0].length - a[0].length);

        for (const [abbr, full] of sorted) {
            const regex = new RegExp(`\\b${abbr}\\b`, 'g');
            expanded = expanded.replace(regex, full);
        }
        return expanded;
    },

    /**
     * Enforce maximum word count.
     * @private
     */
    _enforceWordLimit(title, maxWords) {
        const words = title.split(/\s+/);
        if (words.length <= maxWords) return title;

        // Try to find a natural break point (colon, dash) near the limit
        const truncated = words.slice(0, maxWords);
        let result = truncated.join(' ');

        // Remove trailing prepositions/conjunctions/articles
        result = result.replace(/\s+(and|or|of|the|in|on|for|to|a|an|with|by|from)\s*$/i, '');

        return result;
    },

    /**
     * Convert text to Title Case (academic style).
     * Preserves lowercase for articles/prepositions/conjunctions unless first word.
     * @private
     */
    _toTitleCase(text) {
        const smallWords = new Set([
            'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from',
            'if', 'in', 'into', 'nor', 'of', 'on', 'or', 'per', 'so',
            'the', 'to', 'up', 'via', 'vs', 'yet', 'with'
        ]);

        return text.split(/\s+/).map((word, index) => {
            // Always capitalize first word and words after colons
            if (index === 0 || text[text.indexOf(word) - 2] === ':') {
                return word.charAt(0).toUpperCase() + word.slice(1);
            }
            // Keep small words lowercase
            if (smallWords.has(word.toLowerCase())) {
                return word.toLowerCase();
            }
            // Capitalize first letter
            return word.charAt(0).toUpperCase() + word.slice(1);
        }).join(' ');
    },

    /**
     * Capitalize first letter of a string.
     * @private
     */
    _capitalize(str) {
        if (!str) return str;
        return str.charAt(0).toUpperCase() + str.slice(1);
    },

    /**
     * Calculate Jaccard similarity between two strings.
     * Used to detect when the generated title is too close to the raw query.
     * @private
     */
    _calculateSimilarity(str1, str2) {
        const words1 = new Set(str1.toLowerCase().split(/\s+/).filter(w => w.length > 2));
        const words2 = new Set(str2.toLowerCase().split(/\s+/).filter(w => w.length > 2));

        if (words1.size === 0 && words2.size === 0) return 1.0;

        const intersection = new Set([...words1].filter(w => words2.has(w)));
        const union = new Set([...words1, ...words2]);

        return intersection.size / union.size;
    }
};

module.exports = titleGenerationService;
