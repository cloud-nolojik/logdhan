import mongoose from 'mongoose';
import { User } from '../models/user.js';
import { updateAllUsersWatchlists } from './syncScreenerWatchlist.js';

// Load env
import '../loadEnv.js';

async function testWatchlistPersistence() {
    console.log('🧪 Starting Watchlist Persistence Test (Enum Strategy)...');

    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('📦 Connected to MongoDB');

        // 1. Create a test user
        const testEmail = `test_persistence_${Date.now()}@example.com`;
        const user = await User.create({
            firstName: 'Test',
            lastName: 'User',
            email: testEmail,
            mobileNumber: '999999999999', // 12 digits
            watchlist: [
                {
                    instrument_key: 'TEST_MANUAL',
                    trading_symbol: 'MANUAL1',
                    name: 'Manual Stock',
                    exchange: 'NSE',
                    added_source: 'manual' // SHOULD BE PRESERVED
                },
                {
                    instrument_key: 'TEST_ORDER',
                    trading_symbol: 'ORDER1',
                    name: 'Order Stock',
                    exchange: 'NSE',
                    added_source: 'order' // SHOULD BE PRESERVED
                },
                {
                    instrument_key: 'TEST_SCREENER',
                    trading_symbol: 'SCREENER1',
                    name: 'Screener Stock',
                    exchange: 'NSE',
                    added_source: 'screener' // SHOULD BE REMOVED (if not in new list)
                }
            ]
        });
        console.log(`👤 Created test user: ${user.email}`);

        // 2. Simulate new screener list
        // - Contains NEW_SCREENER (New)
        // - Contains MANUAL1 (Overlap - should stay 'manual')
        const newScreenerList = [
            {
                instrument_key: 'NEW_SCREENER',
                trading_symbol: 'NEW1',
                name: 'New Screener Stock',
                exchange: 'NSE'
            },
            {
                instrument_key: 'TEST_MANUAL',
                trading_symbol: 'MANUAL1',
                name: 'Manual Stock',
                exchange: 'NSE'
            }
        ];

        // 3. Run the update function
        console.log('🔄 Running updateAllUsersWatchlists...');
        await updateAllUsersWatchlists(newScreenerList, User, false);

        // 4. Verify results
        const updatedUser = await User.findById(user._id);
        const watchlist = updatedUser.watchlist;

        console.log('📊 Final Watchlist:', watchlist.map(w => ({
            symbol: w.trading_symbol,
            source: w.added_source
        })));

        const manualStock = watchlist.find(w => w.instrument_key === 'TEST_MANUAL');
        const orderStock = watchlist.find(w => w.instrument_key === 'TEST_ORDER');
        const oldScreenerStock = watchlist.find(w => w.instrument_key === 'TEST_SCREENER');
        const newScreenerStock = watchlist.find(w => w.instrument_key === 'NEW_SCREENER');

        let success = true;

        // Check MANUAL1: Should be present AND source should still be 'manual' (sticky)
        if (manualStock && manualStock.added_source === 'manual') {
            console.log('✅ MANUAL1 preserved as "manual" (Sticky check passed)');
        } else {
            console.error(`❌ MANUAL1 failed. Present: ${!!manualStock}, Source: ${manualStock?.added_source}`);
            success = false;
        }

        // Check ORDER1: Should be present (preserved)
        if (orderStock && orderStock.added_source === 'order') {
            console.log('✅ ORDER1 preserved as "order"');
        } else {
            console.error(`❌ ORDER1 failed. Present: ${!!orderStock}, Source: ${orderStock?.added_source}`);
            success = false;
        }

        // Check SCREENER1: Should be removed
        if (!oldScreenerStock) {
            console.log('✅ SCREENER1 removed');
        } else {
            console.error('❌ SCREENER1 was NOT removed');
            success = false;
        }

        // Check NEW1: Should be added as 'screener'
        if (newScreenerStock && newScreenerStock.added_source === 'screener') {
            console.log('✅ NEW1 added as "screener"');
        } else {
            console.error(`❌ NEW1 failed. Present: ${!!newScreenerStock}, Source: ${newScreenerStock?.added_source}`);
            success = false;
        }

        // Cleanup
        await User.deleteOne({ _id: user._id });
        console.log('🧹 Cleanup done');

        if (success) {
            console.log('🎉 TEST PASSED');
            process.exit(0);
        } else {
            console.error('💥 TEST FAILED');
            process.exit(1);
        }

    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

testWatchlistPersistence();
