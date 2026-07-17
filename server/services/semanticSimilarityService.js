/**
 * Semantic Similarity Service
 * Checks for duplicate questions/answers using embedding-based similarity
 */

const axios = require('axios');
const log = require('../utils/logger');

const SIMILARITY_THRESHOLD = 0.8; // Cosine similarity threshold for duplicates
const PYTHON_RAG_SERVICE_URL = process.env.PYTHON_RAG_SERVICE_URL || 'http://localhost:2001';

class SemanticSimilarityService {
    constructor() {
        this.embeddingCache = new Map(); // Simple in-memory cache
    }

    /**
     * Get embedding for text using Python RAG service
     */
    async getEmbedding(text) {
        // Check cache first
        const cacheKey = text.toLowerCase().trim();
        if (this.embeddingCache.has(cacheKey)) {
            return this.embeddingCache.get(cacheKey);
        }

        try {
            const response = await axios.post(`${PYTHON_RAG_SERVICE_URL}/embed`, {
                text
            });
            
            const embedding = response.data.embedding;
            
            // Cache it
            this.embeddingCache.set(cacheKey, embedding);
            
            // Limit cache size
            if (this.embeddingCache.size > 1000) {
                const firstKey = this.embeddingCache.keys().next().value;
                this.embeddingCache.delete(firstKey);
            }
            
            return embedding;
        } catch (error) {
            log.error('SEMANTIC', `Failed to get embedding: ${error.message}`);
            throw error;
        }
    }

    /**
     * Calculate cosine similarity between two vectors
     */
    cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || vecA.length !== vecB.length) {
            return 0;
        }

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }

        if (normA === 0 || normB === 0) {
            return 0;
        }

        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    /**
     * Check if a question is semantically similar to existing questions
     * @param {string} newQuestion - New question to check
     * @param {Array<string>} existingQuestions - Array of existing questions
     * @param {number} threshold - Similarity threshold (default: 0.8)
     * @returns {Object} { isDuplicate: boolean, similarity: number, matchedQuestion: string }
     */
    async checkQuestionDuplicate(newQuestion, existingQuestions, threshold = SIMILARITY_THRESHOLD) {
        if (!newQuestion || existingQuestions.length === 0) {
            return { isDuplicate: false, similarity: 0, matchedQuestion: null };
        }

        try {
            const newEmbedding = await this.getEmbedding(newQuestion);
            let maxSimilarity = 0;
            let matchedQuestion = null;

            for (const existingQ of existingQuestions) {
                const existingEmbedding = await this.getEmbedding(existingQ);
                const similarity = this.cosineSimilarity(newEmbedding, existingEmbedding);

                if (similarity > maxSimilarity) {
                    maxSimilarity = similarity;
                    matchedQuestion = existingQ;
                }
            }

            const isDuplicate = maxSimilarity >= threshold;

            if (isDuplicate) {
                log.info('SEMANTIC', `Duplicate detected: similarity=${maxSimilarity.toFixed(3)}`);
            }

            return {
                isDuplicate,
                similarity: maxSimilarity,
                matchedQuestion: isDuplicate ? matchedQuestion : null
            };

        } catch (error) {
            log.error('SEMANTIC', `Duplicate check failed: ${error.message}`);
            // On error, fall back to simple string comparison
            const lowerNew = newQuestion.toLowerCase();
            for (const existingQ of existingQuestions) {
                if (existingQ.toLowerCase() === lowerNew) {
                    return { isDuplicate: true, similarity: 1.0, matchedQuestion: existingQ };
                }
            }
            return { isDuplicate: false, similarity: 0, matchedQuestion: null };
        }
    }

    /**
     * Check novelty against user's knowledge graph
     * Returns novelty score (0 = completely repetitive, 1 = completely novel)
     */
    async checkNoveltyAgainstUserKG(userId, questionText) {
        try {
            // Query user's personal KG for similar past questions
            const response = await axios.post(`${PYTHON_RAG_SERVICE_URL}/user_kg/check_novelty`, {
                user_id: userId,
                text: questionText
            });

            return response.data.novelty_score || 1.0;

        } catch (error) {
            log.warn('SEMANTIC', `User KG novelty check failed: ${error.message}`);
            // Default to novel if service unavailable
            return 1.0;
        }
    }

    /**
     * Find similar text from list
     * @param {string} text - Text to compare
     * @param {Array<string>} candidates - Candidate texts
     * @param {number} topK - Number of top similar results to return
     * @returns {Array<{text: string, similarity: number}>}
     */
    async findSimilar(text, candidates, topK = 5) {
        if (!text || candidates.length === 0) {
            return [];
        }

        try {
            const textEmbedding = await this.getEmbedding(text);
            const similarities = [];

            for (const candidate of candidates) {
                const candidateEmbedding = await this.getEmbedding(candidate);
                const similarity = this.cosineSimilarity(textEmbedding, candidateEmbedding);
                similarities.push({ text: candidate, similarity });
            }

            // Sort by similarity descending
            similarities.sort((a, b) => b.similarity - a.similarity);

            // Return top K
            return similarities.slice(0, topK);

        } catch (error) {
            log.error('SEMANTIC', `Find similar failed: ${error.message}`);
            return [];
        }
    }

    /**
     * Clear embedding cache
     */
    clearCache() {
        this.embeddingCache.clear();
        log.info('SEMANTIC', 'Embedding cache cleared');
    }
}

module.exports = new SemanticSimilarityService();
