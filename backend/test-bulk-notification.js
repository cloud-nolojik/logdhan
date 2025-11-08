#!/usr/bin/env node

/**
 * Test script to trigger bulk analysis notifications
 * Usage: node test-bulk-notification.js [auth-token]
 */

import fetch from 'node-fetch';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:5650';
const AUTH_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4ZmNmNmRkNmNhMDk1NDU3YTI2NWZkZSIsImlhdCI6MTc2MjEzMDkxMCwiZXhwIjoxNzYyNzM1NzEwfQ.wwgPvgycniVYiTsK9GZZphAUZ3Nb_uCT9LWQR9bu8Gw";

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
  console.log('\n' + '='.repeat(80));
  log(title, 'cyan');
  console.log('='.repeat(80) + '\n');
}

async function triggerBulkNotification() {
  logSection('🚀 Triggering Bulk Analysis Notification');

  if (!AUTH_TOKEN) {
    log('❌ ERROR: Authentication token required', 'red');
    log('Usage: node test-bulk-notification.js <auth-token>', 'yellow');
    log('   OR: Set TEST_AUTH_TOKEN in .env file', 'yellow');
    process.exit(1);
  }

  try {
    log('📡 Sending request to trigger bulk notification...', 'blue');
    log(`   API URL: ${API_BASE_URL}/api/v1/monitoring/bulk-notification/trigger`, 'blue');

    const response = await fetch(`${API_BASE_URL}/api/v1/monitoring/bulk-notification/trigger`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();

    if (response.ok && data.success) {
      log('\n✅ SUCCESS: Bulk notification triggered!', 'green');
      log(`   Message: ${data.message}`, 'green');
      log(`   Timestamp: ${data.timestamp}`, 'green');
    } else {
      log('\n❌ FAILED: Bulk notification trigger failed', 'red');
      log(`   Status: ${response.status}`, 'red');
      log(`   Error: ${data.error || data.message}`, 'red');
      log(`   Details: ${JSON.stringify(data, null, 2)}`, 'yellow');
    }

  } catch (error) {
    log('\n❌ ERROR: Request failed', 'red');
    log(`   ${error.message}`, 'red');

    if (error.code === 'ECONNREFUSED') {
      log('\n⚠️  Backend server is not running!', 'yellow');
      log('   Start the backend first: npm start', 'yellow');
    }

    process.exit(1);
  }
}

async function getNotificationStatus() {
  logSection('📊 Getting Bulk Notification Status');

  try {
    log('📡 Fetching notification job status...', 'blue');
    log(`   API URL: ${API_BASE_URL}/api/v1/monitoring/bulk-notification/status`, 'blue');

    const response = await fetch(`${API_BASE_URL}/api/v1/monitoring/bulk-notification/status`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();

    if (response.ok && data.success) {
      log('\n✅ Status retrieved successfully:', 'green');

      const status = data.data;

      if (status.error) {
        log(`   ⚠️  Service not initialized: ${status.error}`, 'yellow');
      } else if (status.status === 'no_jobs_scheduled') {
        log('   ⚠️  No jobs scheduled yet', 'yellow');
      } else {
        log(`   Status: ${status.status}`, 'cyan');
        log(`   Next Run: ${status.nextRunAt || 'N/A'}`, 'cyan');
        log(`   Last Run: ${status.lastRunAt || 'Never'}`, 'cyan');
        log(`   Last Finished: ${status.lastFinishedAt || 'Never'}`, 'cyan');

        if (status.data) {
          log('\n   📈 Last Job Results:', 'bright');

          if (status.data.skipped) {
            log(`      ⏭️  Skipped: ${status.data.reason}`, 'yellow');
            log(`      Message: ${status.data.message}`, 'yellow');
          } else {
            log(`      ✅ Success: ${status.data.success || 0}`, 'green');
            log(`      ❌ Failed: ${status.data.failed || 0}`, status.data.failed > 0 ? 'red' : 'green');
            log(`      📊 Total: ${status.data.total || 0}`, 'cyan');
          }
        }
      }

      log(`\n   Timestamp: ${data.timestamp}`, 'cyan');

    } else {
      log('\n❌ FAILED: Could not get status', 'red');
      log(`   Status: ${response.status}`, 'red');
      log(`   Error: ${data.error || data.message}`, 'red');
    }

  } catch (error) {
    log('\n❌ ERROR: Request failed', 'red');
    log(`   ${error.message}`, 'red');
  }
}

async function main() {
  logSection('🔔 Bulk Analysis Notification Test Script');

  log('This script will:', 'cyan');
  log('  1. Trigger a manual bulk notification to all users', 'cyan');
  log('  2. Display the notification job status', 'cyan');

  // Trigger notification
  await triggerBulkNotification();

  // Wait a bit for the job to process
  log('\n⏳ Waiting 3 seconds for job to process...', 'yellow');
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Get status
  await getNotificationStatus();

  logSection('✨ Test Complete');
  log('Check your app to see if you received the notification!', 'green');
  log('Also check backend logs for detailed processing information.', 'cyan');
}

// Run the script
main().catch(error => {
  log(`\n❌ Unexpected error: ${error.message}`, 'red');
  process.exit(1);
});
