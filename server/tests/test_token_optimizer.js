// server/tests/test_token_optimizer.js
const assert = require('assert');
const tokenOptimizer = require('../utils/tokenOptimizer');

console.log('=== Starting Token Optimizer Tests ===\n');

// -------------------------------------------------------------
// Test 1: Minify Prompt
// -------------------------------------------------------------
function testMinifyPrompt() {
    console.log('Running testMinifyPrompt...');

    const inputPrompt = `
    This is a test prompt.
    
    
    Here is a comment: <!-- this comment should be removed -->
    
    And here is a code block:
    \`\`\`python
    def my_function():
        # Keep indentation and comment
        return "w/ or w/o optimization"
    \`\`\`
    
    And another line with multiple   spaces.
    `;

    const expectedOutput = `This is a test prompt.

Here is a comment:

And here is a code block:
\`\`\`python
    def my_function():
        # Keep indentation and comment
        return "w/ or w/o optimization"
\`\`\`

And another line with multiple spaces.`;

    const actualOutput = tokenOptimizer.minifyPrompt(inputPrompt);
    assert.strictEqual(actualOutput, expectedOutput);
    console.log('✓ testMinifyPrompt passed.');
}

// -------------------------------------------------------------
// Test 2: Expand Outgoing Response
// -------------------------------------------------------------
function testExpandOutgoingResponse() {
    console.log('Running testExpandOutgoingResponse...');

    const response = "Please review the info w/ your team, w/o missing the details esp the db config params. Here is some code:\n```javascript\nconst db = 'postgres'; // do not expand db here!\n```\nLet me know if you need another msg.";
    const expected = "Please review the information with your team, without missing the details especially the database configuration parameters. Here is some code:\n```javascript\nconst db = 'postgres'; // do not expand db here!\n```\nLet me know if you need another message.";

    const actual = tokenOptimizer.expandOutgoingResponse(response);
    assert.strictEqual(actual, expected);
    console.log('✓ testExpandOutgoingResponse passed.');
}

// -------------------------------------------------------------
// Test 3: Case-Preserving Expansion
// -------------------------------------------------------------
function testCasePreservation() {
    console.log('Running testCasePreservation...');

    const text = "Esp check the DB config. MSG received, w/o issues. W/O delay, W/ info.";
    const expected = "Especially check the DATABASE configuration. MESSAGE received, without issues. WITHOUT delay, With information.";

    const actual = tokenOptimizer.expandOutgoingResponse(text);
    assert.strictEqual(actual, expected);
    console.log('✓ testCasePreservation passed.');
}

// -------------------------------------------------------------
// Test 4: JSON Key Protection
// -------------------------------------------------------------
function testJsonKeyProtection() {
    console.log('Running testJsonKeyProtection...');

    const jsonResponse = '{"status":"success","msg":"everything is w/o errors","config":{"db":"mongo","param":10}}';
    const expectedJson = '{"status":"success","msg":"everything is without errors","config":{"db":"mongo","param":10}}';

    const actual = tokenOptimizer.expandOutgoingResponse(jsonResponse);
    // Parse both to ensure semantically identical JSON objects to ignore ordering differences
    assert.deepStrictEqual(JSON.parse(actual), JSON.parse(expectedJson));
    console.log('✓ testJsonKeyProtection passed.');
}

// -------------------------------------------------------------
// Test 5: Streaming Token Expander & Split Backticks
// -------------------------------------------------------------
function testStreamingTokenExpander() {
    console.log('Running testStreamingTokenExpander...');

    let receivedTokens = [];
    const expander = new tokenOptimizer.StreamingTokenExpander((token) => {
        receivedTokens.push(token);
    });

    // Stream chunks that split abbreviations
    expander.processChunk("Please look at this ");
    expander.processChunk("inf");
    expander.processChunk("o w");
    expander.processChunk("/");
    expander.processChunk(" the doc. ");
    
    // Simulate split code block marker
    expander.processChunk("Here is the code:\n``");
    expander.processChunk("`javascript\ncon");
    expander.processChunk("st db = 'test';\n``");
    expander.processChunk("`\nNow a finishing ");
    expander.processChunk("msg.");
    
    expander.flush();

    const finalResult = receivedTokens.join('');
    const expected = "Please look at this information with the document. Here is the code:\n```javascript\nconst db = 'test';\n```\nNow a finishing message.";
    
    assert.strictEqual(finalResult, expected);
    console.log('✓ testStreamingTokenExpander passed.');
}

// Run all tests
try {
    testMinifyPrompt();
    testExpandOutgoingResponse();
    testCasePreservation();
    testJsonKeyProtection();
    testStreamingTokenExpander();
    console.log('\n=== All Hardened Token Optimizer Tests Passed Successfully! ===');
} catch (error) {
    console.error('\n❌ Test failed:');
    console.error(error);
    process.exit(1);
}
