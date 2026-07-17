/**
 * Quick Fix Script for Chat Errors
 * 
 * Fixes:
 * 1. Updates invalid model names in database
 * 2. Checks service availability
 * 3. Provides recommendations
 */

require('dotenv').config();
const mongoose = require('mongoose');
const LLMConfiguration = require('../models/LLMConfiguration');

async function quickFix() {
    console.log('🔧 Chat System Quick Fix\n');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    try {
        // Connect to database
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB\n');

        // Fix 1: Update invalid model names
        console.log('🔧 Fix 1: Updating Invalid Model Names\n');

        const invalidModels = [
            'gemini-1.5-flash-latest',
            'gemini-2.5-flash',
            'gemini-2.0-flash-exp'
        ];

        for (const invalidModel of invalidModels) {
            const count = await LLMConfiguration.countDocuments({ modelId: invalidModel });
            if (count > 0) {
                console.log(`⚠️  Found ${count} instances of deprecated model: ${invalidModel}`);

                // Delete deprecated models (they'll be replaced by valid ones)
                await LLMConfiguration.deleteMany({ modelId: invalidModel });
                console.log(`✅ Deleted deprecated model: ${invalidModel}\n`);
            }
        }

        // Fix 2: Check service availability
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        console.log('🔧 Fix 2: Checking Service Availability\n');

        // Check Python RAG service
        try {
            const response = await fetch('http://127.0.0.1:2001/health');
            if (response.ok) {
                console.log('✅ Python RAG Service: Running');
            } else {
                console.log('⚠️  Python RAG Service: Unhealthy');
            }
        } catch (error) {
            console.log('❌ Python RAG Service: NOT RUNNING');
            console.log('   Start it with: cd python-rag-service && python app.py\n');
        }

        // Check Ollama service (if configured)
        if (process.env.OLLAMA_API_BASE_URL) {
            try {
                const response = await fetch(`${process.env.OLLAMA_API_BASE_URL}/api/tags`);
                if (response.ok) {
                    console.log('✅ Ollama Service: Running');
                } else {
                    console.log('⚠️  Ollama Service: Unhealthy');
                }
            } catch (error) {
                console.log('❌ Ollama Service: NOT RUNNING');
                console.log('   Start it with: ollama serve\n');
            }
        }

        // Fix 3: Check API keys
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        console.log('🔧 Fix 3: Checking API Keys\n');

        if (process.env.GEMINI_API_KEY) {
            console.log('✅ Gemini API Key: Configured');
            console.log('   ⚠️  Note: Free tier has 20 requests/day limit');
        } else {
            console.log('❌ Gemini API Key: NOT CONFIGURED');
        }

        if (process.env.GROQ_API_KEY) {
            console.log('✅ Groq API Key: Configured');
            console.log('   💡 Recommended: Use Groq to avoid quota issues');
        } else {
            console.log('⚠️  Groq API Key: NOT CONFIGURED');
            console.log('   Get one free at: https://console.groq.com');
        }

        // Recommendations
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        console.log('💡 Recommendations\n');

        const geminiCount = await LLMConfiguration.countDocuments({ provider: 'gemini' });
        const groqCount = await LLMConfiguration.countDocuments({ provider: 'groq' });
        const ollamaCount = await LLMConfiguration.countDocuments({ provider: 'ollama' });

        console.log(`📊 Available Providers:`);
        console.log(`   Gemini: ${geminiCount} models (⚠️  20 req/day limit)`);
        console.log(`   Groq: ${groqCount} models (✅ Higher limits)`);
        console.log(`   Ollama: ${ollamaCount} models (✅ No limits, local)`);

        console.log('\n🎯 Recommended Actions:\n');

        if (!process.env.GROQ_API_KEY) {
            console.log('1. ⭐ Get a Groq API key (free, higher limits)');
            console.log('   Visit: https://console.groq.com\n');
        }

        console.log('2. 🔄 Switch to Groq to avoid quota issues');
        console.log('   Update user preference: preferredLlmProvider = "groq"\n');

        console.log('3. 🚀 Start Python RAG service if needed');
        console.log('   cd python-rag-service && python app.py\n');

        console.log('4. 🔄 Restart your Node server');
        console.log('   npm run dev\n');

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        console.log('✅ Quick fix completed!\n');

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await mongoose.connection.close();
    }
}

// Run quick fix
if (require.main === module) {
    quickFix()
        .then(() => process.exit(0))
        .catch((error) => {
            console.error('❌ Quick fix failed:', error);
            process.exit(1);
        });
}

module.exports = { quickFix };
