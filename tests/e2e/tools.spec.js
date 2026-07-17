// tests/e2e/tools.spec.js — UI-TOOL-01 .. UI-TOOL-06
import { test, expect } from '@playwright/test';
import { loginAs, sendMessage } from './helpers/auth.js';

test.describe('UI-TOOLS — Tool Toggles', () => {

  test.beforeEach(async ({ page }) => {
    await loginAs(page);
  });

  test('UI-TOOL-01 — Web search toggle', async ({ page }) => {
    // Open plus menu to find web search toggle
    const plusBtn = page.getByLabel(/open menu/i)
      .or(page.locator('button[class*="plus"], button[aria-label*="menu"]').first());
    if (await plusBtn.isVisible()) {
      await plusBtn.click();
      await page.waitForTimeout(500);
    }

    // Toggle web search
    const webToggle = page.getByText(/web search/i).first();
    if (await webToggle.isVisible()) {
      await webToggle.click();
      await page.waitForTimeout(300);
    }

    // Close menu if open
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    await sendMessage(page, 'What are the latest AI research papers in 2025?');

    const botMsg = page.locator('.message-bubble, [class*="message-bubble"], [class*="items-start"] .message-bubble-wrapper').last();
    await expect(botMsg).toBeVisible({ timeout: 90000 });

    console.log('✓ UI-TOOL-01 passed: Web search message sent and response received');
  });

  test('UI-TOOL-03 — Critical Thinking (ToT) toggle', async ({ page }) => {
    // Find ToT toggle
    const totBtn = page.getByLabel(/toggle tree of thought/i)
      .or(page.getByTitle(/tree of thought/i))
      .or(page.getByText(/tree of thought/i).first());

    if (await totBtn.isVisible()) {
      await totBtn.click();
      await page.waitForTimeout(300);
    }

    await sendMessage(page, 'Analyze bias-variance tradeoff in ensemble methods');

    const botMsg = page.locator('.message-bubble, [class*="message-bubble"], [class*="items-start"] .message-bubble-wrapper').last();
    await expect(botMsg).toBeVisible({ timeout: 90000 });
    const text = await botMsg.textContent();
    expect(text.length).toBeGreaterThan(50);

    console.log('✓ UI-TOOL-03 passed: ToT response received');
  });

  test('UI-TOOL-05 — Knowledge base selection', async ({ page }) => {
    // Click KB toggle
    const kbBtn = page.getByLabel(/toggle rag/i)
      .or(page.getByLabel(/toggle knowledge base/i))
      .or(page.getByTitle(/rag/i))
      .or(page.getByTitle(/knowledge base/i))
      .or(page.getByText(/knowledge base/i).first());

    if (await kbBtn.isVisible()) {
      await kbBtn.click();
      await page.waitForTimeout(1000);

      // Look for modal and select Machine Learning
      const mlOption = page.getByText(/machine learning/i).first();
      if (await mlOption.isVisible()) {
        await mlOption.click();
        await page.waitForTimeout(500);
      }

      // Close modal
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    await sendMessage(page, 'Explain what the course covers about supervised learning');

    const botMsg = page.locator('.message-bubble, [class*="message-bubble"], [class*="items-start"] .message-bubble-wrapper').last();
    await expect(botMsg).toBeVisible({ timeout: 90000 });

    console.log('✓ UI-TOOL-05 passed: Knowledge base query responded');
  });

  test('UI-TOOL-06 — Deep Research page', async ({ page }) => {
    await page.goto('/tools/deep-research');
    await page.waitForTimeout(2000);

    // Assert page loaded
    const heading = page.getByText(/deep research/i).first();
    await expect(heading).toBeVisible({ timeout: 10000 });

    console.log('✓ UI-TOOL-06 passed: Deep Research page loaded');
  });

});
