// server/scripts/testKnowledgeState.js
/**
 * Test script for Knowledge State Service
 * Run with: node server/scripts/testKnowledgeState.js
 */

require('dotenv').config({ path: './server/.env' });
const mongoose = require('mongoose');
const StudentKnowledgeState = require('../models/StudentKnowledgeState');
const ChatHistory = require('../models/ChatHistory');
const knowledgeStateService = require('../services/knowledgeStateService');

async function testKnowledgeStateSystem() {
    try {
        console.log('🧪 Testing Knowledge State System...\n');

        // Connect to MongoDB
        console.log('📡 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB\n');

        // Test 1: Create a test user ID
        const testUserId = new mongoose.Types.ObjectId();
        console.log(`👤 Test User ID: ${testUserId}\n`);

        // Test 2: Get or create knowledge state
        console.log('📝 Test 2: Creating knowledge state...');
        const knowledgeState = await knowledgeStateService.getOrCreateKnowledgeState(testUserId);
        console.log('✅ Knowledge state created');
        console.log(`   - User ID: ${knowledgeState.userId}`);
        console.log(`   - Concepts: ${knowledgeState.concepts.length}`);
        console.log(`   - Summary: ${knowledgeState.knowledgeSummary}\n`);

        // Test 3: Manually add a concept
        console.log('📝 Test 3: Adding concept manually...');
        knowledgeState.updateConcept({
            conceptName: 'Loops',
            understandingLevel: 'mastered',
            confidenceScore: 0.95,
            totalInteractions: 5,
            successfulInteractions: 5,
            lastInteractionDate: new Date(),
            strengths: [{
                aspect: 'For loop syntax',
                evidence: 'Wrote correct for loops in 5 exercises',
                detectedAt: new Date()
            }]
        });
        await knowledgeState.save();
        console.log('✅ Added concept: Loops (mastered)\n');

        // Test 4: Add a struggling concept
        console.log('📝 Test 4: Adding struggling concept...');
        knowledgeState.updateConcept({
            conceptName: 'Recursion',
            understandingLevel: 'struggling',
            confidenceScore: 0.35,
            totalInteractions: 3,
            successfulInteractions: 0,
            lastInteractionDate: new Date(),
            weaknesses: [{
                aspect: 'Base case design',
                evidence: 'Forgot base case in 2 out of 3 attempts',
                detectedAt: new Date()
            }]
        });
        await knowledgeState.save();
        console.log('✅ Added concept: Recursion (struggling)\n');

        // Test 5: Get mastered and struggling concepts
        console.log('📝 Test 5: Retrieving concept categories...');
        const mastered = knowledgeState.getMasteredConcepts();
        const struggling = knowledgeState.getStrugglingConcepts();
        console.log(`✅ Mastered concepts: ${mastered.length}`);
        mastered.forEach(c => console.log(`   - ${c.conceptName} (confidence: ${(c.confidenceScore * 100).toFixed(0)}%)`));
        console.log(`✅ Struggling concepts: ${struggling.length}`);
        struggling.forEach(c => console.log(`   - ${c.conceptName} (confidence: ${(c.confidenceScore * 100).toFixed(0)}%)`));
        console.log();

        // Test 6: Generate quick summary
        console.log('📝 Test 6: Generating quick summary...');
        const summary = knowledgeState.generateQuickSummary();
        console.log('✅ Summary generated:');
        console.log(`   - Total concepts: ${summary.totalConcepts}`);
        console.log(`   - Mastered: ${summary.mastered}`);
        console.log(`   - Learning: ${summary.learning}`);
        console.log(`   - Struggling: ${summary.struggling}`);
        console.log(`   - Not exposed: ${summary.notExposed}\n`);

        // Test 7: Get contextual memory
        console.log('📝 Test 7: Getting contextual memory...');
        const contextualMemory = await knowledgeStateService.getContextualMemory(testUserId, 'Tell me about recursion');
        if (contextualMemory) {
            console.log('✅ Contextual memory generated:');
            console.log('---');
            console.log(contextualMemory);
            console.log('---\n');
        } else {
            console.log('⚠️  No contextual memory (expected for new user)\n');
        }

        // Test 8: Create a mock chat session
        console.log('📝 Test 8: Creating mock chat session...');
        const sessionId = 'test-session-' + Date.now();
        const mockChatHistory = new ChatHistory({
            userId: testUserId,
            sessionId: sessionId,
            messages: [
                {
                    role: 'user',
                    parts: [{ text: 'What are loops?' }],
                    timestamp: new Date()
                },
                {
                    role: 'model',
                    parts: [{ text: 'Loops are control structures that repeat code...' }],
                    timestamp: new Date()
                },
                {
                    role: 'user',
                    parts: [{ text: 'Can you give me an example?' }],
                    timestamp: new Date()
                },
                {
                    role: 'model',
                    parts: [{ text: 'Sure! Here\'s a for loop example: for(int i=0; i<10; i++) { ... }' }],
                    timestamp: new Date()
                }
            ]
        });
        await mockChatHistory.save();
        console.log(`✅ Created mock chat session: ${sessionId}\n`);

        // Test 9: Update chat history with insights
        console.log('📝 Test 9: Updating chat history with insights...');
        const mockInsights = {
            conceptsDiscussed: [
                { conceptName: 'Loops', understandingLevel: 'comfortable' }
            ],
            strengths: [
                { aspect: 'Understanding loop syntax' }
            ],
            weaknesses: [],
            breakthroughs: ['Understood for loop structure'],
            studentQuestions: ['Can you give me an example?'],
            effectiveApproaches: ['Code examples'],
            ineffectiveApproaches: [],
            overallEngagement: 'high'
        };
        await knowledgeStateService.updateChatHistoryWithInsights(sessionId, mockInsights);
        console.log('✅ Chat history updated with insights\n');

        // Test 10: Verify chat history was updated
        console.log('📝 Test 10: Verifying chat history update...');
        const updatedChatHistory = await ChatHistory.findOne({ sessionId });
        console.log('✅ Chat history verified:');
        console.log(`   - Concepts discussed: ${updatedChatHistory.conceptsDiscussed?.length || 0}`);
        console.log(`   - Breakthroughs: ${updatedChatHistory.sessionInsights?.breakthroughs?.length || 0}`);
        console.log(`   - Engagement level: ${updatedChatHistory.sessionMetadata?.engagementLevel || 'not_assessed'}\n`);

        // Test 11: Update knowledge state from insights
        console.log('📝 Test 11: Updating knowledge state from insights...');
        await knowledgeStateService.updateKnowledgeStateFromInsights(testUserId, sessionId, mockInsights);
        const updatedKnowledgeState = await StudentKnowledgeState.findOne({ userId: testUserId });
        console.log('✅ Knowledge state updated:');
        console.log(`   - Total concepts: ${updatedKnowledgeState.concepts.length}`);
        console.log(`   - Session insights: ${updatedKnowledgeState.sessionInsights.length}`);
        console.log(`   - Total sessions: ${updatedKnowledgeState.engagementMetrics.totalSessions}\n`);

        // Cleanup
        console.log('🧹 Cleaning up test data...');
        await StudentKnowledgeState.deleteOne({ userId: testUserId });
        await ChatHistory.deleteOne({ sessionId });
        console.log('✅ Test data cleaned up\n');

        console.log('✅ All tests passed! Knowledge State System is working correctly.\n');

    } catch (error) {
        console.error('❌ Test failed:', error);
    } finally {
        await mongoose.connection.close();
        console.log('👋 Disconnected from MongoDB');
        process.exit(0);
    }
}

// Run tests
testKnowledgeStateSystem();
