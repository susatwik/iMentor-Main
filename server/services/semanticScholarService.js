const log = require('../utils/logger');
const axios = require('axios');

/**
 * Semantic Scholar Academic Source Service
 *
 * Free public API — no key required (optional key increases rate limits).
 * Returns structured paper objects matching the shared AcademicSource schema.
 *
 * Docs: https://api.semanticscholar.org/api-docs/graph
 */

const BASE_URL = 'https://api.semanticscholar.org/graph/v1/paper/search';
const FIELDS = [
    'paperId', 'title', 'abstract', 'year', 'citationCount',
    'authors', 'externalIds', 'fieldsOfStudy', 'publicationDate',
    'openAccessPdf', 'referenceCount', 'influentialCitationCount',
    'journal', 'publicationVenue'
].join(',');

/**
 * Build request headers — includes optional API key if provided.
 */
function buildHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.SEMANTIC_SCHOLAR_API_KEY) {
        headers['x-api-key'] = process.env.SEMANTIC_SCHOLAR_API_KEY;
    }
    return headers;
}

const semanticScholarService = {
    /**
     * Retrieve academic papers from Semantic Scholar.
     * @param {string} query – search string
     * @param {object} options – { limit: number, year?: string (e.g. "2020-") }
     * @returns {Promise<Array>}  AcademicSource-shaped objects
     */
    async retrieveSources(query, options = {}) {
        const limit = Math.min(options.limit || 10, 100);

        // Optional year filter (e.g. "2022-" means 2022 onwards)
        const params = {
            query: query.trim(),
            limit,
            fields: FIELDS,
            offset: 0,
        };
        if (options.year) params.year = options.year;

        try {
            const response = await axios.get(BASE_URL, {
                params,
                headers: buildHeaders(),
                timeout: 12000,
            });

            const papers = (response.data?.data) || [];
            return papers.map(p => this._mapPaper(p));
        } catch (err) {
            // 429 = rate limited (still useful without key, just slower)
            if (err.response?.status === 429) {
                log.warn('RESEARCH', `Semantic Scholar rate limit hit for: "${query.slice(0, 50)}"`);
            } else {
                log.warn('RESEARCH', `Semantic Scholar error: ${err.message}`);
            }
            return [];
        }
    },

    /**
     * Retrieve papers from Semantic Scholar using its bulk endpoint (sorted by relevance).
     * Used for larger volume fetches.
     * @param {string[]} queries
     * @param {number}   limitPerQuery
     * @param {object}   constraints   – { yearStart?, yearEnd?, venueFilter? }
     */
    async retrieveSourcesBulk(queries = [], limitPerQuery = 8, constraints = {}) {
        const results = [];
        const seen = new Set();

        // Build SS year filter string — e.g. "2025-2026" or "2025-"
        let yearParam;
        if (constraints.yearStart && constraints.yearEnd) {
            yearParam = `${constraints.yearStart}-${constraints.yearEnd}`;
        } else if (constraints.yearStart) {
            yearParam = `${constraints.yearStart}-`;
        }

        for (const q of queries) {
            const papers = await this.retrieveSources(q, { limit: limitPerQuery, year: yearParam });
            for (const p of papers) {
                const key = (p.url || p.title || '').toLowerCase();
                if (!seen.has(key)) {
                    seen.add(key);
                    results.push(p);
                }
            }
        }
        return results;
    },

    /**
     * Map Semantic Scholar API response to internal AcademicSource schema.
     */
    _mapPaper(p) {
        const doi = p.externalIds?.DOI || null;
        const arxivId = p.externalIds?.ArXiv || null;

        let url = null;
        if (doi) url = `https://doi.org/${doi}`;
        else if (arxivId) url = `https://arxiv.org/abs/${arxivId}`;
        else if (p.paperId) url = `https://www.semanticscholar.org/paper/${p.paperId}`;

        // Prefer open-access PDF when available
        const openAccessUrl = p.openAccessPdf?.url || null;

        // Derive publication year
        let year = p.year || null;
        if (!year && p.publicationDate) {
            const parsed = new Date(p.publicationDate).getFullYear();
            if (!Number.isNaN(parsed) && parsed > 1900) year = parsed;
        }

        // Credibility heuristic: influential citations weighted more than raw count
        const citationCount = p.citationCount || 0;
        const influentialCount = p.influentialCitationCount || 0;
        const credScore = Math.min(95, 78 + Math.log1p(citationCount) * 1.5 + influentialCount * 0.3);

        const journal   = p.journal?.name || p.publicationVenue?.name || null;
        const publisher = p.publicationVenue?.publisher || null;

        return {
            title: p.title || 'Untitled',
            abstract: p.abstract || '',
            content: p.abstract || '',
            authors: (p.authors || []).map(a => a.name).filter(Boolean),
            year,
            doi,
            url,
            openAccessUrl,
            journal,
            publisher,
            semanticScholarId: p.paperId || null,
            arxivId,
            citationCount,
            influentialCitationCount: influentialCount,
            referenceCount: p.referenceCount || 0,
            concepts: p.fieldsOfStudy || [],
            referenced_works: [],
            sourceType: 'academic',
            sourceProvider: 'semantic_scholar',
            credibilityScore: Math.round(credScore),
        };
    }
};

module.exports = semanticScholarService;
