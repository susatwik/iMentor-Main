/**
 * Local Knowledge Base Service
 * 
 * Semantic repository using embeddings for retrieving localized knowledge sources.
 * Integrates incremental updates by hashing content versioning.
 */

const KnowledgeSource = require('../models/KnowledgeSource');
const crypto = require('crypto');

// Simulated local embedding service for seamless future swap
const embeddingService = {
    async generateEmbedding(text) {
        // Mock 1536-d float array
        return Array.from({ length: 1536 }, () => (Math.random() - 0.5) * 0.1);
    }
};

const localKnowledgeBase = {

    /**
     * Search local knowledge repository using MongoDB Text index (fallback available)
     * Future: VectorSearch ($knnBeta or FAISS)
     */
    async getLocalSources(query, options = { limit: 5 }) {
        try {
            console.log(`[LocalKB] Searching semantic sources for: "${query}"`);
            const normalizedQuery = query.toLowerCase().trim();

            const queryEmbedding = await embeddingService.generateEmbedding(normalizedQuery);
            // In a real MongoDB 6.0+ Atlas setup, we would use $vectorSearch here.
            // Using standard text search as the baseline fallback logic for this environment.

            const results = await KnowledgeSource.find({
                $text: { $search: normalizedQuery }
            })
                .limit(options.limit)
                .select('title textContent type metaData updatedAt version credibilityScore originSource')
                .lean();

            const formattedSources = results.map(doc => ({
                title: doc.title || 'Local Document',
                content: doc.textContent,
                abstract: (doc.textContent || '').substring(0, 500) + '...',
                url: `local://knowledge-source/${doc._id}`,
                sourceType: 'local',
                publishedDate: doc.updatedAt,
                year: new Date(doc.updatedAt).getFullYear(),
                credibilityScore: doc.credibilityScore || 80, // Default to High Authority
                version: doc.version,
                originSource: doc.originSource || 'User Upload',
                authors: ['Local Internal Knowledge']
            }));

            if (formattedSources.length === 0) {
                console.log("[LocalKB] No local semantic matches found.");
                return [];
            }

            console.log(`[LocalKB] Found ${formattedSources.length} local sources.`);
            return formattedSources;

        } catch (error) {
            if (error.code === 27 || error.message.includes('text index')) {
                console.warn("[LocalKB] Text index missing, semantic fallback not configured. Skipping local search.");
                return [];
            }
            console.error("[LocalKB] Error searching local sources:", error);
            return [];
        }
    },

    /**
     * Incremental Crawling / Ingestion logic
     * Hashes text content to check if an update is genuinely needed.
     */
    async ingestIncremental(userId, title, textContent, originSource = 'API') {
        const contentHash = crypto.createHash('sha256').update(textContent).digest('hex');

        // Check if document exists
        const existingDoc = await KnowledgeSource.findOne({ userId, title });

        if (existingDoc) {
            if (existingDoc.contentHash === contentHash) {
                console.log(`[LocalKB] Document "${title}" unchanged. Skipping update.`);
                return existingDoc;
            } else {
                // Update and re-embed
                console.log(`[LocalKB] Document "${title}" changed. Updating...`);
                existingDoc.textContent = textContent;
                existingDoc.contentHash = contentHash;
                existingDoc.version = (existingDoc.version || 1) + 1;
                existingDoc.embedding = await embeddingService.generateEmbedding(textContent); // Async generate
                existingDoc.originSource = originSource;
                return await existingDoc.save();
            }
        } else {
            // Create new
            console.log(`[LocalKB] Document "${title}" is new. Storing and embedding...`);
            const embedding = await embeddingService.generateEmbedding(textContent);
            return await KnowledgeSource.create({
                userId,
                title,
                sourceType: 'document',
                textContent,
                contentHash,
                embedding,
                version: 1,
                credibilityScore: 90, // Newly added local DB gets high credibility
                originSource
            });
        }
    }
};

module.exports = localKnowledgeBase;
