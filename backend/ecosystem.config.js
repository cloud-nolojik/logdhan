module.exports = {
  apps: [
    {
      name: 'logdhan-backend',
      script: 'src/index.js',
      cwd: '/Users/nolojik/Documents/logdhan/backend',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        PORT: 3000
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      env_staging: {
        NODE_ENV: 'staging',
        PORT: 3001
      },
      // Load environment variables from .env file in root directory
      env_file: '.env',
      // Error and output logs
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_file: './logs/combined.log',
      time: true,
      // Advanced PM2 features
      exec_mode: 'fork',
      min_uptime: '10s',
      max_restarts: 10,
      // Monitoring
      monitor: true,
      // Graceful shutdown
      kill_timeout: 5000,
      // Source map support for better error traces
      source_map_support: true,
      // Advanced options
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // Health check
      health_check_grace_period: 3000
    },
    {
      name: 'logdhan-frontend',
      script: 'npm',
      args: 'run preview',
      cwd: '/Users/nolojik/Documents/logdhan/frontend-web',
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 4173,
        VITE_API_URL: 'http://localhost:3000'
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 4173,
        VITE_API_URL: 'https://api.logdhan.com'
      },
      env_staging: {
        NODE_ENV: 'staging',
        PORT: 4174,
        VITE_API_URL: 'https://staging-api.logdhan.com'
      },
      error_file: './logs/frontend-err.log',
      out_file: './logs/frontend-out.log',
      log_file: './logs/frontend-combined.log',
      time: true
    }
  ],

  deploy: {
    production: {
      user: 'ubuntu',
      host: ['your-server.com'],
      ref: 'origin/main',
      repo: 'https://github.com/your-username/logdhan.git',
      path: '/var/www/logdhan',
      'pre-deploy-local': '',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env production',
      'pre-setup': ''
    },
    staging: {
      user: 'ubuntu',
      host: ['staging-server.com'],
      ref: 'origin/develop',
      repo: 'https://github.com/your-username/logdhan.git',
      path: '/var/www/logdhan-staging',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env staging'
    }
  }
};