import React, { useState, useEffect } from 'react';
import Animate from '../core/Animate.jsx';
import { useNavigate, useLocation } from 'react-router-dom';
import {
    Gamepad2, Plus, Trophy, Star, ChevronRight, Trash2,
    Clock, Target, Zap, BookOpen, Loader2, Play, ArrowLeft, Coins, History, X
} from 'lucide-react';
import axios from 'axios';
import toast from 'react-hot-toast';

const SkillTreeGames = () => {
    const navigate = useNavigate();
    const location = useLocation();
    const [games, setGames] = useState([]);
    const [loading, setLoading] = useState(true);
    const [deleteConfirm, setDeleteConfirm] = useState(null);
    const [profileCredits, setProfileCredits] = useState(0);
    const [creditsHistory, setCreditsHistory] = useState([]);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [csvLoading, setCsvLoading] = useState(false);

    // Check if we just created a new game from assessment
    const newGameData = location.state?.newGame;
    const resumedGameId = location.state?.resumedGameId;
    const fromCsvUpload = location.state?.fromCsvUpload;
    const csvTopic = location.state?.topic;

    useEffect(() => {
        fetchGames();
        fetchProfileCredits();
    }, []);

    useEffect(() => {
        // If we have new game data, save it
        if (newGameData) {
            saveNewGame(newGameData);
            // Clear the state to prevent re-saving on refresh
            window.history.replaceState({}, document.title);
        }
    }, [newGameData]);

    // If a game was restored via credits, auto-open it once games are loaded
    useEffect(() => {
        if (resumedGameId && !loading && games.length > 0) {
            const resumed = games.find(g => g._id === resumedGameId);
            if (resumed) {
                handlePlayGame(resumed);
                window.history.replaceState({}, document.title);
            }
        }
    }, [resumedGameId, loading, games]);

    // CSV upload flow: auto-detect existing game or redirect to new game
    useEffect(() => {
        if (!loading && fromCsvUpload && csvTopic) {
            window.history.replaceState({}, document.title);
            setCsvLoading(true);
            const existingGame = games.find(g =>
                g.topic?.toLowerCase().trim() === csvTopic.toLowerCase().trim()
            );
            if (existingGame) {
                // Brief pause so user sees the loading state before navigation
                setTimeout(() => handlePlayGame(existingGame), 400);
            } else {
                setTimeout(() => {
                    navigate('/gamification/skill-tree/new', {
                        state: { fromCsvUpload: true, topic: csvTopic }
                    });
                }, 400);
            }
        }
    }, [loading, fromCsvUpload, csvTopic, games]);

    // Redirect to new game page if no games exist (and not coming with new game data)
    useEffect(() => {
        if (!loading && games.length === 0 && !newGameData && !resumedGameId && !fromCsvUpload) {
            navigate('/gamification/skill-tree/new', { state: { hasGames: false } });
        }
    }, [loading, games, newGameData, resumedGameId, fromCsvUpload, navigate]);

    const fetchGames = async () => {
        try {
            const token = localStorage.getItem('authToken');
            const response = await axios.get(
                `${import.meta.env.VITE_API_BASE_URL}/gamification/skill-tree/games`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            setGames(response.data.games || []);
        } catch (error) {
            console.error('[SkillTreeGames] Error fetching games:', error);
            toast.error('Failed to load your games');
        } finally {
            setLoading(false);
        }
    };

    const fetchProfileCredits = async () => {
        try {
            const token = localStorage.getItem('authToken');
            const response = await axios.get(
                `${import.meta.env.VITE_API_BASE_URL}/gamification/profile`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            setProfileCredits(response.data.totalLearningCredits || 0);
            setCreditsHistory(response.data.learningCreditsHistory || []);
        } catch (error) {
            console.error('[SkillTreeGames] Error fetching profile credits:', error);
        }
    };

    const saveNewGame = async (gameData) => {
        try {
            const token = localStorage.getItem('authToken');
            await axios.post(
                `${import.meta.env.VITE_API_BASE_URL}/gamification/skill-tree/games`,
                gameData,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            // Refresh games list
            fetchGames();
            toast.success(`"${gameData.topic}" skill tree created!`);
        } catch (error) {
            console.error('[SkillTreeGames] Error saving game:', error);
            toast.error('Failed to save game');
        }
    };

    const handlePlayGame = (game) => {
        navigate('/gamification/skill-tree/map', {
            state: {
                topic: game.topic,
                assessmentResult: game.assessmentResult,
                gameId: game._id,
                savedLevels: game.levels
            }
        });
    };

    const handleDeleteGame = async (gameId) => {
        try {
            const token = localStorage.getItem('authToken');
            await axios.delete(
                `${import.meta.env.VITE_API_BASE_URL}/gamification/skill-tree/games/${gameId}`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            setGames(prev => prev.filter(g => g._id !== gameId));
            toast.success('Game deleted');
            setDeleteConfirm(null);
        } catch (error) {
            console.error('[SkillTreeGames] Error deleting game:', error);
            toast.error('Failed to delete game');
        }
    };

    const handleCreateNew = () => {
        navigate('/gamification/skill-tree/new', { state: { hasGames: games.length > 0 } });
    };

    const getProgressPercentage = (game) => {
        if (!game.levels || game.levels.length === 0) return 0;
        const completed = game.levels.filter(l => l.status === 'completed').length;
        return Math.round((completed / game.levels.length) * 100);
    };

    const getTotalStars = (game) => {
        if (!game.levels) return 0;
        return game.levels.reduce((sum, l) => sum + (l.stars || 0), 0);
    };

    const getMaxStars = (game) => {
        if (!game.levels) return 0;
        return game.levels.length * 3;
    };

    // Capitalize first letter of each word
    const formatTopic = (topic) => {
        if (!topic) return '';
        return topic.split(' ').map(word =>
            word.charAt(0).toUpperCase() + word.slice(1)
        ).join(' ');
    };

    // Only show credits earned from skill tree completions
    const getTotalCredits = () => {
        return creditsHistory
            .filter(e => e.reason === 'skill_tree_completion')
            .reduce((sum, e) => sum + (e.amount || 0), 0);
    };

    if (csvLoading) {
        return (
            <div className="min-h-screen bg-black flex items-center justify-center">
                <div className="text-center">
                    <Loader2 className="w-12 h-12 text-white animate-spin mx-auto mb-4" />
                    <p className="text-white text-lg font-bold">Loading existing skill tree...</p>
                    <p className="text-zinc-500 text-sm mt-1">Restoring your progress and game data</p>
                </div>
            </div>
        );
    }

    if (loading) {
        return (
            <div className="min-h-screen bg-black flex items-center justify-center">
                <Loader2 className="w-12 h-12 text-white animate-spin" />
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-black p-6 overflow-y-auto">
            <div className="max-w-5xl mx-auto pb-20">
                {/* Top Bar with Back Button and Credits */}
                <div className="flex items-center justify-between mb-6">
                    <button
                        onClick={() => navigate('/')}
                        className="flex items-center gap-2 text-zinc-500 hover:text-white transition-colors hover:-translate-x-1"
                    >
                        <ArrowLeft className="w-5 h-5" />
                        <span>Back</span>
                    </button>

                    {/* Total Credits Display + History Button */}
                    <div className="flex items-center gap-2">
                        <span
                            data-testid="profile-credits"
                            className="flex items-center gap-1 bg-zinc-900 border border-zinc-700 rounded-xl px-3 py-2 text-sm font-bold text-yellow-400"
                            title="Total Learning Credits"
                        >
                            ⭐ {profileCredits}
                        </span>
                        <button
                            onClick={() => setHistoryOpen(true)}
                            className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-700 hover:border-zinc-500 rounded-xl px-3 py-2 transition-colors hover:scale-105 active:scale-95"
                            title="Credit History"
                        >
                            <History className="w-4 h-4 text-zinc-400" />
                        </button>
                    </div>
                </div>

                {/* Header */}
                <Animate
                    animation="slide-up"
                    className="text-center mb-10"
                >
                    <div className="w-16 h-16 bg-white rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-xl shadow-zinc-900">
                        <Gamepad2 className="w-8 h-8 text-black" />
                    </div>
                    <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">My Skill Trees</h1>
                    <p className="text-zinc-400">Continue learning or start a new adventure</p>
                </Animate>

                {/* Games Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {/* Create New Game Card */}
                    <button
                        onClick={handleCreateNew}
                        className="bg-zinc-950 border border-zinc-800 hover:border-white rounded-2xl p-6 flex flex-col items-center justify-center min-h-[280px] transition-all group hover:scale-[1.02] active:scale-[0.98]"
                    >
                        <div className="w-16 h-16 bg-zinc-900 group-hover:bg-white rounded-full flex items-center justify-center mb-4 transition-colors">
                            <Plus className="w-8 h-8 text-zinc-500 group-hover:text-black transition-colors" />
                        </div>
                        <h3 className="text-lg font-bold text-zinc-300 group-hover:text-white transition-colors">
                            New Skill Tree
                        </h3>
                        <p className="text-sm text-zinc-500 mt-1">Start a new learning adventure</p>
                    </button>

                    {/* Existing Games */}
                    {games.map((game, index) => {
                        const progress = getProgressPercentage(game);
                        const stars = getTotalStars(game);
                        const maxStars = getMaxStars(game);
                        const completedLevels = game.levels?.filter(l => l.status === 'completed').length || 0;
                        const totalLevels = game.levels?.length || 0;

                        return (
                            <Animate
                                key={game._id}
                                animation="slide-up"
                                delay={index * 100}
                                className="bg-zinc-900 rounded-2xl overflow-hidden border border-zinc-800 hover:border-zinc-600 transition-all group"
                            >
                                {/* Card Header - Monochrome */}
                                <div className="h-24 bg-zinc-800 relative border-b border-zinc-700">
                                    <div className="absolute bottom-3 left-4">
                                        <span className="px-3 py-1 bg-black/50 backdrop-blur-sm rounded-full text-xs font-mono font-medium text-white border border-zinc-600">
                                            {game.assessmentResult?.level || 'Beginner'}
                                        </span>
                                    </div>
                                    {/* Delete button */}
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setDeleteConfirm(game._id);
                                        }}
                                        className="absolute top-3 right-3 p-2 bg-black/30 hover:bg-red-900/80 hover:text-red-200 rounded-lg opacity-0 group-hover:opacity-100 transition-all"
                                    >
                                        <Trash2 className="w-4 h-4 text-zinc-300" />
                                    </button>
                                </div>

                                {/* Card Content */}
                                <div className="p-5">
                                    <h3 className="text-xl font-bold text-white mb-1 truncate capitalize tracking-tight">
                                        {formatTopic(game.topic)}
                                    </h3>
                                    <p className="text-sm text-zinc-500 mb-4 flex items-center gap-2 font-mono">
                                        <Clock className="w-3 h-3" />
                                        {new Date(game.updatedAt || game.createdAt).toLocaleDateString()}
                                    </p>

                                    {/* Progress Bar */}
                                    <div className="mb-4">
                                        <div className="flex justify-between text-xs text-zinc-400 mb-1 font-mono uppercase">
                                            <span>Progress</span>
                                            <span>{progress}%</span>
                                        </div>
                                        <div className="h-2 bg-zinc-950 rounded-full overflow-hidden border border-zinc-800">
                                            <div
                                                className="h-full bg-white transition-all duration-300"
                                                style={{ width: `${progress}%` }}
                                            />
                                        </div>
                                    </div>

                                    {/* Stats */}
                                    <div className="flex items-center justify-between mb-4">
                                        <div className="flex items-center gap-1.5 text-sm">
                                            <Target className="w-4 h-4 text-zinc-400" />
                                            <span className="text-white font-bold">{completedLevels}/{totalLevels}</span>
                                            <span className="text-zinc-500 text-xs uppercase">levels</span>
                                        </div>
                                        <div className="flex items-center gap-1.5 text-sm">
                                            <Star className="w-4 h-4 text-white fill-white" />
                                            <span className="text-white font-bold">{stars}/{maxStars}</span>
                                        </div>
                                    </div>

                                    {/* Play Button */}
                                    <button
                                        onClick={() => handlePlayGame(game)}
                                        className="w-full py-3 bg-white hover:bg-zinc-200 text-black rounded-lg font-bold uppercase tracking-wider flex items-center justify-center gap-2 transition-all hover:scale-[1.02] active:scale-[0.98]"
                                    >
                                        <Play className="w-4 h-4 fill-current" />
                                        {progress > 0 ? 'Continue' : 'Start'}
                                    </button>
                                </div>
                            </Animate>
                        );
                    })}
                </div>

                {/* Empty State */}
                {games.length === 0 && (
                    <Animate
                        animation="fade-in"
                        delay={300}
                        className="text-center py-12"
                    >
                        <BookOpen className="w-16 h-16 text-zinc-800 mx-auto mb-4" />
                        <h3 className="text-xl font-bold text-zinc-500 mb-2">No skill trees yet</h3>
                        <p className="text-zinc-600 mb-6">Create your first skill tree to start learning!</p>
                    </Animate>
                )}
            </div>

            {/* Credits History Modal */}
            <Animate show={historyOpen} unmount animation="fade-in">
                    <div
                        className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4"
                        onClick={() => setHistoryOpen(false)}
                    >
                        <Animate
                            animation="scale-in"
                            className="bg-zinc-900 rounded-2xl p-6 max-w-md w-full border border-zinc-800 max-h-[80vh] flex flex-col"
                            onClick={e => e.stopPropagation()}
                        >
                            {/* Modal Header */}
                            <div className="flex items-center justify-between mb-4">
                                <div className="flex items-center gap-2">
                                    <Coins className="w-5 h-5 text-yellow-500" />
                                    <h3 className="text-xl font-bold text-white">Credit History</h3>
                                </div>
                                <button
                                    onClick={() => setHistoryOpen(false)}
                                    className="p-1.5 hover:bg-zinc-800 rounded-lg transition-colors"
                                >
                                    <X className="w-5 h-5 text-zinc-400" />
                                </button>
                            </div>

                            {/* History List */}
                            <div className="overflow-y-auto flex-1 space-y-2 pr-1">
                                {(() => {
                                    const skillTreeEntries = creditsHistory
                                        .filter(entry => entry.reason === 'skill_tree_completion')
                                        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

                                    if (skillTreeEntries.length === 0) {
                                        return (
                                            <div className="text-center py-8">
                                                <Coins className="w-10 h-10 text-zinc-700 mx-auto mb-3" />
                                                <p className="text-zinc-500">No credits earned from skill trees yet</p>
                                                <p className="text-zinc-600 text-sm mt-1">Complete levels to earn credits!</p>
                                            </div>
                                        );
                                    }

                                    // Group by topic
                                    const byTopic = {};
                                    skillTreeEntries.forEach(entry => {
                                        const topic = entry.topic || 'Unknown';
                                        if (!byTopic[topic]) byTopic[topic] = { entries: [], total: 0 };
                                        byTopic[topic].entries.push(entry);
                                        byTopic[topic].total += entry.amount;
                                    });

                                    return Object.entries(byTopic).map(([topic, data]) => (
                                        <div key={topic} className="bg-zinc-950 border border-zinc-800 rounded-xl p-4">
                                            <div className="flex items-center justify-between mb-2">
                                                <span className="text-white font-bold capitalize">{topic}</span>
                                                <span className="text-yellow-500 font-bold text-sm">+{data.total} credits</span>
                                            </div>
                                            <div className="space-y-1.5">
                                                {data.entries.map((entry, i) => (
                                                    <div key={i} className="flex items-center justify-between text-sm">
                                                        <span className="text-zinc-500 font-mono text-xs">
                                                            {new Date(entry.timestamp).toLocaleDateString()} {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                        </span>
                                                        <span className="text-green-400 font-mono">+{entry.amount}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    ));
                                })()}
                            </div>

                            {/* Total Footer */}
                            <div className="mt-4 pt-3 border-t border-zinc-800 flex items-center justify-between">
                                <span className="text-zinc-400 text-sm">Total Skill Tree Credits</span>
                                <span className="text-yellow-500 font-bold">
                                    {creditsHistory
                                        .filter(e => e.reason === 'skill_tree_completion')
                                        .reduce((s, e) => s + (e.amount || 0), 0)}
                                </span>
                            </div>
                        </Animate>
                    </div>
            </Animate>

            {/* Delete Confirmation Modal */}
            <Animate show={!!deleteConfirm} unmount animation="fade-in">
                    <div
                        className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4"
                        onClick={() => setDeleteConfirm(null)}
                    >
                        <Animate
                            animation="scale-in"
                            className="bg-zinc-900 rounded-2xl p-6 max-w-sm w-full border border-zinc-800"
                            onClick={e => e.stopPropagation()}
                        >
                            <h3 className="text-xl font-bold text-white mb-2">Delete Skill Tree?</h3>
                            <p className="text-zinc-400 mb-6">
                                This will permanently delete all your progress in this skill tree. This action cannot be undone.
                            </p>
                            <div className="flex gap-3">
                                <button
                                    onClick={() => setDeleteConfirm(null)}
                                    className="flex-1 py-3 bg-zinc-800 hover:bg-zinc-700 rounded-xl font-bold text-white transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={() => handleDeleteGame(deleteConfirm)}
                                    className="flex-1 py-3 bg-white hover:bg-zinc-200 text-black rounded-xl font-bold transition-colors"
                                >
                                    Delete
                                </button>
                            </div>
                        </Animate>
                    </div>
            </Animate>
        </div>
    );
};

export default SkillTreeGames;
