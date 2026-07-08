const fs = require('fs');
const path = require('path');
const axios = require('axios');
const log = require('../utils/logger');

const DEFAULT_BOOTSTRAP_DIR = path.join(__dirname, '..', 'course_bootstrap');

function normalizeCourseName(value) {
  return String(value || '').trim().toLowerCase();
}

async function fetchExistingGraphCourses(pythonServiceUrl) {
  if (!pythonServiceUrl) return [];

  try {
    const response = await axios.get(`${pythonServiceUrl}/curriculum/courses`, { timeout: 8000 });
    if (response.data?.success && Array.isArray(response.data?.courses)) {
      return response.data.courses;
    }
  } catch (error) {
    log.warn('SYSTEM', `Startup bootstrap: failed to read curriculum courses: ${error.message}`);
  }

  return [];
}

function getCourseNameFromPrefix(prefix) {
  if (prefix.toLowerCase() === 'os') {
    return 'Operating Systems';
  }
  return prefix
    .replace(/[_-]/g, ' ')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

async function readSeedCourseFolders(bootstrapDir) {
  const courseFolders = [];
  const processedNames = new Set();

  // 1. Read from bootstrapDir
  if (fs.existsSync(bootstrapDir)) {
    const entries = await fs.promises.readdir(bootstrapDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const courseName = entry.name.trim();
      if (!courseName) continue;

      const courseDir = path.join(bootstrapDir, entry.name);
      const files = await fs.promises.readdir(courseDir);

      // Prefer unified 5-column CSV format; fall back to 22-col then any CSV
      let syllabusCsvPath = path.join(courseDir, 'syllabus_unified.csv');
      if (!fs.existsSync(syllabusCsvPath)) {
        syllabusCsvPath = path.join(courseDir, 'syllabus.csv');
      }
      if (!fs.existsSync(syllabusCsvPath)) {
        const firstCsv = files.find(file => file.toLowerCase().endsWith('.csv'));
        if (firstCsv) {
          syllabusCsvPath = path.join(courseDir, firstCsv);
        }
      }

      const materialsFolderCandidate = path.join(courseDir, 'materials');
      const materialsFolder = fs.existsSync(materialsFolderCandidate)
        ? materialsFolderCandidate
        : courseDir;

      courseFolders.push({
        courseName,
        courseDir,
        syllabusCsvPath,
        materialsFolder,
        hasSyllabus: fs.existsSync(syllabusCsvPath),
        hasMaterialsDir: fs.existsSync(materialsFolder) && fs.statSync(materialsFolder).isDirectory(),
      });
      processedNames.add(courseName.toLowerCase());
    }
  }

  // 2. Dynamically scan server/rag_service/data/ for extra courses
  const ragDataDir = path.join(__dirname, '..', 'rag_service', 'data');
  if (fs.existsSync(ragDataDir)) {
    try {
      const ragEntries = await fs.promises.readdir(ragDataDir, { withFileTypes: true });
      for (const entry of ragEntries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('_syllabus.csv')) continue;

        const fileName = entry.name;
        const prefix = fileName.slice(0, -13); // Remove "_syllabus.csv"
        const courseName = getCourseNameFromPrefix(prefix);

        if (processedNames.has(courseName.toLowerCase())) {
          continue;
        }

        const syllabusCsvPath = path.join(ragDataDir, fileName);
        const materialsFolderCandidate = path.join(ragDataDir, `${prefix}_materials`);
        const materialsFolder = fs.existsSync(materialsFolderCandidate) ? materialsFolderCandidate : ragDataDir;

        courseFolders.push({
          courseName,
          courseDir: ragDataDir,
          syllabusCsvPath,
          materialsFolder,
          hasSyllabus: fs.existsSync(syllabusCsvPath),
          hasMaterialsDir: fs.existsSync(materialsFolder) && fs.statSync(materialsFolder).isDirectory(),
        });
        processedNames.add(courseName.toLowerCase());
        log.info('SYSTEM', `Startup bootstrap discovered course '${courseName}' in rag_service/data dynamically.`);
      }
    } catch (err) {
      log.error('SYSTEM', `Failed to dynamically scan rag_service/data for courses: ${err.message}`);
    }
  }

  return courseFolders;
}

async function ingestMissingCourse({ pythonServiceUrl, courseName, syllabusCsvPath, materialsFolder }) {
  const response = await axios.post(
    `${pythonServiceUrl}/course/ingest`,
    {
      course_name: courseName,
      syllabus_csv_path: syllabusCsvPath,
      materials_folder: materialsFolder,
      user_id: 'system_startup',
    },
    { timeout: 600000 }
  );

  return response.data;
}

async function bootstrapCoursesOnStartup({
  pythonServiceUrl = process.env.PYTHON_RAG_SERVICE_URL,
  bootstrapDir = process.env.STARTUP_COURSE_SEED_DIR || DEFAULT_BOOTSTRAP_DIR,
  enabled = process.env.ENABLE_STARTUP_COURSE_SEED !== 'false',
} = {}) {
  const summary = {
    enabled,
    bootstrapDir,
    discovered: 0,
    skippedExisting: [],
    skippedInvalid: [],
    ingested: [],
    failed: [],
  };

  if (!enabled) {
    log.info('SYSTEM', 'Startup bootstrap skipped: ENABLE_STARTUP_COURSE_SEED=false');
    return summary;
  }

  if (!pythonServiceUrl) {
    log.warn('SYSTEM', 'Startup bootstrap skipped: PYTHON_RAG_SERVICE_URL is not configured.');
    return summary;
  }

  const seedCourses = await readSeedCourseFolders(bootstrapDir);
  summary.discovered = seedCourses.length;

  if (seedCourses.length === 0) {
    log.info('SYSTEM', `Startup bootstrap: no seed courses found in '${bootstrapDir}'.`);
    return summary;
  }

  const existingGraphCourses = await fetchExistingGraphCourses(pythonServiceUrl);
  const existingSet = new Set(existingGraphCourses.map(normalizeCourseName));

  for (const seed of seedCourses) {
    const normalized = normalizeCourseName(seed.courseName);

    if (!seed.hasSyllabus || !seed.hasMaterialsDir) {
      summary.skippedInvalid.push({
        courseName: seed.courseName,
        reason: !seed.hasSyllabus
          ? 'Missing syllabus CSV (expected syllabus.csv or any .csv file in course folder)'
          : 'Missing materials directory',
      });
      continue;
    }

    if (existingSet.has(normalized)) {
      summary.skippedExisting.push(seed.courseName);
      continue;
    }

    try {
      await ingestMissingCourse({
        pythonServiceUrl,
        courseName: seed.courseName,
        syllabusCsvPath: seed.syllabusCsvPath,
        materialsFolder: seed.materialsFolder,
      });
      existingSet.add(normalized);
      summary.ingested.push(seed.courseName);
      log.success('SYSTEM', `Startup bootstrap: ingested missing course '${seed.courseName}'.`);
    } catch (error) {
      const message = error.response?.data?.error
        || error.response?.data?.message
        || error.message;
      summary.failed.push({ courseName: seed.courseName, error: message });
      log.warn('SYSTEM', `Startup bootstrap: failed to ingest '${seed.courseName}': ${message}`);
    }
  }

  log.info('SYSTEM', 'Startup bootstrap summary:', summary);
  return summary;
}

module.exports = {
  bootstrapCoursesOnStartup,
};
