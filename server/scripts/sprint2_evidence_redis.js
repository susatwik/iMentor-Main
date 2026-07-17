const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { redisClient, connectRedis } = require('../config/redisClient');
const fs = require('fs');

const OUT = '/tmp/redis_evidence.txt';

const log = (msg) => {
  process.stdout.write(msg + '\n');
  fs.appendFileSync(OUT, msg + '\n');
};

const j = (o) => JSON.stringify(o, null, 2);

// Format bytes
const fmtBytes = (b) => {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
};

async function collectKeyDetails(client, key) {
  const ttl = await client.ttl(key);
  const type = await client.type(key);
  let preview = '';
  let parsed = null;

  if (type === 'string') {
    const val = await client.get(key);
    preview = val ? val.substring(0, 200) : '(empty)';
    try { parsed = JSON.parse(val); } catch (_) { /* not JSON */ }
  } else if (type === 'hash') {
    const fields = await client.hLen(key);
    preview = `hash with ${fields} fields`;
  } else if (type === 'set') {
    const card = await client.sCard(key);
    preview = `set with ${card} members`;
  } else if (type === 'list') {
    const len = await client.lLen(key);
    preview = `list with ${len} items`;
  } else if (type === 'zset') {
    const card = await client.zCard(key);
    preview = `zset with ${card} members`;
  } else {
    preview = type;
  }

  return { key, ttl, type, preview, parsed };
}

function renderDetails(info) {
  const lines = [];
  lines.push(`  TTL:        ${info.ttl === -1 ? '∞ (no expiry)' : info.ttl === -2 ? '(expired/missing)' : `${info.ttl}s`}`);
  lines.push(`  Type:       ${info.type}`);
  lines.push(`  Preview:    ${info.preview}`);

  if (info.parsed) {
    if (Array.isArray(info.parsed)) {
      lines.push(`  ├─ Cached items: ${info.parsed.length}`);
    } else if (typeof info.parsed === 'object' && info.parsed !== null) {
      const itemKeys = Object.keys(info.parsed);
      lines.push(`  ├─ Object keys:  ${itemKeys.length} (${itemKeys.slice(0, 8).join(', ')}${itemKeys.length > 8 ? ',...' : ''})`);
      if (info.parsed.cacheTimestamp || info.parsed.timestamp || info.parsed.cachedAt || info.parsed.lastUpdated) {
        const ts = info.parsed.cacheTimestamp || info.parsed.timestamp || info.parsed.cachedAt || info.parsed.lastUpdated;
        lines.push(`  ├─ Timestamp:    ${ts}`);
        const age = Date.now() - new Date(ts).getTime();
        if (!isNaN(age)) {
          lines.push(`  ├─ Age:          ${(age / 1000).toFixed(0)}s (${(age / 60000).toFixed(1)} min)`);
        }
      }
      if (info.parsed.data) {
        const d = info.parsed.data;
        if (Array.isArray(d)) lines.push(`  ├─ Data items:   ${d.length}`);
        else if (typeof d === 'object') lines.push(`  ├─ Data keys:    ${Object.keys(d).length}`);
      }
    }
  }
  return lines.join('\n');
}

async function main() {
  fs.writeFileSync(OUT, '');

  log('='.repeat(72));
  log('SPRINT 2 — Redis Cache Evidence Collection');
  log('='.repeat(72));
  log(`Started at: ${new Date().toISOString()}\n`);

  // Connect
  await connectRedis();
  if (!redisClient || !redisClient.isOpen) {
    log('ERROR: Could not connect to Redis. Is the server running?');
    log('Run: redis-server');
    process.exit(1);
  }

  const client = redisClient;
  log('Connected to Redis successfully.\n');

  // ── 1. Server info ──
  try {
    const info = await client.info('server');
    const uptime = await client.info('uptime');
    const mem = await client.info('memory');
    log('--- Redis Server Info ---');
    const extract = (txt, key) => {
      const m = txt.match(new RegExp(`${key}:(\\S+)`));
      return m ? m[1] : 'N/A';
    };
    log(`  Redis version:        ${extract(info, 'redis_version')}`);
    log(`  Uptime (seconds):     ${extract(uptime, 'uptime_in_seconds')}`);
    log(`  Used memory:          ${extract(mem, 'used_memory_human')}`);
    log(`  Peak memory:          ${extract(mem, 'used_memory_peak_human')}`);
    log(`  Total connections:    ${extract(info, 'total_connections_received')}`);
    log('');
  } catch (e) {
    log(`  (Could not retrieve server info: ${e.message})`);
    log('');
  }

  // ── 2. SCAN all keys ──
  log('='.repeat(72));
  log('ALL REDIS KEYS (SCAN)');
  log('='.repeat(72));
  log('');

  let cursor = '0';
  const allKeys = [];
  let totalSizeEstimate = 0;

  do {
    const reply = await client.scan(cursor, { MATCH: '*', COUNT: 100 });
    cursor = reply.cursor;
    allKeys.push(...reply.keys);
  } while (cursor !== '0');

  log(`Total keys found: ${allKeys.length}\n`);

  if (allKeys.length === 0) {
    log('No keys found in Redis.\n');
    log('='.repeat(72));
    log('SUMMARY');
    log('='.repeat(72));
    log(`  Total keys:              0`);
    log(`  Estimated memory usage:  0 B`);
    log(`  TTL range:               N/A`);
    log(`  Cache patterns found:    none`);
    log('');
    log('Output written to: ' + OUT);
    await client.quit();
    return;
  }

  // ── 3. Iterate each key ──
  const patternGroups = {
    'concept_qb:*': [],
    'skilltree:questions:*': [],
    'assessment:*': [],
    'otp:*': [],
    'other': [],
  };

  for (const key of allKeys) {
    const info = await collectKeyDetails(client, key);

    // Estimate size: key name length + preview length
    const sizeEstimate = Buffer.byteLength(key, 'utf8') + (typeof info.preview === 'string' ? Buffer.byteLength(info.preview, 'utf8') : 100);
    totalSizeEstimate += sizeEstimate;

    // Categorize
    let grouped = false;
    for (const pattern of Object.keys(patternGroups)) {
      if (pattern === 'other') continue;
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      if (regex.test(key)) {
        patternGroups[pattern].push(info);
        grouped = true;
        break;
      }
    }
    if (!grouped) {
      patternGroups['other'].push(info);
    }
  }

  // ── 4. Print by pattern group ──
  const allTtls = [];

  for (const [groupName, keys] of Object.entries(patternGroups)) {
    if (keys.length === 0) continue;

    log(`${'─'.repeat(72)}`);
    log(`Pattern: "${groupName}" — ${keys.length} key(s)`);
    log(`${'─'.repeat(72)}`);
    log('');

    for (const info of keys) {
      log(`  Key:  ${info.key}`);
      log(renderDetails(info));
      log('');
      allTtls.push(info.ttl);
    }
  }

  // ── 5. Summary ──
  const ttls = allTtls.filter(t => t >= 0);
  const ttlMin = ttls.length ? Math.min(...ttls) : 'N/A';
  const ttlMax = ttls.length ? Math.max(...ttls) : 'N/A';
  const ttlAvg = ttls.length ? (ttls.reduce((a, b) => a + b, 0) / ttls.length).toFixed(0) : 'N/A';
  const noExpiry = allTtls.filter(t => t === -1).length;
  const expired = allTtls.filter(t => t === -2).length;

  log('='.repeat(72));
  log('SUMMARY');
  log('='.repeat(72));
  log(`  Total keys:              ${allKeys.length}`);
  log(`  Estimated memory usage:  ${fmtBytes(totalSizeEstimate)}`);
  log(`  TTL range:               ${ttlMin}s — ${ttlMax}s`);
  log(`  TTL avg:                 ${ttlAvg}s`);
  log(`  No expiry (TTL=-1):      ${noExpiry} keys`);
  log(`  Missing (TTL=-2):        ${expired} keys`);
  log('');

  log('  Pattern breakdown:');
  for (const [groupName, keys] of Object.entries(patternGroups)) {
    if (keys.length > 0) {
      log(`    ${groupName.padEnd(30)} ${keys.length} key(s)`);
    }
  }
  log('');

  log('  Key patterns observed:');
  const patterns = {};
  for (const k of allKeys) {
    const base = k.replace(/:\d+$/g, ':*').replace(/:[a-f0-9]{24}$/g, ':*').replace(/-\d+/g, '-*');
    patterns[base] = (patterns[base] || 0) + 1;
  }
  const sorted = Object.entries(patterns).sort((a, b) => b[1] - a[1]);
  for (const [pat, count] of sorted.slice(0, 20)) {
    log(`    ${pat}`);
  }
  if (sorted.length > 20) {
    log(`    ... and ${sorted.length - 20} more unique patterns`);
  }

  log('');
  log('Output written to: ' + OUT);
  log('');

  await client.quit();
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  log(err.stack);
  process.exit(1);
});
