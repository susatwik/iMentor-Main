import React, { useState, useRef, useEffect } from 'react';
import { MessageCircle, Send, X, Bot, User, Loader2, Sparkles, ChevronRight } from 'lucide-react';
import axios from 'axios';
import toast from 'react-hot-toast';

const API = import.meta.env.VITE_API_BASE_URL;

const NodeTutorChat = ({ treeId, nodeId, nodeName, onClose }) => {
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const messagesEndRef = useRef(null);
    const inputRef = useRef(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const suggestedQuestions = [
        `Explain ${nodeName} in simple terms`,
        `How does ${nodeName} apply to real problems?`,
        `What are the prerequisites for understanding ${nodeName}?`,
        `Give me a practice problem for ${nodeName}`
    ];

    const handleSend = async (text) => {
        const msg = text || input;
        if (!msg.trim() || loading) return;

        const userMessage = { role: 'user', content: msg };
        setMessages(prev => [...prev, userMessage]);
        setInput('');
        setLoading(true);

        try {
            const token = localStorage.getItem('authToken');
            const history = messages.map(m => ({ role: m.role, content: m.content }));
            const { data } = await axios.post(`${API}/skill-tree/tutor`, {
                treeId, nodeId,
                message: msg,
                history
            }, {
                headers: { Authorization: `Bearer ${token}` }
            });

            setMessages(prev => [...prev, {
                role: 'assistant',
                content: data.reply
            }]);
        } catch (err) {
            toast.error('Tutor unavailable. Try again.');
            setMessages(prev => [...prev, {
                role: 'assistant',
                content: 'I apologize, but I\'m unable to respond right now. Please try again.'
            }]);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
            <div className="bg-zinc-900 rounded-2xl border border-zinc-800 w-full max-w-lg max-h-[85vh] flex flex-col">
                <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Bot className="w-5 h-5 text-blue-400" />
                        <div>
                            <h3 className="text-white font-bold text-sm">AI Tutor</h3>
                            <p className="text-zinc-500 text-xs">{nodeName}</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-1.5 hover:bg-zinc-800 rounded-lg transition-colors">
                        <X className="w-5 h-5 text-zinc-400" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {messages.length === 0 && (
                        <div className="text-center py-8">
                            <Sparkles className="w-10 h-10 text-yellow-400 mx-auto mb-3" />
                            <p className="text-zinc-400 text-sm mb-4">Ask me anything about <span className="text-white font-medium">{nodeName}</span></p>
                            <div className="space-y-2">
                                {suggestedQuestions.map((q, i) => (
                                    <button key={i}
                                        onClick={() => handleSend(q)}
                                        className="w-full text-left px-4 py-2.5 bg-zinc-800/50 hover:bg-zinc-800 rounded-xl text-zinc-300 text-sm transition-all flex items-center justify-between group"
                                    >
                                        <span>{q}</span>
                                        <ChevronRight className="w-4 h-4 text-zinc-600 group-hover:text-zinc-400 transition-colors shrink-0" />
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {messages.map((msg, i) => (
                        <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : ''}`}>
                            {msg.role === 'assistant' && (
                                <div className="w-8 h-8 bg-blue-900/50 rounded-lg flex items-center justify-center shrink-0">
                                    <Bot className="w-4 h-4 text-blue-400" />
                                </div>
                            )}
                            <div className={`max-w-[80%] ${msg.role === 'user' ? 'order-1' : ''}`}>
                                <div className={`rounded-xl px-4 py-2.5 text-sm ${
                                    msg.role === 'user'
                                        ? 'bg-blue-600 text-white'
                                        : 'bg-zinc-800/50 text-zinc-200'
                                }`}>
                                    {msg.content}
                                </div>
                            </div>
                            {msg.role === 'user' && (
                                <div className="w-8 h-8 bg-zinc-800 rounded-lg flex items-center justify-center shrink-0">
                                    <User className="w-4 h-4 text-zinc-400" />
                                </div>
                            )}
                        </div>
                    ))}

                    {loading && (
                        <div className="flex gap-3">
                            <div className="w-8 h-8 bg-blue-900/50 rounded-lg flex items-center justify-center shrink-0">
                                <Bot className="w-4 h-4 text-blue-400" />
                            </div>
                            <div className="bg-zinc-800/50 rounded-xl px-4 py-3">
                                <Loader2 className="w-4 h-4 animate-spin text-zinc-400" />
                            </div>
                        </div>
                    )}
                    <div ref={messagesEndRef} />
                </div>

                <div className="p-4 border-t border-zinc-800">
                    <div className="flex gap-2">
                        <input ref={inputRef}
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                            placeholder="Ask about this topic..."
                            className="flex-1 px-4 py-2.5 bg-black border border-zinc-800 rounded-xl text-white text-sm focus:outline-none focus:border-zinc-700 placeholder:text-zinc-600"
                        />
                        <button onClick={() => handleSend()}
                            disabled={!input.trim() || loading}
                            className="p-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 rounded-xl transition-colors"
                        >
                            <Send className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default NodeTutorChat;
