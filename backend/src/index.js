import './loadEnv.js';
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import connectDB from './config/database.js';

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

// Import services and jobs
import { subscriptionService } from './services/subscription/subscriptionService.js';
import { azureStorageService } from './services/storage/azureStorage.service.js';
import { messagingService } from './services/messaging/messaging.service.js';
import priceCacheService from './services/priceCache.service.js'; // In-memory price caching service
import weekendScreeningJob from './services/jobs/weekendScreeningJob.js'; // weekend-screening (Sat 6PM IST)
import agendaDataPrefetchService from './services/agendaDataPrefetchService.js'; // daily-price-prefetch (3:35 PM Mon-Fri)
import dailyNewsStocksJob from './services/jobs/dailyNewsStocksJob.js'; // daily-news-scrape (8:30 AM Mon-Fri)
import weeklyTrackAnalysisJob from './services/jobs/weeklyTrackAnalysisJob.js'; // weekly-track-analysis (4:00 PM Mon-Fri, position management for weekly_track)

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
// COMMENTED OUT: Upstox routes - using WhatsApp notifications instead
import upstoxRoutes from './routes/upstox.js';
import bulkAnalysisRoutes from './routes/bulkAnalysis.js';
import webhookRoutes from './routes/webhook.js';
import publicRoutes from './routes/public.js';
import consentRoutes from './routes/consent.js';
import appRedirectRoutes from './routes/app-redirect.js';
import feedbackRoutes from './routes/feedback.js';
import positionsRoutes from './routes/positions.js';
import dashboardRoutes from './routes/dashboard.js';
import weeklyWatchlistRoutes from './routes/weeklyWatchlist.js';
import screenerRoutes from './routes/screener.js';
import journalRoutes from './routes/journal.js';
import dailyNewsStocksRoutes from './routes/dailyNewsStocks.js';
import apiUsageRoutes from './routes/apiUsage.js';
import adminRoutes from './routes/admin.js';

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Request logging middleware - logs URL, body, and auth token for all API requests
app.use((req, res, next) => {
  // Only log API requests (skip static files, health checks)
  if (req.path.startsWith('/api/')) {
    const timestamp = new Date().toISOString();
    const authHeader = req.headers.authorization;
    const tokenPreview = authHeader ? `${authHeader.substring(0, 20)}...` : 'NO_TOKEN';

    // Log request details
    console.log(`\n📥 [API REQUEST] ${timestamp}`);
    console.log(`   Method: ${req.method}`);
    console.log(`   URL: ${req.originalUrl}`);
    console.log(`   Auth: ${tokenPreview}`);

    // Log body for POST/PUT/PATCH (exclude sensitive fields)
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
      const safeBody = { ...req.body };
      // Mask sensitive fields
      if (safeBody.password) safeBody.password = '***';
      if (safeBody.access_token) safeBody.access_token = '***';
      if (safeBody.refresh_token) safeBody.refresh_token = '***';
      console.log(`   Body: ${JSON.stringify(safeBody)}`);
    }

    // Log query params if present
    if (Object.keys(req.query).length > 0) {
      console.log(`   Query: ${JSON.stringify(req.query)}`);
    }

    // Log response status and body when done
    const originalSend = res.send;
    res.send = function(body) {
      const responseTime = Date.now() - req._startTime;
      console.log(`📤 [API RESPONSE] ${req.method} ${req.originalUrl} - Status: ${res.statusCode} (${responseTime}ms)`);

      // Log response body (truncated for large responses)
      try {
        let responseBody = body;
        if (typeof body === 'string') {
          // Try to parse JSON for better formatting
          try {
            responseBody = JSON.parse(body);
          } catch (e) {
            // Not JSON, use as-is
          }
        }
        const bodyStr = typeof responseBody === 'object' ? JSON.stringify(responseBody) : String(responseBody);
        const truncatedBody = bodyStr.length > 1000 ? bodyStr.substring(0, 1000) + '... [TRUNCATED]' : bodyStr;
        console.log(`   Response: ${truncatedBody}`);
      } catch (e) {
        console.log(`   Response: [Unable to log response body]`);
      }

      return originalSend.call(this, body);
    };
    req._startTime = Date.now();
  }
  next();
});

// Serve static files from public directory with proper headers
app.use(express.static('public', {
  setHeaders: (res, path) => {
    if (path.endsWith('.svg')) res.setHeader('Content-Type', 'image/svg+xml');
    if (path.endsWith('.png')) res.setHeader('Content-Type', 'image/png');
    if (path.endsWith('.jpg') || path.endsWith('.jpeg')) res.setHeader('Content-Type', 'image/jpeg');
    if (path.endsWith('.gif')) res.setHeader('Content-Type', 'image/gif');
    if (path.endsWith('.webp')) res.setHeader('Content-Type', 'image/webp');
    if (path.endsWith('.ico')) res.setHeader('Content-Type', 'image/x-icon');
    if (path.endsWith('.json')) res.setHeader('Content-Type', 'application/json');
    // Enable CORS for images
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
  }
}));

// Specific route for Android App Links verification
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.sendFile(path.join(process.cwd(), 'public', '.well-known', 'assetlinks.json'));
});

// Serve static chart files with security headers
app.use('/charts', (req, res, next) => {
  // Security headers for chart serving
  res.setHeader('Cache-Control', 'private, max-age=3600'); // 1 hour cache
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
}, express.static(path.join(process.cwd(), 'temp', 'charts')));

// MongoDB connection is handled in connectDB() which sets up all event listeners

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
// COMMENTED OUT: Upstox API routes - using WhatsApp notifications instead
app.use('/api/v1/upstox', upstoxRoutes);
app.use('/api/v1/bulk-analysis', bulkAnalysisRoutes);
app.use('/api/v1/webhook', webhookRoutes);
app.use('/api/v1/feedback', feedbackRoutes);
app.use('/api/v1/public', publicRoutes);
app.use('/api/v1/consent', consentRoutes);
app.use('/api/v1/positions', positionsRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/weekly-watchlist', weeklyWatchlistRoutes);
app.use('/api/v1/screener', screenerRoutes);
app.use('/api/v1/journal', journalRoutes);
app.use('/api/v1/daily-news-stocks', dailyNewsStocksRoutes);
app.use('/api/v1/usage', apiUsageRoutes);
app.use('/api/v1/admin', adminRoutes);

// App redirect routes for WhatsApp deep links
app.use('/app', appRedirectRoutes);

// Deep link routes for WhatsApp templates (logdhan.com domain)

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Chart cleanup is now handled by Agenda service (agendaDataPrefetchService)
// Runs every hour via scheduled job 'chart-cleanup'

// Initialize Azure Storage
async function initializeAzureStorage() {
  try {

    await azureStorageService.initializeContainer();

  } catch (error) {
    console.warn('⚠️ Azure Storage initialization failed:', error.message);
  }
}

// Initialize subscription system
async function initializeSubscriptionSystem() {
  try {

    await subscriptionService.initializeDefaultPlans();

  } catch (error) {
    console.error('❌ Failed to initialize subscription system:', error);
  }
}

// Initialize messaging service
async function initializeMessagingService() {
  try {

    await messagingService.initialize();

  } catch (error) {
    console.error('❌ Failed to initialize messaging service:', error);
  }
}

// Initialize weekend screening job (Sat 6PM IST)
async function initializeWeekendScreeningJob() {
  try {

    await weekendScreeningJob.initialize();

  } catch (error) {
    console.error('❌ Failed to initialize weekend screening job:', error);
  }
}

// Initialize price cache service
async function initializePriceCacheService() {
  try {

    priceCacheService.start();

  } catch (error) {
    console.error('❌ Failed to initialize price cache service:', error);
  }
}

// Initialize Agenda data prefetch service (daily-price-prefetch at 3:35 PM Mon-Fri)
async function initializeAgendaDataPrefetchService() {
  try {

    await agendaDataPrefetchService.initialize();

  } catch (error) {
    console.error('❌ Failed to initialize Agenda data prefetch service:', error);
  }
}

// Initialize daily news stocks job (8:30 AM Mon-Fri IST)
async function initializeDailyNewsStocksJob() {
  try {

    await dailyNewsStocksJob.initialize();

  } catch (error) {
    console.error('❌ Failed to initialize daily news stocks job:', error);
  }
}

// Initialize weekly track analysis job (4:00 PM Mon-Fri IST - position management AI analysis for weekly_track stocks)
async function initializeWeeklyTrackAnalysisJob() {
  try {

    await weeklyTrackAnalysisJob.initialize();

  } catch (error) {
    console.error('❌ Failed to initialize weekly track analysis job:', error);
  }
}

// Condition monitoring removed - direct order placement only

const PORT = process.env.PORT || 5650;
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);

  // Connect to MongoDB FIRST before initializing services
  await connectDB();

  // Initialize all services
  await initializeAzureStorage();
  // await initializeSubscriptionSystem();
  await initializeMessagingService();
  await initializePriceCacheService(); // Start price caching for watchlist + indices

  // Scheduled jobs:
  await initializeWeekendScreeningJob(); // weekend-screening (Sat 6PM IST)
  await initializeAgendaDataPrefetchService(); // daily-price-prefetch (3:35 PM Mon-Fri)
  // await initializeDailyNewsStocksJob(); // daily-news-scrape (8:30 AM Mon-Fri IST)
  await initializeWeeklyTrackAnalysisJob(); // weekly-track-analysis (4:00 PM Mon-Fri, position management for weekly_track)

});

// Graceful shutdown handling
process.on('SIGINT', async () => {

  try {
    // Stop price cache service

    priceCacheService.stop();

    // Stop all Agenda services gracefully
    await Promise.all([
      weekendScreeningJob.shutdown(),
      agendaDataPrefetchService.stop(),
      dailyNewsStocksJob.shutdown(),
      weeklyTrackAnalysisJob.shutdown()
    ]);

    // Close MongoDB connection
    await mongoose.connection.close();

    process.exit(0);
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  try {
    // Stop price cache service
    priceCacheService.stop();

    // Stop all Agenda services gracefully
    await Promise.all([
      weekendScreeningJob.shutdown(),
      agendaDataPrefetchService.stop(),
      dailyNewsStocksJob.shutdown(),
      weeklyTrackAnalysisJob.shutdown()
    ]);

    // Close MongoDB connection
    await mongoose.connection.close();

    process.exit(0);
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
});