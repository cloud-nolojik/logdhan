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
        console.log('🔄 Starting cleanup of expired monitoring subscriptions...');

        // Connect to MongoDB
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Connected to MongoDB');

        const now = new Date();
        console.log(`📅 Current time: ${now.toISOString()}`);

        // Find all expired subscriptions
        const expiredSubscriptions = await MonitoringSubscription.find({
            expires_at: { $lt: now }
        });

        console.log(`📊 Found ${expiredSubscriptions.length} expired monitoring subscriptions`);

        if (expiredSubscriptions.length === 0) {
            console.log('✅ No expired subscriptions to clean up');
            process.exit(0);
        }

        // Log details
        console.log('\n📋 Expired subscriptions:');
        expiredSubscriptions.forEach((sub, index) => {
            console.log(`${index + 1}. ID: ${sub._id}`);
            console.log(`   Stock: ${sub.stock_symbol}`);
            console.log(`   Status: ${sub.monitoring_status}`);
            console.log(`   Expired at: ${sub.expires_at.toISOString()}`);
            console.log(`   Created at: ${sub.createdAt.toISOString()}`);
            console.log(`   Users: ${sub.subscribed_users.length}`);
            console.log('');
        });

        // Delete all expired subscriptions
        const result = await MonitoringSubscription.deleteMany({
            expires_at: { $lt: now }
        });

        console.log(`✅ Deleted ${result.deletedCount} expired monitoring subscriptions`);

        // Verify TTL index exists
        const indexes = await MonitoringSubscription.collection.getIndexes();
        console.log('\n📊 Current indexes on monitoring_subscriptions:');
        Object.keys(indexes).forEach(indexName => {
            console.log(`   - ${indexName}: ${JSON.stringify(indexes[indexName])}`);
        });

        const hasTTLIndex = Object.values(indexes).some(
            index => index.expireAfterSeconds !== undefined
        );

        if (hasTTLIndex) {
            console.log('✅ TTL index is configured');
        } else {
            console.log('⚠️ WARNING: TTL index is NOT configured! Documents will not auto-delete.');
            console.log('   Creating TTL index...');

            await MonitoringSubscription.collection.createIndex(
                { expires_at: 1 },
                { expireAfterSeconds: 0 }
            );

            console.log('✅ TTL index created');
        }

        process.exit(0);

    } catch (error) {
        console.error('❌ Error during cleanup:', error);
        process.exit(1);
    }
}

// Run the cleanup
cleanupExpiredMonitoring();
