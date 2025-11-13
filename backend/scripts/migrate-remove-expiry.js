/**
 * Migration Script: Remove expires_at Field from Existing Analyses
 *
 * This script updates all existing StockAnalysis documents to:
 * 1. Remove the expires_at field completely
 * 2. Strategies will no longer auto-expire
 *
 * Run this script ONCE after deploying the expiry removal changes.
 *
 * Usage: node backend/scripts/migrate-remove-expiry.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function migrate() {
    try {
        console.log('🚀 Starting migration: Remove expires_at field from analyses...\n');

        // Connect to MongoDB
        const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/logdhan';
        await mongoose.connect(mongoUri);
        console.log('✅ Connected to MongoDB\n');

        const db = mongoose.connection.db;
        const collection = db.collection('stockanalyses');

        // Get count before migration
        const totalCount = await collection.countDocuments({});
        const withExpiresAt = await collection.countDocuments({ expires_at: { $exists: true } });

        console.log(`📊 Total analyses: ${totalCount}`);
        console.log(`📊 With expires_at field: ${withExpiresAt}\n`);

        if (withExpiresAt === 0) {
            console.log('✅ No analyses have expires_at field. Migration already completed or not needed.\n');
            process.exit(0);
        }

        console.log(`🗑️  Removing expires_at field from ${withExpiresAt} documents...\n`);

        // Remove expires_at field from all documents
        const result = await collection.updateMany(
            { expires_at: { $exists: true } },
            { $unset: { expires_at: '' } }
        );

        console.log('\n' + '='.repeat(60));
        console.log('📊 MIGRATION SUMMARY');
        console.log('='.repeat(60));
        console.log(`Total documents:        ${totalCount}`);
        console.log(`✅ Updated:             ${result.modifiedCount}`);
        console.log(`Matched:                ${result.matchedCount}`);
        console.log('='.repeat(60) + '\n');

        // Verify removal
        const remaining = await collection.countDocuments({ expires_at: { $exists: true } });
        if (remaining > 0) {
            console.log(`⚠️  Warning: ${remaining} documents still have expires_at field\n`);
            process.exit(1);
        }

        console.log('🎉 Migration completed successfully!\n');
        console.log('📝 Next steps:');
        console.log('   1. Drop the TTL index: node backend/scripts/drop-ttl-index.js');
        console.log('   2. Restart your application\n');

        process.exit(0);

    } catch (error) {
        console.error('💥 Migration failed:', error);
        process.exit(1);
    }
}

// Run migration
migrate();
