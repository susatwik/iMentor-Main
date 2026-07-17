// server/scripts/seedLLMs.js
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
const LLMConfiguration = require('../models/LLMConfiguration');

// --- The Seed Data ---
const llmSeedData = [
  // ===================================================================
  // === OLLAMA MODELS (PRIMARY — User's local models, highest priority)
  // ===================================================================

  // 1. Qwen 2.5 14B: The Reliable All-Rounder (DEFAULT for Ollama)
  {
    modelId: "qwen2.5:14b-instruct",
    provider: "ollama",
    displayName: "Qwen 2.5 14B (Default)",
    description: "Primary general-purpose local model. Great for chat, tutoring, and creative tasks.",
    isDefault: true,
    strengths: ["chat", "creative", "summarization", "technical"],
    subjectFocus: null
  },
  // 2. Qwen 3 32B: Heavy-Duty Reasoning & Technical
  {
    modelId: "qwen3:32b",
    provider: "ollama",
    displayName: "Qwen 3 32B",
    description: "High-parameter model for complex reasoning, technical analysis, and deep thinking.",
    isDefault: false,
    strengths: ["reasoning", "technical", "chat", "math"],
    subjectFocus: null
  },
  // 3. DeepSeek R1: Advanced Reasoning Specialist
  {
    modelId: "deepseek-r1:latest",
    provider: "ollama",
    displayName: "DeepSeek R1 (Reasoning)",
    description: "Advanced reasoning model with chain-of-thought capabilities. Best for complex logic and math.",
    isDefault: false,
    strengths: ["reasoning", "technical", "math", "logic"],
    subjectFocus: null
  },
  // 4. R1-1776 70B: Massive Reasoning Model
  {
    modelId: "r1-1776:70b",
    provider: "ollama",
    displayName: "R1-1776 70B (Heavy Reasoning)",
    description: "70B parameter reasoning powerhouse for the most complex analytical tasks.",
    isDefault: false,
    strengths: ["reasoning", "logic", "math", "technical"],
    subjectFocus: null
  },
  // 5. Phi-4 Reasoning: Logic Specialist
  {
    modelId: "phi4-reasoning:latest",
    provider: "ollama",
    displayName: "Phi-4 Reasoning Expert",
    description: "Specialized reasoning model from Microsoft for logical deduction and structured analysis.",
    isDefault: false,
    strengths: ["reasoning", "logic", "math"],
    subjectFocus: null
  },
  // 6. DeepSeek Coder V2: Full-Size Coding Specialist
  {
    modelId: "deepseek-coder-v2:latest",
    provider: "ollama",
    displayName: "DeepSeek Coder V2",
    description: "Powerful coding model supporting hundreds of programming languages.",
    isDefault: false,
    strengths: ["code", "technical"],
    subjectFocus: null
  },
  // 7. DeepSeek Coder 6.7B: Lightweight Code Model
  {
    modelId: "deepseek-coder:6.7b",
    provider: "ollama",
    displayName: "DeepSeek Coder 6.7B (Fast)",
    description: "Lightweight coding model for quick code generation and debugging.",
    isDefault: false,
    strengths: ["code", "speed"],
    subjectFocus: null
  },
  // 8. DeepSeek Coder V2 Lite: Efficient Code Assistant
  {
    modelId: "mannix/deepseek-coder-v2-lite-instruct:latest",
    provider: "ollama",
    displayName: "DeepSeek Coder V2 Lite",
    description: "Efficient instruction-tuned coding model, balanced speed and quality.",
    isDefault: false,
    strengths: ["code", "speed"],
    subjectFocus: null
  },
  // 9. Devstral 24B: Mistral's Coding Powerhouse
  {
    modelId: "devstral:24b",
    provider: "ollama",
    displayName: "Devstral 24B (Code Expert)",
    description: "Mistral's specialized coding model. Excellent for architecture, debugging, and code review.",
    isDefault: false,
    strengths: ["code", "technical", "reasoning"],
    subjectFocus: null
  },
  // 10. Llama 4 16x17B: MoE Architecture
  {
    modelId: "llama4:16x17b",
    provider: "ollama",
    displayName: "Llama 4 (16x17B MoE)",
    description: "Next-gen Mixture of Experts model. Great all-rounder for complex multi-domain tasks.",
    isDefault: false,
    strengths: ["reasoning", "technical", "general", "chat"],
    subjectFocus: null
  },
  // 11. Llama 4 Scout: Efficient Next-Gen
  {
    modelId: "llama4:scout",
    provider: "ollama",
    displayName: "Llama 4 Scout",
    description: "Efficient next-gen model for fast general purpose tasks.",
    isDefault: false,
    strengths: ["chat", "general", "speed"],
    subjectFocus: null
  },
  // 12. Llama 3.2: Ultra-Fast Chat
  {
    modelId: "llama3.2:latest",
    provider: "ollama",
    displayName: "Llama 3.2 (Speed)",
    description: "Ultra-fast lightweight model for rapid conversational responses and classification.",
    isDefault: false,
    strengths: ["chat", "speed", "summarization"],
    subjectFocus: null
  },
  // 13. Qwen 2.5 VL 32B: Vision-Language
  {
    modelId: "qwen2.5vl:32b",
    provider: "ollama",
    displayName: "Qwen 2.5 VL 32B (Vision)",
    description: "Advanced Vision-Language model for image analysis and visual reasoning.",
    isDefault: false,
    strengths: ["vision", "reasoning", "multimodal"],
    subjectFocus: null
  },
  // 14. Llava: Vision Specialist
  {
    modelId: "llava:latest",
    provider: "ollama",
    displayName: "Llava (Vision)",
    description: "Vision-capable model for analyzing images and visual data.",
    isDefault: false,
    strengths: ["vision", "multimodal"],
    subjectFocus: null
  },

  // ===================================================================
  // === GROQ MODELS (SECONDARY — Cloud fallback, fast inference)
  // ===================================================================
  {
    modelId: "llama-3.3-70b-versatile",
    provider: "groq",
    displayName: "Groq Llama 3.3 70B",
    description: "High-speed cloud model from Groq. Great fallback for all task types.",
    isDefault: true,
    strengths: ["reasoning", "technical", "code", "chat"],
    subjectFocus: null
  },
  {
    modelId: "llama-3.1-8b-instant",
    provider: "groq",
    displayName: "Groq Llama 3.1 8B",
    description: "Ultra-fast model for classification and high-concurrency lightweight tasks.",
    isDefault: false,
    strengths: ["chat", "summarization", "speed"],
    subjectFocus: null
  },
  {
    modelId: "deepseek-r1-distill-llama-70b",
    provider: "groq",
    displayName: "DeepSeek R1 (70B Distill)",
    description: "Groq-hosted DeepSeek reasoning model for complex analysis.",
    isDefault: false,
    strengths: ["reasoning", "technical"],
    subjectFocus: null
  },

  // ===================================================================
  // === GEMINI MODELS (TERTIARY — Last resort / large context needs)
  // ===================================================================
  {
    modelId: "gemini-2.0-flash",
    provider: "gemini",
    displayName: "Gemini 2.0 Flash",
    description: "Google's fast multimodal model. Used as last-resort fallback or for very large contexts.",
    isDefault: true,
    strengths: ["chat", "creative", "summarization", "reasoning", "multimodal"],
    subjectFocus: null
  },
  {
    modelId: "gemini-2.0-pro-exp-02-05",
    provider: "gemini",
    displayName: "Gemini 2.0 Pro (Experimental)",
    description: "Most powerful Gemini model for complex coding and deep reasoning.",
    isDefault: false,
    strengths: ["code", "technical", "reasoning"],
    subjectFocus: null
  },
  {
    modelId: "gemini-1.5-pro-latest",
    provider: "gemini",
    displayName: "Gemini 1.5 Pro (Stable)",
    description: "Stable high-capacity model with massive context window.",
    isDefault: false,
    strengths: ["code", "technical", "large_context"],
    subjectFocus: null
  }
];

const seedLLMConfigurations = async () => {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI not found in .env file. Aborting.');
    process.exit(1);
  }

  try {
    console.log('Attempting to connect to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('MongoDB connected successfully.');

    const existingConfigs = await LLMConfiguration.find().select('modelId').lean();
    const existingModelIds = new Set(existingConfigs.map(config => config.modelId));

    const modelsToInsert = llmSeedData.filter(seed => !existingModelIds.has(seed.modelId));
    const modelsToUpdate = llmSeedData.filter(seed => existingModelIds.has(seed.modelId));

    if (modelsToUpdate.length > 0) {
      console.log(`Found ${modelsToUpdate.length} existing LLM configurations to check for updates.`);
      for (const modelData of modelsToUpdate) {
        await LLMConfiguration.updateOne({ modelId: modelData.modelId }, { $set: modelData });
        console.log(`- Updated ${modelData.displayName} (${modelData.modelId})`);
      }
    }

    if (modelsToInsert.length === 0) {
      console.log('No new LLM configurations to add.');
    } else {
      console.log(`Found ${modelsToInsert.length} new LLM configurations to add.`);
      const inserted = await LLMConfiguration.insertMany(modelsToInsert);
      console.log('Successfully seeded the following new models:');
      inserted.forEach(doc => console.log(`- ${doc.displayName} (${doc.modelId})`));
    }

    // Set defaults: Ensure only one default per provider
    const providers = ['gemini', 'ollama', 'groq'];
    for (const provider of providers) {
        const defaultForProvider = llmSeedData.find(m => m.provider === provider && m.isDefault);
        if (defaultForProvider) {
            await LLMConfiguration.updateMany(
                { provider, modelId: { $ne: defaultForProvider.modelId } },
                { $set: { isDefault: false } }
            );
            await LLMConfiguration.updateOne(
                { modelId: defaultForProvider.modelId },
                { $set: { isDefault: true } }
            );
        }
    }

  } catch (error) {
    console.error('An error occurred during the seeding process:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\nMongoDB connection closed. Seeder finished.');
  }
};

seedLLMConfigurations();