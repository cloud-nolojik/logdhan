// Quick test script to check if the can-use-credits API returns the correct data
import fetch from 'node-fetch';

async function testCanUseCreditsAPI() {
    try {
        // You'll need to replace this with a real auth token for testing
        const token = 'YOUR_AUTH_TOKEN_HERE';
        
        const response = await fetch('http://localhost:5650/api/v1/subscriptions/can-use-credits?credits=1', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });
        
        const data = await response.json();
        console.log('API Response:', JSON.stringify(data, null, 2));
        
        if (data.success && data.data) {
            console.log('\n✅ Success! API returned:');
            console.log(`- Can use credits: ${data.data.canUse}`);
            console.log(`- Daily limit: ${data.data.limit}`);
            console.log(`- Used today: ${data.data.used}`);
        } else {
            console.log('❌ API did not return expected data structure');
        }
    } catch (error) {
        console.error('❌ Error testing API:', error.message);
    }
}

console.log('Testing can-use-credits API...');
console.log('Note: You need to replace YOUR_AUTH_TOKEN_HERE with a real token');
// testCanUseCreditsAPI();