import express from 'express';

const router = express.Router();

// Get public credit information
router.get('/public/info', (req, res) => {
  try {
    // Return public credit information
    const creditInfo = {
      aiReviewCost: 1,
      creditValidityMonths: 6,
      description: '1 AI Review = 1 Credit',
      features: [
        'AI-powered trade analysis',
        'Personalized recommendations',
        'Risk assessment',
        'Performance insights'
      ]
    };

    res.json({
      success: true,
      data: creditInfo
    });
  } catch (error) {
    console.error('Error fetching credit info:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch credit information'
    });
  }
});

export default router;