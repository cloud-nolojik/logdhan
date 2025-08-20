import express from 'express';
import mongoose from 'mongoose';
import { auth } from '../middleware/auth.js';
import { validateStockLog } from '../utils/validation.js';
import StockLog from '../models/stockLog.js';
import { createObjectCsvWriter } from 'csv-writer';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { aiReviewService } from '../services/ai/aiReview.service.js';
import { getExactStock } from '../utils/stock.js';
import { firebaseService } from '../services/firebase/firebase.service.js';
import { User } from '../models/user.js';
import { emailService } from '../services/email/email.service.js';

const router = express.Router();

// Helper function to extract confidence from UI chips
function extractConfidenceFromChips(chips) {
  if (!Array.isArray(chips)) return null;
  
  // Look for confidence-related chips (RR, confidence, score, etc.)
  for (const chip of chips) {
    if (chip.label && typeof chip.value === 'string') {
      // Extract numeric confidence from RR or similar metrics
      const numMatch = chip.value.match(/[\d.]+/);
      if (numMatch && chip.label.toLowerCase().includes('rr')) {
        return parseFloat(numMatch[0]) || 0;
      }
    }
  }
  
  // Default confidence based on verdict tone
  return 0.5; // neutral confidence
}

// Helper function to extract risk level from analysis data
function extractRiskLevel(analysisData) {
  if (!analysisData) return null;
  
  // Check if analysis indicates high risk
  if (analysisData.isValid === false) return "High";
  
  // Check guards for risk indicators
  if (analysisData.guards?.needsData) return "High";
  
  // Check user review validity
  if (analysisData.userReview?.isValidToday === false) return "Medium-High";
  
  // Check alignment issues
  const alignment = analysisData.userReview?.alignment;
  if (alignment?.withVWAP === 'below' && alignment?.with15mBias === 'against') {
    return "High";
  }
  
  // Default to medium risk
  return "Medium";
}

// Add stock log entry
router.post('/', auth, async (req, res) => {
  try {
    const {
      direction,
      quantity,
      entryPrice,
      targetPrice,
      stopLoss,
      reasoning,
      note,
      tags,
      needsReview,
      instrument_key,
      term,
      creditType, // Credit type for AI model selection
      // Optional model parameters for testing
      sentimentModel,
      analysisModel
    } = req.body;



    // Validate log data
    const { errors, isValid } = validateStockLog({
      direction,
      quantity,
      entryPrice,
      targetPrice,
      stopLoss,
      reasoning,
      note,
      tags,
      instrument_key,
      term,
      needsReview
    });

    if (!isValid) {
      return res.status(400).json({ errors });
    }

    // Get stock details using instrument_key
    const stock = await getExactStock(instrument_key);
    if (!stock) {
      return res.status(404).json({ error: 'Stock not found' });
    }
    const isFromRewardedAd = req.body.isFromRewardedAd || false;
    // If AI review is requested, check credits first
    if (needsReview) {
      // Check if user has enough credits in their subscription
      const { subscriptionService } = await import('../services/subscription/subscriptionService.js');
      
      const canUse = await subscriptionService.canUserUseCredits(req.user.id, 1, isFromRewardedAd);
      
      if (!canUse.canUse) {
        return res.status(402).json({
          error: `${canUse.reason || 'Please upgrade your subscription to continue using AI trade reviews.'}`
        });
      }
    }

    // Create log entry
    const logEntry = new StockLog({
      user: req.user.id,
      stock: {
        instrument_key: stock.instrument_key,
        trading_symbol: stock.trading_symbol,
        name: stock.name,
        exchange: stock.exchange
      },
      direction: direction.toUpperCase(),
      quantity,
      entryPrice,
      targetPrice,
      stopLoss,
      reasoning: reasoning || undefined,
      term,
      needsReview: needsReview || false,
      creditType: creditType || "regular", // Store credit type for AI model selection
      reviewRequestedAt: needsReview ? new Date() : undefined,
      reviewStatus: needsReview ? 'pending' : undefined
    });

    await logEntry.save();

    // If AI review is requested, trigger AI review workflow asynchronously (fire-and-forget)
    if (needsReview) {
      // Trigger AI review workflow without waiting for response
      aiReviewService.processAIReview({
        instrument_key: stock.instrument_key,
        stock: stock.name,
        needsReview: needsReview,
        entryprice: entryPrice.toString(), // Convert to string to match expected format
        stoploss: stopLoss ? stopLoss.toString() : null, // Convert to string and handle null
        target: targetPrice ? targetPrice.toString() : null, // Convert to string and handle null
        direction: direction.toLowerCase(), // Convert to lowercase to match expected format
        term: term,
        reasoning: reasoning || null, // Include user's reasoning for better AI analysis
        logId: logEntry._id.toString(), // Convert ObjectId to string
        quantity: quantity.toString(), // Convert to string to match expected format
        createdAt: logEntry.createdAt,
        // Pass optional model parameters for testing
        sentimentModel: sentimentModel || null,
        analysisModel: analysisModel || null,
        creditType: creditType || "regular", // Pass credit type for model selection
        isFromRewardedAd: isFromRewardedAd // Flag indicating ad was watched
      }, req.user.id).catch(error => { // Pass user ID for experience-based responses
        // Just log the error, don't block the response
        console.error('Error triggering AI review workflow:', error);
        console.log('Trade will be created successfully, AI review will retry or handle separately');
      });
    }

    // Return success
    res.status(201).json({
      success: true,
      data: {
        _id: logEntry._id,
        instrument_key: logEntry.stock.instrument_key,
        type: logEntry.direction,
        quantity: logEntry.quantity,
        entryPrice: logEntry.entryPrice,
        targetPrice: logEntry.targetPrice,
        stopLoss: logEntry.stopLoss,
        reasoning: logEntry.reasoning,
        note: logEntry.note,
        tags: logEntry.tags,
        needsReview: logEntry.needsReview,
        reviewStatus: logEntry.reviewStatus,
        reviewResult: logEntry.reviewResult,
        createdAt: logEntry.createdAt
      },
      message: needsReview ? 'Trade logged successfully. AI review in progress...' : 'Trade log entry created successfully'
    });
  } catch (error) {
    console.error('Error creating trade log entry:', error);
    res.status(500).json({ error: 'Error creating trade log entry' });
  }
});


router.get('/getLogs',auth,async(req,res)=>{
  try {
    const logs = await StockLog.find({ user: req.user.id }).sort({ createdAt: -1 });
    res.json({ 
      success: true,
      data: logs,
      message: "Trade logs retrieved successfully"
    });
  } catch (error) {
    console.error('Error fetching stock logs:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching stock logs',
      data: null 
    });
  }
});




// Get stock log entries for a symbol
router.get('/:instrument_key', auth, async (req, res) => {
  try {
    const stock = await getExactStock(req.params.instrument_key);
    if (!stock) {
      return res.status(404).json({ error: 'Stock not found' });
    }

    const logs = await StockLog.find({
      user: req.user.id,
      'stock.instrument_key': stock.instrument_key
    }).sort({ executedAt: -1 });

    const entries = logs.map(log => ({
      id: log._id,
      instrument_key: log.stock.instrument_key,
      trading_symbol: log.stock.trading_symbol,
      name: log.stock.name,
      exchange: log.stock.exchange,
      type: log.direction,
      quantity: log.quantity,
      entryPrice: log.entryPrice,
      targetPrice: log.targetPrice,
      stopLoss: log.stopLoss,
      reasoning: log.reasoning,
      note: log.note,
      tags: log.tags,
      executed: log.executed,
      executedAt: log.executedAt,
      createdAt: log.createdAt,
      ...(log.needsReview && {
        review: {
          status: log.reviewStatus,
          result: log.reviewResult,
          requestedAt: log.reviewRequestedAt,
          completedAt: log.reviewCompletedAt
        }
      })
    }));

    res.json({ entries });
  } catch (error) {
    console.error('Error fetching trade log entries:', error);
    res.status(500).json({ error: 'Error fetching trade log entries' });
  }
});

// Get review status for a log entry
router.get('/:id/review', auth, async (req, res) => {
  try {
    const logEntry = await StockLog.findOne({
      _id: req.params.id,
      user: req.user.id,
      needsReview: true
    });

    if (!logEntry) {
      return res.status(404).json({ error: 'Log entry not found or no review requested' });
    }

    res.status(200).json({
      success: true,
      data: {
        // Include original trade log data
        _id: logEntry._id,
        stock: logEntry.stock,
        direction: logEntry.direction,
        quantity: logEntry.quantity,
        entryPrice: logEntry.entryPrice,
        targetPrice: logEntry.targetPrice,
        stopLoss: logEntry.stopLoss,
        term: logEntry.term,
        reasoning: logEntry.reasoning,
        executed: logEntry.executed,
        needsReview: logEntry.needsReview,
        isRead: logEntry.isRead,
        createdAt: logEntry.createdAt,
        updatedAt: logEntry.updatedAt,
        executedAt: logEntry.executedAt,
        // Include review data
        reviewStatus: logEntry.reviewStatus,
        reviewResult: logEntry.reviewResult,
        reviewRequestedAt: logEntry.reviewRequestedAt,
        reviewCompletedAt: logEntry.reviewCompletedAt
      }
    });

  } catch (error) {
    console.error('Error getting review status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get review status for a log entry
router.get('/:id/review-status', auth, async (req, res) => {
  try {
    const logEntry = await StockLog.findOne({
      _id: req.params.id,
      user: req.user.id,
    });

        if (!logEntry) {
          return res.status(404).json({ error: 'Log entry not found' });
    }

    
    // Extract data from the new AI review structure
    const reviewData = logEntry?.reviewResult?.[0];
    const analysisData = reviewData?.analysis;
    const uiData = reviewData?.ui;
    
    // Check if review is completed based on reviewStatus and reviewResult presence
    const isReviewCompleted = logEntry.reviewStatus === 'completed' || 
                              (logEntry.reviewStatus === 'failed' && reviewData) ||
                              (reviewData && analysisData);

    let response = {
      id: logEntry._id,
      isReviewCompleted: isReviewCompleted,
      reviewStatus: logEntry.reviewStatus,
      
      // Extract recommendation from analysis or UI
      recommendation: analysisData?.tldr || uiData?.tldr || "No analysis available",
      
      // Extract verdict/status from UI
      verdict: uiData?.verdict || "unknown",
      
      // Map validity to analysis correctness
      isAnalysisCorrect: analysisData?.isValid === true ? "valid" : 
                        analysisData?.isValid === false ? "invalid" : "unknown",
      
      // Extract confidence from chips or set default
      confidence: extractConfidenceFromChips(uiData?.chips) || 0.0,
      
      // Extract risk level from analysis
      riskLevel: extractRiskLevel(analysisData) || "N/A",
      
      // Use review completion time
      createdAt: logEntry.reviewCompletedAt || logEntry.updatedAt,
      
      // Include detailed analysis data for testing
      detailedAnalysis: {
        ui: uiData,
        analysis: analysisData,
        charts: {
          microChart: reviewData?.microChartUrl,
          fullChart: reviewData?.fullChartUrl
        }
      },
      
      // Include comprehensive review metadata
      reviewMetadata: logEntry.reviewMetadata ? {
        totalCost: logEntry.reviewMetadata.totalCost,
        costBreakdown: logEntry.reviewMetadata.costBreakdown,
        modelsUsed: logEntry.reviewMetadata.modelsUsed,
        userExperience: logEntry.reviewMetadata.userExperience,
        tokenUsage: logEntry.reviewMetadata.tokenUsage,
        reviewProcessedAt: logEntry.reviewMetadata.reviewProcessedAt,
        modelBreakdown: logEntry.reviewMetadata.modelBreakdown
      } : null,
      
      // Legacy cost data for backward compatibility
      apiCosts: logEntry.apiCosts || null
    };
    

    res.status(200).json({
      success: true,
      data: response
    });
  } catch (error) {
    console.error('Error getting review status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Request AI review for a specific trade log
router.post('/:id/request-review', auth, async (req, res) => {
  try {
    const logEntry = await StockLog.findOne({
      _id: req.params.id,
      user: req.user.id
    });

    if (!logEntry) {
      return res.status(404).json({
        success: false,
        message: 'Trade log not found'
      });
    }

    // Check if user has sufficient credits in their subscription
    const { subscriptionService } = await import('../services/subscription/subscriptionService.js');
    const isFromRewardedAd = req.body.isFromRewardedAd || false;
    const canUse = await subscriptionService.canUserUseCredits(req.user.id, 1, isFromRewardedAd);
    
    if (!canUse.canUse) {
      return res.status(402).json({
        success: false,
        message: `${canUse.reason || 'Please upgrade your subscription.'}`
      });
    }

    // Update trade log to mark as needs review
    await StockLog.findByIdAndUpdate(req.params.id, {
      needsReview: true,
      reviewStatus: 'pending',
      reviewRequestedAt: new Date()
    });

    try {
      console.log(`\n=== AI Review Route Called ===`);
      console.log(`userId: ${req.user.id}, logId: ${req.params.id}, isFromRewardedAd: ${isFromRewardedAd}`);
      
      // Credits will be deducted after successful AI review completion
      // Pass userId and isFromRewardedAd to the AI review service
      
      // Process AI review asynchronously
      aiReviewService.processAIReview({
        logId: req.params.id,
        userId: req.user.id,
        stock: logEntry.stock,
        direction: logEntry.direction,
        quantity: logEntry.quantity,
        entryPrice: logEntry.entryPrice,
        targetPrice: logEntry.targetPrice,
        stopLoss: logEntry.stopLoss,
        term: logEntry.term,
        reasoning: logEntry.reasoning,
        createdAt: logEntry.createdAt,
        creditType: logEntry.creditType || "regular", // Pass credit type for model selection
        isFromRewardedAd: isFromRewardedAd // Flag indicating ad was watched
      });

      // Return immediate response
      res.status(200).json({
        success: true,
        message: 'AI review request submitted successfully',
        data: {
          id: req.params.id,
          status: 'pending',
          analysis: 'AI review is being processed. You will receive a notification when complete.'
        }
      });

    } catch (deductError) {
      console.error('Error deducting credits for AI review:', deductError);
      
      // Revert the needsReview flag since credit deduction failed
      await StockLog.findByIdAndUpdate(req.params.id, {
        needsReview: false,
        reviewStatus: null,
        reviewRequestedAt: null
      });
      
      return res.status(402).json({
        success: false,
        message: deductError.message || 'Failed to process payment for AI review'
      });
    }

  } catch (error) {
    console.error('Error requesting AI review:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Export trade logs as CSV (enhanced version)
router.get('/export/csv', auth, async (req, res) => {
  try {
    const { startDate, endDate, email } = req.query;
    
    // Build query filter
    const filter = { user: req.user._id };
    
    // Date filtering (using executedAt since that's what you have in schema)
    if (startDate || endDate) {
      filter.executedAt = {};
      if (startDate) {
        // Start from beginning of startDate (00:00:00)
        filter.executedAt.$gte = new Date(startDate);
      }
      if (endDate) {
        // Include entire endDate by going to end of day (23:59:59.999)
        const endOfDay = new Date(endDate);
        endOfDay.setHours(23, 59, 59, 999);
        filter.executedAt.$lte = endOfDay;
      }
    }
    
    
    // Get trade logs with filtering (sort by executedAt since that's your main date field)
    const tradeLogs = await StockLog.find(filter).sort({ executedAt: -1 });
    
    // Enhanced CSV headers
    const csvHeader = [
      'Instrument Key',
      'Stock Symbol',
      'Stock Name',
      'Exchange',
      'Direction', 
      'Quantity',
      'Entry Price',
      'Target Price',
      'Stop Loss',
      'Term',
      'User Reasoning',
      'Tags',
      'Notes',
      'Executed',
      'Executed At',
      'Needs Review',
      'Review Status',
      'Review Result',
      'Review Requested At',
      'Review Completed At',
      'Created At',
      'Updated At'
    ];
    
    const csvRows = tradeLogs.map(log => {
      // Format reviewResult properly for CSV
      let reviewResultText = '';
      if (log?.reviewResult) {
        try {
          if (Array.isArray(log.reviewResult) && log.reviewResult.length > 0) {
            const firstReview = log.reviewResult[0];
            reviewResultText = `Status: ${firstReview.status || 'N/A'} | Correct: ${firstReview.isAnalaysisCorrect || 'N/A'} | Result: ${firstReview.result || 'N/A'}`;
          } else if (typeof log.reviewResult === 'object') {
            reviewResultText = JSON.stringify(log.reviewResult);
          } else {
            reviewResultText = log.reviewResult.toString();
          }
        } catch (e) {
          reviewResultText = 'Error parsing review result';
        }
      }
      
      return [
        log.stock?.instrument_key || '',
        log.stock?.trading_symbol || '',
        log.stock?.name || '',
        log.stock?.exchange || '',
        log.direction || '',
        log.quantity || '',
        log.entryPrice || '',
        log.targetPrice || '',
        log.stopLoss || '',
        log.term || '',
        `"${(log.reasoning || '').replace(/"/g, '""')}"`, // Escape quotes properly for reasoning
        log.tags?.join('; ') || '', // This field might not exist in schema
        log.note || '', // This field might not exist in schema
        log.executed ? 'Yes' : 'No',
        log.executedAt ? log.executedAt.toISOString() : '',
        log.needsReview ? 'Yes' : 'No',
        log.reviewStatus || '',
        `"${reviewResultText.replace(/"/g, '""')}"`, // Escape quotes properly
        log.reviewRequestedAt ? log.reviewRequestedAt.toISOString() : '',
        log.reviewCompletedAt ? log.reviewCompletedAt.toISOString() : '',
        log.createdAt ? log.createdAt.toISOString() : '',
        log.updatedAt ? log.updatedAt.toISOString() : ''
      ];
    });
    
    // Build CSV content
    const csvContent = [
      csvHeader.join(','),
      ...csvRows.map(row => row.join(','))
    ].join('\n');
    

 
      // Get user details for email
      const user = await User.findById(req.user._id);
      
      // Use provided exportEmail or fall back to user's profile email
      const emailToUse = email || user.email;
      
      if (!emailToUse) {
        return res.status(400).json({
          success: false,
          error: 'Email address is required for export. Please provide an email address.'
        });
      }
      
      // Validate email format
      const emailRegex = /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/;
      if (!emailRegex.test(emailToUse)) {
        return res.status(400).json({
          success: false,
          error: 'Please enter a valid email address'
        });
      }
      
      // Prepare export parameters for email
      const exportParams = {
        startDate: startDate,
        endDate: endDate,
        totalTrades: tradeLogs.length
      };
      
      // Generate filename
      const filename = `trade_logs_${new Date().toISOString().split('T')[0]}.csv`;
      
      // Send email with CSV attachment
      const emailResult = await emailService.sendCSVExport(
        emailToUse,
        user.firstName || 'Trader',
        csvContent,
        filename,
        exportParams
      );
      
      if (emailResult.success) {
        return res.status(200).json({
          success: true,
          message: `Export sent successfully to ${emailToUse}`,
          data: {
            totalTrades: tradeLogs.length,
            filename: filename,
            emailSent: true,
            emailAddress: emailToUse,
            isProfileEmail: emailToUse === user.email
          }
        });
      } else {
        return res.status(500).json({
          success: false,
          error: 'Failed to send email. Please try again or download directly.',
          details: emailResult.error
        });
      }
    
  
    
  } catch (error) {
    console.error('Error exporting trade logs:', error);
    res.status(500).json({ error: 'Failed to export trade logs' });
  }
});

// Get user email status for export
router.get('/user/email-status', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('email firstName');
    
    res.status(200).json({
      success: true,
      data: {
        hasEmail: !!user.email,
        email: user.email || null,
        firstName: user.firstName || null
      }
    });
  } catch (error) {
    console.error('Error getting user email status:', error);
    res.status(500).json({ error: 'Failed to get user email status' });
  }
});

// Update user email for exports
router.post('/user/update-email', auth, async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required'
      });
    }
    
    // Validate email format
    const emailRegex = /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        error: 'Please enter a valid email address'
      });
    }
    
    // Update user email
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { email: email.toLowerCase().trim() },
      { new: true, runValidators: true }
    ).select('email firstName');
    
    // Send welcome email
    const emailResult = await emailService.sendWelcomeEmail(
      user.email,
      user.firstName || 'Trader'
    );
    
    res.status(200).json({
      success: true,
      message: 'Email updated successfully',
      data: {
        email: user.email,
        firstName: user.firstName,
        welcomeEmailSent: emailResult.success
      }
    });
    
  } catch (error) {
    console.error('Error updating user email:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to update email address' 
    });
  }
});

// Get token usage statistics for the current user
router.get('/token-usage/stats', auth, async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.userId);
    
    // Aggregate token usage data for the user
    const tokenStats = await StockLog.aggregate([
      {
        $match: {
          user: userId,
          tokenUsage: { $exists: true },
          'tokenUsage.totalTokens': { $gt: 0 }
        }
      },
      {
        $group: {
          _id: null,
          totalInputTokens: { $sum: '$tokenUsage.inputTokens' },
          totalOutputTokens: { $sum: '$tokenUsage.outputTokens' },
          totalCacheCreationTokens: { $sum: '$tokenUsage.cacheCreationInputTokens' },
          totalCacheReadTokens: { $sum: '$tokenUsage.cacheReadInputTokens' },
          totalTokens: { $sum: '$tokenUsage.totalTokens' },
          totalCost: { $sum: '$tokenUsage.estimatedCost' },
          reviewCount: { $sum: 1 },
          models: { $addToSet: '$tokenUsage.model' }
        }
      }
    ]);
    
    // Get monthly breakdown
    const monthlyStats = await StockLog.aggregate([
      {
        $match: {
          user: userId,
          tokenUsage: { $exists: true },
          'tokenUsage.totalTokens': { $gt: 0 }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' }
          },
          totalTokens: { $sum: '$tokenUsage.totalTokens' },
          totalCost: { $sum: '$tokenUsage.estimatedCost' },
          reviewCount: { $sum: 1 }
        }
      },
      {
        $sort: { '_id.year': -1, '_id.month': -1 }
      },
      {
        $limit: 12 // Last 12 months
      }
    ]);
    
    // Get recent reviews with token usage
    const recentReviews = await StockLog.find({
      user: userId,
      tokenUsage: { $exists: true },
      'tokenUsage.totalTokens': { $gt: 0 }
    })
    .select('stock.trading_symbol tokenUsage.totalTokens tokenUsage.estimatedCost tokenUsage.model tokenUsage.timestamp createdAt')
    .sort({ createdAt: -1 })
    .limit(10);
    
    res.status(200).json({
      success: true,
      data: {
        summary: tokenStats[0] || {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          totalTokens: 0,
          totalCost: 0,
          reviewCount: 0,
          models: []
        },
        monthlyBreakdown: monthlyStats,
        recentReviews: recentReviews.map(review => ({
          stock: review.stock?.trading_symbol,
          tokens: review.tokenUsage?.totalTokens,
          cost: review.tokenUsage?.estimatedCost,
          model: review.tokenUsage?.model,
          date: review.tokenUsage?.timestamp || review.createdAt
        }))
      }
    });
  } catch (error) {
    console.error('Error fetching token usage stats:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch token usage statistics' 
    });
  }
});

export default router; 