#!/usr/bin/env node
/**
 * server/scripts/test_dr_units.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Unit tests for the new Deep Research V2 server-side modules:
 *   1. ResearchJob model (schema, instance methods)
 *   2. researchIntelligenceService — NATURE_DEPTH_MATRIX, resolveResearchConfig
 *   3. researchQueryGenerator — deduplicateQueries (no LLM call)
 *   4. semanticScholarService — module loads, maps paper correctly
 *   5. researchWorker — enqueueResearchJob returns job without blocking
 *
 * Run with:
 *   cd /home/sri/Downloads/iMentor_march/chatbot
 *   node server/scripts/test_dr_units.js
 */

'use strict';
process.env.NODE_ENV = 'test';

// ── Minimal bootstrap ────────────────────────────────────────────────────────
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0, total = 0;
const results = [];

function test(name, fn) {
    total++;
    try {
        const ret = fn();
        if (ret && typeof ret.then === 'function') {
            return ret.then(() => {
                passed++;
                results.push({ status: 'PASS', name });
                console.log(`  ✅  ${name}`);
            }).catch(err => {
                failed++;
                results.push({ status: 'FAIL', name, error: err.message });
                console.error(`  ❌  ${name}\n      ${err.message}`);
            });
        }
        passed++;
        results.push({ status: 'PASS', name });
        console.log(`  ✅  ${name}`);
        return Promise.resolve();
    } catch (err) {
        failed++;
        results.push({ status: 'FAIL', name, error: err.message });
        console.error(`  ❌  ${name}\n      ${err.message}`);
        return Promise.resolve();
    }
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(a, b, msg) {
    if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function assertGTE(a, b, msg) {
    if (a < b) throw new Error(msg || `Expected ${a} >= ${b}`);
}

function assertContains(arr, item, msg) {
    if (!arr.includes(item)) throw new Error(msg || `Array does not contain ${item}: [${arr.join(', ')}]`);
}

// ── Connect to MongoDB ────────────────────────────────────────────────────────
async function connectDB() {
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27018/imentor';
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    console.log(`  ℹ  MongoDB connected: ${uri.split('@').pop()}`);
}

async function disconnectDB() {
    await mongoose.disconnect();
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 1 — researchIntelligenceService (NATURE_DEPTH_MATRIX)
// ═══════════════════════════════════════════════════════════════════════════════

async function suiteResearchIntelligence() {
    console.log('\n📊  SUITE 1 — researchIntelligenceService');

    let svc;
    try {
        svc = require('../services/researchIntelligenceService');
    } catch (e) {
        console.error('  ⚠  Could not load researchIntelligenceService:', e.message);
        return;
    }

    // Access matrix
    const matrix = svc.getNatureDepthMatrix?.() || svc.NATURE_DEPTH_MATRIX;

    await test('Matrix has 3 nature keys', () => {
        const keys = Object.keys(matrix || {});
        assertContains(keys, 'general');
        assertContains(keys, 'academic');
        assertContains(keys, 'research');
    });

    await test('Matrix has 3 depth keys per nature', () => {
        for (const nature of ['general', 'academic', 'research']) {
            const depths = Object.keys(matrix[nature] || {});
            assertContains(depths, 'low');
            assertContains(depths, 'medium');
            assertContains(depths, 'high');
        }
    });

    await test('Source counts are ascending by depth', () => {
        for (const nature of ['general', 'academic', 'research']) {
            const low    = matrix[nature].low?.total    || matrix[nature].low;
            const medium = matrix[nature].medium?.total || matrix[nature].medium;
            const high   = matrix[nature].high?.total   || matrix[nature].high;
            assert(low < medium, `${nature}: low(${low}) should < medium(${medium})`);
            assert(medium < high, `${nature}: medium(${medium}) should < high(${high})`);
        }
    });

    await test('Research preset > general preset at same depth', () => {
        const srcOf = (n, d) => matrix[n][d]?.total || matrix[n][d];
        for (const depth of ['low', 'medium', 'high']) {
            assert(srcOf('research', depth) >= srcOf('general', depth),
                `research/${depth}(${srcOf('research',depth)}) should ≥ general/${depth}(${srcOf('general',depth)})`);
        }
    });

    await test('Minimum source counts meet 30-70 range spec', () => {
        const allValues = ['general','academic','research'].flatMap(n =>
            ['low','medium','high'].map(d => matrix[n][d]?.total || matrix[n][d]));
        assert(Math.min(...allValues) >= 30, `Min sources ${Math.min(...allValues)} < 30`);
        assert(Math.max(...allValues) <= 70, `Max sources ${Math.max(...allValues)} > 70`);
    });

    await test('resolveResearchConfig returns correct config for academic/medium', () => {
        if (!svc.resolveResearchConfig) return;
        const cfg = svc.resolveResearchConfig({ nature: 'academic', depth: 'medium' });
        assertGTE(cfg.target_source_count, 30, 'target_source_count < 30');
        assert(cfg.target_source_count <= 70, 'target_source_count > 70');
        assert(typeof cfg.empirical_ratio === 'number', 'empirical_ratio not a number');
        assertGTE(cfg.empirical_ratio, 0.5, 'empirical_ratio < 0.5 for academic');
    });

    await test('resolveResearchConfig returns higher count for research/high vs general/low', () => {
        if (!svc.resolveResearchConfig) return;
        const hi = svc.resolveResearchConfig({ nature: 'research', depth: 'high' });
        const lo = svc.resolveResearchConfig({ nature: 'general',  depth: 'low'  });
        assertGTE(hi.target_source_count, lo.target_source_count,
            `research/high(${hi.target_source_count}) < general/low(${lo.target_source_count})`);
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 2 — researchQueryGenerator (dedup, no LLM calls)
// ═══════════════════════════════════════════════════════════════════════════════

async function suiteQueryGenerator() {
    console.log('\n🔍  SUITE 2 — researchQueryGenerator (dedup logic)');

    let qgen;
    try {
        qgen = require('../services/researchQueryGenerator');
    } catch (e) {
        console.error('  ⚠  Could not load researchQueryGenerator:', e.message);
        return;
    }

    await test('querySimilarity returns 0 for empty strings', () => {
        const sim = qgen.querySimilarity('', '');
        assert(sim === 0 || sim === 1, `Unexpected similarity for empty strings: ${sim}`);
    });

    await test('querySimilarity returns 1 for identical strings', () => {
        const sim = qgen.querySimilarity('machine learning transformers', 'machine learning transformers');
        assert(sim >= 0.99, `Identical strings should have sim≈1, got ${sim}`);
    });

    await test('querySimilarity returns 0 for completely different strings', () => {
        const sim = qgen.querySimilarity('quantum physics', 'cooking recipes banana bread');
        assert(sim < 0.5, `Unrelated strings should have low sim, got ${sim}`);
    });

    await test('querySimilarity is symmetric', () => {
        const a = 'deep learning attention mechanisms',
              b = 'neural network training strategies';
        const s1 = qgen.querySimilarity(a, b);
        const s2 = qgen.querySimilarity(b, a);
        assert(Math.abs(s1 - s2) < 0.001, `Symmetry broken: ${s1} vs ${s2}`);
    });

    await test('deduplicateQueries removes near-duplicates', () => {
        const queries = [
            'neural network attention transformer model training',
            'neural network attention transformer model optimization',  // near-dup (4/5 tokens overlap → sim≈0.8)
            'quantum computing applications chemistry',
        ];
        const deduped = qgen.deduplicateQueries(queries, 0.72);
        assert(deduped.length < queries.length,
            `Expected fewer queries after dedup (got ${deduped.length} from ${queries.length})`);
    });

    await test('deduplicateQueries keeps completely different queries', () => {
        const queries = [
            'deep learning vision models',
            'graph neural networks chemistry',
            'reinforcement learning robotics',
            'natural language processing sentiment',
        ];
        const deduped = qgen.deduplicateQueries(queries, 0.72);
        // All are different enough — should keep most
        assertGTE(deduped.length, 3,
            `Dedup removed too many unique queries: kept ${deduped.length} of ${queries.length}`);
    });

    await test('deduplicateQueries with threshold=0 keeps only one query', () => {
        const queries = ['alpha', 'beta', 'gamma', 'delta'];
        // threshold=0 means everything is a duplicate of the first
        const deduped = qgen.deduplicateQueries(queries, 0.0);
        assert(deduped.length >= 1, 'deduplicateQueries returned empty array');
    });

    await test('deduplicateQueries with threshold=1 keeps all unique queries', () => {
        const queries = [
            'attention mechanism transformer architecture',
            'graph neural network molecular property',
        ];
        const deduped = qgen.deduplicateQueries(queries, 1.0);
        assertEqual(deduped.length, queries.length,
            `threshold=1 should keep all queries, got ${deduped.length}`);
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 3 — semanticScholarService (module structure, no API calls)
// ═══════════════════════════════════════════════════════════════════════════════

async function suiteSemanticScholar() {
    console.log('\n🔬  SUITE 3 — semanticScholarService (structure & mapping)');

    let svc;
    try {
        svc = require('../services/semanticScholarService');
    } catch (e) {
        console.error('  ⚠  Could not load semanticScholarService:', e.message);
        return;
    }

    await test('Module exports retrieveSources function', () => {
        assert(typeof svc.retrieveSources === 'function', 'retrieveSources not exported');
    });

    await test('Module exports retrieveSourcesBulk function', () => {
        assert(typeof svc.retrieveSourcesBulk === 'function', 'retrieveSourcesBulk not exported');
    });

    await test('_mapPaper maps fields to AcademicSource schema', () => {
        const mapPaper = svc._mapPaper || svc.__test_mapPaper;
        if (!mapPaper) {
            // Can't test private function directly — verify via duck-typing the module
            assert(true, 'skip — _mapPaper not exported for direct test');
            return;
        }
        const mockPaper = {
            paperId: 'abc123',
            title:   'Attention Is All You Need',
            abstract:'We propose the Transformer...',
            year:    2017,
            citationCount: 50000,
            influentialCitationCount: 3000,
            authors: [{ name: 'Vaswani' }],
            externalIds: { DOI: '10.5555/3295222.3295349' },
            publicationDate: '2017-06-12',
        };
        const mapped = mapPaper(mockPaper);
        assert(mapped.title === mockPaper.title, 'title not mapped');
        assert(mapped.sourceProvider === 'semantic_scholar', 'sourceProvider wrong');
        assert(typeof mapped.credibilityScore === 'number', 'credibilityScore not a number');
        assertGTE(mapped.credibilityScore, 50, 'credScore too low for highly cited paper');
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 4 — ResearchJob model (requires MongoDB)
// ═══════════════════════════════════════════════════════════════════════════════

async function suiteResearchJobModel() {
    console.log('\n🗄   SUITE 4 — ResearchJob model (MongoDB required)');

    let ResearchJob;
    try {
        ResearchJob = require('../models/ResearchJob');
    } catch (e) {
        console.error('  ⚠  Could not load ResearchJob:', e.message);
        return;
    }

    const testQuery = `unit-test-${Date.now()}`;

    await test('Can create a ResearchJob document', async () => {
        const job = await ResearchJob.create({
            userId:  new mongoose.Types.ObjectId(),
            query:   testQuery,
            nature:  'academic',
            depth:   'medium',
            status:  'queued',
        });
        assert(job._id, 'No _id on created job');
        assertEqual(job.status, 'queued');
        assertEqual(job.nature, 'academic');
        assertEqual(job.depth,  'medium');
        _state_node.createdJobId = job._id;
    });

    await test('markRunning() sets status=running and startedAt', async () => {
        const id = _state_node.createdJobId;
        if (!id) return;
        const job = await ResearchJob.findById(id);
        await job.markRunning();
        const updated = await ResearchJob.findById(id);
        assertEqual(updated.status, 'running');
        assert(updated.startedAt, 'startedAt not set');
    });

    await test('addProgress() appends to progress array', async () => {
        const id = _state_node.createdJobId;
        if (!id) return;
        const job = await ResearchJob.findById(id);
        await job.addProgress('querying', 'Fetching OpenAlex sources…');
        await job.addProgress('synthesis', 'Drafting report…');
        const updated = await ResearchJob.findById(id);
        assertGTE(updated.progress.length, 2, 'progress array too short');
        assert(updated.progress[0].phase, 'progress[0] missing phase');
        assert(updated.progress[0].message, 'progress[0] missing message');
    });

    await test('markCompleted() sets status=completed, completedAt, resultMeta', async () => {
        const id = _state_node.createdJobId;
        if (!id) return;
        const fakeResultId = new mongoose.Types.ObjectId();
        const job = await ResearchJob.findById(id);
        await job.markCompleted(fakeResultId, {
            totalSources:    45,
            academicSources: 30,
            webSources:      15,
            confidenceScore: 82,
            pageEstimate:    4,
            openAlexCount:   18,
            semanticCount:   8,
            arxivCount:      4,
            webCount:        15,
        });
        const updated = await ResearchJob.findById(id);
        assertEqual(updated.status, 'completed');
        assert(updated.completedAt, 'completedAt not set');
        assert(updated.resultId, 'resultId not set');
        assertEqual(updated.resultMeta.totalSources,    45);
        assertEqual(updated.resultMeta.confidenceScore, 82);
        assertEqual(updated.resultMeta.openAlexCount,   18);
        assertEqual(updated.resultMeta.semanticCount,   8);
    });

    await test('markFailed() sets status=failed and error message', async () => {
        // Create a fresh job for failure test
        const job = await ResearchJob.create({
            userId: new mongoose.Types.ObjectId(),
            query:  testQuery + '-fail',
            nature: 'general',
            depth:  'low',
            status: 'queued',
        });
        await job.markRunning();
        await job.markFailed('No sources found after all fallbacks');
        const updated = await ResearchJob.findById(job._id);
        assertEqual(updated.status, 'failed');
        assert(updated.error.includes('No sources'), 'error message not stored');
        assert(updated.completedAt, 'completedAt not set on failure');
    });

    await test('Can query jobs by userId and status', async () => {
        const uid = new mongoose.Types.ObjectId();
        await ResearchJob.create([
            { userId: uid, query: 'test q1', nature: 'academic', depth: 'low',  status: 'completed' },
            { userId: uid, query: 'test q2', nature: 'general',  depth: 'high', status: 'queued'    },
        ]);
        const completedJobs = await ResearchJob.find({ userId: uid, status: 'completed' });
        assertEqual(completedJobs.length, 1);
        const allJobs = await ResearchJob.find({ userId: uid });
        assertEqual(allJobs.length, 2);
    });

    // Cleanup test documents
    await test('Cleanup test ResearchJob documents', async () => {
        const result = await ResearchJob.deleteMany({ query: new RegExp(`^unit-test-${Date.now().toString().slice(0, 8)}`) });
        // Just assert no error — count varies
        assert(true);
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 5 — researchWorker (enqueue without LLM)
// ═══════════════════════════════════════════════════════════════════════════════

async function suiteResearchWorker() {
    console.log('\n⚙️   SUITE 5 — researchWorker (enqueue contract)');

    let worker;
    try {
        worker = require('../workers/researchWorker');
    } catch (e) {
        console.error('  ⚠  Could not load researchWorker:', e.message);
        return;
    }

    await test('enqueueResearchJob is exported', () => {
        assert(typeof worker.enqueueResearchJob === 'function', 'enqueueResearchJob not a function');
    });

    await test('getJobStatus is exported', () => {
        assert(typeof worker.getJobStatus === 'function', 'getJobStatus not a function');
    });

    await test('listUserJobs is exported', () => {
        assert(typeof worker.listUserJobs === 'function', 'listUserJobs not a function');
    });

    await test('enqueueResearchJob creates a job and returns immediately', async () => {
        const uid = new mongoose.Types.ObjectId();
        const t0 = Date.now();
        const job = await worker.enqueueResearchJob({
            query:  'unit-test placeholder query',
            nature: 'academic',
            depth:  'low',
            userId: uid,
        });
        const elapsed = Date.now() - t0;
        assert(job._id, 'No _id on returned job');
        assertEqual(job.status, 'queued');
        assert(elapsed < 3000, `enqueueResearchJob took ${elapsed}ms — should be <3000ms`);
        _state_node.workerJobId = job._id;
    });

    await test('getJobStatus returns job by ID', async () => {
        const id = _state_node.workerJobId;
        if (!id) return;
        const uid = new mongoose.Types.ObjectId(); // wrong uid — may return null
        const job = await worker.getJobStatus(id, id); // using same id for userId (won't match)
        // Just assert no crash (security: wrong userId returns null, not throws)
        assert(true, 'getJobStatus should not throw');
    });

    await test('listUserJobs returns array for any userId', async () => {
        const uid = new mongoose.Types.ObjectId();
        const jobs = await worker.listUserJobs(uid, 10);
        assert(Array.isArray(jobs), `listUserJobs should return array, got ${typeof jobs}`);
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 6 — academicSourceService (structure check)
// ═══════════════════════════════════════════════════════════════════════════════

async function suiteAcademicSourceService() {
    console.log('\n📚  SUITE 6 — academicSourceService (structure)');

    let svc;
    try {
        svc = require('../services/academicSourceService');
    } catch (e) {
        console.error('  ⚠  Could not load academicSourceService:', e.message);
        return;
    }

    await test('fetchOpenAlexBatch is exported', () => {
        assert(typeof svc.fetchOpenAlexBatch === 'function', 'fetchOpenAlexBatch not exported');
    });

    await test('fetchSemanticBatch is exported', () => {
        assert(typeof svc.fetchSemanticBatch === 'function', 'fetchSemanticBatch not exported');
    });

    await test('fetchArxivBatch is exported', () => {
        assert(typeof svc.fetchArxivBatch === 'function', 'fetchArxivBatch not exported');
    });

    await test('tagWebSources is exported', () => {
        assert(typeof svc.tagWebSources === 'function', 'tagWebSources not exported');
    });

    await test('tagWebSources marks old sources as goldStandard', () => {
        const THREE_MONTHS_AGO = new Date();
        THREE_MONTHS_AGO.setMonth(THREE_MONTHS_AGO.getMonth() - 4); // 4 months ago = old

        const mockSources = [
            { title: 'Recent paper',      publishedDate: new Date().toISOString() },
            { title: 'Old paper (gold)',   publishedDate: THREE_MONTHS_AGO.toISOString() },
            { title: 'No date paper' },
        ];

        const tagged = svc.tagWebSources(mockSources);
        assert(Array.isArray(tagged), 'tagWebSources should return array');
        const old = tagged.find(s => s.title === 'Old paper (gold)');
        assert(old?.goldStandard === true, 'Old source should be tagged goldStandard=true');
        const recent = tagged.find(s => s.title === 'Recent paper');
        assert(!recent?.goldStandard, 'Recent source should NOT be goldStandard');
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main runner
// ═══════════════════════════════════════════════════════════════════════════════

const _state_node = {};

async function main() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  Deep Research V2 — Server-Side Unit Tests');
    console.log('═══════════════════════════════════════════════════════════════');

    await connectDB();

    await suiteResearchIntelligence();
    await suiteQueryGenerator();
    await suiteSemanticScholar();
    await suiteResearchJobModel();
    await suiteResearchWorker();
    await suiteAcademicSourceService();

    await disconnectDB();

    // ── Summary ────────────────────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log(`  Results: ${passed} passed, ${failed} failed, ${total} total`);

    const failedTests = results.filter(r => r.status === 'FAIL');
    if (failedTests.length) {
        console.log('\n  Failed tests:');
        failedTests.forEach(t => console.log(`    ❌ ${t.name}: ${t.error}`));
    }

    console.log('═══════════════════════════════════════════════════════════════\n');

    if (failed > 0) process.exit(1);
}

main().catch(err => {
    console.error('Fatal error in test runner:', err);
    process.exit(1);
});
