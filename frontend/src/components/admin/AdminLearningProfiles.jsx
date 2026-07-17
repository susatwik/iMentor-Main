import React, { useEffect, useState } from 'react';
import { 
    Loader2, Search, RefreshCw, Brain, Users, AlertTriangle, 
    CheckCircle, BarChart3, BookOpen, Clock, Activity, Award, 
    ChevronDown, ChevronUp, UserCheck 
} from 'lucide-react';
import * as adminApi from '../../services/adminApi.js';
import Button from '../core/Button.jsx';
import toast from 'react-hot-toast';

export default function AdminLearningProfiles() {
    const [activeTab, setActiveTab] = useState('profiles'); // 'profiles' | 'cohort'
    const [profiles, setProfiles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [searchInput, setSearchInput] = useState('');
    const [search, setSearch] = useState('');
    const [page, setPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const [totalStudents, setTotalStudents] = useState(0);
    const [selectedProfile, setSelectedProfile] = useState(null);
    const [selectedLoading, setSelectedLoading] = useState(false);
    
    // Cohort analytics states
    const [cohortStats, setCohortStats] = useState(null);
    const [cohortLoading, setCohortLoading] = useState(false);
    
    // UI state
    const [expandedQuizIndex, setExpandedQuizIndex] = useState(null);

    const fetchProfiles = async () => {
        setLoading(true);
        try {
            const response = await adminApi.getLearningProfiles({ page, limit: 15, search });
            setProfiles(Array.isArray(response?.profiles) ? response.profiles : []);
            setTotalPages(response?.totalPages || 1);
            setTotalStudents(response?.totalStudents || 0);
        } catch (error) {
            toast.error(error.message || 'Failed to load learning profiles');
        } finally {
            setLoading(false);
        }
    };

    const fetchCohortStats = async () => {
        setCohortLoading(true);
        try {
            const stats = await adminApi.getCohortAnalytics();
            setCohortStats(stats);
        } catch (error) {
            toast.error(error.message || 'Failed to load cohort analytics');
        } finally {
            setCohortLoading(false);
        }
    };

    useEffect(() => {
        if (activeTab === 'profiles') {
            fetchProfiles();
        } else {
            fetchCohortStats();
        }
    }, [page, search, activeTab]);

    const submitSearch = (event) => {
        event.preventDefault();
        setPage(1);
        setSearch(searchInput.trim());
    };

    const handleOpenDetails = async (userId) => {
        setSelectedLoading(true);
        setExpandedQuizIndex(null);
        try {
            const detail = await adminApi.getLearningProfileDetails(userId);
            setSelectedProfile(detail);
        } catch (error) {
            toast.error(error.message || 'Failed to load profile details');
        } finally {
            setSelectedLoading(false);
        }
    };

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-border-light dark:border-border-dark pb-4">
                <div>
                    <h2 className="text-xl font-bold flex items-center gap-2 text-text-light dark:text-text-dark">
                        <Brain size={22} className="text-primary" /> Teacher Analytics & Student Profiles
                    </h2>
                    <p className="text-sm text-text-muted-light dark:text-text-muted-dark">
                        Monitor student progress, analyze quiz performance, and track cognitive mastery trends.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <div className="flex rounded-md bg-background-light dark:bg-background-dark p-1 border border-border-light dark:border-border-dark">
                        <button
                            onClick={() => setActiveTab('profiles')}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                                activeTab === 'profiles'
                                    ? 'bg-surface-light dark:bg-surface-dark text-primary shadow-sm'
                                    : 'text-text-muted-light dark:text-text-muted-dark hover:text-text-light dark:hover:text-text-dark'
                            }`}
                        >
                            <Users size={14} /> Student Overview
                        </button>
                        <button
                            onClick={() => setActiveTab('cohort')}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                                activeTab === 'cohort'
                                    ? 'bg-surface-light dark:bg-surface-dark text-primary shadow-sm'
                                    : 'text-text-muted-light dark:text-text-muted-dark hover:text-text-light dark:hover:text-text-dark'
                            }`}
                        >
                            <BarChart3 size={14} /> Cohort Analytics
                        </button>
                    </div>
                    <Button 
                        variant="secondary" 
                        size="sm" 
                        onClick={activeTab === 'profiles' ? fetchProfiles : fetchCohortStats} 
                        leftIcon={<RefreshCw size={14} />}
                    >
                        Refresh
                    </Button>
                </div>
            </div>

            {/* TAB 1: Student Overview */}
            {activeTab === 'profiles' && (
                <div className="space-y-4">
                    {/* Search bar */}
                    <form onSubmit={submitSearch} className="flex gap-2">
                        <div className="relative flex-1">
                            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted-light dark:text-text-muted-dark" />
                            <input
                                value={searchInput}
                                onChange={(e) => setSearchInput(e.target.value)}
                                className="input-field w-full pl-9"
                                placeholder="Search students by email, username, or name..."
                            />
                        </div>
                        <Button type="submit" size="sm">Search</Button>
                    </form>

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        {/* Student Overview Table Left Side */}
                        <div className="lg:col-span-2 space-y-4">
                            <div className="border border-border-light dark:border-border-dark rounded-lg bg-surface-light dark:bg-surface-dark overflow-hidden">
                                <div className="p-3 bg-background-light dark:bg-background-dark border-b border-border-light dark:border-border-dark flex items-center justify-between">
                                    <span className="text-xs font-bold text-text-muted-light dark:text-text-muted-dark uppercase tracking-wider">Student Registry</span>
                                    <span className="text-xs text-text-muted-light dark:text-text-muted-dark font-medium">Total: {totalStudents}</span>
                                </div>
                                <div className="overflow-x-auto max-h-[60vh] overflow-y-auto custom-scrollbar">
                                    {loading ? (
                                        <div className="flex items-center justify-center p-16 text-sm text-text-muted-light dark:text-text-muted-dark">
                                            <Loader2 size={22} className="animate-spin text-primary mr-2" />
                                            Loading student registry...
                                        </div>
                                    ) : profiles.length === 0 ? (
                                        <div className="p-16 text-center text-sm text-text-muted-light dark:text-text-muted-dark">
                                            No students found matching search.
                                        </div>
                                    ) : (
                                        <table className="w-full text-sm text-left border-collapse">
                                            <thead className="bg-background-light dark:bg-background-dark text-xs text-text-muted-light dark:text-text-muted-dark uppercase border-b border-border-light dark:border-border-dark sticky top-0 z-10">
                                                <tr>
                                                    <th className="px-4 py-3 font-semibold">Student</th>
                                                    <th className="px-4 py-3 font-semibold">Active Course</th>
                                                    <th className="px-4 py-3 font-semibold text-center">Sessions</th>
                                                    <th className="px-4 py-3 font-semibold text-center">Avg Quiz</th>
                                                    <th className="px-4 py-3 font-semibold text-center">Mastery</th>
                                                    <th className="px-4 py-3 font-semibold text-right">Action</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-border-light dark:divide-border-dark">
                                                {profiles.map((profile) => {
                                                    const isSelected = selectedProfile && selectedProfile.user?.id === profile.user.id;
                                                    return (
                                                        <tr 
                                                            key={profile.user.id} 
                                                            className={`hover:bg-background-light/40 dark:hover:bg-background-dark/30 transition-colors ${
                                                                isSelected ? 'bg-primary/5 dark:bg-primary/10 border-l-2 border-primary' : ''
                                                            }`}
                                                        >
                                                            <td className="px-4 py-3">
                                                                <div className="font-semibold text-text-light dark:text-text-dark">
                                                                    {profile.user.name || profile.user.username}
                                                                </div>
                                                                <div className="text-xs text-text-muted-light dark:text-text-muted-dark">
                                                                    {profile.user.email}
                                                                </div>
                                                            </td>
                                                            <td className="px-4 py-3 text-xs font-medium text-text-muted-light dark:text-text-muted-dark truncate max-w-[120px]">
                                                                {profile.activeCourse || 'None'}
                                                            </td>
                                                            <td className="px-4 py-3 text-center text-xs font-bold text-text-light dark:text-text-dark">
                                                                {profile.totalTutorSessions}
                                                            </td>
                                                            <td className="px-4 py-3 text-center text-xs font-bold">
                                                                {profile.averageQuizScore !== null ? (
                                                                    <span className={profile.averageQuizScore >= 80 ? 'text-green-600 dark:text-green-400' : profile.averageQuizScore >= 50 ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-600 dark:text-red-400'}>
                                                                        {profile.averageQuizScore}%
                                                                    </span>
                                                                ) : (
                                                                    <span className="text-text-muted-light dark:text-text-muted-dark font-normal">N/A</span>
                                                                )}
                                                            </td>
                                                            <td className="px-4 py-3 text-center">
                                                                <div className="text-xs font-medium text-text-light dark:text-text-dark">
                                                                    {profile.summary?.mastered} / {profile.summary?.totalConcepts}
                                                                </div>
                                                                <div className="w-16 bg-background-light dark:bg-background-dark h-1.5 rounded-full mx-auto overflow-hidden mt-1">
                                                                    <div 
                                                                        className="bg-green-500 h-full rounded-full" 
                                                                        style={{ 
                                                                            width: `${profile.summary?.totalConcepts ? (profile.summary.mastered / profile.summary.totalConcepts) * 100 : 0}%` 
                                                                        }} 
                                                                    />
                                                                </div>
                                                            </td>
                                                            <td className="px-4 py-3 text-right">
                                                                <Button 
                                                                    size="xs" 
                                                                    variant={isSelected ? 'primary' : 'secondary'} 
                                                                    onClick={() => handleOpenDetails(profile.user.id)}
                                                                >
                                                                    Details
                                                                </Button>
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                    )}
                                </div>
                            </div>

                            {/* Pagination */}
                            <div className="flex items-center justify-between pt-2">
                                <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((prev) => Math.max(1, prev - 1))}>Previous</Button>
                                <span className="text-xs text-text-muted-light dark:text-text-muted-dark font-medium">Page {page} / {Math.max(totalPages, 1)}</span>
                                <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage((prev) => prev + 1)}>Next</Button>
                            </div>
                        </div>

                        {/* Student Detailed Report Sidebar */}
                        <div className="border border-border-light dark:border-border-dark rounded-lg bg-surface-light dark:bg-surface-dark overflow-hidden flex flex-col max-h-[72vh]">
                            <div className="p-3 bg-background-light dark:bg-background-dark border-b border-border-light dark:border-border-dark">
                                <span className="text-xs font-bold text-text-muted-light dark:text-text-muted-dark uppercase tracking-wider">Detailed Learning Log</span>
                            </div>
                            
                            <div className="p-4 overflow-y-auto custom-scrollbar flex-1 space-y-5">
                                {selectedLoading ? (
                                    <div className="flex flex-col items-center justify-center p-16 text-sm text-text-muted-light dark:text-text-muted-dark">
                                        <Loader2 size={24} className="animate-spin text-primary mb-2" />
                                        Hydrating profile history...
                                    </div>
                                ) : !selectedProfile ? (
                                    <div className="text-sm text-text-muted-light dark:text-text-muted-dark text-center py-24 italic">
                                        Select a student from the registry to view cognitive insights and performance metrics.
                                    </div>
                                ) : (
                                    <div className="space-y-5">
                                         {/* Student Details */}
                                         <div className="border-b border-border-light dark:border-border-dark pb-3">
                                             <h3 className="font-bold text-base text-text-light dark:text-text-dark">{selectedProfile.user?.name || selectedProfile.user?.username}</h3>
                                             <p className="text-xs text-text-muted-light dark:text-text-muted-dark">{selectedProfile.user?.email}</p>
                                             <div className="mt-2 flex flex-wrap gap-1.5">
                                                 <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-primary/10 text-primary">
                                                     Style: {selectedProfile.profile?.dominantLearningStyle || 'unknown'}
                                                 </span>
                                                 <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">
                                                     Pace: {selectedProfile.profile?.learningPace || 'moderate'}
                                                 </span>
                                                 <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300">
                                                     Stage: {selectedProfile.user?.learningStage || 'Beginner'}
                                                 </span>
                                             </div>
                                             {selectedProfile.lastUpdated && (
                                                 <div className="text-[10px] text-text-muted-light dark:text-text-muted-dark mt-2">
                                                     Last Active: {new Date(selectedProfile.lastUpdated).toLocaleDateString()} at {new Date(selectedProfile.lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                 </div>
                                             )}
                                         </div>

                                         {/* Gamification Dashboard */}
                                         <div className="space-y-2 border-b border-border-light dark:border-border-dark pb-3">
                                             <h4 className="text-xs font-bold text-text-muted-light dark:text-text-muted-dark uppercase tracking-wider flex items-center gap-1">
                                                 <Award size={12} className="text-yellow-500" /> Gamification Profile
                                             </h4>
                                             <div className="grid grid-cols-2 gap-2 text-xs">
                                                 <div className="p-2 rounded bg-background-light dark:bg-background-dark border border-border-light/60 dark:border-border-dark/60">
                                                     <span className="block text-text-muted-light dark:text-text-muted-dark text-[10px]">Learning Credits</span>
                                                     <strong className="text-xs text-text-light dark:text-text-dark">Lvl {selectedProfile.gamification?.level || 1} • {selectedProfile.gamification?.totalLearningCredits || 0} pts</strong>
                                                 </div>
                                                 <div className="p-2 rounded bg-background-light dark:bg-background-dark border border-border-light/60 dark:border-border-dark/60">
                                                     <span className="block text-text-muted-light dark:text-text-muted-dark text-[10px]">Streak / Energy</span>
                                                     <strong className="text-xs text-text-light dark:text-text-dark">{selectedProfile.gamification?.currentStreak || 0} days / {selectedProfile.gamification?.currentEnergy || 100}%</strong>
                                                 </div>
                                             </div>
                                             {selectedProfile.gamification?.badges?.length > 0 && (
                                                 <div className="space-y-1">
                                                     <span className="text-[10px] text-text-muted-light dark:text-text-muted-dark font-medium">Earned Badges:</span>
                                                     <div className="flex flex-wrap gap-1">
                                                         {selectedProfile.gamification.badges.map((badge, bIdx) => (
                                                             <span key={bIdx} className="text-[9px] px-1.5 py-0.5 rounded font-bold bg-yellow-500/10 text-yellow-600 border border-yellow-500/20" title={new Date(badge.earnedAt).toLocaleDateString()}>
                                                                 🏆 {badge.name}
                                                             </span>
                                                         ))}
                                                     </div>
                                                 </div>
                                             )}
                                         </div>

                                         {/* Course Curriculum Progress */}
                                         <div className="space-y-2 border-b border-border-light dark:border-border-dark pb-3">
                                             <h4 className="text-xs font-bold text-text-muted-light dark:text-text-muted-dark uppercase tracking-wider flex items-center gap-1">
                                                 <BookOpen size={12} className="text-blue-500" /> Syllabus Progress
                                             </h4>
                                             {(!selectedProfile.courseCurriculumProgress || selectedProfile.courseCurriculumProgress.length === 0) ? (
                                                 <p className="text-xs italic text-text-muted-light dark:text-text-muted-dark">No courses registered.</p>
                                             ) : (
                                                 <div className="space-y-3">
                                                     {selectedProfile.courseCurriculumProgress.map((course, cIdx) => (
                                                         <div key={cIdx} className="space-y-1 text-xs">
                                                             <div className="flex justify-between font-medium">
                                                                 <span className="truncate max-w-[70%]">{course.courseName}</span>
                                                                 <span>{course.completionPercent}%</span>
                                                             </div>
                                                             <div className="w-full bg-background-light dark:bg-background-dark h-2 rounded-full overflow-hidden">
                                                                 <div 
                                                                     className="bg-blue-500 h-full rounded-full" 
                                                                     style={{ width: `${course.completionPercent}%` }} 
                                                                 />
                                                             </div>
                                                             <div className="text-[10px] text-text-muted-light dark:text-text-muted-dark flex justify-between">
                                                                 <span>Completed: {course.completedSubtopicsCount} subtopics, {course.completedModulesCount} modules</span>
                                                             </div>
                                                         </div>
                                                     ))}
                                                 </div>
                                             )}
                                         </div>

                                         {/* Skill Tree Progress */}
                                         <div className="space-y-2 border-b border-border-light dark:border-border-dark pb-3">
                                             <h4 className="text-xs font-bold text-text-muted-light dark:text-text-muted-dark uppercase tracking-wider flex items-center gap-1">
                                                 <Activity size={12} className="text-purple-500" /> Skill Map Mastery
                                             </h4>
                                             <div className="p-2.5 rounded bg-background-light dark:bg-background-dark border border-border-light/60 dark:border-border-dark/60 text-xs flex justify-between items-center">
                                                 <div>
                                                     <span className="text-[10px] text-text-muted-light dark:text-text-muted-dark block">Completed Levels</span>
                                                     <strong className="text-sm font-bold text-purple-600 dark:text-purple-400">{selectedProfile.skillTree?.completedLevels || 0} nodes</strong>
                                                 </div>
                                                 <div className="text-right">
                                                     <span className="text-[10px] text-text-muted-light dark:text-text-muted-dark block">Stars Earned</span>
                                                     <strong className="text-sm font-bold text-yellow-600 dark:text-yellow-400">⭐ {selectedProfile.skillTree?.totalStars || 0} stars</strong>
                                                 </div>
                                             </div>
                                         </div>

                                         {/* Socratic Session Analytics */}
                                         <div className="space-y-2 border-b border-border-light dark:border-border-dark pb-3">
                                             <h4 className="text-xs font-bold text-text-muted-light dark:text-text-muted-dark uppercase tracking-wider flex items-center gap-1">
                                                 <Brain size={12} className="text-primary" /> Tutor Session Analytics
                                             </h4>
                                             <div className="grid grid-cols-2 gap-2 text-xs">
                                                 <div className="p-2 rounded bg-background-light dark:bg-background-dark border border-border-light/60 dark:border-border-dark/60">
                                                     <span className="block text-text-muted-light dark:text-text-muted-dark text-[10px]">Tutor Sessions</span>
                                                     <strong className="text-xs text-text-light dark:text-text-dark">{selectedProfile.engagementMetrics?.totalSessions || 0} sessions</strong>
                                                 </div>
                                                 <div className="p-2 rounded bg-background-light dark:bg-background-dark border border-border-light/60 dark:border-border-dark/60">
                                                     <span className="block text-text-muted-light dark:text-text-muted-dark text-[10px]">Tutor Duration</span>
                                                     <strong className="text-xs text-text-light dark:text-text-dark">{selectedProfile.engagementMetrics?.totalSessionDuration || 0} mins</strong>
                                                 </div>
                                             </div>
                                         </div>

                                         {/* Quiz Performance Analytics */}
                                         <div className="space-y-2 border-b border-border-light dark:border-border-dark pb-3">
                                             <h4 className="text-xs font-bold text-text-muted-light dark:text-text-muted-dark uppercase tracking-wider flex items-center gap-1">
                                                 <Award size={12} className="text-green-500" /> Quiz Statistics
                                             </h4>
                                             <div className="grid grid-cols-3 gap-1.5 text-xs text-center">
                                                 <div className="p-1.5 rounded bg-background-light dark:bg-background-dark border border-border-light/60 dark:border-border-dark/60">
                                                     <span className="block text-text-muted-light dark:text-text-muted-dark text-[9px]">Attempts</span>
                                                     <strong className="text-xs text-text-light dark:text-text-dark">{selectedProfile.user?.totalQuizAttempts || 0}</strong>
                                                 </div>
                                                 <div className="p-1.5 rounded bg-background-light dark:bg-background-dark border border-border-light/60 dark:border-border-dark/60">
                                                     <span className="block text-text-muted-light dark:text-text-muted-dark text-[9px]">Best Score</span>
                                                     <strong className="text-xs text-green-600 dark:text-green-400">{selectedProfile.user?.bestQuizScore !== null ? `${selectedProfile.user.bestQuizScore}%` : 'N/A'}</strong>
                                                 </div>
                                                 <div className="p-1.5 rounded bg-background-light dark:bg-background-dark border border-border-light/60 dark:border-border-dark/60">
                                                     <span className="block text-text-muted-light dark:text-text-muted-dark text-[9px]">Latest Score</span>
                                                     <strong className="text-xs text-blue-600 dark:text-blue-400">{selectedProfile.user?.latestQuizScore !== null ? `${selectedProfile.user.latestQuizScore}%` : 'N/A'}</strong>
                                                 </div>
                                             </div>
                                         </div>

                                         {/* Cognitive Profile Summary */}
                                         <div className="space-y-2 border-b border-border-light dark:border-border-dark pb-3">
                                             <h4 className="text-xs font-bold text-text-muted-light dark:text-text-muted-dark uppercase tracking-wider flex items-center gap-1">
                                                 <Brain size={12} /> Cognitive Mastery Status
                                             </h4>
                                             <div className="grid grid-cols-3 gap-1.5 text-center text-xs">
                                                 <div className="p-2 bg-green-500/10 text-green-700 dark:text-green-400 border border-green-500/20 rounded">
                                                     <span className="block font-bold text-sm">{selectedProfile.summary?.mastered || 0}</span>
                                                     Mastered
                                                 </div>
                                                 <div className="p-2 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border border-yellow-500/20 rounded">
                                                     <span className="block font-bold text-xs">+{selectedProfile.summary?.avgLearningVelocity || 0}</span>
                                                     Velocity
                                                 </div>
                                                 <div className="p-2 bg-red-500/10 text-red-700 dark:text-red-400 border border-red-500/20 rounded">
                                                     <span className="block font-bold text-sm">{selectedProfile.summary?.struggling || 0}</span>
                                                     Struggling
                                                 </div>
                                             </div>
                                         </div>

                                         {/* AI Natural Language Summary */}
                                         {selectedProfile.textSummary && (
                                             <div className="space-y-1.5 p-3 rounded-lg bg-background-light dark:bg-background-dark border border-border-light dark:border-border-dark">
                                                 <h4 className="text-xs font-bold text-text-muted-light dark:text-text-muted-dark uppercase tracking-wider flex items-center gap-1">
                                                     🤖 AI Tutor Profile Analysis
                                                 </h4>
                                                 <p className="text-xs leading-relaxed text-text-light dark:text-text-dark whitespace-pre-wrap">{selectedProfile.textSummary}</p>
                                             </div>
                                         )}

                                         {/* Quiz Performance Log */}
                                         <div className="space-y-2 border-b border-border-light dark:border-border-dark pb-3">
                                             <h4 className="text-xs font-bold text-text-muted-light dark:text-text-muted-dark uppercase tracking-wider flex items-center gap-1">
                                                 <Award size={12} /> Quiz Performance Log
                                             </h4>
                                             {(selectedProfile.user?.quizScores || []).length === 0 ? (
                                                 <p className="text-xs italic text-text-muted-light dark:text-text-muted-dark">No quiz attempts recorded.</p>
                                             ) : (
                                                 <div className="space-y-1.5">
                                                     {(selectedProfile.user.quizScores).map((quiz, qIdx) => {
                                                         const isExpanded = expandedQuizIndex === qIdx;
                                                         return (
                                                             <div key={qIdx} className="border border-border-light dark:border-border-dark rounded-md overflow-hidden text-xs bg-background-light/40 dark:bg-background-dark/20">
                                                                 <div 
                                                                     onClick={() => setExpandedQuizIndex(isExpanded ? null : qIdx)}
                                                                     className="p-2 flex items-center justify-between cursor-pointer hover:bg-background-light/80 dark:hover:bg-background-dark/50"
                                                                 >
                                                                     <div className="font-medium text-text-light dark:text-text-dark truncate pr-2 max-w-[70%]">
                                                                         {quiz.module || quiz.courseName || 'General Quiz'}
                                                                     </div>
                                                                     <div className="flex items-center gap-2">
                                                                         <span className={`font-bold ${quiz.score >= 80 ? 'text-green-600 dark:text-green-400' : quiz.score >= 50 ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-600 dark:text-red-400'}`}>
                                                                             {quiz.score}%
                                                                         </span>
                                                                         {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                                                     </div>
                                                                 </div>
                                                                 {isExpanded && (
                                                                     <div className="p-2.5 bg-surface-light dark:bg-surface-dark border-t border-border-light dark:border-border-dark space-y-2 text-[11px] text-text-muted-light dark:text-text-muted-dark">
                                                                         <div>
                                                                             <span className="font-semibold text-text-light dark:text-text-dark">Date:</span> {new Date(quiz.date || quiz.attemptDate).toLocaleDateString()}
                                                                         </div>
                                                                         {quiz.remediation && (
                                                                             <div className="space-y-1 border-t border-border-light dark:border-border-dark pt-1.5 mt-1.5">
                                                                                 <div>
                                                                                     <span className="font-semibold text-green-600 dark:text-green-400">Strengths:</span> {quiz.remediation.strength || 'N/A'}
                                                                                 </div>
                                                                                 <div>
                                                                                     <span className="font-semibold text-red-600 dark:text-red-400">Weaknesses:</span> {quiz.remediation.weakness || 'N/A'}
                                                                                 </div>
                                                                                 <div>
                                                                                     <span className="font-semibold text-primary">AI recommendation:</span> {quiz.remediation.recommendation || 'N/A'}
                                                                                 </div>
                                                                             </div>
                                                                         )}
                                                                     </div>
                                                                 )}
                                                             </div>
                                                         );
                                                     })}
                                                 </div>
                                             )}
                                         </div>

                                         {/* Socratic Path Recommendations */}
                                         <div className="space-y-2 border-b border-border-light dark:border-border-dark pb-3">
                                             <h4 className="text-xs font-bold text-text-muted-light dark:text-text-muted-dark uppercase tracking-wider flex items-center gap-1">
                                                 <UserCheck size={12} /> Socratic Path Recommendations
                                             </h4>
                                             {(selectedProfile.recommendations || []).length === 0 ? (
                                                 <p className="text-xs italic text-text-muted-light dark:text-text-muted-dark">No recommendations available.</p>
                                             ) : (
                                                 <div className="space-y-2">
                                                     {(selectedProfile.recommendations).map((rec, idx) => (
                                                         <div key={idx} className="p-2.5 border border-border-light dark:border-border-dark rounded-md bg-background-light dark:bg-background-dark text-xs relative">
                                                             <div className="flex items-center justify-between mb-1">
                                                                 <span className="font-semibold text-text-light dark:text-text-dark capitalize">{rec.topic}</span>
                                                                 <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold uppercase ${
                                                                     rec.priority === 'high' ? 'bg-red-500/10 text-red-600' :
                                                                     rec.priority === 'medium' ? 'bg-yellow-500/10 text-yellow-600' : 'bg-blue-500/10 text-blue-600'
                                                                 }`}>
                                                                     {rec.priority || 'medium'}
                                                                 </span>
                                                             </div>
                                                             <p className="text-[11px] text-text-muted-light dark:text-text-muted-dark">{rec.reason}</p>
                                                             <div className="text-[9px] mt-1.5 text-text-muted-light/60 dark:text-text-muted-dark/50 flex justify-between">
                                                                 <span>Action: {rec.type}</span>
                                                                 <span>{new Date(rec.createdAt).toLocaleDateString()}</span>
                                                             </div>
                                                         </div>
                                                     ))}
                                                 </div>
                                             )}
                                         </div>

                                         {/* Concept Table Detail */}
                                         <div className="space-y-2 border-b border-border-light dark:border-border-dark pb-3">
                                             <h4 className="text-xs font-bold text-text-muted-light dark:text-text-muted-dark uppercase tracking-wider flex items-center gap-1">
                                                 <BookOpen size={12} /> Concept Mastery Log
                                             </h4>
                                             <div className="max-h-56 overflow-y-auto custom-scrollbar border border-border-light dark:border-border-dark rounded-md">
                                                 <table className="w-full text-xs text-left border-collapse">
                                                     <thead className="bg-background-light dark:bg-background-dark sticky top-0 border-b border-border-light dark:border-border-dark">
                                                         <tr>
                                                             <th className="p-2 font-semibold">Concept</th>
                                                             <th className="p-2 font-semibold text-center">Mastery</th>
                                                             <th className="p-2 font-semibold text-right">Velocity</th>
                                                         </tr>
                                                     </thead>
                                                     <tbody className="divide-y divide-border-light dark:divide-border-dark">
                                                         {(selectedProfile.concepts || []).map((concept, idx) => (
                                                             <tr key={`${concept.name}-${idx}`} className="hover:bg-background-light/20 dark:hover:bg-background-dark/10">
                                                                 <td className="p-2">
                                                                     <div className="font-medium text-text-light dark:text-text-dark">{concept.name}</div>
                                                                     <div className="text-[10px] text-text-muted-light dark:text-text-muted-dark capitalize">{concept.understandingLevel} • {concept.difficulty} diff</div>
                                                                 </td>
                                                                 <td className="p-2 text-center font-bold text-text-light dark:text-text-dark">
                                                                     {concept.mastery}%
                                                                 </td>
                                                                 <td className="p-2 text-right text-text-muted-light dark:text-text-muted-dark">
                                                                     +{concept.learningVelocity || 0}
                                                                 </td>
                                                             </tr>
                                                         ))}
                                                     </tbody>
                                                 </table>
                                             </div>
                                         </div>

                                         {/* Learning Timeline */}
                                         <div className="space-y-3">
                                             <h4 className="text-xs font-bold text-text-muted-light dark:text-text-muted-dark uppercase tracking-wider flex items-center gap-1">
                                                 <Activity size={12} /> Student Learning Timeline
                                             </h4>
                                             {!selectedProfile.timeline || selectedProfile.timeline.length === 0 ? (
                                                 <p className="text-xs italic text-text-muted-light dark:text-text-muted-dark">No timeline events recorded.</p>
                                             ) : (
                                                 <div className="border-l-2 border-primary/20 dark:border-primary/45 ml-2 pl-4 space-y-4">
                                                     {selectedProfile.timeline.map((event, idx) => (
                                                         <div key={idx} className="relative">
                                                             <span className={`absolute -left-[23px] top-1 rounded-full p-1 border text-white ${
                                                                 event.type === 'quiz' ? 'bg-green-500 border-green-600' :
                                                                 event.type === 'tutor' ? 'bg-primary border-primary/80' : 'bg-purple-500 border-purple-600'
                                                             }`}>
                                                                 {event.type === 'quiz' ? <Award size={8} /> :
                                                                  event.type === 'tutor' ? <Brain size={8} /> : <BookOpen size={8} />}
                                                             </span>
                                                             <div className="text-xs">
                                                                 <div className="font-semibold text-text-light dark:text-text-dark">{event.title}</div>
                                                                 <div className="text-[11px] text-text-muted-light dark:text-text-muted-dark mt-0.5">{event.detail}</div>
                                                                 <div className="text-[10px] text-text-muted-light/60 dark:text-text-muted-dark/50 mt-1">
                                                                     {new Date(event.date).toLocaleDateString()} at {new Date(event.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                                 </div>
                                                             </div>
                                                         </div>
                                                     ))}
                                                 </div>
                                             )}
                                         </div>
                                     </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* TAB 2: Cohort Analytics */}
            {activeTab === 'cohort' && (
                <div className="space-y-6">
                    {cohortLoading ? (
                        <div className="flex flex-col items-center justify-center p-24 text-sm text-text-muted-light dark:text-text-muted-dark">
                            <Loader2 size={28} className="animate-spin text-primary mb-2" />
                            Aggregating school-wide data layers...
                        </div>
                    ) : !cohortStats ? (
                        <div className="p-16 text-center text-sm text-text-muted-light dark:text-text-muted-dark border border-dashed border-border-light dark:border-border-dark rounded-lg">
                            Cohort analytics are currently empty. Check back once users run Socratic chat routines.
                        </div>
                    ) : (
                        <div className="space-y-6">
                            {/* Summary Metrics Row */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div className="p-5 border border-border-light dark:border-border-dark rounded-xl bg-surface-light dark:bg-surface-dark shadow-sm flex items-center gap-4">
                                    <div className="p-3 bg-primary/10 rounded-full text-primary">
                                        <Users size={24} />
                                    </div>
                                    <div>
                                        <span className="block text-xs font-bold uppercase tracking-wider text-text-muted-light dark:text-text-muted-dark">Total Enrolled</span>
                                        <strong className="text-2xl text-text-light dark:text-text-dark">{cohortStats.totalStudentsCount || 0}</strong>
                                    </div>
                                </div>
                                <div className="p-5 border border-border-light dark:border-border-dark rounded-xl bg-surface-light dark:bg-surface-dark shadow-sm flex items-center gap-4">
                                    <div className="p-3 bg-green-500/10 rounded-full text-green-600">
                                        <Award size={24} />
                                    </div>
                                    <div>
                                        <span className="block text-xs font-bold uppercase tracking-wider text-text-muted-light dark:text-text-muted-dark">Avg Quiz Performance</span>
                                        <strong className="text-2xl text-green-600 dark:text-green-400">
                                            {cohortStats.courseAnalytics?.length > 0 
                                                ? `${Math.round(cohortStats.courseAnalytics.reduce((sum, item) => sum + (item.averageQuizScore || 0), 0) / cohortStats.courseAnalytics.length)}%`
                                                : 'N/A'
                                            }
                                        </strong>
                                    </div>
                                </div>
                                <div className="p-5 border border-border-light dark:border-border-dark rounded-xl bg-surface-light dark:bg-surface-dark shadow-sm flex items-center gap-4">
                                    <div className="p-3 bg-blue-500/10 rounded-full text-blue-600">
                                        <Activity size={24} />
                                    </div>
                                    <div>
                                        <span className="block text-xs font-bold uppercase tracking-wider text-text-muted-light dark:text-text-muted-dark">Risk Index</span>
                                        <strong className="text-2xl text-text-light dark:text-text-dark">
                                            {cohortStats.strugglingStudents?.length || 0} <span className="text-xs font-medium text-text-muted-light dark:text-text-muted-dark">students at risk</span>
                                        </strong>
                                    </div>
                                </div>
                            </div>

                            {/* Course Enrollment & Stats */}
                            <div className="border border-border-light dark:border-border-dark rounded-xl bg-surface-light dark:bg-surface-dark p-5 shadow-sm space-y-4">
                                <h3 className="text-sm font-bold text-text-light dark:text-text-dark flex items-center gap-1.5 uppercase tracking-wider">
                                    <BookOpen size={16} className="text-primary" /> Active Course Metrics
                                </h3>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    {(cohortStats.courseAnalytics || []).length === 0 ? (
                                        <p className="text-sm text-text-muted-light dark:text-text-muted-dark italic">No course analytics recorded.</p>
                                    ) : (
                                        (cohortStats.courseAnalytics).map((courseItem, idx) => (
                                            <div key={idx} className="space-y-3 p-4 rounded-lg bg-background-light dark:bg-background-dark border border-border-light/60 dark:border-border-dark/60">
                                                <div className="flex items-center justify-between">
                                                    <span className="font-semibold text-text-light dark:text-text-dark text-sm truncate pr-2">{courseItem.course}</span>
                                                    <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-bold">{courseItem.studentCount} active</span>
                                                </div>
                                                <div className="space-y-1">
                                                    <div className="flex justify-between text-xs text-text-muted-light dark:text-text-muted-dark">
                                                        <span>Class Quiz Avg</span>
                                                        <span className="font-bold text-text-light dark:text-text-dark">{courseItem.averageQuizScore !== null ? `${courseItem.averageQuizScore}%` : 'N/A'}</span>
                                                    </div>
                                                    {courseItem.averageQuizScore !== null && (
                                                        <div className="w-full bg-surface-light dark:bg-surface-dark h-2 rounded-full overflow-hidden">
                                                            <div 
                                                                className={`h-full rounded-full ${
                                                                    courseItem.averageQuizScore >= 75 ? 'bg-green-500' :
                                                                    courseItem.averageQuizScore >= 50 ? 'bg-yellow-500' : 'bg-red-500'
                                                                }`}
                                                                style={{ width: `${courseItem.averageQuizScore}%` }}
                                                            />
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="space-y-1 pt-1.5 border-t border-border-light/30 dark:border-border-dark/30 mt-1.5">
                                                    <div className="flex justify-between text-xs text-text-muted-light dark:text-text-muted-dark">
                                                        <span>Syllabus Completion</span>
                                                        <span className="font-bold text-text-light dark:text-text-dark">{courseItem.averageCompletionPercent || 0}%</span>
                                                    </div>
                                                    <div className="w-full bg-surface-light dark:bg-surface-dark h-2 rounded-full overflow-hidden">
                                                        <div 
                                                            className="h-full rounded-full bg-blue-500"
                                                            style={{ width: `${courseItem.averageCompletionPercent || 0}%` }}
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </div>

                            {/* Two-Column Lists */}
                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                {/* Topic Mastered vs Struggle list */}
                                <div className="border border-border-light dark:border-border-dark rounded-xl bg-surface-light dark:bg-surface-dark p-5 shadow-sm space-y-4">
                                    <h3 className="text-sm font-bold text-text-light dark:text-text-dark flex items-center gap-1.5 uppercase tracking-wider">
                                        <Brain size={16} className="text-primary" /> Topic Performance Distribution
                                    </h3>
                                    
                                    <div className="space-y-4">
                                        {/* Most Difficult */}
                                        <div className="space-y-2">
                                            <span className="text-xs font-bold text-red-600 dark:text-red-400 uppercase tracking-wider flex items-center gap-1">
                                                ⚠️ Most Difficult Topics (Lowest Mastery)
                                            </span>
                                            {(cohortStats.mostDifficultTopics || []).length === 0 ? (
                                                <p className="text-xs italic text-text-muted-light dark:text-text-muted-dark">No topic stats.</p>
                                            ) : (
                                                <div className="space-y-1.5">
                                                    {(cohortStats.mostDifficultTopics).map((topic, idx) => (
                                                        <div key={idx} className="flex items-center justify-between p-2 rounded bg-red-500/5 border border-red-500/10 text-xs">
                                                            <span className="font-medium text-text-light dark:text-text-dark">{topic.conceptName}</span>
                                                            <div className="flex items-center gap-3">
                                                                <span className="text-text-muted-light dark:text-text-muted-dark font-medium">{topic.studentCount} students</span>
                                                                <span className="font-bold text-red-600 dark:text-red-400">{topic.averageMastery}% mastery</span>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>

                                        {/* Most Mastered */}
                                        <div className="space-y-2">
                                            <span className="text-xs font-bold text-green-600 dark:text-green-400 uppercase tracking-wider flex items-center gap-1">
                                                ✅ Most Mastered Topics (Highest Mastery)
                                            </span>
                                            {(cohortStats.mostMasteredTopics || []).length === 0 ? (
                                                <p className="text-xs italic text-text-muted-light dark:text-text-muted-dark">No topic stats.</p>
                                            ) : (
                                                <div className="space-y-1.5">
                                                    {(cohortStats.mostMasteredTopics).map((topic, idx) => (
                                                        <div key={idx} className="flex items-center justify-between p-2 rounded bg-green-500/5 border border-green-500/10 text-xs">
                                                            <span className="font-medium text-text-light dark:text-text-dark">{topic.conceptName}</span>
                                                            <div className="flex items-center gap-3">
                                                                <span className="text-text-muted-light dark:text-text-muted-dark font-medium">{topic.studentCount} students</span>
                                                                <span className="font-bold text-green-600 dark:text-green-400">{topic.averageMastery}% mastery</span>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                {/* Struggles and Activity */}
                                <div className="border border-border-light dark:border-border-dark rounded-xl bg-surface-light dark:bg-surface-dark p-5 shadow-sm space-y-4">
                                    <h3 className="text-sm font-bold text-text-light dark:text-text-dark flex items-center gap-1.5 uppercase tracking-wider">
                                        <Activity size={16} className="text-primary" /> Engagement & Risk Analysis
                                    </h3>
                                    
                                    <div className="space-y-4">
                                        {/* Struggling Students */}
                                        <div className="space-y-2">
                                            <span className="text-xs font-bold text-red-600 dark:text-red-400 uppercase tracking-wider flex items-center gap-1">
                                                🚨 Students Requiring Quiz Attention (Avg &lt; 50%)
                                            </span>
                                            {(cohortStats.strugglingStudents || []).length === 0 ? (
                                                <p className="text-xs text-text-muted-light dark:text-text-muted-dark italic">No students identified as struggling with quizzes.</p>
                                            ) : (
                                                <div className="space-y-1.5 max-h-36 overflow-y-auto custom-scrollbar">
                                                    {(cohortStats.strugglingStudents).map((stud, idx) => (
                                                        <div key={idx} className="p-2 border border-red-500/25 rounded-md bg-red-500/5 flex items-center justify-between text-xs">
                                                            <div>
                                                                <span className="font-semibold text-text-light dark:text-text-dark block">{stud.name || stud.username}</span>
                                                                <span className="text-[10px] text-text-muted-light dark:text-text-muted-dark">{stud.email}</span>
                                                            </div>
                                                            <div className="text-right">
                                                                <span className="font-bold text-red-600 dark:text-red-400 text-sm">{stud.averageQuizScore}%</span>
                                                                <span className="block text-[9px] text-text-muted-light dark:text-text-muted-dark">{stud.quizAttemptsCount} attempts</span>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>

                                        {/* Most Active */}
                                        <div className="space-y-2">
                                            <span className="text-xs font-bold text-primary uppercase tracking-wider flex items-center gap-1">
                                                ⚡ Highly Engaged Students
                                            </span>
                                            {(cohortStats.mostActiveStudents || []).length === 0 ? (
                                                <p className="text-xs text-text-muted-light dark:text-text-muted-dark italic">No student activity logged.</p>
                                            ) : (
                                                <div className="space-y-1.5 max-h-36 overflow-y-auto custom-scrollbar">
                                                    {(cohortStats.mostActiveStudents).map((stud, idx) => (
                                                        <div key={idx} className="p-2 border border-border-light dark:border-border-dark rounded-md bg-background-light/40 dark:bg-background-dark/10 flex items-center justify-between text-xs">
                                                            <div>
                                                                <span className="font-semibold text-text-light dark:text-text-dark block">{stud.name || stud.username}</span>
                                                                <span className="text-[10px] text-text-muted-light dark:text-text-muted-dark">{stud.email}</span>
                                                            </div>
                                                            <div className="text-right text-[10px] text-text-muted-light dark:text-text-muted-dark">
                                                                <span className="font-bold text-text-light dark:text-text-dark text-xs block">{stud.sessionCount} sessions</span>
                                                                {stud.totalInteractions} interactions
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
