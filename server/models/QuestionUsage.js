const mongoose = require('mongoose');

const QuestionUsageSchema = new mongoose.Schema({
  question_id: { type: String, required: true, index: true },
  concept_id: { type: String, required: true, index: true },
  userId: { type: String, default: '', index: true },

  usage_context: { type: String, required: true, default: 'unknown' },
  usage_metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

  used_at: { type: Date, default: Date.now }
}, {
  timestamps: false
});

QuestionUsageSchema.index({ question_id: 1, usage_context: 1 }, { unique: false });
QuestionUsageSchema.index({ userId: 1, concept_id: 1 });

module.exports = mongoose.model('QuestionUsage', QuestionUsageSchema);

