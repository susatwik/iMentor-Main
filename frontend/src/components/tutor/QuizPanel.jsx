// frontend/src/components/tutor/QuizPanel.jsx
import React, { useState, useEffect, useCallback } from 'react';
import Animate from '../core/Animate.jsx';
import {
    Brain,
    ChevronRight,
    ChevronLeft,
    CheckCircle2,
    XCircle,
    RotateCcw,
    Trophy,
    Loader2,
    Lightbulb,
    AlertCircle,
    MessageSquare,
    ShieldOff,
    BookOpen,
    Send
} from 'lucide-react';
import api from '../../services/api.js';
import { useAuth } from '../../hooks/useAuth';

/**
 * QuizPanel handles persistence and display of practice questions.
 * Results (correct/wrong) are passed from TutorModePage but also synced.
 * Course-aware: validates that the selected course is academic before showing questions.
 */
function QuizPanel({ selectedCourse, moduleId, onQuestionChange, questionResults = {}, onResetQuiz, initialQuizIndex = 0, onIndexChange, systemPrompt }) {
    const { token: regularUserToken, user } = useAuth();
    const userId = user?.id || 'guest';
    const [questions, setQuestions] = useState([]);
    const [loading, setLoading] = useState(true);
    // error: null | 'no_backend' | 'non_academic' | 'no_questions'
    const [error, setError] = useState(null);
    const [nonAcademicMessage, setNonAcademicMessage] = useState('');
    const isInitialized = React.useRef(false);

    // Persist current question index per course
    const [currentIndex, setCurrentIndex] = useState(() => {
        const saved = localStorage.getItem(`quizIndex_${userId}_${selectedCourse || 'default'}`);
        // If initialQuizIndex is 0, we should prefer it over a saved index of e.g. 5
        // but only if it's explicitly passed as a valid number.
        return (initialQuizIndex !== null && initialQuizIndex !== undefined)
            ? initialQuizIndex
            : (saved ? parseInt(saved, 10) : 0);
    });

    const [answerText, setAnswerText] = useState('');
    const [isEvaluating, setIsEvaluating] = useState(false);
    const [localFeedback, setLocalFeedback] = useState('');

    const handleSubmitAnswer = async () => {
        if (!answerText.trim() || isEvaluating) return;

        setIsEvaluating(true);
        setLocalFeedback('');

        try {
            const apiUrl = `${import.meta.env.VITE_API_BASE_URL || 'http://localhost:2000/api'}/chat/message`;

            // Generate a unique session ID for this evaluation to avoid disturbing Socratic mode history
            const tempSessionId = `isolated-quiz-${Date.now()}`;

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${regularUserToken}`
                },
                body: JSON.stringify({
                    query: answerText.trim(),
                    sessionId: tempSessionId,
                    systemPrompt,
                    tutorMode: true,
                    tutorModeType: 'assistant' // Use assistant mode for fast-path evaluation
                })
            });

            if (!response.ok) throw new Error('Evaluation failed');

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullText = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n\n').filter(line => line.startsWith('data: '));

                for (const line of lines) {
                    const jsonString = line.replace('data: ', '');
                    if (jsonString === '[DONE]') break;
                    try {
                        const eventData = JSON.parse(jsonString);

                        if (eventData.type === 'content' || eventData.type === 'text') {
                            const content = eventData.content || eventData.text;
                            setLocalFeedback(prev => prev + content);
                        }

                        if (eventData.type === 'final_answer') {
                            const botMsg = eventData.content;
                            const text = botMsg.finalAnswer || botMsg.text;

                            // Detect correct/incorrect
                            const openingText = text.replace(/\*+/g, '').replace(/_+/g, '').trim().slice(0, 80).toLowerCase();
                            const isCorrect = openingText.startsWith('✅') || openingText.includes('✅ correct') || openingText.startsWith('correct!') || openingText.startsWith('correct.') || openingText.startsWith('that is correct');
                            const isIncorrect = openingText.startsWith('❌') || openingText.includes('❌ not quite') || openingText.includes('❌ incorrect') || openingText.includes('❌ needs adjustment');

                            window.dispatchEvent(new CustomEvent('quiz-result', {
                                detail: {
                                    result: isCorrect ? 'correct' : (isIncorrect ? 'incorrect' : 'correct'),
                                    index: currentIndex,
                                    feedback: text
                                }
                            }));
                            setAnswerText('');
                            setLocalFeedback(''); // Clear local streaming once persistent state takes over
                        }
                    } catch (e) {
                        // Some chunks might be partial or contain non-JSON content
                        // In a simple streaming evaluator, we might just get text
                    }
                }
            }
        } catch (err) {
            console.error('Quiz Evaluation Error:', err);
        } finally {
            setIsEvaluating(false);
        }
    };

    const handleSelectOption = (optionIndex) => {
        if (isEvaluating || currentResult) return;

        const isCorrect = optionIndex === current.correctIndex;
        const correctOptionText = current.options[current.correctIndex] || '';
        const feedbackText = isCorrect
            ? `Correct! "${correctOptionText}" is the correct answer.`
            : `Incorrect. You selected "${current.options[optionIndex]}". The correct answer was: "${correctOptionText}".`;

        window.dispatchEvent(new CustomEvent('quiz-result', {
            detail: {
                result: isCorrect ? 'correct' : 'incorrect',
                index: currentIndex,
                feedback: feedbackText,
                selectedOption: optionIndex
            }
        }));
    };

    // Reset index when course changes or backend data arrives
    useEffect(() => {
        if (!selectedCourse) return;

        // Prioritize backend-synced index if available (ensures per-user persistence)
        if (initialQuizIndex !== null && initialQuizIndex !== undefined) {
            setCurrentIndex(initialQuizIndex);
        } else {
            const saved = localStorage.getItem(`quizIndex_${userId}_${selectedCourse}`);
            if (saved) {
                setCurrentIndex(parseInt(saved, 10));
            }
        }
        isInitialized.current = true;
    }, [selectedCourse, initialQuizIndex, userId]);

    // Persist index whenever it changes
    useEffect(() => {
        if (selectedCourse && isInitialized.current) {
            localStorage.setItem(`quizIndex_${userId}_${selectedCourse}`, currentIndex.toString());
            if (typeof onIndexChange === 'function') {
                onIndexChange(currentIndex);
            }
        }
    }, [currentIndex, selectedCourse, onIndexChange, userId]);

    const fetchQuestions = useCallback(async () => {
        setLoading(true);
        setError(null);
        setNonAcademicMessage('');
        try {
            console.log("Quiz Request", {
                courseName: selectedCourse,
                moduleId: moduleId
            });
            const data = await api.generateSocraticQuiz(selectedCourse || null, moduleId || null);
            console.log("Quiz Response", data);

            // Non-academic rejection from backend (status 200 with isNonAcademic flag)
            if (data && data.isNonAcademic) {
                setError('non_academic');
                setNonAcademicMessage(data.message || `"${selectedCourse}" is not an academic subject.`);
                setQuestions([]);
                setLoading(false);
                return;
            }

            if (data.success && data.questions?.length > 0) {
                setQuestions(data.questions);
                setCurrentIndex(prev => Math.min(prev, data.questions.length - 1));
                setLoading(false);
                return;
            }

            // Loaded OK but empty dataset
            setError('no_questions');
        } catch (err) {
            // HTTP 422 = non-academic rejection from backend
            if (err?.response?.status === 422 && err?.response?.data?.isNonAcademic) {
                setError('non_academic');
                setNonAcademicMessage(
                    err.response.data.message || `"${selectedCourse}" is not an academic subject.`
                );
            } else {
                setError('no_backend');
            }
        } finally {
            setLoading(false);
        }
    }, [selectedCourse, moduleId]);

    // Re-fetch whenever the selected course changes
    useEffect(() => { fetchQuestions(); }, [fetchQuestions]);

    useEffect(() => {
        if (questions.length > 0 && onQuestionChange) {
            onQuestionChange(questions[currentIndex], currentIndex, questions.length);
        }
    }, [currentIndex, questions, onQuestionChange]);

    const goNext = () => { if (currentIndex < questions.length - 1) setCurrentIndex(i => i + 1); };
    const goPrev = () => { if (currentIndex > 0) setCurrentIndex(i => i - 1); };

    // Derived statistics
    const resultsArray = Object.values(questionResults);
    const correctCount = resultsArray.filter(r => (r?.result === 'correct' || r === 'correct')).length;
    const incorrectCount = resultsArray.filter(r => (r?.result === 'incorrect' || r === 'incorrect')).length;
    const answeredCount = Object.keys(questionResults).length;
    const progressPct = questions.length > 0 ? Math.round((answeredCount / questions.length) * 100) : 0;

    const current = questions[currentIndex];
    const dataForCurrent = questionResults[currentIndex];
    const currentResult = typeof dataForCurrent === 'object' ? dataForCurrent.result : dataForCurrent;
    const currentFeedback = typeof dataForCurrent === 'object' ? dataForCurrent.feedback : null;

    const [isRevealingAnswer, setIsRevealingAnswer] = useState(false);

    // Reset reveal state when question changes
    useEffect(() => {
        setIsRevealingAnswer(false);
    }, [currentIndex]);

    // ── Loading ───────────────────────────────────────────────────────────────
    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-400">
                <Loader2 size={24} className="animate-spin text-purple-400" />
                <p className="text-xs">
                    Loading questions{selectedCourse ? ` for ${selectedCourse}` : ''}...
                </p>
            </div>
        );
    }

    // ── Non-academic rejection ────────────────────────────────────────────────
    if (error === 'non_academic') {
        return (
            <div className="flex flex-col h-full overflow-y-auto custom-scrollbar p-6">
                <div className="flex flex-col items-center justify-center flex-1 text-center gap-5 px-2">
                    <div className="w-14 h-14 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center">
                        <ShieldOff size={26} className="text-red-400" />
                    </div>
                    <div>
                        <p className="text-sm font-bold text-gray-100 mb-2">Non-Academic Course</p>
                        <p className="text-[11px] text-gray-400 leading-relaxed">{nonAcademicMessage}</p>
                    </div>
                    <div className="w-full rounded-xl bg-blue-500/5 border border-blue-500/15 p-3 flex items-start gap-2.5">
                        <BookOpen size={13} className="text-blue-400 mt-0.5 flex-shrink-0" />
                        <p className="text-[10px] text-blue-300/80 text-left leading-relaxed">
                            Please select an academic course (e.g.,{' '}
                            <span className="font-semibold text-blue-200">
                                Mathematics, Physics, Computer Science, Engineering
                            </span>
                            ) from the dropdown above.
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    // ── No questions yet ──────────────────────────────────────────────────────
    if (error === 'no_questions') {
        return (
            <div className="flex flex-col h-full overflow-y-auto custom-scrollbar p-6">
                <div className="flex flex-col items-center justify-center flex-1 text-center gap-4">
                    <Brain size={22} className="text-purple-400/50" />
                    <p className="text-sm font-semibold text-gray-300">No Questions Yet</p>
                    <p className="text-[11px] text-gray-500 leading-relaxed">
                        No practice questions have been generated for{' '}
                        <span className="text-gray-300 font-medium">{selectedCourse || 'this course'}</span> yet.
                        <br />An admin needs to run the Q&amp;A generator for this course.
                    </p>
                    <button
                        onClick={fetchQuestions}
                        className="px-4 py-2 rounded-xl bg-purple-500/15 border border-purple-500/25 text-purple-300 text-xs font-medium hover:bg-purple-500/25"
                    >
                        <RotateCcw size={11} className="inline mr-2" /> Retry
                    </button>
                </div>
            </div>
        );
    }

    // ── Backend unreachable ───────────────────────────────────────────────────
    if (error === 'no_backend') {
        return (
            <div className="flex flex-col h-full overflow-y-auto custom-scrollbar p-6">
                <div className="flex flex-col items-center justify-center flex-1 text-center gap-4">
                    <AlertCircle size={22} className="text-orange-400" />
                    <p className="text-sm font-semibold text-gray-200">Backend Not Running</p>
                    <button
                        onClick={fetchQuestions}
                        className="px-4 py-2 rounded-xl bg-purple-500/15 border border-purple-500/25 text-purple-300 text-xs font-medium hover:bg-purple-500/25"
                    >
                        <RotateCcw size={11} className="inline mr-2" /> Retry
                    </button>
                </div>
            </div>
        );
    }

    // ── Quiz Panel ────────────────────────────────────────────────────────────
    return (
        <div className="flex flex-col h-full" style={{ background: 'rgba(10,12,18,0.97)' }}>
            {/* Header */}
            <div className="flex-shrink-0 px-4 pt-4 pb-3 border-b border-white/5">
                <div className="flex items-center justify-between mb-2.5">
                    <div className="flex items-center gap-2">
                        <div className="p-1 rounded bg-purple-500/10 border border-purple-500/20">
                            <Brain size={12} className="text-purple-400" />
                        </div>
                        <span className="text-[11px] font-bold text-gray-300 uppercase tracking-wider">
                            Practice Quiz
                        </span>
                    </div>
                    <div className="flex items-center gap-3">
                        <span className="text-[11px] text-gray-500 tabular-nums">
                            {currentIndex + 1} / {questions.length}
                        </span>
                        <button
                            onClick={() => {
                                if (window.confirm('Reset quiz results and start from Question 1?')) {
                                    if (typeof onResetQuiz === 'function') onResetQuiz();
                                }
                            }}
                            title="Reset Quiz"
                            className="p-1.5 rounded-lg hover:bg-white/5 text-gray-600 hover:text-red-400/80 transition-all"
                        >
                            <RotateCcw size={11} />
                        </button>
                    </div>
                </div>

                <div className="w-full h-1 bg-gray-800 rounded-full overflow-hidden mb-3">
                    <div
                        style={{ width: `${progressPct}%` }}
                        className="h-full bg-gradient-to-r from-purple-500 to-teal-500 transition-all duration-400"
                    />
                </div>

                <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1 text-[10px] text-green-400 font-medium tracking-tight">
                        <CheckCircle2 size={10} /> {correctCount} correct
                    </span>
                    <span className="flex items-center gap-1 text-[10px] text-red-400 font-medium tracking-tight">
                        <XCircle size={10} /> {incorrectCount} wrong
                    </span>
                    <span className="ml-auto text-[10px] text-gray-600 font-medium uppercase tracking-widest">
                        {loading ? '---' : `${answeredCount} / ${questions.length} answered`}
                    </span>
                </div>
            </div>

            {/* Question Area */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
                    <Animate
                        key={currentIndex}
                        animation="scale-in"
                        className="flex flex-col gap-3"
                    >
                        {currentResult && (
                            <div className={`px-3 py-1.5 rounded-lg text-[11px] font-bold w-fit flex items-center gap-2 border shadow-lg ${currentResult === 'correct'
                                ? 'bg-green-500/10 border-green-500/20 text-green-400'
                                : 'bg-red-500/10 border-red-500/20 text-red-400'
                                }`}>
                                {currentResult === 'correct'
                                    ? <><CheckCircle2 size={12} /> Correct!</>
                                    : <><XCircle size={12} /> Incorrect</>
                                }
                            </div>
                        )}

                        <div className={`rounded-2xl p-4 border transition-all duration-500 ${currentResult === 'correct'
                            ? 'bg-green-500/5 border-green-500/10 shadow-[0_0_20px_rgba(34,197,94,0.03)]'
                            : currentResult === 'incorrect'
                                ? 'bg-red-500/5 border-red-500/10 shadow-[0_0_20px_rgba(239,68,68,0.03)]'
                                : 'bg-gray-800/40 border-white/5 shadow-inner'
                            }`}>
                            <div className="flex items-start gap-3">
                                <div className="w-8 h-8 rounded-xl bg-purple-500/10 flex items-center justify-center flex-shrink-0 border border-purple-500/10">
                                    <Lightbulb size={16} className="text-purple-400" />
                                </div>
                                <div className="flex-1">
                                    <p className="text-[10px] text-purple-400 font-bold uppercase tracking-widest mb-1.5 opacity-80">
                                        Question {currentIndex + 1}
                                    </p>
                                    <p className="text-[13px] text-gray-100 leading-relaxed font-semibold">
                                        {current?.instruction || current?.question || ''}
                                    </p>
                                </div>
                            </div>
                        </div>

                        {/* Analysis Panel (Generated Answer Area) */}
                        {(currentFeedback || localFeedback) && (
                            <Animate
                                animation="slide-up"
                                className="rounded-2xl p-4 bg-teal-500/5 border border-teal-500/10 flex flex-col gap-3 shadow-lg"
                            >
                                <div className="flex items-center gap-2 border-b border-teal-500/10 pb-2">
                                    <Brain size={14} className="text-teal-400" />
                                    <p className="text-[11px] font-bold text-teal-400 uppercase tracking-widest">Feedback Analysis</p>
                                </div>
                                <div className="text-[12px] text-gray-300 leading-relaxed max-h-48 overflow-y-auto custom-scrollbar pr-1 whitespace-pre-wrap">
                                    {localFeedback || currentFeedback}
                                </div>
                            </Animate>
                        )}

                        {current?.options && current.options.length > 0 ? (
                            <div className="flex flex-col gap-2.5">
                                {current.options.map((option, idx) => {
                                    let btnStyle = "border-white/5 bg-gray-900/40 text-gray-300 hover:bg-gray-800/40 hover:border-purple-500/25";
                                    if (currentResult) {
                                        if (idx === current.correctIndex) {
                                            btnStyle = "border-green-500/30 bg-green-500/10 text-green-400 font-semibold";
                                        } else if (dataForCurrent?.selectedOption === idx) {
                                            btnStyle = "border-red-500/30 bg-red-500/10 text-red-400";
                                        } else {
                                            btnStyle = "border-white/5 bg-gray-900/20 text-gray-500 opacity-60 cursor-not-allowed";
                                        }
                                    }
                                    return (
                                        <button
                                            key={idx}
                                            disabled={!!currentResult || isEvaluating}
                                            onClick={() => handleSelectOption(idx)}
                                            className={`w-full p-3.5 rounded-xl border text-left text-xs transition-all duration-200 flex items-start gap-3 ${btnStyle}`}
                                        >
                                            <span className="flex-shrink-0 w-5 h-5 rounded-full border border-current/25 flex items-center justify-center font-bold text-[10px]">
                                                {String.fromCharCode(65 + idx)}
                                            </span>
                                            <span className="flex-1">{option}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        ) : (
                            !currentResult && !isRevealingAnswer && (
                                <div className="flex flex-col gap-3">
                                    <div className="relative group">
                                        <textarea
                                            value={answerText}
                                            onChange={(e) => setAnswerText(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter' && !e.shiftKey) {
                                                    e.preventDefault();
                                                    handleSubmitAnswer();
                                                }
                                            }}
                                            disabled={isEvaluating}
                                            placeholder={isEvaluating ? "Evaluating answer..." : "Enter your answer here..."}
                                            className="w-full min-h-[100px] p-3 rounded-2xl bg-gray-900/40 border border-white/5 text-[12px] text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-purple-500/30 focus:bg-gray-900/60 transition-all resize-none custom-scrollbar disabled:opacity-50"
                                        />
                                        <button
                                            onClick={handleSubmitAnswer}
                                            disabled={!answerText.trim() || isEvaluating}
                                            className="absolute bottom-3 right-3 p-1.5 rounded-lg bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 disabled:opacity-30 disabled:hover:bg-purple-500/20 transition-all border border-purple-500/20"
                                        >
                                            {isEvaluating ? <Loader2 size={14} className="animate-spin text-purple-300" /> : <Send size={14} />}
                                        </button>
                                    </div>

                                    <button
                                        onClick={() => setIsRevealingAnswer(true)}
                                        className="w-full py-2 rounded-xl bg-gray-800/20 border border-white/5 text-[10px] text-gray-500 font-bold uppercase tracking-widest hover:bg-gray-800/40 transition-all flex items-center justify-center gap-2"
                                    >
                                        <ShieldOff size={11} className="text-orange-400/40" />
                                        Reveal Correct Answer
                                    </button>
                                </div>
                            )
                        )}

                        {isRevealingAnswer && (
                            <Animate
                                animation="scale-in"
                                className="rounded-2xl p-4 bg-orange-500/5 border border-orange-500/10 flex flex-col gap-2.5 shadow-lg"
                            >
                                <div className="flex items-center justify-between border-b border-orange-500/10 pb-2">
                                    <div className="flex items-center gap-2">
                                        <ShieldOff size={13} className="text-orange-400" />
                                        <p className="text-[11px] font-bold text-orange-400 uppercase tracking-widest">Document Answer</p>
                                    </div>
                                    <button onClick={() => setIsRevealingAnswer(false)} className="text-gray-500 hover:text-white transition-colors">
                                        <RotateCcw size={10} />
                                    </button>
                                </div>
                                <p className="text-[12px] text-orange-200/80 leading-relaxed italic pr-1">
                                    "{current?.output}"
                                </p>
                                <p className="text-[9px] text-gray-500 font-medium italic">Note: Use this to compare your knowledge with the official course source.</p>
                            </Animate>
                        )}

                        {currentResult && currentIndex < questions.length - 1 && (
                            <button
                                onClick={goNext}
                                className="group relative w-full overflow-hidden p-[1px] rounded-xl bg-gradient-to-r from-purple-500/30 to-teal-500/30"
                            >
                                <div className="bg-gray-900/90 px-3 py-2.5 rounded-xl flex items-center justify-between group-hover:bg-gray-900/50 transition-colors">
                                    <span className="text-[11px] text-purple-300 font-bold uppercase tracking-wider">
                                        Next Question Ready
                                    </span>
                                    <ChevronRight size={14} className="text-purple-400 group-hover:translate-x-1 transition-transform" />
                                </div>
                            </button>
                        )}

                        {/* FINAL SCORECARD: Show when the last question is answered, even if some were skipped */}
                        {currentIndex === questions.length - 1 && currentResult && questions.length > 0 && (() => {
                            const total = questions.length;
                            const pct = total > 0 ? Math.round((correctCount / total) * 100) : 0;
                            const grade = pct >= 90 ? { label: 'A+', color: 'text-yellow-400', bg: 'bg-yellow-400/10 border-yellow-400/20' }
                                : pct >= 75 ? { label: 'A', color: 'text-green-400', bg: 'bg-green-400/10  border-green-400/20' }
                                    : pct >= 60 ? { label: 'B', color: 'text-teal-400', bg: 'bg-teal-400/10   border-teal-400/20' }
                                        : pct >= 45 ? { label: 'C', color: 'text-blue-400', bg: 'bg-blue-400/10   border-blue-400/20' }
                                            : { label: 'D', color: 'text-red-400', bg: 'bg-red-400/10    border-red-400/20' };
                            return (
                                <Animate
                                    animation="slide-up"
                                    className="flex flex-col items-center gap-4 py-5 px-4 rounded-2xl bg-gradient-to-b from-purple-500/8 to-transparent border border-white/8"
                                >
                                    {/* Trophy + title */}
                                    <div className="flex flex-col items-center gap-1">
                                        <Trophy size={28} className="text-yellow-400 drop-shadow-[0_0_12px_rgba(234,179,8,0.4)] animate-bounce" />
                                        <p className="text-[13px] font-bold text-white tracking-wide">Quiz Complete!</p>
                                        <p className="text-[10px] text-gray-500">{selectedCourse} practice set</p>
                                    </div>

                                    {/* Score ring + grade */}
                                    <div className="flex items-center gap-4 w-full justify-center">
                                        {/* Big score */}
                                        <div className="flex flex-col items-center justify-center w-20 h-20 rounded-full border-2 border-purple-500/30 bg-purple-500/5 shadow-[0_0_20px_rgba(168,85,247,0.08)]">
                                            <span className="text-xl font-black text-white tabular-nums leading-none">{correctCount}</span>
                                            <span className="text-[9px] text-gray-500 font-semibold uppercase tracking-widest">/ {total}</span>
                                        </div>
                                        {/* Grade badge */}
                                        <div className={`flex flex-col items-center justify-center w-14 h-14 rounded-2xl border font-black text-2xl ${grade.bg} ${grade.color}`}>
                                            {grade.label}
                                        </div>
                                    </div>

                                    {/* Stat row */}
                                    <div className="flex items-center justify-between w-full px-1 gap-2">
                                        <div className="flex-1 flex flex-col items-center gap-0.5 rounded-xl bg-green-500/5 border border-green-500/15 py-2">
                                            <span className="text-base font-black text-green-400 tabular-nums">{correctCount}</span>
                                            <span className="text-[9px] text-gray-500 font-semibold uppercase tracking-wider">Correct</span>
                                        </div>
                                        <div className="flex-1 flex flex-col items-center gap-0.5 rounded-xl bg-red-500/5 border border-red-500/15 py-2">
                                            <span className="text-base font-black text-red-400 tabular-nums">{incorrectCount}</span>
                                            <span className="text-[9px] text-gray-500 font-semibold uppercase tracking-wider">Wrong</span>
                                        </div>
                                        <div className="flex-1 flex flex-col items-center gap-0.5 rounded-xl bg-purple-500/5 border border-purple-500/15 py-2">
                                            <span className="text-base font-black text-purple-300 tabular-nums">{pct}%</span>
                                            <span className="text-[9px] text-gray-500 font-semibold uppercase tracking-wider">Score</span>
                                        </div>
                                    </div>

                                    {/* Score bar */}
                                    <div className="w-full">
                                        <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
                                            <div
                                                style={{ width: `${pct}%` }}
                                                className={`h-full rounded-full transition-all duration-800 ${pct >= 75 ? 'bg-gradient-to-r from-green-500 to-teal-400'
                                                    : pct >= 45 ? 'bg-gradient-to-r from-yellow-500 to-orange-400'
                                                        : 'bg-gradient-to-r from-red-500 to-pink-400'
                                                    }`}
                                            />
                                        </div>
                                    </div>

                                    {/* Start Over */}
                                    <button
                                        onClick={() => {
                                            if (window.confirm('Reset quiz results and start from Question 1?')) {
                                                localStorage.removeItem(`quizResults_${userId}_${selectedCourse}`);
                                                localStorage.setItem(`quizIndex_${userId}_${selectedCourse || 'default'}`, '0');
                                                setCurrentIndex(0);
                                                if (typeof onResetQuiz === 'function') onResetQuiz();
                                            }
                                        }}
                                        className="flex items-center gap-2 px-5 py-2 rounded-xl bg-purple-500/15 border border-purple-500/25 text-purple-300 text-[10px] font-bold uppercase tracking-widest hover:bg-purple-500/30 hover:border-purple-500/40 transition-all active:scale-95"
                                    >
                                        <RotateCcw size={11} /> Try Again
                                    </button>
                                </Animate>
                            );
                        })()}
                    </Animate>
            </div>

            {/* Navigation */}
            <div className="flex-shrink-0 px-4 py-3 border-t border-white/5 flex items-center justify-between gap-1.5">
                <button
                    onClick={goPrev}
                    disabled={currentIndex === 0}
                    className="w-10 h-10 flex items-center justify-center rounded-xl text-gray-500 hover:text-gray-300 hover:bg-white/5 disabled:opacity-0 transition-all"
                >
                    <ChevronLeft size={18} />
                </button>

                <div className="flex items-center gap-2 overflow-hidden max-w-[190px] flex-wrap justify-center py-1">
                    {questions.map((_, i) => {
                        const result = questionResults[i];
                        const isCurrent = i === currentIndex;
                        return (
                            <button
                                key={i}
                                onClick={() => setCurrentIndex(i)}
                                className={`relative flex items-center justify-center transition-all ${isCurrent ? 'scale-110' : 'scale-100'}`}
                            >
                                {result === 'correct' || result?.result === 'correct'
                                    ? <CheckCircle2 size={16} className="text-green-500 drop-shadow-[0_0_4px_rgba(34,197,94,0.2)]" />
                                    : result === 'incorrect' || result?.result === 'incorrect'
                                        ? <XCircle size={16} className="text-red-500 drop-shadow-[0_0_4px_rgba(239,68,68,0.2)]" />
                                        : <div className={`rounded-full transition-all border ${isCurrent
                                            ? 'w-2.5 h-2.5 bg-purple-400 border-purple-400 shadow-[0_0_8px_rgba(168,85,247,0.4)]'
                                            : 'w-2 h-2 bg-gray-700/50 border-white/5 hover:bg-gray-600'
                                            }`} />
                                }
                            </button>
                        );
                    })}
                </div>

                <button
                    onClick={goNext}
                    disabled={currentIndex === questions.length - 1}
                    className="w-10 h-10 flex items-center justify-center rounded-xl text-gray-500 hover:text-gray-300 hover:bg-white/5 disabled:opacity-0 transition-all"
                >
                    <ChevronRight size={18} />
                </button>
            </div>
        </div>
    );
}

export default QuizPanel;
