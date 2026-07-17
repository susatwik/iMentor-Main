// server/scripts/seedBounties.js
// Run with: node scripts/seedBounties.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const BountyQuestion = require('../models/BountyQuestion');
const User = require('../models/User');

const demoBounties = [
    {
        topic: "Machine Learning",
        difficulty: "easy",
        knowledgeGap: "Fundamentals of supervised learning",
        questionText: "What is the main difference between supervised and unsupervised learning?",
        questionType: "open_ended",
        explanation: "Supervised learning uses labeled data to train models, while unsupervised learning discovers patterns in unlabeled data.",
        creditReward: 10,
        xpBonus: 15
    },
    {
        topic: "Neural Networks",
        difficulty: "medium",
        knowledgeGap: "Understanding activation functions",
        questionText: "Why do neural networks need non-linear activation functions? What would happen if we only used linear functions?",
        questionType: "open_ended",
        explanation: "Without non-linear activations, multiple layers would collapse into a single linear transformation, limiting the network's ability to learn complex patterns.",
        creditReward: 25,
        xpBonus: 30
    },
    {
        topic: "Data Structures",
        difficulty: "medium",
        knowledgeGap: "Tree traversal algorithms",
        questionText: "Explain the difference between BFS and DFS tree traversal. When would you prefer one over the other?",
        questionType: "open_ended",
        explanation: "BFS explores level by level (uses queue), DFS goes deep first (uses stack/recursion). BFS is better for shortest path, DFS for topological sorting or maze solving.",
        creditReward: 25,
        xpBonus: 25
    },
    {
        topic: "Python Programming",
        difficulty: "easy",
        knowledgeGap: "List comprehensions",
        questionText: "Convert this for loop to a list comprehension: squares = []; for i in range(10): squares.append(i**2)",
        questionType: "coding",
        correctAnswer: "squares = [i**2 for i in range(10)]",
        explanation: "List comprehensions provide a concise way to create lists based on existing iterables.",
        creditReward: 15,
        xpBonus: 10
    },
    {
        topic: "Algorithms",
        difficulty: "hard",
        knowledgeGap: "Dynamic programming concepts",
        questionText: "Explain the concept of 'overlapping subproblems' in dynamic programming. Give an example of a problem that exhibits this property.",
        questionType: "open_ended",
        explanation: "Overlapping subproblems occur when the same subproblems are solved multiple times. Classic example: Fibonacci sequence, where F(n) requires F(n-1) and F(n-2), which share F(n-2) and F(n-3).",
        creditReward: 40,
        xpBonus: 50
    },
    {
        topic: "Database Systems",
        difficulty: "medium",
        knowledgeGap: "SQL vs NoSQL",
        questionText: "When would you choose a NoSQL database like MongoDB over a traditional SQL database? What are the trade-offs?",
        questionType: "open_ended",
        explanation: "NoSQL is better for flexible schemas, horizontal scaling, and unstructured data. Trade-offs include lack of ACID transactions (in some cases) and eventual consistency.",
        creditReward: 25,
        xpBonus: 20
    }
];

async function seedBounties() {
    try {
        const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
        if (!mongoUri) {
            console.error('❌ MONGO_URI not found in .env file');
            process.exit(1);
        }
        await mongoose.connect(mongoUri);
        console.log('✅ Connected to MongoDB');

        // Find ALL users to assign bounties to
        const users = await User.find({});
        if (users.length === 0) {
            console.error('❌ No users found. Please create a user first.');
            process.exit(1);
        }
        console.log(`📝 Creating bounties for ${users.length} user(s):`);
        users.forEach(u => console.log(`   - ${u.email}`));

        // Delete old demo bounties for clean refresh
        const deleted = await BountyQuestion.deleteMany({
            generationMethod: 'admin_manual',
            status: 'active'
        });
        console.log(`🗑️ Deleted ${deleted.deletedCount} old demo bounties`);

        // Create new bounties for EACH user
        const now = new Date();
        const expiresIn24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        let totalCreated = 0;
        for (const user of users) {
            console.log(`\n👤 Creating bounties for: ${user.email}`);
            for (const bounty of demoBounties) {
                const newBounty = new BountyQuestion({
                    bountyId: `demo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    userId: user._id,
                    ...bounty,
                    status: 'active',
                    generationMethod: 'admin_manual',
                    generatedAt: now,
                    expiresAt: expiresIn24Hours
                });
                await newBounty.save();
                console.log(`  ✅ Created: ${bounty.topic} (${bounty.difficulty})`);
                totalCreated++;
            }
        }

        console.log(`\n🎉 Successfully created ${totalCreated} demo bounty questions for ${users.length} user(s)!`);
        console.log(`📋 Bounties expire: ${expiresIn24Hours.toLocaleString()}`);

        process.exit(0);
    } catch (error) {
        console.error('❌ Error seeding bounties:', error);
        process.exit(1);
    }
}

seedBounties();
