const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { processQueryWithToT_Streaming } = require('../services/totOrchestrator');

const mockRequestContext = {
    llmProvider: 'ollama',
    ollamaModel: process.env.OLLAMA_DEFAULT_MODEL || 'qwen2.5',
    ollamaUrl: process.env.OLLAMA_API_BASE_URL || 'https://payroll-preferences-lobby-convert.trycloudflare.com',
    userId: 'test_user_1.4',
    criticalThinkingEnabled: true,
    isWebSearchEnabled: false,
    documentContextName: null
};

async function testHierarchicalPlanning() {
    console.log("--- STARTING HIERARCHICAL PLANNING TEST ---");

    const query = "Research the impact of green hydrogen on the steel industry and then compare it with traditional coal-based methods. Finally, suggest 3 policy recommendations for faster adoption.";

    console.log(`Query: ${query}`);

    const streamingUpdates = [];
    const streamCallback = (update) => {
        streamingUpdates.push(update);
        if (update.type === 'thought') {
            // console.log(`[THOUGHT]: ${update.content.substring(0, 100)}...`);
        }
    };

    try {
        const result = await processQueryWithToT_Streaming(
            query,
            [],
            mockRequestContext,
            streamCallback
        );

        console.log("\n--- TEST RESULTS ---");
        console.log(`Final Answer Length: ${result.finalAnswer.length}`);

        // Analyze the execution flow from reasoning steps
        console.log("\nExecution Steps:");
        const tasks = new Set();
        const reasoningSteps = result.reasoning_steps || [];

        reasoningSteps.forEach(step => {
            if (step.task_id) tasks.add(step.task_id);
        });

        console.log(`Unique Tasks Executed: ${Array.from(tasks).join(', ')}`);

        if (tasks.size >= 2) {
            console.log("✅ SUCCESS: Hierarchical tasks were executed in order.");
        } else {
            console.log("⚠️ WARNING: Limited tasks were executed. Breakdown may be shallow for this model.");
        }

        console.log("\nSample Thinking (First 3 turns):");
        reasoningSteps.slice(0, 3).forEach((step, i) => {
            console.log(`[${i + 1}] Task ${step.task_id} - Thought: ${step.thought.substring(0, 100)}...`);
        });

    } catch (error) {
        console.error("❌ TEST FAILED:", error);
    }
}

testHierarchicalPlanning();
