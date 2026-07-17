// server/services/skilltreeCourseMatchingService.js
// Topic extraction + matching for SkillTree course selection enhancements.

const { parse } = require('csv-parse/sync');
const SkillTreeCsvUploadSnapshot = require('../models/SkillTreeCsvUploadSnapshot');

const INVALID_SNAPSHOT_CANONICAL = new Set([
  'module',
  'lecture topic',
  'subtopics',
  'module 1',
  'module 2',
  'module 3',
  'module 4',
]);

function normalizeText(s) {
  return String(s || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

function tokenize(s) {
  return normalizeText(s)
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) {
    if (B.has(x)) inter++;
  }
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Metadata/header rows that are never real curriculum lecture topics.
const METADATA_TOPIC_RE = [
  /^module\s*\d*$/i,
  /^unit\s*\d*$/i,
  /^lecture\s*(number|topic|#|\d+)?$/i,
  /^subtopics?$/i,
  /^sl\.?\s*no\.?$/i,
  /^s\.?\s*no\.?$/i,
  /^topic\s*(name)?$/i,
  /^(review|tutorial|exercises?|case\s*stud(y|ies)|lab|assignment|quiz|exam|test)$/i,
  /module\s*\d+\s*review/i,
  /course\s*wrap[- ]?up/i,
  /^\d{1,3}$/,
  /^[ivxlcdm]+$/i,
];

function isMetadataTopic(str) {
  const t = String(str || '').trim();
  if (!t || t.length < 3) return true;
  if (INVALID_SNAPSHOT_CANONICAL.has(normalizeText(t))) return true;
  return METADATA_TOPIC_RE.some(re => re.test(t));
}

function isCurriculumTopic(str) {
  return !isMetadataTopic(str);
}

function isInvalidSnapshotCanonical(str) {
  const t = normalizeText(str);
  return !t || isMetadataTopic(str) || INVALID_SNAPSHOT_CANONICAL.has(t);
}

function firstRealCurriculumTopic(extractedTopics = []) {
  for (const t of (extractedTopics || [])) {
    const trimmed = String(t || '').trim();
    if (trimmed && isCurriculumTopic(trimmed)) return trimmed;
  }
  return '';
}

function parseCsvRows(csvText) {
  return parse(String(csvText || ''), {
    columns: false,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    bom: true,
  });
}

function detectLectureTopicColumnIndex(headerRow = []) {
  const header = headerRow.map(h => normalizeText(h));
  const TOPIC_ALIASES = ['lecture topic', 'topic', 'lecture', 'topic name', 'lecture title', 'title', 'subtopic', 'concept', 'lesson'];

  // Try exact matches first
  for (const alias of TOPIC_ALIASES) {
    const na = normalizeText(alias);
    const idx = header.findIndex(h => h === na);
    if (idx !== -1) return idx;
  }

  // Fuzzy: contains match
  for (const alias of TOPIC_ALIASES) {
    const na = normalizeText(alias);
    const idx = header.findIndex(h => h.includes(na) || na.includes(h));
    if (idx !== -1) return idx;
  }

  // Standard syllabus shape: Module, Lecture Number, Lecture Topic, Subtopics
  if (headerRow.length >= 3) return 2;
  return -1;
}

function normalizeHeader(value) {
  return normalizeText(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const HEADER_ALIASES_MAP = {
  'course': ['course', 'course name', 'course title', 'subject', 'class'],
  'module': ['module', 'mod', 'unit', 'chapter', 'section', 'week', 'module name'],
  'topic': ['topic', 'lecture topic', 'lecture', 'topic name', 'lesson', 'title', 'lecture title'],
  'concept': ['concept', 'subtopic', 'sub topic', 'sub-topic', 'subtopic name', 'detail', 'description', 'subtopic details'],
  'difficulty': ['difficulty', 'level', 'difficult', 'diff', 'complexity', 'tier', 'bloom', 'blooms', 'bloom level'],
};

function findHeaderColumnIndex(row, aliases) {
  const normalized = row.map(normalizeHeader);
  for (const alias of aliases) {
    const idx = normalized.findIndex(h => h === normalizeHeader(alias));
    if (idx !== -1) return idx;
  }
  // Fuzzy: any header that contains a key alias word
  for (const alias of aliases) {
    const a = normalizeHeader(alias);
    const idx = normalized.findIndex(h => h.includes(a) || a.includes(h));
    if (idx !== -1) return idx;
  }
  return -1;
}

function validateCsvUploadStructure(csvText) {
  const rows = parseCsvRows(csvText);
  if (!rows.length) {
    return {
      validRows: 0,
      invalidRows: 0,
      duplicates: [],
      warnings: ['CSV is empty'],
      rows: []
    };
  }

  const headerRow = Array.isArray(rows[0]) ? rows[0] : [];
  const headers = headerRow.map(normalizeHeader);
  console.log('[CSV VALIDATE] raw headers:', headerRow);
  console.log('[CSV VALIDATE] normalized headers:', headers);

  // Detect columns using aliases (not strict required list)
  const detectedColumns = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES_MAP)) {
    const idx = findHeaderColumnIndex(headerRow, aliases);
    if (idx !== -1) detectedColumns[key] = idx;
  }
  console.log('[CSV VALIDATE] detected columns:', detectedColumns);

  const duplicates = [];
  const warnings = [];
  const seenRows = new Set();
  let validRows = 0;
  let invalidRows = 0;

  const topicColIdx = detectedColumns['topic'] ?? detectedColumns['concept'] ?? -1;
  const diffColIdx = detectedColumns['difficulty'] ?? -1;

  if (topicColIdx === -1) {
    warnings.push('No topic/concept column detected — treating all non-header cells as potential topics');
  }

  for (let i = 1; i < rows.length; i += 1) {
    const row = Array.isArray(rows[i]) ? rows[i] : [];
    const rowText = row.map(normalizeText).join('|');
    if (!rowText.replace(/\|/g, '').trim()) {
      continue;
    }

    if (seenRows.has(rowText)) {
      duplicates.push({ rowIndex: i + 1, row });
      invalidRows += 1;
      continue;
    }
    seenRows.add(rowText);

    // Try to find a topic cell
    const topicCell = topicColIdx >= 0 && topicColIdx < row.length ? String(row[topicColIdx] || '').trim() : '';
    const hasTopic = topicCell.length > 0 || row.some(cell => isCurriculumTopic(cell));

    if (!hasTopic) {
      warnings.push(`Row ${i + 1} has no curriculum topic`);
      invalidRows += 1;
      continue;
    }

    if (diffColIdx >= 0 && diffColIdx < row.length) {
      const diffCell = normalizeText(String(row[diffColIdx] || ''));
      if (diffCell && !['easy', 'medium', 'hard', 'beginner', 'intermediate', 'advanced', 'expert'].includes(diffCell)) {
        warnings.push(`Row ${i + 1} has unrecognized difficulty: "${row[diffColIdx]}"`);
      }
    }

    validRows += 1;
  }

  return {
    validRows,
    invalidRows,
    duplicates,
    warnings,
    rows,
    detectedColumns,
    headerCount: headers.length
  };
}

function estimateTopicMatchPercentage({ extractedTopics = [], candidateNames = [] }) {
  const extracted = uniq(extractedTopics.map(normalizeText).filter(Boolean));
  const candidates = uniq(candidateNames.map(normalizeText).filter(Boolean));
  if (extracted.length === 0 || candidates.length === 0) return 0;

  let bestTotal = 0;
  for (const t of extracted) {
    const tt = tokenize(t);
    let best = 0;
    for (const c of candidates) {
      const cc = tokenize(c);
      const score = jaccard(tt, cc);
      best = Math.max(best, score);
    }
    bestTotal += best;
  }

  const avg = bestTotal / extracted.length;
  return Math.round(avg * 1000) / 10;
}

async function extractTopicsFromCsvText(csvText) {
  const rows = parseCsvRows(csvText);
  if (!rows.length) return [];

  const topicColIdx = detectLectureTopicColumnIndex(rows[0]);
  if (topicColIdx < 0) return [];

  const topics = [];
  const seen = new Set();

  for (let rowIdx = 1; rowIdx < rows.length; rowIdx += 1) {
    const row = rows[rowIdx];
    if (!Array.isArray(row) || row.length <= topicColIdx) continue;

    const lectureTopic = String(row[topicColIdx] || '').trim();
    if (!lectureTopic || !isCurriculumTopic(lectureTopic)) continue;

    const key = normalizeText(lectureTopic);
    if (seen.has(key)) continue;
    seen.add(key);
    topics.push(lectureTopic);
  }

  return topics;
}

function topicOverlapRatio(topicsA = [], topicsB = []) {
  const a = new Set(
    (topicsA || []).filter(isCurriculumTopic).map(t => normalizeText(t)).filter(Boolean)
  );
  const b = new Set(
    (topicsB || []).filter(isCurriculumTopic).map(t => normalizeText(t)).filter(Boolean)
  );
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const key of a) {
    if (b.has(key)) overlap += 1;
  }
  return overlap / Math.max(a.size, b.size);
}


function cleanCurriculumTopics(extractedTopics = []) {
  const seen = new Set();
  return (extractedTopics || [])
    .filter(isCurriculumTopic)
    .filter(t => {
      const key = normalizeText(t);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function estimateSnapshotReusePercentage({ cleanedTopics = [], priorSnapshots = [] }) {
  const current = cleanCurriculumTopics(cleanedTopics);
  if (current.length === 0 || priorSnapshots.length === 0) return 0;

  const priorPool = new Set();
  for (const snap of priorSnapshots) {
    for (const t of cleanCurriculumTopics(snap.extractedTopics || [])) {
      priorPool.add(normalizeText(t));
    }
  }
  if (priorPool.size === 0) return 0;

  let matched = 0;
  for (const t of current) {
    if (priorPool.has(normalizeText(t))) matched += 1;
  }
  return Math.round((matched / current.length) * 100);
}

async function matchUploadedCsvToPriorSnapshots({ userId, extractedTopics = [] }) {
  if (!userId) {
    return { matchPercentage: 0, matchedConcepts: [], priorSnapshotCount: 0 };
  }

  const cleanedTopics = cleanCurriculumTopics(extractedTopics);
  const canonicalTopic = firstRealCurriculumTopic(cleanedTopics);

  const priorSnapshots = await SkillTreeCsvUploadSnapshot.find({ userId })
    .sort({ createdAt: -1 })
    .lean();

  const relevantPrior = priorSnapshots.filter(snap => {
    const snapCanonical = normalizeText(snap.canonicalTopic || firstRealCurriculumTopic(snap.extractedTopics || []));
    const requested = normalizeText(canonicalTopic);

    // overlap debug (per required diagnostics)
    const uploadedTopics = cleanedTopics || [];
    const snapshotTopics = snap.extractedTopics || [];
    const commonTopics = Array.from(new Set(
      uploadedTopics
        .map(normalizeText)
        .filter(Boolean)
        .filter(t => topicOverlapRatio([t], snapshotTopics) > 0)
    ));
    const overlapRatio = topicOverlapRatio(uploadedTopics, snapshotTopics);

    // NOTE: matchedSnapshot is computed as overlapRatio-based inclusion (not canonical-only)
    const matchedSnapshot = overlapRatio >= 0.5;

    console.log('[OVERLAP DEBUG]', {
      uploadedTopicCount: uploadedTopics.length,
      snapshotTopicCount: snapshotTopics.length,
      commonTopics: commonTopics.slice(0, 20),
      overlapRatio,
      matchedSnapshot,
      snapId: snap._id?.toString?.() || undefined,
      snapCanonical,
      requested
    });

    if (!requested || !snapCanonical) return true;
    return snapCanonical === requested
      || snapCanonical.includes(requested)
      || requested.includes(snapCanonical)
      || matchedSnapshot;
  });



  const matchPercentage = estimateSnapshotReusePercentage({
    cleanedTopics,
    priorSnapshots: relevantPrior
  });

  // Validate reuse against full syllabus characteristics (no algorithmic new features; tighten reuse criteria)
  // Reuse only if:
  // 1) Canonical topic match (requested canonical vs snapshot canonical)
  // 2) overlapPercentage >= 90
  // 3) topic count difference <= 10%

  // Compute overlapPercentage / topicCountDifferencePercent using the best (most overlapping) prior snapshot.
  const uploadedTopics = cleanedTopics || [];
  const snapshotCandidatesForReuse = relevantPrior || [];

  let best = null;
  for (const snap of snapshotCandidatesForReuse) {
    const snapCanonical = normalizeText(snap.canonicalTopic || firstRealCurriculumTopic(snap.extractedTopics || []));
    const requested = normalizeText(canonicalTopic);
    const canonicalMatch = Boolean(canonicalTopic) && Boolean(snapCanonical) && (
      snapCanonical === requested ||
      snapCanonical.includes(requested) ||
      requested.includes(snapCanonical)
    );

    const snapshotTopics = snap.extractedTopics || [];
    const overlapPercentage = Math.round(topicOverlapRatio(uploadedTopics, snapshotTopics) * 100);

    const uploadedTopicCount = cleanCurriculumTopics(uploadedTopics).length;
    const snapshotTopicCount = cleanCurriculumTopics(snapshotTopics).length;

    const topicCountDifferencePercent = (() => {
      const denom = Math.max(uploadedTopicCount, snapshotTopicCount) || 1;
      return Math.abs(uploadedTopicCount - snapshotTopicCount) / denom;
    })();

    const reuseDecision = canonicalMatch && overlapPercentage >= 90 && topicCountDifferencePercent <= 0.10;

    console.log('[REUSE VALIDATION]', {
      uploadedTopicCount,
      snapshotTopicCount,
      overlapPercentage,
      topicCountDifferencePercent,
      reuseDecision
    });

    if (!best || overlapPercentage > best.overlapPercentage) {
      best = { reuseDecision, overlapPercentage };
    }

    // If already decided true for some snapshot, we can still keep best for logging; reuseDecision drives outcome.
  }

  const reuseDecisionFinal = best ? best.reuseDecision : false;

  const matchedConcepts = reuseDecisionFinal && canonicalTopic
    ? [canonicalTopic]
    : [];

  // Build snapshot topic pool for individual-topic matching
  const snapshotPool = new Set();
  for (const snap of relevantPrior) {
    for (const t of cleanCurriculumTopics(snap.extractedTopics || [])) {
      snapshotPool.add(normalizeText(t));
    }
  }
  const snapshotPoolMatchedTopics = cleanedTopics.filter(t => snapshotPool.has(normalizeText(t)));


  return {
    matchPercentage,
    matchedConcepts,
    snapshotPoolMatchedTopics,
    priorSnapshotCount: relevantPrior.length,
    cleanedTopics
  };
}

async function getCandidateCourseNames({ skillTrees = [] } = {}) {
  const names = [];
  for (const st of (skillTrees || [])) {
    if (st?.topic) names.push(st.topic);
    if (st?.name) names.push(st.name);
    if (st?.course) names.push(st.course);
    if (Array.isArray(st?.relatedTopics)) names.push(...st.relatedTopics);
    if (Array.isArray(st?.category)) names.push(...st.category);
  }
  return uniq(names);
}

async function matchUploadedCsvToExistingTopics({
  csvText,
  existingCourseNames = [],
  existingSkillTreeTopics = [],
  userId = null,
} = {}) {
  const extractedTopics = await extractTopicsFromCsvText(csvText);
  const cleanedTopics = cleanCurriculumTopics(extractedTopics);

  const candidateNames = uniq([
    ...(existingCourseNames || []),
    ...(existingSkillTreeTopics || []),
  ]);

  const catalogMatchPercentage = estimateTopicMatchPercentage({
    extractedTopics: cleanedTopics,
    candidateNames,
  });

  let bestCandidate = null;
  let bestScore = -1;
  const extracted = cleanedTopics.map(normalizeText).filter(Boolean);
  for (const cand of candidateNames) {
    const cc = tokenize(cand);
    let candBest = 0;
    for (const t of extracted) {
      const tt = tokenize(t);
      candBest = Math.max(candBest, jaccard(tt, cc));
    }
    if (candBest > bestScore) {
      bestScore = candBest;
      bestCandidate = cand;
    }
  }

  const snapshotMatch = await matchUploadedCsvToPriorSnapshots({
    userId,
    extractedTopics: cleanedTopics
  });

  // Build individually matched topic names (union of catalog + snapshot pool)
  const allMatchedMap = new Map();

  // Snapshot pool matches (exact normalized-text match)
  for (const topic of (snapshotMatch.snapshotPoolMatchedTopics || [])) {
    allMatchedMap.set(normalizeText(topic), topic);
  }

  // Catalog matches (any Jaccard token overlap > 0 with a candidate)
  const normalizedCandidates = candidateNames.map(c => normalizeText(c));
  for (const topic of cleanedTopics) {
    const normalized = normalizeText(topic);
    if (!allMatchedMap.has(normalized)) {
      const hasCatalogMatch = normalizedCandidates.some(c => {
        return jaccard(tokenize(normalized), tokenize(c)) > 0;
      });
      if (hasCatalogMatch) {
        allMatchedMap.set(normalized, topic);
      }
    }
  }

  const matchedConcepts = Array.from(allMatchedMap.values());
  const matchPercentage = cleanedTopics.length > 0
    ? Math.round((matchedConcepts.length / cleanedTopics.length) * 100)
    : 0;

  const matchedCandidate = snapshotMatch.matchedConcepts[0] || bestCandidate;
  const reused = matchPercentage >= 80;

  console.log('[MATCH_PERCENT_DEBUG]', {
    uploadedTopics: cleanedTopics.length,
    matchedConcepts: matchedConcepts.length,
    matchedConceptNames: matchedConcepts.slice(0, 20),
    matchPercentage,
    reuseDecision: reused ? 'reuse_existing' : 'generate_new',
    snapshotPoolSize: (snapshotMatch.snapshotPoolMatchedTopics || []).length,
    catalogMatchPercentage
  });


  return {
    extractedTopics: cleanedTopics.length > 0 ? cleanedTopics : extractedTopics,
    matchedCandidate,
    matchedConcepts,
    matchPercentage,
    reusedSkillTreeDecision: reused ? 'reuse_existing' : 'generate_new',
    cleanedTopics,
    snapshotMatchPercentage: snapshotMatch.matchPercentage,
    catalogMatchPercentage
  };
}

module.exports = {
  extractTopicsFromCsvText,
  estimateTopicMatchPercentage,
  matchUploadedCsvToExistingTopics,
  matchUploadedCsvToPriorSnapshots,
  validateCsvUploadStructure,
  cleanCurriculumTopics,
  isMetadataTopic,
  isCurriculumTopic,
  isInvalidSnapshotCanonical,
  firstRealCurriculumTopic,
  topicOverlapRatio,
};
