import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAppState } from '../../contexts/AppStateContext.jsx';
import { useAuth as useRegularAuth } from '../../hooks/useAuth.jsx';
import TopNav from '../layout/TopNav.jsx';
import CenterPanel from '../layout/CenterPanel.jsx';
import CurriculumPanel from './CurriculumPanel.jsx';
import QuizPanel from './QuizPanel.jsx';
import Animate from '../core/Animate.jsx';
import { GraduationCap, ArrowLeft, Sparkles, Brain, BookOpen, ChevronDown, PanelRightOpen, PanelRightClose, Target, CircleHelp } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import ChatHistoryModal from '../chat/ChatHistoryModal.jsx';
import toast from 'react-hot-toast';
import api from '../../services/api.js';

const TUTOR_MODE_TYPES = {
    COURSE_STRUCTURED: 'structured',
    GENERAL_SOCRATIC: 'general_socratic'
};

const resolveTutorMode = (selectedCourse) => {
    return selectedCourse ? TUTOR_MODE_TYPES.COURSE_STRUCTURED : TUTOR_MODE_TYPES.GENERAL_SOCRATIC;
};

// Simple loading modal matches the one in App.jsx
function SessionLoadingModal() {
    return (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[9999]">
            <Animate
                key="session-loading-modal"
                animation="scale-in"
                className="bg-surface-light dark:bg-surface-dark rounded-xl shadow-2xl p-8 w-full max-w-md text-center"
            >
                <div className="flex justify-center items-center mb-4">
                    <div className="animate-spin rounded-full h-10 w-10 border-t-4 border-b-4 border-primary"></div>
                </div>
                <h2 className="text-xl font-bold text-text-light dark:text-text-dark mb-2">Finalizing Session...</h2>
                <p className="text-sm text-text-muted-light dark:text-text-muted-dark">
                    Summarizing key points and identifying topics for your future recommendations.
                </p>
            </Animate>
        </div>
    );
}

function TutorModePage({
    orchestratorStatus,
    handleNewChat,
    isSessionLoading,
    messages,
    setMessages
}) {
    const { user: regularUser, logout: regularUserLogout } = useRegularAuth();
    const {
        currentSessionId,
        setSessionId: setGlobalSessionId,
        setTutorMode,
        initialPromptForNewSession,
        setInitialPromptForNewSession,
        initialActivityForNewSession,
        setInitialActivityForNewSession,
        selectedSubject,
        setSelectedSubject,
        tutorModeType,
        setTutorModeType,
        systemPrompt,
        setSystemPrompt
    } = useAppState();

    const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
    const [isChatProcessing, setIsChatProcessing] = useState(false);
    const [availableSubjects, setAvailableSubjects] = useState([]);
    const [isLoadingSubjects, setIsLoadingSubjects] = useState(true);
    const [showCurriculumPanel, setShowCurriculumPanel] = useState(true);
    const [currentTopic, setCurrentTopic] = useState(null);
    const [currentSubtopic, setCurrentSubtopic] = useState(null);
    const [rightPanelTab, setRightPanelTab] = useState('roadmap');



    // Quiz mode state (AI Assistant)
    const [currentQuestion, setCurrentQuestion] = useState(null);
    // Guard: prevents clearing localStorage during initial mount before data is loaded
    const quizResultsReady = useRef(false);
    const [questionResults, setQuestionResults] = useState(() => {
        const userId = regularUser?.id || 'guest';
        // Try course-specific key first (when subject is already loaded)
        const subject = selectedSubject || localStorage.getItem('aiTutorSelectedSubject');
        if (subject) {
            const saved = localStorage.getItem(`quizResults_${userId}_${subject}`);
            if (saved) {
                try {
                    return JSON.parse(saved);
                } catch (e) {
                    if (import.meta.env.DEV) {
                        console.warn('Failed to parse saved quiz results:', e);
                    }
                }
            }
        }
        // Fallback: restore from last-session snapshot (survives server restart + session clear)
        const snapshot = localStorage.getItem(`quizResults_snapshot_${userId}`);
        if (snapshot) {
            try {
                const { results } = JSON.parse(snapshot);
                if (results && typeof results === 'object') return results;
            } catch (e) {
                if (import.meta.env.DEV) {
                    console.warn('Failed to parse quiz results snapshot:', e);
                }
            }
        }
        return {};
    });

    // Load quiz results from localStorage whenever the selected course changes
    useEffect(() => {
        if (!selectedSubject) return;
        const userId = regularUser?.id || 'guest';
        quizResultsReady.current = false; // New course — pause saves briefly

        const saved = localStorage.getItem(`quizResults_${userId}_${selectedSubject}`);
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                if (parsed && typeof parsed === 'object') {
                    setQuestionResults(parsed); // Restore saved results for this course
                }
            } catch (e) {
                console.error("Quiz State Sync Error:", e);
            }
        }
        // IMPORTANT: Do NOT reset to {} when no saved data exists.
        // questionResults is only explicitly cleared by handleResetQuiz.

        // Allow saving after 300ms to avoid race with the initial state load
        const t = setTimeout(() => { quizResultsReady.current = true; }, 300);
        setHasSynced(false); // Reset sync flag when course changes
        return () => clearTimeout(t);
    }, [selectedSubject, regularUser]);

    const [backendQuizIndex, setBackendQuizIndex] = useState(null);
    const [localQuizIndex, setLocalQuizIndex] = useState(0);
    const [hasSynced, setHasSynced] = useState(false);

    // Load quiz results from Backend whenever the selected course changes
    useEffect(() => {
        if (!selectedSubject) return;

        const syncWithBackend = async () => {
            try {
                const response = await api.getProgress(selectedSubject);
                if (response.success && response.progress) {
                    const { quizResults: backendResults, quizIndex: backendIdx } = response.progress;

                    if (backendResults && Object.keys(backendResults).length > 0) {
                        setQuestionResults(prev => ({
                            ...prev,
                            ...backendResults // Backend is the source of truth after refresh
                        }));
                    }
                    if (backendIdx !== undefined) {
                        setBackendQuizIndex(backendIdx);
                        setLocalQuizIndex(backendIdx);
                    }
                }
                setHasSynced(true);
            } catch (error) {
                console.error("Backend Quiz State Sync Error:", error);
                // Even on error, we might want to allow saving if the user starts answering
                setHasSynced(true);
            }
        };

        syncWithBackend();
    }, [selectedSubject]);

    // Persist results to Backend whenever they change (Debounced)
    useEffect(() => {
        if (!selectedSubject || !quizResultsReady.current || !hasSynced) return;

        const saveToBackend = async () => {
            try {
                await api.updateQuizProgress(selectedSubject, questionResults, localQuizIndex);
            } catch (err) {
                console.error("Failed to save quiz progress to backend:", err);
            }
        };

        const timeout = setTimeout(saveToBackend, 2000); // 2 second debounce
        return () => clearTimeout(timeout);
    }, [questionResults, selectedSubject, localQuizIndex]);

    // Persist results to localStorage whenever they change
    useEffect(() => {
        if (!selectedSubject || !hasSynced || !regularUser?.id) return; // Wait for initial sync
        const userId = regularUser.id;
        if (Object.keys(questionResults).length > 0) {
            // Save to course-specific key
            localStorage.setItem(`quizResults_${userId}_${selectedSubject}`, JSON.stringify(questionResults));
            // Also save a snapshot with course name — survives server restart & session clear
            localStorage.setItem(`quizResults_snapshot_${userId}`, JSON.stringify({
                course: selectedSubject,
                results: questionResults,
                savedAt: Date.now()
            }));
        } else if (quizResultsReady.current) {
            // Only clear when the user explicitly reset (not on initial mount)
            localStorage.removeItem(`quizResults_${userId}_${selectedSubject}`);
            localStorage.removeItem(`quizResults_snapshot_${userId}`);
        }
    }, [questionResults, selectedSubject, hasSynced, regularUser]);


    const [currentModulePathId, setCurrentModulePathId] = useState(null);
    const activeTutorModeType = tutorModeType || resolveTutorMode(selectedSubject);
    const isCourseStructuredMode = activeTutorModeType === TUTOR_MODE_TYPES.COURSE_STRUCTURED;

    // Per-mode session ID storage keys
    const sessionKeyFor = useCallback((mode, mid) => {
        const sub = selectedSubject || 'default';
        const mId = mid || currentModulePathId || 'start';
        const userId = regularUser?.id || 'guest';
        if (mode === 'structured') {
            return `tutorSession_structured_${userId}_${sub}_${mId}`;
        }
        return `tutorSession_${mode}_${userId}_${sub}`;
    }, [selectedSubject, currentModulePathId, regularUser]);

    // Progress tracking - loaded from localStorage (scoped per course)
    const [completedSubtopics, setCompletedSubtopics] = useState(() => {
        const userId = regularUser?.id || 'guest';
        const saved = localStorage.getItem(`tutorProgress_subtopics_${userId}_${selectedSubject || 'default'}`);
        return saved ? JSON.parse(saved) : [];
    });
    const [completedTopics, setCompletedTopics] = useState(() => {
        const userId = regularUser?.id || 'guest';
        const saved = localStorage.getItem(`tutorProgress_topics_${userId}_${selectedSubject || 'default'}`);
        return saved ? JSON.parse(saved) : [];
    });
    const [completedModules, setCompletedModules] = useState(() => {
        const userId = regularUser?.id || 'guest';
        const saved = localStorage.getItem(`tutorProgress_modules_${userId}_${selectedSubject || 'default'}`);
        return saved ? JSON.parse(saved) : [];
    });

    const navigate = useNavigate();

    // Ensure Tutor Mode is active whenever we are on this page
    useEffect(() => {
        setTutorMode(true);
    }, [setTutorMode]);

    // Auto-resolve mode: course selected => structured, no course => general socratic
    useEffect(() => {
        const resolvedMode = resolveTutorMode(selectedSubject);
        if (tutorModeType !== resolvedMode) {
            setTutorModeType(resolvedMode);
        }
    }, [selectedSubject, tutorModeType, setTutorModeType]);

    // Persist progress to localStorage (scoped per course)
    useEffect(() => {
        if (selectedSubject && regularUser?.id) {
            localStorage.setItem(`tutorProgress_subtopics_${regularUser.id}_${selectedSubject}`, JSON.stringify(completedSubtopics));
        }
    }, [completedSubtopics, selectedSubject, regularUser]);

    useEffect(() => {
        if (selectedSubject && regularUser?.id) {
            localStorage.setItem(`tutorProgress_topics_${regularUser.id}_${selectedSubject}`, JSON.stringify(completedTopics));
        }
    }, [completedTopics, selectedSubject, regularUser]);

    useEffect(() => {
        if (selectedSubject && regularUser?.id) {
            localStorage.setItem(`tutorProgress_modules_${regularUser.id}_${selectedSubject}`, JSON.stringify(completedModules));
        }
    }, [completedModules, selectedSubject, regularUser]);

    // When selectedSubject changes, reload progress from localStorage for that course
    useEffect(() => {
        if (selectedSubject && regularUser?.id) {
            const userId = regularUser.id;
            const savedSub = localStorage.getItem(`tutorProgress_subtopics_${userId}_${selectedSubject}`);
            const savedTop = localStorage.getItem(`tutorProgress_topics_${userId}_${selectedSubject}`);
            const savedMod = localStorage.getItem(`tutorProgress_modules_${userId}_${selectedSubject}`);
            setCompletedSubtopics(savedSub ? JSON.parse(savedSub) : []);
            setCompletedTopics(savedTop ? JSON.parse(savedTop) : []);
            setCompletedModules(savedMod ? JSON.parse(savedMod) : []);
        }
    }, [selectedSubject, regularUser]);

    // Listen for progress updates from chat (mastery achieved)
    useEffect(() => {
        const handleProgressUpdate = (event) => {
            const data = event.detail;
            console.log('[TutorModePage] Received progress update:', data);

            // Update completed subtopics
            if (data.masteredSubtopicId) {
                setCompletedSubtopics(prev => {
                    if (!prev.includes(data.masteredSubtopicId)) {
                        // toast.success(`Mastered: ${data.masteredSubtopicName || 'Subtopic'} 🎉`);
                        return [...prev, data.masteredSubtopicId];
                    }
                    return prev;
                });
            }

            // Sync with backend data if available
            if (data.completedSubtopics?.length > 0) {
                setCompletedSubtopics(prev => [...new Set([...prev, ...data.completedSubtopics])]);
            }
            if (data.completedTopics?.length > 0) {
                setCompletedTopics(prev => [...new Set([...prev, ...data.completedTopics])]);
            }

            // Update completed topics
            if (data.masteredTopicId) {
                setCompletedTopics(prev => {
                    if (!prev.includes(data.masteredTopicId)) {
                        // toast.success(`Topic completed: ${data.masteredTopicName} 🏆`);
                        return [...prev, data.masteredTopicId];
                    }
                    return prev;
                });
            }

            // Update completed modules — from explicit masteredModuleId or full sync array
            if (data.masteredModuleId) {
                setCompletedModules(prev => {
                    if (!prev.includes(data.masteredModuleId)) {
                        // toast.success(`Module completed: ${data.masteredModuleName} 🌟`);
                        return [...prev, data.masteredModuleId];
                    }
                    return prev;
                });
            }
            if (data.completedModules?.length > 0) {
                setCompletedModules(prev => [...new Set([...prev, ...data.completedModules])]);
            }

            // Update current topic/subtopic indicator
            if (data.currentPosition) {
                setCurrentTopic(data.currentPosition.topicId || null);
                setCurrentSubtopic(data.currentPosition.subtopicId || null);
                setCurrentModulePathId(data.currentPosition.moduleId || null);
            }
        };

        // Position update from any chat response (not mastery specific)
        const handlePositionUpdate = (event) => {
            const pos = event.detail;
            if (pos?.subtopicId || pos?.topicId) {
                setCurrentTopic(pos.topicId || null);
                setCurrentSubtopic(pos.subtopicId || null);
                if (pos.moduleId) {
                    setCurrentModulePathId(pos.moduleId);
                    // Force the current session to own this mapped module when auto-advanced or newly started
                    if (currentSessionId) {
                        const moduleKey = sessionKeyFor('structured', pos.moduleId);
                        localStorage.setItem(moduleKey, currentSessionId);
                    }
                }
            }
        };

        window.addEventListener('tutor-progress-update', handleProgressUpdate);
        window.addEventListener('tutor-position-update', handlePositionUpdate);
        return () => {
            window.removeEventListener('tutor-progress-update', handleProgressUpdate);
            window.removeEventListener('tutor-position-update', handlePositionUpdate);
        };
    }, [currentSessionId, selectedSubject]);

    // Listen for quiz evaluation results from the chat AI
    const currentQuestionRef = useRef(null);
    useEffect(() => {
        currentQuestionRef.current = currentQuestion;
    }, [currentQuestion]);

    useEffect(() => {
        const handleQuizResult = (event) => {
            const { result, index: eventIdx, feedback, selectedOption } = event.detail; // result: 'correct' | 'incorrect'

            // Priority: index from event (captures state at time of sending), 
            // fallback to current ref.
            const idx = eventIdx !== undefined && eventIdx !== null
                ? eventIdx
                : currentQuestionRef.current?.index;

            if (idx !== undefined && idx !== null) {
                const topic = currentQuestionRef.current?.question?.topic;
                setQuestionResults(prev => {
                    // Logic for "Constant" score: Once marked correct, keep it.
                    // This prevents flip-flopping if the AI re-evaluates follow-up chat.
                    if (prev[idx]?.result === 'correct' && result === 'incorrect') return prev;
                    return { ...prev, [idx]: { result, feedback, topic, selectedOption } };
                });
            }
        };
        window.addEventListener('quiz-result', handleQuizResult);
        return () => window.removeEventListener('quiz-result', handleQuizResult);
    }, []);

    // Reset quiz: clear results + go back to question 1 (no page reload)
    const handleResetQuiz = useCallback(() => {
        const key = `quizResults_${selectedSubject || 'default'}`;
        const idxKey = `quizIndex_${selectedSubject || 'default'}`;
        localStorage.removeItem(key);
        localStorage.removeItem('quizResults_snapshot');
        localStorage.setItem(idxKey, '0'); // Force back to Q1
        setQuestionResults({});           // Clear in-memory results → QuizPanel re-renders at index 0
        setLocalQuizIndex(0);
        setBackendQuizIndex(0);           // Explicitly set to 0 to override any stale localStorage indices
    }, [selectedSubject]);

    // When the active quiz question changes, inject a STRICT document-grounded evaluator prompt
    const handleQuestionChange = useCallback((question, index, total) => {
        setCurrentQuestion({ question, index, total });
        if (question) {
            setSystemPrompt(
                `You are a strict and helpful quiz answer evaluator. 
Evaluate the student's answer strictly against the PROVIDED DOCUMENT ANSWER.

Question ${index + 1} of ${total}:
QUESTION: "${question.instruction}"
DOCUMENT ANSWER: "${question.output}"

STRICT OUTPUT FORMAT:
Evaluation: [✅ Correct] OR [❌ Needs Adjustment]

Analysis: [Provide a clear and detailed explanation of why the answer is correct or incorrect. If incorrect, explicitly state exactly what information from the document was missing or misrepresented in the student's answer.]

Source Fact: "[Insert a direct quote from the DOCUMENT ANSWER that contains the required information]".

Correction: [If "Needs Adjustment", provide the complete correct explanation based ONLY on the document. If "Correct", this section should say "Your answer matches the course material perfectly."]

Reflective Socratic Follow-up: [Provide a brief, open-ended question that prompts the student to think deeper about the concept, apply it to a new scenario, or reflect on why their answer differed from the expected model. This must be a Socratic question that helps them self-discover.]

Next Step: Click "Next" in the Quiz Panel to continue.

RULES:
1. ONLY mark "✅ Correct" if all essential concepts from the DOCUMENT ANSWER are present.
2. If the answer is vague, incomplete, or slightly off, mark "❌ Needs Adjustment".
3. Accuracy is paramount. Use ONLY the provided DOCUMENT ANSWER.
4. Always include a "Reflective Socratic Follow-up" question at the end of your analysis to guide the student towards deeper understanding, regardless of whether their answer was correct or needs adjustment.`
            );
        }
    }, [setSystemPrompt]);

    // Fetch available subjects/courses for topic-wise learning
    const fetchSubjects = useCallback(async () => {
        setIsLoadingSubjects(true);
        try {
            let response = await api.getSubjects();
            let subjects = Array.isArray(response.subjects) ? response.subjects : [];

            // One lightweight retry when first fetch returns empty (handles transient backend timeout)
            if (subjects.length === 0) {
                await new Promise(resolve => setTimeout(resolve, 400));
                response = await api.getSubjects();
                subjects = Array.isArray(response.subjects) ? response.subjects : [];
            }

            setAvailableSubjects(subjects);

            // Removed auto-select first subject to avoid polluting global state
            // and overriding "General Chat" as the default.
        } catch (error) {
            console.error("[TutorMode] Failed to load subjects:", error);
            toast.error("Failed to load available courses for study.");
        } finally {
            setIsLoadingSubjects(false);
        }
    }, []);

    useEffect(() => {
        fetchSubjects();
    }, [fetchSubjects]);

    const handleChatProcessingStatusChange = (isLoading) => {
        setIsChatProcessing(isLoading);
    };

    const handleLogout = () => {
        regularUserLogout();
        setGlobalSessionId(null);
        navigate('/');
    };

    const handleSelectSessionFromHistory = (sessionId, sessionMeta) => {
        if (sessionId && sessionId !== currentSessionId) {
            setGlobalSessionId(sessionId);
            // If the loaded session has a tutorModeType, switch to that mode
            if (sessionMeta?.tutorModeType && sessionMeta.tutorModeType !== tutorModeType) {
                setTutorModeType(sessionMeta.tutorModeType);
                setSystemPrompt('');
            }
            // Persist the loaded session for that mode and module
            const modeKey = sessionKeyFor(
                sessionMeta?.tutorModeType || tutorModeType,
                sessionMeta?.moduleId || currentModulePathId
            );
            localStorage.setItem(modeKey, sessionId);
            toast.success(`Session loaded.`);
        }
        setIsHistoryModalOpen(false);
    };

    const handleModuleSelect = (module) => {
        if (!module) return;
        setCurrentModulePathId(module.id);

        const moduleKey = sessionKeyFor('structured', module.id);
        const savedSession = localStorage.getItem(moduleKey);

        if (savedSession) {
            setGlobalSessionId(savedSession);
        } else {
            // Start fresh for the clicked module if no session exists yet
            handleNewChat((newSid) => {
                // No initial prompt - user will start the conversation
                if (newSid) {
                    localStorage.setItem(moduleKey, newSid);
                }
            }, true, true);
        }

        // Also start fresh for the quiz - new module means new focus
        handleResetQuiz();

        toast.success(`Starting module: ${module.name}`);
    };

    const handleTopicSelect = (topic) => {
        if (!topic) return;
        setCurrentTopic(topic.id);

        // No auto-prompt here either - wait for user
    };

    // Progress tracking - Sync with Backend (REPLACE local state, don't merge)
    const fetchProgress = useCallback(async () => {
        if (!selectedSubject) return;
        try {
            const response = await api.getProgress(selectedSubject);

            if (response?.success && response?.progress) {
                // REPLACE local state with backend truth (not union-merge)
                setCompletedSubtopics(response.progress.completedSubtopics || []);
                setCompletedTopics(response.progress.completedTopics || []);
                setCompletedModules(response.progress.completedModules || []);
            }
        } catch (err) {
            console.error("[TutorModePage] Failed to fetch progress from backend:", err);
            // Fall back to localStorage (already loaded on mount)
        }
    }, [selectedSubject]);

    // Position tracking - Resolve active Socratic position from backend
    const fetchTutorPosition = useCallback(async () => {
        if (!selectedSubject) {
            setCurrentTopic(null);
            setCurrentSubtopic(null);
            setCurrentModulePathId(null);
            return;
        }
        try {
            const res = await api.getTutorProgress(selectedSubject);
            if (res?.success && res?.position) {
                const pos = res.position;
                setCurrentTopic(pos.topicId || null);
                setCurrentSubtopic(pos.subtopicId || null);
                setCurrentModulePathId(pos.moduleId || null);

                // Force the current session to own this mapped module when loaded/restored
                if (currentSessionId && pos.moduleId) {
                    const moduleKey = sessionKeyFor('structured', pos.moduleId);
                    localStorage.setItem(moduleKey, currentSessionId);
                }
            }
        } catch (err) {
            console.error("[TutorModePage] Failed to fetch resolved tutor position on load:", err);
        }
    }, [selectedSubject, currentSessionId]);

    useEffect(() => {
        fetchProgress();
        fetchTutorPosition();
    }, [fetchProgress, fetchTutorPosition]);

    // Function to mark progress - can be called from chat when mastery is achieved
    const markSubtopicComplete = async (subtopicId) => {
        if (!completedSubtopics.includes(subtopicId)) {
            setCompletedSubtopics(prev => [...prev, subtopicId]);
            // toast.success('Subtopic mastered! 🎉');
            try {
                await api.updateProgress(selectedSubject, 'subtopic', subtopicId);
            } catch (err) { console.error("[TutorModePage] Sync error:", err); }
        }
    };

    const markTopicComplete = async (topicId) => {
        if (!completedTopics.includes(topicId)) {
            setCompletedTopics(prev => [...prev, topicId]);
            // toast.success('Topic completed! 🏆');
            try {
                await api.updateProgress(selectedSubject, 'topic', topicId);
            } catch (err) { console.error("[TutorModePage] Sync error:", err); }
        }
    };

    const markModuleComplete = async (moduleId) => {
        if (!completedModules.includes(moduleId)) {
            setCompletedModules(prev => [...prev, moduleId]);
            // toast.success('Module completed! 🌟');
            try {
                await api.updateProgress(selectedSubject, 'module', moduleId);
            } catch (err) { console.error("[TutorModePage] Sync error:", err); }
        }
    };

    return (
        <div className="flex flex-col h-screen overflow-hidden bg-background-light dark:bg-background-dark font-sans relative">
            {isSessionLoading && <SessionLoadingModal />}

            <TopNav
                user={regularUser}
                onLogout={handleLogout}
                onNewChat={handleNewChat}
                onHistoryClick={() => setIsHistoryModalOpen(true)}
                orchestratorStatus={orchestratorStatus}
                isChatProcessing={isChatProcessing}
            />

            <main className="flex-1 flex flex-col overflow-hidden pt-16 relative">
                {/* Page Header - Minimal */}
                <div className="bg-[#0d0d0d] border-b border-[#4a4a4a] px-4 sm:px-6 py-2.5 flex items-center justify-between z-10">
                    <div className="flex items-center gap-3">
                        {/* Back Button */}
                        <Link
                            to="/"
                            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 transition-all"
                            onClick={(e) => {
                                e.preventDefault();
                                setTutorMode(false);
                                setSelectedSubject(null); // Reset to General Chat
                                handleNewChat(() => {
                                    navigate('/');
                                }, true, true);
                            }}
                            title="Exit Tutor Mode"
                        >
                            <ArrowLeft size={18} />
                        </Link>

                        <div className="h-5 w-px bg-white/10" />

                        {/* Tutor Mode Label */}
                        <div className="flex items-center gap-2">
                            <GraduationCap size={18} className="text-teal-400" />
                            <span className="text-sm font-semibold text-white">Tutor Mode</span>
                            {selectedSubject && (
                                <>
                                    <span className="text-gray-500">·</span>
                                    <span className="text-sm text-gray-400">{selectedSubject}</span>
                                </>
                            )}
                        </div>

                        <div className="h-5 w-px bg-white/10" />

                        {/* Roadmap Session Title */}
                        <div className="flex flex-col">
                            <h1 className="text-white text-sm font-bold tracking-tight uppercase flex items-center gap-2">
                                <Target size={14} className="text-teal-400" />
                                {isCourseStructuredMode ? 'Module Roadmap' : 'General Socratic Mode'}
                            </h1>
                            <p className="text-[10px] text-gray-400 font-medium">
                                {isCourseStructuredMode
                                    ? 'Socratic Learning Environment'
                                    : 'Explore any topic. I’ll guide you Socratically.'}
                            </p>
                        </div>
                    </div>

                    {/* Right Controls */}
                    <div className="flex items-center gap-2">

                        {/* Subject Selector - Compact */}
                        <select
                            data-tutor-tour="subject-select"
                            value={selectedSubject || ''}
                            onChange={(e) => setSelectedSubject(e.target.value || null)}
                            disabled={isLoadingSubjects}
                            className="text-sm px-3 py-1.5 rounded-md bg-[#1a1a1a] border border-[#4a4a4a] text-white focus:outline-none focus:border-[#666666] cursor-pointer shadow-[0_2px_4px_rgba(0,0,0,0.3)]"
                        >
                            {isLoadingSubjects ? (
                                <option value="" className="bg-gray-800">Loading...</option>
                            ) : (
                                <>
                                    <option value="" className="bg-gray-800">General</option>
                                    {availableSubjects.map((subject) => (
                                        <option key={subject} value={subject} className="bg-gray-800">
                                            {subject}
                                        </option>
                                    ))}
                                </>
                            )}
                        </select>

                        {/* Curriculum Toggle */}
                        {isCourseStructuredMode && (
                            <button
                                onClick={() => setShowCurriculumPanel(!showCurriculumPanel)}
                                className={`p-2 rounded-lg transition-all ${showCurriculumPanel
                                    ? 'bg-teal-500/15 text-teal-400'
                                    : 'text-gray-500 hover:text-white hover:bg-white/5'
                                    }`}
                                title={showCurriculumPanel ? 'Hide Curriculum' : 'Show Curriculum'}
                            >
                                {showCurriculumPanel ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
                            </button>
                        )}
                    </div>

                </div>

                {/* Two-column layout: Chat + Curriculum Panel */}
                <div className="flex-1 flex overflow-hidden">
                    {/* Main Chat Section */}
                    <div className="flex-1 flex justify-center overflow-hidden">
                        <Animate
                            animation="slide-up"
                            duration="0.5s"
                            className="w-full flex flex-col h-full bg-transparent relative overflow-hidden"
                        >
                            <CenterPanel
                                messages={messages}
                                setMessages={setMessages}
                                currentSessionId={currentSessionId}
                                onChatProcessingChange={handleChatProcessingStatusChange}
                                initialPromptForNewSession={initialPromptForNewSession}
                                setInitialPromptForNewSession={setInitialPromptForNewSession}
                                initialActivityForNewSession={initialActivityForNewSession}
                                setInitialActivityForNewSession={setInitialActivityForNewSession}
                                tutorModeType={tutorModeType}
                                currentQuestionIndex={currentQuestion?.index}
                                currentModulePathId={currentModulePathId}
                            />
                        </Animate>
                    </div>

                    {/* Right Panel Wrapper */}
                        {showCurriculumPanel && isCourseStructuredMode && (
                            <div
                                data-tutor-tour="roadmap-panel"
                                style={{ width: 340 }}
                                className="h-full border-l border-[#4a4a4a] flex flex-col bg-[#1a1a1a] overflow-hidden flex-shrink-0 transition-all duration-300 shadow-[-4px_0_12px_rgba(0,0,0,0.3)]"
                            >
                                {/* Tab Header */}
                                <div className="flex-shrink-0 flex items-center p-1 bg-black/10 border-b border-white/5 mx-3 mt-3 rounded-lg">
                                    <button
                                        data-tutor-tour="roadmap-tab"
                                        onClick={() => setRightPanelTab('roadmap')}
                                        className={`flex-1 flex items-center justify-center gap-2 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all ${rightPanelTab === 'roadmap'
                                            ? 'bg-purple-500/20 text-purple-300 shadow-sm'
                                            : 'text-gray-500 hover:text-gray-400'
                                            }`}
                                    >
                                        <BookOpen size={12} /> Roadmap
                                    </button>
                                    <button
                                        data-tutor-tour="quiz-tab"
                                        onClick={() => setRightPanelTab('quiz')}
                                        className={`flex-1 flex items-center justify-center gap-2 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all ${rightPanelTab === 'quiz'
                                            ? 'bg-teal-500/20 text-teal-300 shadow-sm'
                                            : 'text-gray-500 hover:text-gray-400'
                                            }`}
                                    >
                                        <Brain size={12} /> Practice Quiz
                                    </button>
                                </div>

                                {/* Content Area */}
                                <div className="flex-1 overflow-hidden">
                                    {rightPanelTab === 'roadmap' ? (
                                        <CurriculumPanel
                                            selectedCourse={selectedSubject}
                                            currentTopic={currentTopic}
                                            currentSubtopic={currentSubtopic}
                                            completedSubtopics={completedSubtopics}
                                            completedTopics={completedTopics}
                                            completedModules={completedModules}
                                            onTopicSelect={handleTopicSelect}
                                            onModuleSelect={handleModuleSelect}
                                        />
                                    ) : (
                                        <QuizPanel
                                            selectedCourse={selectedSubject}
                                            moduleId={currentModulePathId}
                                            onQuestionChange={handleQuestionChange}
                                            questionResults={questionResults}
                                            onResetQuiz={handleResetQuiz}
                                            initialQuizIndex={backendQuizIndex}
                                            onIndexChange={setLocalQuizIndex}
                                            systemPrompt={systemPrompt}
                                        />
                                    )}
                                </div>
                            </div>
                        )}
                </div>
            </main>

            <ChatHistoryModal
                isOpen={isHistoryModalOpen}
                onClose={() => setIsHistoryModalOpen(false)}
                onSelectSession={handleSelectSessionFromHistory}
                filterMode="tutor"
            />

        </div>
    );
}

export default TutorModePage;
