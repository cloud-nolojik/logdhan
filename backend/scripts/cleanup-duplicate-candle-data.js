#!/usr/bin/env node

/**
 * Cleanup Script: Remove duplicate candle data from upstox_payload.original_data
 * 
 * This script removes the duplicate candle data stored in upstox_payload.original_data
 * while keeping only essential metadata. This reduces storage space and eliminates
 * data inconsistency between candle_data and upstox_payload.original_data.
 */

import mongoose from 'mongoose';
import PreFetchedData from '../src/models/preFetchedData.js';

const MONGODB_URI="mongodb+srv://logdhan:RdctQJweIxaK40sb@nolojikcluster0.47wluir.mongodb.net/logdhan?retryWrites=true&w=majority"


async function cleanupDuplicateCandleData() {
    try {
        console.log('🚀 Starting duplicate candle data cleanup...');
        
        // Connect to MongoDB
        await mongoose.connect(MONGODB_URI);
        console.log('✅ Connected to MongoDB');
        
        // Find documents with original_data
        const documentsWithOriginalData = await PreFetchedData.countDocuments({
            'upstox_payload.original_data': { $exists: true }
        });
        
        console.log(`📊 Found ${documentsWithOriginalData} documents with duplicate candle data`);
        
        if (documentsWithOriginalData === 0) {
            console.log('✅ No cleanup needed - all documents are already clean');
            return;
        }
        
        // Update documents to remove original_data and replace with metadata
        const result = await PreFetchedData.updateMany(
            { 'upstox_payload.original_data': { $exists: true } },
            {
                $set: {
                    'upstox_payload.cleanup_performed': new Date(),
                    'upstox_payload.original_data_removed': true
                },
                $unset: {
                    'upstox_payload.original_data': 1
                }
            }
        );
        
        console.log(`✅ Cleanup completed successfully!`);
        console.log(`   - Modified ${result.modifiedCount} documents`);
        console.log(`   - Removed duplicate candle data from upstox_payload.original_data`);
        console.log(`   - Added cleanup metadata for tracking`);
        
        // Verify cleanup
        const remainingDocuments = await PreFetchedData.countDocuments({
            'upstox_payload.original_data': { $exists: true }
        });
        
        if (remainingDocuments === 0) {
            console.log('🎉 All duplicate data successfully removed!');
        } else {
            console.warn(`⚠️  ${remainingDocuments} documents still have original_data`);
        }
        
        // Show storage space improvement estimate
        const sampleDoc = await PreFetchedData.findOne({}).lean();
        if (sampleDoc && sampleDoc.candle_data) {
            const avgCandlesPerDoc = sampleDoc.candle_data.length;
            const estimatedSpaceSavedPerDoc = avgCandlesPerDoc * 50; // Rough estimate: 50 bytes per candle
            const totalSpaceSaved = (estimatedSpaceSavedPerDoc * result.modifiedCount) / (1024 * 1024); // MB
            
            console.log(`💾 Estimated storage space saved: ${totalSpaceSaved.toFixed(2)} MB`);
        }
        
    } catch (error) {
        console.error('❌ Cleanup failed:', error);
        throw error;
    } finally {
        await mongoose.disconnect();
        console.log('👋 Disconnected from MongoDB');
    }
}

// Run the cleanup
if (import.meta.url === `file://${process.argv[1]}`) {
    cleanupDuplicateCandleData()
        .then(() => {
            console.log('🏁 Cleanup script completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('💥 Cleanup script failed:', error);
            process.exit(1);
        });
}

export default cleanupDuplicateCandleData;