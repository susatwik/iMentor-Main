import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Brain, Loader2, CheckCircle2, AlertTriangle, ArrowLeft,
  BarChart3, BookOpen, Target, TrendingUp, ChevronRight, ChevronLeft, Send
} from 'lucide-react';
import axios from 'axios';
import toast from 'react-hot-toast';
import api from '../../services/api';

const BLOOM_LABELS = {
  remember: 'Remember',
  understand: 'Understand',
  apply: 'Apply',
  analyze: 'Analyze',
  evaluate: 'Evaluate',
};

const LEVEL_COLORS = {
  Beginner: { bg: 'bg-red-500/20', text: 'text-red-400', border: 'border-red-500/30' },
  Intermediate: { bg: 'bg-yellow-500/20', text: 'text-yellow-400', border: 'border-yellow-500/30' },
  Advanced: { bg: 'bg-blue-500/20', text: 'text-blue-400', border: 'border-blue-500/30' },
  Expert: { bg: 'bg-emerald-500/20', text: 'text-emerald-400', border: 'border-emerald-500/30' },
};

const KnowledgeAssessmentPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialTopic = searchParams.get('topic') || '';

  const [step, setStep] = useState('start');
  const [topic, setTopic] = useState(initialTopic);
  const [course, setCourse] = useState(searchParams.get('course') || '');
  const [courses, setCourses] = useState([]);
  const [loading, setLoading] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [questions, setQuestions] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState([]);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState(null);
  const [bloomData, setBloomData] = useState(null);
  const [draftAnswers, setDraftAnswers] = useState({});
  const questionRef = useRef(null);

  useEffect(() => {
    api.getSubjects().then(d => setCourses(d?.subjects || [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (initialTopic) handleGenerate();
  }, []);

  useEffect(() => {
    if (questionRef.current) {
      questionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [currentIndex]);

  const handleGenerate = async () => {
    if (!topic.trim() && !course.trim()) {
      toast.error('Enter a topic or select a course');
      return;
    }
    setLoading(true);
    try {
      const data = await api.generateAssessment({ course, topic: topic.trim() });
      setQuestions(data.questions || []);
      setAnswers([]);
      setCurrentIndex(0);
      setResult(null);
      setDraftAnswers({});
      setStep('taking');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to generate assessment');
    } finally {
      setLoading(false);
    }
  };

  const saveCurrentAnswer = () => {
    const q = questions[currentIndex];
    if (!q) return;
    if (q.type === 'mcq') return;
    const val = draftAnswers[q.question] || '';
    const existingIdx = answers.findIndex(a => a.question === q.question);
    if (existingIdx >= 0) {
      const updated = [...answers];
      updated[existingIdx] = { ...updated[existingIdx], userAnswer: val };
      setAnswers(updated);
    }
  };

  const goNext = () => {
    const q = questions[currentIndex];
    if (!q) return;
    if (q.type === 'descriptive') {
      const val = draftAnswers[q.question] || '';
      if (!val.trim()) {
        toast.error('Please type an answer before continuing');
        return;
      }
      const existingIdx = answers.findIndex(a => a.question === q.question);
      if (existingIdx >= 0) {
        const updated = [...answers];
        updated[existingIdx] = { ...updated[existingIdx], userAnswer: val };
        setAnswers(updated);
      } else {
        setAnswers([...answers, {
          question: q.question, type: q.type, options: q.options,
          correctAnswer: q.correctAnswer, modelAnswer: q.modelAnswer,
          bloomLevel: q.bloomLevel, concepts: q.concepts, userAnswer: val,
        }]);
      }
    }
    setCurrentIndex(Math.min(questions.length - 1, currentIndex + 1));
  };

  const goPrev = () => {
    saveCurrentAnswer();
    setCurrentIndex(Math.max(0, currentIndex - 1));
  };

  const handleSubmitAssessment = async () => {
    setEvaluating(true);
    const q = questions[currentIndex];
    const allResponses = [...answers];
    if (q && q.type === 'descriptive') {
      const val = draftAnswers[q.question] || '';
      const existingIdx = allResponses.findIndex(a => a.question === q.question);
      if (existingIdx >= 0) {
        allResponses[existingIdx] = { ...allResponses[existingIdx], userAnswer: val };
      } else {
        allResponses.push({
          question: q.question, type: q.type, options: q.options,
          correctAnswer: q.correctAnswer, modelAnswer: q.modelAnswer,
          bloomLevel: q.bloomLevel, concepts: q.concepts, userAnswer: val,
        });
      }
    }
    try {
      const data = await api.submitAssessment({
        responses: allResponses,
        topic: topic.trim() || course,
        course,
      });
      setResult(data);
      setStep('done');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to evaluate assessment');
    } finally {
      setEvaluating(false);
    }
  };

  const handleMcqAnswer = (opt) => {
    const q = questions[currentIndex];
    if (!q) return;
    const answer = {
      question: q.question, type: q.type, options: q.options,
      correctAnswer: q.correctAnswer, modelAnswer: q.modelAnswer,
      bloomLevel: q.bloomLevel, concepts: q.concepts, userAnswer: opt,
    };
    const existingIdx = answers.findIndex(a => a.question === q.question);
    let newAnswers;
    if (existingIdx >= 0) {
      newAnswers = [...answers];
      newAnswers[existingIdx] = answer;
    } else {
      newAnswers = [...answers, answer];
    }
    setAnswers(newAnswers);
    if (currentIndex < questions.length - 1) {
      setCurrentIndex(currentIndex + 1);
    }
  };

  const loadProfile = async () => {
    setLoading(true);
    try {
      const data = await api.getAssessmentProfile(topic.trim() || course);
      setHistory(data.history);
      setResult(data.readiness);
      setStep('profile');
    } catch (err) {
      toast.error('Failed to load profile');
    } finally {
      setLoading(false);
    }
  };

  const loadBloomTaxonomy = async () => {
    setLoading(true);
    try {
      const data = await api.getBloomTaxonomy(topic.trim() || course);
      setBloomData(data);
      setStep('bloom');
    } catch (err) {
      toast.error('Failed to load Bloom taxonomy data');
    } finally {
      setLoading(false);
    }
  };

  const renderStart = () => (
    <div className="max-w-xl mx-auto">
      <div className="text-center mb-10">
        <div className="w-20 h-20 bg-white rounded-2xl flex items-center justify-center mx-auto mb-5 shadow-[0_0_30px_rgba(255,255,255,0.15)]">
          <Brain className="w-10 h-10 text-black" />
        </div>
        <h1 className="text-3xl md:text-4xl font-bold text-white mb-3">Knowledge Assessment</h1>
        <p className="text-zinc-400">Evaluate your understanding with a Bloom's Taxonomy diagnostic test</p>
      </div>

      <div className="bg-zinc-900 rounded-2xl p-6 border border-zinc-800 mb-6">
        <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
          <Target className="w-5 h-5 text-zinc-400" />
          Choose a Topic
        </h3>
        <select
          value={course}
          onChange={e => setCourse(e.target.value)}
          className="w-full px-4 py-3 bg-black border border-zinc-800 rounded-xl text-white focus:outline-none focus:border-white mb-4"
        >
          <option value="">Select a course...</option>
          {courses.map(c => (
            <option key={c.code} value={c.code}>{c.name || c.code}</option>
          ))}
        </select>
        <div className="text-center text-zinc-600 text-sm mb-4">— or —</div>
        <input
          type="text"
          value={topic}
          onChange={e => setTopic(e.target.value)}
          placeholder="Or type a custom topic..."
          className="w-full px-4 py-3 bg-black border border-zinc-800 rounded-xl text-white placeholder-zinc-600 focus:outline-none focus:border-white mb-4"
          onKeyDown={e => e.key === 'Enter' && handleGenerate()}
        />
        <button
          onClick={handleGenerate}
          disabled={(!topic.trim() && !course) || loading}
          className="w-full py-3 bg-white text-black rounded-xl font-bold hover:bg-zinc-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Brain className="w-5 h-5" />}
          {loading ? 'Generating Assessment...' : 'Start Assessment'}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <button onClick={loadProfile} className="p-4 bg-zinc-900 rounded-xl border border-zinc-800 hover:border-zinc-600 text-left transition-all">
          <BarChart3 className="w-5 h-5 text-zinc-400 mb-2" />
          <div className="text-white font-medium text-sm">My Profile</div>
          <div className="text-zinc-500 text-xs mt-1">View past assessments</div>
        </button>
        <button onClick={loadBloomTaxonomy} className="p-4 bg-zinc-900 rounded-xl border border-zinc-800 hover:border-zinc-600 text-left transition-all">
          <TrendingUp className="w-5 h-5 text-zinc-400 mb-2" />
          <div className="text-white font-medium text-sm">Bloom's Taxonomy</div>
          <div className="text-zinc-500 text-xs mt-1">Track cognitive levels</div>
        </button>
      </div>
    </div>
  );

  const renderQuestion = () => {
    const q = questions[currentIndex];
    if (!q) return null;
    const progressPct = ((currentIndex) / questions.length) * 100;
    const isLast = currentIndex === questions.length - 1;
    const isFirst = currentIndex === 0;

    const isMcqAnswered = (q) => {
      return answers.some(a => a.question === q.question);
    };

    const getSelectedMcq = (q) => {
      const found = answers.find(a => a.question === q.question);
      return found ? found.userAnswer : null;
    };

    return (
      <div ref={questionRef} className="max-w-2xl mx-auto">
        <div className="mb-6">
          <div className="flex justify-between text-sm text-zinc-500 mb-2">
            <span>Question {currentIndex + 1} of {questions.length}</span>
            <span className="capitalize">{BLOOM_LABELS[q.bloomLevel] || q.bloomLevel}</span>
          </div>
          <div className="w-full h-1 bg-zinc-800 rounded-full overflow-hidden">
            <div className="h-full bg-white rounded-full transition-all duration-300" style={{ width: `${progressPct}%` }} />
          </div>
        </div>

        <div className="bg-zinc-900 rounded-2xl p-6 border border-zinc-800 mb-6">
          <div className="flex items-start gap-3 mb-6">
            <span className="w-8 h-8 bg-zinc-800 rounded-full flex items-center justify-center text-white font-bold text-sm shrink-0">
              {currentIndex + 1}
            </span>
            <p className="text-lg text-white font-medium">{q.question}</p>
          </div>

          {q.type === 'mcq' ? (
            <div className="space-y-3">
              {(q.options || []).map((opt, i) => {
                const selected = getSelectedMcq(q);
                const isSelected = selected === opt;
                return (
                  <button
                    key={i}
                    onClick={() => handleMcqAnswer(opt)}
                    className={`w-full text-left px-5 py-4 bg-black border rounded-xl transition-all flex items-center gap-3 ${
                      isSelected
                        ? 'border-white text-white'
                        : 'border-zinc-800 text-zinc-300 hover:border-white hover:text-white'
                    }`}
                  >
                    <span className={`w-7 h-7 rounded-full border flex items-center justify-center text-sm font-medium shrink-0 ${
                      isSelected ? 'border-white bg-white text-black' : 'border-zinc-700'
                    }`}>
                      {String.fromCharCode(65 + i)}
                    </span>
                    <span>{opt.replace(/^[A-D]\.\s*/, '')}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div>
              <textarea
                className="w-full px-5 py-4 bg-black border border-zinc-800 rounded-xl text-white placeholder-zinc-600 focus:outline-none focus:border-white min-h-[120px] resize-y"
                placeholder="Type your answer..."
                value={draftAnswers[q.question] || ''}
                onChange={e => setDraftAnswers(prev => ({ ...prev, [q.question]: e.target.value }))}
              />
            </div>
          )}
        </div>

        <div className="flex gap-3">
          {!isFirst && (
            <button
              onClick={goPrev}
              className="flex-1 py-3 bg-zinc-800 rounded-xl text-white font-bold hover:bg-zinc-700 transition-all flex items-center justify-center gap-2"
            >
              <ChevronLeft className="w-4 h-4" />
              Previous
            </button>
          )}
          {!isLast && (
            <button
              onClick={goNext}
              className="flex-1 py-3 bg-white text-black rounded-xl font-bold hover:bg-zinc-200 transition-all flex items-center justify-center gap-2"
            >
              Next
              <ChevronRight className="w-4 h-4" />
            </button>
          )}
          {isLast && (
            <button
              onClick={handleSubmitAssessment}
              disabled={evaluating}
              className="flex-1 py-3 bg-white text-black rounded-xl font-bold hover:bg-zinc-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {evaluating ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
              {evaluating ? 'Evaluating your assessment...' : 'Submit Answer'}
            </button>
          )}
        </div>
      </div>
    );
  };

  const renderResults = () => {
    if (!result) return null;
    const colors = LEVEL_COLORS[result.level] || LEVEL_COLORS.Beginner;

    return (
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-8">
          <div className={`w-20 h-20 ${colors.bg} rounded-full flex items-center justify-center mx-auto mb-4 border ${colors.border}`}>
            <CheckCircle2 className={`w-10 h-10 ${colors.text}`} />
          </div>
          <h1 className="text-3xl font-bold text-white mb-2">Assessment Complete</h1>
          <p className="text-zinc-400">Here's your knowledge profile</p>
        </div>

        <div className={`${colors.bg} ${colors.border} border rounded-2xl p-6 mb-6 text-center`}>
          <div className={`text-5xl font-bold ${colors.text} mb-2`}>{result.level}</div>
          <div className="text-zinc-400 text-sm">Proficiency Level</div>
          <div className={`mt-3 text-2xl font-bold text-white`}>{result.scorePercent}%</div>
          <div className="text-zinc-500 text-sm">({result.score}/{result.maxScore} correct)</div>
        </div>

        <div className="bg-zinc-900 rounded-2xl p-6 border border-zinc-800 mb-6">
          <h3 className="text-white font-semibold mb-3">Bloom's Taxonomy Breakdown</h3>
          <div className="space-y-3">
            {Object.entries(result.bloomProfile || {}).map(([level, data]) => (
              <div key={level}>
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-zinc-300 capitalize">{BLOOM_LABELS[level] || level}</span>
                  <span className={data.mastered ? 'text-emerald-400' : 'text-zinc-500'}>
                    {data.mastered ? 'Mastered' : `${data.score}%`}
                  </span>
                </div>
                <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full transition-all ${data.mastered ? 'bg-emerald-500' : 'bg-zinc-500'}`}
                    style={{ width: `${data.score}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {result.weakAreas?.length > 0 && (
          <div className="bg-zinc-900 rounded-2xl p-6 border border-zinc-800 mb-6">
            <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-yellow-400" />
              Areas to Review
            </h3>
            <div className="flex flex-wrap gap-2">
              {result.weakAreas.map((area, i) => (
                <span key={i} className="px-3 py-1 bg-yellow-500/10 border border-yellow-500/20 rounded-lg text-yellow-400 text-sm">
                  {area}
                </span>
              ))}
            </div>
          </div>
        )}

        {result.strengths?.length > 0 && (
          <div className="bg-zinc-900 rounded-2xl p-6 border border-zinc-800 mb-6">
            <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              Strengths
            </h3>
            <div className="flex flex-wrap gap-2">
              {result.strengths.map((area, i) => (
                <span key={i} className="px-3 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-400 text-sm">
                  {area}
                </span>
              ))}
            </div>
          </div>
        )}

        {result.misconceptions?.length > 0 && (
          <div className="bg-zinc-900 rounded-2xl p-6 border border-zinc-800 mb-6">
            <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-orange-400" />
              Misconceptions to Address
            </h3>
            <div className="flex flex-wrap gap-2">
              {result.misconceptions.map((m, i) => (
                <span key={i} className="px-3 py-1 bg-orange-500/10 border border-orange-500/20 rounded-lg text-orange-400 text-sm">
                  {m}
                </span>
              ))}
            </div>
          </div>
        )}

        {result.suggestedRevisionTopics?.length > 0 && (
          <div className="bg-zinc-900 rounded-2xl p-6 border border-zinc-800 mb-6">
            <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-blue-400" />
              Suggested Revision Topics
            </h3>
            <div className="flex flex-wrap gap-2">
              {result.suggestedRevisionTopics.map((t, i) => (
                <span key={i} className="px-3 py-1 bg-blue-500/10 border border-blue-500/20 rounded-lg text-blue-400 text-sm">
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="bg-zinc-900 rounded-2xl p-6 border border-zinc-800 mb-6">
          <p className="text-zinc-300 mb-2">{result.feedback}</p>
          <p className="text-zinc-400 text-sm">{result.recommendation}</p>
        </div>

        <div className="flex gap-4">
          <button onClick={() => { setStep('start'); setResult(null); setQuestions([]); }}
            className="flex-1 py-3 bg-zinc-800 rounded-xl text-white font-bold hover:bg-zinc-700 transition-all">
            Take Another
          </button>
          <button onClick={loadProfile}
            className="flex-1 py-3 bg-white text-black rounded-xl font-bold hover:bg-zinc-200 transition-all flex items-center justify-center gap-2">
            <BarChart3 className="w-4 h-4" />
            View Profile
          </button>
        </div>
      </div>
    );
  };

  const renderProfile = () => (
    <div className="max-w-2xl mx-auto">
      <div className="text-center mb-8">
        <BarChart3 className="w-10 h-10 text-white mx-auto mb-3" />
        <h1 className="text-3xl font-bold text-white mb-2">Assessment Profile</h1>
        {topic && <p className="text-zinc-500">{topic}</p>}
      </div>

      {result && result.readiness && (
        <div className="bg-zinc-900 rounded-2xl p-6 border border-zinc-800 mb-6">
          <h3 className="text-white font-semibold mb-3">Learning Readiness</h3>
          <div className="flex items-center gap-3 mb-4">
            <span className={`px-3 py-1 rounded-lg text-sm font-medium ${
              result.readiness === 'ready' ? 'bg-emerald-500/20 text-emerald-400' :
              result.readiness === 'needs_preparation' ? 'bg-yellow-500/20 text-yellow-400' :
              'bg-zinc-800 text-zinc-400'
            }`}>
              {result.readiness === 'ready' ? 'Ready to Learn' : result.readiness === 'needs_preparation' ? 'Needs Preparation' : 'Unknown'}
            </span>
            {result.currentLevel && (
              <span className="px-3 py-1 bg-zinc-800 rounded-lg text-zinc-300 text-sm">{result.currentLevel}</span>
            )}
          </div>
          {result.recommendations?.map((rec, i) => (
            <div key={i} className="flex items-start gap-3 py-2 border-b border-zinc-800 last:border-0">
              <div className={`w-2 h-2 rounded-full mt-1.5 ${
                rec.priority === 'high' ? 'bg-red-500' : 'bg-zinc-500'
              }`} />
              <div>
                <p className="text-zinc-300 text-sm">{rec.action}</p>
                <p className="text-zinc-600 text-xs capitalize">{rec.area}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {history?.assessments?.length > 0 && (
        <div className="bg-zinc-900 rounded-2xl p-6 border border-zinc-800">
          <h3 className="text-white font-semibold mb-4">Assessment History</h3>
          <div className="space-y-3">
            {history.assessments.slice(-10).reverse().map((a, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-zinc-800 last:border-0">
                <div>
                  <span className={`text-sm font-medium ${
                    a.level === 'Expert' ? 'text-emerald-400' :
                    a.level === 'Advanced' ? 'text-blue-400' :
                    a.level === 'Intermediate' ? 'text-yellow-400' :
                    'text-red-400'
                  }`}>{a.level}</span>
                  <span className="text-zinc-500 text-xs ml-2">
                    {new Date(a.createdAt || a.date).toLocaleDateString()}
                  </span>
                </div>
                <span className="text-white font-bold">{a.scorePercent}%</span>
              </div>
            ))}
          </div>
          {history.trend !== null && (
            <div className="mt-4 pt-4 border-t border-zinc-800 flex items-center gap-2">
              <TrendingUp className={`w-4 h-4 ${history.trend >= 0 ? 'text-emerald-400' : 'text-red-400'}`} />
              <span className={`text-sm ${history.trend >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {history.trend >= 0 ? '+' : ''}{history.trend}% trend
              </span>
            </div>
          )}
        </div>
      )}

      <button onClick={() => setStep('start')}
        className="mt-6 w-full py-3 bg-zinc-800 rounded-xl text-white font-bold hover:bg-zinc-700 transition-all">
        Back to Assessment
      </button>
    </div>
  );

  const renderBloom = () => (
    <div className="max-w-2xl mx-auto">
      <div className="text-center mb-8">
        <TrendingUp className="w-10 h-10 text-white mx-auto mb-3" />
        <h1 className="text-3xl font-bold text-white mb-2">Bloom's Taxonomy</h1>
        <p className="text-zinc-500">Cognitive level analysis across assessments</p>
      </div>

      {bloomData?.bloomLevels?.length > 0 ? (
        <div className="space-y-4">
          {bloomData.bloomLevels.map((item, i) => (
            <div key={i} className="bg-zinc-900 rounded-2xl p-5 border border-zinc-800">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-white font-semibold capitalize">{BLOOM_LABELS[item.level] || item.level}</h3>
                <span className={`text-lg font-bold ${
                  item.averageScore >= 80 ? 'text-emerald-400' :
                  item.averageScore >= 50 ? 'text-yellow-400' :
                  'text-red-400'
                }`}>{item.averageScore}%</span>
              </div>
              <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden mb-2">
                <div className={`h-full rounded-full ${
                  item.averageScore >= 80 ? 'bg-emerald-500' :
                  item.averageScore >= 50 ? 'bg-yellow-500' :
                  'bg-red-500'
                }`} style={{ width: `${item.averageScore}%` }} />
              </div>
              <div className="flex justify-between text-xs text-zinc-600">
                <span>Best: {item.highestScore}%</span>
                <span>{item.assessmentsAttempted} assessments</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-zinc-900 rounded-2xl p-8 border border-zinc-800 text-center">
          <p className="text-zinc-500">No assessment data yet. Complete a diagnostic to see Bloom's taxonomy breakdown.</p>
        </div>
      )}

      <div className="mt-6">
        <button onClick={() => setStep('start')}
          className="w-full py-3 bg-zinc-800 rounded-xl text-white font-bold hover:bg-zinc-700 transition-all">
          Back
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-black font-sans overflow-y-auto">
      <div className="max-w-4xl mx-auto p-6 pb-32">
        <button
          onClick={() => step === 'start' ? navigate(-1) : setStep('start')}
          className="flex items-center gap-2 text-zinc-500 hover:text-white transition-colors mb-6"
        >
          <ArrowLeft className="w-5 h-5" />
          <span>Back</span>
        </button>

        {loading && step === 'start' && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-white" />
          </div>
        )}

        {evaluating && (
          <div className="flex flex-col items-center justify-center py-32">
            <Loader2 className="w-10 h-10 animate-spin text-white mb-4" />
            <p className="text-zinc-400 text-lg">Evaluating your assessment...</p>
          </div>
        )}

        {step === 'start' && !loading && !evaluating && renderStart()}
        {step === 'taking' && !evaluating && renderQuestion()}
        {step === 'done' && !evaluating && renderResults()}
        {step === 'profile' && renderProfile()}
        {step === 'bloom' && renderBloom()}
      </div>
    </div>
  );
};

export default KnowledgeAssessmentPage;