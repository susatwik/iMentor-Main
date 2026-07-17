const mongoose = require('mongoose');
const Lecture = require('../models/Lecture');
const path = require('path');
const fs = require('fs');
const { buildTemplateLecture } = require('../services/lectureTemplateBuilder');
const { redisClient, connectRedis } = require('../config/redisClient');

const spuriousCourses = ['EE', 'EE_101', 'EE_201', 'EE_202', 'Machine Learning', 'Machine_Learning', 'Machine_learning'];

async function run() {
  await mongoose.connect('mongodb://127.0.0.1:27017/imentor');
  await connectRedis();

  // 1. Remove spurious lectures from Mongo
  console.log('=== Cleaning spurious MongoDB entries ===');
  for (const course of spuriousCourses) {
    const result = await Lecture.deleteMany({ course });
    console.log(`  Removed ${result.deletedCount} lectures for "${course}"`);

    // Clear Redis cache for these
    if (redisClient && redisClient.isOpen) {
      const keys = await redisClient.keys(`lecture:${course}:*`);
      if (keys.length > 0) {
        await redisClient.del(keys);
        console.log(`  Cleared ${keys.length} Redis keys for "${course}"`);
      }
    }
  }

  // 2. Generate lectures for missing courses (HS2011, HS2012, PE1022, PE2012)
  console.log('\n=== Generating missing lectures ===');

  const missingBrief = [
    {
      code: 'HS2011', name: 'Personality Development', credits: 1, category: 'HSC',
      modules: [{ name: 'Module 1', topics: [
        { topic: 'Self-Awareness and Self-Management', subtopics: ['Self-assessment', 'Emotional intelligence', 'Goal setting', 'Time management'] },
        { topic: 'Interpersonal Skills', subtopics: ['Communication skills', 'Active listening', 'Assertiveness', 'Teamwork'] },
      ]}]
    },
    {
      code: 'HS2012', name: 'NCC/Social Services', credits: 1, category: 'HSC',
      modules: [{ name: 'Module 1', topics: [
        { topic: 'National Cadet Corps', subtopics: ['NCC organization', 'Drill and discipline', 'Camp training', 'Community service'] },
        { topic: 'Social Service', subtopics: ['Community development', 'Awareness campaigns', 'Disaster relief', 'Environmental conservation'] },
      ]}]
    },
    {
      code: 'PE1022', name: 'Physical Education II', credits: 1, category: 'HSC',
      modules: [{ name: 'Module 1', topics: [
        { topic: 'Advanced Physical Fitness', subtopics: ['Fitness assessment', 'Exercise programming', 'Sports skills', 'Team games'] },
        { topic: 'Health and Wellness', subtopics: ['Lifestyle management', 'Injury prevention', 'Nutrition for athletes', 'Mental wellness'] },
      ]}]
    },
    {
      code: 'PE2012', name: 'Yoga', credits: 1, category: 'HSC',
      modules: [{ name: 'Module 1', topics: [
        { topic: 'Foundations of Yoga', subtopics: ['Yoga philosophy', 'Asanas', 'Pranayama', 'Meditation'] },
        { topic: 'Yoga Practice', subtopics: ['Surya namaskar', 'Stress relief', 'Flexibility training', 'Mindfulness'] },
      ]}]
    },
  ];

  for (const course of missingBrief) {
    console.log(`\n--- ${course.code}: ${course.name} ---`);

    for (const mod of course.modules) {
      for (const topic of mod.topics) {
        for (const sub of (topic.subtopics || [])) {
          const subId = sub.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
          const cacheKey = `lecture:${course.code}:${subId}`;

          const result = buildTemplateLecture(course.code, subId, sub, topic.topic, mod.name);
          const { validateLecture } = require('../services/lectureQualityValidator');
          const validation = validateLecture(result.markdown, subId, sub, course.code);

          if (validation.valid) {
            const doc = {
              course: course.code,
              subtopicId: subId,
              subtopicName: sub,
              topicName: topic.topic,
              moduleName: mod.name,
              markdown: result.markdown,
              html: result.html,
              conceptMap: '',
              contentType: 'subtopic',
              source: 'template_fallback',
            };
            await Lecture.findOneAndUpdate(
              { course: course.code, subtopicId: subId },
              { $set: doc },
              { upsert: true }
            );
            if (redisClient && redisClient.isOpen) {
              await redisClient.setEx(cacheKey, 7 * 24 * 3600, JSON.stringify(doc));
            }
            const wc = result.markdown.split(/\s+/).filter(Boolean).length;
            console.log(`  [GEN] ${subId} (${wc}w)`);
          } else {
            console.log(`  [SKIP] ${subId}: ${validation.reasons.join(', ')}`);
          }
        }
      }
    }
  }

  // 3. Final counts
  const totalLectures = await Lecture.countDocuments({});
  const distinctCourses = await Lecture.distinct('course');
  console.log(`\n\n=== FINAL STATS ===`);
  console.log(`Total lectures in MongoDB: ${totalLectures}`);
  console.log(`Distinct courses with lectures: ${distinctCourses.length}`);

  await mongoose.disconnect();
  if (redisClient && redisClient.isOpen) await redisClient.quit();
}

run().catch(e => { console.error(e); process.exit(1); });
