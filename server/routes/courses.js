// server/routes/courses.js
// Proxy routes for course structure and lecture notes from the Python RAG service.
const express = require('express');
const router = express.Router();
const axios = require('axios');
const log = require('../utils/logger');

const PYTHON_RAG_URL = process.env.PYTHON_RAG_SERVICE_URL || 'http://127.0.0.1:2005';

// @route   GET /api/courses/meta
// @desc    Get all courses with metadata (code, name, semester, credits, counts)
// @access  Private
router.get('/meta', async (req, res) => {
    try {
        const { data } = await axios.get(`${PYTHON_RAG_URL}/curriculum/courses/meta`, { timeout: 10000 });
        return res.json(data);
    } catch (err) {
        const msg = err.response?.data?.message || err.message;
        log.error('DB', `Course meta fetch failed: ${msg}`);
        return res.status(500).json({ success: false, message: msg });
    }
});

// @route   GET /api/courses/:courseName/structure
// @desc    Get module/topic/subtopic tree for an admin course
// @access  Private
router.get('/:courseName/structure', async (req, res) => {
    const { courseName } = req.params;
    try {
        const { data } = await axios.get(
            `${PYTHON_RAG_URL}/curriculum/${encodeURIComponent(courseName)}/structure`,
            { timeout: 12000 }
        );
        return res.json(data);
    } catch (err) {
        const msg = err.response?.data?.message || err.message;
        log.error('DB', `Course structure fetch failed for '${courseName}': ${msg}`);
        return res.status(500).json({ success: false, message: msg });
    }
});

// @route   GET /api/courses/:courseName/notes/:subtopicId
// @desc    Get all STN teaching notes for a specific subtopic
// @access  Private
router.get('/:courseName/notes/:subtopicId', async (req, res) => {
    const { courseName, subtopicId } = req.params;
    try {
        const { data } = await axios.get(
            `${PYTHON_RAG_URL}/curriculum/${encodeURIComponent(courseName)}/notes/${encodeURIComponent(subtopicId)}`,
            { timeout: 10000 }
        );
        return res.json(data);
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
        const url = `${PYTHON_RAG_URL}/curriculum/${encodeURIComponent(courseName)}/lecture/${encodeURIComponent(subtopicId)}`;
        const { data } = await axios.get(url, {
            params: { subtopic_name: subtopicName, topic_name: topicName },
            timeout: 120000,  // allow up to 120s for first-time LLM generation (Groq~4s, Gemini~10s, SGLang~60s)
        });
        return res.json(data);
    } catch (err) {
        const msg = err.response?.data?.message || err.message;
        log.error('DB', `Lecture section fetch failed for '${courseName}/${subtopicId}': ${msg}`);
        return res.status(err.response?.status || 500).json({ success: false, message: msg });
    }
});

module.exports = router;
