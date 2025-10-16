module.exports = {
  apps: [{
    name: 'web-traffic-insight-ai-backend',
    script: 'index.js',
    instances: 'max', // Use all available CPU cores
    exec_mode: 'cluster', // Enable clustering
    env: {
      NODE_ENV: 'development',
      PORT: 3001
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3001,
      // Production-specific environment variables
      LOG_LEVEL: 'info',
      CACHE_TTL: 600, // 10 minutes
      REDIS_ENABLED: 'true'
    },
    // Auto restart configuration
    autorestart: true,
    watch: false, // Disable file watching in production
    max_memory_restart: '1G', // Restart if memory exceeds 1GB
    // Logging
    log_file: './logs/combined.log',
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    // Graceful shutdown
    kill_timeout: 5000,
    // Environment variables
    env_file: '.env'
  }]
};
