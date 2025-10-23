#!/usr/bin/env node

/**
 * Test script for AI Analysis Caching System
 * Usage: node src/scripts/testAiAnalysisCache.js
 */

import './loadEnv.js';
import mongoose from 'mongoose';
import CachedAiAnalysisService from '../services/cachedAiAnalysis.service.js';
import aiAnalyzeService from '../services/aiAnalyze.service.js';
import AIAnalysisCache from '../models/aiAnalysisCache.js';
import StockAnalysis from '../models/stockAnalysis.js';
import { User } from '../models/user.js';

async function testCacheSystem() {
    try {
        console.log('🧪 Testing AI Analysis Cache System...');
        
        // Connect to database
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Connected to MongoDB');

        // Initialize cached service
        const cachedService = new CachedAiAnalysisService(aiAnalyzeService);

        // Test data
        const testStock = {
            instrument_key: 'NSE_EQ|INE002A01018', // Reliance
            stock_name: 'Reliance Industries Limited',
            stock_symbol: 'RELIANCE',
            current_price: 2500.50,
            analysis_type: 'swing'
        };

        // Create test users
        const user1 = new User({
            name: 'Test User 1',
            email: 'test1@example.com',
            phone: '+919999999991'
        });
        await user1.save();

        const user2 = new User({
            name: 'Test User 2', 
            email: 'test2@example.com',
            phone: '+919999999992'
        });
        await user2.save();

        console.log('\n📊 Testing cross-user cache sharing...');

        // Test 1: User 1 requests analysis (should generate fresh)
        console.log('\n🔄 Test 1: User 1 requesting fresh analysis...');
        const result1 = await cachedService.analyzeStockWithCache({
            ...testStock,
            user_id: user1._id,
            forceFresh: false // Allow cache lookup
        });

        console.log(`   Result: ${result1.success ? 'SUCCESS' : 'FAILED'}`);
        console.log(`   Cached: ${result1.cached || false}`);
        if (result1.cache_info) {
            console.log(`   Cache Info: ${JSON.stringify(result1.cache_info, null, 2)}`);
        }

        // Test 2: User 2 requests same analysis (should get from cache)
        console.log('\n🎯 Test 2: User 2 requesting same analysis (should hit cache)...');
        const result2 = await cachedService.analyzeStockWithCache({
            ...testStock,
            user_id: user2._id,
            forceFresh: false
        });

        console.log(`   Result: ${result2.success ? 'SUCCESS' : 'FAILED'}`);
        console.log(`   Cached: ${result2.cached || false}`);
        if (result2.cache_info) {
            console.log(`   Cache Info: ${JSON.stringify(result2.cache_info, null, 2)}`);
        }

        // Test 3: Check cache statistics
        console.log('\n📈 Test 3: Cache Statistics...');
        const cacheStats = await cachedService.getCacheStats();
        console.log(`   Cache Stats: ${JSON.stringify(cacheStats, null, 2)}`);

        // Test 4: Check cache info for the stock
        console.log('\n🔍 Test 4: Cache Information...');
        const tradingDate = await cachedService.getCurrentTradingDate();
        const cacheKey = AIAnalysisCache.generateCacheKey(
            testStock.instrument_key, 
            testStock.analysis_type, 
            tradingDate
        );
        
        const cacheEntry = await AIAnalysisCache.findOne({ cache_key: cacheKey });
        if (cacheEntry) {
            console.log(`   Cache Key: ${cacheKey}`);
            console.log(`   Usage Count: ${cacheEntry.usage_count}`);
            console.log(`   Users Served: ${cacheEntry.users_served.length}`);
            console.log(`   Expires At: ${cacheEntry.expires_at.toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})}`);
            console.log(`   Generated At: ${cacheEntry.generated_at.toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})}`);
        } else {
            console.log('   No cache entry found');
        }

        // Test 5: Force fresh analysis
        console.log('\n🔄 Test 5: Force fresh analysis...');
        const result3 = await cachedService.analyzeStockWithCache({
            ...testStock,
            user_id: user1._id,
            forceFresh: true
        });

        console.log(`   Result: ${result3.success ? 'SUCCESS' : 'FAILED'}`);
        console.log(`   Cached: ${result3.cached || false}`);

        // Test 6: Test price sensitivity
        console.log('\n💰 Test 6: Price change sensitivity...');
        const priceChangedStock = {
            ...testStock,
            current_price: testStock.current_price * 1.1 // 10% price increase
        };

        const result4 = await cachedService.analyzeStockWithCache({
            ...priceChangedStock,
            user_id: user2._id,
            forceFresh: false
        });

        console.log(`   Result: ${result4.success ? 'SUCCESS' : 'FAILED'}`);
        console.log(`   Cached: ${result4.cached || false}`);
        console.log(`   Price changed: ${testStock.current_price} -> ${priceChangedStock.current_price}`);

        // Cleanup
        console.log('\n🧹 Cleaning up test data...');
        await User.deleteMany({ _id: { $in: [user1._id, user2._id] } });
        await StockAnalysis.deleteMany({ user_id: { $in: [user1._id, user2._id] } });
        await AIAnalysisCache.deleteMany({ cache_key: cacheKey });

        console.log('\n✅ All tests completed successfully!');

    } catch (error) {
        console.error('❌ Test failed:', error);
    } finally {
        await mongoose.connection.close();
        console.log('🔌 Disconnected from MongoDB');
    }
}

// Check if this is being run directly
if (import.meta.url === `file://${process.argv[1]}`) {
    testCacheSystem().catch(console.error);
}

export default testCacheSystem;