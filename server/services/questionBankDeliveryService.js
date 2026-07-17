function toMillis(value) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function normalizeQuestionId(question) {
  return String(question?.question_id || question?._id || question?.questionId || '').trim();
}

function getQuestionStats(question) {
  return {
    questionId: normalizeQuestionId(question),
    usageCount: Number(question?.usage_count || 0),
    lastUsedAt: toMillis(question?.last_used_at || question?.lastUsedAt || question?.used_at),
  };
}

function rankQuestionsForDelivery(pool = [], randomFn = Math.random) {
  return (Array.isArray(pool) ? pool : [])
    .map((question, index) => ({
      question,
      index,
      ...getQuestionStats(question),
      randomTieBreak: Number(randomFn()),
    }))
    .sort((a, b) => {
      if (a.usageCount !== b.usageCount) return a.usageCount - b.usageCount;
      if (a.lastUsedAt !== b.lastUsedAt) return a.lastUsedAt - b.lastUsedAt;
      if (a.randomTieBreak !== b.randomTieBreak) return a.randomTieBreak - b.randomTieBreak;
      return a.questionId.localeCompare(b.questionId) || a.index - b.index;
    });
}

function selectQuestionsForDelivery({
  pool = [],
  seenQuestionIds = [],
  count = 5,
  randomFn = Math.random
} = {}) {
  const normalizedPool = Array.isArray(pool) ? pool.filter(Boolean) : [];
  const seen = new Set((seenQuestionIds || []).map(id => String(id)).filter(Boolean));
  const unseen = normalizedPool.filter(question => !seen.has(normalizeQuestionId(question)));
  const excludedByHistory = normalizedPool.length - unseen.length;

  const preferredPool = unseen.length >= count
    ? unseen
    : [...unseen, ...normalizedPool.filter(question => seen.has(normalizeQuestionId(question)))];

  const ranked = rankQuestionsForDelivery(preferredPool, randomFn);
  const selected = ranked.slice(0, count).map(entry => entry.question);

  return {
    selected,
    selectedQuestions: selected.length,
    totalAvailable: normalizedPool.length,
    totalUnseen: unseen.length,
    excludedByHistory,
    questionIds: selected.map(normalizeQuestionId),
    ranking: ranked.map(entry => ({
      questionId: entry.questionId,
      usageCount: entry.usageCount,
      lastUsedAt: entry.lastUsedAt,
      randomTieBreak: entry.randomTieBreak
    }))
  };
}

module.exports = {
  normalizeQuestionId,
  getQuestionStats,
  rankQuestionsForDelivery,
  selectQuestionsForDelivery
};
