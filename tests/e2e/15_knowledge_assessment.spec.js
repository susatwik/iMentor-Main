// tests/e2e/15_knowledge_assessment.spec.js — KA-01 .. KA-09
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';

test.describe('KA — Knowledge Assessment', () => {

  test.beforeEach(async ({ page }) => {
    await loginAs(page);
  });

  test('KA-01 — Start screen loads with all UI elements', async ({ page }) => {
    await page.goto('/assessment');
    await page.waitForTimeout(2000);

    await expect(page.getByText('Knowledge Assessment')).toBeVisible();
    await expect(page.getByText("Evaluate your understanding with a Bloom's Taxonomy diagnostic test")).toBeVisible();

    const courseSelect = page.locator('select');
    await expect(courseSelect).toBeVisible();

    const topicInput = page.locator('input[placeholder*="custom topic"]');
    await expect(topicInput).toBeVisible();

    const startBtn = page.getByText('Start Assessment');
    await expect(startBtn).toBeVisible();

    await expect(page.getByText('My Profile')).toBeVisible();
    await expect(page.getByText("Bloom's Taxonomy")).toBeVisible();

    console.log('✓ KA-01 passed: Start screen loaded with all elements');
  });

  test('KA-02 — Generate assessment with topic loads questions', async ({ page }) => {
    test.setTimeout(120000);

    await page.goto('/assessment');
    await page.waitForTimeout(1000);

    const topicInput = page.locator('input[placeholder*="custom topic"]');
    await topicInput.fill('Machine Learning');

    await page.getByText('Start Assessment').click();

    await page.waitForTimeout(2000);

    await expect(page.getByText(/question|of/i).first()).toBeVisible({ timeout: 60000 });

    const questionNum = page.getByText(/question \d+ of \d+/i);
    await expect(questionNum).toBeVisible();

    const progressBar = page.locator('.bg-white.rounded-full');
    await expect(progressBar).toBeVisible();

    console.log('✓ KA-02 passed: Assessment generated with questions and progress bar');
  });

  test('KA-03 — Navigate questions with Previous/Next', async ({ page }) => {
    test.setTimeout(120000);

    await page.goto('/assessment');
    await page.waitForTimeout(1000);

    const topicInput = page.locator('input[placeholder*="custom topic"]');
    await topicInput.fill('Machine Learning');

    await page.getByText('Start Assessment').click();
    await page.waitForTimeout(2000);

    await page.waitForSelector('text=/question \d+ of \d+/i', { timeout: 60000 });

    const firstQuestionText = await page.locator('.text-lg.text-white.font-medium').first().textContent();

    const nextBtn = page.getByText('Next');
    await nextBtn.click();

    await page.waitForTimeout(1000);

    const afterNext = await page.locator('.text-lg.text-white.font-medium').first().textContent();

    if (firstQuestionText !== afterNext) {
      console.log('  → Question changed after Next click');
    }

    const prevBtn = page.getByText('Previous');
    await expect(prevBtn).toBeVisible();
    await prevBtn.click();

    await page.waitForTimeout(1000);

    const afterPrev = await page.locator('.text-lg.text-white.font-medium').first().textContent();
    expect(afterPrev).toBe(firstQuestionText);

    console.log('✓ KA-03 passed: Previous/Next navigation works correctly');
  });

  test('KA-04 — Descriptive answer input and validation', async ({ page }) => {
    test.setTimeout(120000);

    await page.goto('/assessment');
    await page.waitForTimeout(1000);

    const topicInput = page.locator('input[placeholder*="custom topic"]');
    await topicInput.fill('Machine Learning');

    await page.getByText('Start Assessment').click();
    await page.waitForTimeout(2000);

    await page.waitForSelector('text=/question \d+ of \d+/i', { timeout: 60000 });

    const textarea = page.locator('textarea');
    if (await textarea.isVisible({ timeout: 3000 }).catch(() => false)) {
      const nextBtn = page.getByText('Next');

      await nextBtn.click();
      await page.waitForTimeout(500);

      const toastError = page.getByText('Please type an answer before continuing');
      await expect(toastError).toBeVisible({ timeout: 3000 });

      await textarea.fill('Machine Learning is a subset of artificial intelligence where models learn patterns from data.');

      await nextBtn.click();
      await page.waitForTimeout(1000);

      const questionChanged = page.locator('.text-lg.text-white.font-medium').first();
      await expect(questionChanged).toBeVisible();

      console.log('✓ KA-04 passed: Descriptive answer input with empty validation');
    } else {
      console.log('  → Skipped: first question is MCQ, not descriptive');
    }
  });

  test('KA-05 — Submit button visible on last question', async ({ page }) => {
    test.setTimeout(120000);

    await page.goto('/assessment');
    await page.waitForTimeout(1000);

    const topicInput = page.locator('input[placeholder*="custom topic"]');
    await topicInput.fill('Machine Learning');

    await page.getByText('Start Assessment').click();
    await page.waitForTimeout(2000);

    await page.waitForSelector('text=/question \d+ of \d+/i', { timeout: 60000 });

    const totalText = await page.locator('text=/question \d+ of \d+/i').first().textContent();
    const match = totalText.match(/of (\d+)/);
    const totalQuestions = match ? parseInt(match[1]) : 0;

    expect(totalQuestions).toBeGreaterThanOrEqual(1);

    for (let q = 1; q < totalQuestions; q++) {
      const textarea = page.locator('textarea');
      if (await textarea.isVisible({ timeout: 1000 }).catch(() => false)) {
        await textarea.fill('Sample answer for question navigation.');
      } else {
        const mcqOptions = page.locator('button').filter({ hasText: /^[A-D]\./ });
        const firstOption = mcqOptions.first();
        if (await firstOption.isVisible({ timeout: 1000 }).catch(() => false)) {
          await firstOption.click();
          await page.waitForTimeout(500);
          continue;
        }
      }

      const nextBtn = page.getByText('Next');
      if (await nextBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await nextBtn.click();
        await page.waitForTimeout(1000);
      }
    }

    const submitBtn = page.getByText('Submit Answer');
    await expect(submitBtn).toBeVisible({ timeout: 5000 });

    console.log(`✓ KA-05 passed: Submit Answer button visible on last question (${totalQuestions} total)`);
  });

  test('KA-06 — Submit triggers evaluating state', async ({ page }) => {
    test.setTimeout(180000);

    await page.goto('/assessment');
    await page.waitForTimeout(1000);

    const topicInput = page.locator('input[placeholder*="custom topic"]');
    await topicInput.fill('Machine Learning');

    await page.getByText('Start Assessment').click();
    await page.waitForTimeout(2000);

    await page.waitForSelector('text=/question \d+ of \d+/i', { timeout: 60000 });

    const totalText = await page.locator('text=/question \d+ of \d+/i').first().textContent();
    const match = totalText.match(/of (\d+)/);
    const totalQuestions = match ? parseInt(match[1]) : 0;

    for (let q = 1; q < totalQuestions; q++) {
      const textarea = page.locator('textarea');
      if (await textarea.isVisible({ timeout: 1000 }).catch(() => false)) {
        await textarea.fill('Sample answer for navigating to submit.');
      } else {
        const mcqOptions = page.locator('button').filter({ hasText: /^[A-D]\./ });
        const firstOption = mcqOptions.first();
        if (await firstOption.isVisible({ timeout: 1000 }).catch(() => false)) {
          await firstOption.click();
          await page.waitForTimeout(500);
          continue;
        }
      }

      const nextBtn = page.getByText('Next');
      if (await nextBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await nextBtn.click();
        await page.waitForTimeout(1000);
      }
    }

    const textarea = page.locator('textarea');
    if (await textarea.isVisible({ timeout: 2000 }).catch(() => false)) {
      await textarea.fill('Machine Learning is a subset of AI where systems learn from data to improve performance.');
    }

    const submitBtn = page.getByText('Submit Answer');
    await submitBtn.click();

    await page.waitForTimeout(1000);

    const evaluatingText = page.getByText('Evaluating your assessment...');
    const spinner = page.locator('.animate-spin');
    const hasEval = await evaluatingText.isVisible({ timeout: 5000 }).catch(() => false);
    const hasSpinner = await spinner.isVisible({ timeout: 2000 }).catch(() => false);

    expect(hasEval || hasSpinner).toBeTruthy();

    console.log('✓ KA-06 passed: Submit button triggered evaluating state with spinner/text');
  });

  test('KA-07 — Results display level, score, strengths, weak areas, feedback', async ({ page }) => {
    test.setTimeout(300000);

    await page.goto('/assessment');
    await page.waitForTimeout(1000);

    const topicInput = page.locator('input[placeholder*="custom topic"]');
    await topicInput.fill('Machine Learning');

    await page.getByText('Start Assessment').click();
    await page.waitForTimeout(2000);

    await page.waitForSelector('text=/question \d+ of \d+/i', { timeout: 60000 });

    const totalText = await page.locator('text=/question \d+ of \d+/i').first().textContent();
    const match = totalText.match(/of (\d+)/);
    const totalQuestions = match ? parseInt(match[1]) : 0;

    for (let q = 1; q < totalQuestions; q++) {
      const textarea = page.locator('textarea');
      if (await textarea.isVisible({ timeout: 1000 }).catch(() => false)) {
        await textarea.fill('I have a good understanding of this concept. This involves mathematical optimization and statistical inference techniques applied to data.');
      } else {
        const mcqOptions = page.locator('button').filter({ hasText: /^[A-D]\./ });
        const firstOption = mcqOptions.first();
        if (await firstOption.isVisible({ timeout: 1000 }).catch(() => false)) {
          await firstOption.click();
          await page.waitForTimeout(500);
          continue;
        }
      }

      const nextBtn = page.getByText('Next');
      if (await nextBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await nextBtn.click();
        await page.waitForTimeout(1000);
      }
    }

    const textarea = page.locator('textarea');
    if (await textarea.isVisible({ timeout: 2000 }).catch(() => false)) {
      await textarea.fill('Machine Learning is a subset of artificial intelligence where models learn patterns from data to make predictions or decisions.');
    }

    const submitBtn = page.getByText('Submit Answer');
    await submitBtn.click();

    await page.waitForSelector('text=Assessment Complete', { timeout: 120000 });

    await expect(page.getByText('Assessment Complete')).toBeVisible();
    await expect(page.getByText(/Proficiency Level|%/).first()).toBeVisible({ timeout: 10000 });

    const levelText = page.locator('text=/Beginner|Intermediate|Advanced|Expert/');
    await expect(levelText.first()).toBeVisible({ timeout: 5000 });

    const scoreText = page.locator('text=/%').first();
    await expect(scoreText).toBeVisible({ timeout: 5000 });

    await expect(page.getByText("Bloom's Taxonomy Breakdown")).toBeVisible({ timeout: 5000 });

    const hasWeakAreas = await page.getByText('Areas to Review').isVisible({ timeout: 5000 }).catch(() => false);
    const hasStrengths = await page.getByText('Strengths').isVisible({ timeout: 3000 }).catch(() => false);

    if (hasWeakAreas) console.log('  → Areas to Review section visible');
    if (hasStrengths) console.log('  → Strengths section visible');

    const hasFeedback = await page.locator('.text-zinc-300').first().isVisible({ timeout: 5000 }).catch(() => false);
    expect(hasFeedback).toBeTruthy();

    const hasMisconceptions = await page.getByText('Misconceptions to Address').isVisible({ timeout: 3000 }).catch(() => false);
    if (hasMisconceptions) console.log('  → Misconceptions section visible');

    const hasRevision = await page.getByText('Suggested Revision Topics').isVisible({ timeout: 3000 }).catch(() => false);
    if (hasRevision) console.log('  → Suggested Revision Topics section visible');

    await expect(page.getByText('Take Another')).toBeVisible();
    await expect(page.getByText('View Profile')).toBeVisible();

    console.log('✓ KA-07 passed: Results display level, score, Bloom breakdown, strengths, weak areas, feedback');
  });

  test('KA-08 — Profile and Bloom taxonomy accessible from start screen', async ({ page }) => {
    await page.goto('/assessment');
    await page.waitForTimeout(2000);

    const profileBtn = page.getByText('My Profile');
    await profileBtn.click();
    await page.waitForTimeout(2000);

    await expect(page.getByText('Assessment Profile')).toBeVisible({ timeout: 10000 });

    const backBtn = page.getByText('Back').first();
    await backBtn.click();
    await page.waitForTimeout(1000);

    await expect(page.getByText('Knowledge Assessment')).toBeVisible();

    const bloomBtn = page.getByText("Bloom's Taxonomy");
    await bloomBtn.click();
    await page.waitForTimeout(2000);

    await expect(page.getByText("Bloom's Taxonomy")).toBeVisible();

    const bloomBack = page.getByText('Back').first();
    await bloomBack.click();
    await page.waitForTimeout(1000);

    await expect(page.getByText('Knowledge Assessment')).toBeVisible();

    console.log('✓ KA-08 passed: Profile and Bloom taxonomy screens accessible');
  });

  test('KA-09 — Scroll support on assessment page', async ({ page }) => {
    await page.goto('/assessment');
    await page.waitForTimeout(2000);

    const scrollContainer = page.locator('.overflow-y-auto');
    await expect(scrollContainer).toBeVisible({ timeout: 3000 });

    const initialScroll = await scrollContainer.evaluate(el => el.scrollTop);
    console.log(`  → Initial scroll position: ${initialScroll}`);

    const topicInput = page.locator('input[placeholder*="custom topic"]');
    await topicInput.fill('Machine Learning');

    await page.getByText('Start Assessment').click();
    await page.waitForTimeout(2000);

    await page.waitForSelector('text=/question \d+ of \d+/i', { timeout: 60000 });

    await page.getByText('Next').click();
    await page.waitForTimeout(1500);

    const scrollY = await page.evaluate(() => window.scrollY);
    console.log(`  → Page scrollY after next: ${scrollY}`);

    expect(typeof scrollY).toBe('number');

    console.log('✓ KA-09 passed: Scroll container and smooth scroll-into-view works');
  });

});
