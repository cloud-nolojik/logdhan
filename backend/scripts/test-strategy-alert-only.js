#!/usr/bin/env node

/**
 * Test just the strategy alert template to debug the issue
 */

import { MessagingService } from '../src/services/messaging/messaging.service.js';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
const envPath = path.resolve('backend/.env');
dotenv.config({ path: envPath });

const TEST_MOBILE_NUMBER = '919008108650';

async function testStrategyAlertOnly() {
  console.log('🧪 Testing Strategy Alert Template Only');
  console.log('📱 Target Number:', TEST_MOBILE_NUMBER);
  console.log('='.repeat(50));

  try {
    const messagingService = new MessagingService();
    await messagingService.initialize();
    
    console.log('✅ Messaging service initialized');
    console.log('');

    // Test strategy alert with minimal data
    console.log('📋 Testing Strategy Alert (Minimal Data):');
    try {
      const strategyData = {
        stock_name: 'TESTSTOCK',
        entry_price: '100.00',
        target_price: '110.00', 
        stop_loss: '95.00',
        strategy_type: 'BUY',
        current_price: '99.50',
        triggers_satisfied: 'Test trigger',
        next_action: 'Test action'
      };
      
      console.log('   Sending with data:', strategyData);
      
      const result = await messagingService.sendStrategyAlert(TEST_MOBILE_NUMBER, strategyData);
      console.log('✅ Strategy Alert sent successfully');
      console.log('   Response:', JSON.stringify(result, null, 2));
      
    } catch (error) {
      console.log('❌ Strategy Alert failed:', error.message);
      console.log('   Full error:', error);
    }

  } catch (error) {
    console.error('❌ Failed to initialize:', error.message);
  }
}

// Test with different placeholder counts
async function testDifferentPlaceholders() {
  console.log('');
  console.log('🧪 Testing with reduced placeholders...');
  
  try {
    const messagingService = new MessagingService();
    await messagingService.initialize();
    
    // Create a custom message with fewer placeholders
    const customData = {
      stock_name: 'RELIANCE',
      entry_price: '2850',
      target_price: '2950',
      stop_loss: '2780'
    };
    
    console.log('   Sending reduced data:', customData);
    
    // Directly call the provider to test
    if (messagingService.infobipProvider) {
      const result = await messagingService.infobipProvider.sendMessage({
        to: TEST_MOBILE_NUMBER,
        templateName: 'strategy_alert',
        templateData: customData
      });
      
      console.log('✅ Direct provider call successful');
      console.log('   Response:', JSON.stringify(result, null, 2));
    }
    
  } catch (error) {
    console.log('❌ Direct provider test failed:', error.message);
    console.log('   Full error:', error);
  }
}

// Run tests
async function runTests() {
  await testStrategyAlertOnly();
  await testDifferentPlaceholders();
}

runTests().catch(console.error);