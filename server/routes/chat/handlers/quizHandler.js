// server/routes/chat/handlers/quizHandler.js
// Handles the quiz fast-path when a system prompt marks a request as quiz evaluation.
const ChatHistory = require('../../../models/ChatHistory');
const groqService = require('../../../services/groqService');
const geminiService = require('../../../services/geminiService');
const log = require('../../../utils/logger');
const { streamEvent } = require('../helpers');

/**
 * @param {object} res  - Express response (SSE stream, headers not yet set)
 * @param {object} ctx  - Request context built by index.js
 */
async function handle(res, ctx) {
    const { query, sessionId, userId, clientProvidedSystemInstruction, userMessageForDb } = ctx;

    log.info('CHAT', 'Quiz fast-path triggered');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    streamEvent(res, { type: 'status_update', content: 'Evaluating...' });

    try {
        let evalText = null;
        const groqKey = process.env.GROQ_API_KEY;
        const geminiKey = process.env.GEMINI_API_KEY;

        if (groqKey) {
            try {
                evalText = await groqService.generateContentWithHistory(
                    [], query.trim(), clientProvidedSystemInstruction,
                    { model: 'llama-3.1-8b-instant', apiKey: groqKey, maxOutputTokens: 300, temperature: 0.4 }
                );
            } catch (e) {
                log.warn('CHAT', `Quiz evaluation fallback: ${e.message}`);
            }
        }

        if (!evalText && geminiKey) {
            evalText = await geminiService.generateContentWithHistory(
                [], query.trim(), clientProvidedSystemInstruction,
                { geminiModel: 'gemini-2.0-flash', apiKey: geminiKey, maxOutputTokens: 300 }
            );
        }
        if (!evalText) throw new Error('No LLM available');

        const reply = {
            sender: 'bot', role: 'model',
            text: evalText, parts: [{ text: evalText }],
            timestamp: new Date(), source_pipeline: 'quiz-evaluator', confidenceScore: 95
        };

        // Save to DB async (don't await — don't block response)
        ChatHistory.findOneAndUpdate(
            { sessionId, userId },
            {
                $push: { messages: { $each: [userMessageForDb, { role: 'model', parts: [{ text: evalText }], timestamp: new Date(), source_pipeline: 'quiz-evaluator' }], $slice: -100 } },
                $set: { isTutorMode: true, tutorModeType: 'assistant', updatedAt: new Date() }
            },
            { upsert: true }
        ).catch(e => log.error('DB', `Quiz history save failed: ${e.message}`));

        streamEvent(res, { type: 'final_answer', content: reply });
        return res.end();
    } catch (err) {
        log.error('CHAT', `Quiz evaluation error: ${err.message}`);
        streamEvent(res, { type: 'error', content: 'Could not evaluate answer. Please try again.' });
        return res.end();
    }
}

module.exports = { handle };
