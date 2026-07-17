const log = require('../utils/logger');

/**
 * Calculate optimal number of plans to generate based on complexity.
 * Supports both:
 *   1) Legacy signature: (query, requestContext)
 *   2) Dynamic signature: ({ queryComplexity, tokenBudget, historicalConfidence, query, requestContext })
 *
 * Returns 2-3 branches for safe performance.
 */
function calculateOptimalBranchCount(queryOrParams, requestContext = {}) {
    // Dynamic signature path
    if (typeof queryOrParams === 'object' && queryOrParams !== null && !Array.isArray(queryOrParams)) {
        const {
            queryComplexity = 0.5,
            tokenBudget = 2048,
            historicalConfidence = 70,
            query = '',
            requestContext: ctx = {}
        } = queryOrParams;

        const q = String(query || '').toLowerCase();
        const hasDocument = !!ctx.documentContextName;
        const analyticCue = /(analy[sz]e|compare|forecast|risk|trade[- ]?off|strategy|architecture|multi[- ]step)/i.test(q);

        // Weighted branch signal in [0,1]
        const complexitySignal = Math.max(0, Math.min(1, Number(queryComplexity) || 0));
        const confidenceSignal = Math.max(0, Math.min(1, (100 - (Number(historicalConfidence) || 70)) / 100));
        const budgetSignal = (Number(tokenBudget) || 2048) < 1400 ? 0 : 0.25;
        const docSignal = hasDocument ? 0.25 : 0;
        const analyticSignal = analyticCue ? 0.2 : 0;

        const score = complexitySignal * 0.5 + confidenceSignal * 0.2 + budgetSignal + docSignal + analyticSignal;
        return score >= 0.8 ? 3 : 2;
    }

    // Legacy signature path
    const query = String(queryOrParams || '');
    const wordCount = query.split(' ').length;
    const questionCount = (query.match(/\?/g) || []).length;
    const hasDocument = !!requestContext.documentContextName;

    const toolKeywords = ['search', 'find', 'research', 'compare', 'analyze'];
    const hasToolKeywords = toolKeywords.some(keyword =>
        query.toLowerCase().includes(keyword)
    );

    if (hasDocument || wordCount > 30 || questionCount > 2) return 3;
    if (wordCount > 15 || questionCount > 1 || hasToolKeywords) return 3;
    return 2;
}

/**
 * Calculate similarity between two plan step arrays
 * @param {Array} steps1 - First plan's steps
 * @param {Array} steps2 - Second plan's steps
 * @returns {number} Similarity percentage (0-100)
 */
function calculatePlanSimilarity(steps1, steps2) {
    if (!steps1 || !steps2 || steps1.length === 0 || steps2.length === 0) {
        return 0;
    }

    const descriptions1 = steps1.map(s => (s.description || '').toLowerCase());
    const descriptions2 = steps2.map(s => (s.description || '').toLowerCase());

    let matchCount = 0;
    const maxLength = Math.max(descriptions1.length, descriptions2.length);

    for (let i = 0; i < Math.min(descriptions1.length, descriptions2.length); i++) {
        const desc1 = descriptions1[i];
        const desc2 = descriptions2[i];

        // Check if descriptions are very similar (>70% word overlap)
        const words1 = desc1.split(' ').filter(w => w.length > 3);
        const words2 = desc2.split(' ').filter(w => w.length > 3);

        if (words1.length === 0 || words2.length === 0) continue;

        const commonWords = words1.filter(w => words2.includes(w)).length;
        const similarity = (commonWords * 2) / (words1.length + words2.length);

        if (similarity > 0.7) {
            matchCount++;
        }
    }

    return (matchCount / maxLength) * 100;
}

/**
 * Prune plans before expensive LLM evaluation
 * @param {Array} plans - Raw generated plans
 * @param {string} query - Original user query
 * @returns {Array} Pruned plans (max 3)
 */
function pruneBeforeEvaluation(plans, query) {
    if (!plans || plans.length === 0) {
        return [];
    }

    // log.info('TOT', `Pruning ${plans.length} candidate plans...`);

    // A. Remove invalid plans
    let validPlans = plans.filter(plan => {
        if (!plan.steps || !Array.isArray(plan.steps) || plan.steps.length === 0) {
            // log.warn('TOT', `Removed invalid plan: ${plan.name || 'unnamed'}`);
            return false;
        }

        const hasValidSteps = plan.steps.every(step =>
            step.description && step.description.trim().length > 0
        );

        if (!hasValidSteps) {
            // log.warn('TOT', `Removed plan with empty steps: ${plan.name || 'unnamed'}`);
            return false;
        }

        return true;
    });

    // B. Remove duplicates (>80% similarity)
    const uniquePlans = [];
    for (const plan of validPlans) {
        const isDuplicate = uniquePlans.some(existingPlan => {
            const similarity = calculatePlanSimilarity(plan.steps, existingPlan.steps);
            if (similarity > 80) {
                // log.info('TOT', `Removed duplicate plan: ${plan.name}`);
                return true;
            }
            return false;
        });

        if (!isDuplicate) {
            uniquePlans.push(plan);
        }
    }

    // C. Remove overly generic plans (only if we have enough plans)
    let filteredPlans = uniquePlans;
    if (uniquePlans.length > 2) {
        filteredPlans = uniquePlans.filter(plan => {
            const allStepsDirectAnswer = plan.steps.every(step =>
                !step.tool_call || step.tool_call === null
            );

            if (allStepsDirectAnswer && plan.steps.length === 1) {
                // log.info('TOT', `Removed generic plan: ${plan.name}`);
                return false;
            }

            return true;
        });

        // If we removed all plans, keep the originals
        if (filteredPlans.length === 0) {
            filteredPlans = uniquePlans;
        }
    }

    // D. Limit to maximum 3 plans
    const finalPlans = filteredPlans.slice(0, 3);

    // Ensure at least 1 plan remains
    if (finalPlans.length === 0 && plans.length > 0) {
        log.warn('TOT', 'All plans pruned, falling back to original');
        return [plans[0]];
    }

    return finalPlans;
}

/**
 * Score confidence for a single execution step
 */
function scoreStepConfidence(step, stepResult, cumulativeContext) {
    let confidence = 50; // Base confidence

    const finalAnswer = stepResult.finalAnswer || '';
    const sourcePipeline = stepResult.sourcePipeline || '';

    // +30 if tool executed successfully
    if (stepResult.tool_call && !sourcePipeline.includes('error')) {
        confidence += 30;
    }

    // -40 if tool error detected
    if (sourcePipeline.includes('error')) {
        confidence -= 40;
    }

    // -20 if response length < 50 characters
    if (finalAnswer.length < 50) {
        confidence -= 20;
    }

    // -30 if error keywords detected
    const errorKeywords = ['error', 'failed', 'undefined', 'not found', 'unable to'];
    const hasErrorKeywords = errorKeywords.some(keyword =>
        finalAnswer.toLowerCase().includes(keyword)
    );
    if (hasErrorKeywords) {
        confidence -= 30;
    }

    // +20 if response length > 200 chars (substantial answer)
    if (finalAnswer.length > 200) {
        confidence += 20;
    }

    // +10 if step description keywords appear in result (relevance check)
    if (step.description) {
        const stepKeywords = step.description
            .toLowerCase()
            .split(' ')
            .filter(w => w.length > 4);

        const relevantKeywords = stepKeywords.filter(keyword =>
            finalAnswer.toLowerCase().includes(keyword)
        );

        if (relevantKeywords.length > 0) {
            confidence += 10;
        }
    }

    // Clamp between 0-100
    return Math.max(0, Math.min(100, confidence));
}

/**
 * Determine if execution should abort based on step confidences
 */
function shouldAbortExecution(stepConfidences, currentStepIndex) {
    if (!stepConfidences || stepConfidences.length === 0) {
        return false;
    }

    // Condition 1: First step confidence < 25 (critical failure)
    if (currentStepIndex === 0 && stepConfidences[0] < 25) {
        log.warn('TOT', `Abort: First step failure (${stepConfidences[0]}%)`);
        return true;
    }

    // Condition 2: Average confidence of completed steps < 40
    const avgConfidence = stepConfidences.reduce((a, b) => a + b, 0) / stepConfidences.length;
    if (avgConfidence < 40) {
        log.warn('TOT', `Abort: Low average confidence (${avgConfidence.toFixed(0)}%)`);
        return true;
    }

    // Condition 3: Last 2 steps both < 30
    if (stepConfidences.length >= 2) {
        const lastTwo = stepConfidences.slice(-2);
        if (lastTwo.every(conf => conf < 30)) {
            log.warn('TOT', 'Abort: Repeated low confidence steps');
            return true;
        }
    }

    return false;
}

module.exports = {
    calculateOptimalBranchCount,
    pruneBeforeEvaluation,
    scoreStepConfidence,
    shouldAbortExecution
};
