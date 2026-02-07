/**
 * Test script: Send a test notification to all users
 *
 * Sends both:
 * 1. In-app notification (saved to Notification collection)
 * 2. Firebase push notification (to all devices with FCM tokens)
 *
 * Usage: node src/scripts/testNotifications.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../.env') });

import { User } from '../models/user.js';
import Notification from '../models/notification.js';
import { firebaseService } from '../services/firebase/firebase.service.js';

async function testNotifications() {
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('TEST: SEND NOTIFICATION TO ALL USERS');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB\n');

    // Step 1: Find all users
    console.log('Step 1: Finding all users...');
    const allUsers = await User.find({}).lean();
    console.log(`  Total users in DB: ${allUsers.length}`);

    const usersWithTokens = allUsers.filter(u => u.fcmTokens && u.fcmTokens.length > 0);
    console.log(`  Users with FCM tokens: ${usersWithTokens.length}`);

    allUsers.forEach(u => {
      const tokenCount = u.fcmTokens?.length || 0;
      console.log(`    - ${u.name || u.email} (${u._id}) — ${tokenCount} FCM token(s)`);
    });
    console.log('');

    // Step 2: Send in-app notification to each user
    console.log('Step 2: Creating in-app notifications...');
    const testMessage = 'This is a test notification from the analysis system.';

    for (const user of allUsers) {
      try {
        const notif = await Notification.createNotification({
          userId: user._id,
          title: 'Test Notification',
          message: testMessage,
          type: 'system',
          metadata: { test: true, sent_at: new Date().toISOString() }
        });
        console.log(`  [IN-APP] Sent to ${user.name || user.email} — notif ID: ${notif._id}`);
      } catch (err) {
        console.log(`  [IN-APP] FAILED for ${user.name || user.email}: ${err.message}`);
      }
    }
    console.log('');

    // Step 3: Send Firebase push notification to users with tokens
    console.log('Step 3: Sending Firebase push notifications...');

    if (usersWithTokens.length === 0) {
      console.log('  No users with FCM tokens — skipping Firebase push\n');
    } else {
      for (const user of usersWithTokens) {
        try {
          console.log(`  [PUSH] Sending to ${user.name || user.email} (${user.fcmTokens.length} device(s))...`);
          const result = await firebaseService.sendToUser(
            user._id,
            'Test Notification',
            testMessage,
            {
              type: 'TEST',
              route: '/notifications',
              timestamp: new Date().toISOString()
            }
          );
          console.log(`  [PUSH] Result: success=${result.success}, sent=${result.successCount || 0}, failed=${result.failureCount || 0}`);
          if (result.failedTokens?.length > 0) {
            console.log(`  [PUSH] Failed tokens removed: ${result.failedTokens.length}`);
          }
        } catch (err) {
          console.log(`  [PUSH] FAILED for ${user.name || user.email}: ${err.message}`);
        }
      }
      console.log('');
    }

    // Step 4: Verify in-app notifications were saved
    console.log('Step 4: Verifying saved notifications...');
    for (const user of allUsers) {
      const count = await Notification.countDocuments({ user: user._id, title: 'Test Notification' });
      console.log(`  ${user.name || user.email}: ${count} test notification(s) in DB`);
    }
    console.log('');

    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('TEST COMPLETE');
    console.log('═══════════════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('Test failed:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

testNotifications();
