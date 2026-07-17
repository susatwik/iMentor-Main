const mongoose = require('mongoose');

const LevelQuestionSchema = new mongoose.Schema({
  question:     { type: String, required: true },
  options:      [String],
  correctIndex: { type: Number, default: 0 },
  explanation:  { type: String, default: '' },
  difficulty:   { type: String, enum: ['easy','medium','hard','boss','expert'], default: 'medium' },
  bloomLevel:   { type: String, default: 'understand' },
  conceptTags:  [String],
}, { _id: false });

const TreeLevelSchema = new mongoose.Schema({
  levelId:    { type: Number, required: true },
  name:       { type: String, required: true },
  description:{ type: String, default: '' },
  difficulty: { type: String, enum: ['easy','medium','hard','boss','expert'], default: 'easy' },
  status:     { type: String, enum: ['locked','unlocked','completed'], default: 'locked' },
  stars:      { type: Number, default: 0 },
  credits:    { type: Number, default: 10 },
  questions:  [LevelQuestionSchema],
  subtopicId: { type: String, default: '' },
  topicName:  { type: String, default: '' },
  moduleName: { type: String, default: '' },
}, { _id: false });

const SkillTreeLevelSchema = new mongoose.Schema({
  topic:       { type: String, required: true, trim: true },
  course:      { type: String, default: '' },
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  isAdminCourse:{ type: Boolean, default: false },
  levels:      [TreeLevelSchema],
  metadata: {
    totalLevels:      Number,
    knowledgeLevel:   { type: String, default: 'Beginner' },
    generatedBy:      { type: String, default: '' },
    model:            { type: String, default: '' },
    pipelineVersion:  { type: String, default: '' },
    provider:         { type: String, default: '' },
    generationTimeMs: Number,
  },
  source:      { type: String, default: 'generated' },
  generatedBy: { type: String, default: '' },
  model:       { type: String, default: '' },
  pipelineVersion: { type: String, default: '' },
  generatedAt: { type: String, default: '' },
  createdAt:   { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now },
});

SkillTreeLevelSchema.index({ topic: 1, userId: 1 }, { unique: true });
SkillTreeLevelSchema.index({ topic: 1 }, { unique: true });

module.exports = mongoose.model('SkillTreeLevel', SkillTreeLevelSchema);
