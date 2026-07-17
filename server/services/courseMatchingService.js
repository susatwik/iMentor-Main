// server/services/courseMatchingService.js
// Compatibility wrapper for the restored course matching route set.
// Master already owns the real CSV/topic matching logic in
// skilltreeCourseMatchingService.js, so we re-export that behavior here
// under the legacy service name expected by the imported route files.

const skilltreeCourseMatchingService = require('./skilltreeCourseMatchingService');

function normalizeCourseName(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeCourseRecord(course) {
  if (!course) return { name: '', aliases: [] };
  return {
    name: course.name || course.courseName || '',
    aliases: Array.isArray(course.aliases) ? course.aliases : [],
    raw: course.raw || course,
  };
}

function findExactMatch({ courseName, courses = [] } = {}) {
  const target = normalizeCourseName(courseName);
  if (!target) return null;

  for (const course of courses) {
    const normalized = normalizeCourseName(course?.name || course?.courseName);
    if (normalized && normalized === target) {
      return normalizeCourseRecord(course);
    }
  }

  return null;
}

function findAliasMatch({ courseName, courses = [] } = {}) {
  const target = normalizeCourseName(courseName);
  if (!target) return null;

  for (const course of courses) {
    const aliases = Array.isArray(course?.aliases) ? course.aliases : [];
    for (const alias of aliases) {
      if (normalizeCourseName(alias) === target) {
        return normalizeCourseRecord(course);
      }
    }
  }

  return null;
}

function shouldReuseSkillTree({
  matchPercentage = 0,
  overlapPercentage = 0,
  topicCountDifferencePercent = 1,
  canonicalMatch = false,
} = {}) {
  return Boolean(canonicalMatch && overlapPercentage >= 90 && topicCountDifferencePercent <= 0.10)
    || matchPercentage >= 80;
}

module.exports = {
  ...skilltreeCourseMatchingService,
  normalizeCourseName,
  findExactMatch,
  findAliasMatch,
  shouldReuseSkillTree,
};
