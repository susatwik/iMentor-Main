/**
 * One-time script: normalize SkillTreeGame level names
 *
 * Fixes:
 *   "scopeof ML"        → "Scope of ML"
 *   "history of ML"     → "History of ML"
 *   "unsupervised  Learning" (double space) → "Unsupervised Learning"
 *   Any leading/trailing whitespace in any level name
 *
 * Run: node server/scripts/fix_skill_tree_level_names.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mongoose = require('mongoose');
const SkillTreeGame = require('../models/SkillTreeGame');

const KNOWN_FIXES = [
    { from: /^scopeof\s+ML$/i,         to: 'Scope of ML' },
    { from: /^history\s+of\s+ML$/i,    to: 'History of ML' },
    { from: /^unsupervised\s{2,}learning$/i, to: 'Unsupervised Learning' },
];

function normalizeName(raw) {
    // Trim outer whitespace
    let name = raw.trim();
    // Collapse internal multiple spaces
    name = name.replace(/\s{2,}/g, ' ');
    // Apply known specific fixes
    for (const { from, to } of KNOWN_FIXES) {
        if (from.test(name)) {
            name = to;
            break;
        }
    }
    // Title-case first letter of the whole string if it starts lowercase
    // (e.g. "history of ML" → "History of ML" already handled above, but catch others)
    name = name.charAt(0).toUpperCase() + name.slice(1);
    return name;
}

async function run() {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/iMentor');
    console.log('Connected to MongoDB');

    const games = await SkillTreeGame.find({});
    let totalFixed = 0;

    for (const game of games) {
        let dirty = false;
        for (const level of game.levels) {
            const fixed = normalizeName(level.name || '');
            if (fixed !== level.name) {
                console.log(`  [game ${game._id}] "${level.name}" → "${fixed}"`);
                level.name = fixed;
                dirty = true;
                totalFixed++;
            }
        }
        if (dirty) {
            game.markModified('levels');
            await game.save();
        }
    }

    console.log(`\nDone. Fixed ${totalFixed} level name(s) across ${games.length} game(s).`);
    await mongoose.disconnect();
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
