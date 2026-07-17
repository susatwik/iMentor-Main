import React, { useState, useEffect, useRef } from 'react';
import Animate from '../core/Animate.jsx';
import { useLocation, useNavigate } from 'react-router-dom';
import {
    Lock, Star, CheckCircle2, Play, Trophy, Zap,
    ArrowLeft, Target, Crown, Sparkles, Flame, Gift, Check, Loader2
} from 'lucide-react';
import axios from 'axios';
import toast from 'react-hot-toast';

const SkillTreeGameMap = () => {
    const location = useLocation();
    const navigate = useNavigate();
    const scrollRef = useRef(null);

    const stateData = location.state || {};

    // Recover state from sessionStorage if location.state is empty (page refresh)
    const getRecoveredState = () => {
        if (stateData.topic) {
            // Save to sessionStorage for refresh recovery
            sessionStorage.setItem('skillTreeGameMap_state', JSON.stringify(stateData));
            return stateData;
        }
        // Try sessionStorage first (most recent page state)
        try {
            const sessionData = sessionStorage.getItem('skillTreeGameMap_state');
            if (sessionData) {
                const parsed = JSON.parse(sessionData);
                if (parsed.topic) return parsed;
            }
        } catch (e) { /* skip invalid */ }
        // Fallback to localStorage backup
        const keys = Object.keys(localStorage).filter(k => k.startsWith('skillTree_backup_'));
        if (keys.length > 0) {
            let latest = null;
            for (const key of keys) {
                try {
                    const data = JSON.parse(localStorage.getItem(key));
                    if (!latest || new Date(data.lastSaved) > new Date(latest.lastSaved)) {
                        latest = data;
                    }
                } catch (e) { /* skip invalid */ }
            }
            if (latest) {
                return {
                    topic: latest.topic,
                    assessmentResult: latest.assessmentResult,
                    gameId: latest.gameId,
                    savedLevels: latest.levels
                };
            }
        }
        return {};
    };

    const recoveredState = getRecoveredState();
    const { topic, assessmentResult, answers, savedLevels } = recoveredState;
    const initialGameId = recoveredState.gameId || null;

    const [levels, setLevels] = useState([]);
    const [loading, setLoading] = useState(true);
    const [selectedLevel, setSelectedLevel] = useState(null);
    const [showLevelModal, setShowLevelModal] = useState(false);
    const [playingLevel, setPlayingLevel] = useState(null);
    const [levelQuestions, setLevelQuestions] = useState([]);
    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
    const [selectedAnswer, setSelectedAnswer] = useState(null);
    const [score, setScore] = useState(0);
    const [finalScore, setFinalScore] = useState(0);
    const [showResults, setShowResults] = useState(false);
    const [currentGameId, setCurrentGameId] = useState(initialGameId);
    const [levelLoadError, setLevelLoadError] = useState('');
    const [questionsFetching, setQuestionsFetching] = useState(false);
    const [showExplanation, setShowExplanation] = useState(false);
    const [answerSubmitted, setAnswerSubmitted] = useState(false);
    const [questionXp, setQuestionXp] = useState(0);

    // Data fetching
    useEffect(() => {
        if (topic) {
            if (initialGameId) {
                refetchGameFromDB(initialGameId);
            } else {
                generateLevels();
            }
        } else {
            navigate('/gamification/skill-tree');
        }
    }, [topic]);

    // Refetch game from DB to get latest progress
    const refetchGameFromDB = async (gId) => {
        try {
            const token = localStorage.getItem('authToken');
            const response = await axios.get(
                `${import.meta.env.VITE_API_BASE_URL}/gamification/skill-tree/games/${gId}`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            const game = response.data.game;
            if (game && game.levels?.length > 0) {
                setLevels(game.levels);
                setCurrentGameId(game._id);
                setLoading(false);
            } else {
                // No levels in DB — generate them
                if (game?._id) setCurrentGameId(game._id);
                await generateLevels();
            }
        } catch (error) {
            console.error('[SkillTreeGameMap] Error refetching game:', error);
            const msg = error.response?.data?.message || 'Failed to load game. Please try again.';
            setLevelLoadError(msg);
            setLoading(false);
        }
    };

    useEffect(() => {
        if (levels.length > 0 && topic) {
            const stateToSave = {
                topic,
                assessmentResult,
                levels,
                gameId: currentGameId,
                lastSaved: new Date().toISOString()
            };
            localStorage.setItem(`skillTree_backup_${topic}`, JSON.stringify(stateToSave));
            // Also update sessionStorage for refresh recovery
            sessionStorage.setItem('skillTreeGameMap_state', JSON.stringify({
                topic,
                assessmentResult,
                gameId: currentGameId,
                savedLevels: levels
            }));
        }
    }, [levels, currentGameId]);

    const generateLevels = async () => {
        setLoading(true);
        try {
            const token = localStorage.getItem('authToken');
            const res = await axios.post(
                `${import.meta.env.VITE_API_BASE_URL}/gamification/skill-tree/generate-levels`,
                { topic, assessmentResult, answers },
                { headers: { Authorization: `Bearer ${token}` } }
            );
            const generatedLevels = res.data.levels || [];
            if (generatedLevels.length === 0) {
                toast('Unable to generate learning path. Please try again later.', {
                    icon: '⚠️',
                    style: {
                        background: '#18181b',
                        color: '#fff',
                        border: '1px solid #3f3f46',
                        fontWeight: '500'
                    }
                });
                navigate(-1);
                return;
            }
            setLevels(generatedLevels);
            await saveGameProgress(generatedLevels);
        } catch (error) {
            console.error('[SkillTreeGameMap] Error:', error);
            const errorMessage = error.response?.data?.message || 'Unable to connect to AI service. Please try again later.';
            setLevelLoadError(errorMessage);
            toast(errorMessage, {
                icon: '⚠️',
                style: {
                    background: '#18181b',
                    color: '#fff',
                    border: '1px solid #ef4444',
                    fontWeight: '500'
                }
            });
        } finally {
            setLoading(false);
        }
    };

    const saveGameProgress = async (levelData) => {
        try {
            const token = localStorage.getItem('authToken');
            const res = await axios.post(
                `${import.meta.env.VITE_API_BASE_URL}/gamification/skill-tree/games`,
                { topic, assessmentResult, levels: levelData },
                { headers: { Authorization: `Bearer ${token}` } }
            );
            if (res.data.game?._id) {
                setCurrentGameId(res.data.game._id);
            }
        } catch (error) {
            console.error('Error saving game progress:', error);
        }
    };

    const generateFallbackLevels = () => {
        const knowledgeLevel = assessmentResult?.level || 'Beginner';
        const totalLevels = knowledgeLevel === 'Expert' ? 20 : 
                          knowledgeLevel === 'Advanced' ? 25 : 
                          knowledgeLevel === 'Intermediate' ? 30 : 35;

        const stageNames = [
            'Introduction', 'Basics', 'Understanding', 'Exploring', 'Learning', 'Fundamentals',
            'Core Concepts', 'Key Principles', 'Essential', 'Building Blocks',
            'Intermediate', 'Developing', 'Practicing', 'Applying', 'Working',
            'Advanced', 'Deep Dive', 'Mastering', 'Expert Level', 'Professional'
        ];

        const fallbackLevels = Array.from({ length: totalLevels }, (_, i) => ({
            id: i + 1,
            name: `${stageNames[Math.floor(i / 2) % stageNames.length]} ${i + 1}`,
            description: `Master ${topic} - Stage ${Math.floor(i / 5) + 1}`,
            difficulty: i < totalLevels * 0.3 ? 'easy' : i < totalLevels * 0.7 ? 'medium' : 'hard',
            status: i === 0 ? 'unlocked' : 'locked',
            stars: 0,
            credits: (i + 1) * 10,
            isMilestone: (i + 1) % 5 === 0
        }));
        
        setLevels(fallbackLevels);
        saveGameProgress(fallbackLevels);
    };

    // Level handlers
    const handleLevelClick = (level) => {
        if (level.status === 'locked') {
            toast.error('Complete previous levels first!', { icon: '🔒' });
            return;
        }
        setSelectedLevel(level);
        setShowLevelModal(true);
    };

    const startLevel = async () => {
        if (!selectedLevel) return;
        setShowLevelModal(false);
        setPlayingLevel(selectedLevel);
        setCurrentQuestionIndex(0);
        setScore(0);
        setSelectedAnswer(null);
        setShowResults(false);
        setLevelLoadError('');
        
        const errorMsg = await fetchLevelQuestions(selectedLevel);
        if (errorMsg) {
            toast(errorMsg, {
                icon: '⚠️',
                style: {
                    background: '#18181b',
                    color: '#fff',
                    border: '1px solid #ef4444',
                    fontWeight: '500'
                }
            });
            setPlayingLevel(null);
        }
    };

    const handleAnswerSelect = (index) => {
        if (selectedAnswer !== null || answerSubmitted) return;
        setSelectedAnswer(index);
        setAnswerSubmitted(true);
        
        const currentQuestion = levelQuestions?.[currentQuestionIndex];
        const isCorrect = index === currentQuestion?.correctIndex;
        const newScore = isCorrect ? score + 1 : score;
        const earnedXp = isCorrect ? 10 : 2;
        
        if (isCorrect) {
            setScore(newScore);
        }
        setQuestionXp(earnedXp);
        setShowExplanation(true);
    };

    const handleNextQuestion = () => {
        if (currentQuestionIndex < levelQuestions.length - 1) {
            setCurrentQuestionIndex(prev => prev + 1);
            setSelectedAnswer(null);
            setShowExplanation(false);
            setAnswerSubmitted(false);
            setQuestionXp(0);
        } else {
            completeLevel(score);
        }
    };

    const completeLevel = async (completedScore) => {
        const totalQuestions = levelQuestions.length;
        const percentage = (completedScore / totalQuestions) * 100;
        const earnedStars = percentage >= 90 ? 3 : percentage >= 70 ? 2 : percentage >= 50 ? 1 : 0;

        setFinalScore(completedScore);
        setShowResults(true);

        // Calculate updated levels
        const updatedLevels = levels.map((level, idx) => {
            if (level.id === playingLevel.id) {
                // Only mark as completed if user earned at least 1 star
                const newStatus = earnedStars > 0 ? 'completed' : level.status;
                return { ...level, status: newStatus, stars: Math.max(level.stars, earnedStars) };
            }
            // Unlock next level only if current level was completed with stars
            if (idx === levels.findIndex(l => l.id === playingLevel.id) + 1 && level.status === 'locked' && earnedStars > 0) {
                return { ...level, status: 'unlocked' };
            }
            return level;
        });

        // Always update levels (to save attempts and scores)
        setLevels(updatedLevels);

        // Save progress to the game document if we have a gameId
        if (currentGameId) {
            try {
                const token = localStorage.getItem('authToken');
                console.log('[SkillTree] Saving level completion:', { gameId: currentGameId, levelId: playingLevel.id, stars: earnedStars, score: completedScore, totalQuestions });
                const response = await axios.put(
                    `${import.meta.env.VITE_API_BASE_URL}/gamification/skill-tree/games/${currentGameId}/level/${playingLevel.id}`,
                    {
                        stars: earnedStars,
                        score: completedScore,
                        totalQuestions,
                        status: earnedStars > 0 ? 'completed' : 'unlocked'
                    },
                    { headers: { Authorization: `Bearer ${token}` } }
                );
                console.log('[SkillTree] Level saved response:', response.data);
                // Sync levels from server response to keep frontend in sync with DB
                if (response.data.game?.levels?.length > 0) {
                    setLevels(response.data.game.levels);
                }
                // Show Credits earned if any
                if (response.data.creditsEarned > 0) {
                    toast.success(`+${response.data.creditsEarned} Credits earned!`, { icon: '⭐' });
                }
            } catch (error) {
                console.error('Error saving level progress to game:', error);
                toast.error('Failed to save progress');
            }
        } else {
            // Save as new game if no gameId
            await saveGameProgress(updatedLevels);
        }

        // Also save to gamification profile for Credits (only if stars earned)
        if (earnedStars > 0) {
            try {
                const token = localStorage.getItem('authToken');
                await axios.post(
                    `${import.meta.env.VITE_API_BASE_URL}/gamification/skill-tree/complete-level`,
                    {
                        topic,
                        levelId: playingLevel.id,
                        stars: earnedStars,
                        score: completedScore,
                        totalQuestions
                    },
                    { headers: { Authorization: `Bearer ${token}` } }
                );
            } catch (error) {
                console.error('Error saving level progress:', error);
            }
        }
    };

    const closeLevel = () => {
        setPlayingLevel(null);
        setLevelQuestions([]);
        setShowResults(false);
        setScore(0);
        setFinalScore(0);
        setSelectedAnswer(null);
        setShowExplanation(false);
        setAnswerSubmitted(false);
        setQuestionXp(0);
    };

    const goToNextLevel = () => {
        // Find current level index and get next level
        const currentIndex = levels.findIndex(l => l.id === playingLevel.id);
        const nextLevel = levels[currentIndex + 1];

        if (nextLevel && nextLevel.status === 'unlocked') {
            setLevelQuestions([]);
            setShowResults(false);
            setScore(0);
            setFinalScore(0);
            setShowExplanation(false);
            setAnswerSubmitted(false);
            setQuestionXp(0);
            setCurrentQuestionIndex(0);
            setSelectedAnswer(null);

            // Set next level as selected and start it
            setSelectedLevel(nextLevel);
            setPlayingLevel(nextLevel);

            // Fetch questions for next level; if it fails, notify and don't switch
            (async () => {
                const errMsg = await fetchLevelQuestions(nextLevel);
                if (errMsg) {
                    toast(errMsg, {
                        icon: '⚠️',
                        style: {
                            background: '#18181b',
                            color: '#fff',
                            border: '1px solid #ef4444',
                            fontWeight: '500'
                        }
                    });
                    return;
                }
            })();
        } else {
            // No next level or it's locked - go back to map
            closeLevel();
        }
    };

    const fetchLevelQuestions = async (level) => {
        setQuestionsFetching(true);
        try {
            const token = localStorage.getItem('authToken');
            const payload = {
                topic,
                levelId: level.id,
                levelName: level.name,
                difficulty: level.difficulty,
                gameId: currentGameId // Pass gameId to retrieve saved questions or save new ones
            };

            const response = await axios.post(
                `${import.meta.env.VITE_API_BASE_URL}/gamification/skill-tree/level-questions`,
                payload,
                { headers: { Authorization: `Bearer ${token}` }, timeout: 35000 }
            );
            
            if (response.data.aiQuotaExceeded || response.data.aiGenerationFailed) {
                const msg = response.data.message || 'AI unavailable';
                setLevelLoadError(msg);
                return msg;
            }

            setLevelQuestions(response.data.questions || []);
            return null;
        } catch (error) {
            console.error('[SkillTreeGameMap] Error fetching questions:', error);
            const isTimeout = error.code === 'ECONNABORTED' || error.message?.includes('timeout');
            const resp = error.response;
            const msg = isTimeout
                ? 'Question generation timed out. Please try again.'
                : (resp?.data?.message || 'Failed to load level questions. Please try again.');
            setLevelLoadError(msg);
            return msg;
        } finally {
            setQuestionsFetching(false);
        }
    };

    // Get path positions for candy crush style - CURVED PATH
    const getLevelPosition = (index, total) => {
        const amplitude = 35; // How far left/right the zigzag goes
        const verticalSpacing = 100; // Space between levels vertically

        // Create a smooth sine wave pattern
        const x = 50 + Math.sin(index * 0.8) * amplitude;
        const y = 60 + (index * verticalSpacing);

        return { x, y, index };
    };

    // Get level colors based on difficulty
    const getLevelColors = (level, index) => {
        if (level.status === 'completed') {
            return {
                bg: 'from-slate-200 via-slate-300 to-slate-400',
                shadow: 'shadow-slate-400/50',
                glow: 'bg-slate-300'
            };
        }
        if (level.status === 'unlocked') {
            // Rotating vibrant colors for unlocked
            const colors = [
                { bg: 'from-slate-500 via-slate-600 to-slate-700', shadow: 'shadow-slate-500/50', glow: 'bg-slate-400' },
                { bg: 'from-slate-400 via-slate-500 to-slate-600', shadow: 'shadow-slate-400/50', glow: 'bg-slate-300' },
                { bg: 'from-gray-400 via-gray-500 to-gray-600', shadow: 'shadow-gray-400/50', glow: 'bg-gray-300' },
                { bg: 'from-zinc-500 via-zinc-600 to-zinc-700', shadow: 'shadow-zinc-500/50', glow: 'bg-zinc-400' },
            ];
            return colors[index % colors.length];
        }
        return {
            bg: 'from-slate-600 to-slate-700',
            shadow: 'shadow-slate-700/30',
            glow: 'bg-slate-500'
        };
    };

    const renderStars = (count, size = 'sm') => {
        const sizeClass = size === 'lg' ? 'w-6 h-6' : 'w-4 h-4';
        return (
            <div className="flex gap-0.5">
                {[1, 2, 3].map(star => (
                    <Star
                        key={star}
                        className={`${sizeClass} ${star <= count ? 'text-blue-300 fill-blue-300' : 'text-gray-600'}`}
                    />
                ))}
            </div>
        );
    };

    // Capitalize first letter of each word
    const formatTopic = (str) => {
        if (!str) return '';
        return str.split(' ').map(word =>
            word.charAt(0).toUpperCase() + word.slice(1)
        ).join(' ');
    };

    if (loading) {
        return (
            <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-black flex items-center justify-center">
                <div className="text-center">
                    <Loader2 className="w-16 h-16 text-slate-300 animate-spin mx-auto mb-4" />
                    <h2 className="text-2xl font-bold text-white mb-2">Building Your Skill Tree</h2>
                    <div className="space-y-1 text-sm text-slate-400 mb-2">
                        <p>⏳ Checking cache…</p>
                        <p>🔍 Searching database…</p>
                        <p className="text-slate-500">🤖 Generating via AI…</p>
                    </div>
                    <p className="text-slate-500">Personalizing levels for {topic}...</p>
                </div>
            </div>
        );
    }

    // Error / auto-retry state — backend auto-generates levels now
    if (levelLoadError && levels.length === 0) {
        return (
            <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-black flex items-center justify-center p-6">
                <div className="bg-slate-800/80 backdrop-blur-sm rounded-3xl p-8 max-w-md w-full text-center border border-slate-500/30">
                    <Loader2 className="w-12 h-12 text-slate-300 animate-spin mx-auto mb-4" />
                    <h2 className="text-2xl font-bold text-white mb-2">Generating Your Skill Tree</h2>
                    <p className="text-slate-300 mb-2">{levelLoadError}</p>
                    <p className="text-slate-500 text-sm mb-6">Creating personalized levels for {topic}...</p>
                    <button
                        onClick={() => {
                            setLevelLoadError('');
                            generateLevels();
                        }}
                        className="w-full py-3 bg-slate-700 hover:bg-slate-600 text-white rounded-xl font-bold transition-colors"
                    >
                        Retry
                    </button>
                    <button
                        onClick={() => navigate('/gamification/skill-tree')}
                        className="w-full py-3 mt-2 bg-slate-800 hover:bg-slate-700 text-gray-300 rounded-xl font-medium transition-colors text-sm"
                    >
                        <span className="flex items-center justify-center gap-2">
                            <ArrowLeft className="w-4 h-4" />
                            Back to Skill Trees
                        </span>
                    </button>
                </div>
            </div>
        );
    }

    // Loading overlay while questions are being fetched for a level
    if (playingLevel && questionsFetching) {
        return (
            <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-black flex items-center justify-center p-6">
                <div className="text-center">
                    <div className="relative w-24 h-24 mx-auto mb-6">
                        <Loader2 className="w-24 h-24 text-slate-400 animate-spin" />
                        <div className="absolute inset-0 flex items-center justify-center">
                            <span className="text-2xl">🧠</span>
                        </div>
                    </div>
                    <h2 className="text-2xl font-bold text-white mb-2">Preparing Questions</h2>
                    <div className="space-y-1 text-sm text-slate-400 mb-2">
                        <p>⏳ Checking cache…</p>
                        <p>🔍 Checking question bank…</p>
                        <p className="text-slate-500">🤖 Generating via AI if needed…</p>
                    </div>
                    <p className="text-slate-200 font-semibold">{playingLevel.name}</p>
                    <p className="text-slate-500 text-sm mt-2">This may take a few seconds…</p>
                </div>
            </div>
        );
    }

    // Playing a level
    if (playingLevel && levelQuestions.length > 0) {
        const currentQuestion = levelQuestions[currentQuestionIndex];

        if (showResults) {
            const percentage = (finalScore / levelQuestions.length) * 100;
            const earnedStars = percentage >= 90 ? 3 : percentage >= 70 ? 2 : percentage >= 50 ? 1 : 0;
            const isNearMiss = percentage >= 40 && percentage < 50; // 40-49% — encouraging near-miss tier
            
            return (
                <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-black flex items-center justify-center p-6">
                    <div
                       
                       
                        className="bg-slate-800/80 backdrop-blur-sm rounded-3xl p-8 max-w-md w-full text-center border border-slate-600/50"
                    >
                        <div
                           
                           
                           
                            className={`w-24 h-24 rounded-full mx-auto mb-6 flex items-center justify-center ${
                                earnedStars >= 2 ? 'bg-gradient-to-br from-slate-300 to-slate-400' :
                                earnedStars === 1 ? 'bg-gradient-to-br from-blue-400 to-blue-500' :
                                isNearMiss ? 'bg-gradient-to-br from-amber-500 to-orange-500' :
                                'bg-gradient-to-br from-gray-500 to-gray-600'
                            }`}
                        >
                            {earnedStars >= 2 ? (
                                <Trophy className="w-12 h-12 text-white" />
                            ) : earnedStars === 1 ? (
                                <CheckCircle2 className="w-12 h-12 text-white" />
                            ) : isNearMiss ? (
                                <Flame className="w-12 h-12 text-white" />
                            ) : (
                                <Target className="w-12 h-12 text-white" />
                            )}
                        </div>

                        <h2 className="text-3xl font-bold text-white mb-2">
                            {earnedStars >= 2 ? 'Excellent!' : earnedStars === 1 ? 'Good Job!' : isNearMiss ? 'So Close!' : 'Keep Trying!'}
                        </h2>

                        {isNearMiss && (
                            <p className="text-amber-300 text-sm mb-2 font-medium">
                                Just {Math.ceil(levelQuestions.length * 0.5) - finalScore} more correct answer{Math.ceil(levelQuestions.length * 0.5) - finalScore !== 1 ? 's' : ''} to pass — you can do it!
                            </p>
                        )}

                        <p className="text-slate-400 mb-4">{playingLevel.name} Complete</p>
                        
                        <div className="flex justify-center mb-6" data-testid="stars-earned" data-stars={earnedStars}>
                            {renderStars(earnedStars, 'lg')}
                        </div>

                        <div className="bg-slate-900/50 rounded-xl p-4 mb-6">
                            <div className="flex justify-between text-sm text-slate-400 mb-2">
                                <span>Score</span>
                                <span className="text-white font-bold">{finalScore}/{levelQuestions.length}</span>
                            </div>
                            <div className="flex justify-between text-sm text-slate-400 mb-2">
                                <span>Accuracy</span>
                                <span className="text-white font-bold">{Math.round(percentage)}%</span>
                            </div>
                            {earnedStars > 0 && (
                                <div className="flex justify-between text-sm text-slate-400">
                                    <span>Credits Earned</span>
                                    <span className="text-blue-300 font-bold">+{earnedStars === 3 ? 10 : earnedStars === 2 ? 8 : 5} Credits</span>
                                </div>
                            )}
                        </div>

                        <div className="flex gap-3">
                            <button
                                onClick={closeLevel}
                                className="flex-1 px-6 py-3 bg-slate-700 hover:bg-slate-600 rounded-xl font-semibold text-white transition-colors"
                               
                               
                            >
                                Back to Map
                            </button>
                            {earnedStars === 0 ? (
                                // No stars (including near-miss) - show Retry button
                                <button
                                    onClick={async () => {
                                        setShowResults(false);
                                        setCurrentQuestionIndex(0);
                                        setScore(0);
                                        setFinalScore(0);
                                        setSelectedAnswer(null);
                                        setShowExplanation(false);
                                        setAnswerSubmitted(false);
                                        setQuestionXp(0);
                                        setLevelLoadError('');
                                        // Re-fetch fresh questions so retry never repeats the same set
                                        const errorMsg = await fetchLevelQuestions(playingLevel);
                                        if (errorMsg) {
                                            toast(errorMsg, {
                                                icon: '⚠️',
                                                style: { background: '#18181b', color: '#fff', border: '1px solid #ef4444', fontWeight: '500' }
                                            });
                                            setPlayingLevel(null);
                                        }
                                    }}
                                    className={`flex-1 px-6 py-3 rounded-xl font-semibold text-white ${
                                        isNearMiss
                                            ? 'bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500'
                                            : 'bg-gradient-to-r from-slate-500 to-slate-600'
                                    }`}
                                >
                                    {isNearMiss ? '🔥 Try Again' : 'Retry'}
                                </button>
                            ) : (
                                // At least 1 star - show Next Level button
                                <button
                                    onClick={goToNextLevel}
                                    className="flex-1 px-6 py-3 bg-gradient-to-r from-slate-600 to-slate-500 rounded-xl font-semibold text-white"
                                   
                                   
                                >
                                    Next Level →
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            );
        }

        return (
            <div className="min-h-screen max-h-screen overflow-hidden bg-gradient-to-b from-slate-900 via-slate-800 to-black p-6">
                <div className="max-w-2xl mx-auto h-full flex flex-col">
                    {/* Header */}
                    <div className="flex items-center justify-between mb-4 flex-shrink-0">
                        <button
                            onClick={closeLevel}
                            className="p-2 rounded-lg bg-slate-800/50 text-slate-400 hover:text-white transition-colors"
                        >
                            <ArrowLeft className="w-6 h-6" />
                        </button>
                        <div className="text-center">
                            <h3 className="text-lg font-semibold text-white">{playingLevel.name}</h3>
                            <p className="text-sm text-slate-400">{topic}</p>
                        </div>
                        <div className="flex items-center gap-2 bg-slate-800/50 rounded-lg px-3 py-1">
                            <Zap className="w-4 h-4 text-blue-300" />
                            <span className="text-white font-bold">{score}</span>
                        </div>
                    </div>

                    {/* Progress */}
                    <div className="mb-4 flex-shrink-0">
                        <div className="flex justify-between text-sm text-slate-400 mb-2">
                            <span>Question {currentQuestionIndex + 1} of {levelQuestions.length}</span>
                        </div>
                        <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-gradient-to-r from-slate-500 to-slate-400"
                               
                                style={{ width: `${((currentQuestionIndex + 1) / levelQuestions.length) * 100}%` }}
                            />
                        </div>
                    </div>

                    {/* Question + Explanation - Scrollable */}
                    <div className="flex-1 overflow-y-auto pr-2 game-scrollbar">
                        <div
                            key={currentQuestionIndex}
                            className="bg-slate-800/60 backdrop-blur-sm rounded-2xl p-6 border border-slate-600/50 mb-4"
                        >
                            <h2 className="text-xl font-semibold text-white mb-6 leading-relaxed">
                                {currentQuestion?.question || ''}
                            </h2>

                            <div className="space-y-3">
                                {(currentQuestion?.options || []).map((option, idx) => {
                                    const isSelected = selectedAnswer === idx;
                                    const isCorrect = idx === currentQuestion.correctIndex;
                                    const showResult = selectedAnswer !== null;

                                    return (
                                        <button
                                            key={idx}
                                            onClick={() => handleAnswerSelect(idx)}
                                            disabled={selectedAnswer !== null}
                                            className={`w-full p-4 rounded-xl text-left transition-all ${
                                                showResult
                                                    ? isCorrect
                                                        ? 'bg-emerald-500/10 border-2 border-emerald-500 text-emerald-300'
                                                        : isSelected
                                                            ? 'bg-red-500/10 border-2 border-red-500 text-red-300'
                                                            : 'bg-slate-700/50 border border-slate-600 text-slate-500'
                                                    : 'bg-slate-700/50 border border-slate-600 text-white hover:bg-slate-700 hover:border-slate-500'
                                            }`}
                                        >
                                            <div className="flex items-center gap-3">
                                                <span className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 ${
                                                    showResult && isCorrect ? 'bg-emerald-500 text-white' :
                                                    showResult && isSelected ? 'bg-red-500 text-white' :
                                                    'bg-slate-600 text-slate-300'
                                                }`}>
                                                    {String.fromCharCode(65 + idx)}
                                                </span>
                                                <span className="flex-1">{option}</span>
                                                {showResult && isCorrect && <Check className="w-5 h-5 text-emerald-400" />}
                                                {showResult && isSelected && !isCorrect && <span className="text-red-400 text-sm font-medium">✗</span>}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>

                            {/* ── Explanation Screen ── */}
                            {showExplanation && (
                                <div className="mt-6 pt-6 border-t border-slate-600/40 space-y-4">
                                    {/* Correct/Incorrect */}
                                    <div className={`flex items-center gap-3 p-3 rounded-xl ${
                                        selectedAnswer === currentQuestion.correctIndex
                                            ? 'bg-emerald-500/10 border border-emerald-500/30'
                                            : 'bg-red-500/10 border border-red-500/30'
                                    }`}>
                                        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                                            selectedAnswer === currentQuestion.correctIndex
                                                ? 'bg-emerald-500/20 text-emerald-400'
                                                : 'bg-red-500/20 text-red-400'
                                        }`}>
                                            {selectedAnswer === currentQuestion.correctIndex ? (
                                                <Check className="w-5 h-5" />
                                            ) : (
                                                <span className="text-lg font-bold">✗</span>
                                            )}
                                        </div>
                                        <div>
                                            <p className={`font-semibold ${
                                                selectedAnswer === currentQuestion.correctIndex
                                                    ? 'text-emerald-300' : 'text-red-300'
                                            }`}>
                                                {selectedAnswer === currentQuestion.correctIndex ? 'Correct!' : 'Incorrect'}
                                            </p>
                                            <p className="text-sm text-slate-400">
                                                {selectedAnswer === currentQuestion.correctIndex
                                                    ? `+${questionXp} XP`
                                                    : `Correct answer: ${String.fromCharCode(65 + (currentQuestion.correctIndex ?? 0))}`}
                                            </p>
                                        </div>
                                        <div className="ml-auto text-xs text-slate-500">
                                            +{questionXp} XP
                                        </div>
                                    </div>

                                    {/* Detailed Explanation */}
                                    {currentQuestion.explanation && (
                                        <div className="bg-slate-900/50 rounded-xl p-4">
                                            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Explanation</p>
                                            <p className="text-sm text-slate-200 leading-relaxed">{currentQuestion.explanation}</p>
                                        </div>
                                    )}

                                    {/* Why other options are wrong */}
                                    <div className="bg-slate-900/50 rounded-xl p-4">
                                        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Why Other Options Are Incorrect</p>
                                        <div className="space-y-2">
                                            {(currentQuestion?.options || []).map((option, idx) => {
                                                if (idx === currentQuestion.correctIndex) return null;
                                                const isUsersChoice = selectedAnswer === idx;
                                                return (
                                                    <div key={idx} className={`text-sm p-2 rounded-lg ${
                                                        isUsersChoice ? 'bg-red-500/10 border border-red-500/20' : ''
                                                    }`}>
                                                        <span className="text-slate-400 font-mono mr-2">{String.fromCharCode(65 + idx)}.</span>
                                                        <span className={isUsersChoice ? 'text-red-300' : 'text-slate-400'}>{option}</span>
                                                        {isUsersChoice && <span className="ml-2 text-red-400 text-xs">(your choice)</span>}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>

                                    {/* Next Question Button */}
                                    <button
                                        onClick={handleNextQuestion}
                                        className="w-full py-3 bg-gradient-to-r from-slate-500 to-slate-400 hover:from-slate-400 hover:to-slate-300 text-white rounded-xl font-semibold transition-all"
                                    >
                                        {currentQuestionIndex < levelQuestions.length - 1 ? 'Next Question →' : 'See Results'}
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-black overflow-hidden">
            {/* Animated Background Stars */}
            <div className="fixed inset-0 overflow-hidden pointer-events-none">
                {[...Array(20)].map((_, i) => (
                    <div
                        key={i}
                        className="absolute w-1 h-1 bg-white rounded-full"
                        style={{
                            left: `${Math.random() * 100}%`,
                            top: `${Math.random() * 100}%`,
                        }}
                    />
                ))}
            </div>

            {/* Header */}
            <div className="sticky top-0 z-20 bg-gradient-to-b from-slate-900 via-slate-900/95 to-transparent pb-4">
                <div className="bg-slate-900/90 backdrop-blur-sm border-b border-slate-600/30 p-4">
                    <div className="max-w-4xl mx-auto flex items-center justify-between">
                        <button
                            onClick={() => navigate('/gamification/skill-tree')}
                            className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors"
                        >
                            <ArrowLeft className="w-5 h-5" />
                            <span>Back</span>
                        </button>
                        <div className="text-center">
                            <h1 className="text-xl font-bold text-white capitalize">{formatTopic(topic)}</h1>
                            <p className="text-sm text-slate-400">Skill Tree Adventure</p>
                        </div>
                        <div className="flex items-center gap-2 bg-gradient-to-r from-slate-700/50 to-slate-600/50 rounded-lg px-3 py-1.5 border border-slate-600/50">
                            <Trophy className="w-4 h-4 text-blue-300" />
                            <span className="text-white font-bold">
                                {levels.filter(l => l.status === 'completed').length}/{levels.length}
                            </span>
                        </div>
                    </div>
                </div>

                {/* Progress Bar */}
                <div className="max-w-md mx-auto mt-3 px-6">
                    <div className="flex items-center gap-3">
                        <div className="flex-1 h-3 bg-slate-800/80 rounded-full overflow-hidden border border-slate-600/30">
                            <div
                                className="h-full bg-gradient-to-r from-slate-500 via-slate-400 to-slate-300"
                               
                                style={{ width: `${(levels.filter(l => l.status === 'completed').length / levels.length) * 100}%` }}
                               
                            />
                        </div>
                        <div className="flex items-center gap-1">
                            <Star className="w-4 h-4 text-blue-300 fill-blue-300" />
                            <span className="text-sm font-bold text-blue-300">
                                {levels.reduce((sum, l) => sum + (l.stars || 0), 0)}
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Level Map */}
            <div
                ref={scrollRef}
                className="overflow-y-auto px-4 py-4"
                style={{ height: 'calc(100vh - 120px)' }}
            >
                <div
                    className="relative max-w-sm mx-auto"
                    style={{ minHeight: `${levels.length * 100 + 100}px` }}
                >
                    {/* Decorative path background */}
                    <div className="absolute inset-0 pointer-events-none">
                        <svg
                            className="absolute inset-0 w-full h-full"
                            style={{ minHeight: `${levels.length * 100 + 100}px` }}
                            viewBox={`0 0 100 ${levels.length * 100 + 100}`}
                            preserveAspectRatio="none"
                        >
                            <defs>
                                <linearGradient id="pathGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                                    <stop offset="0%" stopColor="rgba(148, 163, 184, 0.3)" />
                                    <stop offset="100%" stopColor="rgba(100, 116, 139, 0.3)" />
                                </linearGradient>
                                <filter id="glow">
                                    <feGaussianBlur stdDeviation="3" result="coloredBlur" />
                                    <feMerge>
                                        <feMergeNode in="coloredBlur" />
                                        <feMergeNode in="SourceGraphic" />
                                    </feMerge>
                                </filter>
                            </defs>

                            {/* Main curved path — visible portion (up to a few levels ahead) */}
                            {levels.length > 1 && (() => {
                                const progressIdx = Math.max(...levels.map((l, i) => l.status !== 'locked' ? i : -1), 0);
                                const visibleEnd = Math.min(progressIdx + 3, levels.length);
                                return (
                                    <>
                                        {/* Visible path up to near-fog boundary */}
                                        <path
                                            d={levels.slice(0, visibleEnd).map((_, idx) => {
                                                const pos = getLevelPosition(idx, levels.length);
                                                return idx === 0
                                                    ? `M ${pos.x} ${pos.y}`
                                                    : `L ${pos.x} ${pos.y}`;
                                            }).join(' ')}
                                            fill="none"
                                            stroke="url(#pathGradient)"
                                            strokeWidth="8"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            filter="url(#glow)"
                                        />
                                        {/* Faded path beyond fog boundary */}
                                        {visibleEnd < levels.length && (
                                            <path
                                                d={levels.slice(visibleEnd - 1).map((_, i) => {
                                                    const pos = getLevelPosition(visibleEnd - 1 + i, levels.length);
                                                    return i === 0
                                                        ? `M ${pos.x} ${pos.y}`
                                                        : `L ${pos.x} ${pos.y}`;
                                                }).join(' ')}
                                                fill="none"
                                                stroke="rgba(100, 116, 139, 0.08)"
                                                strokeWidth="6"
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                strokeDasharray="8 12"
                                            />
                                        )}
                                    </>
                                );
                            })()}

                            {/* Completed path overlay */}
                            {levels.some(l => l.status === 'completed') && (
                                <path
                                    d={levels.slice(0, levels.findIndex(l => l.status !== 'completed') + 1 || levels.length).map((_, idx) => {
                                        const pos = getLevelPosition(idx, levels.length);
                                        return idx === 0
                                            ? `M ${pos.x} ${pos.y}`
                                            : `L ${pos.x} ${pos.y}`;
                                    }).join(' ')}
                                    fill="none"
                                    stroke="rgba(255, 255, 255, 0.6)"
                                    strokeWidth="6"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                />
                            )}
                        </svg>
                    </div>

                    {/* Level nodes */}
                    {levels.map((level, idx) => {
                        const pos = getLevelPosition(idx, levels.length);
                        const isLocked = level.status === 'locked';
                        const isCompleted = level.status === 'completed';
                        const isUnlocked = level.status === 'unlocked';
                        const colors = getLevelColors(level, idx);
                        const isBossLevel = (idx + 1) % 5 === 0; // Every 5th level is a boss

                        // Fog-of-war: calculate distance from player's current progress
                        const currentProgressIdx = Math.max(...levels.map((l, i) => l.status !== 'locked' ? i : -1), 0);
                        const fogDistance = isLocked ? idx - currentProgressIdx : 0;
                        const fogOpacity = !isLocked ? 1 : fogDistance <= 2 ? 0.45 : fogDistance <= 5 ? 0.18 : 0.08;
                        const fogBlur = !isLocked ? '' : fogDistance <= 2 ? '' : fogDistance <= 5 ? 'blur-[1px]' : 'blur-[2px]';
                        const showLabel = !isLocked || fogDistance <= 2;
                        const showLevelNumber = !isLocked || fogDistance <= 2;

                        return (
                            <div
                                key={level.id}
                                className={`absolute transform -translate-x-1/2 -translate-y-1/2 ${fogBlur}`}
                                style={{ left: `${pos.x}%`, top: pos.y, opacity: fogOpacity }}
                               
                               
                               
                            >
                                {/* Decorative ring for special levels */}
                                {isBossLevel && !isLocked && (
                                    <div
                                        className="absolute inset-0 -m-3 rounded-full border-4 border-slate-400/50"
                                       
                                       
                                    >
                                        <div className="absolute -top-1 left-1/2 transform -translate-x-1/2 w-2 h-2 bg-slate-300 rounded-full" />
                                    </div>
                                )}

                                <button
                                    onClick={() => handleLevelClick(level)}
                                    className={`relative flex items-center justify-center shadow-xl transition-all ${
                                        isBossLevel
                                            ? 'w-20 h-20 rounded-2xl rotate-45'
                                            : 'w-16 h-16 rounded-full'
                                    } bg-gradient-to-br ${colors.bg} ${colors.shadow} ${
                                        isLocked ? '' : ''
                                    }`}
                                    disabled={isLocked}
                                >
                                    {/* Inner content - counter-rotate for boss levels */}
                                    <div className={isBossLevel ? '-rotate-45' : ''}>
                                        {isLocked ? (
                                            showLevelNumber
                                                ? <Lock className="w-6 h-6 text-slate-400" />
                                                : <div className="w-6 h-6 rounded-full bg-slate-600/50" />
                                        ) : isCompleted ? (
                                            <div className="flex flex-col items-center">
                                                <CheckCircle2 className="w-6 h-6 text-white" />
                                            </div>
                                        ) : isBossLevel ? (
                                            <Crown className="w-7 h-7 text-blue-300" />
                                        ) : (
                                            <span className="text-2xl font-black text-white drop-shadow-lg">{level.id}</span>
                                        )}
                                    </div>

                                    {/* Pulse animation for unlocked levels */}
                                    {isUnlocked && (
                                        <>
                                            <div
                                                className={`absolute inset-0 ${isBossLevel ? 'rounded-2xl' : 'rounded-full'} ${colors.glow}`}
                                               
                                               
                                            />
                                            {/* Sparkle effect */}
                                            <div
                                                className="absolute -top-1 -right-1"
                                               
                                               
                                            >
                                                <Sparkles className="w-4 h-4 text-blue-300" />
                                            </div>
                                        </>
                                    )}

                                    {/* Flame effect for streak */}
                                    {isUnlocked && idx > 0 && levels[idx - 1]?.status === 'completed' && (
                                        <div
                                            className="absolute -top-3 left-1/2 transform -translate-x-1/2"
                                           
                                           
                                        >
                                            <Flame className="w-5 h-5 text-slate-300" />
                                        </div>
                                    )}
                                </button>

                                {/* Level name label — only for non-fogged levels */}
                                {showLabel && !isLocked && (
                                    <div
                                        className={`absolute ${pos.x > 50 ? 'right-full mr-3' : 'left-full ml-3'} top-1/2 transform -translate-y-1/2 whitespace-nowrap`}
                                       
                                       
                                       
                                    >
                                        <div className="bg-slate-800/90 backdrop-blur-sm rounded-lg px-3 py-1.5 border border-slate-600/30">
                                            <p className="text-xs font-semibold text-white truncate max-w-[120px]">{level.name}</p>
                                            {isCompleted && level.stars > 0 && (
                                                <div className="flex gap-0.5 mt-0.5">
                                                    {[1, 2, 3].map(star => (
                                                        <Star
                                                            key={star}
                                                            className={`w-3 h-3 ${star <= level.stars ? 'text-blue-300 fill-blue-300' : 'text-gray-600'}`}
                                                        />
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}

                    {/* End goal decoration */}
                    <div
                        className="absolute transform -translate-x-1/2"
                        style={{
                            left: `${getLevelPosition(levels.length - 1, levels.length).x}%`,
                            top: getLevelPosition(levels.length - 1, levels.length).y + 80
                        }}
                       
                       
                       
                    >
                        <div className="flex flex-col items-center">
                            <div
                               
                               
                            >
                                <Gift className="w-10 h-10 text-blue-300" />
                            </div>
                            <p className="text-sm font-bold text-slate-400 mt-2">Master {formatTopic(topic)}!</p>
                        </div>
                    </div>
                </div>
            </div>

            {/* Level Modal */}
                {showLevelModal && selectedLevel && (
                    <div
                       
                       
                       
                        className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4"
                        onClick={() => setShowLevelModal(false)}
                    >
                        <div
                           
                           
                           
                            className="relative bg-gradient-to-b from-slate-800 to-slate-900 rounded-3xl p-6 max-w-sm w-full border border-slate-600/50 shadow-2xl shadow-slate-900/50"
                            onClick={e => e.stopPropagation()}
                        >
                            {/* Decorative top banner */}
                            <div className="absolute -top-3 left-1/2 transform -translate-x-1/2 z-10">
                                <div className={`text-white text-xs font-bold px-4 py-1 rounded-full shadow-lg ${
                                    selectedLevel.difficulty === 'hard'
                                        ? 'bg-gradient-to-r from-slate-600 to-slate-700'
                                        : selectedLevel.difficulty === 'medium'
                                            ? 'bg-gradient-to-r from-slate-500 to-slate-600'
                                            : 'bg-gradient-to-r from-slate-400 to-slate-500'
                                }`}>
                                    {selectedLevel.difficulty?.toUpperCase() || 'EASY'}
                                </div>
                            </div>

                            <div className="text-center mb-6 pt-2">
                                {/* Level icon with animation */}
                                <div
                                    className={`w-24 h-24 rounded-full mx-auto mb-4 flex items-center justify-center relative ${
                                        selectedLevel.status === 'completed'
                                            ? 'bg-gradient-to-br from-slate-200 to-slate-400'
                                            : 'bg-gradient-to-br from-slate-600 via-slate-500 to-slate-400'
                                    }`}
                                   
                                   
                                >
                                    {selectedLevel.status === 'completed' ? (
                                        <Trophy className="w-12 h-12 text-blue-300" />
                                    ) : (
                                        <span className="text-4xl font-black text-white drop-shadow-lg">{selectedLevel.id}</span>
                                    )}

                                    {/* Sparkles around */}
                                    <div
                                        className="absolute -top-2 -right-2"
                                       
                                       
                                    >
                                        <Sparkles className="w-6 h-6 text-blue-300" />
                                    </div>
                                </div>

                                <h3 className="text-2xl font-bold text-white mb-2">{selectedLevel.name}</h3>
                                <p className="text-slate-400 text-sm">{selectedLevel.description}</p>
                                
                                {selectedLevel.status === 'completed' && (
                                    <div
                                        className="flex justify-center mt-4 gap-1"
                                       
                                       
                                       
                                    >
                                        {[1, 2, 3].map(star => (
                                            <div
                                                key={star}
                                               
                                               
                                               
                                            >
                                                <Star
                                                    className={`w-8 h-8 ${star <= selectedLevel.stars ? 'text-blue-300 fill-blue-300' : 'text-gray-600'}`}
                                                />
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* Stats grid */}
                            <div className="grid grid-cols-2 gap-3 mb-6">
                                <div className="bg-slate-800/50 rounded-xl p-3 text-center border border-slate-700/50">
                                    <Target className="w-5 h-5 text-blue-300 mx-auto mb-1" />
                                    <p className="text-xs text-slate-400">Questions</p>
                                    <p className="text-lg font-bold text-white">5</p>
                                </div>
                                <div className="bg-slate-800/50 rounded-xl p-3 text-center border border-slate-700/50">
                                    <Zap className="w-5 h-5 text-blue-300 mx-auto mb-1" />
                                    <p className="text-xs text-slate-400">Credits Reward</p>
                                    <p className="text-lg font-bold text-white">
                                        {selectedLevel.status === 'completed' ? '✓' : '5-10'}
                                    </p>
                                </div>
                            </div>

                            {/* Credits breakdown */}
                            {selectedLevel.status !== 'completed' && (
                                <div className="bg-gradient-to-r from-slate-800/50 to-slate-700/50 rounded-xl p-3 mb-6 border border-slate-600/30">
                                    <p className="text-xs text-center text-slate-400 mb-2">Credits based on stars earned</p>
                                    <div className="flex justify-around">
                                        <div className="text-center">
                                            <Star className="w-4 h-4 text-blue-300 fill-blue-300 mx-auto" />
                                            <p className="text-sm font-bold text-white">5 Credits</p>
                                        </div>
                                        <div className="text-center">
                                            <div className="flex">
                                                <Star className="w-4 h-4 text-blue-300 fill-blue-300" />
                                                <Star className="w-4 h-4 text-blue-300 fill-blue-300" />
                                            </div>
                                            <p className="text-sm font-bold text-white">8 Credits</p>
                                        </div>
                                        <div className="text-center">
                                            <div className="flex">
                                                <Star className="w-4 h-4 text-blue-300 fill-blue-300" />
                                                <Star className="w-4 h-4 text-blue-300 fill-blue-300" />
                                                <Star className="w-4 h-4 text-blue-300 fill-blue-300" />
                                            </div>
                                            <p className="text-sm font-bold text-white">10 Credits</p>
                                        </div>
                                    </div>
                                </div>
                            )}

                            <div className="flex gap-3">
                                <button
                                    onClick={() => setShowLevelModal(false)}
                                    className="flex-1 px-4 py-3 bg-slate-700 hover:bg-slate-600 rounded-xl font-semibold text-white transition-colors"
                                   
                                   
                                >
                                    Close
                                </button>
                                <button
                                    onClick={startLevel}
                                    className="flex-1 px-4 py-3 bg-gradient-to-r from-slate-600 via-slate-500 to-slate-400 rounded-xl font-semibold text-white flex items-center justify-center gap-2 shadow-lg shadow-slate-900/50"
                                   
                                   
                                >
                                    <Play className="w-5 h-5" />
                                    {selectedLevel.status === 'completed' ? 'Replay' : 'Play!'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}
        </div>
    );
};

export default SkillTreeGameMap;
