const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { authMiddleware } = require('../middleware/authMiddleware');

const skilltreeCourseMatchingService = require('../services/skilltreeCourseMatchingService');
const SkillTreeCsvUploadSnapshot = require('../models/SkillTreeCsvUploadSnapshot');

const REPORT_DIR = path.join(__dirname, '..', '..', 'curriculum_reports');
const REPORT_PATH = path.join(REPORT_DIR, 'skilltree_course_matching_report.json');

// Ensure reports directory exists
try {
    if (!fs.existsSync(REPORT_DIR)) {
        fs.mkdirSync(REPORT_DIR, { recursive: true });
    }
} catch (e) {
    // Non-critical — directory may already exist
}

function writeReport(report) {
  try {
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  } catch (e) {
  }
}

router.post('/course-matching/upload', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?._id;

    let csvText = '';

    if (req.body?.csvText) {
      csvText = req.body.csvText;
    }

    if (!csvText && req.file?.buffer) {
      csvText = req.file.buffer.toString('utf8');
    } else if (!csvText && req.file?.path) {
      csvText = fs.readFileSync(req.file.path, 'utf8');
    }

    if (!csvText) {
      return res.status(400).json({ message: 'csvText or uploaded file is required' });
    }

    const existingCourseNames = Array.isArray(req.body?.existingCourseNames) ? req.body.existingCourseNames : [];
    const existingSkillTreeTopics = Array.isArray(req.body?.existingSkillTreeTopics) ? req.body.existingSkillTreeTopics : [];

    const match = await skilltreeCourseMatchingService.matchUploadedCsvToExistingTopics({
      csvText,
      existingCourseNames,
      existingSkillTreeTopics,
      userId,
    });
    const uploadValidation = skilltreeCourseMatchingService.validateCsvUploadStructure(csvText);

    if (uploadValidation.validRows === 0) {
      return res.status(400).json({
        message: 'CSV validation failed',
        uploadReport: {
          validRows: uploadValidation.validRows,
          invalidRows: uploadValidation.invalidRows,
          duplicates: uploadValidation.duplicates,
          warnings: uploadValidation.warnings
        }
      });
    }

    const extractedTopics = Array.isArray(match.extractedTopics) ? match.extractedTopics : [];
    const matchedConcepts = Array.isArray(match.matchedConcepts) && match.matchedConcepts.length > 0
      ? match.matchedConcepts
      : (match.matchedCandidate ? [match.matchedCandidate] : []);
    const matchPercentage = match.matchPercentage;
    const reusedSkillTreeDecision = match.reusedSkillTreeDecision;

    const report = {
      uploadedFileName: req.body?.uploadedFileName || null,
      extractedTopics,
      matchedConcepts,
      matchPercentage: match.matchPercentage,
      reusedSkillTreeDecision: match.reusedSkillTreeDecision,
      uploadReport: {
        validRows: uploadValidation.validRows,
        invalidRows: uploadValidation.invalidRows,
        duplicates: uploadValidation.duplicates,
        warnings: uploadValidation.warnings
      },
      meta: {
        userId,
        generatedAt: new Date().toISOString(),
        threshold: 80,
      }
    };

    try {
      const canonicalTopic = skilltreeCourseMatchingService.firstRealCurriculumTopic(extractedTopics);

      const courseNameAlias = (req.body?.courseName || req.body?.canonicalTopic || req.body?.topic || '').trim();
      const topicAliases = [...new Set([
        canonicalTopic,
        courseNameAlias,
        (req.body?.topic || '').trim(),
      ].filter(Boolean))];

      if (canonicalTopic && !skilltreeCourseMatchingService.isInvalidSnapshotCanonical(canonicalTopic)) {
        const snapshotPayload = {
          userId,
          canonicalTopic,
          topicAliases,
          extractedTopics,
          matchedConcepts,
          matchPercentage: report.matchPercentage,
          reusedSkillTreeDecision: report.reusedSkillTreeDecision,
        };

        await SkillTreeCsvUploadSnapshot.create(snapshotPayload);

        const existing = await SkillTreeCsvUploadSnapshot.find({ userId, canonicalTopic })
          .sort({ createdAt: -1 }).lean();
        if (existing.length > 5) {
          const toDelete = existing.slice(5).map(d => d._id);
          await SkillTreeCsvUploadSnapshot.deleteMany({ _id: { $in: toDelete } });
        }
      }
    } catch (persistErr) {
      console.warn('[SNAPSHOT SAVE] persist failed:', persistErr?.message || persistErr);
    }

    writeReport(report);

    res.json(report);
  } catch (err) {
    res.status(500).json({ message: 'Course matching failed', error: err?.message });
  }
});

router.post('/course-matching/validate', authMiddleware, async (req, res) => {
  const courseName = req.body?.courseName;
  if (!courseName || !String(courseName).trim()) {
    return res.status(400).json({ message: 'courseName is required' });
  }

  const qNorm = String(courseName).trim().toLowerCase();

  const inventoryPath = path.join(__dirname, '..', '..', 'curriculum_reports', 'curriculum_inventory.json');
  let inventory = { courses: [] };
  try {
    if (fs.existsSync(inventoryPath)) {
      inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
    }
  } catch (e) {
  }

  const courses = (Array.isArray(inventory?.courses) ? inventory.courses : [])
    .map(c => c.courseName || c.name || '').filter(Boolean);

  const exact = courses.find(c => c.toLowerCase() === qNorm);
  if (exact) {
    return res.json({ status: 'exact', canonical: exact, suggestions: [] });
  }

  const alias = courses.find(c => c.toLowerCase().includes(qNorm) || qNorm.includes(c.toLowerCase()));
  if (alias) {
    return res.json({ status: 'alias', canonical: alias, suggestions: [] });
  }

  const suggestions = courses
    .filter(c => c.toLowerCase().includes(qNorm) || qNorm.includes(c.toLowerCase()))
    .slice(0, 6);

  res.json({ status: suggestions.length ? 'suggestions' : 'other', canonical: null, suggestions });
});

router.get('/course-matching/autocomplete', authMiddleware, async (req, res) => {
  const q = req.query?.q;
  if (!q || String(q).trim().length < 3) {
    return res.json({ suggestions: [] });
  }

  const query = String(q).trim().toLowerCase();

  const inventoryPath = path.join(__dirname, '..', '..', 'curriculum_reports', 'curriculum_inventory.json');
  let inventory = { courses: [] };
  try {
    if (fs.existsSync(inventoryPath)) {
      inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
    }
  } catch (e) {
  }

  const courseNames = Array.isArray(inventory?.courses) ? inventory.courses.map(c => c.courseName || c.name || '').filter(Boolean) : [];

  const scored = courseNames
    .map(name => {
      const lower = name.toLowerCase();
      let score = 0;
      if (lower.startsWith(query)) score = 1;
      else if (lower.includes(query)) score = 0.6;
      return { type: 'course', value: name, label: name, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  res.json({ suggestions: scored });
});

module.exports = router;
