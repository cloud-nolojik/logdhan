#!/usr/bin/env node

/**
 * Test script for incremental data updates
 * Usage: node src/scripts/testIncrementalUpdates.js
 */

import './loadEnv.js';
import mongoose from 'mongoose';
import dailyDataPrefetchService from '../services/dailyDataPrefetch.service.js';
import PreFetchedData from '../models/preFetchedData.js';

async function testIncrementalUpdates() {
    try {
        console.log('🧪 Testing incremental update logic...');
        
        // Connect to database
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Connected to MongoDB');

        // Test data
        const testStock = {
            instrument_key: 'NSE_EQ|INE002A01018', // Reliance
            stock_symbol: 'RELIANCE',
            stock_name: 'Reliance Industries Limited'
        };

        console.log('\n📊 Testing incremental updates for:', testStock.stock_symbol);
        
        // Check existing data
        const existing = await PreFetchedData.findOne({
            instrument_key: testStock.instrument_key,
            timeframe: '1d'
        });

        if (existing) {
            console.log(`📦 Found existing data:`);
            console.log(`   - Bars: ${existing.bars_count}`);
            console.log(`   - Trading Date: ${existing.trading_date.toDateString()}`);
            console.log(`   - Last Updated: ${existing.updated_at}`);
            console.log(`   - Latest Bar: ${existing.data_quality.last_bar_time}`);
        } else {
            console.log('🆕 No existing data found - will fetch initial data');
        }

        // Run update for this specific stock
        const result = await dailyDataPrefetchService.updateExistingData(
            testStock, 
            '1d', 
            existing
        );

        console.log('\n📈 Update Result:');
        console.log(`   - Success: ${result.success}`);
        console.log(`   - New Bars: ${result.newBars}`);
        console.log(`   - Total Bars: ${result.totalBars}`);
        console.log(`   - API Called: ${result.apiCalled}`);
        
        if (result.error) {
            console.log(`   - Error: ${result.error}`);
        }

        // Show updated data
        const updated = await PreFetchedData.findOne({
            instrument_key: testStock.instrument_key,
            timeframe: '1d'
        });

        if (updated) {
            console.log('\n📦 Updated data:');
            console.log(`   - Bars: ${updated.bars_count}`);
            console.log(`   - Trading Date: ${updated.trading_date.toDateString()}`);
            console.log(`   - Last Updated: ${updated.updated_at}`);
            console.log(`   - Latest Bar: ${updated.data_quality.last_bar_time}`);
        }

        console.log('\n✅ Test completed successfully');

    } catch (error) {
        console.error('❌ Test failed:', error);
    } finally {
        await mongoose.connection.close();
        console.log('🔌 Disconnected from MongoDB');
    }
}

// Run the test
testIncrementalUpdates();