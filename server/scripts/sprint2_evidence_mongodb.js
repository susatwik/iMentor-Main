const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const fs = require('fs');

const OUT = '/tmp/mongodb_evidence.txt';

// Helper: write to stdout and file
const log = (msg) => {
  process.stdout.write(msg + '\n');
  fs.appendFileSync(OUT, msg + '\n');
};

// Helper: format JSON inline
const j = (o) => JSON.stringify(o, null, 2);

// Helper: compute field completeness %
const fieldCompleteness = (docs, requiredFields) => {
  if (!docs.length) return {};
  const counts = {};
  for (const f of requiredFields) counts[f] = 0;
  for (const d of docs) {
    for (const f of requiredFields) {
      if (d[f] !== undefined && d[f] !== null && d[f] !== '' && !(Array.isArray(d[f]) && d[f].length === 0)) {
        counts[f]++;
      }
    }
  }
  const pct = {};
  for (const f of requiredFields) {
    pct[f] = ((counts[f] / docs.length) * 100).toFixed(1) + '%';
  }
  return pct;
};

async function main() {
  fs.writeFileSync(OUT, ''); // clear output file

  log('='.repeat(72));
  log('SPRINT 2 — MongoDB Evidence Collection');
  log('='.repeat(72));
  log(`Started at: ${new Date().toISOString()}\n`);

  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    log('ERROR: No MONGO_URI or MONGODB_URI found in .env');
    process.exit(1);
  }
  log(`Connecting to: ${mongoUri.replace(/\/\/.*@/, '//***@')}\n`);

  await mongoose.connect(mongoUri);
  log('Connected successfully.\n');

  // ─── 1. ConceptQuestionBank — ALL documents ───────────────────────────────
  log('─'.repeat(72));
  log('COLLECTION: ConceptQuestionBank');
  log('─'.repeat(72));

  const CQB = require('../models/ConceptQuestionBank');
  const cqbDocs = await CQB.find({}).lean();
  log(`Total documents: ${cqbDocs.length}`);
  log(`\n--- FULL DUMP (${cqbDocs.length} docs) ---`);
  log(j(cqbDocs));

  if (cqbDocs.length) {
    const concepts = [...new Set(cqbDocs.map(d => d.concept).filter(Boolean))];
    const difficulties = {};
    const bloomLevels = {};
    for (const d of cqbDocs) {
      const diff = d.difficulty || 'unknown';
      difficulties[diff] = (difficulties[diff] || 0) + 1;
      const bl = d.bloomLevel || 'unknown';
      bloomLevels[bl] = (bloomLevels[bl] || 0) + 1;
    }

    log('\n--- ConceptQuestionBank Summary ---');
    log(`Unique concepts: ${concepts.join(', ')}`);
    log(`Difficulty distribution: ${j(difficulties)}`);
    log(`Bloom level distribution: ${j(bloomLevels)}`);

    const requiredFields = ['course', 'concept', 'question', 'options', 'correctIndex', 'explanation', 'difficulty', 'bloomLevel', 'learningObjective'];
    log('\nField completeness % for 9 required fields:');
    const fc = fieldCompleteness(cqbDocs, requiredFields);
    for (const [f, pct] of Object.entries(fc)) {
      log(`  ${f}: ${pct}`);
    }
  }
  log('');

  // ─── 2. QuestionBank — first 10 ───────────────────────────────────────────
  log('─'.repeat(72));
  log('COLLECTION: QuestionBank');
  log('─'.repeat(72));

  const QB = require('../models/QuestionBank');
  const qbCount = await QB.countDocuments({});
  const qbDocs = await QB.find({}).limit(10).lean();
  log(`Total documents: ${qbCount}`);
  log(`Showing first: ${qbDocs.length}`);
  log(`\n--- FIRST ${qbDocs.length} DOCS ---`);
  log(j(qbDocs));
  log('');

  // ─── 3. SkillTreeGame — first 5 (redact userId) ──────────────────────────
  log('─'.repeat(72));
  log('COLLECTION: SkillTreeGame');
  log('─'.repeat(72));

  const STG = require('../models/SkillTreeGame');
  const stgCount = await STG.countDocuments({});
  const stgDocs = await STG.find({}).limit(5).lean();
  log(`Total documents: ${stgCount}`);
  log(`Showing first: ${stgDocs.length}`);
  const redacted = stgDocs.map(d => ({ ...d, userId: 'REDACTED' }));
  log(`\n--- FIRST ${redacted.length} DOCS (userId REDACTED) ---`);
  log(j(redacted));
  log('');

  // ─── 4. AssessmentResult — first 5 ────────────────────────────────────────
  log('─'.repeat(72));
  log('COLLECTION: AssessmentResult');
  log('─'.repeat(72));

  const AR = require('../models/AssessmentResult');
  const arCount = await AR.countDocuments({});
  const arDocs = await AR.find({}).limit(5).lean();
  log(`Total documents: ${arCount}`);
  log(`Showing first: ${arDocs.length}`);
  log(`\n--- FIRST ${arDocs.length} DOCS ---`);
  log(j(arDocs));
  log('');

  // ─── 5. SkillTree — first 3 ──────────────────────────────────────────────
  log('─'.repeat(72));
  log('COLLECTION: SkillTree');
  log('─'.repeat(72));

  const ST = require('../models/SkillTree');
  const stCount = await ST.countDocuments({});
  const stDocs = await ST.find({}).limit(3).lean();
  log(`Total documents: ${stCount}`);
  log(`Showing first: ${stDocs.length}`);
  log(`\n--- FIRST ${stDocs.length} DOCS ---`);
  log(j(stDocs));
  log('');

  // ─── 6. GamificationProfile — first 2 ─────────────────────────────────────
  log('─'.repeat(72));
  log('COLLECTION: GamificationProfile');
  log('─'.repeat(72));

  const GP = require('../models/GamificationProfile');
  const gpCount = await GP.countDocuments({});
  const gpDocs = await GP.find({}).limit(2).lean();
  log(`Total documents: ${gpCount}`);
  log(`Showing first: ${gpDocs.length}`);
  log(`\n--- FIRST ${gpDocs.length} DOCS ---`);
  log(j(gpDocs));
  log('');

  // ─── Final summary ────────────────────────────────────────────────────────
  log('='.repeat(72));
  log('SUMMARY STATISTICS');
  log('='.repeat(72));
  log(`  ConceptQuestionBank  : ${cqbDocs.length} total, unique concepts: ${[...new Set(cqbDocs.map(d => d.concept).filter(Boolean))].length}`);
  log(`  QuestionBank         : ${qbCount} total (showing ${qbDocs.length})`);
  log(`  SkillTreeGame        : ${stgCount} total (showing ${stgDocs.length}, userId redacted)`);
  log(`  AssessmentResult     : ${arCount} total (showing ${arDocs.length})`);
  log(`  SkillTree            : ${stCount} total (showing ${stDocs.length})`);
  log(`  GamificationProfile  : ${gpCount} total (showing ${gpDocs.length})`);
  log('');

  await mongoose.disconnect();
  log('Done. Output saved to: ' + OUT);
}

main().catch(err => {
  log(`FATAL: ${err.message}`);
  log(err.stack);
  process.exit(1);
});
