const log = require('../utils/logger');
// server/services/toolChainOrchestrator.js
/**
 * Advanced Tool Chain Orchestrator
 * 
 * Capabilities:
 *  1. Tool Chaining — output of Tool A feeds into Tool B
 *  2. Execution Planning — LLM decides if multi-tool is needed, plans the chain
 *  3. Performance Monitoring — tracks latency, success rate per tool
 *  4. Error Recovery — retry with backoff, fallback to alternative tools
 */

const { availableTools, getToolMeta } = require('./toolRegistry');


// ─── PERFORMANCE MONITOR ───────────────────────────────────────────────────
class ToolPerformanceMonitor {
    constructor() {
        // In-memory metrics — could be persisted to Redis/MongoDB for production
        this.metrics = {};
    }

    startExecution(toolName) {
        return {
            toolName,
            startTime: Date.now(),
        };
    }

    endExecution(handle, success, errorMsg = null) {
        const duration = Date.now() - handle.startTime;
        const toolName = handle.toolName;

        if (!this.metrics[toolName]) {
            this.metrics[toolName] = {
                totalCalls: 0,
                successCount: 0,
                failureCount: 0,
                totalLatencyMs: 0,
                avgLatencyMs: 0,
                lastError: null,
                lastCallTime: null,
                recentLatencies: [], // last 20
            };
        }

        const m = this.metrics[toolName];
        m.totalCalls++;
        m.totalLatencyMs += duration;
        m.avgLatencyMs = Math.round(m.totalLatencyMs / m.totalCalls);
        m.lastCallTime = Date.now();
        m.recentLatencies.push(duration);
        if (m.recentLatencies.length > 20) m.recentLatencies.shift();

        if (success) {
            m.successCount++;
        } else {
            m.failureCount++;
            m.lastError = errorMsg;
        }

        // log.info('AI', `[ToolPerf] ${toolName}: ${duration}ms | ${success ? '✓' : '✗'}`);

        return { toolName, duration, success };
    }

    getMetrics(toolName) {
        if (toolName) return this.metrics[toolName] || null;
        return { ...this.metrics };
    }

    getHealthReport() {
        const report = {};
        for (const [name, m] of Object.entries(this.metrics)) {
            const successRate = m.totalCalls > 0 ? (m.successCount / m.totalCalls * 100) : 100;
            report[name] = {
                status: successRate > 80 ? 'healthy' : successRate > 50 ? 'degraded' : 'unhealthy',
                successRate: `${successRate.toFixed(1)}%`,
                avgLatencyMs: m.avgLatencyMs,
                totalCalls: m.totalCalls,
                lastError: m.lastError,
            };
        }
        return report;
    }
}

// Singleton
const performanceMonitor = new ToolPerformanceMonitor();

// ─── ERROR RECOVERY ─────────────────────────────────────────────────────────
const RETRY_CONFIG = {
    maxRetries: 2,
    baseDelayMs: 1000,
    backoffMultiplier: 2,
};

const TOOL_FALLBACKS = {
    rag_search: ['web_search'],
    academic_search: ['web_search'],
    kg_search: ['rag_search'],
    web_search: [],
};

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function executeWithRetry(toolName, params, context, retryConfig = RETRY_CONFIG) {
    const tool = availableTools[toolName];
    if (!tool) throw new Error(`Tool "${toolName}" not found in registry.`);

    let lastError = null;

    for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
        const attemptStart = Date.now();
        const perfHandle = performanceMonitor.startExecution(toolName);

        try {
            if (attempt > 0) {
                const delay = retryConfig.baseDelayMs * Math.pow(retryConfig.backoffMultiplier, attempt - 1);
                log.info('AI', `Retrying ${toolName} (attempt ${attempt + 1})`);
                await sleep(delay);
            }

            const result = await tool.execute(params, context);
            performanceMonitor.endExecution(perfHandle, true);
            return { success: true, toolName, result, duration: Date.now() - attemptStart };

        } catch (error) {
            lastError = error;
            performanceMonitor.endExecution(perfHandle, false, error.message);
            log.warn('AI', `${toolName} attempt ${attempt + 1} failed: ${error.message}`);
        }
    }

    // All retries failed — try fallback tools
    const fallbacks = TOOL_FALLBACKS[toolName] || [];
    for (const fallbackName of fallbacks) {
        log.info('AI', `Fallback: ${toolName} → ${fallbackName}`);
        const fallbackTool = availableTools[fallbackName];
        if (!fallbackTool) continue;

        const perfHandle = performanceMonitor.startExecution(fallbackName);
        try {
            const result = await fallbackTool.execute(params, context);
            performanceMonitor.endExecution(perfHandle, true);
            // log.success('AI', `Fallback ${fallbackName} succeeded`);
            return { success: true, toolName: fallbackName, result, wasFailover: true, originalTool: toolName, duration: Date.now() - perfHandle.startTime };
        } catch (fbError) {
            performanceMonitor.endExecution(perfHandle, false, fbError.message);
            log.error('AI', `Fallback ${fallbackName} failed: ${fbError.message}`);
        }
    }

    // Everything failed
    return {
        success: false,
        toolName,
        error: lastError?.message || 'Unknown error after all retries and fallbacks.',
    };
}

// ─── TOOL CHAINING ──────────────────────────────────────────────────────────
/**
 * Executes a chain of tool calls. Independent steps (no inputMapping) run in parallel.
 * Dependent steps (with inputMapping referencing previous output) run sequentially.
 * 
 * @param {Array} chain - Array of chain steps:
 *   [{ toolName: 'web_search', params: { query: '...' }, inputMapping: null },
 *    { toolName: 'rag_search', params: { query: '{prev.output}' }, inputMapping: { query: 'prev.toolOutput' } }]
 * @param {Object} context - Request context
 * @param {Function} onStepComplete - Callback after each step (for streaming updates)
 * @returns {Object} - { results: [...], finalOutput, allReferences, chainTimings }
 */
async function executeToolChain(chain, context, onStepComplete = null) {
    const results = [];
    const allReferences = [];
    const chainTimings = [];

    // Partition chain into parallel-safe groups:
    // Steps without inputMapping that don't reference previous output can run in parallel.
    const independentSteps = [];
    const dependentSteps = [];
    for (let i = 0; i < chain.length; i++) {
        if (i === 0 || !chain[i].inputMapping) {
            independentSteps.push({ ...chain[i], originalIndex: i });
        } else {
            dependentSteps.push({ ...chain[i], originalIndex: i });
        }
    }

    // Phase 1: Execute all independent steps in parallel
    let previousOutput = null;
    if (independentSteps.length > 0) {
        const parallelStart = Date.now();
        const parallelPromises = independentSteps.map(async (step) => {
            const stepStart = Date.now();
            const execution = await executeWithRetry(step.toolName, step.params, context);
            const stepDuration = Date.now() - stepStart;

            const stepResult = {
                step: step.originalIndex + 1,
                toolName: execution.toolName,
                success: execution.success,
                duration: stepDuration,
                wasFailover: execution.wasFailover || false,
                originalTool: execution.originalTool || null,
            };

            if (execution.success) {
                stepResult.output = execution.result.toolOutput;
                stepResult.references = execution.result.references || [];
            } else {
                stepResult.error = execution.error;
                stepResult.output = `[Error: ${execution.error}]`;
            }
            return { stepResult, execution, stepDuration, step };
        });

        const parallelResults = await Promise.all(parallelPromises);

        for (const { stepResult, execution, stepDuration, step } of parallelResults) {
            results.push(stepResult);
            chainTimings.push({ step: step.originalIndex + 1, tool: step.toolName, duration: stepDuration });
            if (execution.success) {
                allReferences.push(...(execution.result.references || []));
                previousOutput = execution.result;
            } else {
                previousOutput = previousOutput || { toolOutput: `Step (${step.toolName}) failed: ${execution.error}`, references: [] };
            }
            if (onStepComplete) {
                onStepComplete({ stepIndex: step.originalIndex, total: chain.length, ...stepResult });
            }
        }
    }

    // Phase 2: Execute dependent steps sequentially (they need previous output)
    for (const step of dependentSteps) {
        const stepStart = Date.now();
        const resolvedParams = resolveInputMapping(step.params, step.inputMapping, previousOutput, results);

        const execution = await executeWithRetry(step.toolName, resolvedParams, context);
        const stepDuration = Date.now() - stepStart;

        const stepResult = {
            step: step.originalIndex + 1,
            toolName: execution.toolName,
            success: execution.success,
            duration: stepDuration,
            wasFailover: execution.wasFailover || false,
            originalTool: execution.originalTool || null,
        };

        if (execution.success) {
            stepResult.output = execution.result.toolOutput;
            stepResult.references = execution.result.references || [];
            previousOutput = execution.result;
            allReferences.push(...(execution.result.references || []));
        } else {
            stepResult.error = execution.error;
            stepResult.output = `[Error: ${execution.error}]`;
            previousOutput = { toolOutput: `Step (${step.toolName}) failed: ${execution.error}`, references: [] };
        }

        results.push(stepResult);
        chainTimings.push({ step: step.originalIndex + 1, tool: step.toolName, duration: stepDuration });

        if (onStepComplete) {
            onStepComplete({ stepIndex: step.originalIndex, total: chain.length, ...stepResult });
        }
    }

    // Deduplicate references
    const uniqueRefs = new Map();
    allReferences.forEach(ref => {
        const key = ref.url || ref.source || JSON.stringify(ref);
        if (!uniqueRefs.has(key)) uniqueRefs.set(key, ref);
    });

    const totalDuration = chainTimings.reduce((sum, t) => sum + t.duration, 0);

    return {
        results: results.sort((a, b) => a.step - b.step),
        finalOutput: previousOutput?.toolOutput || results.map(r => r.output).join('\n\n'),
        allReferences: Array.from(uniqueRefs.values()).map((ref, i) => ({ ...ref, number: i + 1 })),
        chainTimings,
        totalDuration,
    };
}

/**
 * Resolves input mappings by injecting outputs from previous steps.
 * Supports special tokens like {prev.toolOutput}, {step[0].toolOutput}, etc.
 */
function resolveInputMapping(params, inputMapping, previousOutput, allResults) {
    if (!inputMapping || !previousOutput) return { ...params };

    const resolved = { ...params };

    for (const [paramKey, mappingExpr] of Object.entries(inputMapping)) {
        let value = null;

        if (mappingExpr === 'prev.toolOutput') {
            value = previousOutput.toolOutput;
        } else if (mappingExpr === 'prev.references') {
            value = previousOutput.references;
        } else if (mappingExpr.startsWith('step[')) {
            // e.g., "step[0].toolOutput"
            const match = mappingExpr.match(/step\[(\d+)\]\.(\w+)/);
            if (match) {
                const stepIdx = parseInt(match[1]);
                const field = match[2];
                if (allResults[stepIdx]) {
                    value = allResults[stepIdx][field] || allResults[stepIdx].output;
                }
            }
        }

        if (value !== null && value !== undefined) {
            // If the target param is 'query', intelligently append context
            if (paramKey === 'query' && typeof value === 'string') {
                resolved[paramKey] = params[paramKey]
                    ? `${params[paramKey]}\n\nContext from previous step:\n${value.substring(0, 2000)}`
                    : value;
            } else {
                resolved[paramKey] = value;
            }
        }
    }

    return resolved;
}

// ─── CHAIN PLANNING ─────────────────────────────────────────────────────────
/**
 * Analyzes a tool call and decides if it benefits from chaining.
 * For example, a RAG search might benefit from a KG search too.
 * 
 * @param {string} primaryToolName - The tool the router selected
 * @param {Object} params - The tool parameters
 * @param {Object} context - Request context
 * @returns {Array} - A chain of tool steps (may be just the single tool)
 */
function planToolChain(primaryToolName, params, context) {
    const chain = [];

    // Always start with the primary tool
    chain.push({
        toolName: primaryToolName,
        params: { ...params },
        inputMapping: null,
    });

    // Smart chaining rules — enhance results with complementary tools
    if (primaryToolName === 'rag_search' && context.criticalThinkingEnabled) {
        // RAG + KG for deep document understanding
        chain.push({
            toolName: 'kg_search',
            params: { query: params.query },
            inputMapping: null, // Independent parallel-like step
        });
    }

    if (primaryToolName === 'academic_search' && context.isWebSearchEnabled) {
        // Academic + Web for broader context
        chain.push({
            toolName: 'web_search',
            params: { query: params.query },
            inputMapping: null,
        });
    }

    return chain;
}

// ─── EXPORTS ────────────────────────────────────────────────────────────────
module.exports = {
    executeToolChain,
    executeWithRetry,
    planToolChain,
    resolveInputMapping,
    performanceMonitor,
    TOOL_FALLBACKS,
};
