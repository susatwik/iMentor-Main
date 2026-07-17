import React, { useEffect, useState, useCallback } from 'react';
import api from '../../services/api';
import toast from 'react-hot-toast';
import { History, Loader2, MessageSquareText } from 'lucide-react';

const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    try {
        return new Date(dateString).toLocaleString(undefined, {
            month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
        });
    } catch {
        return 'Invalid Date';
    }
};

function ChatHistorySidebar({
    isOpen,
    currentSessionId,
    onSelectSession,
    onClose,
    className = '',
    filterMode = null
}) {
    const [sessions, setSessions] = useState([]);
    const [loadingSessions, setLoadingSessions] = useState(false);

    const fetchSessions = useCallback(async () => {
        if (!isOpen) return;
        setLoadingSessions(true);
        try {
            const data = await api.getChatSessions();
            let sessionList = Array.isArray(data) ? data : [];

            if (filterMode === 'tutor') {
                sessionList = sessionList.filter(s => s.isTutorMode === true);
            } else if (filterMode === 'general') {
                sessionList = sessionList.filter(s => s.isTutorMode === false);
            }

            setSessions(sessionList.filter(s => (s.messageCount || 0) > 0));
        } catch (err) {
            toast.error('Failed to load chat sessions.');
            setSessions([]);
        } finally {
            setLoadingSessions(false);
        }
    }, [isOpen, filterMode]);

    useEffect(() => {
        fetchSessions();
    }, [fetchSessions]);

    if (!isOpen) return null;

    return (
        <aside
            className={`h-full bg-[#0B0F10] border-r border-[#1D2A2D] shadow-[0_10px_40px_rgba(0,0,0,0.35)] flex flex-col ${className}`}
        >
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#1A2528]">
                <div className="flex items-center gap-2 text-[#A6E8F0]">
                    <History size={16} />
                    <h3 className="text-sm font-semibold tracking-wide">Chat History</h3>
                </div>
                {onClose && (
                    <button
                        onClick={onClose}
                        className="md:hidden text-xs px-2 py-1 rounded border border-[#214049] text-[#89DDE8] hover:bg-[#0F1B1F]"
                    >
                        Close
                    </button>
                )}
            </div>

            <div
                className="flex-1 overflow-y-auto px-3 py-3 space-y-2 custom-scrollbar"
                style={{
                    scrollbarWidth: 'thin',
                    scrollbarColor: '#22d3ee #0f172a',
                    scrollBehavior: 'smooth'
                }}
            >
                {loadingSessions && (
                    <div className="flex justify-center p-4">
                        <Loader2 className="animate-spin text-cyan-400" size={20} />
                    </div>
                )}

                {!loadingSessions && sessions.length === 0 && (
                    <div className="text-center text-xs text-gray-400 py-8">
                        <MessageSquareText className="mx-auto mb-2 opacity-60" size={24} />
                        No chat sessions yet.
                    </div>
                )}

                {!loadingSessions && sessions.map(session => {
                    const isActive = currentSessionId === session.sessionId;
                    const preview = session.preview || `Session ${String(session.sessionId).slice(0, 8)}`;
                    const isTutor = !!session.isTutorMode;
                    const tutorType = session.tutorModeType;
                    const tutorBadgeText = tutorType === 'structured' ? 'Tutor · Course' : 'Tutor · General';

                    return (
                        <button
                            key={session.sessionId}
                            onClick={() => onSelectSession(session.sessionId, {
                                isTutorMode: session.isTutorMode || false,
                                tutorModeType: session.tutorModeType || null,
                                courseName: session.courseName || null
                            })}
                            className={`w-full text-left rounded-lg px-3 py-2.5 transition-all duration-200 border ${isActive
                                ? 'border-cyan-400 bg-cyan-500/10 shadow-[0_0_0_1px_rgba(34,211,238,0.25)]'
                                : 'border-[#1E2A2F] bg-[#0F1518] hover:bg-[#121D22] hover:shadow-[0_0_10px_rgba(34,211,238,0.12)]'
                                }`}
                            title={preview}
                        >
                            <div className="flex items-center gap-2 min-w-0">
                                <div className={`truncate text-xs font-medium ${isActive ? 'text-[#C9F7FF]' : 'text-[#D2D9DB]'}`}>
                                    {preview}
                                </div>
                                {isTutor && (
                                    <span className="flex-shrink-0 rounded-full border border-cyan-500/50 bg-cyan-500/10 px-2 py-0.5 text-[10px] text-cyan-200">
                                        {tutorBadgeText}
                                    </span>
                                )}
                            </div>
                            <div className={`mt-1 text-[11px] ${isActive ? 'text-cyan-200/90' : 'text-gray-500'}`}>
                                {formatDate(session.updatedAt)} · {session.messageCount} msgs
                            </div>
                        </button>
                    );
                })}
            </div>
        </aside>
    );
}

export default ChatHistorySidebar;
