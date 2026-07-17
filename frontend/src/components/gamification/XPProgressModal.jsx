// frontend/src/components/gamification/XPProgressModal.jsx
import React, { useEffect, useState } from 'react';
import { X, Zap, TrendingUp, Target, Coins } from 'lucide-react';
import axios from 'axios';
import { formatTopicName } from '../../utils/helpers';

const apiClient = axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL || "http://localhost:5005",
});

apiClient.interceptors.request.use((config) => {
    const token = localStorage.getItem("authToken");
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

function XPProgressModal({ isOpen, onClose, level }) {
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (isOpen) {
            fetchStats();
        }
    }, [isOpen]);

    const fetchStats = async () => {
        try {
            setLoading(true);
            const response = await apiClient.get('/gamification/profile');
            setStats(response.data);
        } catch (error) {
            console.error('[XPProgressModal] Error fetching stats:', error);
        } finally {
            setLoading(false);
        }
    };

    if (!isOpen) return null;

    const currentXP = stats?.totalXP || 0;
    const currentLevel = stats?.xpLevel || 1;

    // Level formula: Level = floor(sqrt(XP/50)) + 1
    // Inverse: Level N Start XP = (N-1)^2 * 50
    // Level N End XP (Next Level Start) = N^2 * 50

    const levelStartXP = Math.pow(currentLevel - 1, 2) * 50;
    const levelEndXP = Math.pow(currentLevel, 2) * 50;

    const xpIntoCurrentLevel = currentXP - levelStartXP;
    const xpNeededThisLevel = levelEndXP - levelStartXP; // Total XP span for this level
    const xpRemaining = levelEndXP - currentXP;

    const progressPercent = Math.min(100, Math.max(0, (xpIntoCurrentLevel / xpNeededThisLevel) * 100));

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 backdrop-blur-sm">
            <div className="bg-white dark:bg-gray-900 rounded-lg shadow-2xl w-full max-w-md mx-4 overflow-hidden border-2 border-gray-300 dark:border-gray-700">
                {/* Header - Black and White */}
                <div className="bg-gradient-to-r from-gray-800 to-black px-6 py-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="bg-white bg-opacity-20 p-2 rounded-full border border-white">
                            <Zap className="text-white" size={24} />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-white">XP Progress</h2>
                            <p className="text-sm text-gray-300">Level {currentLevel}</p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-white hover:bg-white hover:bg-opacity-20 p-1 rounded-full transition-colors"
                    >
                        <X size={24} />
                    </button>
                </div>

                {/* Content */}
                <div className="p-6 max-h-[60vh] overflow-y-auto scrollbar-thin scrollbar-thumb-gray-500 scrollbar-track-gray-200 dark:scrollbar-track-gray-800">
                    {loading ? (
                        <div className="flex items-center justify-center py-8">
                            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-800 dark:border-white"></div>
                        </div>
                    ) : (
                        <div className="space-y-6">
                            {/* XP Stats Cards */}
                            <div className="grid grid-cols-2 gap-3">
                                <div className="bg-gradient-to-br from-gray-700 to-gray-900 rounded-lg p-4 text-white border border-gray-600">
                                    <div className="text-2xl font-bold">{currentXP.toLocaleString()}</div>
                                    <div className="text-xs opacity-80">Total XP</div>
                                </div>
                                <div className="bg-gradient-to-br from-gray-600 to-gray-800 rounded-lg p-4 text-white border border-gray-500">
                                    <div className="text-2xl font-bold">{currentLevel}</div>
                                    <div className="text-xs opacity-80">Current Level</div>
                                </div>
                                <div className="bg-gradient-to-br from-gray-500 to-gray-700 rounded-lg p-4 text-white border border-gray-400">
                                    <div className="text-2xl font-bold">{currentLevel + 1}</div>
                                    <div className="text-xs opacity-80">Next Level</div>
                                </div>
                                <div className="bg-gradient-to-br from-gray-700 to-gray-900 rounded-lg p-4 text-white border border-gray-600">
                                    <div className="text-2xl font-bold flex items-center gap-1">
                                        <Coins size={18} className="opacity-80" />
                                        {(stats?.totalLearningCredits || 0).toLocaleString()}
                                    </div>
                                    <div className="text-xs opacity-80">Total Credits</div>
                                </div>
                            </div>

                            {/* Progress Bar - Black and White */}
                            <div>
                                <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                                        <Target size={16} />
                                        <span>Progress to Level {currentLevel + 1}</span>
                                    </div>
                                    <span className="text-sm font-bold text-gray-900 dark:text-white">
                                        {progressPercent.toFixed(1)}%
                                    </span>
                                </div>

                                {/* Progress Bar Track */}
                                <div className="relative w-full h-8 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden shadow-inner border border-gray-300 dark:border-gray-600">
                                    {/* Animated Progress Fill - Grayscale Gradient */}
                                    <div
                                        className="absolute top-0 left-0 h-full bg-gradient-to-r from-gray-400 via-gray-600 to-gray-800 rounded-full transition-all duration-1000 ease-out"
                                        style={{ width: `${Math.min(progressPercent, 100)}%` }}
                                    >
                                        {/* Shimmer Effect */}
                                        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white to-transparent opacity-30 animate-shimmer"></div>
                                    </div>

                                    {/* XP Text on Bar */}
                                    <div className="absolute inset-0 flex items-center justify-center text-xs font-bold text-gray-800 dark:text-white z-10">
                                        {xpIntoCurrentLevel} / {xpNeededThisLevel} XP
                                    </div>
                                </div>
                            </div>

                            {/* XP Remaining - Black and White */}
                            <div className="flex items-center gap-3 bg-gradient-to-r from-gray-100 to-gray-200 dark:from-gray-800 dark:to-gray-700 rounded-lg p-4 border border-gray-300 dark:border-gray-600">
                                <div className="bg-gray-800 dark:bg-white p-2 rounded-full">
                                    <TrendingUp className="text-white dark:text-black" size={20} />
                                </div>
                                <div>
                                    <div className="text-sm text-gray-600 dark:text-gray-300">XP needed for next level</div>
                                    <div className="text-2xl font-bold text-gray-900 dark:text-white">
                                        {xpNeededThisLevel - xpIntoCurrentLevel} XP
                                    </div>
                                </div>
                            </div>

                            {/* Quick Tips - Black and White */}
                            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
                                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">💡 Earn More XP:</h3>
                                <ul className="text-xs text-gray-600 dark:text-gray-400 space-y-1">
                                    <li>• Ask <strong>application</strong> questions: <span className="text-gray-900 dark:text-white font-semibold">10 XP</span></li>
                                    <li>• Ask <strong>understanding</strong> questions: <span className="text-gray-900 dark:text-white font-semibold">3 XP</span></li>
                                    <li>• Build a <strong>daily streak</strong> for XP multipliers!</li>
                                    <li>• Complete boss battles for bonus XP!</li>
                                </ul>
                            </div>

                            {/* Recent Activity - Black and White */}
                            {stats?.recentXPHistory && stats.recentXPHistory.length > 0 && (
                                <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
                                    <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">📜 Recent Activity:</h3>
                                    <div className="space-y-2 max-h-32 overflow-y-auto">
                                        {stats.recentXPHistory.slice(0, 5).map((entry, idx) => (
                                            <div key={idx} className="flex items-center justify-between text-xs">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-gray-600 dark:text-gray-400">{formatTopicName(entry.topic)}</span>
                                                    <span className="text-gray-400 text-[10px]">
                                                        {new Date(entry.timestamp).toLocaleDateString()}
                                                    </span>
                                                </div>
                                                <span className="font-semibold text-gray-900 dark:text-white">
                                                    +{entry.amount} XP
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Footer - Black and White */}
                <div className="bg-gray-100 dark:bg-gray-800 px-6 py-3 flex justify-end border-t border-gray-300 dark:border-gray-700">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 bg-gray-800 hover:bg-black dark:bg-white dark:hover:bg-gray-200 text-white dark:text-black rounded-lg font-medium transition-colors"
                    >
                        Got it!
                    </button>
                </div>
            </div>

            {/* Shimmer Animation CSS */}
            <style>{`
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        .animate-shimmer {
          animation: shimmer 2s infinite;
        }
      `}</style>
        </div>
    );
}

export default XPProgressModal;
