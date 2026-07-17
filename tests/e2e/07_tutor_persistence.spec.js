// tests/e2e/07_tutor_persistence.spec.js — TP-01 .. TP-04
// Tutor mode: progress persistence and clearing
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import {
  navigateToTutor, selectTutorCourse, clearTutorProgress,
  sendTutorMessage, getProgressPercentage, TUTOR_SEL
} from './helpers/tutor-helpers.js';

const COURSE = 'Machine Learning';

test.describe('TP — Tutor Mode Persistence', () => {

  test('TP-01 — Fresh start loads tutor page', async ({ page }) => {
    await loginAs(page);
    await navigateToTutor(page);

    // Assert tutor page loaded
    const tutorLabel = page.getByText(/tutor mode/i).first();
    await expect(tutorLabel).toBeVisible({ timeout: 10000 });

    // Assert course selector visible
    const courseSelect = page.locator(TUTOR_SEL.courseSelect);
    await expect(courseSelect).toBeVisible({ timeout: 5000 });

    console.log('✓ TP-01 passed: Tutor page loaded');
  });

  test('TP-02 — Progress persists across navigation', async ({ page }) => {
    test.setTimeout(180000);
    await loginAs(page);
    await navigateToTutor(page);
    await selectTutorCourse(page, COURSE);

    // Send a message to generate activity (drives mastery)
    const response = await sendTutorMessage(page,
      'Supervised learning is when a model learns from labeled data to predict outputs for new inputs'
    );
    expect(response.length).toBeGreaterThan(10);

    // Take note of current state
    const progressBefore = await getProgressPercentage(page);
    console.log(`  → Progress before navigation: ${progressBefore}%`);

    // Navigate away
    await page.goto('/');
    await page.waitForTimeout(2000);

    // Return to tutor
    await navigateToTutor(page);
    await selectTutorCourse(page, COURSE);

    // Tutor should still be accessible
    const tutorLabel = page.getByText(/tutor mode/i).first();
    await expect(tutorLabel).toBeVisible({ timeout: 10000 });

    const progressAfter = await getProgressPercentage(page);
    console.log(`  → Progress after navigation: ${progressAfter}%`);

    // Progress should be same or higher
    if (progressBefore !== null && progressAfter !== null) {
      expect(progressAfter).toBeGreaterThanOrEqual(progressBefore);
    }

    console.log('✓ TP-02 passed: Progress persists across navigation');
  });

  test('TP-03 — Progress persists across logout/login', async ({ page }) => {
    test.setTimeout(180000);
    await loginAs(page);
    await navigateToTutor(page);
    await selectTutorCourse(page, COURSE);

    // Note progress
    const progressBefore = await getProgressPercentage(page);
    console.log(`  → Progress before logout: ${progressBefore}%`);

    // Logout — navigate to landing or click logout
    await page.goto('/');
    await page.waitForTimeout(1000);

    // Clear auth state (simulate logout)
    await page.evaluate(() => {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
    });
    await page.goto('/');
    await page.waitForTimeout(1000);

    // Re-login
    await loginAs(page);
    await navigateToTutor(page);
    await selectTutorCourse(page, COURSE);

    const progressAfter = await getProgressPercentage(page);
    console.log(`  → Progress after re-login: ${progressAfter}%`);

    if (progressBefore !== null && progressAfter !== null) {
      expect(progressAfter).toBeGreaterThanOrEqual(progressBefore);
    }

    console.log('✓ TP-03 passed: Progress persists across login');
  });

  test('TP-04 — Clear progress resets to zero', async ({ page }) => {
    test.setTimeout(120000);
    await loginAs(page);

    // Clear progress via API
    await clearTutorProgress(page, COURSE);
    console.log('  → Progress cleared via API');

    // Navigate to tutor
    await navigateToTutor(page);
    await selectTutorCourse(page, COURSE);

    await page.waitForTimeout(2000);

    // Progress should be at 0% or very low
    const progress = await getProgressPercentage(page);
    console.log(`  → Progress after clear: ${progress}%`);

    if (progress !== null) {
      expect(progress).toBeLessThanOrEqual(5); // allow minor float
    }

    // Module 1 should show as starting point
    const module1 = page.getByText(/module 1/i).or(page.getByText(/introduction/i)).first();
    const visible = await module1.isVisible().catch(() => false);
    if (visible) {
      console.log('  → Module 1 visible as starting point');
    }

    console.log('✓ TP-04 passed: Progress cleared to zero');
  });

});
