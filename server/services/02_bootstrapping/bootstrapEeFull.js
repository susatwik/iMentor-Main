/**
 * Full EE bootstrap integration script.
 *
 * Steps:
 *   1. PDF → CSV (bootstrapPipeline.js via bootstrap:syllabus)
 *   2. Validate CSV
 *   3. Convert 22-col CSV → 5-col unified CSV (for RAG pipeline)
 *   4. Generate keywords for EE CSV
 *   5. Print summary
 */

const path = require('path');
const fs = require('fs-extra');
const log = require('../../utils/logger');

const BOOTSTRAP_DIR = path.join(__dirname, '../../course_bootstrap');

class EeBootstrapFull {
  async run(department = 'EE') {
    const deptDir = path.join(BOOTSTRAP_DIR, department);
    const csvPath = path.join(deptDir, 'syllabus.csv');
    const unifiedPath = path.join(deptDir, 'syllabus_unified.csv');
    const keywordPath = path.join(deptDir, 'syllabus_keywords_added.csv');
    const pdfPath = path.join(deptDir, 'syllabus.pdf');

    if (!fs.existsSync(pdfPath)) {
      throw new Error(`PDF not found: ${pdfPath}`);
    }

    const startTime = Date.now();
    const results = { steps: {} };

    // Step 1: PDF → CSV (via bootstrapPipeline)
    log.info('EE Full Bootstrap', 'Step 1: PDF → CSV generation');
    const BootstrapPipeline = require('../bootstrapPipeline.js');
    const pipeline = new BootstrapPipeline();
    results.steps.pdfCsv = await pipeline.runPipeline(department);
    log.success('EE Full Bootstrap', `Step 1 complete: ${results.steps.pdfCsv.csvGenerator.recordsCount} records`);

    // Step 2: Convert to unified CSV format
    log.info('EE Full Bootstrap', 'Step 2: Convert to unified CSV format');
    const EeCsvToUnifiedConverter = require('./convertEeCsvToUnified.js');
    const converter = new EeCsvToUnifiedConverter();
    results.steps.unified = converter.convert(csvPath, unifiedPath);
    log.success('EE Full Bootstrap', `Step 2 complete: ${results.steps.unified.rows} unified rows`);

    // Step 3: Generate keywords
    log.info('EE Full Bootstrap', 'Step 3: Generate keywords for CSV');
    const KeywordGenerator = require('../keywordGenerator.js');
    const kwGen = new KeywordGenerator();
    try {
      results.steps.keywords = await kwGen.processCsvWithKeywords(csvPath, keywordPath);
      log.success('EE Full Bootstrap', `Step 3 complete: keywords written to ${path.basename(keywordPath)}`);
    } catch (kwErr) {
      log.warn('EE Full Bootstrap', `Keyword generation skipped: ${kwErr.message}`);
      results.steps.keywords = { skipped: true, message: kwErr.message };
    }

    const duration = Date.now() - startTime;
    results.duration = duration;
    results.department = department;

    this._printSummary(results, deptDir);
    return results;
  }

  _printSummary(results, deptDir) {
    const s = results.steps;
    const sep = '─'.repeat(56);

    console.log('');
    console.log(`  ${sep}`);
    console.log(`  ${'EE Bootstrap Pipeline — Complete'.padStart(34)}`);
    console.log(`  ${sep}`);
    console.log(`  Department    :  ${results.department}`);
    console.log(`  Directory     :  ${deptDir}`);
    console.log(`  Duration      :  ${results.duration}ms`);
    console.log(`  ${sep}`);
    console.log(`  ✓ PDF → CSV          :  ${s.pdfCsv?.csvGenerator?.recordsCount || '—'} records`);
    console.log(`  ✓ Validation         :  ${s.pdfCsv?.validator?.isValid ? 'PASS' : '—'}`);
    console.log(`  ✓ Unified CSV        :  ${s.unified?.rows || '—'} rows`);
    console.log(`  ✓ Keywords           :  ${s.keywords?.skipped ? 'skipped' : 'done'}`);
    console.log(`  ${sep}`);
    console.log(`  Outputs:`);
    console.log(`    ${deptDir}/syllabus.csv`);
    console.log(`    ${deptDir}/syllabus_unified.csv`);
    if (!s.keywords?.skipped) {
      console.log(`    ${deptDir}/syllabus_keywords_added.csv`);
    }
    console.log(`  ${sep}`);
    console.log(`  Next: Run the Python RAG pipeline to generate:`);
    console.log(`    • Neo4j curriculum graph`);
    console.log(`    • Skill tree`);
    console.log(`    • Study questions`);
    console.log(`    • Lecture notes`);
    console.log(`  ${sep}`);
    console.log(`  Command:  python bootstrap_course.py "${results.department}" \\`);
    console.log(`              --course-dir ${deptDir} \\`);
    console.log(`              --rag-url http://localhost:2001`);
    console.log('');
  }

  async runFromCli() {
    const department = process.argv[2] || 'EE';
    try {
      await this.run(department);
    } catch (err) {
      log.error('EE Full Bootstrap', 'Fatal:', err);
      process.exit(1);
    }
  }
}

if (require.main === module) {
  const boot = new EeBootstrapFull();
  boot.runFromCli();
}

module.exports = EeBootstrapFull;
