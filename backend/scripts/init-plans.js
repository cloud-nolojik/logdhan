import '../src/loadEnv.js';
import mongoose from 'mongoose';
import { Plan } from '../src/models/plan.js';

// Connect to MongoDB
await mongoose.connect(process.env.MONGODB_URI);

const plans = [
  {
    planId: 'trial_3_stocks',
    name: '3 Stock Trial',
    description: '3 stocks watchlist with AI swing analysis',
    type: 'TRIAL',
    price: 0,
    stockLimit: 3,
    features: [
      '3 stocks watchlist',
      'AI swing analysis & setups',
      'WhatsApp alerts (4 types)',
      'Entry/exit signals with confidence',
      'Risk management education',
      'Broker-independent'
    ],
    recurringType: 'ON_DEMAND',
    billingCycle: 'ONE_TIME',
    maxAmount: 0,
    recurringAmount: 0,
    costCap: 0,
    grossMargin: 0,
    pipelineAccess: 'BASIC',
    analysisLevel: 'basic',
    restrictions: {
      stockLimit: 3,
      trialDurationDays: 30
    },
    isActive: true,
    sortOrder: 1
  },
  {
    planId: '10_stock_plan',
    name: '10 Stock Plan',
    description: '10 stocks watchlist with full AI analysis',
    type: 'MONTHLY',
    price: 999,
    stockLimit: 10,
    features: [
      '10 stocks watchlist',
      'Full AI swing analysis',
      'Real-time WhatsApp alerts',
      'Entry/SL/target recommendations',
      'Risk-reward calculations',
      'Educational content only'
    ],
    recurringType: 'PERIODIC',
    billingCycle: 'MONTHLY',
    maxAmount: 999,
    recurringAmount: 999,
    costCap: 11988, // 12 months
    grossMargin: 70,
    pipelineAccess: 'FULL',
    analysisLevel: 'advanced',
    restrictions: {
      stockLimit: 10
    },
    isActive: true,
    sortOrder: 2
  },
  {
    planId: '20_stock_plan',
    name: '20 Stock Plan',
    description: '20 stocks watchlist with advanced AI analysis',
    type: 'MONTHLY',
    price: 1999,
    stockLimit: 20,
    features: [
      '20 stocks watchlist',
      'Advanced AI analysis',
      'Priority WhatsApp alerts',
      'Technical pattern recognition',
      'Market timing education',
      'Comprehensive setup details'
    ],
    recurringType: 'PERIODIC',
    billingCycle: 'MONTHLY',
    maxAmount: 1999,
    recurringAmount: 1999,
    costCap: 23988, // 12 months
    grossMargin: 75,
    pipelineAccess: 'FULL',
    analysisLevel: 'advanced',
    restrictions: {
      stockLimit: 20
    },
    isActive: true,
    sortOrder: 3
  },
  {
    planId: '30_stock_plan',
    name: '30 Stock Plan',
    description: '30 stocks watchlist with premium AI insights',
    type: 'MONTHLY',
    price: 2999,
    stockLimit: 30,
    features: [
      '30 stocks watchlist',
      'Premium AI insights',
      'Instant WhatsApp notifications',
      'Advanced market analysis',
      'Maximum learning capacity',
      'Professional education tools'
    ],
    recurringType: 'PERIODIC',
    billingCycle: 'MONTHLY',
    maxAmount: 2999,
    recurringAmount: 2999,
    costCap: 35988, // 12 months
    grossMargin: 80,
    pipelineAccess: 'FULL',
    analysisLevel: 'advanced',
    restrictions: {
      stockLimit: 30
    },
    isActive: true,
    sortOrder: 4
  }
];

console.log('🚀 Initializing LogDhan subscription plans...');

for (const planData of plans) {
  try {
    const existingPlan = await Plan.findOne({ planId: planData.planId });
    
    if (existingPlan) {
      // Update existing plan
      await Plan.findOneAndUpdate(
        { planId: planData.planId },
        planData,
        { new: true }
      );
      console.log(`✅ Updated plan: ${planData.planId}`);
    } else {
      // Create new plan
      const newPlan = new Plan(planData);
      await newPlan.save();
      console.log(`✅ Created plan: ${planData.planId}`);
    }
  } catch (error) {
    console.error(`❌ Error with plan ${planData.planId}:`, error.message);
  }
}

console.log('🎉 Plans initialization complete!');
process.exit(0);