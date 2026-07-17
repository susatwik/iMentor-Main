const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27018/chatbot_autoresearch';
console.log('Connecting to database:', mongoUri);

mongoose.connect(mongoUri)
  .then(async () => {
    console.log('Connected successfully!');

    const User = require('../models/User');
    const ChatHistory = require('../models/ChatHistory');
    const TutorSession = require('../models/TutorSession');
    const StudentKnowledgeState = require('../models/StudentKnowledgeState');
    const GamificationProfile = require('../models/GamificationProfile');
    const SkillTreeGame = require('../models/SkillTreeGame');

    const users = await User.find({ isAdmin: { $ne: true } });
    console.log(`Found ${users.length} students in database.`);

    // 1. Migrate orphan tutor sessions (TutorSession documents with null userId)
    console.log('\n--- 1. Migrating Orphan Tutor Sessions ---');
    const orphanSessions = await TutorSession.find({ userId: { $in: [null, undefined] } });
    console.log(`Found ${orphanSessions.length} tutor sessions with null/undefined userId.`);

    for (const session of orphanSessions) {
      const chatHistory = await ChatHistory.findOne({ sessionId: session.sessionId }).lean();
      if (chatHistory && chatHistory.userId) {
        session.userId = chatHistory.userId;
        // Copy other relevant fields if missing
        session.courseId = session.courseId || chatHistory.courseId;
        session.moduleId = session.moduleId || chatHistory.moduleId;
        session.course = session.course || chatHistory.courseName;
        
        await session.save();
        console.log(`Associated session ${session.sessionId} (Topic: ${session.topic}) to User ID: ${chatHistory.userId}`);
      } else {
        // Fallback: assign to the first active user if we can't find a chat history
        if (users.length > 0) {
          session.userId = users[0]._id;
          await session.save();
          console.log(`Fallback: Associated session ${session.sessionId} to first User: ${users[0].username}`);
        }
      }
    }

    // 2. Seeding Mock Quiz Scores & Concept Mastery Maps
    console.log('\n--- 2. Seeding Quiz Scores & Concept Masteries ---');
    const sampleCourses = ['Machine Learning', 'Operating Systems'];
    const mockTopics = {
      'Machine Learning': ['definition_of_ml', 'history_of_ml', 'supervised_learning', 'unsupervised_learning', 'reinforcement_learning'],
      'Operating Systems': ['os_objectives', 'functions_of_os', 'evolution_of_os', 'os_structures', 'process_management']
    };

    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      console.log(`Seeding user: ${user.username} (${user.email})`);

      // Initialize quizScores if empty
      if (!user.profile.quizScores || user.profile.quizScores.length === 0) {
        const scores = [];
        const numQuizzes = 2 + (i % 3); // 2 to 4 quizzes
        
        for (let q = 0; q < numQuizzes; q++) {
          const course = sampleCourses[q % sampleCourses.length];
          const topics = mockTopics[course];
          const score = 65 + Math.round(Math.random() * 30); // 65% to 95%
          
          scores.push({
            courseName: course,
            course: course,
            module: `Module ${q + 1}`,
            moduleId: `module_${q + 1}`,
            score: score,
            difficulty: user.profile.learningStage || 'Intermediate',
            weakTopics: [topics[q % topics.length]],
            strongTopics: topics.filter((t, idx) => idx !== (q % topics.length)),
            remediation: {
              strength: `Understands core concepts of ${course}.`,
              weakness: `Struggled slightly with ${topics[q % topics.length]}.`,
              reason: 'Minor confusion on classification boundaries.',
              recommendation: `Read the lecture notes on ${topics[q % topics.length]} and retry.`
            },
            date: new Date(Date.now() - q * 24 * 60 * 60 * 1000),
            attemptDate: new Date(Date.now() - q * 24 * 60 * 60 * 1000)
          });
        }

        user.profile.quizScores = scores;
        user.profile.quizAttempts = scores.length;
        user.profile.learningStage = 'Intermediate';
        user.profile.learningLevel = 'INTERMEDIATE';
        
        // Recalculate global strong/weak topics and conceptMastery
        const conceptMastery = new Map();
        const strongTopicsSet = new Set();
        const weakTopicsSet = new Set();

        scores.forEach(s => {
          s.strongTopics.forEach(t => {
            strongTopicsSet.add(t);
            conceptMastery.set(t.replace(/\./g, '-'), 80 + Math.round(Math.random() * 20));
          });
          s.weakTopics.forEach(t => {
            weakTopicsSet.add(t);
            conceptMastery.set(t.replace(/\./g, '-'), 45 + Math.round(Math.random() * 20));
          });
        });

        user.profile.strongTopics = Array.from(strongTopicsSet);
        user.profile.weakTopics = Array.from(weakTopicsSet);
        user.profile.conceptMastery = conceptMastery;

        user.markModified('profile');
        await user.save();
        console.log(`  -> Seeded ${scores.length} quizzes and concept masteries.`);
      }

      // Initialize Curriculum Progress completed lists if empty
      if (!user.curriculumProgress || Object.keys(user.curriculumProgress).length === 0) {
        const progressMap = {};
        sampleCourses.forEach(course => {
          progressMap[course] = {
            completedSubtopics: mockTopics[course].slice(0, 3),
            completedTopics: [mockTopics[course][0]],
            completedModules: ['module_1'],
            quizResults: {
              'module_1': JSON.stringify({ score: 85, date: new Date() })
            },
            quizIndex: 1,
            lastActiveDate: new Date()
          };
        });
        user.curriculumProgress = progressMap;
        user.markModified('curriculumProgress');
        await user.save();
        console.log(`  -> Seeded curriculumProgress for courses.`);
      }

      // Ensure Gamification Profile exists
      let gamification = await GamificationProfile.findOne({ userId: user._id });
      if (!gamification) {
        gamification = new GamificationProfile({
          userId: user._id,
          totalLearningCredits: 350 + (i * 120),
          level: 2 + (i % 2),
          currentStreak: 3 + (i % 4),
          longestStreak: 5 + i,
          currentEnergy: 85,
          badges: [
            { badgeId: 'socratic_spark', name: 'Socratic Spark', earnedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
            { badgeId: 'quiz_master', name: 'Quiz Master', earnedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000) }
          ]
        });
        await gamification.save();
        console.log(`  -> Seeded Gamification profile.`);
      }

      // Ensure Skill Tree exists
      let skillTree = await SkillTreeGame.findOne({ userId: user._id });
      if (!skillTree) {
        skillTree = new SkillTreeGame({
          userId: user._id,
          topic: 'Machine Learning',
          completedLevels: 2,
          totalStars: 5,
          assessmentResult: { level: 'Intermediate' },
          levels: [
            { id: 1, name: 'Introduction to ML', status: 'completed', stars: 3, score: 90, completedAt: new Date() },
            { id: 2, name: 'Supervised Learning', status: 'completed', stars: 2, score: 75, completedAt: new Date() }
          ]
        });
        await skillTree.save();
        console.log(`  -> Seeded Skill Tree game data.`);
      }

      // 3. Initialize/Update StudentKnowledgeState based on the user's tutor sessions and quiz scores
      console.log('\n--- 3. Syncing Knowledge States ---');
      let knowledgeState = await StudentKnowledgeState.findOne({ userId: user._id });
      if (!knowledgeState) {
        knowledgeState = new StudentKnowledgeState({
          userId: user._id,
          knowledgeSummary: 'Active learner demonstrating interest in Machine Learning.',
          engagementMetrics: {
            totalSessions: await TutorSession.countDocuments({ userId: user._id }),
            totalSessionDuration: 45,
            learningVelocity: 1.5,
            lastActiveDate: new Date()
          }
        });
      }

      // Populate concepts in knowledgeState
      const concepts = [];
      const topics = mockTopics['Machine Learning'];
      topics.forEach((t, idx) => {
        const mastery = 50 + Math.round(Math.random() * 45); // 50 to 95
        concepts.push({
          conceptName: t,
          masteryScore: mastery,
          masteryScoreNormalized: mastery / 100,
          difficulty: mastery >= 80 ? 'low' : mastery >= 60 ? 'medium' : 'high',
          understandingLevel: mastery >= 90 ? 'mastered' : mastery >= 70 ? 'comfortable' : mastery >= 40 ? 'learning' : 'struggling',
          learningVelocity: 1.2,
          confidenceScore: mastery / 100,
          totalInteractions: 3,
          lastInteractionDate: new Date(),
          firstExposureDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
          strengths: [{ aspect: 'Definitions', evidence: 'Grasped core terminology.', detectedAt: new Date() }],
          weaknesses: idx === 2 ? [{ aspect: 'Mathematical bounds', evidence: 'Confused about details.', detectedAt: new Date() }] : [],
          misconceptions: []
        });
      });

      knowledgeState.concepts = concepts;
      knowledgeState.markModified('concepts');
      await knowledgeState.save();
      console.log(`  -> Synced knowledge state with ${concepts.length} concepts.`);
    }

    console.log('\nAll migrations and data seeds completed successfully!');
    process.exit(0);
  })
  .catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
