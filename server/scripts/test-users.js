const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27018/chatbot_autoresearch';
console.log('Connecting to:', mongoUri);

mongoose.connect(mongoUri)
  .then(async () => {
    console.log('Connected successfully!');
    
    const SkillTree = require('../models/SkillTree');
    const nodes = await SkillTree.find({}).lean();
    console.log(`\nFound ${nodes.length} SkillTree nodes:`);
    for (const node of nodes) {
      console.log(`- Node: skillId=${node.skillId}, name="${node.name}", category="${node.category}", course="${node.course}", questionsCount=${node.assessmentQuestions?.length || 0}`);
    }

    process.exit(0);
  })
  .catch(err => {
    console.error('Connection failed:', err);
    process.exit(1);
  });
