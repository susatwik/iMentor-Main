const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

const { buildTemplateLecture } = require('../services/lectureTemplateBuilder');
const { validateLecture } = require('../services/lectureQualityValidator');
const Lecture = require('../models/Lecture');
const { redisClient, connectRedis } = require('../config/redisClient');

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (c === ',' && !inQuotes) { result.push(current.trim()); current = ''; continue; }
    current += c;
  }
  result.push(current.trim());
  return result;
}

function extractSubtopics(subtopicsStr) {
  if (!subtopicsStr || subtopicsStr === 'None' || subtopicsStr === 'none') return [];
  return subtopicsStr.split(/[,;]/).map(s => s.trim()).filter(s => s.length > 3);
}

function slugify(text) {
  return text
    .replace(/[^a-zA-Z0-9_ ]/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

async function clearAllCachedLectures() {
  if (redisClient && redisClient.isOpen) {
    const keys = await redisClient.keys('lecture:*');
    if (keys.length > 0) {
      await redisClient.del(keys);
      console.log(`Cleared ${keys.length} Redis lecture keys`);
    } else {
      console.log('No Redis lecture keys found');
    }
  }

  const count = await Lecture.countDocuments({});
  if (count > 0) {
    await Lecture.deleteMany({});
    console.log(`Cleared ${count} MongoDB lecture documents`);
  }
}

function getAllSubtopics() {
  const bootstrapDir = path.join(__dirname, '..', 'course_bootstrap');
  const dirs = fs.readdirSync(bootstrapDir).filter(d => {
    const p = path.join(bootstrapDir, d);
    return fs.statSync(p).isDirectory() && d[0] !== '.';
  });

  const entries = [];
  for (const course of dirs.sort()) {
    const courseDir = path.join(bootstrapDir, course);
    const files = fs.readdirSync(courseDir);
    const syllabusFile = files.find(f => /syllabus/i.test(f) && (f.endsWith('.csv') || f.endsWith('.CSV')));
    if (!syllabusFile) {
      console.log(`  SKIP ${course}: no syllabus.csv`);
      continue;
    }

    const content = fs.readFileSync(path.join(courseDir, syllabusFile), 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    let courseName = course;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.match(/^#/) || line.match(/^Course Code|^Module,/)) continue;
      const cols = parseCSVLine(line);
      if (cols.length < 5) {
        if (cols.length >= 3 && cols[2].trim()) {
          // Alternate format: module,topic,subtopics
          const moduleName = cols[0] || '';
          const topicName = cols[1] || '';
          const subtopicsStr = cols.slice(2).join(',');
          const subtopics = extractSubtopics(subtopicsStr);
          for (const sub of subtopics) {
            entries.push({ course, courseName, subtopicId: slugify(sub), subtopicName: sub, topicName, moduleName });
          }
        }
        continue;
      }

      if (cols[1] && cols[1] !== courseName && cols[1] !== course && !cols[1].includes(cols[0])) {
        courseName = cols[1];
      }

      const topicName = cols[3] || '';
      const subtopicsStr = cols[4] || '';
      const moduleName = cols[2] || '';
      const subtopics = extractSubtopics(subtopicsStr);

      if (subtopics.length === 0) {
        entries.push({ course, courseName, subtopicId: slugify(topicName), subtopicName: topicName, topicName, moduleName });
      } else {
        for (const sub of subtopics) {
          entries.push({ course, courseName, subtopicId: slugify(sub), subtopicName: sub, topicName, moduleName });
        }
      }
    }
  }
  return entries;
}

async function run() {
  await mongoose.connect('mongodb://127.0.0.1:27017/imentor');
  await connectRedis();

  console.log('\n=== STEP 1: Clear existing cached lectures ===');
  await clearAllCachedLectures();

  console.log('\n=== STEP 2: Scan all course syllabi ===');
  const entries = getAllSubtopics();
  console.log(`Found ${entries.length} subtopics`);

  console.log('\n=== STEP 3: Generate template lectures for all subtopics ===');
  let saved = 0, failed = 0, pass = 0, fail = 0;
  const seen = new Set();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const key = `${entry.course}:${entry.subtopicId}`;
    if (seen.has(key)) { continue; }
    seen.add(key);

    process.stdout.write(`  [${i + 1}/${entries.length}] ${key} ... `);

    try {
      const result = buildTemplateLecture(
        entry.course,
        entry.subtopicId,
        entry.subtopicName,
        entry.topicName,
        entry.moduleName
      );

      const validation = validateLecture(result.markdown, entry.subtopicId, entry.subtopicName, entry.course);
      if (!validation.valid) {
        console.log(`VALIDATION FAILED: ${validation.reasons.join(', ')}`);
        fail++;
        continue;
      }

      const lectureData = {
        course: entry.course,
        subtopicId: entry.subtopicId,
        subtopicName: entry.subtopicName || '',
        topicName: entry.topicName || '',
        moduleName: entry.moduleName || '',
        markdown: result.markdown,
        html: result.html || '',
        conceptMap: '',
        contentType: entry.subtopicId ? 'subtopic' : 'full_lecture',
        source: 'template_fallback',
      };

      await Lecture.findOneAndUpdate(
        { course: entry.course, subtopicId: entry.subtopicId },
        { $set: lectureData },
        { upsert: true }
      );

      const cacheKey = `lecture:${entry.course}:${entry.subtopicId}`;
      if (redisClient && redisClient.isOpen) {
        await redisClient.setEx(cacheKey, 7 * 24 * 3600, JSON.stringify(lectureData));
      }

      const wc = result.markdown.split(/\s+/).filter(Boolean).length;
      console.log(`OK (${wc}w)`);
      saved++;
      if (validation.valid) pass++;
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      failed++;
    }
  }

  console.log('\n=== FINAL REPORT ===');
  const storedCount = await Lecture.countDocuments({});
  console.log(`Total unique subtopics: ${seen.size}`);
  console.log(`Saved to MongoDB/Redis: ${saved}`);
  console.log(`Template validation pass: ${pass}`);
  console.log(`Errors: ${failed}`);
  console.log(`Total stored in MongoDB: ${storedCount}`);

  // Final audit sample
  console.log('\n=== AUDIT SAMPLES (first 10) ===');
  const samples = await Lecture.find({}).limit(10).lean();
  for (const s of samples) {
    const v = validateLecture(s.markdown, s.subtopicId, s.subtopicName, s.course);
    const wc = s.markdown?.split(/\s+/).filter(Boolean).length || 0;
    console.log(`  ${s.course}/${s.subtopicId}: ${wc}w, source=${s.source}, valid=${v.valid}`);
  }

  await mongoose.disconnect();
  if (redisClient && redisClient.isOpen) await redisClient.quit();
}

run().catch(e => { console.error(e); process.exit(1); });
