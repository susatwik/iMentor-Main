import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    BookOpen, Upload, FileText, CheckCircle2, Loader2, ArrowLeft,
    ChevronRight, AlertTriangle, XCircle, Clock, MapPin,
    Trash2, ExternalLink, RefreshCw, Sparkles, Brain, BarChart3, TrendingUp
} from 'lucide-react';
import axios from 'axios';
import toast from 'react-hot-toast';
import api from '../../services/api';

const API = import.meta.env.VITE_API_BASE_URL;

const SkillTreeGenerator = () => {
    const navigate = useNavigate();
    const fileInputRef = useRef(null);
    const [mode, setMode] = useState(null);
    const [courses, setCourses] = useState([]);
    const [selectedCourse, setSelectedCourse] = useState('');
    const [csvFile, setCsvFile] = useState(null);
    const [uploading, setUploading] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [uploadResult, setUploadResult] = useState(null);
    const [coursesLoading, setCoursesLoading] = useState(true);
    const [coursesError, setCoursesError] = useState(false);
    const [myTrees, setMyTrees] = useState([]);
    const [myCurricula, setMyCurricula] = useState([]);
    const [treesLoading, setTreesLoading] = useState(true);
    const [progress, setProgress] = useState(null);
    const [dragOver, setDragOver] = useState(false);
    const [assessing, setAssessing] = useState(null);
    const [assessmentQ, setAssessmentQ] = useState([]);
    const [assessmentIdx, setAssessmentIdx] = useState(0);
    const [assessmentAnswers, setAssessmentAnswers] = useState([]);
    const [assessmentResult, setAssessmentResult] = useState(null);
    const [evaluating, setEvaluating] = useState(false);

    useEffect(() => {
        fetchCourses();
        fetchMyTrees();
    }, []);

    const fetchCourses = async () => {
        setCoursesLoading(true);
        setCoursesError(false);
        try {
            const data = await api.getSubjects();
            setCourses(data?.subjects || []);
            if (!data?.subjects || data.subjects.length === 0) {
                setCoursesError(true);
            }
        } catch (err) {
            console.error('[SkillTreeGenerator] Error fetching subjects:', err);
            setCoursesError(true);
        } finally {
            setCoursesLoading(false);
        }
    };

    const fetchMyTrees = async () => {
        setTreesLoading(true);
        try {
            const token = localStorage.getItem('authToken');
            const res = await axios.get(`${API}/skill-tree/existing`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            setMyTrees(res.data.skillTrees || []);
            setMyCurricula(res.data.curricula || []);
        } catch (err) {
            console.error('[SkillTreeGenerator] Error fetching existing trees:', err);
        } finally {
            setTreesLoading(false);
        }
    };

    const handleFileSelect = (file) => {
        if (!file) return;
        if (!file.name.toLowerCase().endsWith('.csv')) {
            toast.error('Only .csv files are accepted');
            return;
        }
        if (file.size > 10 * 1024 * 1024) {
            toast.error('File exceeds 10MB maximum size');
            return;
        }
        setCsvFile(file);
        setUploadResult(null);
    };

    const handleUpload = async () => {
        if (!csvFile) return;
        setUploading(true);
        setProgress({ step: 'uploading' });
        try {
            const token = localStorage.getItem('authToken');
            const formData = new FormData();
            formData.append('file', csvFile);
            const res = await axios.post(`${API}/skill-tree/upload`, formData, {
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'multipart/form-data' }
            });
            setUploadResult(res.data);
            if (res.data.existing) {
                toast('Curriculum already uploaded — you can generate from it', {
                    icon: '📂',
                    style: { background: '#18181b', color: '#fff', border: '1px solid #3f3f46' }
                });
            } else {
                toast.success('Curriculum parsed successfully!');
            }
        } catch (err) {
            const msg = err.response?.data?.message || 'Upload failed. Please check your file.';
            toast.error(msg);
        } finally {
            setUploading(false);
            setProgress(null);
        }
    };

    const handleGenerate = async () => {
        setGenerating(true);
        setProgress({ step: 'generating' });
        try {
            const token = localStorage.getItem('authToken');

            if (mode === 'course') {
                if (!selectedCourse) {
                    toast.error('Please select a course');
                    setGenerating(false);
                    setProgress(null);
                    return;
                }
                setProgress({ step: 'fetching' });
                const structure = await api.getCourseStructure(selectedCourse);
                if (!structure?.modules || structure.modules.length === 0) {
                    toast.error('This course has no modules available');
                    setGenerating(false);
                    setProgress(null);
                    return;
                }
                setProgress({ step: 'building' });
                const genRes = await axios.post(`${API}/skill-tree/generate`, {
                    source: 'course',
                    courseName: selectedCourse,
                    modules: structure.modules
                }, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (genRes.data.skillTree) {
                    toast.success('Skill tree generated!');
                    await fetchMyTrees();
                    navigate(`/gamification/skill-tree/generate`, { state: { refresh: true } });
                }
            } else if (mode === 'csv') {
                if (!uploadResult?.curriculumId) {
                    await handleUpload();
                }
                setProgress({ step: 'parsing' });
                const token = localStorage.getItem('authToken');
                const genRes = await axios.post(`${API}/skill-tree/generate`, {
                    source: 'csv',
                    curriculumId: uploadResult.curriculumId
                }, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (genRes.data.skillTree) {
                    toast.success('Skill tree generated!');
                    await fetchMyTrees();
                }
            }

            setProgress({ step: 'done' });
            setTimeout(() => setProgress(null), 2000);
        } catch (err) {
            const msg = err.response?.data?.message || 'Generation failed. Please try again.';
            toast.error(msg);
            setProgress({ step: 'error', message: msg });
        } finally {
            setGenerating(false);
        }
    };

    const handleDeleteTree = async (id) => {
        if (!window.confirm('Delete this skill tree? This cannot be undone.')) return;
        try {
            const token = localStorage.getItem('authToken');
            await axios.delete(`${API}/skill-tree/${id}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            toast.success('Skill tree deleted');
            fetchMyTrees();
        } catch (err) {
            toast.error('Failed to delete');
        }
    };

    const handleStartAssessment = async (tree) => {
        setAssessing(tree);
        setAssessmentResult(null);
        setAssessmentQ([]);
        setAssessmentIdx(0);
        setAssessmentAnswers([]);
        try {
            const token = localStorage.getItem('authToken');
            const { data } = await axios.post(`${API}/skill-tree/assessment`,
                { treeId: tree._id },
                { headers: { Authorization: `Bearer ${token}` } }
            );
            setAssessmentQ(data.questions || []);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Failed to generate assessment');
            setAssessing(null);
        }
    };

    const handleAnswerSelect = (index) => {
        const answers = [...assessmentAnswers];
        answers[assessmentIdx] = index;
        setAssessmentAnswers(answers);
    };

    const handleNextQuestion = () => {
        if (assessmentIdx < assessmentQ.length - 1) {
            setAssessmentIdx(i => i + 1);
        }
    };

    const handleSubmitAssessment = async () => {
        if (assessmentAnswers.some(a => a === undefined)) {
            toast.error('Answer all questions first');
            return;
        }
        setEvaluating(true);
        try {
            const token = localStorage.getItem('authToken');
            const { data } = await axios.post(`${API}/skill-tree/evaluate`,
                { treeId: assessing._id, questions: assessmentQ, answers: assessmentAnswers },
                { headers: { Authorization: `Bearer ${token}` } }
            );
            setAssessmentResult(data);
            fetchMyTrees();
            toast.success('Assessment complete!');
        } catch (err) {
            toast.error(err.response?.data?.error || 'Evaluation failed');
        } finally {
            setEvaluating(false);
        }
    };

    const formatDate = (d) => {
        const date = new Date(d);
        const now = new Date();
        const diff = now - date;
        if (diff < 86400000) return 'Today';
        if (diff < 172800000) return 'Yesterday';
        if (diff < 604800000) return `${Math.floor(diff / 86400000)} days ago`;
        return date.toLocaleDateString();
    };

    const progressMessages = {
        uploading: 'Uploading...',
        fetching: 'Fetching Course Content...',
        parsing: 'Parsing Curriculum...',
        building: 'Generating Knowledge Graph...',
        dependencies: 'Creating Dependencies...',
        constructing: 'Building Skill Tree...',
        done: 'Done!',
        error: 'Generation Failed'
    };

    return (
        <div className="min-h-screen bg-black p-6 font-sans">
            <div className="max-w-5xl mx-auto pb-20">
                <button
                    onClick={() => navigate('/gamification/skill-tree')}
                    className="flex items-center gap-2 text-zinc-500 hover:text-white transition-colors mb-6 hover:-translate-x-1"
                >
                    <ArrowLeft className="w-5 h-5" />
                    <span>Back to Games</span>
                </button>

                <div className="text-center mb-10">
                    <div className="w-20 h-20 bg-white rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-[0_0_30px_rgba(255,255,255,0.15)]">
                        <Sparkles className="w-10 h-10 text-black" />
                    </div>
                    <h1 className="text-4xl font-bold text-white mb-2 tracking-tight">
                        Skill Tree <span className="text-zinc-400">Generator</span>
                    </h1>
                    <p className="text-zinc-500 max-w-xl mx-auto">
                        Generate a personalized skill tree from an existing course or your own curriculum.
                    </p>
                </div>

                {progress && (
                    <div className="max-w-md mx-auto mb-8 bg-zinc-900 rounded-xl p-5 border border-zinc-800">
                        <div className="flex items-center gap-3">
                            {progress.step === 'error' ? (
                                <XCircle className="w-6 h-6 text-red-400" />
                            ) : progress.step === 'done' ? (
                                <CheckCircle2 className="w-6 h-6 text-green-400" />
                            ) : (
                                <Loader2 className="w-6 h-6 text-white animate-spin" />
                            )}
                            <span className={`text-lg font-medium ${progress.step === 'error' ? 'text-red-400' : 'text-white'}`}>
                                {progressMessages[progress.step] || 'Processing...'}
                            </span>
                        </div>
                        {progress.step !== 'error' && progress.step !== 'done' && (
                            <div className="mt-3 h-1 bg-zinc-800 rounded-full overflow-hidden">
                                <div className="h-full bg-white rounded-full animate-pulse" style={{ width: '60%' }} />
                            </div>
                        )}
                        {progress.step === 'error' && progress.message && (
                            <p className="mt-2 text-sm text-zinc-500">{progress.message}</p>
                        )}
                    </div>
                )}

                {!mode && !generating && (
                    <>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">
                            <button
                                onClick={() => setMode('course')}
                                className="group bg-zinc-900 hover:bg-zinc-800 rounded-2xl p-8 border border-zinc-800 hover:border-zinc-600 transition-all text-left"
                            >
                                <div className="w-14 h-14 bg-white rounded-xl flex items-center justify-center mb-5 group-hover:scale-110 transition-transform">
                                    <BookOpen className="w-7 h-7 text-black" />
                                </div>
                                <h3 className="text-xl font-bold text-white mb-2">Use Existing Course</h3>
                                <p className="text-zinc-500 text-sm leading-relaxed">
                                    Browse AI-curated courses from the library. We'll build a skill tree from the curriculum structure.
                                </p>
                            </button>

                            <button
                                onClick={() => setMode('csv')}
                                className="group bg-zinc-900 hover:bg-zinc-800 rounded-2xl p-8 border border-zinc-800 hover:border-zinc-600 transition-all text-left"
                            >
                                <div className="w-14 h-14 bg-zinc-800 rounded-xl flex items-center justify-center mb-5 group-hover:scale-110 transition-transform border border-zinc-700">
                                    <FileText className="w-7 h-7 text-white" />
                                </div>
                                <h3 className="text-xl font-bold text-white mb-2">Upload Curriculum</h3>
                                <p className="text-zinc-500 text-sm leading-relaxed">
                                    Upload your own syllabus CSV with Module, Topic, and Subtopic columns. Max 10MB.
                                </p>
                            </button>
                        </div>

                        <div className="text-center mb-8">
                            <p className="text-zinc-600 text-sm">
                                How would you like to generate your learning path?
                            </p>
                            <div className="flex items-center justify-center gap-2 mt-2 text-zinc-500 text-xs">
                                <span className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-green-500" /> Choose a course</span>
                                <span className="text-zinc-700">or</span>
                                <span className="flex items-center gap-1"><Upload className="w-3 h-3 text-blue-500" /> Upload your own CSV</span>
                            </div>
                            <p className="text-zinc-700 text-xs mt-1">We'll automatically build a personalized Skill Tree.</p>
                        </div>
                    </>
                )}

                {mode === 'course' && !generating && (
                    <div className="max-w-xl mx-auto mb-12">
                        <div className="bg-zinc-900 rounded-2xl p-8 border border-zinc-800">
                            <div className="flex items-center gap-3 mb-6">
                                <div className="w-12 h-12 bg-zinc-800 rounded-xl flex items-center justify-center">
                                    <BookOpen className="w-6 h-6 text-white" />
                                </div>
                                <div>
                                    <h3 className="text-xl font-bold text-white">Choose a Course</h3>
                                    <p className="text-sm text-zinc-500">Select from available courses in the library</p>
                                </div>
                            </div>

                            {coursesLoading ? (
                                <div className="flex items-center gap-2 text-zinc-500 py-4">
                                    <Loader2 className="w-5 h-5 animate-spin" />
                                    Loading courses...
                                </div>
                            ) : coursesError ? (
                                <div className="bg-red-900/20 border border-red-800/30 rounded-xl p-4 mb-4">
                                    <div className="flex items-start gap-3">
                                        <AlertTriangle className="w-5 h-5 text-red-400 mt-0.5 shrink-0" />
                                        <div>
                                            <p className="text-white font-medium">Unable to load courses.</p>
                                            <p className="text-zinc-400 text-sm mt-1">
                                                Upload a curriculum CSV instead.
                                            </p>
                                            <button
                                                onClick={() => setMode('csv')}
                                                className="mt-2 text-sm text-blue-400 hover:text-blue-300 underline"
                                            >
                                                Switch to CSV upload
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <select
                                    value={selectedCourse}
                                    onChange={(e) => setSelectedCourse(e.target.value)}
                                    className="w-full px-5 py-4 bg-black border border-zinc-800 rounded-xl text-white focus:outline-none focus:border-white text-lg mb-6"
                                >
                                    <option value="" disabled>Select a course...</option>
                                    {courses.map(c => (
                                        <option key={c} value={c}>{c}</option>
                                    ))}
                                </select>
                            )}

                            <div className="flex gap-4">
                                <button
                                    onClick={() => setMode(null)}
                                    className="flex-1 px-6 py-3 bg-zinc-800 hover:bg-zinc-700 rounded-xl font-bold text-zinc-300 transition-colors"
                                >
                                    Back
                                </button>
                                <button
                                    onClick={handleGenerate}
                                    disabled={!selectedCourse || generating}
                                    className={`flex-1 px-6 py-3 rounded-xl font-bold transition-all ${selectedCourse
                                        ? 'bg-white text-black hover:bg-zinc-200'
                                        : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
                                    }`}
                                >
                                    {generating ? (
                                        <span className="flex items-center justify-center gap-2">
                                            <Loader2 className="w-5 h-5 animate-spin" />
                                            Generating...
                                        </span>
                                    ) : 'Generate Skill Tree'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {mode === 'csv' && !generating && (
                    <div className="max-w-xl mx-auto mb-12">
                        <div className="bg-zinc-900 rounded-2xl p-8 border border-zinc-800">
                            <div className="flex items-center gap-3 mb-6">
                                <div className="w-12 h-12 bg-zinc-800 rounded-xl flex items-center justify-center">
                                    <Upload className="w-6 h-6 text-white" />
                                </div>
                                <div>
                                    <h3 className="text-xl font-bold text-white">Upload Curriculum CSV</h3>
                                    <p className="text-sm text-zinc-500">Your CSV must include: Module, Topic, Subtopic</p>
                                </div>
                            </div>

                            <div
                                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                                onDragLeave={() => setDragOver(false)}
                                onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFileSelect(e.dataTransfer.files[0]); }}
                                onClick={() => fileInputRef.current?.click()}
                                className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all mb-6 ${dragOver
                                    ? 'border-white bg-white/5'
                                    : csvFile
                                        ? 'border-green-500/50 bg-green-500/5'
                                        : 'border-zinc-700 hover:border-zinc-500 bg-black'
                                }`}
                            >
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept=".csv"
                                    className="hidden"
                                    onChange={(e) => handleFileSelect(e.target.files[0])}
                                />
                                {csvFile ? (
                                    <div className="flex items-center justify-center gap-3">
                                        <CheckCircle2 className="w-8 h-8 text-green-400" />
                                        <div className="text-left">
                                            <p className="text-white font-medium">{csvFile.name}</p>
                                            <p className="text-zinc-500 text-sm">{(csvFile.size / 1024).toFixed(1)} KB</p>
                                        </div>
                                    </div>
                                ) : (
                                    <>
                                        <Upload className="w-10 h-10 text-zinc-600 mx-auto mb-3" />
                                        <p className="text-zinc-400 font-medium">Drop your CSV here or click to browse</p>
                                        <p className="text-zinc-700 text-sm mt-1">Accepted: .csv &middot; Max 10MB</p>
                                    </>
                                )}
                            </div>

                            {uploadResult && (
                                <div className="bg-green-900/20 border border-green-800/30 rounded-xl p-4 mb-6">
                                    <div className="flex items-center gap-2 text-green-400 font-medium mb-1">
                                        <CheckCircle2 className="w-5 h-5" />
                                        {uploadResult.existing ? 'Curriculum already uploaded' : 'Curriculum uploaded'}
                                    </div>
                                    <p className="text-zinc-400 text-sm">
                                        {uploadResult.moduleCount} modules, {uploadResult.topicCount} topics
                                        {uploadResult.rowCount ? `, ${uploadResult.rowCount} subtopics` : ''}
                                    </p>
                                </div>
                            )}

                            <div className="flex gap-4">
                                <button
                                    onClick={() => { setMode(null); setCsvFile(null); setUploadResult(null); }}
                                    className="flex-1 px-6 py-3 bg-zinc-800 hover:bg-zinc-700 rounded-xl font-bold text-zinc-300 transition-colors"
                                >
                                    Back
                                </button>
                                <button
                                    onClick={uploadResult ? handleGenerate : handleUpload}
                                    disabled={!csvFile || uploading || generating}
                                    className={`flex-1 px-6 py-3 rounded-xl font-bold transition-all ${csvFile && !uploading && !generating
                                        ? 'bg-white text-black hover:bg-zinc-200'
                                        : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
                                    }`}
                                >
                                    {uploading ? (
                                        <span className="flex items-center justify-center gap-2">
                                            <Loader2 className="w-5 h-5 animate-spin" />
                                            Uploading...
                                        </span>
                                    ) : generating ? (
                                        <span className="flex items-center justify-center gap-2">
                                            <Loader2 className="w-5 h-5 animate-spin" />
                                            Generating...
                                        </span>
                                    ) : uploadResult ? 'Generate Skill Tree' : 'Upload'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                <div className="mb-8">
                    <h2 className="text-2xl font-bold text-white mb-6 flex items-center gap-2">
                        <MapPin className="w-6 h-6" />
                        My Skill Trees
                    </h2>

                    {treesLoading ? (
                        <div className="flex items-center gap-2 text-zinc-500 py-4">
                            <Loader2 className="w-5 h-5 animate-spin" />
                            Loading...
                        </div>
                    ) : myTrees.length === 0 && myCurricula.length === 0 ? (
                        <div className="bg-zinc-900/50 rounded-xl p-8 text-center border border-zinc-800">
                            <MapPin className="w-12 h-12 text-zinc-700 mx-auto mb-3" />
                            <p className="text-zinc-500 font-medium">No skill trees yet</p>
                            <p className="text-zinc-700 text-sm mt-1">
                                Generate your first skill tree from a course or upload a curriculum CSV.
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {myTrees.map(tree => (
                                <div key={tree._id} className="bg-zinc-900 rounded-xl p-5 border border-zinc-800 hover:border-zinc-700 transition-all flex items-center justify-between">
                                    <div className="flex items-center gap-4">
                                        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${tree.source === 'course' ? 'bg-white' : 'bg-zinc-800 border border-zinc-700'}`}>
                                            {tree.source === 'course' ? (
                                                <BookOpen className="w-5 h-5 text-black" />
                                            ) : (
                                                <FileText className="w-5 h-5 text-white" />
                                            )}
                                        </div>
                                        <div>
                                            <p className="text-white font-medium">{tree.title}</p>
                                            <p className="text-zinc-500 text-xs flex items-center gap-2">
                                                <span className={`px-2 py-0.5 rounded-full text-xs ${tree.source === 'course' ? 'bg-white/10 text-white' : 'bg-zinc-800 text-zinc-400'}`}>
                                                    {tree.source === 'course' ? 'Library' : 'CSV'}
                                                </span>
                                                {tree.assessmentResult?.level && (
                                                    <span className={`px-2 py-0.5 rounded-full text-xs ${
                                                        tree.assessmentResult.level === 'Expert' ? 'bg-purple-900/50 text-purple-300' :
                                                        tree.assessmentResult.level === 'Advanced' ? 'bg-blue-900/50 text-blue-300' :
                                                        tree.assessmentResult.level === 'Intermediate' ? 'bg-yellow-900/50 text-yellow-300' :
                                                        'bg-green-900/50 text-green-300'
                                                    }`}>
                                                        {tree.assessmentResult.level}
                                                    </span>
                                                )}
                                                {tree.totalStarsEarned > 0 && (
                                                    <span className="text-yellow-500 text-xs">{tree.totalStarsEarned} ★</span>
                                                )}
                                                <Clock className="w-3 h-3" />
                                                {formatDate(tree.createdAt)}
                                                <span className="text-zinc-700">{tree.nodeCount} nodes</span>
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {tree.status === 'ready' && (
                                            <button
                                                onClick={() => handleStartAssessment(tree)}
                                                className="text-sm bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5"
                                                title="Start assessment to unlock skill tree"
                                            >
                                                <Brain className="w-4 h-4" />
                                                Assess
                                            </button>
                                        )}
                                        {tree.status === 'active' && (
                                            <>
                                                <button
                                                    onClick={() => navigate(`/gamification/skill-tree/classic?treeId=${tree._id}`)}
                                                    className="text-sm bg-green-600 hover:bg-green-500 text-white px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5"
                                                    title="View skill tree map"
                                                >
                                                    <MapPin className="w-4 h-4" />
                                                    Map
                                                </button>
                                                <button
                                                    onClick={() => navigate(`/gamification/skill-tree/analytics/${tree._id}`)}
                                                    className="text-sm bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5"
                                                    title="View learning analytics"
                                                >
                                                    <BarChart3 className="w-4 h-4" />
                                                    Analytics
                                                </button>
                                                {tree.gameId && (
                                                    <button
                                                        onClick={() => navigate(`/gamification/skill-tree-game/${tree.gameId}`)}
                                                        className="text-sm bg-zinc-700 hover:bg-zinc-600 text-zinc-200 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5"
                                                    >
                                                        <TrendingUp className="w-4 h-4" />
                                                        Play
                                                    </button>
                                                )}
                                            </>
                                        )}
                                        <button
                                            onClick={() => handleDeleteTree(tree._id)}
                                            className="p-2 hover:bg-red-900/30 rounded-lg transition-colors text-zinc-500 hover:text-red-400"
                                            title="Delete"
                                        >
                                            <Trash2 className="w-5 h-5" />
                                        </button>
                                    </div>
                                </div>
                            ))}

                            {myCurricula.filter(c =>
                                !myTrees.some(t => String(t.curriculumId) === String(c._id))
                            ).map(c => (
                                <div key={c._id} className="bg-zinc-900/50 rounded-xl p-5 border border-zinc-800/50 flex items-center justify-between opacity-70">
                                    <div className="flex items-center gap-4">
                                        <div className="w-10 h-10 bg-zinc-800 rounded-lg flex items-center justify-center border border-zinc-700">
                                            <FileText className="w-5 h-5 text-zinc-400" />
                                        </div>
                                        <div>
                                            <p className="text-zinc-400 font-medium">{c.courseTitle}</p>
                                            <p className="text-zinc-600 text-xs">
                                                {c.moduleCount} modules, {c.topicCount} topics &middot; Uploaded {formatDate(c.createdAt)}
                                            </p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => { setMode('csv'); setUploadResult({ curriculumId: c._id, moduleCount: c.moduleCount, topicCount: c.topicCount, existing: true }); }}
                                        className="text-sm text-blue-400 hover:text-blue-300 px-3 py-1.5 rounded-lg hover:bg-blue-900/20 transition-colors"
                                    >
                                        Generate
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Assessment Dialog */}
                {assessmentQ.length > 0 && (
                    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
                        <div className="bg-zinc-900 rounded-2xl border border-zinc-800 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
                            <div className="p-6 border-b border-zinc-800">
                                <div className="flex items-center justify-between mb-1">
                                    <h3 className="text-xl font-bold text-white flex items-center gap-2">
                                        <Brain className="w-5 h-5 text-blue-400" />
                                        Knowledge Assessment
                                    </h3>
                                    <span className="text-zinc-500 text-sm">
                                        {assessmentIdx + 1} / {assessmentQ.length}
                                    </span>
                                </div>
                                <div className="w-full bg-zinc-800 rounded-full h-1.5 mt-3">
                                    <div
                                        className="bg-blue-500 h-1.5 rounded-full transition-all"
                                        style={{ width: `${((assessmentIdx + 1) / assessmentQ.length) * 100}%` }}
                                    />
                                </div>
                            </div>

                            {assessmentResult ? (
                                <div className="p-6">
                                    <div className="text-center mb-6">
                                        <div className={`w-16 h-16 mx-auto mb-3 rounded-full flex items-center justify-center text-2xl font-bold
                                            ${assessmentResult.level === 'Expert' ? 'bg-purple-900/50 text-purple-300' :
                                              assessmentResult.level === 'Advanced' ? 'bg-blue-900/50 text-blue-300' :
                                              assessmentResult.level === 'Intermediate' ? 'bg-yellow-900/50 text-yellow-300' :
                                              'bg-green-900/50 text-green-300'}`}>
                                            {Math.round(assessmentResult.weightedScore)}%
                                        </div>
                                        <h4 className="text-xl font-bold text-white">{assessmentResult.level}</h4>
                                        <p className="text-zinc-400 text-sm mt-1">
                                            Weighted Score: {assessmentResult.weightedScore.toFixed(1)}%
                                        </p>
                                    </div>

                                    <div className="grid grid-cols-2 gap-3 mb-6">
                                        {Object.entries(assessmentResult.scores || {}).map(([key, val]) => (
                                            <div key={key} className="bg-zinc-800/50 rounded-lg p-3">
                                                <p className="text-zinc-500 text-xs uppercase">{key}</p>
                                                <p className="text-white font-bold text-lg">{typeof val === 'number' ? `${Math.round(val)}%` : val}</p>
                                            </div>
                                        ))}
                                    </div>

                                    {assessmentResult.agentFeedback && (
                                        <div className="bg-zinc-800/30 rounded-xl p-4 mb-6 border border-zinc-800">
                                            <p className="text-zinc-300 text-sm whitespace-pre-wrap">{assessmentResult.agentFeedback}</p>
                                        </div>
                                    )}

                                    <p className="text-zinc-500 text-sm text-center mb-4">
                                        {assessmentResult.nodesUnlocked} skill nodes unlocked
                                    </p>

                                    <div className="flex gap-3">
                                        <button
                                            onClick={() => { setAssessmentQ([]); setAssessmentResult(null); }}
                                            className="flex-1 px-6 py-3 bg-zinc-800 hover:bg-zinc-700 rounded-xl font-bold text-zinc-300 transition-colors"
                                        >
                                            Close
                                        </button>
                                        <button
                                            onClick={() => navigate(`/gamification/skill-tree/classic`, { state: { treeId: assessing?._id } })}
                                            className="flex-1 px-6 py-3 bg-white hover:bg-zinc-200 text-black rounded-xl font-bold transition-colors"
                                        >
                                            View Skill Tree
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <div className="p-6">
                                    <div className="mb-6">
                                        <p className="text-lg font-medium text-white mb-2">
                                            {assessmentQ[assessmentIdx]?.question}
                                        </p>
                                        <p className="text-zinc-500 text-sm mb-4">
                                            {assessmentQ[assessmentIdx]?.type === 'multiple_choice' ? 'Select the best answer' : 'Type your answer'}
                                        </p>
                                        <div className="space-y-2">
                                            {assessmentQ[assessmentIdx]?.options?.map((opt, oi) => (
                                                <button
                                                    key={oi}
                                                    onClick={() => handleAnswerSelect(oi)}
                                                    className={`w-full text-left px-4 py-3 rounded-xl border transition-all ${
                                                        assessmentAnswers[assessmentIdx] === oi
                                                            ? 'border-blue-500 bg-blue-900/20 text-white'
                                                            : 'border-zinc-800 bg-black text-zinc-400 hover:border-zinc-700'
                                                    }`}
                                                >
                                                    {opt}
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    <div className="flex gap-3">
                                        <button
                                            onClick={() => { setAssessmentQ([]); setAssessmentIdx(0); setAssessmentAnswers([]); setAssessing(null); }}
                                            className="px-6 py-3 bg-zinc-800 hover:bg-zinc-700 rounded-xl font-bold text-zinc-300 transition-colors"
                                        >
                                            Cancel
                                        </button>
                                        {assessmentIdx < assessmentQ.length - 1 ? (
                                            <button
                                                onClick={handleNextQuestion}
                                                disabled={assessmentAnswers[assessmentIdx] === undefined}
                                                className={`flex-1 px-6 py-3 rounded-xl font-bold transition-all ${
                                                    assessmentAnswers[assessmentIdx] !== undefined
                                                        ? 'bg-white text-black hover:bg-zinc-200'
                                                        : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
                                                }`}
                                            >
                                                Next
                                            </button>
                                        ) : (
                                            <button
                                                onClick={handleSubmitAssessment}
                                                disabled={assessmentAnswers.some(a => a === undefined) || evaluating}
                                                className={`flex-1 px-6 py-3 rounded-xl font-bold transition-all ${
                                                    !assessmentAnswers.some(a => a === undefined) && !evaluating
                                                        ? 'bg-blue-600 text-white hover:bg-blue-500'
                                                        : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
                                                }`}
                                            >
                                                {evaluating ? (
                                                    <span className="flex items-center justify-center gap-2">
                                                        <Loader2 className="w-5 h-5 animate-spin" />
                                                        Evaluating...
                                                    </span>
                                                ) : 'Submit'}
                                            </button>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {!mode && !assessmentQ.length && (
                    <div className="text-center">
                        <button
                            onClick={fetchMyTrees}
                            className="px-4 py-2 bg-zinc-900 hover:bg-zinc-800 rounded-xl text-zinc-400 text-sm transition-colors"
                        >
                            <RefreshCw className="w-4 h-4 inline mr-1" />
                            Refresh
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

export default SkillTreeGenerator;