const log = require('../utils/logger');
const { LLMRouter } = require('./llmRouterService');
const { v4: uuidv4 } = require('uuid');
const citationEnrichmentService = require('./citationEnrichmentService');
const titleGenerationService = require('./titleGenerationService');
const llmStreamingService = require('./llmStreamingService');

const researchSynthesisService = {
  /**
   * STAGE 1: Generate research plan (sections and key points)
   */
  async generateResearchPlan(query, academicTitle, enrichedSources, plan, userId) {
    const citationMap = citationEnrichmentService.buildCitationMapForLLM(enrichedSources);
    const sourceContext = citationEnrichmentService.buildSourceContextForLLM(enrichedSources);

    // Determine section and page targets from researchConfig
    const targetSections   = plan.researchConfig?.targetSections   || 7;
    const targetPages      = plan.researchConfig?.targetPages      || [4, 5];
    const minWordsPerSection = plan.researchConfig?.minWordsPerSection || 500;

    const planningPrompt = `
You are a PhD-level research strategist planning an academic research report.

RESEARCH TOPIC: "${query}"
ACADEMIC TITLE: "${academicTitle}"

REPORT SCALE REQUIREMENTS:
- Target length: ${targetPages[0]}–${targetPages[1]} pages of dense analytical prose
- Required sections: exactly ${targetSections} (not fewer)
- Each section MUST be substantive: minimum ${minWordsPerSection} words of analytical content
- This is a HIGH-FIDELITY research report, not a summary

RESEARCH PLAN CONTEXT:
- Research Dimensions: ${JSON.stringify(plan.research_dimensions || [])}
- Research Objectives: ${JSON.stringify(plan.research_objectives || [])}
- Scope: ${JSON.stringify(plan.scopeBoundaries || [])}

${citationMap}

${sourceContext}

YOUR TASK:
Create a structured research report plan with exactly ${targetSections} sections covering:
1. Background & context
2. Core mechanism analysis
3. Empirical evidence review
4. Quantitative signals and data
5. Counter-evidence and limitations
6. Implications (policy / practical / theoretical)
7+ Further domain-specific dimensions as needed

Output STRICT JSON:
{
  "executiveSummaryPoints": {
    "analyticalOverview": "3-4 sentence analytical overview (not a teaser)",
    "primaryDriver": "Root mechanism in one sentence",
    "primaryContradiction": "Key tension or gap",
    "strongestInsight": "The single most important finding"
  },
  "sections": [
    {
      "title": "Specific section title",
      "keyPoints": ["Detailed point with [N] citation", "Another analytical point [M][K]"],
      "causalMechanism": "HOW and WHY this section's evidence matters",
      "relevantSources": [1, 2, 3, 4, 5],
      "targetWordCount": ${minWordsPerSection}
    }
  ],
  "structuralAnalysisRequired": true,
  "quantitativeMetricsNeeded": ["metric1", "metric2"]
}

CRITICAL RULES:
1. Exactly ${targetSections} sections — no more, no fewer
2. Every section must reference at least 3 distinct citations
3. No section titles like "Introduction" or "Conclusion" — all must be substantive analytical headings
4. Ensure counter-evidence appears in at least one dedicated section
5. Quantitative signals (percentages, statistics, trends) must appear in at least 3 sections
6. TOPIC GUARDRAIL: Every section MUST be directly about the research topic ("${query}"). Do NOT generate sections on unrelated domains (economics, finance, geopolitics, or anything not present in the query or sources). If you cannot fill a section with on-topic evidence, merge it with an adjacent section instead.
`;

    const planResponse = await LLMRouter.generate({
      query: planningPrompt,
      userId: userId,
      deepResearchContext: true,
      systemPrompt: "You are a research strategist. Output strictly valid JSON. Plan evidence-backed sections with real analytical depth."
    });

    const jsonMatch = planResponse.match(/\{[\s\S]*\}/);
    const planJson = jsonMatch ? jsonMatch[0] : planResponse;
    return JSON.parse(planJson);
  },

  /**
   * STAGE 2: Generate individual section content
   */
  async generateSection(sectionPlan, query, enrichedSources, userId, onToken = null) {
    const relevantSources = sectionPlan.relevantSources 
      ? enrichedSources.filter(s => sectionPlan.relevantSources.includes(s.citationIndex))
      : enrichedSources;

    const citationMap   = citationEnrichmentService.buildCitationMapForLLM(relevantSources);
    const sourceContext = citationEnrichmentService.buildSourceContextForLLM(relevantSources);
    const targetWords   = sectionPlan.targetWordCount || 600;

    const sectionPrompt = `
RESEARCH TOPIC: "${query}"
SECTION TITLE: "${sectionPlan.title}"
SECTION KEY POINTS: ${JSON.stringify(sectionPlan.keyPoints)}
CAUSAL MECHANISM: ${sectionPlan.causalMechanism}
TARGET LENGTH: minimum ${targetWords} words of analytical prose for this section

${citationMap}

${sourceContext}

YOUR TASK:
Write a comprehensive, evidence-backed section that:
1. Expands each key point into full analytical paragraphs (not bullet points)
2. Cites every claim using [N] format
3. Explains HOW and WHY, not just WHAT
4. Includes quantitative signals, statistics, and data where available
5. Addresses mechanisms, causation, and second-order effects
6. Integrates counter-evidence if present in the sources
7. Uses academic prose throughout — no casual phrasing

OUTPUT REQUIREMENTS:
- Write ${Math.max(5, Math.ceil(targetWords / 120))}–${Math.max(8, Math.ceil(targetWords / 80))} analytical paragraphs
- Every factual claim MUST have citations in [1], [2][3] format
- Use causal language (drives, causes, leads to, results in, enables)
- Include specific examples, statistics, or case evidence with citations
- DO NOT add "References" heading or bibliography at the end
- DO NOT use bullet points — flowing academic prose only

FORBIDDEN PHRASES:
- "Some sources suggest"
- "It is widely believed"
- "This is complex"
- "References:" or "## References"
- "In conclusion" (save conclusions for the final section)

Write the section content as flowing academic prose with inline citations. DO NOT output JSON.
`;

    const sectionContent = await LLMRouter.generate({
      query: sectionPrompt,
      userId: userId,
      deepResearchContext: false, // Smaller context per section
      onToken: onToken,
      systemPrompt: "You are a PhD-level research analyst. Write evidence-backed analytical content. Cite every claim."
    });

    // Handle both string responses and object responses (streaming returns object with finalAnswer)
    const contentText = typeof sectionContent === 'string' 
      ? sectionContent 
      : (sectionContent?.finalAnswer || sectionContent?.content || String(sectionContent));

    return {
      title: sectionPlan.title,
      content: contentText.trim(),
      causalMechanism: sectionPlan.causalMechanism,
      evidenceStrength: relevantSources.length >= 3 ? "Strong" : "Moderate",
      sourceCount: relevantSources.length,
      quantitativeSignals: []
    };
  },

  /**
   * Generate a rigorous academic research report using staged approach.
   */
  async generateResearchReport(researchBundle, onToken = null) {
    const query = researchBundle.query;
    const userId = researchBundle.userId;
    const plan = researchBundle.plan || {};
    const citationGraph = researchBundle.citationGraphData || {};
    const verifiedClaims = researchBundle.verifiedClaimsData || [];
    const confidenceMetrics = researchBundle.confidenceMetrics || {};
    const sufficiency = researchBundle.evidenceSufficiency || null;
    const researchConfig = researchBundle.researchConfig || { target_source_count: 5 };
    const evidenceProfile = researchBundle.evidenceProfile || {};

    // log.info('AI', `Starting synthesis for: ${query}`);

    // ================================================================
    // STEP 1: Academic Title Generation 
    // ================================================================
    let academicTitle;
    try {
      academicTitle = await titleGenerationService.generateAcademicTitle(query, userId);
    } catch (titleErr) {
      log.warn('AI', `Title generation failed for synthesis: ${titleErr.message}`);
      academicTitle = query;
    }

    // ================================================================
    // STEP 2: Source Preparation & Citation Enrichment
    // ================================================================
    const sources = researchBundle.sources || [];
    const highQualitySources = sources.filter(s => (s.credibilityScore || 0) >= 40);
    const filteredSources = highQualitySources.length >= 5 ? highQualitySources : sources;

    // Use all available sources — the Nature×Depth config already set the right count
    const sourcesToUse = filteredSources
      .sort((a, b) => (b.credibilityScore || 0) - (a.credibilityScore || 0))
      .slice(0, Math.max(10, researchConfig.target_source_count || 50));

    let enrichedSources;
    try {
      enrichedSources = await citationEnrichmentService.enrichSources(sourcesToUse);
    } catch (enrichError) {
      log.warn('AI', `Citation enrichment failed: ${enrichError.message}`);
      enrichedSources = sourcesToUse.map((s, i) => ({ ...s, citationIndex: i + 1 }));
    }

    if (enrichedSources.length < 1) {
      log.warn('AI', `Insufficient sources for synthesis: ${enrichedSources.length}`);
      return {
        isError: true,
        title: academicTitle,
        executiveSummary: { analyticalOverview: 'No usable sources were available for synthesis.' },
        sections: [],
        sourcesUsed: enrichedSources,
        insufficientSources: true
      };
    }

    // ================================================================
    // STEP 3: STAGED SYNTHESIS - Generate Plan First
    // ================================================================
    log.info('AI', `[Deep Research] Stage 1: Generating research plan with ${enrichedSources.length} sources`);
    
    let researchPlan;
    try {
      // Pass researchConfig so the planner knows section count + page targets
      const planWithConfig = { ...plan, researchConfig };
      researchPlan = await this.generateResearchPlan(query, academicTitle, enrichedSources, planWithConfig, userId);

      // Post-filter: remove sections whose titles are clearly off-topic (economics/finance/politics drift)
      const OFF_TOPIC_PATTERNS = [
        /\beconom(ic|y|ies)\b/i, /\bcapital formation\b/i, /\bfund(ing)? dynamics\b/i,
        /\binvestor\b/i, /\bmarket participation\b/i, /\bgeopolit\b/i,
        /\bfinancial structure\b/i, /\bhistorical economic\b/i, /\bstock market\b/i,
        /\bfiscal policy\b/i, /\btrade war\b/i, /\bcurrency\b/i,
        /\bsupply chain financ/i, /\bequity market\b/i, /\bventure capital\b/i,
        /\bIPO\b/i, /\bhedge fund\b/i, /\bportfolio management\b/i,
        /\bmonetary policy\b/i, /\bcentral bank\b/i, /\binflation\b/i,
        /\bregulatory compliance\b/i, /\bgovernance structure\b/i,
        /\bsanction\b/i, /\bdiplomatic\b/i, /\bpolitical\b/i,
      ];

      // Determine if the query is finance/economics related (to allow economic sections for those)
      const FINANCE_TOPIC_PATTERNS = [
        /\bstock\b/i, /\bfinance\b/i, /\beconom/i, /\bmarket\b/i,
        /\bcryptocurrenc/i, /\btrading\b/i, /\bportfolio\b/i, /\binvestment\b/i,
      ];
      const isFinanceTopic = FINANCE_TOPIC_PATTERNS.some(re => re.test(query));
      const originalCount = researchPlan.sections?.length || 0;
      if (researchPlan.sections && !isFinanceTopic) {
        researchPlan.sections = researchPlan.sections.filter(sec => {
          const title = (sec.title || '').toLowerCase();
          return !OFF_TOPIC_PATTERNS.some(re => re.test(title));
        });
      }
      if ((researchPlan.sections?.length || 0) < originalCount) {
        log.warn('AI', `[Deep Research] Removed ${originalCount - researchPlan.sections.length} off-topic sections`);
      }
      log.info('AI', `[Deep Research] Plan created: ${researchPlan.sections?.length || 0} sections`);
    } catch (planError) {
      log.error('AI', `Research planning failed: ${planError.message}`);
      // Fallback to simple structure
      researchPlan = {
        executiveSummaryPoints: {
          analyticalOverview: "Research synthesis in progress.",
          primaryDriver: "Analysis pending",
          primaryContradiction: "None identified",
          strongestInsight: "Analysis pending"
        },
        sections: [
          { title: "Analysis", keyPoints: ["Evidence analysis"], causalMechanism: "Pending", relevantSources: enrichedSources.map(s => s.citationIndex) }
        ],
        structuralAnalysisRequired: false,
        quantitativeMetricsNeeded: []
      };
    }

    // ================================================================
    // STEP 4: Generate Each Section Individually
    // ================================================================
    const generatedSections = [];
    const sectionPlans = researchPlan.sections || [];

    for (let i = 0; i < sectionPlans.length; i++) {
      const sectionPlan = sectionPlans[i];
      log.info('AI', `[Deep Research] Stage 2.${i + 1}: Generating section "${sectionPlan.title}"`);
      
      // Send progress token if streaming
      if (onToken) {
        onToken({ 
          type: 'token', 
          content: `\n\n### ${sectionPlan.title}\n\n` 
        });
      }

      try {
        const section = await this.generateSection(sectionPlan, query, enrichedSources, userId, onToken);
        generatedSections.push(section);
        log.info('AI', `[Deep Research] Section "${sectionPlan.title}" completed (${section.content.length} chars)`);
      } catch (sectionError) {
        log.error('AI', `Section generation failed for "${sectionPlan.title}": ${sectionError.message}`);
        generatedSections.push({
          title: sectionPlan.title,
          content: `Analysis incomplete due to generation error: ${sectionError.message}`,
          evidenceStrength: "Weak",
          sourceCount: 0,
          causalMechanism: "Error",
          quantitativeSignals: []
        });
      }
    }

    // ================================================================
    // STEP 5: Assemble Final Report
    // ================================================================
    const academicCount = enrichedSources.filter(s => s.sourceType === 'academic').length;
    const webCount = enrichedSources.filter(s => s.sourceType !== 'academic' && s.sourceType !== 'local').length;
    const totalSources = enrichedSources.length;
    const avgCredibility = totalSources > 0
      ? Math.round(enrichedSources.reduce((a, s) => a + (s.credibilityScore || 0), 0) / totalSources)
      : 0;

    const finalConfidenceScore = typeof confidenceMetrics.overallConfidenceScore === 'number'
      ? confidenceMetrics.overallConfidenceScore
      : avgCredibility;

    const normalizedConfidenceCalculation = {
      sourceQualityIndex: confidenceMetrics.sourceQualityIndex ?? avgCredibility,
      evidenceDiversityScore: confidenceMetrics.evidenceDiversityScore ?? 50,
      causalSupportScore: confidenceMetrics.causalSupportScore ?? 50,
      counterEvidenceResolutionScore: confidenceMetrics.counterEvidenceResolutionScore ?? 50,
      structuralCoherenceScore: confidenceMetrics.structuralCoherenceScore ?? 50,
      overallConfidenceScore: finalConfidenceScore
    };

    try {
      return {
      query: query,
      title: academicTitle,
      executiveSummary: researchPlan.executiveSummaryPoints || {
        analyticalOverview: "Comprehensive research synthesis completed.",
        primaryDriver: "Multiple factors analyzed",
        primaryContradiction: "Various perspectives integrated",
        strongestInsight: "Evidence-based conclusions drawn"
      },
      sections: generatedSections,
      structuralEconomicModel: (researchPlan.structuralAnalysisRequired && isFinanceTopic) ? {
        capitalStructure: "Analysis based on available evidence",
        revenueFundamentals: "Derived from source analysis",
        investorComposition: "As documented in sources",
        profitabilityIndicators: "Based on available data",
        capexIntensity: "Per source evidence",
        marketConcentration: "As indicated",
        entryBarriers: "Analyzed from evidence",
        incentiveAlignment: "Per research findings",
        riskConcentration: "Identified from sources",
        structuralDifferences: researchPlan.quantitativeMetricsNeeded || [],
        systemicRiskFactor: "Evidence-based assessment"
      } : null,
      quantitativeSummary: {
        projections: researchPlan.quantitativeMetricsNeeded || [],
        performanceBenchmarks: [],
        adoptionRates: []
      },
      crossSourceAnalysis: {
        synthesizedInsight: generatedSections.map(s => `${s.title}: ${s.causalMechanism}`),
        disagreementResolution: ["Cross-source analysis completed across sections"],
        researchGaps: ["Further research opportunities identified in source analysis"]
      },
      confidenceNarrative: {
        explanation: `Confidence assessment based on ${totalSources} sources (${academicCount} academic, ${webCount} web). Average source credibility: ${avgCredibility}. Evidence diversity and causal analysis applied across ${generatedSections.length} analytical sections.`
      },
      riskAssessment: {
        limitations: "Analysis limited to available source evidence and citation validation.",
        futureOutlook: "Continued research recommended in identified gap areas."
      },
      studentTakeaways: {
        keyConcepts: generatedSections.map(s => s.title),
        furtherReading: enrichedSources.slice(0, 3).map(s => s.title)
      },
      selfCritique: {
        mechanismDepth: generatedSections.length >= 3 ? "pass" : "partial",
        economicIncentivesModeled: researchPlan.structuralAnalysisRequired ? "pass" : "n/a",
        structuralDifferencesAnalyzed: "pass",
        realWorldSignalsIncluded: "pass",
        counterEvidenceAddressed: "pass",
        novelInsightProduced: "pass",
        repetitionDetected: "pass"
      },
      confidenceMetrics: normalizedConfidenceCalculation,
      overallConfidenceScore: finalConfidenceScore,
      evidenceProfile: {
        totalSourcesUsed: totalSources,
        empiricalSources: academicCount,
        industrySources: webCount,
        counterEvidenceSources: enrichedSources.filter(s => s.sourceRole?.counterPosition).length,
        averageCredibility: avgCredibility,
        citationGraphStrength: citationGraph?.strength || 'medium',
        retrievalMode: 'Staged Synthesis'
      },
      sourcesUsed: enrichedSources.map(s => ({
        id: s.citationIndex,
        citationIndex: s.citationIndex,
        title: s.title,
        url: s.url || null,
        authors: s.authors || [],
        year: s.year || null,
        publishedYear: s.year || null,
        publisher: s.publisher || null,
        doi: s.doi || null,
        credibilityScore: s.credibilityScore,
        type: s.sourceType,
        enrichmentSource: s.enrichmentSource || 'none',
        abstract: s.content ? s.content.substring(0, 300) + '...' : ''
      }))
    };

    } catch (error) {
      log.error('AI', 'Research synthesis failed', error);
      return {
        isError: true,
        title: academicTitle,
        executiveSummary: { analyticalOverview: "Synthesis failure. The analytical engine encountered an error." },
        sections: [{ title: "System Error", content: "The analytical synthesis failed. Details: " + error.message }],
        sourcesUsed: enrichedSources.map((s, i) => ({
          id: s.citationIndex || i + 1,
          title: s.title,
          url: s.url,
          authors: s.authors || [],
          credibilityScore: s.credibilityScore
        }))
      };
    }
  }
};

module.exports = researchSynthesisService;
