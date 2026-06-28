const mongoose = require('mongoose');

const SkillTreeCsvUploadSnapshotSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, ref: 'User' },
    canonicalTopic: { type: String, required: true, trim: true },
    topicAliases: { type: [String], default: [] },
    extractedTopics: { type: [String], default: [] },
    matchedConcepts: { type: [String], default: [] },
    matchPercentage: { type: Number, default: 0 },
    reusedSkillTreeDecision: { type: String, default: '' },
  },
  { timestamps: true }
);

SkillTreeCsvUploadSnapshotSchema.index({ userId: 1, canonicalTopic: 1, createdAt: -1 });
SkillTreeCsvUploadSnapshotSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model(
  'SkillTreeCsvUploadSnapshot',
  SkillTreeCsvUploadSnapshotSchema
);
