// server/routes/courses.js
// Proxy routes for course structure and lecture notes from the Python RAG service,
// with Neo4j fallback for curriculum structure when the RAG service is unavailable.
const express = require('express');
const router = express.Router();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const log = require('../utils/logger');
const { runQuery: neo4jRun } = require('../config/neo4j');

const PYTHON_RAG_URL = process.env.PYTHON_RAG_SERVICE_URL || 'http://127.0.0.1:2005';
const LECTURES_DIR = path.join(__dirname, '..', '..', 'lectures');
const COURSE_BOOTSTRAP_DIR = path.join(__dirname, '..', 'course_bootstrap');

// Scan lectures/ directory for stored lecture content
function findStoredLecture(courseName, subtopicId) {
    const result = { markdown: null, html: null, conceptMap: null };
    if (!fs.existsSync(LECTURES_DIR)) return result;

    const entries = fs.readdirSync(LECTURES_DIR);
    for (const entry of entries) {
        const entryPath = path.join(LECTURES_DIR, entry);
        if (!fs.statSync(entryPath).isDirectory()) continue;

        const lectureMdPath = path.join(entryPath, 'lecture.md');
        if (!fs.existsSync(lectureMdPath)) continue;

        const content = fs.readFileSync(lectureMdPath, 'utf8');

        // Check if this lecture matches the course name (first line heading)
        const firstLine = content.split('\n')[0] || '';
        if (firstLine.toLowerCase().includes(courseName.toLowerCase()) ||
            entry.toLowerCase().includes(courseName.toLowerCase())) {

            const htmlPath = path.join(entryPath, 'lecture.html');
            const conceptMapPath = path.join(entryPath, 'concept_map.html');

            result.markdown = content;
            result.html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : null;
            result.conceptMap = fs.existsSync(conceptMapPath) ? conceptMapPath : null;

            // If subtopicId provided, try to extract the matching section
            if (subtopicId && content) {
                const sectionMatch = content.match(new RegExp(`##[^\\n]*${escapeRegex(subtopicId)}[^\\n]*\\n[\\s\\S]*?(?=\\n##|$)`, 'i'));
                if (sectionMatch) {
                    result.markdown = sectionMatch[0];
                }
            }

            return result;
        }
    }
    return result;
}

// Check course_bootstrap directory for per-subtopic lecture notes
function findSubtopicLecture(courseName, subtopicId) {
    const notesDir = path.join(COURSE_BOOTSTRAP_DIR, courseName, 'lecture_notes', 'subtopics');
    if (!fs.existsSync(notesDir)) return null;

    const mdPath = path.join(notesDir, `${subtopicId}.md`);
    if (fs.existsSync(mdPath)) {
        return fs.readFileSync(mdPath, 'utf8');
    }
    return null;
}

async function fetchStructureFromNeo4j(courseName) {
    const result = await neo4jRun(
        `MATCH (m:Module)
         WHERE toLower(m.course) = toLower($course)
         OPTIONAL MATCH (m)-[:HAS_TOPIC]->(t:Topic)
         OPTIONAL MATCH (s:Subtopic)-[:PREREQUISITE_OF]->(t)
         WITH m, t, s
         ORDER BY m.order, coalesce(t.order, 0), coalesce(s.order, 0)
         WITH m, t, COLLECT(DISTINCT CASE WHEN s IS NOT NULL AND s.id IS NOT NULL THEN {id: s.id, name: s.name, order: s.order} END) AS subtopics
         WITH m, COLLECT(DISTINCT CASE WHEN t IS NOT NULL AND t.id IS NOT NULL THEN {
             id: t.id,
             name: t.name,
             order: t.order,
             subtopics: [sub IN subtopics WHERE sub IS NOT NULL AND sub.id IS NOT NULL]
         } END) AS topics
         RETURN m.id AS module_id, m.name AS module_name, m.order AS module_order,
                [tp IN topics WHERE tp IS NOT NULL AND tp.id IS NOT NULL] AS topics
         ORDER BY m.order`,
        { course: courseName }
    );

    if (!result.records || result.records.length === 0) {
        return null;
    }

    const modules = result.records.map(r => {
        const o = r.toObject();
        return {
            id: o.module_id,
            name: o.module_name,
            order: o.module_order ? o.module_order.low || o.module_order : o.module_order,
            topics: (o.topics || []).map(t => ({
                id: t.id,
                name: t.name,
                order: t.order ? (t.order.low || t.order) : t.order,
                subtopics: (t.subtopics || []).filter(s => s && s.id).map(s => ({
                    id: s.id,
                    name: s.name,
                    order: s.order ? (s.order.low || s.order) : s.order
                }))
            }))
        };
    });

    return modules;
}

async function fetchFromPythonRag(endpoint, courseName, params = {}, timeout = 12000) {
    try {
        const url = `${PYTHON_RAG_URL}/curriculum/${encodeURIComponent(courseName)}${endpoint}`;
        const { data } = await axios.get(url, { params, timeout });
        return data;
    } catch {
        return null;
    }
}

// @route   GET /api/courses/:courseName/structure
// @desc    Get module/topic/subtopic tree for an admin course
// @access  Private
router.get('/:courseName/structure', async (req, res) => {
    const { courseName } = req.params;
    try {
        // 1. Try Python RAG service
        const ragData = await fetchFromPythonRag('/structure', courseName, {}, 12000);
        if (ragData) {
            const curriculum = ragData.curriculum || ragData;
            if (curriculum && curriculum.modules && curriculum.modules.length > 0) {
                return res.json({ success: true, curriculum });
            }
        }

        // 2. Fallback: Neo4j direct query
        const modules = await fetchStructureFromNeo4j(courseName);
        if (modules && modules.length > 0) {
            log.info('DB', `Course structure for '${courseName}' served from Neo4j fallback (${modules.length} modules)`);
            return res.json({
                success: true,
                curriculum: { course: courseName, modules }
            });
        }

        return res.json({ success: false, curriculum: null, message: 'Course structure not found' });
    } catch (err) {
        log.error('DB', `Course structure fetch failed for '${courseName}': ${err.message}`);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// @route   GET /api/courses/:courseName/notes/:subtopicId
// @desc    Get all STN teaching notes for a specific subtopic
// @access  Private
router.get('/:courseName/notes/:subtopicId', async (req, res) => {
    const { courseName, subtopicId } = req.params;
    try {
        const data = await fetchFromPythonRag(
            `/notes/${encodeURIComponent(subtopicId)}`,
            courseName, {}, 10000
        );
        if (data) return res.json(data);

        return res.json({ success: false, message: 'Notes not available (RAG service offline)' });
    } catch (err) {
        const msg = err.response?.data?.message || err.message;
        log.error('DB', `Notes fetch failed for '${courseName}/${subtopicId}': ${msg}`);
        return res.status(500).json({ success: false, message: msg });
    }
});

// @route   GET /api/courses/:courseName/lecture/:subtopicId
// @desc    Get the lecture.md section for a subtopic (student-facing, with Mermaid + KaTeX)
// @access  Private
router.get('/:courseName/lecture/:subtopicId', async (req, res) => {
    const { courseName, subtopicId } = req.params;
    const subtopicName = req.query.subtopicName || '';
    const topicName    = req.query.topicName    || '';
    try {
        // 1. Try Python RAG service
        const data = await fetchFromPythonRag(
            `/lecture/${encodeURIComponent(subtopicId)}`,
            courseName,
            { subtopic_name: subtopicName, topic_name: topicName },
            120000
        );
        if (data && (data.markdown || data.html || data.content)) {
            log.info('LECTURE', `Served from Python RAG: ${courseName}/${subtopicId}`);
            return res.json(data);
        }

        // 2. Try course_bootstrap per-subtopic lecture notes
        const subtopicNote = findSubtopicLecture(courseName, subtopicId);
        if (subtopicNote) {
            log.info('LECTURE', `Served from course_bootstrap cache: ${courseName}/${subtopicId}`);
            return res.json({ success: true, markdown: subtopicNote, source: 'subtopic_cache' });
        }

        // 3. Try stored lecture from lectures/ directory
        const stored = findStoredLecture(courseName, subtopicId || subtopicName);
        if (stored.markdown) {
            log.info('LECTURE', `Served from lectures/ directory: ${courseName}/${subtopicId}`);
            return res.json({
                success: true,
                markdown: stored.markdown,
                html: stored.html,
                conceptMap: stored.conceptMap,
                source: 'lecture_directory',
            });
        }

        // 4. Generate lecture via LLM (auto-generate, persist, cache)
        try {
            const contentGen = require('../services/contentGenerationService');
            const lecture = await contentGen.generateOrRetrieveLecture(courseName, subtopicId, subtopicName, topicName);
            if (lecture && lecture.markdown) {
                log.info('LECTURE', `Auto-generated lecture for ${courseName}/${subtopicId} from ${lecture._source}`);
                return res.json({
                    success: true,
                    markdown: lecture.markdown,
                    html: lecture.html || '',
                    conceptMap: lecture.conceptMap || null,
                    source: lecture._source || 'generated',
                    _source: lecture._source || '',
                    generatedBy: lecture.generatedBy || '',
                    model: lecture.model || '',
                    pipelineVersion: lecture.pipelineVersion || '',
                    generatedAt: lecture.generatedAt || '',
                    generating: lecture._source === 'generated',
                });
            }
        } catch (genErr) {
            log.error('LECTURE', `Auto-generation failed: ${genErr.message}`);
        }

        // 5. Check if there's any full lecture for this course
        const fullLecture = findStoredLecture(courseName, null);
        if (fullLecture.markdown) {
            log.info('LECTURE', `No subtopic match, returning full lecture for ${courseName}`);
            return res.json({
                success: true,
                markdown: fullLecture.markdown,
                html: fullLecture.html,
                conceptMap: fullLecture.conceptMap,
                source: 'lecture_directory_full',
                note: 'Subtopic-specific section not found, showing full lecture',
            });
        }

        // 6. Absolute last resort: concept-based template
        const name = subtopicName || subtopicId || subtopicId || courseName;
        const fallbackLecture = `## ${name}\n\nThis lecture covers ${name} within ${courseName}.\n\n### Learning Objectives\n- Understand core concepts of ${name}\n- Identify practical applications\n\n### Summary\n${name} is an essential component of ${courseName}.`;
        return res.json({ success: true, markdown: fallbackLecture, html: '', source: 'template_fallback' });
    } catch (err) {
        const msg = err.response?.data?.message || err.message;
        log.error('DB', `Lecture section fetch failed for '${courseName}/${subtopicId}': ${msg}`);
        return res.status(err.response?.status || 500).json({ success: false, message: msg });
    }
});

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = router;
