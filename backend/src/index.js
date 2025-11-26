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

// Import services and jobs
import { subscriptionService } from './services/subscription/subscriptionService.js';
import { azureStorageService } from './services/storage/azureStorage.service.js';
import { messagingService } from './services/messaging/messaging.service.js';
import priceCacheService from './services/priceCache.service.js'; // In-memory price caching service
import agendaDailyReminderService from './services/agendaDailyReminderService.js'; // Using Agenda instead of BullMQ
import agendaMonitoringService from './services/agendaMonitoringService.js';
import agendaDataPrefetchService from './services/agendaDataPrefetchService.js'; // Using Agenda for data pre-fetching
import agendaBulkAnalysisNotificationService from './services/agendaBulkAnalysisNotificationService.js'; // Daily 5 PM bulk analysis notifications
import agendaBulkAnalysisReminderService from './services/agendaBulkAnalysisReminderService.js'; // Daily 8 AM bulk analysis expiry reminder
import agendaScheduledBulkAnalysisService from './services/agendaScheduledBulkAnalysis.service.js'; // Daily 4 PM pre-analysis of all watchlist stocks (Agenda)
import agendaMonitoringCleanupService from './services/agendaMonitoringCleanupService.js'; // Daily 4 AM cleanup of expired monitoring subscriptions
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
// COMMENTED OUT: Upstox routes - using WhatsApp notifications instead
// import upstoxRoutes from './routes/upstox.js';
import bulkAnalysisRoutes from './routes/bulkAnalysis.js';
import webhookRoutes from './routes/webhook.js';
import monitoringRoutes from './routes/agendaMonitoring.js'; // Using Agenda instead of BullMQ
import publicRoutes from './routes/public.js';
import consentRoutes from './routes/consent.js';
import appRedirectRoutes from './routes/app-redirect.js';
import feedbackRoutes from './routes/feedback.js';

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Request logging middleware - logs URL and body for all requests
app.use((req, res, next) => {

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

// Connect to MongoDB with robust connection settings

// Handle MongoDB connection events
mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB connection error:', err);
});

mongoose.connection.on('disconnected', () => {

});

mongoose.connection.on('reconnected', () => {

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
// COMMENTED OUT: Upstox API routes - using WhatsApp notifications instead
// app.use('/api/v1/upstox', upstoxRoutes);
app.use('/api/v1/bulk-analysis', bulkAnalysisRoutes);
app.use('/api/v1/webhook', webhookRoutes);
app.use('/api/v1/monitoring', monitoringRoutes);
app.use('/api/v1/feedback', feedbackRoutes);
app.use('/api/v1/public', publicRoutes);
app.use('/api/v1/consent', consentRoutes);

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

// Initialize Agenda daily reminder service
async function initializeAgendaDailyReminderService() {
  try {

    await agendaDailyReminderService.initialize();

  } catch (error) {
    console.error('❌ Failed to initialize Agenda daily reminder service:', error);
  }
}

// Initialize Agenda monitoring service
async function initializeAgendaMonitoringService() {
  try {

    await agendaMonitoringService.initialize();

  } catch (error) {
    console.error('❌ Failed to initialize Agenda monitoring service:', error);
  }
}

// Initialize Agenda data pre-fetch service
async function initializeAgendaDataPrefetchService() {
  try {

    await agendaDataPrefetchService.initialize();

  } catch (error) {
    console.error('❌ Failed to initialize Agenda data pre-fetch service:', error);
  }
}

// Initialize Agenda bulk analysis notification service
async function initializeAgendaBulkAnalysisNotificationService() {
  try {

    await agendaBulkAnalysisNotificationService.initialize();

  } catch (error) {
    console.error('❌ Failed to initialize Agenda bulk analysis notification service:', error);
  }
}

// Initialize Agenda bulk analysis reminder service (8 AM expiry reminder)
async function initializeAgendaBulkAnalysisReminderService() {
  try {

    await agendaBulkAnalysisReminderService.initialize();

  } catch (error) {
    console.error('❌ Failed to initialize Agenda bulk analysis reminder service:', error);
  }
}

// Initialize Agenda scheduled bulk analysis service (4 PM pre-analysis)
async function initializeAgendaScheduledBulkAnalysisService() {
  try {

    await agendaScheduledBulkAnalysisService.initialize();

  } catch (error) {
    console.error('❌ Failed to initialize Agenda scheduled bulk analysis service:', error);
  }
}

// Initialize monitoring cleanup service (4 AM daily cleanup)
async function initializeAgendaMonitoringCleanupService() {
  try {

    await agendaMonitoringCleanupService.initialize();

  } catch (error) {
    console.error('❌ Failed to initialize monitoring cleanup service:', error);
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

// Condition monitoring removed - direct order placement only

const PORT = process.env.PORT || 5650;
app.listen(PORT, async () => {

  // Initialize all services
  await initializeAzureStorage();
  // await initializeSubscriptionSystem();
  await initializeMessagingService();
  await initializePriceCacheService(); // Start price caching for watchlist + indices
  await initializeAgendaDailyReminderService();
  await initializeAgendaMonitoringService();
  await initializeAgendaDataPrefetchService();
  await initializeAgendaBulkAnalysisNotificationService();
  await initializeAgendaBulkAnalysisReminderService();
  await initializeAgendaScheduledBulkAnalysisService();
  await initializeAgendaMonitoringCleanupService(); // Cleanup expired monitoring subscriptions
  // BullMQ condition monitoring removed - now using Agenda

});

// Graceful shutdown handling
process.on('SIGINT', async () => {

  try {
    // Stop price cache service

    priceCacheService.stop();

    // Stop all Agenda services gracefully

    await Promise.all([
    agendaDataPrefetchService.stop(),
    agendaDailyReminderService.agenda?.stop?.(),
    agendaMonitoringService.agenda?.stop?.(),
    agendaBulkAnalysisNotificationService.shutdown(),
    agendaBulkAnalysisReminderService.shutdown(),
    agendaScheduledBulkAnalysisService.stop(),
    agendaMonitoringCleanupService.shutdown()]
    );

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
    agendaDataPrefetchService.stop(),
    agendaDailyReminderService.agenda?.stop?.(),
    agendaMonitoringService.agenda?.stop?.(),
    agendaBulkAnalysisNotificationService.shutdown(),
    agendaBulkAnalysisReminderService.shutdown(),
    agendaScheduledBulkAnalysisService.stop(),
    agendaMonitoringCleanupService.shutdown()]
    );

    // Close MongoDB connection
    await mongoose.connection.close();

    process.exit(0);
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
});