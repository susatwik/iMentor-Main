const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const mongoose = require('mongoose');
const { createLearningPath } = require('../services/learning/curriculumOrchestrator');
const User = require('../models/User');

async function testAdminCurriculum() {
    console.log("--- STARTING ADMIN CURRICULUM VERIFICATION ---");
    
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("✓ MongoDB Connected");

        // Find or create a test user
        let user = await User.findOne({ email: 'admin@imentor.com' });
        if (!user) {
            console.log("Admin user not found, using generic test user...");
            user = await User.findOne({});
        }

        if (!user) {
            throw new Error("No users found in database to run curriculum test.");
        }

        console.log(`Using User: ${user.username} (${user._id})`);

        const goal = "Advanced Quantum Computing and its applications in Cryptography";
        console.log(`Goal: ${goal}`);

        // Force Ollama for the test
        user.preferredLlmProvider = 'ollama';
        user.ollamaUrl = 'https://payroll-preferences-lobby-convert.trycloudflare.com';
        user.ollamaModel = 'llama3.2:latest';
        await user.save();

        console.log("Generating curriculum modules...");
        const result = await createLearningPath(user._id, goal);

        if (result.isQuestionnaire) {
            console.log("✅ SUCCESS: System requested clarifications for a broad goal.");
            console.log("Questions:", JSON.stringify(result.questions, null, 2));
        } else {
            console.log("✅ SUCCESS: Curriculum generated directly.");
            console.log(`Title: ${result.title}`);
            console.log(`Modules: ${result.modules.length}`);
            result.modules.forEach((mod, i) => {
                console.log(`  [${i+1}] ${mod.title}`);
            });
        }

    } catch (error) {
        console.error("❌ TEST FAILED:", error);
    } finally {
        await mongoose.disconnect();
        console.log("--- TEST FINISHED ---");
    }
}

testAdminCurriculum();
