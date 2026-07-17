const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const User = require('../models/User');

async function switchToOllama() {
    try {
        await mongoose.connect(process.env.MONGO_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log('Connected to MongoDB');

        // Update all users to use Ollama instead of Gemini
        const result = await User.updateMany(
            {},
            {
                $set: {
                    preferredLlmProvider: 'ollama',
                    ollamaUrl: 'http://localhost:11434',
                    ollamaModel: process.env.OLLAMA_DEFAULT_MODEL || 'qwen2.5:3b-instruct'
                }
            }
        );

        console.log(`✅ Updated ${result.modifiedCount} users to use Ollama`);
        console.log(`   Provider: ollama`);
        console.log(`   URL: http://localhost:11434`);
        console.log(`   Model: ${process.env.OLLAMA_DEFAULT_MODEL || 'qwen2.5:3b-instruct'}`);

        await mongoose.disconnect();
        console.log('\n✅ Done! Users are now configured to use Ollama.');
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

switchToOllama();
