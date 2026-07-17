// server/routes/skilltreeCourseMatching.js
// Dedicated routes for course search bar + CSV upload matching.
// No modifications to existing SkillTree generation routes.

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { authMiddleware } = require('../middleware/authMiddleware');
const log = require('../utils/logger');

const skilltreeCourseMatchingService = require('../services/skilltreeCourseMatchingService');
const SkillTreeCsvUploadSnapshot = require('../models/SkillTreeCsvUploadSnapshot');

const REPORT_PATH = path.join(__dirname, '..', '..', 'curriculum_reports', 'skilltree_course_matching_report.json');

function writeReport(report) {
  try {
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  } catch (e) {
    // best-effort; do not fail request
  }
}

// @route   POST /api/course-matching/upload
// @desc    Accept CSV upload (multipart) OR CSV text payload and return match decision.
router.post('/upload', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?._id;
    const requestId = `REQ-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;

    console.log(`[${requestId}] [USER_CONTEXT]`, JSON.stringify({
        userId: String(userId || ''),
        role: req.user?.isAdmin ? 'admin' : 'student',
        email: req.user?.email || ''
    }));
    console.log(`[${requestId}] [CSV UPLOAD] request received`);
    console.log(`[${requestId}] [CSV UPLOAD] uploadedFileName=`, req.body?.uploadedFileName || null);

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

    console.log(`[${requestId}] [CSV UPLOAD] csvText length=`, csvText?.length || 0);
    console.log(`[${requestId}] [CSV UPLOAD] existingCourseNames count=`, existingCourseNames?.length || 0);
    console.log(`[${requestId}] [CSV UPLOAD] existingSkillTreeTopics count=`, existingSkillTreeTopics?.length || 0);

    // First, validate CSV structure and extract topics
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

    // Pre-extract topics to populate snapshot BEFORE matching (fixes first-upload cold start)
    const rawExtracted = await skilltreeCourseMatchingService.extractTopicsFromCsvText(csvText);
    const preExtractedTopics = skilltreeCourseMatchingService.cleanCurriculumTopics(rawExtracted) || [];
    const canonicalTopic = skilltreeCourseMatchingService.firstRealCurriculumTopic(preExtractedTopics) || '';

    // Seed a snapshot for the current upload BEFORE matching, so the matching
    // service can find its own topics on the first upload attempt.
    if (canonicalTopic && !skilltreeCourseMatchingService.isInvalidSnapshotCanonical?.(canonicalTopic)) {
      try {
        await SkillTreeCsvUploadSnapshot.create({
          userId,
          canonicalTopic,
          extractedTopics: preExtractedTopics,
          courseName: req.body?.courseName || canonicalTopic,
          topic: req.body?.topic || canonicalTopic,
          createdAt: new Date()
        });
        log.debug('CSV_UPLOAD', `Seeded snapshot for "${canonicalTopic}" (${preExtractedTopics.length} topics) before matching`);
      } catch (seedErr) {
        log.warn('CSV_UPLOAD', `Snapshot seed skipped: ${seedErr.message}`);
      }
    }

    const match = await skilltreeCourseMatchingService.matchUploadedCsvToExistingTopics({
      csvText,
      existingCourseNames,
      existingSkillTreeTopics,
      userId,
    });

    const extractedTopics = Array.isArray(match.extractedTopics) ? match.extractedTopics : [];
    const matchedConcepts = Array.isArray(match.matchedConcepts) && match.matchedConcepts.length > 0
      ? match.matchedConcepts
      : (match.matchedCandidate ? [match.matchedCandidate] : []);
    let matchPercentage = match.matchPercentage;
    let reusedSkillTreeDecision = match.reusedSkillTreeDecision;

    // Override: if the user specified a courseName that doesn't match any known
    // course/subject in the system, force generate_new (topic-level matches
    // on generic terms like "Intro" should not trigger reuse).
    const providedCourseName = (req.body?.courseName || '').trim();
    if (providedCourseName && reusedSkillTreeDecision === 'reuse_existing') {
      let knownNames = (req.body?.existingCourseNames || []).map(s => s.toLowerCase());
      if (knownNames.length === 0) {
        try {
          const fs = require('fs');
          const path = require('path');
          const inventoryPath = path.join(__dirname, '..', '..', 'curriculum_reports', 'curriculum_inventory.json');
          if (fs.existsSync(inventoryPath)) {
            const raw = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
            const inventoryCourses = Array.isArray(raw.courses) ? raw.courses : [];
            knownNames = inventoryCourses.map(c => (c.name || c.courseName || c.courseCode || '').toLowerCase()).filter(Boolean);
          }
          if (knownNames.length === 0) {
            const bootstrapDir = path.join(__dirname, '..', '..', 'server', 'course_bootstrap');
            if (fs.existsSync(bootstrapDir)) {
              knownNames = fs.readdirSync(bootstrapDir).filter(e => {
                const fp = path.join(bootstrapDir, e);
                return fs.statSync(fp).isDirectory() && !e.startsWith('.');
              }).map(s => s.toLowerCase());
            }
          }
        } catch (fsErr) {
          log.warn('CSV_MATCHING', `Could not load known course names: ${fsErr.message}`);
        }
      }
      const isKnownCourse = knownNames.includes(providedCourseName.toLowerCase());
      if (!isKnownCourse) {
        reusedSkillTreeDecision = 'generate_new';
        matchPercentage = 0;
        log.info('CSV_MATCHING', `Course "${providedCourseName}" not in known subjects; overriding to generate_new`);
      }
    }

    console.log(`[${requestId}] [CSV PARSER VERIFY]`, {
      lectureTopicCount: extractedTopics.length,
      firstTenTopics: extractedTopics.slice(0, 10),
    });

    console.log(`[${requestId}] [CSV UPLOAD] extractedTopics=`, extractedTopics);
    console.log(`[${requestId}] [CSV UPLOAD] matchedConcepts=`, matchedConcepts);
    console.log(`[${requestId}] [CSV UPLOAD] matchPercentage=`, matchPercentage);
    console.log(`[${requestId}] [CSV UPLOAD] reusedSkillTreeDecision=`, reusedSkillTreeDecision);

    if (!extractedTopics || extractedTopics.length === 0) {
      console.log(`[${requestId}] [CSV UPLOAD] WARNING: no topics extracted from CSV`);
    }

    const report = {
      uploadedFileName: req.body?.uploadedFileName || null,
      extractedTopics,
      matchedConcepts,
      matchPercentage: matchPercentage,
      reusedSkillTreeDecision: reusedSkillTreeDecision,
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

    // Persist snapshot for later CFP usage (do not change response contract)
    try {
      const canonicalTopic = skilltreeCourseMatchingService.firstRealCurriculumTopic(extractedTopics);

      const courseNameAlias = (req.body?.courseName || req.body?.canonicalTopic || req.body?.topic || '').trim();
      const topicAliases = [...new Set([
        canonicalTopic,
        courseNameAlias,
        (req.body?.topic || '').trim(),
      ].filter(Boolean))];

      if (!canonicalTopic || skilltreeCourseMatchingService.isInvalidSnapshotCanonical(canonicalTopic)) {
        console.warn('[SNAPSHOT SAVE] skipped — no valid curriculum canonicalTopic', {
          firstFiveTopics: extractedTopics.slice(0, 5),
        });
        throw new Error('No valid curriculum canonicalTopic');
      }

      console.log('[SNAPSHOT SAVE]', {
        canonicalTopic,
        firstFiveTopics: extractedTopics.slice(0, 5)
      });

      console.log('[CSV_OWNER]', JSON.stringify({
        snapshotOwner: String(userId || ''),
        requestUser: String(userId || ''),
        canonicalTopic
      }));

      if (canonicalTopic) {
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
    log.error('CSV_MATCHING', `Course matching failed: ${err.message}${err.stack ? '\n' + err.stack : ''}`);
    res.status(500).json({
      success: false,
      message: err?.message || 'Course matching failed',
      stage: 'course_matching',
      details: {
        error: err?.message || 'Unknown error',
        stack: err?.stack || ''
      }
    });
  }
});

module.exports = router;
