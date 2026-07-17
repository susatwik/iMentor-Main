const mongoose = require('mongoose');
const Lecture = require('../models/Lecture');
const { buildTemplateLecture } = require('../services/lectureTemplateBuilder');
const { validateLecture } = require('../services/lectureQualityValidator');
const { redisClient, connectRedis } = require('../config/redisClient');

async function main() {
  await mongoose.connect('mongodb://127.0.0.1:27017/imentor');
  await connectRedis();

  const missing = [
    { code: 'CS2102', name: 'Data Structures and Applications Lab', topics: ['Implementation of data structures', 'Sorting and searching algorithms', 'Graph algorithms', 'Tree traversals'] },
    { code: 'EE2010', name: 'Minor Project (Audit Course) - I', topics: ['Project planning', 'Literature review', 'Design and simulation', 'Report writing'] },
    { code: 'MA2092', name: 'Numerical Methods Lab', topics: ['Bisection method', 'Newton-Raphson method', 'Numerical integration', 'Differential equation solvers'] },
    { code: 'SM3021', name: 'Design Thinking', topics: ['Empathize and Define', 'Ideate', 'Prototype', 'Test', 'User-centered design', 'Rapid prototyping', 'Design sprint'] },
    { code: 'EE3010', name: 'Minor Project (Audit Course)-II', topics: ['System design', 'Implementation', 'Testing', 'Documentation and presentation'] },
    { code: 'EE4014', name: 'Professional Major Work', topics: ['Problem identification', 'Methodology', 'Implementation', 'Results and analysis', 'Report writing'] },
    { code: 'EE4024', name: 'Semester-Long Internship', topics: ['Industry exposure', 'Technical skills development', 'Professional development', 'Internship report'] },
  ];

  for (const course of missing) {
    console.log(`\n--- ${course.code}: ${course.name} ---`);
    for (const topic of course.topics) {
      const subId = topic.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
      const result = buildTemplateLecture(course.code, subId, topic, '', '');
      const val = validateLecture(result.markdown, subId, topic, course.code);
      if (val.valid) {
        const doc = {
          course: course.code, subtopicId: subId, subtopicName: topic,
          markdown: result.markdown, html: result.html,
          source: 'template_fallback', contentType: 'subtopic',
        };
        await Lecture.findOneAndUpdate(
          { course: course.code, subtopicId: subId },
          { $set: doc },
          { upsert: true }
        );
        const key = `lecture:${course.code}:${subId}`;
        if (redisClient && redisClient.isOpen) await redisClient.setEx(key, 604800, JSON.stringify(doc));
        const wc = result.markdown.split(/\s+/).filter(Boolean).length;
        console.log(`  [GEN] ${subId} (${wc}w)`);
      } else {
        console.log(`  [FAIL] ${subId}: ${val.reasons.join(', ')}`);
      }
    }
  }

  const total = await Lecture.countDocuments({});
  console.log(`\nTotal lectures in MongoDB: ${total}`);
  await mongoose.disconnect();
  if (redisClient && redisClient.isOpen) await redisClient.quit();
}
main().catch(e => { console.error(e); process.exit(1); });
