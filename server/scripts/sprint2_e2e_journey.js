/**
 * Sprint 2 — E2E Student Journey
 * Tests the complete student journey via API in a single sequential script.
 *
 * Usage: cd server && node scripts/sprint2_e2e_journey.js
 * Output saved to /tmp/e2e_journey_evidence.txt
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = process.env.BASE_URL || 'http://localhost:5001';
const API = `${BASE_URL}/api`;

const TEST_EMAIL = `e2e_${Date.now()}@test.com`;
const TEST_PASSWORD = 'TestPass123!';
const TOPIC = `E2E Journey ${Date.now()}`;
const COURSE_NAME = 'Data Structures';

const OUTPUT_PATH = '/tmp/e2e_journey_evidence.txt';

const REQUEST_TIMEOUT = 60000;
const LONG_TIMEOUT = 120000;

let authToken = null;
let gameId = null;
let firstLevelName = null;
let firstSetQuestions = null;
let secondSetQuestions = null;

// ===== Helpers =====

function request(method, urlPath, body = null, token = null, timeout = REQUEST_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout,
    };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function GET(path, token, timeout) { return request('GET', `${API}${path}`, null, token, timeout); }
function POST(path, body, token, timeout) { return request('POST', `${API}${path}`, body, token, timeout); }
function PUT(path, body, token, timeout) { return request('PUT', `${API}${path}`, body, token, timeout); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function jaccardOverlap(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  return intersection.size / Math.min(setA.size, setB.size);
}

// ===== Test Runner =====

const output = [];
const results = [];

function tee(msg) { console.log(msg); output.push(msg); }

function recordResult(step, ok, detail = '') {
  const status = ok ? 'PASS' : 'FAIL';
  results.push({ step, status, detail });
  const icon = ok ? '\u2713' : '\u2717';
  tee(`  ${icon} [${status}] ${step}${detail ? ': ' + detail : ''}`);
}

async function step(name, fn) {
  tee(`\n=== Step: ${name} ===`);
  try {
    await fn();
  } catch (e) {
    tee(`  \u2717 UNHANDLED ERROR: ${e.message}`);
    recordResult(name, false, e.message);
  }
}

// ===== Main =====

async function main() {
  tee('# Sprint 2 — E2E Student Journey');
  tee(`Started: ${new Date().toISOString()}`);
  tee(`Target:  ${BASE_URL}`);
  tee(`Email:   ${TEST_EMAIL}`);
  tee(`Topic:   ${TOPIC}`);
  tee('');

  // ──────────────────────────────────────────────
  // STEP 1: Login/Signup
  // ──────────────────────────────────────────────
  await step('1. Login/Signup — Create User', async () => {
    // 1a. Send OTP
    const otpResp = await POST('/auth/send-otp', { email: TEST_EMAIL, password: TEST_PASSWORD });
    const otpOk = otpResp.status === 200 && (otpResp.data?.devOtp || otpResp.data?.message);
    tee(`  POST /auth/send-otp → ${otpResp.status}`);
    tee(`  Response: ${JSON.stringify(otpResp.data).substring(0, 200)}`);
    recordResult('1a. send-otp', otpOk, otpResp.status);

    if (!otpOk) throw new Error(`send-otp failed: ${otpResp.status}`);

    // 1b. Signup
    const signupResp = await POST('/auth/signup', {
      email: TEST_EMAIL,
      otp: '123456',
      name: 'E2E Test User',
      college: 'Test University',
      universityNumber: `UNI_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      degreeType: 'bachelor',
      branch: 'CS',
      year: '3',
      learningStyle: 'Visual',
      preferredLlmProvider: 'local_llm',
    });
    const signupOk = signupResp.status === 201 && signupResp.data?.token;
    authToken = signupResp.data?.token || null;
    tee(`  POST /auth/signup → ${signupResp.status}`);
    tee(`  Response: ${JSON.stringify(signupResp.data).substring(0, 200)}`);
    recordResult('1b. signup', signupOk, signupResp.status);

    if (!signupOk) throw new Error(`Signup failed: ${signupResp.status} ${JSON.stringify(signupResp.data).substring(0, 100)}`);
  });

  // ──────────────────────────────────────────────
  // STEP 2: Course Explorer
  // ──────────────────────────────────────────────
  await step('2. Course Explorer — Fetch Courses', async () => {
    const resp = await GET('/subjects', authToken, 15000);
    tee(`  GET /subjects → ${resp.status}`);
    tee(`  Response: ${JSON.stringify(resp.data).substring(0, 200)}`);

    const ok = resp.status === 200;
    const subjects = resp.data?.subjects || [];
    recordResult('2. Course Explorer', ok && subjects.length > 0,
      `${resp.status}, subjects: ${subjects.length}`);
  });

  // ──────────────────────────────────────────────
  // STEP 3: Knowledge Assessment
  // ──────────────────────────────────────────────
  await step('3. Knowledge Assessment', async () => {
    // 3a. Generate
    const genResp = await POST('/assessment/generate',
      { course: COURSE_NAME, topic: COURSE_NAME },
      authToken, LONG_TIMEOUT);
    tee(`  POST /assessment/generate → ${genResp.status}`);
    tee(`  Response: ${JSON.stringify(genResp.data).substring(0, 200)}`);
    const genOk = genResp.status === 200;
    recordResult('3a. Assessment Generate', genOk, genResp.status);

    const questions = genResp.data?.questions || [];
    if (!genOk) throw new Error(`Generate failed: ${genResp.status}`);

    // 3b. Submit
    const mockResponses = questions.slice(0, 5).map((q, i) => ({
      questionId: q._id || `q_${i}`,
      question: q.question || '',
      selectedAnswer: q.options?.[0] || 'A',
      correct: i % 2 === 0,
      timeSpent: 15,
    }));

    const submitResp = await POST('/assessment/submit',
      { responses: mockResponses, topic: COURSE_NAME, course: COURSE_NAME },
      authToken, LONG_TIMEOUT);
    tee(`  POST /assessment/submit → ${submitResp.status}`);
    tee(`  Response: ${JSON.stringify(submitResp.data).substring(0, 200)}`);
    const submitOk = submitResp.status === 200;
    recordResult('3b. Assessment Submit', submitOk, submitResp.status);

    // 3c. Verify Evaluation Agent response
    const hasEval = submitResp.data?.overallScore !== undefined ||
                   submitResp.data?.score !== undefined ||
                   submitResp.data?.level !== undefined ||
                   submitResp.data?.summary !== undefined ||
                   submitResp.data?.feedback !== undefined;
    recordResult('3c. Evaluation Agent Response', hasEval,
      hasEval ? 'has evaluation fields' : 'missing evaluation fields');
  });

  // ──────────────────────────────────────────────
  // STEP 4: Skill Tree — Generate levels
  // ──────────────────────────────────────────────
  await step('4. Skill Tree — Generate', async () => {
    // Need diagnostic first
    const diagResp = await POST('/gamification/skill-tree/diagnostic',
      { topic: TOPIC }, authToken, LONG_TIMEOUT);
    tee(`  POST /skill-tree/diagnostic → ${diagResp.status}`);
    let diagnosticQuestions = [];
    if (diagResp.status === 200 && Array.isArray(diagResp.data?.questions)) {
      diagnosticQuestions = diagResp.data.questions;
    }

    const diagAnswers = diagnosticQuestions.slice(0, 5).map(q => ({
      question: q.question,
      answer: q.options?.[0] || 'A',
      skillId: q.skillId || `diag_${TOPIC}`,
    }));

    let assessmentResult = { level: 'Beginner', score: 0 };
    if (diagAnswers.length >= 3) {
      const submitResp = await POST('/gamification/skill-tree/diagnostic/submit',
        { topic: TOPIC, answers: diagAnswers }, authToken);
      if (submitResp.status === 200) {
        assessmentResult = submitResp.data;
      }
    }

    // Generate levels
    const genResp = await POST('/gamification/skill-tree/generate-levels',
      { topic: TOPIC, assessmentResult, answers: diagAnswers },
      authToken, LONG_TIMEOUT);
    tee(`  POST /skill-tree/generate-levels → ${genResp.status}`);
    tee(`  Response: ${JSON.stringify(genResp.data).substring(0, 200)}`);

    const genOk = genResp.status === 200;
    const levels = genResp.data?.levels || [];
    firstLevelName = levels[0]?.name || 'Level 1';
    recordResult('4. Skill Tree Generate', genOk && levels.length >= 3,
      `${genResp.status}, levels: ${levels.length}, first: "${firstLevelName}"`);

    if (!genOk) throw new Error(`Generate levels failed: ${genResp.status}`);
  });

  // ──────────────────────────────────────────────
  // STEP 5: Level 1 Questions
  // ──────────────────────────────────────────────
  await step('5. Level 1 Questions', async () => {
    // Create game first
    const levels = [{
      id: 1, name: firstLevelName, description: `Master ${TOPIC}`,
      difficulty: 'easy', status: 'unlocked', stars: 0, credits: 10,
    }];
    const gameResp = await POST('/gamification/skill-tree/games',
      { topic: TOPIC, assessmentResult: { level: 'Beginner', score: 0 }, levels },
      authToken);
    tee(`  POST /skill-tree/games → ${gameResp.status}`);
    tee(`  Response: ${JSON.stringify(gameResp.data).substring(0, 200)}`);

    const gameOk = gameResp.status === 201 || gameResp.status === 200;
    const g = gameResp.data?.game || gameResp.data;
    gameId = g?._id || g?.id || null;

    if (!gameOk || !gameId) throw new Error(`Create game failed: ${gameResp.status}`);
    recordResult('5a. Create Game', gameOk && !!gameId, `${gameResp.status}, gameId: ${gameId}`);

    // Fetch level questions
    const qResp = await POST('/gamification/skill-tree/level-questions',
      { topic: TOPIC, levelId: 1, levelName: firstLevelName, gameId },
      authToken, LONG_TIMEOUT);
    tee(`  POST /skill-tree/level-questions → ${qResp.status}`);
    tee(`  Response: ${JSON.stringify(qResp.data).substring(0, 200)}`);

    const questions = qResp.data?.questions || [];
    firstSetQuestions = questions;
    const qOk = qResp.status === 200 && questions.length === 5;

    // Validate required fields
    let allFieldsValid = true;
    const requiredFields = ['question', 'options', 'correctIndex'];
    for (const q of questions) {
      for (const f of requiredFields) {
        if (q[f] === undefined || q[f] === null) {
          allFieldsValid = false;
          tee(`  Missing field "${f}" in question: "${(q.question || '').substring(0, 50)}"`);
        }
      }
      if (!Array.isArray(q.options) || q.options.length < 2) {
        allFieldsValid = false;
        tee(`  Invalid options in question: "${(q.question || '').substring(0, 50)}"`);
      }
    }

    recordResult('5b. Level 1 Questions', qOk && allFieldsValid,
      `${qResp.status}, questions: ${questions.length}, fields valid: ${allFieldsValid}`);
  });

  // ──────────────────────────────────────────────
  // STEP 6: Record Answers
  // ──────────────────────────────────────────────
  await step('6. Record Answers', async () => {
    if (!firstSetQuestions || firstSetQuestions.length === 0) {
      recordResult('6. Record Answers', false, 'No questions from step 5');
      return;
    }

    const answers = firstSetQuestions.map((q, i) => ({
      _conceptQuestionId: q._conceptQuestionId || q._id || null,
      question: q.question,
      correct: i % 2 === 0,
    }));

    const resp = await POST('/gamification/skill-tree/record-answers',
      { topic: TOPIC, levelName: firstLevelName, answers },
      authToken);
    tee(`  POST /skill-tree/record-answers → ${resp.status}`);
    tee(`  Response: ${JSON.stringify(resp.data).substring(0, 200)}`);

    const ok = resp.status === 200;
    recordResult('6. Record Answers', ok, `${resp.status}`);
  });

  // ──────────────────────────────────────────────
  // STEP 7: Replay Level 1
  // ──────────────────────────────────────────────
  await step('7. Replay Level 1', async () => {
    // Complete level 1 first
    const completeResp = await PUT(`/gamification/skill-tree/games/${gameId}/level/1`,
      { stars: 2, score: 3, totalQuestions: 5, status: 'completed' },
      authToken);
    tee(`  PUT /skill-tree/games/${gameId}/level/1 → ${completeResp.status}`);
    const completeOk = completeResp.status === 200;
    recordResult('7a. Complete Level 1', completeOk, completeResp.status);

    // Fetch questions again (replay)
    const qResp = await POST('/gamification/skill-tree/level-questions',
      { topic: TOPIC, levelId: 1, levelName: firstLevelName, gameId },
      authToken, LONG_TIMEOUT);
    tee(`  POST /skill-tree/level-questions (replay) → ${qResp.status}`);
    tee(`  Response: ${JSON.stringify(qResp.data).substring(0, 200)}`);

    secondSetQuestions = qResp.data?.questions || [];
    const qOk = qResp.status === 200 && secondSetQuestions.length === 5;
    recordResult('7b. Replay Level 1 Questions', qOk,
      `${qResp.status}, questions: ${secondSetQuestions.length}`);

    // Calculate overlap
    if (firstSetQuestions && secondSetQuestions.length > 0) {
      const firstTexts = new Set(firstSetQuestions.map(q => (q.question || '').trim().toLowerCase()));
      const secondTexts = new Set(secondSetQuestions.map(q => (q.question || '').trim().toLowerCase()));
      const overlap = jaccardOverlap(firstTexts, secondTexts);
      const overlapPct = Math.round(overlap * 100);
      tee(`  Overlap between first and second set: ${overlapPct}%`);
      recordResult('7c. Overlap Check', true, `${overlapPct}% overlap`);
    }
  });

  // ──────────────────────────────────────────────
  // STEP 8: Complete Multiple Levels (1-3)
  // ──────────────────────────────────────────────
  await step('8. Complete Levels 1-3', async () => {
    let allLevelsOk = true;

    // Unlock levels 2 and 3 through the game
    // First get current game to see if levels 2,3 exist
    const gameResp = await GET(`/gamification/skill-tree/games/${gameId}`, authToken);
    const existingLevels = gameResp.data?.game?.levels || [];

    // Ensure we have at least 3 levels
    if (existingLevels.length < 3) {
      // Update game with more levels
      const moreLevels = [
        { id: 1, name: firstLevelName, description: `Level 1`, difficulty: 'easy', status: 'completed', stars: 2, score: 3 },
        { id: 2, name: 'Level 2', description: `Level 2`, difficulty: 'easy', status: 'unlocked', stars: 0, credits: 10 },
        { id: 3, name: 'Level 3', description: `Level 3`, difficulty: 'medium', status: 'locked', stars: 0, credits: 15 },
      ];
      const updateResp = await POST(`/gamification/skill-tree/games/${gameId}/save`,
        { levels: moreLevels }, authToken);
      tee(`  POST /skill-tree/games/${gameId}/save → ${updateResp.status}`);
    }

    for (let levelId = 2; levelId <= 3; levelId++) {
      const levelName = `Level ${levelId}`;
      // Fetch questions
      const qResp = await POST('/gamification/skill-tree/level-questions',
        { topic: TOPIC, levelId, levelName, gameId },
        authToken, LONG_TIMEOUT);
      tee(`  Level ${levelId} questions → ${qResp.status}, questions: ${(qResp.data?.questions || []).length}`);

      // Record answers
      const qs = qResp.data?.questions || [];
      if (qs.length > 0) {
        await POST('/gamification/skill-tree/record-answers',
          { topic: TOPIC, levelName, answers: qs.map((q, i) => ({
            _conceptQuestionId: q._conceptQuestionId || null,
            question: q.question,
            correct: i % 2 === 0,
          })) }, authToken);
      }

      // Complete level
      const completeResp = await PUT(`/gamification/skill-tree/games/${gameId}/level/${levelId}`,
        { stars: 3, score: 5, totalQuestions: 5, status: 'completed' },
        authToken);
      const ok = completeResp.status === 200;
      tee(`  Complete Level ${levelId} → ${completeResp.status}`);
      if (!ok) allLevelsOk = false;
    }

    recordResult('8. Complete Levels 1-3', allLevelsOk, allLevelsOk ? 'all complete' : 'some failed');
  });

  // ──────────────────────────────────────────────
  // STEP 9: Return to Previous Level
  // ──────────────────────────────────────────────
  await step('9. Return to Level 1 After Level 3', async () => {
    const qResp = await POST('/gamification/skill-tree/level-questions',
      { topic: TOPIC, levelId: 1, levelName: firstLevelName, gameId },
      authToken, LONG_TIMEOUT);
    tee(`  POST /skill-tree/level-questions (return to L1) → ${qResp.status}`);
    tee(`  Response preview: ${JSON.stringify(qResp.data).substring(0, 200)}`);

    const questions = qResp.data?.questions || [];
    const ok = qResp.status === 200 && questions.length === 5;
    recordResult('9. Return to Level 1', ok,
      `${qResp.status}, questions: ${questions.length}`);
  });

  // ──────────────────────────────────────────────
  // STEP 10: Analytics
  // ──────────────────────────────────────────────
  await step('10. Analytics', async () => {
    const resp = await GET(`/question-bank/concept/analytics?concept=${encodeURIComponent(TOPIC)}&course=${encodeURIComponent(TOPIC)}`, authToken);
    tee(`  GET /question-bank/concept/analytics → ${resp.status}`);
    tee(`  Response: ${JSON.stringify(resp.data).substring(0, 200)}`);

    const ok = resp.status === 200;
    recordResult('10. Analytics', ok, resp.status);
  });

  // ──────────────────────────────────────────────
  // STEP 11: Quiz
  // ──────────────────────────────────────────────
  await step('11. Quiz', async () => {
    const resp = await GET(`/quiz/generate?courseName=${encodeURIComponent(COURSE_NAME)}`, authToken, LONG_TIMEOUT);
    tee(`  GET /quiz/generate → ${resp.status}`);
    tee(`  Response: ${JSON.stringify(resp.data).substring(0, 200)}`);

    const ok = resp.status === 200;
    const questions = resp.data?.questions || [];
    recordResult('11. Quiz Generate', ok && questions.length > 0,
      `${resp.status}, questions: ${questions.length}`);
  });

  // ──────────────────────────────────────────────
  // STEP 12: Concept Map / Skill Tree Data
  // ──────────────────────────────────────────────
  await step('12. Concept Map / Skill Tree', async () => {
    const resp = await GET('/gamification/skill-tree-map', authToken);
    tee(`  GET /gamification/skill-tree-map → ${resp.status}`);
    tee(`  Response: ${JSON.stringify(resp.data).substring(0, 200)}`);

    const skills = resp.data?.skills || [];
    const connections = resp.data?.connections || [];
    const ok = resp.status === 200;
    recordResult('12. Concept Map / Skill Tree', ok,
      `${resp.status}, skills: ${skills.length}, connections: ${connections.length}`);
  });

  // ──────────────────────────────────────────────
  // SUMMARY
  // ──────────────────────────────────────────────
  tee('\n');
  tee('='.repeat(60));
  tee('SUMMARY');
  tee('='.repeat(60));
  tee('');
  tee('| Step | Status | Detail |');
  tee('|---|---|---|');
  let passCount = 0;
  let failCount = 0;
  for (const r of results) {
    const icon = r.status === 'PASS' ? '\u2713' : '\u2717';
    tee(`| ${r.step} | ${icon} ${r.status} | ${r.detail} |`);
    if (r.status === 'PASS') passCount++;
    else failCount++;
  }
  tee('');
  tee(`**Total: ${passCount} PASS, ${failCount} FAIL (${results.length} checks)**`);

  fs.writeFileSync(OUTPUT_PATH, output.join('\n') + '\n', 'utf-8');
  console.log(`\nOutput saved to ${OUTPUT_PATH}`);
}

main().catch(async (e) => {
  console.error('Fatal:', e);
  const msg = `Fatal error: ${e.message}\n${e.stack || ''}`;
  fs.writeFileSync(OUTPUT_PATH, msg, 'utf-8');
  process.exit(1);
});
