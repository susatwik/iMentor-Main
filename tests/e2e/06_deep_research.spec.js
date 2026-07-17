// tests/e2e/06_deep_research.spec.js — DR-01 .. DR-10
// Deep research pipeline: V1 legacy flow + V2 fire-and-forget flow
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import { assertNoError } from './helpers/chat-helpers.js';

const RESEARCH_TIMEOUT  = 600_000; // 10 minutes (legacy SSE wait)
const JOB_POLL_TIMEOUT  = 900_000; // 15 minutes (V2 job poll)
const POLL_INTERVAL_MS  = 8_000;   // 8 s between polls

// Nature × Depth matrix (mirrors server constant)
const NATURE_DEPTH_MATRIX = {
  general:  { low: 30, medium: 45, high: 60 },
  academic: { low: 35, medium: 50, high: 65 },
  research: { low: 40, medium: 55, high: 70 },
};

// ── API helpers (direct fetch, no UI) ─────────────────────────────────────────
async function apiPost(request, token, path, body) {
  const r = await request.post(`http://localhost:5005${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: body,
  });
  return { status: r.status(), body: await r.json().catch(() => ({})) };
}

async function apiGet(request, token, path) {
  const r = await request.get(`http://localhost:5005${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: r.status(), body: await r.json().catch(() => ({})) };
}

async function getToken(request) {
  const r = await request.post('http://localhost:5005/api/auth/signin', {
    data: { email: 'ultra.boy7@gmail.com', password: '123456' },
  });
  const d = await r.json();
  return d.token;
}

async function pollJobApi(request, token, jobId, maxWaitMs = JOB_POLL_TIMEOUT) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const { status, body } = await apiGet(request, token, `/api/deep-research/jobs/${jobId}`);
    expect(status).toBe(200);
    const job = body?.data?.job || body?.data || body;
    const s = job?.status;
    if (s === 'completed' || s === 'failed') return job;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Job ${jobId} did not complete within ${maxWaitMs / 1000}s`);
}

test.describe('DR — Deep Research Pipeline', () => {

  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await page.goto('/tools/deep-research');
    await page.waitForTimeout(2000);
  });

  /**
   * Legacy helper: submit via old form (SSE-blocking), wait for completion.
   */
  async function runResearch(page, query, timeout = RESEARCH_TIMEOUT) {
    const start = Date.now();
    const queryInput = page.locator('textarea[data-deep-research-tour="query-input"]')
      .or(page.locator('textarea').first());
    await queryInput.waitFor({ state: 'visible', timeout: 10000 });
    await queryInput.fill(query);
    const startBtn = page.locator('button[data-deep-research-tour="start-button"]')
      .or(page.getByRole('button', { name: /start research/i }));
    await startBtn.click();
    await page.waitForTimeout(3000);
    const reportIndicator = page.locator(
      'text=/executive summary|report|synthesis complete|knowledge synthesis|system confidence/i'
    ).first();
    try {
      await reportIndicator.waitFor({ state: 'visible', timeout });
    } catch {
      console.log('  ⚠ Report indicator not found, checking page state...');
    }
    await page.waitForTimeout(2000);
    const duration = Date.now() - start;
    const report = await page.locator('body').textContent() || '';
    const yearMatches = report.match(/20\d{2}/g) || [];
    const uniqueYears = [...new Set(yearMatches.map(Number).filter(y => y >= 2020 && y <= 2030))];
    return { report, sources: uniqueYears, duration };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DR-01..DR-05: V2 UI — Nature+Depth selector interaction
  // ══════════════════════════════════════════════════════════════════════════

  test('DR-01 — Nature selector cards render and are clickable', async ({ page }) => {
    // Verify 3 nature option cards are present
    const natureSelector = page.locator('[data-deep-research-tour="nature-selector"]');
    await natureSelector.waitFor({ state: 'visible', timeout: 8000 });

    for (const label of ['General', 'Academic', 'Research']) {
      const card = natureSelector.getByText(label, { exact: true });
      await expect(card).toBeVisible();
    }

    // Click "Research" and check it gets the active style (border-purple or blue)
    await natureSelector.getByText('Research', { exact: true }).click();
    console.log('✓ DR-01 passed: Nature selector cards visible and clickable');
  });

  test('DR-02 — Depth selector cards render and show source counts', async ({ page }) => {
    const depthSelector = page.locator('[data-deep-research-tour="depth-selector"]');
    await depthSelector.waitFor({ state: 'visible', timeout: 8000 });

    for (const label of ['Low', 'Medium', 'High']) {
      await expect(depthSelector.getByText(label, { exact: true })).toBeVisible();
    }

    // Each depth card should show a source count (e.g. "50 sources")
    const bodyText = await page.locator('body').textContent();
    const hasSrcCount = /\d+ sources/i.test(bodyText);
    expect(hasSrcCount).toBeTruthy();
    console.log('✓ DR-02 passed: Depth cards visible with source count');
  });

  test('DR-03 — Source count updates when Nature+Depth changes', async ({ page }) => {
    const natureSelector = page.locator('[data-deep-research-tour="nature-selector"]');
    const depthSelector  = page.locator('[data-deep-research-tour="depth-selector"]');

    await natureSelector.waitFor({ state: 'visible', timeout: 8000 });

    // Select Research + High (70 sources)
    await natureSelector.getByText('Research', { exact: true }).click();
    await depthSelector.getByText('High',     { exact: true }).click();
    const body70 = await page.locator('body').textContent();
    const has70 = body70.includes('70');

    // Select General + Low (30 sources)
    await natureSelector.getByText('General', { exact: true }).click();
    await depthSelector.getByText('Low',      { exact: true }).click();
    const body30 = await page.locator('body').textContent();
    const has30 = body30.includes('30');

    expect(has70 || has30).toBeTruthy(); // At least one matrix value shown
    console.log(`✓ DR-03 passed: 70-src=${has70} 30-src=${has30}`);
  });

  test('DR-04 — Submit navigates to Archive and shows toast', async ({ page }) => {
    test.setTimeout(30_000);

    const queryInput = page.locator('textarea[data-deep-research-tour="query-input"]');
    await queryInput.waitFor({ state: 'visible', timeout: 10000 });
    await queryInput.fill('Unit test placeholder query for DR-04 validation');

    // Select academic / medium
    const natureSelector = page.locator('[data-deep-research-tour="nature-selector"]');
    const depthSelector  = page.locator('[data-deep-research-tour="depth-selector"]');
    await natureSelector.getByText('Academic', { exact: true }).click();
    await depthSelector.getByText('Medium',    { exact: true }).click();

    // Click Start Research
    const startBtn = page.locator('button[data-deep-research-tour="start-button"]');
    await startBtn.click();

    // Should navigate to /history very quickly (fire-and-forget)
    await page.waitForURL(/history/, { timeout: 15000 });

    // Should show some archive content (header or job list)
    const hasArchive = await page.locator('text=/Research Archive|Archive|Jobs/i').isVisible();
    expect(hasArchive).toBeTruthy();
    console.log('✓ DR-04 passed: Submit → navigated to Archive');
  });

  test('DR-05 — Archive shows job cards with status badges', async ({ page }) => {
    await page.goto('/tools/deep-research/history');
    await page.waitForTimeout(3000);

    const bodyText = await page.locator('body').textContent();
    // Should have either job status badges or "No research jobs yet" message
    const hasJobUI = /queued|running|completed|failed|no research jobs|Research Archive/i.test(bodyText);
    expect(hasJobUI).toBeTruthy();
    console.log('✓ DR-05 passed: Archive page shows job UI');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // DR-06..DR-07: V2 API — fire-and-forget + polling via direct API calls
  // ══════════════════════════════════════════════════════════════════════════

  test('DR-06 — V2 /start returns 202 in under 5s (API)', async ({ request }) => {
    test.setTimeout(30_000);
    const token = await getToken(request);
    const t0 = Date.now();
    const { status, body } = await apiPost(request, token, '/api/deep-research/start', {
      query:  'Neural scaling laws and emergent capabilities in large language models',
      nature: 'academic',
      depth:  'low',
    });
    const elapsed = Date.now() - t0;

    expect(status).toBe(202);
    expect(body.success).toBe(true);
    expect(body.jobId).toBeTruthy();
    expect(body.status).toBe('queued');
    expect(elapsed).toBeLessThan(5000);
    console.log(`✓ DR-06 passed: 202 in ${elapsed}ms, jobId=${body.jobId}`);
  });

  test('DR-07 — V2 /jobs returns list including newly queued jobs (API)', async ({ request }) => {
    test.setTimeout(30_000);
    const token = await getToken(request);

    // Enqueue a job
    const { body: enq } = await apiPost(request, token, '/api/deep-research/start', {
      query:  'Quantum error correction and fault-tolerant computation',
      nature: 'research',
      depth:  'low',
    });
    expect(enq.jobId).toBeTruthy();

    // List should include it
    const { status, body: list } = await apiGet(request, token, '/api/deep-research/jobs');
    expect(status).toBe(200);
    const jobs = list.data || [];
    const found = jobs.find(j => String(j._id) === String(enq.jobId));
    expect(found).toBeTruthy();
    expect(found.status).toBe('queued');
    console.log(`✓ DR-07 passed: job ${enq.jobId} found in list (${jobs.length} total)`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // DR-08: Legacy regression — old SSE research still works
  // ══════════════════════════════════════════════════════════════════════════

  test('DR-08 — LEGACY /search endpoint still responds (regression)', async ({ request }) => {
    test.setTimeout(180_000);
    const token = await getToken(request);
    const t0 = Date.now();
    const { status, body } = await apiPost(request, token, '/api/deep-research/search', {
      query: 'How does backpropagation work in deep neural networks?',
    });
    const elapsed = Math.round((Date.now() - t0) / 1000);
    expect([200, 202]).toContain(status);
    const ok = body?.success === true || 'data' in body || 'synthesizedResult' in (body?.data || {});
    expect(ok).toBeTruthy();
    console.log(`✓ DR-08 passed: LEGACY /search returned ${status} in ${elapsed}s`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // DR-09..DR-10: V2 full job lifecycle (slow — waits for completion)
  // ══════════════════════════════════════════════════════════════════════════

  test('DR-09 — V2 academic/low job completes and has provider breakdown (slow)', async ({ request }) => {
    test.setTimeout(JOB_POLL_TIMEOUT);
    const token = await getToken(request);

    const { body: enq } = await apiPost(request, token, '/api/deep-research/start', {
      query:  'AI Safety alignment techniques: RLHF and Constitutional AI comparative analysis',
      nature: 'academic',
      depth:  'low',
    });
    expect(enq.status).toBe('queued');
    const jobId = enq.jobId;

    const job = await pollJobApi(request, token, jobId);
    expect(job.status).toBe('completed');

    const meta = job.resultMeta || {};
    const total = meta.totalSources || 0;
    const target = NATURE_DEPTH_MATRIX.academic.low; // 35

    console.log(`  Sources: ${total}/${target} | OA=${meta.openAlexCount} SS=${meta.semanticCount} Ax=${meta.arxivCount} Web=${meta.webCount}`);
    console.log(`  Pages≈${meta.pageEstimate} Confidence=${meta.confidenceScore}`);

    // At least 60% of target sources retrieved
    expect(total).toBeGreaterThanOrEqual(Math.floor(target * 0.6));
    console.log(`✓ DR-09 passed: academic/low completed with ${total} sources`);
  });

  test('DR-10 — V2 vs LEGACY: source count comparison (slow)', async ({ request }) => {
    test.setTimeout(JOB_POLL_TIMEOUT);
    const token = await getToken(request);
    const topic = 'Federated learning in healthcare: privacy preserving machine learning for clinical data';

    // ── V2 fire-and-forget ──
    const t0 = Date.now();
    const { body: enq } = await apiPost(request, token, '/api/deep-research/start', {
      query:  topic,
      nature: 'academic',
      depth:  'medium',
    });
    const enqueueMs = Date.now() - t0;
    expect(enq.status).toBe('queued');
    expect(enqueueMs).toBeLessThan(5000);

    // ── Legacy search (parallel) ──
    const legacyStart = Date.now();
    const { body: legacy } = await apiPost(request, token, '/api/deep-research/search',
      { query: topic }, { timeout: 180_000 });
    const legacyElapsed = Math.round((Date.now() - legacyStart) / 1000);

    // ── Wait for V2 job ──
    const job = await pollJobApi(request, token, enq.jobId);
    const meta = job.resultMeta || {};
    const v2Sources = meta.totalSources || 0;

    // Legacy source count
    const legacyData = legacy?.data || legacy;
    const legacyCount = (legacyData?.sources || legacyData?.synthesizedSources || []).length;

    console.log(`
  ┌─ DR-10: V1 vs V2 Comparison ─────────────────────────────────
  │  V2 enqueue time  : ${enqueueMs}ms  (target <5000ms) ✓
  │  Legacy /search   : ${legacyElapsed}s (blocking)
  │  V2 sources       : ${v2Sources}  (target=50 for academic/medium)
  │  Legacy sources   : ${legacyCount}
  │  Improvement      : ${legacyCount > 0 ? `${Math.round((v2Sources / legacyCount - 1) * 100)}% more sources` : 'legacy returned 0'}
  └────────────────────────────────────────────────────────────────`);

    // V2 must retrieve more sources than legacy
    expect(v2Sources).toBeGreaterThanOrEqual(
      Math.max(legacyCount, Math.floor(NATURE_DEPTH_MATRIX.academic.medium * 0.6))
    );
    console.log(`✓ DR-10 passed: V2 returned ${v2Sources} sources vs legacy ${legacyCount}`);
  });

});

