const express = require('express');
const { isDebugMode } = require('../utils/debugMode');
const {
  FLAG_NAMES,
  getFeatureFlagsSnapshot,
  setFeatureFlag,
} = require('../services/debugFeatureFlagsService');

const router = express.Router();

router.use((req, res, next) => {
  if (!isDebugMode(req)) {
    return res.status(403).json({ message: 'Debug mode is not enabled.' });
  }
  next();
});

router.get('/feature-flags', (req, res) => {
  res.json({ success: true, flags: getFeatureFlagsSnapshot() });
});

router.post('/toggle-feature', (req, res) => {
  const { feature, enabled } = req.body || {};

  if (!FLAG_NAMES.includes(feature)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid feature flag.',
      allowedFlags: FLAG_NAMES,
    });
  }

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({
      success: false,
      message: 'enabled must be a boolean.',
    });
  }

  const flags = setFeatureFlag(feature, enabled);
  return res.json({ success: true, flags });
});

module.exports = router;
