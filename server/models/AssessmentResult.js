const mongoose = require('mongoose');

const BloomScoreSchema = new mongoose.Schema({
  score: { type: Number, default: 0 },
  mastered: { type: Boolean, default: false },
  attempted: { type: Number, default: 0 },
}, { _id: false });

const ConceptMasterySchema = new mongoose.Schema({
  mastery: { type: Number, default: 0 },
  needsReview: { type: Boolean, default: false },
}, { _id: false });

const GradingDetailSchema = new mongoose.Schema({
  question: String,
  correct: Boolean,
  bloomLevel: String,
  concepts: [String],
}, { _id: false });

const AssessmentResultSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  topic: {
    type: String,
    required: true,
    index: true,
  },
  course: String,
  level: {
    type: String,
    enum: ['Beginner', 'Intermediate', 'Advanced', 'Expert'],
    default: 'Beginner',
  },
  score: Number,
  maxScore: Number,
  scorePercent: Number,
  confidence: Number,
  highestBloomLevel: {
    type: String,
    enum: ['remember', 'understand', 'apply', 'analyze', 'evaluate'],
    default: 'remember',
  },
  bloomProfile: {
    type: Map,
    of: BloomScoreSchema,
    default: {},
  },
  conceptMastery: {
    type: Map,
    of: ConceptMasterySchema,
    default: {},
  },
  strengths: [String],
  weakAreas: [String],
  feedback: String,
  recommendation: String,
  gradingDetails: [GradingDetailSchema],
}, { timestamps: true });

AssessmentResultSchema.index({ userId: 1, topic: 1, createdAt: -1 });
AssessmentResultSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('AssessmentResult', AssessmentResultSchema);
