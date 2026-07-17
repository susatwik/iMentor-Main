/**
 * Sprint 2 — Evidence: Answer Distribution Analysis
 * Generates concept MCQs via API for 9 Data Structures concepts,
 * then computes correct-answer-position distribution, chi-squared test,
 * per-difficulty, and per-Bloom tables.
 *
 * Usage: cd server && node scripts/sprint2_evidence_distribution.js
 * Output saved to /tmp/distribution_evidence.txt
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = process.env.BASE_URL || 'http://localhost:5001';
const API = `${BASE_URL}/api`;

const TEST_EMAIL = `dist_test_${Date.now()}@test.com`;
const TEST_PASSWORD = 'TestPass123!';
const COURSE = 'Data Structures';

const CONCEPTS = [
  'Binary Search Trees',
  'Arrays',
  'Linked Lists',
  'Hash Tables',
  'Stacks',
  'Queues',
  'Sorting Algorithms',
  'Graphs',
  'Trees',
];

const OUTPUT_PATH = '/tmp/distribution_evidence.txt';

let authToken = null;

const LABELS = ['A (index 0)', 'B (index 1)', 'C (index 2)', 'D (index 3)'];

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
function GET(path, token, timeout) { return request('GET', `${API}${path}`, null, token, timeout); }

function chiSquared(observed) {
  const total = observed.reduce((a, b) => a + b, 0);
  const ideal = total / 4;
  let chi = 0;
  for (const v of observed) {
    if (ideal > 0) chi += ((v - ideal) ** 2) / ideal;
  }
  return chi;
}

async function createTestUser(email) {
  const otpResp = await POST('/auth/send-otp', { email, password: TEST_PASSWORD });
  if (otpResp.status === 200 && otpResp.data?.devOtp) {
    // ok
  } else if (otpResp.status === 409) {
    const signin = await POST('/auth/signin', { email, password: TEST_PASSWORD });
    if (signin.status === 200) return signin.data.token;
    console.error(`  Signin failed: ${signin.status}`);
    return null;
  } else {
    console.error(`  send-otp failed: ${otpResp.status} ${JSON.stringify(otpResp.data)}`);
    return null;
  }

  const signupResp = await POST('/auth/signup', {
    email,
    otp: '123456',
    name: 'Distribution Test User',
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
  console.error(`  Signup failed: ${signupResp.status} ${JSON.stringify(signupResp.data)}`);
  return null;
}

async function generateConcept(concept) {
  console.log(`  Generating "${concept}"...`);
  const resp = await POST(
    '/question-bank/concept/generate',
    { course: COURSE, concept, topic: concept },
    authToken,
    180000
  );
  if (resp.status === 200 && resp.data && resp.data.success) {
    const total = resp.data.total || 0;
    console.log(`    → ${total} questions generated`);
    return total;
  }
  console.log(`    → fail: ${resp.status} ${JSON.stringify(resp.data || '').substring(0, 200)}`);
  return 0;
}

async function fetchConceptQuestions(concept, limit = 500) {
  const resp = await GET(
    `/question-bank/concept/${encodeURIComponent(COURSE)}/${encodeURIComponent(concept)}?limit=${limit}`,
    authToken,
    60000
  );
  if (resp.status === 200 && resp.data) {
    return { questions: resp.data.questions || [], total: resp.data.total || 0 };
  }
  return { questions: [], total: 0 };
}

async function main() {
  const output = [];
  const tee = (msg) => { console.log(msg); output.push(msg); };

  tee('# Sprint 2 — Evidence: Answer Distribution Analysis');
  tee('');
  tee(`Started: ${new Date().toISOString()}`);
  tee(`Target:  ${BASE_URL}`);
  tee(`Course:  ${COURSE}`);
  tee('');

  // ── Auth ──
  tee('## Step 1: Auth');
  authToken = await createTestUser(TEST_EMAIL);
  if (!authToken) { tee('FAIL: Could not authenticate.'); fs.writeFileSync(OUTPUT_PATH, output.join('\n') + '\n'); process.exit(1); }
  tee('Authenticated OK');
  tee('');

  // ── Generate concept banks ──
  tee('## Step 2: Generate Concept Banks via API');
  const genResults = [];
  for (const concept of CONCEPTS) {
    const total = await generateConcept(concept);
    genResults.push({ concept, total });
  }

  tee('');
  tee('| Concept | Questions |');
  tee('|---|---|');
  let apiTotal = 0;
  for (const r of genResults) {
    tee(`| ${r.concept} | ${r.total} |`);
    apiTotal += r.total;
  }
  tee(`| **Total** | **${apiTotal}** |`);
  tee('');

  // ── Fetch all questions ──
  tee('## Step 3: Fetch All Questions');
  const allQuestions = [];
  for (const concept of CONCEPTS) {
    const { questions } = await fetchConceptQuestions(concept);
    console.log(`  Fetched ${questions.length} questions for "${concept}"`);
    allQuestions.push(...questions);
  }

  // Deduplicate by question text
  const seen = new Set();
  const uniqueQuestions = [];
  for (const q of allQuestions) {
    const key = (q.question || '').trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    if (q.options && q.options.length === 4 && typeof q.correctIndex === 'number' && q.correctIndex >= 0 && q.correctIndex <= 3) {
      uniqueQuestions.push(q);
    }
  }

  const totalQ = uniqueQuestions.length;
  tee(`Total unique valid MCQs collected: **${totalQ}**`);
  tee('');

  if (totalQ < 30) {
    tee('FAIL: Too few questions for meaningful analysis.');
    fs.writeFileSync(OUTPUT_PATH, output.join('\n') + '\n');
    process.exit(1);
  }

  // ── Distribution ──
  const counts = [0, 0, 0, 0];
  const diffBuckets = {};
  const bloomBuckets = {};

  for (const q of uniqueQuestions) {
    const idx = q.correctIndex;
    counts[idx]++;

    const d = q.difficulty || 'unknown';
    if (!diffBuckets[d]) diffBuckets[d] = [0, 0, 0, 0];
    diffBuckets[d][idx]++;

    const b = q.bloomLevel || 'unknown';
    if (!bloomBuckets[b]) bloomBuckets[b] = [0, 0, 0, 0];
    bloomBuckets[b][idx]++;
  }

  // ── Distribution table (Markdown) ──
  tee('## Step 4: Answer Position Distribution');
  tee('');
  tee('| Option | Count | Percentage |');
  tee('|---|---|---|');
  for (let i = 0; i < 4; i++) {
    const pct = (counts[i] / totalQ * 100).toFixed(1);
    tee(`| ${LABELS[i]} | ${counts[i]} | ${pct}% |`);
  }
  tee(`| **Total** | **${totalQ}** | **100.0%** |`);
  tee('');

  // ── Chi-squared ──
  tee('## Step 5: Chi-Squared Test');
  tee('');
  const chiSq = chiSquared(counts);
  const df = 3;
  const threshold = 7.815; // χ²(3, 0.05)
  const balanced = chiSq <= threshold;
  tee(`χ² = **${chiSq.toFixed(4)}** (df = ${df}, α = 0.05, threshold = ${threshold})`);
  tee(`Result: **${balanced ? 'PASS — Balanced (p > 0.05)' : 'FAIL — Biased (p < 0.05)'}**`);
  tee('');

  // ── Per-difficulty ──
  tee('## Step 6: Per-Difficulty Breakdown');
  tee('');
  tee('| Difficulty | Total | A | B | C | D | χ² |');
  tee('|---|---|---|---|---|---|---|');
  for (const d of ['easy', 'medium', 'hard']) {
    const c = diffBuckets[d];
    if (!c) continue;
    const t = c.reduce((a, b) => a + b, 0);
    const pcts = c.map(v => (v / t * 100).toFixed(1) + '%');
    const chi = chiSquared(c);
    tee(`| ${d} | ${t} | ${pcts[0]} | ${pcts[1]} | ${pcts[2]} | ${pcts[3]} | ${chi.toFixed(3)} |`);
  }
  tee('');

  // ── Per-Bloom ──
  tee('## Step 7: Per-Bloom-Level Breakdown');
  tee('');
  tee('| Bloom Level | Total | A | B | C | D | χ² |');
  tee('|---|---|---|---|---|---|---|');
  for (const bl of ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create']) {
    const c = bloomBuckets[bl];
    if (!c) continue;
    const t = c.reduce((a, b) => a + b, 0);
    const pcts = c.map(v => (v / t * 100).toFixed(1) + '%');
    const chi = chiSquared(c);
    tee(`| ${bl} | ${t} | ${pcts[0]} | ${pcts[1]} | ${pcts[2]} | ${pcts[3]} | ${chi.toFixed(3)} |`);
  }
  tee('');

  // ── Summary ──
  tee('---');
  tee('## Summary');
  tee('');
  tee(`- **Total unique MCQs analyzed:** ${totalQ}`);
  tee(`- **Chi-squared (df=3):** ${chiSq.toFixed(4)}`);
  tee(`- **Threshold (α=0.05):** ${threshold}`);
  tee(`- **Distribution balanced?** ${balanced ? 'YES' : 'NO'}`);
  tee('');
  tee('| Option | Count | Percentage |');
  tee('|---|---|---|');
  for (let i = 0; i < 4; i++) {
    const pct = (counts[i] / totalQ * 100).toFixed(1);
    tee(`| ${LABELS[i]} | ${counts[i]} | ${pct}% |`);
  }

  fs.writeFileSync(OUTPUT_PATH, output.join('\n') + '\n', 'utf-8');
  console.log(`\nOutput saved to ${OUTPUT_PATH}`);
}

main().catch(async (e) => {
  console.error('Fatal:', e);
  fs.writeFileSync(OUTPUT_PATH, `Fatal error: ${e.message}\n${e.stack || ''}`, 'utf-8');
  process.exit(1);
});
