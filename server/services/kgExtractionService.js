const log = require("../utils/logger");
// server/services/kgExtractionService.js
const { decrypt } = require("../utils/crypto");
const User = require("../models/User");
const geminiService = require("./geminiService");
const ollamaService = require("./ollamaService");
const axios = require("axios");
const path = require("path");

const KG_EXTRACTION_PROMPT = `
You are an expert data architect. Your task is to analyze the provided text and extract a detailed knowledge graph of the key concepts and their relationships.

**INSTRUCTIONS:**
1.  **Identify Entities/Nodes**: Identify the top 5-7 most important entities (concepts, technologies, processes). These will be your nodes.
2.  **Identify Relationships/Edges**: Determine how these nodes are connected with descriptive verb phrases (e.g., 'IS_A', 'USES', 'RESULTS_IN').
3.  **Format as JSON**: Your entire output MUST be a single, valid JSON object with "nodes" and "edges".
    -   Nodes: \`[{"id": "NodeID", "description": "A brief, one-sentence description."}]\`
    -   Edges: \`[{"from": "SourceNodeID", "to": "TargetNodeID", "relationship": "RELATIONSHIP_TYPE"}]\`
4.  **Be Concise**: Focus only on the most critical concepts from the provided text.
5.  **CRITICAL FOR JSON VALIDITY**: Any quotation marks INSIDE the "description" must be properly escaped (e.g. \\"). Do NOT use unescaped quotes inside strings.

---
**TEXT TO ANALYZE:**
\`\`\`text
{textToAnalyze}
\`\`\`
---

**FINAL KNOWLEDGE GRAPH JSON (start immediately with \`{\`):**
`;

function extractBalancedJsonObject(input) {
  if (!input || typeof input !== "string") return null;

  let depth = 0;
  let startIndex = -1;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (inString) {
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (ch === "\\") {
        escapeNext = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) startIndex = i;
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && startIndex !== -1) {
        return input.slice(startIndex, i + 1);
      }
    }
  }

  return null;
}

function normalizeJsonCandidate(input) {
  if (!input || typeof input !== "string") return "";

  return input
    .replace(/^\uFEFF/, "")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, "$1")
    .trim();
}

async function repairJsonWithLlm(invalidJson, llmService, finalLlmOptions) {
  const repairPrompt = `Repair the following malformed JSON so it becomes one valid JSON object.\n\nRules:\n1) Keep the same semantic meaning and data.\n2) Output ONLY JSON, no markdown or explanation.\n3) Ensure keys \"nodes\" and \"edges\" remain arrays.\n\nMalformed JSON:\n${invalidJson.slice(0, 8000)}`;

  return llmService.generateContentWithHistory(
    [],
    repairPrompt,
    "You are a strict JSON repair tool. Return a single valid JSON object only.",
    {
      ...finalLlmOptions,
      temperature: 0,
    }
  );
}

async function extractAndStoreKgFromText(text, sessionId, userId, llmConfig, courseName = null) { // llmConfig is now a fallback
  const logPrefix = `[KG Extraction Service] Session: ${sessionId}`;
  try {
    const user = await User.findById(userId).select('+encryptedApiKey preferredLlmProvider ollamaModel ollamaUrl');
    if (!user) throw new Error("User not found for KG extraction.");

    // --- USE INTELLIGENT ROUTING FOR KG EXTRACTION ---
    const { selectLLM } = require("./llmRouterService");
    const groqService = require("./groqService");

    // KG extraction is complex, so we use the 'technical' subject for routing help
    const { chosenModel } = await selectLLM(text, { userId, subject: 'technical' });

    let llmService;
    if (chosenModel.provider === 'ollama') llmService = ollamaService;
    else if (chosenModel.provider === 'groq') llmService = groqService;
    else llmService = geminiService;

    const finalLlmOptions = {
      apiKey: chosenModel.provider === 'gemini' ? (user.encryptedApiKey ? decrypt(user.encryptedApiKey) : process.env.GEMINI_API_KEY) : (chosenModel.provider === 'groq' ? process.env.GROQ_API_KEY : null),
      ollamaUrl: user.ollamaUrl || process.env.OLLAMA_API_BASE_URL,
      model: chosenModel.modelId,
      temperature: 0.2,
    };

    log.info('DB', `Extracting KG via ${chosenModel.provider.toUpperCase()}`);
    const responseText = await llmService.generateContentWithHistory(
      [],
      KG_EXTRACTION_PROMPT.replace("{textToAnalyze}", text),
      "You are a knowledge graph extractor. Respond with VALID JSON only.",
      finalLlmOptions
    );

    let graphData;
    try {
      const candidates = [];
      const markdownMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (markdownMatch && markdownMatch[1]) candidates.push(markdownMatch[1]);

      const balanced = extractBalancedJsonObject(responseText);
      if (balanced) candidates.push(balanced);

      const trimmedResponse = responseText.trim();
      if (trimmedResponse.startsWith("{") && trimmedResponse.endsWith("}")) {
        candidates.push(trimmedResponse);
      }

      const triedErrors = [];
      const uniqueCandidates = [...new Set(candidates.map((c) => c.trim()).filter(Boolean))];

      if (!uniqueCandidates.length) {
        throw new Error("No JSON object found in LLM response.");
      }

      for (const candidate of uniqueCandidates) {
        const parseInputs = [candidate, normalizeJsonCandidate(candidate)];

        for (const parseInput of parseInputs) {
          try {
            graphData = JSON.parse(parseInput);
            break;
          } catch (e) {
            triedErrors.push(e.message);
          }
        }

        if (graphData) break;

        try {
          const repaired = await repairJsonWithLlm(candidate, llmService, finalLlmOptions);
          const repairedCandidate = extractBalancedJsonObject(repaired) || repaired;
          graphData = JSON.parse(normalizeJsonCandidate(repairedCandidate));
          break;
        } catch (e) {
          triedErrors.push(`repair failed: ${e.message}`);
        }
      }

      if (!graphData) {
        throw new Error(triedErrors[0] || "Unknown parse failure.");
      }
    } catch (parseErr) {
      throw new Error(`LLM did not return a valid JSON object. Error: ${parseErr.message}`);
    }

    if (!graphData.nodes || !graphData.edges)
      throw new Error("LLM JSON is missing 'nodes' or 'edges'.");

    log.info('DB', `Extracted ${graphData.nodes.length} nodes for "${sessionId}"`);

    const pythonServiceUrl = process.env.PYTHON_RAG_SERVICE_URL;
    if (!pythonServiceUrl)
      throw new Error("Python service URL not configured.");

    await axios.post(
      `${pythonServiceUrl}/kg`,
      {
        userId: userId.toString(),
        originalName: sessionId,
        nodes: graphData.nodes,
        edges: graphData.edges,
        ...(courseName ? { courseName } : {}),
      },
      { timeout: 60000 }
    );

    log.success('DB', "KG ingestion from text successful");
  } catch (error) {
    log.error('DB', `Failed to extract KG from text: ${error.message}`);
    // Do not throw here to prevent crashing the main thread for a background task
  }
}

module.exports = { extractAndStoreKgFromText };