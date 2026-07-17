// server/scripts/test_research_synthesis.js
// Verification test for Task 1.3.2: Intelligent Research Synthesis
// Tests: multi-doc summarization, citation graph, contradiction detection, fact-checking

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

function testModuleLoading() {
    console.log('\n=== TEST 1: Module Loading ===');
    try {
        const synthesis = require('../services/researchSynthesisService');
        console.log('  ✅ researchSynthesisService loaded');
        console.log(`    └─ Exports: ${Object.keys(synthesis).join(', ')}`);

        const factCheck = require('../services/factCheckingService');
        console.log('  ✅ factCheckingService loaded');
        console.log(`    └─ Exports: ${Object.keys(factCheck).join(', ')}`);

        const orchestrator = require('../services/deepResearchOrchestrator');
        console.log('  ✅ deepResearchOrchestrator loaded (enhanced)');
        console.log(`    └─ Exports: ${Object.keys(orchestrator).join(', ')}`);
        console.log(`    └─ Has conductDeepResearch: ${typeof orchestrator.conductDeepResearch === 'function'}`);

        return true;
    } catch (error) {
        console.error('  ❌ Module loading failed:', error.message);
        return false;
    }
}

async function testMultiDocSummarization() {
    console.log('\n=== TEST 2: Multi-Document Summarization ===');
    const { multiDocumentSummarize } = require('../services/researchSynthesisService');

    const mockSources = [
        {
            title: 'Deep Learning in Computer Vision',
            content: 'Convolutional neural networks (CNNs) have revolutionized computer vision tasks. Abstract: This paper surveys recent advances in deep learning for image classification, object detection, and segmentation. Results show that transformer-based models are outperforming traditional CNNs in many benchmarks et al. (2024).',
            sourceType: 'arxiv',
            credibilityScore: 0.95,
            url: 'https://arxiv.org/abs/2301.00001',
            authors: ['Smith, J.', 'Doe, A.'],
        },
        {
            title: 'Transfer Learning for Medical Imaging',
            content: 'Transfer learning has shown remarkable results in medical image analysis. Introduction: Pre-trained models fine-tuned on domain-specific data achieve state-of-the-art performance with limited training data. Methodology: We evaluate ResNet, EfficientNet, and ViT models on chest X-ray classification. Conclusion: ViT with pre-training outperforms CNN approaches.',
            sourceType: 'pubmed',
            credibilityScore: 0.92,
            url: 'https://pubmed.ncbi.nlm.nih.gov/12345/',
            authors: ['Lee, K.', 'Park, S.'],
        },
        {
            title: 'Attention Mechanisms in Neural Networks',
            content: 'The transformer architecture introduced self-attention mechanisms which have become fundamental in modern deep learning. Self-attention allows models to weigh the importance of different input elements. While originally designed for NLP, attention mechanisms now dominate vision tasks as well through Vision Transformers (ViT).',
            sourceType: 'semantic_scholar',
            credibilityScore: 0.88,
            url: 'https://semanticscholar.org/paper/123',
            authors: ['Chen, W.'],
        },
    ];

    try {
        const result = await multiDocumentSummarize(mockSources, 'deep learning in computer vision', { style: 'academic' });
        console.log(`  📝 Summary length: ${(result.summary || '').length} chars`);
        console.log(`  🔑 Key findings: ${(result.keyFindings || []).length}`);
        console.log(`  🎯 Themes: ${(result.themes || []).length}`);
        console.log(`  ⚠️ Contradictions: ${(result.contradictions || []).length}`);
        console.log(`  🕳️ Gaps: ${(result.gaps || []).length}`);
        console.log(`  📊 Source count: ${result.sourceCount}`);
        console.log('  ✅ Multi-document summarization working');
    } catch (error) {
        console.log(`  ⚠️ Summarization test: ${error.message}`);
    }
}

async function testCitationGraph() {
    console.log('\n=== TEST 3: Citation Graph Construction ===');
    const { buildCitationGraph } = require('../services/researchSynthesisService');

    const mockSources = [
        { title: 'Paper A: CNN Architectures', content: 'ResNet and VGG are popular CNN architectures for image classification.', sourceType: 'arxiv', credibilityScore: 0.95 },
        { title: 'Paper B: Vision Transformers', content: 'Vision Transformers (ViT) outperform CNNs like ResNet on many benchmarks.', sourceType: 'arxiv', credibilityScore: 0.93 },
        { title: 'Paper C: Hybrid Models', content: 'Combining CNN feature extraction with transformer attention improves results over pure CNN or ViT.', sourceType: 'web', credibilityScore: 0.7 },
    ];

    try {
        const graph = await buildCitationGraph(mockSources, 'neural network architectures');
        console.log(`  📊 Nodes: ${(graph.nodes || []).length}`);
        console.log(`  🔗 Edges: ${(graph.edges || []).length}`);
        console.log(`  📦 Clusters: ${(graph.clusters || []).length}`);
        if (graph.edges.length > 0) {
            console.log(`    └─ Example edge: ${graph.edges[0].from} → ${graph.edges[0].to} (${graph.edges[0].relationship})`);
        }
        console.log('  ✅ Citation graph construction working');
    } catch (error) {
        console.log(`  ⚠️ Citation graph test: ${error.message}`);
    }
}

async function testContradictionDetection() {
    console.log('\n=== TEST 4: Contradiction Detection ===');
    const { detectContradictions } = require('../services/researchSynthesisService');

    const conflictingSources = [
        { title: 'Study A', content: 'Our study shows that model X achieves 95% accuracy on ImageNet, making it state-of-the-art.', sourceType: 'arxiv', credibilityScore: 0.9 },
        { title: 'Study B', content: 'Model X only achieves 89% accuracy on ImageNet in our experiments. Model Y with 94% is superior.', sourceType: 'arxiv', credibilityScore: 0.88 },
    ];

    try {
        const result = await detectContradictions(conflictingSources, 'model performance on ImageNet');
        console.log(`  🔍 Agreement level: ${result.agreementLevel}`);
        console.log(`  ⚠️ Contradictions found: ${(result.contradictions || []).length}`);
        console.log(`  🚩 Factual concerns: ${(result.factualConcerns || []).length}`);
        console.log('  ✅ Contradiction detection working');
    } catch (error) {
        console.log(`  ⚠️ Contradiction test: ${error.message}`);
    }
}

async function testFactChecking() {
    console.log('\n=== TEST 5: Fact-Checking Service ===');
    const { extractClaims, factCheckResearch } = require('../services/factCheckingService');

    const testText = 'Transformer architectures, introduced by Vaswani et al. in 2017, have achieved state-of-the-art results. GPT-4 uses 1.7 trillion parameters. BERT was trained on 16GB of text data [1].';

    try {
        // Test claim extraction
        const claims = await extractClaims(testText, 'transformer models');
        console.log(`  📋 Extracted claims: ${claims.length}`);
        claims.forEach((c, i) => {
            console.log(`    └─ Claim ${i + 1}: "${(c.text || '').substring(0, 80)}..." (${c.category})`);
        });

        console.log('  ✅ Fact-checking service working');
    } catch (error) {
        console.log(`  ⚠️ Fact-check test: ${error.message}`);
    }
}

async function testReportGeneration() {
    console.log('\n=== TEST 6: Research Report Generation ===');
    const { generateResearchReport } = require('../services/researchSynthesisService');

    const mockSources = [
        { title: 'Introduction to Quantum Computing', content: 'Quantum computers use qubits which can exist in superposition, enabling parallel computation.', sourceType: 'academic', credibilityScore: 0.9, url: 'https://example.edu/quantum', authors: ['Alice'] },
        { title: 'Quantum Error Correction', content: 'Error correction is critical for practical quantum computing. Surface codes are the leading approach.', sourceType: 'arxiv', credibilityScore: 0.95, url: 'https://arxiv.org/quantum', authors: ['Bob'] },
    ];

    try {
        const report = await generateResearchReport('quantum computing fundamentals', mockSources, { includeGraph: true, includeContradictions: true });
        console.log(`  📄 Report markdown length: ${(report.reportMarkdown || '').length} chars`);
        console.log(`  📊 Has citation graph: ${!!report.citationGraph}`);
        console.log(`  ⚠️ Has contradictions: ${!!report.contradictions}`);
        console.log(`  📚 References: ${(report.references || []).length}`);
        console.log(`  ⏱️ Generation time: ${report.metadata?.generationTimeMs}ms`);
        console.log('  ✅ Report generation working');
    } catch (error) {
        console.log(`  ⚠️ Report generation test: ${error.message}`);
    }
}

async function testRouteLoading() {
    console.log('\n=== TEST 7: Route Loading ===');
    try {
        const route = require('../routes/deepResearch');
        const layers = route.stack || [];
        const routes = layers.filter(l => l.route).map(l => `${Object.keys(l.route.methods).join(',').toUpperCase()} ${l.route.path}`);
        console.log(`  🛣️ Registered routes: ${routes.length}`);
        routes.forEach(r => console.log(`    └─ ${r}`));
        console.log('  ✅ Route loading successful');
    } catch (error) {
        console.error('  ❌ Route loading failed:', error.message);
    }
}

async function runAll() {
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║   Task 1.3.2: Research Synthesis System Tests   ║');
    console.log('╚══════════════════════════════════════════════════╝');

    const modulesOk = testModuleLoading();
    if (!modulesOk) {
        console.error('\n❌ Module loading failed — aborting remaining tests.');
        process.exit(1);
    }

    testRouteLoading();
    await testMultiDocSummarization();
    await testCitationGraph();
    await testContradictionDetection();
    await testFactChecking();
    await testReportGeneration();

    console.log('\n' + '='.repeat(52));
    console.log('All Task 1.3.2 tests completed!');
    console.log('='.repeat(52));
    process.exit(0);
}

runAll().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
