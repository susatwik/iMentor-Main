// server/routes/index_skilltreeCourseMatching.js
// Convenience re-export(s) for SkillTree course matching enhancements.
// Keep this file tiny; mounting happens in server/server.js.

const mainRouter = require('./skilltreeCourseMatching');
const autocompleteRouter = require('./skilltreeCourseMatchingAutocomplete');
const validateRouter = require('./skilltreeCourseMatchingValidate');

const express = require('express');
const router = express.Router();

router.use('/', mainRouter);
router.use('/', autocompleteRouter);
router.use('/', validateRouter);

module.exports = router;


