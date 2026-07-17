const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27018/chatbot_autoresearch';
console.log('Connecting to:', mongoUri);

mongoose.connect(mongoUri)
  .then(async () => {
    console.log('Connected successfully!');
    
    const User = require('../models/User');
    const users = await User.find({}).lean();
    console.log('--- USER DATA ---');
    users.forEach(u => {
      console.log(`User: ${u.username} (${u.email})`);
      console.log('Progress:', JSON.stringify(u.curriculumProgress, null, 2));
    });

    const TutorSession = require('../models/TutorSession');
    const tutorSessions = await TutorSession.find({}).lean();
    console.log('--- TUTOR SESSIONS ---');
    tutorSessions.forEach(ts => {
      console.log(`Session: ${ts.sessionId}, Topic: ${ts.topic}`);
      console.log(`State:`, JSON.stringify(ts.state, null, 2));
    });
    
    process.exit(0);
  })
  .catch(err => {
    console.error('Connection failed:', err);
    process.exit(1);
  });
