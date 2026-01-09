import '../src/loadEnv.js';
import mongoose from 'mongoose';
import { Plan } from '../src/models/plan.js';

// Connect to MongoDB
await mongoose.connect(process.env.MONGODB_URI);

const plans = [
  {
    planId: 'free_plan',
    name: 'Free',
    description: 'Free forever - 5 stocks',
    type: 'TRIAL', // Using TRIAL type but with no expiry = free forever
    price: 0,
    stockLimit: 5,
    features: [
      '5 stocks watchlist',
      'AI swing analysis & setups',
      'Daily analysis at 4 PM',
      'Weekly discoveries',
      'Position tracking',
      'WhatsApp notifications'
    ],
    recurringType: 'ON_DEMAND', // ON_DEMAND for free (no recurring payments)
    billingCycle: 'ONE_TIME',
    maxAmount: 0,
    recurringAmount: 0,
    costCap: 0,
    grossMargin: 0,
    pipelineAccess: 'FULL',
    analysisLevel: 'advanced',
    restrictions: {
      stockLimit: 5,
      trialDurationDays: null // null = no expiry = free forever
    },
    isActive: true,
    sortOrder: 1
  },
  {
    planId: 'pro_monthly',
    name: 'Pro Monthly',
    description: 'Full features - 30 stocks',
    type: 'MONTHLY',
    price: 149,
    stockLimit: 30,
    features: [
      '30 stocks watchlist',
      'Full AI swing analysis',
      'Daily analysis at 4 PM',
      'Weekly discoveries',
      'Position tracking',
      'WhatsApp notifications',
      'Priority support'
    ],
    recurringType: 'PERIODIC',
    billingCycle: 'MONTHLY',
    maxAmount: 149,
    recurringAmount: 149,
    costCap: 1788,
    grossMargin: 85,
    pipelineAccess: 'FULL',
    analysisLevel: 'advanced',
    restrictions: {
      stockLimit: 30
    },
    isActive: true,
    sortOrder: 2,
    cashfreePlanId: 'pro_monthly'
  },
  {
    planId: 'pro_yearly1',
    name: 'Pro Yearly',
    description: 'Best value - Save 44%',
    type: 'ANNUAL',
    price: 999,
    stockLimit: 30,
    features: [
      '30 stocks watchlist',
      'Full AI swing analysis',
      'Daily analysis at 4 PM',
      'Weekly discoveries',
      'Position tracking',
      'WhatsApp notifications',
      'Priority support',
      'Save 44%'
    ],
    recurringType: 'PERIODIC',
    billingCycle: 'YEARLY',
    maxAmount: 999,
    recurringAmount: 999,
    costCap: 999,
    grossMargin: 90,
    pipelineAccess: 'FULL',
    analysisLevel: 'advanced',
    restrictions: {
      stockLimit: 30
    },
    isActive: true,
    sortOrder: 3,
    cashfreePlanId: 'pro_yearly1'
  }
];

console.log('🚀 Initializing SwingSetups subscription plans...\n');

// Step 1: Delete ALL existing plans
console.log('🗑️  Deleting all existing plans...');
const deleteResult = await Plan.deleteMany({});
console.log(`   Deleted ${deleteResult.deletedCount} existing plans\n`);

// Step 2: Create new plans
console.log('✨ Creating new plans...');
for (const planData of plans) {
  try {
    const newPlan = new Plan(planData);
    await newPlan.save();
    console.log(`   ✅ Created: ${planData.name} (${planData.planId}) - ${planData.stockLimit} stocks - ₹${planData.price}`);
  } catch (error) {
    console.error(`   ❌ Error with ${planData.planId}:`, error.message);
  }
}

// Step 3: Summary
console.log('\n' + '═'.repeat(50));
console.log('📊 PLAN SUMMARY');
console.log('═'.repeat(50));
console.log(`
┌────────────────┬─────────┬────────┬─────────────────┐
│ Plan           │ Price   │ Stocks │ Features        │
├────────────────┼─────────┼────────┼─────────────────┤
│ 🆓 Free        │ ₹0      │ 5      │ Free forever    │
│ ⭐ Pro Monthly │ ₹149/mo │ 30     │ Full features   │
│ 💎 Pro Yearly  │ ₹999/yr │ 30     │ Save 44%        │
└────────────────┴─────────┴────────┴─────────────────┘
`);
console.log('═'.repeat(50));
console.log('🎉 Plans initialization complete!');
console.log('═'.repeat(50));

await mongoose.disconnect();
process.exit(0);
