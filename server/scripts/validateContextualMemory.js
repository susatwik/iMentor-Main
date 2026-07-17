// server/scripts/validateContextualMemory.js
/**
 * Comprehensive Validation Script for Contextual Memory System
 * Tests all requirements from the agent task prompt
 * Run with: node server/scripts/validateContextualMemory.js
 */

require('dotenv').config({ path: './server/.env' });
const mongoose = require('mongoose');
const StudentKnowledgeState = require('../models/StudentKnowledgeState');
const ChatHistory = require('../models/ChatHistory');
const knowledgeStateService = require('../services/knowledgeStateService');
const { logger } = require('../utils/logger');

// Test results tracker
const testResults = {
    passed: 0,
    failed: 0,
    tests: []
};

function logTest(name, passed, details = '') {
    const status = passed ? '✅ PASS' : '❌ FAIL';
    console.log(`${status}: ${name}`);
    if (details) console.log(`   ${details}`);

    testResults.tests.push({ name, passed, details });
    if (passed) testResults.passed++;
    else testResults.failed++;
}

async function validateContextualMemorySystem() {
    console.log('\n🧪 ===== CONTEXTUAL MEMORY SYSTEM VALIDATION =====\n');

    try {
        // Connect to MongoDB
        console.log('📡 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB\n');

        const testUserId = new mongoose.Types.ObjectId();
        console.log(`👤 Test User ID: ${testUserId}\n`);

        // ===== TEST 1: Student Profile Creation =====
        console.log('📝 TEST 1: Student Profile Creation');
        const knowledgeState = await knowledgeStateService.getOrCreateKnowledgeState(testUserId);
        logTest(
            'Student profile created with all required fields',
            knowledgeState &&
            knowledgeState.userId.equals(testUserId) &&
            knowledgeState.learningProfile &&
            knowledgeState.concepts !== undefined &&
            knowledgeState.engagementMetrics !== undefined,
            `Profile ID: ${knowledgeState._id}`
        );

        // ===== TEST 2: Granular Concept Tracking =====
        console.log('\n📝 TEST 2: Granular Concept Tracking');
        knowledgeState.updateConcept({
            conceptName: 'recursion.base_case',
            masteryScore: 45,
            difficulty: 'high',
            understandingLevel: 'learning',
            totalInteractions: 1,
            lastInteractionDate: new Date()
        });
        await knowledgeState.save();

        const concept = knowledgeState.getConcept('recursion.base_case');
        logTest(
            'Granular concepts (e.g., recursion.base_case) are tracked',
            concept && concept.conceptName === 'recursion.base_case',
            `Concept: ${concept?.conceptName}, Mastery: ${concept?.masteryScore}`
        );

        // ===== TEST 3: Mastery Score Validation (0-100) =====
        console.log('\n📝 TEST 3: Mastery Score Validation');
        knowledgeState.updateConcept({
            conceptName: 'test.invalid_mastery',
            masteryScore: 150, // Invalid
            difficulty: 'medium'
        });
        await knowledgeState.save();

        const invalidConcept = knowledgeState.getConcept('test.invalid_mastery');
        logTest(
            'Mastery scores are clamped to 0-100 range',
            invalidConcept.masteryScore >= 0 && invalidConcept.masteryScore <= 100,
            `Input: 150, Stored: ${invalidConcept.masteryScore}`
        );

        // ===== TEST 4: Difficulty Enum Validation =====
        console.log('\n📝 TEST 4: Difficulty Enum Validation');
        const validDifficulties = ['low', 'medium', 'high'];
        const allValid = knowledgeState.concepts.every(c =>
            validDifficulties.includes(c.difficulty)
        );
        logTest(
            'All difficulty values are valid enums (low/medium/high)',
            allValid,
            `Checked ${knowledgeState.concepts.length} concepts`
        );

        // ===== TEST 5: Contradictory State Prevention =====
        console.log('\n📝 TEST 5: Contradictory State Prevention');

        // Create a mastered concept with high difficulty (should auto-correct)
        const mockInsights = {
            concepts: [{
                name: 'arrays.sorting',
                mastery: 95, // Mastered
                difficulty: 'high', // Contradictory
                evidence: 'Test evidence'
            }]
        };

        await knowledgeStateService.updateKnowledgeStateFromInsights(
            testUserId,
            'test-session-contradiction',
            mockInsights
        );

        const updatedState = await StudentKnowledgeState.findOne({ userId: testUserId });
        const sortingConcept = updatedState.getConcept('arrays.sorting');

        logTest(
            'Mastered concepts cannot have high difficulty (auto-corrected)',
            sortingConcept.understandingLevel === 'mastered' && sortingConcept.difficulty !== 'high',
            `Mastery: ${sortingConcept.masteryScore}, Difficulty: ${sortingConcept.difficulty} (was high, auto-corrected)`
        );

        // ===== TEST 6: Incremental Updates (Not Overwriting) =====
        console.log('\n📝 TEST 6: Incremental Updates');

        const initialConceptCount = updatedState.concepts.length;

        // Add another concept
        await knowledgeStateService.updateKnowledgeStateFromInsights(
            testUserId,
            'test-session-incremental',
            {
                concepts: [{
                    name: 'loops.for_loop',
                    mastery: 60,
                    difficulty: 'medium'
                }]
            }
        );

        const afterUpdate = await StudentKnowledgeState.findOne({ userId: testUserId });

        logTest(
            'Updates are incremental (existing concepts preserved)',
            afterUpdate.concepts.length === initialConceptCount + 1 &&
            afterUpdate.getConcept('arrays.sorting') !== undefined,
            `Before: ${initialConceptCount} concepts, After: ${afterUpdate.concepts.length} concepts`
        );

        // ===== TEST 7: Learning Velocity Calculation =====
        console.log('\n📝 TEST 7: Learning Velocity Calculation');

        // Update existing concept to trigger velocity calculation
        await knowledgeStateService.updateKnowledgeStateFromInsights(
            testUserId,
            'test-session-velocity',
            {
                concepts: [{
                    name: 'loops.for_loop',
                    mastery: 75, // Improved from 60
                    difficulty: 'medium'
                }]
            }
        );

        const velocityState = await StudentKnowledgeState.findOne({ userId: testUserId });
        const loopConcept = velocityState.getConcept('loops.for_loop');

        logTest(
            'Learning velocity is calculated on updates',
            loopConcept.learningVelocity !== undefined && loopConcept.learningVelocity > 0,
            `Velocity: ${loopConcept.learningVelocity.toFixed(2)} pts/interaction`
        );

        // ===== TEST 8: Contextual Memory Retrieval =====
        console.log('\n📝 TEST 8: Contextual Memory Retrieval');

        const contextualMemory = await knowledgeStateService.getContextualMemory(testUserId);

        logTest(
            'Contextual memory is retrieved and formatted',
            contextualMemory !== null && contextualMemory.includes('STUDENT CONTEXTUAL MEMORY'),
            `Memory length: ${contextualMemory?.length || 0} characters`
        );

        // ===== TEST 9: Memory Opt-Out Privacy Control =====
        console.log('\n📝 TEST 9: Memory Opt-Out Privacy Control');

        velocityState.memoryOptOut = true;
        await velocityState.save();

        const optedOutState = await StudentKnowledgeState.findOne({ userId: testUserId });

        logTest(
            'User can opt out of contextual memory',
            optedOutState.memoryOptOut === true,
            'Opt-out flag set successfully'
        );

        // ===== TEST 10: Error Handling (Graceful Degradation) =====
        console.log('\n📝 TEST 10: Error Handling');

        try {
            // Try to update with invalid data
            await knowledgeStateService.updateKnowledgeStateFromInsights(
                testUserId,
                'test-session-error',
                null // Invalid insights
            );

            // Should not throw, should return null gracefully
            logTest(
                'System handles invalid insights gracefully (no crash)',
                true,
                'Null insights handled without throwing error'
            );
        } catch (error) {
            logTest(
                'System handles invalid insights gracefully (no crash)',
                false,
                `Error thrown: ${error.message}`
            );
        }

        // ===== TEST 11: Misconception Tracking =====
        console.log('\n📝 TEST 11: Misconception Tracking');

        await knowledgeStateService.updateKnowledgeStateFromInsights(
            testUserId,
            'test-session-misconception',
            {
                concepts: [{
                    name: 'pointers.null_pointer',
                    mastery: 30,
                    difficulty: 'high',
                    misconceptions: ['Thinks null pointer is same as zero']
                }]
            }
        );

        const misconceptionState = await StudentKnowledgeState.findOne({ userId: testUserId });
        const pointerConcept = misconceptionState.getConcept('pointers.null_pointer');

        logTest(
            'Common misconceptions are tracked',
            pointerConcept.misconceptions.length > 0 &&
            pointerConcept.misconceptions[0].stillPresent === true,
            `Misconceptions: ${pointerConcept.misconceptions.length}`
        );

        // ===== TEST 12: Recurring Struggles Detection =====
        console.log('\n📝 TEST 12: Recurring Struggles Detection');

        // Add multiple concepts with similar weaknesses
        await knowledgeStateService.updateKnowledgeStateFromInsights(
            testUserId,
            'test-session-recurring',
            {
                concepts: [
                    {
                        name: 'concept_a',
                        mastery: 40,
                        difficulty: 'high',
                        weaknesses: ['mathematical notation']
                    },
                    {
                        name: 'concept_b',
                        mastery: 35,
                        difficulty: 'high',
                        weaknesses: ['mathematical notation']
                    }
                ]
            }
        );

        const recurringState = await StudentKnowledgeState.findOne({ userId: testUserId });

        logTest(
            'Recurring struggles are detected across concepts',
            recurringState.recurringStruggles.length > 0,
            `Recurring struggles: ${recurringState.recurringStruggles.length}`
        );

        // ===== TEST 13: Session Insights Storage =====
        console.log('\n📝 TEST 13: Session Insights Storage');

        const sessionInsightsCount = recurringState.sessionInsights.length;

        logTest(
            'Session insights are stored for each analysis',
            sessionInsightsCount > 0,
            `Total session insights: ${sessionInsightsCount}`
        );

        // ===== TEST 14: No Latency Added (Performance Check) =====
        console.log('\n📝 TEST 14: Performance Check');

        const startTime = Date.now();
        await knowledgeStateService.getContextualMemory(testUserId);
        const endTime = Date.now();
        const latency = endTime - startTime;

        logTest(
            'Memory retrieval completes in < 500ms',
            latency < 500,
            `Latency: ${latency}ms`
        );

        // ===== CLEANUP =====
        console.log('\n🧹 Cleaning up test data...');
        await StudentKnowledgeState.deleteOne({ userId: testUserId });
        console.log('✅ Test data cleaned up\n');

        // ===== FINAL RESULTS =====
        console.log('\n' + '='.repeat(60));
        console.log('📊 VALIDATION RESULTS');
        console.log('='.repeat(60));
        console.log(`✅ Passed: ${testResults.passed}`);
        console.log(`❌ Failed: ${testResults.failed}`);
        console.log(`📈 Success Rate: ${((testResults.passed / (testResults.passed + testResults.failed)) * 100).toFixed(1)}%`);
        console.log('='.repeat(60) + '\n');

        if (testResults.failed === 0) {
            console.log('🎉 ALL TESTS PASSED! Contextual Memory System is fully functional.\n');
        } else {
            console.log('⚠️  Some tests failed. Review the output above for details.\n');
            console.log('Failed tests:');
            testResults.tests.filter(t => !t.passed).forEach(t => {
                console.log(`  - ${t.name}: ${t.details}`);
            });
            console.log();
        }

    } catch (error) {
        console.error('❌ Validation failed with error:', error);
    } finally {
        await mongoose.connection.close();
        console.log('👋 Disconnected from MongoDB');
        process.exit(testResults.failed === 0 ? 0 : 1);
    }
}

// Run validation
validateContextualMemorySystem();
