const mongoose = require('mongoose');

const ConceptSchema = new mongoose.Schema(
  {
    concept_id: { type: String, required: true, unique: true, index: true },
    concept_name: { type: String, required: true, trim: true },
    conceptId: { type: String, default: '' },
    conceptName: { type: String, default: '' },
    aliases: { type: [String], default: [] },
    description: { type: String, default: '' },
    prerequisites: { type: [String], default: [] },
    related_concepts: { type: [String], default: [] },
    difficulty_level: {
      type: String,
      default: 'beginner',
      enum: ['beginner', 'intermediate', 'advanced', 'expert']
    },
    subject_tags: { type: [String], default: [] },
    embedding_id: { type: String, default: '' },
    createdBy: { type: String, default: '' },
    version: { type: Number, default: 1 },
    notes: { type: String, default: '' },
    flashcards: [{ front: { type: String, default: '' }, back: { type: String, default: '' } }],
    learningObjectives: [{ type: String }],
    contentSource: { type: String, default: 'Concept' },
    contentDocumentId: { type: String, default: '' },
    contentStatus: {
        notes:        { type: Boolean, default: false },
        flashcards:   { type: Boolean, default: false },
        objectives:   { type: Boolean, default: false },
        questionBank: { type: Boolean, default: false }
    },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now }
  },
  { timestamps: false }
);

ConceptSchema.pre('save', function (next) {
  if (!this.conceptId) this.conceptId = this.concept_id;
  if (!this.conceptName) this.conceptName = this.concept_name;
  if (!this.contentSource) this.contentSource = 'Concept';
  if (!this.contentDocumentId && this._id) this.contentDocumentId = String(this._id);
  this.updated_at = new Date();
  if (!this.created_at) this.created_at = new Date();
  next();
});

module.exports = mongoose.model('Concept', ConceptSchema);
