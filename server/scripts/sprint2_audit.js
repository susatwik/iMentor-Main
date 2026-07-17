const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const Lecture = require('../models/Lecture');
const { validateLecture } = require('../services/lectureQualityValidator');

// ── PDF courses (definitive list) ──────────────────────────────────
const PDF_COURSES = [
  { code: 'MA1011', name: 'Principles of Differential and Integral Calculus', sem: 1, cat: 'BSC', credits: 3 },
  { code: 'EE1011', name: 'Basic Electrical Circuits', sem: 1, cat: 'PCC', credits: 3 },
  { code: 'PH1021', name: 'Physics for Electrical Engineering', sem: 1, cat: 'BSC', credits: 3 },
  { code: 'ME1021', name: 'Basics of Mechanical Engineering', sem: 1, cat: 'ESC', credits: 2 },
  { code: 'CS1031', name: 'Problem Solving through Computer Programming', sem: 1, cat: 'ESC', credits: 3 },
  { code: 'CS1032', name: 'Problem Solving through Computer Programming Lab', sem: 1, cat: 'ESC', credits: 2 },
  { code: 'PE1012', name: 'Physical Education I', sem: 1, cat: 'HSC', credits: 1 },
  { code: 'HS1011', name: 'English for Engineers-I', sem: 2, cat: 'HSC', credits: 2 },
  { code: 'MA1021', name: 'Matrices and Differential Equations', sem: 2, cat: 'BSC', credits: 3 },
  { code: 'CY1021', name: 'Chemistry of Energy Systems', sem: 2, cat: 'BSC', credits: 2 },
  { code: 'EE1021', name: 'Analog Electronics', sem: 2, cat: 'PCC', credits: 3 },
  { code: 'EE1031', name: 'Electrical Network Analysis', sem: 2, cat: 'PCC', credits: 3 },
  { code: 'CS2101', name: 'Data Structures and Applications', sem: 2, cat: 'ESC', credits: 3 },
  { code: 'CS2102', name: 'Data Structures and Applications Lab', sem: 2, cat: 'ESC', credits: 1 },
  { code: 'ME1072', name: 'Engineering Graphics with CAD', sem: 2, cat: 'ESC', credits: 1 },
  { code: 'PE1022', name: 'Physical Education II', sem: 2, cat: 'HSC', credits: 1 },
  { code: 'EE2011', name: 'Measurements and Instrumentation', sem: 3, cat: 'PCC', credits: 3 },
  { code: 'EE2021', name: 'DC Machines and Transformers', sem: 3, cat: 'PCC', credits: 3 },
  { code: 'EE2031', name: 'Power System Generation and Transmission', sem: 3, cat: 'PCC', credits: 3 },
  { code: 'EE2041', name: 'Digital Electronics', sem: 3, cat: 'PCC', credits: 3 },
  { code: 'MA2051', name: 'Complex Variables and Mathematical Methods', sem: 3, cat: 'BSC', credits: 3 },
  { code: 'EE2012', name: 'Analog and Digital Circuits Lab', sem: 3, cat: 'PCC', credits: 2 },
  { code: 'EE2022', name: 'Circuits and Measurements Lab', sem: 3, cat: 'PCC', credits: 2 },
  { code: 'HS2012', name: 'NCC/Social Services', sem: 3, cat: 'HSC', credits: 1 },
  { code: 'EC1521', name: 'Signals and Systems for Electrical Engineers', sem: 4, cat: 'ESC', credits: 3 },
  { code: 'HS2011', name: 'Personality Development', sem: 4, cat: 'HSC', credits: 1 },
  { code: 'PE2012', name: 'Yoga', sem: 4, cat: 'HSC', credits: 1 },
  { code: 'EE2051', name: 'AC Rotating Machines', sem: 4, cat: 'PCC', credits: 3 },
  { code: 'EE2061', name: 'Control Systems', sem: 4, cat: 'PCC', credits: 3 },
  { code: 'EE2071', name: 'Power Systems Analysis', sem: 4, cat: 'PCC', credits: 4 },
  { code: 'EE2010', name: 'Minor Project (Audit Course) - I', sem: 4, cat: 'PCC', credits: 0 },
  { code: 'EE2032', name: 'DC Machines and Transformers Lab', sem: 4, cat: 'PCC', credits: 2 },
  { code: 'MA2092', name: 'Numerical Methods Lab', sem: 4, cat: 'BSC', credits: 1 },
  { code: 'EE3011', name: 'Power Electronics', sem: 5, cat: 'PCC', credits: 3 },
  { code: 'EE3021', name: 'Power System Protection and Control', sem: 5, cat: 'PCC', credits: 3 },
  { code: 'SM3021', name: 'Design Thinking', sem: 5, cat: 'HSC', credits: 1 },
  { code: 'EE2042', name: 'Control Systems Lab', sem: 5, cat: 'PCC', credits: 2 },
  { code: 'EE2052', name: 'AC Rotating Machines Lab', sem: 5, cat: 'PCC', credits: 2 },
  { code: 'EE2062', name: 'Power Systems & Renewable Energy Lab', sem: 5, cat: 'PCC', credits: 2 },
  { code: 'EE3031', name: 'Embedded Systems', sem: 6, cat: 'PCC', credits: 3 },
  { code: 'EE3041', name: 'Electric Power Drives', sem: 6, cat: 'PCC', credits: 3 },
  { code: 'SM3011', name: 'Introduction to Entrepreneurship', sem: 6, cat: 'HSC', credits: 1 },
  { code: 'EE3012', name: 'Power Electronics Lab', sem: 6, cat: 'PCC', credits: 2 },
  { code: 'EE3022', name: 'Embedded Systems Lab', sem: 6, cat: 'PCC', credits: 1 },
  { code: 'EE3010', name: 'Minor Project (Audit Course)-II', sem: 6, cat: 'PCC', credits: 0 },
  { code: 'EE3032', name: 'Electric Power Drives Lab', sem: 7, cat: 'PCC', credits: 2 },
  { code: 'EE4014', name: 'Professional Major Work', sem: 7, cat: 'PRC', credits: 6 },
  { code: 'EE4024', name: 'Semester-Long Internship', sem: 8, cat: 'SLI', credits: 6 },
  // DEC electives
  { code: 'EE2601', name: 'Basics of Internet of Things', sem: 4, cat: 'DEC', credits: 3 },
  { code: 'EE2611', name: 'Renewable Power Generation', sem: 4, cat: 'DEC', credits: 3 },
  { code: 'EE2621', name: 'Introduction to Machine Learning', sem: 4, cat: 'DEC', credits: 3 },
  { code: 'EE3601', name: 'Advanced Control Systems', sem: 5, cat: 'DEC', credits: 3 },
  { code: 'EE3611', name: 'Wind and Solar Electrical Systems', sem: 5, cat: 'DEC', credits: 3 },
  { code: 'EE3621', name: 'Digital Signal Processing', sem: 5, cat: 'DEC', credits: 3 },
  { code: 'EE3631', name: 'Soft Computing Techniques', sem: 5, cat: 'DEC', credits: 3 },
  { code: 'EE3641', name: 'Introduction to Electric Vehicles', sem: 5, cat: 'DEC', credits: 3 },
  { code: 'EE3651', name: 'Advanced Computer Methods in Power Systems', sem: 5, cat: 'DEC', credits: 3 },
  { code: 'EE3661', name: 'Advanced Power Electronics', sem: 5, cat: 'DEC', credits: 3 },
  { code: 'EE3671', name: 'Industrial Instrumentation and Automation', sem: 6, cat: 'DEC', credits: 3 },
  { code: 'EE3681', name: 'Converters for Renewable Energy Systems', sem: 6, cat: 'DEC', credits: 3 },
  { code: 'EE3691', name: 'Deep Learning Algorithms', sem: 6, cat: 'DEC', credits: 3 },
  { code: 'EE3701', name: 'Electrical Machine Design', sem: 6, cat: 'DEC', credits: 3 },
  { code: 'EE3711', name: 'Introduction to Smart Grid', sem: 6, cat: 'DEC', credits: 3 },
  { code: 'EE3721', name: 'Battery Energy Storage and EV Charging Systems', sem: 6, cat: 'DEC', credits: 3 },
  { code: 'EE3731', name: 'Power System Security and Reliability', sem: 6, cat: 'DEC', credits: 3 },
  { code: 'EE3741', name: 'Switched Mode Power Supplies', sem: 6, cat: 'DEC', credits: 3 },
  { code: 'EE3751', name: 'New Venture Creation', sem: 6, cat: 'DEC', credits: 3 },
  { code: 'EE4601', name: 'Energy Management and Audit', sem: 7, cat: 'DEC', credits: 3 },
  { code: 'EE4611', name: 'Power Quality Improvement', sem: 7, cat: 'DEC', credits: 3 },
  { code: 'EE4621', name: 'Distribution System Planning and Automation', sem: 7, cat: 'DEC', credits: 3 },
  { code: 'EE4631', name: 'Special Machines', sem: 7, cat: 'DEC', credits: 3 },
  // HSC / Liberal Arts
  { code: 'HS3011', name: 'English for Engineers II', sem: 6, cat: 'HSC', credits: 3 },
  { code: 'HS3021', name: 'German/Other Foreign Languages', sem: 6, cat: 'HSC', credits: 2 },
  { code: 'HS3031', name: 'Indian Philosophy', sem: 6, cat: 'HSC', credits: 1 },
  { code: 'HS3041', name: 'Introduction to Psychology', sem: 6, cat: 'HSC', credits: 1 },
  { code: 'HS3051', name: 'Psychology of Wellbeing', sem: 6, cat: 'HSC', credits: 1 },
  { code: 'HS3061', name: 'Introduction to Mass Communication', sem: 6, cat: 'HSC', credits: 1 },
  { code: 'HS3071', name: 'Introduction to Media Studies', sem: 6, cat: 'HSC', credits: 1 },
  { code: 'HS3081', name: 'Vedic Maths', sem: 6, cat: 'HSC', credits: 3 },
  { code: 'HS3091', name: 'Indian Heritage and Culture', sem: 6, cat: 'HSC', credits: 1 },
  { code: 'HS3101', name: 'Indian Business History', sem: 6, cat: 'HSC', credits: 1 },
  { code: 'HS3111', name: 'Post-Harvest Technology', sem: 6, cat: 'HSC', credits: 1 },
  { code: 'HS3121', name: 'Ethics in Technology', sem: 6, cat: 'HSC', credits: 1 },
  { code: 'HS3131', name: 'Financial Marketing', sem: 6, cat: 'HSC', credits: 1 },
  { code: 'HS3141', name: 'Bharatiya Nyaya Sanhita: Indian Judicial Code Overview', sem: 6, cat: 'HSC', credits: 1 },
  { code: 'HS3151', name: 'Introduction to the Constitution of India', sem: 6, cat: 'HSC', credits: 1 },
  { code: 'HS3162', name: 'Photography', sem: 6, cat: 'HSC', credits: 1 },
  { code: 'HS3172', name: 'Pottery', sem: 6, cat: 'HSC', credits: 1 },
  { code: 'HS3182', name: 'Painting', sem: 6, cat: 'HSC', credits: 1 },
  { code: 'HS3192', name: 'Music', sem: 6, cat: 'HSC', credits: 1 },
  { code: 'HS3501', name: 'Sanskrit', sem: 7, cat: 'HSC', credits: 3 },
  { code: 'HS3511', name: 'Introduction to Academic Writing', sem: 7, cat: 'HSC', credits: 1 },
  { code: 'HS3521', name: 'Contemporary Issues in Philosophy of Mind & Cognition', sem: 7, cat: 'HSC', credits: 1 },
  { code: 'HS3531', name: 'Psychology and Mental Health', sem: 7, cat: 'HSC', credits: 1 },
  { code: 'HS3541', name: 'Psychology at Work', sem: 7, cat: 'HSC', credits: 1 },
  { code: 'HS3551', name: 'Introduction to Journalism', sem: 7, cat: 'HSC', credits: 1 },
  { code: 'HS3561', name: 'Introduction to Film Studies', sem: 7, cat: 'HSC', credits: 1 },
  { code: 'HS3571', name: 'Introduction to Anthropology', sem: 7, cat: 'HSC', credits: 1 },
  { code: 'HS3581', name: 'Ethics for AI', sem: 7, cat: 'HSC', credits: 1 },
  { code: 'HS3591', name: 'Introduction to Sociology', sem: 7, cat: 'HSC', credits: 1 },
  { code: 'HS3601', name: 'Personal Finance', sem: 7, cat: 'HSC', credits: 1 },
  { code: 'HS3611', name: 'Introductory Economics', sem: 7, cat: 'HSC', credits: 1 },
  { code: 'HS3621', name: 'Cyber Law for Engineers', sem: 7, cat: 'HSC', credits: 1 },
  { code: 'HS3631', name: 'Food and Nutrition', sem: 7, cat: 'HSC', credits: 1 },
  { code: 'HS3641', name: 'Youth, Gender and Identity', sem: 7, cat: 'HSC', credits: 1 },
  { code: 'HS3652', name: 'Dance', sem: 7, cat: 'HSC', credits: 1 },
  { code: 'HS3662', name: 'Theatre Arts', sem: 7, cat: 'HSC', credits: 1 },
  { code: 'HS3672', name: 'Sculpture', sem: 7, cat: 'HSC', credits: 1 },
  { code: 'HS3682', name: 'Introduction to Animation', sem: 7, cat: 'HSC', credits: 1 },
  { code: 'HS2052', name: 'National Service Scheme', sem: 7, cat: 'HSC', credits: 1 },
];

const LEGACY_COURSES = ['EE1611', 'EE1621', 'ME1013'];
const PDF_CODE_SET = new Set(PDF_COURSES.map(c => c.code));
const bootstrapDir = path.join(__dirname, '..', 'course_bootstrap');

async function run() {
  await mongoose.connect('mongodb://127.0.0.1:27017/imentor');

  const results = {};

  // ── Phase 1: Bootstrap verification ──────────────────────────────
  console.log('\n=== PHASE 1: BOOTSTRAP VERIFICATION ===');
  const bootDirs = fs.readdirSync(bootstrapDir)
    .filter(d => fs.statSync(path.join(bootstrapDir, d)).isDirectory() && !d.startsWith('.'));

  let csvOk = 0, csvMissing = 0, empty = 0, unexpected = [];
  for (const d of bootDirs) {
    const dirPath = path.join(bootstrapDir, d);
    const files = fs.readdirSync(dirPath);
    const hasCSV = files.some(f => /syllabus/i.test(f) && (f.endsWith('.csv') || f.endsWith('.CSV')));
    const isEmpty = files.length === 0;

    if (isEmpty) empty++;
    else if (hasCSV && PDF_CODE_SET.has(d)) csvOk++;
    else if (!hasCSV) csvMissing++;
    if (!PDF_CODE_SET.has(d) && !LEGACY_COURSES.includes(d)) unexpected.push(d);
  }

  results.bootstrap = {
    totalDirs: bootDirs.length,
    csvOk,
    csvMissing,
    empty,
    unexpected,
  };
  console.log(`  Directories: ${bootDirs.length}`);
  console.log(`  With syllabus.csv: ${csvOk}`);
  console.log(`  Missing CSV: ${csvMissing}`);
  console.log(`  Empty: ${empty}`);
  console.log(`  Unexpected: ${unexpected.join(', ') || 'none'}`);

  // Count legacy dirs
  for (const lc of LEGACY_COURSES) {
    const exists = bootDirs.includes(lc);
    console.log(`  Legacy ${lc}: ${exists ? 'present' : 'not found'}`);
  }

  // ── Phase 2: Course Inventory ────────────────────────────────────
  console.log('\n=== PHASE 2: COURSE INVENTORY ===');
  const mongoCourses = await Lecture.distinct('course');
  const mongoSet = new Set(mongoCourses);
  const counts = await Lecture.aggregate([
    { $group: { _id: '$course', count: { $sum: 1 } } }
  ]);
  const lectureCounts = {};
  for (const c of counts) lectureCounts[c._id] = c.count;

  let complete = 0, missingLecture = 0, missingBootstrap = 0, legacy = 0;

  // Check quiz models exist
  const Quiz = (() => { try { return require('../models/QuestionBank'); } catch(e) { return null; } })();
  let quizCounts = {};
  if (Quiz) {
    const quizAgg = await Quiz.aggregate([{ $group: { _id: '$course', count: { $sum: 1 } } }]);
    for (const q of quizAgg) quizCounts[q._id] = q.count;
  }

  results.inventory = { courses: [] };
  for (const c of PDF_COURSES) {
    const inBootstrap = bootDirs.includes(c.code);
    const inMongo = mongoSet.has(c.code);
    const lCount = lectureCounts[c.code] || 0;
    const qCount = quizCounts[c.code] || 0;
    const status = [];
    if (!inBootstrap) { status.push('⚠ Missing CSV'); missingBootstrap++; }
    if (lCount === 0) { status.push('⚠ Missing Lecture'); missingLecture++; }
    else complete++;
    results.inventory.courses.push({ ...c, bootstrap: inBootstrap, mongo: inMongo, lectures: lCount, quizzes: qCount, status: status.join(', ') || '✓ Complete' });
  }

  console.log(`  Complete: ${complete}/${PDF_COURSES.length}`);
  console.log(`  Missing lectures: ${missingLecture}`);
  console.log(`  Missing bootstrap: ${missingBootstrap}`);

  // ── Phase 3: Lecture Verification ────────────────────────────────
  console.log('\n=== PHASE 3: LECTURE VERIFICATION ===');
  const allLectures = await Lecture.find({}).lean();
  let totalWc = 0, shortest = Infinity, longest = 0, shortestId = '', longestId = '';
  let failed = 0, passed = 0, dupes = {}, sectionCounts = {};

  const seenMarkdown = new Set();
  let duplicateCount = 0;

  for (const lec of allLectures) {
    const wc = (lec.markdown || '').split(/\s+/).filter(Boolean).length;
    totalWc += wc;
    if (wc < shortest) { shortest = wc; shortestId = `${lec.course}/${lec.subtopicId}`; }
    if (wc > longest) { longest = wc; longestId = `${lec.course}/${lec.subtopicId}`; }

    const val = validateLecture(lec.markdown, lec.subtopicId, lec.subtopicName, lec.course);
    if (val.valid) passed++;
    else { failed++;
      if (failed <= 5) console.log(`  FAIL: ${lec.course}/${lec.subtopicId}: ${val.reasons.join(', ')}`);
    }

    // Check duplicate markdown
    const mdHash = (lec.markdown || '').substring(0, 500);
    if (seenMarkdown.has(mdHash)) duplicateCount++;
    else seenMarkdown.add(mdHash);

    // Section counts
    const headings = (lec.markdown || '').match(/^## /gm);
    if (headings) {
      const hCount = headings.length;
      sectionCounts[hCount] = (sectionCounts[hCount] || 0) + 1;
    }
  }

  results.lectures = {
    total: allLectures.length,
    averageWc: Math.round(totalWc / allLectures.length),
    shortest, shortestId, longest, longestId,
    passed, failed, duplicates: duplicateCount,
  };
  console.log(`  Total: ${allLectures.length}`);
  console.log(`  Average words: ${Math.round(totalWc / allLectures.length)}`);
  console.log(`  Shortest: ${shortest}w (${shortestId})`);
  console.log(`  Longest: ${longest}w (${longestId})`);
  console.log(`  Validated PASS: ${passed}`);
  console.log(`  Validated FAIL: ${failed}`);
  console.log(`  Duplicate content: ${duplicateCount}`);
  console.log(`  Section distribution:`);
  for (const [k, v] of Object.entries(sectionCounts).sort((a, b) => a[0] - b[0])) {
    console.log(`    ${k} sections: ${v} lectures`);
  }

  // ── Phase 5: MongoDB Integrity ───────────────────────────────────
  console.log('\n=== PHASE 5: MONGODB INTEGRITY ===');
  const orphanCourses = mongoCourses.filter(c => !PDF_CODE_SET.has(c) && !LEGACY_COURSES.includes(c));
  results.mongo = {
    totalDocuments: allLectures.length,
    distinctCourses: mongoCourses.length,
    pdfCoursesInMongo: mongoCourses.filter(c => PDF_CODE_SET.has(c)).length,
    extraCourses: mongoCourses.filter(c => !PDF_CODE_SET.has(c) && !LEGACY_COURSES.includes(c)),
    legacyInMongo: mongoCourses.filter(c => LEGACY_COURSES.includes(c)),
  };
  console.log(`  Total documents: ${allLectures.length}`);
  console.log(`  Distinct courses: ${mongoCourses.length}`);
  console.log(`  PDF courses present: ${results.mongo.pdfCoursesInMongo}`);
  console.log(`  Extra (not in PDF): ${orphanCourses.join(', ') || 'none'}`);
  console.log(`  Legacy in Mongo: ${results.mongo.legacyInMongo.join(', ') || 'none'}`);

  // ── Phase 7: Legacy Summary ─────────────────────────────────────
  console.log('\n=== PHASE 9: LEGACY COURSE AUDIT ===');
  for (const lc of LEGACY_COURSES) {
    const inBoot = bootDirs.includes(lc);
    const inM = mongoSet.has(lc);
    const lCount = lectureCounts[lc] || 0;
    console.log(`  ${lc}: bootstrap=${inBoot}, mongo=${inM}, lectures=${lCount}`);
  }

  // ── Phase 10: Statistics ─────────────────────────────────────────
  console.log('\n=== PHASE 10: STATISTICS ===');
  const bootstrapDirsWithCSV = bootDirs.filter(d => {
    const files = fs.readdirSync(path.join(bootstrapDir, d));
    return files.some(f => /syllabus/i.test(f) && (f.endsWith('.csv') || f.endsWith('.CSV')));
  });

  const totalModules = await Lecture.distinct('moduleName');
  const totalTopics = await Lecture.distinct('topicName');

  results.stats = {
    courses: PDF_COURSES.length,
    bootstrapDirs: bootstrapDirsWithCSV.length,
    mongoDocuments: allLectures.length,
    lectures: allLectures.length,
    modules: totalModules.length,
    distinctTopics: totalTopics.length,
    avgWordCount: Math.round(totalWc / allLectures.length),
    validationPassRate: Math.round(passed / allLectures.length * 100) + '%',
    coverage: Math.round(mongoCourses.filter(c => PDF_CODE_SET.has(c)).length / PDF_COURSES.length * 100) + '%',
  };

  console.log(`  PDF Courses: ${PDF_COURSES.length}`);
  console.log(`  Bootstrap Dirs with CSV: ${bootstrapDirsWithCSV.length}`);
  console.log(`  MongoDB Documents: ${allLectures.length}`);
  console.log(`  Avg Word Count: ${Math.round(totalWc / allLectures.length)}`);
  console.log(`  Validation Pass Rate: ${Math.round(passed / allLectures.length * 100)}%`);
  console.log(`  Coverage: ${Math.round(mongoCourses.filter(c => PDF_CODE_SET.has(c)).length / PDF_COURSES.length * 100)}%`);

  results.validationPassRate = Math.round(passed / allLectures.length * 100);
  results.coveragePercent = Math.round(mongoCourses.filter(c => PDF_CODE_SET.has(c)).length / PDF_COURSES.length * 100);

  await mongoose.disconnect();
  return results;
}

run()
  .then(r => {
    // Determine status
    if (r.validationPassRate === 100 && r.coveragePercent === 100 && r.lectures.failed === 0 && r.lectures.total > 0) {
      console.log('\n🟢 Sprint 2 Complete — Production Ready');
    } else if (r.validationPassRate >= 95 && r.coveragePercent >= 95) {
      console.log('\n🟡 Sprint 2 Complete — Minor Issues Remaining');
    } else {
      console.log('\n🔴 Sprint 2 Requires Additional Fixes');
    }
    // Write results
    fs.writeFileSync(
      path.join(__dirname, '..', '..', 'SPRINT_2_AUDIT_RESULTS.json'),
      JSON.stringify(r, null, 2)
    );
  })
  .catch(e => { console.error(e); process.exit(1); });
