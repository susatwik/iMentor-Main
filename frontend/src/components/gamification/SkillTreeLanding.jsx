import React, { useState } from 'react';
import Animate from '../core/Animate.jsx';
import { useNavigate, useLocation } from 'react-router-dom';
import {
    Gamepad2, MapPin, Star,
    ChevronRight, Sparkles, BookOpen, ArrowLeft,
    Brain, Loader2, CheckCircle2, MessageCircle,
    Lock, Coins, AlertTriangle
} from 'lucide-react';
import axios from 'axios';
import toast from 'react-hot-toast';
import api from '../../services/api';

const SkillTreeLanding = () => {
    const navigate = useNavigate();
    const location = useLocation();
    const hasGames = location.state?.hasGames ?? false;
    const [isHovering, setIsHovering] = useState(false);
    const [step, setStep] = useState('start'); // 'start', 'topic', 'replay', 'assessment', 'complete'
    const [topic, setTopic] = useState('');
    const [questions, setQuestions] = useState([]);
    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
    const [answers, setAnswers] = useState([]);
    const [currentAnswer, setCurrentAnswer] = useState('');
    const [loading, setLoading] = useState(false);
    const [assessmentResult, setAssessmentResult] = useState(null);
    const [replayInfo, setReplayInfo] = useState(null); // { totalCredits, replayCost, completedLevels }
    const [isOther, setIsOther] = useState(false);
    const [courses, setCourses] = useState([]);

    React.useEffect(() => {
        const fetchCourses = async () => {
            try {
                const data = await api.getSubjects();
                setCourses(data?.subjects || []);
            } catch (err) {
                console.error('[SkillTreeLanding] Error fetching subjects:', err);
            }
        };
        fetchCourses();
    }, []);

    const handleStartGame = () => {
        setStep('topic');
    };

    const handleNext = async () => {
        if (!topic.trim()) return;
        setLoading(true);
        try {
            const token = localStorage.getItem('authToken');

            // First check if topic is active or was previously played
            const checkRes = await axios.post(
                `${import.meta.env.VITE_API_BASE_URL}/gamification/skill-tree/check-topic`,
                { topic: topic.trim() },
                { headers: { Authorization: `Bearer ${token}` } }
            );

            const { status } = checkRes.data;

            if (status === 'active') {
                toast('This game is already present', {
                    icon: '⚠️',
                    style: { background: '#18181b', color: '#fff', border: '1px solid #3f3f46', fontWeight: '500' }
                });
                setLoading(false);
                return;
            }

            if (status === 'replay') {
                setReplayInfo({
                    totalCredits: checkRes.data.totalCredits,
                    replayCost: checkRes.data.replayCost,
                    completedLevels: checkRes.data.completedLevels
                });
                setStep('replay');
                setLoading(false);
                return;
            }

            // Topic is fresh — proceed to generate diagnostic questions
            await generateDiagnosticQuestions();
        } catch (error) {
            console.error('[SkillTreeLanding] Error checking topic:', error);
            const errorMessage = error.response?.data?.message || 'Unable to check topic. Please try again.';
            toast(errorMessage, {
                icon: '⚠️',
                style: { background: '#18181b', color: '#fff', border: '1px solid #3f3f46', fontWeight: '500' }
            });
            setLoading(false);
        }
    };

    const generateDiagnosticQuestions = async () => {
        setLoading(true);
        try {
            const token = localStorage.getItem('authToken');
            const response = await axios.post(
                `${import.meta.env.VITE_API_BASE_URL}/gamification/skill-tree/diagnostic`,
                { topic: topic.trim() },
                { headers: { Authorization: `Bearer ${token}` } }
            );
            const q = response.data.questions || [];
            if (q.length > 0) {
                setQuestions(q);
                setStep('assessment');
            } else {
                toast('AI service returned no questions. Please try again.', {
                    icon: '⚠️',
                    style: { background: '#18181b', color: '#fff', border: '1px solid #3f3f46', fontWeight: '500' }
                });
            }
        } catch (error) {
            console.error('[SkillTreeLanding] Error generating questions:', error);
            const errorMessage = error.response?.data?.message || 'Unable to connect to AI service. Please try again later.';
            toast(errorMessage, {
                icon: '⚠️',
                style: { background: '#18181b', color: '#fff', border: '1px solid #3f3f46', fontWeight: '500' }
            });
        } finally {
            setLoading(false);
        }
    };

    const handleReplayWithCredits = async () => {
        if (!replayInfo) return;
        setLoading(true);
        try {
            const token = localStorage.getItem('authToken');
            const res = await axios.post(
                `${import.meta.env.VITE_API_BASE_URL}/gamification/skill-tree/spend-credits`,
                { topic: topic.trim(), amount: replayInfo.replayCost },
                { headers: { Authorization: `Bearer ${token}` } }
            );
            if (res.data.success) {
                toast(`${replayInfo.replayCost} credits spent! Resuming your game...`, {
                    icon: '✅',
                    style: { background: '#18181b', color: '#fff', border: '1px solid #3f3f46', fontWeight: '500' }
                });
                // Game was restored on the backend — navigate directly to the games list
                navigate('/gamification/skill-tree', {
                    state: { resumedGameId: res.data.restoredGameId }
                });
            }
        } catch (error) {
            console.error('[SkillTreeLanding] Error spending credits:', error);
            const errorMessage = error.response?.data?.message || 'Failed to spend credits. Please try again.';
            toast(errorMessage, {
                icon: '⚠️',
                style: { background: '#18181b', color: '#fff', border: '1px solid #3f3f46', fontWeight: '500' }
            });
        } finally {
            setLoading(false);
        }
    };

    const handleAnswerSubmit = (selectedAnswer) => {
        const answerToSubmit = selectedAnswer || currentAnswer;
        if (!answerToSubmit || (typeof answerToSubmit === 'string' && !answerToSubmit.trim())) return;

        const currentQ = questions[currentQuestionIndex];
        const newAnswers = [...answers, {
            question: currentQ.question,
            answer: typeof answerToSubmit === 'string' ? answerToSubmit.trim() : answerToSubmit,
            skillId: currentQ.skillId || null, // null for LLM-generated (custom topic) questions
            correctAnswer: currentQ.correctAnswer || null, // For custom topic grading on backend
            explanation: currentQ.explanation || ''
        }];
        setAnswers(newAnswers);
        setCurrentAnswer('');

        if (currentQuestionIndex < questions.length - 1) {
            setCurrentQuestionIndex(currentQuestionIndex + 1);
        } else {
            // All questions answered - submit assessment
            submitAssessment(newAnswers);
        }
    };

    const submitAssessment = async (finalAnswers) => {
        setLoading(true);
        try {
            const token = localStorage.getItem('authToken');
            const response = await axios.post(
                `${import.meta.env.VITE_API_BASE_URL}/gamification/skill-tree/diagnostic/submit`,
                {
                    topic: topic.trim(),
                    answers: finalAnswers
                },
                { headers: { Authorization: `Bearer ${token}` } }
            );
            setAssessmentResult(response.data);
            setStep('complete');
        } catch (error) {
            console.error('[SkillTreeLanding] Error submitting assessment:', error);
            const errorMessage = error.response?.data?.message || 'Failed to analyze responses. Please try again.';
            toast(errorMessage, {
                icon: '⚠️',
                style: {
                    background: '#18181b',
                    color: '#fff',
                    border: '1px solid #3f3f46',
                    fontWeight: '500'
                }
            });
            // Stay on assessment screen - don't proceed
        } finally {
            setLoading(false);
        }
    };

    const handleProceedToMap = () => {
        // Navigate to games page with new game data
        navigate('/gamification/skill-tree', {
            state: {
                newGame: {
                    topic: topic.trim(),
                    assessmentResult,
                    answers
                }
            }
        });
    };

    const handleBack = () => {
        if (step === 'topic') {
            setStep('start');
            setTopic('');
        } else if (step === 'replay') {
            setStep('topic');
            setReplayInfo(null);
        } else if (step === 'assessment') {
            setStep('topic');
            setQuestions([]);
            setCurrentQuestionIndex(0);
            setAnswers([]);
            setCurrentAnswer('');
        }
    };

    return (
        <div className="min-h-screen max-h-screen overflow-y-auto bg-black p-6 font-sans">
            <div className="max-w-4xl mx-auto pb-20">
                {/* Back Button */}
                <button
                    onClick={() => navigate(hasGames ? '/gamification/skill-tree' : '/')}
                    className="flex items-center gap-2 text-zinc-500 hover:text-white transition-colors mb-6 hover:-translate-x-1"
                >
                    <ArrowLeft className="w-5 h-5" />
                    <span>Back</span>
                </button>

                {/* Hero Section */}
                <Animate
                    animation="slide-up"
                    className="text-center mb-12"
                >
                    {/* Icon */}
                    <div className="w-24 h-24 bg-white rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-[0_0_30px_rgba(255,255,255,0.15)]">
                        <MapPin className="w-12 h-12 text-black" />
                    </div>

                    <h1 className="text-4xl md:text-5xl font-bold text-white mb-4 tracking-tight">
                        Skill Tree <span className="text-zinc-400">Adventure</span>
                    </h1>
                    <p className="text-lg text-zinc-500 max-w-2xl mx-auto font-light">
                        Embark on your learning journey! Explore the fog of war, unlock new skills,
                        and master topics to reveal the complete knowledge map.
                    </p>
                </Animate>

                <div>
                    {step === 'start' && (
                        /* Start Game Button */
                        <Animate
                            key="start-button"
                            animation="scale-in"
                            delay={400}
                            className="flex justify-center mb-12"
                        >
                            <button
                                onClick={handleStartGame}
                                onMouseEnter={() => setIsHovering(true)}
                                onMouseLeave={() => setIsHovering(false)}
                                className="relative group px-12 py-5 bg-white rounded-xl font-bold text-xl text-black shadow-lg shadow-white/10 overflow-hidden tracking-wide transition-all hover:bg-zinc-200 hover:scale-105 active:scale-[0.98]"
                            >
                                <span className="relative flex items-center gap-3">
                                    <Gamepad2 className="w-7 h-7" />
                                    Start the Game
                                    <span className="animate-bounce">
                                        <ChevronRight className="w-6 h-6" />
                                    </span>
                                </span>
                            </button>
                        </Animate>
                    )}

                    {step === 'topic' && (
                        /* Topic Input Section */
                        <Animate
                            key="topic-input"
                            animation="slide-up"
                            className="max-w-xl mx-auto mb-12"
                        >
                            <div className="bg-zinc-900 rounded-2xl p-8 border border-zinc-800 shadow-xl shadow-black/50">
                                <div className="flex items-center gap-3 mb-6">
                                    <div className="w-12 h-12 bg-zinc-800 rounded-xl flex items-center justify-center border border-zinc-700">
                                        <BookOpen className="w-6 h-6 text-white" />
                                    </div>
                                    <div>
                                        <h3 className="text-xl font-bold text-white">Choose Your Topic</h3>
                                        <p className="text-sm text-zinc-500">Enter a course or topic to explore</p>
                                    </div>
                                </div>

                                <select
                                    value={isOther ? 'other' : (topic || '')}
                                    onChange={(e) => {
                                        if (e.target.value === 'other') {
                                            setIsOther(true);
                                            setTopic('');
                                        } else {
                                            setIsOther(false);
                                            setTopic(e.target.value);
                                        }
                                    }}
                                    className="w-full px-5 py-4 bg-black border border-zinc-800 rounded-xl text-white focus:outline-none focus:border-white focus:ring-1 focus:ring-white/20 transition-all text-lg font-medium mb-4"
                                    disabled={loading}
                                >
                                    <option value="" disabled>Select a course...</option>
                                    {courses.map(c => (
                                        <option key={c} value={c}>{c}</option>
                                    ))}
                                    <option value="other">Other Topic...</option>
                                </select>

                                {isOther && (
                                    <Animate animation="fade-in">
                                        <input
                                            type="text"
                                            value={topic}
                                            onChange={(e) => setTopic(e.target.value)}
                                            onKeyDown={(e) => e.key === 'Enter' && !loading && handleNext()}
                                            className="w-full px-5 py-4 bg-black border border-zinc-800 rounded-xl text-white placeholder-zinc-600 focus:outline-none focus:border-white focus:ring-1 focus:ring-white/20 transition-all text-lg font-medium"
                                            autoFocus
                                            disabled={loading}
                                            placeholder="e.g., Quantum Computing, Art History..."
                                        />
                                    </Animate>
                                )}

                                <div className="flex gap-4 mt-6">
                                    <button
                                        onClick={handleBack}
                                        disabled={loading}
                                        className="flex-1 px-6 py-3 bg-zinc-800 hover:bg-zinc-700 rounded-xl font-bold text-zinc-300 flex items-center justify-center gap-2 transition-colors disabled:opacity-50 hover:scale-[1.02] active:scale-[0.98]"
                                    >
                                        <ArrowLeft className="w-5 h-5" />
                                        Back
                                    </button>
                                    <button
                                        onClick={handleNext}
                                        disabled={!topic.trim() || loading}
                                        className={`flex-1 px-6 py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-all hover:scale-[1.02] active:scale-[0.98] ${topic.trim() && !loading
                                                ? 'bg-white text-black hover:bg-zinc-200'
                                                : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
                                            }`}
                                    >
                                        {loading ? (
                                            <>
                                                <Loader2 className="w-5 h-5 animate-spin" />
                                                Preparing...
                                            </>
                                        ) : (
                                            <>
                                                Next
                                                <ChevronRight className="w-5 h-5" />
                                            </>
                                        )}
                                    </button>
                                </div>
                            </div>
                        </Animate>
                    )}

                    {step === 'replay' && replayInfo && (
                        /* Replay Confirmation Section */
                        <Animate
                            animation="scale-in"
                            className="max-w-xl mx-auto mb-12"
                        >
                            <div className="bg-zinc-900 rounded-2xl p-8 border border-zinc-800 text-center shadow-xl shadow-black/50">
                                <Animate
                                    animation="scale-in"
                                    delay={200}
                                    className="w-20 h-20 bg-amber-500/20 rounded-full flex items-center justify-center mx-auto mb-6 border border-amber-500/30"
                                >
                                    <AlertTriangle className="w-10 h-10 text-amber-400" />
                                </Animate>

                                <h3 className="text-2xl font-bold text-white mb-3">Already Played!</h3>
                                <p className="text-zinc-400 mb-2 max-w-sm mx-auto">
                                    You already played <span className="text-white font-bold">{topic}</span> and completed <span className="text-white font-bold">{replayInfo.completedLevels}</span> levels.
                                </p>
                                <p className="text-zinc-400 mb-8 max-w-sm mx-auto">
                                    If you want to play again, use credits.
                                </p>

                                <div className="bg-black border border-zinc-800 rounded-xl p-4 mb-8">
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm text-zinc-500">Your Credits</span>
                                        <span className="text-lg font-bold text-white flex items-center gap-1">
                                            <Coins className="w-4 h-4 text-amber-400" />
                                            {replayInfo.totalCredits}
                                        </span>
                                    </div>
                                </div>

                                <div className="flex gap-4">
                                    <button
                                        onClick={handleBack}
                                        disabled={loading}
                                        className="flex-1 px-6 py-4 bg-zinc-800 hover:bg-zinc-700 rounded-xl font-bold text-zinc-300 flex items-center justify-center gap-2 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50"
                                    >
                                        <ArrowLeft className="w-5 h-5" />
                                        Back
                                    </button>
                                    <button
                                        onClick={handleReplayWithCredits}
                                        disabled={loading || replayInfo.totalCredits < replayInfo.replayCost}
                                        className={`flex-1 px-6 py-4 rounded-xl font-bold flex items-center justify-center gap-2 transition-all hover:scale-[1.02] active:scale-[0.98] ${
                                            !loading && replayInfo.totalCredits >= replayInfo.replayCost
                                                ? 'bg-amber-500 text-black hover:bg-amber-400'
                                                : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
                                        }`}
                                    >
                                        {loading ? (
                                            <>
                                                <Loader2 className="w-5 h-5 animate-spin" />
                                                Processing...
                                            </>
                                        ) : replayInfo.totalCredits < replayInfo.replayCost ? (
                                            <>
                                                <Lock className="w-5 h-5" />
                                                Not Enough Credits
                                            </>
                                        ) : (
                                            <>
                                                <Coins className="w-5 h-5" />
                                                {replayInfo.replayCost} Credits
                                            </>
                                        )}
                                    </button>
                                </div>
                            </div>
                        </Animate>
                    )}

                    {step === 'assessment' && (
                        /* Socratic Assessment Section */
                        <div
                            key="assessment"
                            className="max-w-2xl mx-auto mb-12"
                           
                           
                           
                           
                        >
                            <div className="bg-zinc-900 rounded-2xl p-8 border border-zinc-800 shadow-xl shadow-black/50">
                                {/* Header */}
                                <div className="flex items-center gap-3 mb-6">
                                    <div className="w-12 h-12 bg-white rounded-xl flex items-center justify-center">
                                        <Brain className="w-6 h-6 text-black" />
                                    </div>
                                    <div>
                                        <h3 className="text-xl font-bold text-white">Knowledge Assessment</h3>
                                        <p className="text-sm text-zinc-500">Let's understand your current knowledge of {topic}</p>
                                    </div>
                                </div>

                                {/* Progress */}
                                <div className="mb-6">
                                    <div className="flex items-center justify-between text-sm text-zinc-500 mb-2 font-mono uppercase tracking-wider">
                                        <span>Question {currentQuestionIndex + 1} of {questions.length}</span>
                                        <span>{Math.round(((currentQuestionIndex) / questions.length) * 100)}%</span>
                                    </div>
                                    <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
                                        <div
                                            className="h-full bg-white"
                                           
                                            style={{ width: `${((currentQuestionIndex) / questions.length) * 100}%` }}
                                           
                                        />
                                    </div>
                                </div>

                                {/* Question */}
                                {questions[currentQuestionIndex] && (
                                    <div
                                        key={currentQuestionIndex}
                                       
                                       
                                        className="mb-8"
                                    >
                                        <div className="flex items-start gap-4 mb-6">
                                            <MessageCircle className="w-6 h-6 text-zinc-400 mt-1 shrink-0" />
                                            <p className="text-xl font-medium text-white leading-relaxed">
                                                {questions[currentQuestionIndex].question}
                                            </p>
                                        </div>

                                        {/* MCQ Options */}
                                        {questions[currentQuestionIndex].options && questions[currentQuestionIndex].options.length > 0 ? (
                                            <div className="space-y-3 mb-8">
                                                {questions[currentQuestionIndex].options.map((option, idx) => (
                                                    <button
                                                        key={idx}
                                                        onClick={() => {
                                                            setCurrentAnswer(option);
                                                            // Auto-submit after a short delay for better UX
                                                            setTimeout(() => handleAnswerSubmit(option), 300);
                                                        }}
                                                        className={`w-full text-left p-4 rounded-xl border-2 transition-all hover:scale-[1.01] active:scale-[0.99] ${
                                                            currentAnswer === option
                                                                ? 'bg-white/10 border-white text-white'
                                                                : 'bg-black border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                                                        }`}
                                                    >
                                                        <div className="flex items-start gap-3">
                                                            <div className={`mt-1 w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                                                                currentAnswer === option ? 'border-white bg-white' : 'border-zinc-700'
                                                            }`}>
                                                                {currentAnswer === option && <div className="w-2 h-2 bg-black rounded-full" />}
                                                            </div>
                                                            <span className="text-lg font-medium">{option}</span>
                                                        </div>
                                                    </button>
                                                ))}
                                            </div>
                                        ) : (
                                            <textarea
                                                value={currentAnswer}
                                                onChange={(e) => setCurrentAnswer(e.target.value)}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter' && !e.shiftKey && !loading) {
                                                        e.preventDefault();
                                                        handleAnswerSubmit();
                                                    }
                                                }}
                                                placeholder="Share your thoughts... (Press Enter to submit)"
                                                className="w-full px-5 py-4 bg-black border border-zinc-800 rounded-xl text-white placeholder-zinc-600 focus:outline-none focus:border-white focus:ring-1 focus:ring-white/20 transition-all resize-none text-lg mb-8"
                                                rows={4}
                                                autoFocus
                                                disabled={loading}
                                            />
                                        )}
                                    </div>
                                )}

                                {/* Buttons */}
                                <div className="flex gap-4">
                                    <button
                                        onClick={handleBack}
                                        disabled={loading}
                                        className="px-6 py-3 bg-zinc-800 hover:bg-zinc-700 rounded-xl font-bold text-zinc-300 flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
                                       
                                       
                                    >
                                        <ArrowLeft className="w-5 h-5" />
                                        Back
                                    </button>
                                    <button
                                        onClick={handleAnswerSubmit}
                                        disabled={!currentAnswer.trim() || loading}
                                        className={`flex-1 px-6 py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-all ${currentAnswer.trim() && !loading
                                                ? 'bg-white text-black hover:bg-zinc-200 shadow-lg shadow-white/5'
                                                : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
                                            }`}
                                    >
                                        {loading ? (
                                            <>
                                                <Loader2 className="w-5 h-5 animate-spin" />
                                                Analyzing...
                                            </>
                                        ) : currentQuestionIndex < questions.length - 1 ? (
                                            <>
                                                Next Question
                                                <ChevronRight className="w-5 h-5" />
                                            </>
                                        ) : (
                                            <>
                                                Complete Assessment
                                                <CheckCircle2 className="w-5 h-5" />
                                            </>
                                        )}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {step === 'complete' && (
                        /* Assessment Complete Section */
                        <div
                            key="complete"
                            className="max-w-xl mx-auto mb-12"
                           
                           
                           
                        >
                            <div className="bg-zinc-900 rounded-2xl p-8 border border-zinc-800 text-center shadow-xl shadow-black/50">
                                <div
                                   
                                   
                                   
                                    className="w-20 h-20 bg-white rounded-full flex items-center justify-center mx-auto mb-6 shadow-lg shadow-white/20"
                                >
                                    <CheckCircle2 className="w-10 h-10 text-black" />
                                </div>

                                <h3 className="text-2xl font-bold text-white mb-2">Assessment Complete!</h3>
                                <p className="text-zinc-400 mb-8 max-w-sm mx-auto">
                                    We've analyzed your responses and prepared a personalized skill tree for <span className="text-white font-bold">{topic}</span>
                                </p>

                                {assessmentResult && (
                                    <div className="bg-black border border-zinc-800 rounded-xl p-5 mb-8 text-left">
                                        <p className="text-xs text-zinc-500 uppercase tracking-widest font-mono mb-2">Starting Level</p>
                                        <p className="text-xl font-bold text-white">{assessmentResult.level || 'Beginner'}</p>
                                        {assessmentResult.summary && (
                                            <p className="text-sm text-zinc-400 mt-2 border-t border-zinc-900 pt-2">{assessmentResult.summary}</p>
                                        )}
                                    </div>
                                )}

                                <button
                                    onClick={handleProceedToMap}
                                    className="w-full px-8 py-4 bg-white hover:bg-zinc-200 rounded-xl font-bold text-lg text-black transition-colors flex items-center justify-center gap-3"
                                   
                                   
                                >
                                    <MapPin className="w-5 h-5" />
                                    Explore Your Skill Tree
                                    <ChevronRight className="w-5 h-5" />
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                {/* Instructions */}
                <div
                    className="bg-zinc-900/50 backdrop-blur-sm rounded-xl p-6 border border-zinc-800"
                   
                   
                   
                >
                    <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                        <Gamepad2 className="w-5 h-5 text-white" />
                        How to Play
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="flex items-start gap-3">
                            <span className="w-6 h-6 bg-zinc-800 border border-zinc-700 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0">1</span>
                            <span className="text-sm text-zinc-400">Enter a <strong className="text-white">topic</strong> and complete a quick assessment</span>
                        </div>
                        <div className="flex items-start gap-3">
                            <span className="w-6 h-6 bg-zinc-800 border border-zinc-700 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0">2</span>
                            <span className="text-sm text-zinc-400">AI generates <strong className="text-white">personalized levels</strong> based on your skills</span>
                        </div>
                        <div className="flex items-start gap-3">
                            <span className="w-6 h-6 bg-zinc-800 border border-zinc-700 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0">3</span>
                            <span className="text-sm text-zinc-400">Complete quiz levels to <strong className="text-white">earn stars</strong> and unlock next stages</span>
                        </div>
                        <div className="flex items-start gap-3">
                            <span className="w-6 h-6 bg-zinc-800 border border-zinc-700 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0">4</span>
                            <span className="text-sm text-zinc-400">Earn <strong className="text-white">Credit rewards</strong> for every completed challenge</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SkillTreeLanding;
