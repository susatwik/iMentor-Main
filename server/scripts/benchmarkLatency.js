const axios = require('axios');

const BASE_URL = process.env.BENCHMARK_BASE_URL || 'http://localhost:5001';
const TOKEN = process.env.BENCHMARK_JWT_TOKEN || '';
const SESSION_ID = process.env.BENCHMARK_SESSION_ID || `bench-${Date.now()}`;

function parseSSEPayload(raw) {
  const lines = String(raw || '').split('\n');
  const events = [];
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.replace(/^data:\s*/, '');
    try {
      events.push(JSON.parse(payload));
    } catch (parseErr) {
      console.warn(`[Benchmark] Skipping invalid SSE payload: ${parseErr.message}`);
    }
  }
  return events;
}

async function callMessage(body) {
  const label = body.deepResearchMode
    ? 'deepResearch'
    : (body.criticalThinkingEnabled || body.useReAct ? 'complexToT' : 'simple');
  const requestTimeoutMs = Number(process.env.BENCHMARK_REQUEST_TIMEOUT_MS || 180000);
  const startedAt = Date.now();
  console.log(`[Benchmark] ${label}: started (session=${body.sessionId})`);

  try {
    const response = await axios.post(`${BASE_URL}/api/chat/message`, body, {
      timeout: requestTimeoutMs,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      },
      responseType: 'text'
    });

    const events = parseSSEPayload(response.data);
    const finalEvent = events.reverse().find(e => e.type === 'final_answer' || e.type === 'research_complete') || null;
    const content = finalEvent?.content || {};
    const reasoningMeta = content.reasoningMeta || {};

    const result = {
      responseTimeMs: Date.now() - startedAt,
      tokenUsageEstimate: reasoningMeta.tokenUsageEstimate || Math.ceil(String(content.finalAnswer || content.researchReport?.fullReport || '').length / 4),
      branchCount: reasoningMeta.branchCount || content.totalBranchesGenerated || 1,
      toolCalls: reasoningMeta.toolCalls || 0,
      sourcePipeline: content.sourcePipeline || 'unknown',
      status: 'ok'
    };

    console.log(`[Benchmark] ${label}: completed in ${result.responseTimeMs}ms`);
    return result;
  } catch (error) {
    const elapsed = Date.now() - startedAt;
    const message = error.response?.data?.message || error.message || 'request failed';
    console.log(`[Benchmark] ${label}: failed after ${elapsed}ms (${message})`);
    return {
      responseTimeMs: elapsed,
      tokenUsageEstimate: 0,
      branchCount: 0,
      toolCalls: 0,
      sourcePipeline: 'failed',
      status: 'failed',
      error: message,
    };
  }
}

function avg(nums) {
  return nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : 0;
}

async function runBenchmark() {
  if (!TOKEN) {
    throw new Error('Missing BENCHMARK_JWT_TOKEN');
  }

  const rounds = Number(process.env.BENCHMARK_ROUNDS || 2);
  const includeDeepResearch = process.env.BENCHMARK_INCLUDE_DEEP_RESEARCH !== 'false';
  const simpleStats = [];
  const complexStats = [];
  const deepStats = [];

  console.log(`[Benchmark] Base URL: ${BASE_URL}`);
  console.log(`[Benchmark] Rounds: ${rounds}`);
  console.log(`[Benchmark] Include DeepResearch: ${includeDeepResearch}`);

  for (let i = 0; i < rounds; i++) {
    console.log(`[Benchmark] ---- Round ${i + 1}/${rounds} ----`);
    simpleStats.push(await callMessage({
      query: 'What is Newton second law?',
      sessionId: `${SESSION_ID}-simple-${i}`,
      criticalThinkingEnabled: false,
      useReAct: false,
      deepResearchMode: false,
    }));

    complexStats.push(await callMessage({
      query: 'Analyze trade-offs between SQL and NoSQL for a multi-tenant LMS with scaling and consistency constraints.',
      sessionId: `${SESSION_ID}-complex-${i}`,
      criticalThinkingEnabled: true,
      useReAct: false,
      deepResearchMode: false,
    }));

    if (includeDeepResearch) {
      deepStats.push(await callMessage({
        query: 'Latest empirical evidence on retrieval augmented generation hallucination mitigation strategies.',
        sessionId: `${SESSION_ID}-deep-${i}`,
        deepResearchMode: true,
        forceRefresh: false,
      }));
    }
  }

  const report = {
    averageSimpleResponseMs: avg(simpleStats.map(s => s.responseTimeMs)),
    averageComplexToTResponseMs: avg(complexStats.map(s => s.responseTimeMs)),
    averageDeepResearchResponseMs: avg(deepStats.map(s => s.responseTimeMs)),
    averageTokenUsage: {
      simple: avg(simpleStats.map(s => s.tokenUsageEstimate)),
      complex: avg(complexStats.map(s => s.tokenUsageEstimate)),
      deepResearch: avg(deepStats.map(s => s.tokenUsageEstimate)),
    },
    averageBranchCount: {
      simple: avg(simpleStats.map(s => s.branchCount)),
      complex: avg(complexStats.map(s => s.branchCount)),
      deepResearch: avg(deepStats.map(s => s.branchCount)),
    },
    averageToolCalls: {
      simple: avg(simpleStats.map(s => s.toolCalls)),
      complex: avg(complexStats.map(s => s.toolCalls)),
      deepResearch: avg(deepStats.map(s => s.toolCalls)),
    },
    failures: {
      simple: simpleStats.filter(s => s.status === 'failed').length,
      complex: complexStats.filter(s => s.status === 'failed').length,
      deepResearch: deepStats.filter(s => s.status === 'failed').length,
    }
  };

  console.log(JSON.stringify(report, null, 2));
}

runBenchmark().catch((error) => {
  console.error('[Benchmark] Failed:', error.message);
  process.exit(1);
});
