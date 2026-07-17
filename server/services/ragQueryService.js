const log = require('../utils/logger');
const { ragQueryDuration } = require('../utils/metrics');
// server/services/ragQueryService.js
// Calls the Python RAG service which internally runs vector search + KG search in parallel.
// KG search has a 200ms server-side timeout (GRAPHRAG_TIMEOUT_MS) to keep chat latency predictable.
const axios = require('axios');

async function queryPythonRagService(
    query, documentContextNameToPass, criticalThinkingEnabled, clientFilter = null, k = 5, userId = null
) {
    const pythonServiceUrl = process.env.PYTHON_RAG_SERVICE_URL;
    if (!pythonServiceUrl) {
        log.error('DB', "PYTHON_RAG_SERVICE_URL is not set.");
        return { references: [], toolOutput: "RAG service is not configured on the server." };
    }
    const searchUrl = `${pythonServiceUrl}/query`;

    const _hasExtension = documentContextNameToPass
        ? /\.[a-zA-Z0-9]{2,5}$/.test(documentContextNameToPass)
        : false;
    const sourceType = _hasExtension ? 'user_doc' : (documentContextNameToPass ? 'course' : null);

    // KG (Neo4j) only contains course concept graphs — never user-uploaded file data.
    // Guard: only enable KG search when the context is an admin course (no file extension).
    const useKgForThisContext = !!criticalThinkingEnabled && sourceType === 'course';

    const payload = {
        query: query,
        k: k,
        user_id: userId || "anonymous",
        use_kg_critical_thinking: useKgForThisContext,
        documentContextName: documentContextNameToPass || null,
        source_type: sourceType,
        filter: clientFilter || {}
    };

    const _ragStart = Date.now();
    try {
        const response = await axios.post(searchUrl, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: process.env.PYTHON_RAG_TIMEOUT || 30000
        });
        const _elapsed = Date.now() - _ragStart;
        log.info('DB', `[RAG] query completed in ${_elapsed}ms — docs=${response.data?.retrieved_documents_list?.length ?? 0} kg=${!!criticalThinkingEnabled}`);
        ragQueryDuration.observe({ status: 'ok' }, _elapsed);

        const relevantDocs = response.data?.retrieved_documents_list || [];
        const references = relevantDocs.map((doc, index) => ({
            number: index + 1,
            source: doc.metadata?.file_name || doc.metadata?.original_name || 'Unknown Document',
            content_preview: (doc.page_content || "").substring(0, 100) + "...",
            metadata: doc.metadata // Pass full metadata including section_context
        }));

        const toolOutput = relevantDocs.length > 0
            ? response.data.formatted_context_snippet
            : "No relevant context was found in the specified documents for this query.";

        return { references, toolOutput };

    } catch (error) {
        const _elapsed = Date.now() - _ragStart;
        let errorMsg = error.message;
        if (error.response?.data?.error) errorMsg = `Python Service Error: ${error.response.data.error}`;
        else if (error.code === 'ECONNABORTED') errorMsg = `Python RAG service request timed out after ${_elapsed}ms.`;
        log.error('DB', `[RAG] query FAILED after ${_elapsed}ms: ${errorMsg}`);
        ragQueryDuration.observe({ status: error.code === 'ECONNABORTED' ? 'timeout' : 'error' }, _elapsed);
        throw new Error(errorMsg);
    }
}

module.exports = {
    queryPythonRagService,
};