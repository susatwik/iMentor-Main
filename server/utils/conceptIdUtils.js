const { normalizeSkillTreeTopic, canonicalizeSkillTreeTopic } = require('./skillTreeTopicUtils');

function slugifySkillTreeTopic(topic) {
  return normalizeSkillTreeTopic(topic)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildLevelConceptId(courseTopic, levelName, { log = true } = {}) {
  const topic = canonicalizeSkillTreeTopic(courseTopic);
  const level = normalizeSkillTreeTopic(levelName);
  const conceptId = `${slugifySkillTreeTopic(topic)}-${slugifySkillTreeTopic(level)}`;

  if (log) {
    console.log('[CONCEPT ID VERIFY]', {
      topic,
      level,
      conceptId
    });
  }

  return conceptId;
}

function resolveConceptCourseTopic(topic) {
  return canonicalizeSkillTreeTopic(topic);
}

module.exports = {
  slugifySkillTreeTopic,
  buildLevelConceptId,
  resolveConceptCourseTopic,
  normalizeSkillTreeTopic,
  canonicalizeSkillTreeTopic
};
