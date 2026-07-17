const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

const connectDB = require('../config/db');
const { syncSkillTreeToMongo } = require('../services/skillTreeSyncService');
const log = require('../utils/logger');

async function runManualSync() {
    try {
        // 1. Connect to MongoDB
        await connectDB(process.env.MONGO_URI);
        log.info('SYNC', 'Starting manual skill tree sync for Machine Learning');

        // 2. Read skill_tree.json
        const course = 'Machine Learning';
        const skillTreePath = path.join(__dirname, '..', 'course_bootstrap', course, 'skill_tree.json');
        
        if (!fs.existsSync(skillTreePath)) {
            log.error('SYNC', `Skill tree file not found at: ${skillTreePath}`);
            process.exit(1);
        }

        const skillTreeData = JSON.parse(fs.readFileSync(skillTreePath, 'utf-8'));
        log.info('SYNC', `Read ${skillTreeData.skill_tree.length} subtopics from skill_tree.json`);

        // 3. Trigger sync
        const result = await syncSkillTreeToMongo(course, skillTreeData.skill_tree);
        log.success('SYNC', `Manual sync complete: ${result.created} created, ${result.updated} updated`);

        // 4. Verify a few nodes
        const SkillTree = require('../models/SkillTree');
        const count = await SkillTree.countDocuments({ category: course });
        const withQuestions = await SkillTree.countDocuments({ 
            category: course, 
            'assessmentQuestions.0': { $exists: true } 
        });
        
        log.info('SYNC', `Total ML nodes in DB: ${count}`);
        log.info('SYNC', `Nodes with pre-computed questions: ${withQuestions}`);

        process.exit(0);
    } catch (error) {
        log.error('SYNC', `Manual sync failed: ${error.message}`);
        console.error(error);
        process.exit(1);
    }
}

runManualSync();
