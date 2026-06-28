const mongoose = require('mongoose');

const ConceptAliasSchema = new mongoose.Schema(
  {
    alias: { type: String, required: true, unique: true, index: true },
    concept_id: { type: String, required: true, index: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ConceptAlias', ConceptAliasSchema);
