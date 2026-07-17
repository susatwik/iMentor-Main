// server/scripts/test_routing_optimization.js
const { selectLLM } = require('../services/llmRouterService');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function runTests() {
    try {
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/imentor');
        console.log('✓ Connected to MongoDB');

        const context = { user: { preferredLlmProvider: 'ollama', ollamaUrl: process.env.OLLAMA_API_BASE_URL } };

        console.log('\n--- Phase 1: Complexity-Aware Selection ---');
        const testCases = [
            { q: "Hi", expectedComplexity: 'low' },
            { q: "Explain the theory of relativity in detail", expectedComplexity: 'medium' },
            { q: "Implement a sharded database architecture in Go with Raft consensus", expectedComplexity: 'high' }
        ];

        for (const tc of testCases) {
            const start = Date.now();
            const result = await selectLLM(tc.q, context);
            const duration = Date.now() - start;
            console.log(`Query: "${tc.q}"`);
            console.log(`- Category: ${result.queryCategory}`);
            console.log(`- Complexity (Calculated): ${result.logic.split('_').pop()}`);
            console.log(`- Chosen Model: ${result.chosenModel.modelId}`);
            console.log(`- Latency: ${duration}ms`);
        }

        console.log('\n--- Phase 2: Redis Caching (Sub-5ms Target) ---');
        const recurringQuery = "How to sort a list in Python?";

        console.log('First call (Cold)...');
        const start1 = Date.now();
        await selectLLM(recurringQuery, context);
        console.log(`Latency: ${Date.now() - start1}ms`);

        console.log('Second call (Hot/Cache)...');
        const start2 = Date.now();
        const result2 = await selectLLM(recurringQuery, context);
        const duration2 = Date.now() - start2;
        console.log(`Latency: ${duration2}ms`);

        if (duration2 < 10) {
            console.log('[PASS] Redis cache hit target met (< 10ms)');
        } else {
            console.log('[FAIL] Cache latency too high or cache miss');
        }

        console.log('\n--- Phase 3: Stress Test (Latency Target < 50ms) ---');
        let totalLatency = 0;
        const runs = 20;
        for (let i = 0; i < runs; i++) {
            const start = Date.now();
            await selectLLM(`Test query ${i} ${Math.random()}`, context);
            totalLatency += (Date.now() - start);
        }
        const avg = totalLatency / runs;
        console.log(`Average Latency across ${runs} random queries: ${avg}ms`);
        if (avg < 50) {
            console.log('[PASS] Routing optimization target met (< 50ms average)');
        } else {
            console.log('[WARNING] Average latency above 50ms target.');
        }

    } catch (err) {
        console.error('Test Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

runTests();
