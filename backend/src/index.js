import './loadEnv.js';
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import path from 'path';
import fs from 'fs';

// Environment validation - fail fast on startup
function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`❌ Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

// Validate critical environment variables
const requiredVars = {
  MONGODB_URI: requireEnv('MONGODB_URI'),
  OPENAI_API_KEY: requireEnv('OPENAI_API_KEY'),
  UPSTOX_API_KEY: requireEnv('UPSTOX_API_KEY')
};

console.log('✅ Environment validation passed');

// Import services and jobs
import { subscriptionService } from './services/subscription/subscriptionService.js';
import { azureStorageService } from './services/storage/azureStorage.service.js';
import { messagingService } from './services/messaging/messaging.service.js';
import agendaDailyReminderService from './services/agendaDailyReminderService.js'; // Using Agenda instead of BullMQ
import agendaMonitoringService from './services/agendaMonitoringService.js';
// Removed condition monitoring - direct order placement only

import authRoutes from './routes/auth.js';
import stockRoutes from './routes/stock.js';
import stockLogRoutes from './routes/stockLog.js';
import watchlistRoutes from './routes/watchlist.js';
import notificationsRoutes from './routes/notifications.js';
import paymentRoutes from './routes/payments.js';
import onboardingRoutes from './routes/onboarding.js';
import experienceRoutes from './routes/experience.js';
import experienceAnalyticsRoutes from './routes/experienceAnalytics.js';
import subscriptionRoutes from './routes/subscriptions.js';
import referralRoutes from './routes/referrals.js';
import creditsRoutes from './routes/credits.js';
import marketRoutes from './routes/market.js';
import aiRoutes from './routes/ai.js';
import upstoxRoutes from './routes/upstox.js';
import bulkAnalysisRoutes from './routes/bulkAnalysis.js';
import webhookRoutes from './routes/webhook.js';
import monitoringRoutes from './routes/agendaMonitoring.js'; // Using Agenda instead of BullMQ


const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from public directory with proper headers
app.use(express.static('public', {
  setHeaders: (res, path) => {
    if (path.endsWith('.svg')) res.setHeader('Content-Type', 'image/svg+xml');
    if (path.endsWith('.png')) res.setHeader('Content-Type', 'image/png');
    if (path.endsWith('.jpg') || path.endsWith('.jpeg')) res.setHeader('Content-Type', 'image/jpeg');
    if (path.endsWith('.gif')) res.setHeader('Content-Type', 'image/gif');
    if (path.endsWith('.webp')) res.setHeader('Content-Type', 'image/webp');
    if (path.endsWith('.ico')) res.setHeader('Content-Type', 'image/x-icon');
    // Enable CORS for images
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
  }
}));

// Serve static chart files with security headers
app.use('/charts', (req, res, next) => {
  // Security headers for chart serving
  res.setHeader('Cache-Control', 'private, max-age=3600'); // 1 hour cache
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
}, express.static(path.join(process.cwd(), 'temp', 'charts')));

// Connect to MongoDB with robust connection settings
mongoose.connect(requiredVars.MONGODB_URI, {
  // Connection pool settings
  maxPoolSize: 10, // Maintain up to 10 socket connections
  serverSelectionTimeoutMS: 5000, // Keep trying to send operations for 5 seconds
  socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
  connectTimeoutMS: 10000, // Give up initial connection after 10 seconds
  
  // Resilience settings  
  maxIdleTimeMS: 30000, // Close connections after 30 seconds of inactivity
  retryWrites: true, // Automatically retry write operations
  retryReads: true, // Automatically retry read operations
})
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });

// Handle MongoDB connection events
mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('⚠️ MongoDB disconnected');
});

mongoose.connection.on('reconnected', () => {
  console.log('🔄 MongoDB reconnected');
});

// Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/stocks', stockRoutes);
app.use('/api/v1/stocklog', stockLogRoutes);
app.use('/api/v1/watchlist', watchlistRoutes);
app.use('/api/v1/notifications', notificationsRoutes);
app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/onboarding', onboardingRoutes);
app.use('/api/v1/experience', experienceRoutes);
app.use('/api/v1/analytics/experience', experienceAnalyticsRoutes);
app.use('/api/v1/subscriptions', subscriptionRoutes);
app.use('/api/v1/referrals', referralRoutes);
app.use('/api/credits', creditsRoutes);
app.use('/api/v1/market', marketRoutes);
app.use('/api/v1/ai', aiRoutes);
app.use('/api/v1/upstox', upstoxRoutes);
app.use('/api/v1/bulk-analysis', bulkAnalysisRoutes);
app.use('/api/v1/webhook', webhookRoutes);
app.use('/api/v1/monitoring', monitoringRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Clean up old chart files every hour (both local and Azure)
setInterval(async () => {
  // Clean up local files
  const chartDir = path.join(process.cwd(), 'temp', 'charts');
  
  try {
    if (fs.existsSync(chartDir)) {
      const files = fs.readdirSync(chartDir);
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;
      
      files.forEach(file => {
        const filePath = path.join(chartDir, file);
        try {
          const stats = fs.statSync(filePath);
          
          if (now - stats.mtime.getTime() > oneHour) {
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
              console.log(`🗑️ Cleaned up old local chart: ${file}`);
            }
          }
        } catch (fileError) {
          // Ignore individual file errors
          if (fileError.code !== 'ENOENT') {
            console.warn(`⚠️ Could not clean up ${file}:`, fileError.message);
          }
        }
      });
    }
  } catch (error) {
    console.error('❌ Error cleaning up local charts:', error);
  }

  // Clean up Azure storage
  try {
    await azureStorageService.cleanupOldCharts(24); // Clean up files older than 24 hours
  } catch (error) {
    console.warn('⚠️ Error cleaning up Azure charts:', error);
  }
}, 60 * 60 * 1000); // Run every hour

// Initialize Azure Storage
async function initializeAzureStorage() {
  try {
    console.log('🔄 Initializing Azure Storage...');
    await azureStorageService.initializeContainer();
    console.log('✅ Azure Storage initialized');
  } catch (error) {
    console.warn('⚠️ Azure Storage initialization failed:', error.message);
  }
}

// Initialize subscription system
async function initializeSubscriptionSystem() {
  try {
    console.log('🔄 Initializing subscription system...');
    await subscriptionService.initializeDefaultPlans();

    console.log('✅ Subscription system initialized');
  } catch (error) {
    console.error('❌ Failed to initialize subscription system:', error);
  }
}

// Initialize messaging service
async function initializeMessagingService() {
  try {
    console.log('🔄 Initializing messaging service...');
    await messagingService.initialize();
    console.log('✅ Messaging service initialized');
  } catch (error) {
    console.error('❌ Failed to initialize messaging service:', error);
  }
}

// Initialize Agenda daily reminder service
async function initializeAgendaDailyReminderService() {
  try {
    console.log('🔄 Initializing Agenda daily reminder service...');
    await agendaDailyReminderService.initialize();
    console.log('✅ Agenda daily reminder service initialized');
  } catch (error) {
    console.error('❌ Failed to initialize Agenda daily reminder service:', error);
  }
}

// Initialize Agenda monitoring service
async function initializeAgendaMonitoringService() {
  try {
    console.log('🔄 Initializing Agenda monitoring service...');
    await agendaMonitoringService.initialize();
    console.log('✅ Agenda monitoring service initialized');
  } catch (error) {
    console.error('❌ Failed to initialize Agenda monitoring service:', error);
  }
}

// Condition monitoring removed - direct order placement only

const PORT = process.env.PORT || 5650;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  
  // Initialize all services
  await initializeAzureStorage();
  await initializeSubscriptionSystem();
  await initializeMessagingService();
  await initializeAgendaDailyReminderService();
  await initializeAgendaMonitoringService();
  // BullMQ condition monitoring removed - now using Agenda
  
  console.log('🚀 All services initialized successfully');
}); 