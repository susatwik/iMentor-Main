// Script to fix LLM configurations - set gemini-2.5-flash as the only default
require('dotenv').config();
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/chatbot_gemini';

async function fixLLMConfig() {
    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(MONGO_URI);
        console.log('Connected to MongoDB');

        const LLMConfiguration = mongoose.connection.collection('llmconfigurations');

        // First, show current configs
        console.log('\n--- Current LLM Configurations ---');
        const configs = await LLMConfiguration.find({}).toArray();
        configs.forEach(c => {
            console.log(`  - ${c.modelId} | Provider: ${c.provider} | Default: ${c.isDefault}`);
        });

        // Step 1: Set ALL Gemini models to isDefault: false
        await LLMConfiguration.updateMany(
            { provider: 'gemini' },
            { $set: { isDefault: false } }
        );
        console.log('\n✓ Set all Gemini models to isDefault: false');

        // Step 2: Delete deprecated/wrong models
        const deleteResult = await LLMConfiguration.deleteMany({
            provider: 'gemini',
            modelId: { $in: ['gemini-2.5-pro-latest', 'gemini-1.5-pro-latest', 'gemini-1.5-flash-latest', 'gemini-2.0-flash-lite'] }
        });
        console.log(`✓ Deleted ${deleteResult.deletedCount} deprecated Gemini model(s)`);

        // Step 3: Check if gemini-2.5-flash exists
        const flashModel = await LLMConfiguration.findOne({ modelId: 'gemini-2.5-flash' });

        if (!flashModel) {
            // Check for gemini-2.5-flash-latest and rename it
            const flashLatest = await LLMConfiguration.findOne({ modelId: 'gemini-2.5-flash-latest' });
            if (flashLatest) {
                await LLMConfiguration.updateOne(
                    { _id: flashLatest._id },
                    { $set: { modelId: 'gemini-2.5-flash', isDefault: true, updatedAt: new Date() } }
                );
                console.log('✓ Renamed gemini-2.5-flash-latest to gemini-2.5-flash and set as default');
            } else {
                // Create new
                await LLMConfiguration.insertOne({
                    modelId: 'gemini-2.5-flash',
                    provider: 'gemini',
                    isDefault: true,
                    strengths: 'general',
                    description: 'Gemini 2.5 Flash - Fast and capable',
                    createdAt: new Date(),
                    updatedAt: new Date()
                });
                console.log('✓ Created new gemini-2.5-flash configuration as default');
            }
        } else {
            // Just make it the default
            await LLMConfiguration.updateOne(
                { modelId: 'gemini-2.5-flash' },
                { $set: { isDefault: true, updatedAt: new Date() } }
            );
            console.log('✓ Set existing gemini-2.5-flash as default');
        }

        // Show updated configs
        console.log('\n--- Updated LLM Configurations ---');
        const updatedConfigs = await LLMConfiguration.find({}).toArray();
        updatedConfigs.forEach(c => {
            console.log(`  - ${c.modelId} | Provider: ${c.provider} | Default: ${c.isDefault}`);
        });

        console.log('\n✅ Done! Restart the server for changes to take effect.');

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await mongoose.disconnect();
        process.exit(0);
    }
}

fixLLMConfig();
