const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

const COURSE_DIR = path.join(__dirname, '..', 'server', 'course_bootstrap');
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27018/imentor';

async function seedCourses() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const entries = fs.readdirSync(COURSE_DIR, { withFileTypes: true });
  const courseDirs = entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(name => !name.startsWith('.'))
    .sort();

  console.log(`Found ${courseDirs.length} course directories in course_bootstrap/`);

  const AdminDocument = mongoose.model('AdminDocument', new mongoose.Schema({
    filename: String,
    originalName: String,
    text: String,
    analysis: {
      faq: String,
      topics: String,
      mindmap: String,
    },
    uploadedAt: Date,
    analysisUpdatedAt: Date,
  }));

  let inserted = 0;
  let skipped = 0;

  for (const course of courseDirs) {
    const existing = await AdminDocument.findOne({ originalName: course });
    if (existing) {
      skipped++;
      continue;
    }
    await AdminDocument.create({
      filename: `${Date.now()}-${course}`,
      originalName: course,
      text: `Auto-seeded course: ${course}`,
      uploadedAt: new Date(),
    });
    inserted++;
  }

  const total = await AdminDocument.countDocuments();
  console.log(`Done: ${inserted} inserted, ${skipped} skipped, ${total} total in AdminDocument`);
  await mongoose.disconnect();
}

seedCourses().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
