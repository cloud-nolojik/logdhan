#!/usr/bin/env node

/**
 * Check the delivery status of WhatsApp messages
 */

import { MessagingService } from '../src/services/messaging/messaging.service.js';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
const envPath = path.resolve('backend/.env');
dotenv.config({ path: envPath });

const STRATEGY_MESSAGE_ID = 'f2f2e423-1728-4fc5-b34a-4e8bfa00ffc1';
const OTP_MESSAGE_ID = '445d009e-24d8-4fa7-98b5-656a3447c9c6';

async function checkMessageStatus() {
  console.log('🔍 Checking WhatsApp Message Delivery Status');
  console.log('=' .repeat(50));

  try {
    const messagingService = new MessagingService();
    await messagingService.initialize();

    console.log('✅ Messaging service initialized');
    console.log('');

    // Check OTP message status
    console.log('📋 Checking OTP Message Status:');
    console.log('   Message ID:', OTP_MESSAGE_ID);
    try {
      const otpStatus = await messagingService.getMessageStatus(OTP_MESSAGE_ID);
      console.log('   Status:', JSON.stringify(otpStatus, null, 2));
    } catch (error) {
      console.log('   Error:', error.message);
    }
    
    console.log('');
    
    // Check strategy alert message status
    console.log('📋 Checking Strategy Alert Message Status:');
    console.log('   Message ID:', STRATEGY_MESSAGE_ID);
    try {
      const strategyStatus = await messagingService.getMessageStatus(STRATEGY_MESSAGE_ID);
      console.log('   Status:', JSON.stringify(strategyStatus, null, 2));
    } catch (error) {
      console.log('   Error:', error.message);
    }

  } catch (error) {
    console.error('❌ Failed to check message status:', error.message);
  }
}

// Run the status check
checkMessageStatus().catch(console.error);