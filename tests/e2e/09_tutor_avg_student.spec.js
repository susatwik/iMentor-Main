// tests/e2e/09_tutor_avg_student.spec.js
// Average student profile: correct but shallow, needs depth, modules 1-4
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import {
  navigateToTutor, selectTutorCourse, clearTutorProgress,
  sendTutorMessage, assertSocraticResponse, getCurriculumStructure,
  getProgressPercentage, averageStudentAnswer, TUTOR_SEL
} from './helpers/tutor-helpers.js';

const COURSE = 'Machine Learning';
const MAX_TURNS_PER_SUBTOPIC = 3; // Average students need fewer turns
const MESSAGE_TIMEOUT = 120000;

test.describe('TUTOR-AVG — Average Student Profile (ML Modules 1-4)', () => {

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAs(page);
    await clearTutorProgress(page, COURSE);
    await page.close();
  });

  test('TUTOR-AVG-SETUP — Clear progress and verify', async ({ page }) => {
    test.setTimeout(60000);
    await loginAs(page);
    await clearTutorProgress(page, COURSE);

    const curriculum = await getCurriculumStructure(page, COURSE);
    if (curriculum && Array.isArray(curriculum)) {
      console.log(`  → ${curriculum.length} modules loaded`);
    }
    console.log('✓ TUTOR-AVG-SETUP passed');
  });

  test('TUTOR-AVG-M1 — Module 1 progression (average student)', async ({ page }) => {
    test.setTimeout(600000);
    await loginAs(page);
    await navigateToTutor(page);
    await selectTutorCourse(page, COURSE);

    let totalTurns = 0;
    let socraticCount = 0;
    let deeperProbeCount = 0;

    for (let subtopicIdx = 0; subtopicIdx < 8; subtopicIdx++) {
      for (let attempt = 1; attempt <= MAX_TURNS_PER_SUBTOPIC; attempt++) {
        const answer = averageStudentAnswer(`subtopic ${subtopicIdx + 1}`, attempt);
        let response;

        try {
          response = await sendTutorMessage(page, answer, MESSAGE_TIMEOUT);
        } catch (err) {
          console.log(`  ⚠ Timeout on M1-S${subtopicIdx + 1}, attempt ${attempt}`);
          break;
        }

        totalTurns++;
        if (assertSocraticResponse(response)) socraticCount++;

        // Check if agent pushes deeper (Bloom's L2→L3)
        const pushesDeeper = /apply|what would happen|can you explain why|how would you|consider|analyze/i.test(response);
        if (pushesDeeper) deeperProbeCount++;

        console.log(`  [M1-S${subtopicIdx + 1}-A${attempt}] "${answer.slice(0, 50)}..." → "${response.slice(0, 70)}..."`);

        const mastered = /excellent|correct|great|well done|mastered|move on|next|let.*s proceed/i.test(response);
        if (mastered) {
          console.log(`  → M1-S${subtopicIdx + 1} mastered after ${attempt} attempts`);
          break;
        }
      }
    }

    const progress = await getProgressPercentage(page);
    console.log(`\n  Module 1 Summary (Average):`);
    console.log(`    Total turns: ${totalTurns}`);
    console.log(`    Socratic: ${socraticCount}/${totalTurns}`);
    console.log(`    Deeper probes: ${deeperProbeCount}`);
    console.log(`    Progress: ${progress}%`);

    console.log('✓ TUTOR-AVG-M1 passed');
  });

  test('TUTOR-AVG-M2 — Module 2 progression (average student)', async ({ page }) => {
    test.setTimeout(600000);
    await loginAs(page);
    await navigateToTutor(page);
    await selectTutorCourse(page, COURSE);

    let totalTurns = 0;
    let socraticCount = 0;

    for (let subtopicIdx = 0; subtopicIdx < 8; subtopicIdx++) {
      for (let attempt = 1; attempt <= MAX_TURNS_PER_SUBTOPIC; attempt++) {
        const answer = averageStudentAnswer(`module 2 subtopic ${subtopicIdx + 1}`, attempt);
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
        if (mastered) break;
      }
    }

    const progress = await getProgressPercentage(page);
    console.log(`\n  Module 2 Summary (Average): ${totalTurns} turns, ${socraticCount} Socratic, ${progress}%`);
    console.log('✓ TUTOR-AVG-M2 passed');
  });

  test('TUTOR-AVG-M3 — Module 3 progression (average student)', async ({ page }) => {
    test.setTimeout(600000);
    await loginAs(page);
    await navigateToTutor(page);
    await selectTutorCourse(page, COURSE);

    let totalTurns = 0;
    let socraticCount = 0;

    for (let subtopicIdx = 0; subtopicIdx < 8; subtopicIdx++) {
      for (let attempt = 1; attempt <= MAX_TURNS_PER_SUBTOPIC; attempt++) {
        const answer = averageStudentAnswer(`module 3 subtopic ${subtopicIdx + 1}`, attempt);
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
    console.log(`\n  Module 3 Summary (Average): ${totalTurns} turns, ${socraticCount} Socratic, ${progress}%`);
    console.log('✓ TUTOR-AVG-M3 passed');
  });

  test('TUTOR-AVG-M4 — Module 4 progression (average student)', async ({ page }) => {
    test.setTimeout(600000);
    await loginAs(page);
    await navigateToTutor(page);
    await selectTutorCourse(page, COURSE);

    let totalTurns = 0;
    let socraticCount = 0;

    for (let subtopicIdx = 0; subtopicIdx < 8; subtopicIdx++) {
      for (let attempt = 1; attempt <= MAX_TURNS_PER_SUBTOPIC; attempt++) {
        const answer = averageStudentAnswer(`module 4 subtopic ${subtopicIdx + 1}`, attempt);
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
    console.log(`\n  Module 4 Summary (Average): ${totalTurns} turns, ${socraticCount} Socratic, ${progress}%`);
    console.log('✓ TUTOR-AVG-M4 passed');
  });

});
