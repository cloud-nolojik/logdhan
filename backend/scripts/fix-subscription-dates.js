/**
 * Migration script to fix incorrect subscription end dates
 * Run this once to fix existing subscriptions with 100-year end dates
 */

import mongoose from 'mongoose';
import { Subscription } from '../src/models/Subscription.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

async function fixSubscriptionDates() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    // Find all active subscriptions
    const subscriptions = await Subscription.find({ status: 'ACTIVE' });
    console.log(`Found ${subscriptions.length} active subscriptions to check`);

    let fixedCount = 0;
    const now = new Date();
    const oneYearFromNow = new Date(now);
    oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() + 1);

    for (const subscription of subscriptions) {
      const currentEndDate = new Date(subscription.billing.endDate);
      const yearsInFuture = (currentEndDate.getFullYear() - now.getFullYear());
      
      // If end date is more than 10 years in the future, it needs fixing
      if (yearsInFuture > 10) {
        console.log(`\nFixing subscription for user ${subscription.userId}:`);
        console.log(`  Plan: ${subscription.planId}`);
        console.log(`  Current end date: ${currentEndDate.toISOString()} (${yearsInFuture} years in future)`);
        
        let newEndDate;
        const startDate = new Date(subscription.billing.startDate);
        
        // Calculate correct end date based on plan type
        if (subscription.planId === 'basic_ads') {
          // Keep lifetime for free plan
          console.log('  -> Keeping lifetime end date for free plan');
          continue;
        } else if (subscription.planId === 'pro_monthly') {
          // Monthly: 30 days from start
          newEndDate = new Date(startDate);
          newEndDate.setDate(newEndDate.getDate() + 30);
          
          // If that date is already passed, set to 30 days from now
          if (newEndDate < now) {
            newEndDate = new Date(now);
            newEndDate.setDate(newEndDate.getDate() + 30);
          }
        } else if (subscription.planId === 'pro_annual') {
          // Annual: 365 days from start
          newEndDate = new Date(startDate);
          newEndDate.setDate(newEndDate.getDate() + 365);
          
          // If that date is already passed, set to 365 days from now
          if (newEndDate < now) {
            newEndDate = new Date(now);
            newEndDate.setDate(newEndDate.getDate() + 365);
          }
        } else {
          // Unknown plan, default to 30 days
          newEndDate = new Date(now);
          newEndDate.setDate(newEndDate.getDate() + 30);
        }
        
        console.log(`  New end date: ${newEndDate.toISOString()}`);
        
        // Update the subscription
        subscription.billing.endDate = newEndDate;
        subscription.billing.nextBillingDate = newEndDate;
        subscription.nextResetAt = newEndDate;
        
        await subscription.save();
        fixedCount++;
        console.log('  ✅ Fixed!');
      }
    }

    console.log(`\n=========================`);
    console.log(`Fixed ${fixedCount} subscriptions`);
    console.log(`=========================`);

  } catch (error) {
    console.error('Error fixing subscription dates:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

// Run the migration
fixSubscriptionDates();