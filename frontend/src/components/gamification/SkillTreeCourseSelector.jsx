import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import toast from 'react-hot-toast';
import { Loader2, Upload, FileText, Search, AlertTriangle } from 'lucide-react';

const getBase = () => {
  const rawBase = import.meta.env.VITE_API_BASE_URL || '/api';
  return rawBase.endsWith('/') ? rawBase.slice(0, -1) : rawBase;
};

function normalizeLabel(v) {
  return String(v || '').trim();
}

const SkillTreeCourseSelector = ({
  onValidatedCourse,
  onMatchingResult,
  existingCourses = [],
  isGenerating = false,
}) => {
  const [courseMode, setCourseMode] = useState('database');
  const [courseValue, setCourseValue] = useState('');
  const [manualCourseValue, setManualCourseValue] = useState('');

  const [isValidating, setIsValidating] = useState(false);
  const [validationStatus, setValidationStatus] = useState(null);

  const [autocompleteQuery, setAutocompleteQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);

  const [csvText, setCsvText] = useState('');
  const [csvFileName, setCsvFileName] = useState(null);
  const [isUploadingCsv, setIsUploadingCsv] = useState(false);
  const fileInputRef = useRef(null);

  const base = useMemo(() => getBase(), []);

  const currentCourseName = courseMode === 'other' ? manualCourseValue : courseValue;

  const authHeaders = useMemo(() => {
    const token = localStorage.getItem('authToken');
    return { Authorization: `Bearer ${token}` };
  }, [base]);

  useEffect(() => {
    setValidationStatus(null);
    onValidatedCourse?.({ canonical: null });
  }, [courseMode]);

  useEffect(() => {
    setValidationStatus(null);
    onValidatedCourse?.({ canonical: null });
  }, [currentCourseName]);

  const fetchSuggestions = async (q) => {
    const query = String(q || '').trim();
    if (query.length < 3) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    try {
      setLoadingSuggestions(true);
      const res = await axios.get(
        `${base}/gamification/skill-tree/course-matching/autocomplete`,
        {
          params: { q: query },
          headers: authHeaders
        }
      );
      const next = res?.data?.suggestions || [];
      setSuggestions(next);
      setShowSuggestions(true);
    } catch (e) {
      console.error('[SkillTreeCourseSelector] autocomplete failed', e);
      toast.error('Failed to load suggestions');
      setSuggestions([]);
      setShowSuggestions(false);
    } finally {
      setLoadingSuggestions(false);
    }
  };

  useEffect(() => {
    const q = autocompleteQuery;
    const t = setTimeout(() => {
      fetchSuggestions(q);
    }, 180);
    return () => clearTimeout(t);
  }, [autocompleteQuery]);

  useEffect(() => {
    const onDocClick = (e) => {
      const target = e.target;
      if (!target) return;
      if (String(target.getAttribute?.('data-suggestion-root')) === 'true') return;
      setShowSuggestions(false);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  const validateCourse = async () => {
    const courseName = normalizeLabel(currentCourseName);
    if (!courseName) {
      setValidationStatus(null);
      onValidatedCourse?.({ canonical: null });
      return;
    }

    try {
      setIsValidating(true);
      const res = await axios.post(
        `${base}/gamification/skill-tree/course-matching/validate`,
        { courseName },
        { headers: authHeaders }
      );

      const status = res?.data?.status;
      const canonical = res?.data?.canonical || null;
      const nextSuggestions = res?.data?.suggestions || [];

      setValidationStatus({ status, canonical, suggestions: nextSuggestions });

      if (status === 'exact' || status === 'alias') {
        onValidatedCourse?.({ canonical: canonical || courseName, source: courseMode });
        return;
      }

      onValidatedCourse?.({ canonical: null, source: courseMode });
    } catch (e) {
      console.error('[SkillTreeCourseSelector] validate failed', e);
      toast.error('Course validation failed');
      setValidationStatus({ status: 'error', canonical: null, suggestions: [] });
      onValidatedCourse?.({ canonical: null, source: courseMode });
    } finally {
      setIsValidating(false);
    }
  };

  const handleChooseSuggestion = (item) => {
    const label = normalizeLabel(item?.value || item?.label);
    if (!label) return;
    setCourseValue(label);
    setAutocompleteQuery(label);
    setShowSuggestions(false);
    const canonical = label;
    setValidationStatus({ status: 'exact', canonical, suggestions: [] });
    onValidatedCourse?.({ canonical, source: 'database' });
  };

  const handleUploadCsv = async () => {
    if (!csvText || !csvText.trim()) {
      toast.error('Upload CSV first');
      return;
    }

    try {
      setIsUploadingCsv(true);

      const existingCourseNames = (existingCourses || []).map(c => normalizeLabel(c));
      const existingSkillTreeTopics = [];

      const payload = {
        uploadedFileName: csvFileName,
        csvText,
        existingCourseNames,
        existingSkillTreeTopics: existingSkillTreeTopics,
        courseName: normalizeLabel(currentCourseName),
        topic: normalizeLabel(currentCourseName),
      };

      const res = await axios.post(
        `${base}/gamification/skill-tree/course-matching/upload`,
        payload,
        { headers: { ...authHeaders, 'Content-Type': 'application/json' } }
      );

      onMatchingResult?.(res?.data || null);

      if (res?.data?.reusedSkillTreeDecision === 'reuse_existing') {
        toast.success('Existing skill tree/concepts found. Reusing available content.');
      } else {
        toast(res?.data?.matchPercentage >= 80
          ? 'Existing skill tree/concepts found. Reusing available content.'
          : 'No sufficient match found. Continuing with normal skill tree generation.',
        { icon: '✨' });
      }
    } catch (e) {
      console.error('[FRONTEND CSV] upload failed', e);
      toast.error('CSV upload/matching failed');
      onMatchingResult?.(null);
    } finally {
      setIsUploadingCsv(false);
    }
  };

  const onFilePicked = async (file) => {
    if (!file) return;
    setCsvFileName(file.name);

    const text = await file.text();
    setCsvText(text);

    onMatchingResult?.({ reset: true });
  };

  return (
    <div className="bg-zinc-900 rounded-2xl p-8 border border-zinc-800 shadow-xl shadow-black/50">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-12 h-12 bg-zinc-800 rounded-xl flex items-center justify-center border border-zinc-700">
          <Search className="w-6 h-6 text-white" />
        </div>
        <div>
          <h3 className="text-xl font-bold text-white">Choose Your Course</h3>
          <p className="text-sm text-zinc-500">Search existing courses or upload your CSV syllabus</p>
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setCourseMode('database')}
            className={`flex-1 px-4 py-3 rounded-xl font-bold border transition-colors ${
              courseMode === 'database'
                ? 'bg-white text-black border-white'
                : 'bg-black/0 text-zinc-300 border-zinc-800 hover:bg-zinc-800'
            }`}
          >
            Available Courses
          </button>
          <button
            type="button"
            onClick={() => setCourseMode('other')}
            className={`flex-1 px-4 py-3 rounded-xl font-bold border transition-colors ${
              courseMode === 'other'
                ? 'bg-white text-black border-white'
                : 'bg-black/0 text-zinc-300 border-zinc-800 hover:bg-zinc-800'
            }`}
          >
            Other Course...
          </button>
        </div>

        {courseMode === 'database' ? (
          <div>
            {(autocompleteQuery || '').trim() && (
              <div className="mt-2 text-sm text-emerald-300 font-semibold">
                ✓ Selected: <span className="text-emerald-200">{autocompleteQuery}</span>
              </div>
            )}

            <div className="relative" data-suggestion-root="true">
              <input
                value={autocompleteQuery}
                onChange={(e) => setAutocompleteQuery(e.target.value)}
                onFocus={() => {
                  if ((autocompleteQuery || '').trim().length >= 3) setShowSuggestions(true);
                }}
                placeholder="Search available courses..."
                className="w-full px-5 py-4 bg-black border border-zinc-800 rounded-xl text-white placeholder-zinc-600 focus:outline-none focus:border-white focus:ring-1 focus:ring-white/20 transition-all text-lg font-medium"
              />

              {showSuggestions && (
                <div className="absolute z-50 left-0 right-0 mt-2 bg-zinc-950 border border-zinc-800 rounded-xl overflow-hidden">
                  {loadingSuggestions ? (
                    <div className="p-3 text-zinc-400 flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" /> Loading...
                    </div>
                  ) : suggestions.length === 0 ? (
                    <div className="p-3 text-zinc-500">No suggestions</div>
                  ) : (
                    suggestions.map((s, idx) => (
                      <button
                        key={`${s.type}-${s.value}-${idx}`}
                        type="button"
                        onClick={() => handleChooseSuggestion(s)}
                        className="w-full text-left px-4 py-3 hover:bg-zinc-800 border-b border-zinc-900/60 last:border-b-0"
                      >
                        <div className="text-white font-semibold truncate">{s.label}</div>
                        <div className="text-xs text-zinc-500 capitalize">{s.type}</div>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

          </div>
        ) : (
          <input
            value={manualCourseValue}
            onChange={(e) => setManualCourseValue(e.target.value)}
            placeholder="Enter Course Name"
            className="w-full px-5 py-4 bg-black border border-zinc-800 rounded-xl text-white placeholder-zinc-600 focus:outline-none focus:border-white focus:ring-1 focus:ring-white/20 transition-all text-lg font-medium"
          />
        )}

        <div className="flex gap-3">
          <button
            type="button"
            onClick={validateCourse}
            disabled={isValidating || !(currentCourseName || '').trim()}
            className="flex-1 px-5 py-3 bg-zinc-800 hover:bg-zinc-700 rounded-xl font-bold text-zinc-200 border border-zinc-700 transition-colors disabled:opacity-50"
          >
            {isValidating ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Validating...
              </span>
            ) : (
              'Validate Course'
            )}
          </button>

          <button
            type="button"
            onClick={() => {
              if (courseMode === 'other') {
                const name = (manualCourseValue || '').trim();
                if (!name) return;
                onValidatedCourse?.({ canonical: name, source: 'other' });
                return;
              }
              const canonical = (validationStatus?.canonical || autocompleteQuery || currentCourseName || '').trim();
              if (!canonical) return;
              onValidatedCourse?.({ canonical, source: 'database' });
            }}
            disabled={
              isValidating || isGenerating ||
              (courseMode === 'other'
                ? !(manualCourseValue || '').trim().length
                : !(autocompleteQuery || '').trim().length)
            }
            className="flex-1 px-5 py-3 bg-white hover:bg-zinc-200 rounded-xl font-bold text-black border border-white transition-colors disabled:opacity-50"
          >
            {isGenerating ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Generating...
              </span>
            ) : (
              'Continue'
            )}
          </button>
        </div>

        {validationStatus && (validationStatus.status === 'suggestions' || validationStatus.status === 'other') && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-400 mt-0.5" />
              <div>
                <p className="text-sm text-amber-100 font-medium mb-2">We need a valid course selection. Suggestions:</p>
                <div className="flex flex-wrap gap-2">
                  {(validationStatus.suggestions || []).map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="px-3 py-1 rounded-lg bg-black/40 hover:bg-black border border-zinc-700 text-zinc-200 text-sm"
                      onClick={() => {
                        setCourseMode('database');
                        setCourseValue(s);
                        setAutocompleteQuery(s);
                        setValidationStatus(null);
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="border-t border-zinc-800 pt-4" />

        <div>
          <div className="flex items-center gap-3 mb-3">
            <FileText className="w-5 h-5 text-white" />
            <h4 className="text-white font-bold">Upload CSV</h4>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => onFilePicked(e.target.files?.[0])}
            className="w-full text-zinc-400"
            disabled={isUploadingCsv}
          />

          <div className="mt-3 flex gap-3">
            <button
              type="button"
              onClick={handleUploadCsv}
              disabled={isUploadingCsv || !csvText.trim()}
              className="flex-1 px-5 py-3 bg-white hover:bg-zinc-200 rounded-xl font-bold text-black border border-white transition-colors disabled:opacity-50"
            >
              {isUploadingCsv ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> Matching...
                </span>
              ) : (
                <span className="inline-flex items-center gap-2">
                  <Upload className="w-4 h-4" /> Upload CSV
                </span>
              )}
            </button>
          </div>

          {csvFileName && (
            <div className="mt-3 text-sm text-zinc-500">
              Selected: <span className="text-zinc-300 font-mono">{csvFileName}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SkillTreeCourseSelector;
