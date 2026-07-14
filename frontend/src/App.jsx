// frontend/src/App.jsx
import React, { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useAuth as useRegularAuth } from './hooks/useAuth.jsx';
import { useAppState } from './contexts/AppStateContext.jsx';
import { DeepResearchProvider } from './contexts/DeepResearchContext.jsx';
import AuthModal from './components/auth/AuthModal.jsx';
import TopNav from './components/layout/TopNav.jsx';
import LeftPanel from './components/layout/LeftPanel.jsx';
import CenterPanel from './components/layout/CenterPanel.jsx';
import RightPanel from './components/layout/RightPanel.jsx';
import LeftCollapsedNav from './components/layout/LeftCollapsedNav.jsx';
import RightCollapsedNav from './components/layout/RightCollapsedNav.jsx';
import CourseViewerPanel from './components/course/CourseViewerPanel.jsx';
import api from './services/api.js';
import toast from 'react-hot-toast';
import { GraduationCap, AlertCircle } from 'lucide-react';
import Animate from './components/core/Animate.jsx';
import Button from './components/core/Button.jsx';
import Modal from './components/core/Modal.jsx';
const LandingPage = React.lazy(() => import('./components/landing/LandingPage.jsx'));
// Onboarding tours removed for cleaner UX
import { useBadgeSocket } from './hooks/useBadgeSocket.js';
import BadgeTotem from './components/gamification/BadgeTotem.jsx';

// --- Code-split heavy pages (Monaco ~2MB, pdfjs ~700KB, vis-network ~500KB, etc.) ---
const AdminDashboardPage   = React.lazy(() => import('./components/admin/AdminDashboardPage.jsx'));
const AdminProtectedRoute  = React.lazy(() => import('./components/admin/AdminProtectedRoute.jsx'));
const CodeExecutorPage     = React.lazy(() => import('./components/tools/CodeExecutorPage.jsx'));
const StudyPlanPage        = React.lazy(() => import('./components/learning/StudyPlanPage.jsx'));
const QuizGeneratorPage    = React.lazy(() => import('./components/tools/QuizGeneratorPage.jsx'));
const AcademicIntegrityPage = React.lazy(() => import('./components/tools/AcademicIntegrityPage.jsx'));
const AnalyticsDashboardPage = React.lazy(() => import('./components/admin/AnalyticsDashboardPage.jsx'));
const BountyCreditsPage    = React.lazy(() => import('./components/gamification/BountyCreditsPage.jsx'));
const BossBattles          = React.lazy(() => import('./components/gamification/BossBattles.jsx'));
const BadgesShowcase       = React.lazy(() => import('./components/gamification/BadgesShowcase.jsx'));
const LearningProfile      = React.lazy(() => import('./components/learning/LearningProfile.jsx'));
const SkillTreeMap         = React.lazy(() => import('./components/gamification/SkillTreeMap.jsx'));
const SkillTreeLanding     = React.lazy(() => import('./components/gamification/SkillTreeLanding.jsx'));
const SkillTreeGameMap     = React.lazy(() => import('./components/gamification/SkillTreeGameMap.jsx'));
const SkillTreeGames       = React.lazy(() => import('./components/gamification/SkillTreeGames.jsx'));
const SkillTreeCsvUpload   = React.lazy(() => import('./components/gamification/SkillTreeCourseSelectorWrapper.jsx'));
const TutorModePage        = React.lazy(() => import('./components/tutor/TutorModePage.jsx'));
const DeepResearchPage     = React.lazy(() => import('./components/research/DeepResearchPage.jsx'));
const CourseExplorerPage   = React.lazy(() => import('./components/course/CourseExplorerPage.jsx'));
const ResearchHistory      = React.lazy(() => import('./components/research/ResearchHistory.jsx'));
const ResearchDetailView   = React.lazy(() => import('./components/research/ResearchDetailView.jsx'));
const KnowledgeAssessmentPage = React.lazy(() => import('./components/assessment/KnowledgeAssessmentPage.jsx'));



function SessionLoadingModal() {
    return (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[9999]">
            <Animate
                animation="scale-in"
                className="bg-white dark:bg-black rounded-xl shadow-2xl p-8 w-full max-w-md text-center border-2 border-black dark:border-white"
            >
                <div className="flex justify-center items-center mb-4">
                    <div className="animate-spin rounded-full h-10 w-10 border-t-4 border-b-4 border-black dark:border-white"></div>
                </div>
                <h2 className="text-xl font-bold text-text-light dark:text-text-dark mb-2">Finalizing Session...</h2>
                <p className="text-sm text-text-muted-light dark:text-text-muted-dark">
                    Summarizing key points and identifying topics for your future recommendations.
                </p>
            </Animate>
        </div>
    );
}

function MainAppLayout({
    orchestratorStatus,
    handleNewChat,
    isSessionLoading,
    messages,
    setMessages,
    isTutorPage = false
}) {
    const location = useLocation();
    const navigate = useNavigate();
    const { user: regularUser, logout: regularUserLogout } = useRegularAuth();
    const {
        currentSessionId,
        isLeftPanelOpen,
        setIsLeftPanelOpen,
        isRightPanelOpen,
        setSessionId: setGlobalSessionId,
        initialPromptForNewSession,
        setInitialPromptForNewSession,
        initialActivityForNewSession,
        setInitialActivityForNewSession,
        tutorMode,
        setTutorMode,
        setTutorModeType,
        setSelectedSubject,
        lastGeneralSessionId,
        setLastGeneralSessionId,
        lastTutorSessionId,
        setLastTutorSessionId
    } = useAppState();

    const [isChatProcessing, setIsChatProcessing] = useState(false);

    const handleChatProcessingStatusChange = (isLoading) => {
        setIsChatProcessing(isLoading);
    };

    const handleRegularUserLogout = () => {
        regularUserLogout();
        setGlobalSessionId(null);
    };

    const handleSelectSessionFromHistory = (sessionId, sessionMeta = {}) => {
        if (sessionId && sessionId !== currentSessionId) {
            sessionStorage.setItem('historySessionLoadTs', String(Date.now()));
            setGlobalSessionId(sessionId);

            // Auto-enable tutor mode and navigate to /tutor if session was tutor
            if (sessionMeta.isTutorMode) {
                setTutorMode(true);
                const inferredTutorModeType = sessionMeta.tutorModeType
                    || ((sessionMeta.courseName && sessionMeta.courseName !== 'General') ? 'structured' : 'general_socratic');
                setTutorModeType(inferredTutorModeType);
                if (sessionMeta.courseName) {
                    setSelectedSubject(sessionMeta.courseName === 'General' ? null : sessionMeta.courseName);
                } else {
                    setSelectedSubject(null);
                }
                navigate('/tutor');
                toast.success(`Loading tutor session...`);
            } else {
                setTutorMode(false);
                setTutorModeType(null);
                setSelectedSubject(null);
                navigate('/');
                toast.success(`Loading session...`);
            }
        }
    };

    // CourseViewerPanel -> chat: injects prompt as next user message
    const handleCourseChat = useCallback((prompt) => {
        setInitialPromptForNewSession(prompt);
    }, [setInitialPromptForNewSession]);

    return (
        <>
            {isSessionLoading && <SessionLoadingModal />}

            <TopNav
                user={regularUser}
                onLogout={handleRegularUserLogout}
                onNewChat={handleNewChat}
                onHistoryClick={() => setIsLeftPanelOpen(true)}
                orchestratorStatus={orchestratorStatus}
                isChatProcessing={isChatProcessing}
            />
            {/* AppLayout */}
            <div className="flex flex-1 overflow-hidden pt-11 relative" style={{ background: 'var(--vs-bg)' }}>
                {/* MainChatArea */}
                <div className="flex-1 flex overflow-hidden min-w-0">
                    {isLeftPanelOpen ? (
                        <aside className="w-full md:w-72 lg:w-80 xl:w-96 overflow-y-auto p-3 sm:p-4 flex-shrink-0 custom-scrollbar transition-transform duration-300 ease-out" style={{ background: 'var(--vs-sidebar)', borderRight: '1px solid var(--vs-border)' }}>
                            <LeftPanel
                                isChatProcessing={isChatProcessing}
                                currentSessionId={currentSessionId}
                                handleSelectSessionFromHistory={handleSelectSessionFromHistory}
                            />
                        </aside>
                    ) : (
                        <LeftCollapsedNav
                            isChatProcessing={isChatProcessing}
                            onHistoryClick={() => setIsLeftPanelOpen(true)}
                            onKnowledgeBaseClick={() => setIsLeftPanelOpen(true)}
                        />
                    )}

                    <main className={`flex-1 flex flex-col overflow-hidden p-0 sm:p-2 md:p-4 transition-all duration-300 ease-in-out ${isLeftPanelOpen ? 'lg:ml-0' : 'ml-14 lg:ml-16 md:ml-14'} ${isRightPanelOpen ? 'lg:mr-0' : 'lg:mr-16 md:mr-14'}`}>
                        <CenterPanel
                            messages={messages}
                            setMessages={setMessages}
                            currentSessionId={currentSessionId}
                            onChatProcessingChange={handleChatProcessingStatusChange}
                            initialPromptForNewSession={initialPromptForNewSession}
                            setInitialPromptForNewSession={setInitialPromptForNewSession}
                            initialActivityForNewSession={initialActivityForNewSession}
                            setInitialActivityForNewSession={setInitialActivityForNewSession}
                        />
                    </main>

                    {isRightPanelOpen ? (
                        <aside className="hidden md:flex md:flex-col md:w-72 lg:w-80 xl:w-96 overflow-y-auto p-3 sm:p-4 flex-shrink-0 custom-scrollbar transition-transform duration-300 ease-out" style={{ background: 'var(--vs-sidebar)', borderLeft: '1px solid var(--vs-border)' }}>
                            <RightPanel isChatProcessing={isChatProcessing} />
                        </aside>
                    ) : (<RightCollapsedNav isChatProcessing={isChatProcessing} />)}
                </div>
            </div>

            {/* FloatingModals */}
            <CourseViewerPanel onChatMessage={handleCourseChat} />
        </>
    );
}

function App() {
    const { token: regularUserToken, user: regularUser, loading: regularUserAuthLoading, setUser: setRegularUserInAuthContext } = useRegularAuth();
    const {
        theme,
        setSessionId: setGlobalSessionId,
        currentSessionId,
        isAdminSessionActive,
        setIsAdminSessionActive,
        tutorMode,
        setTutorMode,
        setTutorModeType,
        setLastGeneralSessionId,
        setLastTutorSessionId
    } = useAppState();
    const navigate = useNavigate();
    const location = useLocation();
    const [appInitializing, setAppInitializing] = useState(true);
    const [showAuthModal, setShowAuthModal] = useState(false);
    const [isLoginViewInModal, setIsLoginViewInModal] = useState(true);
    const [orchestratorStatus, setOrchestratorStatus] = useState({ status: "loading", message: "Connecting..." });
    const [isSessionLoading, setIsSessionLoading] = useState(false);
    const [appStateMessages, setAppStateMessages] = useState([]);
    const isCreatingSessionRef = useRef(false);
    const [isSessionErrorModalOpen, setIsSessionErrorModalOpen] = useState(false);
    const { newBadge, clearBadge } = useBadgeSocket();


    const handleNewChat = useCallback(async (callback, forceNewChat = false, skipSessionAnalysis = false) => {

        const actualCallback = typeof callback === 'function' ? callback : null;
        const messages = appStateMessages;

        if (!forceNewChat && messages.length === 0 && currentSessionId) {
            toast('This is already a new chat!', { icon: '✨' });
            if (actualCallback) actualCallback(currentSessionId);
            return;
        }
        // --- MANDATORY: Clear state for isolation ---
        setAppStateMessages([]);

        // Only reset tutor mode if we're not currently on the tutor page
        if (!location.pathname.startsWith('/tutor')) {
            setTutorMode(false);
            setTutorModeType(null);
        }
        setIsSessionLoading(true);
        try {
            const data = await api.startNewSession(currentSessionId, skipSessionAnalysis);
            if (data && data.newSessionId) {
                setGlobalSessionId(data.newSessionId);
                if (data.studyPlanSuggestion) {
                    const { topic, reason } = data.studyPlanSuggestion;
                    toast.custom((t) => (
                        <Animate
                            animation="slide-down"
                            className="bg-white dark:bg-black shadow-lg rounded-lg p-4 w-96 border border-black dark:border-white"
                        >
                            <div className="flex items-start">
                                <div className="flex-shrink-0 pt-0.5"><GraduationCap className="h-6 w-6 text-black dark:text-white" /></div>
                                <div className="ml-3 flex-1">
                                    <p className="text-sm font-semibold text-text-light dark:text-text-dark">Personalized Study Plan Suggestion</p>
                                    <p className="mt-1 text-sm text-text-muted-light dark:text-text-muted-dark">{reason}</p>
                                    <div className="mt-4 flex gap-2">
                                        <button className="px-3 py-1 bg-black text-white dark:bg-white dark:text-black rounded-md text-sm font-semibold hover:opacity-80 transition-opacity" onClick={() => { navigate('/study-plan', { state: { prefilledGoal: topic } }); toast.dismiss(t.id); }}>
                                            Create Plan for "{topic}"
                                        </button>
                                        <button className="px-3 py-1 bg-white text-black dark:bg-black dark:text-white border border-black dark:border-white rounded-md text-sm font-semibold hover:opacity-80 transition-opacity" onClick={() => toast.dismiss(t.id)}>Dismiss</button>
                                    </div>
                                </div>
                            </div>
                        </Animate>
                    ), { id: `study-plan-toast-${topic}`, duration: Infinity });
                }
                if (actualCallback) {
                    if (!skipSessionAnalysis) {
                        toast.success("New chat started!");
                    }
                    actualCallback(data.newSessionId);
                } else if (!skipSessionAnalysis) {
                    // If no callback, but it's a user-initiated new chat, still show the toast.
                    toast.success("New chat started!");
                }
            } else {
                toast.error(data.message || "Could not start new chat session.");
                if (actualCallback) actualCallback(null);
            }
        } catch (error) {
            toast.error(`I couldn't start a new session right now. The AI service might be busy. Please try again in a moment!`);
            setIsSessionErrorModalOpen(true);
            if (actualCallback) actualCallback(null);
        } finally {
            setIsSessionLoading(false);
        }
    }, [currentSessionId, setGlobalSessionId, navigate, appStateMessages]);

    const fetchChatHistory = useCallback(async (sid) => {
        if (!sid || !regularUserToken) {
            setAppStateMessages([]);
            return;
        }
        try {
            const sessionData = await api.getChatHistory(sid);
            setAppStateMessages(Array.isArray(sessionData.messages) ? sessionData.messages : []);
        } catch (error) {
            if (error.response && error.response.status === 404) {
                console.warn("Stale session ID found. It will be replaced.");
                localStorage.removeItem('aiTutorSessionId');
                setGlobalSessionId(null);
            } else {
                toast.error(`History load failed: ${error.message}`);
            }
        }
    }, [regularUserToken, setGlobalSessionId]);

    useEffect(() => {
        if (currentSessionId && regularUserToken) {
            setAppStateMessages([]); // Clear stale messages immediately
            fetchChatHistory(currentSessionId);
        } else if (!regularUserToken) {
            setAppStateMessages([]);
        }
    }, [currentSessionId, regularUserToken, fetchChatHistory]);

    useEffect(() => {
        const isCurrentlyTutor = location.pathname.startsWith('/tutor');
        const historyLoadTs = Number(sessionStorage.getItem('historySessionLoadTs') || 0);
        const fromHistoryLoad = historyLoadTs > 0 && (Date.now() - historyLoadTs) < 8000;

        if (isCurrentlyTutor) {
            // Entering Tutor Mode
            if (!tutorMode) {
                setAppStateMessages([]); // Instant UI clear
                if (currentSessionId) {
                    localStorage.setItem('lastGeneralSessionId', currentSessionId);
                    setLastGeneralSessionId(currentSessionId);
                }

                if (!fromHistoryLoad) {
                    handleNewChat(null, true, true);
                }
            }
            setTutorMode(true);
        } else {
            // Entering General mode
            if (tutorMode) {
                setAppStateMessages([]); // Instant UI clear
                if (currentSessionId) {
                    localStorage.setItem('lastTutorSessionId', currentSessionId);
                    setLastTutorSessionId(currentSessionId);
                }

                if (!fromHistoryLoad) {
                    handleNewChat(null, true, true);
                }
            }
            setTutorMode(false);
            setTutorModeType(null);
        }

    }, [location.pathname, tutorMode, setTutorMode, setTutorModeType, handleNewChat, currentSessionId, setLastGeneralSessionId, setLastTutorSessionId]);

    useEffect(() => { document.documentElement.className = theme; }, [theme]);
    useEffect(() => { api.getOrchestratorStatus().then(setOrchestratorStatus); }, []);

    useEffect(() => {
        const handleAuthAndSession = async () => {
            if (isAdminSessionActive) {
                setAppInitializing(false); setShowAuthModal(false);
                // Ensure no overlays block admin dashboard
                setIsSessionLoading(false);
                if (!location.pathname.startsWith('/admin')) navigate('/admin/dashboard', { replace: true });
                return;
            }
            if (regularUserAuthLoading) {
                setAppInitializing(true); return;
            }
            setAppInitializing(false);

            if (regularUserToken && regularUser) {
                setShowAuthModal(false);
                document.body.classList.remove('landing-page-body');

                // Don't redirect an active admin session away from /admin even if
                // verifyTokenAndLoadUser also resolved them as a regular user.
                if (location.pathname.startsWith('/admin') && !isAdminSessionActive) navigate('/', { replace: true });

                const shouldCreateSession = !currentSessionId && !location.pathname.startsWith('/tools') && !location.pathname.startsWith('/study-plan');
                if (shouldCreateSession && !isCreatingSessionRef.current) {
                    isCreatingSessionRef.current = true;
                    await handleNewChat(() => { }, true, true);
                    isCreatingSessionRef.current = false;
                }
            } else {
                document.body.classList.add('landing-page-body');
            }
        };
        handleAuthAndSession();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        regularUserAuthLoading, regularUserToken, regularUser, isAdminSessionActive,
        currentSessionId, navigate, location.pathname
    ]);

    const handleAuthSuccess = (authData) => {
        setShowAuthModal(false);
        if (authData?.isAdminLogin) {
            setIsAdminSessionActive(true);
        } else if (authData?.token) {
            setGlobalSessionId(null);
            if (authData.email && authData._id) {
                const userForContext = {
                    id: authData._id,
                    email: authData.email,
                    username: authData.username,
                    hasCompletedOnboarding: authData.hasCompletedOnboarding
                };
                setRegularUserInAuthContext(userForContext);
                // The main useEffect will handle onboarding check
            }
        }
    };

    const openAuthModal = (isLogin = true) => {
        setIsLoginViewInModal(isLogin);
        setShowAuthModal(true);
    };

    if (appInitializing) {
        return (
            <div className="fixed inset-0 flex items-center justify-center bg-white dark:bg-black">
                <div className="animate-spin rounded-full h-12 w-12 border-t-4 border-b-4 border-black dark:border-white"></div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-screen overflow-hidden font-sans">
            <BadgeTotem badge={newBadge} onComplete={clearBadge} />
            {showAuthModal && (
                <AuthModal
                    isOpen={showAuthModal}
                    onClose={handleAuthSuccess}
                    initialViewIsLogin={isLoginViewInModal}
                />
            )}

            <Suspense fallback={<div className="fixed inset-0 flex items-center justify-center bg-white dark:bg-black"><div className="animate-spin rounded-full h-12 w-12 border-t-4 border-b-4 border-black dark:border-white"></div></div>}>
            <Routes>
                {isAdminSessionActive ? (
                    <>
                        <Route path="/admin/dashboard" element={<AdminProtectedRoute><AdminDashboardPage /></AdminProtectedRoute>} />
                        <Route path="/admin/analytics" element={<AdminProtectedRoute><AnalyticsDashboardPage /></AdminProtectedRoute>} />
                        <Route path="/*" element={<Navigate to="/admin/dashboard" replace />} />
                    </>
                ) : regularUserToken && regularUser ? (
                    <>
                        <Route path="/tools/code-executor" element={<CodeExecutorPage />} />
                        <Route path="/study-plan" element={<StudyPlanPage handleNewChat={handleNewChat} />} />
                        <Route path="/tools/quiz-generator" element={<QuizGeneratorPage />} />
                        <Route path="/tools/integrity-checker" element={<AcademicIntegrityPage />} />
                        <Route path="/tools/deep-research" element={<DeepResearchPage />} />
                        <Route path="/tools/deep-research/history" element={<ResearchHistory />} />
                        <Route path="/tools/deep-research/view/:id" element={<ResearchDetailView />} />
                        <Route path="/courses" element={<CourseExplorerPage />} />
                        <Route path="/assessment" element={<KnowledgeAssessmentPage />} />
                        {/* Gamification Routes */}
                        <Route path="/gamification/bounties" element={<BountyCreditsPage />} />
                        <Route path="/gamification/credits" element={<BountyCreditsPage />} />
                        <Route path="/gamification/boss-battles" element={<BossBattles />} />
                        <Route path="/gamification/badges" element={<BadgesShowcase />} />
                        <Route path="/learning-profile" element={<LearningProfile />} />
                        <Route path="/gamification/skill-tree" element={<SkillTreeGames />} />
                        <Route path="/gamification/skill-tree/new" element={<SkillTreeLanding />} />
                        <Route path="/gamification/skill-tree/upload" element={<SkillTreeCsvUpload />} />
                        <Route path="/gamification/skill-tree/map" element={<SkillTreeGameMap />} />
                        <Route path="/gamification/skill-tree/classic" element={<SkillTreeMap />} />
                        <Route path="/admin/dashboard" element={<Navigate to="/" replace />} />
                        <Route path="/tutor" element={
                            <TutorModePage
                                orchestratorStatus={orchestratorStatus}
                                handleNewChat={handleNewChat}
                                isSessionLoading={isSessionLoading}
                                messages={appStateMessages}
                                setMessages={setAppStateMessages}
                            />
                        } />
                        <Route path="/*" element={
                            <MainAppLayout
                                orchestratorStatus={orchestratorStatus}
                                handleNewChat={handleNewChat}
                                isSessionLoading={isSessionLoading}
                                messages={appStateMessages}
                                setMessages={setAppStateMessages}
                            />
                        } />
                    </>
                ) : (
                    <Route path="/*" element={<LandingPage onLoginClick={openAuthModal} />} />
                )}
            </Routes>
            </Suspense>

            <Modal
                isOpen={isSessionErrorModalOpen}
                onClose={() => setIsSessionErrorModalOpen(false)}
                title="Service Status"
            >
                <div className="flex flex-col items-center text-center p-2">
                    <div className="bg-red-500/10 p-4 rounded-full mb-4">
                        <AlertCircle className="text-red-500" size={40} />
                    </div>
                    <h3 className="text-xl font-bold text-text-light dark:text-text-dark mb-2">Service Busy</h3>
                    <p className="text-text-muted-light dark:text-text-muted-dark mb-6 leading-relaxed">
                        iMentor is receiving an unusually high number of requests.
                        We couldn't start your new session just yet. Please try again in a few seconds.
                    </p>
                    <Button
                        variant="primary"
                        className="w-full"
                        onClick={() => setIsSessionErrorModalOpen(false)}
                    >
                        Got it
                    </Button>
                </div>
            </Modal>
        </div>
    );
}

function AppWrapper() {
    return (
        <Router>
            <DeepResearchProvider>
               <App />
            </DeepResearchProvider>
        </Router>
    );
}

export default AppWrapper;