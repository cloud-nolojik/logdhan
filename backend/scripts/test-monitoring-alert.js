#!/usr/bin/env node

/**
 * Test the monitoring conditions met alert template
 */

import { MessagingService } from '../src/services/messaging/messaging.service.js';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
const envPath = path.resolve('backend/.env');
console.log('Loading .env from:', envPath);
dotenv.config({ path: envPath });

const TEST_MOBILE_NUMBER = '919008108650';

async function testMonitoringAlert() {
  console.log('🧪 Testing Monitoring Conditions Met Alert');
  console.log('📱 Target Number:', TEST_MOBILE_NUMBER);
  console.log('='.repeat(50));

  try {
    const messagingService = new MessagingService();
    await messagingService.initialize();
    
    console.log('✅ Messaging service initialized');
    console.log('');

    // Test monitoring conditions met alert
    console.log('📋 Test: Monitoring Conditions Met Alert');
    try {
      const alertData = {
        userName: 'John',
        stockSymbol: 'RELIANCE',
        instrumentKey: 'NSE_EQ|INE002A01018'
      };
      
      console.log('   Sending alert with data:', alertData);
      
      const result = await messagingService.sendMonitoringConditionsMet(
        TEST_MOBILE_NUMBER,
        alertData
      );
      
      console.log('✅ Monitoring conditions met alert sent successfully');
      console.log('   Response:', JSON.stringify(result, null, 2));
      
    } catch (error) {
      console.log('❌ Monitoring alert test failed:', error.message);
    }

    console.log('');
    console.log('🎉 Monitoring alert test completed!');
    console.log('📱 Check your WhatsApp for the message');

  } catch (error) {
    console.error('❌ Failed to initialize messaging service:', error.message);
  }
}

// Show expected message
function showExpectedMessage() {
  console.log('');
  console.log('📋 Expected WhatsApp Message:');
  console.log('='.repeat(30));
  console.log(`
Monitoring Alert

Hi John,

Your monitoring service detected conditions met for RELIANCE.

Educational service notification only.

LogDhan | support@nolojik.com

[View Results] → Button with instrument key parameter: NSE_EQ|INE002A01018
  `);
}

// Run tests
async function runTests() {
  showExpectedMessage();
  await testMonitoringAlert();
}

runTests().catch(console.error);