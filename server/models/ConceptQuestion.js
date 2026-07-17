const mongoose = require('mongoose');

const ConceptQuestionSchema = new mongoose.Schema({
  question_id: { type: String, required: true, unique: true, index: true },
  concept_id: { type: String, required: true, index: true },
  conceptId: { type: String, default: '', index: true },

  question_text: { type: String, required: true, trim: true },
  question: { type: String, default: '', trim: true },
  options: { type: [String], default: [] },
  correct_answer: { type: String, default: '' },
  answer: { type: String, default: '' },
  explanation: { type: String, default: '' },
  source: { type: String, default: 'concept-question-bank' },
  createdBy: { type: String, default: '' },
  version: { type: Number, default: 1 },

  difficulty: {
    type: String,
    default: 'medium',
    enum: ['easy', 'medium', 'hard', 'boss', 'expert']
  },
  bloom_level: { type: String, default: 'remember' },
  tags: { type: [String], default: [] },
  usage_count: { type: Number, default: 0 },
  usageCount: { type: Number, default: 0 },
  last_used_at: { type: Date, default: null },
  lastUsedAt: { type: Date, default: null },
  created_at: { type: Date, default: Date.now }
}, {
  timestamps: false
});

ConceptQuestionSchema.pre('save', function (next) {
  if (!this.conceptId) this.conceptId = this.concept_id;
  if (!this.question) this.question = this.question_text;
  if (!this.answer) this.answer = this.correct_answer;
  if (this.usageCount == null) this.usageCount = this.usage_count || 0;
  if (!this.lastUsedAt && this.last_used_at) this.lastUsedAt = this.last_used_at;
  next();
});

module.exports = mongoose.model('ConceptQuestion', ConceptQuestionSchema);

