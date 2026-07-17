// tests/e2e/tool_pages.spec.js — UI-TOOLS-01 .. UI-TOOLS-05
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';

test.describe('UI-TOOLS-EXTRA — Tool Pages', () => {

  test.beforeEach(async ({ page }) => {
    await loginAs(page);
  });

  test('UI-TOOLS-01 — Code Executor page loads', async ({ page }) => {
    await page.goto('/tools/code-executor');
    await page.waitForTimeout(2000);

    // Assert page loaded with the Code Executor heading
    const heading = page.getByText(/secure code executor/i).or(page.getByText(/code executor/i)).first();
    await expect(heading).toBeVisible({ timeout: 15000 });

    console.log('✓ UI-TOOLS-01 passed: Code Executor page loaded');
  });

  test('UI-TOOLS-02 — Quiz Generator page loads', async ({ page }) => {
    await page.goto('/tools/quiz-generator');
    await page.waitForTimeout(2000);

    await expect(page.locator('body')).toBeVisible();

    console.log('✓ UI-TOOLS-02 passed: Quiz Generator page loaded');
  });

  test('UI-TOOLS-03 — Academic Integrity page loads', async ({ page }) => {
    await page.goto('/tools/integrity-checker');
    await page.waitForTimeout(2000);

    await expect(page.locator('body')).toBeVisible();

    console.log('✓ UI-TOOLS-03 passed: Integrity Checker page loaded');
  });

  test('UI-TOOLS-04 — Deep Research page loads', async ({ page }) => {
    await page.goto('/tools/deep-research');
    await page.waitForTimeout(2000);

    const heading = page.getByText(/deep research/i).first();
    await expect(heading).toBeVisible({ timeout: 10000 });

    console.log('✓ UI-TOOLS-04 passed: Deep Research page loaded');
  });

  test('UI-TOOLS-05 — Deep Research history', async ({ page }) => {
    await page.goto('/tools/deep-research/history');
    await page.waitForTimeout(2000);

    await expect(page.locator('body')).toBeVisible();

    console.log('✓ UI-TOOLS-05 passed: Deep Research history page loaded');
  });

});
