import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAppState } from '../../contexts/AppStateContext.jsx';
import {
    PanelLeftClose, ChevronDown, ChevronUp, FilePlus,
    Library, History, GraduationCap, Zap,
    BookMarked, Loader2, MessageSquareText, Plus
} from 'lucide-react';
import Animate from '../core/Animate.jsx';
import IconButton from '../core/IconButton.jsx';
import toast from 'react-hot-toast';
import api from '../../services/api';
import DocumentUpload from '../documents/DocumentUpload.jsx';
import KnowledgeSourceList from '../documents/KnowledgeSourceList.jsx';

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

const stripExt = (name = '') => name.replace(/\.[^.]+$/, '');

const getRelativeDateGroup = (dateString) => {
    if (!dateString) return 'Older';
    const date = new Date(dateString);
    const today = new Date();
    
    // Clear times
    const dDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const dToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    
    const diffTime = dToday.getTime() - dDate.getTime();
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays <= 7) return 'Previous 7 Days';
    return 'Older';
};

const groupSessions = (sessionsList) => {
    const grouped = {};
    sessionsList.forEach(session => {
        const course = session.courseName ? stripExt(session.courseName) : 'General Chat';
        const dateGroup = getRelativeDateGroup(session.updatedAt);
        
        if (!grouped[course]) {
            grouped[course] = {};
        }
        if (!grouped[course][dateGroup]) {
            grouped[course][dateGroup] = [];
        }
        grouped[course][dateGroup].push(session);
    });
    return grouped;
};

const DATE_GROUPS_ORDER = ['Today', 'Yesterday', 'Previous 7 Days', 'Older'];

function LeftPanel({ isChatProcessing, currentSessionId, handleSelectSessionFromHistory, handleNewChat }) {
    const navigate = useNavigate();
    const location = useLocation();
    const {
        setIsLeftPanelOpen,
        selectedSubject, setSelectedSubject,
        selectedDocumentForAnalysis, selectDocumentForAnalysis,
        tutorMode,
    } = useAppState();

    // Chat History state
    const [isHistorySectionOpen, setIsHistorySectionOpen] = useState(false);
    const [sessions, setSessions] = useState([]);
    const [loadingSessions, setLoadingSessions] = useState(false);

    // Knowledge Base state
    const [isKBSectionOpen, setIsKBSectionOpen] = useState(false);
    const [kbRefreshKey, setKbRefreshKey] = useState(Date.now());

    const toggleHistorySection = () => {
        setIsHistorySectionOpen(prev => !prev);
    };

    const handleSourceSelect = (title, sourceType) => {
        if (!title) {
            setSelectedSubject(null);
            selectDocumentForAnalysis(null);
            return;
        }
        if (sourceType === 'subject') {
            setSelectedSubject(title);
        } else {
            selectDocumentForAnalysis(title);
        }
    };

    useEffect(() => {
        if (!isHistorySectionOpen) return;
        const fetchSessions = async () => {
            setLoadingSessions(true);
            try {
                const data = await api.getChatSessions();
                const sessionList = Array.isArray(data) ? data : [];
                setSessions(sessionList.filter(s => (s.messageCount || 0) > 0));
            } catch (err) {
                toast.error('Failed to load chat sessions.');
                setSessions([]);
            } finally {
                setLoadingSessions(false);
            }
        };
        fetchSessions();
    }, [isHistorySectionOpen]);

    return (
        <div className={`flex flex-col h-full ${isChatProcessing ? 'processing-overlay' : ''}`}>
            <div className="flex items-center justify-between mb-3 px-1 pt-1">
                <h2 className="text-sm font-semibold text-text-muted-light dark:text-text-muted-dark uppercase tracking-wider">Assistant Controls</h2>
                <IconButton
                    icon={PanelLeftClose}
                    onClick={() => setIsLeftPanelOpen(false)}
                    title="Close Assistant Panel"
                    variant="ghost" size="sm"
                    className="text-text-muted-light dark:text-text-muted-dark hover:text-black dark:hover:text-white"
                />
            </div>


            {/* Admin Subjects — opens dedicated Course Explorer page */}
            <div className="mb-4">
                <button
                    onClick={() => navigate('/courses')}
                    className={`w-full flex items-center gap-2 px-4 py-3 text-sm font-medium text-left transition-all duration-200 rounded-xl shadow-sm border ${
                        location.pathname === '/courses'
                            ? 'bg-indigo-500/10 border-indigo-500/40 text-indigo-300 ring-1 ring-indigo-500/20'
                            : 'bg-gray-50 dark:bg-gray-800 border-border-light dark:border-border-dark text-text-light dark:text-text-dark hover:bg-gray-100 dark:hover:bg-gray-700'
                    }`}
                >
                    <Library size={16} className={location.pathname === '/courses' ? 'text-indigo-400' : 'text-primary dark:text-primary-light'} />
                    <span className="flex-1">Courses</span>
                    {selectedSubject && location.pathname !== '/courses' && (
                        <span className="text-[10px] bg-indigo-500/20 text-indigo-300 px-2 py-0.5 rounded-full font-medium truncate max-w-[80px]">
                            {selectedSubject.replace(/\.[^.]+$/, '')}
                        </span>
                    )}
                    {location.pathname === '/courses' && (
                        <BookMarked size={13} className="text-indigo-400" />
                    )}
                </button>
            </div>

            {/* Tutor Mode (Selectable Option) */}
            <div className="mb-4">
                <button
                    onClick={() => {
                        if (location.pathname === '/tutor') {
                            navigate('/');
                        } else {
                            navigate('/tutor');
                            toast.success("🎓 Tutor Mode activated!");
                        }
                    }}
                    className={`w-full flex items-center gap-2 px-4 py-3 text-sm font-medium text-left transition-all duration-200 rounded-xl shadow-sm border ${tutorMode
                        ? 'bg-primary/10 border-primary text-primary dark:text-primary-light ring-1 ring-primary/20'
                        : 'bg-gray-50 dark:bg-gray-800 border-border-light dark:border-border-dark text-text-light dark:text-text-dark hover:bg-gray-100 dark:hover:bg-gray-700'
                        }`}
                >
                    <GraduationCap size={16} className={tutorMode ? 'text-primary' : 'text-primary dark:text-primary-light'} />
                    <span className="flex-1">Tutor Mode</span>
                    {tutorMode && (
                        <Animate
                            animation="scale-in"
                            className="w-2 h-2 rounded-full bg-primary shadow-[0_0_8px_theme(colors.primary.DEFAULT)]"
                        />
                    )}
                </button>
            </div>

            {/* Deep Research Mode — desktop only, hidden on mobile */}
            <div className="hidden md:block mb-4">
                <button
                    onClick={() => {
                        navigate('/tools/deep-research');
                    }}
                    className={`w-full flex items-center gap-2 px-4 py-3 text-sm font-medium text-left transition-all duration-200 rounded-xl shadow-sm border bg-gray-50 dark:bg-gray-800 border-border-light dark:border-border-dark text-text-light dark:text-text-dark hover:bg-gray-100 dark:hover:bg-gray-700`}
                >
                    <Zap size={16} className="text-blue-500" />
                    <span className="flex-1">Deep Research</span>
                </button>
            </div>

            {/* Chat History Section */}
            <div className="mb-4">
                <button
                    onClick={toggleHistorySection}
                    className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-left text-text-light dark:text-text-dark bg-gray-50 dark:bg-gray-800 border border-border-light dark:border-border-dark hover:bg-gray-100 dark:hover:bg-gray-700 rounded-xl focus:outline-none shadow-sm transition-all duration-200"
                    aria-expanded={isHistorySectionOpen}
                >
                    <span className="flex items-center gap-2"><History size={16} className="text-primary dark:text-primary-light" /> Chat History</span>
                    {isHistorySectionOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                </button>
                <Animate
                    show={isHistorySectionOpen}
                    unmount
                    animation="height-in"
                >
                    <div className="mt-2 p-2 bg-surface-light dark:bg-surface-dark border border-border-light dark:border-border-dark rounded-md shadow-inner overflow-y-auto max-h-80 custom-scrollbar">
                        {loadingSessions && (
                            <div className="flex justify-center p-4">
                                <Loader2 className="animate-spin text-cyan-500" size={20} />
                            </div>
                        )}

                        {!loadingSessions && sessions.length === 0 && (
                            <div className="text-center text-xs text-gray-500 py-6">
                                <MessageSquareText className="mx-auto mb-2 opacity-60" size={24} />
                                No chat sessions yet.
                            </div>
                        )}

                        {!loadingSessions && sessions.length > 0 && (() => {
                            const grouped = groupSessions(sessions);
                            const courses = Object.keys(grouped).sort((a, b) => {
                                if (a === 'General Chat') return -1;
                                if (b === 'General Chat') return 1;
                                return a.localeCompare(b);
                            });

                            return courses.map(course => (
                                <div key={course} className="mb-4 last:mb-1">
                                    <div className="text-[10px] font-bold text-indigo-400 dark:text-indigo-300/80 uppercase tracking-wider mb-2 px-1 border-b border-indigo-500/10 pb-1">
                                        {course}
                                    </div>
                                    
                                    {DATE_GROUPS_ORDER.map(dateGroup => {
                                        const groupSessionsList = grouped[course][dateGroup] || [];
                                        if (groupSessionsList.length === 0) return null;

                                        return (
                                            <div key={dateGroup} className="mb-2 last:mb-0">
                                                <div className="text-[9px] font-semibold text-gray-500 dark:text-gray-400 px-2 mb-1.5 uppercase tracking-wide">
                                                    {dateGroup}
                                                </div>
                                                <div className="space-y-1 pl-1">
                                                    {groupSessionsList.map(session => {
                                                        const isActive = currentSessionId === session.sessionId;
                                                        const preview = session.preview || `Session ${String(session.sessionId).slice(0, 8)}`;
                                                        const isTutor = !!session.isTutorMode;
                                                        const tutorType = session.tutorModeType;
                                                        const tutorBadgeText = tutorType === 'structured' ? 'Tutor · Course' : 'Tutor · General';

                                                        return (
                                                            <button
                                                                key={session.sessionId}
                                                                onClick={() => handleSelectSessionFromHistory(session.sessionId, {
                                                                    isTutorMode: session.isTutorMode || false,
                                                                    tutorModeType: session.tutorModeType || null,
                                                                    courseName: session.courseName || null
                                                                })}
                                                                className={`w-full text-left rounded-lg px-2.5 py-1.5 transition-all duration-200 border ${isActive
                                                                    ? 'border-primary/50 bg-primary/10 shadow-sm'
                                                                    : 'border-border-light dark:border-gray-800 bg-background-light dark:bg-gray-900 hover:bg-gray-100 dark:hover:bg-gray-800'
                                                                    }`}
                                                                title={preview}
                                                            >
                                                                <div className="flex flex-col gap-0.5 min-w-0">
                                                                    <div className={`truncate text-xs font-medium ${isActive ? 'text-primary dark:text-primary-light' : 'text-text-light dark:text-text-dark'}`}>
                                                                        {preview}
                                                                    </div>
                                                                    <div className="flex items-center justify-between mt-0.5">
                                                                        {isTutor && (
                                                                            <span className="flex-shrink-0 rounded border border-primary/30 bg-primary/10 px-1 py-0.2 text-[8px] text-primary">
                                                                                {tutorBadgeText}
                                                                            </span>
                                                                        )}
                                                                        <div className={`text-[9px] ${isActive ? 'text-primary/70' : 'text-text-muted-light dark:text-text-muted-dark'} ml-auto`}>
                                                                            {formatDate(session.updatedAt)}
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            ));
                        })()}
                    </div>
                </Animate>
            </div>

            {/* User's Knowledge Base Section (Embedded Accordion) */}
            <div className="mb-4">
                <button
                    onClick={() => setIsKBSectionOpen(prev => !prev)}
                    className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-left text-text-light dark:text-text-dark bg-gray-50 dark:bg-gray-800 border border-border-light dark:border-border-dark hover:bg-gray-100 dark:hover:bg-gray-700 rounded-xl focus:outline-none shadow-sm transition-all duration-200"
                    aria-expanded={isKBSectionOpen}
                >
                    <span className="flex items-center gap-2">
                        <FilePlus size={16} className="text-primary dark:text-primary-light" /> 
                        My Knowledge Base
                    </span>
                    {isKBSectionOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                </button>
                <Animate
                    show={isKBSectionOpen}
                    unmount
                    animation="height-in"
                >
                    <div className="mt-2 p-3 bg-surface-light dark:bg-surface-dark border border-border-light dark:border-border-dark rounded-md shadow-inner overflow-hidden">
                        <DocumentUpload onSourceAdded={() => {
                            toast.success('Source added. Refreshing list...');
                            setKbRefreshKey(Date.now());
                        }} />
                        <div className="mt-2 max-h-64 overflow-y-auto custom-scrollbar">
                            <KnowledgeSourceList
                                key={kbRefreshKey}
                                showSubjects={true}
                                selectedSource={selectedDocumentForAnalysis || selectedSubject}
                                onSelectSource={handleSourceSelect}
                                onRefreshNeeded={kbRefreshKey}
                            />
                        </div>
                    </div>
                </Animate>
            </div>
        </div>
    );
}

export default LeftPanel;