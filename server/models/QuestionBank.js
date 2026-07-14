const mongoose = require('mongoose');

const questionSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['mcq', 'scenario', 'fill_blank', 'match', 'reasoning', 'case_study', 'short_answer', 'diagnostic'],
    required: true
  },
  question: { type: String, required: true },
  options: [String],
  correctAnswer: String,
  correctIndex: { type: Number, default: 0 },
  explanation: String,
  difficulty: { type: String, enum: ['beginner', 'intermediate', 'advanced', 'expert'], default: 'beginner' },
  bloomLevel: { type: String, enum: ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'], default: 'understand' },
  learningObjective: { type: String, default: '' },
  estimatedTime: { type: String, default: '60s' },
  confidence: { type: Number, default: 0.8 },
  skillNodeId: String,
  course: String,
  module: String,
  topic: String,
  subtopic: String,
  curriculumHash: String,
  tags: [String],
  metadata: mongoose.Schema.Types.Mixed
}, { timestamps: true });

questionSchema.index({ course: 1, curriculumHash: 1, skillNodeId: 1 });
questionSchema.index({ course: 1, subtopic: 1 });
questionSchema.index({ type: 1, difficulty: 1, bloomLevel: 1 });

module.exports = mongoose.model('QuestionBank', questionSchema);
