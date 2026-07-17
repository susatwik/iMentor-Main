const { LLMRouter } = require('./llmRouterService');
const researchIntelligenceService = require('./researchIntelligenceService');

const researchPlanService = {
    /**
     * Generates a structured research plan before execution.
     * @param {string} query 
     * @param {string} userId
     * @returns {Promise<Object>}
     */
    async generatePlan(query, userId) {
        console.log(`[ResearchPlanOrder] Generating plan for: "${query}"`);

        const prompt = `
You are a research strategist designing a research-grade analytical intelligence plan.
Topic: "${query}".

MANDATORY REQUIREMENTS:
1. Decompose the question into 6-10 analytical dimensions.
2. Each dimension must map to an explicit research objective.
3. Generate at least 8 high-precision expanded search queries.
4. Include at least 4 counter-evidence search queries.
5. Avoid generic wording and avoid placeholders.

OUTPUT FORMAT (JSON ONLY, NO MARKDOWN):
{
    "research_dimensions": ["... minimum 6, maximum 10 ..."],
    "research_objectives": [
        {
            "dimension": "...",
            "objective": "...",
            "requiredEvidence": "..."
        }
    ],
    "expanded_search_queries": ["... minimum 8 ..."],
    "counter_evidence_queries": ["... minimum 4 ..."],
    "scopeBoundaries": ["In scope", "Out of scope"],
    "intendedAudience": "Graduate Research Analysts",
    "methodology": "Mechanism extraction, causal analysis, structural modeling, counter-evidence resolution."
}
`;

        try {
            const response = await LLMRouter.generate({
                query: prompt,
                userId: userId,
                deepResearchContext: true,
                systemPrompt: "You are a research planning system. Output valid JSON only."
            });

            let jsonString = response;
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                jsonString = jsonMatch[0];
            }

            // Clean control characters that might break JSON.parse
            jsonString = jsonString.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, "");

            const parsed = JSON.parse(jsonString);
            const blueprint = researchIntelligenceService.buildQueryBlueprint(query, parsed);

            return {
                ...parsed,
                ...blueprint,
                scopeBoundaries: Array.isArray(parsed.scopeBoundaries) ? parsed.scopeBoundaries : ['In-scope: mechanisms, incentives, structural evidence', 'Out-of-scope: unsupported speculation'],
                intendedAudience: parsed.intendedAudience || 'Graduate Research Analysts',
                methodology: parsed.methodology || 'Mechanism extraction, causal analysis, structural modeling, counter-evidence resolution.'
            };
        } catch (error) {
            console.error("[ResearchPlanService] Plan generation failed:", error);
            // Fallback plan with strict decomposition/query-expansion guarantees
            const fallbackBlueprint = researchIntelligenceService.buildQueryBlueprint(query, {});
            return {
                ...fallbackBlueprint,
                scopeBoundaries: ['In-scope: mechanism-level and structural analysis', 'Out-of-scope: unsupported claims without measurable evidence'],
                intendedAudience: 'Graduate Research Analysts',
                methodology: 'Causal synthesis, structural economic modeling, contradiction resolution'
            };
        }
    }
};

module.exports = researchPlanService;
