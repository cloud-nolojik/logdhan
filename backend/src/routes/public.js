import express from 'express';
import { subscriptionService } from '../services/subscription/subscriptionService.js';

const router = express.Router();

/**
 * Get all available subscription plans - Public endpoint for websites
 * GET /api/public/plans
 */
router.get('/plans', async (req, res) => {
  try {
    const plans = await subscriptionService.getActivePlans();
    
    // Transform plans for public website consumption
    const publicPlans = plans.map(plan => ({
      id: plan.planId,
      name: plan.name,
      description: plan.description,
      type: plan.type,
      price: plan.price,
      stockLimit: plan.stockLimit,
      features: plan.features,
      billingCycle: plan.billingCycle,
      stocksPerRupee: plan.getStocksPerRupee(),
      savings: plan.type === 'ANNUAL' ? 
        Math.round(((plan.price * 12 - plan.price) / (plan.price * 12)) * 100) : 0,
      isPopular: plan.planId === 'pro_monthly',
      isBestValue: plan.planId === 'premium_annual' || plan.planId === 'pro_annual',
      analysisLevel: plan.analysisLevel || 'advanced',
      pipelineAccess: plan.pipelineAccess || 'FULL'
    }));

    // Add CORS headers for cross-origin requests from websites
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Cache-Control', 'public, max-age=300'); // Cache for 5 minutes

    res.json({
      success: true,
      data: publicPlans,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching public subscription plans:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch subscription plans',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Get plan details by ID - Public endpoint
 * GET /api/public/plans/:planId
 */
router.get('/plans/:planId', async (req, res) => {
  try {
    const { planId } = req.params;
    
    if (!planId || typeof planId !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Valid plan ID is required'
      });
    }

    const plan = await subscriptionService.getPlanById(planId);
    
    if (!plan || !plan.isActive) {
      return res.status(404).json({
        success: false,
        message: 'Plan not found or inactive'
      });
    }

    const publicPlan = {
      id: plan.planId,
      name: plan.name,
      description: plan.description,
      type: plan.type,
      price: plan.price,
      stockLimit: plan.stockLimit,
      features: plan.features,
      billingCycle: plan.billingCycle,
      stocksPerRupee: plan.getStocksPerRupee(),
      savings: plan.type === 'ANNUAL' ? 
        Math.round(((plan.price * 12 - plan.price) / (plan.price * 12)) * 100) : 0,
      isPopular: plan.planId === 'pro_monthly',
      isBestValue: plan.planId === 'premium_annual' || plan.planId === 'pro_annual',
      analysisLevel: plan.analysisLevel || 'advanced',
      pipelineAccess: plan.pipelineAccess || 'FULL'
    };

    // Add CORS headers
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Cache-Control', 'public, max-age=300'); // Cache for 5 minutes

    res.json({
      success: true,
      data: publicPlan,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching public plan details:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch plan details',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

export default router;