import express from 'express';
import { auth } from '../middleware/auth.js';
import { User } from '../models/user.js';

const router = express.Router();

// GET /consent/status - Check if user has consented
router.get('/status', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: null
      });
    }

    if (!user.hasConsented) {
      return res.status(404).json({
        success: false,
        message: 'No consent record found',
        data: null
      });
    }

    res.json({
      success: true,
      message: 'Consent status retrieved',
      data: {
        hasConsented: true,
        acceptedAt: user.consentedAt,
        version: user.consentVersion
      }
    });
  } catch (error) {
    console.error('Error checking consent status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check consent status',
      error: error.message
    });
  }
});

// POST /consent/submit - Submit user consent
router.post('/submit', auth, async (req, res) => {
  try {
    const { consentAcceptance } = req.body;
    
    if (!consentAcceptance) {
      return res.status(400).json({
        success: false,
        message: 'Consent data is required'
      });
    }

    // Validate required fields
    const required = ['acceptedAt', 'ipAddress', 'device', 'linksSnapshot', 'hashOfTextShown', 'checkboxes'];
    for (const field of required) {
      if (!consentAcceptance[field]) {
        return res.status(400).json({
          success: false,
          message: `Missing required field: ${field}`
        });
      }
    }

    // Validate mandatory checkboxes
    const { checkboxes } = consentAcceptance;
    if (!checkboxes.notAdvice || !checkboxes.acceptTermsPrivacy || !checkboxes.age18Plus || !checkboxes.whatsappCommunication) {
      return res.status(400).json({
        success: false,
        message: 'All mandatory checkboxes must be accepted'
      });
    }

    // Find and update the user
    const user = await User.findById(req.user.id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Update user consent fields
    user.hasConsented = true;
    user.consentedAt = new Date(consentAcceptance.acceptedAt);
    user.consentTextHash = consentAcceptance.hashOfTextShown;
    user.consentText = consentAcceptance.consentText || null;
    user.consentVersion = consentAcceptance.consentVersion || 'v1.0.0';
    
    await user.save();
    
    res.json({
      success: true,
      message: 'Consent submitted successfully',
      data: {
        consentId: user._id,
        acceptedAt: user.consentedAt
      }
    });
  } catch (error) {
    console.error('Error submitting consent:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit consent',
      error: error.message
    });
  }
});

export default router;