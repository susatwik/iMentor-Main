const mongoose = require('mongoose');

const StudentResultSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  correct: Boolean,
  answeredAt: { type: Date, default: Date.now },
}, { _id: false });

const ConceptQuestionBankSchema = new mongoose.Schema({
  course: { type: String, required: true, index: true },
  concept: { type: String, required: true, index: true },
  topic: { type: String, default: '' },
  moduleName: { type: String, default: '' },

  question: { type: String, required: true },
  options: { type: [String], required: true, validate: v => v.length === 4 },
  correctIndex: { type: Number, required: true, min: 0, max: 3 },
  explanation: { type: String, default: '' },
  difficulty: {
    type: String, enum: ['easy', 'medium', 'hard'], default: 'medium',
  },
  bloomLevel: {
    type: String,
    enum: ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'],
    default: 'understand',
  },
  learningObjective: { type: String, default: '' },
  estimatedTime: { type: String, default: '60s' },
  confidence: { type: Number, default: 0.8, min: 0, max: 1 },

  usageCount: { type: Number, default: 0 },
  successCount: { type: Number, default: 0 },
  lastUsedAt: { type: Date, default: null },
  studentHistory: [StudentResultSchema],

  conceptTags: [String],
  generatedBy: { type: String, default: '' },
  model: { type: String, default: '' },
  pipelineVersion: { type: String, default: 'v2' },
  generatedAt: { type: Date, default: Date.now },
}, { timestamps: true });

ConceptQuestionBankSchema.index({ course: 1, concept: 1 });
ConceptQuestionBankSchema.index({ usageCount: 1 });
ConceptQuestionBankSchema.virtual('successRate').get(function () {
  if (this.usageCount === 0) return 0;
  return Math.round((this.successCount / this.usageCount) * 100);
});

ConceptQuestionBankSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('ConceptQuestionBank', ConceptQuestionBankSchema);
