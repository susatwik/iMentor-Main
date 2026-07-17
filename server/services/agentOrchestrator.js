const { decomposeTask } = require('./taskDecompositionService');
const { routeRetrieval } = require('./retrievalRouter');
// const { availableTools } = require('./toolRegistry'); // Removed to fix circular dependency
// Note: We might need to refactor toolRegistry to export individual functions if we want direct calls, 
// or use the toolRegistry.execute() method.

/**
 * Agent Orchestrator
 * Manages the execution of the decomposition plan.
 */
async function executeAgentTask(userRequest, context) {
    // 1. Decompose
    const plan = await decomposeTask(userRequest, context);

    // 2. Execute Graph (Topological Sort / Parallel Execution)
    // For simplicity, we'll do linear or simple dependency check loop.

    const results = new Map(); // stepId -> result
    const completed = new Set();

    // Wave-based parallel DAG: each wave runs all steps whose dependencies are met concurrently
    while (completed.size < plan.steps.length) {
        const ready = plan.steps.filter(
            s => !completed.has(s.id) && s.dependencies.every(d => completed.has(d))
        );
        if (ready.length === 0) break; // guard against cycles or unresolvable deps

        const wave = await Promise.allSettled(
            ready.map(step =>
                (async () => {
                    console.log(`[Agent] Executing Step ${step.id}: ${step.description}`);
                    let result = '';
                    if (['web_search', 'graph_search', 'vector_search'].includes(step.tool)) {
                        const retrieval = await routeRetrieval(step.description, context);
                        result = JSON.stringify(retrieval);
                    } else {
                        result = `Simulated result for: ${step.description}`;
                    }
                    return { id: step.id, result };
                })().catch(e => {
                    console.error(`[Agent] Step ${step.id} failed: ${e.message}`);
                    return { id: step.id, result: `Error: ${e.message}` };
                })
            )
        );

        for (const outcome of wave) {
            const { id, result } = outcome.value;
            results.set(id, result);
            completed.add(id);
        }
    }

    return {
        plan: plan,
        execution_trace: Array.from(results.entries())
    };
}

module.exports = { executeAgentTask };
