const { redisClient, connectRedis, isRedisConnected } = require('../config/redisClient');

async function clearRoutingCache() {
  console.log('Connecting to Redis...');
  await connectRedis();

  if (!isRedisConnected()) {
    console.error('Could not connect to Redis.');
    process.exit(1);
  }

  try {
    const keys = await redisClient.keys('routing_cache:*');
    console.log(`Found ${keys.length} keys to clear.`);
    
    if (keys.length > 0) {
      await redisClient.del(keys);
      console.log('Successfully cleared routing cache.');
    }
  } catch (err) {
    console.error('Error clearing cache:', err);
  } finally {
    process.exit(0);
  }
}

clearRoutingCache();
