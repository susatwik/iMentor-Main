// server/services/llmStreamingService.js
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Groq = require('groq-sdk');
const axios = require('axios');
const log = require('../utils/logger');
const sglangService = require('./sglangService');
const sglangCaps    = require('./sglangCapabilities');
const SGLANG_ENABLED = process.env.SGLANG_ENABLED === 'true';

/**
 * Unified streaming service for ALL LLM providers.
 * Supports: gemini, groq, ollama, sglang
 * 
 * @param {Object} params
 * @param {Array} params.messages - Array of { role, content } messages
 * @param {String} params.provider - 'gemini', 'groq', 'ollama', 'sglang'
 * @param {String} params.model - Model ID
 * @param {String} params.apiKey - Provider API key
 * @param {String} params.systemPrompt - Optional system instruction
 * @param {Function} params.onToken - Callback for each token/chunk
 * @param {Object} params.options - Additional options (temperature, maxTokens, ollamaUrl, etc.)
 */
async function streamCompletion({
    messages,
    provider,
    model,
    apiKey,
    systemPrompt,
    onToken,
    options = {}
}) {
    if (!onToken || typeof onToken !== 'function') {
        throw new Error('onToken callback is required for streaming');
    }

    // Wrap onToken to handle thinking tags if requested
    let finalOnToken = onToken;
    let isThinking = false;
    let buffer = '';

    if (options.handleThinkingTags) {
        finalOnToken = (token) => {
            buffer += token;

            // Handle start tag
            if (!isThinking && buffer.includes('<thinking>')) {
                isThinking = true;
                const parts = buffer.split('<thinking>');
                if (parts[0]) onToken({ type: 'token', content: parts[0] });
                buffer = parts[1] || '';
            }

            // Handle end tag
            if (isThinking && buffer.includes('</thinking>')) {
                isThinking = false;
                const parts = buffer.split('</thinking>');
                if (parts[0]) onToken({ type: 'thought', content: parts[0] });
                buffer = parts[1] || '';
            }

            // Stream current mode content
            if (isThinking) {
                // Buffer to avoid splitting tags
                if (buffer.length > 0 && !buffer.includes('<') && !buffer.includes('/')) {
                    onToken({ type: 'thought', content: buffer });
                    buffer = '';
                }
            } else {
                if (buffer.length > 0 && !buffer.includes('<')) {
                    onToken({ type: 'token', content: buffer });
                    buffer = '';
                }
            }
        };
    }

    try {
        let result;
        if (provider === 'gemini') {
            result = await streamGemini({ messages, model, apiKey, systemPrompt, onToken: finalOnToken, options });
        } else if (provider === 'groq') {
            result = await streamGroq({ messages, model, apiKey, systemPrompt, onToken: finalOnToken, options });
        } else if (provider === 'ollama') {
            result = await streamOllama({ messages, model, systemPrompt, onToken: finalOnToken, options });
        } else if (provider === 'sglang') {
            if (!SGLANG_ENABLED) {
                log.warn('AI', 'SGLang requested but SGLANG_ENABLED=false — routing to Groq');
                result = await streamGroq({ messages, model: model || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', apiKey: process.env.GROQ_API_KEY, systemPrompt, onToken: finalOnToken, options });
            } else {
                result = await streamSGLang({ messages, model, systemPrompt, onToken: finalOnToken, options });
            }
        } else {
            throw new Error(`Streaming not implemented for provider: ${provider}`);
        }

        // Flush remaining buffer if using thinking wrapper
        if (options.handleThinkingTags && buffer) {
            onToken({ type: isThinking ? 'thought' : 'token', content: buffer });
        }

        return result;
    } catch (error) {
        const status = error.status || error.response?.status || 500;
        log.warn('AI', `Stream error (${provider}): ${error.message?.split('\n')[0]}`);
        throw error;
    }
}

/**
 * Gemini Streaming Implementation
 */
async function streamGemini({ messages, model, apiKey, systemPrompt, onToken, options }) {
    const genAI = new GoogleGenerativeAI(apiKey);

    // Format model name
    let modelName = model || process.env.GEMINI_MODEL || 'gemini-2.0-flash';
    if (modelName && !modelName.startsWith('models/')) {
        modelName = `models/${modelName}`;
    }

    const generativeModel = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
    });

    // Format history: Gemini expects { role: 'user'|'model', parts: [{ text: '...' }] }
    // We assume the last message is the current query, and the rest is history
    const history = messages.slice(0, -1).map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
    }));

    const currentQuery = messages[messages.length - 1].content;

    const chat = generativeModel.startChat({
        history: history,
        generationConfig: {
            temperature: options.temperature || 0.7,
            maxOutputTokens: options.maxOutputTokens || 4096,
        },
    });

    const result = await chat.sendMessageStream(currentQuery);

    let fullText = '';
    // log.info('AI', `Starting Gemini stream...`);
    for await (const chunk of result.stream) {
        const chunkText = chunk.text();
        if (chunkText) {
            fullText += chunkText;
            if (options.handleThinkingTags) {
                onToken(chunkText);
            } else {
                onToken({ type: 'token', content: chunkText });
            }
        }
    }
    // log.success('AI', `Gemini stream complete (${fullText.length} chars)`);

    return fullText;
}

/**
 * Groq Streaming Implementation
 */
async function streamGroq({ messages, model, apiKey, systemPrompt, onToken, options }) {
    const groq = new Groq({ apiKey, baseUrl: process.env.GROQ_API_BASE_URL || 'https://api.groq.com/openai/v1' });

    const formattedMessages = [];
    if (systemPrompt) {
        formattedMessages.push({ role: 'system', content: systemPrompt });
    }

    messages.forEach(msg => {
        formattedMessages.push({
            role: msg.role === 'model' ? 'assistant' : msg.role,
            content: msg.content
        });
    });

    const stream = await groq.chat.completions.create({
        messages: formattedMessages,
        model: model || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        temperature: options.temperature || 0.7,
        max_tokens: options.maxOutputTokens || 4096,
        stream: true,
    });

    let fullText = '';
    // log.info('AI', `Starting Groq stream...`);
    for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || "";
        if (content) {
            fullText += content;
            if (options.handleThinkingTags) {
                onToken(content);
            } else {
                onToken({ type: 'token', content: content });
            }
        }
    }
    // log.success('AI', `Groq stream complete (${fullText.length} chars)`);

    return fullText;
}

/**
 * Ollama Streaming Implementation (native /api/chat stream)
 */
async function streamOllama({ messages, model, systemPrompt, onToken, options }) {
    const ollamaUrl = (options.ollamaUrl || process.env.OLLAMA_API_BASE_URL || `http://localhost:${process.env.OLLAMA_PORT || 11434}`).trim();
    const modelToUse = model || process.env.OLLAMA_DEFAULT_MODEL || 'qwen3.5:9b';
    const endpoint = `${ollamaUrl}/api/chat`;

    const ollamaMessages = [];
    if (systemPrompt) {
        ollamaMessages.push({ role: 'system', content: systemPrompt });
    }
    messages.forEach(msg => {
        ollamaMessages.push({
            role: msg.role === 'model' ? 'assistant' : (msg.role || 'user'),
            content: msg.content || ''
        });
    });

    const requestPayload = {
        model: modelToUse,
        messages: ollamaMessages,
        stream: true,
        keep_alive: -1,
        options: { temperature: options.temperature || 0.7 },
    };

    // Enable native thinking for Qwen3 / QwQ / DeepSeek-R1 / Gemma3
    if (options.think === true || /qwen3|qwq|deepseek.*r1|gemma3|gemma-3/i.test(modelToUse)) {
        requestPayload.think = true;
    }

    const response = await axios.post(endpoint, requestPayload, {
        responseType: 'stream',
        timeout: 300000,
    });

    let fullText = '';
    let buffer = '';

    return new Promise((resolve, reject) => {
        response.data.on('data', chunk => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const json = JSON.parse(line);
                    // Handle thinking content from thinking models
                    if (json.message?.thinking) {
                        onToken({ type: 'thought', content: json.message.thinking });
                    }
                    if (json.message?.content) {
                        const token = json.message.content;
                        fullText += token;
                        if (options.handleThinkingTags) {
                            onToken(token);
                        } else {
                            onToken({ type: 'token', content: token });
                        }
                    }
                } catch { /* skip unparseable fragments */ }
            }
        });
        response.data.on('end', () => {
            if (buffer.trim()) {
                try {
                    const json = JSON.parse(buffer);
                    if (json.message?.content) {
                        fullText += json.message.content;
                        onToken({ type: 'token', content: json.message.content });
                    }
                } catch { /* ignore */ }
            }
            resolve(fullText.trim());
        });
        response.data.on('error', reject);
    });
}

/**
 * SGLang Streaming Implementation
 */
async function streamSGLang({ messages, model, systemPrompt, onToken, options }) {
    // Convert messages to chat history format
    const chatHistory = messages.slice(0, -1).map(msg => ({
        role: msg.role === 'model' ? 'assistant' : msg.role,
        content: msg.content
    }));
    const userQuery = messages[messages.length - 1].content;

    // Estimate input tokens (rough approximation: 1 token ≈ 3.5 chars for Qwen)
    const historyText = chatHistory.map(m => m.content).join(' ');
    const estimatedInputTokens = Math.ceil((historyText.length + userQuery.length + (systemPrompt?.length || 0)) / 3.5);
    
    // Read actual context window from the running SGLang server (cached)
    const modelMaxContext = sglangCaps.getModelMaxContext();
    const safetyBuffer = 256;
    const availableForCompletion = Math.max(512, modelMaxContext - estimatedInputTokens - safetyBuffer);
    const maxTokens = Math.min(options.maxTokens || 4096, availableForCompletion);
    
    log.info('AI', `[SGLang] Token budget: input≈${estimatedInputTokens} + completion=${maxTokens} ≈ ${estimatedInputTokens + maxTokens} / ${modelMaxContext}`);

    const result = await sglangService.streamChat(
        chatHistory,
        userQuery,
        systemPrompt,
        {
            model: model,
            maxTokens: maxTokens,
            temperature: options.temperature || 0.7,
            endpoint: options.endpoint || 'chat'
        },
        onToken
    );

    return result.finalAnswer;
}

module.exports = {
    streamCompletion
};
