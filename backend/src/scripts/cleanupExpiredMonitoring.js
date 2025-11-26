import mongoose from 'mongoose';
import MonitoringSubscription from '../models/monitoringSubscription.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

/**
 * Manual cleanup script for expired monitoring subscriptions
 * Removes documents where expires_at has passed
 * Run this if MongoDB TTL index is not working automatically
 */
async function cleanupExpiredMonitoring() {
  try {

    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);

    const now = new Date();

    // Find all expired subscriptions
    const expiredSubscriptions = await MonitoringSubscription.find({
      expires_at: { $lt: now }
    });

    if (expiredSubscriptions.length === 0) {

      process.exit(0);
    }

    // Log details

    expiredSubscriptions.forEach((sub, index) => {

    });

    // Delete all expired subscriptions
    const result = await MonitoringSubscription.deleteMany({
      expires_at: { $lt: now }
    });

    // Verify TTL index exists
    const indexes = await MonitoringSubscription.collection.getIndexes();

    Object.keys(indexes).forEach((indexName) => {

    });

    const hasTTLIndex = Object.values(indexes).some(
      (index) => index.expireAfterSeconds !== undefined
    );

    if (hasTTLIndex) {

    } else {

      await MonitoringSubscription.collection.createIndex(
        { expires_at: 1 },
        { expireAfterSeconds: 0 }
      );

    }

    process.exit(0);

  } catch (error) {
    console.error('❌ Error during cleanup:', error);
    process.exit(1);
  }
}

// Run the cleanup
cleanupExpiredMonitoring();