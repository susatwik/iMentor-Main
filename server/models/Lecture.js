const mongoose = require('mongoose');

const LectureSchema = new mongoose.Schema({
  course:      { type: String, required: true, index: true, trim: true },
  subtopicId:  { type: String, default: null, index: true },
  subtopicName:{ type: String, default: '' },
  moduleName:  { type: String, default: '' },
  topicName:   { type: String, default: '' },
  markdown:    { type: String, default: '' },
  html:        { type: String, default: '' },
  conceptMap:  { type: String, default: '' },
  source:      { type: String, default: 'generated' },
  contentType: { type: String, enum: ['subtopic','full_lecture','concept_notes'], default: 'subtopic' },
  metadata: {
    wordCount:    Number,
    sectionCount: Number,
    difficulty:   { type: String, enum: ['beginner','intermediate','advanced','expert'], default: 'beginner' },
    bloomLevels:  [String],
    generatedBy:  { type: String, default: '' },
    model:        { type: String, default: '' },
    pipelineVersion: { type: String, default: '' },
  },
  generatedAt: { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now },
});

LectureSchema.index({ course: 1, subtopicId: 1 }, { unique: true, sparse: true });
LectureSchema.index({ course: 1, contentType: 1 });

module.exports = mongoose.model('Lecture', LectureSchema);
