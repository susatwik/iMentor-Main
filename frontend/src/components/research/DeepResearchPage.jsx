import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth as useRegularAuth } from '../../hooks/useAuth';
import { useAppState } from '../../contexts/AppStateContext';
import DeepResearchPanel from './DeepResearchPanel';
import { useDeepResearch } from '../../contexts/DeepResearchContext';
import toast from 'react-hot-toast';
import api from '../../services/api';
import Modal from '../core/Modal.jsx';
import Button from '../core/Button.jsx';
import { FileText, AlertCircle, Mic, MicOff } from 'lucide-react';
import { useWebSpeech } from '../../hooks/useWebSpeech';

const DeepResearchPage = () => {
    const navigate = useNavigate();
    const { user: regularUser, token: regularUserToken } = useRegularAuth();
    const { currentSessionId } = useAppState();

    const {
        setPipelineStage,
        handleResearchUpdate,
        resetResearch,
        setQuery: setContextQuery
    } = useDeepResearch();

    const [query, setQuery] = useState('');
    const [isSearching, setIsSearching] = useState(false);
    const [depthPreset, setDepthPreset] = useState('standard');
    const [customSourceCount, setCustomSourceCount] = useState(5);
    const [empiricalRatio, setEmpiricalRatio] = useState(0.5);
    
    // Voice input
    const { transcript, listening, isSpeechSupported, startListening, stopListening, resetTranscript } = useWebSpeech();

    // Local refs for data that will be pushed to context
    const [researchBundle, setResearchBundle] = useState(null);
    const [researchReport, setResearchReport] = useState(null);

    const [recentSessions, setRecentSessions] = useState([]);
    const [isErrorModalOpen, setIsErrorModalOpen] = useState(false);
    const abortControllerRef = useRef(null);

    // Sync voice transcript with query input
    useEffect(() => {
        if (transcript) {
            setQuery(transcript);
        }
    }, [transcript]);

    const RECENT_RESEARCH_WINDOW_MS = 24 * 60 * 60 * 1000;

    const keepRecentWindow = (sessions) => {
        const now = Date.now();
        return sessions
            .filter((session) => {
                const createdAt = new Date(session.createdAt).getTime();
                return Number.isFinite(createdAt) && now - createdAt <= RECENT_RESEARCH_WINDOW_MS;
            })
            .slice(0, 5);
    };

    useEffect(() => {
        const fetchRecent = async () => {
            if (!regularUserToken) return;
            try {
                const data = await api.getResearchHistory();
                setRecentSessions(keepRecentWindow(data));
            } catch (err) {
                console.error("Recent sessions fetch error", err);
            }
        };
        fetchRecent();
    }, [regularUserToken]);

    const startResearch = async (e) => {
        if (e) e.preventDefault();
        if (!query.trim() || isSearching) return;

        // Unified Context Reset & Init
        resetResearch();
        setContextQuery(query.trim());
        setPipelineStage('planning');

        // Local Trigger to change View
        setIsSearching(true);

        abortControllerRef.current = new AbortController();

        const effectiveSessionId = currentSessionId || `dr-${sessionStorage.getItem('temp_sessionId') || (() => {
            const newId = Math.random().toString(36).substring(7);
            sessionStorage.setItem('temp_sessionId', newId);
            return newId;
        })()}`;

        const apiUrl = `${import.meta.env.VITE_API_BASE_URL || 'http://localhost:2000/api'}/chat/message`;
        const payload = {
            query: query.trim(),
            sessionId: effectiveSessionId,
            deepResearchMode: true,
            useWebSearch: true,
            useAcademicSearch: true,
            researchConfig: {
                depthPreset,
                target_source_count: depthPreset === 'custom' ? Number(customSourceCount) : undefined,
                empirical_ratio: Number(empiricalRatio),
                allow_adaptive_fallback: true
            }
        };

        try {
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${regularUserToken}`
                },
                body: JSON.stringify(payload),
                signal: abortControllerRef.current.signal,
            });

            if (!response.ok) throw new Error('Failed to start research');

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n\n').filter(line => line.startsWith('data: '));

                for (const line of lines) {
                    const jsonString = line.replace('data: ', '');
                    try {
                        const eventData = JSON.parse(jsonString);

                        // Handle Different Event Types
                        if (eventData.type === 'deep_research_update') {
                            handleResearchUpdate(eventData.content);
                        } else if (eventData.type === 'research_complete') {
                            const { researchBundle, researchReport } = eventData.content;

                            setResearchBundle(researchBundle);
                            setResearchReport(researchReport);

                            // Map metadata correctly from the bundle if it's not nested
                            const metaData = researchBundle?.meta || {
                                retrievalMode: researchBundle?.mode || 'HYBRID',
                                totalSources: researchBundle?.sources?.length || 0,
                                academicSources: researchBundle?.onlineSourceCount || 0,
                                webSources: 0,
                                confidenceScore: researchBundle?.overallConfidenceScore || 0,
                                confidenceExplanation: researchBundle?.confidenceMetrics?.explanation || '',
                                evidenceProfile: researchBundle?.evidenceProfile || null
                            };

                            // Push to context with correct destructuring
                            handleResearchUpdate({
                                phase: 'completed',
                                fullReport: researchReport,
                                metaData: metaData,
                                sourceData: researchBundle?.sources,
                                graphData: researchBundle?.citationGraphData
                            });

                            setIsSearching(false);
                            // Refresh history list
                            setRecentSessions(prev => [
                                { _id: researchBundle?._id || 'temp', title: query, query, createdAt: new Date() },
                                ...prev
                            ].slice(0, 5));

                            toast.success((t) => (
                                <span>
                                    Research Complete!
                                    <button
                                        onClick={() => { toast.dismiss(t.id); navigate('/tools/deep-research/history'); }}
                                        className="ml-2 underline text-xs font-bold"
                                    >
                                        View Library
                                    </button>
                                </span>
                            ));
                        } else if (eventData.type === 'error') {
                            throw new Error(eventData.content);
                        }
                    } catch (e) {
                        // console.error("Error parsing stream chunk", e);
                    }
                }
            }
        } catch (error) {
            if (error.name === 'AbortError') return;
            console.error("Research failed:", error);
            toast.error(error.message || "Deep Research encountered a network error.");
            setPipelineStage('error');
        }
    };

    // If not searching and no data, show Hero Input
    if (!isSearching && !researchReport && !researchBundle) {
        return (
            <div className="min-h-screen bg-[#0A0A0A] text-white flex flex-col items-center justify-center relative overflow-hidden font-sans">

                {/* Background Decor */}
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-blue-900/10 via-[#0A0A0A] to-[#0A0A0A]"></div>

                <div className="z-10 w-full max-w-2xl px-6">
                    <div className="mb-10 text-center">
                        <div className="inline-block px-3 py-1 mb-4 border border-[#333] rounded-full text-[10px] uppercase tracking-widest text-gray-500 font-bold bg-[#111]">
                            Hybrid Knowledge Engine
                        </div>
                        <h1 className="text-5xl font-serif font-medium text-white mb-4 tracking-tight">
                            Deep Research
                        </h1>
                        <p className="text-gray-400 text-lg leading-relaxed max-w-lg mx-auto">
                            Conduct PhD-level analysis across academic journals, technical documentation, and real-time web sources.
                        </p>
                    </div>

                    <form onSubmit={startResearch} className="relative group" data-deep-research-tour="hero-input">
                        <div className="absolute -inset-1 bg-gradient-to-r from-blue-500/20 to-purple-500/20 rounded-xl blur opacity-25 group-hover:opacity-50 transition duration-500"></div>
                        <div className="relative bg-[#111] border border-[#333] rounded-xl overflow-hidden group-focus-within:border-gray-500 transition-colors">
                            <div className="relative">
                                <textarea
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && !e.shiftKey) {
                                            e.preventDefault();
                                            startResearch();
                                        }
                                    }}
                                    placeholder="What do you want to verify?"
                                    data-deep-research-tour="query-input"
                                    className="w-full bg-transparent p-6 pr-16 text-lg text-white placeholder:text-gray-600 outline-none resize-none min-h-[140px]"
                                />
                                {/* Voice Input Button */}
                                {isSpeechSupported && (
                                    <button
                                        type="button"
                                        onClick={listening ? stopListening : startListening}
                                        className={`absolute right-4 top-4 p-2.5 rounded-lg transition-all ${
                                            listening
                                                ? 'bg-red-500/20 text-red-400 animate-pulse'
                                                : 'bg-gray-800/50 text-gray-400 hover:bg-gray-700/50 hover:text-white'
                                        }`}
                                        title={listening ? 'Stop listening' : 'Voice input'}
                                        aria-label={listening ? 'Stop listening' : 'Voice input'}
                                    >
                                        {listening ? <MicOff size={20} /> : <Mic size={20} />}
                                    </button>
                                )}
                            </div>
                            <div className="flex justify-between items-center px-4 py-3 bg-[#0f0f0f] border-t border-[#222]">
                                <div className="flex flex-col gap-2 text-xs text-gray-500 font-medium w-full pr-3" data-deep-research-tour="depth-controls">
                                    <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span> Academic + Web Deep Search Enabled</span>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <label className="text-[11px] uppercase tracking-wider text-gray-500">Depth</label>
                                        <select
                                            value={depthPreset}
                                            onChange={(e) => setDepthPreset(e.target.value)}
                                            className="bg-[#121212] border border-[#2a2a2a] text-gray-300 text-xs px-2 py-1 rounded"
                                        >
                                            <option value="standard">Standard (5 sources)</option>
                                            <option value="deep">Deep (8 sources)</option>
                                            <option value="extensive">Extensive (12 sources)</option>
                                            <option value="custom">Custom</option>
                                        </select>
                                        {depthPreset === 'custom' && (
                                            <input
                                                type="number"
                                                min={3}
                                                max={20}
                                                value={customSourceCount}
                                                onChange={(e) => setCustomSourceCount(e.target.value)}
                                                className="w-20 bg-[#121212] border border-[#2a2a2a] text-gray-300 text-xs px-2 py-1 rounded"
                                                title="Custom source count"
                                            />
                                        )}
                                        <label className="text-[11px] uppercase tracking-wider text-gray-500">Empirical %</label>
                                        <input
                                            type="number"
                                            min={30}
                                            max={90}
                                            step={5}
                                            value={Math.round(empiricalRatio * 100)}
                                            onChange={(e) => setEmpiricalRatio(Math.max(0.3, Math.min(0.9, Number(e.target.value) / 100)))}
                                            className="w-16 bg-[#121212] border border-[#2a2a2a] text-gray-300 text-xs px-2 py-1 rounded"
                                            title="Empirical ratio percentage"
                                        />
                                    </div>
                                </div>
                                <button
                                    type="submit"
                                    disabled={!query.trim()}
                                    data-deep-research-tour="start-button"
                                    className="px-6 py-2 bg-white text-black text-sm font-bold rounded-lg hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                >
                                    Start Research
                                </button>
                            </div>
                        </div>
                    </form>

                    <div className="mt-12 grid grid-cols-3 gap-4 text-center mb-12">
                        {[
                            { label: "Research Planning", val: "Automated" },
                            { label: "Source Depth", val: "12-15 Sources" },
                            { label: "Synthesis", val: "Academic Standard" }
                        ].map((stat, i) => (
                            <div key={i} className="p-4 border border-[#161616] rounded-lg bg-[#0F0F0F]">
                                <div className="text-xs text-gray-500 uppercase tracking-widest mb-1">{stat.label}</div>
                                <div className="text-sm font-bold text-gray-300">{stat.val}</div>
                            </div>
                        ))}
                    </div>

                    {/* Recent Research Widget */}
                    <div className="border-t border-[#1F1F1F] pt-8" data-deep-research-tour="recent-research">
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-widest">Recent Research</h3>
                            <button
                                onClick={() => navigate('/tools/deep-research/history')}
                                data-deep-research-tour="library-button"
                                className="text-xs text-blue-400 hover:text-blue-300"
                            >
                                View Library →
                            </button>
                        </div>
                        <div className="space-y-2">
                            {recentSessions.length === 0 ? (
                                <p className="text-xs text-gray-600 italic">No recent sessions found.</p>
                            ) : (
                                recentSessions.map(session => (
                                    <div
                                        key={session._id}
                                        onClick={() => navigate(`/tools/deep-research/view/${session._id}`)}
                                        className="flex items-center justify-between p-3 bg-[#111] border border-[#1F1F1F] rounded hover:border-gray-600 cursor-pointer transition-colors group"
                                    >
                                        <span className="text-sm text-gray-300 truncate max-w-[300px] group-hover:text-white">
                                            {session.title || session.query}
                                        </span>
                                        <span className="text-xs text-gray-600">
                                            {new Date(session.createdAt).toLocaleDateString()}
                                        </span>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>

                {/* Back Button */}
                <button
                    onClick={() => navigate('/')}
                    className="absolute top-6 left-6 text-xs font-bold text-gray-500 uppercase tracking-widest hover:text-white transition-colors"
                >
                    ← Back to Dashboard
                </button>

                {/* Top Right Action Buttons */}
                <div className="absolute top-6 right-6 flex items-center gap-2">
                    <button
                        onClick={() => navigate('/tools/deep-research/history')}
                        data-deep-research-tour="library-button"
                        className="flex items-center px-4 py-2 bg-[#1F1F1F] text-gray-300 text-xs font-bold uppercase tracking-widest rounded hover:bg-gray-700 transition-colors"
                    >
                        <FileText className="w-4 h-4 mr-2" />
                        Library
                    </button>
                </div>

                <Modal
                    isOpen={isErrorModalOpen}
                    onClose={() => setIsErrorModalOpen(false)}
                    title="Service Interruption"
                >
                    <div className="flex flex-col items-center text-center p-2">
                        <div className="bg-red-500/10 p-4 rounded-full mb-4">
                            <AlertCircle className="text-red-500" size={40} />
                        </div>
                        <h3 className="text-xl font-bold text-white mb-2">Deep Research Busy</h3>
                        <p className="text-gray-400 mb-6 leading-relaxed">
                            The Deep Research engine is currently handling multiple complex queries.
                            Please wait a moment before trying again, or try a shorter query.
                        </p>
                        <Button
                            variant="primary"
                            className="w-full"
                            onClick={() => setIsErrorModalOpen(false)}
                        >
                            Understood
                        </Button>
                    </div>
                </Modal>

            </div >
        );
    }

    // Active Research UI
    return (
        <DeepResearchPanel
            onToggleMode={() => {
                // Exit logic
                resetResearch();
                setIsSearching(false);
                setQuery('');
            }}
        />
    );
};

export default DeepResearchPage;
