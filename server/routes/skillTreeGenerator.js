const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const csv = require('csv-parse/sync');
const { authMiddleware } = require('../middleware/authMiddleware');
const UploadedCurriculum = require('../models/UploadedCurriculum');
const UserSkillTree = require('../models/UserSkillTree');
const SkillTreeGame = require('../models/SkillTreeGame');
const GamificationProfile = require('../models/GamificationProfile');
const { callWithFallback } = require('../services/llmFallbackService');
const log = require('../utils/logger');

const logEvent = (event, detail, extra) => {
    log.info('SKILL_TREE', `[${event}] ${detail}${extra ? ' | ' + JSON.stringify(extra) : ''}`);
};
const logErr = (event, error) => {
    log.error('SKILL_TREE', `[${event}] ${error.message}${error.stack ? '\n' + error.stack : ''}`);
};

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'curricula');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const unique = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        cb(null, `${unique}-${file.originalname}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!file.originalname.toLowerCase().endsWith('.csv')) {
            return cb(new Error('Only .csv files are accepted'), false);
        }
        cb(null, true);
    }
});

const REQUIRED_COLUMNS = ['Module', 'Topic', 'Subtopic'];

function validateCSV(records) {
    if (!records || records.length === 0) return { valid: false, error: 'CSV file is empty.' };
    const headers = Object.keys(records[0]);
    const missing = REQUIRED_COLUMNS.filter(col =>
        !headers.some(h => h.toLowerCase() === col.toLowerCase())
    );
    if (missing.length > 0) return { valid: false, error: `Missing required column: ${missing.join(', ')}` };
    for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const missingFields = REQUIRED_COLUMNS.filter(col => {
            const key = Object.keys(row).find(k => k.toLowerCase() === col.toLowerCase());
            return !key || !row[key] || !String(row[key]).trim();
        });
        if (missingFields.length > 0) return { valid: false, error: `Row ${i + 1}: missing value for ${missingFields.join(', ')}` };
    }
    return { valid: true };
}

function computeHash(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

function normalizeRecords(records) {
    return records.map(row => {
        const get = (name) => {
            const key = Object.keys(row).find(k => k.toLowerCase() === name.toLowerCase());
            return key ? String(row[key] || '').trim() : '';
        };
        return { module: get('Module'), topic: get('Topic'), subtopic: get('Subtopic'), difficulty: get('Difficulty'), credits: get('Credits') };
    });
}

router.use(authMiddleware);

// ─── Upload ────────────────────────────────────────────────────────────────────
router.post('/upload', (req, res, next) => {
    upload.single('file')(req, res, (err) => {
        if (err) {
            if (err instanceof multer.MulterError) {
                if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ message: 'File exceeds 10MB maximum size.' });
                return res.status(400).json({ message: `Upload error: ${err.message}` });
            }
            return res.status(400).json({ message: err.message });
        }
        next();
    });
}, async (req, res) => {
    const startTime = Date.now();
    try {
        if (!req.file) return res.status(400).json({ message: 'No file provided.' });
        const filePath = req.file.path;
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const hash = computeHash(fileContent);

        const existing = await UploadedCurriculum.findOne({ userId: req.user._id, hash });
        if (existing) {
            const skillTree = await UserSkillTree.findOne({ curriculumId: existing._id, userId: req.user._id });
            logEvent('UPLOAD_DUPLICATE', `${req.file.originalname} already uploaded`);
            fs.unlinkSync(filePath);
            return res.json({
                existing: true,
                curriculumId: existing._id,
                skillTreeId: skillTree?._id || null,
                courseTitle: existing.courseTitle,
                topicCount: existing.topicCount,
                moduleCount: existing.moduleCount,
                message: 'Curriculum already uploaded. You can load the existing skill tree or generate a new one.'
            });
        }

        let records;
        try {
            records = csv.parse(fileContent, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });
        } catch (parseErr) {
            fs.unlinkSync(filePath);
            logErr('CSV_PARSE_ERROR', parseErr);
            return res.status(400).json({ message: `CSV parse error: ${parseErr.message}` });
        }

        const validation = validateCSV(records);
        if (!validation.valid) {
            fs.unlinkSync(filePath);
            log.warn('SKILL_TREE', `CSV validation error: ${validation.error}`);
            return res.status(400).json({ message: validation.error });
        }

        const normalized = normalizeRecords(records);
        const moduleSet = new Set(normalized.map(r => r.module));
        const topicSet = new Set(normalized.map(r => `${r.module}::${r.topic}`));
        const courseTitle = req.body.courseTitle || path.basename(req.file.originalname, '.csv');

        const curriculum = new UploadedCurriculum({
            userId: req.user._id, filename: req.file.originalname, hash,
            storagePath: filePath, courseTitle, topics: normalized,
            moduleCount: moduleSet.size, topicCount: topicSet.size, status: 'parsed'
        });
        await curriculum.save();

        logEvent('UPLOAD_OK', `${req.file.originalname}`, { rows: normalized.length, modules: moduleSet.size });
        res.json({
            existing: false, curriculumId: curriculum._id, courseTitle,
            topicCount: topicSet.size, moduleCount: moduleSet.size, rowCount: normalized.length, status: curriculum.status
        });
    } catch (error) {
        logErr('UPLOAD_ERROR', error);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ message: 'Failed to process curriculum file.' });
    }
});

// ─── List Existing ─────────────────────────────────────────────────────────────
router.get('/existing', async (req, res) => {
    try {
        const skillTrees = await UserSkillTree.find(
            { userId: req.user._id },
            { title: 1, source: 1, courseName: 1, nodeCount: 1, dependencyCount: 1,
              createdAt: 1, updatedAt: 1, curriculumId: 1, status: 1, gameId: 1,
              nodesUnlocked: 1, nodesMastered: 1, totalStarsEarned: 1,
              'assessmentResult.level': 1, 'assessmentResult.weightedScore': 1,
              'analytics.masteryPercentage': 1, 'analytics.completionPercentage': 1 }
        ).sort({ updatedAt: -1 }).lean();

        const curricula = await UploadedCurriculum.find(
            { userId: req.user._id, status: { $in: ['parsed', 'ready'] } },
            { courseTitle: 1, moduleCount: 1, topicCount: 1, createdAt: 1 }
        ).sort({ createdAt: -1 }).lean();

        res.json({ skillTrees, curricula });
    } catch (error) {
        logErr('LIST_ERROR', error);
        res.status(500).json({ message: 'Failed to fetch existing skill trees.' });
    }
});

// ─── Get Single ────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
    try {
        const skillTree = await UserSkillTree.findOne({ _id: req.params.id, userId: req.user._id }).lean();
        if (!skillTree) return res.status(404).json({ message: 'Skill tree not found.' });
        res.json({ skillTree });
    } catch (error) {
        logErr('FETCH_ERROR', error);
        res.status(500).json({ message: 'Failed to fetch skill tree.' });
    }
});

// ─── Generate ──────────────────────────────────────────────────────────────────
router.post('/generate', async (req, res) => {
    const startTime = Date.now();
    const genLog = [];
    try {
        const { source, courseName, modules, curriculumId } = req.body;
        if (!source || !['course', 'csv'].includes(source)) return res.status(400).json({ message: 'source must be "course" or "csv"' });

        let title, rawTopics;
        if (source === 'course') {
            if (!courseName || !modules || !Array.isArray(modules)) return res.status(400).json({ message: 'courseName and modules array required' });
            title = courseName;
            rawTopics = [];
            modules.forEach(mod => {
                const modName = mod.name || mod.module || 'Module';
                (mod.topics || []).forEach(topic => {
                    const topicName = topic.name || topic.topic || 'Topic';
                    (topic.subtopics || []).forEach(sub => {
                        rawTopics.push({
                            module: modName, topic: topicName,
                            subtopic: sub.name || sub.subtopic || sub,
                            difficulty: sub.difficulty || topic.difficulty || mod.difficulty || ''
                        });
                    });
                    if (!topic.subtopics || topic.subtopics.length === 0) {
                        rawTopics.push({ module: modName, topic: topicName, subtopic: topicName, difficulty: topic.difficulty || mod.difficulty || '' });
                    }
                });
            });
            genLog.push(`Parsed ${rawTopics.length} subtopics from course ${courseName}`);
        } else {
            if (!curriculumId) return res.status(400).json({ message: 'curriculumId required for csv source' });
            const curriculum = await UploadedCurriculum.findOne({ _id: curriculumId, userId: req.user._id });
            if (!curriculum) return res.status(404).json({ message: 'Curriculum not found' });
            title = curriculum.courseTitle;
            rawTopics = curriculum.topics.map(t => ({ module: t.module, topic: t.topic, subtopic: t.subtopic, difficulty: t.difficulty || '' }));
            genLog.push(`Loaded ${rawTopics.length} subtopics from uploaded curriculum "${title}"`);
        }

        if (rawTopics.length === 0) return res.status(400).json({ message: 'No topics found in curriculum' });

        const moduleOrder = [...new Set(rawTopics.map(t => t.module))];
        const subtopicKeys = new Set();
        const nodes = [];
        const edges = [];
        const DIFFICULTY_MAP = ['beginner', 'beginner', 'intermediate', 'intermediate', 'advanced', 'advanced', 'expert'];

        moduleOrder.forEach((modName, modIdx) => {
            const modTopics = rawTopics.filter(t => t.module === modName);
            const topicNames = [...new Set(modTopics.map(t => t.topic))];
            const tier = modIdx;
            topicNames.forEach((topicName, topicIdx) => {
                const subtopics = modTopics.filter(t => t.topic === topicName);
                const yBase = topicIdx * 120 + 60;
                subtopics.forEach((sub, subIdx) => {
                    const subKey = `${modName}::${topicName}::${sub.subtopic}`;
                    if (subtopicKeys.has(subKey)) return;
                    subtopicKeys.add(subKey);
                    const parts = [modName, topicName, sub.subtopic].filter(Boolean);
                    const label = parts.join(' - ');
                    const diffIdx = Math.min(tier, DIFFICULTY_MAP.length - 1);
                    const difficulty = DIFFICULTY_MAP[diffIdx];
                    const nodeId = `node-${subKey.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`;

                    nodes.push({
                        id: nodeId, name: sub.subtopic, module: modName, topic: topicName,
                        difficulty, prerequisites: [], x: tier * 280 + 140, y: yBase + subIdx * 80, tier,
                        learningObjective: `Understand ${sub.subtopic} in the context of ${topicName}`,
                        estimatedTime: 30,
                        outcomes: [`Explain ${sub.subtopic}`, `Apply ${sub.subtopic} concepts`, `Analyze problems involving ${sub.subtopic}`],
                        successCriteria: [`Complete quiz with >70%`, `Demonstrate understanding via reflection`],
                        masteryThreshold: 70,
                        masteryStatus: 'locked', unlocked: false, mastered: false, stars: 0, xpAwarded: 0
                    });
                });
            });
        });

        moduleOrder.forEach((modName, modIdx) => {
            const currentNodes = nodes.filter(n => n.module === modName);
            currentNodes.forEach((node, i) => {
                if (i > 0) {
                    if (!node.prerequisites.includes(currentNodes[i - 1].id)) {
                        node.prerequisites.push(currentNodes[i - 1].id);
                        edges.push({ from: currentNodes[i - 1].id, to: node.id });
                    }
                }
                if (modIdx > 0) {
                    const prevModName = moduleOrder[modIdx - 1];
                    const prevNodes = nodes.filter(n => n.module === prevModName);
                    if (prevNodes.length > 0) {
                        const closest = prevNodes.reduce((best, pn) => {
                            const dist = Math.abs(pn.y - node.y);
                            return dist < best.dist ? { node: pn, dist } : best;
                        }, { node: prevNodes[0], dist: Infinity });
                        if (!node.prerequisites.includes(closest.node.id)) {
                            node.prerequisites.push(closest.node.id);
                            edges.push({ from: closest.node.id, to: node.id });
                        }
                    }
                }
            });
        });

        const graphJson = { nodes, edges };
        const nodeCount = nodes.length;
        const dependencyCount = edges.length;
        const elapsed = Date.now() - startTime;

        const skillTree = new UserSkillTree({
            userId: req.user._id,
            courseName: source === 'course' ? courseName : undefined,
            curriculumId: source === 'csv' ? curriculumId : undefined,
            title, source, graphJson, nodes,
            generatedBy: 'deterministic', nodeCount, dependencyCount,
            generationTimeMs: elapsed, status: 'ready', generationLog: genLog,
            analytics: { overallProgress: 0, completionPercentage: 0, masteryPercentage: 0, timeInvested: 0, lastActivityDate: new Date() }
        });
        await skillTree.save();

        if (source === 'csv') await UploadedCurriculum.findByIdAndUpdate(curriculumId, { status: 'ready' });

        logEvent('GENERATE_OK', `"${title}"`, { nodeCount, dependencyCount, elapsed });
        res.json({ skillTree: { _id: skillTree._id, title, source, nodeCount, dependencyCount, generationTimeMs: elapsed, status: 'ready' } });
    } catch (error) {
        logErr('GENERATE_ERROR', error);
        res.status(500).json({ message: `Skill tree generation failed: ${error.message}` });
    }
});

// ─── Assessment (Multi-Type Questions) ─────────────────────────────────────────
router.post('/assessment', async (req, res) => {
    const startTime = Date.now();
    try {
        const { treeId } = req.body;
        if (!treeId) return res.status(400).json({ message: 'treeId required' });

        const tree = await UserSkillTree.findOne({ _id: treeId, userId: req.user._id });
        if (!tree) return res.status(404).json({ message: 'Skill tree not found.' });

        const firstNodes = tree.nodes.filter(n => !n.prerequisites || n.prerequisites.length === 0);
        const pick = firstNodes.slice(0, 5);
        if (pick.length === 0) pick.push(tree.nodes[0]);

        const topics = pick.map(n => `${n.module || ''} ${n.topic || ''} ${n.name}`.trim()).filter(Boolean);
        const contextStr = topics.join('\n');

        const prompt = `Generate 5 diagnostic questions for a student starting a skill tree in "${tree.title}". Topic areas: ${contextStr}.

Rules:
- Mix question types: 2 MCQ, 1 scenario, 1 fill-in-the-blank, 1 short answer
- Each question must have: question, type, options (for mcq/scenario), correctAnswer, explanation, difficulty
- For MCQ: provide 4 options and a correctIndex (0-based)
- For fill_blank: provide correctAnswer as string
- For short_answer: provide correctAnswer as string, options is optional hints
- For scenario: provide a scenario description as question, 4 options, correctIndex
- Difficulties: first 2 beginner, next 2 intermediate, last 1 advanced
- Return ONLY valid JSON array

[{"question":"","type":"mcq","options":["","","",""],"correctAnswer":"","correctIndex":0,"explanation":"","difficulty":"beginner","bloomsLevel":"remember"}]`;

        const result = await callWithFallback({
            userQuery: prompt,
            preferredProvider: 'groq',
            preferLocalFirst: true,
            options: { temperature: 0.3 }
        });

        let text = result.text.replace(/```json/gi, '').replace(/```/g, '').trim();
        let questions;
        try { questions = JSON.parse(text); }
        catch {
            const arrMatch = text.match(/\[[\s\S]*\]/);
            if (arrMatch) { try { questions = JSON.parse(arrMatch[0]); } catch { questions = null; } }
            else questions = null;
        }

        if (!Array.isArray(questions) || questions.length === 0) {
            questions = [
                { question: `What is a core concept in ${tree.title}?`, type: 'mcq', options: ['Concept A', 'Concept B', 'Concept C', 'Concept D'], correctAnswer: 'Concept A', correctIndex: 0, explanation: 'Core concepts form the foundation.', difficulty: 'beginner', bloomsLevel: 'remember' },
                { question: `Which topic relates to ${pick[0]?.name || 'the first module'}?`, type: 'mcq', options: ['Option 1', 'Option 2', 'Option 3', 'Option 4'], correctAnswer: 'Option 2', correctIndex: 1, explanation: 'This topic relates directly.', difficulty: 'beginner', bloomsLevel: 'understand' },
                { question: `Explain how ${pick[0]?.name || 'the core concept'} applies to a real-world scenario.`, type: 'short_answer', correctAnswer: 'Application varies by context, but generally involves...', explanation: 'Scenario application tests practical understanding.', difficulty: 'intermediate', bloomsLevel: 'apply' }
            ];
        }

        await UserSkillTree.findByIdAndUpdate(treeId, { status: 'assessing' });
        logEvent('ASSESSMENT_OK', `"${tree.title}"`, { questions: questions.length, timeMs: Date.now() - startTime });

        res.json({ questions, treeId });
    } catch (error) {
        logErr('ASSESSMENT_ERROR', error);
        res.status(500).json({ message: 'Failed to generate assessment questions.' });
    }
});

// ─── Evaluate (Enhanced with configurable weights, knowledge gaps) ─────────────
router.post('/evaluate', async (req, res) => {
    try {
        const { treeId, questions, answers } = req.body;
        if (!treeId || !answers) return res.status(400).json({ message: 'treeId and answers required' });

        const tree = await UserSkillTree.findOne({ _id: treeId, userId: req.user._id });
        if (!tree) return res.status(404).json({ message: 'Skill tree not found.' });

        const weights = tree.scoringWeights || { mcq: 0.3, scenario: 0.2, reasoning: 0.3, reflection: 0.2, application: 0.15, confidence: 0.05 };

        const qResults = [];
        let correctCount = 0;
        const totalQuestions = answers.length || 1;

        answers.forEach((ans, i) => {
            const q = questions?.[i];
            const isCorrect = ans.isCorrect !== undefined ? ans.isCorrect :
                (q?.correctIndex != null ? Number(ans.selectedIndex) === Number(q.correctIndex) :
                 String(ans.text || '').toLowerCase().trim() === String(q?.correctAnswer || '').toLowerCase().trim());
            if (isCorrect) correctCount++;
            qResults.push({
                questionId: q?.id || `q${i}`,
                questionType: q?.type || 'mcq',
                correct: isCorrect,
                score: isCorrect ? 100 : 0,
                bloomsLevel: q?.bloomsLevel || 'understand',
                difficulty: q?.difficulty || 'beginner',
                feedback: isCorrect ? 'Correct' : `Expected: ${q?.correctAnswer || 'N/A'}`
            });
        });

        const rawScore = Math.round((correctCount / totalQuestions) * 100);

        // Score breakdown by type
        const byType = {};
        qResults.forEach(r => {
            if (!byType[r.questionType]) byType[r.questionType] = { correct: 0, total: 0 };
            byType[r.questionType].total++;
            if (r.correct) byType[r.questionType].correct++;
        });

        const typeScores = {};
        Object.entries(byType).forEach(([type, data]) => {
            typeScores[type] = Math.round((data.correct / data.total) * 100);
        });

        // Normalize weights to available question types
        const typeWeights = { mcq: weights.mcq || 0.3, scenario: weights.scenario || 0.2,
            fill_blank: 0.1, short_answer: 0.15, reasoning: weights.reasoning || 0.3,
            reflection: weights.reflection || 0.2, case_study: 0.15, match: 0.1 };
        const availableTypes = Object.keys(byType);
        let totalWeight = 0;
        availableTypes.forEach(t => { if (typeWeights[t]) totalWeight += typeWeights[t]; });
        const normalizeFactor = totalWeight > 0 ? 1 / totalWeight : 1;

        let weightedScore = 0;
        availableTypes.forEach(t => {
            const w = (typeWeights[t] || 0.1) * normalizeFactor;
            weightedScore += (typeScores[t] || 0) * w;
        });
        weightedScore = Math.round(weightedScore);

        let level = 'beginner';
        if (weightedScore >= 80) level = 'expert';
        else if (weightedScore >= 60) level = 'advanced';
        else if (weightedScore >= 35) level = 'intermediate';

        // Knowledge gap analysis from answers
        const knowledgeGaps = [];
        const strengths = [];
        const improvements = [];
        qResults.forEach((r, i) => {
            if (!r.correct) {
                const node = tree.nodes.find(n => {
                    const q = questions?.[i];
                    return q && (n.name.toLowerCase().includes((q.question || '').slice(0, 20).toLowerCase()) ||
                        (n.module || '').toLowerCase().includes((q.question || '').slice(0, 10).toLowerCase()));
                });
                knowledgeGaps.push({
                    nodeId: node?.id || `q${i}`,
                    nodeName: node?.name || `Question ${i + 1}`,
                    gapType: r.bloomsLevel === 'remember' || r.bloomsLevel === 'understand' ? 'conceptual' :
                             r.bloomsLevel === 'apply' ? 'application' : 'reasoning',
                    severity: r.difficulty === 'beginner' ? 0.8 : r.difficulty === 'intermediate' ? 0.5 : 0.3,
                    description: `Failed on ${r.difficulty}-level ${r.bloomsLevel} question`,
                    detectedAt: new Date()
                });
            } else {
                const node = tree.nodes.find(n => {
                    const q = questions?.[i];
                    return q && (n.name.toLowerCase().includes((q.question || '').slice(0, 20).toLowerCase()));
                });
                strengths.push(node?.name ? `Understood ${node.name}` : `Correct on ${r.questionType} question`);
            }
        });

        if (rawScore >= 60) strengths.push('Good conceptual understanding');
        else improvements.push('Strengthen conceptual foundations');

        const evaluatorPrompt = `Evaluate a student's diagnostic assessment for "${tree.title}". Score: ${rawScore}%. Level: ${level}.

${questions ? questions.map((q, i) => `Q${i + 1} [${q.type}][${q.difficulty}][${q.bloomsLevel}]: ${answers[i]?.isCorrect ? 'CORRECT' : 'WRONG'}`).join('\n') : ''}

Return ONLY valid JSON:
{"conceptUnderstanding":0-100,"confidence":0-100,"misconceptions":[],"recommendations":[],"summary":"","strengths":[],"improvements":[]}`;

        let evaluation = {
            conceptUnderstanding: Math.min(100, rawScore + 10),
            confidence: Math.min(100, rawScore + 5),
            misconceptions: rawScore < 50 ? ['Foundational gaps in key topics'] : [],
            recommendations: rawScore < 60
                ? ['Review fundamental concepts', 'Practice with basic exercises', 'Use spaced repetition for core topics']
                : rawScore < 80
                    ? ['Deepen understanding of advanced topics', 'Try applied problem-solving', 'Explore cross-topic connections']
                    : ['Challenge yourself with expert-level material', 'Mentor other students', 'Explore research papers'],
            summary: `Student scored ${rawScore}% (${level} level). ${rawScore >= 60 ? 'Demonstrates solid understanding.' : 'Needs to build foundational knowledge.'}`,
            strengths, improvements
        };

        try {
            const evalResult = await callWithFallback({
                userQuery: evaluatorPrompt,
                preferredProvider: 'groq',
                preferLocalFirst: true,
                options: { temperature: 0.2, maxOutputTokens: 500 }
            });
            let evalText = evalResult.text.replace(/```json/gi, '').replace(/```/g, '').trim();
            const braceIdx = evalText.indexOf('{');
            if (braceIdx !== -1) {
                evalText = evalText.slice(braceIdx);
                const closeIdx = evalText.lastIndexOf('}');
                if (closeIdx !== -1) evalText = evalText.slice(0, closeIdx + 1);
                const parsed = JSON.parse(evalText);
                evaluation = { ...evaluation, ...parsed };
            }
        } catch { }

        // Adaptive unlock: proportional to weighted score, but also consider knowledge gaps
        const sorted = [...tree.nodes].sort((a, b) => a.tier - b.tier);
        const unlockRatio = Math.max(0.2, Math.min(0.9, weightedScore / 100));
        const firstTierCount = sorted.filter(n => n.tier <= 1).length;
        const unlockedCount = Math.ceil(firstTierCount * unlockRatio);

        // Build personalized unlock order: avoid nodes in knowledge gaps, prioritize strengths
        const gapNodeIds = new Set(knowledgeGaps.filter(g => g.severity > 0.5).map(g => g.nodeId));
        const unlockedNodes = [];
        sorted.forEach((n, i) => {
            if (i < unlockedCount || (!gapNodeIds.has(n.id) && unlockedNodes.length < unlockedCount)) {
                n.unlocked = true;
                n.masteryStatus = 'available';
                unlockedNodes.push(n.id);
            } else {
                n.unlocked = false;
                n.masteryStatus = 'locked';
            }
        });

        const nodesUnlocked = unlockedNodes.length;

        // Store knowledge gap report
        const gapReport = {
            analysisVersion: 1,
            analyzedAt: new Date(),
            overallAssessment: evaluation.summary,
            strongAreas: (evaluation.strengths || []).slice(0, 5).map((s, i) => ({
                nodeId: sorted[i]?.id || `s${i}`,
                nodeName: sorted[i]?.name || s,
                masteryScore: 100,
                strengths: [s]
            })),
            weakAreas: knowledgeGaps.slice(0, 10).map((g, i) => ({
                nodeId: g.nodeId,
                nodeName: g.nodeName,
                masteryScore: Math.round((1 - g.severity) * 100),
                gaps: [g.description],
                severity: g.severity,
                suggestedReviewOrder: i + 1
            })),
            commonMisconceptions: evaluation.misconceptions || [],
            recommendations: (evaluation.recommendations || []).map((r, i) => ({
                action: r, priority: i === 0 ? 'high' : i < 2 ? 'medium' : 'low',
                details: r, relatedNodes: knowledgeGaps.slice(0, 2).map(g => g.nodeId)
            })),
            suggestedReviewOrder: knowledgeGaps.sort((a, b) => b.severity - a.severity).map(g => g.nodeId),
            suggestedReading: [],
            suggestedPractice: [],
            suggestedVideos: []
        };

        const assessmentResult = {
            level, weightedScore, rawScore,
            mcqScore: typeScores.mcq || 0,
            scenarioScore: typeScores.scenario || 0,
            reasoningScore: typeScores.reasoning || 0,
            reflectionScore: typeScores.reflection || 0,
            conceptUnderstanding: evaluation.conceptUnderstanding,
            confidence: evaluation.confidence,
            misconceptions: evaluation.misconceptions || [],
            strengths: evaluation.strengths || [],
            improvements: evaluation.improvements || [],
            recommendations: evaluation.recommendations || [],
            knowledgeGaps: knowledgeGaps.map(g => g.description),
            summary: evaluation.summary || '',
            evaluatedBy: 'ai',
            answers, completedAt: new Date(),
            questionResults: qResults
        };

        // Update analytics
        const analytics = {
            overallProgress: Math.round((nodesUnlocked / tree.nodes.length) * 100),
            completionPercentage: 0,
            masteryPercentage: 0,
            weakAreas: knowledgeGaps.map(g => g.nodeName),
            strongAreas: (evaluation.strengths || []).slice(0, 5),
            timeInvested: 0,
            averageQuizScore: rawScore,
            averageAgentScore: evaluation.conceptUnderstanding || rawScore,
            learningVelocity: 0,
            currentStreak: 1,
            lastActivityDate: new Date()
        };

        await UserSkillTree.findByIdAndUpdate(treeId, {
            status: 'active',
            assessmentResult,
            knowledgeGapReport: gapReport,
            analytics,
            nodes: sorted,
            nodesUnlocked,
            lastOpenedNode: sorted.find(n => n.unlocked)?.id || null
        });

        // Create game
        const game = new SkillTreeGame({
            userId: req.user._id,
            topic: tree.title,
            assessmentResult: {
                level, summary: evaluation.summary || '',
                strengths: evaluation.strengths || [],
                improvements: evaluation.improvements || [],
                recommendedStartingPoint: level,
                answers
            },
            levels: tree.nodes.filter(n => n.unlocked).map((n, i) => ({
                id: i, name: n.name,
                description: `${n.module ? n.module + ' - ' : ''}${n.topic || ''}`.trim(),
                difficulty: n.difficulty || 'beginner',
                status: i === 0 ? 'unlocked' : 'locked',
                stars: 0, score: 0, totalQuestions: 5, creditsEarned: 0, attempts: 0
            }))
        });
        if (game.levels.length > 0) game.levels[0].status = 'unlocked';
        await game.save();
        await UserSkillTree.findByIdAndUpdate(treeId, { gameId: game._id });

        logEvent('EVALUATE_OK', `"${tree.title}"`, { rawScore, weightedScore, level, nodesUnlocked, gaps: knowledgeGaps.length });
        res.json({ assessmentResult, gameId: game._id, nodesUnlocked, totalNodes: tree.nodes.length, level });
    } catch (error) {
        logErr('EVALUATE_ERROR', error);
        res.status(500).json({ message: `Evaluation failed: ${error.message}` });
    }
});

// ─── Adaptive Unlock (Mastery-based) ──────────────────────────────────────────
router.post('/adaptive-unlock', async (req, res) => {
    try {
        const { treeId, nodeId } = req.body;
        if (!treeId || !nodeId) return res.status(400).json({ message: 'treeId and nodeId required' });

        const tree = await UserSkillTree.findOne({ _id: treeId, userId: req.user._id });
        if (!tree) return res.status(404).json({ message: 'Skill tree not found.' });

        const node = tree.nodes.find(n => n.id === nodeId);
        if (!node) return res.status(404).json({ message: 'Node not found.' });

        const masteryScore = tree.calculateMasteryScore(node);
        const threshold = node.masteryThreshold || 70;
        const newStatus = tree.determineMasteryStatus(masteryScore, threshold);

        node.masteryScore = masteryScore;
        node.masteryStatus = newStatus;

        if (newStatus === 'mastered' || newStatus === 'expert') {
            node.mastered = true;
            node.completedAt = node.completedAt || new Date();
            // Unlock dependents — but only if their prerequisites are met
            const dependents = tree.nodes.filter(n => n.prerequisites && n.prerequisites.includes(nodeId));
            dependents.forEach(dn => {
                const allPrereqsMet = dn.prerequisites.every(pid => {
                    const pn = tree.nodes.find(n => n.id === pid);
                    return pn && (pn.mastered || pn.masteryStatus === 'mastered' || pn.masteryStatus === 'expert');
                });
                if (allPrereqsMet) {
                    dn.unlocked = true;
                    dn.masteryStatus = 'available';
                }
            });
        } else if (newStatus === 'practicing') {
            // Partially unlocked — can access but not fully progress
            node.unlocked = true;
        }

        const nodesUnlocked = tree.nodes.filter(n => n.unlocked).length;
        const nodesMastered = tree.nodes.filter(n => n.mastered).length;
        const totalStars = tree.nodes.reduce((s, n) => s + (n.stars || 0), 0);

        tree.totalStarsEarned = totalStars;
        tree.nodesMastered = nodesMastered;
        tree.nodesUnlocked = nodesUnlocked;

        // Update analytics
        if (tree.analytics) {
            tree.analytics.masteryPercentage = Math.round((nodesMastered / tree.nodes.length) * 100);
            tree.analytics.completionPercentage = Math.round((nodesUnlocked / tree.nodes.length) * 100);
            tree.analytics.lastActivityDate = new Date();
        }

        await tree.save();

        logEvent('ADAPTIVE_UNLOCK', `Node "${node.name}" -> ${newStatus}`, { masteryScore, threshold });
        res.json({
            nodeId: node.id, nodeName: node.name,
            masteryScore, masteryStatus: newStatus, threshold,
            mastered: node.mastered, unlocked: node.unlocked,
            newlyUnlocked: dependents?.filter(d => d.unlocked).map(d => ({ id: d.id, name: d.name })),
            nodesUnlocked, nodesMastered, totalStars, totalNodes: tree.nodes.length
        });
    } catch (error) {
        logErr('ADAPTIVE_UNLOCK_ERROR', error);
        res.status(500).json({ message: 'Adaptive unlock failed.' });
    }
});

// ─── Knowledge Gap Analysis ────────────────────────────────────────────────────
router.post('/knowledge-gaps', async (req, res) => {
    try {
        const { treeId } = req.body;
        if (!treeId) return res.status(400).json({ message: 'treeId required' });

        const tree = await UserSkillTree.findOne({ _id: treeId, userId: req.user._id });
        if (!tree) return res.status(404).json({ message: 'Skill tree not found.' });

        // Analyze each node for gaps based on attempt history and scores
        const weakAreas = [];
        const strongAreas = [];
        const allGaps = [];

        tree.nodes.forEach(node => {
            const mScore = tree.calculateMasteryScore(node);
            if (node.attempts > 0 || node.quizScore != null) {
                if (mScore < (node.masteryThreshold || 70) * 0.6) {
                    const gaps = [];
                    if (node.quizScore != null && node.quizScore < 60) gaps.push('Low quiz performance');
                    if (!node.reflection || node.reflection.length < 10) gaps.push('Missing reflection');
                    if (node.attempts > 2 && (node.bestQuizScore || 0) < 70) gaps.push('Repeated low scores');
                    weakAreas.push({
                        nodeId: node.id, nodeName: node.name, masteryScore: mScore,
                        gaps, severity: 1 - (mScore / 100),
                        suggestedReviewOrder: weakAreas.length + 1
                    });
                    gaps.forEach(g => allGaps.push({ nodeId: node.id, nodeName: node.name, description: g }));
                } else if (mScore >= (node.masteryThreshold || 70)) {
                    strongAreas.push({
                        nodeId: node.id, nodeName: node.name, masteryScore: mScore,
                        strengths: node.agentFeedback ? ['Positive agent evaluation'] : ['Completed successfully']
                    });
                }
            }
        });

        weakAreas.sort((a, b) => a.severity - b.severity);

        const gapReport = {
            analysisVersion: (tree.knowledgeGapReport?.analysisVersion || 0) + 1,
            analyzedAt: new Date(),
            overallAssessment: weakAreas.length === 0
                ? 'Strong performance across all topics.'
                : `${weakAreas.length} area(s) need improvement.`,
            strongAreas: strongAreas.slice(0, 10),
            weakAreas: weakAreas.slice(0, 10),
            commonMisconceptions: allGaps.map(g => g.description).filter((v, i, a) => a.indexOf(v) === i),
            recommendations: weakAreas.slice(0, 5).map((w, i) => ({
                action: `Review ${w.nodeName}`,
                priority: i === 0 ? 'high' : 'medium',
                details: w.gaps.join('; '),
                relatedNodes: [w.nodeId]
            })),
            suggestedReviewOrder: weakAreas.map(w => w.nodeId),
            suggestedReading: [],
            suggestedPractice: [],
            suggestedVideos: []
        };

        tree.knowledgeGapReport = gapReport;
        if (tree.analytics) {
            tree.analytics.weakAreas = weakAreas.map(w => w.nodeName);
            tree.analytics.strongAreas = strongAreas.map(s => s.nodeName);
            tree.analytics.masteryPercentage = Math.round((strongAreas.length / Math.max(tree.nodes.filter(n => n.attempts > 0 || n.quizScore != null).length, 1)) * 100);
            tree.analytics.lastActivityDate = new Date();
        }
        await tree.save();

        logEvent('KNOWLEDGE_GAPS', `"${tree.title}"`, { weak: weakAreas.length, strong: strongAreas.length });
        res.json({ knowledgeGapReport: gapReport });
    } catch (error) {
        logErr('KNOWLEDGE_GAPS_ERROR', error);
        res.status(500).json({ message: 'Knowledge gap analysis failed.' });
    }
});

// ─── Node-Level Mini Assessment (Continuous Assessment) ────────────────────────
router.post('/node-assessment', async (req, res) => {
    const startTime = Date.now();
    try {
        const { treeId, nodeId } = req.body;
        if (!treeId || !nodeId) return res.status(400).json({ message: 'treeId and nodeId required' });

        const tree = await UserSkillTree.findOne({ _id: treeId, userId: req.user._id });
        if (!tree) return res.status(404).json({ message: 'Skill tree not found.' });

        const node = tree.nodes.find(n => n.id === nodeId);
        if (!node) return res.status(404).json({ message: 'Node not found.' });

        const prompt = `Generate 3 quick assessment questions for the topic "${node.name}" in module "${node.module || ''}" at difficulty "${node.difficulty}".

Mix types: 1 MCQ, 1 short answer, 1 scenario.
Return ONLY valid JSON array:
[{"question":"","type":"mcq","options":["","","",""],"correctIndex":0,"correctAnswer":"","explanation":"","difficulty":"${node.difficulty}","bloomsLevel":"understand"}]`;

        const result = await callWithFallback({
            userQuery: prompt, preferredProvider: 'groq', preferLocalFirst: true,
            options: { temperature: 0.3 }
        });

        let text = result.text.replace(/```json/gi, '').replace(/```/g, '').trim();
        let questions;
        try { questions = JSON.parse(text); }
        catch {
            const arrMatch = text.match(/\[[\s\S]*\]/);
            if (arrMatch) { try { questions = JSON.parse(arrMatch[0]); } catch { questions = null; } }
            else questions = null;
        }

        if (!Array.isArray(questions) || questions.length === 0) {
            questions = [
                { question: `What is the main concept of ${node.name}?`, type: 'mcq', options: ['Definition A', 'Definition B', 'Definition C', 'Definition D'], correctIndex: 0, correctAnswer: 'Definition A', explanation: 'This is the core definition.', difficulty: node.difficulty, bloomsLevel: 'remember' },
                { question: `Explain how ${node.name} applies to real-world problems.`, type: 'short_answer', correctAnswer: 'Application involves...', explanation: 'Practical application is key.', difficulty: node.difficulty, bloomsLevel: 'apply' }
            ];
        }

        logEvent('NODE_ASSESSMENT_OK', `"${node.name}"`, { questions: questions.length, timeMs: Date.now() - startTime });
        res.json({ questions, treeId, nodeId });
    } catch (error) {
        logErr('NODE_ASSESSMENT_ERROR', error);
        res.status(500).json({ message: 'Failed to generate node assessment.' });
    }
});

// ─── Submit Node-Level Assessment ──────────────────────────────────────────────
router.post('/node-assessment/submit', async (req, res) => {
    try {
        const { treeId, nodeId, questions, answers, timeSpent } = req.body;
        if (!treeId || !nodeId || !answers) return res.status(400).json({ message: 'treeId, nodeId, and answers required' });

        const tree = await UserSkillTree.findOne({ _id: treeId, userId: req.user._id });
        if (!tree) return res.status(404).json({ message: 'Skill tree not found.' });

        const node = tree.nodes.find(n => n.id === nodeId);
        if (!node) return res.status(404).json({ message: 'Node not found.' });

        let correctCount = 0;
        const results = [];
        answers.forEach((ans, i) => {
            const q = questions?.[i];
            const isCorrect = q?.correctIndex != null
                ? Number(ans.selectedIndex) === Number(q.correctIndex)
                : String(ans.text || '').toLowerCase().trim() === String(q?.correctAnswer || '').toLowerCase().trim();
            if (isCorrect) correctCount++;
            results.push({ question: q?.question || '', correct: isCorrect, expected: q?.correctAnswer || '' });
        });

        const quizScore = Math.round((correctCount / answers.length) * 100);
        node.quizScore = quizScore;
        node.lastQuizScore = quizScore;
        node.bestQuizScore = Math.max(node.bestQuizScore || 0, quizScore);
        node.quizAttempts = (node.quizAttempts || 0) + 1;
        node.attempts = (node.attempts || 0) + 1;
        node.timeInvested = (node.timeInvested || 0) + (timeSpent || 0);
        node.masteryStatus = quizScore >= (node.masteryThreshold || 70) ? 'practicing' : 'started';

        const attemptEntry = {
            timestamp: new Date(),
            quizScore,
            timeSpent: timeSpent || 0,
            evaluation: { correctness: correctCount / answers.length, reasoning: 0, depth: 0, communication: 0, application: 0 }
        };
        if (!node.attemptHistory) node.attemptHistory = [];
        node.attemptHistory.push(attemptEntry);

        if (quizScore >= (node.masteryThreshold || 70)) {
            node.mastered = true;
            node.masteryStatus = 'mastered';
            node.completedAt = node.completedAt || new Date();
            const dependents = tree.nodes.filter(n => n.prerequisites && n.prerequisites.includes(nodeId));
            dependents.forEach(dn => {
                const allMet = dn.prerequisites.every(pid => {
                    const pn = tree.nodes.find(nn => nn.id === pid);
                    return pn && (pn.mastered || pn.masteryStatus === 'mastered' || pn.masteryStatus === 'expert');
                });
                if (allMet) { dn.unlocked = true; dn.masteryStatus = 'available'; }
            });
        }

        const nodesMastered = tree.nodes.filter(n => n.mastered).length;
        const nodesUnlocked = tree.nodes.filter(n => n.unlocked).length;
        const totalStars = tree.nodes.reduce((s, n) => s + (n.stars || 0), 0);
        tree.totalStarsEarned = totalStars;
        tree.nodesMastered = nodesMastered;
        tree.nodesUnlocked = nodesUnlocked;

        if (tree.analytics) {
            tree.analytics.masteryPercentage = Math.round((nodesMastered / tree.nodes.length) * 100);
            tree.analytics.completionPercentage = Math.round((nodesUnlocked / tree.nodes.length) * 100);
            tree.analytics.averageQuizScore = tree.nodes.reduce((s, n) => s + (n.quizScore || 0), 0) / Math.max(tree.nodes.filter(n => n.quizScore != null).length, 1);
            tree.analytics.lastActivityDate = new Date();
        }

        await tree.save();

        logEvent('NODE_ASSESSMENT_SUBMIT', `"${node.name}" score=${quizScore}`, { mastered: node.mastered });
        res.json({
            success: true, nodeId, quizScore, mastered: node.mastered,
            masteryStatus: node.masteryStatus,
            results, correctCount, totalQuestions: answers.length,
            nodesUnlocked, nodesMastered, totalStars, totalNodes: tree.nodes.length
        });
    } catch (error) {
        logErr('NODE_ASSESSMENT_SUBMIT_ERROR', error);
        res.status(500).json({ message: 'Failed to submit node assessment.' });
    }
});

// ─── AI Tutor (Contextual per-node chat) ───────────────────────────────────────
router.post('/tutor', async (req, res) => {
    try {
        const { treeId, nodeId, message, history } = req.body;
        if (!treeId || !nodeId || !message) return res.status(400).json({ message: 'treeId, nodeId, and message required' });

        const tree = await UserSkillTree.findOne({ _id: treeId, userId: req.user._id });
        if (!tree) return res.status(404).json({ message: 'Skill tree not found.' });

        const node = tree.nodes.find(n => n.id === nodeId);
        if (!node) return res.status(404).json({ message: 'Node not found.' });

        const assessmentSummary = tree.assessmentResult
            ? `Student assessment: ${tree.assessmentResult.level} level, ${tree.assessmentResult.weightedScore}% weighted score. Strengths: ${(tree.assessmentResult.strengths || []).slice(0, 3).join(', ')}. Gaps: ${(tree.assessmentResult.knowledgeGaps || []).slice(0, 3).join(', ')}.`
            : 'No assessment data yet.';

        const gapInfo = tree.knowledgeGapReport
            ? `Known gaps: ${(tree.knowledgeGapReport.weakAreas || []).slice(0, 3).map(w => w.nodeName).join(', ')}`
            : '';

        const tutorPrompt = `You are an AI tutor for ${tree.title}.

Current node: ${node.name}
Module: ${node.module || 'N/A'}
Topic: ${node.topic || 'N/A'}
Difficulty: ${node.difficulty}
Learning Objective: ${node.learningObjective || 'Understand this topic'}
Estimated Time: ${node.estimatedTime || 30} minutes

${assessmentSummary}
${gapInfo}

Teaching approach: Socratic — guide the student to discover answers through questions rather than lecturing.
Be encouraging, adapt to the student's level, and connect concepts to their broader context.
If the student is struggling, break down the concept into simpler parts.
If the student shows mastery, challenge with deeper questions or real-world applications.`;

        const chatHistory = (history || []).map(m => ({
            role: m.role || 'user',
            content: m.content || ''
        }));

        const result = await callWithFallback({
            systemPrompt: tutorPrompt,
            userQuery: message,
            chatHistory,
            preferredProvider: 'groq',
            preferLocalFirst: true,
            options: { temperature: 0.4 }
        });

        logEvent('TUTOR_OK', `"${node.name}"`, { msgLen: message.length });
        res.json({ reply: result.text, nodeId, nodeName: node.name });
    } catch (error) {
        logErr('TUTOR_ERROR', error);
        res.status(500).json({ message: 'Tutor request failed.' });
    }
});

// ─── Resource Recommendations ──────────────────────────────────────────────────
router.get('/resources/:treeId/:nodeId', async (req, res) => {
    try {
        const { treeId, nodeId } = req.params;
        const tree = await UserSkillTree.findOne({ _id: treeId, userId: req.user._id }).lean();
        if (!tree) return res.status(404).json({ message: 'Skill tree not found.' });

        const node = tree.nodes.find(n => n.id === nodeId);
        if (!node) return res.status(404).json({ message: 'Node not found.' });

        const resources = {
            lecture: {
                title: `${node.name} - Lecture Notes`,
                type: 'lecture',
                description: `Comprehensive notes on ${node.name} covering ${node.module ? node.module + ' - ' : ''}${node.topic || ''}`
            },
            practice: {
                title: `${node.name} - Practice Questions`,
                type: 'practice',
                description: `Practice questions at ${node.difficulty} difficulty level`
            },
            discussion: {
                title: `${node.name} - Discussion`,
                type: 'discussion',
                description: `Discuss ${node.name} with peers and instructors`
            },
            revision: {
                title: `${node.name} - Revision Notes`,
                type: 'revision',
                description: `Quick revision summary of ${node.name}`
            },
            related: (node.relatedNodes || []).map(rid => {
                const rn = tree.nodes.find(n => n.id === rid);
                return rn ? { title: rn.name, type: 'reading', description: `Related topic: ${rn.name}`, relatedNodeId: rn.id } : null;
            }).filter(Boolean)
        };

        res.json({ resources, nodeId, nodeName: node.name });
    } catch (error) {
        logErr('RESOURCES_ERROR', error);
        res.status(500).json({ message: 'Failed to fetch resources.' });
    }
});

// ─── Analytics ─────────────────────────────────────────────────────────────────
router.get('/analytics/:id', async (req, res) => {
    try {
        const tree = await UserSkillTree.findOne(
            { _id: req.params.id, userId: req.user._id },
            { title: 1, courseName: 1, nodeCount: 1, nodesUnlocked: 1, nodesMastered: 1,
              totalStarsEarned: 1, totalXpEarned: 1, analytics: 1,
              knowledgeGapReport: 1, assessmentResult: 1, nodes: 1,
              status: 1, createdAt: 1, updatedAt: 1 }
        ).lean();

        if (!tree) return res.status(404).json({ message: 'Skill tree not found.' });

        const nodeAnalytics = (tree.nodes || []).map(n => ({
            id: n.id, name: n.name, module: n.module, difficulty: n.difficulty,
            masteryStatus: n.masteryStatus || 'locked',
            masteryScore: n.masteryScore || 0,
            quizScore: n.quizScore,
            bestQuizScore: n.bestQuizScore,
            attempts: n.attempts || 0,
            timeInvested: n.timeInvested || 0,
            stars: n.stars || 0,
            unlocked: n.unlocked,
            mastered: n.mastered
        }));

        const analytics = tree.analytics || {};
        const totalTimeInvested = nodeAnalytics.reduce((s, n) => s + (n.timeInvested || 0), 0);
        const avgQuizScore = nodeAnalytics.filter(n => n.quizScore != null).length > 0
            ? Math.round(nodeAnalytics.filter(n => n.quizScore != null).reduce((s, n) => s + n.quizScore, 0) / nodeAnalytics.filter(n => n.quizScore != null).length)
            : null;
        const masteredCount = nodeAnalytics.filter(n => n.mastered).length;
        const inProgressCount = nodeAnalytics.filter(n => n.unlocked && !n.mastered).length;

        res.json({
            treeId: tree._id,
            title: tree.title,
            status: tree.status,
            summary: {
                totalNodes: tree.nodeCount || nodeAnalytics.length,
                nodesUnlocked: tree.nodesUnlocked || 0,
                nodesMastered: masteredCount,
                nodesInProgress: inProgressCount,
                completionPercentage: analytics.completionPercentage || Math.round(((tree.nodesUnlocked || 0) / Math.max(tree.nodeCount || 1, 1)) * 100),
                masteryPercentage: analytics.masteryPercentage || Math.round((masteredCount / Math.max(tree.nodeCount || 1, 1)) * 100),
                totalStarsEarned: tree.totalStarsEarned || 0,
                totalXpEarned: tree.totalXpEarned || 0,
                timeInvested: totalTimeInvested,
                averageQuizScore: avgQuizScore,
                averageAgentScore: analytics.averageAgentScore,
                learningVelocity: analytics.learningVelocity || 0,
                currentStreak: analytics.currentStreak || 0
            },
            strongAreas: analytics.strongAreas || [],
            weakAreas: analytics.weakAreas || [],
            gapReport: tree.knowledgeGapReport || null,
            assessment: tree.assessmentResult ? {
                level: tree.assessmentResult.level,
                weightedScore: tree.assessmentResult.weightedScore,
                rawScore: tree.assessmentResult.rawScore,
                strengths: tree.assessmentResult.strengths,
                improvements: tree.assessmentResult.improvements,
                recommendations: tree.assessmentResult.recommendations
            } : null,
            nodeAnalytics,
            lastActivityDate: analytics.lastActivityDate,
            createdAt: tree.createdAt,
            updatedAt: tree.updatedAt
        });
    } catch (error) {
        logErr('ANALYTICS_ERROR', error);
        res.status(500).json({ message: 'Failed to fetch analytics.' });
    }
});

// ─── Resume State ──────────────────────────────────────────────────────────────
router.put('/resume', async (req, res) => {
    try {
        const { treeId, resumeState } = req.body;
        if (!treeId || !resumeState) return res.status(400).json({ message: 'treeId and resumeState required' });

        const tree = await UserSkillTree.findOne({ _id: treeId, userId: req.user._id });
        if (!tree) return res.status(404).json({ message: 'Skill tree not found.' });

        tree.resumeState = { ...tree.resumeState, ...resumeState, updatedAt: new Date() };
        await tree.save();

        res.json({ success: true, resumeState: tree.resumeState });
    } catch (error) {
        logErr('RESUME_ERROR', error);
        res.status(500).json({ message: 'Failed to save resume state.' });
    }
});

router.get('/resume/:id', async (req, res) => {
    try {
        const tree = await UserSkillTree.findOne(
            { _id: req.params.id, userId: req.user._id },
            { resumeState: 1, lastOpenedNode: 1, status: 1, gameId: 1 }
        ).lean();

        if (!tree) return res.status(404).json({ message: 'Skill tree not found.' });
        res.json({ resumeState: tree.resumeState || {}, lastOpenedNode: tree.lastOpenedNode, status: tree.status, gameId: tree.gameId });
    } catch (error) {
        logErr('RESUME_FETCH_ERROR', error);
        res.status(500).json({ message: 'Failed to fetch resume state.' });
    }
});

// ─── Progress ──────────────────────────────────────────────────────────────────
router.put('/progress', async (req, res) => {
    try {
        const { treeId, nodeId, progress } = req.body;
        if (!treeId || !nodeId) return res.status(400).json({ message: 'treeId and nodeId required' });

        const tree = await UserSkillTree.findOne({ _id: treeId, userId: req.user._id });
        if (!tree) return res.status(404).json({ message: 'Skill tree not found.' });

        const node = tree.nodes.find(n => n.id === nodeId);
        if (!node) return res.status(404).json({ message: 'Node not found.' });

        if (progress.stars !== undefined) node.stars = Math.min(3, Math.max(0, progress.stars));
        if (progress.mastered !== undefined) node.mastered = progress.mastered;
        if (progress.quizScore !== undefined) {
            node.quizScore = progress.quizScore;
            node.bestQuizScore = Math.max(node.bestQuizScore || 0, progress.quizScore);
        }
        if (progress.reflection !== undefined) node.reflection = progress.reflection;
        if (progress.agentFeedback !== undefined) node.agentFeedback = progress.agentFeedback;
        if (progress.attempts !== undefined) node.attempts = progress.attempts;
        if (progress.unlocked !== undefined) node.unlocked = progress.unlocked;
        if (progress.masteryStatus) node.masteryStatus = progress.masteryStatus;
        if (progress.masteryScore !== undefined) node.masteryScore = progress.masteryScore;
        if (progress.timeInvested !== undefined) node.timeInvested = (node.timeInvested || 0) + progress.timeInvested;

        // Adaptive unlock: only if mastery threshold met
        if (progress.mastered || (progress.stars && progress.stars >= 2)) {
            const masteryScore = tree.calculateMasteryScore(node);
            const threshold = node.masteryThreshold || 70;
            if (masteryScore >= threshold) {
                node.unlocked = true;
                node.mastered = true;
                node.masteryStatus = masteryScore >= 95 ? 'expert' : 'mastered';
                node.completedAt = node.completedAt || new Date();

                const nextNodes = tree.nodes.filter(n => n.prerequisites && n.prerequisites.includes(nodeId));
                nextNodes.forEach(n => {
                    const allMet = n.prerequisites.every(pid => {
                        const pn = tree.nodes.find(x => x.id === pid);
                        return pn && (pn.mastered || pn.masteryStatus === 'mastered' || pn.masteryStatus === 'expert');
                    });
                    if (allMet) { n.unlocked = true; n.masteryStatus = 'available'; }
                });
            }
        }

        const totalStars = tree.nodes.reduce((s, n) => s + (n.stars || 0), 0);
        const nodesMastered = tree.nodes.filter(n => n.mastered).length;
        const nodesUnlocked = tree.nodes.filter(n => n.unlocked).length;

        tree.totalStarsEarned = totalStars;
        tree.nodesMastered = nodesMastered;
        tree.nodesUnlocked = nodesUnlocked;
        tree.lastOpenedNode = nodeId;

        if (tree.analytics) {
            tree.analytics.masteryPercentage = Math.round((nodesMastered / tree.nodes.length) * 100);
            tree.analytics.completionPercentage = Math.round((nodesUnlocked / tree.nodes.length) * 100);
            tree.analytics.lastActivityDate = new Date();
        }

        await tree.save();

        res.json({
            success: true,
            node: { id: node.id, unlocked: node.unlocked, mastered: node.mastered, stars: node.stars, masteryStatus: node.masteryStatus, completedAt: node.completedAt },
            totalStars, nodesMastered, nodesUnlocked, totalNodes: tree.nodes.length
        });
    } catch (error) {
        logErr('PROGRESS_ERROR', error);
        res.status(500).json({ message: 'Failed to update progress.' });
    }
});

// ─── Delete ────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
    try {
        const tree = await UserSkillTree.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
        if (!tree) return res.status(404).json({ message: 'Skill tree not found.' });
        if (tree.gameId) await SkillTreeGame.findByIdAndDelete(tree.gameId);
        logEvent('DELETE_OK', `"${tree.title}"`);
        res.json({ success: true, message: 'Skill tree deleted.' });
    } catch (error) {
        logErr('DELETE_ERROR', error);
        res.status(500).json({ message: 'Failed to delete skill tree.' });
    }
});

module.exports = router;
