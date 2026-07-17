/**
 * tests/unit/priorKnowledgeDetector.test.js
 * 
 * Unit tests for Prior Knowledge Detector
 * Validates:
 * - Prior knowledge statement detection
 * - Difficulty level classification
 * - Topic extraction
 * - Confidence scoring
 */

const {
    detectPriorKnowledge,
    hasPriorKnowledgeStatement,
    extractMasteredTopics,
    detectDifficultyLevel
} = require('../../server/services/priorKnowledgeDetector');

describe('Prior Knowledge Detector', () => {
    // ─── PRIOR KNOWLEDGE DETECTION TESTS ──────────────────────────────────

    describe('hasPriorKnowledgeStatement()', () => {
        it('should detect "I already know" statements', () => {
            const queries = [
                'I already know arrays, teach me linked lists',
                'I already know Python basics',
                'I already understand recursion'
            ];
            queries.forEach(query => {
                expect(hasPriorKnowledgeStatement(query)).toBe(true);
            });
        });

        it('should detect "I am familiar with" statements', () => {
            const queries = [
                'I am familiar with data structures',
                'I\'m familiar with OOP concepts',
                'I am familiar with machine learning'
            ];
            queries.forEach(query => {
                expect(hasPriorKnowledgeStatement(query)).toBe(true);
            });
        });

        it('should detect "I studied" statements', () => {
            const queries = [
                'I studied graph algorithms last year',
                'I studied algorithms in my course',
                'I learned about dynamic programming'
            ];
            queries.forEach(query => {
                expect(hasPriorKnowledgeStatement(query)).toBe(true);
            });
        });

        it('should NOT detect negation patterns', () => {
            const queries = [
                "I don't know arrays",
                "I can't understand recursion",
                'I have no prior knowledge'
            ];
            queries.forEach(query => {
                expect(hasPriorKnowledgeStatement(query)).toBe(false);
            });
        });

        it('should NOT detect explainer queries without mastery claim', () => {
            const queries = [
                'Explain arrays',
                'What is recursion?',
                'Tell me about linked lists'
            ];
            queries.forEach(query => {
                expect(hasPriorKnowledgeStatement(query)).toBe(false);
            });
        });

        it('should handle null/undefined gracefully', () => {
            expect(hasPriorKnowledgeStatement(null)).toBe(false);
            expect(hasPriorKnowledgeStatement(undefined)).toBe(false);
            expect(hasPriorKnowledgeStatement('')).toBe(false);
        });
    });

    // ─── TOPIC EXTRACTION TESTS ───────────────────────────────────────────

    describe('extractMasteredTopics()', () => {
        it('should extract topics from comma-separated lists', () => {
            const query = 'I already know arrays, linked lists, stacks, and queues';
            const topics = extractMasteredTopics(query);
            expect(topics).toContain('arrays');
            expect(topics).toContain('linked lists');
            expect(topics).toContain('stacks');
        });

        it('should extract topics from "know about" statements', () => {
            const query = 'I know about graph theory and algorithms';
            const topics = extractMasteredTopics(query);
            expect(topics.length).toBeGreaterThan(0);
        });

        it('should extract common programming keywords', () => {
            const query = 'I understand Python, JavaScript, and recursion';
            const topics = extractMasteredTopics(query);
            expect(topics.some(t => 
                t.toLowerCase().includes('python') || 
                t.toLowerCase().includes('javascript')
            )).toBe(true);
        });

        it('should deduplicate topics', () => {
            const query = 'arrays arrays arrays linked lists';
            const topics = extractMasteredTopics(query);
            const arrayCount = topics.filter(t => t === 'arrays').length;
            expect(arrayCount).toBeLessThanOrEqual(1);
        });

        it('should handle empty/null inputs', () => {
            expect(extractMasteredTopics(null)).toEqual([]);
            expect(extractMasteredTopics(undefined)).toEqual([]);
            expect(extractMasteredTopics('')).toEqual([]);
        });

        it('should filter out short/invalid topics', () => {
            const query = 'I know a, an, the, and this';
            const topics = extractMasteredTopics(query);
            expect(topics.length).toBe(0);
        });
    });

    // ─── DIFFICULTY LEVEL DETECTION TESTS ─────────────────────────────────

    describe('detectDifficultyLevel()', () => {
        it('should detect advanced requests', () => {
            const queries = [
                'teach me advanced graph algorithms',
                'I want to deep dive into machine learning',
                'expert level recursion problems',
                'in-depth explanation of dynamic programming',
                'challenging algorithms'
            ];
            queries.forEach(query => {
                expect(detectDifficultyLevel(query)).toBe('advanced');
            });
        });

        it('should detect beginner requests', () => {
            const queries = [
                'I am a complete beginner',
                'teach me the basics',
                'start from scratch with Python',
                'beginner-level introduction',
                'explain like I\'m five'
            ];
            queries.forEach(query => {
                expect(detectDifficultyLevel(query)).toBe('beginner');
            });
        });

        it('should detect intermediate requests', () => {
            const queries = [
                'I want to move beyond basics',
                'intermediate level concepts',
                'level up my understanding'
            ];
            queries.forEach(query => {
                expect(detectDifficultyLevel(query)).toBe('intermediate');
            });
        });

        it('should default to intermediate for ambiguous queries', () => {
            const queries = [
                'teach me Python',
                'what is recursion?',
                'explain algorithms'
            ];
            queries.forEach(query => {
                expect(detectDifficultyLevel(query)).toBe('intermediate');
            });
        });

        it('should handle null/empty gracefully', () => {
            expect(detectDifficultyLevel(null)).toBe('intermediate');
            expect(detectDifficultyLevel(undefined)).toBe('intermediate');
            expect(detectDifficultyLevel('')).toBe('intermediate');
        });
    });

    // ─── FULL DETECTION FUNCTION TESTS ───────────────────────────────────

    describe('detectPriorKnowledge()', () => {
        it('should return complete object structure', () => {
            const result = detectPriorKnowledge('I already know arrays');
            expect(result).toHaveProperty('hasPriorKnowledge');
            expect(result).toHaveProperty('masteredTopics');
            expect(result).toHaveProperty('difficultyLevel');
            expect(result).toHaveProperty('confidence');
            expect(result).toHaveProperty('signals');
        });

        it('should detect mastery with advanced request', () => {
            const query = 'I already know basic data structures. Teach me advanced graph algorithms.';
            const result = detectPriorKnowledge(query);
            expect(result.hasPriorKnowledge).toBe(true);
            expect(result.difficultyLevel).toBe('advanced');
            expect(result.signals.advancedRequest).toBe(true);
            expect(result.confidence).toBeGreaterThan(0.5);
        });

        it('should extract topics from mastery statement', () => {
            const query = 'I already know arrays, linked lists, and stacks';
            const result = detectPriorKnowledge(query);
            expect(result.hasPriorKnowledge).toBe(true);
            expect(result.masteredTopics.length).toBeGreaterThan(0);
        });

        it('should handle beginner without mastery', () => {
            const query = 'I\'m a complete beginner, start from scratch';
            const result = detectPriorKnowledge(query);
            expect(result.hasPriorKnowledge).toBe(false);
            expect(result.difficultyLevel).toBe('beginner');
            expect(result.signals.beginnerRequest).toBe(true);
        });

        it('should return safe defaults for invalid input', () => {
            const result = detectPriorKnowledge(null);
            expect(result.hasPriorKnowledge).toBe(false);
            expect(result.masteredTopics).toEqual([]);
            expect(result.difficultyLevel).toBe('intermediate');
            expect(result.confidence).toBeLessThan(1);
        });

        it('should score higher confidence with multiple signals', () => {
            const queryFewSignals = 'I know Python';
            const queryManySignals = 'I already know Python, Java, and C++. Teach me advanced algorithms.';

            const resultFew = detectPriorKnowledge(queryFewSignals);
            const resultMany = detectPriorKnowledge(queryManySignals);

            expect(resultMany.confidence).toBeGreaterThanOrEqual(resultFew.confidence);
        });

        it('should handle complex real-world query', () => {
            const query = 'I\'ve studied graph theory before. I understand Dijkstra and Bellman-Ford. Teach me advanced graph algorithms like A* and bidirectional search.';
            const result = detectPriorKnowledge(query);
            expect(result.hasPriorKnowledge).toBe(true);
            expect(result.masteredTopics.length).toBeGreaterThan(0);
            expect(result.difficultyLevel).toBe('advanced');
        });
    });

    // ─── EDGE CASES ───────────────────────────────────────────────────────

    describe('Edge Cases', () => {
        it('should handle very long queries', () => {
            const longQuery = 'I already know ' + 'arrays, '.repeat(100);
            const result = detectPriorKnowledge(longQuery);
            expect(result.masteredTopics.length).toBeLessThanOrEqual(10); // Should cap at 10
        });

        it('should handle mixed case queries', () => {
            const queries = [
                'I ALREADY KNOW ARRAYS',
                'i already know arrays',
                'I AlReAdY kNoW aRrAyS'
            ];
            queries.forEach(query => {
                expect(detectPriorKnowledge(query).hasPriorKnowledge).toBe(true);
            });
        });

        it('should handle special characters in topics', () => {
            const query = 'I know C++, C#, and Node.js';
            const result = detectPriorKnowledge(query);
            expect(result.masteredTopics.length).toBeGreaterThan(0);
        });

        it('should handle non-English characters gracefully', () => {
            const query = 'I know arrays and también entiendo recursión';
            const result = detectPriorKnowledge(query);
            expect(typeof result.hasPriorKnowledge).toBe('boolean');
        });
    });
});

module.exports = {
    detectPriorKnowledge,
    hasPriorKnowledgeStatement,
    extractMasteredTopics,
    detectDifficultyLevel
};
