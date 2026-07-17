// server/routes/guestChat.js
// Lightweight chat endpoint for unauthenticated (landing page) users.
// ─── No auth, no history persistence, no gamification, no tutor, no RAG ───
// Just a direct LLM call with SSE streaming for general Q&A.
const express = require('express');
const rateLimit = require('express-rate-limit');
const log = require('../utils/logger');

const router = express.Router();

// ── Strict rate limit: 10 messages per minute per IP ──────────────────────
const guestLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests. Please sign in for unlimited access.' },
    validate: false,
});

// ── System prompt for guest mode ──────────────────────────────────────────
const GUEST_SYSTEM_PROMPT = `You are iMentor, a friendly and knowledgeable AI learning assistant.
You help students understand academic concepts across all subjects.
Keep responses clear, concise, and educational.
If the question is non-academic, politely redirect toward learning topics.
Do NOT mention that the user is a guest or unauthenticated.
Use markdown formatting where helpful (bold, lists, code blocks).`;

// ── POST /api/guest/chat ──────────────────────────────────────────────────
router.post('/chat', guestLimiter, async (req, res) => {
    const { query } = req.body;

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
        return res.status(400).json({ error: 'Query is required.' });
    }

    const trimmedQuery = query.trim();
    if (trimmedQuery.length > 1000) {
        return res.status(400).json({ error: 'Query too long. Please keep it under 1000 characters.' });
    }

    log.info('GUEST', `Guest query: "${trimmedQuery.substring(0, 60)}..."`);

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const streamEvent = (data) => {
        if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
    };

    try {
        // ── Try SGLang first (primary), then Gemini as fallback ───────────
        let responseText = '';
        const sglangEnabled = process.env.SGLANG_ENABLED === 'true';

        if (sglangEnabled) {
            try {
                const sglangService = require('../services/sglangService');
                const cb = require('../utils/circuitBreaker'); // [Team4]
                if (cb.isOpen('sglang')) {
                    log.warn('GUEST', 'SGLang circuit open — skipping to Gemini');
                } else {
                    streamEvent({ type: 'status_update', content: 'Thinking...' });
                    try {
                        const result = await sglangService.streamChat(
                            [],              // no history
                            trimmedQuery,
                            GUEST_SYSTEM_PROMPT,
                            { endpoint: 'chat', maxTokens: 2048, temperature: 0.7 },
                            (evt) => streamEvent(evt) // stream tokens as they arrive
                        );
                        responseText = result.finalAnswer || '';
                        cb.onSuccess('sglang');
                    } catch (sglangErr) {
                        cb.onFailure('sglang');
                        throw sglangErr;
                    }
                }
            } catch (sglangErr) {
                log.warn('GUEST', `SGLang failed: ${sglangErr.message} — trying Gemini`);
                responseText = ''; // reset to trigger Gemini fallback
            }
        }

        // ── Gemini fallback (non-streaming) ──────────────────────────────
        if (!responseText) {
            try {
                const geminiService = require('../services/geminiService');
                streamEvent({ type: 'status_update', content: 'Thinking...' });

                responseText = await geminiService.generateContentWithHistory(
                    [],
                    trimmedQuery,
                    GUEST_SYSTEM_PROMPT,
                    { maxOutputTokens: 2048, temperature: 0.7 }
                );
            } catch (geminiErr) {
                log.warn('GUEST', `Gemini fallback failed: ${geminiErr.message}`);
                responseText = "";
            }
        }

        // ── Groq fallback (non-streaming) ────────────────────────────────
        if (!responseText && process.env.GROQ_API_KEY && !process.env.GROQ_API_KEY.startsWith('your_')) {
            try {
                const groqService = require('../services/groqService');
                streamEvent({ type: 'status_update', content: 'Thinking...' });

                responseText = await groqService.generateContentWithHistory(
                    [],
                    trimmedQuery,
                    GUEST_SYSTEM_PROMPT,
                    { maxOutputTokens: 2048, temperature: 0.7 }
                );
            } catch (groqErr) {
                log.warn('GUEST', `Groq fallback failed: ${groqErr.message}`);
                responseText = "";
            }
        }

        // ── Final fallback message if all failed ──────────────────────────
        if (!responseText) {
            responseText = "I'm having trouble connecting right now. Please try again in a moment, or sign in for the full experience!";
        }


        // ── Send final answer ─────────────────────────────────────────────
        streamEvent({
            type: 'final_answer',
            content: {
                sender: 'bot',
                role: 'model',
                text: responseText,
                parts: [{ text: responseText }],
                timestamp: new Date(),
                source_pipeline: 'guest_chat',
                isGuest: true,
            }
        });

    } catch (err) {
        log.error('GUEST', `Guest chat error: ${err.message}`);
        streamEvent({
            type: 'final_answer',
            content: {
                sender: 'bot',
                role: 'model',
                text: "Sorry, something went wrong. Please try again or sign in for the full experience!",
                parts: [{ text: "Sorry, something went wrong. Please try again or sign in for the full experience!" }],
                timestamp: new Date(),
                source_pipeline: 'guest_chat_error',
                isGuest: true,
            }
        });
    } finally {
        if (!res.writableEnded) {
            res.end();
        }
    }
});

module.exports = router;
