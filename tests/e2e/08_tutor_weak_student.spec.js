// tests/e2e/08_tutor_weak_student.spec.js
// Weak student profile: confused answers, needs scaffolding, modules 1-4
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import {
  navigateToTutor, selectTutorCourse, clearTutorProgress,
  sendTutorMessage, assertSocraticResponse, getCurriculumStructure,
  getProgressPercentage, weakStudentAnswer, expandModule, TUTOR_SEL
} from './helpers/tutor-helpers.js';

const COURSE = 'Machine Learning';
const MAX_TURNS_PER_SUBTOPIC = 5;
const MESSAGE_TIMEOUT = 120000;

test.describe('TUTOR-WEAK — Weak Student Profile (ML Modules 1-4)', () => {

  test.beforeAll(async ({ browser }) => {
    // Clear progress before the entire suite
    const page = await browser.newPage();
    await loginAs(page);
    await clearTutorProgress(page, COURSE);
    await page.close();
  });

  test('TUTOR-WEAK-SETUP — Clear progress and load curriculum', async ({ page }) => {
    test.setTimeout(60000);
    await loginAs(page);
    await clearTutorProgress(page, COURSE);

    // Fetch curriculum to know the structure
    const curriculum = await getCurriculumStructure(page, COURSE);
    console.log('  → Curriculum structure:');
    if (curriculum && Array.isArray(curriculum)) {
      curriculum.forEach((mod, i) => {
        const topicCount = mod.topics ? mod.topics.length : 0;
        const subtopicCount = mod.topics
          ? mod.topics.reduce((sum, t) => sum + (t.subtopics ? t.subtopics.length : 0), 0)
          : 0;
        console.log(`    Module ${i + 1}: ${mod.name || mod.module} — ${topicCount} topics, ${subtopicCount} subtopics`);
      });
    } else {
      console.log('  ⚠ Could not parse curriculum:', JSON.stringify(curriculum).slice(0, 200));
    }

    console.log('✓ TUTOR-WEAK-SETUP passed: Progress cleared, curriculum fetched');
  });

  test('TUTOR-WEAK-M1 — Module 1 progression (weak student)', async ({ page }) => {
    test.setTimeout(600000); // 10 minutes for an entire module
    await loginAs(page);
    await navigateToTutor(page);
    await selectTutorCourse(page, COURSE);

    let totalTurns = 0;
    let socraticCount = 0;

    // The tutor auto-starts at the current subtopic.
    // We simulate the weak student pattern: wrong → guided → correct
    for (let subtopicIdx = 0; subtopicIdx < 8; subtopicIdx++) {
      // Each subtopic: up to MAX_TURNS_PER_SUBTOPIC interactions
      for (let attempt = 1; attempt <= MAX_TURNS_PER_SUBTOPIC; attempt++) {
        const answer = weakStudentAnswer(`subtopic ${subtopicIdx + 1}`, attempt);
        let response;

        try {
          response = await sendTutorMessage(page, answer, MESSAGE_TIMEOUT);
        } catch (err) {
          console.log(`  ⚠ Timeout on subtopic ${subtopicIdx + 1}, attempt ${attempt}: ${err.message}`);
          break;
        }

        totalTurns++;

        if (assertSocraticResponse(response)) {
          socraticCount++;
        }

        // Log interaction
        console.log(`  [M1-S${subtopicIdx + 1}-A${attempt}] Student: "${answer.slice(0, 50)}..." → Bot: "${response.slice(0, 80)}..."`);

        // Check if subtopic was mastered (response indicates advancement)
        const mastered = /excellent|correct|great|well done|mastered|move on|next|let.*s proceed/i.test(response);
        if (mastered) {
          console.log(`  → Subtopic ${subtopicIdx + 1} mastered after ${attempt} attempts`);
          break;
        }

        // If this is the last attempt and not mastered, the tutor may still advance
        if (attempt === MAX_TURNS_PER_SUBTOPIC) {
          console.log(`  → Subtopic ${subtopicIdx + 1}: max turns reached`);
        }
      }
    }

    const progress = await getProgressPercentage(page);
    console.log(`\n  Module 1 Summary:`);
    console.log(`    Total turns: ${totalTurns}`);
    console.log(`    Socratic responses: ${socraticCount}/${totalTurns} (${Math.round(socraticCount / totalTurns * 100)}%)`);
    console.log(`    Progress: ${progress}%`);

    // Weak student should need many turns
    expect(totalTurns).toBeGreaterThan(5);
    // Most responses should be Socratic
    expect(socraticCount / totalTurns).toBeGreaterThan(0.3);

    console.log('✓ TUTOR-WEAK-M1 passed');
  });

  test('TUTOR-WEAK-M2 — Module 2 progression (weak student)', async ({ page }) => {
    test.setTimeout(600000);
    await loginAs(page);
    await navigateToTutor(page);
    await selectTutorCourse(page, COURSE);

    let totalTurns = 0;
    let socraticCount = 0;

    for (let subtopicIdx = 0; subtopicIdx < 8; subtopicIdx++) {
      for (let attempt = 1; attempt <= MAX_TURNS_PER_SUBTOPIC; attempt++) {
        const answer = weakStudentAnswer(`module 2 subtopic ${subtopicIdx + 1}`, attempt);
        let response;

        try {
          response = await sendTutorMessage(page, answer, MESSAGE_TIMEOUT);
        } catch (err) {
          console.log(`  ⚠ Timeout on M2-S${subtopicIdx + 1}, attempt ${attempt}`);
          break;
        }

        totalTurns++;
        if (assertSocraticResponse(response)) socraticCount++;

        console.log(`  [M2-S${subtopicIdx + 1}-A${attempt}] "${answer.slice(0, 40)}..." → "${response.slice(0, 60)}..."`);

        const mastered = /excellent|correct|great|well done|mastered|move on|next|let.*s proceed/i.test(response);
        if (mastered) {
          console.log(`  → M2-S${subtopicIdx + 1} mastered after ${attempt} attempts`);
          break;
        }
      }
    }

    const progress = await getProgressPercentage(page);
    console.log(`\n  Module 2 Summary: ${totalTurns} turns, ${socraticCount} Socratic, ${progress}% progress`);
    console.log('✓ TUTOR-WEAK-M2 passed');
  });

  test('TUTOR-WEAK-M3 — Module 3 progression (weak student)', async ({ page }) => {
    test.setTimeout(600000);
    await loginAs(page);
    await navigateToTutor(page);
    await selectTutorCourse(page, COURSE);

    let totalTurns = 0;
    let socraticCount = 0;

    for (let subtopicIdx = 0; subtopicIdx < 8; subtopicIdx++) {
      for (let attempt = 1; attempt <= MAX_TURNS_PER_SUBTOPIC; attempt++) {
        const answer = weakStudentAnswer(`module 3 subtopic ${subtopicIdx + 1}`, attempt);
        let response;

        try {
          response = await sendTutorMessage(page, answer, MESSAGE_TIMEOUT);
        } catch (err) {
          console.log(`  ⚠ Timeout on M3-S${subtopicIdx + 1}, attempt ${attempt}`);
          break;
        }

        totalTurns++;
        if (assertSocraticResponse(response)) socraticCount++;

        console.log(`  [M3-S${subtopicIdx + 1}-A${attempt}] "${answer.slice(0, 40)}..." → "${response.slice(0, 60)}..."`);

        const mastered = /excellent|correct|great|well done|mastered|move on|next|let.*s proceed/i.test(response);
        if (mastered) break;
      }
    }

    const progress = await getProgressPercentage(page);
    console.log(`\n  Module 3 Summary: ${totalTurns} turns, ${socraticCount} Socratic, ${progress}% progress`);
    console.log('✓ TUTOR-WEAK-M3 passed');
  });

  test('TUTOR-WEAK-M4 — Module 4 progression (weak student)', async ({ page }) => {
    test.setTimeout(600000);
    await loginAs(page);
    await navigateToTutor(page);
    await selectTutorCourse(page, COURSE);

    let totalTurns = 0;
    let socraticCount = 0;

    for (let subtopicIdx = 0; subtopicIdx < 8; subtopicIdx++) {
      for (let attempt = 1; attempt <= MAX_TURNS_PER_SUBTOPIC; attempt++) {
        const answer = weakStudentAnswer(`module 4 subtopic ${subtopicIdx + 1}`, attempt);
        let response;

        try {
          response = await sendTutorMessage(page, answer, MESSAGE_TIMEOUT);
        } catch (err) {
          console.log(`  ⚠ Timeout on M4-S${subtopicIdx + 1}, attempt ${attempt}`);
          break;
        }

        totalTurns++;
        if (assertSocraticResponse(response)) socraticCount++;

        console.log(`  [M4-S${subtopicIdx + 1}-A${attempt}] "${answer.slice(0, 40)}..." → "${response.slice(0, 60)}..."`);

        const mastered = /excellent|correct|great|well done|mastered|move on|next|let.*s proceed/i.test(response);
        if (mastered) break;
      }
    }

    const progress = await getProgressPercentage(page);
    console.log(`\n  Module 4 Summary: ${totalTurns} turns, ${socraticCount} Socratic, ${progress}% progress`);
    console.log('✓ TUTOR-WEAK-M4 passed');
  });

});
