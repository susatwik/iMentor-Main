import React, { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import SkillTreeCourseSelector from './SkillTreeCourseSelector.jsx';
import { Loader2, MapPin, CheckCircle2, ExternalLink, ArrowRight } from 'lucide-react';

const SkillTreeCourseSelectorWrapper = () => {
  const navigate = useNavigate();
  const [matchingResult, setMatchingResult] = useState(null);
  const [bestTopic, setBestTopic] = useState('');
  const [navigating, setNavigating] = useState(false);
  const [navPhase, setNavPhase] = useState('');

  const handleValidatedCourse = useCallback(
    ({ canonical, source }) => {
      if (!canonical) return;
      setBestTopic(canonical);
      navigate('/gamification/skill-tree', {
        state: { fromCsvUpload: true, topic: canonical, source: source || 'database' }
      });
    },
    [navigate]
  );

  const isEducationalCandidate = (s) => {
    const ignoreStructuralLabels = new Set([
      'module', 'module 1', 'module 2', 'lecture number', 'lecture topic',
      'subtopics', 'week', 'unit', 'chapter', 'topic', 's.no', 'sr no', 'index', 'number'
    ]);
    const candidate = String(s || '').trim();
    if (!candidate) return { ok: false, candidate };
    if (/^\d+$/.test(candidate)) return { ok: false, candidate };
    const lower = candidate.toLowerCase();
    if (ignoreStructuralLabels.has(lower)) return { ok: false, candidate };
    if (ignoreStructuralLabels.has(lower.replace(/\s+/g, ' '))) return { ok: false, candidate };
    return { ok: true, candidate };
  };

  const getBestTopic = (res) => {
    const extracted = Array.isArray(res.extractedTopics) ? res.extractedTopics : [];
    const matched = Array.isArray(res.matchedConcepts) ? res.matchedConcepts : [];
    const candidates = [...matched, ...extracted];
    for (const raw of candidates) {
      const { ok, candidate } = isEducationalCandidate(raw);
      if (ok) return candidate;
    }
    return '';
  };

  const handleMatchingResult = useCallback((res) => {
    if (!res || res.reset) {
      setMatchingResult(null);
      setBestTopic('');
      return;
    }

    setMatchingResult(res);
    const topic = getBestTopic(res);
    setBestTopic(topic);

    if (!topic) return;

    const isReuse = res.reusedSkillTreeDecision === 'reuse_existing';

    if (isReuse) {
      setNavPhase('detecting');
      setNavigating(true);

      setTimeout(() => {
        setNavPhase('loading');
        setTimeout(() => {
          setNavPhase('restoring');
          setTimeout(() => {
            navigate('/gamification/skill-tree', {
              state: { fromCsvUpload: true, topic, reuseExisting: true }
            });
          }, 600);
        }, 500);
      }, 400);
    }
  }, [navigate]);

  const handleContinueToNew = () => {
    if (!bestTopic || !matchingResult) return;
    setNavigating(true);
    const isReuse = matchingResult.reusedSkillTreeDecision === 'reuse_existing';
    setNavPhase(isReuse ? 'loading' : 'preparing');
    setTimeout(() => {
      navigate('/gamification/skill-tree', {
        state: { fromCsvUpload: true, topic: bestTopic, reuseExisting: isReuse }
      });
    }, 300);
  };

  if (navigating) {
    return (
      <div className="min-h-screen bg-black p-6 font-sans flex items-center justify-center">
        <div className="max-w-md w-full text-center">
          <div className="w-20 h-20 bg-zinc-900 rounded-full flex items-center justify-center mx-auto mb-6 border border-zinc-800">
            {navPhase === 'detecting' && <Loader2 className="w-10 h-10 text-white animate-spin" />}
            {navPhase === 'loading' && <MapPin className="w-10 h-10 text-emerald-400 animate-pulse" />}
            {navPhase === 'restoring' && <CheckCircle2 className="w-10 h-10 text-emerald-400" />}
            {navPhase === 'preparing' && <Loader2 className="w-10 h-10 text-white animate-spin" />}
          </div>
          <h3 className="text-xl font-bold text-white mb-2">
            {navPhase === 'detecting' && 'Checking existing skill tree...'}
            {navPhase === 'loading' && 'Loading existing skill tree...'}
            {navPhase === 'restoring' && 'Restoring your progress...'}
            {navPhase === 'preparing' && 'Preparing your adventure...'}
          </h3>
          <p className="text-zinc-500 text-sm">
            {navPhase === 'detecting' && 'Found existing course content in the system'}
            {navPhase === 'loading' && 'Fetching your skill tree and game data'}
            {navPhase === 'restoring' && 'Reloading completed levels, stars, and progress'}
            {navPhase === 'preparing' && 'Setting up your learning journey'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black p-6 font-sans">
      <div className="max-w-2xl mx-auto">
        <div className="mb-6">
          <button
            onClick={() => navigate('/gamification/skill-tree')}
            className="flex items-center gap-2 text-zinc-500 hover:text-white transition-colors mb-6 hover:-translate-x-1"
          >
            <ArrowRight className="w-5 h-5 rotate-180" />
            <span>Back to Games</span>
          </button>
        </div>

        <SkillTreeCourseSelector
          onValidatedCourse={handleValidatedCourse}
          onMatchingResult={handleMatchingResult}
          existingCourses={[]}
        />

        {matchingResult && bestTopic && (
          <div className="mt-6 bg-zinc-900 rounded-2xl p-6 border border-zinc-800 shadow-xl shadow-black/50">
            <div className="flex items-center gap-3 mb-4">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                matchingResult.reusedSkillTreeDecision === 'reuse_existing'
                  ? 'bg-emerald-500/20 border border-emerald-500/30'
                  : 'bg-zinc-800 border border-zinc-700'
              }`}>
                {matchingResult.reusedSkillTreeDecision === 'reuse_existing'
                  ? <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                  : <MapPin className="w-5 h-5 text-white" />
                }
              </div>
              <div>
                <h3 className="text-lg font-bold text-white">
                  {matchingResult.reusedSkillTreeDecision === 'reuse_existing'
                    ? 'Existing Skill Tree Found'
                    : 'New Course Detected'
                  }
                </h3>
                <p className="text-sm text-zinc-500">
                  {matchingResult.reusedSkillTreeDecision === 'reuse_existing'
                    ? `"${bestTopic}" already has skill tree content (${matchingResult.matchPercentage}% match)`
                    : `"${bestTopic}" — will generate new skill tree content`
                  }
                </p>
              </div>
            </div>

            <div className="bg-black border border-zinc-800 rounded-xl p-4 mb-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-zinc-500">Course</span>
                <span className="text-white font-bold">{bestTopic}</span>
              </div>
              {matchingResult.matchPercentage > 0 && (
                <div className="flex items-center justify-between text-sm mt-2">
                  <span className="text-zinc-500">Match</span>
                  <span className="text-emerald-400 font-bold">{matchingResult.matchPercentage}%</span>
                </div>
              )}
              {matchingResult.extractedTopics && matchingResult.extractedTopics.length > 0 && (
                <div className="flex items-center justify-between text-sm mt-2">
                  <span className="text-zinc-500">Topics</span>
                  <span className="text-zinc-300">{matchingResult.extractedTopics.length} extracted</span>
                </div>
              )}
            </div>

            <button
              onClick={handleContinueToNew}
              disabled={navigating}
              className="w-full px-6 py-4 bg-white hover:bg-zinc-200 rounded-xl font-bold text-black transition-all flex items-center justify-center gap-3 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {matchingResult.reusedSkillTreeDecision === 'reuse_existing' ? (
                <>
                  <MapPin className="w-5 h-5" />
                  Open Skill Tree
                  <ExternalLink className="w-4 h-4" />
                </>
              ) : (
                <>
                  <MapPin className="w-5 h-5" />
                  Start Skill Tree Journey
                  <ArrowRight className="w-5 h-5" />
                </>
              )}
            </button>

            {matchingResult.reusedSkillTreeDecision === 'reuse_existing' && (
              <p className="text-xs text-zinc-600 text-center mt-3">
                Your existing progress (completed levels, stars, XP) will be restored automatically
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default SkillTreeCourseSelectorWrapper;
