import mongoose from 'mongoose';
import monitoringQueueService from './src/services/monitoringQueue.js';
import triggerOrderService from './src/services/triggerOrderService.js';
import { getCandleDataForTimeframe } from './src/utils/candleData.js';

/**
 * Test monitoring system with VALID ObjectId
 */

async function testMonitoringSystemFixed() {
    console.log('🧪 Testing Monitoring System (Fixed ObjectId)');
    console.log('='.repeat(80));
    
    try {
        // Generate a valid MongoDB ObjectId for testing
        const validObjectId = new mongoose.Types.ObjectId();
        console.log(`📋 Using valid test ObjectId: ${validObjectId}`);
        
        // Mock analysis with VALID ObjectId
        const mockAnalysis = {
            _id: validObjectId.toString(),
            stock_symbol: 'RELIANCE',
            instrument_key: 'NSE_EQ|INE002A01018',
            user_id: 'test_user_123',
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000), // Expires in 24 hours
            analysis_data: {
                strategies: [{
                    id: 'strategy_test_monitoring',
                    type: 'intraday',
                    entry: 2800,
                    target: 2900,
                    stopLoss: 2750,
                    triggers: [
                        // Trigger that's likely to fail - RSI oversold condition
                        {
                            id: 'T1',
                            timeframe: '1d',
                            left: { ref: 'rsi' },
                            op: '<',
                            right: { ref: 'value', value: 25 }, // Very oversold, unlikely to be met
                            description: 'RSI oversold below 25'
                        },
                        // Another trigger - price above very high value
                        {
                            id: 'T2',
                            timeframe: '1d',
                            left: { ref: 'close' },
                            op: '>',
                            right: { ref: 'value', value: 5000 }, // Very high price, unlikely to be met
                            description: 'Price above 5000'
                        }
                    ]
                }]
            },
            hasActiveOrders: () => false, // Mock method
            placed_orders: []
        };
        
        // 1. Test trigger condition checking directly (without database)
        console.log('\n📊 1. Testing direct trigger condition checking...');
        const triggerResult = await triggerOrderService.checkTriggerConditions(mockAnalysis);
        
        console.log(`✅ Direct trigger check completed:`, {
            triggersConditionsMet: triggerResult.triggersConditionsMet,
            reason: triggerResult.reason,
            shouldMonitor: triggerResult.data?.should_monitor,
            monitoringFrequency: triggerResult.data?.monitoring_frequency
        });
        
        if (triggerResult.data?.triggers) {
            console.log('\n📋 Trigger Details:');
            triggerResult.data.triggers.forEach(trigger => {
                const status = trigger.passed ? '✅' : '❌';
                console.log(`   ${status} ${trigger.id}: ${trigger.condition} → ${trigger.left_value} vs ${trigger.right_value}`);
            });
        }
        
        // 2. Test monitoring queue with understanding that DB lookup will fail
        console.log('\n🚀 2. Testing monitoring queue (expecting DB failure)...');
        console.log('   ⚠️  Note: This will fail because the test ObjectId is not in the database');
        console.log('   ⚠️  In real usage, the analysis would already exist in MongoDB');
        
        // Start monitoring (will fail gracefully due to DB lookup)
        const startResult = await monitoringQueueService.startMonitoring(
            validObjectId.toString(),
            'strategy_test_monitoring',
            'test_user_123',
            { seconds: 30 } // Check every 30 seconds for testing
        );
        
        console.log(`📋 Monitoring start result:`, startResult);
        
        if (startResult.success) {
            console.log('\n⏱️ Waiting 35 seconds to see monitoring behavior...');
            console.log('   (Jobs will fail due to missing DB record, but this demonstrates the flow)');
            
            await new Promise(resolve => setTimeout(resolve, 35000));
            
            // Check status
            const status = await monitoringQueueService.getMonitoringStatus(validObjectId.toString());
            console.log(`📊 Final monitoring status:`, status);
            
            // Stop monitoring
            console.log('\n🛑 Stopping monitoring...');
            const stopResult = await monitoringQueueService.stopMonitoring(validObjectId.toString());
            console.log(`📊 Stop result:`, stopResult);
        }
        
        // 3. Demonstrate the solution for real usage
        console.log('\n💡 3. Solution for Real Usage:');
        console.log('   📋 To use monitoring in production:');
        console.log('   1. Create a real StockAnalysis document in MongoDB');
        console.log('   2. Use the real document\'s _id (24-char hex string)');
        console.log('   3. Monitoring will work normally');
        console.log('');
        console.log('   📋 Example real workflow:');
        console.log('   POST /api/upstox/place-order { "strategyId": "real_strategy_id" }');
        console.log('   ↓ (if triggers not met)');
        console.log('   System automatically starts monitoring with real analysis._id');
        console.log('   ↓ (every hour/minute based on triggers)');
        console.log('   Background worker checks triggers using real DB data');
        console.log('   ↓ (when triggers satisfied)');
        console.log('   Order placed automatically!');
        
        console.log('\n🎉 Fixed Monitoring Test Completed!');
        console.log('='.repeat(80));
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
    } finally {
        // Ensure cleanup
        setTimeout(() => {
            console.log('👋 Test completed, exiting...');
            process.exit(0);
        }, 2000);
    }
}

// Run the fixed test
testMonitoringSystemFixed().catch(error => {
    console.error('❌ Test suite failed:', error);
    process.exit(1);
});