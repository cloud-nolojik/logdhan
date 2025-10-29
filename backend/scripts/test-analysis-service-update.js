#!/usr/bin/env node

/**
 * Test the new analysis_service_update template
 */

import { MessagingService } from '../src/services/messaging/messaging.service.js';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
const envPath = path.resolve('backend/.env');
console.log('Loading .env from:', envPath);
dotenv.config({ path: envPath });

const TEST_MOBILE_NUMBER = '919008108650';

async function testAnalysisServiceUpdate() {
  console.log('🧪 Testing Analysis Service Update Template');
  console.log('📱 Target Number:', TEST_MOBILE_NUMBER);
  console.log('='.repeat(50));

  try {
    const messagingService = new MessagingService();
    await messagingService.initialize();
    
    console.log('✅ Messaging service initialized');
    console.log('');

    // Test 1: With user name
    console.log('📋 Test 1: Analysis Service Update (With Name)');
    try {
      const analysisData = {
        userName: 'John',
        stocksProcessed: 15
      };
      
      console.log('   Sending with data:', analysisData);
      
      const result = await messagingService.sendAnalysisServiceUpdate(
        TEST_MOBILE_NUMBER,
        analysisData
      );
      
      console.log('✅ Analysis service update sent successfully');
      console.log('   Response:', JSON.stringify(result, null, 2));
      
    } catch (error) {
      console.log('❌ Analysis service update failed:', error.message);
    }

    console.log('');
    console.log('⏳ Waiting 10 seconds before next test...');
    await new Promise(resolve => setTimeout(resolve, 10000));

    // Test 2: Without user name (fallback to logdhanuser)
    console.log('📋 Test 2: Analysis Service Update (Fallback Name)');
    try {
      const analysisData = {
        userName: null, // Will fallback to 'logdhanuser'
        stocksProcessed: 20
      };
      
      console.log('   Sending with data:', analysisData);
      
      const result = await messagingService.sendAnalysisServiceUpdate(
        TEST_MOBILE_NUMBER,
        analysisData
      );
      
      console.log('✅ Analysis service update (fallback) sent successfully');
      console.log('   Response:', JSON.stringify(result, null, 2));
      
    } catch (error) {
      console.log('❌ Analysis service update (fallback) failed:', error.message);
    }

    console.log('');
    console.log('🎉 Analysis service update tests completed!');
    console.log('📱 Check your WhatsApp for the messages');

  } catch (error) {
    console.error('❌ Failed to initialize messaging service:', error.message);
  }
}

// Test what the generated message would look like
function showExpectedMessage() {
  console.log('');
  console.log('📋 Expected WhatsApp Message:');
  console.log('='.repeat(30));
  console.log(`
Analysis Ready

Hi John,

Your educational stock analysis is complete and ready to view.

📊 What's Ready:
• 15 stocks with AI feedback now available.

This is your educational service completion notice.

Open the app to explore your learning insights.

LogDhan | support@nolojik.com

[Button: Open Results] → https://logdhan.com/analysis/completed
  `);
}

// Run tests
async function runTests() {
  showExpectedMessage();
  await testAnalysisServiceUpdate();
}

runTests().catch(console.error);