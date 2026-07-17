import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Send, Square, BookOpen, Brain, Target, ChevronDown, ChevronUp, Lightbulb, MessageCircle, RotateCcw } from 'lucide-react';
 
// ─── Anthropic API Call ──────────────────────────────────────────────────────
async function callClaude({ messages, system, signal }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system,
      messages,
    }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API error ${response.status}`);
  }
  const data = await response.json();
  return data.content?.map(b => b.text || '').join('') || '';
}
 
// ─── Socratic System Prompt ──────────────────────────────────────────────────
const SOCRATIC_SYSTEM = `You are an expert Socratic tutor. Your role is to guide students to discover knowledge themselves through thoughtful questioning — never give direct answers.
 
RULES:
1. NEVER directly answer a question. Instead, ask a guiding question that helps the student think.
2. Acknowledge what the student says positively and briefly before your question.
3. If the student is correct, celebrate briefly and ask a deeper follow-up question.
4. If the student is wrong, don't say "wrong" — ask a question that reveals the inconsistency.
5. Break complex topics into small, discoverable steps.
6. Use analogies and real-world examples as questions ("What happens when you...?").
7. Keep responses SHORT: 2–4 sentences max. One key question at the end.
 
After your Socratic response, append a JSON block (do not show it to the user visually, but include it) on a new line:
<SESSION_DATA>
{
  "topic": "<detected topic in 3 words>",
  "concept": "<the core concept being explored>",
  "studentLevel": "<beginner|intermediate|advanced>",
  "progress": <0-100 integer representing mastery progress>,
  "hint": "<a one-sentence hint if the student seems stuck, else empty string>",
  "nextGoal": "<what the student should figure out next>"
}
</SESSION_DATA>
 
Always include the SESSION_DATA block at the end of every response.`;
 
// ─── Parse session data from response ────────────────────────────────────────
function parseResponse(raw) {
  const sessionMatch = raw.match(/<SESSION_DATA>([\s\S]*?)<\/SESSION_DATA>/);
  const text = raw.replace(/<SESSION_DATA>[\s\S]*?<\/SESSION_DATA>/, '').trim();
  let sessionData = null;
  if (sessionMatch) {
    try { sessionData = JSON.parse(sessionMatch[1].trim()); } catch {}
  }
  return { text, sessionData };
}
 
// ─── Components ───────────────────────────────────────────────────────────────
 
function ProgressBar({ value }) {
  return (
    <div className="progress-bar-track">
      <div className="progress-bar-fill" style={{ width: `${value}%` }} />
    </div>
  );
}
 
function TutorSessionPanel({ session, messageCount }) {
  const [hintsOpen, setHintsOpen] = useState(true);
  if (!session) return (
    <div className="session-panel empty-panel">
      <div className="panel-icon">🎓</div>
      <p className="panel-empty-text">Your learning session will appear here as you interact with your tutor.</p>
    </div>
  );
 
  return (
    <div className="session-panel">
      <div className="session-header">
        <span className="session-label">Session</span>
        <span className={`level-badge level-${session.studentLevel}`}>{session.studentLevel}</span>
      </div>
 
      <div className="session-topic">
        <BookOpen size={14} />
        <span>{session.topic || 'Exploring…'}</span>
      </div>
 
      <div className="session-concept">
        <Brain size={14} />
        <span>{session.concept || '—'}</span>
      </div>
 
      <div className="progress-section">
        <div className="progress-header">
          <Target size={12} />
          <span>Mastery</span>
          <span className="progress-value">{session.progress ?? 0}%</span>
        </div>
        <ProgressBar value={session.progress ?? 0} />
      </div>
 
      {session.nextGoal && (
        <div className="next-goal">
          <div className="goal-label"><Lightbulb size={12} /> Next Goal</div>
          <p>{session.nextGoal}</p>
        </div>
      )}
 
      {session.hint && (
        <div className="hint-section">
          <button className="hint-toggle" onClick={() => setHintsOpen(o => !o)}>
            <MessageCircle size={12} /> Hint Available
            {hintsOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          {hintsOpen && <p className="hint-text">{session.hint}</p>}
        </div>
      )}
 
      <div className="stat-row">
        <div className="stat"><span className="stat-value">{messageCount}</span><span className="stat-label">Exchanges</span></div>
        <div className="stat"><span className="stat-value">{session.progress ?? 0}%</span><span className="stat-label">Progress</span></div>
      </div>
    </div>
  );
}
 
function ChatBubble({ msg }) {
  const isUser = msg.role === 'user';
  return (
    <div className={`bubble-row ${isUser ? 'bubble-row-user' : 'bubble-row-model'}`}>
      {!isUser && <div className="avatar avatar-tutor">🎓</div>}
      <div className={`bubble ${isUser ? 'bubble-user' : 'bubble-model'} ${msg.isLoading ? 'bubble-loading' : ''}`}>
        {msg.isLoading
          ? <span className="dots"><span /><span /><span /></span>
          : <span className="bubble-text">{msg.text}</span>
        }
      </div>
      {isUser && <div className="avatar avatar-user">You</div>}
    </div>
  );
}
 
// ─── Main Page ────────────────────────────────────────────────────────────────
export default function TutorPage() {
  const [messages, setMessages] = useState([]);           // { id, role, text, isLoading }
  const [apiHistory, setApiHistory] = useState([]);       // Anthropic messages format
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [session, setSession] = useState(null);
  const abortRef = useRef(null);
  const bottomRef = useRef(null);
  const textareaRef = useRef(null);
 
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);
 
  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }, [input]);
 
  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;
 
    const placeholderId = `a-${Date.now()}`;
    const newApiHistory = [...apiHistory, { role: 'user', content: text }];
 
    setMessages(prev => [
      ...prev,
      { id: `u-${Date.now()}`, role: 'user', text },
      { id: placeholderId, role: 'model', text: '', isLoading: true },
    ]);
    setInput('');
    setIsLoading(true);
 
    const controller = new AbortController();
    abortRef.current = controller;
 
    try {
      const raw = await callClaude({
        messages: newApiHistory,
        system: SOCRATIC_SYSTEM,
        signal: controller.signal,
      });
 
      const { text: replyText, sessionData } = parseResponse(raw);
 
      setApiHistory([...newApiHistory, { role: 'assistant', content: raw }]);
      if (sessionData) setSession(sessionData);
 
      setMessages(prev =>
        prev.map(m =>
          m.id === placeholderId
            ? { id: placeholderId, role: 'model', text: replyText }
            : m
        )
      );
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'CanceledError') {
        setMessages(prev => prev.filter(m => m.id !== placeholderId));
        return;
      }
      setMessages(prev =>
        prev.map(m =>
          m.id === placeholderId
            ? { id: placeholderId, role: 'model', text: `⚠️ ${err.message}` }
            : m
        )
      );
    } finally {
      setIsLoading(false);
      abortRef.current = null;
    }
  }, [input, isLoading, apiHistory]);
 
  const handleStop = () => {
    abortRef.current?.abort();
    setIsLoading(false);
  };
 
  const handleReset = () => {
    if (isLoading) abortRef.current?.abort();
    setMessages([]);
    setApiHistory([]);
    setSession(null);
    setInput('');
    setIsLoading(false);
  };
 
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };
 
  const userMessages = messages.filter(m => m.role === 'user').length;
 
  return (
    <>
      <style>{CSS}</style>
      <div className="tutor-root">
        {/* ── Left: Chat ── */}
        <div className="chat-col">
          {/* Header */}
          <div className="chat-header">
            <div className="header-left">
              <span className="logo">iMentor</span>
              <span className="logo-tag">Socratic Tutor</span>
            </div>
            <button className="reset-btn" onClick={handleReset} title="New session">
              <RotateCcw size={15} /> New Session
            </button>
          </div>
 
          {/* Messages */}
          <div className="messages-area">
            {messages.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">🎓</div>
                <h2 className="empty-title">Your Socratic Tutor</h2>
                <p className="empty-sub">Ask any question. I won't give you the answer — I'll help you discover it yourself.</p>
                <div className="starter-chips">
                  {['Explain photosynthesis', 'How does gravity work?', 'What is recursion?', 'Why is the sky blue?'].map(q => (
                    <button key={q} className="chip" onClick={() => { setInput(q); textareaRef.current?.focus(); }}>
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="messages-list">
                {messages.map(msg => <ChatBubble key={msg.id} msg={msg} />)}
                <div ref={bottomRef} />
              </div>
            )}
          </div>
 
          {/* Input */}
          <div className="input-area">
            <div className="input-box">
              <textarea
                ref={textareaRef}
                className="input-textarea"
                rows={1}
                placeholder="Ask your tutor anything…"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={isLoading}
              />
              {isLoading ? (
                <button className="send-btn stop-btn" onClick={handleStop} title="Stop">
                  <Square size={18} />
                </button>
              ) : (
                <button
                  className="send-btn"
                  onClick={handleSend}
                  disabled={!input.trim()}
                  title="Send"
                >
                  <Send size={18} />
                </button>
              )}
            </div>
            <p className="input-hint">Press Enter to send · Shift+Enter for new line</p>
          </div>
        </div>
 
        {/* ── Right: Session Panel ── */}
        <div className="panel-col">
          <TutorSessionPanel session={session} messageCount={userMessages} />
        </div>
      </div>
    </>
  );
}
 
// ─── Styles ───────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap');
 
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface2: #1c2333;
    --border: #30363d;
    --text: #e6edf3;
    --muted: #7d8590;
    --accent: #58a6ff;
    --accent2: #3fb950;
    --warn: #f0883e;
    --user-bubble: #1f6feb;
    --tutor-bubble: #1c2333;
    --radius: 14px;
    --panel-width: 280px;
  }
 
  * { box-sizing: border-box; margin: 0; padding: 0; }
 
  .tutor-root {
    display: flex;
    height: 100vh;
    background: var(--bg);
    color: var(--text);
    font-family: 'DM Sans', sans-serif;
    overflow: hidden;
  }
 
  /* ── Chat column ── */
  .chat-col {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    border-right: 1px solid var(--border);
  }
 
  .chat-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    flex-shrink: 0;
  }
 
  .header-left { display: flex; align-items: baseline; gap: 10px; }
 
  .logo {
    font-family: 'DM Serif Display', serif;
    font-size: 20px;
    color: var(--accent);
    letter-spacing: -0.3px;
  }
 
  .logo-tag {
    font-size: 11px;
    font-weight: 500;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 1px;
  }
 
  .reset-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
    font-family: 'DM Sans', sans-serif;
    padding: 5px 12px;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .reset-btn:hover { color: var(--text); border-color: var(--accent); }
 
  /* ── Messages area ── */
  .messages-area {
    flex: 1;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
 
  .messages-list {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 24px 20px;
    max-width: 780px;
    margin: 0 auto;
    width: 100%;
  }
 
  /* ── Empty state ── */
  .empty-state {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px 24px;
    text-align: center;
    gap: 12px;
  }
 
  .empty-icon { font-size: 48px; line-height: 1; }
 
  .empty-title {
    font-family: 'DM Serif Display', serif;
    font-size: 26px;
    color: var(--text);
    margin-top: 4px;
  }
 
  .empty-sub {
    font-size: 14px;
    color: var(--muted);
    max-width: 380px;
    line-height: 1.6;
  }
 
  .starter-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
    margin-top: 16px;
  }
 
  .chip {
    background: var(--surface2);
    border: 1px solid var(--border);
    color: var(--text);
    font-size: 13px;
    font-family: 'DM Sans', sans-serif;
    padding: 7px 14px;
    border-radius: 20px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .chip:hover { border-color: var(--accent); color: var(--accent); }
 
  /* ── Chat bubbles ── */
  .bubble-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    animation: fadeUp 0.2s ease;
  }
  .bubble-row-user { flex-direction: row-reverse; }
 
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
 
  .avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    flex-shrink: 0;
    margin-top: 2px;
  }
 
  .avatar-tutor {
    background: var(--surface2);
    border: 1px solid var(--border);
  }
 
  .avatar-user {
    background: var(--user-bubble);
    font-size: 10px;
    font-weight: 600;
    color: #fff;
    letter-spacing: 0.3px;
  }
 
  .bubble {
    max-width: 72%;
    padding: 12px 16px;
    border-radius: var(--radius);
    font-size: 14px;
    line-height: 1.65;
  }
 
  .bubble-model {
    background: var(--tutor-bubble);
    border: 1px solid var(--border);
    border-top-left-radius: 4px;
    color: var(--text);
  }
 
  .bubble-user {
    background: var(--user-bubble);
    border-top-right-radius: 4px;
    color: #fff;
  }
 
  .bubble-loading {
    padding: 16px;
    display: flex;
    align-items: center;
  }
 
  .bubble-text { white-space: pre-wrap; word-break: break-word; }
 
  /* Loading dots */
  .dots { display: flex; gap: 4px; }
  .dots span {
    width: 7px; height: 7px;
    background: var(--muted);
    border-radius: 50%;
    animation: bounce 1.1s ease-in-out infinite;
  }
  .dots span:nth-child(2) { animation-delay: 0.15s; }
  .dots span:nth-child(3) { animation-delay: 0.3s; }
  @keyframes bounce {
    0%, 80%, 100% { transform: scale(0.7); opacity: 0.4; }
    40% { transform: scale(1); opacity: 1; }
  }
 
  /* ── Input area ── */
  .input-area {
    padding: 14px 20px;
    border-top: 1px solid var(--border);
    background: var(--surface);
    flex-shrink: 0;
  }
 
  .input-box {
    display: flex;
    align-items: flex-end;
    gap: 10px;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 14px;
    transition: border-color 0.15s;
  }
  .input-box:focus-within { border-color: var(--accent); }
 
  .input-textarea {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    resize: none;
    color: var(--text);
    font-size: 14px;
    font-family: 'DM Sans', sans-serif;
    line-height: 1.5;
    min-height: 22px;
    max-height: 160px;
    overflow-y: auto;
  }
  .input-textarea::placeholder { color: var(--muted); }
  .input-textarea:disabled { opacity: 0.5; }
 
  .send-btn {
    background: var(--accent);
    border: none;
    color: #fff;
    width: 34px;
    height: 34px;
    border-radius: 9px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.15s;
    flex-shrink: 0;
  }
  .send-btn:hover { filter: brightness(1.15); }
  .send-btn:disabled { background: var(--border); cursor: not-allowed; }
  .stop-btn { background: #da3633; }
 
  .input-hint {
    font-size: 11px;
    color: var(--muted);
    margin-top: 8px;
    text-align: center;
  }
 
  /* ── Right panel ── */
  .panel-col {
    width: var(--panel-width);
    flex-shrink: 0;
    overflow-y: auto;
    background: var(--surface);
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
 
  .session-panel {
    padding: 20px 16px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
 
  .empty-panel {
    align-items: center;
    text-align: center;
    padding-top: 60px;
  }
 
  .panel-icon { font-size: 36px; }
 
  .panel-empty-text {
    font-size: 13px;
    color: var(--muted);
    line-height: 1.6;
    margin-top: 8px;
  }
 
  .session-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
 
  .session-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    color: var(--muted);
  }
 
  .level-badge {
    font-size: 11px;
    font-weight: 600;
    padding: 3px 9px;
    border-radius: 20px;
    text-transform: capitalize;
  }
  .level-beginner { background: rgba(63,185,80,0.15); color: var(--accent2); }
  .level-intermediate { background: rgba(240,136,62,0.15); color: var(--warn); }
  .level-advanced { background: rgba(88,166,255,0.15); color: var(--accent); }
 
  .session-topic, .session-concept {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 13px;
  }
  .session-topic { color: var(--accent); font-weight: 500; }
  .session-concept { color: var(--text); }
 
  .progress-section { display: flex; flex-direction: column; gap: 8px; }
 
  .progress-header {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--muted);
  }
  .progress-value { margin-left: auto; color: var(--accent2); font-weight: 600; }
 
  .progress-bar-track {
    height: 5px;
    background: var(--surface2);
    border-radius: 10px;
    overflow: hidden;
  }
  .progress-bar-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--accent2), var(--accent));
    border-radius: 10px;
    transition: width 0.6s cubic-bezier(0.4,0,0.2,1);
  }
 
  .next-goal {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px;
  }
  .goal-label {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--warn);
    margin-bottom: 6px;
  }
  .next-goal p { font-size: 12px; line-height: 1.5; color: var(--text); }
 
  .hint-section {
    border-top: 1px solid var(--border);
    padding-top: 12px;
  }
  .hint-toggle {
    display: flex;
    align-items: center;
    gap: 5px;
    background: transparent;
    border: none;
    color: var(--accent);
    font-size: 12px;
    font-family: 'DM Sans', sans-serif;
    cursor: pointer;
    width: 100%;
    text-align: left;
    padding: 0;
  }
  .hint-toggle svg:last-child { margin-left: auto; }
  .hint-text {
    margin-top: 8px;
    font-size: 12px;
    line-height: 1.55;
    color: var(--muted);
    font-style: italic;
  }
 
  .stat-row {
    display: flex;
    gap: 1px;
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }
  .stat {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 10px;
    background: var(--surface2);
    gap: 2px;
  }
  .stat:not(:last-child) { border-right: 1px solid var(--border); }
  .stat-value { font-size: 18px; font-weight: 600; color: var(--text); }
  .stat-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
 
  /* Responsive */
  @media (max-width: 600px) {
    .panel-col { display: none; }
  }
`;