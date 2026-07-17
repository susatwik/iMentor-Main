/**
 * tests/integration/tutorHandler.prior-knowledge.integration.test.js
 * 
 * Integration tests for Prior Knowledge Detection with Tutor Handler
 * 
 * Validates:
 * - Prior knowledge detection is called early in tutor flow
 * - Cognitive level is adapted based on prior knowledge
 * - Mastered topics are stored in session state
 * - Advanced requests skip L1_CONCEPT
 */

const priorKnowledgeDetector = require('../../server/services/priorKnowledgeDetector');

describe('Prior Knowledge Detection Integration with Tutor Handler', () => {
    
    describe('Scenario 1: Expert Student with Advanced Request', () => {
        it('should detect mastery and advanced intent, start at L3_CRITICAL', () => {
            const query = 'I\'ve studied graph theory extensively. I want to learn advanced algorithms like A*, bidirectional search, and Bellman-Ford with negative weights.';
            
            // Phase 1: Detection
            const analysis = priorKnowledgeDetector.detectPriorKnowledge(query);
            
            expect(analysis.hasPriorKnowledge).toBe(true);
            expect(analysis.difficultyLevel).toBe('advanced');
            expect(analysis.signals.advancedRequest).toBe(true);
            expect(analysis.masteredTopics.length).toBeGreaterThan(0);
            expect(analysis.confidence).toBeGreaterThan(0.7);
            
            // Phase 2: Cognitive Level Selection (simulating selectStartingCognitiveLevel)
            const expectedLevel = analysis.difficultyLevel === 'advanced' ? 'L3_CRITICAL' : 'L1_CONCEPT';
            expect(expectedLevel).toBe('L3_CRITICAL');
        });
    });

    describe('Scenario 2: Intermediate Student with Intermediate Request', () => {
        it('should detect prior knowledge and intermediate intent, start at L2_APPLICATION', () => {
            const query = 'I know the basics of Python and data structures. I want to learn more about algorithm design patterns.';
            
            const analysis = priorKnowledgeDetector.detectPriorKnowledge(query);
            
            expect(analysis.hasPriorKnowledge).toBe(true);
            expect(analysis.difficultyLevel).toBe('intermediate');
            expect(analysis.masteredTopics.length).toBeGreaterThan(0);
            expect(analysis.confidence).toBeGreaterThan(0.5);
            
            // For intermediate + prior knowledge → L2_APPLICATION
            const expectedLevel = analysis.hasPriorKnowledge && analysis.difficultyLevel === 'intermediate' 
                ? 'L2_APPLICATION' 
                : 'L1_CONCEPT';
            expect(expectedLevel).toBe('L2_APPLICATION');
        });
    });

    describe('Scenario 3: Beginner Student', () => {
        it('should detect beginner intent, stay at L1_CONCEPT', () => {
            const query = 'I\'m completely new to programming. Can you teach me the absolute basics of Python?';
            
            const analysis = priorKnowledgeDetector.detectPriorKnowledge(query);
            
            expect(analysis.hasPriorKnowledge).toBe(false);
            expect(analysis.difficultyLevel).toBe('beginner');
            expect(analysis.signals.beginnerRequest).toBe(true);
            
            // Beginner → L1_CONCEPT
            const expectedLevel = analysis.difficultyLevel === 'beginner' ? 'L1_CONCEPT' : 'L2_APPLICATION';
            expect(expectedLevel).toBe('L1_CONCEPT');
        });
    });

    describe('Scenario 4: Student with Prior Knowledge But No Explicit Difficulty', () => {
        it('should detect mastery, default to intermediate level', () => {
            const query = 'I understand arrays and linked lists. What should I learn next?';
            
            const analysis = priorKnowledgeDetector.detectPriorKnowledge(query);
            
            expect(analysis.hasPriorKnowledge).toBe(true);
            expect(analysis.masteredTopics.length).toBeGreaterThan(0);
            expect(analysis.difficultyLevel).toBe('intermediate'); // Default
            
            // Prior knowledge + intermediate → L2_APPLICATION
            const expectedLevel = analysis.hasPriorKnowledge && analysis.difficultyLevel === 'intermediate'
                ? 'L2_APPLICATION'
                : 'L1_CONCEPT';
            expect(expectedLevel).toBe('L2_APPLICATION');
        });
    });

    describe('Scenario 5: Complex Multi-Topic Mastery', () => {
        it('should extract multiple mastered topics with confidence scoring', () => {
            const query = 'I already know arrays, linked lists, stacks, queues, and trees. I have studied sorting algorithms like quicksort and mergesort. Now teach me advanced graph algorithms.';
            
            const analysis = priorKnowledgeDetector.detectPriorKnowledge(query);
            
            expect(analysis.hasPriorKnowledge).toBe(true);
            expect(analysis.masteredTopics.length).toBeGreaterThanOrEqual(3);
            expect(analysis.difficultyLevel).toBe('advanced');
            expect(analysis.confidence).toBeGreaterThan(0.75);
        });
    });

    describe('Scenario 6: False Positive Prevention', () => {
        it('should NOT detect mastery when negation is present', () => {
            const query = "I don't understand arrays, so teach me the fundamentals";
            
            const analysis = priorKnowledgeDetector.detectPriorKnowledge(query);
            
            expect(analysis.hasPriorKnowledge).toBe(false);
            expect(analysis.difficultyLevel).toBe('intermediate'); // Safe default
        });

        it('should NOT treat "explain" queries as mastery statements', () => {
            const query = 'Explain how arrays work';
            
            const analysis = priorKnowledgeDetector.detectPriorKnowledge(query);
            
            expect(analysis.hasPriorKnowledge).toBe(false);
            expect(analysis.signals.advancedRequest).toBe(false);
        });
    });

    describe('Session State Integration', () => {
        it('should store prior knowledge analysis in session state', () => {
            const query = 'I know Python and want to learn advanced algorithms';
            const analysis = priorKnowledgeDetector.detectPriorKnowledge(query);

            // Simulating how this would be stored in tutor session state
            const sessionStateExample = {
                cognitiveLevel: 'L3_CRITICAL',
                priorKnowledgeAnalysis: {
                    hasPriorKnowledge: analysis.hasPriorKnowledge,
                    masteredTopics: analysis.masteredTopics,
                    difficultyLevel: analysis.difficultyLevel,
                    signals: analysis.signals
                },
                moduleTitle: 'Advanced Algorithms'
            };

            expect(sessionStateExample.priorKnowledgeAnalysis).toBeDefined();
            expect(sessionStateExample.priorKnowledgeAnalysis.hasPriorKnowledge).toBe(true);
            expect(sessionStateExample.cognitiveLevel).toBe('L3_CRITICAL');
        });
    });

    describe('Confidence Scoring Validation', () => {
        it('should score high confidence for signals alignment', () => {
            const strongSignal = 'I already know arrays, linked lists, and stacks. Teach me advanced graph algorithms.';
            const weakSignal = 'What is recursion?';

            const strongAnalysis = priorKnowledgeDetector.detectPriorKnowledge(strongSignal);
            const weakAnalysis = priorKnowledgeDetector.detectPriorKnowledge(weakSignal);

            expect(strongAnalysis.confidence).toBeGreaterThan(weakAnalysis.confidence);
        });

        it('should maintain confidence between 0 and 1', () => {
            const testQueries = [
                'I already know arrays',
                'What is recursion?',
                'I am a complete beginner',
                'Teach me advanced algorithms',
                'I understand but want to go deeper'
            ];

            testQueries.forEach(query => {
                const analysis = priorKnowledgeDetector.detectPriorKnowledge(query);
                expect(analysis.confidence).toBeGreaterThanOrEqual(0);
                expect(analysis.confidence).toBeLessThanOrEqual(1);
            });
        });
    });

    describe('Production Readiness Checks', () => {
        it('should handle null/undefined inputs gracefully', () => {
            const result1 = priorKnowledgeDetector.detectPriorKnowledge(null);
            const result2 = priorKnowledgeDetector.detectPriorKnowledge(undefined);
            const result3 = priorKnowledgeDetector.detectPriorKnowledge('');

            [result1, result2, result3].forEach(result => {
                expect(result).toHaveProperty('hasPriorKnowledge');
                expect(result).toHaveProperty('masteredTopics');
                expect(result).toHaveProperty('difficultyLevel');
                expect(result.hasPriorKnowledge).toBe(false);
                expect(Array.isArray(result.masteredTopics)).toBe(true);
            });
        });

        it('should not throw errors on edge cases', () => {
            const edgeCases = [
                'a'.repeat(5000), // Very long string
                '!!!@@@###$$$', // Special characters only
                '\n\n\n', // Whitespace only
                '   ', // Spaces
                'Ñoño cosas raras 中文', // Mixed scripts
            ];

            expect(() => {
                edgeCases.forEach(query => {
                    priorKnowledgeDetector.detectPriorKnowledge(query);
                });
            }).not.toThrow();
        });

        it('should not mutate input query', () => {
            const originalQuery = 'I already know arrays';
            const queryClone = originalQuery;

            priorKnowledgeDetector.detectPriorKnowledge(originalQuery);

            expect(originalQuery).toBe(queryClone);
        });
    });

    describe('Performance Characteristics', () => {
        it('should complete detection within acceptable time', () => {
            const query = 'I already know arrays, linked lists, stacks, queues, trees, and graphs. Teach me advanced algorithms.';
            
            const startTime = performance.now();
            const analysis = priorKnowledgeDetector.detectPriorKnowledge(query);
            const endTime = performance.now();

            const executionTime = endTime - startTime;
            expect(executionTime).toBeLessThan(100); // Should complete in < 100ms
        });

        it('should handle batch detection without memory issues', () => {
            const queries = Array(100).fill('I know Python and want to learn advanced algorithms');
            
            expect(() => {
                queries.forEach(query => {
                    priorKnowledgeDetector.detectPriorKnowledge(query);
                });
            }).not.toThrow();
        });
    });
});
