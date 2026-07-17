// server/scripts/test_context_routing.js
const queryClassifierService = require('../services/queryClassifierService');
const { selectLLM } = require('../services/llmRouterService');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

async function runTests() {
    console.log('--- Phase 1: Classification Verification ---');
    const queries = [
        { text: "Write a python function to sort a list", expected: "code" },
        { text: "Solve the equation x^2 + 5x + 6 = 0", expected: "technical" },
        { text: "Write a short story about a brave knight", expected: "creative" },
        { text: "Translate 'Hello' to Spanish", expected: "multilingual" },
        { text: "Tell me about the EU AI Act", expected: "research" },
        { text: "How are you today?", expected: "general" }
    ];

    let passedClassifications = 0;
    queries.forEach(q => {
        const result = queryClassifierService.classify(q.text);
        if (result === q.expected) {
            console.log(`[PASS] "${q.text.substring(0, 30)}..." -> ${result}`);
            passedClassifications++;
        } else {
            console.log(`[FAIL] "${q.text.substring(0, 30)}..." -> Expected ${q.expected}, got ${result}`);
        }
    });

    console.log(`\nClassification Summary: ${passedClassifications}/${queries.length} passed\n`);

    console.log('--- Phase 2: Router Integration Verification ---');
    try {
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/imentor');

        const context = { user: { preferredLlmProvider: 'ollama', ollamaUrl: process.env.OLLAMA_API_BASE_URL } };
        const result = await selectLLM("Write a story", context);

        console.log('Routing Result:', {
            logic: result.logic,
            category: result.queryCategory,
            isABTest: result.isABTest,
            model: result.chosenModel.modelId
        });

        if (result.queryCategory === 'creative') {
            console.log('[PASS] Router correctly identified category and returned metadata.');
        } else {
            console.log('[FAIL] Router metadata mismatch.');
        }

        console.log('\n--- Phase 3: A/B Testing Verification (Statistical) ---');
        let abCount = 0;
        const totalRuns = 50;
        for (let i = 0; i < totalRuns; i++) {
            const abResult = await selectLLM("Hello there", context);
            if (abResult.isABTest) abCount++;
        }
        console.log(`A/B Test Frequency: ${abCount}/${totalRuns} (Expected ~5 at 10%)`);

    } catch (err) {
        console.error('Database connection or routing error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

runTests();
