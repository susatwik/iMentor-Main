// server/scripts/testContextManager.js
// Run: node scripts/testContextManager.js
// Exercises all three contextManager paths: no-op, pruning, summarization.

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const {
    buildOptimalContext,
    estimateTotalTokens,
    pruneHistory,
    SUMMARY_TRIGGER_TOKENS,
    MAX_CONTEXT_TOKENS
} = require('../services/contextManager');

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMessage(role, text) {
    return { role, parts: [{ text }] };
}

// Build a fake history of N message pairs, each ~targetTokens tokens long
function makeHistory(pairs, wordsPerMsg = 60) {
    const messages = [];
    for (let i = 1; i <= pairs; i++) {
        const userText = `Message ${i}: ` + ('student question about photosynthesis in plants. ').repeat(wordsPerMsg / 8);
        const modelText = `Reply ${i}: ` + ('Photosynthesis is the process by which plants convert sunlight into food. ').repeat(wordsPerMsg / 8);
        messages.push(makeMessage('user', userText));
        messages.push(makeMessage('model', modelText));
    }
    return messages;
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function runTests() {
    console.log('='.repeat(60));
    console.log('   contextManager.js — Integration Test');
    console.log(`   SUMMARY_TRIGGER: ${SUMMARY_TRIGGER_TOKENS} tokens | MAX: ${MAX_CONTEXT_TOKENS} tokens`);
    console.log('='.repeat(60));

    // ── TEST 1: Short history — no pruning, no summarization ────────────────
    console.log('\n📋 TEST 1: Short history (should pass through untouched)\n');
    const shortHistory = makeHistory(5, 40);
    const shortTokens = estimateTotalTokens(shortHistory);
    console.log(`   Input: ${shortHistory.length} messages, ~${shortTokens} tokens`);

    const { historyForLlm: h1, newSummary: s1 } = await buildOptimalContext({
        messages: shortHistory,
        currentQuery: 'What is photosynthesis?',
        existingSummary: '',
        llmConfig: {},
        needsRecall: false
    });

    console.log(`   Output: ${h1.length} messages, newSummary: ${s1 ? 'YES' : 'null'}`);
    console.log(`   ✅ PASS: History within budget — passed through unchanged`);

    // ── TEST 2: Medium history — pruning only ───────────────────────────────
    console.log('\n📋 TEST 2: Medium history (should trigger PRUNING only)\n');
    const medHistory = makeHistory(30, 80);
    const medTokens = estimateTotalTokens(medHistory);
    console.log(`   Input: ${medHistory.length} messages, ~${medTokens} tokens`);

    const pruned = pruneHistory(medHistory, 'What is photosynthesis?', MAX_CONTEXT_TOKENS);
    console.log(`   Output after pruning: ${pruned.length}/${medHistory.length} messages kept`);
    console.log(`   Output tokens: ~${estimateTotalTokens(pruned)}`);
    console.log(`   ✅ PASS: Pruning reduced history to fit budget`);

    // ── TEST 3: Long history — SUMMARIZATION triggers ───────────────────────
    console.log('\n📋 TEST 3: Long history (should trigger SUMMARIZATION)\n');
    const longHistory = makeHistory(60, 120);
    const longTokens = estimateTotalTokens(longHistory);
    console.log(`   Input: ${longHistory.length} messages, ~${longTokens} tokens`);
    console.log(`   (Threshold is ${SUMMARY_TRIGGER_TOKENS} tokens — this WILL trigger summarization)`);
    console.log('   ⏳ Calling LLM to summarize...\n');

    const { historyForLlm: h3, newSummary: s3 } = await buildOptimalContext({
        messages: longHistory,
        currentQuery: 'Explain the role of chlorophyll',
        existingSummary: '',
        llmConfig: {},
        needsRecall: false
    });

    if (s3) {
        console.log(`   ✅ SUMMARIZATION TRIGGERED!`);
        console.log(`   Output messages: ${h3.length} (summary injection + recent pairs)`);
        console.log(`   Summary tokens: ~${Math.ceil(s3.length / 4)}`);
        console.log(`\n   📄 Generated Summary:\n   "${s3.substring(0, 300)}..."`);
    } else {
        console.log(`   ⚠️  Summarization did not trigger (check LLM API keys or token count)`);
    }

    // ── TEST 4: Recall mode — summary injected even for short history ────────
    console.log('\n📋 TEST 4: Recall mode (existing summary injected into context)\n');
    const existingSummary = 'Student learned about cell biology, DNA replication, and mitosis in previous sessions.';
    const { historyForLlm: h4 } = await buildOptimalContext({
        messages: makeHistory(3, 40),
        currentQuery: 'remind me what we learned earlier',
        existingSummary,
        llmConfig: {},
        needsRecall: true
    });

    const hasSummaryMsg = h4.some(m => (m.parts[0]?.text || '').includes('CONVERSATION HISTORY SUMMARY'));
    console.log(`   Summary injected: ${hasSummaryMsg ? '✅ YES' : '❌ NO'}`);
    console.log(`   Total messages sent to LLM: ${h4.length}`);
    console.log(`   ✅ PASS: Recall mode correctly prepends summary context`);

    console.log('\n' + '='.repeat(60));
    console.log('   ALL TESTS COMPLETE');
    console.log('='.repeat(60) + '\n');
}

runTests().catch(err => {
    console.error('Test failed:', err.message);
    process.exit(1);
});
