const mongoose = require('mongoose');
const log = require('../utils/logger');

// Modified connectDB to accept the URI as an argument
const connectDB = async (mongoUri) => {
  if (!mongoUri) {
      log.error('DB', 'MongoDB Connection Error: URI is missing.');
      process.exit(1);
  }
  try {
    const conn = await mongoose.connect(mongoUri);

    log.success('DB', 'MongoDB Connected Successfully');
    return conn;
  } catch (error) {
    log.error('DB', 'MongoDB Connection Error', error);
    log.warn('DB', 'Continuing startup without MongoDB connection (read-only/degraded mode).');
    // Don't crash the entire server for missing MongoDB in local/dev setups.
    // Return null so callers can handle degraded behavior gracefully.
    return null;
  }
};

module.exports = connectDB;

