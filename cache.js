import NodeCache from 'node-cache';
import { createClient } from 'redis';

// Memory cache (fallback)
const memoryCache = new NodeCache({
  stdTTL: process.env.CACHE_TTL || 600, // 10 minutes default
  checkperiod: 120, // Check for expired keys every 2 minutes
  maxKeys: 10000 // Maximum number of keys
});

// Redis client (primary cache for production)
let redisClient = null;

const initializeRedis = async () => {
  if (process.env.REDIS_ENABLED !== 'true') {
    console.log('Redis caching disabled');
    return null;
  }

  try {
    redisClient = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: {
        connectTimeout: 60000,
        lazyConnect: true,
      },
      retry_strategy: (options) => {
        if (options.error && options.error.code === 'ECONNREFUSED') {
          console.error('Redis connection refused');
          return new Error('Redis connection refused');
        }
        if (options.total_retry_time > 1000 * 60 * 60) {
          console.error('Redis retry time exhausted');
          return new Error('Retry time exhausted');
        }
        if (options.attempt > 10) {
          console.error('Redis max retry attempts reached');
          return undefined;
        }
        // Exponential backoff
        return Math.min(options.attempt * 100, 3000);
      }
    });

    redisClient.on('error', (err) => {
      console.error('Redis Client Error:', err);
    });

    redisClient.on('connect', () => {
      console.log('✅ Redis client connected');
    });

    redisClient.on('ready', () => {
      console.log('✅ Redis client ready');
    });

    redisClient.on('end', () => {
      console.log('Redis client connection ended');
    });

    await redisClient.connect();
    return redisClient;
  } catch (error) {
    console.error('❌ Failed to initialize Redis:', error.message);
    console.log('Falling back to memory cache');
    return null;
  }
};

// Cache wrapper class
class CacheManager {
  constructor() {
    this.redis = null;
    this.memory = memoryCache;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    this.redis = await initializeRedis();
    this.initialized = true;
  }

  async get(key) {
    try {
      // Try Redis first
      if (this.redis && this.redis.isOpen) {
        const value = await this.redis.get(key);
        if (value) {
          console.log(`Cache hit (Redis): ${key}`);
          return JSON.parse(value);
        }
      }

      // Fallback to memory cache
      const value = this.memory.get(key);
      if (value) {
        console.log(`Cache hit (Memory): ${key}`);
        return value;
      }

      console.log(`Cache miss: ${key}`);
      return null;
    } catch (error) {
      console.error('Cache get error:', error);
      // Fallback to memory cache
      return this.memory.get(key);
    }
  }

  async set(key, value, ttl = null) {
    try {
      const serializedValue = JSON.stringify(value);
      const expiry = ttl || (process.env.CACHE_TTL ? parseInt(process.env.CACHE_TTL) : 600);

      // Set in Redis
      if (this.redis && this.redis.isOpen) {
        await this.redis.setEx(key, expiry, serializedValue);
      }

      // Also set in memory cache as backup
      this.memory.set(key, value, expiry);

      console.log(`Cache set: ${key} (TTL: ${expiry}s)`);
    } catch (error) {
      console.error('Cache set error:', error);
      // Fallback to memory cache
      this.memory.set(key, value, ttl);
    }
  }

  async del(key) {
    try {
      // Delete from Redis
      if (this.redis && this.redis.isOpen) {
        await this.redis.del(key);
      }

      // Delete from memory cache
      this.memory.del(key);

      console.log(`Cache deleted: ${key}`);
    } catch (error) {
      console.error('Cache delete error:', error);
      // Fallback to memory cache
      this.memory.del(key);
    }
  }

  async clear() {
    try {
      // Clear Redis
      if (this.redis && this.redis.isOpen) {
        await this.redis.flushAll();
      }

      // Clear memory cache
      this.memory.flushAll();

      console.log('Cache cleared');
    } catch (error) {
      console.error('Cache clear error:', error);
      // Fallback to memory cache
      this.memory.flushAll();
    }
  }

  async getStats() {
    const memoryStats = this.memory.getStats();
    let redisStats = null;

    if (this.redis && this.redis.isOpen) {
      try {
        const info = await this.redis.info('memory');
        redisStats = {
          used_memory: info.match(/used_memory:(\d+)/)?.[1],
          total_keys: await this.redis.dbsize()
        };
      } catch (error) {
        console.error('Redis stats error:', error);
      }
    }

    return {
      memory: memoryStats,
      redis: redisStats,
      cache_type: this.redis && this.redis.isOpen ? 'redis+memory' : 'memory'
    };
  }

  // Graceful shutdown
  async close() {
    if (this.redis && this.redis.isOpen) {
      await this.redis.quit();
      console.log('Redis connection closed');
    }
  }
}

// Export singleton instance
const cacheManager = new CacheManager();

export default cacheManager;
