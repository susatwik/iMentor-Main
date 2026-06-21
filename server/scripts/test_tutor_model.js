const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const mongoose = require('mongoose');
const { connectRedis } = require('../config/redisClient');
const { startSocraticSession, processTutorResponse } = require('../services/socraticTutorService');

const mockLlmConfig = {
    llmProvider: 'groq',
    groqModel: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
    apiKey: process.env.GROQ_API_KEY
};

async function testTutorModel() {
    console.log("--- STARTING TUTOR MODEL TEST ---");

    try {
        await mongoose.connect(process.env.MONGO_URI);
        await connectRedis();

        const topic = "Quantum Physics";
        const context = "Quantum physics deals with the behavior of matter and energy at the scale of atoms and subatomic particles.";

        console.log(`\n1. Testing startSocraticSession for topic: ${topic}`);
        const intro = await startSocraticSession(topic, context, mockLlmConfig);
        console.log("Tutor Intro:", intro.substring(0, 150) + "...");

        if (intro && intro.length > 50) {
            console.log("✅ SUCCESS: Tutor intro generated.");
        } else {
            console.log("❌ FAIL: Tutor intro too short or missing.");
        }

        console.log(`\n2. Testing processTutorResponse with student answer`);
        // Mock a session ID (usually these are UUIDs in the real app)
        const mockSessionId = "test-session-" + Date.now();

        // We need to manually set state since we're calling processTutorResponse which expects it
        const { setTutorSessionState } = require('../services/socraticTutorService');
        await setTutorSessionState(mockSessionId, {
            moduleTitle: topic,
            lastQuestion: "What do you know about quantum physics?",
            turnCount: 1,
            struggleCount: 0,
            masteryScore: 10,
            conversationHistory: [],
            position: { topicName: topic, moduleName: "Physics 101" }
        });

        const studentAnswer = "It is about very small particles and how they behave weirdly.";
        const response = await processTutorResponse(studentAnswer, mockSessionId, mockLlmConfig);

        console.log("Tutor Response:", response.followUpQuestion.substring(0, 150) + "...");
        console.log("Classification:", response.classification);
        console.log("Mastery Score:", response.masteryScore);

        if (response.followUpQuestion && response.classification) {
            console.log("✅ SUCCESS: Tutor processed response and generated follow-up.");
        } else {
            console.log("❌ FAIL: Tutor response or classification missing.");
        }

    } catch (error) {
        console.error("❌ TEST FAILED:", error);
    } finally {
        await mongoose.disconnect();
        const { redisClient } = require('../config/redisClient');
        if (redisClient && redisClient.isOpen) {
            await redisClient.disconnect();
        }
    }

    process.exit(0);
}

testTutorModel();
