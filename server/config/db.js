const mongoose = require('mongoose');
const log = require('../utils/logger');

// Modified connectDB to accept the URI as an argument
const connectDB = async (mongoUri) => {
  if (!mongoUri) {
    log.error('DB', 'MongoDB Connection Error: URI is missing.');
    process.exit(1);
  }

  try {
    // [Optimization] Explicit pool settings — Mongoose default (5) is too low for 50+ concurrent users
    const conn = await mongoose.connect(mongoUri, {
      maxPoolSize: parseInt(process.env.MONGO_MAX_POOL_SIZE, 10) || 20,
      minPoolSize: parseInt(process.env.MONGO_MIN_POOL_SIZE, 10) || 2,
      socketTimeoutMS:
        parseInt(process.env.MONGO_SOCKET_TIMEOUT_MS, 10) || 45000,
      serverSelectionTimeoutMS: 5000,
    });

    log.success(
      'DB',
      `MongoDB Connected Successfully (pool: ${conn.connection.config?.maxPoolSize || 20})`
    );
    return conn;
  } catch (error) {
    log.error('DB', 'MongoDB Connection Error', error);
    log.warn(
      'DB',
      'Continuing startup without MongoDB connection (read-only/degraded mode).'
    );

    // Don't crash the entire server for missing MongoDB in local/dev setups.
    // Return null so callers can handle degraded behavior gracefully.
    return null;
  }
};

module.exports = connectDB;
