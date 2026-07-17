// server/tests/test_model_router.js
const assert = require('assert');
const { calculateComplexityScore, tuneParameters, selectModel } = require('../services/smartModelRouterService');
const { truncateContextToWindow } = require('../utils/tokenOptimizer');

console.log('=== Starting Model Router Optimization Tests ===\n');

// -------------------------------------------------------------
// Test 1: Complexity Scoring Signals
// -------------------------------------------------------------
function testComplexityScoring() {
    console.log('Running testComplexityScoring...');

    // Simple query
    const simpleScore = calculateComplexityScore({ query: 'hello there' });
    assert.ok(simpleScore <= 35, `Simple query should have low score: ${simpleScore}`);

    // Query with math signals
    const mathScore = calculateComplexityScore({ query: 'calculate the integral and eigenvalue of the matrix' });
    assert.ok(mathScore > simpleScore, `Math query should have boosted score: ${mathScore}`);

    // Query with code signals
    const codeScore = calculateComplexityScore({ query: 'implement a class with a function and ```const x = 5```' });
    assert.ok(codeScore > simpleScore, `Code query should have boosted score: ${codeScore}`);

    console.log('✓ testComplexityScoring passed.');
}

// -------------------------------------------------------------
// Test 2: Parameter Tuning
// -------------------------------------------------------------
function testParameterTuning() {
    console.log('Running testParameterTuning...');

    // Code task should result in low temperature
    const codeParams = tuneParameters({ query: 'write code for def my_function()' });
    assert.strictEqual(codeParams.temperature, 0.2, 'Code tasks must use highly deterministic low temp (0.2)');

    // Deep research should use low temp and larger token window
    const researchParams = tuneParameters({ query: 'compare approaches', reasoningMode: 'deep_research' });
    assert.strictEqual(researchParams.temperature, 0.2);
    assert.strictEqual(researchParams.maxOutputTokens, 8192);

    // Standard query
    const standardParams = tuneParameters({ query: 'hello' });
    assert.strictEqual(standardParams.temperature, 0.7);

    console.log('✓ testParameterTuning passed.');
}

// -------------------------------------------------------------
// Test 3: Hybrid Quality-Cost Routing
// -------------------------------------------------------------
async function testHybridRouting() {
    console.log('Running testHybridRouting...');

    process.env.GROQ_API_KEY = 'mock_key';
    process.env.GEMINI_API_KEY = 'mock_key';

    // 1. Ollama is up, but complexity is very low -> route to Ollama (standard local)
    const decision1 = await selectModel({
        query: 'hello',
        isOllamaActive: true,
        complexityScore: 20
    });
    assert.strictEqual(decision1.provider, 'ollama');
    assert.strictEqual(decision1.strategy, 'ollama_default');

    // 2. Ollama is up, but complexity is very high (>=75) -> hybrid routing to cloud provider (Groq/Gemini) for better quality
    const decision2 = await selectModel({
        query: 'analyze the architecture and write complete code',
        isOllamaActive: true,
        complexityScore: 80
    });
    assert.ok(decision2.provider === 'groq' || decision2.provider === 'gemini');
    assert.strictEqual(decision2.strategy, 'high_complexity_hybrid_cloud_fallback');

    console.log('✓ testHybridRouting passed.');
}

// -------------------------------------------------------------
// Test 4: History Truncation and Context Window Limits
// -------------------------------------------------------------
function testHistoryTruncation() {
    console.log('Running testHistoryTruncation...');

    const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'a'.repeat(5000) },
        { role: 'model', content: 'b'.repeat(5000) },
        { role: 'user', content: 'c'.repeat(5000) },
        { role: 'model', content: 'd'.repeat(5000) },
        { role: 'user', content: 'final prompt' }
    ];

    // Limit set to 12000 characters. Since total is 20000+, it must truncate older messages.
    // However, it MUST preserve the system message and the final user prompt.
    const result = truncateContextToWindow(messages, 12000);

    assert.strictEqual(result[0].role, 'system', 'Should keep system message first');
    assert.strictEqual(result[result.length - 1].content, 'final prompt', 'Should keep the most recent user prompt');
    
    // Check total character length of resulting messages is within boundary
    const totalLen = result.reduce((acc, m) => acc + (m.content ? m.content.length : 0), 0);
    assert.ok(totalLen <= 12000, `Resulting length ${totalLen} should be <= 12000`);

    console.log('✓ testHistoryTruncation passed.');
}

// Run all tests
(async () => {
    try {
        testComplexityScoring();
        testParameterTuning();
        await testHybridRouting();
        testHistoryTruncation();
        console.log('\n=== All Model Router Optimization Tests Passed Successfully! ===');
    } catch (error) {
        console.error('\n❌ Test failed:');
        console.error(error);
        process.exit(1);
    }
})();
