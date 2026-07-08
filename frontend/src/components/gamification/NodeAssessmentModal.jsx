import React, { useState, useEffect } from 'react';
import { Brain, X, Loader2, CheckCircle2, XCircle, ChevronRight, ChevronLeft, Star } from 'lucide-react';
import axios from 'axios';
import toast from 'react-hot-toast';

const API = import.meta.env.VITE_API_BASE_URL;

const NodeAssessmentModal = ({ treeId, nodeId, nodeName, onClose }) => {
    const [questions, setQuestions] = useState([]);
    const [currentIdx, setCurrentIdx] = useState(0);
    const [answers, setAnswers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [result, setResult] = useState(null);
    const [startTime, setStartTime] = useState(Date.now());

    useEffect(() => {
        fetchQuestions();
    }, []);

    const fetchQuestions = async () => {
        setLoading(true);
        try {
            const token = localStorage.getItem('authToken');
            const { data } = await axios.post(`${API}/skill-tree/node-assessment`,
                { treeId, nodeId },
                { headers: { Authorization: `Bearer ${token}` } }
            );
            setQuestions(data.questions || []);
            setAnswers(new Array(data.questions?.length || 0).fill(undefined));
            setStartTime(Date.now());
        } catch (err) {
            toast.error('Failed to load assessment');
            onClose();
        } finally {
            setLoading(false);
        }
    };

    const handleSelect = (val) => {
        const newAnswers = [...answers];
        newAnswers[currentIdx] = val;
        setAnswers(newAnswers);
    };

    const handleSubmit = async () => {
        if (answers.some(a => a === undefined)) {
            toast.error('Answer all questions');
            return;
        }
        setSubmitting(true);
        try {
            const token = localStorage.getItem('authToken');
            const formatted = questions.map((q, i) => ({
                question: q.question,
                selectedIndex: typeof answers[i] === 'number' ? answers[i] : undefined,
                text: typeof answers[i] === 'string' ? answers[i] : undefined
            }));
            const { data } = await axios.post(`${API}/skill-tree/node-assessment/submit`, {
                treeId, nodeId, questions, answers: formatted,
                timeSpent: Math.round((Date.now() - startTime) / 1000)
            }, {
                headers: { Authorization: `Bearer ${token}` }
            });
            setResult(data);
            if (data.mastered) toast.success(`${nodeName} mastered!`);
        } catch (err) {
            toast.error('Failed to submit');
        } finally {
            setSubmitting(false);
        }
    };

    if (loading) {
        return (
            <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
                <div className="bg-zinc-900 rounded-2xl border border-zinc-800 p-8">
                    <Loader2 className="w-8 h-8 animate-spin text-zinc-500 mx-auto" />
                </div>
            </div>
        );
    }

    if (result) {
        return (
            <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
                <div className="bg-zinc-900 rounded-2xl border border-zinc-800 max-w-md w-full p-6">
                    <div className="text-center mb-6">
                        <div className={`w-16 h-16 mx-auto mb-3 rounded-full flex items-center justify-center ${
                            result.quizScore >= 70 ? 'bg-green-900/50' : 'bg-yellow-900/50'
                        }`}>
                            {result.quizScore >= 70
                                ? <CheckCircle2 className="w-8 h-8 text-green-400" />
                                : <XCircle className="w-8 h-8 text-yellow-400" />
                            }
                        </div>
                        <h3 className="text-xl font-bold text-white">{result.quizScore}%</h3>
                        <p className="text-zinc-400 text-sm mt-1">
                            {result.correctCount}/{result.totalQuestions} correct
                        </p>
                        {result.mastered && (
                            <div className="mt-2 inline-flex items-center gap-1 px-3 py-1 bg-green-900/30 text-green-400 rounded-full text-sm">
                                <Star className="w-4 h-4" /> Mastered!
                            </div>
                        )}
                        <p className="text-zinc-500 text-xs mt-2">
                            Status: <span className="text-zinc-300 capitalize">{result.masteryStatus}</span>
                        </p>
                    </div>
                    <div className="space-y-2 mb-6">
                        {result.results?.map((r, i) => (
                            <div key={i} className={`flex items-center gap-2 p-2 rounded-lg text-sm ${
                                r.correct ? 'bg-green-900/10 text-green-400' : 'bg-red-900/10 text-red-400'
                            }`}>
                                {r.correct ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
                                <span className="truncate">{r.question?.slice(0, 60)}</span>
                            </div>
                        ))}
                    </div>
                    <button onClick={onClose}
                        className="w-full px-6 py-3 bg-white hover:bg-zinc-200 text-black rounded-xl font-bold transition-colors">
                        Close
                    </button>
                </div>
            </div>
        );
    }

    if (questions.length === 0) {
        return (
            <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
                <div className="bg-zinc-900 rounded-2xl border border-zinc-800 p-8 text-center">
                    <p className="text-zinc-500">No questions available</p>
                    <button onClick={onClose} className="mt-4 text-sm text-blue-400">Close</button>
                </div>
            </div>
        );
    }

    const q = questions[currentIdx];

    return (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
            <div className="bg-zinc-900 rounded-2xl border border-zinc-800 max-w-lg w-full">
                <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Brain className="w-5 h-5 text-blue-400" />
                        <div>
                            <h3 className="text-white font-bold text-sm">Quick Check</h3>
                            <p className="text-zinc-500 text-xs">{nodeName}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        <span className="text-zinc-500 text-sm">{currentIdx + 1}/{questions.length}</span>
                        <button onClick={onClose} className="p-1 hover:bg-zinc-800 rounded-lg">
                            <X className="w-4 h-4 text-zinc-400" />
                        </button>
                    </div>
                </div>

                <div className="p-6">
                    <div className="w-full bg-zinc-800 rounded-full h-1 mb-6">
                        <div className="bg-blue-500 h-1 rounded-full transition-all"
                            style={{ width: `${((currentIdx + 1) / questions.length) * 100}%` }} />
                    </div>

                    <p className="text-white font-medium mb-2">{q.question}</p>
                    <p className="text-zinc-500 text-xs mb-4 capitalize">{q.type?.replace(/_/g, ' ')} — {q.difficulty}</p>

                    {q.options && q.options.length > 0 ? (
                        <div className="space-y-2">
                            {q.options.map((opt, oi) => (
                                <button key={oi}
                                    onClick={() => handleSelect(oi)}
                                    className={`w-full text-left px-4 py-3 rounded-xl border text-sm transition-all ${
                                        answers[currentIdx] === oi
                                            ? 'border-blue-500 bg-blue-900/20 text-white'
                                            : 'border-zinc-800 bg-black text-zinc-400 hover:border-zinc-700'
                                    }`}
                                >
                                    {opt}
                                </button>
                            ))}
                        </div>
                    ) : (
                        <textarea
                            value={typeof answers[currentIdx] === 'string' ? answers[currentIdx] : ''}
                            onChange={(e) => handleSelect(e.target.value)}
                            placeholder="Type your answer..."
                            className="w-full px-4 py-3 bg-black border border-zinc-800 rounded-xl text-white text-sm focus:outline-none focus:border-zinc-700 placeholder:text-zinc-600 min-h-[100px] resize-none"
                        />
                    )}
                </div>

                <div className="p-4 border-t border-zinc-800 flex gap-3">
                    <button onClick={currentIdx > 0 ? () => setCurrentIdx(i => i - 1) : onClose}
                        className="px-4 py-2.5 bg-zinc-800 hover:bg-zinc-700 rounded-xl text-sm text-zinc-300 transition-colors">
                        {currentIdx > 0 ? 'Previous' : 'Cancel'}
                    </button>
                    {currentIdx < questions.length - 1 ? (
                        <button onClick={() => setCurrentIdx(i => i + 1)}
                            disabled={answers[currentIdx] === undefined}
                            className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-bold transition-all ${
                                answers[currentIdx] !== undefined
                                    ? 'bg-white text-black hover:bg-zinc-200'
                                    : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
                            }`}>
                            Next
                        </button>
                    ) : (
                        <button onClick={handleSubmit}
                            disabled={answers.some(a => a === undefined) || submitting}
                            className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-bold transition-all ${
                                !submitting && !answers.some(a => a === undefined)
                                    ? 'bg-blue-600 text-white hover:bg-blue-500'
                                    : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
                            }`}>
                            {submitting ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'Submit'}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

export default NodeAssessmentModal;
