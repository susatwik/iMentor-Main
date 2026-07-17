// server/routes/skilltreeCourseMatchingValidate.js
// Isolated route: validate a course name + provide suggestions.

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const log = require('../utils/logger');
const fs = require('fs');
const path = require('path');

const COURSE_INDEX_PATH = path.join(__dirname, '..', '..', 'curriculum_reports', 'curriculum_inventory.json');

const {
  normalizeCourseName,
  findExactMatch,
  findAliasMatch,
  shouldReuseSkillTree,
} = require('../services/courseMatchingService');

function safeReadJSON(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

router.post('/validate', authMiddleware, async (req, res) => {
  const courseName = req.body?.courseName;
  if (!courseName || !String(courseName).trim()) {
    return res.status(400).json({ message: 'courseName is required' });
  }

  const qNorm = normalizeCourseName(courseName);

  const inventory = safeReadJSON(COURSE_INDEX_PATH, { courses: [] });

  // inventory.courses from generate_curriculum_reports.js is array of { file? , courseName, ... }
  // It doesn't store aliases. We'll treat it as only exact match.
  const courses = (Array.isArray(inventory?.courses) ? inventory.courses : [])
    .map(c => ({
      name: c.courseName || c.name,
      aliases: c.aliases || [],
      raw: c,
    }));

  const exact = findExactMatch({ courseName: qNorm, courses: courses.map(c => ({ name: c.name, aliases: c.aliases })) });
  if (exact) {
    return res.json({ status: 'exact', canonical: exact.name, suggestions: [] });
  }

  const alias = findAliasMatch({ courseName: qNorm, courses: courses.map(c => ({ name: c.name, aliases: c.aliases })) });
  if (alias) {
    return res.json({ status: 'alias', canonical: alias.name, suggestions: [] });
  }

  // Suggestions: prefix/substring heuristic
  const suggestions = courses
    .map(c => ({
      name: c.name,
      score: c.name
        ? (normalizeCourseName(c.name).startsWith(qNorm) ? 1 : (normalizeCourseName(c.name).includes(qNorm) ? 0.6 : 0))
        : 0,
    }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(x => x.name);

  res.json({ status: suggestions.length ? 'suggestions' : 'other', canonical: null, suggestions });
});

module.exports = router;

