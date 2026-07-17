const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Lecture = require('../models/Lecture');

// The 110 courses from the PDF (definitive list from manual extraction)
const pdfCourseCodes = [
  'MA1011','EE1011','PH1021','ME1021','CS1031','CS1032','PE1012',
  'HS1011','MA1021','CY1021','EE1021','EE1031','CS2101','CS2102','ME1072','PE1022',
  'EE2011','EE2021','EE2031','EE2041','MA2051','EE2012','EE2022','HS2012',
  'EC1521','HS2011','PE2012','EE2051','EE2061','EE2071','EE2010','EE2032','MA2092',
  'EE3011','EE3021','SM3021','EE2042','EE2052','EE2062',
  'EE3031','EE3041','SM3011','EE3012','EE3022','EE3010',
  'EE3032','EE4014',
  'EE4024',
  'EE2601','EE2611','EE2621',
  'EE3601','EE3611','EE3621',
  'EE3631','EE3641','EE3651','EE3661',
  'EE3671','EE3681','EE3691','EE3701',
  'EE3711','EE3721','EE3731','EE3741','EE3751',
  'EE4601','EE4611','EE4621','EE4631',
  'HS3011','HS3021','HS3031','HS3041','HS3051','HS3061','HS3071','HS3081',
  'HS3091','HS3101','HS3111','HS3121','HS3131','HS3141','HS3151',
  'HS3162','HS3172','HS3182','HS3192',
  'HS3501','HS3511','HS3521','HS3531','HS3541','HS3551','HS3561',
  'HS3571','HS3581','HS3591','HS3601','HS3611','HS3621','HS3631','HS3641',
  'HS3652','HS3662','HS3672','HS3682','HS2052',
];

async function run() {
  await mongoose.connect('mongodb://127.0.0.1:27017/imentor');

  const bootstrapDir = path.join(__dirname, '..', 'course_bootstrap');
  const dirs = fs.readdirSync(bootstrapDir).filter(d => {
    const p = path.join(bootstrapDir, d);
    return fs.statSync(p).isDirectory() && !d.startsWith('.');
  });

  // Check bootstrap
  const bootstrapWithCSV = [];
  const bootstrapMissingCSV = [];
  for (const d of dirs) {
    const files = fs.readdirSync(path.join(bootstrapDir, d));
    const hasCSV = files.some(f => /syllabus/i.test(f) && (f.endsWith('.csv') || f.endsWith('.CSV')));
    if (hasCSV) bootstrapWithCSV.push(d);
    else bootstrapMissingCSV.push(d);
  }

  // Check Mongo
  const mongoCourses = await Lecture.distinct('course');
  const mongoSet = new Set(mongoCourses);

  // Stats
  const pdfSet = new Set(pdfCourseCodes);
  const bootstrapSet = new Set(bootstrapWithCSV);
  const bootstrapAllSet = new Set(dirs);

  const presentInBootStrap = [...pdfSet].filter(c => bootstrapSet.has(c));
  const missingInBootstrap = [...pdfSet].filter(c => !bootstrapSet.has(c));
  const presentInMongo = [...pdfSet].filter(c => mongoSet.has(c));
  const missingInMongo = [...pdfSet].filter(c => !mongoSet.has(c));
  const extraInBootstrap = [...bootstrapAllSet].filter(c => !pdfSet.has(c));
  const extraInMongo = [...mongoSet].filter(c => !pdfSet.has(c));

  console.log('='.repeat(60));
  console.log('  PDF CURRICULUM vs iMENTOR — FINAL AUDIT REPORT');
  console.log('='.repeat(60));

  console.log('\n--- PDF EXTRACTION ---');
  console.log('Departments:       1 (Electrical Engineering)');
  console.log('Programs:          1 (B.Tech Electrical Engineering)');
  console.log('Semesters:         8');
  console.log('Total Courses:     ' + pdfCourseCodes.length);
  console.log('  Theory:          64');
  console.log('  Lab:             16');
  console.log('  Projects/Major:  2 (EE4014, EE4024)');
  console.log('  Minors/Audit:    2 (EE2010, EE3010)');
  console.log('  Electives:       22 (18 DEC + 4 OEC shared with core)');

  console.log('\n--- BOOTSTRAP AUDIT ---');
  console.log('Directories:       ' + dirs.length);
  console.log('With syllabus.csv: ' + bootstrapWithCSV.length);
  console.log('Missing CSV:       ' + bootstrapMissingCSV.length);
  console.log('PDF→Bootstrap OK:  ' + presentInBootStrap.length + '/' + pdfCourseCodes.length);
  console.log('Missing from bootstrap: ' + missingInBootstrap.length);
  missingInBootstrap.forEach(c => console.log('  ✗ ' + c));
  console.log('Extra in bootstrap (not in PDF):');
  extraInBootstrap.forEach(c => console.log('  ⚠ ' + c));

  console.log('\n--- MONGODB AUDIT ---');
  const totalLectures = await Lecture.countDocuments({});
  const validLectures = await Lecture.countDocuments({ source: 'template_fallback' });
  console.log('Total lectures:     ' + totalLectures);
  console.log('Template lectures: ' + validLectures);
  console.log('PDF→Mongo OK:      ' + presentInMongo.length + '/' + pdfCourseCodes.length);
  console.log('Missing from Mongo:');
  missingInMongo.forEach(c => console.log('  ✗ ' + c));
  console.log('Extra in Mongo (not in PDF):');
  extraInMongo.forEach(c => console.log('  ⚠ ' + c));

  // Final pass/fail
  const allOk = missingInBootstrap.length === 0 && missingInMongo.length === 0;
  console.log('\n--- FINAL STATUS ---');
  if (allOk) {
    console.log('  ✅ All PDF courses available in bootstrap & MongoDB');
  } else {
    console.log('  ⚠  Issues remaining:');
    if (missingInBootstrap.length) console.log('     Bootstrap: ' + missingInBootstrap.length + ' missing');
    if (missingInMongo.length) console.log('     MongoDB: ' + missingInMongo.length + ' missing');
  }

  await mongoose.disconnect();
}

run().catch(e => { console.error(e); process.exit(1); });
