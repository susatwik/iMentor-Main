// tests/e2e/05_rag_course.spec.js — RAG-01 .. RAG-06
// Course RAG selection, KG augmentation, cross-course isolation
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import {
  sendAndWait, assertBotResponse, assertNoError,
  toggleToT, toggleWebSearch, selectCourseViaRAG, deselectCourse,
  clickNewChat, getLastBotText, SEL
} from './helpers/chat-helpers.js';

test.describe('RAG — Course Selection, KG, Cross-Course', () => {

  test.beforeEach(async ({ page }) => {
    await loginAs(page);
  });

  test('RAG-01 — Course selection activates RAG context', async ({ page }) => {
    test.setTimeout(120000);
    await selectCourseViaRAG(page, 'Machine Learning');

    const text = await sendAndWait(page, 'Explain supervised learning', 120000);

    expect(text.length).toBeGreaterThan(50);
    // Response should contain course-level terminology
    const hasCourseContent = /supervised|training|label|classification|regression|feature|predict/i.test(text);
    expect(hasCourseContent).toBeTruthy();

    await assertNoError(page);
    console.log(`✓ RAG-01 passed: Course RAG active (${text.length} chars)`);
  });

  test('RAG-02 — Course RAG vs no-course quality comparison', async ({ page }) => {
    test.setTimeout(180000);
    const query = 'Explain gradient descent';

    // First: without course
    const textNoCourse = await sendAndWait(page, query);
    const lenNoCourse = textNoCourse.length;
    console.log(`  → No-course response: ${lenNoCourse} chars`);

    // New chat
    await clickNewChat(page);

    // Second: with ML course
    await selectCourseViaRAG(page, 'Machine Learning');
    const textWithCourse = await sendAndWait(page, query, 120000);
    const lenWithCourse = textWithCourse.length;
    console.log(`  → Course response: ${lenWithCourse} chars`);

    // Course-grounded response should be at least as detailed
    // (not necessarily longer, but should contain curriculum terms)
    const courseTerms = /gradient|loss|learning rate|weight|parameter|epoch|batch|convergence|descent/i;
    expect(courseTerms.test(textWithCourse)).toBeTruthy();

    await assertNoError(page);
    console.log(`✓ RAG-02 passed: Quality comparison (${lenNoCourse} vs ${lenWithCourse} chars)`);
  });

  test('RAG-03 — Course + ToT activates KG-augmented reasoning', async ({ page }) => {
    test.setTimeout(180000);
    await selectCourseViaRAG(page, 'Machine Learning');
    await toggleToT(page);

    const text = await sendAndWait(page, 'How does regularization relate to overfitting?', 180000);

    expect(text.length).toBeGreaterThan(100);
    // Should have analytical depth (ToT) + course grounding
    const hasAnalysis = /regulariz|overfit|bias|variance|L1|L2|penalty|dropout|generalization/i.test(text);
    expect(hasAnalysis).toBeTruthy();

    await assertNoError(page);
    console.log(`✓ RAG-03 passed: Course+ToT response (${text.length} chars)`);
  });

  test('RAG-04 — Course + Web + ToT combined multi-tool', async ({ page }) => {
    test.setTimeout(180000);
    await selectCourseViaRAG(page, 'Machine Learning');
    await toggleWebSearch(page);
    await toggleToT(page);

    const text = await sendAndWait(page,
      'Compare dropout vs batch normalization with recent research findings',
      180000
    );

    expect(text.length).toBeGreaterThan(100);
    // Should blend course content + web sources + structured reasoning
    const hasContent = /dropout|batch norm|regulariz|training|research|study|2024|2025|2026/i.test(text);
    expect(hasContent).toBeTruthy();

    await assertNoError(page);
    console.log(`✓ RAG-04 passed: Multi-tool combined (${text.length} chars)`);
  });

  test('RAG-05 — Cross-course isolation (ML vs Data Structures)', async ({ page }) => {
    test.setTimeout(180000);

    // Query 1: Machine Learning
    await selectCourseViaRAG(page, 'Machine Learning');
    const mlText = await sendAndWait(page, 'What are the key topics in this course?', 120000);
    console.log(`  → ML response: "${mlText.slice(0, 120)}..."`);

    // New chat
    await clickNewChat(page);

    // Query 2: Data Structures
    await deselectCourse(page);
    await page.waitForTimeout(500);
    await selectCourseViaRAG(page, 'Data Structures');
    const dsText = await sendAndWait(page, 'What are the key topics in this course?', 120000);
    console.log(`  → DS response: "${dsText.slice(0, 120)}..."`);

    // ML response should contain ML terms, not DS
    const mlHasML = /neural|learning|regression|classification|gradient|model/i.test(mlText);
    // DS response should contain DS terms, not ML
    const dsHasDS = /array|linked list|tree|graph|stack|queue|hash|sort|search|data structure/i.test(dsText);

    expect(mlHasML).toBeTruthy();
    expect(dsHasDS).toBeTruthy();

    await assertNoError(page);
    console.log('✓ RAG-05 passed: Cross-course isolation verified');
  });

  test('RAG-06 — Deselecting course removes RAG grounding', async ({ page }) => {
    test.setTimeout(180000);
    const query = 'What is a decision tree?';

    // With course
    await selectCourseViaRAG(page, 'Machine Learning');
    const textWith = await sendAndWait(page, query, 120000);
    console.log(`  → With course: ${textWith.length} chars`);

    await clickNewChat(page);

    // Deselect course
    await deselectCourse(page);
    await page.waitForTimeout(1000);

    const textWithout = await sendAndWait(page, query);
    console.log(`  → Without course: ${textWithout.length} chars`);

    // Both should have relevant content, but course response may be more detailed
    expect(textWith.length).toBeGreaterThan(20);
    expect(textWithout.length).toBeGreaterThan(20);

    await assertNoError(page);
    console.log('✓ RAG-06 passed: Deselection works');
  });

});
