/**
 * Migration Script: Add valid_until to Existing Analyses
 *
 * This script adds the valid_until field to all existing StockAnalysis documents
 * that don't have it yet. It calculates the valid_until time based on:
 * - If created before today's market close (3:59:59 PM IST) → valid until today 3:59:59 PM IST
 * - If created after market close → valid until next trading day 3:59:59 PM IST
 *
 * UTC Equivalent: 3:59:59 PM IST = 10:29:59 AM UTC (IST is UTC+5:30)
 *
 * The getValidUntilTime() method automatically handles the timezone conversion
 * and stores the timestamp in UTC format in the database.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../.env') });

// Import MarketHoursUtil
const MarketHoursUtil = (await import('../src/utils/marketHours.js')).default;

async function migrate() {
    try {
        console.log('🚀 Starting migration: Add valid_until to existing analyses\n');

        // Connect to MongoDB
        console.log('📡 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Connected to MongoDB\n');

        // Get StockAnalysis collection
        const collection = mongoose.connection.collection('stockanalyses');

        // Find all completed documents (will update/add valid_until for all)
        console.log('🔍 Finding all completed analysis documents...');
        const documentsToUpdate = await collection.find({
            status: 'completed'
        }).toArray();

        console.log(`📊 Found ${documentsToUpdate.length} documents to update\n`);

        // Update each document
        let successCount = 0;
        let errorCount = 0;

        for (const doc of documentsToUpdate) {
            try {
                // Calculate valid_until based on created_at (or current time if no created_at)
                const referenceDate = doc.created_at || new Date();
                const valid_until = await MarketHoursUtil.getValidUntilTime(referenceDate);

                // Update document
                await collection.updateOne(
                    { _id: doc._id },
                    {
                        $set: {
                            valid_until: valid_until,
                            last_validated_at: null // Not yet validated with new system
                        }
                    }
                );

                successCount++;
                console.log(`  ✅ [${successCount}/${documentsToUpdate.length}] Updated ${doc.stock_symbol} (${doc.instrument_key})`);
                console.log(`     Created: ${doc.created_at?.toISOString() || 'N/A'}`);
                console.log(`     Valid Until: ${valid_until.toISOString()}\n`);

            } catch (error) {
                errorCount++;
                console.error(`  ❌ [${successCount + errorCount}/${documentsToUpdate.length}] Failed to update ${doc.stock_symbol}:`, error.message);
            }
        }

        // Summary
        console.log('='.repeat(60));
        console.log('📊 Migration Summary:');
        console.log(`   Total Documents: ${documentsToUpdate.length}`);
        console.log(`   ✅ Successfully Updated: ${successCount}`);
        console.log(`   ❌ Failed: ${errorCount}`);
        console.log('='.repeat(60));

        // Verify
        console.log('\n🔍 Verifying migration...');
        const withValidUntil = await collection.countDocuments({
            status: 'completed',
            valid_until: { $exists: true }
        });

        const totalCompleted = await collection.countDocuments({
            status: 'completed'
        });

        console.log(`✅ Migration verified:`);
        console.log(`   Completed documents: ${totalCompleted}`);
        console.log(`   With valid_until: ${withValidUntil}`);

        if (withValidUntil === totalCompleted) {
            console.log(`   ✅ All completed documents now have valid_until field!`);
        } else {
            console.log(`   ⚠️  Warning: ${totalCompleted - withValidUntil} documents still missing valid_until`);
        }

        // Disconnect
        await mongoose.disconnect();
        console.log('\n✅ Migration completed successfully!');

    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    }
}

// Run migration
migrate();
