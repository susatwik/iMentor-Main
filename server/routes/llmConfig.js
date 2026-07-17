// server/routes/llmConfig.js
const express = require("express");
const router = express.Router();
const User = require("../models/User");
const { encrypt } = require("../utils/crypto");
const log = require('../utils/logger');
const { auditLog } = require('../utils/logger');
const { validateProviderConnection, fetchAvailableModels } = require('../services/providerValidationService');

// @route   PUT /api/llm/config
// @desc    Update user's LLM preferences (provider, key, or URL)
// @access  Private
router.put("/config", async (req, res) => {
  // 1. Destructure all possible fields.
  const { llmProvider, apiKey, ollamaUrl, ollamaModel, selectedModelId, modelRoutingMode, autoModelRouting } = req.body;
  const userId = req.user._id;

  try {
    // 2. Start with a blank object. We will only update what is sent.
    const updates = {};

    if (llmProvider) {
      // Normalize frontend alias
      const normalizedProvider = llmProvider === 'local_llm' ? 'local_llm' : llmProvider;
      if (!["local_llm", "gemini", "ollama", "groq"].includes(normalizedProvider)) {
        log.warn('AI', `Invalid LLM provider: ${llmProvider}`);
        return res
          .status(400)
          .json({ message: `Invalid LLM provider specified: "${llmProvider}".` });
      }
      updates.preferredLlmProvider = normalizedProvider;
    }

    const resolvedRoutingMode = typeof autoModelRouting === 'boolean'
      ? (autoModelRouting ? 'auto' : 'manual')
      : modelRoutingMode;
    if (resolvedRoutingMode) {
      if (!['auto', 'manual'].includes(resolvedRoutingMode)) {
        return res.status(400).json({ message: 'Invalid model routing mode. Use auto or manual.' });
      }
      updates.modelRoutingMode = resolvedRoutingMode;
    }

    if (typeof selectedModelId === 'string') {
      updates.selectedModelId = selectedModelId.trim();
    }

    // If a new API key is provided, encrypt and add it to updates.
    if (apiKey) {
      updates.encryptedApiKey = encrypt(apiKey);
    }

    // If a new Ollama URL is provided, add it to updates.
    if (typeof ollamaUrl === "string") {
      updates.ollamaUrl = ollamaUrl.trim().replace(/\/+$/, "");
    }


    // If a new Ollama model is provided, add it to updates.
    if (ollamaModel) {
      updates.ollamaModel = ollamaModel;
    }

    // 3. If the updates object is empty, nothing was sent to change.
    if (Object.keys(updates).length === 0) {
      return res
        .status(400)
        .json({ message: "No valid update information provided." });
    }

    // If credentials are being changed, validate the connection BEFORE saving.
    // local_llm is server-side — skip external validation entirely.
    const credentialChange = llmProvider !== 'local_llm' && (apiKey || (llmProvider === 'ollama' && typeof ollamaUrl === 'string' && ollamaUrl.length > 0));
    if (credentialChange) {
      const effectiveProvider = llmProvider || 'gemini';
      try {
        const validationResult = await validateProviderConnection({
          provider: effectiveProvider,
          apiKey: apiKey || undefined,
          ollamaUrl: ollamaUrl || undefined,
        });
        if (!validationResult.ok) {
          log.warn('AI', `LLM config rejected — connection validation failed for ${effectiveProvider}: ${validationResult.message}`);
          return res.status(400).json({
            message: `Connection validation failed for ${effectiveProvider}: ${validationResult.message}`,
            provider: effectiveProvider,
          });
        }
      } catch (validationError) {
        log.warn('AI', `LLM config validation check threw: ${validationError.message}`);
        return res.status(400).json({
          message: `Could not verify connection to ${llmProvider || 'provider'}: ${validationError.message}`,
        });
      }
    }

    // 5. Use $set to only modify the fields present in the 'updates' object.
    // This will NEVER delete a field that isn't included in the request.
    await User.updateOne({ _id: userId }, { $set: updates });

    const logPayload = {
      llmProvider: llmProvider || undefined,
      apiKeyUpdated: !!apiKey,
      ollamaUrlUpdated: typeof ollamaUrl === 'string',
      ollamaModelUpdated: !!ollamaModel,
      modelRoutingModeUpdated: !!resolvedRoutingMode,
      selectedModelUpdated: typeof selectedModelId === 'string'
    };
    auditLog(req, 'USER_CONFIG_UPDATE_SUCCESS', logPayload);

    res.status(200).json({ message: "LLM preferences updated successfully." });
  } catch (error) {
    log.error('AI', `LLM config update failure: ${error.message}`);
    res.status(500).json({
      message: `Server error while updating LLM preferences: ${error.message}`,
    });
  }
});

// This GET route is correct and doesn't need changes, but it should also return ollamaUrl
router.get("/config", async (req, res) => {
  const userId = req.user._id;
  try {
    const user = await User.findById(userId).select(
      "preferredLlmProvider ollamaModel ollamaUrl modelRoutingMode selectedModelId"
    );
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }
    res.status(200).json({
      preferredLlmProvider: user.preferredLlmProvider,
      ollamaModel: user.ollamaModel,
      ollamaUrl: user.ollamaUrl, // Also return the URL
      modelRoutingMode: user.modelRoutingMode || 'manual',
      selectedModelId: user.selectedModelId || '',
    });
  } catch (error) {
    log.error('AI', `LLM config fetch failure: ${error.message}`);
    res.status(500).json({ message: "Server error fetching LLM preferences." });
  }
});

router.post('/validate-provider-connection', async (req, res) => {
  const { provider, apiKey, ollamaUrl } = req.body || {};
  if (!provider) {
    return res.status(400).json({ ok: false, message: 'provider is required.' });
  }

  try {
    const result = await validateProviderConnection({ provider, apiKey, ollamaUrl });
    return res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    return res.status(500).json({ ok: false, provider, models: [], message: error.message });
  }
});

router.get('/available-models', async (req, res) => {
  const provider = req.query.provider;
  const apiKey = req.query.apiKey;
  const ollamaUrl = req.query.ollamaUrl;

  if (!provider) {
    return res.status(400).json({ ok: false, message: 'provider query parameter is required.', models: [] });
  }

  try {
    const result = await fetchAvailableModels({ provider, apiKey, ollamaUrl });
    return res.status(200).json({ ok: true, provider, models: result.models || [], endpoint: result.endpoint || null });
  } catch (error) {
    return res.status(400).json({ ok: false, provider, models: [], message: error.message });
  }
});

module.exports = router;
