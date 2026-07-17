const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const SocraticSession = require('../models/SocraticSession');
const { logger } = require('../utils/logger'); // Assuming you have a logger

// Multer Setup for File Uploads
const upload = multer({ dest: 'uploads/' });

const SOCRATIC_SERVICE_URL = process.env.SOCRATIC_SERVICE_URL || 'http://127.0.0.1:2002';
const PYTHON_RAG_SERVICE_URL = process.env.PYTHON_RAG_SERVICE_URL || 'http://127.0.0.1:2001';

// --- Helper Functions ---
function calculateFileHash(filepath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filepath);
        stream.on('data', (data) => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

// --- Routes ---

// 1. Upload File & Create/Update Session
router.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: "No file uploaded" });
        }

        const userId = req.user?._id;
        const sessionId = req.body.sessionId;
        const filepath = req.file.path;
        const filename = req.file.originalname;

        // 1. Hash File
        const fileHash = await calculateFileHash(filepath);

        // 2. Send to Python Service for Ingestion
        const FormData = require('form-data');
        const pyFormData = new FormData();
        pyFormData.append('file', fs.createReadStream(filepath), filename);
        pyFormData.append('file_hash', fileHash);

        const pyRes = await axios.post(`${SOCRATIC_SERVICE_URL}/ingest`, pyFormData, {
            headers: {
                ...pyFormData.getHeaders()
            }
        });

        const { cached, summary } = pyRes.data;

        // 3. Update or Create MongoDB Session
        let session;
        if (sessionId) {
            session = await SocraticSession.findOne({ _id: sessionId, userId });
        }

        if (!session) {
            session = new SocraticSession({
                userId,
                fileHashes: [],
                filenames: [],
                messages: []
            });
        }

        if (!session.fileHashes.includes(fileHash)) {
            session.fileHashes.push(fileHash);
            session.filenames.push(filename);
        }

        const systemMsg = `I've analyzed **${filename}**. ${summary ? `\n\n**Summary:**\n${summary}` : ''}`;
        session.messages.push({ role: 'assistant', content: systemMsg });

        await session.save();

        fs.unlinkSync(filepath);

        res.json({
            message: "File processed",
            sessionId: session._id,
            cached: cached,
            summary: summary
        });

    } catch (error) {
        logger.error(`Socratic Upload Error: ${error.message}`);
        res.status(500).json({ message: "Upload failed", error: error.message });
    }
});

// 2. Chat with Socratic Tutor
router.post('/chat', async (req, res) => {
    const { message, sessionId } = req.body;
    const userId = req.user?._id;

    if (!message || !sessionId) return res.status(400).json({ message: "Missing fields" });

    try {
        const session = await SocraticSession.findOne({ _id: sessionId, userId });
        if (!session) return res.status(404).json({ message: "Session not found" });

        session.messages.push({ role: 'user', content: message });
        await session.save();

        const historyForPy = session.messages.map(m => ({ role: m.role, content: m.content }));

        const currentTopic = session.studyPlan && session.studyPlan.length > 0 && session.currentTopicIndex >= 0 && session.currentTopicIndex < session.studyPlan.length
            ? session.studyPlan[session.currentTopicIndex]
            : null;

        const pyRes = await axios.post(`${SOCRATIC_SERVICE_URL}/chat`, {
            query: message,
            file_hashes: session.fileHashes,
            history: historyForPy,
            current_topic: currentTopic ? currentTopic.topic : null,
            learning_level: session.learningLevel
        });

        const assistantResponse = pyRes.data.response;
        const isTopicCompleted = pyRes.data.topic_completed;

        session.messages.push({ role: 'assistant', content: assistantResponse });

        // Simplified Chat Completion Logic (Server side status updates usually happen via PUT)
        // detailed completion logic is in the PUT route now to sync with UI clicks

        await session.save();

        res.json({ response: assistantResponse, topic_completed: isTopicCompleted });

    } catch (error) {
        logger.error(`Chat Error: ${error.message}`);
        const status = error.response?.status || 500;
        const msg = error.response?.data?.error || error.message;
        res.status(status).json({ message: msg });
    }
});

// 3. Get All Sessions
router.get('/sessions', async (req, res) => {
    const userId = req.user?._id;
    try {
        const sessions = await SocraticSession.find({ userId }).sort({ updatedAt: -1 }).select('filenames createdAt updatedAt');
        const formatted = sessions.map(s => ({
            _id: s._id,
            filename: s.filenames.join(', ') || "Untitled Session",
            filenames: s.filenames,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt
        }));
        res.json(formatted);
    } catch (error) {
        res.status(500).json({ message: "Failed to fetch sessions" });
    }
});

// 4. Get Session History
router.get('/history/:sessionId', async (req, res) => {
    const userId = req.user?._id;
    try {
        const session = await SocraticSession.findOne({ _id: req.params.sessionId, userId });
        if (!session) return res.status(404).json({ message: "Session not found" });
        res.json(session);
    } catch (error) {
        res.status(500).json({ message: "Failed to fetch history" });
    }
});

// 5. Delete Session
router.delete('/history/:sessionId', async (req, res) => {
    const userId = req.user?._id;
    try {
        await SocraticSession.deleteOne({ _id: req.params.sessionId, userId });
        res.json({ message: "Session deleted" });
    } catch (error) {
        res.status(500).json({ message: "Failed to delete session" });
    }
});

// 6. Set Learning Level
router.put('/session/:sessionId/level', async (req, res) => {
    const userId = req.user?._id;
    const { level } = req.body;

    if (!['beginner', 'intermediate', 'advanced'].includes(level)) {
        return res.status(400).json({ message: "Invalid level" });
    }

    try {
        const session = await SocraticSession.findOneAndUpdate(
            { _id: req.params.sessionId, userId },
            { learningLevel: level },
            { new: true }
        );
        res.json(session);
    } catch (error) {
        res.status(500).json({ message: "Failed to update level" });
    }
});

// 7. Generate Study Plan
router.post('/session/:sessionId/plan', async (req, res) => {
    const userId = req.user?._id;
    try {
        const session = await SocraticSession.findOne({ _id: req.params.sessionId, userId });
        if (!session) return res.status(404).json({ message: "Session not found" });

        const pyRes = await axios.post(`${SOCRATIC_SERVICE_URL}/generate_plan`, {
            file_hashes: session.fileHashes,
            learning_level: session.learningLevel
        });

        const planData = pyRes.data;

        session.studyPlan = planData.study_plan.map(item => ({
            ...item,
            status: 'pending' // Default status
        }));

        // Assign order
        session.studyPlan = session.studyPlan.map((item, index) => ({ ...item, order: index }));

        logger.info(`Syncing Study Plan to Neo4j. Modules: ${session.studyPlan.length}`);
        if (session.studyPlan.length > 0) {
            logger.info(`First Module Subtopics: ${JSON.stringify(session.studyPlan[0].subtopics)}`);
        }

        // SYNC TO NEO4J
        try {
            await axios.post(`${PYTHON_RAG_SERVICE_URL}/study_plan/graph`, {
                user_id: userId.toString(),
                session_id: session._id.toString(),
                plan: session.studyPlan.map(p => ({
                    topic: p.topic,
                    description: p.description,
                    status: p.status,
                    order: p.order,
                    subtopics: p.subtopics ? p.subtopics.map(s => ({
                        topic: s.topic,
                        description: s.description,
                        status: s.status,
                        order: s.order
                    })) : []
                }))
            });
        } catch (err) {
            logger.error(`Failed to sync study plan to Neo4j: ${err.message}`);
        }

        // Auto-start first topic
        if (session.studyPlan.length > 0) {
            session.studyPlan[0].status = 'in-progress';
            // Start first subtopic if present
            if (session.studyPlan[0].subtopics && session.studyPlan[0].subtopics.length > 0) {
                session.studyPlan[0].subtopics[0].status = 'in-progress';
            }
            session.currentTopicIndex = 0;

            session.messages.push({
                role: 'assistant',
                content: `**Study Plan Generated!** 📚\n\nI've created a study plan based on your documents. We'll start with: **${session.studyPlan[0].topic}**.\n\n${session.studyPlan[0].description}`
            });
        }

        await SocraticSession.findOneAndUpdate(
            { _id: req.params.sessionId, userId },
            {
                studyPlan: session.studyPlan,
                currentTopicIndex: session.currentTopicIndex,
                $push: { messages: { $each: session.messages.slice(-1) } }
            },
            { new: true }
        );

        const updatedSession = await SocraticSession.findOne({ _id: req.params.sessionId, userId });
        res.json(updatedSession);

    } catch (error) {
        logger.error(`Plan Gen Error: ${error.message}`);
        const msg = error.response?.data?.error || "Failed to generate plan";
        res.status(500).json({ message: msg });
    }
});

// 8. Update Topic Status (Hierarchical)
router.put('/session/:sessionId/topic/status', async (req, res) => {
    const userId = req.user?._id;
    const { moduleIndex, subtopicIndex, status } = req.body;

    try {
        const session = await SocraticSession.findOne({ _id: req.params.sessionId, userId });
        if (!session) return res.status(404).json({ message: "Session not found" });

        if (!session.studyPlan || !session.studyPlan[moduleIndex]) {
            return res.status(400).json({ message: "Invalid module index" });
        }

        let topicName = "";

        if (subtopicIndex !== undefined && subtopicIndex !== null) {
            // Updating a subtopic
            if (!session.studyPlan[moduleIndex].subtopics || !session.studyPlan[moduleIndex].subtopics[subtopicIndex]) {
                return res.status(400).json({ message: "Invalid subtopic index" });
            }
            session.studyPlan[moduleIndex].subtopics[subtopicIndex].status = status;
            topicName = session.studyPlan[moduleIndex].subtopics[subtopicIndex].topic;
        } else {
            // Updating module
            session.studyPlan[moduleIndex].status = status;
            topicName = session.studyPlan[moduleIndex].topic;

            // CASCADE: If module is completed, mark subtopics completed
            if (status === 'completed' && session.studyPlan[moduleIndex].subtopics) {
                session.studyPlan[moduleIndex].subtopics.forEach(sub => {
                    sub.status = 'completed';
                    // Note: We are not syncing individual subtopic status to Neo4j here to save requests.
                    // The Frontend will reflect this from MongoDB.
                });
            }
        }

        logger.info(`Updating Status: Session=${req.params.sessionId}, Module=${moduleIndex}, Sub=${subtopicIndex}, Topic='${topicName}', Status=${status}`);

        // Checking Next Topic Logic
        if (status === 'completed') {
            let nextTopic = null;
            let nextModuleIdx = moduleIndex;
            let nextSubIdx = subtopicIndex;

            // 1. Try next subtopic in SAME module
            if (subtopicIndex !== undefined && subtopicIndex !== null && session.studyPlan[moduleIndex].subtopics && subtopicIndex + 1 < session.studyPlan[moduleIndex].subtopics.length) {
                nextSubIdx = subtopicIndex + 1;
                nextTopic = session.studyPlan[moduleIndex].subtopics[nextSubIdx];
                logger.info(`Found Next Subtopic: ${nextTopic.topic}`);
            }
            // 2. Try next MODULE (start at subtopic 0 if exists)
            else if (moduleIndex + 1 < session.studyPlan.length) {
                nextModuleIdx = moduleIndex + 1;
                const nextModule = session.studyPlan[nextModuleIdx];
                if (nextModule.subtopics && nextModule.subtopics.length > 0) {
                    nextSubIdx = 0;
                    nextTopic = nextModule.subtopics[0];
                    logger.info(`Found Next Module Subtopic: ${nextTopic.topic}`);
                } else {
                    nextSubIdx = null;
                    nextTopic = nextModule;
                    logger.info(`Found Next Module: ${nextTopic.topic}`);
                }
            }

            if (nextTopic && nextTopic.status === 'pending') {
                // Auto-start next topic
                if (nextSubIdx !== null && nextSubIdx !== undefined) {
                    session.studyPlan[nextModuleIdx].subtopics[nextSubIdx].status = 'in-progress';
                    // Also enable parent module if it was pending?
                    session.studyPlan[nextModuleIdx].status = 'in-progress';
                } else {
                    session.studyPlan[nextModuleIdx].status = 'in-progress';
                }

                const nextTitle = nextTopic.topic;

                session.messages.push({
                    role: 'assistant',
                    content: `Great job completing **${topicName}**! 🎉\n\nLet's move on to: **${nextTitle}**.`
                });
            } else if (!nextTopic) {
                session.messages.push({
                    role: 'assistant',
                    content: `Congratulations! You've completed the entire study plan! 🎓`
                });
            }
        }

        // SYNC TO NEO4J
        try {
            logger.info(`Sending Neo4j Sync: ${PYTHON_RAG_SERVICE_URL}/study_plan/status`);
            await axios.put(`${PYTHON_RAG_SERVICE_URL}/study_plan/status`, {
                user_id: userId.toString(),
                session_id: req.params.sessionId.toString(),
                topic: topicName,
                status: status
            });
            logger.info("Neo4j Sync Request Sent.");
        } catch (err) {
            logger.error(`Failed to sync status update to Neo4j: ${err.message}`);
            if (err.response) logger.error(`Neo4j Response: ${JSON.stringify(err.response.data)}`);
        }

        await SocraticSession.findOneAndUpdate(
            { _id: req.params.sessionId, userId },
            { studyPlan: session.studyPlan, $push: { messages: { $each: session.messages.slice(-1) } } },
            { new: true }
        );

        const updated = await SocraticSession.findOne({ _id: req.params.sessionId, userId });
        res.json(updated);

    } catch (error) {
        logger.error(`Update Error: ${error.message}`);
        res.status(500).json({ message: "Failed to update topic" });
    }
});

module.exports = router;
