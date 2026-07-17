const STOP_WORDS = new Set([
    'the', 'and', 'with', 'from', 'that', 'this', 'into', 'about', 'their', 'there', 'have', 'has', 'were', 'been', 'will', 'would', 'could', 'should', 'than', 'then', 'while', 'where', 'when', 'what', 'which', 'who', 'why', 'how', 'for', 'are', 'is', 'was', 'be', 'to', 'of', 'in', 'on', 'at', 'by', 'an', 'or', 'as', 'it', 'its'
]);

const EVIDENCE_STRENGTH = {
    empirical: 0.95,
    historical: 0.8,
    theoretical: 0.65,
    market_signal: 0.78,
    speculative: 0.35
};

const validatedResearchSources = [];

/**
 * Nature × Depth configuration matrix.
 *
 * Controls total sources, per-provider quotas (in absolute counts), and
 * synthesis targets (pages, sections, words-per-section).
 *
 * Source distribution rules:
 *   ≥ 60%  academic (OpenAlex + Semantic Scholar)
 *   10-20% ArXiv (more for "research" nature)
 *   ≤ 30%  web (recent ≤ 3 months preferred; older tagged goldStandard)
 */
const NATURE_DEPTH_MATRIX = {
    general: {
        low:    { total: 30,  openAlex: 12, semantic: 6,  arxiv: 3,  web: 9,  pages: [3,4],  sections: 5,  minWordsPerSection: 400 },
        medium: { total: 45,  openAlex: 18, semantic: 9,  arxiv: 5,  web: 13, pages: [4,5],  sections: 7,  minWordsPerSection: 500 },
        high:   { total: 60,  openAlex: 24, semantic: 12, arxiv: 9,  web: 15, pages: [6,8],  sections: 9,  minWordsPerSection: 600 },
    },
    academic: {
        low:    { total: 35,  openAlex: 16, semantic: 9,  arxiv: 5,  web: 5,  pages: [4,5],  sections: 6,  minWordsPerSection: 500 },
        medium: { total: 50,  openAlex: 23, semantic: 13, arxiv: 8,  web: 7,  pages: [5,7],  sections: 8,  minWordsPerSection: 600 },
        high:   { total: 65,  openAlex: 30, semantic: 16, arxiv: 10, web: 9,  pages: [8,10], sections: 11, minWordsPerSection: 700 },
    },
    research: {
        low:    { total: 40,  openAlex: 16, semantic: 8,  arxiv: 8,  web: 8,  pages: [5,6],  sections: 7,  minWordsPerSection: 500 },
        medium: { total: 55,  openAlex: 22, semantic: 11, arxiv: 11, web: 11, pages: [7,9],  sections: 10, minWordsPerSection: 650 },
        high:   { total: 70,  openAlex: 28, semantic: 14, arxiv: 14, web: 14, pages: [10,12],sections: 13, minWordsPerSection: 750 },
    },
};

const DEFAULT_RESEARCH_CONFIG = {
    nature: 'academic',
    depth:  'medium',
    target_source_count: 50,
    openAlexTarget:  23,
    semanticTarget:  13,
    arxivTarget:     8,
    webTarget:       7,
    empirical_ratio: 0.60,
    allow_adaptive_fallback: true,
    minimum_counter_sources: 2,
    minimum_industry_or_report: 2,
    minimum_academic: 15,
    strictness: 'standard',
    targetPages: [5, 7],
    targetSections: 8,
    minWordsPerSection: 600,
};

function tokenize(text = '') {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(token => token.length > 2 && !STOP_WORDS.has(token));
}

function uniqueList(items = []) {
    return [...new Set(items.filter(Boolean).map(item => String(item).trim()).filter(Boolean))];
}

function extractYear(source) {
    const candidates = [source.year, source.publishedYear, source.publishedDate];
    for (const value of candidates) {
        if (!value) continue;
        const year = value instanceof Date ? value.getFullYear() : new Date(value).getFullYear();
        if (!Number.isNaN(year) && year > 1900 && year <= (new Date().getFullYear() + 1)) {
            return year;
        }
    }
    return null;
}

function safeText(source) {
    return [source.title, source.abstract, source.content, source.snippet].filter(Boolean).join(' ').toLowerCase();
}

function scoreRecency(year) {
    if (!year) return 0.45;
    const age = new Date().getFullYear() - year;
    if (age <= 1) return 1;
    if (age <= 3) return 0.9;
    if (age <= 5) return 0.8;
    if (age <= 10) return 0.6;
    return 0.4;
}

function detectEvidenceCategory(text, sourceType) {
    const hasNumbers = /\b\d+(\.\d+)?%?\b/.test(text);
    const hasEmpiricalKeywords = /(dataset|survey|sample|experiment|regression|panel|randomized|meta-analysis|empirical|n=|observation)/.test(text);
    const hasHistoricalKeywords = /(historical|previous cycle|prior era|dot-com|dot com|2008|1999|timeline|longitudinal)/.test(text);
    const hasTheoreticalKeywords = /(framework|model|theory|hypothesis|conceptual|proposition)/.test(text);
    const hasMarketKeywords = /(valuation|earnings|revenue|capex|ipo|market share|cash flow|gross margin|multiple|institutional)/.test(text);

    if (sourceType === 'academic' && (hasEmpiricalKeywords || hasNumbers)) return 'empirical';
    if (hasEmpiricalKeywords && hasNumbers) return 'empirical';
    if (hasHistoricalKeywords) return 'historical';
    if (hasMarketKeywords && hasNumbers) return 'market_signal';
    if (hasTheoreticalKeywords) return 'theoretical';
    return 'speculative';
}

function scoreDataRichness(text = '') {
    const numericMatches = text.match(/\b\d+(\.\d+)?%?\b/g) || [];
    const financeSignals = text.match(/\b(revenue|earnings|margin|capex|valuation|ipo|growth rate|adoption|productivity|yield|multiple)\b/g) || [];
    const cap = Math.min(1, (numericMatches.length * 0.04) + (financeSignals.length * 0.08));
    return Math.max(0.15, cap);
}

function normalizeScore(value) {
    if (typeof value !== 'number' || Number.isNaN(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function toNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function normalizedOverlapScore(overlap, tokenSetSize, cap = 12) {
    if (!tokenSetSize || tokenSetSize <= 0) return 0.7;
    const denom = Math.max(1, Math.min(cap, tokenSetSize));
    return clamp(overlap / denom, 0, 1);
}

function defaultDimensionsForQuery(query) {
    const q = query.toLowerCase();

    // Detect technical / engineering / ML / scientific queries
    const isTechnical = /(deep learning|machine learning|neural network|algorithm|model|estimation|prediction|battery|lstm|cnn|rnn|transformer|dataset|benchmark|accuracy|training|inference|signal processing|sensor|hardware|firmware|embedded|circuit|semiconductor|chemistry|physics|biology|genomic|protein|climate|geospatial|satellite|radar|lidar|optical|quantum|robotics|autonomous|reinforcement learning|computer vision|nlp|natural language|speech|image|classification|regression|clustering|optimization|gradient|loss function|epoch|overfitting|regularization|precision|recall|f1|mse|rmse|mae|auc|roc|confusion matrix|feature engineering|hyperparameter|preprint|arxiv|journal|conference|proceedings|doi|peer.reviewed)/.test(q);

    if (isTechnical) {
        const dims = [
            'methodology and algorithmic approach',
            'empirical results and benchmark performance',
            'dataset and experimental validation',
            'model architecture and training procedure',
            'accuracy precision recall performance metrics',
            'comparison with state of the art methods',
            'limitations and future research directions',
            'application domain and deployment use case',
            'computational efficiency hardware requirements',
            'reproducibility open source code availability'
        ];
        if (/(battery|soc|rul|soh|lithium|charge|energy storage)/.test(q)) {
            dims.push('battery degradation cycle life aging');
            dims.push('state estimation electrochemical model');
        }
        if (/(health|biotech|medical|clinical|drug|patient)/.test(q)) {
            dims.push('clinical trial safety efficacy outcomes');
        }
        return uniqueList(dims).slice(0, 10);
    }

    // Finance / economics / market queries — original dimensions
    const dimensions = [
        'historical economic structure comparison',
        'capital formation and funding dynamics',
        'investor composition and market participation',
        'revenue fundamentals and profitability maturity',
        'infrastructure and deployment readiness',
        'productivity and measurable real-economy signal analysis',
        'speculative behavior and valuation dislocation indicators',
        'macroeconomic and policy context',
        'regulatory and governance differences',
        'systemic risk and feedback loop analysis'
    ];

    if (/(labor|workforce|employment|jobs)/.test(q)) {
        dimensions.push('labor market transition, wage dispersion, and skill bottlenecks');
    }
    if (/(health|biotech|medical)/.test(q)) {
        dimensions.push('clinical or operational adoption constraints');
    }

    return uniqueList(dimensions).slice(0, 10);
}

function defaultExpandedQueries(query, dimensions) {
    const firstDimensions = dimensions.slice(0, 8);
    const directionalTemplates = [
        `${query} empirical evidence dataset survey`,
        `${query} industry report financial metrics`,
        `${query} historical comparison structural differences`,
        `${query} causal mechanism analysis`,
        `${query} second-order effects long-term implications`,
        `${query} counter evidence skeptical analysis`,
        `${query} risk concentration systemic fragility`,
        `${query} productivity signal measurable impact`
    ];

    const fromDimensions = firstDimensions.map(d => `${query} ${d}`);
    return uniqueList([...directionalTemplates, ...fromDimensions]).slice(0, 12);
}

function classifySourceRole(source, evidenceCategory, text) {
    const isAcademic = source.sourceType === 'academic';
    const url = (source.url || '').toLowerCase();
    const retrievalQuery = (source.retrievalQuery || '').toLowerCase();

    const empiricalAcademic = isAcademic && (evidenceCategory === 'empirical' || /(study|dataset|survey|empirical)/.test(text));
    const industryFinancial = (!isAcademic) && /(mckinsey|goldman|morgan stanley|world bank|imf|oecd|sec|earnings|10-k|industry report|financial)/.test(`${text} ${url}`);
    const datasetOrSurvey = /(dataset|survey|sample|n=|world development indicators|census|bureau of labor|statista)/.test(text);
    const counterPosition = /(skeptic|overvalued|bubble risk|contrary|limited impact|weak evidence|counter)/.test(`${text} ${retrievalQuery}`);
    const policyGovReport = /(gov|oecd|imf|world bank|policy report|ministry|federal reserve|ecb|united nations|whitepaper|white paper)/.test(`${text} ${url}`);
    const peerReviewedLikely = isAcademic && /(journal|conference|proceedings|doi|peer-reviewed|peer reviewed|openalex)/.test(`${text} ${url}`);

    return {
        empiricalAcademic,
        industryFinancial,
        datasetOrSurvey,
        counterPosition,
        policyGovReport,
        peerReviewedLikely
    };
}

function parseSourceCountFromQuery(query = '') {
    const patterns = [
        /(analyze|analyse)\s+using\s+(\d{1,2})\s+(papers|sources|studies)/i,
        /use\s+(\d{1,2})\s+(papers|sources|studies)/i,
        /limit\s+to\s+(\d{1,2})\s+(papers|sources|studies)/i,
        /(\d{1,2})\s+(papers|sources|studies)/i
    ];

    for (const pattern of patterns) {
        const match = query.match(pattern);
        if (!match) continue;
        const num = toNumber(match[2] || match[1], null);
        if (num && num > 0) return clamp(num, 3, 20);
    }
    return null;
}

const researchIntelligenceService = {
    /**
     * Resolve the research configuration from nature + depth.
     * Users no longer specify source counts — they pick Nature and Depth.
     */
    resolveResearchConfig(query, userConfig = null) {
        const cfg = { ...DEFAULT_RESEARCH_CONFIG, ...(userConfig || {}) };

        // Normalise nature / depth from user selection
        const nature = ['general', 'academic', 'research'].includes(cfg.nature)
            ? cfg.nature : 'academic';
        const depth  = ['low', 'medium', 'high'].includes(cfg.depth)
            ? cfg.depth : 'medium';

        const preset = NATURE_DEPTH_MATRIX[nature][depth];

        // Apply preset — overrides any manual source-count specification
        cfg.nature               = nature;
        cfg.depth                = depth;
        cfg.target_source_count  = preset.total;
        cfg.openAlexTarget       = preset.openAlex;
        cfg.semanticTarget       = preset.semantic;
        cfg.arxivTarget          = preset.arxiv;
        cfg.webTarget            = preset.web;
        cfg.targetPages          = preset.pages;
        cfg.targetSections       = preset.sections;
        cfg.minWordsPerSection   = preset.minWordsPerSection;

        // Academic-fraction drives the empirical ratio
        const academicFraction   = (preset.openAlex + preset.semantic + preset.arxiv) / preset.total;
        cfg.empirical_ratio      = Math.min(0.90, Math.round(academicFraction * 100) / 100);
        cfg.empirical_required   = Math.ceil(preset.total * cfg.empirical_ratio);

        // Scale minimums proportionally
        cfg.minimum_academic             = Math.max(5,  Math.floor(preset.total * 0.25));
        cfg.minimum_counter_sources      = Math.max(2,  Math.floor(preset.total * 0.04));
        cfg.minimum_industry_or_report   = Math.max(2,  Math.floor(preset.total * 0.04));

        cfg.allow_adaptive_fallback = cfg.allow_adaptive_fallback !== false;
        cfg.studentSpecifiedCount   = false; // users choose nature/depth, not raw counts

        return cfg;
    },

    /** Expose the matrix so callers can show the config to users */
    getNatureDepthMatrix() {
        return NATURE_DEPTH_MATRIX;
    },

    buildQueryBlueprint(query, plan = {}) {
        const incomingDimensions = Array.isArray(plan.research_dimensions) ? plan.research_dimensions : [];
        const normalizedDimensions = uniqueList([...incomingDimensions, ...defaultDimensionsForQuery(query)]).slice(0, 10);

        const researchObjectives = normalizedDimensions.map(dimension => ({
            dimension,
            objective: `Evaluate ${dimension} for the question: ${query}`,
            requiredEvidence: 'At least one empirical or market-backed signal with explicit mechanism.'
        }));

        const expandedQueries = uniqueList([
            ...(Array.isArray(plan.expanded_search_queries) ? plan.expanded_search_queries : []),
            ...defaultExpandedQueries(query, normalizedDimensions)
        ]).slice(0, 12);

        const counterEvidenceQueries = uniqueList([
            ...(Array.isArray(plan.counter_evidence_queries) ? plan.counter_evidence_queries : []),
            `${query} criticism evidence`,
            `${query} failure cases`,
            `${query} overvaluation risks`,
            `${query} disconfirming data`
        ]).slice(0, 6);

        return {
            research_dimensions: normalizedDimensions,
            research_objectives: researchObjectives,
            expanded_search_queries: expandedQueries,
            counter_evidence_queries: counterEvidenceQueries
        };
    },

    dedupeSources(sources = []) {
        const map = new Map();
        for (const source of sources) {
            const urlKey = (source.url || '').trim().toLowerCase();
            const titleKey = (source.title || '').trim().toLowerCase();
            const key = urlKey || titleKey;
            if (!key) continue;

            const existing = map.get(key);
            if (!existing) {
                map.set(key, source);
                continue;
            }

            const existingLen = (existing.content || existing.abstract || '').length;
            const currentLen = (source.content || source.abstract || '').length;
            if (currentLen > existingLen) {
                map.set(key, { ...existing, ...source });
            }
        }
        return Array.from(map.values());
    },

    evaluateSource(source, context) {
        const queryTokens = new Set(tokenize(context.query));
        const dimensionTokens = new Set(tokenize((context.dimensions || []).join(' ')));
        const text = safeText(source);
        const textTokens = new Set(tokenize(text));

        let queryOverlap = 0;
        queryTokens.forEach(token => { if (textTokens.has(token)) queryOverlap++; });

        let dimensionOverlap = 0;
        dimensionTokens.forEach(token => { if (textTokens.has(token)) dimensionOverlap++; });

        const topicalRelevance = queryTokens.size > 0
            ? normalizedOverlapScore(queryOverlap, queryTokens.size, 10)
            : 0.7;

        // Critical fix: do not divide by very large dimension token sets;
        // cap denominator so multi-dimension plans do not force near-zero alignment.
        const domainAlignment = dimensionTokens.size > 0
            ? normalizedOverlapScore(dimensionOverlap, dimensionTokens.size, 12)
            : 0.7;

        const evidenceCategory = detectEvidenceCategory(text, source.sourceType);
        const evidenceStrength = EVIDENCE_STRENGTH[evidenceCategory] || 0.35;
        const recency = scoreRecency(extractYear(source));
        const dataRichness = scoreDataRichness(text);
        const credibility = normalizeScore((source.credibilityScore || source.credibilityBaseScore || 50) / 100);
        const citationDensity = normalizeScore(toNumber(source.citationCount, 0) / 200);

        // source_score = 0.30 credibility + 0.25 empirical_strength + 0.20 topical_relevance + 0.15 citation_density + 0.10 recency
        const rankingScore = (
            credibility * 0.30 +
            evidenceStrength * 0.25 +
            topicalRelevance * 0.20 +
            citationDensity * 0.15 +
            recency * 0.10
        );

        const overall = (
            topicalRelevance * 0.25 +
            domainAlignment * 0.2 +
            evidenceStrength * 0.2 +
            credibility * 0.2 +
            recency * 0.1 +
            dataRichness * 0.05
        );

        const thresholds = context.thresholds || { relevance: 0.65, domainAlignment: 0.6, includeNearMatch: false };
        const strictEvidenceGate = (dataRichness >= 0.2 || evidenceStrength >= 0.65);
        const nearMatchGate = thresholds.includeNearMatch && (
            (topicalRelevance >= (thresholds.relevance - 0.08) && domainAlignment >= (thresholds.domainAlignment - 0.1) && credibility >= 0.45)
            || (topicalRelevance >= 0.5 && credibility >= 0.55)
        );

        const passesThreshold = (
            topicalRelevance >= thresholds.relevance &&
            domainAlignment >= thresholds.domainAlignment &&
            strictEvidenceGate
        ) || nearMatchGate;
        const roles = classifySourceRole(source, evidenceCategory, text);

        const repositoryWeight = (
            roles.peerReviewedLikely ? 1.0 :
                source.sourceType === 'academic' ? 0.9 :
                    roles.policyGovReport ? 0.82 :
                        roles.industryFinancial ? 0.78 :
                            0.55
        );

        return {
            ...source,
            evidenceCategory,
            source_score: Number((rankingScore * repositoryWeight).toFixed(3)),
            sourceValidation: {
                topicalRelevance: Number(topicalRelevance.toFixed(3)),
                domainAlignment: Number(domainAlignment.toFixed(3)),
                evidenceStrength: Number(evidenceStrength.toFixed(3)),
                citationDensity: Number(citationDensity.toFixed(3)),
                credibility: Number(credibility.toFixed(3)),
                recency: Number(recency.toFixed(3)),
                dataRichness: Number(dataRichness.toFixed(3)),
                overall: Number(overall.toFixed(3)),
                passesThreshold
            },
            sourceRole: roles
        };
    },

    evaluateCorpus(sources, context) {
        return sources.map(source => this.evaluateSource(source, context));
    },

    selectTopSourcesWithBalance(sources = [], researchConfig) {
        const cfg = researchConfig || DEFAULT_RESEARCH_CONFIG;
        const target = cfg.target_source_count;
        const empiricalRequired = cfg.empirical_required || Math.ceil(target * 0.60);

        const sorted = [...sources].sort((a, b) => (b.source_score || 0) - (a.source_score || 0));
        const empirical = sorted.filter(s =>
            s.evidenceCategory === 'empirical' || s.sourceType === 'academic' ||
            s.sourceRole?.datasetOrSurvey || s.sourceRole?.empiricalAcademic
        );
        const nonEmpirical = sorted.filter(s =>
            !(s.evidenceCategory === 'empirical' || s.sourceType === 'academic' ||
              s.sourceRole?.datasetOrSurvey || s.sourceRole?.empiricalAcademic)
        );

        const picked = [];

        // Provider-balanced mandatory picks
        const openAlexSorted  = sorted.filter(s => s.sourceProvider === 'openalex');
        const semanticSorted  = sorted.filter(s => s.sourceProvider === 'semantic_scholar');
        const arxivSorted     = sorted.filter(s => s.sourceProvider === 'arxiv');
        const webSorted       = sorted.filter(s => s.sourceType !== 'academic' && s.sourceType !== 'local');

        const mandatoryGroups = [
            { sources: openAlexSorted,  quota: cfg.openAlexTarget  || Math.floor(target * 0.40) },
            { sources: semanticSorted,  quota: cfg.semanticTarget   || Math.floor(target * 0.20) },
            { sources: arxivSorted,     quota: cfg.arxivTarget      || Math.floor(target * 0.12) },
            { sources: webSorted,       quota: cfg.webTarget        || Math.floor(target * 0.25) },
        ];

        for (const { sources: provSources, quota } of mandatoryGroups) {
            let count = 0;
            for (const src of provSources) {
                if (count >= quota || picked.length >= target) break;
                if (!picked.includes(src)) { picked.push(src); count++; }
            }
        }

        // Fill remaining slots with highest-scored sources not yet picked
        const mustHave = [
            ...sorted.filter(s => s.sourceType === 'academic').slice(0, cfg.minimum_academic || 5),
            ...sorted.filter(s => s.sourceRole?.industryFinancial || s.sourceRole?.policyGovReport).slice(0, cfg.minimum_industry_or_report || 2),
            ...sorted.filter(s => s.sourceRole?.counterPosition).slice(0, cfg.minimum_counter_sources || 2),
        ];
        for (const src of mustHave) {
            if (picked.length >= target) break;
            if (!picked.includes(src)) picked.push(src);
        }

        for (const src of [...empirical.filter(s => !picked.includes(s)), ...nonEmpirical.filter(s => !picked.includes(s))]) {
            if (picked.length >= target) break;
            picked.push(src);
        }

        return picked;
    },

    computeSufficiencyMetrics(sources = [], researchConfig = DEFAULT_RESEARCH_CONFIG) {
        const total = sources.length;
        const empiricalAcademic = sources.filter(s => s.sourceRole?.empiricalAcademic).length;
        const industryFinancial = sources.filter(s => s.sourceRole?.industryFinancial).length;
        const datasetEvidence = sources.filter(s => s.sourceRole?.datasetOrSurvey).length;
        const counterPosition = sources.filter(s => s.sourceRole?.counterPosition).length;
        const empiricalTotal = sources.filter(s => s.evidenceCategory === 'empirical' || s.sourceType === 'academic' || s.sourceRole?.datasetOrSurvey || s.sourceRole?.empiricalAcademic).length;
        const academicTotal = sources.filter(s => s.sourceType === 'academic').length;
        const industryOrReportTotal = sources.filter(s => s.sourceRole?.industryFinancial || s.sourceRole?.policyGovReport).length;

        return {
            total,
            empiricalAcademic,
            industryFinancial,
            datasetEvidence,
            counterPosition,
            empiricalTotal,
            academicTotal,
            industryOrReportTotal,
            thresholds: {
                total: researchConfig.target_source_count,
                empiricalRequired: researchConfig.empirical_required,
                minimumCounter: researchConfig.minimum_counter_sources,
                minimumIndustryOrReport: researchConfig.minimum_industry_or_report,
                minimumAcademic: researchConfig.minimum_academic
            }
        };
    },

    hasSufficientEvidence(metrics) {
        if (!metrics) return false;
        const t = metrics.thresholds;
        return (
            metrics.total >= t.total &&
            metrics.empiricalTotal >= t.empiricalRequired &&
            metrics.counterPosition >= t.minimumCounter &&
            metrics.industryOrReportTotal >= t.minimumIndustryOrReport &&
            metrics.academicTotal >= t.minimumAcademic
        );
    },

    buildRecoveryQueries(query, metrics) {
        if (!metrics) return [];
        const missing = [];
        const t = metrics.thresholds;

        if (metrics.empiricalTotal < t.empiricalRequired) {
            missing.push(`${query} peer reviewed empirical study`, `${query} longitudinal dataset evidence`);
        }
        if (metrics.industryOrReportTotal < t.minimumIndustryOrReport) {
            missing.push(`${query} industry report earnings capex`, `${query} institutional investor analysis`);
        }
        if (metrics.datasetEvidence < 1) {
            missing.push(`${query} survey data adoption metrics`, `${query} official dataset indicators`);
        }
        if (metrics.counterPosition < t.minimumCounter) {
            missing.push(`${query} critical perspective`, `${query} disconfirming empirical evidence`);
        }

        if (metrics.academicTotal < t.minimumAcademic) {
            missing.push(`${query} arxiv latest preprint`, `${query} conference proceedings peer reviewed`);
        }

        missing.push(`${query} government policy report`, `${query} technical benchmark report`);

        return uniqueList(missing).slice(0, 8);
    },

    getAdaptiveThresholds(level = 0) {
        if (level <= 2) {
            return { relevance: 0.65, domainAlignment: 0.6, includeNearMatch: false, label: 'default' };
        }
        return { relevance: 0.55, domainAlignment: 0.5, includeNearMatch: true, label: 'fallback_near_match' };
    },

    registerValidatedSources(query, sources = []) {
        if (!query || !Array.isArray(sources) || sources.length === 0) return;
        const signature = tokenize(query).slice(0, 12).join(' ');

        for (const source of sources) {
            const key = `${(source.url || '').toLowerCase()}::${(source.title || '').toLowerCase()}`;
            if (!source.title && !source.url) continue;

            const exists = validatedResearchSources.find(item => item.key === key);
            if (exists) {
                exists.lastUsedAt = Date.now();
                exists.source = { ...exists.source, ...source };
                continue;
            }

            validatedResearchSources.push({
                key,
                signature,
                source,
                createdAt: Date.now(),
                lastUsedAt: Date.now()
            });
        }

        if (validatedResearchSources.length > 500) {
            validatedResearchSources.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
            validatedResearchSources.length = 500;
        }
    },

    getReusableValidatedSources(query, limit = 8) {
        const signatureTokens = new Set(tokenize(query));
        if (signatureTokens.size === 0) return [];

        const scored = validatedResearchSources.map(item => {
            const itemTokens = new Set(tokenize(item.signature));
            let overlap = 0;
            signatureTokens.forEach(token => {
                if (itemTokens.has(token)) overlap++;
            });
            const score = overlap / Math.max(1, signatureTokens.size);
            return { ...item, score };
        }).filter(item => item.score >= 0.35);

        return scored
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(item => ({ ...item.source, reusedValidatedSource: true }));
    },

    computeConfidenceMetrics({ sources = [], evidenceUnits = [], sufficiencyMetrics = null, researchConfig = DEFAULT_RESEARCH_CONFIG, retrievalMode = 'default' }) {
        const sourceQualityIndex = sources.length > 0
            ? sources.reduce((acc, s) => acc + (((s.credibilityScore || 50) / 100) * 0.5 + (s.sourceValidation?.overall || 0.5) * 0.5), 0) / sources.length
            : 0;

        const evidenceTypeCounts = {};
        for (const source of sources) {
            const key = source.evidenceCategory || 'speculative';
            evidenceTypeCounts[key] = (evidenceTypeCounts[key] || 0) + 1;
        }
        const distinctEvidenceTypes = Object.keys(evidenceTypeCounts).length;
        const sourceTypeDiversity = new Set(sources.map(s => s.sourceType)).size;
        const evidenceDiversityScore = normalizeScore((distinctEvidenceTypes / 5) * 0.6 + (sourceTypeDiversity / 3) * 0.4);

        const empiricalTotal = sources.filter(s => s.evidenceCategory === 'empirical' || s.sourceType === 'academic' || s.sourceRole?.datasetOrSurvey || s.sourceRole?.empiricalAcademic).length;
        const empiricalRatioScore = sources.length > 0 ? normalizeScore(empiricalTotal / sources.length) : 0;

        const causalSignals = evidenceUnits.filter(unit =>
            unit && unit.mechanism && unit.cause && unit.second_order_effects
        ).length;
        const causalSupportScore = evidenceUnits.length > 0 ? normalizeScore(causalSignals / evidenceUnits.length) : 0.35;

        const counterResolved = evidenceUnits.filter(unit =>
            unit && unit.alternative_explanations && String(unit.alternative_explanations).trim().length > 0 && Array.isArray(unit.contradictingSources)
        ).length;
        const counterEvidenceResolutionScore = evidenceUnits.length > 0
            ? normalizeScore(counterResolved / evidenceUnits.length)
            : 0.35;

        const structuralSignals = evidenceUnits.filter(unit =>
            unit && unit.supporting_data && /(revenue|valuation|capex|ipo|margin|productivity|market share|cash flow|multiple)/i.test(String(unit.supporting_data))
        ).length;
        const structuralCoherenceScore = evidenceUnits.length > 0
            ? normalizeScore(structuralSignals / evidenceUnits.length)
            : 0.35;

        const evidenceCompletenessScore = sufficiencyMetrics
            ? normalizeScore((
                (sufficiencyMetrics.total / Math.max(1, sufficiencyMetrics.thresholds.total)) * 0.35 +
                (sufficiencyMetrics.empiricalTotal / Math.max(1, sufficiencyMetrics.thresholds.empiricalRequired)) * 0.3 +
                (sufficiencyMetrics.counterPosition / Math.max(1, sufficiencyMetrics.thresholds.minimumCounter || 1)) * 0.15 +
                (sufficiencyMetrics.industryOrReportTotal / Math.max(1, sufficiencyMetrics.thresholds.minimumIndustryOrReport || 1)) * 0.1 +
                (sufficiencyMetrics.academicTotal / Math.max(1, sufficiencyMetrics.thresholds.minimumAcademic || 1)) * 0.1
            ))
            : 0.5;

        // confidence = 0.25 source_quality + 0.20 empirical_ratio + 0.20 causal_support + 0.15 counter_evidence + 0.10 structural_coherence + 0.10 evidence_completeness
        const raw = (
            sourceQualityIndex * 0.25 +
            empiricalRatioScore * 0.20 +
            causalSupportScore * 0.2 +
            counterEvidenceResolutionScore * 0.15 +
            structuralCoherenceScore * 0.10 +
            evidenceCompletenessScore * 0.10
        );

        const expectedCount = Math.max(1, researchConfig.target_source_count || 5);
        const sourceCoverageFactor = normalizeScore(sources.length / expectedCount);
        const fallbackPenalty = retrievalMode === 'fallback' ? 0.88 : (retrievalMode === 'adaptive' ? 0.94 : 1);
        const adjusted = raw * sourceCoverageFactor * fallbackPenalty;
        const overallConfidenceScore = Math.round(clamp(adjusted, 0, 1) * 100);

        const explanation = `Confidence is based on source quality, empirical balance, causal support, counter-evidence handling, structural coherence, and evidence completeness. Evidence coverage was ${Math.round(sourceCoverageFactor * 100)}% of the requested source depth, with retrieval mode '${retrievalMode}'.`;

        return {
            sourceQualityIndex: Math.round(sourceQualityIndex * 100),
            evidenceDiversityScore: Math.round(evidenceDiversityScore * 100),
            empiricalRatioScore: Math.round(empiricalRatioScore * 100),
            causalSupportScore: Math.round(causalSupportScore * 100),
            counterEvidenceResolutionScore: Math.round(counterEvidenceResolutionScore * 100),
            structuralCoherenceScore: Math.round(structuralCoherenceScore * 100),
            evidenceCompletenessScore: Math.round(evidenceCompletenessScore * 100),
            sourceCoverageScore: Math.round(sourceCoverageFactor * 100),
            overallConfidenceScore,
            explanation
        };
    }
};

module.exports = researchIntelligenceService;
