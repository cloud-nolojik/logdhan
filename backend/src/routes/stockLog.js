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
import { TRADING_TERMS, getTermsForSelection } from '../config/tradingTerms.js';

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
        // Determine if we should suggest watching an ad
        const suggestAd = !isFromRewardedAd && (canUse.reason?.includes('exhausted') || canUse.reason?.includes('limit'));
        
        return res.status(402).json({
          error: `${canUse.reason || 'Please upgrade your subscription to continue using AI trade reviews.'}`,
          suggestAd: suggestAd,
          errorCode: 'CREDITS_EXHAUSTED'
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
      // Only set review-related fields if review is actually requested
      ...(needsReview && {
        isFromRewardedAd: isFromRewardedAd || false,
        creditType: isFromRewardedAd ? "bonus" : (creditType || "regular"),
        reviewRequestedAt: new Date(),
        reviewStatus: 'pending'
      })
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

// Get complete trade log entry (with or without review)
router.get('/:id/trade-log', auth, async (req, res) => {
  try {
    const logEntry = await StockLog.findOne({
      _id: req.params.id,
      user: req.user.id,
    });

    if (!logEntry) {
      return res.status(404).json({ error: 'Trade log not found' });
    }

    // Return the complete document as is
    res.status(200).json({
      success: true,
      data: logEntry.toObject() // Convert mongoose document to plain object with all fields
    });

  } catch (error) {
    console.error('Error getting trade log:', error);
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
                              logEntry.reviewStatus === 'rejected' ||
                              (logEntry.reviewStatus === 'failed' && reviewData) ||
                              (reviewData && analysisData);

    // Extract rejection reason from flat structure (now consistent across success/rejected)
    const rejectionReason = analysisData?.rejectionReason || null;

    let response = {
      id: logEntry._id,
      isReviewCompleted: isReviewCompleted,
      reviewStatus: logEntry.reviewStatus,
      status: logEntry.reviewStatus, // Add status field for frontend compatibility
      rejectionReason: rejectionReason, // Add rejection reason field
      
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
      // Determine if we should suggest watching an ad
      const suggestAd = !isFromRewardedAd && (canUse.reason?.includes('exhausted') || canUse.reason?.includes('limit'));
      
      return res.status(402).json({
        success: false,
        message: `${canUse.reason || 'Please upgrade your subscription.'}`,
        suggestAd: suggestAd,
        errorCode: 'CREDITS_EXHAUSTED'
      });
    }

    // Update trade log to mark as needs review
    await StockLog.findByIdAndUpdate(req.params.id, {
      needsReview: true,
      reviewStatus: 'pending',
      reviewRequestedAt: new Date(),
      isFromRewardedAd: isFromRewardedAd || false,
      creditType: isFromRewardedAd ? "bonus" : "regular"
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
        instrument_key: logEntry.stock?.instrument_key, // Extract instrument_key for API calls
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
          tradeLogId: req.params.id,
          reviewStatus: 'pending',
          message: 'AI review is being processed. You will receive a notification when complete.',
          analysis: 'AI review is being processed. You will receive a notification when complete.' // Keep for backward compatibility
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

// Retry AI review for a specific trade log
router.post('/:id/retry-review', auth, async (req, res) => {
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
    // For retry, use the saved isFromRewardedAd flag from the original trade log
    // This ensures we use the same model type (bonus/regular) as the original request
    const isFromRewardedAd = logEntry.isFromRewardedAd || req.body.isFromRewardedAd || false;
    const canUse = await subscriptionService.canUserUseCredits(req.user.id, 1, isFromRewardedAd);
    
    if (!canUse.canUse) {
      // Determine if we should suggest watching an ad
      const suggestAd = !isFromRewardedAd && (canUse.reason?.includes('exhausted') || canUse.reason?.includes('limit'));
      
      return res.status(402).json({
        success: false,
        message: `${canUse.reason || 'Please upgrade your subscription.'}`,
        suggestAd: suggestAd,
        errorCode: 'CREDITS_EXHAUSTED'
      });
    }

    // Reset review status to pending and clear previous results
    await StockLog.findByIdAndUpdate(req.params.id, {
      needsReview: true,
      reviewStatus: 'pending',
      reviewRequestedAt: new Date(),
      reviewResult: null,
      reviewCompletedAt: null,
      reviewError: null
    });

    try {
      console.log(`\n=== AI Review Retry Route Called ===`);
      console.log(`userId: ${req.user.id}, logId: ${req.params.id}, isFromRewardedAd: ${isFromRewardedAd}`);
      
      // Process AI review asynchronously
      aiReviewService.processAIReview({
        instrument_key: logEntry.stock.instrument_key,
        stock: logEntry.stock.name,
        needsReview: true,
        entryprice: logEntry.entryPrice.toString(),
        stoploss: logEntry.stopLoss ? logEntry.stopLoss.toString() : null,
        target: logEntry.targetPrice ? logEntry.targetPrice.toString() : null,
        direction: logEntry.direction.toLowerCase(),
        term: logEntry.term,
        reasoning: logEntry.reasoning || null,
        logId: req.params.id,
        quantity: logEntry.quantity.toString(),
        createdAt: logEntry.createdAt,
        creditType: isFromRewardedAd ? "bonus" : (logEntry.creditType || "regular"),
        isFromRewardedAd: isFromRewardedAd
      }, req.user.id);

      // Return immediate response
      res.status(200).json({
        success: true,
        message: 'AI review retry submitted successfully',
        data: {
          tradeLogId: req.params.id,
          reviewStatus: 'pending',
          message: 'AI review is being reprocessed. You will receive a notification when complete.'
        }
      });

    } catch (processError) {
      console.error('Error processing AI review retry:', processError);
      
      // Revert the status changes since processing failed
      await StockLog.findByIdAndUpdate(req.params.id, {
        reviewStatus: 'error',
        reviewError: {
          message: processError.message || 'Failed to process retry',
          code: 'RETRY_PROCESSING_ERROR',
          type: 'processing_error'
        }
      });
      
      return res.status(500).json({
        success: false,
        message: 'Failed to process AI review retry'
      });
    }

  } catch (error) {
    console.error('Error retrying AI review:', error);
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
    
    // Enhanced CSV headers - shorter names for better Excel display
    const csvHeader = [
      'Instrument Key',
      'Symbol',
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
      'Executed Date',
      'AI Review Requested',
      'Review Status',
      'AI Verdict',
      'AI Analysis Valid',
      'AI Recommendation',
      'Rejection Reason',
      'Review Requested Date',
      'Review Completed Date',
      'Created Date',
      'Updated Date'
    ];
    
    const csvRows = tradeLogs.map(log => {
      // Extract AI review data properly
      let aiVerdict = '';
      let aiAnalysisCorrect = '';
      let aiInsight = '';
      let rejectionReason = '';
      
      if (log?.reviewResult && Array.isArray(log.reviewResult) && log.reviewResult.length > 0) {
        try {
          const firstReview = log.reviewResult[0];
          
          // Extract verdict from UI section
          aiVerdict = firstReview.ui?.verdict || firstReview.status || '';
          
          // Extract analysis correctness
          if (firstReview.isAnalaysisCorrect !== undefined) {
            aiAnalysisCorrect = firstReview.isAnalaysisCorrect ? 'Yes' : 'No';
          } else if (firstReview.analysis?.isValid !== undefined) {
            aiAnalysisCorrect = firstReview.analysis.isValid === true ? 'Yes' : 
                               firstReview.analysis.isValid === false ? 'No' : 'N/A';
          } else {
            aiAnalysisCorrect = 'N/A';
          }
          
          // Extract insight/recommendation (prioritize tldr, then insight)
          aiInsight = firstReview.ui?.tldr || firstReview.analysis?.insight || '';
          
          // Extract rejection reason
          rejectionReason = firstReview.analysis?.rejectionReason || '';
          
        } catch (e) {
          console.error('Error parsing review result:', e);
          aiVerdict = 'Error parsing';
          aiAnalysisCorrect = 'N/A';
          aiInsight = 'Error parsing review data';
          rejectionReason = '';
        }
      }
      
      // Helper function to format date for user-friendly display
      const formatDate = (dateString) => {
        if (!dateString) return '';
        try {
          const date = new Date(dateString);
          // Format as DD/MM/YYYY HH:MM AM/PM IST
          const options = {
            day: '2-digit',
            month: '2-digit', 
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
            timeZone: 'Asia/Kolkata'
          };
          return date.toLocaleString('en-IN', options) + ' IST';
        } catch (e) {
          return dateString; // Return original if parsing fails
        }
      };
      
      return [
        log.stock?.instrument_key || '',
        log.stock?.trading_symbol || '',
        `"${(log.stock?.name || '').replace(/"/g, '""')}"`, // Escape stock name
        log.stock?.exchange || '',
        log.direction || '',
        log.quantity || '',
        log.entryPrice || '',
        log.targetPrice || '',
        log.stopLoss || '',
        log.term || '',
        `"${(log.reasoning || '').replace(/"/g, '""')}"`, // Escape quotes properly for reasoning
        `"${(log.tags?.join('; ') || '').replace(/"/g, '""')}"`, // Escape tags properly
        `"${(log.note || '').replace(/"/g, '""')}"`, // Escape notes properly
        log.executed ? 'Yes' : 'No',
        `"${formatDate(log.executedAt)}"`, // Escape date-time string
        log.needsReview ? 'Yes' : 'No',
        `"${(log.reviewStatus || '').replace(/"/g, '""')}"`, // Escape review status
        `"${aiVerdict.replace(/"/g, '""')}"`, // Escape AI verdict
        aiAnalysisCorrect,
        `"${aiInsight.replace(/"/g, '""')}"`, // Escape quotes properly for AI insight
        `"${rejectionReason.replace(/"/g, '""')}"`, // Escape quotes properly for rejection reason
        `"${formatDate(log.reviewRequestedAt)}"`, // Escape date-time string
        `"${formatDate(log.reviewCompletedAt)}"`, // Escape date-time string
        `"${formatDate(log.createdAt)}"`, // Escape date-time string
        `"${formatDate(log.updatedAt)}"` // Escape date-time string
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

// Get trading terms configuration
router.get('/terms', (req, res) => {
  try {
    res.json({
      success: true,
      data: getTermsForSelection()
    });
  } catch (error) {
    console.error('Error fetching trading terms:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch trading terms'
    });
  }
});

export default router; 