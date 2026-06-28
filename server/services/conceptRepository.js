const Concept = require('../models/Concept');
const ConceptRelationship = require('../models/ConceptRelationship');
const ConceptAlias = require('../models/ConceptAlias');

function ensureStringArray(v) {
  return Array.isArray(v) ? v.map(x => String(x)).filter(Boolean) : [];
}

function normalizeLookupKey(s) {
  return String(s || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function createConcept(conceptDoc) {
  if (!conceptDoc || !conceptDoc.concept_id || !conceptDoc.concept_name) {
    throw new Error('createConcept requires concept_id and concept_name');
  }

  const aliases = ensureStringArray(conceptDoc.aliases);
  const prerequisites = ensureStringArray(conceptDoc.prerequisites);
  const related_concepts = ensureStringArray(conceptDoc.related_concepts);
  const subject_tags = ensureStringArray(conceptDoc.subject_tags);

  const created = await Concept.create({
    concept_id: String(conceptDoc.concept_id),
    concept_name: String(conceptDoc.concept_name),
    conceptId: String(conceptDoc.concept_id),
    conceptName: String(conceptDoc.concept_name),
    aliases: aliases,
    description: String(conceptDoc.description || ''),
    prerequisites,
    related_concepts,
    difficulty_level: conceptDoc.difficulty_level || 'beginner',
    subject_tags,
    embedding_id: String(conceptDoc.embedding_id || ''),
    createdBy: String(conceptDoc.createdBy || ''),
    version: Number.isFinite(conceptDoc.version) ? Number(conceptDoc.version) : 1,
    notes: String(conceptDoc.notes || ''),
    flashcards: Array.isArray(conceptDoc.flashcards) ? conceptDoc.flashcards : [],
    learningObjectives: Array.isArray(conceptDoc.learningObjectives) ? conceptDoc.learningObjectives : [],
    contentSource: String(conceptDoc.contentSource || 'Concept'),
    contentDocumentId: String(conceptDoc.contentDocumentId || ''),
    contentStatus: conceptDoc.contentStatus || {
      notes: false,
      flashcards: false,
      objectives: false,
      questionBank: false
    }
  });

  if (!created.contentDocumentId) {
    created.contentDocumentId = String(created._id || '');
    await created.save().catch(() => {});
  }

  const aliasDocs = aliases.map(a => ({
    alias: String(a),
    concept_id: created.concept_id
  }));
  if (aliasDocs.length > 0) {
    await ConceptAlias.insertMany(aliasDocs, { ordered: false }).catch(() => {});
  }

  const relDocs = [];
  for (const pid of prerequisites) {
    relDocs.push({
      source_concept: created.concept_id,
      target_concept: String(pid),
      relationship_type: 'prerequisite'
    });
  }
  for (const rid of related_concepts) {
    relDocs.push({
      source_concept: created.concept_id,
      target_concept: String(rid),
      relationship_type: 'related'
    });
  }
  if (relDocs.length > 0) {
    await ConceptRelationship.insertMany(relDocs, { ordered: false }).catch(() => {});
  }

  return created;
}

async function updateConcept(concept_id, patch) {
  if (!concept_id) throw new Error('updateConcept requires concept_id');
  const conceptKey = String(concept_id);
  let concept = await Concept.findOne({
    $or: [
      { concept_id: conceptKey },
      { conceptId: conceptKey },
      { concept_name: conceptKey }
    ]
  });
  if (!concept) {
    const aliasHit = await ConceptAlias.findOne({ alias: conceptKey }).lean().catch(() => null);
    if (aliasHit?.concept_id) {
      concept = await Concept.findOne({ concept_id: aliasHit.concept_id });
    }
  }
  if (!concept) throw new Error(`Concept not found: ${concept_id}`);

  const aliases = ensureStringArray(patch.aliases ?? concept.aliases);
  const prerequisites = ensureStringArray(patch.prerequisites ?? concept.prerequisites);
  const related_concepts = ensureStringArray(patch.related_concepts ?? concept.related_concepts);
  const subject_tags = ensureStringArray(patch.subject_tags ?? concept.subject_tags);

  concept.concept_name = patch.concept_name != null ? String(patch.concept_name) : concept.concept_name;
  concept.conceptId = patch.concept_id != null ? String(patch.concept_id) : String(concept.concept_id || concept.conceptId || '');
  concept.conceptName = patch.concept_name != null ? String(patch.concept_name) : String(concept.concept_name || concept.conceptName || '');
  concept.aliases = aliases;
  concept.description = patch.description != null ? String(patch.description) : concept.description;
  concept.prerequisites = prerequisites;
  concept.related_concepts = related_concepts;
  concept.difficulty_level = patch.difficulty_level || concept.difficulty_level;
  concept.subject_tags = subject_tags;
  concept.embedding_id = patch.embedding_id != null ? String(patch.embedding_id) : concept.embedding_id;
  if (patch.createdBy != null) concept.createdBy = String(patch.createdBy);
  if (patch.contentSource != null) concept.contentSource = String(patch.contentSource);
  if (patch.contentDocumentId != null) concept.contentDocumentId = String(patch.contentDocumentId);
  if (!concept.contentDocumentId && concept._id) concept.contentDocumentId = String(concept._id);
  concept.version = Number.isFinite(patch.version)
    ? Number(patch.version)
    : Number(concept.version || 1) + 1;
  if (patch.notes != null) concept.notes = String(patch.notes);
  if (patch.flashcards != null) concept.flashcards = Array.isArray(patch.flashcards) ? patch.flashcards : concept.flashcards;
  if (patch.learningObjectives != null) {
    concept.learningObjectives = Array.isArray(patch.learningObjectives) ? patch.learningObjectives : concept.learningObjectives;
  }
  if (patch.contentStatus != null) {
    concept.contentStatus = { ...(concept.contentStatus || {}), ...patch.contentStatus };
  }
  concept.updated_at = new Date();

  await concept.save();

  if (aliases.length > 0) {
    const aliasDocs = aliases.map(a => ({
      alias: String(a),
      concept_id: concept.concept_id
    }));
    await ConceptAlias.insertMany(aliasDocs, { ordered: false }).catch(() => {});
  }

  await ConceptRelationship.deleteMany({ source_concept: concept.concept_id }).catch(() => {});
  const relDocs = [];
  for (const pid of prerequisites) {
    relDocs.push({ source_concept: concept.concept_id, target_concept: String(pid), relationship_type: 'prerequisite' });
  }
  for (const rid of related_concepts) {
    relDocs.push({ source_concept: concept.concept_id, target_concept: String(rid), relationship_type: 'related' });
  }
  if (relDocs.length > 0) {
    await ConceptRelationship.insertMany(relDocs, { ordered: false }).catch(() => {});
  }

  return concept;
}

async function getConceptById(concept_id) {
  if (!concept_id) return null;
  return Concept.findOne({ concept_id: String(concept_id) });
}

async function getConceptByName(name) {
  if (!name) return null;
  return Concept.findOne({ concept_name: name }).catch(() => null);
}

async function getConceptByAlias(alias) {
  if (!alias) return null;
  const exactAlias = String(alias);
  const rel = await ConceptAlias.findOne({ alias: exactAlias }).lean().catch(() => null);
  if (!rel) return null;
  return Concept.findOne({ concept_id: rel.concept_id }).catch(() => null);
}

async function getConceptsBySubject(subjectTag) {
  if (!subjectTag) return [];
  const tag = String(subjectTag);
  return Concept.find({ subject_tags: tag }).lean();
}

async function createRelationship(source_concept, target_concept, relationship_type) {
  if (!source_concept || !target_concept) throw new Error('createRelationship requires source and target');
  if (!relationship_type) throw new Error('createRelationship requires relationship_type');

  return ConceptRelationship.create({
    source_concept: String(source_concept),
    target_concept: String(target_concept),
    relationship_type
  });
}

async function backfillConceptIdentityFields() {
  const cursor = Concept.find({
    $or: [
      { conceptId: { $exists: false } },
      { conceptId: { $in: ['', null] } },
      { conceptName: { $exists: false } },
      { conceptName: { $in: ['', null] } },
      { contentSource: { $exists: false } },
      { contentSource: { $in: ['', null] } },
      { contentDocumentId: { $exists: false } },
      { contentDocumentId: { $in: ['', null] } }
    ]
  }).cursor();

  let scanned = 0;
  let updated = 0;
  const ops = [];

  for await (const concept of cursor) {
    scanned += 1;
    const update = {};

    if (!concept.conceptId) update.conceptId = concept.concept_id;
    if (!concept.conceptName) update.conceptName = concept.concept_name;
    if (!concept.contentSource) update.contentSource = 'Concept';
    if (!concept.contentDocumentId) update.contentDocumentId = String(concept._id || '');

    if (Object.keys(update).length > 0) {
      ops.push({
        updateOne: {
          filter: { _id: concept._id },
          update: { $set: update }
        }
      });
    }

    if (ops.length >= 100) {
      await Concept.bulkWrite(ops, { ordered: false }).catch(() => {});
      updated += ops.length;
      ops.length = 0;
    }
  }

  if (ops.length > 0) {
    await Concept.bulkWrite(ops, { ordered: false }).catch(() => {});
    updated += ops.length;
  }

  return { scanned, updated };
}

module.exports = {
  createConcept,
  updateConcept,
  getConceptById,
  getConceptByName,
  getConceptByAlias,
  getConceptsBySubject,
  createRelationship,
  backfillConceptIdentityFields
};
