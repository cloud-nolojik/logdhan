#!/usr/bin/env node

/**
 * Test script for Infobip WhatsApp OTP integration
 * 
 * Usage:
 * node scripts/test-infobip-otp.js [phone_number]
 * 
 * Example:
 * node scripts/test-infobip-otp.js 919999999999
 */

import '../src/loadEnv.js';
import { InfobipProvider } from '../src/services/messaging/infobip.provider.js';

async function testInfobipOTP() {
  const phoneNumber = process.argv[2] || '919999999999';
  const testOTP = '123456';
  
  console.log('🧪 Testing Infobip WhatsApp OTP Integration');
  console.log('==========================================');
  
  // Check environment variables
  console.log('\n📋 Environment Check:');
  const requiredEnvVars = ['INFOBIP_API_KEY', 'INFOBIP_BASE_URL', 'INFOBIP_FROM_NUMBER'];
  let envValid = true;
  
  for (const envVar of requiredEnvVars) {
    const value = process.env[envVar];
    if (value) {
      console.log(`✅ ${envVar}: ${envVar === 'INFOBIP_API_KEY' ? '*'.repeat(20) : value}`);
    } else {
      console.log(`❌ ${envVar}: Missing`);
      envValid = false;
    }
  }
  
  if (!envValid) {
    console.log('\n❌ Environment variables not configured. Please check your .env file.');
    console.log('📖 See INFOBIP_SETUP.md for configuration instructions.');
    process.exit(1);
  }
  
  try {
    // Initialize Infobip provider
    console.log('\n🔄 Initializing Infobip provider...');
    const infobipProvider = new InfobipProvider({
      apiKey: process.env.INFOBIP_API_KEY,
      baseUrl: process.env.INFOBIP_BASE_URL,
      fromNumber: process.env.INFOBIP_FROM_NUMBER,
      webhookUrl: process.env.INFOBIP_WEBHOOK_URL
    });
    
    await infobipProvider.initialize();
    console.log('✅ Infobip provider initialized successfully');
    
    // Test OTP sending
    console.log(`\n📱 Sending test OTP to: +${phoneNumber}`);
    console.log(`🔢 Test OTP: ${testOTP}`);
    
    const result = await infobipProvider.sendMessage({
      to: phoneNumber,
      templateName: 'otp',
      templateData: {
        otp: testOTP,
        appName: process.env.APP_NAME || 'LogDhan'
      }
    });
    
    console.log('✅ OTP sent successfully!');
    console.log('📊 Response:', JSON.stringify(result, null, 2));
    
    // Extract message ID for status tracking
    if (result.messages && result.messages[0] && result.messages[0].messageId) {
      const messageId = result.messages[0].messageId;
      console.log(`\n📋 Message ID: ${messageId}`);
      
      // Wait a bit then check status
      console.log('\n⏳ Waiting 5 seconds to check delivery status...');
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      try {
        const status = await infobipProvider.getMessageStatus(messageId);
        console.log('📊 Delivery Status:', JSON.stringify(status, null, 2));
      } catch (statusError) {
        console.log('⚠️  Could not fetch delivery status:', statusError.message);
      }
    }
    
    console.log('\n🎉 Test completed successfully!');
    console.log('📱 Check your WhatsApp for the OTP message');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    
    if (error.message.includes('Template')) {
      console.log('\n💡 Template Error Solutions:');
      console.log('1. Check if template "logdhan_otp_verification" exists in Infobip dashboard');
      console.log('2. Verify template is approved and active');
      console.log('3. Ensure template language is set to "en_GB"');
      console.log('4. Check template placeholders match the expected format');
    }
    
    if (error.message.includes('Authorization') || error.message.includes('401')) {
      console.log('\n💡 Authorization Error Solutions:');
      console.log('1. Verify INFOBIP_API_KEY is correct');
      console.log('2. Check API key permissions in Infobip dashboard');
      console.log('3. Ensure API key is not expired');
    }
    
    if (error.message.includes('Phone') || error.message.includes('number')) {
      console.log('\n💡 Phone Number Error Solutions:');
      console.log('1. Ensure phone number is in correct format (12 digits)');
      console.log('2. Check if WhatsApp Business number is properly configured');
      console.log('3. Verify recipient has WhatsApp installed');
    }
    
    process.exit(1);
  }
}

// Run the test
testInfobipOTP().catch(console.error);