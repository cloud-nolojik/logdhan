# PM2 Commands for LogDhan

## 🚀 Quick Start

```bash
# Start all apps (backend + frontend)
pm2 start ecosystem.config.js

# Start only backend
pm2 start ecosystem.config.js --only logdhan-backend

# Start only frontend  
pm2 start ecosystem.config.js --only logdhan-frontend

# Start with specific environment
pm2 start ecosystem.config.js --env production
pm2 start ecosystem.config.js --env staging
```

## 📊 Monitoring

```bash
# Show all running processes
pm2 list

# Monitor real-time logs
pm2 logs

# Monitor specific app
pm2 logs logdhan-backend
pm2 logs logdhan-frontend

# Monitor with live dashboard
pm2 monit

# Show process details
pm2 show logdhan-backend
```

## 🔄 Management

```bash
# Restart all apps
pm2 restart ecosystem.config.js

# Restart specific app
pm2 restart logdhan-backend

# Reload (zero-downtime restart)
pm2 reload logdhan-backend

# Stop all apps
pm2 stop ecosystem.config.js

# Stop specific app
pm2 stop logdhan-backend

# Delete all apps
pm2 delete ecosystem.config.js

# Delete specific app
pm2 delete logdhan-backend
```

## 🔧 Configuration

```bash
# Reload config after changes
pm2 reload ecosystem.config.js

# Start with new config
pm2 start ecosystem.config.js --update-env

# Environment-specific start
pm2 start ecosystem.config.js --env production
```

## 📝 Logs

```bash
# View logs
pm2 logs --lines 100

# Clear logs
pm2 flush

# Log rotation (setup)
pm2 install pm2-logrotate
```

## 💾 Persistence

```bash
# Save current PM2 state
pm2 save

# Resurrect saved state on reboot
pm2 resurrect

# Setup auto-startup
pm2 startup
# Follow the command it shows

# Disable auto-startup
pm2 unstartup
```

## 🌍 Deployment

```bash
# Deploy to production
pm2 deploy production setup
pm2 deploy production

# Deploy to staging
pm2 deploy staging setup  
pm2 deploy staging
```

## 🔍 Health Checks

```bash
# Process health
pm2 ping

# Memory usage
pm2 list | grep -E "(memory|cpu)"

# Detailed process info
pm2 describe logdhan-backend
```

## ⚙️ Environment Variables

Make sure to create `.env` file in the backend root:

```bash
cp .env.example .env
# Edit .env with your actual values
```

## 🚨 Troubleshooting

```bash
# Kill all PM2 processes
pm2 kill

# Reset PM2 
pm2 reset logdhan-backend

# Update PM2
npm install -g pm2@latest
pm2 update
```