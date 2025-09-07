import axios from 'axios';

async function testRelianceAnalysis() {
    try {
        console.log('🧪 Testing Reliance Stock Analysis...');
        console.log('📊 Stock: NSE_EQ|INE002A01018 (Reliance Industries)');
        console.log('📈 Analysis Type: swing\n');

        const testPayload = {
            instrument_key: "NSE_EQ|INE002A01018",
            analysis_type: "swing",
            isFromRewardedAd: false,
            creditType: "regular"
        };

        console.log('🔄 Request Payload:', JSON.stringify(testPayload, null, 2));
        console.log('\n⏳ Sending request to API...\n');

        const response = await axios.post('http://localhost:5600/api/ai/analyze-stock', testPayload, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4YjM0MmZlYmJlZjRmNTZlMmNhNWQ0YyIsImlhdCI6MTc1NzE4Njk2NywiZXhwIjoxNzU3NzkxNzY3fQ.sPl9PxYJsYwnFAQK6ixnkqAU2FYWrPMLpv_erZFJBRI'
            },
            timeout: 120000 // 2 minutes timeout for analysis
        });

        console.log('✅ API Response Status:', response.status);
        console.log('📋 Response Data:', JSON.stringify(response.data, null, 2));

        if (response.data.success) {
            const analysis = response.data.data.analysis_data;
            console.log('\n🎯 Analysis Summary:');
            console.log(`• Overall Sentiment: ${analysis.overall_sentiment}`);
            console.log(`• Market Trend: ${analysis.market_conditions?.trend || 'N/A'}`);
            console.log(`• Strategies Found: ${analysis.strategies?.length || 0}`);
            
            if (analysis.strategies && analysis.strategies.length > 0) {
                console.log('\n📊 Trading Strategies:');
                analysis.strategies.forEach((strategy, index) => {
                    console.log(`\n  Strategy ${index + 1}: ${strategy.title}`);
                    console.log(`  • Type: ${strategy.type}`);
                    console.log(`  • Confidence: ${(strategy.confidence * 100).toFixed(0)}%`);
                    console.log(`  • Entry: ₹${strategy.entry}`);
                    console.log(`  • Target: ₹${strategy.target}`);
                    console.log(`  • Stop Loss: ₹${strategy.stopLoss}`);
                    console.log(`  • Risk-Reward: ${strategy.riskReward}`);
                    if (strategy.reasoning && strategy.reasoning.length > 0) {
                        console.log(`  • Reasoning:`);
                        strategy.reasoning.forEach(reason => {
                            console.log(`    - ${reason}`);
                        });
                    }
                });
            }
        }

    } catch (error) {
        console.error('❌ Test Failed:', error.message);
        
        if (error.response) {
            console.error('📋 Error Response:', JSON.stringify(error.response.data, null, 2));
            console.error('🔢 Status Code:', error.response.status);
        }
        
        if (error.code === 'ECONNREFUSED') {
            console.error('🚫 Server not running! Please start the backend server first.');
        }
    }
}

// Run the test
testRelianceAnalysis();