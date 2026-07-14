// server/server.js — Unified Chat Repository (Team3 base + Team1-6 features)
const dotenv = require("dotenv");
const path = require('path');
const fs = require('fs');
const envPath = path.join(__dirname, '.env');
dotenv.config({ path: envPath });

require('./instrument.js');
const { register, httpRequestDurationMicroseconds } = require('./utils/metrics');
const Sentry = require("@sentry/node");

const express = require("express");
const cors = require("cors");
const helmet = require("helmet"); // [Team1-6] Security headers
const mongoSanitize = require("express-mongo-sanitize"); // [Team1-6] NoSQL injection prevention
const axios = require("axios");
const mongoose = require("mongoose");

// --- Custom Modules & Middleware ---
const connectDB = require("./config/db");
const { getLocalIPs } = require("./utils/networkUtils");
const { performAssetCleanup } = require("./utils/assetCleanup");
const { authMiddleware } = require("./middleware/authMiddleware");
const { adminAuthMiddleware } = require('./middleware/adminAuthMiddleware');
const { connectRedis } = require("./config/redisClient");
const log = require('./utils/logger');
const { checkEmailCredentials } = require('./services/emailService');
const { verifyCoursesIntegrity, invalidateCurriculumCaches } = require('./services/courseIntegrityService');
const { auditRedisUsage } = require('./services/redisAuditService');
const { closeConnection: closeNeo4j } = require("./config/neo4j"); // [Team1-6] Neo4j graceful shutdown
const { bootstrapCoursesOnStartup } = require('./services/startupCourseBootstrapService');
const {
  authLimiter,
  chatLimiter,
  researchLimiter,
  toolsLimiter
} = require('./middleware/rateLimitMiddleware');

// --- Route Imports ---
const networkRoutes = require("./routes/network");
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/user");
const chatRoutes = require("./routes/chat");
const uploadRoutes = require("./routes/upload");
const analysisRoutes = require("./routes/analysis");
const adminMasterRouter = require('./routes/index');
const subjectsRoutes = require("./routes/subjects");
const coursesRoutes = require("./routes/courses");
const generationRoutes = require("./routes/generationRoutes");
const exportRoutes = require("./routes/export");
const kgRoutes = require("./routes/kg");
const llmConfigRoutes = require("./routes/llmConfig");
const toolsRoutes = require("./routes/tools");
const learningRoutes = require("./routes/learning");
const learningPathRoutes = require("./routes/learningPath");
const knowledgeSourceRoutes = require("./routes/knowledgeSource");
const analyticsRoutes = require('./routes/analytics');
const feedbackRoutes = require('./routes/feedback');
const finetuningRoutes = require('./routes/finetuning');
const gamificationRoutes = require('./routes/gamification');
const knowledgeStateRoutes = require('./routes/knowledgeState');
const filesRoutes = require('./routes/files');
const researchRoutes = require('./routes/research');
const debugRoutes = require('./routes/debug');
const guestChatRoutes = require('./routes/guestChat');
const deepResearchRoutes = require('./routes/deepResearch'); // [Team1-6] Deep research
const tutorRoutes = require('./routes/tutor'); // [Team1-6] Socratic tutor
const socraticRoutes = require('./routes/socratic'); // [Team1-6] Socratic sessions
const studyModeRoutes = require('./routes/studyMode'); // Study questions + skill tree
const quizRoutes = require('./routes/quiz'); // [Team1] Quiz system with knowledge gap analysis
const adaptiveProfileRoutes = require('./routes/adaptiveProfile'); // [Team8] Adaptive learning profiles
const { setupAdmin } = require('./scripts/setupAdmin');

// --- Course Material File Watcher ---
const chokidar = require('chokidar');

// --- Cron Jobs ---
const { startBossBattleCleanup } = require('./jobs/bossBattleCleanup');
const { startBossBattleGenerator } = require('./jobs/bossBattleGenerator');
const { startBountyCleanup } = require('./jobs/bountyCleanup');
const { startBountyGenerator } = require('./jobs/bountyGenerator');
const { startSpacedRepetitionScheduler } = require('./jobs/spacedRepetitionScheduler');
// REMOVED: Nightly session evaluator cron job - now runs via maintenance script
// const { startNightlySessionEvaluator } = require('./jobs/nightlySessionEvaluator');

const ENABLE_CRON = process.env.ENABLE_CRON !== 'false';

// --- Configuration & Express App Setup ---
const port = process.env.PORT || 5001;
const mongoUri = process.env.MONGO_URI;
const pythonRagUrl = process.env.PYTHON_RAG_SERVICE_URL;

const cpursesDir = path.join(__dirname, 'Cpurses');

/** Call RAG service to ingest any new PDFs in Cpurses/ — fires on startup and on file additions. */
async function triggerCpursesIngestion(reason = 'startup') {
  if (!pythonRagUrl) return;
  try {
    const resp = await axios.post(`${pythonRagUrl}/ingest/cpurses`, {}, { timeout: 10000 });
    log.info('SYSTEM', `Course PDF ingestion triggered (${reason}): ${JSON.stringify(resp.data)}`);
  } catch (e) {
    log.warn('SYSTEM', `Course PDF ingestion trigger failed (${reason}): ${e.message}`);
  }
}

/**
 * Trigger the full course material pipeline (PDF→Markdown→Qdrant→STN→STN Qdrant)
 * via the Python RAG service.  Runs in background, is resumable on restart.
 */
async function triggerMaterialPipeline(reason = 'startup') {
  if (!pythonRagUrl) return;
  try {
    const resp = await axios.post(`${pythonRagUrl}/pipeline/run`, {}, { timeout: 15000 });
    log.info('SYSTEM', `Material pipeline triggered (${reason}): ${JSON.stringify(resp.data)}`);
  } catch (e) {
    log.warn('SYSTEM', `Material pipeline trigger failed (${reason}): ${e.message}`);
  }
}

/** Watch Cpurses/ AND course_bootstrap/ for new PDF files and re-trigger pipelines. */
const bootstrapDir = path.join(__dirname, 'course_bootstrap');

function startCourseFileWatchers() {
  const watchDirs = [];
  if (fs.existsSync(cpursesDir)) watchDirs.push(cpursesDir);
  if (fs.existsSync(bootstrapDir)) watchDirs.push(bootstrapDir);

  if (watchDirs.length === 0) {
    log.warn('SYSTEM', 'No course directories found — file watchers not started.');
    return;
  }

  let debounceTimer = null;
  const watcher = chokidar.watch(watchDirs, {
    ignored: /(^|[/\\])[\._]|_processed|_markdown|_markdown_backup|_stn_backup/,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 500 },
  });
  watcher.on('add', (filePath) => {
    if (!filePath.toLowerCase().endsWith('.pdf')) return;
    log.info('SYSTEM', `New course PDF detected: ${filePath}`);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      // Trigger both: Cpurses ingestion + full pipeline for course_bootstrap
      triggerCpursesIngestion('file-watcher');
      triggerMaterialPipeline('file-watcher');
    }, 5000);
  });
  log.info('SYSTEM', `Course file watchers started on: ${watchDirs.join(', ')}`);
}

if (!process.env.JWT_SECRET || !process.env.ENCRYPTION_SECRET) {
  log.error('SYSTEM', "JWT_SECRET or ENCRYPTION_SECRET is not set in .env file.");
  process.exit(1);
}
if (!mongoUri) {
  log.error('SYSTEM', "MONGO_URI is not set in .env file.");
  process.exit(1);
}

const app = express();

// --- Security Middleware Stack [Team1-6] ---
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "connect-src": ["'self'", "ws:", "wss:", "http:", "https:"],
      },
    },
  })
);
app.use(mongoSanitize()); // Prevent NoSQL injection

const configuredFrontendOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

// If FRONTEND_PORT is given without a full FRONTEND_URL, also allow that port on localhost
const frontendPort = process.env.FRONTEND_PORT;
const portDerivedOrigins = frontendPort
  ? [`http://localhost:${frontendPort}`, `http://127.0.0.1:${frontendPort}`]
  : [];

const allowedOrigins = new Set([
  ...configuredFrontendOrigins,
  ...portDerivedOrigins,
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
]);

app.use((req, res, next) => {
  // Allow Chrome's Private Network Access (PNA) preflight for local dev
  if (req.method === 'OPTIONS' && req.headers['access-control-request-private-network']) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  next();
});

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    const isLocalDevOrigin = /^https?:\/\/(localhost|127\.0\.0\.1|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?$/.test(origin);
    if (allowedOrigins.has(origin) || isLocalDevOrigin) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked origin: ${origin}`));
  },
  credentials: true
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use((req, res, next) => {
  const end = httpRequestDurationMicroseconds.startTimer();
  res.on('finish', () => {
    end({ route: req.route?.path || req.path, code: res.statusCode, method: req.method });
  });
  next();
});

// --- API Route Mounting ---
app.get("/", (req, res) => res.send("AI Tutor Backend API is running..."));
app.get("/health", (req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// --- Public Routes (No Authentication Required) ---
app.use("/api/network", networkRoutes);
app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/guest", guestChatRoutes);

// --- Admin Routes (Uses its own adminAuthMiddleware) ---
app.use('/api/admin/analytics', adminAuthMiddleware, analyticsRoutes);
app.use('/api/admin/finetuning', adminAuthMiddleware, finetuningRoutes);
app.use('/api/admin/gamification', adminAuthMiddleware, require('./routes/adminGamification'));
app.use("/api/admin", adminAuthMiddleware, adminMasterRouter);

// --- Protected User Routes (Requires standard authMiddleware) ---
// The authMiddleware is now passed as the second argument, applying it specifically to these routers.
app.use("/api/user", authMiddleware, userRoutes);
app.use("/api/chat", authMiddleware, chatLimiter, chatRoutes);
app.use("/api/upload", authMiddleware, uploadRoutes);
app.use("/api/files", authMiddleware, filesRoutes);
app.use("/api/analysis", authMiddleware, analysisRoutes);
app.use("/api/subjects", authMiddleware, subjectsRoutes);
app.use("/api/courses", authMiddleware, coursesRoutes);
app.use("/api/generate", authMiddleware, generationRoutes);
app.use("/api/export", authMiddleware, exportRoutes);
app.use("/api/kg", authMiddleware, kgRoutes);
app.use("/api/llm", authMiddleware, llmConfigRoutes);
app.use("/api/tools", authMiddleware, toolsLimiter, toolsRoutes);
app.use("/api/learning", authMiddleware, learningRoutes);
app.use("/api/learning/paths", authMiddleware, learningPathRoutes);
app.use("/api/knowledge-sources", authMiddleware, knowledgeSourceRoutes);
app.use('/api/feedback', authMiddleware, feedbackRoutes);
app.use('/api/gamification', authMiddleware, gamificationRoutes);

// --- Course Matching Routes (CSV upload, validate, autocomplete) ---
app.use('/api/course-matching', authMiddleware, require('./routes/index_skilltreeCourseMatching'));

// --- Skill Tree Course Bridge (Course → Skill Tree reuse pipeline) ---
app.use('/api/skill-tree', authMiddleware, require('./routes/skillTreeCourseBridge'));

// --- Internal Service Routes (Python → Node.js callbacks, no JWT required) ---
const { syncSkillTreeToMongo } = require('./services/skillTreeSyncService');
app.post('/api/internal/skill-tree/sync', (req, res, next) => {
    // Simple shared-secret auth for internal service-to-service calls
    const token = req.header('X-Internal-Token') || req.header('Authorization')?.replace('Bearer ', '');
    const expected = process.env.INTERNAL_SERVICE_TOKEN;
    if (expected && token !== expected) {
        return res.status(403).json({ message: 'Invalid internal service token.' });
    }
    next();
}, async (req, res) => {
    try {
        const { course, skill_tree } = req.body;
        if (!course || !skill_tree || !Array.isArray(skill_tree)) {
            return res.status(400).json({ message: 'Missing course or skill_tree array.' });
        }
        log.info('SYSTEM', `Skill tree sync from Python for '${course}' — ${skill_tree.length} nodes`);
        const result = await syncSkillTreeToMongo(course, skill_tree);
        log.success('SYSTEM', `Skill tree synced: ${result.created} created, ${result.updated} updated`);
        res.json({ success: true, ...result });
    } catch (error) {
        log.error('SYSTEM', `Skill tree sync error: ${error.message}`);
        res.status(500).json({ message: 'Skill tree sync failed.' });
    }
});
app.use('/api/knowledge-state', authMiddleware, knowledgeStateRoutes);
app.use('/api/research', authMiddleware, researchLimiter, researchRoutes);
app.use('/api/deep-research', authMiddleware, researchLimiter, deepResearchRoutes); // [Team1-6] Deep research
app.use('/api/tutor', authMiddleware, tutorRoutes); // [Team1-6] Socratic tutor
app.use('/api/socratic', authMiddleware, socraticRoutes); // [Team1-6] Socratic sessions
app.use('/api/study-mode', authMiddleware, studyModeRoutes); // Study questions + skill tree
app.use('/api/debug', authMiddleware, debugRoutes);
app.use('/api/progress', authMiddleware, require('./routes/progress'));
app.use('/api/jobs', authMiddleware, require('./routes/jobs'));
app.use('/api/quiz', authMiddleware, quizRoutes); // [Team1] Quiz generation, submission & grading
app.use('/api/question-bank', authMiddleware, require('./routes/questionBank')); // Question Bank CRUD
app.use('/api/adaptive-profile', authMiddleware, adaptiveProfileRoutes); // [Team8] Student adaptive learning profiles
app.use('/api/assessment', authMiddleware, require('./routes/knowledgeAssessment')); // Knowledge Assessment Engine

// --- Sentry Error Handler ---
Sentry.setupExpressErrorHandler(app);

// --- Centralized Error Handling ---
app.use((err, req, res, next) => {
  log.error('SYSTEM', `Unhandled Error: ${err.message}`, err, `Check ${req.method} ${req.originalUrl}`);

  const statusCode = err.status || 500;
  const message = err.message || "An internal server error occurred.";
  if (!res.headersSent) {
    res.status(statusCode).json({ message });
  }
});

// --- Server Startup Logic ---
async function startServer() {
  log.info('SYSTEM', "Starting Server Initialization...");
  try {
    await setupAdmin(mongoUri);
    await ensureServerDirectories();
    await connectDB(mongoUri);
    await checkEmailCredentials();
    await performAssetCleanup();
    await checkRagService(pythonRagUrl);
    await connectRedis();
    
    // Bootstrap and integrity checks moved to offline jobs for faster server startup
    // Run scripts/maintenanceJobs.js for full course integrity verification
    // Courses are expected to be pre-configured via offline jobs
    
    await auditRedisUsage();

    // --- Course material processing disabled on server startup ---
    // Use offline maintenance jobs (scripts/maintenanceJobs.js) for:
    //   - Course PDF ingestion (Cpurses/)
    //   - Material pipeline (course_bootstrap/ → PDF→Markdown→Qdrant→STN)
    // This prevents redundant processing and keeps server startup fast.
    
    // --- Watch course directories for new PDFs ---
    startCourseFileWatchers();

    // --- Start Gamification Cron Jobs ---
    if (ENABLE_CRON) {
      log.info('SYSTEM', 'Starting gamification cron jobs...');
      startBountyGenerator();
      startBountyCleanup();
      startBossBattleGenerator();
      startBossBattleCleanup();
      startSpacedRepetitionScheduler();
      log.success('SYSTEM', 'All gamification cron jobs started successfully');

      // --- MAINTENANCE MODE APPROACH (replaces nightly cron) ---
      // Heavy offline jobs (KG extraction, XP scoring, skill tree questions, course updates)
      // are now run via: node scripts/maintenanceJobs.js
      // Run during daily maintenance window when frontend is offline for users.
      log.info('SYSTEM', '[MAINTENANCE] For offline jobs, run: node scripts/maintenanceJobs.js');
    } else {
      log.warn('SYSTEM', 'Cron jobs are DISABLED (ENABLE_CRON=false)');
    }

    const server = app.listen(port, "0.0.0.0", () => {
      log.success('SYSTEM', `Server listening on port ${port}`);
    });

    // --- Initialize Semantic Router ---
    log.info('SYSTEM', 'Initializing semantic router...');
    const { initialize: initializeSemanticRouter } = require('./services/semanticRouter');
    initializeSemanticRouter()
      .then(() => log.success('SYSTEM', 'Semantic router initialized successfully'))
      .catch((err) => log.error('SYSTEM', `Semantic router initialization failed: ${err.message}. Will fall back to keyword routing.`));

    // --- Initialize Socket.io ---
    const { initSocket } = require("./services/socketService");
    initSocket(server);
    log.success('SYSTEM', 'Socket.io initialized successfully');

    const gracefulShutdown = async (signal) => {
      log.info('SYSTEM', `${signal} received. Shutting down...`);
      server.close(async () => {
        try {
          await mongoose.connection.close();
          log.info('SYSTEM', "MongoDB connection closed.");
          await closeNeo4j(); // [Team1-6] Close Neo4j connection
          log.info('SYSTEM', "Neo4j connection closed.");
          process.exit(0);
        } catch (err) {
          log.error('SYSTEM', "Error closing connections", err);
          process.exit(1);
        }
      });
    };
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  } catch (error) {
    log.error('SYSTEM', "Failed to start Node.js server", error);
    process.exit(1);
  }
}

// Helper functions
async function ensureServerDirectories() {
  const dirs = [
    path.join(__dirname, "assets"),
    path.join(__dirname, "backup_assets"),
    path.join(__dirname, "generated_docs"),
    path.join(__dirname, "course_bootstrap"),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) await fs.promises.mkdir(dir, { recursive: true });
  }
}

async function checkRagService(url) {
  if (!url) {
    log.warn('SYSTEM', "Python RAG service URL not configured.");
    return;
  }
  try {
    const response = await axios.get(`${url}/health`, { timeout: 7000 });
    if (response.data.status === "ok") {
      log.success('SYSTEM', "Python RAG service is available.");
    } else {
      log.warn('SYSTEM', `Python RAG service responded but is not healthy. Status: ${response.data.status}`);
    }
  } catch (error) {
    log.warn('SYSTEM', `Python RAG service is not reachable at ${url}.`);
  }
}

startServer();