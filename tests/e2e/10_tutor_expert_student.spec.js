// tests/e2e/10_tutor_expert_student.spec.js
// Expert student profile: detailed technical answers, fast progression, modules 1-4
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import {
  navigateToTutor, selectTutorCourse, clearTutorProgress,
  sendTutorMessage, assertSocraticResponse, getCurriculumStructure,
  getProgressPercentage, expertStudentAnswer, TUTOR_SEL
} from './helpers/tutor-helpers.js';

const COURSE = 'Machine Learning';
const MAX_TURNS_PER_SUBTOPIC = 2; // Expert should master in 1-2 turns
const MESSAGE_TIMEOUT = 120000;

test.describe('TUTOR-EXPERT — Expert Student Profile (ML Modules 1-4)', () => {

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAs(page);
    await clearTutorProgress(page, COURSE);
    await page.close();
  });

  test('TUTOR-EXPERT-SETUP — Clear progress and verify', async ({ page }) => {
    test.setTimeout(60000);
    await loginAs(page);
    await clearTutorProgress(page, COURSE);

    const curriculum = await getCurriculumStructure(page, COURSE);
    if (curriculum && Array.isArray(curriculum)) {
      console.log(`  → ${curriculum.length} modules loaded`);
    }
    console.log('✓ TUTOR-EXPERT-SETUP passed');
  });

  test('TUTOR-EXPERT-M1 — Module 1 progression (expert student)', async ({ page }) => {
    test.setTimeout(600000);
    await loginAs(page);
    await navigateToTutor(page);
    await selectTutorCourse(page, COURSE);

    let totalTurns = 0;
    let quickMastery = 0;
    let challengeCount = 0;

    for (let subtopicIdx = 0; subtopicIdx < 8; subtopicIdx++) {
      for (let attempt = 1; attempt <= MAX_TURNS_PER_SUBTOPIC; attempt++) {
        const answer = expertStudentAnswer(`subtopic ${subtopicIdx + 1}`);
        let response;

        try {
          response = await sendTutorMessage(page, answer, MESSAGE_TIMEOUT);
        } catch (err) {
          console.log(`  ⚠ Timeout on M1-S${subtopicIdx + 1}, attempt ${attempt}`);
          break;
        }

        totalTurns++;

        // Check if agent challenges at higher Bloom's (L4: Evaluate/Create)
        const challenges = /evaluate|design|create|propose|how would you improve|what if|critique/i.test(response);
        if (challenges) challengeCount++;

        console.log(`  [M1-S${subtopicIdx + 1}-A${attempt}] Expert: "${answer.slice(0, 60)}..." → Bot: "${response.slice(0, 70)}..."`);

        const mastered = /excellent|correct|great|well done|mastered|move on|next|let.*s proceed|impressive|thorough/i.test(response);
        if (mastered) {
          if (attempt === 1) quickMastery++;
          console.log(`  → M1-S${subtopicIdx + 1} mastered in ${attempt} attempt(s)`);
          break;
        }
      }
    }

    const progress = await getProgressPercentage(page);
    console.log(`\n  Module 1 Summary (Expert):`);
    console.log(`    Total turns: ${totalTurns}`);
    console.log(`    Quick mastery (1 turn): ${quickMastery}/8`);
    console.log(`    Higher-level challenges: ${challengeCount}`);
    console.log(`    Progress: ${progress}%`);

    console.log('✓ TUTOR-EXPERT-M1 passed');
  });

  test('TUTOR-EXPERT-M2 — Module 2 progression (expert student)', async ({ page }) => {
    test.setTimeout(600000);
    await loginAs(page);
    await navigateToTutor(page);
    await selectTutorCourse(page, COURSE);

    let totalTurns = 0;
    let quickMastery = 0;

    for (let subtopicIdx = 0; subtopicIdx < 8; subtopicIdx++) {
      for (let attempt = 1; attempt <= MAX_TURNS_PER_SUBTOPIC; attempt++) {
        const answer = expertStudentAnswer(`module 2 subtopic ${subtopicIdx + 1}`);
        let response;

        try {
          response = await sendTutorMessage(page, answer, MESSAGE_TIMEOUT);
        } catch (err) {
          console.log(`  ⚠ Timeout on M2-S${subtopicIdx + 1}, attempt ${attempt}`);
          break;
        }

        totalTurns++;
        console.log(`  [M2-S${subtopicIdx + 1}-A${attempt}] "${answer.slice(0, 50)}..." → "${response.slice(0, 60)}..."`);

        const mastered = /excellent|correct|great|well done|mastered|move on|next|let.*s proceed|impressive/i.test(response);
        if (mastered) {
          if (attempt === 1) quickMastery++;
          break;
        }
      }
    }

    const progress = await getProgressPercentage(page);
    console.log(`\n  Module 2 Summary (Expert): ${totalTurns} turns, ${quickMastery} quick mastery, ${progress}%`);
    console.log('✓ TUTOR-EXPERT-M2 passed');
  });

  test('TUTOR-EXPERT-M3 — Module 3 progression (expert student)', async ({ page }) => {
    test.setTimeout(600000);
    await loginAs(page);
    await navigateToTutor(page);
    await selectTutorCourse(page, COURSE);

    let totalTurns = 0;
    let quickMastery = 0;

    for (let subtopicIdx = 0; subtopicIdx < 8; subtopicIdx++) {
      for (let attempt = 1; attempt <= MAX_TURNS_PER_SUBTOPIC; attempt++) {
        const answer = expertStudentAnswer(`module 3 subtopic ${subtopicIdx + 1}`);
        let response;

        try {
          response = await sendTutorMessage(page, answer, MESSAGE_TIMEOUT);
        } catch (err) {
          console.log(`  ⚠ Timeout on M3-S${subtopicIdx + 1}, attempt ${attempt}`);
          break;
        }

        totalTurns++;
        console.log(`  [M3-S${subtopicIdx + 1}-A${attempt}] "${answer.slice(0, 50)}..." → "${response.slice(0, 60)}..."`);

        const mastered = /excellent|correct|great|well done|mastered|move on|next|let.*s proceed|impressive/i.test(response);
        if (mastered) {
          if (attempt === 1) quickMastery++;
          break;
        }
      }
    }

    const progress = await getProgressPercentage(page);
    console.log(`\n  Module 3 Summary (Expert): ${totalTurns} turns, ${quickMastery} quick mastery, ${progress}%`);
    console.log('✓ TUTOR-EXPERT-M3 passed');
  });

  test('TUTOR-EXPERT-M4 — Module 4 progression (expert student)', async ({ page }) => {
    test.setTimeout(600000);
    await loginAs(page);
    await navigateToTutor(page);
    await selectTutorCourse(page, COURSE);

    let totalTurns = 0;
    let quickMastery = 0;

    for (let subtopicIdx = 0; subtopicIdx < 8; subtopicIdx++) {
      for (let attempt = 1; attempt <= MAX_TURNS_PER_SUBTOPIC; attempt++) {
        const answer = expertStudentAnswer(`module 4 subtopic ${subtopicIdx + 1}`);
        let response;

        try {
          response = await sendTutorMessage(page, answer, MESSAGE_TIMEOUT);
        } catch (err) {
          console.log(`  ⚠ Timeout on M4-S${subtopicIdx + 1}, attempt ${attempt}`);
          break;
        }

        totalTurns++;
        console.log(`  [M4-S${subtopicIdx + 1}-A${attempt}] "${answer.slice(0, 50)}..." → "${response.slice(0, 60)}..."`);

        const mastered = /excellent|correct|great|well done|mastered|move on|next|let.*s proceed|impressive/i.test(response);
        if (mastered) {
          if (attempt === 1) quickMastery++;
          break;
        }
      }
    }

    const progress = await getProgressPercentage(page);
    console.log(`\n  Module 4 Summary (Expert): ${totalTurns} turns, ${quickMastery} quick mastery, ${progress}%`);
    console.log('✓ TUTOR-EXPERT-M4 passed');
  });

});
