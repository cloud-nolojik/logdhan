import axios from 'axios';

async function testSimpleAnalysis() {
    try {
        console.log('🧪 Testing Simple Analysis (no auth)...');
        
        const response = await axios.get('http://localhost:5600/api/ai/health');
        console.log('✅ Health Check:', response.data);

        // Test with auth to see the detailed error
        console.log('\n🔐 Testing with auth...');
        
        const testPayload = {
            instrument_key: "NSE_EQ|INE002A01018",
            analysis_type: "swing",
            isFromRewardedAd: false,
            creditType: "regular"
        };

        const authResponse = await axios.post('http://localhost:5600/api/ai/analyze-stock', testPayload, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4YjM0MmZlYmJlZjRmNTZlMmNhNWQ0YyIsImlhdCI6MTc1NzE4Njk2NywiZXhwIjoxNzU3NzkxNzY3fQ.sPl9PxYJsYwnFAQK6ixnkqAU2FYWrPMLpv_erZFJBRI'
            },
            timeout: 30000,
            validateStatus: function (status) {
                return true; // Accept all status codes
            }
        });

        console.log('📋 Response Status:', authResponse.status);
        console.log('📋 Response Data:', JSON.stringify(authResponse.data, null, 2));

    } catch (error) {
        console.error('❌ Test Failed:', error.message);
        
        if (error.response) {
            console.error('📋 Error Response Data:', JSON.stringify(error.response.data, null, 2));
            console.error('🔢 Status Code:', error.response.status);
        }
    }
}

// Run the test
testSimpleAnalysis();