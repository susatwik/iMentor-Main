// server/utils/circuitBreaker.js
// Lightweight in-process circuit breaker (per-process) for external calls.

const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_FAILURES_DEFAULT = 5;
const COOLDOWN_MS_DEFAULT = 5 * 60 * 1000; // 5 minutes

// key -> { failures, openedUntil, lastUpdated }
const state = new Map();

function now() {
  return Date.now();
}

function getEntry(key) {
  if (!state.has(key)) {
    state.set(key, { failures: 0, openedUntil: 0, lastUpdated: now() });
  }
  return state.get(key);
}

function pruneOldEntries() {
  const cutoff = now() - DEFAULT_STATE_TTL_MS;
  for (const [k, v] of state.entries()) {
    if (v.lastUpdated < cutoff) state.delete(k);
  }
}

function isOpen(key, cooldownMs = COOLDOWN_MS_DEFAULT, maxFailures = MAX_FAILURES_DEFAULT) {
  const entry = getEntry(key);
  pruneOldEntries();

  if (entry.openedUntil && entry.openedUntil > now()) return true;
  return entry.failures >= maxFailures;
}

function onFailure(key, cooldownMs = COOLDOWN_MS_DEFAULT, maxFailures = MAX_FAILURES_DEFAULT) {
  const entry = getEntry(key);
  entry.failures += 1;

  if (entry.failures >= maxFailures) {
    entry.openedUntil = now() + cooldownMs;
  }

  entry.lastUpdated = now();
}

function onSuccess(key) {
  const entry = getEntry(key);
  entry.failures = 0;
  entry.openedUntil = 0;
  entry.lastUpdated = now();
}

module.exports = { isOpen, onFailure, onSuccess };

