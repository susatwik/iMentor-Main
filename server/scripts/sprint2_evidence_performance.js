const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const http = require('http');
const fs = require('fs');

const BASE = 'http://localhost:5001';
const OUT = '/tmp/performance_evidence.txt';

const log = (msg) => {
  process.stdout.write(msg + '\n');
  fs.appendFileSync(OUT, msg + '\n');
};

function httpRequest(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlPath, BASE);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      timeout: 60000,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function flushRedisCache() {
  log('  Flushing Redis cache...');
  const { createClient } = require('redis');
  const client = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
  await client.connect();
  for (const pattern of ['concept_qb:*', 'skilltree:questions:*', 'assessment:*', 'lecture:*']) {
    const keys = await client.keys(pattern);
    if (keys.length) {
      await client.del(keys);
      log(`    Deleted ${keys.length} keys matching ${pattern}`);
    } else {
      log(`    No keys found for ${pattern}`);
    }
  }
  await client.quit();
  log('  Redis flush complete.');
}

async function createTestUser() {
  const email = `perf_test_${Date.now()}@test.com`;
  const password = 'testpass123';

  log(`  Creating test user: ${email}`);

  const otpResp = await httpRequest('POST', '/api/auth/send-otp', { email, password });
  if (otpResp.status !== 200) {
    throw new Error(`send-otp failed: ${JSON.stringify(otpResp.body)}`);
  }
  const devOtp = otpResp.body.devOtp;
  log(`  Received dev OTP: ${devOtp}`);

  const signupResp = await httpRequest('POST', '/api/auth/signup', {
    email,
    otp: devOtp,
    name: 'Performance Test User',
    college: 'Test University',
    universityNumber: 'PERF001',
    degreeType: 'btech',
    branch: 'Computer Science',
    year: '3',
    learningStyle: 'Visual',
    preferredLlmProvider: 'local_llm',
  });
  if (signupResp.status !== 201) {
    throw new Error(`signup failed: ${JSON.stringify(signupResp.body)}`);
  }
  const token = signupResp.body.token;
  log(`  Got JWT token for user`);
  return { email, token };
}

async function measureOp(name, fn, runs) {
  const coldTimes = [];
  const hotTimes = [];

  for (let i = 0; i < runs; i++) {
    log(`  Cold run ${i + 1}/${runs} for "${name}"...`);
    const t0 = Date.now();
    const coldResult = await fn();
    const coldMs = Date.now() - t0;
    coldTimes.push(coldMs);
    log(`    Cold: ${coldMs}ms (status=${coldResult.status})`);

    log(`  Hot run ${i + 1}/${runs} for "${name}"...`);
    const t1 = Date.now();
    const hotResult = await fn();
    const hotMs = Date.now() - t1;
    hotTimes.push(hotMs);
    log(`    Hot: ${hotMs}ms (status=${hotResult.status})`);
  }

  const coldAvg = coldTimes.reduce((a, b) => a + b, 0) / coldTimes.length;
  const hotAvg = hotTimes.reduce((a, b) => a + b, 0) / hotTimes.length;
  const speedup = hotAvg > 0 ? (coldAvg / hotAvg).toFixed(2) : 'N/A';

  return {
    name,
    coldTimes,
    hotTimes,
    coldAvg: Math.round(coldAvg),
    hotAvg: Math.round(hotAvg),
    speedup,
  };
}

async function main() {
  fs.writeFileSync(OUT, '');
  log('='.repeat(72));
  log('SPRINT 2 — Cold vs Cached Performance Timing Evidence');
  log('='.repeat(72));
  log(`Started at: ${new Date().toISOString()}`);
  log('');

  const RUNS = 3;

  let token;
  try {
    const user = await createTestUser();
    token = user.token;
  } catch (err) {
    log(`FATAL: Could not create test user: ${err.message}`);
    process.exit(1);
  }

  log('');

  // --- Operation 1: Assessment Generate ---
  log('─'.repeat(72));
  log('Operation 1: POST /api/assessment/generate');
  log('─'.repeat(72));
  const assessFn = async () => {
    return httpRequest('POST', '/api/assessment/generate', {
      course: 'Data Structures',
      topic: 'Binary Search Trees',
    }, token);
  };
  const assessResult = await measureOp('Assessment Generate', assessFn, RUNS);

  // --- Operation 2: Level Questions ---
  log('─'.repeat(72));
  log('Operation 2: POST /api/gamification/skill-tree/level-questions');
  log('─'.repeat(72));

  const lqFn = async () => {
    return httpRequest('POST', '/api/gamification/skill-tree/level-questions', {
      topic: 'Binary Search Trees',
      levelId: 1,
      levelName: 'Binary Search Trees',
      difficulty: 'medium',
    }, token);
  };
  const lqResult = await measureOp('Level Questions', lqFn, RUNS);

  // --- Summary Table ---
  log('');
  log('='.repeat(72));
  log('SUMMARY TABLE');
  log('='.repeat(72));
  log('');
  log('| Operation                    | Cold (ms) | Hot (ms) | Speedup |');
  log('|------------------------------|-----------|----------|---------|');
  log(formatRow(assessResult));
  log(formatRow(lqResult));
  log('');

  log('='.repeat(72));
  log('DETAILED PER-RUN DATA');
  log('='.repeat(72));
  log('');
  log(`Assessment Generate:`);
  log(`  Cold runs (ms): ${assessResult.coldTimes.join(', ')}`);
  log(`  Hot runs  (ms): ${assessResult.hotTimes.join(', ')}`);
  log(`  Average cold:   ${assessResult.coldAvg} ms`);
  log(`  Average hot:    ${assessResult.hotAvg} ms`);
  log(`  Speedup:        ${assessResult.speedup}x`);
  log('');
  log(`Level Questions:`);
  log(`  Cold runs (ms): ${lqResult.coldTimes.join(', ')}`);
  log(`  Hot runs  (ms): ${lqResult.hotTimes.join(', ')}`);
  log(`  Average cold:   ${lqResult.coldAvg} ms`);
  log(`  Average hot:    ${lqResult.hotAvg} ms`);
  log(`  Speedup:        ${lqResult.speedup}x`);
  log('');

  log(`Finished at: ${new Date().toISOString()}`);
  log('Output written to: ' + OUT);
}

function formatRow(r) {
  const name = r.name.padEnd(28);
  const cold = String(r.coldAvg).padStart(9);
  const hot = String(r.hotAvg).padStart(8);
  const speed = String(r.speedup).padStart(7);
  return `| ${name} | ${cold} | ${hot} | ${speed} |`;
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  log(err.stack);
  process.exit(1);
});
