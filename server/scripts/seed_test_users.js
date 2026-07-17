/**
 * seed_test_users.js
 * Creates test1–test9 users directly in MongoDB (no OTP, no registration flow).
 * Run: node server/scripts/seed_test_users.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27018/chatbot_autoresearch';
const PASSWORD  = '123456';
const COUNT     = 9;

// Minimal inline schema — bypasses the pre-save hook so we control the hash ourselves.
// We insert documents directly with already-hashed passwords.
async function run() {
    console.log(`\nConnecting to ${MONGO_URI} …`);
    await mongoose.connect(MONGO_URI);
    console.log('Connected.\n');

    const db   = mongoose.connection.db;
    const col  = db.collection('users');

    const salt         = await bcrypt.genSalt(10);
    const hashedPwd    = await bcrypt.hash(PASSWORD, salt);
    const now          = new Date();

    const results = [];

    for (let i = 1; i <= COUNT; i++) {
        const username = `test${i}`;
        const email    = `test${i}@test.com`;

        // Remove any stale test user with same email/username
        await col.deleteOne({ $or: [{ email }, { username }] });

        const doc = {
            email,
            username,
            password               : hashedPwd,
            isAdmin                : false,
            hasCompletedOnboarding : true,
            apiKeyRequestStatus    : 'none',
            preferredLlmProvider   : 'local_llm',
            modelRoutingMode       : 'manual',
            selectedModelId        : '',
            ollamaUrl              : '',
            ollamaModel            : process.env.OLLAMA_DEFAULT_MODEL || 'qwen3.5:9b',
            profile                : {
                name              : username,
                college           : '',
                universityNumber  : '',
                degreeType        : '',
                branch            : '',
                year              : '',
                learningStyle     : 'Not Specified',
                currentGoals      : '',
            },
            learningPaths      : [],
            curriculumProgress : {},
            createdAt          : now,
        };

        await col.insertOne(doc);
        results.push({ username, email, status: 'created' });
        console.log(`  ✅  ${username}  <${email}>  created`);
    }

    // ── Verify: run comparePassword logic for each user ──────────────────────
    console.log('\n── Login verification ──────────────────────────────────');
    let allPassed = true;
    for (const { username, email } of results) {
        const user = await col.findOne({ email });
        const ok   = await bcrypt.compare(PASSWORD, user.password);
        const mark = ok ? '✅' : '❌';
        console.log(`  ${mark}  ${username}  (${email})  login → ${ok ? 'PASS' : 'FAIL'}`);
        if (!ok) allPassed = false;
    }

    console.log('\n' + (allPassed
        ? '🎉  All 9 test users created and verified successfully.'
        : '⚠️   Some users FAILED verification — check output above.'));
    console.log(`     Email format : test1@test.com … test9@test.com`);
    console.log(`     Password     : ${PASSWORD}\n`);

    await mongoose.disconnect();
}

run().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
