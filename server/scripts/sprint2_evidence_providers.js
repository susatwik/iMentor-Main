const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const fs = require('fs');
const { callWithFallback, buildFallbackChain, hasApiKey, isOllamaUp, invalidateOllamaHealth } = require('../services/llmFallbackService');

const OUT = '/tmp/provider_evidence.txt';

const log = (msg) => {
  process.stdout.write(msg + '\n');
  fs.appendFileSync(OUT, msg + '\n');
};

const divider = () => log('─'.repeat(72));

const PROMPT = 'Say hello in one word.';
const SYSTEM_PROMPT = 'Respond with a single word.';
const CALL_OPTIONS = { maxOutputTokens: 20, temperature: 0.1 };

async function testProvider(label, opts) {
  log(`\n▶ TEST: ${label}`);
  log(`  preferredProvider: ${opts.preferredProvider}`);
  divider();

  const start = Date.now();
  let result;
  try {
    result = await callWithFallback({
      userQuery: PROMPT,
      systemPrompt: SYSTEM_PROMPT,
      options: { ...CALL_OPTIONS, ...opts.extraOptions },
      preferredProvider: opts.preferredProvider,
      preferLocalFirst: opts.preferLocalFirst !== false,
      userApiKeys: opts.userApiKeys || {},
      ollamaUrl: opts.ollamaUrl || null,
    });
  } catch (err) {
    const elapsed = Date.now() - start;
    log(`  ✗ CRASHED after ${elapsed}ms: ${err.message.slice(0, 200)}`);
    return { label, elapsed, provider: 'crash', error: err.message };
  }

  const elapsed = Date.now() - start;
  const preview = (result.text || '').substring(0, 200).replace(/\n/g, ' ');
  const wasFallback = result.wasFailover ? ' (failover)' : ' (direct hit)';

  log(`  provider attempted → ${result.provider}${wasFallback}`);
  log(`  model → ${result.model}`);
  log(`  time → ${elapsed}ms`);
  log(`  preview → "${preview}"`);
  if (result.errors && result.errors.length > 0) {
    log(`  skipped providers: ${result.errors.map(e => e.provider).join(', ')}`);
  }

  return { label, elapsed, provider: result.provider, model: result.model, wasFailover: result.wasFailover, errors: result.errors || [] };
}

async function reportAvailability() {
  log('\n╔════════════════════════════════════════╗');
  log('║     PROVIDER AVAILABILITY REPORT        ║');
  log('╚════════════════════════════════════════╝\n');

  const checks = {
    sglang: { env: process.env.SGLANG_ENABLED === 'true', key: 'N/A' },
    groq:   { env: true, key: hasApiKey('groq') },
    gemini: { env: true, key: hasApiKey('gemini') },
    openai: { env: true, key: hasApiKey('openai') },
    ollama: { env: true, key: 'N/A' },
  };

  log('Provider    | Env Enabled | API Key Valid | Health');
  log('─'.repeat(55));
  for (const [prov, c] of Object.entries(checks)) {
    let healthy = 'untested';
    if (prov === 'sglang' && c.env) {
      try {
        const axios = require('axios');
        const sglangUrl = process.env.SGLANG_CHAT_URL || 'http://localhost:8000/v1';
        const baseUrl = sglangUrl.replace(/\/v1\/?$/, '').replace(/\/chat\/completions\/?$/, '');
        await axios.get(`${baseUrl}/health`, { timeout: 3000 });
        healthy = '✅ UP';
      } catch { healthy = '❌ DOWN'; }
    }
    if (prov === 'ollama') {
      try { const h = await isOllamaUp(); healthy = h.healthy ? '✅ UP' : '❌ DOWN'; } catch { healthy = '❌ DOWN'; }
    }
    log(`${prov.padEnd(11)} | ${String(c.env).padEnd(12)} | ${String(c.key).padEnd(14)} | ${healthy}`);
  }

  log('\nChain order (preferred first): ' + buildFallbackChain('sglang').join(' → '));
  log('Chain order (cloud-first): ' + buildFallbackChain('groq', false).join(' → '));
}

async function main() {
  fs.writeFileSync(OUT, `=== Provider Fallback Chain Evidence ===\nDate: ${new Date().toISOString()}\n\n`);

  log('Connecting to MongoDB...');
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/imentor';
  await mongoose.connect(uri);
  log('MongoDB connected.\n');

  await reportAvailability();

  const results = [];

  // 1) preferredProvider: 'sglang' — should try SGLang first, fall through chain
  results.push(await testProvider('SGLang preferred → fall through chain', {
    preferredProvider: 'sglang',
  }));

  // 2) preferredProvider: 'groq' — should try Groq first
  results.push(await testProvider('Groq preferred (should try Groq first)', {
    preferredProvider: 'groq',
    preferLocalFirst: false,
  }));

  // 3) preferredProvider: 'ollama' — should try Ollama first
  results.push(await testProvider('Ollama preferred (should try Ollama first)', {
    preferredProvider: 'ollama',
    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
  }));

  // 4) Force template fallback (all providers fail — temporarily disable env keys & ollama)
  const origGroqKey = process.env.GROQ_API_KEY;
  const origGeminiKey = process.env.GEMINI_API_KEY;
  const origOpenaiKey = process.env.OPENAI_API_KEY;
  const origOllamaUrl = process.env.OLLAMA_URL;
  const origOllamaPort = process.env.OLLAMA_PORT;
  process.env.GROQ_API_KEY = '';
  process.env.GEMINI_API_KEY = '';
  process.env.OPENAI_API_KEY = '';
  process.env.OLLAMA_URL = 'http://localhost:19999';
  process.env.OLLAMA_PORT = '19999';
  invalidateOllamaHealth();
  results.push(await testProvider('Force Template fallback (all providers fail)', {
    preferredProvider: 'sglang',
    userApiKeys: { groq: '', gemini: '', openai: '' },
    ollamaUrl: 'http://localhost:19999',
    extraOptions: { timeout: 2000 },
  }));
  process.env.GROQ_API_KEY = origGroqKey;
  process.env.GEMINI_API_KEY = origGeminiKey;
  process.env.OPENAI_API_KEY = origOpenaiKey;
  process.env.OLLAMA_URL = origOllamaUrl;
  process.env.OLLAMA_PORT = origOllamaPort;

  divider();
  log('\n╔════════════════════════════════════════╗');
  log('║          RESULTS SUMMARY               ║');
  log('╚════════════════════════════════════════╝\n');

  log('Test                                     | Provider Served     | Time (ms)');
  log('─'.repeat(70));
  for (const r of results) {
    const label = r.label.padEnd(40);
    const prov  = (r.provider || '?').padEnd(20);
    const time  = String(r.elapsed || '?').padStart(9);
    log(`${label} | ${prov} | ${time}`);
  }

  log(`\nOutput saved to: ${OUT}`);
  await mongoose.disconnect();
  log('Done.');
}

main().catch(err => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
