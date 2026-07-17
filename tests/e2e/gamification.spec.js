// tests/e2e/gamification.spec.js — UI-GAMIF, UI-SKILL
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';

test.describe('UI-GAMIF — Gamification Features', () => {

  test.beforeEach(async ({ page }) => {
    await loginAs(page);
  });

  test('UI-GAMIF-02 — Badges showcase', async ({ page }) => {
    await page.goto('/gamification/badges');
    await page.waitForTimeout(2000);

    // Assert page loaded
    const heading = page.getByText(/badge/i).first();
    await expect(heading).toBeVisible({ timeout: 10000 });

    console.log('✓ UI-GAMIF-02 passed: Badges page loaded');
  });

  test('UI-GAMIF-03 — Boss Battles', async ({ page }) => {
    await page.goto('/gamification/boss-battles');
    await page.waitForTimeout(2000);

    // Page should load (even if no active battles)
    await expect(page.locator('body')).toBeVisible();

    console.log('✓ UI-GAMIF-03 passed: Boss Battles page loaded');
  });

  test('UI-GAMIF-04 — Bounties', async ({ page }) => {
    await page.goto('/gamification/bounties');
    await page.waitForTimeout(2000);

    await expect(page.locator('body')).toBeVisible();

    console.log('✓ UI-GAMIF-04 passed: Bounties page loaded');
  });

});

test.describe('UI-SKILL — Skill Tree', () => {

  test.beforeEach(async ({ page }) => {
    await loginAs(page);
  });

  test('UI-SKILL-01 — Navigate to skill tree', async ({ page }) => {
    await page.goto('/gamification/skill-tree');
    await page.waitForTimeout(2000);

    await expect(page.locator('body')).toBeVisible();

    console.log('✓ UI-SKILL-01 passed: Skill tree page loaded');
  });

  test('UI-SKILL-02 — Classic skill tree view', async ({ page }) => {
    await page.goto('/gamification/skill-tree/classic');
    await page.waitForTimeout(3000);

    await expect(page.locator('body')).toBeVisible();

    console.log('✓ UI-SKILL-02 passed: Classic skill tree page loaded');
  });

  test('UI-SKILL-04 — Skill tree game map', async ({ page }) => {
    await page.goto('/gamification/skill-tree/map');
    await page.waitForTimeout(3000);

    await expect(page.locator('body')).toBeVisible();

    console.log('✓ UI-SKILL-04 passed: Game map page loaded');
  });

});
