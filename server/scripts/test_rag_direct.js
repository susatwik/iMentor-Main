const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const PYTHON_RAG_URL = process.env.PYTHON_RAG_SERVICE_URL || 'http://localhost:8001';

async function testRagConnectivity() {
    console.log(`Checking Python RAG connectivity at ${PYTHON_RAG_URL}...`);
    
    try {
        console.log("\n--- Testing Health Check ---");
        const health = await axios.get(`${PYTHON_RAG_URL}/health`, { timeout: 5000 });
        console.log("Health Status:", health.status);
        console.log("Health Data:", JSON.stringify(health.data, null, 2));

        console.log("\n--- Testing Web Search ---");
        const webSearch = await axios.post(`${PYTHON_RAG_URL}/web_search`, { query: "deep learning trends 2024" }, { timeout: 15000 });
        console.log("Web Search Status:", webSearch.status);
        console.log("Results found:", Array.isArray(webSearch.data) ? webSearch.data.length : "Error");

        console.log("\n--- Testing Academic Search ---");
        const academicSearch = await axios.post(`${PYTHON_RAG_URL}/academic_search`, { query: "attention mechanism transformers", max_results: 2 }, { timeout: 15000 });
        console.log("Academic Search Status:", academicSearch.status);
        console.log("Success:", academicSearch.data.success);
        console.log("Results found:", academicSearch.data.results ? academicSearch.data.results.length : 0);

        console.log("\n✅ SUCCESS: Python RAG Service is healthy and responding on port 8001.");
    } catch (error) {
        console.error("❌ RAG SERVICE TEST FAILED:", error.message);
        if (error.response) {
            console.error("Response:", error.response.data);
        }
    }
}

testRagConnectivity();
