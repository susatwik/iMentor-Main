const mongoose = require('mongoose');
 
const SubtopicProgressSchema = new mongoose.Schema({
  subtopicId: String,
  subtopicName: String,
  correctAnswers: { type: Number, default: 0 },
  totalAttempts: { type: Number, default: 0 },
  currentScore: { type: Number, default: 0 },
  difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'easy' },
  lastAttemptDate: Date,
  status: { type: String, enum: ['not_started', 'in_progress', 'completed', 'skipped'], default: 'not_started' }
});
 
const StudentLearningProfileSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  courseId: String,
  subject: String,
  subtopicProgress: [SubtopicProgressSchema],
  overallProgress: { type: Number, default: 0 },
  learningCurve: [{
    date: Date,
    score: Number,
    difficulty: String
  }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
 
module.exports = mongoose.model('StudentLearningProfile', StudentLearningProfileSchema);
 const mongoose = require('mongoose');
 
const SubtopicProgressSchema = new mongoose.Schema({
  subtopicId: String,
  subtopicName: String,
  correctAnswers: { type: Number, default: 0 },
  totalAttempts: { type: Number, default: 0 },
  currentScore: { type: Number, default: 0 },
  difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'easy' },
  lastAttemptDate: Date,
  status: { type: String, enum: ['not_started', 'in_progress', 'completed', 'skipped'], default: 'not_started' }
});
 
const StudentLearningProfileSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  courseId: String,
  subject: String,
  subtopicProgress: [SubtopicProgressSchema],
  overallProgress: { type: Number, default: 0 },
  learningCurve: [{
    date: Date,
    score: Number,
    difficulty: String
  }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
 
module.exports = mongoose.model('StudentLearningProfile', StudentLearningProfileSchema);
 