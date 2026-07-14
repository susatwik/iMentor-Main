/**
 * Sprint 2 — Evidence: Replay Variability
 * Replays one level 10+ times, measures question overlap.
 *
 * Usage: cd server && node scripts/sprint2_evidence_replay.js
 * Output saved to /tmp/replay_evidence.txt
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = process.env.BASE_URL || 'http://localhost:5001';
const API = `${BASE_URL}/api`;

const TEST_EMAIL = `replay_${Date.now()}@test.com`;
const TEST_PASSWORD = 'TestPass123!';
const TOPIC = `Replay Topic ${Date.now()}`;
const ITERATIONS = 10;
const OUTPUT_PATH = '/tmp/replay_evidence.txt';

let authToken = null;
let gameId = null;
let levelName = 'Level 1';
let allIterations = [];

function request(method, urlPath, body = null, token = null, timeout = 300000) {
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

function POST(path, body, token, timeout) { return request('POST', `${API}${path}`, body, token, timeout); }
function PUT(path, body, token, timeout) { return request('PUT', `${API}${path}`, body, token, timeout); }
function GET(path, token, timeout) { return request('GET', `${API}${path}`, null, token, timeout); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function createTestUser(email) {
  const otpResp = await POST('/auth/send-otp', { email, password: TEST_PASSWORD });
  if (otpResp.status === 200 && otpResp.data?.devOtp) {
    // Dev mode — proceed
  } else if (otpResp.status === 409) {
    const signin = await POST('/auth/signin', { email, password: TEST_PASSWORD });
    if (signin.status === 200) return signin.data.token;
    throw new Error(`Signin failed: ${signin.status}`);
  } else {
    throw new Error(`send-otp failed: ${otpResp.status} ${JSON.stringify(otpResp.data)}`);
  }

  const signupResp = await POST('/auth/signup', {
    email,
    otp: '123456',
    name: 'Replay Test User',
    college: 'Test University',
    universityNumber: `UNI_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    degreeType: 'bachelor',
    branch: 'CS',
    year: '3',
    learningStyle: 'Visual',
    preferredLlmProvider: 'local_llm',
  });

  if (signupResp.status === 201 || signupResp.status === 200) {
    return signupResp.data.token;
  }
  throw new Error(`Signup failed: ${signupResp.status} ${JSON.stringify(signupResp.data)}`);
}

async function setupGame() {
  // 1. Check topic
  await POST('/gamification/skill-tree/check-topic', { topic: TOPIC }, authToken);

  // 2. Diagnostic questions
  const diagResp = await POST('/gamification/skill-tree/diagnostic', { topic: TOPIC }, authToken, 60000);

  let diagnosticQuestions = [];
  if (diagResp.status === 200 && diagResp.data && Array.isArray(diagResp.data.questions)) {
    diagnosticQuestions = diagResp.data.questions;
  } else {
    // The diagnostic endpoint sometimes wraps in a different format
    if (diagResp.data && Array.isArray(diagResp.data)) {
      diagnosticQuestions = diagResp.data;
    }
  }

  // 3. Submit diagnostic (pick first option for each)
  const diagAnswers = diagnosticQuestions.slice(0, 5).map(q => ({
    question: q.question,
    answer: q.options && q.options[0] ? q.options[0] : 'A',
    skillId: q.skillId || `diag_${TOPIC}`,
  }));

  let assessmentResult = { level: 'Beginner', score: 0 };
  if (diagAnswers.length >= 3) {
    const submitResp = await POST('/gamification/skill-tree/diagnostic/submit', { topic: TOPIC, answers: diagAnswers }, authToken);
    if (submitResp.status === 200 && submitResp.data) {
      assessmentResult = submitResp.data;
    }
  }

  // 4. Generate levels
  const genLevelsResp = await POST('/gamification/skill-tree/generate-levels', {
    topic: TOPIC,
    assessmentResult,
    answers: diagAnswers,
  }, authToken, 60000);

  let levels = [];
  if (genLevelsResp.status === 200 && genLevelsResp.data && Array.isArray(genLevelsResp.data.levels)) {
    levels = genLevelsResp.data.levels;
  }

  // Ensure at least one level exists
  if (!levels || levels.length === 0) {
    levels = [{
      id: 1,
      name: 'Level 1',
      description: `Master ${TOPIC}`,
      difficulty: 'easy',
      status: 'unlocked',
      stars: 0,
      credits: 10,
    }];
  }

  // Record the first level's name
  levelName = levels[0].name || 'Level 1';

  // 5. Create game
  const gameResp = await POST('/gamification/skill-tree/games', {
    topic: TOPIC,
    assessmentResult,
    levels,
  }, authToken);

  if (gameResp.status === 201 || gameResp.status === 200) {
    const g = gameResp.data.game || gameResp.data;
    gameId = g._id || g.id;
    if (!gameId) throw new Error(`No gameId in response: ${JSON.stringify(gameResp.data).substring(0, 200)}`);
  } else {
    throw new Error(`Create game failed: ${gameResp.status} ${JSON.stringify(gameResp.data)}`);
  }
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

async function main() {
  const output = [];
  const tee = (msg) => { console.log(msg); output.push(msg); };

  tee('# Sprint 2 — Evidence: Replay Variability (Question Overlap)');
  tee('');
  tee(`Started: ${new Date().toISOString()}`);
  tee(`Target:  ${BASE_URL}`);
  tee(`Topic:   ${TOPIC}`);
  tee(`Iterations: ${ITERATIONS}`);
  tee('');

  // ── Step 1: Create user ──
  tee('## Step 1: Create Test User');
  try {
    authToken = await createTestUser(TEST_EMAIL);
    tee(`User created: ${TEST_EMAIL}`);
  } catch (e) {
    tee(`FAIL: ${e.message}`);
    fs.writeFileSync(OUTPUT_PATH, output.join('\n') + '\n');
    process.exit(1);
  }
  tee('');

  // ── Step 2: Setup game ──
  tee('## Step 2: Setup Game');
  try {
    await setupGame();
    tee(`Game created: ${gameId}`);
    tee(`Level name: "${levelName}"`);
  } catch (e) {
    tee(`FAIL setting up game: ${e.message}`);
    fs.writeFileSync(OUTPUT_PATH, output.join('\n') + '\n');
    process.exit(1);
  }
  tee('');

  // ── Step 3: Replay iterations ──
  tee('## Step 3: Replay Iterations');
  tee('');
  tee('| Iteration | Questions | Source | Unique Cumulative |');
  tee('|---|---|---|---|');

  const questionSets = [];
  let cumulativeUnique = new Set();

  for (let iter = 1; iter <= ITERATIONS; iter++) {
    tee(`| **${iter}** | | | |`);

    const qResp = await POST('/gamification/skill-tree/level-questions', {
      topic: TOPIC,
      levelId: 1,
      levelName,
      gameId,
    }, authToken, 120000);

    if (qResp.status !== 200 || !qResp.data || !Array.isArray(qResp.data.questions)) {
      const msg = `FAIL iteration ${iter}: ${qResp.status} ${JSON.stringify(qResp.data || '').substring(0, 200)}`;
      tee(`| ${iter} | ERROR: ${msg} | - | ${cumulativeUnique.size} |`);
      continue;
    }

    const questions = qResp.data.questions;
    const questionTexts = questions.map(q => (q.question || '').trim());
    const source = qResp.data.source || qResp.data._source || 'unknown';

    // Track cumulative unique questions
    const prevSize = cumulativeUnique.size;
    for (const qt of questionTexts) {
      if (qt) cumulativeUnique.add(qt.toLowerCase());
    }

    questionSets.push(new Set(questionTexts.filter(Boolean)));

    // Log each question in this iteration
    for (const qt of questionTexts) {
      tee(`| | ${qt.substring(0, 80)} | ${source} | ${cumulativeUnique.size} |`);
    }

    // Record answers (mark ~half correct using _conceptQuestionId)
    const answers = questions.map((q, i) => ({
      _conceptQuestionId: q._conceptQuestionId || null,
      question: q.question,
      correct: i % 2 === 0, // even indices correct, odd incorrect
    }));

    await POST('/gamification/skill-tree/record-answers', {
      topic: TOPIC,
      levelName,
      answers,
    }, authToken);

    // Complete the level
    await PUT(`/gamification/skill-tree/games/${gameId}/level/1`, {
      stars: 2,
      score: 3,
      totalQuestions: 5,
      status: 'completed',
    }, authToken);

    tee(`| **${iter}** | **Done** (${questionTexts.length} q, ${source}) | ${source} | ${cumulativeUnique.size} |`);
  }

  tee('');

  // ── Step 4: Overlap analysis ──
  tee('## Step 4: Overlap Analysis');
  tee('');

  const n = questionSets.length;
  let totalOverlap = 0;
  let pairCount = 0;

  // Overlap matrix
  const matrix = Array.from({ length: n }, () => Array(n).fill(0));
  let minOverlap = 1;
  let maxOverlap = 0;
  let identicalPairs = [];
  let allPairOverlaps = [];

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = jaccardSimilarity(questionSets[i], questionSets[j]);
      const pct = Math.round(sim * 100);
      matrix[i][j] = pct;
      matrix[j][i] = pct;
      totalOverlap += sim;
      pairCount++;
      allPairOverlaps.push(sim);

      if (sim < minOverlap) minOverlap = sim;
      if (sim > maxOverlap) maxOverlap = sim;

      if (pct === 100) {
        identicalPairs.push(`{${i+1}, ${j+1}}`);
      }
    }
  }

  const avgOverlap = pairCount > 0 ? totalOverlap / pairCount : 0;
  const avgOverlapPct = Math.round(avgOverlap * 100);
  const totalUnique = cumulativeUnique.size;
  const totalDisplayed = n * 5; // approximate

  // Output overlap matrix
  tee('### Overlap Matrix (row/col = iteration, value = % Jaccard similarity)');
  tee('');
  let headerRow = '| Iter |';
  for (let i = 0; i < n; i++) headerRow += ` ${i+1} |`;
  tee(headerRow);
  let sepRow = '|------|';
  for (let i = 0; i < n; i++) sepRow += '---|';
  tee(sepRow);
  for (let i = 0; i < n; i++) {
    let row = `| ${i+1} |`;
    for (let j = 0; j < n; j++) {
      if (i === j) {
        row += ' - |';
      } else {
        row += ` ${matrix[i][j]} |`;
      }
    }
    tee(row);
  }
  tee('');

  // Per-iteration unique contribution
  tee('### Per-Iteration Unique Counts');
  tee('');
  tee('| Iteration | Questions | New Unique | Cumulative |');
  tee('|---|---|---|---|');
  const runningSet = new Set();
  for (let i = 0; i < n; i++) {
    const prev = runningSet.size;
    for (const qt of questionSets[i]) {
      runningSet.add(qt.toLowerCase());
    }
    const newUnique = runningSet.size - prev;
    tee(`| ${i+1} | ${questionSets[i].size} | ${newUnique} | ${runningSet.size} |`);
  }
  tee('');

  // ── Summary ──
  tee('---');
  tee('## Summary');
  tee('');
  tee(`- **Total iterations:** ${n}`);
  tee(`- **Total question slots:** ${totalDisplayed}`);
  tee(`- **Unique questions seen:** ${totalUnique}`);
  tee(`- **Unseen question ratio:** ${(totalUnique / totalDisplayed).toFixed(3)} (unique/total displayed)`);
  tee(`- **Overlap across all pairs (Jaccard):`);
  tee(`  - Average: ${avgOverlapPct}%`);
  tee(`  - Min: ${Math.round(minOverlap * 100)}%`);
  tee(`  - Max: ${Math.round(maxOverlap * 100)}%`);
  tee(`- **Identical sets:** ${identicalPairs.length > 0 ? identicalPairs.join(', ') : 'NONE — No two iterations returned identical question sets'}`);
  tee('');

  // Verdict
  const passNoIdentical = identicalPairs.length === 0;
  const passAvgOverlap = avgOverlap < 0.5;
  const passUnseenRatio = (totalUnique / totalDisplayed) > 0.5;

  tee('## Verdict');
  tee('');
  tee(`| Criterion | Expected | Actual | Result |`);
  tee('|---|---|---|---|');
  tee(`| No identical sets | true | ${passNoIdentical} | ${passNoIdentical ? 'PASS' : 'FAIL'} |`);
  tee(`| Average overlap < 50% | true | ${avgOverlapPct}% | ${passAvgOverlap ? 'PASS' : 'FAIL'} |`);
  tee(`| Unseen ratio > 0.5 | true | ${(totalUnique / totalDisplayed).toFixed(3)} | ${passUnseenRatio ? 'PASS' : 'FAIL'} |`);

  const allPass = passNoIdentical && passAvgOverlap && passUnseenRatio;
  tee('');
  tee(`**Overall: ${allPass ? 'ALL PASS' : 'SOME FAILURES'}'**`);

  fs.writeFileSync(OUTPUT_PATH, output.join('\n') + '\n', 'utf-8');
  console.log(`\nOutput saved to ${OUTPUT_PATH}`);
}

main().catch(async (e) => {
  console.error('Fatal:', e);
  const msg = `Fatal error: ${e.message}\n${e.stack || ''}`;
  fs.writeFileSync(OUTPUT_PATH, msg, 'utf-8');
  process.exit(1);
});
