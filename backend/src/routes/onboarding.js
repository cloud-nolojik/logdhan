import express from 'express';
import { User } from '../models/user.js';
import { auth } from '../middleware/auth.js';

const router = express.Router();

// Get onboarding status
router.get('/status', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('onboardingCompleted tradingExperience preferredQuestionStyle onboardingProgress');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      data: {
        onboardingCompleted: user.onboardingCompleted,
        tradingExperience: user.tradingExperience,
        preferredQuestionStyle: user.preferredQuestionStyle,
        currentStep: user.onboardingProgress?.currentStep || 0,
        stepsCompleted: user.onboardingProgress?.stepsCompleted || [],
        conceptsLearned: user.onboardingProgress?.conceptsLearned || []
      }
    });
  } catch (error) {
    console.error('Error getting onboarding status:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Update trading experience
router.post('/experience', auth, async (req, res) => {
  try {
    const { experience } = req.body;

    if (!['beginner', 'intermediate', 'advanced'].includes(experience)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid experience level'
      });
    }

    // Determine question style based on experience
    const questionStyleMap = {
      'beginner': 'simple',
      'intermediate': 'standard',
      'advanced': 'advanced'
    };

    const user = await User.findByIdAndUpdate(
      req.user.id,
      {
        tradingExperience: experience,
        preferredQuestionStyle: questionStyleMap[experience],
        'onboardingProgress.currentStep': 1
      },
      { new: true }
    );

    res.json({
      success: true,
      data: {
        tradingExperience: user.tradingExperience,
        preferredQuestionStyle: user.preferredQuestionStyle,
        currentStep: user.onboardingProgress.currentStep
      }
    });
  } catch (error) {
    console.error('Error updating trading experience:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Update onboarding progress
router.post('/progress', auth, async (req, res) => {
  try {
    const { stepId, conceptLearned } = req.body;

    const user = await User.findById(req.user.id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Add step to completed steps
    if (stepId) {
      const existingStep = user.onboardingProgress.stepsCompleted.find(step => step.stepId === stepId);
      if (!existingStep) {
        user.onboardingProgress.stepsCompleted.push({
          stepId: stepId,
          completedAt: new Date()
        });
        user.onboardingProgress.currentStep += 1;
      }
    }

    // Add concept to learned concepts
    if (conceptLearned && !user.onboardingProgress.conceptsLearned.includes(conceptLearned)) {
      user.onboardingProgress.conceptsLearned.push(conceptLearned);
    }

    await user.save();

    res.json({
      success: true,
      data: {
        currentStep: user.onboardingProgress.currentStep,
        stepsCompleted: user.onboardingProgress.stepsCompleted,
        conceptsLearned: user.onboardingProgress.conceptsLearned
      }
    });
  } catch (error) {
    console.error('Error updating onboarding progress:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Complete onboarding
router.post('/complete', auth, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.user.id,
      {
        onboardingCompleted: true,
        isOnboarded: true
      },
      { new: true }
    );

    res.json({
      success: true,
      message: 'Onboarding completed successfully',
      data: {
        onboardingCompleted: user.onboardingCompleted,
        isOnboarded: user.isOnboarded
      }
    });
  } catch (error) {
    console.error('Error completing onboarding:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Get onboarding questions based on experience level
router.get('/questions', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('tradingExperience preferredQuestionStyle');
    
    if (!user || !user.tradingExperience) {
      return res.status(400).json({
        success: false,
        message: 'Trading experience not set'
      });
    }

    const questionSets = {
      beginner: {
        concepts: [
          {
            id: 'buyPrice',
            question: 'What is a "Buy Price"?',
            options: [
              'The price you paid to purchase a stock',
              'The current market price',
              'The price you want to sell at'
            ],
            correct: 0,
            explanation: 'Buy Price is the price you paid when purchasing the stock - like buying mangoes for ₹100!'
          },
          {
            id: 'stopLoss',
            question: 'What is a "Stop Loss"?',
            options: [
              'A safety limit - sell if stock falls to this price',
              'The maximum profit you want',
              'When to buy more shares'
            ],
            correct: 0,
            explanation: 'Stop Loss protects you from big losses - like selling mangoes at ₹80 if prices keep falling!'
          },
          {
            id: 'targetPrice',
            question: 'What is a "Target Price"?',
            options: [
              'Your profit goal - sell when stock reaches this price',
              'The lowest price you\'ll accept',
              'The stock\'s current value'
            ],
            correct: 0,
            explanation: 'Target Price is your profit goal - like selling mangoes at ₹120 for a good profit!'
          }
        ],
        tradeQuestions: [
          'Tell me about your trade in simple words',
          'How much money did you invest?',
          'At what loss will you exit?',
          'What profit are you hoping for?',
          'Why did you choose this stock?',
          'Do you want AI to review your trade for better insights?'
        ]
      },
      intermediate: {
        tradeQuestions: [
          'What was your buy price?',
          'Stop loss level?',
          'Target price?',
          'Trade duration (Intraday/Short/Long)?',
          'What\'s your strategy/reason?',
          'Would you like an AI review of this trade?'
        ]
      },
      advanced: {
        tradeQuestions: [
          'Entry details (Price | Quantity)?',
          'Stop loss & risk amount?',
          'Target & R:R ratio?',
          'Strategy type (Technical/Fundamental/Momentum)?',
          'Setup pattern (Breakout/Pullback/Reversal)?',
          'Position size (% of portfolio)?',
          'Request AI analysis for this trade?'
        ]
      }
    };

    res.json({
      success: true,
      data: questionSets[user.tradingExperience] || questionSets.intermediate
    });
  } catch (error) {
    console.error('Error getting onboarding questions:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

export default router;