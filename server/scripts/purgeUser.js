// server/scripts/purgeUser.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const log = require('../utils/logger');

// Model imports
const User = require('../models/User');
const ChatHistory = require('../models/ChatHistory');
const StudentKnowledgeState = require('../models/StudentKnowledgeState');
const GamificationProfile = require('../models/GamificationProfile');
const TutorSession = require('../models/TutorSession');
const LearningPath = require('../models/LearningPath');
const ReasoningLog = require('../models/ReasoningLog');

const emailToDelete = process.argv[2];

async function purgeUser() {
    if (!emailToDelete) {
        console.error("Please provide an email as an argument: node purgeUser.js user@example.com");
        process.exit(1);
    }

    const mongoUri = process.env.MONGO_URI;
    try {
        await mongoose.connect(mongoUri);
        log.info('SYSTEM', `Connected to DB. Searching for ${emailToDelete}...`);

        const user = await User.findOne({ email: emailToDelete.toLowerCase() });
        if (!user) {
            log.warn('SYSTEM', `User with email ${emailToDelete} not found.`);
            process.exit(0);
        }

        const userId = user._id;
        log.info('SYSTEM', `User found (ID: ${userId}). Starting purge...`);

        // List of models that use userId as a reference
        const relatedModels = [
            { name: 'ChatHistory', model: ChatHistory },
            { name: 'StudentKnowledgeState', model: StudentKnowledgeState },
            { name: 'GamificationProfile', model: GamificationProfile },
            { name: 'TutorSession', model: TutorSession },
            { name: 'LearningPath', model: LearningPath },
            { name: 'ReasoningLog', model: ReasoningLog }
        ];

        for (const meta of relatedModels) {
            try {
                const result = await meta.model.deleteMany({ userId: userId });
                log.success('SYSTEM', `Purged ${result.deletedCount} items from ${meta.name}`);
            } catch (err) {
                log.error('SYSTEM', `Failed to purge ${meta.name}`, err);
            }
        }

        // Finally delete the user
        await User.deleteOne({ _id: userId });
        log.success('SYSTEM', `User ${emailToDelete} has been completely deleted.`);

    } catch (error) {
        log.error('SYSTEM', 'Purge failed', error);
    } finally {
        await mongoose.connection.close();
        process.exit(0);
    }
}

purgeUser();
