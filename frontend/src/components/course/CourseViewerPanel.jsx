// frontend/src/components/course/CourseViewerPanel.jsx
// Slide-in right panel showing full course lecture notes.
// Opens automatically when an admin course is selected from the KB dropdown.
// Module → Topic → Subtopic accordion; clicking a subtopic loads its STN notes.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../services/api.js';
import { useAppState } from '../../contexts/AppStateContext.jsx';
import {
    X, ChevronDown, ChevronRight, BookOpen, GraduationCap,
    Loader2, AlertTriangle, BookMarked, Layers, Hash,
    MessageSquare, RefreshCw, FileText
} from 'lucide-react';

// ─── Note viewer ───────────────────────────────────────────────────────────────
function NoteViewer({ courseName, subtopic, onChat }) {
    const [notes, setNotes]   = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError]   = useState(null);

    useEffect(() => {
        if (!courseName || !subtopic?.id) return;
        let mounted = true;
        setLoading(true);
        setError(null);
        setNotes([]);

        api.getCourseSubtopicNotes(courseName, subtopic.id)
            .then(data => {
                if (mounted) setNotes(data.notes || []);
            })
            .catch(e => {
                if (mounted) setError(e.response?.data?.message || e.message);
            })
            .finally(() => { if (mounted) setLoading(false); });

        return () => { mounted = false; };
    }, [courseName, subtopic?.id]);

    if (loading) return (
        <div className="flex items-center justify-center py-10 text-gray-500 text-xs gap-2">
            <Loader2 size={14} className="animate-spin" /> Loading notes…
        </div>
    );
    if (error) return (
        <div className="flex items-center justify-center py-8 text-red-400 text-xs gap-2">
            <AlertTriangle size={14} /> {error}
        </div>
    );
    if (!notes.length) return (
        <div className="flex flex-col items-center justify-center py-10 text-gray-600 text-xs gap-2">
            <Loader2 size={18} className="animate-spin text-indigo-400 opacity-40" />
            <p>Auto-generating content…</p>
            <p className="text-[10px] text-gray-700">Content will be created on first access.</p>
        </div>
    );

    return (
        <div className="space-y-4">
            {/* Subtopic header */}
            <div className="flex items-start justify-between gap-2">
                <div>
                    <h3 className="text-sm font-semibold text-white leading-tight">{subtopic.name}</h3>
                    {subtopic.topicName && (
                        <p className="text-[11px] text-gray-500 mt-0.5">{subtopic.topicName}</p>
                    )}
                </div>
                <button
                    onClick={() => onChat(`Explain ${subtopic.name} in ${courseName}`)}
                    className="flex items-center gap-1 px-2.5 py-1.5 bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 rounded-lg text-[11px] font-medium transition-all whitespace-nowrap flex-shrink-0"
                    title="Ask about this in chat"
                >
                    <MessageSquare size={11} /> Ask AI
                </button>
            </div>

            {/* Note cards */}
            {notes.map((note, i) => (
                <div key={i} className="rounded-xl bg-white/3 border border-white/8 overflow-hidden">
                    <div className="px-3 py-2 border-b border-white/8 flex items-center gap-2">
                        <FileText size={11} className="text-indigo-400" />
                        <span className="text-[10px] text-gray-500 uppercase tracking-wide font-medium">
                            {note.topic_name || 'Lecture Note'}
                        </span>
                    </div>
                    <div className="px-3 py-3">
                        <p className="text-xs text-gray-300 leading-relaxed whitespace-pre-wrap">
                            {note.content}
                        </p>
                    </div>
                </div>
            ))}
        </div>
    );
}

// ─── Subtopic item ─────────────────────────────────────────────────────────────
function SubtopicItem({ subtopic, topicName, isActive, onClick }) {
    return (
        <button
            onClick={onClick}
            className={`w-full text-left flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-all group
                ${isActive
                    ? 'bg-indigo-500/20 text-indigo-300 font-medium'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'}`}
        >
            <Hash size={10} className={`flex-shrink-0 ${isActive ? 'text-indigo-400' : 'text-gray-600 group-hover:text-gray-400'}`} />
            <span className="truncate">{subtopic.name}</span>
        </button>
    );
}

// ─── Topic item ────────────────────────────────────────────────────────────────
function TopicItem({ topic, courseStructure, courseName, activeSubtopic, onSubtopicSelect, defaultOpen }) {
    const [open, setOpen] = useState(defaultOpen || false);

    return (
        <div>
            <button
                onClick={() => setOpen(o => !o)}
                className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-xs font-medium text-gray-300 hover:text-white hover:bg-white/5 transition-all group"
            >
                {open
                    ? <ChevronDown size={12} className="flex-shrink-0 text-gray-500" />
                    : <ChevronRight size={12} className="flex-shrink-0 text-gray-500" />}
                <BookMarked size={12} className="flex-shrink-0 text-indigo-400/70" />
                <span className="truncate text-left">{topic.name || topic.id}</span>
                <span className="ml-auto text-[10px] text-gray-600 flex-shrink-0">
                    {topic.subtopics?.length || 0}
                </span>
            </button>

            {open && (
                <div className="ml-4 mt-0.5 space-y-0.5 border-l border-white/8 pl-2">
                    {(topic.subtopics || []).map(sub => (
                        <SubtopicItem
                            key={sub.id}
                            subtopic={sub}
                            topicName={topic.name}
                            isActive={activeSubtopic?.id === sub.id}
                            onClick={() => onSubtopicSelect({ ...sub, topicName: topic.name })}
                        />
                    ))}
                    {(!topic.subtopics || topic.subtopics.length === 0) && (
                        <p className="text-[10px] text-gray-700 pl-2 py-1">No subtopics</p>
                    )}
                </div>
            )}
        </div>
    );
}

// ─── Module item ───────────────────────────────────────────────────────────────
function ModuleItem({ module, courseName, activeSubtopic, onSubtopicSelect, defaultOpen }) {
    const [open, setOpen] = useState(defaultOpen || false);

    return (
        <div className="border border-white/8 rounded-xl overflow-hidden">
            <button
                onClick={() => setOpen(o => !o)}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-all hover:bg-white/5 group"
            >
                <div className="p-1 bg-indigo-500/20 rounded-md flex-shrink-0">
                    <Layers size={12} className="text-indigo-400" />
                </div>
                <span className="text-xs font-semibold text-gray-200 truncate flex-1">
                    {module.name || module.id}
                </span>
                <span className="text-[10px] text-gray-600 flex-shrink-0">
                    {module.topics?.length || 0} topics
                </span>
                {open
                    ? <ChevronDown size={12} className="text-gray-500 flex-shrink-0" />
                    : <ChevronRight size={12} className="text-gray-500 flex-shrink-0" />}
            </button>

            {open && (
                <div className="px-2 pb-2 space-y-0.5 border-t border-white/8">
                    {(module.topics || []).map((topic, ti) => (
                        <TopicItem
                            key={topic.id || ti}
                            topic={topic}
                            courseName={courseName}
                            activeSubtopic={activeSubtopic}
                            onSubtopicSelect={onSubtopicSelect}
                            defaultOpen={ti === 0}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

// ─── Main panel ───────────────────────────────────────────────────────────────
export default function CourseViewerPanel({ onChatMessage }) {
    const { selectedSubject, setCourseViewerOpen, courseViewerOpen, setSelectedSubject } = useAppState();

    const [structure, setStructure]     = useState(null);
    const [loadingStruct, setLoadingStruct] = useState(false);
    const [structError, setStructError] = useState(null);
    const [activeSubtopic, setActiveSubtopic] = useState(null);
    const [view, setView]               = useState('tree'); // 'tree' | 'note'
    const noteScrollRef = useRef(null);

    // Load course structure whenever selected course changes
    useEffect(() => {
        if (!selectedSubject || !courseViewerOpen) return;
        let mounted = true;

        setLoadingStruct(true);
        setStructError(null);
        setStructure(null);
        setActiveSubtopic(null);
        setView('tree');

        api.getCourseStructure(selectedSubject)
            .then(data => {
                if (mounted) setStructure(data.curriculum || null);
            })
            .catch(e => {
                if (mounted) setStructError(e.response?.data?.message || e.message || 'Failed to load course structure');
            })
            .finally(() => { if (mounted) setLoadingStruct(false); });

        return () => { mounted = false; };
    }, [selectedSubject, courseViewerOpen]);

    const handleSubtopicSelect = useCallback((sub) => {
        setActiveSubtopic(sub);
        setView('note');
        // Scroll note area to top
        if (noteScrollRef.current) noteScrollRef.current.scrollTop = 0;
    }, []);

    const handleChat = useCallback((prompt) => {
        onChatMessage?.(prompt);
        setCourseViewerOpen(false);
    }, [onChatMessage, setCourseViewerOpen]);

    const handleClose = () => {
        setCourseViewerOpen(false);
    };

    const handleDeselect = () => {
        setSelectedSubject(null);
        setCourseViewerOpen(false);
    };

    if (!courseViewerOpen || !selectedSubject) return null;

    const displayName = selectedSubject.replace(/\.[^.]+$/, '');
    const modules     = structure?.modules || [];

    return (
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-black/40 backdrop-blur-[2px] z-40"
                onClick={handleClose}
            />

            {/* Panel */}
            <div
                className="fixed top-0 right-0 bottom-0 z-50 flex flex-col"
                style={{
                    width: 'min(520px, 92vw)',
                    background: 'linear-gradient(180deg, #0d0f14 0%, #0a0c10 100%)',
                    borderLeft: '1px solid rgba(255,255,255,0.08)',
                    boxShadow: '-8px 0 40px rgba(0,0,0,0.6)',
                }}
            >
                {/* Header */}
                <div className="flex items-center gap-3 px-4 py-3 border-b border-white/8 flex-shrink-0">
                    <div className="p-2 bg-indigo-500/20 rounded-lg">
                        <GraduationCap size={16} className="text-indigo-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h2 className="text-sm font-bold text-white truncate">{displayName}</h2>
                        <p className="text-[10px] text-gray-500">Lecture Notes · RAG Active</p>
                    </div>
                    <div className="flex items-center gap-1">
                        {view === 'note' && (
                            <button onClick={() => setView('tree')}
                                className="p-1.5 text-gray-500 hover:text-white rounded-lg hover:bg-white/10 transition-all text-[10px] flex items-center gap-1"
                                title="Back to structure">
                                <BookOpen size={13} />
                            </button>
                        )}
                        <button onClick={handleDeselect}
                            className="p-1.5 text-gray-600 hover:text-red-400 rounded-lg hover:bg-red-500/10 transition-all"
                            title="Deselect course">
                            <X size={13} />
                        </button>
                        <button onClick={handleClose}
                            className="p-1.5 text-gray-500 hover:text-white rounded-lg hover:bg-white/10 transition-all"
                            title="Close panel (course stays active)">
                            <ChevronRight size={14} />
                        </button>
                    </div>
                </div>

                {/* View toggle */}
                {structure && (
                    <div className="flex border-b border-white/8 flex-shrink-0">
                        <button
                            onClick={() => setView('tree')}
                            className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-all
                                ${view === 'tree' ? 'text-indigo-400 border-b-2 border-indigo-500' : 'text-gray-500 hover:text-gray-300'}`}>
                            <Layers size={11} /> Structure
                        </button>
                        <button
                            onClick={() => activeSubtopic && setView('note')}
                            className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-all
                                ${!activeSubtopic ? 'opacity-30 cursor-not-allowed' : ''}
                                ${view === 'note' ? 'text-indigo-400 border-b-2 border-indigo-500' : 'text-gray-500 hover:text-gray-300'}`}>
                            <FileText size={11} />
                            {activeSubtopic ? activeSubtopic.name : 'Select a subtopic'}
                        </button>
                    </div>
                )}

                {/* Body */}
                <div ref={noteScrollRef} className="flex-1 overflow-y-auto custom-scrollbar">
                    {/* Loading */}
                    {loadingStruct && (
                        <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-500">
                            <Loader2 size={22} className="animate-spin text-indigo-400" />
                            <p className="text-xs">Loading course structure…</p>
                        </div>
                    )}

                    {/* Error */}
                    {structError && !loadingStruct && (
                        <div className="flex flex-col items-center justify-center h-full gap-3 text-red-400 px-6 text-center">
                            <AlertTriangle size={22} />
                            <p className="text-xs">{structError}</p>
                            <button onClick={() => { /* trigger reload */ setStructError(null); setLoadingStruct(true); }}
                                className="text-[11px] text-indigo-400 hover:underline flex items-center gap-1">
                                <RefreshCw size={10} /> Retry
                            </button>
                        </div>
                    )}

                    {/* Tree view */}
                    {!loadingStruct && !structError && structure && view === 'tree' && (
                        <div className="p-4 space-y-2">
                            <p className="text-[10px] text-gray-600 mb-3 uppercase tracking-wide font-medium">
                                {modules.length} Module{modules.length !== 1 ? 's' : ''} · Click a subtopic to view notes
                            </p>
                            {modules.map((mod, mi) => (
                                <ModuleItem
                                    key={mod.id || mi}
                                    module={mod}
                                    courseName={selectedSubject}
                                    activeSubtopic={activeSubtopic}
                                    onSubtopicSelect={handleSubtopicSelect}
                                    defaultOpen={mi === 0}
                                />
                            ))}
                            {modules.length === 0 && (
                                <div className="flex flex-col items-center justify-center py-16 gap-3 text-gray-600">
                                    <BookOpen size={24} className="opacity-30" />
                                    <p className="text-xs text-center">No modules found for this course.<br />Upload a syllabus CSV via the Admin panel.</p>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Note view */}
                    {!loadingStruct && !structError && view === 'note' && activeSubtopic && (
                        <div className="p-4">
                            <NoteViewer
                                courseName={selectedSubject}
                                subtopic={activeSubtopic}
                                onChat={handleChat}
                            />
                        </div>
                    )}
                </div>

                {/* Footer: RAG status + chat prompt */}
                <div className="px-4 py-2.5 border-t border-white/8 flex-shrink-0 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-1.5">
                        <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-pulse" />
                        <span className="text-[10px] text-gray-500">RAG active — all questions grounded in {displayName}</span>
                    </div>
                    <button
                        onClick={() => handleChat(`Teach me about ${displayName}`)}
                        className="flex items-center gap-1 px-2.5 py-1 bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 rounded-lg text-[10px] font-medium transition-all whitespace-nowrap"
                    >
                        <MessageSquare size={10} /> Chat
                    </button>
                </div>
            </div>
        </>
    );
}
