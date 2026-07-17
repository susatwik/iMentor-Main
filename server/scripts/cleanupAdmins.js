// server/scripts/cleanupAdmins.js
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

async function cleanupAdmins() {
    const mongoUri = process.env.MONGO_URI;
    const adminEmail = process.env.FIXED_ADMIN_USERNAME || 'admin@admin.com';

    if (!mongoUri) {
        console.error('MONGO_URI not found in .env');
        process.exit(1);
    }

    try {
        await mongoose.connect(mongoUri);
        console.log('Connected to MongoDB.');

        // 1. Remove admin privileges from everyone except the fixed admin
        const result = await User.updateMany(
            { email: { $ne: adminEmail }, isAdmin: true },
            { $set: { isAdmin: false } }
        );

        console.log(`Successfully removed admin status from ${result.modifiedCount} other users.`);

        // 2. Ensure fixed admin is actually an admin
        const adminUser = await User.findOne({ email: adminEmail });
        if (adminUser) {
            adminUser.isAdmin = true;
            await adminUser.save();
            console.log(`Ensured ${adminEmail} has admin privileges.`);
        } else {
            console.log(`Warning: Fixed admin user '${adminEmail}' not found in database.`);
        }

    } catch (error) {
        console.error('Error during admin cleanup:', error);
    } finally {
        await mongoose.disconnect();
        console.log('Disconnected from MongoDB.');
    }
}

cleanupAdmins();
