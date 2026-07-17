// server/routes/skilltreeCourseMatchingAutocomplete.js
// Isolated route: 3-character autocomplete for course/topic search.

const express = require('express');
const router = express.Router();
const { softAuthMiddleware } = require('../middleware/authMiddleware');
// Backward-compat: if authMiddleware is mistakenly referenced, ensure it's defined

const fs = require('fs');
const path = require('path');

const COURSE_INDEX_PATH = path.join(__dirname, '..', '..', 'curriculum_reports', 'curriculum_inventory.json');

function safeReadJSON(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalize(q) {
  return String(q || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function prefixMatchScore(query, text) {
  // Simple score: prefix match > substring match > 0
  const nq = normalize(query);
  const nt = normalize(text);
  if (!nq || !nt) return 0;
  if (nt.startsWith(nq)) return 1;
  if (nt.includes(nq)) return 0.6;
  return 0;
}

router.get('/autocomplete', softAuthMiddleware, async (req, res) => {
  const q = req.query?.q;
  if (!q || String(q).trim().length < 3) {
    return res.json({ suggestions: [] });
  }

  const inventory = safeReadJSON(COURSE_INDEX_PATH, { courses: [] });

  const courseNames = Array.isArray(inventory?.courses) ? inventory.courses.map(c => c.courseName || c.name || '').filter(Boolean) : [];

  // Best-effort: also include masterTopicList topics if present
  const topicNames = Array.isArray(inventory?.masterTopicList)
    ? inventory.masterTopicList.slice(0, 500).map(x => x.topics?.[0] || x.normalized).filter(Boolean)
    : [];

  const all = [
    ...courseNames.map(name => ({ type: 'course', value: name })),
    ...topicNames.map(name => ({ type: 'topic', value: name })),
  ];

  const scored = all
    .map(item => ({
      ...item,
      score: prefixMatchScore(q, item.value),
    }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  res.json({ suggestions: scored.map(s => ({ type: s.type, label: s.value, value: s.value })) });
});

module.exports = router;

