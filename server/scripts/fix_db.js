const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function fix() {
  try {
    console.log('Connecting to MONGO_URI...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected.');

    const LLMConfiguration = mongoose.model('LLMConfiguration', new mongoose.Schema({
      modelId: String
    }), 'llmconfigurations');

    const result = await LLMConfiguration.deleteMany({ modelId: 'gemini-2.0-flash' });
    console.log(`Deleted ${result.deletedCount} entries for gemini-2.0-flash.`);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

fix();
