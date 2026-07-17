// server/tests/test_stn_grounding.js
const assert = require('assert');
const path = require('path');

// 1. Mock geminiService BEFORE requiring socraticTutorService
const geminiService = require('../services/geminiService');

let capturedPrompt = '';
let capturedSystemPrompt = '';

geminiService.generateContentWithHistory = async function (chatHistory, currentQuery, systemPromptText, options) {
    capturedPrompt = currentQuery;
    capturedSystemPrompt = systemPromptText;
    
    // Return a mocked JSON response that matches the expected output of assessStudentResponse
    return JSON.stringify({
        understanding: "CORRECT",
        confidence: "HIGH",
        emotionalState: "CURIOUS",
        effortLevel: "HIGH",
        bloom_level: "understand",
        bloomLevel: 2,
        quality: "CORRECT",
        xpMultiplier: 1.1,
        specificGaps: [],
        reasoning: "The student response accurately defines the concept."
    });
};

// 2. Import socraticTutorService
const { assessStudentResponse } = require('../services/socraticTutorService');

async function runTest() {
    console.log("=== Running STN Grounding Unit Test ===");
    
    const mockStudentResponse = "Binary Search divides the list in half each time to find the item in O(log n).";
    const mockModuleTitle = "Binary Search";
    const mockLastQuestion = "Can you explain how Binary Search works and its complexity?";
    const mockLlmConfig = {
        llmProvider: 'gemini',
        apiKey: 'fake-api-key',
        currentCognitiveLevel: 'L2_APPLICATION'
    };
    const mockHistory = [];
    const mockGroundTruth = "Binary Search is a search algorithm that finds the position of a target value within a sorted array. It compares the target value to the middle element of the array. The time complexity is O(log n).";

    // Call assessStudentResponse with the groundTruth parameter
    const assessment = await assessStudentResponse(
        mockStudentResponse,
        mockModuleTitle,
        mockLastQuestion,
        mockLlmConfig,
        mockHistory,
        mockGroundTruth
    );

    console.log("Assessment Result:", assessment);
    
    // 3. Asserts
    assert.strictEqual(assessment.understanding, "CORRECT");
    assert.strictEqual(assessment.bloomLevel, 2);
    
    console.log("Checking if prompt contains ground truth...");
    assert.ok(capturedPrompt.includes(mockGroundTruth), "Prompt should contain the ground truth text.");
    assert.ok(capturedPrompt.includes("STN Context (ground truth reference)"), "Prompt should contain STN Context section.");
    assert.ok(capturedPrompt.includes("Evaluate the student's response strictly and directly against the \"STN Context (ground truth reference)\""), "Prompt should contain evaluation instructions.");

    console.log("✅ All STN Grounding unit tests passed successfully!");
}

runTest().catch(err => {
    console.error("❌ Test failed:", err);
    process.exit(1);
});
