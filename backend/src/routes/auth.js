import express from 'express';
import { auth } from '../middleware/auth.js';
import { validateUser, validateOTP } from '../utils/validation.js';
import { User } from '../models/user.js';
import jwt from 'jsonwebtoken';
import { messagingService } from '../services/messaging/messaging.service.js';
import TokenBlacklist from '../models/tokenBlacklist.js';

const router = express.Router();

// POST /auth/send-otp - Send OTP to mobile number
router.post('/send-otp', async (req, res) => {
  try {
    let { mobileNumber } = req.body;

    // 1️⃣  Remove leading “+” (if present)
  if (mobileNumber.startsWith('+')) {
    mobileNumber = mobileNumber.slice(1);
  }

    if (!mobileNumber || !/^\d{12}$/.test(mobileNumber)) {
      return res.status(400).json({ error: 'Invalid mobile number. Must be 12 digits.' });
    }

    // Generate a random 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Send OTP via messaging service (Infobip WhatsApp)
    try {
      await messagingService.sendOTP(mobileNumber, otp);
      console.log(`✅ OTP sent successfully to ${mobileNumber}`);
    } catch (msgError) {
      console.error('❌ Failed to send OTP via messaging service:', msgError.message);
      // Continue without failing the API - user will see OTP in development
    }

    // Save or update user with OTP
    const user = await User.findOneAndUpdate(
      { mobileNumber },
      { 
        $set: {
          mobileNumber,
          otp,
          otpExpiry: new Date(Date.now() + 10 * 60 * 1000) // 10 minutes
        }
      },
      { 
        upsert: true, 
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true
      }
    );

    if (!user) {
      throw new Error('Failed to update user');
    }

    res.json({ 
      success: true,
      message: 'OTP sent successfully'
    });
  } catch (error) {
    console.error('Error sending OTP:', error);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// POST /auth/verify-otp - Verify OTP and return JWT token
router.post('/verify-otp', async (req, res) => {
  try {
    let { mobileNumber, otp, fcmToken } = req.body;

    if (mobileNumber.startsWith('+')) {
      mobileNumber = mobileNumber.slice(1);
    }

    if (!mobileNumber || !/^\d{12}$/.test(mobileNumber)) {
      return res.status(400).json({ error: 'Invalid mobile number. Must be 12 digits.' });
    }

    if (!otp || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({ error: 'Invalid OTP. Must be 6 digits.' });
    }

    const user = await User.findOne({ mobileNumber })
      .select('+otp +otpExpiry');  // Explicitly include otp and otpExpiry fields
      
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.otp || user.otp !== otp) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    if (!user.otpExpiry || user.otpExpiry < new Date()) {
      return res.status(400).json({ error: 'OTP expired' });
    }

    // Clear OTP after successful verification
    user.otp = undefined;
    user.otpExpiry = undefined;

    // Add FCM token if provided
    if (fcmToken && !user.fcmTokens.includes(fcmToken)) {
      user.fcmTokens.push(fcmToken);
    }

    // Check if user needs subscription setup (both new and migrated users)
    const { subscriptionService } = await import('../services/subscription/subscriptionService.js');
    const { Subscription } = await import('../models/subscription.js');
    
    const existingSubscription = await Subscription.findOne({ userId: user._id });
    
    if (!existingSubscription) {
      try {
        console.log(`🆕 Creating basic ads subscription for new user ${mobileNumber}`);
        
        // Create basic ads subscription for new users (lifetime free with ads)
        await subscriptionService.createSubscription(
          user._id,
          'basic_ads',
          {
            source: 'new_user_login'
          }
        );
        
        console.log(`✅ Created basic ads subscription for new user ${mobileNumber}`);
        
      } catch (subscriptionError) {
        console.error(`Subscription creation failed for ${mobileNumber}:`, subscriptionError);
      }
    }

    await user.save();

    // Generate JWT token
    const token = user.generateAuthToken();
    console.log('token', token);

    res.json({
      success: true,
      token,
      user: {
        _id: user._id?.toString() || user.id?.toString(),
        firstName: user.firstName || null,
        lastName: user.lastName || null,
        mobileNumber: user.mobileNumber,
        isOnboarded: user.isOnboarded,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      }
    });
  } catch (error) {
    console.error('Error verifying OTP:', error);
    res.status(500).json({ error: 'Failed to verify OTP' });
  }
});

// GET /auth/profile - Get user profile with comprehensive trading experience data
router.get('/profile', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-otp -otpExpiry');
    
    // Get actual credits from subscription table
    const { Subscription } = await import('../models/subscription.js');
    const subscription = await Subscription.findActiveForUser(req.user.id);
    const bonusCredits = subscription?.credits?.bonusCredits || 0;
    
    // Prepare comprehensive profile data
    const profileData = {
      _id: user._id?.toString() || user.id?.toString(),
      firstName: user.firstName || null,
      lastName: user.lastName || null,
      email: user.email || null,
      mobileNumber: user.mobileNumber,
      isOnboarded: user.isOnboarded,
      experienceAssessmentComplete: user.assessmentHistory?.quickQuiz?.completed || false,
      deepDiagnosticComplete: user.assessmentHistory?.deepDiagnostic?.completed || false,
      chatOnboardingComplete: user.isOnboarded || false, // Assuming onboarded means chat complete
      tradingExperienceLevel: user.experience?.level || 'intermediate',
      badge: user.assessmentHistory?.deepDiagnostic?.badge || null,
      bonusCredits: bonusCredits,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };
    
    res.json({ 
      data: profileData, 
      success: true, 
      message: "Profile fetched successfully" 
    });
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// PUT /auth/profile - Update user profile
router.put('/profile', auth, async (req, res) => {
  try {
    const { firstName, lastName,email } = req.body;
    const { errors, isValid } = validateUser({ firstName, lastName,email });

    if (!isValid) {
      return res.status(400).json(errors);
    }

    

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { firstName, lastName,email },
      { new: true }
    ).select('-otp -otpExpiry');

    res.json({ data: user, success: true, message: "Profile updated successfully" });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Login user
router.post('/login', async (req, res) => {
  try {
    const { email, password, fcmToken } = req.body;

    // Find user by email
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Check password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Add FCM token if provided and not already registered
    if (fcmToken) {
      if (!user.fcmTokens.includes(fcmToken)) {
        user.fcmTokens.push(fcmToken);
        await user.save();
      }
    }

    // Generate JWT token
    const token = jwt.sign(
      { id: user._id },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        isVerified: user.isVerified
      }
    });
  } catch (error) {
    console.error('Error in login:', error);
    res.status(500).json({ error: 'Error logging in' });
  }
});

// Remove FCM token (for logout)
router.post('/logout', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const token = req.token;
    
    // Clear FCM tokens
    user.fcmTokens = [];
    await user.save();
    
    // Blacklist the JWT token
    
    const decoded = jwt.decode(token);
    const expiresAt = new Date(decoded.exp * 1000);
    
    await TokenBlacklist.blacklistToken(token, req.user.id, expiresAt);

    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Error in logout:', error);
    res.status(500).json({ error: 'Error logging out' });
  }
});

// POST /auth/complete-assessment - Complete experience assessment and award credits
router.post('/complete-assessment', auth, async (req, res) => {
  try {
    const { experienceLevel, assessmentScore, confidence, skipPenalty } = req.body;
    
    // Validate input
    if (!experienceLevel || !['beginner', 'intermediate', 'advanced'].includes(experienceLevel)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid experience level. Must be beginner, intermediate, or advanced.' 
      });
    }
    
    if (typeof assessmentScore !== 'number' || assessmentScore < 0 || assessmentScore > 6) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid assessment score. Must be between 0 and 6.' 
      });
    }
    
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid confidence. Must be between 0 and 1.' 
      });
    }

    // Get user
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }

    // Check if assessment already completed (allow retakes but no additional credits)
    const isRetake = user.assessmentHistory?.quickQuiz?.completed;
    const shouldAwardCredits = !isRetake;

    // Credit service no longer needed - using subscription system

    // Update user's experience and assessment data
    user.experience = {
      level: experienceLevel,
      score: assessmentScore,
      confidence: confidence,
      lastUpdated: new Date(),
      assessmentMethod: 'quick_quiz'
    };

    // Update assessment history - ensure we don't spread undefined values
    if (!user.assessmentHistory) {
      user.assessmentHistory = {};
    }
    
    // Only update quickQuiz, leave deepDiagnostic untouched
    user.assessmentHistory.quickQuiz = {
      completed: true,
      score: assessmentScore,
      completedAt: new Date(),
      answers: [] // Could be populated if we track individual answers
    };

    // Mark onboarding as completed
    user.isOnboarded = true;
    user.onboardingCompleted = true;

    // Award bonus credits for assessment completion (only for first time)
    if (shouldAwardCredits) {
      try {
        const { Subscription } = await import('../models/subscription.js');
        
        // Find user's active subscription and add bonus credits (7-day expiry, advanced analysis)
        const subscription = await Subscription.findActiveForUser(user._id);
        if (subscription) {
          const bonusAmount = 5; // 5 bonus credits for quick quiz
          const expiryDate = new Date();
          expiryDate.setDate(expiryDate.getDate() + 7); // 7 days from now
          
          subscription.credits.bonusCredits += bonusAmount;
          subscription.credits.bonusCreditsExpiry = expiryDate;
          await subscription.save();
          console.log(`Added ${bonusAmount} bonus credits (7-day expiry) to user ${user._id} for completing assessment`);
        } else {
          console.log(`No active subscription found for user ${user._id} - credits not awarded`);
        }
      } catch (creditError) {
        console.error('Error awarding assessment bonus credits:', creditError);
        // Continue without failing the assessment completion
      }
    } else {
      console.log(`User ${user._id} retook assessment - no additional credits awarded`);
    }

    // Save user data
    await user.save();

    // Return updated user profile
    const updatedUser = await User.findById(req.user.id).select('-otp -otpExpiry');
    
    res.json({
      success: true,
      message: shouldAwardCredits 
        ? 'Assessment completed successfully! Trial subscription activated.'
        : 'Assessment updated successfully! (Subscription already active)',
      data: {
        _id: updatedUser._id?.toString() || updatedUser.id?.toString(),
        firstName: updatedUser.firstName || null,
        lastName: updatedUser.lastName || null,
        email: updatedUser.email || null,
        mobileNumber: updatedUser.mobileNumber,
        isOnboarded: updatedUser.isOnboarded,
        experienceAssessmentComplete: updatedUser.assessmentHistory?.quickQuiz?.completed || false,
        chatOnboardingComplete: true, // Set to true after assessment
        tradingExperienceLevel: updatedUser.experience?.level || null,
        createdAt: updatedUser.createdAt,
        updatedAt: updatedUser.updatedAt,
        isRetake: isRetake
      }
    });

  } catch (error) {
    console.error('Error completing assessment:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to complete assessment' 
    });
  }
});

// POST /auth/complete-deep-diagnostic - Complete deep diagnostic assessment and award additional credits
router.post('/complete-deep-diagnostic', auth, async (req, res) => {
  try {
    const { level, totalScore, confidence, badge } = req.body;
    
    // Validate input
    if (!level || !['beginner', 'intermediate', 'advanced'].includes(level)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid experience level. Must be beginner, intermediate, or advanced.' 
      });
    }
    
    if (typeof totalScore !== 'number' || totalScore < 0 || totalScore > 12) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid total score. Must be between 0 and 12.' 
      });
    }
    
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid confidence. Must be between 0 and 1.' 
      });
    }

    // Get user
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }

    // Check if deep diagnostic already completed (allow retakes but no additional credits)
    const isRetake = user.assessmentHistory?.deepDiagnostic?.completed;
    const shouldAwardCredits = !isRetake;

    // Credit service no longer needed - using subscription system

    // Update user's experience with deep diagnostic results
    user.experience = {
      ...user.experience,
      level: level,
      score: totalScore,
      confidence: confidence,
      lastUpdated: new Date(),
      assessmentMethod: 'deep_diagnostic'
    };

    // Update deep diagnostic assessment history - ensure we don't spread undefined values
    if (!user.assessmentHistory) {
      user.assessmentHistory = {};
    }
    
    // Only update deepDiagnostic, leave quickQuiz untouched
    user.assessmentHistory.deepDiagnostic = {
      completed: true,
      score: totalScore,
      completedAt: new Date(),
      answers: [], // Could be populated if we track individual answers
      badge: badge || null
    };

    // Award bonus credits for deep diagnostic completion (only for first time)
    if (shouldAwardCredits) {
      try {
        const { Subscription } = await import('../models/subscription.js');
        
        // Find user's active subscription and add bonus credits (7-day expiry, advanced analysis)
        const subscription = await Subscription.findActiveForUser(user._id);
        if (subscription) {
          const bonusAmount = 10; // 10 bonus credits for deep diagnostic
          const expiryDate = new Date();
          expiryDate.setDate(expiryDate.getDate() + 7); // 7 days from now
          
          subscription.credits.bonusCredits += bonusAmount;
          subscription.credits.bonusCreditsExpiry = expiryDate;
          await subscription.save();
          console.log(`Added ${bonusAmount} bonus credits (7-day expiry) to user ${user._id} for completing deep diagnostic`);
        } else {
          console.log(`No active subscription found for user ${user._id} - credits not awarded`);
        }
      } catch (creditError) {
        console.error('Error awarding deep diagnostic bonus credits:', creditError);
        // Continue without failing the completion
      }
    } else {
      console.log(`User ${user._id} retook deep diagnostic - no additional credits awarded`);
    }

    // Save user data
    await user.save();

    // Return updated user profile
    const updatedUser = await User.findById(req.user.id).select('-otp -otpExpiry');
    
    res.json({
      success: true,
      message: shouldAwardCredits 
        ? 'Deep diagnostic completed successfully! Enhanced insights unlocked.'
        : 'Deep diagnostic updated successfully! (No changes for retake)',
      data: {
        _id: updatedUser._id?.toString() || updatedUser.id?.toString(),
        firstName: updatedUser.firstName || null,
        lastName: updatedUser.lastName || null,
        email: updatedUser.email || null,
        mobileNumber: updatedUser.mobileNumber,
        isOnboarded: updatedUser.isOnboarded,
        experienceAssessmentComplete: updatedUser.assessmentHistory?.quickQuiz?.completed || false,
        deepDiagnosticComplete: updatedUser.assessmentHistory?.deepDiagnostic?.completed || false,
        chatOnboardingComplete: true,
        tradingExperienceLevel: updatedUser.experience?.level || null,
        badge: updatedUser.assessmentHistory?.deepDiagnostic?.badge || null,
        createdAt: updatedUser.createdAt,
        updatedAt: updatedUser.updatedAt,
        isRetake: isRetake
      }
    });

  } catch (error) {
    console.error('Error completing deep diagnostic:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to complete deep diagnostic' 
    });
  }
});

export default router; 