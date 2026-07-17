// server/utils/metrics.js
const client = require('prom-client');

// Create a Registry which registers the metrics
const register = new client.Registry();

// Add a default label `service` to all metrics
register.setDefaultLabels({
  service: 'ai-tutor-nodejs-backend'
});

// Enable the collection of default metrics
client.collectDefaultMetrics({ register });

// Define a custom metric for tracking HTTP request durations
const httpRequestDurationMicroseconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'code'],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10] // Buckets for response time from 0.1s to 10s
});

// Register the custom metric
register.registerMetric(httpRequestDurationMicroseconds);

// ── iMentor Day-Shift Observability Metrics ────────────────────────────────

// Counter: how many queries each router method handles (semantic / keyword / llm)
const routerMethodCounter = new client.Counter({
    name: 'imentor_router_method_total',
    help: 'Number of queries classified by each router method',
    labelNames: ['method', 'route'],
    registers: [register]
});

// Counter: semantic router cache hits vs misses
const routerCacheCounter = new client.Counter({
    name: 'imentor_router_cache_total',
    help: 'Semantic router Redis cache hits and misses',
    labelNames: ['result'],   // 'hit' | 'miss'
    registers: [register]
});

// Histogram: end-to-end critical-path latency (ms buckets tuned for 45 students target <800ms)
const criticalPathDuration = new client.Histogram({
    name: 'imentor_critical_path_duration_ms',
    help: 'End-to-end chat response latency in milliseconds (PATH_B standard)',
    labelNames: ['path'],
    buckets: [50, 100, 200, 400, 800, 1600, 3200, 6400],
    registers: [register]
});

// Histogram: LLM call latency within the critical path
const llmCallDuration = new client.Histogram({
    name: 'imentor_llm_call_duration_ms',
    help: 'LLM generation latency in milliseconds',
    labelNames: ['provider', 'model'],
    buckets: [100, 250, 500, 1000, 2000, 4000, 8000],
    registers: [register]
});

// Histogram: RAG query latency (node.js side, includes network to Python)
const ragQueryDuration = new client.Histogram({
    name: 'imentor_rag_query_duration_ms',
    help: 'RAG service query latency in milliseconds',
    labelNames: ['status'],   // 'ok' | 'timeout' | 'error'
    buckets: [20, 50, 100, 200, 400, 800],
    registers: [register]
});

// Counter: night-shift job outcomes
const nightlyJobCounter = new client.Counter({
    name: 'imentor_nightly_job_total',
    help: 'Nightly session evaluator processed/error counts',
    labelNames: ['result'],   // 'processed' | 'error' | 'skipped'
    registers: [register]
});

module.exports = {
    register,
    httpRequestDurationMicroseconds,
    routerMethodCounter,
    routerCacheCounter,
    criticalPathDuration,
    llmCallDuration,
    ragQueryDuration,
    nightlyJobCounter,
};