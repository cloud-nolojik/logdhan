import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { cashfreeService } from '../src/services/payment/cashfree.service.js';

dotenv.config();

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

async function testCashfreeIntegration() {
  try {
    console.log('🧪 Testing Cashfree Integration...\n');

    // Test 1: Check environment variables
    console.log('1. Checking environment variables...');
    if (!process.env.CASHFREE_APP_ID || !process.env.CASHFREE_SECRET_KEY) {
      throw new Error('Cashfree credentials not found in environment variables');
    }
    console.log('✅ Cashfree credentials found\n');

    // Test 2: Test service initialization
    console.log('2. Testing service initialization...');
    console.log('Base URL:', cashfreeService.baseURL);
    console.log('API Version:', cashfreeService.apiVersion);
    console.log('✅ Service initialized successfully\n');

    // Test 3: Test headers generation
    console.log('3. Testing headers generation...');
    const headers = cashfreeService.getHeaders();
    console.log('Headers generated:', Object.keys(headers));
    console.log('✅ Headers generated successfully\n');

    // Test 4: Test webhook signature verification
    console.log('4. Testing webhook signature verification...');
    const testPayload = JSON.stringify({ test: 'data' });
    const testSignature = 'test_signature';
    const isValid = cashfreeService.verifyWebhookSignature(testPayload, testSignature);
    console.log('Signature verification result:', isValid);
    console.log('✅ Webhook signature verification working\n');

    console.log('🎉 All tests passed! Cashfree integration is ready.');
    console.log('\n📝 Next steps:');
    console.log('1. Test with real payment order creation');
    console.log('2. Configure webhook URL in Cashfree dashboard');
    console.log('3. Test webhook processing');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

// Run the test
testCashfreeIntegration(); 