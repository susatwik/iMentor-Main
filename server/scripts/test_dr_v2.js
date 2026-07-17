/**
 * Deep Research v2 — Live Regression Test
 *
 * Reruns the same query that exposed 6 bugs in the first evaluation and
 * prints a step-by-step comparison table at the end.
 *
 * Usage:
 *   node server/scripts/test_dr_v2.js
 */

'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const mongoose  = require('mongoose');
const orchestrator = require('../services/deepResearchOrchestrator');
const User         = require('../models/User');

// ─────────────────────────────────────────────────────────────────────────────
// v1 baseline (battery SoC/RuL 2025-2026 IEEE-only query — first eval)
// Kept for diff display; new query has no prior baseline so diff shows "n/a"
// ─────────────────────────────────────────────────────────────────────────────
const BASELINE = {
    totalSources:    4,
    targetSources:   65,
    hitRate:         '6%',
    confidence:      4,
    fallbackStages:  4,
    ieeeHit:         false,
    yearFilterApplied: false,
    openAlexMetadataNull: true,
    evidenceProfileEmpty: true,
    offTopicSections: 2,
    verifiedClaims:  0,
    factCheckSilentFail: true,
};

const QUERY   = 'Deep learning, physics informed neural networks and Deep reinforcement learning methods in SOC and RUL of batteries';
const NATURE  = 'academic';
const DEPTH   = 'high';

// ─────────────────────────────────────────────────────────────────────────────
const HR  = '─'.repeat(72);
const HDR = '═'.repeat(72);

function ts() {
    return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function pad(label, width = 40) {
    return String(label).padEnd(width);
}

function formatConstraints(c = {}) {
    const parts = [];
    if (c.yearStart) parts.push(`years:${c.yearStart}-${c.yearEnd || c.yearStart}`);
    if (c.venueFilter) parts.push(`venue:${c.venueFilter}`);
    return parts.length ? parts.join(' | ') : 'none';
}

async function run() {
    console.log('\n' + HDR);
    console.log('  Deep Research v2 — Live Regression Test');
    console.log(`  Query  : ${QUERY}`);
    console.log(`  Config : ${NATURE} / ${DEPTH}`);
    console.log(HDR);

    // ── Connect MongoDB ──────────────────────────────────────────────────────
    const MONGO = process.env.MONGO_URI || 'mongodb://localhost:27017/imentor';
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 8000 });
    console.log(`\n[${ts()}] MongoDB connected: ${MONGO}`);

    // ── Find test user ───────────────────────────────────────────────────────
    const user = await User.findOne({ email: 'ultra.boy7@gmail.com' }).lean();
    const userId = user?._id || null;
    console.log(`[${ts()}] User: ${user?.email || 'NOT FOUND'} (${userId || 'no id'})\n`);

    // ─────────────────────────────────────────────────────────────────────────
    // Monitoring state
    // ─────────────────────────────────────────────────────────────────────────
    const phases       = [];
    let   constraintLog  = null;
    let   fallbackCount  = 0;
    let   l3Triggered    = false;
    const phaseTimings   = {};
    let   lastPhase      = null;
    let   lastPhaseTime  = Date.now();
    const startTime      = Date.now();

    // ─────────────────────────────────────────────────────────────────────────
    // Progress callback
    // ─────────────────────────────────────────────────────────────────────────
    function onProgress({ phase, message }) {
        const now     = Date.now();
        const elapsed = ((now - startTime) / 1000).toFixed(1);
        const delta   = lastPhase ? `+${((now - lastPhaseTime) / 1000).toFixed(1)}s` : '+0.0s';

        if (phase !== 'token') {
            console.log(`[${ts()}] [${String(elapsed).padStart(6)}s ${delta.padStart(8)}]  ${pad(phase, 22)}  ${message}`);
            phases.push({ phase, message, elapsedMs: now - startTime });
            phaseTimings[phase] = now - startTime;
            lastPhase     = phase;
            lastPhaseTime = now;
        }

        // Detect fallback triggers
        if (phase === 'searching_online' && /adaptive retrieval/i.test(message)) {
            fallbackCount++;
            if (/L3/i.test(message)) l3Triggered = true;
        }
        // Detect constraint extraction
        if (phase === 'generating_queries' && /constraints/i.test(message)) {
            constraintLog = message;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Run
    // ─────────────────────────────────────────────────────────────────────────
    let result = null;
    let runError = null;
    try {
        result = await orchestrator.runDeepResearch(
            QUERY,
            { userId, nature: NATURE, depth: DEPTH, forceRefresh: true },
            onProgress
        );
    } catch (err) {
        runError = err;
        console.error(`\n[ERROR] Research failed: ${err.message}`);
    }

    const totalMs = Date.now() - startTime;

    // ─────────────────────────────────────────────────────────────────────────
    // Inspect result
    // ─────────────────────────────────────────────────────────────────────────
    const bundle   = result?.researchBundle  || {};
    const report   = result?.researchReport  || {};
    const ep       = bundle.evidenceProfile  || {};
    const pb       = bundle.providerBreakdown || ep.providerBreakdown || {};
    const sources  = bundle.sources          || [];
    const sections = report.sections         || [];
    const claims   = bundle.verifiedClaimsData || [];
    const conf     = bundle.overallConfidenceScore || 0;
    const constraints = ep.appliedConstraints || {};

    // ─── Source provider breakdown ───────────────────────────────────────────
    const oaCount   = sources.filter(s => s.sourceProvider === 'openalex').length;
    const ssCount   = sources.filter(s => s.sourceProvider === 'semantic_scholar').length;
    const axCount   = sources.filter(s => s.sourceProvider === 'arxiv').length;
    const webCount  = sources.filter(s => !['openalex','semantic_scholar','arxiv'].includes(s.sourceProvider)).length;
    const ieeeCount = sources.filter(s => {
        const j = (s.journal || s.publisher || '').toLowerCase();
        return j.includes('ieee') || j.includes('institute of electrical');
    }).length;

    // ─── Metadata completeness (openAlex) ────────────────────────────────────
    const oaSources = sources.filter(s => s.sourceProvider === 'openalex');
    const oaWithYear    = oaSources.filter(s => s.year).length;
    const oaWithDoi     = oaSources.filter(s => s.doi).length;
    const oaWithJournal = oaSources.filter(s => s.journal).length;
    const oaWithAbstract = oaSources.filter(s => s.abstract && s.abstract.length > 20).length;

    // ─── Off-topic section detection ─────────────────────────────────────────
    const OFF_TOPIC = [
        /\beconom/i, /\bcapital\b/i, /\binvestor\b/i, /\bgeopolit\b/i,
        /\bfinancial\b/i, /\bstock market\b/i, /\bfiscal\b/i,
        /\bmonetary\b/i, /\bcurrency\b/i, /\bpolitical\b/i,
    ];
    const offTopicSections = sections.filter(s =>
        OFF_TOPIC.some(re => re.test(s.title || ''))
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Print results
    // ─────────────────────────────────────────────────────────────────────────

    console.log('\n' + HDR);
    console.log('  STEP-BY-STEP PHASE SUMMARY');
    console.log(HDR);
    phases.forEach((p, i) => {
        const t = (p.elapsedMs / 1000).toFixed(1);
        console.log(`  ${String(i+1).padStart(2)}.  [${String(t).padStart(6)}s]  ${pad(p.phase, 24)}  ${p.message.slice(0, 80)}`);
    });

    console.log('\n' + HDR);
    console.log('  SOURCE BREAKDOWN (this run)');
    console.log(HDR);
    console.log(`  Total sources retrieved  : ${sources.length}  (target: ${bundle.researchConfig?.target_source_count || 65})`);
    console.log(`  Hit rate                 : ${sources.length > 0 ? ((sources.length / (bundle.researchConfig?.target_source_count || 65)) * 100).toFixed(0) + '%' : 'n/a'}`);
    console.log(`  OpenAlex                 : ${oaCount}`);
    console.log(`  Semantic Scholar         : ${ssCount}`);
    console.log(`  ArXiv                    : ${axCount}`);
    console.log(`  Web                      : ${webCount}`);
    console.log(`  IEEE-tagged sources      : ${ieeeCount}`);
    console.log(`  Confidence score         : ${conf}%`);
    console.log(`  Fallback stages triggered: ${fallbackCount}  (L3 unconstrained: ${l3Triggered ? 'YES ✓' : 'NO'})`);
    console.log(`  Applied constraints      : ${formatConstraints(constraints)}`);
    console.log(`  Constraint log           : ${constraintLog || 'none detected'}`);
    console.log(`  Total time               : ${(totalMs / 1000).toFixed(1)}s`);

    console.log('\n' + HR);
    console.log('  OPENALEX METADATA COMPLETENESS');
    console.log(HR);
    if (oaSources.length > 0) {
        console.log(`  Sources from OA          : ${oaSources.length}`);
        console.log(`  with year                : ${oaWithYear}/${oaSources.length}  ${oaWithYear === oaSources.length ? '✓' : '✗ MISSING'}`);
        console.log(`  with DOI                 : ${oaWithDoi}/${oaSources.length}  ${oaWithDoi === oaSources.length ? '✓' : '(partial — normal if no DOI)'}`);
        console.log(`  with journal name        : ${oaWithJournal}/${oaSources.length}  ${oaWithJournal === oaSources.length ? '✓' : '(partial)'}`);
        console.log(`  with abstract            : ${oaWithAbstract}/${oaSources.length}  ${oaWithAbstract === oaSources.length ? '✓' : '✗ MISSING'}`);
    } else {
        console.log('  No OpenAlex sources retrieved this run.');
    }

    console.log('\n' + HR);
    console.log('  EVIDENCE PROFILE (stored)');
    console.log(HR);
    const epEmpty = !ep || Object.keys(ep).length === 0;
    console.log(`  evidenceProfile populated: ${!epEmpty ? 'YES ✓' : 'EMPTY ✗'}`);
    if (!epEmpty) {
        console.log(`  totalSourcesUsed         : ${ep.totalSourcesUsed}`);
        console.log(`  empiricalSources         : ${ep.empiricalSources}`);
        console.log(`  industrySources          : ${ep.industrySources}`);
        console.log(`  retrievalMode            : ${ep.retrievalMode}`);
        console.log(`  providerBreakdown        : OA=${pb.openAlex||0} SS=${pb.semanticScholar||0} Ax=${pb.arxiv||0} Web=${pb.web||0}`);
        console.log(`  appliedConstraints       : ${formatConstraints(ep.appliedConstraints)}`);
    }

    console.log('\n' + HR);
    console.log('  SYNTHESIS');
    console.log(HR);
    console.log(`  Report title             : ${report.title || '(none)'}`);
    console.log(`  Sections generated       : ${sections.length}`);
    sections.forEach((s, i) => {
        const offTopic = OFF_TOPIC.some(re => re.test(s.title || ''));
        const flag = offTopic ? '  ← OFF-TOPIC ✗' : '';
        console.log(`    ${String(i+1).padStart(2)}. ${s.title}${flag}`);
    });
    console.log(`  Off-topic sections       : ${offTopicSections.length}  (${offTopicSections.length === 0 ? '✓ CLEAN' : '✗ ' + offTopicSections.map(s => s.title).join(', ')})`);

    console.log('\n' + HR);
    console.log('  FACT CHECKING');
    console.log(HR);
    console.log(`  Verified claims          : ${claims.length}  (${claims.length > 0 ? '✓' : '✗ zero'})`);
    if (claims.length > 0) {
        const strong = claims.filter(c => c.strength_of_evidence === 'Strong').length;
        console.log(`  Strong evidence claims   : ${strong}/${claims.length}`);
        console.log(`  Example claim            : "${(claims[0]?.claim || '').slice(0, 100)}"`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Before / After comparison
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n' + HDR);
    console.log('  BEFORE vs AFTER COMPARISON  (v1 baseline → v2 this run)');
    console.log(HDR);

    const hitRate    = sources.length > 0 ? Math.round((sources.length / (bundle.researchConfig?.target_source_count || 65)) * 100) : 0;

    function diff(label, before, after, better = (a,b) => a !== b) {
        const improved = better(before, after);
        const arrow = improved ? '→  ✓ IMPROVED' : '→  ~ unchanged';
        console.log(`  ${pad(label, 30)} ${pad(String(before), 18)} ${arrow}  ${after}`);
    }

    console.log(`\n  ${'Metric'.padEnd(30)} ${'v1 (before)'.padEnd(18)} ${'Direction'.padEnd(16)} v2 (this run)`);
    console.log('  ' + '─'.repeat(68));
    diff('Total sources',         BASELINE.totalSources,    sources.length,           (a,b) => b > a);
    diff('Hit rate',              BASELINE.hitRate,         hitRate + '%',             (a,b) => b !== a);
    diff('Confidence score',      BASELINE.confidence + '%', conf + '%',              (a,b) => parseInt(b) > parseInt(a));
    diff('Fallback stages hit',   BASELINE.fallbackStages,  fallbackCount,             (a,b) => b < a);
    diff('L3 unconstrained',      'NO',                     l3Triggered ? 'YES' : 'NO', (a,b) => b === 'YES');
    diff('Year filter applied',   'NO',                     constraints.yearStart ? 'YES' : 'NO', (a,b) => b === 'YES');
    diff('IEEE venue filter',     'NO',                     constraints.venueFilter === 'IEEE' ? 'YES' : 'NO', (a,b) => b === 'YES');
    diff('IEEE-tagged sources',   0,                        ieeeCount,                 (a,b) => b > a);
    diff('OA metadata null',      'YES (all null)',          oaSources.length ? (oaWithYear + '/' + oaSources.length + ' have year') : 'no OA sources', (a,b) => b !== a);
    diff('evidenceProfile empty', 'YES',                    !epEmpty ? 'NO (populated)' : 'YES', (a,b) => b === 'NO (populated)');
    diff('Off-topic sections',    BASELINE.offTopicSections, offTopicSections.length,  (a,b) => b < a);
    diff('Verified claims',       BASELINE.verifiedClaims,  claims.length,             (a,b) => b > a);
    diff('FactCheck silent fail', 'YES',                    claims.length > 0 ? 'NO (returned claims)' : 'YES (still 0)', (a,b) => b.startsWith('NO'));

    console.log('\n' + HDR);
    if (runError) {
        console.log(`  RESULT: FAILED — ${runError.message}`);
    } else {
        const improvements = [
            sources.length > BASELINE.totalSources,
            l3Triggered,
            constraints.yearStart,
            constraints.venueFilter === 'IEEE',
            !epEmpty,
            offTopicSections.length < BASELINE.offTopicSections,
            claims.length > BASELINE.verifiedClaims,
        ].filter(Boolean).length;
        console.log(`  RESULT: ${improvements}/7 areas improved vs v1 baseline`);
    }
    console.log(HDR + '\n');

    // Sample top-3 sources
    if (sources.length > 0) {
        console.log('  TOP 3 SOURCES:');
        sources.slice(0, 3).forEach((s, i) => {
            console.log(`  ${i+1}. [${s.sourceProvider}] ${(s.title || 'Untitled').slice(0, 80)}`);
            console.log(`     year=${s.year || 'null'} | doi=${s.doi || 'null'} | journal=${(s.journal || 'null').slice(0,50)}`);
            console.log(`     abstract=${s.abstract ? s.abstract.slice(0,80) + '...' : 'NULL'}`);
        });
        console.log('');
    }

    await mongoose.disconnect();
    process.exit(runError ? 1 : 0);
}

run().catch(err => {
    console.error('[FATAL]', err.message, err.stack);
    process.exit(1);
});
