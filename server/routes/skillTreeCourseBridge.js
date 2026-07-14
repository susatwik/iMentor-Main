const express = require('express');
const router = express.Router();
const SkillTree = require('../models/SkillTree');
const skillTreeService = require('../services/skillTreeService');
const cache = require('../services/skillTreeCacheService');
const log = require('../utils/logger');

async function findCourseSkillTree(courseName) {
  const cacheKey = `course:${courseName}`;
  const cached = await cache.get('skilltree', cacheKey);
  if (cached) return cached;

  const nodes = await SkillTree.find({ course: courseName, isActive: true }).lean();
  if (nodes && nodes.length > 0) {
    await cache.set('skilltree', nodes, cacheKey);
    return nodes;
  }

  return null;
}

router.get('/course/:courseName', async (req, res) => {
  try {
    const { courseName } = req.params;
    const userId = req.user?._id;

    let nodes = await findCourseSkillTree(courseName);

    if (!nodes) {
      const allTrees = await SkillTree.find({ isActive: true }).lean();
      const categoryMatch = allTrees.filter(n =>
        n.category?.toLowerCase() === courseName.toLowerCase() ||
        n.course?.toLowerCase() === courseName.toLowerCase()
      );
      const fuzzyMatch = allTrees.filter(n =>
        n.category?.toLowerCase().includes(courseName.toLowerCase()) ||
        n.course?.toLowerCase().includes(courseName.toLowerCase())
      );
      nodes = categoryMatch.length > 0 ? categoryMatch : fuzzyMatch;

      if (nodes.length > 0) {
        const sample = nodes[0];
        await cache.set('skilltree', nodes, `course:${sample.course || sample.category}`);
      }
    }

    let userProgress = null;
    if (userId) {
      try {
        const fullTree = await skillTreeService.getUserSkillTree(userId);
        const matched = fullTree.filter(s =>
          nodes.some(n => n.skillId === s.skillId)
        );
        if (matched.length > 0) {
          userProgress = {
            skills: matched,
            unlockedCount: matched.filter(s => s.status !== 'locked').length,
            masteredCount: matched.filter(s => s.status === 'mastered').length,
          };
        }
      } catch (e) {
        log.warn('SKILL_TREE', `User progress fetch error: ${e.message}`);
      }
    }

    res.json({
      course: courseName,
      nodes: nodes || [],
      totalNodes: nodes?.length || 0,
      userProgress,
    });
  } catch (error) {
    log.error('SKILL_TREE', `Course bridge error: ${error.message}`);
    res.status(500).json({ message: 'Failed to fetch skill tree', error: error.message });
  }
});

router.post('/course/:courseName/generate', async (req, res) => {
  try {
    const { courseName } = req.params;

    const existing = await SkillTree.findOne({ course: courseName }).lean();
    if (existing) {
      return res.json({ message: 'Skill tree already exists', course: courseName, existing: true });
    }

    const { generateSkillTreeNodes } = require('../services/skillTreeGeneratorService');
    const nodes = await generateSkillTreeNodes(courseName);

    if (!nodes || nodes.length === 0) {
      return res.status(500).json({ message: 'Failed to generate skill tree nodes', course: courseName });
    }

    await SkillTree.insertMany(nodes);
    await cache.del('skilltree', `course:${courseName}`);

    res.json({ message: 'Skill tree generated', course: courseName, nodesCount: nodes.length });
  } catch (error) {
    log.error('SKILL_TREE', `Generate error: ${error.message}`);
    res.status(500).json({ message: 'Failed to generate skill tree', error: error.message });
  }
});

router.get('/course/:courseName/reuse-check', async (req, res) => {
  try {
    const { courseName } = req.params;

    const cached = await cache.get('skilltree', `course:${courseName}`);
    if (cached) {
      return res.json({ exists: true, source: 'redis', nodeCount: cached.length, course: courseName });
    }

    const nodes = await SkillTree.find({ course: courseName, isActive: true }).lean();
    if (nodes && nodes.length > 0) {
      await cache.set('skilltree', nodes, `course:${courseName}`);
      return res.json({ exists: true, source: 'mongodb', nodeCount: nodes.length, course: courseName });
    }

    const similar = await SkillTree.find({
      $or: [
        { category: { $regex: courseName, $options: 'i' } },
        { course: { $regex: courseName, $options: 'i' } },
      ],
      isActive: true,
    }).lean();

    if (similar.length > 0) {
      return res.json({ exists: true, source: 'similar_match', nodeCount: similar.length, course: similar[0].course || similar[0].category });
    }

    res.json({ exists: false, source: null, nodeCount: 0, course: courseName });
  } catch (error) {
    log.error('SKILL_TREE', `Reuse check error: ${error.message}`);
    res.status(500).json({ message: 'Reuse check failed', error: error.message });
  }
});

module.exports = router;
