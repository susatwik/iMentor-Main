/**
 * ReAct Tool Selector & Prompt Builder
 * 
 * This module is responsible for constructing the prompt that guides the LLM
 * to select the appropriate tool during the ReAct loop.
 */

const { availableTools } = require('./toolRegistry');

/**
 * Generates the system prompt for the ReAct agent, including available tools.
 * @param {string} userQuery - The original user query.
 * @param {string} context - The accumulated context from previous steps.
 * @returns {string} - The formatted system prompt.
 */
function createReActSystemPrompt(userQuery, context) {
    const customTools = { ...availableTools };
    // We might want to filter or format tools differently for ReAct if needed

    // Format tools for the prompt
    let toolsDescription = JSON.stringify(customTools, null, 2);

    return `
You are a "ReAct" (Reasoning + Acting) Agent. Your goal is to answer the user's query by dynamically selecting and executing tools, one step at a time.

**USER QUERY:** "${userQuery}"

**AVAILABLE TOOLS:**
${toolsDescription}

**INSTRUCTIONS:**
1.  **Analyze the current situation.** Look at the "Context / Previous Steps" to see what has been done so far.
2.  **Determine the next step.** Do you need more information? If so, which tool can provide it?
3.  **Select a Tool or Answer.**
    *   If you need to use a tool, output a JSON object with "tool_call".
    *   If you have enough information to answer the user's query *comprehensively*, output a JSON object with "final_answer".

**OUTPUT FORMAT (Strict JSON):**

**Option A: Execute a Tool**
\`\`\`json
{
  "thought": "I need to find X... so I will use tool Y...",
  "tool_call": {
    "tool_name": "exact_tool_name_from_list",
    "parameters": {
      "query": "search query or specific params" 
    }
  }
}
\`\`\`

**Option B: Provide Final Answer**
\`\`\`json
{
  "thought": "I have gathered all necessary information...",
  "final_answer": "Your comprehensive final answer here..."
}
\`\`\`

**CRITICAL RULES:**
*   Only ONE tool call per turn.
*   Your "final_answer" must be the actual answer to the user, not just "I'm done".
*   Do not repeat the same tool call with the same parameters if it already failed or returned no results.
`;
}

module.exports = {
    createReActSystemPrompt
};
