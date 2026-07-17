const { parseBooleanFlag } = require('../utils/debugMode');

const FLAG_NAMES = [
  'ENABLE_DYNAMIC_BRANCHING',
  'ENABLE_STEP_CONFIDENCE',
  'ENABLE_PATTERN_ANALYTICS',
  'RESTRICT_TOT_STREAMING', // [Team 9 merge]
];

const runtimeOverrides = new Map();

function getDefaultFlagValue(flagName) {
  if (flagName === 'ENABLE_PATTERN_ANALYTICS') {
    return parseBooleanFlag(process.env.ENABLE_PATTERN_ANALYTICS);
  }

  // [Team 9 merge] RESTRICT_TOT_STREAMING: opt-in flag — defaults false unless explicitly set
  if (flagName === 'RESTRICT_TOT_STREAMING') {
    return parseBooleanFlag(process.env.RESTRICT_TOT_STREAMING);
  }

  return process.env[flagName] !== 'false';
}

function getFeatureFlag(flagName) {
  if (!FLAG_NAMES.includes(flagName)) {
    throw new Error(`Unsupported feature flag: ${flagName}`);
  }

  if (runtimeOverrides.has(flagName)) {
    return runtimeOverrides.get(flagName);
  }

  return getDefaultFlagValue(flagName);
}

function getFeatureFlagsSnapshot() {
  return FLAG_NAMES.reduce((snapshot, flagName) => {
    snapshot[flagName] = getFeatureFlag(flagName);
    return snapshot;
  }, {});
}

function setFeatureFlag(flagName, enabled) {
  if (!FLAG_NAMES.includes(flagName)) {
    throw new Error(`Unsupported feature flag: ${flagName}`);
  }

  runtimeOverrides.set(flagName, Boolean(enabled));
  return getFeatureFlagsSnapshot();
}

module.exports = {
  FLAG_NAMES,
  getFeatureFlag,
  getFeatureFlagsSnapshot,
  setFeatureFlag,
};
