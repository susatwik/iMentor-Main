const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mongoose = require('mongoose');

async function evaluate() {
    try {
        console.log("Connecting to MongoDB...");
        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected to MongoDB.");

        const deepResearchOrchestrator = require('../services/deepResearchOrchestrator.js');
        
        const query = "deep learning algorithms for Soc and Rul estimation of batteries and datasets";
        console.log(`\n=== Starting Deep Research for: ${query} ===`);
        
        const result = await deepResearchOrchestrator.runDeepResearch(
            query,
            { nature: 'academic', depth: 'medium', forceRefresh: true },
            (progress) => {
                console.log(`[PROGRESS] ${progress.phase}: ${progress.message}`);
                if (progress.extra && progress.extra.plan) {
                    console.log(`  -> Plan: ${JSON.stringify(progress.extra.plan)}`);
                }
            }
        );
        
        console.log("\n=== RESEARCH COMPLETED ===");
        console.log(`Total Sources Used: ${result.researchBundle.sources.length}`);
        console.log(`Overall Confidence: ${result.researchBundle.overallConfidenceScore}`);
        console.log(`\n=== REPORT ===`);
        console.log(result.researchReport.fullReport?.substring(0, 500) + '...');
        
        // Output evaluation data to a file for analysis
        const fs = require('fs');
        fs.writeFileSync('/tmp/dr_evaluation_data.json', JSON.stringify({
            plan: result.researchBundle.plan,
            evidenceProfile: result.researchBundle.evidenceProfile,
            reportSnippet: result.researchReport.fullReport?.substring(0, 1000)
        }, null, 2));
        
        console.log("Evaluation data saved to /tmp/dr_evaluation_data.json");
        
    } catch (e) {
        console.error("Evaluation failed: ", e);
    } finally {
        await mongoose.disconnect();
    }
}

evaluate();
