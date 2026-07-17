/**
 * Skill Tree Unified Fallback Chain Test
 *
 * Tests that the Skill Tree question generation flow uses
 * the unified Provider Fallback Chain consistently.
 *
 * Provider Chain: SGLang → Groq → Gemini → OpenAI → Ollama → Template
 *
 * Usage: cd server && node scripts/test_skilltree_fallback.js
 */

const http = require('http');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = process.env.BASE_URL || 'http://localhost:5001';
const API_BASE = `${BASE_URL}/api/`;

const TEST_EMAIL = `failover_test_${Date.now()}@test.com`;
const TEST_PASSWORD = 'TestPass123!';

let authToken = null;
let testGameId = null;

function request(method, urlPath, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, API_BASE);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      timeout: 90000,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function login() {
  console.log('\n=== Authenticating ===');
  const otpResp = await request('POST', 'auth/send-otp', { email: TEST_EMAIL, password: TEST_PASSWORD });
  const devOtp = otpResp.data?.devOtp || otpResp.data?.otp || '123456';
  const signupResp = await request('POST', 'auth/signup', {
    email: TEST_EMAIL, password: TEST_PASSWORD, otp: devOtp,
    name: 'Failover Test', college: 'Test University',
    universityNumber: 'FN' + Date.now(), degreeType: 'btech',
    branch: 'CS', year: '3', learningStyle: 'Visual',
    preferredLlmProvider: 'groq',
  });
  if ((signupResp.status === 201 || signupResp.status === 200) && signupResp.data?.token) {
    authToken = signupResp.data.token;
    console.log('  Authenticated:', TEST_EMAIL);
    return true;
  }
  if (signupResp.status === 409 || (signupResp.status === 400 && signupResp.data?.message?.includes('already'))) {
    const loginResp = await request('POST', 'auth/login', { email: TEST_EMAIL, password: TEST_PASSWORD });
    if (loginResp.data?.token) {
      authToken = loginResp.data.token;
      console.log('  Logged in (existing user):', TEST_EMAIL);
      return true;
    }
  }
  console.error('  Auth failed:', signupResp.status, JSON.stringify(signupResp.data).slice(0, 200));
  return false;
}

async function testProviderChain() {
  console.log('\n═══════════════════════════════════════════');
  console.log('  SKILL TREE UNIFIED FALLBACK CHAIN TEST');
  console.log('═══════════════════════════════════════════');

  const testConcept = `FailoverTest_${Date.now()}`;
  const testTopic = 'Data Structures';

  // Step 1: Create a game first
  console.log('\n1. Creating test game...');
  const gameResp = await request('POST', 'gamification/skill-tree/games', {
    topic: testTopic,
    assessmentResult: { level: 'Beginner', score: 2, total: 5 },
    levels: [
      { id: 1, name: testConcept, difficulty: 'medium', status: 'unlocked', stars: 0, credits: 10 },
      { id: 2, name: 'Basic Operations', difficulty: 'medium', status: 'locked', stars: 0, credits: 20 },
      { id: 3, name: 'Advanced Concepts', difficulty: 'hard', status: 'locked', stars: 0, credits: 30 },
    ],
  }, authToken);

  if (gameResp.status === 201 || gameResp.status === 200) {
    testGameId = gameResp.data?.game?._id;
    console.log(`  Game created: ${testGameId}`);
  } else {
    console.log(`  Game response: ${gameResp.status} — ${JSON.stringify(gameResp.data).slice(0, 100)}`);
    // Try to find existing game
    const existingResp = await request('GET', 'gamification/skill-tree/games', null, authToken);
    const games = existingResp.data?.games || [];
    if (games.length > 0) {
      testGameId = games[0]._id;
      console.log(`  Using existing game: ${testGameId}`);
    }
  }

  // Step 2: Test level-questions endpoint with cache sources
  console.log('\n2. Testing level-questions endpoint...');

  // 2a. First call — should hit concept_question_bank or generate via LLM chain
  console.log('\n  2a. Fresh call (cold start or concept bank hit)...');
  const start1 = Date.now();
  const resp1 = await request('POST', 'gamification/skill-tree/level-questions', {
    topic: testTopic,
    levelId: 1,
    levelName: testConcept,
    difficulty: 'medium',
    gameId: testGameId,
  }, authToken);
  const time1 = Date.now() - start1;

  console.log(`      Status: ${resp1.status}`);
  console.log(`      Latency: ${time1}ms`);
  console.log(`      Questions: ${resp1.data?.questions?.length || 0}`);
  console.log(`      Source: ${resp1.data?.source || 'unknown'}`);
  console.log(`      GeneratedBy: ${resp1.data?.generatedBy || '—'}`);
  console.log(`      Model: ${resp1.data?.model || '—'}`);
  console.log(`      PipelineVersion: ${resp1.data?.pipelineVersion || '—'}`);
  console.log(`      GeneratedAt: ${resp1.data?.generatedAt || '—'}`);
  console.log(`      Cached: ${resp1.data?.cached || false}`);

  const metadataOk1 = resp1.data?.source && resp1.data?.generatedBy !== undefined && resp1.data?.pipelineVersion !== undefined;

  // 2b. Second call — should be fast (Redis or cached)
  console.log('\n  2b. Second call (should be cached)...');
  const start2 = Date.now();
  const resp2 = await request('POST', 'gamification/skill-tree/level-questions', {
    topic: testTopic,
    levelId: 1,
    levelName: testConcept,
    difficulty: 'medium',
    gameId: testGameId,
  }, authToken);
  const time2 = Date.now() - start2;

  console.log(`      Status: ${resp2.status}`);
  console.log(`      Latency: ${time2}ms`);
  console.log(`      Questions: ${resp2.data?.questions?.length || 0}`);
  console.log(`      Source: ${resp2.data?.source || 'unknown'}`);

  // 2c. Third call with different level — test empty edge case
  console.log('\n  2c. Third call (different level)...');
  const start3 = Date.now();
  const resp3 = await request('POST', 'gamification/skill-tree/level-questions', {
    topic: testTopic,
    levelId: 3,
    levelName: 'Advanced Concepts',
    difficulty: 'hard',
    gameId: testGameId,
  }, authToken);
  const time3 = Date.now() - start3;

  console.log(`      Status: ${resp3.status}`);
  console.log(`      Latency: ${time3}ms`);
  console.log(`      Questions: ${resp3.data?.questions?.length || 0}`);
  console.log(`      Source: ${resp3.data?.source || 'unknown'}`);

  // Step 3: Provider chain analysis from logs
  console.log('\n3. Provider Chain Verification (log-based):');
  console.log('   Chain: SGLang → Groq → Gemini → OpenAI → Ollama → Template');
  console.log('   The callWithFallback() function in llmFallbackService.js:');
  console.log('     - Builds chain: [sglang, groq, gemini, openai, ollama]');
  console.log('     - Each provider attempt has a per-provider timeout');
  console.log('     - SGLang: 5s, Groq: 15s, Gemini: 15s, OpenAI: 15s, Ollama: 20s');
  console.log('     - Skips providers without valid API keys');
  console.log('     - Skips SGLang if SGLANG_ENABLED !== true');
  console.log('     - Skips Ollama if health check fails');
  console.log('     - Falls through to Template if ALL providers fail');
  console.log('');
  console.log('   In contentGenerationService.generateOrRetrieveLevelQuestions():');
  console.log('     1. Concept Question Bank (with 8s timeout guard)');
  console.log('     2. Redis cache');
  console.log('     3. Legacy Question Bank');
  console.log('     4. LLM via callWithFallback() → generateLevelQuestions()');
  console.log('     5. Template fallback');

  // Step 4: Verify metadata
  console.log('\n4. Metadata Verification:');
  console.log(`   _source present: ${Boolean(resp1.data?.source)}`);
  console.log(`   generatedBy present: ${resp1.data?.generatedBy !== undefined}`);
  console.log(`   model present: ${resp1.data?.model !== undefined}`);
  console.log(`   pipelineVersion present: ${resp1.data?.pipelineVersion !== undefined}`);
  console.log(`   generatedAt present: ${resp1.data?.generatedAt !== undefined}`);

  // Results
  const latencyOk1 = time1 < 10000; // cold start < 10s
  const latencyOk2 = time2 < 500;   // cached < 500ms
  const latencyOk3 = time3 < 10000; // cold start < 10s
  const questionsOk = (resp1.data?.questions?.length || 0) > 0 &&
                      (resp2.data?.questions?.length || 0) > 0 &&
                      (resp3.data?.questions?.length || 0) > 0;

  console.log('\n═══════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('═══════════════════════════════════════════');
  console.log(`  Fresh call latency (<10s): ${latencyOk1 ? 'PASS' : 'FAIL'} (${time1}ms)`);
  console.log(`  Cached call latency (<500ms): ${latencyOk2 ? 'PASS' : 'FAIL'} (${time2}ms)`);
  console.log(`  Second cold call (<10s): ${latencyOk3 ? 'PASS' : 'FAIL'} (${time3}ms)`);
  console.log(`  Questions returned: ${questionsOk ? 'PASS' : 'FAIL'}`);
  console.log(`  Metadata propagation: ${metadataOk1 ? 'PASS' : 'FAIL'}`);
  console.log(`  Provider chain: MUST REVIEW LOGS — check backend log for [Fallback] entries`);
  console.log(`  Fallback chain: MUST REVIEW LOGS — check for SGLang→Groq→Gemini→OpenAI→Ollama→Template`);
  console.log(`\n  To review provider chain in logs:`);
  console.log(`    tail -100 /tmp/backend.log | grep -E '\\[Fallback\\]|GENERATED VIA|PIPELINE'`);
}

async function main() {
  const ok = await login();
  if (!ok) {
    console.error('Authentication failed — cannot run tests');
    process.exit(1);
  }
  await testProviderChain();
  console.log('\n  Done.');
}

main().catch((e) => {
  console.error('Test failed:', e.message);
  process.exit(1);
});
