const log = require('../utils/logger');
// server/services/kgService.js
const geminiService = require('./geminiService');
const ollamaService = require('./ollamaService');
const groqService = require('./groqService');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const {
    KG_GENERATION_SYSTEM_PROMPT,
    KG_BATCH_USER_PROMPT_TEMPLATE
} = require('../config/promptTemplates');


function constructKgPromptForBatch(chunkTexts) {
    let formattedChunkTexts = "";
    chunkTexts.forEach((chunkText, index) => {
        formattedChunkTexts += `
--- START OF CHUNK ${index + 1} ---
${chunkText}
--- END OF CHUNK ${index + 1} ---
`;
    });
    return KG_BATCH_USER_PROMPT_TEMPLATE.replace('{BATCHED_CHUNK_TEXTS_HERE}', formattedChunkTexts);
}

async function _processBatchOfChunksForKg(batchOfChunkObjects, batchIndex, llmProvider, ollamaModel) {
    const logPrefix = `[KG Service Batch ${batchIndex}]`;

    const chunkTextsForPrompt = batchOfChunkObjects.map(chunk => chunk.text_content);

    if (chunkTextsForPrompt.length === 0) {
        // log.info('DB', `${logPrefix} No text content in batch`);
        return [];
    }

    const userPromptForBatch = constructKgPromptForBatch(chunkTextsForPrompt);
    
    // For KG generation, the user prompt contains the data to be processed.
    // The system prompt contains the instructions on HOW to process it.
    const historyForLlm = [
        { role: 'user', parts: [{ text: "Please generate the knowledge graph fragments based on the provided text chunks and your system instructions." }] }
    ];

    try {
        log.info('DB', `Extracting KG from ${chunkTextsForPrompt.length} chunks (${llmProvider})`);
        let responseText;

        if (llmProvider === 'ollama') {
            responseText = await ollamaService.generateContentWithHistory(
                historyForLlm,
                userPromptForBatch, // Pass the chunks as the "current query"
                KG_GENERATION_SYSTEM_PROMPT, // Pass the KG instructions as the system prompt
                { model: ollamaModel, maxOutputTokens: ollamaService.DEFAULT_MAX_OUTPUT_TOKENS_OLLAMA_KG }
            );
        } else if (llmProvider === 'groq') {
            responseText = await groqService.generateContentWithHistory(
                historyForLlm,
                userPromptForBatch,
                KG_GENERATION_SYSTEM_PROMPT,
                {
                    model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
                    apiKey: process.env.GROQ_API_KEY,
                    maxOutputTokens: ollamaService.DEFAULT_MAX_OUTPUT_TOKENS_OLLAMA_KG
                }
            );
        } else { // Default to Gemini
            // --- THIS IS THE CORRECTED CALL ---
            responseText = await geminiService.generateContentWithHistory(
                historyForLlm,                      // Minimal history to kick off the chat
                userPromptForBatch,                 // The user prompt containing the document chunks to be analyzed
                KG_GENERATION_SYSTEM_PROMPT,        // The detailed instructions on how the LLM should behave
                { maxOutputTokens: geminiService.DEFAULT_MAX_OUTPUT_TOKENS_KG } // Pass maxOutputTokens correctly in the options object
            );
            // --- END CORRECTION ---
        }

        if (!responseText) {
            log.warn('DB', "Empty LLM response for KG batch");
            return [];
        }

        let cleanedResponseText = responseText.trim();
        if (cleanedResponseText.startsWith("```json")) {
            cleanedResponseText = cleanedResponseText.substring(7);
            if (cleanedResponseText.endsWith("```")) {
                cleanedResponseText = cleanedResponseText.slice(0, -3);
            }
        } else if (cleanedResponseText.startsWith("```")) {
            cleanedResponseText = cleanedResponseText.substring(3);
            if (cleanedResponseText.endsWith("```")) {
                cleanedResponseText = cleanedResponseText.slice(0, -3);
            }
        }
        cleanedResponseText = cleanedResponseText.trim();
        
        const graphFragmentsArray = JSON.parse(cleanedResponseText);

        if (!Array.isArray(graphFragmentsArray)) {
            log.warn('DB', "Extraction failed: Response was not a JSON array.");
            return [];
        }

        const validFragments = graphFragmentsArray.filter(fragment =>
            fragment && typeof fragment === 'object' && Array.isArray(fragment.nodes) && Array.isArray(fragment.edges)
        );

        log.success('DB', `Parsed ${validFragments.length} KG fragments`);
        return validFragments;
    } catch (error) {
        log.error('DB', `KG batch extraction failed: ${error.message}`);
        return [];
    }
}


function _mergeGraphFragments(graphFragments) {
    // log.info('DB', `Merging ${graphFragments.length} fragments...`);
    const finalNodesMap = new Map();
    const finalEdgesSet = new Set();

    for (const fragment of graphFragments) {
        if (!fragment || !fragment.nodes || !fragment.edges) {
            console.warn("[KG Service Merge] Skipping invalid or null graph fragment.");
            continue;
        }
        
        for (const node of fragment.nodes) {
            if (!node || typeof node.id !== 'string' || !node.id.trim()) {
                console.warn("[KG Service Merge] Skipping invalid node (missing/empty ID):", node);
                continue;
            }
            const nodeId = node.id.trim();
            if (!finalNodesMap.has(nodeId)) {
                finalNodesMap.set(nodeId, { ...node, id: nodeId });
            } else {
                const existingNode = finalNodesMap.get(nodeId);
                if (node.description && typeof node.description === 'string' &&
                    (!existingNode.description || node.description.length > existingNode.description.length)) {
                    existingNode.description = node.description;
                }
                if (node.type && (!existingNode.type || existingNode.type === "generic" || existingNode.type.toLowerCase() === "unknown")) {
                    existingNode.type = node.type;
                }
                if (node.parent && !existingNode.parent) {
                    existingNode.parent = node.parent;
                }
            }
        }

        for (const edge of fragment.edges) {
            if (!edge || typeof edge.from !== 'string' || typeof edge.to !== 'string' || typeof edge.relationship !== 'string' ||
                !edge.from.trim() || !edge.to.trim() || !edge.relationship.trim()) {
                console.warn("[KG Service Merge] Skipping invalid edge (missing from/to/relationship or empty):", edge);
                continue;
            }
            const edgeKey = `${edge.from.trim()}|${edge.to.trim()}|${edge.relationship.trim().toUpperCase()}`;
            finalEdgesSet.add(edgeKey);
        }
    }

    const mergedNodes = Array.from(finalNodesMap.values());
    const mergedEdges = Array.from(finalEdgesSet).map(edgeKey => {
        const [from, to, relationship] = edgeKey.split('|');
        return { from, to, relationship };
    });

    log.info('DB', `KG Merged: ${mergedNodes.length} nodes, ${mergedEdges.length} edges`);
    return { nodes: mergedNodes, edges: mergedEdges };
}

async function generateAndStoreKg(chunksForKg, userId, originalName, llmProvider, ollamaModel) {
    const logPrefix = `[KG Service Doc: ${originalName}, User: ${userId}]`;
    log.info('DB', `Starting KG generation for "${originalName}"`);

    if (!chunksForKg || chunksForKg.length === 0) {
        console.warn(`${logPrefix} No chunks provided for KG generation.`);
        return { success: true, message: "No chunks to process for KG.", finalKgNodesCount: 0, finalKgEdgesCount: 0 };
    }

    const allGraphFragments = [];
    const BATCH_SIZE = parseInt(process.env.KG_GENERATION_BATCH_SIZE) || 25;
    let batchIndex = 0;

    for (let i = 0; i < chunksForKg.length; i += BATCH_SIZE) {
        batchIndex++;
        const currentBatchOfChunks = chunksForKg.slice(i, i + BATCH_SIZE);
        const validChunksInBatch = currentBatchOfChunks.filter(chunk => chunk && chunk.text_content && chunk.text_content.trim() !== '');
        
        if (validChunksInBatch.length === 0) continue;
        
        // log.info('DB', `Processing batch ${batchIndex}/${Math.ceil(chunksForKg.length/BATCH_SIZE)}`);
        const fragmentsFromBatch = await _processBatchOfChunksForKg(validChunksInBatch, batchIndex, llmProvider, ollamaModel);
        if (fragmentsFromBatch && fragmentsFromBatch.length > 0) {
            allGraphFragments.push(...fragmentsFromBatch);
        }
    }

    if (allGraphFragments.length === 0) {
        log.warn('DB', "No KG fragments generated from batches.");
        return { success: true, message: "No KG data extracted from any document chunks.", finalKgNodesCount: 0, finalKgEdgesCount: 0 };
    }

    const finalKg = _mergeGraphFragments(allGraphFragments);
    
    if (!finalKg || finalKg.nodes.length === 0) {
        log.warn('DB', "Merged KG has no nodes.");
        return { success: true, message: "Merged KG was empty after processing all fragments.", finalKgNodesCount: 0, finalKgEdgesCount: 0 };
    }

    const baseRagUrl = process.env.PYTHON_RAG_SERVICE_URL;
    if (!baseRagUrl) {
        return { success: false, message: "KG generated, but Python Service URL is not configured. KG not stored." };
    }
    const kgIngestionApiUrl = `${baseRagUrl.replace(/\/$/, '')}/kg`;

    try {
        const payload = { userId, originalName, nodes: finalKg.nodes, edges: finalKg.edges };
        const serviceResponse = await axios.post(kgIngestionApiUrl, payload, { timeout: 300000 });
        const responseData = serviceResponse.data;

        if (serviceResponse.status >= 200 && serviceResponse.status < 300 && responseData && responseData.status === "completed") {
            log.success('DB', `KG for '${originalName}' stored successfully`);
            return {
                success: true, message: `KG for '${originalName}' successfully processed.`,
                finalKgNodesCount: finalKg.nodes.length, finalKgEdgesCount: finalKg.edges.length
            };
        } else {
            const msg = responseData?.message || responseData?.error || 'API failure';
            log.error('DB', `Failed to store KG for '${originalName}': ${msg}`);
            return {
                success: false, message: `Indicator failure: ${msg}`,
                finalKgNodesCount: finalKg.nodes.length, finalKgEdgesCount: finalKg.edges.length
            };
        }
    } catch (error) {
        const errorMsg = error.response?.data?.message || error.response?.data?.error || error.message;
        log.error('DB', `Error calling KG Ingestion API for '${originalName}': ${errorMsg}`);
        return {
            success: false, message: `Critical error calling Ingestion API: ${errorMsg}`,
            finalKgNodesCount: finalKg.nodes.length, finalKgEdgesCount: finalKg.edges.length
        };
    }
}

module.exports = { generateAndStoreKg };