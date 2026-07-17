// frontend/src/components/layout/CenterPanel.jsx
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import ChatHistory from '../chat/ChatHistory';
import ChatInput from '../chat/ChatInput';
import PromptCoachModal from '../chat/PromptCoachModal.jsx';
import Modal from '../core/Modal.jsx';
import Button from '../core/Button.jsx';
import api from '../../services/api';
import { useAuth as useRegularAuth } from '../../hooks/useAuth';
import { useAppState } from '../../contexts/AppStateContext';
import { useDeepResearch } from '../../contexts/DeepResearchContext';
import toast from 'react-hot-toast';
import Animate from '../core/Animate.jsx';
import {
    BookMarked,
    Code,
    Sparkles,
    ChevronRight,
    Flame,
    CheckCircle,
    XCircle,
    X,
    MapPin,
    Zap,
    AlertCircle
} from 'lucide-react';

import DeepResearchPanel from '../research/DeepResearchPanel';
import OrchestratorMonitor from '../debug/OrchestratorMonitor.jsx';

const features = [
    {
        icon: MapPin,
        title: 'Skill Tree Map',
        description: 'Explore your learning journey with an interactive fog-of-war map. Master skills to unlock new paths!',
        path: '/gamification/skill-tree',
        status: 'active',
        glowColor: 'cyan'
    },
    {
        icon: Zap,
        title: "Deep Research Mode",
        description: "AI-driven comprehensive research with synthesis, fact-checking, and citation analysis.",
        path: '/tools/deep-research',
        status: 'active',
        glowColor: 'blue',
        desktopOnly: true   // not shown on mobile
    },
    {
        icon: BookMarked,
        title: "Courses",
        description: "Browse admin-curated course content and explore complete lecture notes with AI-powered search.",
        path: '/courses',
        status: 'active',
        glowColor: 'purple'
    }
];

// VS Code style: all cards use the same neutral hover — no per-card accent hues
const glowStyles = {
    blue: "", green: "", red: "", purple: "",
    orange: "", yellow: "", cyan: "", gray: ""
};

// Typewriter effect component for welcome text
const TypewriterText = ({ text, className, delay = 0, speed = 50, onComplete }) => {
    const [displayedText, setDisplayedText] = useState('');
    const [isComplete, setIsComplete] = useState(false);

    useEffect(() => {
        let timeout;
        const startTyping = () => {
            let currentIndex = 0;
            const typeNextChar = () => {
                if (currentIndex < text.length) {
                    setDisplayedText(text.slice(0, currentIndex + 1));
                    currentIndex++;
                    timeout = setTimeout(typeNextChar, speed);
                } else {
                    setIsComplete(true);
                    if (onComplete) onComplete();
                }
            };
            typeNextChar();
        };

        const delayTimeout = setTimeout(startTyping, delay);

        return () => {
            clearTimeout(delayTimeout);
            clearTimeout(timeout);
        };
    }, [text, delay, speed, onComplete]);

    return (
        <span className={className}>
            {displayedText}
            {!isComplete && (
                <span className="inline-block w-[3px] h-[1em] bg-current ml-1 animate-pulse" />
            )}
        </span>
    );
};

function CenterPanel({ messages, setMessages, currentSessionId, onChatProcessingChange, initialPromptForNewSession, setInitialPromptForNewSession, initialActivityForNewSession, setInitialActivityForNewSession, tutorModeType, currentQuestionIndex, currentModulePathId }) {
    const navigate = useNavigate();
    const location = useLocation();
    const { token: regularUserToken, user: regularUser } = useRegularAuth();
    const { setSelectedSubject, systemPrompt, selectedDocumentForAnalysis, selectedSubject, tutorMode: contextTutorMode, setTutorMode, tutorModeType: contextTutorModeType } = useAppState();
    const { isResearchMode, setQuery: setResearchQuery, setPipelineStage, handleResearchUpdate } = useDeepResearch();

    // Explicitly check route to avoid state race conditions during mode switches
    const isTutorRoute = location.pathname.startsWith('/tutor');
    const tutorMode = contextTutorMode || isTutorRoute;
    const effectiveTutorModeType = tutorModeType || contextTutorModeType || (isTutorRoute ? (selectedSubject ? 'structured' : 'general_socratic') : null);

    const [useWebSearch, setUseWebSearch] = useState(false);
    const [useAcademicSearch, setUseAcademicSearch] = useState(false);
    const [criticalThinkingEnabled, setCriticalThinkingEnabled] = useState(false);
    const [isActuallySendingAPI, setIsActuallySendingAPI] = useState(false);
    const abortControllerRef = useRef(null);
    const [recommendations, setRecommendations] = useState([]);
    const [isLoadingRecs, setIsLoadingRecs] = useState(true);
    const [isCoachModalOpen, setIsCoachModalOpen] = useState(false);
    const [coachData, setCoachData] = useState(null);
    const [activeBountyId, setActiveBountyId] = useState(null);
    const [activeBountyMetadata, setActiveBountyMetadata] = useState(null);
    const [isErrorModalOpen, setIsErrorModalOpen] = useState(false);
    const [lastErrorMessage, setLastErrorMessage] = useState('');
    const [latestDebugData, setLatestDebugData] = useState(null);
    const [debugFeatureFlags, setDebugFeatureFlags] = useState(null);
    const isUserAborted = useRef(false);
    // Track the question index at the moment the message was sent
    const capturedIndexRef = useRef(null);
    // Prevent firing the auto-greeting more than once per session
    const hasAutoGreetedRef = useRef(false);

    const isAdminFromToken = useMemo(() => {
        if (!regularUserToken) return false;
        try {
            const payloadPart = regularUserToken.split('.')[1];
            if (!payloadPart) return false;
            const decodedPayload = JSON.parse(atob(payloadPart));
            return decodedPayload?.isAdmin === true;
        } catch {
            return false;
        }
    }, [regularUserToken]);

    const isDebugModeActive = useMemo(() => {
        const urlDebug = new URLSearchParams(location.search).get('debug') === 'true';
        const envDebug = String(import.meta.env.VITE_ENABLE_DEBUG_MODE || '').toLowerCase() === 'true';
        return urlDebug || envDebug || regularUser?.isAdmin === true || isAdminFromToken;
    }, [location.search, regularUser?.isAdmin, isAdminFromToken]);

    const handleDebugToggle = useCallback(async (feature, enabled) => {
        try {
            const result = await api.toggleDebugFeature(feature, enabled);
            if (result?.flags) {
                setDebugFeatureFlags(result.flags);
            }
        } catch (error) {
            toast.error(error?.response?.data?.message || 'Failed to update debug feature flag.');
        }
    }, []);

    useEffect(() => {
        if (!isDebugModeActive) {
            setDebugFeatureFlags(null);
            return;
        }

        api.getDebugFeatureFlags()
            .then((result) => {
                if (result?.flags) setDebugFeatureFlags(result.flags);
            })
            .catch(() => {
                // ignore: endpoint is intentionally hidden when debug mode is off on backend
            });
    }, [isDebugModeActive]);

    const handleStopGeneration = useCallback(() => {
        if (abortControllerRef.current) {
            isUserAborted.current = true;
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
            setIsActuallySendingAPI(false);
            onChatProcessingChange(false);
        }
    }, [onChatProcessingChange]);

    const handleStreamingSendMessage = useCallback(async (inputText, placeholderId, options) => {
        const normalizeStreamText = (value) => {
            if (typeof value === 'string') return value;
            if (value === null || value === undefined) return '';
            if (typeof value === 'number' || typeof value === 'boolean') return String(value);
            if (typeof value === 'object') {
                if (typeof value.text === 'string') return value.text;
                if (typeof value.content === 'string') return value.content;
                if (typeof value.delta === 'string') return value.delta;
                if (typeof value.message === 'string') return value.message;
                return '';
            }
            return '';
        };

        // Capture the index for this specific conversation turn
        capturedIndexRef.current = currentQuestionIndex;

        const payload = {
            query: inputText.trim(),
            sessionId: currentSessionId,
            useWebSearch: options.useWebSearch,
            useAcademicSearch: options.useAcademicSearch,
            systemPrompt,
            criticalThinkingEnabled: options.criticalThinkingEnabled,
            documentContextName: options.documentContextName,
            tutorMode,
            tutorModeType: effectiveTutorModeType,
            currentModulePathId: currentModulePathId,
            isAutoGreeting: options.isAutoGreeting || false,
        };

        // Add bounty information if this is a bounty answer
        if (activeBountyId && options.isBountyAnswer) {
            payload.bountyId = activeBountyId;
            payload.bountyAnswer = inputText.trim();
        }

        // --- THIS IS THE FIX ---
        // Construct the full, correct API URL using the environment variable.
        const debugSuffix = new URLSearchParams(location.search).get('debug') === 'true' ? '?debug=true' : '';
        const apiUrl = `${import.meta.env.VITE_API_BASE_URL || 'http://localhost:5005/api'}/chat/message${debugSuffix}`;

        const response = await fetch(apiUrl, {
            // --- END OF FIX ---
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${regularUserToken}` },
            body: JSON.stringify(payload),
            signal: abortControllerRef.current.signal,
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || `Server error: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let finalBotMessageObject = null;
        let streamErrorMessage = null;
        let accumulatedThinking = '';
        let currentStatusRef = null; // Track the latest status update
        let accumulatedSteps = []; // Track structured reasoning steps
        let currentConfidenceScore = null; // Track confidence score

        let streamBuffer = '';
        let tokenBuffer = '';
        const BUFFER_SIZE = 1;
        const STALL_TIMEOUT_MS = options?.criticalThinkingEnabled ? 180000 : 120000;

        // Stall Watchdog: abort only after a long silence window.
        let stallTimer = null;
        const resetStallTimer = () => {
            if (stallTimer) clearTimeout(stallTimer);
            stallTimer = setTimeout(() => {
                console.warn(`Stream stalled: no data for ${Math.round(STALL_TIMEOUT_MS / 1000)}s`);
                abortControllerRef.current?.abort();
            }, STALL_TIMEOUT_MS);
        };

        resetStallTimer();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            resetStallTimer();
            streamBuffer += decoder.decode(value, { stream: true });

            let eventEndIndex;
            while ((eventEndIndex = streamBuffer.indexOf('\n\n')) !== -1) {
                const eventChunk = streamBuffer.slice(0, eventEndIndex).trim();
                streamBuffer = streamBuffer.slice(eventEndIndex + 2);

                if (!eventChunk.startsWith('data: ')) continue;

                const jsonString = eventChunk.replace('data: ', '');
                try {
                    const eventData = JSON.parse(jsonString);
                    if (eventData.type === 'token') {
                        const tokenText = normalizeStreamText(eventData.content);
                        if (!tokenText) continue;
                        tokenBuffer += tokenText;
                        if (tokenBuffer.length >= BUFFER_SIZE || tokenText.includes('\n')) {
                            const capturedBuffer = tokenBuffer;
                            tokenBuffer = '';
                            setMessages(prev => prev.map(msg => msg.id === placeholderId ? { ...msg, text: (msg.text || '') + capturedBuffer } : msg));
                        }
                    } else if (eventData.type === 'thought') {
                        const thoughtText = normalizeStreamText(eventData.content);
                        if (!thoughtText) continue;
                        accumulatedThinking += thoughtText;
                        setMessages(prev => prev.map(msg => msg.id === placeholderId ? { ...msg, thinking: accumulatedThinking, _accumulatedContent: accumulatedThinking } : msg));
                    } else if (eventData.type === 'step_update') {
                        // Upsert step by stepId
                        const stepData = eventData.content;
                        const existingIndex = accumulatedSteps.findIndex(s => s.stepId === stepData.stepId);
                        if (existingIndex >= 0) {
                            accumulatedSteps[existingIndex] = { ...accumulatedSteps[existingIndex], ...stepData };
                        } else {
                            accumulatedSteps.push(stepData);
                        }
                        setMessages(prev => prev.map(msg => msg.id === placeholderId ? { ...msg, steps: [...accumulatedSteps] } : msg));
                    } else if (eventData.type === 'confidence_score') {
                        currentConfidenceScore = eventData.content;
                        setMessages(prev => prev.map(msg => msg.id === placeholderId ? { ...msg, confidenceScore: currentConfidenceScore } : msg));
                    } else if (eventData.type === 'status_update') {
                        const statusText = normalizeStreamText(eventData.content);
                        if (!statusText) continue;
                        currentStatusRef = statusText; // Store the latest status
                        setMessages(prev => prev.map(msg => msg.id === placeholderId ? { ...msg, status: statusText } : msg));
                    } else if (eventData.type === 'progress_update') {
                        // Emit custom event for TutorModePage to handle
                        window.dispatchEvent(new CustomEvent('tutor-progress-update', {
                            detail: eventData.content
                        }));
                    } else if (eventData.type === 'final_answer') {
                        finalBotMessageObject = eventData.content;
                        if (eventData?.content?.debug) {
                            setLatestDebugData(eventData.content.debug);
                            if (eventData.content.debug.featureFlags) {
                                setDebugFeatureFlags(eventData.content.debug.featureFlags);
                            }
                        }
                    } else if (eventData.type === 'error') {
                        const errorText = normalizeStreamText(eventData.content);
                        streamErrorMessage = errorText || 'AI service error';
                    }
                } catch (e) {
                    console.error("Error parsing SSE chunk:", jsonString, e);
                }
            }
        }

        if (stallTimer) clearTimeout(stallTimer);

        // Flush remaining token buffer
        if (tokenBuffer.length > 0) {
            setMessages(prev => prev.map(msg => msg.id === placeholderId ? { ...msg, text: (msg.text || '') + tokenBuffer } : msg));
        }

        if (finalBotMessageObject) {
            // --- THIS IS THE FIX ---
            // Create a new, correctly structured message object for the frontend state.
            // This aligns the streaming response with the format used by chat history loading.

            let finalStatus = null;

            // Map Tutor Mode socratic states
            if (tutorMode && finalBotMessageObject.socraticState) {
                const stateMap = {
                    'INTRODUCTION': 'Lesson Start',
                    'L1_CONCEPT': 'Building Foundations 🏗️',
                    'L2_APPLICATION': 'Applying Knowledge 🛠️',
                    'L3_CRITICAL': 'Critical Thinking 🧠',
                    'L4_EVALUATION': 'Evaluation & Design ⚖️',
                    // Legacy minimal support
                    'REFINE': 'Refining Understanding',
                    'CORRECT': 'Addressing Misconception',
                    'ADVANCE': 'Deepening Understanding',
                    'MASTERY_ACHIEVED': '🎉 Mastery Achieved — Moving to Next Topic'
                };
                finalStatus = stateMap[finalBotMessageObject.socraticState] || 'Tutor Response';

                // Add mastery progress indicator if available
                const mp = finalBotMessageObject.masteryProgress;
                if (mp && mp.current > 0 && finalBotMessageObject.socraticState !== 'MASTERY_ACHIEVED') {
                    finalStatus += ` (Mastery: ${mp.current.toFixed(1)}/${mp.required})`;
                }
            }
            // Map Normal Chat workflow stages (from ToT)
            else if (!tutorMode && currentStatusRef) {
                // Use pattern matching for contextual status messages
                if (currentStatusRef.includes('Analyzing')) {
                    finalStatus = 'Query Analyzed';
                } else if (currentStatusRef.includes('Generating answer')) {
                    finalStatus = 'Answer Generated';
                } else if (currentStatusRef.includes('Developing strategy')) {
                    finalStatus = 'Strategy Developed';
                } else if (currentStatusRef.includes('Evaluating best approach')) {
                    finalStatus = 'Path Evaluated';
                } else if (currentStatusRef.includes('Executing plan')) {
                    finalStatus = 'Plan Executed';
                } else if (currentStatusRef.includes('Finalizing response')) {
                    finalStatus = 'Response Complete';
                } else {
                    finalStatus = 'Response Ready';
                }
            }

            const finalMessage = {
                ...finalBotMessageObject, // Copy all properties like thinking, references, etc.
                id: finalBotMessageObject.id || placeholderId,
                sender: 'bot', // Ensure sender is set
                text: finalBotMessageObject.finalAnswer || finalBotMessageObject.text, // Map to 'text' property
                isStreaming: false, // Explicitly mark streaming as complete
                status: finalStatus, // Persist mapped status
                steps: accumulatedSteps, // Persist structured steps
                confidenceScore: currentConfidenceScore // Persist confidence score
            };

            // Now, update the state with the correctly formatted final message.
            setMessages(prev => [
                ...prev.filter(msg => msg.id !== placeholderId),
                finalMessage
            ]);


            // ── Quiz Mode: detect correct/incorrect in AI response, case-insensitive & markdown-safe ──
            const rawText = (finalMessage.text || '').trim();
            // Strip markdown bold/italic markers and get first 80 chars to check the opening
            const openingText = rawText.replace(/\*+/g, '').replace(/_+/g, '').trim().slice(0, 80).toLowerCase();

            const isCorrect =
                openingText.startsWith('✅') ||              // ✅ Correct!
                openingText.includes('✅ correct') ||         // anywhere in opening
                openingText.startsWith('correct!') ||         // plain "Correct!"
                openingText.startsWith('correct.') ||         // plain "Correct."
                openingText.startsWith('that is correct') ||  // "That is correct"
                openingText.startsWith("that's correct");     // "That's correct"

            const isIncorrect =
                openingText.startsWith('❌') ||              // ❌ Not quite.
                openingText.includes('❌ not quite') ||       // anywhere in opening
                openingText.includes('❌ incorrect') ||       // ❌ Incorrect
                openingText.includes('❌ needs adjustment') || // ❌ Needs Adjustment
                openingText.startsWith('not quite') ||        // plain "Not quite"
                openingText.startsWith('incorrect') ||        // plain "Incorrect"
                openingText.startsWith('needs adjustment') || // plain "Needs adjustment"
                openingText.startsWith('that is not correct') ||
                openingText.startsWith("that's not correct");

            if (isCorrect) {
                window.dispatchEvent(new CustomEvent('quiz-result', {
                    detail: { result: 'correct', index: capturedIndexRef.current, feedback: finalMessage.text }
                }));
            } else if (isIncorrect) {
                window.dispatchEvent(new CustomEvent('quiz-result', {
                    detail: { result: 'incorrect', index: capturedIndexRef.current, feedback: finalMessage.text }
                }));
            }

            // Emit position update for curriculum panel if currentPosition is in response
            if (finalBotMessageObject.currentPosition) {
                window.dispatchEvent(new CustomEvent('tutor-position-update', {
                    detail: finalBotMessageObject.currentPosition
                }));
            }
            // --- END OF FIX ---

            if (finalBotMessageObject.action && finalBotMessageObject.action.type === 'DOWNLOAD_DOCUMENT') {
                toast.promise(
                    api.generateDocumentFromTopic(finalBotMessageObject.action.payload),
                    {
                        loading: `Generating your ${finalBotMessageObject.action.payload.docType.toUpperCase()}...`,
                        success: (data) => `Successfully downloaded '${data.filename}'!`,
                        error: (err) => `Download failed: ${err.message}`,
                    }
                );
            }
        } else if (streamErrorMessage) {
            throw new Error(streamErrorMessage);
        } else {
            // If the loop finished but we don't have a final answer, something went wrong with the stream
            throw new Error("The AI service disconnected before finishing the response. Please try again.");
        }
    }, [currentSessionId, systemPrompt, regularUserToken, setMessages, tutorMode, activeBountyId, currentQuestionIndex, location.search]);

    const handleBountyCompletion = useCallback((bountyResult) => {
        if (bountyResult.isCorrect) {
            toast.custom((t) => (
                <Animate
                    animation="scale-in"
                    className="bg-gradient-to-br from-green-500 to-emerald-600 text-white px-6 py-4 rounded-lg shadow-2xl max-w-md"
                >
                    <div className="flex items-start gap-3">
                        <CheckCircle className="flex-shrink-0" size={32} />
                        <div>
                            <h3 className="font-bold text-xl mb-2">Bounty Completed! 🎉</h3>
                            <div className="flex items-center gap-4 text-sm">
                                <span className="flex items-center gap-1">
                                    <Coins size={18} />
                                    +{bountyResult.creditsAwarded} Credits
                                </span>
                                <span className="flex items-center gap-1">
                                    <Award size={18} />
                                    +{bountyResult.learningCreditsAwarded} Learning Credits
                                </span>
                            </div>
                            <p className="text-sm opacity-90 mt-2">
                                Total: {bountyResult.newCreditsBalance} credits
                            </p>
                        </div>
                    </div>
                </Animate>
            ), { duration: 5000 });
        } else {
            toast.custom((t) => (
                <Animate
                    animation="scale-in"
                    className="bg-gradient-to-br from-red-500 to-rose-600 text-white px-6 py-4 rounded-lg shadow-2xl max-w-md"
                >
                    <div className="flex items-start gap-3">
                        <XCircle className="flex-shrink-0" size={32} />
                        <div>
                            <h3 className="font-bold text-xl mb-2">Incorrect Answer</h3>
                            <p className="text-sm opacity-90">
                                {bountyResult.message || 'Try again with a different approach!'}
                            </p>
                        </div>
                    </div>
                </Animate>
            ), { duration: 4000 });
        }
    }, []);

    const handleStandardSendMessage = useCallback(async (inputText, placeholderId, options) => {
        const payload = {
            query: inputText.trim(),
            history: messages.slice(0, -2),
            sessionId: currentSessionId,
            useWebSearch: options.useWebSearch,
            useAcademicSearch: options.useAcademicSearch,
            systemPrompt,
            criticalThinkingEnabled: options.criticalThinkingEnabled,
            documentContextName: options.documentContextName,
            tutorMode,
            tutorModeType: effectiveTutorModeType,
            currentModulePathId: currentModulePathId
        };

        // Add bounty information if this is a bounty answer
        if (activeBountyId && options.isBountyAnswer) {
            payload.bountyId = activeBountyId;
            payload.bountyAnswer = inputText.trim();
        }

        const response = await api.sendMessage(payload, options.signal);

        if (response && response.reply) {
            setMessages(prev => [
                ...prev.filter(msg => msg.id !== placeholderId),
                { ...response.reply, id: response.reply.id || placeholderId }
            ]);

            // Handle bounty completion if present
            if (response.bountyResult) {
                handleBountyCompletion(response.bountyResult);
            }

            if (response.reply.action && response.reply.action.type === 'DOWNLOAD_DOCUMENT') {
                toast.promise(
                    api.generateDocumentFromTopic(response.reply.action.payload),
                    {
                        loading: `Generating your ${response.reply.action.payload.docType.toUpperCase()}...`,
                        success: (data) => `Successfully downloaded '${data.filename}'!`,
                        error: (err) => `Download failed: ${err.message}`,
                    }
                );
            }
        } else {
            throw new Error("Invalid response from iMentor service.");
        }
    }, [messages, currentSessionId, systemPrompt, setMessages, tutorMode, activeBountyId, handleBountyCompletion, effectiveTutorModeType]);


    const handleSendMessage = useCallback(async (inputText, options = {}) => {
        if (!inputText.trim() || !regularUserToken || !currentSessionId || isActuallySendingAPI) return;

        const effectiveUseWebSearch = options.useWebSearch ?? useWebSearch;
        const effectiveUseAcademicSearch = options.useAcademicSearch ?? useAcademicSearch;
        // --- MANDATORY: Disable Thinking in Tutor Mode ---
        const effectiveCriticalThinking = tutorMode ? false : (options.criticalThinkingEnabled ?? criticalThinkingEnabled);
        const effectiveDocumentContext = options.documentContextName ?? selectedSubject ?? selectedDocumentForAnalysis;

        console.log('[ToT DEBUG] criticalThinkingEnabled state:', criticalThinkingEnabled);
        console.log('[ToT DEBUG] options.criticalThinkingEnabled:', options.criticalThinkingEnabled);
        console.log('[ToT DEBUG] effectiveCriticalThinking (will send):', effectiveCriticalThinking);
        console.log('[ToT DEBUG] tutorMode:', tutorMode);

        abortControllerRef.current = new AbortController();
        isUserAborted.current = false;

        const userMessage = {
            id: `user-${Date.now()}`,
            sender: 'user',
            text: inputText.trim(),
            timestamp: new Date().toISOString(),
        };

        const streamingPlaceholderId = `bot-streaming-${Date.now()}`;
        const placeholderMessage = {
            id: streamingPlaceholderId,
            sender: 'bot',
            text: '',
            thinking: effectiveCriticalThinking ? '' : null,
            isStreaming: true,
            timestamp: new Date().toISOString(),
            _accumulatedContent: '',
            status: tutorMode ? 'Thinking…' : null // Initial status for Tutor Mode
        };

        if (options.isTryAgain || options.isAutoGreeting) {
            setMessages(prev => [...prev, placeholderMessage]);
        } else {
            setMessages(prev => [...prev, userMessage, placeholderMessage]);
        }
        onChatProcessingChange(true);
        setIsActuallySendingAPI(true);

        // --- DEEP RESEARCH BYPASS ---
        if (isResearchMode && !tutorMode) {
            setResearchQuery(inputText.trim());
            setPipelineStage('init');
            handleResearchUpdate({ phase: 'init' });

            // Forward to orchestrator
            try {
                const response = await fetch(`${import.meta.env.VITE_API_BASE_URL || 'http://localhost:5005/api'}/chat/message`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${regularUserToken}` },
                    body: JSON.stringify({
                        query: inputText.trim(),
                        sessionId: currentSessionId,
                        isDeepResearch: true
                    }),
                    signal: abortControllerRef.current.signal,
                });

                if (!response.ok) throw new Error("Deep Research API Error");

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let streamBuffer = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    streamBuffer += decoder.decode(value, { stream: true });
                    let eventEndIndex;
                    while ((eventEndIndex = streamBuffer.indexOf('\n\n')) !== -1) {
                        const eventChunk = streamBuffer.slice(0, eventEndIndex).trim();
                        streamBuffer = streamBuffer.slice(eventEndIndex + 2);
                        if (!eventChunk.startsWith('data: ')) continue;
                        
                        try {
                            const eventData = JSON.parse(eventChunk.replace('data: ', ''));
                            // Pass progress chunk directly into the Deep Research Provider
                            handleResearchUpdate(eventData);

                            // Clean up dummy message when done
                            if (eventData.phase === 'completed') {
                                setMessages(prev => prev.filter(msg => msg.id !== streamingPlaceholderId));
                            }
                        } catch (e) {
                            if (import.meta.env.DEV) {
                                console.warn('Deep research stream chunk parse failed:', e);
                            }
                        }
                    }
                }
            } catch (err) {
                 toast.error("Deep Research Failed");
                 setMessages(prev => prev.filter(msg => msg.id !== streamingPlaceholderId));
            } finally {
                setIsActuallySendingAPI(false);
                onChatProcessingChange(false);
            }
            return;
        }
        // --- END DEEP RESEARCH BYPASS ---

        let safetyTimeout = null;
        try {
            const handlerOptions = {
                useWebSearch: effectiveUseWebSearch,
                useAcademicSearch: effectiveUseAcademicSearch,
                criticalThinkingEnabled: effectiveCriticalThinking,
                documentContextName: effectiveDocumentContext,
                tutorMode,
                currentModulePathId,
                signal: abortControllerRef.current.signal
            };

            // Add bounty flag to options if we have an active bounty
            const enrichedOptions = {
                ...handlerOptions,
                isBountyAnswer: !!activeBountyId,
                isAutoGreeting: options.isAutoGreeting || false,
            };

            const SAFETY_TIMEOUT_MS = (effectiveCriticalThinking || tutorMode) ? 180000 : 120000;

            // Add safety timeout for entire request lifecycle
            safetyTimeout = setTimeout(() => {
                if (isActuallySendingAPI) {
                    console.warn("Safety timeout reached, aborting request.");
                    abortControllerRef.current?.abort();
                }
            }, SAFETY_TIMEOUT_MS);

            // Unified streaming handler for ALL message types (Tutor, Critical Thinking, and Standard Chat)
            // The backend now consistently returns text/event-stream for /chat/message
            await handleStreamingSendMessage(inputText, streamingPlaceholderId, enrichedOptions);
        } catch (error) {
            if ((error.name === 'AbortError' || error.code === 'ERR_CANCELED') && isUserAborted.current) {
                setMessages(prev => prev.map(msg =>
                    msg.id === streamingPlaceholderId
                        ? { ...msg, isStreaming: false, status: 'Stopped' }
                        : msg
                ));
            } else {
                console.error("Error in handleSendMessage:", error);
                const errorMessage = (error.name === 'AbortError' || error.code === 'ERR_CANCELED')
                    ? "The request timed out. The service might be under heavy load."
                    : (error.response?.data?.message || error.message || "An unknown error occurred.");

                setMessages(prev => prev.map(msg =>
                    msg.id === streamingPlaceholderId
                        ? {
                            ...msg,
                            isStreaming: false,
                            text: "Oops! It seems like the AI service is temporarily busy or unavailable. We're sorry for the interruption! You can try regenerating the response or check back in a moment.",
                            status: 'Service Error',
                            isError: true,
                            originalError: errorMessage, // Keep original error for debugging if needed
                            providerDetail: error.response?.data?.aiError || error.aiProviderDetail || undefined
                        }
                        : msg
                ));
                setLastErrorMessage(errorMessage);
                setIsErrorModalOpen(true);
            }
        } finally {
            if (safetyTimeout) clearTimeout(safetyTimeout);
            setIsActuallySendingAPI(false);
            onChatProcessingChange(false);
            setUseWebSearch(false);
            setUseAcademicSearch(false);
            // Clear bounty state after message is sent
            if (activeBountyId) {
                setActiveBountyId(null);
                setActiveBountyMetadata(null);
            }
        }
    }, [
        regularUserToken, currentSessionId, isActuallySendingAPI, useWebSearch,
        useAcademicSearch, criticalThinkingEnabled, selectedSubject,
        selectedDocumentForAnalysis, setMessages, onChatProcessingChange,
        handleStreamingSendMessage, handleStandardSendMessage, systemPrompt,
        activeBountyId, tutorMode
    ]);


    // Handle bounty question from navigation state
    useEffect(() => {
        if (location.state?.bountyQuestion) {
            const bountyText = `🎯 Bounty Challenge (${location.state.bountyCredits} credits + ${location.state.bountyLearningCredits} Learning Credits)\n\n${location.state.bountyQuestion}`;
            setInitialPromptForNewSession(bountyText);

            // Store bounty metadata in component state
            setActiveBountyId(location.state.bountyId);
            setActiveBountyMetadata({
                credits: location.state.bountyCredits,
                learningCredits: location.state.bountyLearningCredits,
                topic: location.state.bountyTopic,
                difficulty: location.state.bountyDifficulty
            });

            // Clear the navigation state to prevent re-triggering
            navigate(location.pathname, { replace: true, state: {} });
        }
    }, [location.state, setInitialPromptForNewSession, navigate, location.pathname]);

    // ── Auto-greeting: fire the tutor opener when entering a fresh session ────
    // Fires once per session (hasAutoGreetedRef) when:
    //   • tutor mode is active
    //   • no messages yet (empty chat)
    //   • a session ID exists (auth + session resolved)
    //   • not already waiting on a request
    useEffect(() => {
        if (!tutorMode || !currentSessionId || isActuallySendingAPI) return;
        if (messages.length > 0) {
            // Real messages arrived — mark as greeted so we never re-fire
            hasAutoGreetedRef.current = true;
            return;
        }
        if (hasAutoGreetedRef.current) return;

        hasAutoGreetedRef.current = true;

        const t = setTimeout(() => {
            handleSendMessage('__tutor_init__', { isAutoGreeting: true });
        }, 400);

        return () => clearTimeout(t);
    }, [tutorMode, currentSessionId, messages.length, isActuallySendingAPI, handleSendMessage]);

    // Reset the auto-greet flag whenever the user starts a new session
    useEffect(() => {
        hasAutoGreetedRef.current = false;
    }, [currentSessionId]);

    const handleFeatureClick = (feature) => {
        if (feature.path) {
            navigate(feature.path);
        } else if (feature.action) {
            switch (feature.action) {
                case 'enableTutorMode':
                    setTutorMode(true);
                    toast.success("🎓 Tutor Mode activated!", { duration: 3000 });
                    break;
                case 'toggleAcademicSearch':
                    setUseAcademicSearch(true);
                    toast.success("Academic Search has been enabled for your next message.");
                    break;
                default:
                    break;
            }
        }
    };



    return (
        <div className="flex flex-col h-full rounded-vs" style={{ background: 'var(--vs-bg)' }}>
            {/* Tutor Mode Banner */}

            {isResearchMode ? (
                <DeepResearchPanel />
            ) : messages.length === 0 && !isActuallySendingAPI && currentSessionId ? (
                <div className="flex-1 flex flex-col justify-center items-center p-4 sm:p-8 animate-fadeIn overflow-y-auto custom-scrollbar">
                    <div data-tutor-tour="hero" className="w-full max-w-2xl mx-auto">

                        {/* ── Wordmark ───────────────────────────────────── */}
                        <div className="mb-8 text-center">
                            <Animate
                                as="h2"
                                animation="slide-up"
                                delay={200}
                                className="font-semibold tracking-tight mb-2"
                                style={{
                                    fontSize: '2rem',
                                    color: 'var(--vs-text)',
                                    letterSpacing: '-0.02em',
                                }}
                            >
                                <TypewriterText
                                    text={tutorMode ? "Socratic Mode" : "iMentor"}
                                    speed={55}
                                    delay={300}
                                />
                            </Animate>
                            <Animate
                                as="p"
                                animation="fade-in"
                                delay={1400}
                                className="text-sm"
                                style={{ color: 'var(--vs-text-dim)' }}
                            >
                                <TypewriterText
                                    text={tutorMode
                                        ? "Guided questioning — I teach by asking, not telling. What would you like to learn?"
                                        : "AI-powered academic tutor. Ask anything about your studies."}
                                    speed={30}
                                    delay={1500}
                                />
                            </Animate>
                        </div>

                        {/* ── Feature grid ──────────────────────────────── */}
                        <Animate animation="fade-in" delay={1800}>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                                {features.map((feature) => {
                                    const Icon = feature.icon;
                                    return (
                                        <div
                                            key={feature.title}
                                            className={feature.desktopOnly ? 'hidden md:block' : ''}
                                        >
                                            <button
                                                onClick={() => handleFeatureClick(feature)}
                                                className="group text-left p-3.5 rounded-md transition-all duration-150 outline-none focus-visible:ring-1 focus-visible:ring-[--vs-border-hi] w-full"
                                                style={{
                                                    background:   'var(--vs-sidebar)',
                                                    border:       '1px solid var(--vs-border)',
                                                    borderRadius: '6px',
                                                    boxShadow:    '0 2px 8px rgba(0,0,0,0.25), 0 1px 2px rgba(0,0,0,0.15)',
                                                }}
                                                onMouseEnter={e => {
                                                    e.currentTarget.style.background    = 'var(--vs-surface)';
                                                    e.currentTarget.style.borderColor   = 'var(--vs-border-hi)';
                                                    e.currentTarget.style.boxShadow     = '0 4px 16px rgba(0,0,0,0.35), 0 2px 4px rgba(0,0,0,0.2)';
                                                    e.currentTarget.style.transform     = 'translateY(-1px)';
                                                }}
                                                onMouseLeave={e => {
                                                    e.currentTarget.style.background    = 'var(--vs-sidebar)';
                                                    e.currentTarget.style.borderColor   = 'var(--vs-border)';
                                                    e.currentTarget.style.boxShadow     = '0 2px 8px rgba(0,0,0,0.25), 0 1px 2px rgba(0,0,0,0.15)';
                                                    e.currentTarget.style.transform     = 'translateY(0)';
                                                }}
                                                aria-label={feature.title}
                                            >
                                                <div className="flex items-start gap-2.5">
                                                    <div
                                                        className="mt-0.5 flex-shrink-0"
                                                        style={{ color: 'var(--vs-text-lo)' }}
                                                    >
                                                        <Icon size={14} />
                                                    </div>
                                                    <div className="min-w-0">
                                                        <div
                                                            className="text-xs font-bold mb-0.5 truncate"
                                                            style={{ color: '#ffffff' }}
                                                        >
                                                            {feature.title}
                                                        </div>
                                                        <div
                                                            className="text-xs leading-snug line-clamp-2"
                                                            style={{ color: 'var(--vs-text-dim)' }}
                                                        >
                                                            {feature.description}
                                                        </div>
                                                    </div>
                                                </div>
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        </Animate>

                    </div>
                </div>
            ) : (

                <ChatHistory
                    messages={messages}
                    onCueClick={handleSendMessage}
                    onAnalyze={(text) => navigate('/tools/integrity-checker', { state: { initialText: text } })}
                />
            )}

            <ChatInput
                onSendMessage={handleSendMessage}
                onStop={handleStopGeneration}
                isLoading={isActuallySendingAPI}
                useWebSearch={useWebSearch}
                setUseWebSearch={setUseWebSearch}
                useAcademicSearch={useAcademicSearch}
                setUseAcademicSearch={setUseAcademicSearch}
                criticalThinkingEnabled={criticalThinkingEnabled}
                setCriticalThinkingEnabled={setCriticalThinkingEnabled}
                initialPrompt={initialPromptForNewSession}
                setInitialPromptForNewSession={setInitialPromptForNewSession}
                openCoachModalWithData={setCoachData}
                setCoachModalOpen={setIsCoachModalOpen}
            />
            <PromptCoachModal
                isOpen={isCoachModalOpen}
                onClose={() => setIsCoachModalOpen(false)}
                onApply={(improvedPrompt) => {
                    setInitialPromptForNewSession(improvedPrompt);
                }}
                data={coachData}
            />

            <Modal
                isOpen={isErrorModalOpen}
                onClose={() => setIsErrorModalOpen(false)}
                title="AI Service Notification"
            >
                <div className="flex flex-col items-center text-center p-2">
                    <div className="p-4 rounded-full mb-4" style={{ background: 'var(--vs-surface)' }}>
                        <AlertCircle size={32} style={{ color: 'var(--vs-text-lo)' }} />
                    </div>
                    <h3 className="text-base font-semibold mb-2" style={{ color: 'var(--vs-text)' }}>Service Temporarily Unavailable</h3>
                    <p className="text-sm mb-6 leading-relaxed" style={{ color: 'var(--vs-text-lo)' }}>
                        We're sorry! iMentor is currently experiencing high demand or a temporary connection issue.
                        Our team has been notified. Please try again in a few moments or refresh the page.
                    </p>
                    <div className="flex gap-3 w-full">
                        <Button
                            variant="secondary"
                            className="flex-1"
                            onClick={() => setIsErrorModalOpen(false)}
                        >
                            Dismiss
                        </Button>
                        <Button
                            variant="primary"
                            className="flex-1"
                            onClick={() => {
                                setIsErrorModalOpen(false);
                                // The user can also use the inline regenerate button
                            }}
                        >
                            Got it
                        </Button>
                    </div>
                </div>
            </Modal>

            {isDebugModeActive && (
                <OrchestratorMonitor
                    debugData={latestDebugData}
                    featureFlags={debugFeatureFlags || latestDebugData?.featureFlags}
                    onToggleFeature={handleDebugToggle}
                />
            )}
        </div>
    );
}

export default CenterPanel;