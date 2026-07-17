// server/scripts/createTestUser.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const User = require('../models/User');
const log = require('../utils/logger');

const args = process.argv.slice(2);
const email = args[0] || 'testuser@imentor.com';
const password = args[1] || 'password123';
const username = args[2] || 'test_tester';

async function createTestUser() {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
        console.error("MONGO_URI not found in .env");
        process.exit(1);
    }

    try {
        await mongoose.connect(mongoUri);
        log.info('SYSTEM', 'Connected to MongoDB for user creation');

        const existingUser = await User.findOne({ 
            $or: [{ email: email }, { username: username }] 
        });

        if (existingUser) {
            log.warn('SYSTEM', `User with email ${email} or username ${username} already exists.`);
            process.exit(0);
        }

        const newUser = new User({
            email,
            password,
            username,
            isAdmin: false,
            hasCompletedOnboarding: true,
            profile: {
                name: 'Test Assistant',
                college: 'iMentor Lab',
                universityNumber: 'TEST-001'
            }
        });

        await newUser.save();
        log.success('SYSTEM', `Test user created successfully!`);
        console.log('-----------------------------------');
        console.log(`Email:    ${email}`);
        console.log(`Password: ${password}`);
        console.log(`Username: ${username}`);
        console.log('-----------------------------------');

    } catch (error) {
        log.error('SYSTEM', 'Failed to create test user', error);
    } finally {
        await mongoose.connection.close();
        process.exit(0);
    }
}

createTestUser();
