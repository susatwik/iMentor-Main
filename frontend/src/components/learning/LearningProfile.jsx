import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Brain, Target, Award, AlertTriangle, BookOpen, RefreshCw,
    Download, Trash2, ChevronRight, BarChart3, TrendingUp, History, ArrowLeft,
    ChevronUp, ChevronDown, GraduationCap
} from 'lucide-react';
import Animate from '../core/Animate.jsx';
import api from '../../services/api';
import toast from 'react-hot-toast';
import Button from '../core/Button';

const LearningProfile = () => {
    const navigate = useNavigate();
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState('overview');
    const insightsRef = useRef(null);
    const masteredRef = useRef(null);
    const strugglingRef = useRef(null);

    const scrollList = (ref, direction) => {
        if (ref.current) {
            const amount = direction === 'up' ? -200 : 200;
            ref.current.scrollBy({ top: amount, behavior: 'smooth' });
        }
    };

    const fetchData = async () => {
        setLoading(true);
        try {
            const result = await api.getKnowledgeState();
            console.log('Knowledge state loaded:', result);
            setData(result);
        } catch (error) {
            console.error('Failed to load knowledge state:', error);
            console.error('Error details:', error.response?.data || error.message);
            toast.error(error.response?.data?.message || 'Failed to load your learning profile');
            // Set empty data so component can still render
            setData({
                summary: {
                    totalConcepts: 0,
                    mastered: 0,
                    learning: 0,
                    struggling: 0
                },
                concepts: [],
                profile: {},
                currentFocusAreas: [],
                sessionInsights: [],
                recurringStruggles: []
            });
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
    }, []);

    const handleReset = async () => {
        if (!window.confirm('Are you sure you want to reset your learning memory? This cannot be undone.')) return;
        try {
            await api.resetKnowledgeState();
            toast.success('Learning memory reset successfully');
            fetchData();
        } catch (error) {
            toast.error('Failed to reset learning memory');
        }
    };

    const handleExport = async () => {
        try {
            await api.exportKnowledgeState();
            toast.success('Learning memory exported successfully');
        } catch (error) {
            toast.error('Failed to export learning memory');
        }
    };

    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center p-12 min-h-[400px]">
                <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary mb-4"></div>
                <p className="text-text-muted-light dark:text-text-muted-dark">Retreiving your learning profile...</p>
            </div>
        );
    }

    // Provide default values if no data exists yet
    const summary = data?.summary || {
        totalConcepts: 0,
        mastered: 0,
        learning: 0,
        struggling: 0,
        notExposed: 0,
        recentFocus: [],
        topStruggles: []
    };

    // Extract concepts from the response
    const allConcepts = data?.concepts || [];
    const strugglingConcepts = allConcepts.filter(c =>
        c.difficulty === 'high' || c.mastery < 70
    );
    const masteredConcepts = allConcepts.filter(c =>
        c.mastery >= 85 || c.understandingLevel === 'mastered'
    );

    const learningProfile = {
        dominantLearningStyle: data?.profile?.dominantLearningStyle || 'unknown',
        learningPace: data?.profile?.learningPace || 'moderate',
        preferredDepth: data?.profile?.preferredDepth || 'balanced',
        questioningBehavior: data?.profile?.questioningBehavior || 'asks_when_stuck'
    };

    const currentFocusAreas = data?.currentFocusAreas || [];
    const sessionInsights = data?.sessionInsights || [];
    const recurringStruggles = data?.recurringStruggles || [];

    // If data is still null after loading, show empty state
    if (!data) {
        return (
            <div className="max-w-6xl mx-auto p-4 md:p-8 space-y-8">
                <div className="text-center p-12">
                    <Brain className="mx-auto h-16 w-16 text-text-muted-light dark:text-text-muted-dark mb-4" />
                    <h2 className="text-2xl font-bold mb-2">No Learning Data Yet</h2>
                    <p className="text-text-muted-light dark:text-text-muted-dark">
                        Start chatting with the AI tutor to build your learning profile!
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="h-screen flex flex-col bg-background-light dark:bg-background-dark font-sans overflow-hidden">
            <div className="flex-1 overflow-y-auto custom-scrollbar">
                <div className="max-w-7xl mx-auto p-4 md:p-8 space-y-8 pb-24 animate-in fade-in duration-500">
                    {/* Back Button */}
                    <button
                        onClick={() => navigate('/')}
                        className="flex items-center gap-2 text-text-muted-light dark:text-text-muted-dark hover:text-primary dark:hover:text-primary-light transition-colors group"
                    >
                        <ArrowLeft size={20} className="group-hover:-translate-x-1 transition-transform" />
                        <span className="text-sm font-medium">Back to Home</span>
                    </button>

                    {/* Header Section */}
                    <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-gradient-to-r from-primary/10 to-transparent p-6 rounded-2xl border border-primary/20 shadow-sm border-2">
                        <div>
                            <h1 className="text-3xl font-extrabold text-text-light dark:text-text-dark flex items-center gap-3">
                                <Brain className="text-primary" size={36} />
                                Your Learning Intelligence Profile
                            </h1>
                            <p className="text-text-muted-light dark:text-text-muted-dark mt-2 max-w-2xl">
                                This profile is your AI Tutor's memory. It tracks your progress, identifies struggles, and adapts its teaching style to you.
                            </p>
                        </div>
                        <div className="flex gap-2">
                            <Button variant="secondary" size="sm" onClick={handleExport} className="flex items-center gap-2">
                                <Download size={16} /> Export
                            </Button>
                            <Button variant="ghost" size="sm" onClick={handleReset} className="flex items-center gap-2 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20">
                                <Trash2 size={16} /> Reset
                            </Button>
                        </div>
                    </header>

                    {/* Stats Overview */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                        <StatCard
                            label="Total Topics"
                            value={summary.totalConcepts}
                            icon={BookOpen}
                            color="blue"
                        />
                        <StatCard
                            label="Mastered"
                            value={summary.mastered}
                            icon={Award}
                            color="green"
                            subtext={`${Math.round((summary.mastered / summary.totalConcepts) * 100) || 0}% of explored`}
                        />
                        <StatCard
                            label="Learning"
                            value={summary.learning}
                            icon={TrendingUp}
                            color="amber"
                        />
                        <StatCard
                            label="Struggling"
                            value={summary.struggling}
                            icon={AlertTriangle}
                            color="red"
                        />
                    </div>

                    {/* Main Content Tabs */}
                    <div className="space-y-6">
                        <div className="flex border-b border-border-light dark:border-border-dark overflow-x-auto no-scrollbar">
                            <TabButton active={activeTab === 'overview'} onClick={() => setActiveTab('overview')} label="Overview" icon={BarChart3} />
                            <TabButton active={activeTab === 'concepts'} onClick={() => setActiveTab('concepts')} label="Topics & Mastery" icon={BookOpen} />
                            <TabButton active={activeTab === 'quiz'} onClick={() => setActiveTab('quiz')} label="Quiz Performance" icon={GraduationCap} />
                            <TabButton active={activeTab === 'insights'} onClick={() => setActiveTab('insights')} label="Learning Insights" icon={Lightbulb} />
                            <TabButton active={activeTab === 'history'} onClick={() => setActiveTab('history')} label="Session History" icon={History} />
                        </div>

                            {activeTab === 'overview' && (
                                <Animate
                                    key="overview"
                                    animation="slide-up"
                                    className="grid grid-cols-1 lg:grid-cols-2 gap-6"
                                >
                                    {/* Learning Style */}
                                    <Card title="Learning Profile" icon={User}>
                                        <div className="space-y-4">
                                            <div className="grid grid-cols-2 gap-4">
                                                <ProfileItem label="Dominant Style" value={learningProfile.dominantLearningStyle} />
                                                <ProfileItem label="Learning Pace" value={learningProfile.learningPace} />
                                                <ProfileItem label="Preferred Depth" value={learningProfile.preferredDepth} />
                                                <ProfileItem label="Questioning" value={learningProfile.questioningBehavior} />
                                            </div>
                                            <div className="p-4 bg-primary/5 rounded-lg border border-primary/10">
                                                <p className="text-sm italic text-text-muted-light dark:text-text-muted-dark">
                                                    "Based on your interactions, the tutor has adapted its explanations to be more {learningProfile.dominantLearningStyle} and {learningProfile.learningPace}."
                                                </p>
                                            </div>
                                        </div>
                                    </Card>

                                    {/* Focus Areas */}
                                    <Card title="Current Focus Areas" icon={Target}>
                                        <div className="space-y-3">
                                            {currentFocusAreas && currentFocusAreas.length > 0 ? (
                                                currentFocusAreas.map((area, idx) => (
                                                    <div key={idx} className="flex items-center justify-between p-3 bg-surface-light dark:bg-surface-dark border border-border-light dark:border-border-dark rounded-lg">
                                                        <div>
                                                            <h4 className="font-semibold text-sm">{area.topic}</h4>
                                                            <p className="text-xs text-text-muted-light dark:text-text-muted-dark">{area.reason}</p>
                                                        </div>
                                                        <Badge color={area.priority === 'high' ? 'red' : 'blue'}>{area.priority}</Badge>
                                                    </div>
                                                ))
                                            ) : (
                                                <p className="text-sm text-text-muted-light dark:text-text-muted-dark italic">No specific focus areas identified yet.</p>
                                            )}
                                        </div>
                                    </Card>
                                </Animate>
                            )}

                            {activeTab === 'concepts' && (
                                <Animate
                                    key="concepts"
                                    animation="slide-up"
                                    className="space-y-6"
                                >
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                        {/* Mastered */}
                                        <Card
                                            title="Mastered Concepts"
                                            icon={Award}
                                            color="green"
                                        >
                                            <div
                                                ref={masteredRef}
                                                className="h-[400px] overflow-y-scroll p-5 space-y-3 concept-list-mastered scroll-smooth"
                                            >
                                                {masteredConcepts && masteredConcepts.length > 0 ? (
                                                    masteredConcepts.map((c, idx) => (
                                                        <ConceptRow key={idx} concept={c} status="mastered" />
                                                    ))
                                                ) : (
                                                    <p className="text-sm text-text-muted-light dark:text-text-muted-dark italic">No concepts mastered yet. Keep learning!</p>
                                                )}
                                            </div>
                                        </Card>

                                        {/* Struggling */}
                                        <Card
                                            title="Struggling Concepts"
                                            icon={AlertTriangle}
                                            color="red"
                                        >
                                            <div
                                                ref={strugglingRef}
                                                className="h-[400px] overflow-y-scroll p-5 space-y-3 concept-list-struggling scroll-smooth"
                                            >
                                                {strugglingConcepts && strugglingConcepts.length > 0 ? (
                                                    strugglingConcepts.map((c, idx) => (
                                                        <ConceptRow key={idx} concept={c} status="struggling" />
                                                    ))
                                                ) : (
                                                    <p className="text-sm text-text-muted-light dark:text-text-muted-dark italic">You are doing great! No major struggles detected.</p>
                                                )}
                                            </div>
                                        </Card>
                                    </div>
                                </Animate>
                            )}

                            {activeTab === 'insights' && (
                                <Animate
                                    key="insights"
                                    animation="slide-up"
                                    className="space-y-6"
                                >
                                    <Card
                                        title="AI Learning Observations"
                                        icon={Lightbulb}
                                    >
                                        <div
                                            ref={insightsRef}
                                            style={{
                                                height: '450px',
                                                maxHeight: '450px',
                                                overflowY: 'scroll',
                                                overflowX: 'hidden',
                                                WebkitOverflowScrolling: 'touch',
                                                position: 'relative',
                                                display: 'block',
                                                boxSizing: 'border-box'
                                            }}
                                            className="concept-list-struggling"
                                        >
                                            <div style={{ padding: '1.5rem', minHeight: '600px' }} className="space-y-5">
                                                {recurringStruggles && recurringStruggles.length > 0 ? (
                                                    recurringStruggles.map((struggle, idx) => (
                                                        <div key={idx} className="p-4 bg-red-500/5 border border-red-500/20 rounded-xl">
                                                            <div className="flex items-center gap-2 mb-2">
                                                                <AlertTriangle size={16} className="text-red-500" />
                                                                <h4 className="font-bold text-red-700 dark:text-red-400">{struggle.pattern}</h4>
                                                            </div>
                                                            <p className="text-sm text-text-light dark:text-text-dark mb-2">
                                                                This pattern has been observed {struggle.occurrences} times across several topics.
                                                            </p>
                                                            <div className="flex flex-wrap gap-2">
                                                                {struggle.examples.map((ex, i) => (
                                                                    <span key={i} className="px-2 py-0.5 bg-red-100 dark:bg-red-900/30 text-[10px] rounded-full text-red-600 dark:text-red-300">
                                                                        {ex}
                                                                    </span>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    ))
                                                ) : (
                                                    <p className="text-sm text-text-muted-light dark:text-text-muted-dark italic text-center py-12">Waiting for more interactions to generate recurring patterns.</p>
                                                )}
                                            </div>
                                        </div>
                                    </Card>
                                </Animate>
                            )}

                            {activeTab === 'history' && (
                                <Animate
                                    key="history"
                                    animation="slide-up"
                                    className="space-y-4"
                                >
                                    <div
                                        style={{
                                            height: '600px',
                                            maxHeight: '600px',
                                            overflowY: 'scroll',
                                            overflowX: 'hidden',
                                            WebkitOverflowScrolling: 'touch',
                                            position: 'relative',
                                            display: 'block',
                                            boxSizing: 'border-box'
                                        }}
                                        className="session-history-scroll"
                                    >
                                        <div style={{ padding: '0.5rem', minHeight: '700px' }} className="space-y-4">
                                            {sessionInsights && sessionInsights.length > 0 ? (
                                                [...sessionInsights]
                                                    .sort((a, b) => new Date(b.date) - new Date(a.date))
                                                    .map((session, idx) => (
                                                        <div key={idx} className="p-5 bg-surface-light dark:bg-surface-dark border border-border-light dark:border-border-dark rounded-xl hover:border-primary/30 transition-colors">
                                                            <div className="flex justify-between items-start mb-3">
                                                                <h4 className="font-bold flex items-center gap-2">
                                                                    Session on {new Date(session.date).toLocaleDateString([], { month: 'numeric', day: 'numeric', year: 'numeric' })}
                                                                    <span className="text-secondary dark:text-secondary-light font-normal text-xs ml-2">
                                                                        at {new Date(session.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                                    </span>
                                                                </h4>
                                                                <span className="text-[10px] uppercase tracking-wider text-text-muted-light dark:text-text-muted-dark bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">
                                                                    {session.sessionId.substring(0, 8)}...
                                                                </span>
                                                            </div>
                                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                                <div>
                                                                    <p className="text-xs font-semibold text-text-muted-light dark:text-text-muted-dark uppercase mb-2">Concepts Covered</p>
                                                                    <div className="flex flex-wrap gap-1">
                                                                        {session.conceptsCovered.map((c, i) => (
                                                                            <span key={i} className="px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-[10px] rounded-full text-blue-600 dark:text-blue-300">
                                                                                {c}
                                                                            </span>
                                                                        ))}
                                                                    </div>
                                                                </div>
                                                                <div>
                                                                    <p className="text-xs font-semibold text-text-muted-light dark:text-text-muted-dark uppercase mb-2">Key Observations</p>
                                                                    <ul className="list-disc list-inside text-xs space-y-1 text-text-muted-light dark:text-text-muted-dark">
                                                                        {session.keyObservations.slice(0, 3).map((obs, i) => (
                                                                            <li key={i}>{obs}</li>
                                                                        ))}
                                                                    </ul>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    ))
                                            ) : (
                                                <p className="text-sm text-text-muted-light dark:text-text-muted-dark italic text-center py-12">No detailed session insights available yet.</p>
                                            )}
                                        </div>
                                    </div>
                                </Animate>
                            )}

                            {activeTab === 'quiz' && (
                                <Animate
                                    key="quiz"
                                    animation="slide-up"
                                    className="space-y-6"
                                >
                                    {/* Overall Quiz Stats Cards */}
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                                        <StatCard
                                            label="Quizzes Completed"
                                            value={summary.totalQuizzes || 0}
                                            icon={History}
                                            color="blue"
                                        />
                                        <StatCard
                                            label="Average Quiz Score"
                                            value={`${summary.averageScore || 0}%`}
                                            icon={Award}
                                            color="green"
                                        />
                                        <StatCard
                                            label="Learning Stage"
                                            value={summary.learningStage || 'Beginner'}
                                            icon={GraduationCap}
                                            color="amber"
                                        />
                                        <StatCard
                                            label="Most Improved Area"
                                            value={summary.mostImproved || 'N/A'}
                                            icon={TrendingUp}
                                            color="blue"
                                        />
                                    </div>

                                    {/* Two Column Breakdown */}
                                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                                        {/* Quiz Attempt Progression (Left / col-span-2) */}
                                        <div className="lg:col-span-2 space-y-6">
                                            <Card title="Quiz Attempt Progression" icon={History}>
                                                <div className="p-6 space-y-6">
                                                    {/* Course-by-course metrics aggregate (First, Best, Latest) */}
                                                    <div className="space-y-4">
                                                        <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Course Performance Summary</h4>
                                                        {(() => {
                                                            const coursesGroup = {};
                                                            (data.quizHistoryTimeline || []).forEach(q => {
                                                                if (!coursesGroup[q.courseName]) {
                                                                    coursesGroup[q.courseName] = [];
                                                                }
                                                                coursesGroup[q.courseName].push(q);
                                                            });

                                                            const courseStats = Object.entries(coursesGroup).map(([course, attempts]) => {
                                                                // Sort chronological ascending to find first, latest, and best
                                                                const chron = [...attempts].sort((a, b) => new Date(a.date) - new Date(b.date));
                                                                const scores = attempts.map(a => a.score);
                                                                return {
                                                                    course,
                                                                    attemptsCount: attempts.length,
                                                                    first: chron[0].score,
                                                                    latest: chron[chron.length - 1].score,
                                                                    best: Math.max(...scores)
                                                                };
                                                            });

                                                            if (courseStats.length === 0) {
                                                                return <p className="text-xs text-text-muted-light dark:text-text-muted-dark italic">No course quiz data recorded yet.</p>;
                                                            }

                                                            return (
                                                                <div className="grid grid-cols-1 gap-4">
                                                                    {courseStats.map((cs, i) => (
                                                                        <div key={i} className="p-4 bg-surface-light dark:bg-surface-dark border border-border-light dark:border-border-dark rounded-xl space-y-3">
                                                                            <div className="flex justify-between items-center">
                                                                                <h5 className="font-bold text-sm text-text-light dark:text-text-dark">{cs.course}</h5>
                                                                                <span className="text-[10px] bg-indigo-500/10 text-indigo-400 font-bold px-2 py-0.5 rounded border border-indigo-500/25">
                                                                                    {cs.attemptsCount} {cs.attemptsCount === 1 ? 'Attempt' : 'Attempts'}
                                                                                </span>
                                                                            </div>
                                                                            <div className="grid grid-cols-3 gap-2 text-center">
                                                                                <div className="p-2 bg-gray-100 dark:bg-gray-800/40 rounded-lg">
                                                                                    <span className="text-[9px] text-text-muted-light dark:text-text-muted-dark uppercase font-semibold block">First Score</span>
                                                                                    <span className="text-sm font-bold text-text-light dark:text-text-dark">{cs.first}%</span>
                                                                                </div>
                                                                                <div className="p-2 bg-gray-100 dark:bg-gray-800/40 rounded-lg border border-primary/20">
                                                                                    <span className="text-[9px] text-primary dark:text-primary-light uppercase font-semibold block">Latest Score</span>
                                                                                    <span className="text-sm font-bold text-primary dark:text-primary-light">{cs.latest}%</span>
                                                                                </div>
                                                                                <div className="p-2 bg-gray-100 dark:bg-gray-800/40 rounded-lg">
                                                                                    <span className="text-[9px] text-green-500 uppercase font-semibold block">Best Score</span>
                                                                                    <span className="text-sm font-bold text-green-500">{cs.best}%</span>
                                                                                </div>
                                                                            </div>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            );
                                                        })()}
                                                    </div>

                                                    {/* Chronological list of attempts */}
                                                    <div className="space-y-3">
                                                        <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Detailed Attempt Timeline</h4>
                                                        <div className="max-h-[350px] overflow-y-auto pr-1 space-y-3 custom-scrollbar">
                                                            {data.quizHistoryTimeline && data.quizHistoryTimeline.length > 0 ? (
                                                                data.quizHistoryTimeline.map((attempt, idx) => (
                                                                    <div key={idx} className="p-4 bg-gray-50 dark:bg-gray-900/30 border border-border-light dark:border-border-dark rounded-xl space-y-2.5">
                                                                        <div className="flex justify-between items-start">
                                                                            <div>
                                                                                <span className="text-[9px] text-indigo-400 font-bold uppercase tracking-wider block">{attempt.courseName}</span>
                                                                                <h5 className="font-semibold text-xs text-text-light dark:text-text-dark">{attempt.module}</h5>
                                                                            </div>
                                                                            <div className="text-right">
                                                                                <span className="text-sm font-extrabold text-text-light dark:text-text-dark">{attempt.score}%</span>
                                                                                <span className="text-[9px] text-text-muted-light dark:text-text-muted-dark block">
                                                                                    {new Date(attempt.date).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                                                                                </span>
                                                                            </div>
                                                                        </div>
                                                                        {attempt.remediation && (
                                                                            <div className="p-3 bg-teal-500/5 border border-teal-500/10 rounded-lg space-y-1">
                                                                                <span className="text-[8px] text-teal-400 font-bold uppercase tracking-widest block">AI Remediation Guide</span>
                                                                                <p className="text-[11px] text-text-muted-light dark:text-text-muted-dark leading-relaxed">
                                                                                    <span className="font-semibold text-teal-300">Next Step: </span>
                                                                                    {attempt.remediation.recommendation}
                                                                                </p>
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                ))
                                                            ) : (
                                                                <p className="text-xs text-text-muted-light dark:text-text-muted-dark italic py-4">No quiz timeline records found.</p>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            </Card>
                                        </div>

                                        {/* Subject Focus Breakdown (Right / col-span-1) */}
                                        <div className="space-y-6">
                                            <Card title="Subject Focus Breakdown" icon={Brain}>
                                                <div className="p-6 space-y-6">
                                                    {/* Strong Topics */}
                                                    <div className="space-y-3">
                                                        <div className="flex items-center gap-2 border-b border-border-light dark:border-border-dark pb-2">
                                                            <div className="w-2 h-2 rounded-full bg-green-500"></div>
                                                            <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Strong Mastery Topics</h4>
                                                        </div>
                                                        <div className="flex flex-wrap gap-1.5">
                                                            {summary.strongTopics && summary.strongTopics.length > 0 ? (
                                                                summary.strongTopics.map((topic, i) => (
                                                                    <span key={i} className="px-2.5 py-1 bg-green-500/10 text-green-400 font-semibold border border-green-500/20 text-xs rounded-lg animate-in fade-in">
                                                                        {topic}
                                                                    </span>
                                                                ))
                                                            ) : (
                                                                <p className="text-xs text-text-muted-light dark:text-text-muted-dark italic">No strong topics identified yet.</p>
                                                            )}
                                                        </div>
                                                    </div>

                                                    {/* Weak Topics */}
                                                    <div className="space-y-3">
                                                        <div className="flex items-center gap-2 border-b border-border-light dark:border-border-dark pb-2">
                                                            <div className="w-2 h-2 rounded-full bg-red-500"></div>
                                                            <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Remediation Required</h4>
                                                        </div>
                                                        <div className="flex flex-wrap gap-1.5">
                                                            {summary.weakTopics && summary.weakTopics.length > 0 ? (
                                                                summary.weakTopics.map((topic, i) => (
                                                                    <span key={i} className="px-2.5 py-1 bg-red-500/10 text-red-400 font-semibold border border-red-500/20 text-xs rounded-lg animate-in fade-in">
                                                                        {topic}
                                                                    </span>
                                                                ))
                                                            ) : (
                                                                <p className="text-xs text-text-muted-light dark:text-text-muted-dark italic">No focus topics needing remediation at this stage.</p>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            </Card>
                                        </div>
                                    </div>
                                </Animate>
                            )}
                        </div>
                </div>
            </div>
        </div>
    );
};

// --- Sub-components ---

const StatCard = ({ label, value, icon: Icon, color, subtext }) => {
    const colors = {
        blue: 'bg-blue-500',
        green: 'bg-green-500',
        amber: 'bg-amber-500',
        red: 'bg-red-500'
    };

    const lightColors = {
        blue: 'text-blue-500',
        green: 'text-green-500',
        amber: 'text-amber-500',
        red: 'text-red-500'
    };

    return (
        <div className="bg-surface-light dark:bg-surface-dark border border-border-light dark:border-border-dark p-5 rounded-2xl shadow-sm hover:shadow-md transition-shadow relative overflow-hidden group">
            <div className={`absolute top-0 right-0 w-24 h-24 ${colors[color]} opacity-[0.03] rounded-bl-full group-hover:opacity-[0.06] transition-opacity`}></div>
            <div className="flex items-center gap-4">
                <div className={`p-3 rounded-xl ${colors[color]} bg-opacity-10 ${lightColors[color]}`}>
                    <Icon size={24} />
                </div>
                <div>
                    <p className="text-xs font-medium text-text-muted-light dark:text-text-muted-dark uppercase tracking-wider">{label}</p>
                    <p className="text-2xl font-bold">{value}</p>
                    {subtext && <p className="text-[10px] text-text-muted-light dark:text-text-muted-dark mt-1">{subtext}</p>}
                </div>
            </div>
        </div>
    );
};

const Card = ({ title, icon: Icon, children, color = "primary", extra, className = "" }) => (
    <div className={`bg-surface-light dark:bg-surface-dark border border-border-light dark:border-border-dark rounded-2xl shadow-sm relative ${className}`}>
        <div className={`px-5 py-4 border-b border-border-light dark:border-border-dark flex items-center justify-between bg-opacity-5 rounded-t-2xl ${color === 'red' ? 'bg-red-500' : color === 'green' ? 'bg-green-500' : 'bg-primary'}`}>
            <div className="flex items-center gap-3">
                <Icon size={18} className={color === 'red' ? 'text-red-500' : color === 'green' ? 'text-green-500' : 'text-primary'} />
                <h3 className="font-bold text-sm tracking-tight">{title}</h3>
            </div>
            {extra}
        </div>
        <div>
            {children}
        </div>
    </div>
);

const TabButton = ({ active, onClick, label, icon: Icon }) => (
    <button
        onClick={onClick}
        className={`px-6 py-3 text-sm font-medium flex items-center gap-2 border-b-2 transition-all whitespace-nowrap ${active
            ? 'border-primary text-text-light dark:text-text-dark bg-primary/5 dark:bg-white/10'
            : 'border-transparent text-text-muted-light dark:text-text-muted-dark hover:text-text-light dark:hover:text-text-dark hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
    >
        <Icon size={16} />
        {label}
    </button>
);

const ProfileItem = ({ label, value }) => (
    <div>
        <p className="text-[10px] uppercase font-semibold text-text-muted-light dark:text-text-muted-dark mb-0.5 tracking-wider">{label}</p>
        <p className="text-sm font-medium border-l-2 border-primary/20 pl-2 capitalize">
            {value ? value.replace(/_/g, ' ') : 'Not set'}
        </p>
    </div>
);

const ConceptRow = ({ concept, status }) => (
    <div className="group flex items-center justify-between p-3 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 border border-transparent hover:border-border-light dark:hover:border-border-dark transition-all">
        <div className="flex items-center gap-3">
            <div className={`w-1.5 h-1.5 rounded-full ${status === 'mastered' ? 'bg-green-500' : 'bg-red-500'}`}></div>
            <div>
                <span className="text-sm font-medium">{concept.name || concept.conceptName}</span>
                <div className="flex items-center gap-2 mt-0.5">
                    <div className="w-24 h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                        <div
                            className={`h-full ${status === 'mastered' ? 'bg-green-500' : 'bg-red-500'}`}
                            style={{ width: `${concept.mastery || concept.masteryScore}%` }}
                        ></div>
                    </div>
                    <span className="text-[10px] text-text-muted-light dark:text-text-muted-dark">{concept.mastery || concept.masteryScore}%</span>
                </div>
            </div>
        </div>
        <ChevronRight size={14} className="text-text-muted-light dark:text-text-muted-dark opacity-0 group-hover:opacity-100 transition-opacity" />
    </div>
);

const Badge = ({ children, color }) => {
    const colors = {
        red: 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400',
        blue: 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400',
        green: 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400'
    };
    return (
        <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${colors[color]}`}>
            {children}
        </span>
    );
};

const Lightbulb = (props) => (
    <svg {...props} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-lightbulb"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A4.5 4.5 0 0 0 13.5 3.5c-2.8 0-5.3 2.5-5.3 5.3 0 1.3.5 2.6 1.5 3.5.8.8 1.3 1.5 1.5 2.5" /><path d="M9 18h6" /><path d="M10 22h4" /></svg>
);

const User = (props) => (
    <svg {...props} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-user"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
);

export default LearningProfile;
