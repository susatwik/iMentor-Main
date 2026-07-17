const log = require('../utils/logger');
/**
 * Deep Research Orchestrator  (v2)
 *
 * Key changes vs v1:
 *  - Users pick Nature (general / academic / research) + Depth (low / medium / high)
 *    instead of specifying source counts.
 *  - Source targets come from the 3×3 Nature×Depth matrix (30–70 sources).
 *  - LLM generates source-type-specific queries; cosine dedup removes redundant ones.
 *  - OpenAlex, Semantic Scholar, ArXiv fetched independently against their quotas.
 *  - Web sources are tagged: older than 3 months → goldStandard=true.
 *  - Supports a "fire-and-forget" execution path via runResearchJob().
 */

const ResearchCache = require('../models/ResearchCache');
const localKnowledgeBase = require('./localKnowledgeBase');
const webCrawlerService = require('./webCrawlerService');
const sourceCredibilityService = require('./sourceCredibilityService');
const researchPlanService = require('./researchPlanService');
const researchSynthesisService = require('./researchSynthesisService');
const citationEnrichmentService = require('./citationEnrichmentService');
const academicSourceService = require('./academicSourceService');
const citationGraphService = require('./citationGraphService');
const factCheckingService = require('./factCheckingService');
const researchIntelligenceService = require('./researchIntelligenceService');
const researchQueryGenerator = require('./researchQueryGenerator');
const { extractQueryConstraints } = researchQueryGenerator;
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createPerformanceTracker, logPerformance } = require('./performanceDiagnosticsService');

const RAG_SERVICE_URL = process.env.RAG_SERVICE_URL || 'http://rag:8000';

// ─────────────────────────────────────────────────────────────────────────────
// CrewAI path (feature-flag gated)
// ─────────────────────────────────────────────────────────────────────────────
async function runCrewAiResearch(query, options = {}, onProgress = null) {
    log.info('SYSTEM', `Starting CrewAI deep research for: "${query}"`);
    if (onProgress) onProgress({ phase: 'init', message: 'Initializing CrewAI Research Agents...' });

    try {
        if (onProgress) onProgress({ phase: 'planning', message: 'Agents are planning the research strategy...' });

        const response = await axios.post(`${RAG_SERVICE_URL}/crewai-research`, {
            topic: query,
        }, {
            timeout: 900000,
            headers: { 'Content-Type': 'application/json' }
        });

        if (onProgress) onProgress({ phase: 'synthesizing', message: 'Agents are synthesizing the final report...' });

        const finalReport = response.data.result;
        if (!finalReport || typeof finalReport !== 'string' || finalReport.trim() === '') {
            throw new Error('CrewAI returned an empty or invalid report.');
        }

        const researchResult = {
            query, userId: options.userId,
            normalizedQuery: query.toLowerCase().trim(),
            sources: [], overallConfidenceScore: 95,
            createdAt: new Date(),
            researchReport: { fullReport: finalReport, summary: finalReport.slice(0, 500) }
        };

        if (onProgress) onProgress({ phase: 'completed', message: 'Research Complete.',
            fullReport: researchResult.researchReport,
            metaData: { retrievalMode: 'CrewAI', totalSources: 0, confidenceScore: 95 },
            sourceData: [], graphData: null });

        log.success('AI', `CrewAI research complete for: "${query}"`);
        return { researchBundle: researchResult, researchReport: researchResult.researchReport, performanceDiagnostics: {} };

    } catch (error) {
        log.error('AI', `CrewAI research failed: ${error.message}`);
        if (onProgress) onProgress({ phase: 'error', message: `CrewAI research failed: ${error.message}` });
        throw error;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-provider fetching with quota enforcement
// ─────────────────────────────────────────────────────────────────────────────

async function fetchOpenAlexQuota(queries, quota, constraints = {}) {
    if (!queries.length || quota <= 0) return [];
    const perQuery = Math.ceil(quota / queries.length) + 2;
    return academicSourceService.fetchOpenAlexBatch(queries, perQuery, constraints);
}

async function fetchSemanticQuota(queries, quota, constraints = {}) {
    if (!queries.length || quota <= 0) return [];
    const perQuery = Math.ceil(quota / queries.length) + 2;
    return academicSourceService.fetchSemanticBatch(queries, perQuery, constraints);
}

async function fetchArxivQuota(queries, quota, constraints = {}) {
    if (!queries.length || quota <= 0) return [];
    const perQuery = Math.ceil(quota / queries.length) + 2;
    return academicSourceService.fetchArxivBatch(queries, perQuery, constraints);
}

async function fetchWebQuota(queries, quota) {
    if (!queries.length || quota <= 0) return [];
    const perQuery = Math.max(2, Math.ceil(quota / queries.length));
    const results = [];
    const seen = new Set();
    for (const q of queries) {
        try {
            const webSources = await webCrawlerService.searchAndCrawl(q, perQuery);
            for (const s of (webSources || [])) {
                const key = (s.url || s.title || '').toLowerCase();
                if (key && !seen.has(key)) { seen.add(key); results.push(s); }
                if (results.length >= quota * 1.5) break;
            }
        } catch (_) { /* skip failed web query */ }
    }
    // Tag recency and goldStandard
    return academicSourceService.tagWebSources(results);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

const deepResearchOrchestrator = {

    /**
     * Run a comprehensive deep research query.
     * Supports synchronous (SSE streaming) and fire-and-forget (job-based) modes.
     *
     * @param {string} query
     * @param {object} options  – { forceRefresh, userId, nature, depth, researchConfig, jobDoc }
     * @param {function|null} onProgress  – called with { phase, message, ... } events
     */
    async runDeepResearch(query, options = {}, onProgress = null) {
        // ── Route to CrewAI if flag set ───────────────────────────────────────
        if (process.env.USE_CREWAI_RESEARCH === 'true') {
            return runCrewAiResearch(query, options, onProgress);
        }

        const startTime      = Date.now();
        const perf           = createPerformanceTracker({ mode: 'deepResearch', queryPreview: String(query || '').slice(0, 80) });
        const normalizedQuery = query.toLowerCase().trim();
        const jobDoc          = options.jobDoc || null; // ResearchJob doc for progress persistence

        // Build research config from Nature × Depth
        const researchConfig = researchIntelligenceService.resolveResearchConfig(query, {
            nature: options.nature || options.researchConfig?.nature || 'academic',
            depth:  options.depth  || options.researchConfig?.depth  || 'medium',
            ...(options.researchConfig || {}),
        });

        const progress = async (phase, message, extra = {}) => {
            if (onProgress) onProgress({ phase, message, ...extra });
            if (jobDoc) await jobDoc.addProgress(phase, message).catch(() => {});
        };

        log.info('SYSTEM', `Deep research [${researchConfig.nature}/${researchConfig.depth}] "${query}" — target: ${researchConfig.target_source_count} sources`);
        await progress('init', `Research engine initialised (${researchConfig.nature} / ${researchConfig.depth})`);

        // ── 0. Generate research plan ─────────────────────────────────────────
        await progress('planning', 'Generating research plan...');
        let researchPlan = {};
        try {
            const planStart = Date.now();
            researchPlan = await researchPlanService.generatePlan(query, options.userId);
            perf.addLlm(Date.now() - planStart);
            researchPlan = { ...researchPlan, ...researchIntelligenceService.buildQueryBlueprint(query, researchPlan) };
            await progress('plan_ready', 'Research plan ready', { plan: researchPlan });
        } catch (planError) {
            researchPlan = researchIntelligenceService.buildQueryBlueprint(query, {});
            await progress('plan_ready', 'Using fallback research plan', { plan: researchPlan });
        }

        // ── 1. Cache check ────────────────────────────────────────────────────
        if (!options.forceRefresh) {
            const dbReadStart = Date.now();
            const cachedResult = await ResearchCache.findOne({ normalizedQuery }).sort({ createdAt: -1 }).lean();
            perf.addDb(Date.now() - dbReadStart);
            if (cachedResult?.sources?.length >= Math.min(researchConfig.target_source_count, 10)) {
                log.info('SYSTEM', `Research cache hit: "${query}"`);
                if (onProgress) onProgress({ phase: 'completed', message: 'Retrieved from Cache',
                    fullReport: cachedResult.researchReport,
                    metaData: { retrievalMode: cachedResult.mode || 'HYBRID', totalSources: cachedResult.sources?.length || 0, confidenceScore: cachedResult.overallConfidenceScore || 0 },
                    sourceData: cachedResult.sources, graphData: cachedResult.citationGraphData });

                if (cachedResult.researchReport && Object.keys(cachedResult.researchReport).length > 0) {
                    const diagnostics = perf.toLogPayload({ branchCount: 1, toolCalls: 0, tokenUsageEstimate: Math.ceil(String(cachedResult.researchReport?.fullReport || '').length / 4) });
                    logPerformance(diagnostics);
                    return { researchBundle: cachedResult, researchReport: cachedResult.researchReport, performanceDiagnostics: diagnostics };
                }
            }
        }

        // ── 2. Generate source-type-specific queries via LLM ─────────────────
        await progress('generating_queries', 'Generating specialised search queries...');
        let querySets = { openalex: [], semantic: [], arxiv: [], web: [], constraints: {} };
        try {
            querySets = await researchQueryGenerator.generateQuerySets(query, researchConfig, options.userId);
            const c = querySets.constraints || {};
            const constraintSummary = [
                c.yearStart ? `years:${c.yearStart}-${c.yearEnd || c.yearStart}` : null,
                c.venueFilter ? `venue:${c.venueFilter}` : null,
            ].filter(Boolean).join(', ') || 'none';
            log.info('RESEARCH', `Query sets — OA:${querySets.openalex.length} SS:${querySets.semantic.length} Ax:${querySets.arxiv.length} Web:${querySets.web.length} | Constraints: ${constraintSummary}`);
            if (constraintSummary !== 'none') {
                await progress('generating_queries', `Constraints detected — ${constraintSummary}`);
            }
        } catch (qErr) {
            log.warn('RESEARCH', `Query generation failed, using plan queries: ${qErr.message}`);
            const planQueries = researchPlan.expanded_search_queries || [query];
            querySets.openalex    = planQueries.slice(0, 8);
            querySets.semantic    = planQueries.slice(0, 6);
            querySets.arxiv       = planQueries.slice(0, 4);
            querySets.web         = planQueries.slice(0, 3);
            querySets.constraints = researchQueryGenerator.extractQueryConstraints(query);
        }
        const activeConstraints = {
            ...querySets.constraints || {},
            // ── Deep research always uses trusted publishers only ─────────────
            // OpenAlex: restricted to IEEE, Elsevier, Springer, Nature
            // arXiv:    only papers with ≥18 citations (or published < 12 months)
            trustedPublishersOnly: true,
        };

        // ── 3. Local knowledge ───────────────────────────────────────────────
        await progress('searching_local', 'Checking internal knowledge graph...');
        const localStart   = Date.now();
        const localSources = await localKnowledgeBase.getLocalSources(query, { limit: 10 });
        perf.addTool(Date.now() - localStart);
        const reusableSources = researchIntelligenceService.getReusableValidatedSources(query, researchConfig.target_source_count);

        // ── 4. Parallel academic + web fetch with per-provider quotas ─────────
        await progress('searching_online', `Fetching from OpenAlex (${researchConfig.openAlexTarget}), Semantic Scholar (${researchConfig.semanticTarget}), ArXiv (${researchConfig.arxivTarget}), Web (${researchConfig.webTarget})...`);

        const onlineStart = Date.now();
        const [openAlexResult, semanticResult, arxivResult, webResult] = await Promise.allSettled([
            fetchOpenAlexQuota(querySets.openalex, researchConfig.openAlexTarget, activeConstraints),
            fetchSemanticQuota(querySets.semantic,  researchConfig.semanticTarget, activeConstraints),
            fetchArxivQuota(querySets.arxiv,        researchConfig.arxivTarget,    activeConstraints),
            fetchWebQuota(querySets.web,             researchConfig.webTarget),
        ]);
        perf.addTool(Date.now() - onlineStart);

        let openAlexSources  = openAlexResult.status  === 'fulfilled' ? openAlexResult.value  : [];
        let semanticSources  = semanticResult.status  === 'fulfilled' ? semanticResult.value  : [];
        let arxivSources     = arxivResult.status     === 'fulfilled' ? arxivResult.value     : [];
        const rawWebSources    = webResult.status        === 'fulfilled' ? webResult.value       : [];

        // ── 4b. Constraint-only fallback: if venue filter produced nothing, retry year-only ──
        const totalConstrained = openAlexSources.length + semanticSources.length + arxivSources.length;
        if (totalConstrained === 0 && activeConstraints.venueFilter) {
            log.warn('RESEARCH', `Zero results with venue=${activeConstraints.venueFilter} filter — retrying year-only`);
            await progress('searching_online', `No results for venue:${activeConstraints.venueFilter} — expanding to year-only filter...`);
            const yearOnlyConstraints = { yearStart: activeConstraints.yearStart, yearEnd: activeConstraints.yearEnd, trustedPublishersOnly: true };
            const [oaR2, ssR2, axR2] = await Promise.allSettled([
                fetchOpenAlexQuota(querySets.openalex, researchConfig.openAlexTarget, yearOnlyConstraints),
                fetchSemanticQuota(querySets.semantic,  researchConfig.semanticTarget, yearOnlyConstraints),
                fetchArxivQuota(querySets.arxiv,        researchConfig.arxivTarget,    yearOnlyConstraints),
            ]);
            openAlexSources = oaR2.status === 'fulfilled' ? oaR2.value : [];
            semanticSources = ssR2.status === 'fulfilled' ? ssR2.value : [];
            arxivSources    = axR2.status === 'fulfilled' ? axR2.value : [];
            log.info('RESEARCH', `Year-only retry — OA:${openAlexSources.length} SS:${semanticSources.length} Ax:${arxivSources.length}`);
        }

        // Separate recent vs gold-standard web
        const recentWebSources     = rawWebSources.filter(s => !s.goldStandard);
        const goldStandardWebSources = rawWebSources.filter(s => s.goldStandard);

        log.info('RESEARCH', `Fetched — OA:${openAlexSources.length} SS:${semanticSources.length} Ax:${arxivSources.length} Web:${recentWebSources.length} Gold:${goldStandardWebSources.length}`);

        // ── 5. Merge & deduplicate ────────────────────────────────────────────
        await progress('analyzing', 'Merging and deduplicating sources...');
        let allSources = researchIntelligenceService.dedupeSources([
            ...reusableSources,
            ...localSources,
            ...openAlexSources,
            ...semanticSources,
            ...arxivSources,
            ...recentWebSources,
            ...goldStandardWebSources,
        ]);

        if (allSources.length === 0) {
            const msg = 'Research aborted: no sources retrieved from any provider.';
            log.warn('AI', msg);
            await progress('error', msg);
            throw new Error(msg);
        }

        // ── 6. Credibility scoring ────────────────────────────────────────────
        await progress('evaluating', 'Evaluating source credibility...', { sourceData: allSources });
        allSources.forEach((source, index) => {
            try {
                source.citationIndex = index + 1;
                const assessment = sourceCredibilityService.evaluateSourceCredibility(source, allSources);
                source.credibilityScore  = assessment.credibilityScore;
                source.credibilityReason = assessment.reason;
            } catch (_) {
                source.credibilityScore = 50;
            }
        });

        // ── 7. Corpus evaluation + adaptive fallback ladder ───────────────────
        let retrievalMode = 'default';
        let fallbackStage = 0;
        let thresholds = researchIntelligenceService.getAdaptiveThresholds(0);

        let evaluatedSources = researchIntelligenceService.evaluateCorpus(allSources, {
            query, dimensions: researchPlan.research_dimensions || [], thresholds
        });
        let validSources    = evaluatedSources.filter(s => s.sourceValidation?.passesThreshold);
        let selectedSources = researchIntelligenceService.selectTopSourcesWithBalance(validSources, researchConfig);
        let sufficiency     = researchIntelligenceService.computeSufficiencyMetrics(selectedSources, researchConfig);

        log.info('RESEARCH', `Initial evidence: total=${sufficiency.total}/${researchConfig.target_source_count} academic=${sufficiency.academicTotal} empirical=${sufficiency.empiricalTotal}`);

        // Fallback ladder
        const counterQueries       = (researchPlan.counter_evidence_queries || []).slice(0, 6);

        // Build domain-appropriate expansion queries (strip generic non-academic suffixes for academic searches)
        const isAcademic = researchConfig.nature === 'academic' || researchConfig.nature === 'research';
        const domainExpansionQueries = isAcademic
            ? [
                `${query} deep learning`,
                `${query} neural network`,
                `${query} machine learning estimation`,
                `${query} LSTM transformer battery`,
              ]
            : [
                `${query} arxiv`,
                `${query} government policy report`,
                `${query} industry whitepaper`,
                `${query} technical benchmark report`,
              ];

        // L1/L2: keep year filter + trusted publisher gate; L3: drop ALL — broadest possible
        const fallbackConstraintsL1 = {
            trustedPublishersOnly: true,  // keep quality gate even in fallback
            ...(activeConstraints.yearStart
                ? { yearStart: activeConstraints.yearStart, yearEnd: activeConstraints.yearEnd }
                : {}),
        };
        const fallbackConstraintsL3 = {}; // no year, no venue, no publisher gate — last resort

        while (researchConfig.allow_adaptive_fallback && !researchIntelligenceService.hasSufficientEvidence(sufficiency) && fallbackStage < 4) {
            fallbackStage++;
            if (fallbackStage === 1) {
                retrievalMode = 'adaptive';
                const recoveryQueries = researchIntelligenceService.buildRecoveryQueries(query, sufficiency);
                const secondPass = [...counterQueries, ...recoveryQueries].slice(0, 8);
                if (secondPass.length > 0) {
                    await progress('searching_online', 'Adaptive retrieval L1: expanding semantic queries...');
                    const [r1, r2] = await Promise.allSettled([
                        academicSourceService.fetchOpenAlexBatch(secondPass, 4, fallbackConstraintsL1),
                        academicSourceService.fetchSemanticBatch(secondPass, 3, fallbackConstraintsL1),
                    ]);
                    const extra = [...(r1.status==='fulfilled'?r1.value:[]), ...(r2.status==='fulfilled'?r2.value:[])];
                    allSources = researchIntelligenceService.dedupeSources([...allSources, ...extra]);
                }
            }
            if (fallbackStage === 2) {
                retrievalMode = 'adaptive';
                await progress('searching_online', 'Adaptive retrieval L2: domain expansion (ArXiv / industry / policy)...');
                const [domOA, domAx] = await Promise.allSettled([
                    academicSourceService.fetchOpenAlexBatch(domainExpansionQueries, 5, fallbackConstraintsL1),
                    academicSourceService.fetchArxivBatch(domainExpansionQueries, 4, fallbackConstraintsL1),
                ]);
                const domSources = [...(domOA.status==='fulfilled'?domOA.value:[]), ...(domAx.status==='fulfilled'?domAx.value:[])];
                allSources = researchIntelligenceService.dedupeSources([...allSources, ...domSources]);
            }
            if (fallbackStage === 3) {
                retrievalMode = 'fallback';
                thresholds = researchIntelligenceService.getAdaptiveThresholds(3);
                // Drop ALL constraints so we fetch broadly and lower thresholds simultaneously
                await progress('searching_online', 'Adaptive retrieval L3: dropping year/venue constraints, lowering thresholds...');
                const [r3oa, r3ss, r3ax] = await Promise.allSettled([
                    academicSourceService.fetchOpenAlexBatch(querySets.openalex.slice(0, 6), 6, fallbackConstraintsL3),
                    academicSourceService.fetchSemanticBatch(querySets.semantic.slice(0, 5), 5, fallbackConstraintsL3),
                    academicSourceService.fetchArxivBatch(querySets.arxiv.slice(0, 4), 5, fallbackConstraintsL3),
                ]);
                const l3Sources = [
                    ...(r3oa.status==='fulfilled'?r3oa.value:[]),
                    ...(r3ss.status==='fulfilled'?r3ss.value:[]),
                    ...(r3ax.status==='fulfilled'?r3ax.value:[]),
                ];
                log.info('RESEARCH', `L3 unconstrained fetch: ${l3Sources.length} additional sources`);
                allSources = researchIntelligenceService.dedupeSources([...allSources, ...l3Sources]);
            }
            if (fallbackStage >= 4) {
                retrievalMode = 'fallback';
                await progress('searching_online', 'Adaptive retrieval L4: proceeding with best available evidence.');
                break;
            }

            allSources.forEach((source, index) => {
                if (source.credibilityScore != null) return;
                source.citationIndex = index + 1;
                const assessment = sourceCredibilityService.evaluateSourceCredibility(source, allSources);
                source.credibilityScore  = assessment.credibilityScore;
                source.credibilityReason = assessment.reason;
            });
            evaluatedSources = researchIntelligenceService.evaluateCorpus(allSources, {
                query, dimensions: researchPlan.research_dimensions || [], thresholds
            });
            validSources    = evaluatedSources.filter(s => s.sourceValidation?.passesThreshold);
            selectedSources = researchIntelligenceService.selectTopSourcesWithBalance(validSources, researchConfig);
            if (thresholds.label === 'fallback_near_match') {
                selectedSources = selectedSources.map(s => ({ ...s, lowerConfidenceEvidence: true }));
            }
            sufficiency = researchIntelligenceService.computeSufficiencyMetrics(selectedSources, researchConfig);
            log.info('RESEARCH', `Evidence L${fallbackStage}: total=${sufficiency.total} academic=${sufficiency.academicTotal}`);
        }

        // Controlled proceed guards
        if (selectedSources.length === 0 && validSources.length > 0) {
            selectedSources = validSources.slice(0, researchConfig.target_source_count);
            retrievalMode = 'fallback';
            sufficiency = researchIntelligenceService.computeSufficiencyMetrics(selectedSources, researchConfig);
        }
        if (selectedSources.length === 0 && allSources.length > 0) {
            const broadEval = researchIntelligenceService.evaluateCorpus(allSources, {
                query, dimensions: researchPlan.research_dimensions || [],
                thresholds: { relevance: 0.45, domainAlignment: 0.4, includeNearMatch: true }
            });
            selectedSources = broadEval
                .sort((a, b) => (b.source_score || 0) - (a.source_score || 0))
                .slice(0, researchConfig.target_source_count)
                .map(s => ({ ...s, lowerConfidenceEvidence: true }));
            retrievalMode = 'fallback';
            sufficiency = researchIntelligenceService.computeSufficiencyMetrics(selectedSources, researchConfig);
        }
        if (selectedSources.length === 0) {
            const msg = 'Research aborted: zero usable sources after adaptive fallback.';
            log.warn('AI', msg);
            await progress('error', msg);
            throw new Error(msg);
        }

        // ── 8. Citation Enrichment ────────────────────────────────────────────
        await progress('enriching', 'Enriching citation metadata...', { sourceData: selectedSources });
        try {
            const enrichStart   = Date.now();
            const enriched      = await citationEnrichmentService.enrichSources(selectedSources);
            perf.addTool(Date.now() - enrichStart);
            selectedSources.length = 0;
            selectedSources.push(...enriched);
            const completeness  = citationEnrichmentService.calculateMetadataCompleteness(selectedSources);
            if (completeness < 70) {
                const retry = await citationEnrichmentService.enrichSources(selectedSources);
                selectedSources.length = 0;
                selectedSources.push(...retry);
            }
        } catch (enrichErr) {
            log.warn('AI', `Citation enrichment partial: ${enrichErr.message}`);
        }

        selectedSources.sort((a, b) => (b.source_score || ((b.credibilityScore||0)/100)) - (a.source_score || ((a.credibilityScore||0)/100)));

        const topSources = selectedSources.slice(0, researchConfig.target_source_count);

        // ── 9. Citation graph + fact-check ────────────────────────────────────
        await progress('graphing', 'Constructing citation graph...', { sourceData: topSources });
        const graphData = citationGraphService.buildGraph(topSources);

        await progress('verifying', 'Extracting mechanisms and counter-evidence...', { sourceData: topSources });
        const verifyStart       = Date.now();
        const verificationData  = await factCheckingService.verifyCorpusClaims(topSources, query, options.userId);
        perf.addLlm(Date.now() - verifyStart);

        const confidenceMetrics = researchIntelligenceService.computeConfidenceMetrics({
            sources: topSources, evidenceUnits: verificationData,
            sufficiencyMetrics: sufficiency, researchConfig, retrievalMode
        });

        // ── 10. Build provider breakdown for evidence profile ─────────────────
        const providerBreakdown = {
            openAlex:       topSources.filter(s => s.sourceProvider === 'openalex').length,
            semanticScholar: topSources.filter(s => s.sourceProvider === 'semantic_scholar').length,
            arxiv:          topSources.filter(s => s.sourceProvider === 'arxiv').length,
            web:            topSources.filter(s => s.sourceType !== 'academic' && s.sourceType !== 'local' && !s.goldStandard).length,
            goldStandard:   topSources.filter(s => s.goldStandard).length,
            local:          topSources.filter(s => s.sourceType === 'local').length,
        };

        const academicSources  = topSources.filter(s => s.sourceType === 'academic');
        const webSourcesFinal  = topSources.filter(s => s.sourceType !== 'academic' && s.sourceType !== 'local');
        const empiricalSources = topSources.filter(s => s.evidenceCategory === 'empirical' || s.sourceType === 'academic' || s.sourceRole?.datasetOrSurvey || s.sourceRole?.empiricalAcademic);
        const industrySources  = topSources.filter(s => s.sourceRole?.industryFinancial || s.sourceRole?.policyGovReport);
        const counterSources   = topSources.filter(s => s.sourceRole?.counterPosition);

        const evidenceProfile = {
            totalSourcesUsed:       topSources.length,
            empiricalSources:       empiricalSources.length,
            industrySources:        industrySources.length,
            counterEvidenceSources: counterSources.length,
            retrievalMode:          retrievalMode === 'default' ? 'Default' : (retrievalMode === 'adaptive' ? 'Adaptive' : 'Fallback'),
            providerBreakdown,
            goldStandardCount:      providerBreakdown.goldStandard,
            nature:                 researchConfig.nature,
            depth:                  researchConfig.depth,
            appliedConstraints:     activeConstraints,
        };

        const researchResult = {
            query, userId: options.userId, normalizedQuery,
            mode: evidenceProfile.retrievalMode,
            sources: topSources,
            localSourceCount:  topSources.filter(s => s.sourceType === 'local').length,
            onlineSourceCount: academicSources.length + webSourcesFinal.length,
            overallConfidenceScore: confidenceMetrics.overallConfidenceScore,
            createdAt: new Date(),
            plan: researchPlan,
            citationGraphData:    graphData,
            verifiedClaimsData:   verificationData,
            evidenceSufficiency:  sufficiency,
            confidenceMetrics,
            researchConfig,
            evidenceProfile,
            providerBreakdown,
        };

        researchIntelligenceService.registerValidatedSources(query, topSources);

        // ── 11. Synthesis ─────────────────────────────────────────────────────
        await progress('synthesizing', `Drafting ${researchConfig.targetPages?.[0]}–${researchConfig.targetPages?.[1]} page report (${researchConfig.targetSections} sections)...`);
        const synthesisStart = Date.now();
        const finalReport = await researchSynthesisService.generateResearchReport(
            { ...researchResult, plan: researchPlan },
            (token) => { if (onProgress) onProgress({ phase: 'token', content: token }); }
        );
        perf.addLlm(Date.now() - synthesisStart);

        // ── 12. Save ──────────────────────────────────────────────────────────
        let savedDoc = null;
        try {
            const dbWriteStart = Date.now();
            const cachePayload = { ...researchResult, researchReport: finalReport, title: query };
            savedDoc = await ResearchCache.create(cachePayload);
            perf.addDb(Date.now() - dbWriteStart);
            log.success('SYSTEM', `Research saved (${topSources.length} sources): "${query}"`);
        } catch (cacheError) {
            log.error('SYSTEM', `Failed to save research: ${cacheError.message}`);
        }

        const finalResponse = { researchBundle: researchResult, researchReport: finalReport, savedDocId: savedDoc?._id };

        await progress('completed', 'Research complete.', {
            fullReport: finalReport,
            metaData: {
                retrievalMode: researchResult.mode,
                totalSources:  researchResult.sources?.length || 0,
                academicSources: academicSources.length,
                webSources:      webSourcesFinal.length,
                confidenceScore: researchResult.overallConfidenceScore,
                confidenceExplanation: confidenceMetrics.explanation,
                evidenceProfile,
                providerBreakdown,
                nature: researchConfig.nature,
                depth:  researchConfig.depth,
            },
            sourceData: researchResult.sources,
            graphData:  researchResult.citationGraphData,
        });

        const duration = Date.now() - startTime;
        const diagnostics = perf.toLogPayload({
            branchCount: 1,
            toolCalls:   (querySets.openalex.length + querySets.semantic.length + querySets.arxiv.length + querySets.web.length),
            tokenUsageEstimate: Math.ceil(String(finalReport?.fullReport || finalReport?.summary || '').length / 4),
        });
        logPerformance(diagnostics);
        log.success('AI', `Research complete: ${topSources.length} sources, ${duration}ms [${researchConfig.nature}/${researchConfig.depth}]`);

        return { ...finalResponse, performanceDiagnostics: diagnostics };
    }
};

module.exports = deepResearchOrchestrator;
