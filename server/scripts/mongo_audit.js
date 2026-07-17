const mongoose = require('mongoose');
const Lecture = require('../models/Lecture');

async function main() {
  await mongoose.connect('mongodb://127.0.0.1:27017/imentor');

  const total = await Lecture.countDocuments({});
  const distinctCourses = await Lecture.distinct('course');
  const totalSubtopics = await Lecture.countDocuments({ contentType: 'subtopic' });

  console.log('=== MONGODB AUDIT ===');
  console.log('Total lecture documents:', total);
  console.log('Subtopics with lectures:', totalSubtopics);
  console.log('Distinct courses in Mongo:', distinctCourses.length);

  // Count by course
  const counts = await Lecture.aggregate([
    { $group: { _id: '$course', count: { $sum: 1 } } },
    { $sort: { _id: 1 } }
  ]);

  console.log('\nLectures per course:');
  for (const c of counts) {
    console.log('  ' + c._id + ': ' + c.count + ' lectures');
  }

  console.log('\nTotal stored lectures:', total);
  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
