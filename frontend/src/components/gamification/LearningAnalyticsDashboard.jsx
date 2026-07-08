import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
    BarChart3, TrendingUp, Target, AlertTriangle, CheckCircle2, Clock,
    Brain, Star, Zap, BookOpen, ArrowLeft, Loader2, Award, Sparkles,
    ChevronRight, Activity, FileText, MessageCircle
} from 'lucide-react';
import axios from 'axios';
import toast from 'react-hot-toast';

const API = import.meta.env.VITE_API_BASE_URL;

const MASTERY_COLORS = {
    locked: { bg: 'bg-zinc-800/50', text: 'text-zinc-600', icon: '🔒' },
    available: { bg: 'bg-blue-900/20', text: 'text-blue-400', icon: '📖' },
    started: { bg: 'bg-yellow-900/20', text: 'text-yellow-400', icon: '🔨' },
    practicing: { bg: 'bg-orange-900/20', text: 'text-orange-400', icon: '⚡' },
    mastered: { bg: 'bg-green-900/20', text: 'text-green-400', icon: '✅' },
    expert: { bg: 'bg-purple-900/20', text: 'text-purple-400', icon: '🏆' }
};

const LearningAnalyticsDashboard = () => {
    const { treeId } = useParams();
    const navigate = useNavigate();
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState('overview');

    useEffect(() => {
        if (!treeId) return;
        fetchAnalytics();
    }, [treeId]);

    const fetchAnalytics = async () => {
        setLoading(true);
        try {
            const token = localStorage.getItem('authToken');
            const { data: res } = await axios.get(`${API}/skill-tree/analytics/${treeId}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            setData(res);
        } catch (err) {
            toast.error('Failed to load analytics');
        } finally {
            setLoading(false);
        }
    };

    if (loading) {
        return (
            <div className="min-h-screen bg-gradient-to-b from-[#1a1d25] via-[#12141a] to-[#080a0e] flex items-center justify-center">
                <div className="flex items-center gap-2 text-zinc-500">
                    <Loader2 className="w-6 h-6 animate-spin" />
                    Loading analytics...
                </div>
            </div>
        );
    }

    if (!data) {
        return (
            <div className="min-h-screen bg-gradient-to-b from-[#1a1d25] via-[#12141a] to-[#080a0e] flex items-center justify-center">
                <div className="text-center">
                    <BarChart3 className="w-16 h-16 text-zinc-800 mx-auto mb-4" />
                    <p className="text-zinc-500">Analytics not available</p>
                    <button onClick={() => navigate(-1)} className="mt-4 text-sm text-blue-400 hover:text-blue-300">Go back</button>
                </div>
            </div>
        );
    }

    const { summary, strongAreas, weakAreas, gapReport, assessment, nodeAnalytics, title } = data;

    return (
        <div className="min-h-screen bg-gradient-to-b from-[#1a1d25] via-[#12141a] to-[#080a0e]">
            <div className="max-w-7xl mx-auto px-4 py-6">
                <div className="flex items-center gap-4 mb-6">
                    <button onClick={() => navigate(-1)} className="p-2 hover:bg-white/5 rounded-lg transition-colors">
                        <ArrowLeft className="w-5 h-5 text-zinc-400" />
                    </button>
                    <div>
                        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                            <BarChart3 className="w-6 h-6 text-blue-400" />
                            Learning Analytics
                        </h1>
                        <p className="text-zinc-500 text-sm">{title}</p>
                    </div>
                </div>

                <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
                    {['overview', 'nodes', 'gaps', 'assessment'].map(tab => (
                        <button key={tab}
                            onClick={() => setActiveTab(tab)}
                            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${
                                activeTab === tab ? 'bg-white text-black' : 'bg-zinc-800/50 text-zinc-400 hover:text-white'
                            }`}
                        >
                            {tab === 'overview' && 'Overview'}
                            {tab === 'nodes' && 'Node Details'}
                            {tab === 'gaps' && 'Knowledge Gaps'}
                            {tab === 'assessment' && 'Assessment'}
                        </button>
                    ))}
                </div>

                {activeTab === 'overview' && (
                    <div className="space-y-6">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <StatCard icon={Target} label="Completion" value={`${summary.completionPercentage || 0}%`} color="text-blue-400" />
                            <StatCard icon={Award} label="Mastery" value={`${summary.masteryPercentage || 0}%`} color="text-green-400" />
                            <StatCard icon={Star} label="Stars" value={summary.totalStarsEarned || 0} color="text-yellow-400" />
                            <StatCard icon={Brain} label="Avg Quiz Score" value={summary.averageQuizScore != null ? `${Math.round(summary.averageQuizScore)}%` : 'N/A'} color="text-purple-400" />
                        </div>

                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <StatCard icon={CheckCircle2} label="Mastered" value={`${summary.nodesMastered || 0}/${summary.totalNodes || 0}`} color="text-green-400" />
                            <StatCard icon={Activity} label="In Progress" value={summary.nodesInProgress || 0} color="text-yellow-400" />
                            <StatCard icon={Zap} label="XP Earned" value={summary.totalXpEarned || 0} color="text-orange-400" />
                            <StatCard icon={Clock} label="Time Invested" value={`${Math.round((summary.timeInvested || 0) / 60)}min`} color="text-cyan-400" />
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="bg-zinc-900/80 rounded-2xl p-6 border border-zinc-800">
                                <h3 className="text-white font-bold mb-4 flex items-center gap-2">
                                    <TrendingUp className="w-5 h-5 text-green-400" />
                                    Strong Areas
                                </h3>
                                {strongAreas && strongAreas.length > 0 ? (
                                    <div className="space-y-2">
                                        {strongAreas.map((area, i) => (
                                            <div key={i} className="flex items-center gap-2 text-zinc-300 text-sm">
                                                <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
                                                {typeof area === 'string' ? area : area.nodeName || area}
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <p className="text-zinc-600 text-sm">Complete more nodes to build strong areas</p>
                                )}
                            </div>

                            <div className="bg-zinc-900/80 rounded-2xl p-6 border border-zinc-800">
                                <h3 className="text-white font-bold mb-4 flex items-center gap-2">
                                    <AlertTriangle className="w-5 h-5 text-yellow-400" />
                                    Areas to Improve
                                </h3>
                                {weakAreas && weakAreas.length > 0 ? (
                                    <div className="space-y-2">
                                        {weakAreas.map((area, i) => (
                                            <div key={i} className="flex items-center gap-2 text-zinc-300 text-sm">
                                                <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0" />
                                                {typeof area === 'string' ? area : area.nodeName || area}
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <p className="text-zinc-600 text-sm">No weak areas detected — great progress!</p>
                                )}
                            </div>
                        </div>

                        <div className="bg-zinc-900/80 rounded-2xl p-6 border border-zinc-800">
                            <h3 className="text-white font-bold mb-4 flex items-center gap-2">
                                <Activity className="w-5 h-5 text-blue-400" />
                                Learning Velocity
                            </h3>
                            <div className="flex items-center gap-4">
                                <div className="flex-1">
                                    <div className="flex justify-between text-sm text-zinc-500 mb-1">
                                        <span>Current streak: {summary.currentStreak || 0} days</span>
                                        <span>Velocity: {summary.learningVelocity?.toFixed(1) || 0} pts/day</span>
                                    </div>
                                    <div className="w-full bg-zinc-800 rounded-full h-2">
                                        <div className="bg-gradient-to-r from-blue-500 to-purple-500 h-2 rounded-full transition-all"
                                            style={{ width: `${Math.min(100, (summary.learningVelocity || 0) * 10)}%` }} />
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <Link to={`/gamification/skill-tree/classic?treeId=${treeId}`}
                                className="bg-zinc-900/80 rounded-2xl p-6 border border-zinc-800 hover:border-zinc-700 transition-all group">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <p className="text-zinc-400 text-sm">Continue Learning</p>
                                        <p className="text-white font-bold text-lg mt-1">Skill Tree Map</p>
                                    </div>
                                    <ChevronRight className="w-5 h-5 text-zinc-600 group-hover:text-white transition-colors" />
                                </div>
                            </Link>
                            <button onClick={() => setActiveTab('gaps')}
                                className="bg-zinc-900/80 rounded-2xl p-6 border border-zinc-800 hover:border-zinc-700 transition-all group text-left">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <p className="text-zinc-400 text-sm">Detailed Analysis</p>
                                        <p className="text-white font-bold text-lg mt-1">View Gap Report</p>
                                    </div>
                                    <ChevronRight className="w-5 h-5 text-zinc-600 group-hover:text-white transition-colors" />
                                </div>
                            </button>
                        </div>
                    </div>
                )}

                {activeTab === 'nodes' && nodeAnalytics && (
                    <div className="space-y-3">
                        {nodeAnalytics.map(node => (
                            <div key={node.id} className="bg-zinc-900/80 rounded-xl p-4 border border-zinc-800 hover:border-zinc-700 transition-all">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className={`w-3 h-3 rounded-full ${MASTERY_COLORS[node.masteryStatus]?.bg || 'bg-zinc-800'}`} />
                                        <div>
                                            <p className="text-white font-medium text-sm">{node.name}</p>
                                            <p className="text-zinc-500 text-xs">{node.module} — {node.difficulty}</p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-4 text-xs">
                                        {node.quizScore != null && (
                                            <span className={`font-medium ${node.quizScore >= 70 ? 'text-green-400' : 'text-yellow-400'}`}>
                                                {node.quizScore}%
                                            </span>
                                        )}
                                        <span className={`px-2 py-0.5 rounded-full ${MASTERY_COLORS[node.masteryStatus]?.text || 'text-zinc-600'} ${MASTERY_COLORS[node.masteryStatus]?.bg || 'bg-zinc-800/50'}`}>
                                            {node.masteryStatus}
                                        </span>
                                        {node.stars > 0 && <span className="text-yellow-400">{'★'.repeat(node.stars)}</span>}
                                        {node.timeInvested > 0 && <span className="text-zinc-600">{Math.round(node.timeInvested / 60)}min</span>}
                                    </div>
                                </div>
                                {node.masteryScore > 0 && (
                                    <div className="mt-2 w-full bg-zinc-800 rounded-full h-1">
                                        <div className="bg-gradient-to-r from-blue-500 to-green-500 h-1 rounded-full"
                                            style={{ width: `${node.masteryScore}%` }} />
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}

                {activeTab === 'gaps' && (
                    <div className="space-y-6">
                        {gapReport ? (
                            <>
                                <div className="bg-zinc-900/80 rounded-2xl p-6 border border-zinc-800">
                                    <p className="text-zinc-300 text-sm">{gapReport.overallAssessment}</p>
                                </div>

                                {gapReport.weakAreas && gapReport.weakAreas.length > 0 && (
                                    <div className="bg-zinc-900/80 rounded-2xl p-6 border border-zinc-800">
                                        <h3 className="text-white font-bold mb-4 flex items-center gap-2">
                                            <AlertTriangle className="w-5 h-5 text-red-400" />
                                            Weak Areas ({gapReport.weakAreas.length})
                                        </h3>
                                        <div className="space-y-3">
                                            {gapReport.weakAreas.map((w, i) => (
                                                <div key={i} className="bg-red-900/10 rounded-xl p-4 border border-red-900/20">
                                                    <div className="flex items-center justify-between mb-2">
                                                        <p className="text-white font-medium text-sm">{w.nodeName}</p>
                                                        <span className="text-xs text-red-400">{Math.round((1 - (w.severity || 0)) * 100)}%</span>
                                                    </div>
                                                    {w.gaps && w.gaps.length > 0 && (
                                                        <ul className="space-y-1">
                                                            {w.gaps.map((g, gi) => (
                                                                <li key={gi} className="text-zinc-400 text-xs flex items-start gap-1.5">
                                                                    <span className="text-red-400 mt-0.5">•</span>
                                                                    {g}
                                                                </li>
                                                            ))}
                                                        </ul>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {gapReport.recommendations && gapReport.recommendations.length > 0 && (
                                    <div className="bg-zinc-900/80 rounded-2xl p-6 border border-zinc-800">
                                        <h3 className="text-white font-bold mb-4 flex items-center gap-2">
                                            <Sparkles className="w-5 h-5 text-yellow-400" />
                                            Recommendations
                                        </h3>
                                        <div className="space-y-2">
                                            {gapReport.recommendations.map((r, i) => (
                                                <div key={i} className={`flex items-start gap-3 p-3 rounded-xl ${
                                                    r.priority === 'high' ? 'bg-red-900/10 border border-red-900/20' : 'bg-zinc-800/30'
                                                }`}>
                                                    <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                                                        r.priority === 'high' ? 'bg-red-900/50 text-red-300' :
                                                        r.priority === 'medium' ? 'bg-yellow-900/50 text-yellow-300' :
                                                        'bg-zinc-700 text-zinc-400'
                                                    }`}>
                                                        {r.priority}
                                                    </span>
                                                    <div>
                                                        <p className="text-zinc-300 text-sm">{r.action}</p>
                                                        {r.details && <p className="text-zinc-500 text-xs mt-0.5">{r.details}</p>}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {gapReport.commonMisconceptions && gapReport.commonMisconceptions.length > 0 && (
                                    <div className="bg-zinc-900/80 rounded-2xl p-6 border border-zinc-800">
                                        <h3 className="text-white font-bold mb-3">Common Misconceptions</h3>
                                        <ul className="space-y-1">
                                            {gapReport.commonMisconceptions.map((m, i) => (
                                                <li key={i} className="text-zinc-400 text-sm flex items-start gap-2">
                                                    <span className="text-yellow-400">•</span>
                                                    {m}
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                            </>
                        ) : (
                            <div className="bg-zinc-900/80 rounded-2xl p-8 border border-zinc-800 text-center">
                                <Brain className="w-12 h-12 text-zinc-700 mx-auto mb-3" />
                                <p className="text-zinc-500">No gap report yet. Complete an assessment to generate one.</p>
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'assessment' && (
                    <div className="space-y-6">
                        {assessment ? (
                            <>
                                <div className="bg-zinc-900/80 rounded-2xl p-6 border border-zinc-800">
                                    <div className="flex items-center justify-between mb-4">
                                        <h3 className="text-white font-bold">Assessment Results</h3>
                                        <span className={`px-3 py-1 rounded-full text-sm font-medium ${
                                            assessment.level === 'Expert' ? 'bg-purple-900/50 text-purple-300' :
                                            assessment.level === 'Advanced' ? 'bg-blue-900/50 text-blue-300' :
                                            assessment.level === 'Intermediate' ? 'bg-yellow-900/50 text-yellow-300' :
                                            'bg-green-900/50 text-green-300'
                                        }`}>{assessment.level}</span>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3 mb-4">
                                        <div className="bg-zinc-800/50 rounded-lg p-3">
                                            <p className="text-zinc-500 text-xs">Weighted Score</p>
                                            <p className="text-white font-bold text-lg">{Math.round(assessment.weightedScore)}%</p>
                                        </div>
                                        <div className="bg-zinc-800/50 rounded-lg p-3">
                                            <p className="text-zinc-500 text-xs">Raw Score</p>
                                            <p className="text-white font-bold text-lg">{Math.round(assessment.rawScore)}%</p>
                                        </div>
                                    </div>
                                    {assessment.strengths && assessment.strengths.length > 0 && (
                                        <div className="mb-4">
                                            <p className="text-green-400 text-sm font-medium mb-2">Strengths</p>
                                            <ul className="space-y-1">
                                                {assessment.strengths.map((s, i) => (
                                                    <li key={i} className="text-zinc-300 text-sm flex items-start gap-2">
                                                        <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
                                                        {s}
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                    {assessment.improvements && assessment.improvements.length > 0 && (
                                        <div>
                                            <p className="text-yellow-400 text-sm font-medium mb-2">Areas to Improve</p>
                                            <ul className="space-y-1">
                                                {assessment.improvements.map((imp, i) => (
                                                    <li key={i} className="text-zinc-300 text-sm flex items-start gap-2">
                                                        <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
                                                        {imp}
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                    {assessment.recommendations && assessment.recommendations.length > 0 && (
                                        <div className="mt-4 pt-4 border-t border-zinc-800">
                                            <p className="text-blue-400 text-sm font-medium mb-2">Recommendations</p>
                                            <ul className="space-y-1">
                                                {assessment.recommendations.map((r, i) => (
                                                    <li key={i} className="text-zinc-300 text-sm">→ {r}</li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                </div>
                            </>
                        ) : (
                            <div className="bg-zinc-900/80 rounded-2xl p-8 border border-zinc-800 text-center">
                                <Brain className="w-12 h-12 text-zinc-700 mx-auto mb-3" />
                                <p className="text-zinc-500">No assessment completed yet.</p>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

const StatCard = ({ icon: Icon, label, value, color }) => (
    <div className="bg-zinc-900/80 rounded-2xl p-5 border border-zinc-800">
        <div className="flex items-center gap-2 mb-3">
            <Icon className={`w-4 h-4 ${color}`} />
            <span className="text-zinc-500 text-xs uppercase tracking-wider">{label}</span>
        </div>
        <p className={`text-2xl font-bold ${typeof value === 'number' && value > 0 ? 'text-white' : 'text-zinc-500'}`}>
            {value ?? '—'}
        </p>
    </div>
);

export default LearningAnalyticsDashboard;
