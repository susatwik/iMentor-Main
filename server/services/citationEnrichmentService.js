const log = require('../utils/logger');
const axios = require('axios');

/**
 * Citation Enrichment Service
 * Enriches research source metadata BEFORE synthesis.
 */

// --- Title Similarity (Levenshtein-based) ---
function similarityScore(a, b) {
    if (!a || !b) return 0;
    const s1 = a.toLowerCase().trim();
    const s2 = b.toLowerCase().trim();
    if (s1 === s2) return 1.0;

    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;

    if (longer.length === 0) return 1.0;

    if (longer.includes(shorter) || shorter.includes(longer)) {
        return shorter.length / longer.length;
    }

    const words1 = new Set(s1.split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(s2.split(/\s+/).filter(w => w.length > 2));
    if (words1.size === 0 || words2.size === 0) return 0;

    let overlap = 0;
    for (const w of words1) {
        if (words2.has(w)) overlap++;
    }
    return overlap / Math.max(words1.size, words2.size);
}

const SIMILARITY_THRESHOLD = 0.75;

const citationEnrichmentService = {

    /**
     * Enrich an array of sources with metadata from academic APIs.
     */
    async enrichSources(sources) {
        if (!sources || sources.length === 0) return [];

        // log.info('AI', `Enriching ${sources.length} sources...`);

        const enrichedSources = [];

        const BATCH_SIZE = 5;
        for (let i = 0; i < sources.length; i += BATCH_SIZE) {
            const batch = sources.slice(i, i + BATCH_SIZE);
            const enrichedBatch = await Promise.all(
                batch.map(source => this.enrichSingleSource(source))
            );
            enrichedSources.push(...enrichedBatch);

            if (i + BATCH_SIZE < sources.length) {
                await new Promise(r => setTimeout(r, 300));
            }
        }

        const indexed = this.assignCitationIndices(enrichedSources);
        // const completeness = this.calculateMetadataCompleteness(indexed);
        // log.info('AI', `Source enrichment complete (Completeness: ${completeness}%)`);

        return indexed;
    },

    /**
     * Enrich a single source object.
     */
    async enrichSingleSource(source) {
        const enriched = {
            ...source,
            title: source.title || 'Untitled Source',
            authors: source.authors || [],
            year: source.publishedYear || source.year || this.extractYearFromDate(source.publishedDate),
            publisher: source.publisher || source.journal || null,
            doi: source.doi || null,
            url: source.url || (source.metadata?.url) || null,
            sourceType: source.sourceType || 'web',
            enrichmentAttempted: false,
            enrichmentSource: null
        };

        const needsEnrichment =
            enriched.authors.length === 0 ||
            !enriched.year ||
            !enriched.publisher;

        if (!needsEnrichment) {
            enriched.enrichmentAttempted = true;
            enriched.enrichmentSource = 'original';
            return enriched;
        }

        try {
            const crossrefResult = await this.queryCrossref(enriched.title);
            if (crossrefResult) {
                this.mergeMetadata(enriched, crossrefResult, 'crossref');
                return enriched;
            }
        } catch (err) {
            // log.warn('AI', `Crossref lookup failed for paper: ${enriched.title?.substring(0, 40)}`);
        }

        try {
            const s2Result = await this.querySemanticScholar(enriched.title);
            if (s2Result) {
                this.mergeMetadata(enriched, s2Result, 'semantic_scholar');
                return enriched;
            }
        } catch (err) {
            // log.warn('AI', `Semantic Scholar lookup failed for paper: ${enriched.title?.substring(0, 40)}`);
        }

        this.inferFromUrl(enriched);

        enriched.enrichmentAttempted = true;
        enriched.enrichmentSource = enriched.enrichmentSource || 'none';
        return enriched;
    },

    /**
     * Query Crossref API for metadata by title.
     */
    async queryCrossref(title) {
        if (!title || title.length < 10) return null;

        const searchTitle = title.substring(0, 200);
        const url = `https://api.crossref.org/works?query.title=${encodeURIComponent(searchTitle)}&rows=3&select=title,author,published-print,published-online,container-title,DOI,publisher,type`;

        const response = await axios.get(url, {
            timeout: 5000,
            headers: {
                'User-Agent': 'iMentor-DeepResearch/1.0 (mailto:research@imentor.app)'
            }
        });

        const items = response.data?.message?.items || [];
        if (items.length === 0) return null;

        for (const item of items) {
            const itemTitle = Array.isArray(item.title) ? item.title[0] : item.title;
            const score = similarityScore(title, itemTitle);

            if (score >= SIMILARITY_THRESHOLD) {
                const published = item['published-print'] || item['published-online'];
                const year = published?.['date-parts']?.[0]?.[0];

                return {
                    title: itemTitle || title,
                    authors: (item.author || []).map(a => {
                        if (a.given && a.family) return `${a.given} ${a.family}`;
                        if (a.family) return a.family;
                        if (a.name) return a.name;
                        return null;
                    }).filter(Boolean),
                    year: year || null,
                    publisher: item.publisher || null,
                    journal: Array.isArray(item['container-title']) ? item['container-title'][0] : item['container-title'],
                    doi: item.DOI || null,
                    matchScore: score
                };
            }
        }

        return null;
    },

    /**
     * Query Semantic Scholar API for metadata by title.
     */
    async querySemanticScholar(title) {
        if (!title || title.length < 10) return null;

        const searchTitle = title.substring(0, 200);
        const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(searchTitle)}&limit=3&fields=title,authors,year,venue,externalIds`;

        const response = await axios.get(url, {
            timeout: 5000,
            headers: {
                'User-Agent': 'iMentor-DeepResearch/1.0'
            }
        });

        const papers = response.data?.data || [];
        if (papers.length === 0) return null;

        for (const paper of papers) {
            const score = similarityScore(title, paper.title);

            if (score >= SIMILARITY_THRESHOLD) {
                return {
                    title: paper.title || title,
                    authors: (paper.authors || []).map(a => a.name).filter(Boolean),
                    year: paper.year || null,
                    publisher: paper.venue || null,
                    journal: paper.venue || null,
                    doi: paper.externalIds?.DOI || null,
                    matchScore: score
                };
            }
        }

        return null;
    },

    /**
     * Merge enrichment data into source, without overwriting existing data.
     */
    mergeMetadata(source, enrichment, provider) {
        if (source.authors.length === 0 && enrichment.authors?.length > 0) {
            source.authors = enrichment.authors;
        }
        if (!source.year && enrichment.year) {
            source.year = enrichment.year;
        }
        if (!source.publisher && (enrichment.publisher || enrichment.journal)) {
            source.publisher = enrichment.publisher || enrichment.journal;
        }
        if (!source.doi && enrichment.doi) {
            source.doi = enrichment.doi;
        }

        source.enrichmentAttempted = true;
        source.enrichmentSource = provider;
    },

    /**
     * Infer metadata from the URL when API enrichment fails.
     */
    inferFromUrl(source) {
        if (!source.url) return;

        try {
            const hostname = new URL(source.url).hostname.replace('www.', '');

            if (!source.publisher) {
                const publisherMap = {
                    'arxiv.org': 'arXiv Preprint',
                    'nature.com': 'Nature',
                    'science.org': 'Science',
                    'ieee.org': 'IEEE',
                    'acm.org': 'ACM',
                    'springer.com': 'Springer',
                    'sciencedirect.com': 'Elsevier',
                    'wiley.com': 'Wiley',
                    'ncbi.nlm.nih.gov': 'PubMed',
                    'scholar.google.com': 'Google Scholar',
                    'researchgate.net': 'ResearchGate',
                    'mdpi.com': 'MDPI',
                    'frontiersin.org': 'Frontiers',
                    'plos.org': 'PLOS',
                    'biorxiv.org': 'bioRxiv Preprint',
                    'medrxiv.org': 'medRxiv Preprint',
                    'ssrn.com': 'SSRN',
                    'medium.com': 'Medium',
                    'towardsdatascience.com': 'Towards Data Science'
                };

                for (const [domain, pub] of Object.entries(publisherMap)) {
                    if (hostname.includes(domain)) {
                        source.publisher = pub;
                        break;
                    }
                }

                if (!source.publisher) {
                    source.publisher = hostname;
                }
            }

            if (!source.doi) {
                const doiMatch = source.url.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
                if (doiMatch) {
                    source.doi = doiMatch[0];
                }
            }

            if (!source.doi && hostname.includes('arxiv.org')) {
                const arxivMatch = source.url.match(/(\d{4}\.\d{4,5})/);
                if (arxivMatch) {
                    source.doi = `arXiv:${arxivMatch[1]}`;
                }
            }

        } catch (e) {
            log.warn('CITATION', `Could not infer citation metadata from URL: ${e.message}`);
        }
    },

    /**
     * Extract year from a date string or Date object.
     */
    extractYearFromDate(dateInput) {
        if (!dateInput) return null;
        try {
            const d = new Date(dateInput);
            const year = d.getFullYear();
            return (year > 1900 && year <= new Date().getFullYear() + 1) ? year : null;
        } catch {
            return null;
        }
    },

    /**
     * Assign deterministic citation indices [1], [2], [3]...
     */
    assignCitationIndices(sources) {
        const sorted = [...sources].sort((a, b) => {
            const typeOrder = { academic: 0, local: 1, web: 2 };
            const typeA = typeOrder[a.sourceType] ?? 2;
            const typeB = typeOrder[b.sourceType] ?? 2;
            if (typeA !== typeB) return typeA - typeB;
            return (b.credibilityScore || 0) - (a.credibilityScore || 0);
        });

        return sorted.map((source, index) => ({
            ...source,
            citationIndex: index + 1
        }));
    },

    /**
     * Calculate metadata completeness percentage across all sources.
     */
    calculateMetadataCompleteness(sources) {
        if (sources.length === 0) return 0;

        let totalFields = 0;
        let filledFields = 0;

        const requiredFields = ['title', 'authors', 'year', 'publisher', 'url'];

        for (const source of sources) {
            for (const field of requiredFields) {
                totalFields++;
                if (field === 'authors') {
                    if (source.authors && source.authors.length > 0) filledFields++;
                } else if (source[field]) {
                    filledFields++;
                }
            }
        }

        return Math.round((filledFields / totalFields) * 100);
    },

    /**
     * Build a structured citation map string for LLM consumption.
     */
    buildCitationMapForLLM(enrichedSources) {
        return enrichedSources.map(s => {
            const authors = s.authors?.length > 0
                ? (s.authors.length > 3 ? `${s.authors[0]} et al.` : s.authors.join(', '))
                : 'Unknown';
            const year = s.year || 'n.d.';
            const publisher = s.publisher || s.sourceType || 'Web';

            return `[${s.citationIndex}] ${authors} (${year}). "${s.title}". ${publisher}. Credibility: ${s.credibilityScore || 'N/A'}/100.`;
        }).join('\n');
    },

    /**
     * Build a structured source context block for LLM consumption.
     */
    buildSourceContextForLLM(enrichedSources) {
        return enrichedSources.map(s => {
            const authors = s.authors?.length > 0 ? s.authors.join(', ') : 'Unknown';
            const year = s.year || 'n.d.';

            return `=== SOURCE [${s.citationIndex}] ===
Title: ${s.title}
Authors: ${authors}
Year: ${year}
Publisher: ${s.publisher || 'N/A'}
Type: ${s.sourceType || 'web'} | Credibility: ${s.credibilityScore || 'N/A'}/100
Content:
${s.content ? s.content.substring(0, 1000) : 'No content available.'}
===`;
        }).join('\n\n');
    }
};

module.exports = citationEnrichmentService;
