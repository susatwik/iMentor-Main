const mongoose = require('mongoose');

const ConceptRelationshipSchema = new mongoose.Schema(
  {
    source_concept: { type: String, required: true, index: true },
    target_concept: { type: String, required: true, index: true },
    relationship_type: {
      type: String,
      required: true,
      enum: ['prerequisite', 'related']
    }
  },
  { timestamps: true }
);

ConceptRelationshipSchema.index(
  { source_concept: 1, target_concept: 1, relationship_type: 1 },
  { unique: true }
);

module.exports = mongoose.model('ConceptRelationship', ConceptRelationshipSchema);
