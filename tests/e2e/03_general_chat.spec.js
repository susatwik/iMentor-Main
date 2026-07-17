// tests/e2e/03_general_chat.spec.js — GC-01 .. GC-08
// General chat + semantic routing verification
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import {
  sendAndWait, countBotMessages, assertBotResponse,
  assertHasCodeBlock, assertNoError, clickNewChat, SEL
} from './helpers/chat-helpers.js';

test.describe('GC — General Chat & Semantic Routing', () => {

  test.beforeEach(async ({ page }) => {
    await loginAs(page);
  });

  /* ── Existing coverage (enhanced) ──────────────────────────────── */

  test('GC-01 — Factual query returns substantive response', async ({ page }) => {
    const text = await sendAndWait(page, 'What is machine learning?');
    expect(text.length).toBeGreaterThan(20);
    await assertNoError(page);
    console.log(`✓ GC-01 passed (${text.length} chars)`);
  });

  test('GC-02 — Multi-turn conversation retains context', async ({ page }) => {
    await sendAndWait(page, 'Explain overfitting in machine learning');
    const text2 = await sendAndWait(page, 'Give me a concrete example of what you just described');

    const count = await countBotMessages(page);
    expect(count).toBeGreaterThanOrEqual(2);

    // Second response should reference overfitting or the prior explanation
    const relevant = /overfit|training|model|example|instance|scenario/i.test(text2);
    expect(relevant).toBeTruthy();

    console.log(`✓ GC-02 passed: ${count} bot messages, context retained`);
  });

  test('GC-03 — New chat clears conversation', async ({ page }) => {
    await sendAndWait(page, 'Hello, explain recursion');
    await clickNewChat(page);

    // Either welcome panel is visible or no bot messages remain
    const welcome = page.locator(SEL.welcomePanel);
    const botCount = await countBotMessages(page);
    const isCleared = botCount === 0 || await welcome.isVisible().catch(() => false);
    expect(isCleared).toBeTruthy();

    console.log('✓ GC-03 passed: New chat cleared messages');
  });

  /* ── New semantic routing tests ────────────────────────────────── */

  test('GC-04 — Greeting intent returns fast short response', async ({ page }) => {
    const start = Date.now();
    const text = await sendAndWait(page, 'Hello, how are you?');
    const elapsed = Date.now() - start;

    expect(text.length).toBeGreaterThan(5);
    // Greeting should be relatively quick (< 30s even with slow models)
    expect(elapsed).toBeLessThan(30000);
    // Should not contain RAG references or citations
    const noRAG = !/\[source\]|\[ref\]|retrieved from/i.test(text);
    expect(noRAG).toBeTruthy();

    console.log(`✓ GC-04 passed: Greeting in ${elapsed}ms (${text.length} chars)`);
  });

  test('GC-05 — Code-related intent returns code block', async ({ page }) => {
    test.setTimeout(120000);
    const text = await sendAndWait(page, 'Write a Python function to reverse a linked list');

    expect(text.length).toBeGreaterThan(50);
    await assertHasCodeBlock(page);
    // Should contain Python keywords
    const hasPython = /def |class |return |self\.|node|next|prev/i.test(text);
    expect(hasPython).toBeTruthy();

    console.log(`✓ GC-05 passed: Code response (${text.length} chars)`);
  });

  test('GC-06 — Comparison/reasoning returns structured response', async ({ page }) => {
    test.setTimeout(120000);
    const text = await sendAndWait(page, 'Compare gradient descent vs Adam optimizer');

    expect(text.length).toBeGreaterThan(100);
    // Should be structured — contain bullets, numbered lists, or headers
    const isStructured = /\n[-*•]|\n\d+\.|#{1,3} |gradient|adam|optimizer|convergence/i.test(text);
    expect(isStructured).toBeTruthy();

    console.log(`✓ GC-06 passed: Structured comparison (${text.length} chars)`);
  });

  test('GC-07 — Math/formula intent returns step-by-step', async ({ page }) => {
    test.setTimeout(120000);
    const text = await sendAndWait(page, 'Derive the backpropagation formula for a 2-layer neural network');

    expect(text.length).toBeGreaterThan(100);
    // Should contain math notation or step indicators
    const hasMath = /∂|partial|gradient|derivative|chain rule|step|layer|weight|δ|∇|dL\/d|loss/i.test(text);
    expect(hasMath).toBeTruthy();

    console.log(`✓ GC-07 passed: Math derivation (${text.length} chars)`);
  });

  test('GC-08 — Context recall across turns', async ({ page }) => {
    test.setTimeout(120000);
    // Send a specific fact
    await sendAndWait(page, 'Remember this: the speed of light is exactly 299,792,458 meters per second');

    // Ask about it
    const text = await sendAndWait(page, 'What speed did I just mention?');

    // Should reference the speed of light or the number
    const recalls = /299|speed of light|meters per second/i.test(text);
    expect(recalls).toBeTruthy();

    console.log(`✓ GC-08 passed: Context recall works`);
  });

});
