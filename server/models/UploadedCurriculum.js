const mongoose = require('mongoose');

const CurriculumTopicSchema = new mongoose.Schema({
    module: { type: String, required: true },
    topic: { type: String, required: true },
    subtopic: { type: String, required: true },
    difficulty: { type: String, default: '' },
    credits: { type: String, default: '' }
}, { _id: false });

const UploadedCurriculumSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    filename: { type: String, required: true },
    hash: { type: String, required: true, index: true },
    storagePath: { type: String },
    courseTitle: { type: String },
    topics: [CurriculumTopicSchema],
    moduleCount: { type: Number, default: 0 },
    topicCount: { type: Number, default: 0 },
    status: { type: String, enum: ['uploaded', 'parsed', 'generating', 'ready', 'failed'], default: 'uploaded' },
    errorMessage: { type: String }
}, { timestamps: true });

UploadedCurriculumSchema.index({ userId: 1, hash: 1 }, { unique: true });

module.exports = mongoose.model('UploadedCurriculum', UploadedCurriculumSchema);