// server/scripts/test_new_agent_tools.js
const { availableTools } = require('../services/toolRegistry');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const mockContext = {
    userId: 'test_user_1.4.2',
    documentContextName: null,
    criticalThinkingEnabled: true
};

async function testTools() {
    console.log("--- TESTING NEW AGENT TOOLS ---");

    // 1. Test Multi-Search
    console.log("\n[Test 1] Testing multi_search...");
    try {
        const multiResult = await availableTools.multi_search.execute({ query: "artificial intelligence in healthcare" }, mockContext);
        console.log("Multi-Search Output Summary:");
        console.log(multiResult.toolOutput.substring(0, 500) + "...");
        console.log(`References found: ${multiResult.references.length}`);
    } catch (e) {
        console.error("Multi-search failed:", e.message);
    }

    // 2. Test Crawler
    console.log("\n[Test 2] Testing web_crawl...");
    // Use a relatively stable URL
    const testUrl = "https://en.wikipedia.org/wiki/Green_hydrogen";
    try {
        const crawlResult = await availableTools.web_crawl.execute({ url: testUrl });
        console.log("Crawl Output Summary:");
        console.log(crawlResult.toolOutput.substring(0, 500) + "...");
        if (crawlResult.toolOutput.includes("hydrogen")) {
            console.log("✅ SUCCESS: Found expected content in crawl.");
        } else {
            console.log("⚠️ WARNING: Crawl returned content but maybe not the right one.");
        }
    } catch (e) {
        console.error("Web crawl failed:", e.message);
    }
}

testTools();
