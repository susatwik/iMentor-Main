// server/scripts/updateUserPreferences.js
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
const User = require('../models/User');

async function updatePreferences() {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/imentor');
    console.log('Connected to MongoDB.');

    const result = await User.updateMany(
      {}, 
      { $set: { preferredLlmProvider: 'ollama' } }
    );

    console.log(`Successfully updated ${result.modifiedCount} users to 'ollama' as default provider.`);
    process.exit(0);
  } catch (err) {
    console.error('Update failed:', err);
    process.exit(1);
  }
}

updatePreferences();
