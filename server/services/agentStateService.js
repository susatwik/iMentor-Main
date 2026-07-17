const { redisClient } = require('../config/redisClient');

const AGENT_STATE_TTL_SECONDS = Number(process.env.AGENT_STATE_TTL_SECONDS || 21600);

function buildDefaultAgentState() {
  return {
    lastReasoningModel: null,
    priorInsights: [],
    branchHistory: [],
    confidenceHistory: [],
  };
}

function mergeAgentStatePayload(previous = {}, patch = {}) {
  return {
    ...buildDefaultAgentState(),
    ...previous,
    ...patch,
    priorInsights: Array.isArray(patch.priorInsights)
      ? patch.priorInsights.slice(0, 25)
      : (Array.isArray(previous.priorInsights) ? previous.priorInsights.slice(0, 25) : []),
    branchHistory: Array.isArray(patch.branchHistory)
      ? patch.branchHistory.slice(0, 30)
      : (Array.isArray(previous.branchHistory) ? previous.branchHistory.slice(0, 30) : []),
    confidenceHistory: Array.isArray(patch.confidenceHistory)
      ? patch.confidenceHistory.slice(0, 30)
      : (Array.isArray(previous.confidenceHistory) ? previous.confidenceHistory.slice(0, 30) : []),
  };
}

async function getAgentState(sessionId) {
  if (!sessionId || !redisClient || !redisClient.isOpen) return buildDefaultAgentState();
  try {
    const raw = await redisClient.get(`agent_state:${sessionId}`);
    if (!raw) return buildDefaultAgentState();
    const parsed = JSON.parse(raw);
    return mergeAgentStatePayload({}, parsed);
  } catch {
    return buildDefaultAgentState();
  }
}

async function saveAgentState(sessionId, state) {
  if (!sessionId || !redisClient || !redisClient.isOpen) return;
  await redisClient.set(
    `agent_state:${sessionId}`,
    JSON.stringify(mergeAgentStatePayload({}, state)),
    { EX: AGENT_STATE_TTL_SECONDS }
  );
}

async function updateAgentState(sessionId, patch) {
  if (!sessionId || !redisClient || !redisClient.isOpen) return buildDefaultAgentState();
  const current = await getAgentState(sessionId);
  const merged = mergeAgentStatePayload(current, patch);
  await saveAgentState(sessionId, merged);
  return merged;
}

module.exports = {
  buildDefaultAgentState,
  mergeAgentStatePayload,
  getAgentState,
  saveAgentState,
  updateAgentState,
};
