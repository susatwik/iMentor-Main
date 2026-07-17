// server/routes/subjects.js
const express = require("express");
const router = express.Router();

// TEMP SAFE SUBJECT LIST
router.get("/", async (req, res) => {
  return res.status(200).json({
    subjects: [
      "Machine Learning",
      "Deep Learning",
      "Data Structures",
      "Algorithms",
      "Python",
      "Databases"
    ]
  });
});

module.exports = router;
