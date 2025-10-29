#!/usr/bin/env node

/**
 * Simple OTP test to verify WhatsApp delivery
 */

import { MessagingService } from '../src/services/messaging/messaging.service.js';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
const envPath = path.resolve('backend/.env');
dotenv.config({ path: envPath });

const TEST_MOBILE_NUMBER = '919008108650';

async function sendSimpleOTP() {
  console.log('📱 Sending Simple OTP Test');
  console.log('Target Number:', TEST_MOBILE_NUMBER);
  console.log('='.repeat(30));

  try {
    const messagingService = new MessagingService();
    await messagingService.initialize();
    
    const testOTP = '123456';
    console.log('🔐 Sending OTP:', testOTP);
    
    const result = await messagingService.sendOTP(TEST_MOBILE_NUMBER, testOTP);
    
    console.log('✅ OTP sent successfully!');
    console.log('📱 Check your WhatsApp for OTP:', testOTP);
    console.log('Message ID:', result.messages[0].messageId);
    
  } catch (error) {
    console.error('❌ Failed to send OTP:', error.message);
  }
}

sendSimpleOTP().catch(console.error);