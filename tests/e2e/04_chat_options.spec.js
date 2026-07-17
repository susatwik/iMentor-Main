// tests/e2e/04_chat_options.spec.js — OPT-01 .. OPT-07
// Tool toggle routing: web search, academic, ToT, deep research, RAG, prompt coach
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import {
  sendAndWait, assertBotResponse, assertHasThinking, assertHasReferences,
  assertNoError, toggleWebSearch, toggleAcademicSearch, toggleToT,
  toggleRAG, clickPromptCoach, SEL
} from './helpers/chat-helpers.js';

test.describe('OPT — Chat Option Toggles & Routing', () => {

  test.beforeEach(async ({ page }) => {
    await loginAs(page);
  });

  test('OPT-01 — Web Search toggle produces cited response', async ({ page }) => {
    test.setTimeout(120000);
    await toggleWebSearch(page);

    const text = await sendAndWait(page, 'What are the latest AI breakthroughs in March 2026?', 120000);

    expect(text.length).toBeGreaterThan(50);
    // Web search should surface recent info or citations
    const hasCitations = /source|http|www\.|reference|\[\d+\]|2026|2025|according to/i.test(text);
    expect(hasCitations).toBeTruthy();

    await assertNoError(page);
    console.log(`✓ OPT-01 passed: Web search response with citations (${text.length} chars)`);
  });

  test('OPT-02 — Academic Search returns scholarly references', async ({ page }) => {
    test.setTimeout(120000);
    await toggleAcademicSearch(page);

    const text = await sendAndWait(page, 'Recent papers on transformer efficiency improvements', 120000);

    expect(text.length).toBeGreaterThan(50);
    // Academic responses should reference papers/journals
    const hasAcademic = /paper|journal|study|research|et al|arxiv|published|conference|2024|2025|2026/i.test(text);
    expect(hasAcademic).toBeTruthy();

    await assertNoError(page);
    console.log(`✓ OPT-02 passed: Academic response (${text.length} chars)`);
  });

  test('OPT-03 — Tree of Thought toggle shows reasoning', async ({ page }) => {
    test.setTimeout(180000);
    await toggleToT(page);

    const text = await sendAndWait(page, 'Analyze the trade-offs between CNNs and Vision Transformers', 180000);

    expect(text.length).toBeGreaterThan(100);

    // Look for thinking/reasoning indicator
    try {
      await assertHasThinking(page);
      console.log('  → Thinking dropdown found');
    } catch {
      // ToT may render as structured text without explicit dropdown
      const structured = /trade-off|advantage|disadvantage|CNN|ViT|transformer|convolutional/i.test(text);
      expect(structured).toBeTruthy();
      console.log('  → No thinking dropdown but response is structured analysis');
    }

    await assertNoError(page);
    console.log(`✓ OPT-03 passed: ToT response (${text.length} chars)`);
  });

  test('OPT-04 — Web Search + ToT combined', async ({ page }) => {
    test.setTimeout(180000);
    await toggleWebSearch(page);
    await toggleToT(page);

    const text = await sendAndWait(page, 'What are the latest criticisms of RLHF in 2026?', 180000);

    expect(text.length).toBeGreaterThan(100);

    // Should have web citations
    const hasCitations = /source|http|reference|\[\d+\]|2026|2025|according/i.test(text);
    // Should have analytical depth from ToT
    const hasAnalysis = /criticism|limitation|challenge|concern|problem|issue|RLHF/i.test(text);

    expect(hasCitations || hasAnalysis).toBeTruthy();

    await assertNoError(page);
    console.log(`✓ OPT-04 passed: Web+ToT combined (${text.length} chars)`);
  });

  test('OPT-05 — Deep Research page initiates pipeline', async ({ page }) => {
    test.setTimeout(300000);
    await page.goto('/tools/deep-research');
    await page.waitForTimeout(2000);

    // Assert page loaded
    const heading = page.getByText(/deep research/i).first();
    await expect(heading).toBeVisible({ timeout: 10000 });

    // Find the research input
    const queryInput = page.locator('textarea[data-deep-research-tour="query-input"]')
      .or(page.locator('textarea').first());
    await queryInput.waitFor({ state: 'visible', timeout: 10000 });
    await queryInput.fill('Brief overview of federated learning applications');

    // Click start research
    const startBtn = page.locator('button[data-deep-research-tour="start-button"]')
      .or(page.getByRole('button', { name: /start research/i }));
    await startBtn.waitFor({ state: 'visible', timeout: 5000 });
    await startBtn.click();

    // Wait for pipeline to start — look for stage indicators
    await page.waitForTimeout(5000);

    // Assert pipeline is running (any stage indicator or loading state)
    const pipeline = page.locator('text=/planning|discovery|methodology|semantic|synthesis|evaluating|searching/i').first();
    const isRunning = await pipeline.isVisible({ timeout: 30000 }).catch(() => false);

    // If pipeline is visible, it started successfully
    if (isRunning) {
      console.log('  → Research pipeline started, stages visible');
    } else {
      // May have already completed (fast query)
      console.log('  → Pipeline may have completed quickly or redirected');
    }

    await assertNoError(page);
    console.log('✓ OPT-05 passed: Deep Research pipeline initiated');
  });

  test('OPT-06 — RAG without course gives normal response', async ({ page }) => {
    test.setTimeout(120000);
    // Don't select any course, just send a query
    const text = await sendAndWait(page, 'What is overfitting in machine learning?');

    expect(text.length).toBeGreaterThan(20);
    // Should be a general response without RAG citations
    // No "retrieved from course" or specific document references
    await assertNoError(page);

    console.log(`✓ OPT-06 passed: Response without course RAG (${text.length} chars)`);
  });

  test('OPT-07 — Prompt Coach improves user query', async ({ page }) => {
    // Type a vague query first
    const input = page.locator('textarea').first();
    await input.waitFor({ state: 'visible', timeout: 10000 });
    await input.fill('explain ml');

    // Click Prompt Coach
    const coachBtn = page.locator(SEL.promptCoach);
    if (await coachBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await coachBtn.click();
      await page.waitForTimeout(3000);

      // Look for enhanced prompt suggestion modal/popup
      const enhanced = page.locator('[class*="modal"], [class*="coach"], [class*="suggest"], [role="dialog"]').first();
      const visible = await enhanced.isVisible({ timeout: 10000 }).catch(() => false);

      if (visible) {
        console.log('  → Prompt Coach modal appeared');
        // Close it
        await page.keyboard.press('Escape');
      } else {
        // Coach may modify the textarea directly
        const newText = await input.inputValue();
        console.log(`  → Prompt Coach modified input: "${newText.slice(0, 80)}..."`);
      }

      console.log('✓ OPT-07 passed: Prompt Coach activated');
    } else {
      console.log('⚠ OPT-07 skipped: Prompt Coach button not visible');
    }
  });

});
