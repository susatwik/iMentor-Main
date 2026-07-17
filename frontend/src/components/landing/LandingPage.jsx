// frontend/src/components/landing/LandingPage.jsx
// Clean chat-style landing page for unauthenticated users.
// Shows a simple chat interface with send + mic buttons only.
// Supports real AI chat via /api/guest/chat with SSE streaming.
// Advanced options (RAG, Tutor, Deep Research, KG) disabled until sign-in.
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ArrowUp, Mic, Server, Loader2 } from 'lucide-react';
import { renderMarkdown } from '../../utils/markdownUtils';
import toast from 'react-hot-toast';

// ─── Minimal top nav ──────────────────────────────────────
function LandingNav({ onLoginClick }) {
    return (
        <nav className="fixed top-0 left-0 right-0 z-50 h-12 flex items-center justify-between px-4 sm:px-6 bg-black/90 backdrop-blur-md border-b border-white/10">
            {/* Brand */}
            <div className="flex items-center gap-2 text-white">
                <Server size={20} className="text-teal-400" />
                <span className="text-base font-bold tracking-tight">iMentor</span>
            </div>

            {/* Auth buttons */}
            <div className="flex items-center gap-2">
                <button
                    onClick={() => onLoginClick(true)}
                    className="px-4 py-1.5 text-sm font-semibold text-white border border-white/20 rounded-lg hover:bg-white/10 transition-colors"
                >
                    Sign In
                </button>
                <button
                    onClick={() => onLoginClick(false)}
                    className="px-4 py-1.5 text-sm font-semibold text-black bg-white rounded-lg hover:bg-gray-200 transition-colors"
                >
                    Sign Up
                </button>
            </div>
        </nav>
    );
}

// ─── Single chat bubble ───────────────────────────────────
function ChatBubble({ role, text }) {
    const isUser = role === 'user';
    const isEmpty = !text || text.trim() === '';
    return (
        <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} w-full`}>
            <div
                className={`max-w-[75%] md:max-w-[60%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                    isUser
                        ? 'bg-white text-black rounded-br-md'
                        : 'bg-[#1a1a1a] border border-white/10 text-gray-200 rounded-bl-md'
                }`}
            >
                {isEmpty ? (
                    <span className="flex items-center gap-2 text-gray-400">
                        <Loader2 size={14} className="animate-spin" />
                        Thinking...
                    </span>
                ) : isUser ? (
                    <span style={{ whiteSpace: 'pre-wrap' }}>{text}</span>
                ) : (
                    <div
                        className="prose prose-invert prose-sm max-w-none"
                        dangerouslySetInnerHTML={renderMarkdown(text)}
                    />
                )}
            </div>
        </div>
    );
}

// ─── Landing page component ───────────────────────────────
function LandingPage({ onLoginClick }) {
    const [inputValue, setInputValue] = useState('');
    const [messages, setMessages] = useState(() => {
        try {
            const stored = sessionStorage.getItem('guest_messages');
            const parsed = stored ? JSON.parse(stored) : [];
            if (!Array.isArray(parsed)) return [];
            return parsed
                .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim() !== '')
                .map(m => ({ role: m.role, text: m.text }));
        } catch (e) {
            return [];
        }
    });
    const [showAuthHint, setShowAuthHint] = useState(false);
    const [isStreaming, setIsStreaming] = useState(false);
    const [guestMessageCount, setGuestMessageCount] = useState(() => {
        try {
            const stored = sessionStorage.getItem('guest_message_count');
            const parsed = stored ? Number.parseInt(stored, 10) : 0;
            return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
        } catch (e) {
            return 0;
        }
    });
    const textareaRef = useRef(null);
    const chatEndRef  = useRef(null);
    const abortRef    = useRef(null);

    // Auto-resize textarea
    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 140)}px`;
        }
    }, [inputValue]);

    // Scroll to bottom when messages change
    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Sync messages and count to sessionStorage (RAM-only persistence)
    useEffect(() => {
        if (isStreaming) return;
        try {
            sessionStorage.setItem('guest_messages', JSON.stringify(messages));
        } catch (e) {
            console.error('Failed to sync guest messages', e);
        }
    }, [messages, isStreaming]);

    useEffect(() => {
        try {
            sessionStorage.setItem('guest_message_count', guestMessageCount.toString());
        } catch (e) {
            console.error('Failed to sync guest message count', e);
        }
        if (guestMessageCount >= 2) {
            setShowAuthHint(true);
        }
    }, [guestMessageCount]);

    const handleSend = useCallback(async () => {
        if (!inputValue.trim() || isStreaming || guestMessageCount >= 3) return;

        const userQuery = inputValue.trim();
        const userMsg = { role: 'user', text: userQuery };
        setMessages(prev => [...prev, userMsg]);
        setInputValue('');
        setIsStreaming(true);

        const newCount = guestMessageCount + 1;
        setGuestMessageCount(newCount);

        // Add a placeholder bot message for streaming
        const botIdx = Date.now();
        setMessages(prev => [...prev, { role: 'assistant', text: '', _streamId: botIdx }]);

        // Abort any previous request
        if (abortRef.current) abortRef.current.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        try {
            const apiBase = import.meta.env.VITE_API_BASE_URL || '/api';
            const res = await fetch(`${apiBase}/guest/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: userQuery }),
                signal: controller.signal,
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error || `Server error: ${res.status}`);
            }

            // Parse SSE stream
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let finalText = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                let idx;
                while ((idx = buffer.indexOf('\n\n')) !== -1) {
                    const chunk = buffer.slice(0, idx).trim();
                    buffer = buffer.slice(idx + 2);
                    if (!chunk.startsWith('data: ')) continue;

                    try {
                        const event = JSON.parse(chunk.slice(6));
                        if (event.type === 'token' && event.content) {
                            // Streaming token — append to the bot message
                            finalText += event.content;
                            const currentText = finalText;
                            setMessages(prev =>
                                prev.map(m => m._streamId === botIdx ? { ...m, text: currentText } : m)
                            );
                        } else if (event.type === 'final_answer' && event.content) {
                            // Final answer — replace bot message with full text
                            const fullText = event.content.text || finalText;
                            setMessages(prev =>
                                prev.map(m => m._streamId === botIdx ? { ...m, text: fullText, _streamId: undefined } : m)
                            );
                            finalText = fullText;
                        }
                    } catch (_) { /* skip malformed */ }
                }
            }

            // If we somehow got no text, use what we accumulated
            if (!finalText) {
                setMessages(prev =>
                    prev.map(m => m._streamId === botIdx
                        ? { ...m, text: "I couldn't generate a response. Please try again!", _streamId: undefined }
                        : m
                    )
                );
            }

        } catch (err) {
            if (err.name === 'AbortError') return;
            console.error('Guest chat error:', err);
            setMessages(prev =>
                prev.map(m => m._streamId === botIdx
                    ? { ...m, text: err.message || 'Something went wrong. Please try again!', _streamId: undefined }
                    : m
                )
            );
        } finally {
            setIsStreaming(false);
        }
    }, [inputValue, isStreaming, guestMessageCount]);

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !isStreaming && guestMessageCount < 3) {
            e.preventDefault();
            handleSend();
        }
    };

    return (
        <div className="flex flex-col h-screen bg-black text-white">
            <LandingNav onLoginClick={onLoginClick} />

            {/* Chat area */}
            <div className="flex-1 overflow-y-auto pt-16 pb-4 px-4 sm:px-8 md:px-16 lg:px-32">
                {messages.length === 0 ? (
                    /* Empty state */
                    <div className="flex flex-col items-center justify-center h-full gap-6 text-center select-none">
                        <div className="flex items-center gap-3">
                            <Server size={36} className="text-teal-400" />
                            <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight">iMentor</h1>
                        </div>
                        <p className="text-gray-400 text-base sm:text-lg max-w-md">
                            Your AI Mentor for limitless learning. Ask anything — sign in to unlock the full experience.
                        </p>
                        <div className="flex flex-wrap justify-center gap-3 mt-4">
                            {['Explain neural networks', 'Help me study calculus', 'What is Big-O notation?'].map((q) => (
                                <button
                                    key={q}
                                    onClick={() => { setInputValue(q); textareaRef.current?.focus(); }}
                                    className="px-4 py-2 text-sm bg-[#111] border border-white/10 rounded-xl text-gray-300 hover:bg-[#1a1a1a] hover:text-white transition-colors"
                                >
                                    {q}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : (
                    /* Message list */
                    <div className="flex flex-col gap-4 max-w-3xl mx-auto py-8">
                        {messages.map((msg, i) => (
                            <ChatBubble key={i} role={msg.role} text={msg.text} />
                        ))}

                        {/* Gentle sign-in suggestion after a few messages */}
                        {showAuthHint && (
                            <div className="flex flex-col items-center gap-2 mt-4 p-3 rounded-xl bg-teal-500/10 border border-teal-500/20">
                                <p className="text-xs text-teal-300/80">
                                    {guestMessageCount >= 3 
                                        ? "You have reached the limit of 3 free guest messages. Sign in to save this chat history and continue." 
                                        : "Sign in to unlock Tutor Mode, course materials, history saving, and more."
                                    }
                                </p>
                                <div className="flex gap-3">
                                    <button
                                        onClick={() => onLoginClick(true)}
                                        className="px-4 py-1.5 text-xs font-semibold text-black bg-white rounded-lg hover:bg-gray-200 transition-colors"
                                    >
                                        Sign In
                                    </button>
                                    <button
                                        onClick={() => onLoginClick(false)}
                                        className="px-4 py-1.5 text-xs font-semibold text-white border border-white/20 rounded-lg hover:bg-white/10 transition-colors"
                                    >
                                        Create Account
                                    </button>
                                </div>
                            </div>
                        )}
                        <div ref={chatEndRef} />
                    </div>
                )}
            </div>

            {/* Input bar */}
            <div className="flex-shrink-0 px-4 sm:px-8 md:px-16 lg:px-32 pb-4 pt-2">
                <div className="max-w-3xl mx-auto">
                    <div className="flex items-end gap-2 bg-[#111] border border-white/10 rounded-2xl px-4 py-2 focus-within:border-white/25 transition-colors">
                        <textarea
                            ref={textareaRef}
                            value={inputValue}
                            onChange={(e) => setInputValue(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={guestMessageCount >= 3 ? "Message limit reached. Please sign in to continue." : "Ask iMentor anything about your studies..."}
                            disabled={guestMessageCount >= 3}
                            rows={1}
                            className="flex-1 bg-transparent text-white text-base leading-relaxed resize-none min-h-[28px] max-h-36 py-1.5 border-none outline-none placeholder:text-gray-500 disabled:opacity-50 disabled:cursor-not-allowed"
                        />

                        {/* Mic — available after sign-in */}
                        <button
                            onClick={() => toast('Sign in to use voice input', { icon: '🎙️' })}
                            className="flex-shrink-0 p-2 rounded-lg text-gray-600 hover:text-gray-400 transition-colors"
                            title="Voice input — sign in to use"
                            aria-label="Voice input requires sign-in"
                        >
                            <Mic size={18} />
                        </button>

                        {/* Send button */}
                        <button
                            onClick={handleSend}
                            disabled={!inputValue.trim() || isStreaming || guestMessageCount >= 3}
                            className={`flex-shrink-0 p-2 rounded-lg transition-colors ${
                                inputValue.trim() && !isStreaming && guestMessageCount < 3
                                    ? 'bg-white text-black hover:bg-gray-200'
                                    : 'bg-white/10 text-gray-600 cursor-not-allowed'
                            }`}
                            title="Send message"
                            aria-label="Send message"
                        >
                            {isStreaming ? <Loader2 size={18} className="animate-spin" /> : <ArrowUp size={18} />}
                        </button>
                    </div>

                    <p className="text-center text-[11px] text-gray-600 mt-2">
                        {guestMessageCount >= 3 
                            ? "You have reached your guest message limit. Please sign in or create an account to continue." 
                            : `Guest Mode — ${guestMessageCount}/3 messages sent. Sign in to unlock unlimited chat and save history.`
                        }
                    </p>
                </div>
            </div>
        </div>
    );
}

export default LandingPage;
