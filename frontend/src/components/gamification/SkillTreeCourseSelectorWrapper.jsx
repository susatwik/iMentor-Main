import React, { useCallback, useState } from 'react';
import SkillTreeCourseSelector from './SkillTreeCourseSelector.jsx';

const SkillTreeCourseSelectorWrapper = ({ onContinue, isGenerating }) => {
  const [matchingResult, setMatchingResult] = useState(null);

  const handleValidatedCourse = useCallback(
    async ({ canonical, source }) => {
      if (!canonical) return;
      onContinue?.({ courseName: canonical, source });
    },
    [onContinue]
  );

  const handleMatchingResult = useCallback((res) => {
    setMatchingResult(res);

    if (!res) return;

    const extracted = Array.isArray(res.extractedTopics) ? res.extractedTopics : [];
    const matched = Array.isArray(res.matchedConcepts) ? res.matchedConcepts : [];

    const ignoreStructuralLabels = new Set([
      'module',
      'module 1',
      'module 2',
      'lecture number',
      'lecture topic',
      'subtopics',
      'week',
      'unit',
      'chapter',
      'topic',
      's.no',
      'sr no',
      'index',
      'number'
    ]);

    const isPureNumber = (s) => /^\d+$/.test(String(s || '').trim());

    const isEducationalCandidate = (s) => {
      const candidate = String(s || '').trim();
      if (!candidate) return { ok: false, candidate };
      if (isPureNumber(candidate)) return { ok: false, candidate };
      const lower = candidate.toLowerCase();
      if (ignoreStructuralLabels.has(lower)) return { ok: false, candidate };
      if (ignoreStructuralLabels.has(lower.replace(/\s+/g, ' '))) return { ok: false, candidate };
      return { ok: true, candidate };
    };

    const candidates = [...(Array.isArray(matched) ? matched : []), ...(Array.isArray(extracted) ? extracted : [])];

    let bestTopic = '';
    for (const raw of candidates) {
      const { ok, candidate } = isEducationalCandidate(raw);
      if (ok) {
        bestTopic = candidate;
        break;
      }
    }

    if (!bestTopic) return;

    onContinue?.({ courseName: bestTopic, source: 'database' });

  }, [onContinue]);

  return (
    <SkillTreeCourseSelector
      onValidatedCourse={handleValidatedCourse}
      onMatchingResult={handleMatchingResult}
      existingCourses={[]}
      isGenerating={isGenerating}
    />
  );
};

export default SkillTreeCourseSelectorWrapper;
