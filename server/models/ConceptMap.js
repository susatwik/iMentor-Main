const mongoose = require('mongoose');

const ConceptMapSchema = new mongoose.Schema({
  course: { type: String, required: true },
  topic: { type: String, required: true },
  concepts: [{
    id: String,
    label: String,
    description: String,
  }],
  relationships: [{
    sourceId: String,
    targetId: String,
    label: String,
  }],
  generatedBy: String,
  model: { type: String, default: '' },
  pipelineVersion: { type: String, default: '' },
  source: { type: String, default: '' },
  generatedAt: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
});

ConceptMapSchema.index({ course: 1, topic: 1 }, { unique: true });

module.exports = mongoose.model('ConceptMap', ConceptMapSchema);
