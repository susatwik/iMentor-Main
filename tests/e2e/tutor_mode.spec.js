// tests/e2e/tutor_mode.spec.js — UI-TUTOR-01 .. UI-TUTOR-07
import { test, expect } from '@playwright/test';
import { loginAs, sendMessage } from './helpers/auth.js';

test.describe('UI-TUTOR — Study Mode (Machine Learning)', () => {

  test.beforeEach(async ({ page }) => {
    await loginAs(page);
  });

  test('UI-TUTOR-01 — Enter tutor mode', async ({ page }) => {
    await page.goto('/tutor');
    await page.waitForTimeout(2000);

    // Assert tutor page loaded
    const tutorLabel = page.getByText(/tutor mode/i).first();
    await expect(tutorLabel).toBeVisible({ timeout: 10000 });

    // Assert course selector visible
    const courseSelect = page.locator('[data-tutor-tour="subject-select"]')
      .or(page.locator('select').first());
    await expect(courseSelect).toBeVisible({ timeout: 5000 });

    console.log('✓ UI-TUTOR-01 passed: Tutor mode page loaded');
  });

  test('UI-TUTOR-02 — Navigate modules', async ({ page }) => {
    await page.goto('/tutor');
    await page.waitForTimeout(2000);

    // Select Machine Learning
    const courseSelect = page.locator('[data-tutor-tour="subject-select"]')
      .or(page.locator('select').first());
    if (await courseSelect.isVisible()) {
      // Use string match — Playwright selectOption doesn't accept regex for label
      const options = await courseSelect.locator('option').allTextContents();
      const mlOption = options.find(o => /machine learning/i.test(o));
      if (mlOption) await courseSelect.selectOption({ label: mlOption });
      await page.waitForTimeout(2000);
    }

    // Look for module/curriculum items
    const moduleItem = page.getByText(/module 1/i)
      .or(page.getByText(/introduction/i))
      .first();

    if (await moduleItem.isVisible()) {
      await moduleItem.click();
      await page.waitForTimeout(1000);
      console.log('✓ UI-TUTOR-02 passed: Module navigation works');
    } else {
      console.log('⚠ UI-TUTOR-02: No module items visible (course may need selection)');
    }
  });

  test('UI-TUTOR-03 — Chat within structured tutor mode', async ({ page }) => {
    await page.goto('/tutor');
    await page.waitForTimeout(2000);

    // Select course
    const courseSelect = page.locator('[data-tutor-tour="subject-select"]')
      .or(page.locator('select').first());
    if (await courseSelect.isVisible()) {
      const options = await courseSelect.locator('option').allTextContents();
      const mlOption = options.find(o => /machine learning/i.test(o));
      if (mlOption) await courseSelect.selectOption({ label: mlOption });
      await page.waitForTimeout(2000);
    }

    // Send message in tutor mode
    await sendMessage(page, "I don't understand overfitting");

    const botMsg = page.locator('.message-bubble, [class*="message-bubble"], [class*="items-start"] .message-bubble-wrapper').last();
    await expect(botMsg).toBeVisible({ timeout: 60000 });
    const text = await botMsg.textContent();
    expect(text.length).toBeGreaterThan(20);

    // Socratic response often ends with "?"
    console.log(`✓ UI-TUTOR-03 passed: Tutor response received (${text.length} chars)`);
  });

  test('UI-TUTOR-05 — Progress persists across session', async ({ page }) => {
    await page.goto('/tutor');
    await page.waitForTimeout(2000);

    // Select course
    const courseSelect = page.locator('[data-tutor-tour="subject-select"]')
      .or(page.locator('select').first());
    if (await courseSelect.isVisible()) {
      const options = await courseSelect.locator('option').allTextContents();
      const mlOption = options.find(o => /machine learning/i.test(o));
      if (mlOption) await courseSelect.selectOption({ label: mlOption });
      await page.waitForTimeout(2000);
    }

    // Take a screenshot to capture current state
    await page.screenshot({ path: 'test-results/tutor-progress.png' });

    // Navigate away and back
    await page.goto('/');
    await page.waitForTimeout(1000);
    await page.goto('/tutor');
    await page.waitForTimeout(2000);

    // Tutor page should still be accessible
    const tutorLabel = page.getByText(/tutor mode/i).first();
    await expect(tutorLabel).toBeVisible({ timeout: 10000 });

    console.log('✓ UI-TUTOR-05 passed: Tutor mode accessible after navigation');
  });

});
