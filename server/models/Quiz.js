const mongoose = require('mongoose');

const QuizSchema = new mongoose.Schema({
  course: { type: String, required: true },
  module: { type: String, required: true },
  questions: [{
    question: String,
    options: [String],
    correctIndex: Number,
    explanation: String,
    difficulty: { type: String, enum: ['easy', 'medium', 'hard'] },
    bloomLevel: { type: String, enum: ['remember', 'understand', 'apply', 'analyze'] },
  }],
  generatedBy: String,
  model: { type: String, default: '' },
  pipelineVersion: { type: String, default: '' },
  source: { type: String, default: '' },
  generatedAt: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
});

QuizSchema.index({ course: 1, module: 1 }, { unique: true });

module.exports = mongoose.model('Quiz', QuizSchema);
