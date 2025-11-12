import axios from 'axios';
import Parser from 'rss-parser';
// Removed QuickChart import due to ES module compatibility issues
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import PQueue from 'p-queue';
import { User } from '../../models/user.js';
import StockLog from '../../models/stockLog.js';
import { firebaseService } from '../firebase/firebase.service.js';
import { createAndUploadShortTermCharts } from '../chart/shortChart.service.js';
import { createAndUploadIntradayCharts } from '../chart/intradayChart.service.js';
import { createAndUploadMediumTermCharts } from '../chart/mediumChart.service.js';
import { aiCostTracker } from './aiCostTracker.js';
import { subscriptionService } from '../subscription/subscriptionService.js';
  import { Plan }  from '../../models/plan.js';
import { Subscription } from '../../models/subscription.js';
import candleFetcherService from '../candleFetcher.service.js';
import modelSelectorService from './modelSelector.service.js';



class AIReviewService {
  constructor() {
    this.upstoxApiKey = process.env.UPSTOX_API_KEY;
    this.openaiApiKey = process.env.OPENAI_API_KEY;
    
    this.advancedanalysisModel = "gpt-5";
    this.basicanalysisModel = "o4-mini";

    
    // Initialize analysis model to basic by default
    this.analysisModel = this.basicanalysisModel;
    this.sentimentalModel = "gpt-4o-mini"; // Default to mini for cost efficiency
    
    // Model selection logic:
    // - Bonus credits (advanced analysis): use o4-mini
    // - Basic plan with regular credits: use gpt-4o-mini  
    // - Rewarded ad reviews: use gpt-4o-mini (sustainable)
    // - Paid plans: use o4-mini
    // - Sentiment analysis: always use gpt-4o-mini for cost efficiency 
    
    this.rssParser = new Parser();
    
    // Chart generation queue to prevent CPU spikes
    this.chartQueue = new PQueue({ concurrency: 2 });
    
    // Reset cost tracker for each new instance
    aiCostTracker.resetSession();
    
    // Dynamic confidence weights based on trade term with rationale
    this.CONFIDENCE_WEIGHTS = {
      intraday: { 
        rr: 0.3,        // 30%: R:R important but not dominant for quick scalps
        sentiment: 0.2, // 20%: Less relevant for minute-by-minute moves
        price: 0.5      // 50%: Entry timing critical for tight stops
      },
      short: { 
        rr: 0.4,         // 40%: R:R more important for multi-day holds
        sentiment: 0.35, // 35%: News/sentiment drives 1-3 day swings
        price: 0.25      // 25%: Some flexibility on entry for wider stops
      },
      medium: { 
        rr: 0.4,        // 40%: R:R critical for multi-week positions
        sentiment: 0.2, // 20%: Fundamentals matter more than daily news
        price: 0.4      // 40%: Technical levels still important
      },
      long: { 
        rr: 0.25,        // 25%: Long-term value matters more than precise R:R
        sentiment: 0.35, // 35%: Company fundamentals and sector trends key
        price: 0.4       // 40%: Major support/resistance levels critical
      }
    };
    
    // Term-specific trading rules
    this.TERM_RULES = {
      intraday: {
        objective: 'Catch 1-3% pops on momentum, be flat by EOD',
        timeframes: ['3m', '15m'],
        rrMin: 1.2,
        riskPct: 0.005, // 0.5% account risk
        tradeWindow: { start: '09:15', end: '15:20', timezone: 'IST' },
        targetPct: 1.0, // 1% target
        stopPct: 0.4,   // 0.4% stop
        indicators: ['vwap', 'ema9', 'ema20', 'volumeSpike']
      },
      short: {
        objective: 'Ride earnings drift/news flow for 3-7% moves',
        timeframes: ['15m', '1h'],
        rrMin: 1.5,
        riskPct: 0.01, // 1% account risk
        targetPct: 5.0, // 3-7% target range
        indicators: ['ema20', 'rsi14', 'gapAnalysis']
      },
      medium: {
        objective: 'Capture 5-15% trend legs aligned with sector rotation',
        timeframes: ['1h', '4h', '1d'],
        rrMin: 2.0,
        riskPct: 0.015, // 1.5% account risk
        targetPct: 10.0, // 5-15% target range
        indicators: ['sma50', 'sma200', 'macd', 'sentimentTrend']
      },
      long: {
        objective: 'Hold for 10-25%+ appreciation driven by fundamentals',
        timeframes: ['1d', '1W'],
        rrMin: 2.0,
        riskPct: 0.02, // 2% account risk
        targetPct: 20.0, // 10-25%+ target
        trailingStop: 8.0, // 8% trailing stop
        indicators: ['sma200', 'weeklyStructure', 'fundamentals']
      }
    };
  }

  /**
   * Get user's trading experience level
   * @param {String} userId - User ID
   */
  async getUserExperience(userId) {
    try {
      // Convert ObjectId to string if needed
      const userIdString = userId?.toString();
      
      // Handle test/mock user IDs
      if (userIdString?.startsWith('mock_')) {
        const experience = userIdString.split('_')[1]; // Extract experience from mock_beginner_user
        return ['beginner', 'intermediate', 'advanced'].includes(experience) ? experience : 'intermediate';
      }
      
      const user = await User.findById(userId).select('tradingExperience');
      return user?.tradingExperience || 'intermediate'; // Default to intermediate if not set
    } catch (error) {
//       console.error('Error fetching user experience:', error);
      return 'intermediate'; // Safe fallback
    }
  }

  /**
   * Clean JSON response from AI models (especially o4-mini)
   * @param {String} raw - Raw response that might contain markdown or other formatting
   * @returns {Object} - Parsed JSON object
   */
  cleanJsonResponse(raw) {
    if (!raw) throw new Error("Empty response from model");
    
    let cleaned = raw;
    
    // Remove markdown code blocks if present
    if (cleaned.includes('```json')) {
      cleaned = cleaned.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    }
    
    // Remove any leading/trailing whitespace
    cleaned = cleaned.trim();
    
    // Remove any potential BOM or zero-width characters
    cleaned = cleaned.replace(/^\uFEFF/, '').replace(/\u200B/g, '');
    
    // If it starts with ``` without json, remove it
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/g, '');
    }
    
    try {
      return JSON.parse(cleaned);
    } catch (error) {
//       console.error('Failed to parse JSON after cleaning:', cleaned.substring(0, 200));
      throw new Error(`JSON parsing failed: ${error.message}`);
    }
  }

  /**
   * Get language style based on user experience
   * @param {String} userExperience - User's trading experience level
   * @returns {Object} - Language style configuration
   */
  getExperienceLanguage(userExperience) {
    switch (userExperience) {
      case 'beginner':
        return {
          tone: 'Use plain, short sentences',
          complexity: 'Avoid technical jargon',
          glossaryTerms: ['VWAP', 'Risk/Reward', 'RR', 'ATR', 'RSI', 'SMA', 'EMA', 'Support', 'Resistance']
        };
      case 'intermediate':
        return {
          tone: 'Use clear language with light technical terms',
          complexity: 'Define uncommon terms once in parentheses',
          glossaryTerms: ['RR', 'SL', 'TP', 'VWAP', 'ATR', 'MACD', 'Divergence']
        };
      case 'advanced':
        return {
          tone: 'Use technical language freely',
          complexity: 'Include advanced structure and confluence analysis',
          glossaryTerms: []
        };
      default:
        return {
          tone: 'Use clear, practical language',
          complexity: 'Keep it concise',
          glossaryTerms: ['VWAP', 'RR', 'ATR']
        };
    }
  }

  /**
   * Get latest candle from array, handling both chronological orders
   * @param {Array} candles - Array of candles [time, open, high, low, close, volume]
   * @returns {Object|null} - Latest candle object or null
   */
  getLatestCandle(candles) {
    if (!candles || !Array.isArray(candles) || candles.length === 0) return null;
    
    // Check if first candle is array or object format
    const isArrayFormat = Array.isArray(candles[0]);
    
    if (candles.length === 1) {
      if (isArrayFormat) {
        return { time: candles[0][0], close: candles[0][4] };
      } else {
        return { 
          time: candles[0].time || candles[0].timestamp, 
          close: candles[0].close || candles[0].c 
        };
      }
    }
    
    // Check order by comparing first and last timestamps
    let firstTime, lastTime;
    if (isArrayFormat) {
      firstTime = new Date(candles[0][0]).getTime();
      lastTime = new Date(candles[candles.length - 1][0]).getTime();
    } else {
      firstTime = new Date(candles[0].time || candles[0].timestamp).getTime();
      lastTime = new Date(candles[candles.length - 1].time || candles[candles.length - 1].timestamp).getTime();
    }
    
    // If newest first (reverse chronological), use [0]
    // If oldest first (chronological), use [-1]
    const latestIndex = firstTime > lastTime ? 0 : candles.length - 1;
    const latestCandle = candles[latestIndex];
    
    if (isArrayFormat) {
      return {
        time: latestCandle[0],
        close: latestCandle[4],
        open: latestCandle[1],
        high: latestCandle[2], 
        low: latestCandle[3],
        volume: latestCandle[5]
      };
    } else {
      return {
        time: latestCandle.time || latestCandle.timestamp,
        close: latestCandle.close || latestCandle.c,
        open: latestCandle.open || latestCandle.o,
        high: latestCandle.high || latestCandle.h,
        low: latestCandle.low || latestCandle.l,
        volume: latestCandle.volume || latestCandle.v
      };
    }
  }

  /**
   * Get current Indian Standard Time (IST)
   * @param {string} format - Return format: 'string' | 'minutes' | 'object'
   * @returns {string|number|object} - IST time in requested format
   */
  getCurrentIST(format = 'string') {
    const now = new Date();
    
    // Use Intl.DateTimeFormat for proper IST conversion
    const istTimeString = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(now);
    
    // Create proper IST Date object using toLocaleString
    const istDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    
    if (format === 'string') {
      return istTimeString; 
    }
    
    if (format === 'minutes') {
      const [hours, minutes] = istTimeString.split(':').map(Number);
      return (hours * 60) + minutes;
    }
    
    if (format === 'object') {
      const [hours, minutes] = istTimeString.split(':').map(Number);
      return {
        timeString: istTimeString,
        hours,
        minutes,
        totalMinutes: (hours * 60) + minutes,
        rawDate: istDate
      };
    }
  
    if (format === 'date') {
      return istDate; // <--- proper IST Date object
    }
    
    throw new Error(`Invalid format: ${format}`);
  }

  isoIST(date) {
    // Always format in Asia/Kolkata time zone
    const istDate = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    return istDate.toISOString().split('T')[0]; // "YYYY-MM-DD"
  }

  /**
   * Get IST date in YYYY-MM-DD format (timezone-safe)
   * @param {Date} date - Date object (defaults to current date)
   * @returns {string} - Date in YYYY-MM-DD format based on IST timezone
   */
  getISTDate(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata'
    }).format(date);
  }

  /**
   * Validate if intraday trade should be reviewed based on market hours
   * @param {Object} tradeData - Trade data containing term
   * @returns {Object} - { shouldReview: boolean, reason: string }
   */
  validateTradeReview(tradeData) {
    const term = tradeData.term?.toLowerCase();
    
    // 1) Skip market-hour checks for non-intraday trades
    if (term !== 'intraday') {
      return {
        shouldReview: true,
        reason: `${term} trade – no market-hours restriction`
      };
    }
  
    // 2) Get current IST time using utility function
    const nowIST = this.getCurrentIST('date');        // "17:01"
    const nowMinutes = this.getCurrentIST('minutes');   // 1021
  
    // 3) Define exchange vs platform windows
    const EXCHANGE_OPEN_MIN  =  9 * 60 + 15;   // 09:15
    const PLATFORM_OPEN_MIN  =  9 * 60 + 30;   // 09:30  (start accepting)
    const PLATFORM_CLOSE_MIN = 15 * 60;        // 15:00  (stop accepting)
    const EXCHANGE_CLOSE_MIN = 15 * 60 + 30;   // 15:30
  
    const isWithinPlatformWindow =
      nowMinutes >= PLATFORM_OPEN_MIN && nowMinutes <= PLATFORM_CLOSE_MIN;
  
    // console.log(
    //   `⏰ Market-window check — Current ${nowIST} IST | ` +
    //   `Accepting: ${isWithinPlatformWindow}`
    // );
  
    // 4) Reject if outside platform window
    if (!isWithinPlatformWindow) {
      const reason =
        nowMinutes < PLATFORM_OPEN_MIN
          ? `Intraday request before platform start.\n` +
            `• NSE opens at 09:15 AM IST\n` +
            `• We accept intraday review requests only after 09:30 AM IST\n` +
            `Current time: ${nowIST} IST`
          : `Intraday request after platform cut-off.\n` +
            `• NSE trades until 03:30 PM IST, but we stop accepting intraday review requests at 03:00 PM IST\n` +
            `Current time: ${nowIST} IST`;
  
      return { shouldReview: false, reason };
    }
  
    // 5) Inside platform window → proceed
    return {
      shouldReview: true,
      reason: `Intraday trade within platform window (${nowIST} IST)`
    };
  }



  // determineAIModel method moved to common modelSelectorService

  /**
   * Main entry point - replaces n8n workflow
   * @param {Object} tradeData - Trade data from webhook
   * @param {String} userId - User ID for experience-based responses
   */
  async processAIReview(tradeData, userId = null) {
    // Override default models if provided in tradeData
    const originalSentimentModel = this.sentimentalModel;
    const originalAnalysisModel = this.analysisModel;
    
    // Use the new centralized model determination function
    if (userId) {
      const modelConfig = await modelSelectorService.determineAIModel(
        userId, 
        tradeData.isFromRewardedAd || false,
        tradeData.creditType || 'regular'
      );
      
      if (!modelConfig.canProceed) {
        // Cannot proceed with review - save error status
//         console.error(`❌ Cannot proceed with AI review: ${modelConfig.error}`);
        
        // Update trade log with error status
        try {
          const errorData = {
            reviewStatus: 'error',
            reviewCompletedAt: new Date(),
            reviewError: {
              message: modelConfig.error,
              code: modelConfig.errorCode,
              suggestAd: modelConfig.suggestAd
            },
            reviewResult: [{
              status: 'error',
              ui: {
                verdict: 'error',
                tldr: modelConfig.error
              }
            }]
          };
          
          await StockLog.findByIdAndUpdate(tradeData.logId, errorData, { new: true });
        } catch (updateError) {
//           console.error('Error updating trade log with error status:', updateError);
        }
        
        return {
          success: false,
          error: modelConfig.error,
          errorCode: modelConfig.errorCode,
          suggestAd: modelConfig.suggestAd
        };
      }
      
      // Set the determined models and credit type
      this.analysisModel = modelConfig.models.analysis;
      this.sentimentalModel = modelConfig.models.sentiment;
      this.creditType = modelConfig.creditType;
      
//       console.log(`✅ Model selection complete:`);
//       console.log(`   Analysis: ${this.analysisModel}`);
//       console.log(`   Sentiment: ${this.sentimentalModel}`);
//       console.log(`   Tier: ${modelConfig.models.tier}`);
//       console.log(`   Credit Type: ${this.creditType}`);
//       console.log(`   Credits remaining: ${modelConfig.subscription.creditsRemaining}`);
    }
    
    // Allow manual overrides for testing (only if not already set by determineAIModel)
    if (tradeData.sentimentModel && !userId) {
      this.sentimentalModel = tradeData.sentimentModel;
//       console.log(`🔄 Override: Using custom sentiment model: ${tradeData.sentimentModel}`);
    }
    
    if (tradeData.analysisModel && !userId) {
      this.analysisModel = tradeData.analysisModel;
//       console.log(`🔄 Override: Using custom analysis model: ${tradeData.analysisModel}`);
    }
    try {
    //   console.log('🤖 Starting AI Review Process for:', tradeData.logId);
      
    //   // Validate market hours for intraday trades
      const validation = this.validateTradeReview(tradeData);
      
      if (!validation.shouldReview) {
//         console.log(`⏰ SKIPPING REVIEW - ${validation.reason}`);
        
        // Update database with rejection (no AI processing, no chart generation)
        await this.updateTradeLogWithRejection(tradeData.logId, validation.reason);
        
        return { 
          success: false, 
          error: 'Market hours validation failed',
          reason: validation.reason,
          skipped: true
        };
      }
  
    const userExperience = userId ? await this.getUserExperience(userId) : 'intermediate';

    // Use candleFetcherService as single source of truth for data fetching
   
     let isMarketOpen = false;
                try {
                    isMarketOpen = await MarketHoursUtil.isMarketOpen();
                } catch (mhError) {
                    console.error('❌ Error checking market hours:', mhError.message);
                }
    const [candleResult, newsData] = await Promise.all([
      candleFetcherService.getCandleDataForAnalysis(tradeData.instrument_key, tradeData.term, !isMarketOpen),
      this.fetchNewsData(tradeData.stock).catch(e => ({ error: e?.message || String(e) }))
    ]);

    // Extract clean candle data from candleFetcherService result
    const candleSets = candleResult.success ? candleResult.data : {};


    const agentOut = await this.routeToTradingAgent(tradeData, candleSets, newsData);      
     const sentiment = await this.analyzeSentiment(newsData, tradeData.term, tradeData.logId);

    let rawAiReview = {};
    let payload = {};
    if(tradeData.term == 'intraday-today'){
          payload =  this.buildIntradayReviewPayload(agentOut, tradeData, sentiment);
          rawAiReview = await this.getIntraDayAITradingReviewToday(payload);
    }
    else if(tradeData.term == 'intraday'){
        payload =  this.buildIntradayReviewPayload(agentOut, tradeData, sentiment);
        rawAiReview = await this.getIntraDayAITradingReview(tradeData, payload, userExperience);
        
        // Save debug info for troubleshooting
        const candleSummary = {
          dataSource: candleResult?.source || 'unknown',
          candleSets: Object.keys(candleSets || {}),
           lastPrices: {
            last1m: this.getLatestCandle(agentOut?.frames?.['1m']?.candles)?.close,
            finalUsed: payload?.priceContext?.last
          }
        };
        await this.saveDebugInfo(tradeData.logId, payload, { 
          type: 'intraday', 
          userExperience, 
          models: { analysis: this.analysisModel, sentiment: this.sentimentalModel },
          ...rawAiReview.debugInfo
        }, candleSummary);
        
        // Only create charts if we have required snapshot data
        if (payload?.snapshots?.lastBars1m?.length && payload?.snapshots?.lastBars3m?.length) {
          const { microUrl, fullUrl } = await createAndUploadIntradayCharts(payload, rawAiReview);
//           console.log('Charts uploaded:', { microUrl, fullUrl });
          rawAiReview.microChartUrl = microUrl;
          rawAiReview.fullChartUrl = fullUrl;
        } else {
//           console.log('⚠️ Skipping chart creation: missing snapshot bars data');
        }
    }
    else if(tradeData.term == 'short'){
       payload =  this.buildShortTermReviewPayload(agentOut, tradeData, sentiment);
       rawAiReview = await this.getShortTermAITradingReview(tradeData, payload, userExperience);
       
       // Save debug info for troubleshooting
       const candleSummary = {
         dataSource: candleResult?.source || 'unknown',
         candleSets: Object.keys(candleSets || {}),
         lastPrices: {
           last15m: this.getLatestCandle(agentOut?.frames?.['15m']?.candles)?.close,
           last1h: this.getLatestCandle(agentOut?.frames?.['1h']?.candles)?.close,
           last1D: this.getLatestCandle(agentOut?.frames?.['1d']?.candles)?.close,
           finalUsed: payload?.priceContext?.last
         }
       };
       await this.saveDebugInfo(tradeData.logId, payload, { 
        type: 'short-term', 
        userExperience, 
        models: { analysis: this.analysisModel, sentiment: this.sentimentalModel },
        ...rawAiReview.debugInfo
      }, candleSummary);
       
        const { microUrl, fullUrl } = await createAndUploadShortTermCharts( payload, rawAiReview );
//        console.log('Charts uploaded:', { microUrl, fullUrl });
      rawAiReview.microChartUrl = microUrl;
      rawAiReview.fullChartUrl = fullUrl;
    }
    else if(tradeData.term == 'medium'){
      payload =  this.buildMediumTermReviewPayload(agentOut, tradeData, sentiment);
      rawAiReview = await this.getMediumTermAITradingReview(tradeData, payload, userExperience); 
      
      // Save debug info for troubleshooting
      const candleSummary = {
        term: 'medium',
        lastPrices: {
          last1h: this.getLatestCandle(agentOut?.frames?.['1h']?.candles)?.close,
          last1D: this.getLatestCandle(agentOut?.frames?.['1d']?.candles)?.close,
          last1W: this.getLatestCandle(agentOut?.frames?.['1W']?.candles)?.close,
          finalUsed: payload?.priceContext?.last
        }
      };
      await this.saveDebugInfo(tradeData.logId, payload, { 
        type: 'medium-term', 
        userExperience, 
        models: { analysis: this.analysisModel, sentiment: this.sentimentalModel },
        ...rawAiReview.debugInfo
      }, candleSummary);
      
      const { microUrl, fullUrl } = await createAndUploadMediumTermCharts( payload, rawAiReview );
//       console.log('Charts uploaded:', { microUrl, fullUrl });
      rawAiReview.microChartUrl = microUrl;
      rawAiReview.fullChartUrl = fullUrl;

    }
   
      // payload = this.buildSwingReviewPayload(agentOut, tradeData, sentiment);



    await this.updateTradeLogAndNotify(tradeData.logId, rawAiReview);

    const stockLogUser = await StockLog.findById(tradeData.logId).select('user');

    try {
      await firebaseService.sendAIReviewNotification(
        stockLogUser.user,
        tradeData.stock,
        tradeData.logId
      );
    } catch (error) {
      console.error('❌ Failed to send AI review notification:', error);
      // Don't throw - notification failure shouldn't break the review
    }
   

      // // Step 2: Fetch all data in parallel (replaces HTTP Request nodes)
      // const [candleData1, candleData2, latestCandle, newsData] = await Promise.all([
      //   this.fetchCandleData(urls.endpoints[0]),
      //   this.fetchCandleData(urls.endpoints[1]),
      //   this.fetchLatestCandle(urls.latestCandleUrl),
      //   this.fetchNewsData(tradeData.stock)
      // ]);

      // // Step 3: Process and merge data (replaces Merge/Aggregate nodes)
      // const processedCandles = this.processCandleData([candleData1, candleData2], urls.endpoints);
      // const newsTitles = this.extractNewsTitles(newsData);
      
      // // Step 4: Get sentiment analysis (replaces "Message a model" node)
      //
      
      // // Step 5: Prepare final data structureend
      // const aggregatedData = {
      //   data: [
      //     latestCandle,
      //     {
      //       data: [
      //         ...processedCandles,
      //         sentiment
      //       ]
      //     }
      //   ]
      // };

      // // Step 6: Get AI trading review (replaces "AI Agent" node)
      // const rawAiReview = await this.getAITradingReview(tradeData, aggregatedData, userExperience, tradeData.logId);
      
      // // Step 6.5: Enhance the AI response with structured data
      // const aiReview = await this.enhanceAIResponse(rawAiReview, tradeData, aggregatedData, userExperience, userId);
      
      // // Step 7: Update database directly and send notification
      // await this.updateTradeLogAndNotify(tradeData.logId, aiReview);
      
      // console.log('✅ AI Review completed successfully for:', tradeData.logId);
      
      // // Generate final cost summary
      // const costSummary = this.logReviewCostSummary(tradeData.logId);

      // //get user id from tradelog based on tradeData.logId
      // const stockLogUser = await StockLog.findById(tradeData.logId).select('user');
    


      //   console.log('👤 User ID:',  stockLogUser.user);
      //   console.log('👤  tradeData:', tradeData);
      

      // Display final cost summary
      const costSummary = aiCostTracker.getCostBreakdown();
//       console.log(costSummary);
      
      // Update trade log with comprehensive review information
      if (tradeData.logId) {
        const sessionSummary = aiCostTracker.getSessionSummary();
        await this.updateTradeLogWithReviewMetadata(tradeData.logId, {
          sessionCosts: sessionSummary,
          modelsUsed: [this.sentimentalModel, this.analysisModel].filter((model, index, arr) => arr.indexOf(model) === index), // Array of unique model names
          modelDetails: {
            sentimentModel: this.sentimentalModel,
            analysisModel: this.analysisModel
          },
          userExperience: userExperience,
          reviewProcessedAt: new Date(),
          tokenUsage: {
            totalTokens: sessionSummary.totalTokens.total,
            inputTokens: sessionSummary.totalTokens.input,
            outputTokens: sessionSummary.totalTokens.output
          }
        });
      }
      
//       console.log('AI Review result:', { success: true, result: rawAiReview });
     
      
    } catch (error) {
//       console.error('❌ AI Review failed:', error);
      
      // Save error status to database
      if (tradeData.logId) {
        await this.saveErrorStatus(tradeData.logId, error);
      }
      
      return { success: false, error: error.message };
    } finally {
      // Restore original models
      this.sentimentalModel = originalSentimentModel;
      this.analysisModel = originalAnalysisModel;
    }
  }


buildIntradayReviewPayload(agentOut, tradeData, newsSentiment) {
  // pull latest prices safely using consistent helper
  const last1m = agentOut?.frames?.['1m']?.candles;
  const latestCandle = this.getLatestCandle(last1m);
  const last = latestCandle?.close || null;
  
  // DEBUG: Consolidated intraday data summary
  const candleCount = last1m?.length || 0;
  const lastCandleTime = last1m?.length ? last1m[last1m.length - 1].time : null;
  if (candleCount > 0) {
//     console.log(`📊 INTRADAY DATA: ${candleCount} candles | Last: ${lastCandleTime} | Price: ${last}`);
  } else {
//     console.log(`❌ INTRADAY DATA: No 1m candles available`);
  }

  // small helpers from your indicators
  const vwapArr = agentOut?.frames?.['1m']?.indicators?.vwap || [];
  const vwap1m = vwapArr.length ? vwapArr[vwapArr.length - 1] : null;

  // derive 15m bias from ema20 vs close
  const c15 = agentOut?.frames?.['15m']?.candles || [];
  const ema20_15m = agentOut?.frames?.['15m']?.indicators?.ema20 || [];
  const last15 = c15.length ? c15[c15.length - 1].close : null;
  const e20_15 = ema20_15m.length ? ema20_15m[ema20_15m.length - 1] : null;
  const bias15m = (last15 != null && e20_15 != null)
    ? (last15 > e20_15 ? 'bullish' : 'bearish')
    : 'unknown';

  // 3m momentum bits
  const rsi14_3m = agentOut?.frames?.['3m']?.indicators?.rsi14?.slice(-1)[0] ?? null;
  const atr14_3m = agentOut?.frames?.['3m']?.indicators?.atr14?.slice(-1)[0] ?? null;
  const atr14_15m = agentOut?.frames?.['15m']?.indicators?.atr14?.slice(-1)[0] ?? null;

  // opening range (if you computed it)
  const orb = agentOut?.frames?.['1m']?.openingRange || agentOut?.frames?.['15m']?.openingRange || null;

  // volatility/tape
  const medianMove1m = agentOut?.frames?.['1m']?.indicators?.medianMove1m ?? null; // if you stored it
  const volSpike3m = agentOut?.frames?.['3m']?.indicators?.volumeSpike?.slice(-1)[0]?.isSpike ?? false;
  const volSpike15m = agentOut?.frames?.['15m']?.indicators?.volumeSpike?.slice(-1)[0]?.isSpike ?? false;

  // plan diagnostics - extract correct field names from tradeData
  const entry = parseFloat(tradeData?.entryprice) || null;
  const stop = parseFloat(tradeData?.stoploss) || null;
  const target = parseFloat(tradeData?.target) || null;
  const quantity = parseInt(tradeData?.quantity) || null;
  
  const distanceFromLastPct = (last && entry) ? Math.abs(entry - last) / last * 100 : null;
  
  // DEBUG: Consolidated deviation calculation
//   console.log(`💰 DEVIATION: Entry=${entry} | Last=${last} | Deviation=${distanceFromLastPct?.toFixed(2)}% | LogID=${tradeData?.logId || 'N/A'}`);
  const rr = (entry != null && stop != null && target != null)
    ? Math.abs(target - entry) / Math.max(1e-9, Math.abs(entry - stop))
    : null;

  // tiny snapshots (last 30 bars each, tuples to keep payload small)
  const tup = c => c.map(k => [k.time, k.open, k.high, k.low, k.close, k.volume]);
  const snapshots = {
    lastBars1m: (last1m || []).slice(-30) .map(k => [k.time,k.open,k.high,k.low,k.close,k.volume]),
    lastBars3m: (agentOut?.frames?.['3m']?.candles || []).slice(-30).map(k => [k.time,k.open,k.high,k.low,k.close,k.volume]),
    lastBars15m:(agentOut?.frames?.['15m']?.candles|| []).slice(-30).map(k => [k.time,k.open,k.high,k.low,k.close,k.volume]),
  };

  return {
    meta: {
      symbol: tradeData?.stock || 'UNKNOWN',
      instrument_key: tradeData?.instrument_key,
      term: 'intraday',
      tz: 'Asia/Kolkata',
      session: {
        dateISO: agentOut?.meta?.dateISO || null,
        isBusinessDay: agentOut?.meta?.isBusinessDay ?? true,
        marketOpenIST: '09:15',
        platformAcceptFromIST: '09:30',
        marketCloseIST: '15:30',
        requestTimeIST: agentOut?.meta?.requestTimeIST || null
      },
      dataHealth: {
        bars1m: last1m?.length || 0,
        bars3m: agentOut?.frames?.['3m']?.candles?.length || 0,
        bars15m: agentOut?.frames?.['15m']?.candles?.length || 0,
        missingFrames: agentOut?.meta?.dataHealth?.missing || []
      }
    },

    priceContext: {
      last, vwap1m,
      aboveVWAP: (last != null && vwap1m != null) ? last > vwap1m : null,
    },

    trendMomentum: {
      bias15m,
      ema20_15m: e20_15,
      ema20_3m: agentOut?.frames?.['3m']?.indicators?.ema20?.slice(-1)[0] ?? null,
      rsi14_3m,
      atr14_3m,
      atr14_15m
    },

    openingRange: orb ? {
      orbHigh: orb.high, orbLow: orb.low,
      inOR: (last != null) ? (last >= orb.low && last <= orb.high) : null,
      aboveORHigh: (last != null) ? (last > orb.high) : null,
      belowORLow: (last != null) ? (last < orb.low) : null
    } : null,

    volatilityTape: {
      medianMove1m,
      volumeSpike3m: !!volSpike3m,
      volumeSpike15m: !!volSpike15m
    },

    levels: agentOut?.levels || { intradaySupports: [], intradayResistances: [] },

    userPlan: {
      direction: tradeData?.direction,
      entryprice: tradeData?.entryprice, 
      stoploss: tradeData?.stoploss, 
      target: tradeData?.target,  // Fixed: was targetprice, should be target
      quantity: tradeData?.quantity,
      createdAtISO: tradeData?.createdAt || null
    },

    planDiagnostics: {
      distanceFromLastPct,
      riskPerShare: (entry != null && stop != null) ? Math.abs(entry - stop) : null,
      rewardPerShare: (entry != null && target != null) ? Math.abs(target - entry) : null,
      rr,
      alignedWith15mBias: (bias15m === 'bullish' && tradeData?.direction === 'BUY') ||
                          (bias15m === 'bearish' && tradeData?.direction === 'SELL') || false,
      entryVsVWAP: (entry != null && vwap1m != null)
        ? (entry > vwap1m ? 'above' : (Math.abs(entry - vwap1m)/vwap1m < 0.001 ? 'near' : 'below'))
        : 'unknown',
      entryVsOR: (orb && entry != null)
        ? (entry > orb.high ? 'aboveORHigh' : entry < orb.low ? 'belowORLow' : 'inside')
        : 'unknown'
    },

    timeToTargetEstimate: (entry != null && target != null && medianMove1m)
      ? {
          minutesAtMedian1m: Math.round(Math.abs(target - entry) / Math.max(medianMove1m, 1e-6)),
          note: "rough; assumes steady tape"
        }
      : null,

    newsLite: {
      sentimentScore: newsSentiment?.shortTermSentiment?.score ?? 0,
      notes: newsSentiment?.shortTermSentiment?.rationale || ''
    },

    snapshots
  };
}

buildShortTermReviewPayload(agentOut, tradeData, newsSentiment) {
  
  // ----- latest prices (prefer 1h, then 15m, then 1d) -----
  const c1h = agentOut?.frames?.['1h']?.candles || [];
  const c15 = agentOut?.frames?.['15m']?.candles || [];
  const c1D = agentOut?.frames?.['1d']?.candles  || [];

  // Use consistent helper to get latest candle regardless of API order
  const latest1h = this.getLatestCandle(c1h);
  const latest15m = this.getLatestCandle(c15);
  const latest1D = this.getLatestCandle(c1D);
  
  const last = latest1h?.close ?? latest15m?.close ?? latest1D?.close ?? null;
  
  // For compatibility with existing code
  const last1h = latest1h?.close;
  const last15 = latest15m?.close;
  const last1D = latest1D?.close;

  // ----- indicators snapshot -----
  const ind15  = agentOut?.frames?.['15m']?.indicators || {};
  const ind1h  = agentOut?.frames?.['1h']?.indicators || {};
  const ind1D  = agentOut?.frames?.['1d'] ?.indicators || {};
  
  console.log(`🔍 [PAYLOAD DEBUG] Building payload with indicators:`);
  console.log(`   - 15m indicators: ${Object.keys(ind15).join(', ') || 'none'}`);
  console.log(`   - 1h indicators: ${Object.keys(ind1h).join(', ') || 'none'}`);
  console.log(`   - 1d indicators: ${Object.keys(ind1D).join(', ') || 'none'}`);

  const vwap15 = Array.isArray(ind15.vwap) ? ind15.vwap.at(-1) : null;

  const ema20_1D = Array.isArray(ind1D.ema20) ? ind1D.ema20.at(-1) : null;
  const ema50_1D = (Array.isArray(ind1D.ema50) ? ind1D.ema50.at(-1)
                    : Array.isArray(ind1D.sma50) ? ind1D.sma50.at(-1) : null);
  const sma200_1D = Array.isArray(ind1D.sma200) ? ind1D.sma200.at(-1) : null;

  const rsi14_1h = Array.isArray(ind1h.rsi14) ? ind1h.rsi14.at(-1) : null;
  const atr14_1h = Array.isArray(ind1h.atr14) ? ind1h.atr14.at(-1) : null;
  const atr14_1D  = Array.isArray(ind1D.atr14) ? ind1D.atr14.at(-1) : null;
  
  console.log(`🔍 [PAYLOAD DEBUG] Extracted indicator values:`);
  console.log(`   - ema20_1D: ${ema20_1D}`);
  console.log(`   - ema50_1D: ${ema50_1D}`);
  console.log(`   - sma200_1D: ${sma200_1D}`);
  console.log(`   - rsi14_1h: ${rsi14_1h}`);
  console.log(`   - atr14_1h: ${atr14_1h}`);
  console.log(`   - atr14_1D: ${atr14_1D}`);

  // trend bias from 1d (if your short indicators set it)
  const trendBias = agentOut?.frames?.['1d']?.indicators?.trendBias
    ?? agentOut?.meta?.bias?.trend
    ?? (() => {
         if (ema20_1D != null && ema50_1D != null && last1D != null) {
           if (ema20_1D > ema50_1D && last1D > ema20_1D) return 'bullish';
           if (ema20_1D < ema50_1D && last1D < ema20_1D) return 'bearish';
         }
         return 'neutral';
       })();

  // swing levels (recent high/low windows if present)
  const swing = ind1D?.swingLevels || ind1h?.swingLevels || null;
  const pivots = ind1D?.pivotClassic || null;

  // prev-session / weekly range & gap (from your short agent)
  const prevSession = agentOut?.frames?.['1d']?.prevSession || null;
  const weeklyRange = agentOut?.frames?.['1d']?.weeklyRange || null;
  const gapMeta = agentOut?.meta?.gap || null;

  // ----- plan diagnostics - extract correct field names from tradeData -----
  const entry = parseFloat(tradeData?.entryprice) || null;
  const stop = parseFloat(tradeData?.stoploss) || null;
  const target = parseFloat(tradeData?.target) || null;
  const qty = parseInt(tradeData?.quantity) || null;
  
  const distanceFromLastPct = (last != null && entry != null)
    ? Math.abs(entry - last) / Math.max(1e-9, last) * 100
    : null;
  
  // DEBUG: Clean short-term summary
  const priceSource = c1h?.length ? '1h' : (c1D?.length ? '1d' : 'NO_DATA');
//   console.log(`💰 SHORT DEVIATION: Entry=${entry} | Last=${last}(${priceSource}) | Dev=${distanceFromLastPct?.toFixed(2)}% | Log=${tradeData?.logId}`);

  const rr = (entry != null && stop != null && target != null)
    ? Math.abs(target - entry) / Math.max(1e-9, Math.abs(entry - stop))
    : null;

  const alignedWithBias =
      (trendBias === 'bullish' && tradeData?.direction === 'BUY') ||
      (trendBias === 'bearish' && tradeData?.direction === 'SELL') || false;

  // entry vs key MAs (daily context)
  const entryVsDailyMA = (entry != null)
    ? {
        vsEMA20: (ema20_1D != null) ? (entry > ema20_1D ? 'above' : entry < ema20_1D ? 'below' : 'at') : 'unknown',
        vsEMA50: (ema50_1D != null) ? (entry > ema50_1D ? 'above' : entry < ema50_1D ? 'below' : 'at') : 'unknown',
        vsSMA200: (sma200_1D != null) ? (entry > sma200_1D ? 'above' : entry < sma200_1D ? 'below' : 'at') : 'unknown',
      }
    : { vsEMA20: 'unknown', vsEMA50: 'unknown', vsSMA200: 'unknown' };

  // proximity to swing levels (use recent50 if present)
  const swingRef = swing?.recent50 || swing?.recent20 || null;
  const nearSwing = (entry != null && swingRef)
    ? {
        distToRecentHigh: +(Math.abs(swingRef.high - entry)).toFixed(2),
        distToRecentLow:  +(Math.abs(entry - swingRef.low)).toFixed(2),
      }
    : null;

  // ----- time-to-target estimates (rough) -----
  // 1) Daily ATR-based: days to target
  const daysAtATR = (entry != null && target != null && atr14_1D != null && atr14_1D > 0)
    ? Math.max(1, Math.round(Math.abs(target - entry) / atr14_1D))
    : null;

  // 2) 60m ATR-based: number of 60m bars (approx) — ATR per 60m bar ~ atr14_60m
  const bars1hAtATR = (entry != null && target != null && atr14_1h != null && atr14_1h > 0)
    ? Math.max(1, Math.round(Math.abs(target - entry) / atr14_1h))
    : null;

  // ----- tiny snapshots (last 30 bars each) -----
  const toTups = (arr = []) => arr.slice(-30).map(k => [k.time,k.open,k.high,k.low,k.close,k.volume]);
  const snapshots = {
    lastBars15m: toTups(c15),
    lastBars1h: toTups(c1h),
    lastBars1D : toTups(c1D),
  };

  return {
    meta: {
      symbol: tradeData?.stock || 'UNKNOWN',
      instrument_key: tradeData?.instrument_key,
      term: 'short',
      tz: 'Asia/Kolkata',
      session: {
        dateISO: agentOut?.meta?.dateISO || null,
        isBusinessDay: agentOut?.meta?.isBusinessDay ?? true,
        marketOpenIST: '09:15',
        marketCloseIST: '15:30',
        requestTimeIST: agentOut?.meta?.requestTimeIST || null
      },
      dataHealth: {
        bars15m: c15.length,
        bars1h: c1h.length,
        bars1D : c1D.length,
        missingFrames: agentOut?.meta?.dataHealth?.missing || []
      }
    },

    priceContext: {
      last,
      vwap15m: vwap15,
      aboveVWAP15m: (last != null && vwap15 != null) ? last > vwap15 : null,
      lastDailyClose: last1D
    },

    trendMomentum: {
      trendBias,                 // bullish / bearish / neutral
      ema20_1D: ema20_1D,
      ema50_1D: ema50_1D,
      sma200_1D: sma200_1D,
      rsi14_1h: rsi14_1h,
      atr14_1h: atr14_1h,
      atr14_1D:  atr14_1D
    },

    swingContext: {
      prevSession,               // {high, low, close, date}
      weeklyRange,               // {high, low}
      gap: gapMeta,              // {open, prevClose, pct}
      swingLevels: swing,        // {recent20:{high,low}, recent50:{high,low}}
      pivots: pivots || null     // pivotClassic if you compute it
    },

    levels: agentOut?.levels || { supports: [], resistances: [] },

    userPlan: {
      direction: tradeData?.direction,
      entry: entry,  // Use parsed numeric value
      stop: stop,    // Use parsed numeric value  
      target: target, // Use parsed numeric value
      qty: qty,      // Use parsed numeric value
      createdAtISO: tradeData?.createdAt || null
    },

    planDiagnostics: {
      distanceFromLastPct,
      riskPerShare: (entry != null && stop != null) ? Math.abs(entry - stop) : null,
      rewardPerShare: (entry != null && target != null) ? Math.abs(target - entry) : null,
      rr,
      alignedWithBias,
      entryVsDailyMA,
      nearSwing
    },

    timeToTargetEstimate: (daysAtATR || bars1hAtATR) ? {
      daysAtDailyATR: daysAtATR,
      bars1hAtATR: bars1hAtATR,
      note: "ATR-based rough estimate; assumes typical volatility."
    } : null,

    newsLite: {
      sentimentScore: newsSentiment?.shortTermSentiment?.score ?? 0,
      notes: newsSentiment?.shortTermSentiment?.rationale || ''
    },

    snapshots
  };
}


buildMediumTermReviewPayload(agentOut, tradeData, newsSentiment) {
  // ----- latest prices (prefer 1d, then 1h, then 1W) -----
  const c1h = agentOut?.frames?.['1h']?.candles || [];
  const c1D = agentOut?.frames?.['1d']?.candles || [];
  const c1W = agentOut?.frames?.['1W']?.candles || [];

  const last1D = c1D.length ? c1D[c1D.length - 1].close : null;
  const last1h = c1h.length ? c1h[c1h.length - 1].close : null;
  const last1W = c1W.length ? c1W[c1W.length - 1].close : null;
  const last = last1D ?? last1h ?? last1W ?? null;

  // ----- indicators snapshot -----
  const ind1h = agentOut?.frames?.['1h']?.indicators || {};
  const ind1D = agentOut?.frames?.['1d']?.indicators || {};
  const ind1W = agentOut?.frames?.['1W']?.indicators || {};

  // Daily
  const ema20_1D  = Array.isArray(ind1D.ema20)  ? ind1D.ema20.at(-1)  : null;
  const ema50_1D  = Array.isArray(ind1D.ema50)  ? ind1D.ema50.at(-1)
                    : Array.isArray(ind1D.sma50) ? ind1D.sma50.at(-1) : null;
  const sma200_1D = Array.isArray(ind1D.sma200) ? ind1D.sma200.at(-1) : null;
  const rsi14_1D  = Array.isArray(ind1D.rsi14)  ? ind1D.rsi14.at(-1)  : null;
  const atr14_1D  = Array.isArray(ind1D.atr14)  ? ind1D.atr14.at(-1)  : null;

  // Weekly
  const ema20_1W  = Array.isArray(ind1W.ema20)  ? ind1W.ema20.at(-1)  : null;
  const ema50_1W  = Array.isArray(ind1W.ema50)  ? ind1W.ema50.at(-1)
                    : Array.isArray(ind1W.sma50) ? ind1W.sma50.at(-1) : null;
  const sma200_1W = Array.isArray(ind1W.sma200) ? ind1W.sma200.at(-1) : null;
  const rsi14_1W  = Array.isArray(ind1W.rsi14)  ? ind1W.rsi14.at(-1)  : null;
  const atr14_1W  = Array.isArray(ind1W.atr14)  ? ind1W.atr14.at(-1)  : null;

  // Hourly (timing)
  const rsi14_1h  = Array.isArray(ind1h.rsi14)  ? ind1h.rsi14.at(-1)  : null;
  const atr14_1h  = Array.isArray(ind1h.atr14)  ? ind1h.atr14.at(-1)  : null;

  // trend bias: combine weekly + daily (weekly dominates)
  const calcBias = (lastClose, ema20, ema50) => {
    if ([lastClose, ema20, ema50].every(v => Number.isFinite(v))) {
      if (ema20 > ema50 && lastClose > ema20) return 'bullish';
      if (ema20 < ema50 && lastClose < ema20) return 'bearish';
    }
    return 'neutral';
  };

  // Use consistent helper to get latest candle regardless of API order
  const latestWeekly = this.getLatestCandle(c1W);
  const latestDaily = this.getLatestCandle(c1D);
  const lastWclose = latestWeekly?.close || null;
  const lastDclose = latestDaily?.close || null;

  const biasW = calcBias(lastWclose, ema20_1W, ema50_1W);
  const biasD = calcBias(lastDclose, ema20_1D, ema50_1D);
  const trendBias = agentOut?.meta?.bias?.w1 || biasW || agentOut?.meta?.bias?.d1 || biasD || 'neutral';

  // swing levels (prefer weekly swings; fallback to daily)
  const swingWeekly = agentOut?.frames?.['1W']?.swing4W || null; // {high, low}
  const swingDaily  = agentOut?.frames?.['1d']?.weeklyRange || null; // {high, low}
  const swingLevels = swingWeekly || swingDaily || null;

  // prev period context
  const prevSession = agentOut?.frames?.['1d']?.prevSession || null;
  const prevWeek    = agentOut?.frames?.['1W']?.prevWeek || null;

  // ----- plan fields (support both camelCase & lowercase variants) -----
  const parseN = (v) => (v == null ? null : parseFloat(v));
  const entry  = parseN(tradeData?.entryPrice ?? tradeData?.entryprice);
  const stop   = parseN(tradeData?.stopLoss   ?? tradeData?.stoploss);
  const target = parseN(tradeData?.targetPrice?? tradeData?.target);
  const qty    = tradeData?.qty ?? tradeData?.quantity ?? null;

  const distanceFromLastPct = (last != null && entry != null)
    ? Math.abs(entry - last) / Math.max(1e-9, last) * 100
    : null;

  // DEBUG: Clean medium-term summary  
  const priceSource = c1h?.length ? '1h' : (c1D?.length ? '1d' : 'NO_DATA');
//   console.log(`💰 MEDIUM DEVIATION: Entry=${entry} | Last=${last}(${priceSource}) | Dev=${distanceFromLastPct?.toFixed(2)}% | Log=${tradeData?.logId}`);

  const rr = (entry != null && stop != null && target != null)
    ? Math.abs(target - entry) / Math.max(1e-9, Math.abs(entry - stop))
    : null;

  const alignedWithBias =
      (trendBias === 'bullish' && tradeData?.direction === 'BUY') ||
      (trendBias === 'bearish' && tradeData?.direction === 'SELL') || false;

  // entry vs key MAs (daily + weekly)
  const cmp = (val, ref) =>
    (ref != null && val != null) ? (val > ref ? 'above' : val < ref ? 'below' : 'at') : 'unknown';

  const entryVsDailyMA = (entry != null)
    ? {
        vsEMA20:  cmp(entry, ema20_1D),
        vsEMA50:  cmp(entry, ema50_1D),
        vsSMA200: cmp(entry, sma200_1D),
      }
    : { vsEMA20: 'unknown', vsEMA50: 'unknown', vsSMA200: 'unknown' };

  const entryVsWeeklyMA = (entry != null)
    ? {
        vsEMA20W:  cmp(entry, ema20_1W),
        vsEMA50W:  cmp(entry, ema50_1W),
        vsSMA200W: cmp(entry, sma200_1W),
      }
    : { vsEMA20W: 'unknown', vsEMA50W: 'unknown', vsSMA200W: 'unknown' };

  // proximity to swing bands (weekly preferred)
  const nearSwing = (entry != null && swingLevels)
    ? {
        distToSwingHigh: +(Math.abs(swingLevels.high - entry)).toFixed(2),
        distToSwingLow:  +(Math.abs(entry - swingLevels.low)).toFixed(2),
      }
    : null;

  // ----- time-to-target estimates -----
  // Daily ATR ⇒ rough days; Weekly ATR ⇒ rough weeks
  const daysAtATR = (entry != null && target != null && Number.isFinite(atr14_1D) && atr14_1D > 0)
    ? Math.max(1, Math.round(Math.abs(target - entry) / atr14_1D))
    : null;

  const weeksAtATR = (entry != null && target != null && Number.isFinite(atr14_1W) && atr14_1W > 0)
    ? Math.max(1, Math.round(Math.abs(target - entry) / atr14_1W))
    : null;

  // Hourly ATR bars (timing granularity)
  const bars1hAtATR = (entry != null && target != null && Number.isFinite(atr14_1h) && atr14_1h > 0)
    ? Math.max(1, Math.round(Math.abs(target - entry) / atr14_1h))
    : null;

  // ----- tiny snapshots (last 30 bars) -----
  const toTups = (arr = []) => arr.slice(-30).map(k => [k.time,k.open,k.high,k.low,k.close,k.volume]);
  const snapshots = {
    lastBars1h: toTups(c1h),
    lastBars1D: toTups(c1D),
    lastBars1W: toTups(c1W),
  };

  return {
    meta: {
      symbol: tradeData?.stock || 'UNKNOWN',
      instrument_key: tradeData?.instrument_key,
      term: 'medium',
      tz: 'Asia/Kolkata',
      session: {
        dateISO: agentOut?.meta?.dateISO || null,
        isBusinessDay: agentOut?.meta?.isBusinessDay ?? true,
        marketOpenIST: '09:15',
        marketCloseIST: '15:30',
        requestTimeIST: agentOut?.meta?.requestTimeIST || null
      },
      dataHealth: {
        bars1h: c1h.length,
        bars1D: c1D.length,
        bars1W: c1W.length,
        missingFrames: agentOut?.meta?.dataHealth?.missing || []
      }
    },

    priceContext: {
      last,
      lastDailyClose: last1D,
      lastWeeklyClose: last1W
    },

    trendMomentum: {
      biasWeekly: biasW,
      biasDaily:  biasD,
      trendBias,               // final combined view
      // Daily
      ema20_1D, ema50_1D, sma200_1D, rsi14_1D, atr14_1D,
      // Weekly
      ema20_1W, ema50_1W, sma200_1W, rsi14_1W, atr14_1W,
      // Hourly timing
      rsi14_1h, atr14_1h
    },

    swingContext: {
      prevSession,         // from 1d
      prevWeek,            // from 1W
      swingLevels,         // weekly 4W range or daily weeklyRange
      pivotsDaily: ind1D?.pivotClassic || null
    },

    levels: agentOut?.levels || { supports: [], resistances: [] },

    userPlan: {
      direction: tradeData?.direction,
      entry, stop, target,
      qty,
      createdAtISO: tradeData?.createdAt || null
    },

    planDiagnostics: {
      distanceFromLastPct,
      riskPerShare:   (entry != null && stop != null)   ? Math.abs(entry - stop)   : null,
      rewardPerShare: (entry != null && target != null) ? Math.abs(target - entry) : null,
      rr,
      alignedWithBias,
      entryVsDailyMA,
      entryVsWeeklyMA,
      nearSwing
    },

    timeToTargetEstimate: (daysAtATR || weeksAtATR || bars1hAtATR) ? {
      daysAtDailyATR:  daysAtATR,
      weeksAtWeeklyATR: weeksAtATR,
      bars1hAtATR:     bars1hAtATR,
      note: "ATR-based rough estimates; assumes typical volatility."
    } : null,

    newsLite: {
      sentimentScore: newsSentiment?.mediumTermSentiment?.score
        ?? newsSentiment?.shortTermSentiment?.score
        ?? 0,
      notes: newsSentiment?.mediumTermSentiment?.rationale
        ?? newsSentiment?.shortTermSentiment?.rationale
        ?? ''
    },

    snapshots
  };
}





  sessionHasStartedIST(checkOnlyStart = false) {
    const { hours, minutes } = this.getCurrentIST('object');
    const totalMinutes = (hours * 60) + minutes;
  
    const marketOpen = (9 * 60) + 15;   // 09:15
    const marketClose = (15 * 60) + 30; // 15:30
  
    if (checkOnlyStart) {
      return totalMinutes >= marketOpen;
    }
  
    // Return true if current IST time is between open and close
    return totalMinutes >= marketOpen && totalMinutes <= marketClose;
  }

  // Map of term → preferred frames
termToFrames = {
  intraday: ['1m', '3m', '15m'],  // For active day traders
  short:    ['15m', '1h', '1d'],  // Swing trades lasting days - now includes 1d
  medium:   ['1h', '1d','1W']     // Multi-week to monthly trades
};

// Market holidays cache - fetched from Upstox API by year
marketHolidaysCache = new Map(); // year -> Set of holiday dates

/**
 * Fetch market holidays from Upstox API for a specific year
 */
async fetchMarketHolidays(year, upstoxToken = null) {
  try {
    // Import MarketTiming model
    const MarketTiming = (await import('../../models/marketTiming.js')).default;
    
    // Check if we already have holidays for this year in memory cache
    if (this.marketHolidaysCache.has(year)) {
      // console.log(`📅 Using memory cached holidays for ${year}`);
      return this.marketHolidaysCache.get(year);
    }

    // Check database first for existing holiday data for this year
    const startOfYear = `${year}-01-01`;
    const endOfYear = `${year}-12-31`;
    
    const existingHolidays = await MarketTiming.find({
      date: { $gte: startOfYear, $lte: endOfYear },
      isHoliday: true,
      validUntil: { $gt: new Date() } // Only get non-expired records
    }).select('date');

    // If we have holidays in DB, use them
    if (existingHolidays.length > 0) {
      const holidays = new Set(existingHolidays.map(h => h.date));
      this.marketHolidaysCache.set(year, holidays);
      // console.log(`📅 Using ${holidays.size} holidays from database for ${year}`);
      return holidays;
    }

    // No holidays in DB, must fetch from API - requires token
    if (!upstoxToken) {
      console.error(`❌ No Upstox token available and no holiday data in DB for ${year}. Cannot fetch holidays - business day calculation will fail.`);
      throw new Error(`Holiday data required for ${year} but no Upstox token available`);
    }

    const response = await axios.get('https://api.upstox.com/v2/market/holidays', {
      headers: {
        'Authorization': `Bearer ${upstoxToken}`,
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    if (response.data?.status === 'success' && Array.isArray(response.data.data)) {
      const holidays = new Set();
      const holidayDocs = [];
      
      response.data.data.forEach(holiday => {
        if (holiday.date && holiday.holiday_type === 'TRADING_HOLIDAY') {
          const holidayYear = new Date(holiday.date).getFullYear();
          
          // Only include holidays for the requested year
          if (holidayYear === year) {
            // Check if NSE is closed (most relevant for equity trading)
            const nseClosed = holiday.closed_exchanges?.includes('NSE') || 
                             holiday.open_exchanges?.every(ex => ex.exchange !== 'NSE');
            if (nseClosed) {
              holidays.add(holiday.date);
              
              // Prepare document for database storage
              holidayDocs.push({
                date: holiday.date,
                exchange: 'NSE',
                isHoliday: true,
                isMarketOpen: false,
                reason: holiday.description || 'Market Holiday',
                upstoxData: holiday,
                fetchedAt: new Date(),
                validUntil: new Date(year + 1, 11, 31) // Valid until end of next year
              });
            }
          }
        }
      });

      // Store holidays in database for future use
      if (holidayDocs.length > 0) {
        try {
          await MarketTiming.insertMany(holidayDocs, { ordered: false }); // Continue on duplicates
          console.log(`💾 Stored ${holidayDocs.length} holidays in database for ${year}`);
        } catch (dbError) {
          // Log but don't fail - duplicates are expected
          console.log(`💾 Some holidays may already exist in DB for ${year}`);
        }
      }

      // Cache the holidays for this year in memory
      this.marketHolidaysCache.set(year, holidays);
      return holidays;
    }
    
    throw new Error('Invalid response from Upstox holidays API');
    
  } catch (error) {
    console.error(`❌ Failed to fetch market holidays for ${year}:`, error.message);
    return new Set(); // Return empty set on error
  }
}

/**
 * Parse a timeframe string like: '1m','3m','15m','1h','4h','1d','1W','1Mo'
 * Returns:
 *  { raw, n, u, unit } 
 *  - raw: original input (trimmed)
 *  - n: numeric value (Number)
 *  - u: compact unit code: 'm' | 'h' | 'd' | 'w' | 'mo'
 *  - unit: long unit string for Upstox paths: 'minutes'|'hours'|'days'|'weeks'|'months'
 */
/**
 * Helper function to format messages based on model type
 * o1 models don't support system role, so we merge system into user message
 */
formatMessagesForModel(model, systemPrompt, userPrompt = null) {
  const isO1Model = model && (model.includes('o1-') || model.startsWith('o1'));
  
  if (isO1Model) {
    // For o1 models: merge system prompt into user message
    const combinedPrompt = userPrompt 
      ? `${systemPrompt}\n\n${userPrompt}`
      : systemPrompt;
    
    return [{ role: 'user', content: combinedPrompt }];
  } else {
    // For regular models: keep system and user separate
    const messages = [{ role: 'system', content: systemPrompt }];
    if (userPrompt) {
      messages.push({ role: 'user', content: userPrompt });
    }
    return messages;
  }
}

/**
 * Date utility methods
 */
addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

addMonths(date, months) {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

addYears(date, years) {
  const result = new Date(date);
  result.setFullYear(result.getFullYear() + years);
  return result;
}

parseFrame(frame) {
  if (!frame || typeof frame !== 'string') {
    throw new Error(`parseFrame: invalid frame "${frame}"`);
  }

  const raw = frame.trim();

  // Capture number + unit; allow case-insensitive, and "Mo" or "M" for months
  // Examples matched: 1m, 3M, 15m, 1h, 4H, 1d, 1d, 1w, 1W, 1Mo, 3mo
  const match = raw.match(/^(\d+)\s*([a-zA-Z]+)$/);
  if (!match) {
    throw new Error(`parseFrame: could not parse "${raw}"`);
  }

  const n = Number(match[1]);
  const unitStr = match[2].toLowerCase();

  // Normalize to compact unit code
  let u;
  if (unitStr === 'm' || unitStr === 'min' || unitStr === 'mins' || unitStr === 'minute' || unitStr === 'minutes') {
    u = 'm';
  } else if (unitStr === 'h' || unitStr === 'hr' || unitStr === 'hrs' || unitStr === 'hour' || unitStr === 'hours') {
    u = 'h';
  } else if (unitStr === 'd' || unitStr === 'day' || unitStr === 'days') {
    u = 'd';
  } else if (unitStr === 'w' || unitStr === 'wk' || unitStr === 'wks' || unitStr === 'week' || unitStr === 'weeks') {
    u = 'w';
  } else if (unitStr === 'mo' || unitStr === 'mon' || unitStr === 'month' || unitStr === 'months') {
    u = 'mo';
  } else {
    throw new Error(`parseFrame: unknown unit "${unitStr}" in "${raw}"`);
  }

  const unitMap = { m: 'minutes', h: 'hours', d: 'days', w: 'weeks', mo: 'months' };
  return { raw, n, u, unit: unitMap[u] };
}

/**
 * Convert compact unit to Upstox path segment depending on mode.
 * mode: 'intraday' | 'historical'
 * For Upstox it’s the same strings, but keeping this helper keeps your code explicit.
 */
unitPath(u, mode = 'intraday') {
  const map = { m: 'minutes', h: 'hours', d: 'days', w: 'weeks', mo: 'months' };
  const seg = map[u];
  if (!seg) throw new Error(`unitPath: unsupported unit "${u}"`);
  // If someday Upstox differs between intraday/historical paths, branch here.
  return seg;
}


async buildCandleUrls(tradeData) {
  const { instrument_key, term } = tradeData;
  const t = (term || '').toLowerCase();

  // SMART DATA SELECTION: Current day intraday data after 5.00 PM, historical data before
  const now = this.getCurrentIST('date');         // IST Date object
  const { hours, minutes } = this.getCurrentIST('object');
  const currentTimeMinutes = hours * 60 + minutes;
  const ANALYSIS_ALLOWED_AFTER = 16 * 60; // 5.00 PM (16:00)
  
  // Determine if we should use current day intraday data or historical data
  const isAfter4PM = currentTimeMinutes >= ANALYSIS_ALLOWED_AFTER;
  const todayIsBusinessDay = await this.isBusinessDayIST(now, process.env.UPSTOX_API_KEY);
  const useCurrentDayData = isAfter4PM && todayIsBusinessDay;
  
  let todayISO, yesterdayISO, live;
  
  if (useCurrentDayData) {
    // Use current day data with V3 intraday endpoints
    todayISO = this.isoIST(now);                    // Current day
    yesterdayISO = this.isoIST(this.addDays(now, -1));
    live = true;                                    // Enable intraday endpoints
    console.log(`📊 [CANDLE URLs] Using CURRENT DAY intraday data (after 5.00 PM): ${todayISO}`);
  } else {
    // Use historical data only (for morning runs or before 5.00 PM)
    const previousDay = this.addDays(now, -1);     // Force previous day
    todayISO = this.isoIST(previousDay);            // Use previous day as "today"
    yesterdayISO = this.isoIST(this.addDays(previousDay, -1));
    live = false;                                   // Force not live to avoid intraday endpoints
    console.log(`📊 [CANDLE URLs] Using HISTORICAL data only (before 5.00 PM or non-business day): ${todayISO}`);
  }
  
  const frames = this.termToFrames[t] || [];
  
  // DEBUG: Clean endpoint creation summary
//   console.log(`🔍 ENDPOINT DEBUG: ${t.toUpperCase()} | Today: ${todayISO} | Live: ${live} | Frames: [${frames.join(',')}]`);
  
  const endpoints = [];

  // ---------- SWING/SHORT (Smart endpoint selection based on timing) ----------
  if (t === 'short' || t === 'shortterm' || t === 'swing') {
    // Targets for swing trading
    const TARGETS = { '15m': 200, '1h': 160, '1d': 260 };
    // Bars a typical trading day contributes for each frame
    const PER_DAY = { '15m': 25, '1h': 6, '1d': 1 };

    for (const f of frames) {
      const { n, u } = this.parseFrame(f);
      const target = TARGETS[f] ?? 0;
      const perDay = PER_DAY[f] ?? 0;

      if (target > 0) {
        if (useCurrentDayData && (f === '5m' || f === '15m' || f === '1h')) {
          // Use V3 Intraday API for current day data (after 5.00 PM)
          const intradayUrl = this.buildIntradayV3Url(instrument_key, f);
          
          endpoints.push({
            frame: f,
            kind: 'intraday_v3',
            url: intradayUrl,
            timeframe: f
          });
          
          console.log(`📊 [V3 INTRADAY] ${f}: ${intradayUrl}`);
          
          // For intraday timeframes, also get some historical context
          if (perDay > 0) {
            const historicalTarget = Math.floor(target * 0.7); // 70% from historical for context
            const businessDaysNeeded = Math.ceil(historicalTarget / perDay);
            
            const fromDate = await this.calculateHistoricalFromDate(yesterdayISO, businessDaysNeeded);
            const upHist = this.unitPath(u, 'historical');
            const historicalUrl = `https://api.upstox.com/v3/historical-candle/${instrument_key}/${upHist}/${n}/${yesterdayISO}/${fromDate}`;
            
            endpoints.push({
              frame: f,
              kind: 'historical_context',
              url: historicalUrl,
            });
            
            console.log(`📊 [HISTORICAL CONTEXT] ${f}: ${historicalUrl}`);
          }
        } else {
          // Use Historical API (before 5.00 PM, non-business day, or daily data)
          if (perDay > 0) {
            const businessDaysNeeded = Math.ceil(target / perDay);
            const referenceDate = useCurrentDayData ? yesterdayISO : todayISO;
            
            const fromDate = await this.calculateHistoricalFromDate(referenceDate, businessDaysNeeded);
            const upHist = this.unitPath(u, 'historical');
            const finalUrl = `https://api.upstox.com/v3/historical-candle/${instrument_key}/${upHist}/${n}/${referenceDate}/${fromDate}`;
            
            endpoints.push({
              frame: f,
              kind: 'historical',
              url: finalUrl,
            });
            
            console.log(`📊 [HISTORICAL] ${f}: ${finalUrl}`);
          }
        }
      }
    }

    return {
      endpoints,
      latestCandleUrl: null, // not needed for short
      sessionHasStarted: live,
      todayISO,
      todayIsBusinessDay,
    };
  }

  // ---------- MEDIUM (target-based: 1d/1W, optional 1h for timing) ----------
if (t === 'medium' || t === 'mediumterm') {
  // Targets for a robust medium-term review
  // 1d ≈ one trading year, 1W ≈ ~2+ years, 1h ≈ recent timing window
  const TARGETS = { '1d': 260, '1W': 120, '1h': 160 };
  // Bars contributed per active day/week
  const PER_DAY  = { '1h': 6, '1d': 1 };
  const PER_WEEK = { '1W': 1 };

  const minutesSoFar = this.getTradingMinutesElapsedIST(); // 0..375
  const todayIsBusinessDay = await this.isBusinessDayIST(now, process.env.UPSTOX_API_KEY);

  // Helper: go back N business days to get a fromDate that yields 'need' bars
  const backfillBusinessDays = async (startDate, need, perDay) => {
    let businessDays = Math.ceil(need / perDay);
    let currentDate = new Date(startDate);
    let fromDate = new Date(startDate);
    let daysChecked = 0, found = 0;

    while (found < businessDays && daysChecked < 365) {
      currentDate = this.addDays(currentDate, -1);
      if (await this.isBusinessDayIST(currentDate, process.env.UPSTOX_API_KEY)) {
        found++;
        fromDate = currentDate;
      }
      daysChecked++;
    }
    return fromDate;
  };

  // Helper: go back N business weeks (use week steps; 1W = 1 per week)
  const backfillBusinessWeeks = async (startDate, needWeeks) => {
    // anchor to last completed week if we're in a live session/business day
    // so we don’t include the partial current week
    let current = new Date(startDate);
    let fromDate = new Date(startDate);
    let weeksFound = 0, steps = 0;
    while (weeksFound < needWeeks && steps < 260) { // ~5 years
      current = this.addDays(current, -7);
      // if any business day exists in that week, count it
      // (simple approach: check the Friday of that week)
      const friday = this.addDays(current, 4); // Mon + 4 = Fri
      if (await this.isBusinessDayIST(friday, process.env.UPSTOX_API_KEY)) {
        weeksFound++;
        fromDate = friday;
      }
      steps++;
    }
    return fromDate;
  };

  for (const f of frames) {
    const { n, u } = this.parseFrame(f);

    // Get full target amount from historical data only (no live data)
    const target   = TARGETS[f] ?? 0;
    const perDay   = PER_DAY[f]  ?? 0;
    const perWeek  = PER_WEEK[f] ?? 0;
    let deficit    = target; // Need full target since no live data

    if (deficit > 0) {
      // Always start from previous day for historical data only
      let startDate;
      if (f === '1W') {
        // For weekly data, anchor to last completed week (use previous day as anchor)
        const anchor = previousDay;
        const weekday = anchor.getDay(); // 0=Sun..6=Sat
        // distance to last Friday (5)
        const deltaToFriday = (weekday >= 5) ? (weekday - 5) : (weekday + 2); 
        startDate = this.addDays(anchor, -deltaToFriday);
      } else {
        // For 1d and 1h, use previous day
        startDate = previousDay;
      }

      let fromDate;
      if (f === '1W' && perWeek > 0) {
        fromDate = await backfillBusinessWeeks(startDate, Math.ceil(deficit / perWeek));
      } else if (perDay > 0) {
        fromDate = await backfillBusinessDays(startDate, deficit, perDay);
      }

      const upHist = this.unitPath(u, 'historical');
      endpoints.push({
        frame: f,
        kind: 'historical',
        url: `https://api.upstox.com/v3/historical-candle/${instrument_key}/${upHist}/${n}/${this.isoIST(startDate)}/${this.isoIST(fromDate)}`,
      });
    }
  }

  return {
    endpoints,
    latestCandleUrl: null, // not needed for medium
    sessionHasStarted: live,
    todayISO,
    todayIsBusinessDay,
  };
}

  // ---------- DEFAULT/FALLBACK (historical data only) ----------
  const lookbacks = {
    m: { from: this.addMonths(previousDay, -1),  to: previousDay },
    h: { from: this.addMonths(previousDay, -3),  to: previousDay },
    d: { from: this.addYears (previousDay, -3),  to: previousDay },
    w: { from: this.addYears (previousDay, -10), to: previousDay },
  };

  frames.forEach((f) => {
    const { n, u } = this.parseFrame(f);
    const upHist  = this.unitPath(u, 'historical');

    // historical window for context (no intraday)
    const { from, to } = lookbacks[u] || {};
    if (from && to) {
      endpoints.push({
        frame: f,
        kind: 'historical',
        url: `https://api.upstox.com/v3/historical-candle/${instrument_key}/${upHist}/${n}/${this.isoIST(to)}/${this.isoIST(from)}`,
      });
    }
  });

  return {
    endpoints,
    latestCandleUrl: null,
    sessionHasStarted: false,
    todayISO,
  };
}

/**
 * Build V3 Intraday URL for current day data
 */
buildIntradayV3Url(instrumentKey, timeframe) {
  // Map our timeframes to V3 API format
  const timeframeMapping = {
    '5m': { unit: 'minutes', interval: '5' },
    '15m': { unit: 'minutes', interval: '15' },
    '30m': { unit: 'minutes', interval: '30' },
    '1h': { unit: 'hours', interval: '1' },
    '2h': { unit: 'hours', interval: '2' },
    '1d': { unit: 'days', interval: '1' }
  };

  const mapping = timeframeMapping[timeframe];
  if (!mapping) {
    throw new Error(`Unsupported timeframe for V3 intraday API: ${timeframe}`);
  }

  // V3 Intraday API URL format: 
  // https://api.upstox.com/v3/historical-candle/intraday/{instrument_key}/{unit}/{interval}
  return `https://api.upstox.com/v3/historical-candle/intraday/${instrumentKey}/${mapping.unit}/${mapping.interval}`;
}

/**
 * Calculate historical from date by going back specified business days
 */
async calculateHistoricalFromDate(startDateISO, businessDaysNeeded) {
  const startDate = new Date(startDateISO);
  let currentDate = new Date(startDate);
  let businessDaysFound = 0;
  let daysChecked = 0;
  let fromDate = new Date(startDate);

  while (businessDaysFound < businessDaysNeeded && daysChecked < 365) {
    currentDate = this.addDays(currentDate, -1);
    const isBusinessDay = await this.isBusinessDayIST(currentDate, process.env.UPSTOX_API_KEY);
    
    if (isBusinessDay) {
      businessDaysFound++;
      fromDate = currentDate;
    }
    daysChecked++;
  }

  return this.isoIST(fromDate);
}

/**
 * Check if a date is a business day (not weekend or holiday)
 * Uses Upstox API to fetch holidays for the year
 */
async isBusinessDayIST(date = new Date(), upstoxToken = null) {
  // Convert 'date' to IST calendar day
  const ist = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay(); // 0=Sun .. 6=Sat
  const dateISO = ist.toISOString().slice(0, 10); // YYYY-MM-DD

  // Weekend check (Saturday=6, Sunday=0)
  if (day === 0 || day === 6) {
    return false;
  }

  // Get holidays for this year
  const year = ist.getFullYear();
  const holidays = await this.fetchMarketHolidays(year, upstoxToken);

  // Check if this date is a holiday
  const isHoliday = holidays.has(dateISO);
  
  if (isHoliday) {
   // console.log(`🏖️ HOLIDAY: ${dateISO} is a market holiday`);
  }
  
  return !isHoliday;
}

getTradingMinutesElapsedIST() {
  const { hours, minutes } = this.getCurrentIST('object'); // your helper
  const total = hours * 60 + minutes;

  const OPEN  = 9 * 60 + 15;   // 09:15
  const CLOSE = 15 * 60 + 30;  // 15:30
  const LEN   = CLOSE - OPEN;  // 375

  if (total <= OPEN)  return 0;
  if (total >= CLOSE) return LEN;
  return total - OPEN;
}


  /**
   * Fetch candle data from Upstox API
   */
  async fetchCandleData(url) {
//     console.log(`📡 Fetching candle data from: ${url}`);
    
    // DEBUG: Log URL details - Upstox uses path params, not query params
    const urlParts = url.split('/');
    const isIntraday = url.includes('/intraday/');
    const instrument = isIntraday ? urlParts[5] : urlParts[4];
    const interval = isIntraday ? 
      `${urlParts[6]}/${urlParts[7]}` : // intraday: minutes/15
      `${urlParts[5]}/${urlParts[6]}`; // historical: minutes/15
    const toDate = isIntraday ? 'TODAY' : urlParts[7];
    const fromDate = isIntraday ? 'TODAY' : urlParts[8];
    
//     console.log(`📡 FETCH: ${instrument} | ${interval} | ${fromDate} → ${toDate}`);
    
    try {
      const response = await axios.get(url, {
        headers: {
          'x-api-key': this.upstoxApiKey
        }
      });
      
      // Check if data exists in nested structure
      const actualCandles = response.data?.data?.candles || response.data?.candles;
//       console.log(`✅ Candle data received: ${actualCandles?.length || 0} candles`);
      
      // DEBUG: Check response structure
      if (!actualCandles && response.data) {
//         console.log(`❌ RESPONSE STRUCTURE ISSUE:`, Object.keys(response.data));
//         console.log(`   Raw response.data:`, JSON.stringify(response.data).substring(0, 200));
      }
      
      // DEBUG: Check candle order for both API types
      if (actualCandles?.length > 0) {
        const firstCandle = actualCandles[0];
        const lastCandle = actualCandles[actualCandles.length - 1];
        const isIntraday = url.includes('/intraday/');
        
//         console.log(`   📈 ${isIntraday ? 'INTRADAY' : 'HISTORICAL'} - ${actualCandles.length} candles`);
//         console.log(`   🕐 Array[0]: ${firstCandle[0]} | Close: ${firstCandle[4]}`);
//         console.log(`   🕐 Array[-1]: ${lastCandle[0]} | Close: ${lastCandle[4]}`);
        
        // Determine chronological order
        const firstTime = new Date(firstCandle[0]).getTime();
        const lastTime = new Date(lastCandle[0]).getTime();
        const isNewestFirst = firstTime > lastTime;
        
//         console.log(`   📊 ORDER: ${isNewestFirst ? 'NEWEST→OLDEST' : 'OLDEST→NEWEST'} | API: ${isIntraday ? 'intraday' : 'historical'}`);
      }
      
      // If no candles (market closed), return empty structure
      if (!actualCandles || actualCandles.length === 0) {
//         console.warn('⚠️ No candle data available (market may be closed)');
        return {
          status: 'success',
          candles: [],
          message: 'No candle data available'
        };
      }
      
      // Ensure we return the correct structure
      if (response.data?.data?.candles) {
        // Upstox format: { status, data: { candles: [...] } }
        return response.data.data;
      }
      
      return response.data;
    } catch (error) {
//       console.error(`❌ Failed to fetch candle data from ${url}:`, error.message);
      return {
        status: 'error',
        candles: [],
        message: `API Error: ${error.message}`
      };
    }
  }


  routeToTradingAgent(tradeData, candleSets, newsData) {
    const t = (tradeData.term || '').toLowerCase();

    console.log(`\n${'='.repeat(80)}`);
    console.log(`🎯 [ROUTE TO AGENT] Starting data routing for term: ${t}`);
    console.log(`${'='.repeat(80)}`);

    // candleSets is now clean: { '15m': [candles], '1h': [candles], '1d': [candles] }
    console.log(`\n🔍 [ROUTE INPUT] candleSets received:`);
    console.log(`   ├─ Type: ${typeof candleSets}`);
    console.log(`   ├─ Is null/undefined: ${candleSets == null}`);
    console.log(`   ├─ Keys present: ${candleSets ? Object.keys(candleSets).join(', ') : 'none'}`);

    if (candleSets) {
      Object.keys(candleSets).forEach(key => {
        const value = candleSets[key];
        console.log(`   ├─ [${key}] type: ${Array.isArray(value) ? 'array' : typeof value}, length: ${value?.length || 0}`);
        if (Array.isArray(value) && value.length > 0) {
          console.log(`   │   └─ Sample[0]:`, value[0]);
        }
      });
    }

    const timeframeData = candleSets || {};
    console.log(`\n📋 [ROUTE] timeframeData keys after assignment: ${Object.keys(timeframeData).join(', ')}`);

    // Create labeled data from our clean timeframe structure
    console.log(`\n🏗️  [ROUTE] Creating labeledData structure...`);
    const labeledData = Object.keys(timeframeData).map((timeframe) => {
      const candles = timeframeData[timeframe] || [];
      console.log(`   ├─ Processing ${timeframe}: ${candles.length} candles`);

      return {
        frame: timeframe,
        candles: candles,  // Direct candle array
        data: {
          candles: candles,
          status: candles.length > 0 ? 'success' : 'error',
          message: candles.length > 0 ? `${candles.length} candles loaded` : 'No data'
        }
      };
    });

    console.log(`\n✅ [ROUTE] Created labeledData with ${labeledData.length} items`);

    // Filter out endpoints with no valid candle data for debugging
    const validData = labeledData.filter(item => 
      item.data && 
      item.data.candles && 
      Array.isArray(item.data.candles) && 
      item.data.candles.length > 0
    );

//     console.log(`📊 Data summary: ${labeledData.length} total endpoints, ${validData.length} with valid candles`);
    
    // Log each endpoint's data status
    labeledData.forEach((item) => {
      const candleCount = item.data?.candles?.length || 0;
//       console.log(`  ${item.frame} (${item.kind}): ${candleCount} candles - ${item.data?.message || 'No message'}`);
    });
  
    if (t === 'intraday') {
      return this.runIntradayAgent(labeledData,tradeData, newsData);
    }
  
    if (t === 'short' || t === 'shortterm') {
      return this.runShortTermAgent(labeledData,tradeData, newsData);
    }
  
    if (t === 'medium' || t === 'mediumterm') {
      return this.runMediumTermAgent(labeledData, tradeData,newsData);
    }
  
  
//     console.warn(`⚠️ No matching agent found for term: ${t}`);
    return null;
  }



  /**
 * Intraday Agent
 * Takes raw labeled endpoints + news and returns a pro-grade intraday package.
 * Expects:
 *  - labeledData: [{ frame:'1m'|'3m'|'15m', kind:'intraday'|'historical', url, candles:[...upstox arrays...] }, ...]
 *  - tradeData: { entryPrice, stopLoss, targetPrice, ... }  // optional, for overlays
 *  - newsData: whatever your news fetcher returns
 */
async runIntradayAgent(labeledData, tradeData = {}, newsData = null) {
  // ---------- helpers ----------

  const sortByTime = (a,b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0);

  // merge + dedupe by timestamp (last write wins), keep asc
  const mergeCandles = (...lists) => {
    const m = new Map();
    lists.flat().forEach(c => m.set(c.time, c));
    return [...m.values()].sort(sortByTime);
  };

  // frame → limit we want to SHOW (add a buffer for stable indicators)
  const LIMITS = { '1m': 375, '3m': 125, '15m': 50 };
  const BUF = 50; // extra bars for indicator warm-up
  const take = (arr, frame) => arr.slice(-(LIMITS[frame] + BUF));

  // which indicators to compute per frame (only the ones you actually implemented)
  // NOTE: you don’t have a MACD function in the code you shared. Remove it for now.
  const INDSET = {
    '1m':  ['ema9','ema20','vwap','rsi14','volumeSpike'],        // execution frame
    '3m':  ['ema9','ema20','vwap','rsi14','atr14','volumeSpike'],// momentum confirm
    '15m': ['ema9','ema20','sma50','vwap','rsi14','atr14'],      // bias + levels
  };

  // ---------- build byFrame = { '1m': [candles], '3m': [candles], ... } ----------
  // Simplified structure with direct candle arrays per timeframe
  const byFrame = (labeledData && Array.isArray(labeledData)) ? labeledData.reduce((acc, x) => {
    const frame = x.frame; // '1m'|'3m'|'15m'
    if (!frame) return acc;

    const arr = Array.isArray(x.data?.candles) ? x.data.candles : x.candles;
    if (Array.isArray(arr)) {
      acc[frame] = arr; // Direct assignment - no intraday/historical complexity
    }
    return acc;
  }, {}) : {};

  const out = { term: 'intraday', frames: {}, overlays: {}, news: newsData, meta: {} };

  // simplified builder for a frame
  const buildFrame = (frame) => {
    const candles = byFrame[frame] || [];
    
    if (!candles.length) return null;

    // Convert to our standard format and sort (standardize timestamp -> time)
    // Support both array format [timestamp, open, high, low, close, volume] and object format
    const rawCandles = candles.map(candle => {
      const isArray = Array.isArray(candle);
      return {
        time: isArray ? candle[0] : (candle.timestamp || candle.time),
        open: isArray ? +candle[1] : +candle.open,
        high: isArray ? +candle[2] : +candle.high,
        low: isArray ? +candle[3] : +candle.low,
        close: isArray ? +candle[4] : +candle.close,
        volume: isArray ? +candle[5] : +candle.volume
      };
    });
    
    // trim to limit + buffer, then compute indicators on trimmed
    const trimmed = take(rawCandles, frame);
    const indicators = this._computeIntradaySelectedIndicators(trimmed, INDSET[frame]);

    return { candles: trimmed, indicators };
  };

  // Build each requested frame if present
  ['1m','3m','15m'].forEach(f => {
    const built = buildFrame(f);
    if (built) out.frames[f] = built;
  });

  // ---------- Opening Range (first 30 mins) using 1m (preferred) or 15m fallback ----------
  // If you already have a 1m ORB function, prefer that. Otherwise keep your 15m version.
  if (out.frames['1m']?.candles?.length) {
    const orb1m = this._calcOpeningRangeBox1m?.(out.frames['1m'].candles);
    if (orb1m) out.frames['1m'].openingRange = orb1m;
  } else if (out.frames['15m']?.candles?.length) {
    const orb15 = this._calcOpeningRangeBox?.(out.frames['15m'].candles);
    if (orb15) out.frames['15m'].openingRange = orb15;
  }

  // ---------- Suggested trade overlays ----------
  const { entryPrice, stopLoss, targetPrice } = tradeData || {};
  if (entryPrice || stopLoss || targetPrice) {
    out.overlays.levels = {
      entry:  entryPrice  ? { price: +entryPrice,  label: 'Entry' }  : null,
      stop:   stopLoss    ? { price: +stopLoss,    label: 'Stop' }   : null,
      target: targetPrice ? { price: +targetPrice, label: 'Target' } : null,
    };
  }

  // ---------- Diagnostics / meta ----------
  const have = f => !!out.frames[f]?.candles?.length;
  out.meta.dataHealth = {
    counts: {
      '1m': out.frames['1m']?.candles?.length || 0,
      '3m': out.frames['3m']?.candles?.length || 0,
      '15m': out.frames['15m']?.candles?.length || 0,
    },
    has1m: have('1m'),
    has3m: have('3m'),
    has15m: have('15m'),
    missing: ['1m','3m','15m'].filter(f => !have(f)),
  };

  return out;
}


async  runShortTermAgent(labeledData, tradeData = {}, newsData = null) {
  // ---------- helpers ----------

  const sortByTime = (a,b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0);

  // merge + dedupe by timestamp (last write wins), keep asc
  const mergeCandles = (...lists) => {
    const m = new Map();
    lists.flat().forEach(c => m.set(c.time, c));
    return [...m.values()].sort(sortByTime);
  };

  // frame → limit we want to SHOW (add buffer for indicator warm-up)
  const LIMITS = { '15m': 200, '1h': 160, '1d': 260 }; // ~2-12 months depending on frame
  const BUF = 50;
  const take = (arr, frame) => arr.slice(-(LIMITS[frame] + BUF));

  // indicators per frame (exclude MACD unless you’ve implemented it)
  const INDSET = {
    '15m': ['ema9','ema20','sma50','vwap','rsi14','atr14','volumeSpike'], // entry timing
    '1h': ['ema20','ema50','sma200','rsi14','atr14'],                    // structure + momentum
    '1d' : ['ema20','ema50','sma200','rsi14','atr14','pivotClassic']      // bias + big levels
  };

  // ---------- build byFrame = { '15m': [candles], '1h': [candles], ... } ----------
  // Simplified structure with direct candle arrays per timeframe
  console.log(`\n🔍 [DATA FLOW DEBUG] Starting byFrame construction...`);
  console.log(`   ├─ labeledData is Array: ${Array.isArray(labeledData)}`);
  console.log(`   ├─ labeledData length: ${labeledData?.length || 0}`);

  if (labeledData && Array.isArray(labeledData)) {
    labeledData.forEach((item, idx) => {
      console.log(`   ├─ [${idx}] frame: ${item.frame}, has data: ${!!item.data}, has candles in data: ${!!item.data?.candles}, candles is array: ${Array.isArray(item.data?.candles)}, candles count: ${item.data?.candles?.length || 0}`);
      console.log(`   │   └─ has direct candles: ${!!item.candles}, direct candles is array: ${Array.isArray(item.candles)}, direct candles count: ${item.candles?.length || 0}`);
    });
  }

  const byFrame = (labeledData && Array.isArray(labeledData)) ? labeledData.reduce((acc, x) => {
    const frame = x.frame; // '15m'|'1h'|'1d'
    if (!frame) {
      console.log(`   ⚠️  [byFrame] Skipping item with no frame property`);
      return acc;
    }

    const arr = Array.isArray(x.data?.candles) ? x.data.candles : x.candles;
    if (Array.isArray(arr)) {
      acc[frame] = arr; // Direct assignment - no intraday/historical complexity
      console.log(`   ✅ [byFrame] Added ${frame}: ${arr.length} candles`);
    } else {
      console.log(`   ⚠️  [byFrame] ${frame}: No valid candle array found (data.candles type: ${typeof x.data?.candles}, direct candles type: ${typeof x.candles})`);
    }
    return acc;
  }, {}) : {};

  console.log(`\n📊 [byFrame RESULT] Available timeframes: ${Object.keys(byFrame).join(', ')}`);
  Object.keys(byFrame).forEach(tf => {
    console.log(`   └─ ${tf}: ${byFrame[tf].length} candles`);
  });

  const out = { term: 'short', frames: {}, overlays: {}, news: newsData, meta: {} };

  // simplified builder for a frame
  const buildFrame = (frame) => {
    console.log(`\n🔨 [BUILD FRAME] Starting build for ${frame}...`);
    const candles = byFrame[frame] || [];
    console.log(`   ├─ Found ${candles.length} candles in byFrame[${frame}]`);

    if (!candles.length) {
      console.log(`   └─ ❌ No candles available, returning null`);
      return null;
    }

    // Convert to our standard format and sort (standardize timestamp -> time)
    // Support both array format [timestamp, open, high, low, close, volume] and object format
    console.log(`   ├─ Sample candle[0] type: ${Array.isArray(candles[0]) ? 'array' : 'object'}`);
    console.log(`   ├─ Sample candle[0] keys:`, candles[0] ? Object.keys(candles[0]) : 'none');
    console.log(`   ├─ Sample candle[0] values:`, candles[0]);

    const rawCandles = candles.map(candle => {
      const isArray = Array.isArray(candle);
      return {
        time: isArray ? candle[0] : (candle.timestamp || candle.time),
        open: isArray ? +candle[1] : +candle.open,
        high: isArray ? +candle[2] : +candle.high,
        low: isArray ? +candle[3] : +candle.low,
        close: isArray ? +candle[4] : +candle.close,
        volume: isArray ? +candle[5] : +candle.volume
      };
    });

    console.log(`   ├─ Converted ${rawCandles.length} candles to standard format`);
    console.log(`   ├─ Sample converted[0].time: ${rawCandles[0]?.time}`);
    console.log(`   ├─ Sample converted[0].close: ${rawCandles[0]?.close}`);
   
    
    // trim to limit + buffer, then compute indicators on trimmed
    const trimmed = take(rawCandles, frame);
    const indicators = this._computeShortSelectedIndicators(trimmed, INDSET[frame]);
    
    console.log(`📊 [INDICATOR DEBUG] Frame ${frame}: calculated ${Object.keys(indicators || {}).length} indicators`);
    if (indicators?.error) {
      console.error(`❌ [INDICATOR ERROR] Frame ${frame}: ${indicators.error}`);
    }
    
    return { candles: trimmed, indicators };
  };
  
  ['15m','1h','1d'].forEach(timeframe => {
    const built = buildFrame(timeframe);
    if (built) {
      out.frames[timeframe] = built;
      console.log(`📊 [FRAME BUILT] ${timeframe}: ${built.candles?.length || 0} candles, ${Object.keys(built.indicators || {}).length} indicators`);
    } else {
      console.log(`⚠️ [FRAME MISSING] No data for ${timeframe}`);
    }
  });

  // ---------- Swing context (prev day / weekly / gaps) ----------
  const daily = out.frames['1d']?.candles || [];
  if (daily.length) {
    // Previous day high/low/close
    const last = daily[daily.length - 1];
    const prev = daily[daily.length - 2];

    if (prev && out.frames['1d']) {
      out.frames['1d'].prevSession = {
        high: prev.high, low: prev.low, close: prev.close, date: prev.time
      };
    }

    // Rolling weekly range (last 5 daily bars)
    const week = daily.slice(-5);
    if (week.length) {
      const wh = Math.max(...week.map(c => c.high));
      const wl = Math.min(...week.map(c => c.low));
      if (out.frames['1d']) {
        out.frames['1d'].weeklyRange = { high: wh, low: wl };
      }
    }
  }

  // Gap detection (compare last daily close vs first 15m open of current session)
  const m15 = out.frames['15m']?.candles || [];
  if (daily.length && m15.length) {
    const lastDailyClose = daily[daily.length - 1]?.close;
    // first 15m of the latest day present
    const dayKey = (ts) => new Date(ts).toISOString().slice(0,10);
    const latestDay = dayKey(m15[m15.length - 1].time);
    const first15mToday = m15.find(c => dayKey(c.time) === latestDay);
    if (first15mToday && Number.isFinite(lastDailyClose)) {
      const gapPct = ((first15mToday.open - lastDailyClose) / lastDailyClose) * 100;
      out.meta.gap = { open: first15mToday.open, prevClose: lastDailyClose, pct: +gapPct.toFixed(2) };
    }
  }

  // Optional: higher-timeframe bias from 1d EMAs
  if (out.frames['1d']?.indicators) {
    const indD = out.frames['1d'].indicators;
    const lastClose = daily[daily.length - 1]?.close;
    const ema20 = indD.ema20?.[indD.ema20.length - 1];
    const ema50 = indD.ema50?.[indD.ema50.length - 1];

    if (Number.isFinite(lastClose) && Number.isFinite(ema20) && Number.isFinite(ema50)) {
      out.meta.bias = {
        trend: (ema20 > ema50 && lastClose > ema20) ? 'bullish'
              : (ema20 < ema50 && lastClose < ema20) ? 'bearish'
              : 'neutral'
      };
    }
  }

  // ---------- Suggested trade overlays ----------
  const { entryPrice, stopLoss, targetPrice } = tradeData || {};
  if (entryPrice || stopLoss || targetPrice) {
    out.overlays.levels = {
      entry:  entryPrice  ? { price: +entryPrice,  label: 'Entry' }  : null,
      stop:   stopLoss    ? { price: +stopLoss,    label: 'Stop' }   : null,
      target: targetPrice ? { price: +targetPrice, label: 'Target' } : null,
    };
  }

  // ---------- Diagnostics / meta ----------
  const have = f => !!out.frames[f]?.candles?.length;
  out.meta.dataHealth = {
    counts: {
      '15m': out.frames['15m']?.candles?.length || 0,
      '1h': out.frames['1h']?.candles?.length || 0,
      '1d' : out.frames['1d']?.candles?.length || 0,
    },
    has15m: have('15m'),
    has1h: have('1h'),
    has1d:  have('1d'),
    missing: ['15m','1h','1d'].filter(f => !have(f)),
  };

  return out;
}


async runMediumTermAgent(labeledData, tradeData = {}, newsData = null) {
  // ---------- helpers ----------

  const sortByTime = (a,b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0);

  // merge + dedupe by timestamp (last write wins), keep asc
  const mergeCandles = (...lists) => {
    const m = new Map();
    lists.flat().forEach(c => m.set(c.time, c));
    return [...m.values()].sort(sortByTime);
  };

  // frame → limit we want to SHOW (add buffer for indicator warm-up)
  const LIMITS = { '15m': 200, '1h': 160, '1d': 260 }; // swing trading timeframes
  const BUF = 50;
  const take = (arr, frame) => arr.slice(-(LIMITS[frame] + BUF));

  // indicators per frame
  const INDSET = {
    '15m': ['ema20','ema50','rsi14','atr14','vwap'],              // intraday timing
    '1h': ['ema20','ema50','rsi14','atr14'],                      // timing within swing
    '1d': ['ema20','ema50','sma200','rsi14','atr14','pivotClassic'], // primary bias + levels
  };

  // ---------- structure incoming data -> byFrame ----------
  // Simplified: direct timeframe to candles mapping
  const byFrame = (labeledData && Array.isArray(labeledData)) ? labeledData.reduce((acc, x) => {
    const frame = x.frame; // '15m'|'1h'|'1d'
    if (!frame) return acc;

    const arr = Array.isArray(x.data?.candles) ? x.data.candles : x.candles;
    if (Array.isArray(arr)) {
      acc[frame] = arr; // Direct assignment - no intraday/historical complexity
    }
    return acc;
  }, {}) : {};

  const out = { term: 'medium', frames: {}, overlays: {}, news: newsData, meta: {} };

  // simplified builder for a frame
  const buildFrame = (frame) => {
    const candles = byFrame[frame] || [];
    
    if (!candles.length) return null;

    // Convert to our standard format and sort (standardize timestamp -> time)
    // Support both array format [timestamp, open, high, low, close, volume] and object format
    const rawCandles = candles.map(candle => {
      const isArray = Array.isArray(candle);
      return {
        time: isArray ? candle[0] : (candle.timestamp || candle.time),
        open: isArray ? +candle[1] : +candle.open,
        high: isArray ? +candle[2] : +candle.high,
        low: isArray ? +candle[3] : +candle.low,
        close: isArray ? +candle[4] : +candle.close,
        volume: isArray ? +candle[5] : +candle.volume
      };
    });
    
    // trim to limit + buffer, then compute indicators on trimmed
    const trimmed = take(rawCandles, frame);
    const compute = (this._computeMediumSelectedIndicators || this._computeShortSelectedIndicators).bind(this);
    const indicators = compute(trimmed, INDSET[frame]);
    return { candles: trimmed, indicators };
  };

  // Build each requested frame if present - changed to support swing trading
  ['15m','1h','1d'].forEach(f => {
    const built = buildFrame(f);
    if (built) out.frames[f] = built;
  });

  // ---------- Context layers ----------
  const daily  = out.frames['1d']?.candles || [];
  const hourly = out.frames['1h']?.candles || [];

  // Previous day / week context
  if (daily.length) {
    const prevD = daily[daily.length - 2];
    if (prevD) {
      out.frames['1d'].prevSession = {
        high: prevD.high, low: prevD.low, close: prevD.close, date: prevD.time
      };
    }
    // Rolling weekly range from daily (last 5 trading days)
    const weekSlice = daily.slice(-5);
    if (weekSlice.length) {
      const wh = Math.max(...weekSlice.map(c => c.high));
      const wl = Math.min(...weekSlice.map(c => c.low));
      if (out.frames['1d']) {
        out.frames['1d'].weeklyRange = { high: wh, low: wl };
      }
    }
  }

  // Weekly swing levels from 1W candles
  if (weekly.length) {
    const lastW = weekly[weekly.length - 1];
    const prevW = weekly[weekly.length - 2];
    if (prevW) {
      out.frames['1W'].prevWeek = {
        high: prevW.high, low: prevW.low, close: prevW.close, date: prevW.time
      };
    }
    // 4-week swing range
    const w4 = weekly.slice(-4);
    if (w4.length) {
      const swH = Math.max(...w4.map(c => c.high));
      const swL = Math.min(...w4.map(c => c.low));
      out.frames['1W'].swing4W = { high: swH, low: swL };
    }
  }

  // Bias from 1d and 1W EMAs
  const biasFrom = (frameKey) => {
    const fr = out.frames[frameKey];
    if (!fr?.indicators || !fr?.candles?.length) return null;
    const lastClose = fr.candles[fr.candles.length - 1].close;
    const ema20 = fr.indicators.ema20?.[fr.indicators.ema20.length - 1];
    const ema50 = fr.indicators.ema50?.[fr.indicators.ema50.length - 1];
    if (![lastClose, ema20, ema50].every(Number.isFinite)) return null;

    return (ema20 > ema50 && lastClose > ema20) ? 'bullish'
         : (ema20 < ema50 && lastClose < ema20) ? 'bearish'
         : 'neutral';
  };

  out.meta.bias = {
    d1: biasFrom('1d') || 'unknown',
    w1: biasFrom('1W') || 'unknown'
  };

  // ---------- Suggested trade overlays ----------
  const { entryPrice, stopLoss, targetPrice } = tradeData || {};
  if (entryPrice || stopLoss || targetPrice) {
    out.overlays.levels = {
      entry:  entryPrice  ? { price: +entryPrice,  label: 'Entry' }  : null,
      stop:   stopLoss    ? { price: +stopLoss,    label: 'Stop' }   : null,
      target: targetPrice ? { price: +targetPrice, label: 'Target' } : null,
    };
  }

  // ---------- Quick R/R & ATR-multiple check (daily ATR) ----------
  if ([entryPrice, stopLoss, targetPrice].every(v => Number.isFinite(+v)) && daily.length) {
    const indD = out.frames['1d']?.indicators || {};
    const atrD = indD.atr14?.[indD.atr14.length - 1];
    const rr   = (targetPrice - entryPrice) / (entryPrice - stopLoss);
    let riskATR = null, rewardATR = null;

    if (Number.isFinite(atrD) && atrD > 0) {
      riskATR   = Math.abs(entryPrice - stopLoss) / atrD;
      rewardATR = Math.abs(targetPrice - entryPrice) / atrD;
    }

    out.meta.rr = {
      rr: +rr.toFixed(2),
      riskATR: riskATR != null ? +riskATR.toFixed(2) : null,
      rewardATR: rewardATR != null ? +rewardATR.toFixed(2) : null,
      notes: (rr >= 1.5 ? 'meets' : 'below') + ' typical medium-term threshold'
    };
  }

  // ---------- Diagnostics / data health ----------
  const have = f => !!out.frames[f]?.candles?.length;
  out.meta.dataHealth = {
    counts: {
      '1h': out.frames['1h']?.candles?.length || 0,
      '1d': out.frames['1d']?.candles?.length || 0,
      '1W': out.frames['1W']?.candles?.length || 0,
    },
    has1h: have('1h'),
    has1D: have('1d'),
    has1W: have('1W'),
    missing: ['1h','1d','1W'].filter(f => !have(f)),
  };

  return out;
}

  // This is a placeholder for your short-term agent logic.

/**
 * Compute only selected indicators on a candle array (uses your existing methods).
 * candles: [{time,open,high,low,close,volume}, ...]
 * keys: ['ema9','ema20','vwap','rsi14','atr14','sma50','macd','volumeSpike']
 */

calculateEMA(candles, period, field = 'close') {
  if (!Array.isArray(candles) || candles.length === 0) return [];

  const k = 2 / (period + 1);
  let prevEMA = null;

  return candles.map((c, idx) => {
    const price = c[field];
    if (idx === 0) {
      prevEMA = price; // seed EMA with first price
    } else {
      prevEMA = price * k + prevEMA * (1 - k);
    }
    return { ...c, [`ema${period}`]: prevEMA };
  });
}

calculateSMA(candles, period, field = 'close') {
  if (!Array.isArray(candles) || candles.length === 0) return [];

  let sum = 0;
  const result = candles.map((c, idx) => {
    const price = c[field];
    sum += price;

    if (idx >= period) {
      sum -= candles[idx - period][field];
    }

    const smaValue = idx >= period - 1 ? sum / period : null;

    return { ...c, [`sma${period}`]: smaValue };
  });

  return result;
}

calculateRSI(candles, period = 14) {
  if (!candles || candles.length < period + 1) return [];
  const rsi = [];
  let gains = 0, losses = 0;

  // Initial average gain/loss
  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change >= 0) gains += change;
    else losses -= change;
  }
  gains /= period;
  losses /= period;
  rsi[period] = 100 - (100 / (1 + (gains / (losses || 1))));

  // Rest of the series
  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change >= 0) {
      gains = (gains * (period - 1) + change) / period;
      losses = (losses * (period - 1)) / period;
    } else {
      gains = (gains * (period - 1)) / period;
      losses = (losses * (period - 1) - change) / period;
    }
    rsi[i] = 100 - (100 / (1 + (gains / (losses || 1))));
  }

  return rsi;
}

calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return [];
  const atr = [];

  const trueRanges = candles.map((c, i) => {
    if (i === 0) return 0;
    const highLow = c.high - c.low;
    const highClosePrev = Math.abs(c.high - candles[i - 1].close);
    const lowClosePrev = Math.abs(c.low - candles[i - 1].close);
    return Math.max(highLow, highClosePrev, lowClosePrev);
  });

  // Initial ATR
  let sum = trueRanges.slice(1, period + 1).reduce((a, b) => a + b, 0);
  atr[period] = sum / period;

  // Smoothed ATR
  for (let i = period + 1; i < trueRanges.length; i++) {
    atr[i] = ((atr[i - 1] * (period - 1)) + trueRanges[i]) / period;
  }

  return atr;
}

calculateVWAP(candles) {
  if (!candles || candles.length === 0) return [];
  const vwap = [];
  let cumulativePV = 0;
  let cumulativeVol = 0;

  candles.forEach((c, i) => {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumulativePV += typicalPrice * c.volume;
    cumulativeVol += c.volume;
    vwap[i] = cumulativePV / (cumulativeVol || 1);
  });

  return vwap;
}

 calculateVolumeSpike(candles, lookback = 20, multiplier = 2) {
  if (!candles || candles.length < lookback) return [];
  const spikes = [];

  for (let i = 0; i < candles.length; i++) {
    if (i < lookback) {
      spikes[i] = false;
      continue;
    }
    const avgVol = candles.slice(i - lookback, i)
      .reduce((sum, c) => sum + c.volume, 0) / lookback;
    spikes[i] = candles[i].volume > avgVol * multiplier;
  }

  return spikes;
}


_computeIntradaySelectedIndicators(candles, keys) {
  if (!candles || candles.length < 20) return { error: 'Insufficient data' };

  const out = {};
  try {
    if (keys.includes('ema9'))  out.ema9  = this.calculateEMA(candles, 9);
    if (keys.includes('ema20')) out.ema20 = this.calculateEMA(candles, 20);

    if (keys.includes('sma50'))  out.sma50  = this.calculateSMA(candles, Math.min(50, candles.length));
    if (keys.includes('sma200')) out.sma200 = this.calculateSMA(candles, Math.min(200, candles.length)); // not used in intraday

    if (keys.includes('rsi14')) out.rsi14 = this.calculateRSI(candles, 14);
    if (keys.includes('atr14')) out.atr14 = this.calculateATR(candles, 14);
    if (keys.includes('vwap'))  out.vwap  = this.calculateVWAP(candles);
    if (keys.includes('volumeSpike')) out.volumeSpike = this.calculateVolumeSpike(candles, 20);

    // optional MACD helper; if you don't have it yet, remove this branch
    if (keys.includes('macd') && this.calculateMACD) {
      out.macd = this.calculateMACD(candles, { fast: 12, slow: 26, signal: 9 });
    }

    const last = candles.at(-1)?.close ?? 0;
    out.pricePosition = {
      aboveEMA9 : out.ema9  ? last > (out.ema9.at(-1)  ?? 0) : undefined,
      aboveEMA20: out.ema20 ? last > (out.ema20.at(-1) ?? 0) : undefined,
      aboveSMA50: out.sma50 ? last > (out.sma50.at(-1) ?? 0) : undefined,
      aboveVWAP : out.vwap  ? last > (out.vwap.at(-1)  ?? 0) : undefined,
    };
  } catch (err) {
//     console.error('Indicator calc failed:', err);
    out.error = 'Indicator calculation failed';
  }

  return out;
}

_computeShortSelectedIndicators(candles, keys) {
  console.log(`🔍 [INDICATOR DEBUG] Computing indicators for ${candles?.length || 0} candles`);
  console.log(`   - Keys requested:`, keys);
  console.log(`   - Sample candle structure:`, candles?.[0] ? Object.keys(candles[0]) : 'none');
  console.log(`   - Sample candle values:`, candles?.[0]);
  
  if (!Array.isArray(candles) || candles.length < 20) {
    console.log(`❌ [INDICATOR DEBUG] Insufficient data: ${candles?.length || 0} candles (need ≥20)`);
    return { error: 'Insufficient data' };
  }

  const n = candles.length;
  const lastClose = candles[n - 1]?.close ?? 0;
  console.log(`   - Last close: ${lastClose}`);
  const out = {};

  // small helpers
  const lastVal = arr => Array.isArray(arr) && arr.length ? arr[arr.length - 1] : undefined;
  const safeLen = p => Math.min(p, n);

  // swing structure helper: recent swing high/low in a window
  const recentExtrema = (arr, lookback = 20) => {
    const win = arr.slice(-safeLen(lookback));
    return {
      high: Math.max(...win.map(c => c.high)),
      low : Math.min(...win.map(c => c.low)),
    };
  };

  try {
    // ---------------- Core MAs / EMAs ----------------
    if (keys.includes('ema9')) {
      const emaResult = this.calculateEMA(candles, 9);
      out.ema9 = Array.isArray(emaResult) ? emaResult.map(c => c.ema9) : [];
      console.log(`   - ema9: ${out.ema9.length} values, last = ${out.ema9.at(-1)}`);
    }
    if (keys.includes('ema20')) {
      const emaResult = this.calculateEMA(candles, 20);
      out.ema20 = Array.isArray(emaResult) ? emaResult.map(c => c.ema20) : [];
      console.log(`   - ema20: ${out.ema20.length} values, last = ${out.ema20.at(-1)}`);
    }
    if (keys.includes('ema50')) {
      const emaResult = this.calculateEMA(candles, 50);
      out.ema50 = Array.isArray(emaResult) ? emaResult.map(c => c.ema50) : [];
      console.log(`   - ema50: ${out.ema50.length} values, last = ${out.ema50.at(-1)}`);
    }

    if (keys.includes('sma50')) {
      const smaResult = this.calculateSMA(candles, safeLen(50));
      out.sma50 = Array.isArray(smaResult) ? smaResult.map(c => c.sma50).filter(v => v !== null && v !== undefined) : [];
      console.log(`   - sma50: ${out.sma50.length} values, last = ${out.sma50.at(-1)}`);
    }
    if (keys.includes('sma200')) {
      const smaResult = this.calculateSMA(candles, safeLen(200));
      out.sma200 = Array.isArray(smaResult) ? smaResult.map(c => c.sma200).filter(v => v !== null && v !== undefined) : [];
      console.log(`   - sma200: ${out.sma200.length} values, last = ${out.sma200.at(-1)}`);
    }

    // ---------------- Momentum / Volatility ----------------
    if (keys.includes('rsi14')) {
      const rsiResult = this.calculateRSI(candles, 14);
      // RSI returns sparse array of numbers, filter out undefined values
      out.rsi14 = Array.isArray(rsiResult) ? rsiResult.filter(v => v !== undefined) : [];
      console.log(`   - rsi14: ${out.rsi14.length} values, last = ${out.rsi14.at(-1)}`);
    }
    if (keys.includes('atr14')) {
      const atrResult = this.calculateATR(candles, 14);
      // ATR returns sparse array of numbers, filter out undefined values
      out.atr14 = Array.isArray(atrResult) ? atrResult.filter(v => v !== undefined) : [];
      console.log(`   - atr14: ${out.atr14.length} values, last = ${out.atr14.at(-1)}`);
    }

    // ---------------- Volume / VWAP ----------------
    if (keys.includes('vwap'))         out.vwap         = this.calculateVWAP(candles);
    if (keys.includes('volumeSpike'))  out.volumeSpike  = this.calculateVolumeSpike(candles, 30); // slightly longer for swing

    // ---------------- Classic Pivots (optional) ----------------
    if (keys.includes('pivotClassic') && typeof this.calculatePivotsClassic === 'function') {
      // Expecting your helper to accept candles and return {PP,R1,R2,R3,S1,S2,S3} arrays or last value
      out.pivotClassic = this.calculatePivotsClassic(candles);
    }

    // ---------------- Price position snapshot ----------------
    out.pricePosition = {
      aboveEMA9   : out.ema9    ? lastClose > lastVal(out.ema9)    : undefined,
      aboveEMA20  : out.ema20   ? lastClose > lastVal(out.ema20)   : undefined,
      aboveEMA50  : out.ema50   ? lastClose > lastVal(out.ema50)   : undefined,
      aboveSMA50  : out.sma50   ? lastClose > lastVal(out.sma50)   : undefined,
      aboveSMA200 : out.sma200  ? lastClose > lastVal(out.sma200)  : undefined,
      aboveVWAP   : out.vwap    ? lastClose > lastVal(out.vwap)    : undefined,
    };

    // ---------------- Trend bias (swing) ----------------
    const e20 = lastVal(out.ema20);
    const e50 = lastVal(out.ema50 ?? out.sma50); // fallback
    const s200 = lastVal(out.sma200);

    let bias = 'neutral';
    if (Number.isFinite(e20) && Number.isFinite(e50) && Number.isFinite(s200)) {
      if (e20 > e50 && lastClose > e20 && lastClose > s200) bias = 'bullish';
      else if (e20 < e50 && lastClose < e20 && lastClose < s200) bias = 'bearish';
    } else if (Number.isFinite(e20) && Number.isFinite(e50)) {
      bias = e20 > e50 ? 'bullish' : (e20 < e50 ? 'bearish' : 'neutral');
    }
    out.trendBias = bias;

    // ---------------- Recent swing levels ----------------
    const swing20 = recentExtrema(candles, 20);
    const swing50 = recentExtrema(candles, 50);
    out.swingLevels = {
      recent20: swing20,
      recent50: swing50
    };

    // ---------------- ATR-based context (optional utility) ----------------
    if (out.atr14 && Number.isFinite(lastClose)) {
      const atr = lastVal(out.atr14);
      if (Number.isFinite(atr)) {
        out.volatility = {
          atr: atr,
          atrPct: +(atr / lastClose * 100).toFixed(2)
        };
      }
    }

  } catch (err) {
    console.error(`❌ [INDICATOR CALC] Error calculating indicators:`, err.message);
    console.error(`   - Keys requested:`, keys);
    console.error(`   - Candles count:`, candles?.length);
    console.error(`   - Error stack:`, err.stack);
    out.error = `Indicator calculation failed: ${err.message}`;
  }

  return out;
}

/**
 * Opening Range Box (first 30 mins of the session on 15m frame)
 * Assumes candles are sorted ASC by time and include today's first two 15m candles.
 */
_calcOpeningRangeBox(c15) {
  if (!Array.isArray(c15) || c15.length < 2) return null;
  // Find today's date from last candle time
  const lastDate = new Date(c15.at(-1).time);
  const y = lastDate.getFullYear(), m = lastDate.getMonth(), d = lastDate.getDate();

  // First two 15m bars after 09:15 (approx) of the same Y-M-D
  const todays = c15.filter(c => {
    const dt = new Date(c.time);
    return dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d;
  });

  if (todays.length < 2) return null;

  const firstTwo = todays.slice(0, 2);
  const high = Math.max(...firstTwo.map(b => b.high));
  const low  = Math.min(...firstTwo.map(b => b.low));

  return { high, low, from: firstTwo[0].time, to: firstTwo[1].time };
}


addDays(date, days) {
  const newDate = new Date(date);
  newDate.setDate(newDate.getDate() + days);
  return newDate;
}


  /**
   * Fetch latest candle data
   */
  async fetchLatestCandle(url) {
//     console.log(`📡 Fetching latest candle from: ${url}`);
    
    try {
      const response = await axios.get(url, {
        headers: {
          'x-api-key': this.upstoxApiKey
        }
      });
      
      // Check if data exists in nested structure
      const actualCandles = response.data?.data?.candles || response.data?.candles;
//       console.log(`✅ Latest candle received: ${actualCandles?.length || 0} candles`);
      
      // Ensure we return the correct structure
      if (response.data?.data?.candles) {
        // Upstox format: { status, data: { candles: [...] } }
        return response.data.data;
      }
      
      return response.data;
      
    } catch (error) {
//       console.error(`❌ Failed to fetch latest candle:`, error.message);
      return {
        status: 'error',
        candles: [],
        message: `Latest candle API Error: ${error.message}`
      };
    }
  }





  /**
   * Fetch news data from Google RSS
   */
  async fetchNewsData(stockName) {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(stockName)}&hl=en-IN&gl=IN&ceid=IN:en`;
    const feed = await this.rssParser.parseURL(rssUrl);
    return feed.items;
  }


  /**
   * Extract news titles (replaces "Code1" node)
   */
  extractNewsTitles(newsItems) {
    return newsItems.map(item => item.title);
  }

  /**
   * Analyze sentiment using OpenAI (replaces "Message a model" node)
   */
  async analyzeSentiment(titles, term, logId = 'N/A') {
    try {
      const prompt = `You are an AI assistant analyzing ${term} term sentiment for a given stock based on recent news articles and technical signals.

Your job is to:
  • ✅ Evaluate immediate market reactions, technical price movements, and recent news impact.
  • ✅ Classify the sentiment into one of these categories:
    - "Positive" – market outlook is optimistic.
    - "Neutral" – market shows little change or conflicting signals.
    - "Negative" – market reaction is adverse or concerning.
  • ✅ Assign a numerical sentiment score between -1 (very negative) and 1 (very positive). For example:
    - Strong sell-off = -0.9
    - Mild positive headline = 0.2
    - Major bullish technical breakout = 0.8
  • ✅ Provide a concise, factual rationale for the sentiment. Mention technical triggers, breaking news, macro events, or earnings if relevant.

📤 Output Format (strict JSON only):
{
  "shortTermSentiment": {
    "category": "Positive",
    "score": 0.7,
    "rationale": "Apple stock jumped after stronger-than-expected earnings and bullish guidance for next quarter. Technical breakout confirmed above key resistance at $200."
  }
}

📥 Input:
Here are the last 30 news article titles:
${titles.slice(-30).join('\n')}`;

    const response = await axios.post('https://api.openai.com/v1/chat/completions', 
      this.buildRequestPayload(
        this.sentimentalModel,
        this.formatMessagesForModel(this.sentimentalModel, prompt),
        false // Sentiment analysis doesn't require JSON format
      ), 
      {
        headers: {
          'Authorization': `Bearer ${this.openaiApiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const content = response.data.choices[0].message.content;
    const usage = response.data.usage;
    
    // Track API cost
    const costRecord = aiCostTracker.calculateCost(
      this.sentimentalModel,
      usage.prompt_tokens,
      usage.completion_tokens,
      false,
      'sentiment'
    );
    
//     console.log(`💰 Sentiment Analysis Cost: ${aiCostTracker.formatCost(costRecord.totalCost)} | Tokens: ${costRecord.totalTokens}`);
    
    // Update stock log with cost
    if (logId && logId !== 'N/A') {
      await this.updateStockLogWithCost(logId, costRecord.totalCost, 'sentiment');
    }
    
try {
  return JSON.parse(content);
} catch (e) {
  try {
    return this.safeJSONParse(content);
  } catch (err) {
//     console.error('Failed to parse sentiment analysis response:', err, 'Raw content:', content);
    return {
      shortTermSentiment: {
        category: "Neutral",
        score: 0,
        rationale: "Unable to parse sentiment analysis"
      }
    };
  }
}
    } catch (error) {
//       console.error('❌ Sentiment analysis failed:', error);
      // Return default neutral sentiment on error
      return {
        shortTermSentiment: {
          category: "Neutral",
          score: 0,
          rationale: `Sentiment analysis failed: ${error.message}`
        }
      };
    }
  }


safeJSONParse(content) {
  try {
    // Remove markdown code fences like ```json ... ``` or ``` ...
    const cleaned = content
      .replace(/```json\s*/gi, '') // remove ```json
      .replace(/```\s*/g, '')      // remove ```
      .trim();

    return JSON.parse(cleaned);
  } catch (err) {
//     console.error('Failed to parse JSON from model:', err, 'Raw content:', content);
    return {
      shortTermSentiment: {
        category: "Neutral",
        score: 0,
        rationale: "Unable to parse sentiment analysis"
      }
    };
  }
}

  getExperienceLanguage(experience) {
    const languages = {
      beginner: {
        tone: "use everyday language like talking to a friend who never traded before",
        examples: "Replace all technical terms: VWAP → 'average price today', RSI → 'price momentum', ATR → 'daily movement', RR → 'profit vs loss'",
        complexity: "Translate everything to plain English - say 'price going up/down' instead of 'bullish/bearish', 'average price' instead of 'VWAP'",
        glossaryTerms: ['profit-vs-loss', 'safety-exit', 'price-barrier', 'price-floor', 'price-jump', 'trading-activity', 'market-mood']
      },
      intermediate: {
        tone: "clear language with some technical terms explained",
        examples: "Use trading terminology but explain complex concepts",
        complexity: "Moderate technical depth with practical examples",
        glossaryTerms: ['ATR', 'pivot', 'consolidation', 'momentum', 'volatility']
      },
      advanced: {
        tone: "professional trading language with technical analysis",
        examples: "Use advanced technical terms and detailed analysis",
        complexity: "Full technical depth with sophisticated insights",
        glossaryTerms: []
      }
    };
    
    return languages[experience] || languages.intermediate;
  }





// Minimal intraday review: model decides buy/sell/none and outputs levels only




// Minimal intraday review: model decides buy/sell/none and outputs levels only
// Assumes `axios` and `aiCostTracker` exist in your scope, and `this.analysisModel` / `this.openaiApiKey` are configured.

async  getIntraDayAITradingReviewToday(payload) {
  try {
    // ---------- PROMPTS ----------
  const SYSTEM = `
You are a veteran Indian intraday stock trader and mentor.

Operate ONLY on the provided JSON payload. Do not browse. Do not infer missing fields.
When numeric MA comparisons are provided, ignore entryVsDailyMA.* text flags.
Market: NSE cash, IST 09:15–15:30. Intraday only (no carryover).

Your task:
- Decide whether to BUY, SELL, or NONE based on the payload’s current context.
- Propose precise numeric levels: entry, stop, T1, T2 with practical risk (ATR/structure).

Preferences & Behavior:
- Prefer SHORTS when price is below VWAP and 15m bias is bearish; prefer LONGS when price is above VWAP and bias is bullish. If VWAP is missing, alignment = "unknown".
- Stops: ATR(3m) × (1.5–2.0) or nearest clean structure. Targets: ~1R and ~2R from entry unless nearby structure suggests better precise levels.
- Use absolute IST times; avoid new entries after 15:00; hard exit by 15:25.
- Work only within today's high/low determined from 3m bars; if you cannot compute, return side:"none".

Rounding:
- Compute with full precision; compare thresholds on full precision.
- Present prices to nearest tickSize if available (payload.meta.tickSize or priceContext.tickSize) else 0.05.
- Prices 1dp where sensible; rr 2 decimals.

Safety:
- If critical fields (last price, today’s 3m bars, ATR(3m)) are missing or stale -> side:"none", entry/stop/targets/rr = null with clear reason in reasoning.
- If meta.session.requestTimeIST exists and is ≥ 15:00 -> side:"none".
- Never invent data.

Field Mapping:
- last = priceContext.last
- vwap = priceContext.vwap1m (nullable)
- bias15m = trendMomentum.bias15m
- atr3 = trendMomentum.atr14_3m
- ema20_15m = trendMomentum.ema20_15m.ema20 (context only)
- 3m bars = snapshots.lastBars3m  -> [isoTime, open, high, low, close, volume]
- Compute today’s high/low from 3m bars on the latest IST calendar day present.

Validation for Proposed Plan:
- BUY: stop < entry < targets[0] ≤ targets[1]
- SELL: targets[0] ≤ targets[1] < entry < stop
- Entry within today’s [low, high].
- |entry - last| ≤ max(0.02*last, 5*atr3) unless a strong structure justifies (briefly state).

Tape Context (exact strings):
- If vwap != null and last >= vwap and bias15m == "bullish"  -> "Above VWAP · Bullish"
- If vwap != null and last <  vwap and bias15m == "bearish" -> "Below VWAP · Bearish"
- Else -> "VWAP Unknown"

REASONING REQUIREMENTS (must be concrete & numeric):
- In 2–4 sentences, explicitly cite:
  • current tape: last, vwap (or 'unknown'), bias15m;
  • today’s range: todayHigh and todayLow;
  • chosen ATR multiple used for stop (e.g., "1.8×ATR3m = 3.0");
  • the structural level or condition used for entry (e.g., “break/reclaim of 1373.0”);
  • how T1/T2 relate to R multiples or nearby structure.
- If side:"none", explain specifically which guard failed (e.g., “VWAP unknown + neutral bias”, “outside today’s range”, “after 15:00 IST”, or “RR < 1.0 before 15:00”).

Self-check (hard requirements before returning):
- Return ONE valid JSON object. No markdown, no comments.
- When side:"none", entry/stop/targets/rr MUST be null (targets = [null, null]).
- rr = |T1 - entry| / |entry - stop| (rounded to 2 decimals).
- Reasoning must include at least three explicit numbers among: last, vwap, todayHigh, todayLow, atr3, entry, stop, T1, T2.
- Always include note: "Exit by 15:25 IST. Educational review, not investment advice."
`.trim();

  const USER = `
Analyze this payload and generate a fresh intraday trading suggestion for TODAY. There is NO user trade plan; you must independently decide the side (buy/sell/none) using VWAP alignment, 15m bias, ATR(3m), and intraday structure. Your reasoning MUST justify the direction and each level numerically as per SYSTEM.

[PAYLOAD]
${JSON.stringify(payload)}

[OUTPUT SHAPE — return ONLY this JSON]
{
  "symbol": "string",
  "side": "buy" | "sell" | "none",
  "entry": number | null,
  "stop": number | null,
  "targets": [number | null, number | null],
  "rr": number | null,
  "tapeContext": "Above VWAP · Bullish" | "Below VWAP · Bearish" | "VWAP Unknown",
  "reasoning": "2–4 sentences with explicit numeric references to last/vwap/bias/todayHigh/Low/ATR/entry/stop/T1/T2 per SYSTEM.",
  "notes": [
    "Enter after confirmation (e.g., two consecutive 3m closes through the trigger or VWAP retest rejection).",
    "Avoid new entries after 15:00 IST.",
    "Exit by 15:25 IST. Educational review, not investment advice."
  ]
}
`.trim();

  // ---------- CALL MODEL ----------
  const formattedMessages = this.formatMessagesForModel(this.analysisModel, SYSTEM, USER);
  const resp = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    this.buildRequestPayload(
      this.analysisModel,
      formattedMessages,
      true // Intraday analysis requires JSON format
    ),
    {
      headers: {
        Authorization: `Bearer ${this.openaiApiKey}`,
        "Content-Type": "application/json"
      }
    }
  );

  const raw = resp?.data?.choices?.[0]?.message?.content;
  const usage = resp?.data?.usage;

  // Optional: cost tracking
  const costRecord = aiCostTracker.calculateCost(
    this.analysisModel,
    usage?.prompt_tokens ?? 0,
    usage?.completion_tokens ?? 0,
    false,
    'analysis'
  );
//   console.log(`💰 Intraday Analysis Cost: ${aiCostTracker.formatCost(costRecord.totalCost)} | Tokens: ${costRecord.totalTokens}`);

  // Parse & return JSON result with token usage (use cleanJsonResponse for o4-mini compatibility)
  const parsedResult = this.cleanJsonResponse(raw);

  // ---------- OPTIONAL: schema sanity check ----------
  validateIntradayPlan(parsedResult);

  // Attach token usage for telemetry
  parsedResult.tokenUsage = {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    totalTokens: costRecord.totalTokens,
    estimatedCost: costRecord.totalCost,
    model: this.analysisModel,
    timestamp: new Date().toISOString()
  };

  // Save debug info with actual formatted messages
  parsedResult.debugInfo = {
    formattedMessages: formattedMessages,
    systemPrompt: SYSTEM,
    userPrompt: USER,
    model: this.analysisModel
  };

    return parsedResult;
  } catch (error) {
//     console.error('❌ Intraday analysis failed:', error);
    throw new Error(`Intraday analysis failed: ${error.message}`);
  }
}

// --- Optional helper: light schema + guard validation ---
async validateIntradayPlan(o) {
  const must = (cond, msg) => { if (!cond) throw new Error(`Invalid AI plan: ${msg}`); };

  must(o && typeof o === 'object', 'result must be an object');
  must(typeof o.symbol === 'string', 'symbol must be string');
  must(['buy','sell','none'].includes(o.side), 'side must be buy/sell/none');
  must(Array.isArray(o.targets) && o.targets.length === 2, 'targets must be [t1,t2]');

  if (o.side === 'none') {
    must(o.entry === null && o.stop === null && o.targets[0] === null && o.targets[1] === null && o.rr === null,
         'when side is none, entry/stop/targets/rr must be null');
    return;
  }

  // For actionable plans, ensure numbers
  ['entry','stop','rr'].forEach(k => must(typeof o[k] === 'number' && Number.isFinite(o[k]), `${k} must be number`));
  o.targets.forEach((t, i) => must(typeof t === 'number' && Number.isFinite(t), `targets[${i}] must be number`));

  if (o.side === 'buy') {
    must(o.stop < o.entry, 'buy: stop < entry');
    must(o.entry < o.targets[0] && o.targets[0] <= o.targets[1], 'buy: entry < T1 ≤ T2');
  } else if (o.side === 'sell') {
    must(o.targets[0] <= o.targets[1] && o.targets[1] < o.entry, 'sell: T1 ≤ T2 < entry');
    must(o.entry < o.stop, 'sell: entry < stop');
  }

  must(typeof o.tapeContext === 'string' &&
       ['Above VWAP · Bullish','Below VWAP · Bearish','VWAP Unknown'].includes(o.tapeContext),
       'tapeContext must be one of the exact strings');
  must(typeof o.reasoning === 'string' && o.reasoning.length >= 30, 'reasoning must be a non-empty explanation');
}

async  getIntraDayAITradingReview(tradeData,payload,userExperience) {
  // --- guardrails ---
  const allowed = new Set(["beginner", "intermediate", "advanced"]);
  if (!allowed.has(userExperience)) throw new Error(`Invalid userExperience: ${userExperience}`);

  const lang =
    typeof this.getExperienceLanguage === "function"
      ? this.getExperienceLanguage(userExperience)
      : { tone: "clear, practical language", complexity: "keep it concise", glossaryTerms: [] };

  // ---- merge user's proposed trade into payload (so the model can review it) ----
  const mergedPayload = {
    ...payload,
    userTrade: {
      // normalize common keys (db variations supported)
      direction: tradeData.direction,
      entry: tradeData.entryPrice ?? tradeData.entryprice ?? tradeData.entry ?? null,
      stop: tradeData.stopLoss ?? tradeData.stoploss ?? tradeData.stop ?? null,
      target: tradeData.targetPrice ?? tradeData.targetprice ?? tradeData.target ?? null,
      qty: tradeData.quantity ?? tradeData.qty ?? null,
      term: tradeData.term ?? "intraday",
      reasoning: tradeData.reasoning ?? tradeData.note ?? null,
      createdAtISO: tradeData.createdAt ?? null
    }
  };

  // ---------- PROMPTS ----------
  const SYSTEM = `
You are a veteran Indian intraday stock trader and mentor.

Operate ONLY on the provided JSON payload. Do not browse. Do not infer missing fields.
When numeric MA comparisons are provided, ignore entryVsDailyMA.* text flags.
Market: NSE cash, IST 09:15–15:30. Intraday only (no carryover).

Behavior:
- Be practical and decisive. The top-level output must be skimmable in 3–10 seconds.
- The concise UI "card" MUST be beginner-friendly regardless of userExperience.
- The detailed "analysis" can adapt tone/complexity to userExperience.
- Prefer shorts when price is below VWAP and 15m bias is bearish; prefer longs only after a clear VWAP reclaim + acceptance. If VWAP is missing, alignment is "unknown".
- Stops: ATR(3m) × (1.5–2.0) or nearest clean structure. Targets: ~1R / 2R baseline.
- Use absolute IST times. Avoid new entries after 15:00; hard exit by 15:25.

Language style: ${lang.tone}. ${lang.complexity}.
If userExperience=="beginner":
  - Use plain, short sentences.
  - Add 1–3 bullets in analysis.notes defining any of: ${lang.glossaryTerms.join(', ')} that appear (e.g., "VWAP = day's average price weighted by volume").
  - Avoid unexplained jargon in ui.tldr and ui.actionHint (keep them plain).
If userExperience=="intermediate":
  - Use clear language with light technical terms (define uncommon terms once, in parentheses).
  - May use standard acronyms (RR, SL, TP, VWAP) but expand them the first time in analysis (e.g., "RR (risk/reward)").
  - Include one numeric example where helpful (e.g., how RR was computed).
  - Keep the UI beginner-simple; put any extra detail in analysis.notes.
If userExperience=="advanced":
  - You may use technical terms in analysis; keep UI beginner-simple but expand analysis depth and structure commentary.

Rounding:
- Compute with full precision; compare thresholds on full precision.
- Present prices to nearest tickSize (payload) else 0.05; prices 1dp where sensible; percentages 2dp; rr 2dp.

Safety:
- If critical fields are missing/stale, set guards.needsData=true and isValid=false.
- If requestTimeIST exists and is ≥ 15:00, no new entries today (still provide a correctedPlan for next session).
- Never invent news/data. If alignment references are null, mark as "unknown".

Before returning, self-check:
- No BSON wrappers or comments; valid single JSON object.
- ui.chips length ≤ 3. ui.tldr ≤ 140 chars. ui.actionHint ≤ 80 chars.
- Numeric fields are numbers; when side:"none", entry/stop/targets MUST be null.
- Replace any vague text like "break of opposite structure level" with explicit numeric levels.
- Context chip MUST reflect current tape: "Above VWAP · Bullish" / "Below VWAP · Bearish" / "VWAP Unknown".
Always append: "Educational review, not investment advice."`.trim();

  const USER = `Analyze the payload and FIRST review the user's proposed plan (payload.userPlan; fallback to payload.userTrade if userPlan missing).
Validate both the numeric plan and the user's textual "reasoning".

Then produce TWO layers:
1) ui  -> ultra-short "card" for 3–10s attention.
2) analysis -> detailed content (accordion-friendly), tone may vary by ${userExperience}.

[PAYLOAD]
${JSON.stringify(mergedPayload)}

[OUTPUT SHAPE]
{
  "ui": {                                  // ALWAYS fill this, beginner-friendly
    "verdict": "approve" | "reject" | "caution",
    "tldr": "string",                       // <= 140 chars, no jargon
    "chips": [                              // <= 3 items
      {"label":"RR","value":"string","tone":"good|warn|bad"},               // e.g., "1.14"
      {"label":"Deviation","value":"string","tone":"good|warn|bad"},        // MUST use payload.planDiagnostics.distanceFromLastPct with % sign, e.g., "0.35%"        // MUST use payload.planDiagnostics.distanceFromLastPct with % sign, e.g., "0.35%"
      {"label":"Context","value":"string","tone":"good|warn|bad"}           // EXACT: "Below VWAP · Bearish" / "Above VWAP · Bullish" / "Below VWAP · Neutral" / "Above VWAP · Neutral" / "VWAP Unknown"
    ],
    "actionHint": "string"                  // <= 80 chars. If verdict=="reject" and correctedPlan exists, summarize it (e.g., "Short 1373 / SL 1375.5 / T1 1370.5 / T2 1368.0").
  },

  "analysis": {                             // Detailed, skill-adapted
    "level": "${userExperience}",
    "isValid": boolean,                     // execute user's plan as-is today?
    "tldr": "string",
    "userReview": {
      "provided": boolean,
      "isValidToday": boolean | null,
      "reasons": ["string"],
      "rr": number | null,                  // full precision; round only for display
      "distanceFromLastPct": number | null, // 2dp; = 100*abs(entry-last)/last
      "withinTodayRange": boolean | null,   // computed against USER'S ENTRY
      "todayRange": { "high": number, "low": number }, // include whenever withinTodayRange is evaluated
      "alignment": {
        "withVWAP": "above" | "below" | "unknown",
        "with15mBias": "aligned" | "against" | "neutral"
      },
      "reasoning": {
        "provided": boolean,
        "text": string | null,
        "accepted": boolean | null,
        "issues": ["string"]
      },
      "correctedPlan": {
        "side": "long" | "short" | "none",
        "trigger": "string",                // explicit & checkable (see RULES triggers)
        "entry": number,                    // numeric, tick-aligned
        "stop": number,
        "targets": [number, number]
      } | null
    },
    "plan": {
      "side": "long" | "short" | "none",
      "trigger": "string",                  // use explicit numeric levels if possible
      "entry": number | null,               // null when side:"none"
      "stop": number | null,
      "targets": [number | null, number | null],
      "manage": "string",                   // keep RR wording consistent with targets
      "exitByIST": "15:25",
      "notes": ["string"]
    },
    "guards": {
      "needsData": boolean,
      "marketOpenRequired": true,
      "invalidateIf": [
        "3m close >= <numeric stop level>",                     // use the actual number (e.g., "3m close ≥ 1375.5")
        "sustained VWAP reclaim (2 consecutive 3m closes above VWAP)"
      ]
    },
    "meta": {
      "last": number,
      "vwap": number | null,
      "ema15": number,                      // 15m EMA(20) alias if that's your source
      "atr3": number,                       // ATR(14) on 3m alias if that's your source
      "bias15m": "bullish" | "bearish" | "neutral",
      "tickSize": number | null,
      "generatedAtIST": "YYYY-MM-DD HH:MM",  // Use userPlan.createdAtISO→IST if available; else null/omit
      "marketStatus": "open" | "closed" | "preopen"
    },
    "disclaimer": "Educational review, not investment advice."
  }
}

[RULES]
- Map fields:
  • last = priceContext.last
  • vwap = priceContext.vwap1m (nullable; if null, set alignment.withVWAP = "unknown")
  • ema15 = trendMomentum.ema20_15m.ema20
  • atr3 = trendMomentum.atr14_3m
  • bias15m = trendMomentum.bias15m

- Determine today's high/low from snapshots.lastBars3m for the current IST calendar day (exclude preopen). If unavailable, set guards.needsData=true.

- USER TRADE NUMERIC VALIDITY (compute vs USER'S ENTRY):
  • BUY: stop < entry < target ; SELL: target < entry < stop
  • abs(entry - last) ≤ max(0.02 * last, 5 * atr3)
  • entry ∈ [todayLow, todayHigh]
  • Deviation = payload.planDiagnostics.distanceFromLastPct (already calculated as percentage)
    - If payload.planDiagnostics.distanceFromLastPct is missing or null:
      • Set analysis.userReview.distanceFromLastPct = null
      • In ui.chips, set Deviation.value = "n/a" and Deviation.tone = "good"
  • Alignment preference: longs above VWAP (or unknown), shorts below VWAP (or unknown), and with 15m bias.
  → Set userReview.isValidToday accordingly; rr = abs(target - entry) / abs(entry - stop).

- Triggers (use this template for correctedPlan/plan):
  • "Enter only after (a) two consecutive 3m closes below <level>, or
     (b) a VWAP retest rejection (wick above VWAP, close back below) then
         break of that rejection candle’s low."
  • Replace <level> with an explicit numeric level (e.g., 1373.0). No placeholders in final output.

- Invalidation levels:
  • Use explicit numbers (e.g., "3m close ≥ 1375.5"), not generic phrases like "break of opposite structure level".

- UI rules:
  • ui.tldr ≤ 140 chars, plain language.
  • ui.chips ≤ 3. Chip[2] value MUST be the exact tape context: "Below VWAP · Bearish" / "Above VWAP · Bullish" / "VWAP Unknown".
  • ui.actionHint ≤ 80 chars; if verdict=="reject" and correctedPlan exists, show compact plan line "Side Entry / SL Stop / T1 x / T2 y".

- Number formatting:
  • Compute with full precision; compare thresholds on full precision.
  • Present prices rounded to tickSize (else 0.05); prices 1dp where sensible; percentages 2dp; rr 2dp.

Return ONLY the JSON object described above.
`.trim();

  // ---------- CALL MODEL ----------
  const formattedMessages = this.formatMessagesForModel(this.analysisModel, SYSTEM, USER);
  const resp = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    this.buildRequestPayload(
      this.analysisModel,
      formattedMessages,
      true // Short-term analysis requires JSON format
    ),
    {
      headers: {
        Authorization: `Bearer ${this.openaiApiKey}`,
        "Content-Type": "application/json"
      }
    }
  );

  const raw = resp?.data?.choices?.[0]?.message?.content;
  const usage = resp?.data?.usage;
  
  // Track API cost
  const costRecord = aiCostTracker.calculateCost(
    this.analysisModel,
    usage.prompt_tokens,
    usage.completion_tokens,
    false,
    'analysis'
  );
  
//   console.log(`💰 Intraday Analysis Cost: ${aiCostTracker.formatCost(costRecord.totalCost)} | Tokens: ${costRecord.totalTokens}`);
  
  // Update stock log with cost
  if (tradeData.logId) {
    await this.updateStockLogWithCost(tradeData.logId, costRecord.totalCost, 'analysis');
  }
  
  // Parse & return JSON result with token usage (use cleanJsonResponse for o4-mini compatibility)
  const parsedResult = this.cleanJsonResponse(raw);
  parsedResult.tokenUsage = {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: costRecord.totalTokens,
    estimatedCost: costRecord.totalCost,
    model: this.analysisModel,
    timestamp: new Date().toISOString()
  };
  
  // Save debug info with actual prompt sent to AI
  parsedResult.debugInfo = {
    aiPrompt: formattedMessages,
    model: this.analysisModel
  };
  
  return parsedResult;
}

async  getShortTermAITradingReview(tradeData, payload, userExperience) {
  try {
    // --- guardrails ---
  const allowed = new Set(["beginner", "intermediate", "advanced"]);
  if (!allowed.has(userExperience)) throw new Error(`Invalid userExperience: ${userExperience}`);

  const lang =
    typeof this.getExperienceLanguage === "function"
      ? this.getExperienceLanguage(userExperience)
      : { tone: "clear, practical language", complexity: "keep it concise", glossaryTerms: [] };

  // ---- merge user's proposed trade into payload ----
  const mergedPayload = {
    ...payload, 
    userTrade: {
      direction: tradeData.direction,
      entry:     tradeData.entryPrice ?? tradeData.entryprice ?? tradeData.entry ?? null,
      stop:      tradeData.stopLoss   ?? tradeData.stoploss   ?? tradeData.stop  ?? null,
      target:    tradeData.targetPrice?? tradeData.targetprice?? tradeData.target?? null,
      qty:       tradeData.quantity ?? tradeData.qty ?? null,
      term:      tradeData.term ?? "short",
      reasoning: tradeData.reasoning ?? tradeData.note ?? null,
      createdAtISO: tradeData.createdAt ?? null
    }
  };

  // ---------- PROMPTS ----------
  const SYSTEM = `
You are a veteran Indian **short-term swing** stock trader and mentor.

Operate ONLY on the provided JSON payload. Do not browse. Do not infer missing fields.
When numeric MA comparisons are provided, ignore entryVsDailyMA.* text flags.
Market: NSE cash. Holding window: ~2–10 trading days. Timeframes: **15m (trigger)**, **1h (momentum)**, **1d (bias)**.

Behavior:
- Be practical and decisive. The top-level output must be skimmable in 3–10 seconds.
- The concise UI "card" MUST be beginner-friendly regardless of userExperience.
- The detailed "analysis" may adapt tone/complexity to userExperience.
- **Alignment rule (swing):** Prefer longs when 1d bias is bullish AND 1h momentum is improving; prefer shorts when 1d bias is bearish AND 1h momentum is weakening. Use 15m only for precise trigger timing (break/retest).
- **VWAP usage:** Use 15m VWAP for timing. It's NOT mandatory to be above VWAP for a swing long if 1d/1h align, but it improves timing quality. If VWAP is missing, mark "unknown".
- **Risk model:** Stops at swing low/high or ATR(1d) × (1.0–1.5). Targets at ~1.5R and 2R baseline; stretch only if structure allows.
- **Session rules:** Planning can occur after hours. No intraday forced exit times for swing.

Language style: ${lang.tone}. ${lang.complexity}.
If userExperience=="beginner":
  - Use plain, short sentences.
  - Add 1–3 bullets in analysis.notes defining any of: ${lang.glossaryTerms.join(', ')} that appear (e.g., "Risk/Reward = profit ÷ loss").
  - Avoid unexplained jargon in ui.tldr and ui.actionHint (keep them plain).
If userExperience=="intermediate":
  - Use clear language with light technical terms (define uncommon terms once, in parentheses).
  - May use standard acronyms (RR, SL, TP, VWAP) but expand them the first time in analysis (e.g., "RR (risk/reward)").
  - Include one numeric example where helpful (e.g., how RR was computed).
  - Keep the UI beginner-simple; put any extra detail in analysis.notes.
If userExperience=="advanced":
  - You may use technical terms in analysis; keep UI beginner-simple but expand analysis depth and structure commentary.

Rounding:
- Compute with full precision; compare thresholds on full precision.
- Round all emitted levels (entry/stop/T1/T2 in plan/correctedPlan and ui.actionHint) to tickSize (default 0.05); display with 2dp.

Chip Tones (consistency):
- RR chip: ≥2.00: good, 1.20–1.99: warn, <1.20: bad
- Deviation chip: ≤5%: good, >5–10%: warn, >10–15%: bad, >15%: reject flag
- Context chip: "Above VWAP · Bullish": good, "Below VWAP · Bearish": bad, all others: warn (including "VWAP Unknown")

Safety:
- If critical fields are missing/stale, set guards.needsData=true and analysis.isValid=false.
- Never invent data. If alignment references are null, mark them "unknown".

Before returning, self-check:
- Valid single JSON object; no comments.
- ui.chips length ≤ 3. ui.tldr ≤ 140 chars. ui.actionHint ≤ 80 chars.
- Numeric fields are numbers; when side:"none", entry/stop/targets MUST be null.
- Replace vague text with explicit numeric levels (use payload levels).
- Context chip MUST be EXACTLY one of: "Below VWAP · Bearish" / "Above VWAP · Bullish" / "Below VWAP · Neutral" / "Above VWAP · Neutral" / "VWAP Unknown".

HARD CONSTRAINTS:
- ui.actionHint MUST be built from the chosen trade:
  • If analysis.plan.side != "none" -> build from analysis.plan
  • Else if userReview.correctedPlan exists -> build from correctedPlan
  • If plan.side=="none" and userReview.correctedPlan==null -> return validation error (don't fabricate a hint)
  • NEVER build ui.actionHint from payload.userTrade.
- analysis.tldr MUST accurately describe what's being recommended:
  • If suggesting opposite direction from user -> "Rejected user's [long/short]; conditions favor [opposite direction] instead"
  • Never say "User long plan" when the actual recommendation is short (or vice versa)
- userReview.isValidToday MUST reflect your computed checks:
  • Set to false if ANY hold: deviation > 15; numeric order invalid (BUY: stop<entry<target; SELL: target<entry<stop);
    long & withVWAP15m=="below" & (with1hMomentum!="aligned" OR with1DBias!="bullish"); 
    short & withVWAP15m=="above" & (with1hMomentum!="aligned" OR with1DBias!="bearish").
- guards.invalidateIf MUST mirror side and STOP:
  • LONG: "1h close ≤ <stop>" and "Sustained 15m VWAP loss (2 consecutive 15m closes below VWAP)"
  • SHORT: "1h close ≥ <stop>" and "Sustained 15m VWAP reclaim (2 consecutive 15m closes above VWAP)"
- Language MUST NOT claim alignment when metrics disagree. Use "requires VWAP reclaim" or "requires momentum improvement" when below VWAP or 1h RSI is weak.
- Absolutely NO BSON wrappers (NumberInt/ObjectId/ISODate). Output plain JSON numbers/strings only.
`.trim();

  const USER = `
Review the payload for a SHORT-TERM swing trade. First, evaluate the user's proposed plan (payload.userPlan; fallback to payload.userTrade if userPlan missing).
Then, produce: (1) a beginner-friendly "ui" card; (2) a detailed "analysis" section tailored to ${userExperience}.

[PAYLOAD]
${JSON.stringify(mergedPayload)}

[OUTPUT SHAPE]
{
  "ui": {
    "verdict": "approve" | "reject" | "caution",
    "tldr": "string",
    "chips": [
      {"label":"RR","value":"string","tone":"good|warn|bad"},
      {"label":"Deviation","value":"string","tone":"good|warn|bad"},        // MUST use payload.planDiagnostics.distanceFromLastPct with % sign, e.g., "0.35%"
      {"label":"Context","value":"string","tone":"good|warn|bad"}  // EXACT: "Below VWAP · Bearish" / "Above VWAP · Bullish" / "Below VWAP · Neutral" / "Above VWAP · Neutral" / "VWAP Unknown"
    ],
    "actionHint": "string"  // "Side <entry> / SL <stop> / T1 <t1> / T2 <t2>"
  },

  "analysis": {
    "level": "${userExperience}",
    "isValid": boolean,                 // execute user's plan as-is within swing window?
    "tldr": "string",

    "userReview": {
      "provided": boolean,
      "isValidToday": boolean | null,
      "reasons": ["string"],
      "rr": number | null,              // abs(target-entry)/abs(entry-stop)
      "distanceFromLastPct": number | null, // Use payload.planDiagnostics.distanceFromLastPct (pre-calculated)
      "alignment": {
        "withVWAP15m": "above" | "below" | "unknown",
        "with1hMomentum": "aligned" | "against" | "neutral",
        "with1DBias": "aligned" | "against" | "neutral"
      },
      "reasoning": {
        "provided": boolean,
        "text": string | null,
        "accepted": boolean | null,
        "issues": ["string"]
      },
      "correctedPlan": {
        "side": "long" | "short" | "none",
        "trigger": "string",            // explicit, numeric, testable
        "entry": number,
        "stop": number,
        "targets": [number, number]
      } | null
    },

    "plan": {
      "side": "long" | "short" | "none",
      "trigger": "string",              // explicit numeric trigger; avoid vague "confirmation"
      "entry": number | null,
      "stop": number | null,
      "targets": [number | null, number | null],
      "manage": "string",
      "notes": ["string"]
    },

    "guards": {
      "needsData": boolean,
      "marketOpenRequired": false,
      "invalidateIf": [  // LONG: ["1h close ≤ <stop>", "Sustained 15m VWAP loss (2 consecutive 15m closes below VWAP)"]
        "1h close ≤ <stop>",  // SHORT: ["1h close ≥ <stop>", "Sustained 15m VWAP reclaim (2 consecutive 15m closes above VWAP)"]
        "Sustained 15m VWAP loss (2 consecutive 15m closes below VWAP)"
      ]
    },

    "meta": {
      "last": number,                   // priceContext.last
      "vwap15m": number | null,         // priceContext.vwap15m
      "emaDaily": number | null,        // trendMomentum.ema20_1D.ema20
      "rsi1h": number | null,           // trendMomentum.rsi14_1h
      "atr1D": number | null,           // trendMomentum.atr14_1D
      "biasDaily": "bullish" | "bearish" | "neutral",
      "tickSize": number | null,
      "generatedAtIST": "YYYY-MM-DD HH:MM",  // Use userPlan.createdAtISO→IST if available; else null/omit
      "dataHealth": { "bars15m": number, "bars1h": number, "bars1D": number }
    },

    "disclaimer": "Educational review, not investment advice."
  }
}

[RULES]
- Map fields:
  • last = priceContext.last
  • vwap15m = priceContext.vwap15m (nullable -> use "VWAP Unknown" in UI)
  • emaDaily = trendMomentum.ema20_1D.ema20
  • rsi1h = trendMomentum.rsi14_1h
  • atr1D = trendMomentum.atr14_1D
  • biasDaily = trendMomentum.trendBias
  • bars = meta.dataHealth.{bars15m,bars1h,bars1D}
  • tickSize = meta.tickSize ?? 0.05

- Data sufficiency (minimums for indicator computation):
  • bars15m >= 26   // enough for a full trading day's 15m VWAP & structure
  • bars1h  >= 20   // enough for 1h RSI(14) and momentum read
  • bars1D  >= 50   // enough for daily EMA20 & ATR14
  -> If ANY minimum is not met: set guards.needsData=true and analysis.isValid=false (still provide guidance and a correctedPlan if possible).

- Optional context warning (soft note only):
  • If bars are sufficient for indicators but below ideal context (15m<150 or 1h<120 or 1d<200), allow validation but add a note like "Context data is limited" in plan.notes.

- User numeric validity:
  • BUY: stop < entry < target ; SELL: target < entry < stop
  • rr = abs(target - entry) / abs(entry - stop)
  • Deviation = payload.planDiagnostics.distanceFromLastPct (already calculated correctly as a percentage)
    - For the Deviation chip: use the exact value from payload.planDiagnostics.distanceFromLastPct, format as "X.XX%" (e.g., "0.35%", "2.45%")
    - > 10% => warn; > 15% => reject unless explicitly marked as a future stop/limit order
    - If payload.planDiagnostics.distanceFromLastPct is missing or null:
      • Set analysis.userReview.distanceFromLastPct = null
      • In ui.chips, set Deviation.value = "n/a" and Deviation.tone = "good"
  • Alignment scoring:
    - with1DBias: aligned if (biasDaily=="bullish" && side=="long") or (biasDaily=="bearish" && side=="short"), else "against"; if "neutral" => "neutral"
    - with1hMomentum: use rsi1h (Longs: aligned if RSI ≥ 52; against if RSI ≤ 45; else neutral. Shorts: aligned if RSI ≤ 48; against if RSI ≥ 55; else neutral. If missing => "neutral")
    - withVWAP15m: "above"/"below"/"unknown" from last vs vwap15m

- Triggers (explicit numbers; no vague phrasing):
  • Long: "Enter after one 1h close above <level> AND two 15m closes above <level>"
  • Short: "Enter after one 1h close below <level> AND two 15m closes below <level>"
  • Pick <level> from: prevSession.high/low, weeklyRange.high/low, swingLevels.recent20/50

- actionHint source:
  • Build from analysis.plan if side!="none"; else from userReview.correctedPlan. Never from payload.userTrade.

- Invalidation (must match side and stop):
  • Long: "1h close ≤ <stop>" and "Sustained 15m VWAP loss (2 consecutive 15m closes below VWAP)"
  • Short: "1h close ≥ <stop>" and "Sustained 15m VWAP reclaim (2 consecutive 15m closes above VWAP)"

Return ONLY the JSON object described above.
`.trim();

  // ---------- CALL MODEL ----------
  const formattedMessages = this.formatMessagesForModel(this.analysisModel, SYSTEM, USER);
  const resp = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    this.buildRequestPayload(
      this.analysisModel,
      formattedMessages,
      true // Short-term analysis requires JSON format
    ),
    {
      headers: {
        Authorization: `Bearer ${this.openaiApiKey}`,
        "Content-Type": "application/json"
      }
    }
  );

  const raw = resp?.data?.choices?.[0]?.message?.content;
  const usage = resp?.data?.usage;
  
  // Track API cost
  const costRecord = aiCostTracker.calculateCost(
   this.analysisModel,
    usage.prompt_tokens,
    usage.completion_tokens,
    false,
    'analysis'
  );
  
//   console.log(`💰 Short-term Analysis Cost: ${aiCostTracker.formatCost(costRecord.totalCost)} | Tokens: ${costRecord.totalTokens}`);
  
  // Update stock log with cost
  if (tradeData.logId) {
    await this.updateStockLogWithCost(tradeData.logId, costRecord.totalCost, 'analysis');
  }
  
  // Parse + sanitize drift (use cleanJsonResponse for o4-mini compatibility)
  const modelJson = this.cleanJsonResponse(raw);
  const sanitized = await this.sanitizeReview(modelJson);
  
  // Add token usage information to the result
  sanitized.tokenUsage = {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: costRecord.totalTokens,
    estimatedCost: costRecord.totalCost,
    model: this.analysisModel,
    timestamp: new Date().toISOString()
  };

  // Save debug info with actual prompt sent to AI
  sanitized.debugInfo = {
    aiPrompt: formattedMessages,
    model: this.analysisModel
  };
  
    return sanitized;
  } catch (error) {
//     console.error('❌ Short-term analysis failed:', error);
    throw new Error(`Short-term analysis failed: ${error.message}`);
  }
}


async getMediumTermAITradingReview(tradeData, payload, userExperience) {
  try {
    // --- guardrails ---
  const allowed = new Set(["beginner", "intermediate", "advanced"]);
  if (!allowed.has(userExperience)) throw new Error(`Invalid userExperience: ${userExperience}`);

  const lang =
    typeof this.getExperienceLanguage === "function"
      ? this.getExperienceLanguage(userExperience)
      : { tone: "clear, practical language", complexity: "keep it concise", glossaryTerms: [] };

  // ---- merge user's proposed trade into payload (so model can review it) ----
  const mergedPayload = {
    ...payload, // expected from buildMediumTermReviewPayload
    userTrade: {
      direction: tradeData.direction,
      entry:     tradeData.entryPrice ?? tradeData.entryprice ?? tradeData.entry ?? null,
      stop:      tradeData.stopLoss   ?? tradeData.stoploss   ?? tradeData.stop  ?? null,
      target:    tradeData.targetPrice?? tradeData.targetprice?? tradeData.target?? null,
      qty:       tradeData.qty ?? tradeData.quantity ?? null,
      term:      tradeData.term ?? "medium",
      reasoning: tradeData.reasoning ?? tradeData.note ?? null,
      createdAtISO: tradeData.createdAt ?? null
    }
  };

   //const payloadForModel = this.sanitizeMediumTradeForPrompt(mergedPayload);
  // ---------- PROMPTS ----------
// ---------- PROMPTS ----------
const SYSTEM = `
You are a veteran Indian medium-term swing/position stock trader and mentor.

Operate ONLY on the provided JSON payload. Do not browse. Do not infer missing fields.
When numeric MA comparisons are provided, ignore entryVsDailyMA.* text flags.
Market: NSE cash. Holding window: ~3–12 weeks. Timeframes: 1W (structure), 1d (primary bias), 1h (timing aid only).

Behavior:
- Be practical and decisive. The top-level output must be skimmable in 3–10 seconds.
- The concise UI "card" MUST be beginner-friendly regardless of userExperience.
- The detailed "analysis" may adapt tone/complexity to userExperience.
- Alignment rule: Prefer LONGS when 1W AND 1d are bullish; prefer SHORTS when 1W AND 1d are bearish. 1h is for timing only (optional).

Language style: ${lang.tone}. ${lang.complexity}.
If userExperience=="beginner":
  - Use plain, short sentences.
  - Add 1–3 bullets in analysis.notes defining any of: ${lang.glossaryTerms.join(', ')} that appear (e.g., "Risk/Reward = profit ÷ loss").
  - Avoid unexplained jargon in ui.tldr and ui.actionHint (keep them plain).
If userExperience=="intermediate":
  - Use clear language with light technical terms (define uncommon terms once, in parentheses).
  - May use standard acronyms (RR, SL, TP) but expand them the first time in analysis (e.g., "RR (risk/reward)").
  - Include one numeric example where helpful (e.g., how RR was computed).
  - Keep the UI beginner-simple; put any extra detail in analysis.notes.
If userExperience=="advanced":
  - You may use technical terms in analysis; keep UI beginner-simple but expand analysis depth and structure commentary.

Risk model:
- Stops at weekly/daily swing low/high or ATR(1d) × (1.5–2.0).
- Baseline targets: T1 ≈ 1.8R, T2 ≈ 2.5R; stretch only if weekly structure allows.

Session rules:
- Planning can occur after hours. No intraday forced exits for medium-term.

Output:
- Return JSON only. No markdown. All numeric fields are numbers (not strings).

Rounding:
- Compute with full precision; compare thresholds on full precision.
- Round all emitted levels (entry/stop/T1/T2 in plan/correctedPlan and ui.actionHint) to tickSize (default 0.05); display with 2dp.

Chip Tones (consistency):
- RR chip: ≥2.00: good, 1.20–1.99: warn, <1.20: bad
- Deviation chip: ≤5%: good, >5–10%: warn, >10–15%: bad, >15%: reject flag
- Context chip: "Above VWAP · Bullish": good, "Below VWAP · Bearish": bad, all others: warn (including "VWAP Unknown")

Safety:
- If critical fields are missing/stale, set guards.needsData=true and analysis.isValid=false.
- Never invent data. If alignment references are null, mark them "unknown".

Before returning, self-check:
- Valid single JSON object; no comments.
- ui.chips length ≤ 3. ui.tldr ≤ 140 chars. ui.actionHint ≤ 80 chars.
- Numeric fields are numbers; when side:"none", entry/stop/targets MUST be null.
- Replace vague text with explicit numeric levels (use payload levels).
- Context chip MUST be EXACTLY one of: "W1&D1 Bullish" / "W1&D1 Bearish" / "Mixed/Neutral".
- Do NOT reference VWAP or 15m in medium-term output.

HARD CONSTRAINTS:
- Strict medium-term invalidation ONLY (no intraday rules):
  • LONG: "1d close ≤ <stop>" AND "Weekly swing low break (<weekly swing low>)"
  • SHORT: "1d close ≥ <stop>" AND "Weekly swing high reclaim (<weekly swing high>)"
  • DO NOT emit any 1h or 15m/VWAP-based invalidation lines.

- Trigger–Entry coherence:
  • If a trigger level exists and |trigger - entry| / entry > 0.01 → snap trigger to entry (note this in userReview.reasons) OR revise entry to the trigger. Keep them equal and explicit.

- Deviation calculation:
  • Deviation = payload.planDiagnostics.distanceFromLastPct (already calculated correctly as a percentage)
  • For the Deviation chip: use the exact value from payload.planDiagnostics.distanceFromLastPct, format as "X.XX%" (e.g., "0.35%", "2.45%")
  • DO NOT output "15.00" when distanceFromLastPct is 0.35 - use the actual calculated value

- Future order detection:
  • If deviation > 3% AND a trigger is present → set userReview.isValidToday=false (plan may still be valid). State this explicitly.
  • If _preFlags.futureOrder is true, do the same and cite deviation.

- Target baseline (CRITICAL):
  • If RR(T1) < 1.8, YOU MUST propose a correctedPlan that lifts T1 to achieve ≥ 1.8R minimum
  • Calculate new T1: T1_new = entry + (1.8 × |entry - stop|)
  • For LONG: T1_new = entry + (1.8 × (entry - stop))
  • For SHORT: T1_new = entry - (1.8 × (stop - entry))  
  • DO NOT copy the user's targets if RR < 1.8 - you MUST improve them
  • Set T2 to extend beyond T1 for better reward potential
  • Only keep user's targets if they already meet ≥ 1.8R requirement

- ui.actionHint:
  • Build ONLY from analysis.plan when side!="none"; else from userReview.correctedPlan. NEVER from payload.userTrade.

- Consistency:
  • No VWAP/15m references anywhere in medium-term output text.
- Absolutely NO BSON wrappers. Output plain JSON numbers/strings only.
`.trim();

const USER = `
Review the payload for a MEDIUM-TERM swing/position trade. First, evaluate the user's proposed plan (payload.userPlan; fallback to payload.userTrade if userPlan missing).
Then, produce: (1) a beginner-friendly "ui" card; (2) a detailed "analysis" section tailored to ${userExperience}.

[PAYLOAD]
${JSON.stringify(mergedPayload)}

[OUTPUT SHAPE]
{
  "ui": {
    "verdict": "approve" | "reject" | "caution",
    "tldr": "string",
    "chips": [
      {"label":"RR","value":"string","tone":"good|warn|bad"},
      {"label":"Deviation","value":"string","tone":"good|warn|bad"},        // MUST use payload.planDiagnostics.distanceFromLastPct with % sign, e.g., "0.35%"
      {"label":"Context","value":"W1&D1 Bullish" | "W1&D1 Bearish" | "Mixed/Neutral","tone":"good|warn|bad"}
    ],
    "actionHint": "string"  // "Side <entry> / SL <stop> / T1 <t1> / T2 <t2>"
  },

  "analysis": {
    "level": "${userExperience}",
    "isValid": boolean,
    "tldr": "string",

    "userReview": {
      "provided": boolean,
      "isValidToday": boolean | null,
      "reasons": ["string"],
      "rr": number | null,
      "distanceFromLastPct": number | null, // Use payload.planDiagnostics.distanceFromLastPct (pre-calculated)
      "alignment": {
        "with1hMomentum": "aligned" | "against" | "neutral",
        "with1DBias": "aligned" | "against" | "neutral",
        "with1WBias": "aligned" | "against" | "neutral"
      },
      "reasoning": {
        "provided": boolean,
        "text": string | null,
        "accepted": boolean | null,
        "issues": ["string"]
      },
      "correctedPlan": {
        "side": "long" | "short" | "none",
        "trigger": "string",            // explicit, numeric, testable (coherent with entry)
        "entry": number,
        "stop": number,
        "targets": [number, number]
      } | null
    },

    "plan": {
      "side": "long" | "short" | "none",
      "trigger": "string",              // numeric trigger using weekly/daily levels and coherent with entry
      "entry": number | null,
      "stop": number | null,
      "targets": [number | null, number | null],
      "manage": "string",
      "notes": ["string"]
    },

    "guards": {
      "needsData": boolean,
      "marketOpenRequired": false,
      "invalidateIf": [
        "1d close ≤ <stop> (for longs) / ≥ <stop> (for shorts)",
        "Weekly swing invalidation (break of swing low/high)"
      ]
    },

    "meta": {
      "last": number,
      "emaDaily": number | null,
      "emaWeekly": number | null,
      "rsi1h": number | null,
      "atr1D": number | null,
      "atr1W": number | null,
      "biasDaily": "bullish" | "bearish" | "neutral",
      "biasWeekly": "bullish" | "bearish" | "neutral",
      "tickSize": number | null,
      "generatedAtIST": "YYYY-MM-DD HH:MM",  // Use userPlan.createdAtISO→IST if available; else null/omit
      "dataHealth": { "bars1h": number, "bars1D": number, "bars1W": number }
    },

    "disclaimer": "Educational review, not investment advice."
  }
}

[RULES]
- Map fields from payload as specified.
- Data minima: bars1D ≥ 200, bars1W ≥ 80 (required); bars1h ≥ 60 (optional).
- Numeric validity: BUY stop<entry<target; SELL target<entry<stop; rr and deviation as defined.
- Deviation handling:
  • Use payload.planDiagnostics.distanceFromLastPct (already calculated as percentage)
  • If payload.planDiagnostics.distanceFromLastPct is missing or null:
    - Set analysis.userReview.distanceFromLastPct = null
    - In ui.chips, set Deviation.value = "n/a" and Deviation.tone = "good"
- Alignment scoring: with1W/with1D per side; 1h momentum via rsi1h (52–65 long, 35–48 short).
- Triggers: explicit numeric; ensure trigger ≈ entry (≤1% diff) — else snap/revise and explain.
- Target upgrades: if T1 < 1.8R, lift to ≥ 1.8R (or ≥ _preHints.minT1) unless blocked by resistance; keep "caution" if blocked.
- actionHint: from plan if side!="none"; else from correctedPlan.
- Invalidation: Long "1d close ≤ <stop>" & weekly swing LOW break; Short "1d close ≥ <stop>" & weekly swing HIGH reclaim.

Return ONLY the JSON object described above.
`.trim();

  // ---------- CALL MODEL ----------
  const formattedMessages = this.formatMessagesForModel(this.analysisModel, SYSTEM, USER);
  const resp = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    this.buildRequestPayload(
      this.analysisModel,
      formattedMessages,
      true // Medium-term analysis requires JSON format
    ),
    {
      headers: {
        Authorization: `Bearer ${this.openaiApiKey}`,
        "Content-Type": "application/json"
      }
    }
  );

  const raw = resp?.data?.choices?.[0]?.message?.content;
  const usage = resp?.data?.usage;
  
  // Track API cost
  const costRecord = aiCostTracker.calculateCost(
    this.analysisModel,
    usage.prompt_tokens,
    usage.completion_tokens,
    false,
    'analysis'
  );
  
//   console.log(`💰 Medium-term Analysis Cost: ${aiCostTracker.formatCost(costRecord.totalCost)} | Tokens: ${costRecord.totalTokens}`);
  
  // Update stock log with cost
  if (tradeData.logId) {
    await this.updateStockLogWithCost(tradeData.logId, costRecord.totalCost, 'analysis');
  }
  
  // Parse (use cleanJsonResponse for o4-mini compatibility)
  const modelJson = this.cleanJsonResponse(raw);
  
  // Add debug info early so it survives processing
  modelJson.debugInfo = {
    aiPrompt: formattedMessages,
    model: this.analysisModel
  };
  
  const patched = await this.fixMediumReview(modelJson);
  const cleaned = this.validateMediumResponse(patched);
  
  // Add token usage information to the result
  cleaned.tokenUsage = {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: costRecord.totalTokens,
    estimatedCost: costRecord.totalCost,
    model: this.analysisModel,
    timestamp: new Date().toISOString()
  };
  
  // Ensure debug info is preserved
  if (!cleaned.debugInfo) {
    cleaned.debugInfo = {
      aiPrompt: formattedMessages,
      model: this.analysisModel
    };
  }
  
    return cleaned;
  } catch (error) {
//     console.error('❌ Medium-term analysis failed:', error);
    throw new Error(`Medium-term analysis failed: ${error.message}`);
  }
}


// Harden medium-term review: enforce consistency & side-specific rules
async fixMediumReview(review, opts = {}) {
  const r = structuredClone(review || {});
  const ui = r.ui = r.ui || {};
  const a  = r.analysis = r.analysis || {};
  const ur = a.userReview = a.userReview || {};
  const meta = a.meta = a.meta || {};
  const chips = Array.isArray(ui.chips) ? ui.chips : (ui.chips = []);

  // ---- 0) pick source plan (prefer analysis.plan, else correctedPlan) ----
  const src = (a.plan && a.plan.side && a.plan.side !== 'none') ? a.plan : ur.correctedPlan;
  const side = src?.side || a.plan?.side || ur.correctedPlan?.side || null;

  // ---- 1) UI vs analysis mismatch -> use "caution" for valid future plans ----
  if (a.isValid && ui.verdict === 'reject') ui.verdict = 'caution';
  // If it's clearly invalid, keep reject; if no plan at all, leave as is.

  // ---- 2) Trigger must be explicit (daily+weekly phrasing) ----
  const makeExplicitTrigger = (lvl, s = side || 'long') => {
    if (!Number.isFinite(+lvl)) return null;
    const n = Number(lvl);
    const dirWord = (s === 'short') ? 'below' : 'above';
    return `Enter after one 1d close ${dirWord} ${n} AND weekly holds ${dirWord} ${n}`;
  };
  const coerceTrigger = (obj) => {
    if (!obj || obj.side === 'none') return;
    // snap trigger≈entry and rewrite phrasing if it's a bare number or empty
    const e = Number(obj.entry);
    const tNum = Number(obj.trigger);
    if (Number.isFinite(e)) {
      if (!obj.trigger || (!Number.isNaN(tNum) && Math.abs(tNum - e)/Math.max(1e-9,e) > 0.01)) {
        obj.trigger = String(e); // snap
      }
      // if now numeric or numeric-ish, rewrite explicitly
      if (!isNaN(Number(obj.trigger))) {
        obj.trigger = makeExplicitTrigger(Number(obj.trigger), obj.side) || obj.trigger;
      } else if (/^\s*\d+(\.\d+)?\s*$/.test(String(obj.trigger))) {
        const n = Number(obj.trigger);
        obj.trigger = makeExplicitTrigger(n, obj.side) || obj.trigger;
      }
    }
  };
  if (a.plan) coerceTrigger(a.plan);
  if (ur.correctedPlan) coerceTrigger(ur.correctedPlan);

  // ---- 3) Guards -> side-specific, no templates ----
  const weeklySwingLow = opts.weeklySwingLow ?? (
    // try to read from notes like "Weekly swing low ... (below 1365)"
    (Array.isArray(a.notes) && (a.notes.join(' ').match(/\(below\s*(\d+(\.\d+)?)\)/i)?.[1])) ||
    null
  );
  const weeklySwingHigh = opts.weeklySwingHigh ?? null;

  const ensureGuards = () => {
    a.guards = a.guards || { needsData: false, marketOpenRequired: false, invalidateIf: [] };
    const stop =
      a.plan?.stop ??
      ur.correctedPlan?.stop ??
      null;

    let invalidateIf = [];
    if (side === 'short') {
      if (Number.isFinite(stop)) invalidateIf.push(`1d close ≥ ${Number(stop)}`);
      invalidateIf.push(
        weeklySwingHigh ? `Weekly swing high reclaim (above ${Number(weeklySwingHigh)})`
                        : `Weekly swing high reclaim`
      );
    } else if (side === 'long') {
      if (Number.isFinite(stop)) invalidateIf.push(`1d close ≤ ${Number(stop)}`);
      invalidateIf.push(
        weeklySwingLow ? `Weekly swing low break (below ${Number(weeklySwingLow)})`
                       : `Weekly swing low break`
      );
    } else {
      // no side -> keep generic but without placeholders
      invalidateIf = [`Weekly swing invalidation`];
    }
    a.guards.invalidateIf = invalidateIf;
  };
  ensureGuards();

  // ---- 4) Context chip tone -> Mixed/Neutral => tone:"neutral" ----
  const ctx = chips.find(c => c?.label === 'Context');
  if (ctx && String(ctx.value).trim() === 'Mixed/Neutral') ctx.tone = 'neutral';

  // ---- 5) tickSize default for NSE cash ----
  if (meta.tickSize == null) meta.tickSize = 0.05;

  // ---- 6) Ensure actionHint is built from plan/correctedPlan, not userTrade ----
  const hintSrc = (a.plan && a.plan.side && a.plan.side !== 'none') ? a.plan : ur.correctedPlan;
  if (hintSrc) {
    const sideWord = hintSrc.side === 'short' ? 'Short' : 'Long';
    const [t1, t2] = Array.isArray(hintSrc.targets) ? hintSrc.targets : [null, null];
    ui.actionHint = `${sideWord} ${Number(hintSrc.entry)} / SL ${Number(hintSrc.stop)} / T1 ${Number(t1)} / T2 ${Number(t2)}`;
  }

  return r;
}


// ---- Pre-sanitizer: fixes trigger↔entry, flags future order, hints min T1 (≥1.8R) ----
async sanitizeMediumTradeForPrompt(payload) {
  const p = structuredClone(payload);
  const ut = p.userTrade || {};
  const tick = +(p.meta?.tickSize ?? 0.05) || 0.05;

  const roundTick = (n) =>
    Number.isFinite(+n) ? Number((Math.round(+n / tick) * tick).toFixed(2)) : null;

  const entry  = roundTick(ut.entry);
  const stop   = roundTick(ut.stop);
  const target = roundTick(ut.target);

  // Trigger–entry coherence: snap trigger to entry if off by >1%
  const hasTrigger = typeof ut.trigger === 'string' && ut.trigger.trim().length > 0;
  const trigNum = Number(ut.trigger);
  if (hasTrigger && Number.isFinite(trigNum) && Number.isFinite(entry)) {
    const dev = Math.abs(trigNum - entry) / Math.max(1e-9, entry);
    if (dev > 0.01) p.userTrade.trigger = String(entry); // snap to entry
  }

  // Future order detection by deviation & trigger presence
  const last = p.priceContext?.last;
  const deviation = (Number.isFinite(last) && Number.isFinite(entry))
    ? Math.abs(entry - last) / Math.max(1e-9, last) * 100 : null;

  p._preFlags = {
    futureOrder: !!(deviation != null && deviation > 3 && (hasTrigger || Number.isFinite(trigNum))),
    deviationPct: deviation != null ? +deviation.toFixed(2) : null
  };

  // Min T1 hint for ≥1.8R (do not overwrite; the model can use it)
  if ([entry, stop].every(Number.isFinite)) {
    const risk = Math.abs(entry - stop);
    if (risk > 0) {
      const minT1 = ut.direction === 'SELL'
        ? roundTick(entry - 1.8 * risk)
        : roundTick(entry + 1.8 * risk);
      p._preHints = { minT1, risk };
    }
  }

  // Bubble tickSize to meta if missing
  p.meta = p.meta || {};
  if (p.meta.tickSize == null) p.meta.tickSize = tick;

  return p;
}

// ---- Post-validator: removes intraday guards, enforces coherence, builds actionHint ----
async validateMediumResponse(r) {
  if (!r || !r.analysis) return r;

  // 1) No intraday invalidations in medium-term
  const inv = r?.analysis?.guards?.invalidateIf || [];
  const hasIntraday = inv.some(s => /15m|VWAP|1h\s*close/i.test(String(s || '')));
  if (hasIntraday) {
    const side = r?.analysis?.plan?.side || r?.analysis?.userReview?.correctedPlan?.side;
    const stop = r?.analysis?.plan?.stop ?? r?.analysis?.userReview?.correctedPlan?.stop;
    const repl = (side === 'short')
      ? [`1d close ≥ ${stop}`, `Weekly swing high reclaim`]
      : [`1d close ≤ ${stop}`, `Weekly swing low break`];
    if (r.analysis.guards) r.analysis.guards.invalidateIf = repl;
  }

  // 2) Trigger–entry coherence on plan/correctedPlan
  const snapTrigger = (obj) => {
    if (!obj || obj.side === 'none') return;
    const e = obj.entry;
    const t = Number(obj.trigger);
    if (Number.isFinite(e) && Number.isFinite(t)) {
      const dev = Math.abs(t - e) / Math.max(1e-9, e);
      if (dev > 0.01) obj.trigger = String(e);
    }
  };
  snapTrigger(r?.analysis?.plan);
  snapTrigger(r?.analysis?.userReview?.correctedPlan);

  // 3) Build ui.actionHint from plan else correctedPlan (never from userTrade)
  const src = (r?.analysis?.plan?.side && r.analysis.plan.side !== 'none')
    ? r.analysis.plan
    : r?.analysis?.userReview?.correctedPlan;

  if (src) {
    const sideWord = src.side === 'short' ? 'Short' : 'Long';
    const [t1 = null, t2 = null] = Array.isArray(src.targets) ? src.targets : [null, null];
    r.ui = r.ui || {};
    r.ui.actionHint = `${sideWord} ${src.entry} / SL ${src.stop} / T1 ${t1} / T2 ${t2}`;
  }

  // 4) Ensure context chip is one of the allowed values
  if (r?.ui?.chips?.length) {
    const ctx = r.ui.chips.find(c => c.label === 'Context');
    if (ctx) {
      const v = String(ctx.value || '').trim();
      if (!['W1&D1 Bullish','W1&D1 Bearish','Mixed/Neutral'].includes(v)) {
        ctx.value = 'Mixed/Neutral';
      }
    }
  }

  return r;
}





/* ---- Safety net: fixes any residual model drift deterministically ---- */
async sanitizeReview(review) {
  const r = Array.isArray(review) ? review[0] : review;
  if (!r || !r.analysis) return review;

  const a = r.analysis;
  const ui = r.ui || (r.ui = {});
  const metaTick = a?.meta?.tickSize ?? r?.meta?.tickSize ?? 0.05;

  const roundTick = (n, t=metaTick) => {
    const x = Number(n); if (!isFinite(x) || t <= 0) return x;
    return Number((Math.round(x / t) * t).toFixed(2));
  };

  // Choose actionHint source: plan > correctedPlan
  const planOk = (p) => p && p.side && p.side !== 'none' &&
    isFinite(+p.entry) && isFinite(+p.stop) &&
    Array.isArray(p.targets) && isFinite(+p.targets[0]) && isFinite(+p.targets[1]);

  const plan = planOk(a.plan) ? a.plan : null;
  const cp   = planOk(a.userReview?.correctedPlan) ? a.userReview.correctedPlan : null;
  const src  = plan || cp;

  if (src) {
    const E  = roundTick(src.entry);
    const S  = roundTick(src.stop);
    const T1 = roundTick(src.targets?.[0]);
    const T2 = roundTick(src.targets?.[1]);
    const sideCap = String(src.side || '').toLowerCase().replace(/^./, c => c.toUpperCase());
    ui.actionHint = `${sideCap} ${E} / SL ${S} / T1 ${T1} / T2 ${T2}`;

    // Fix invalidation to match side + stop
    const long = String(src.side).toLowerCase() === 'long';
    a.guards ??= {};
    a.guards.invalidateIf = long
      ? [`1h close ≤ ${S}`, `Sustained 15m VWAP loss (2 consecutive 15m closes below VWAP)`]
      : [`1h close ≥ ${S}`, `Sustained 15m VWAP reclaim (2 consecutive 15m closes above VWAP)`];
  }

  // Fix deviation chip value if AI got it wrong
  if (ui.chips && Array.isArray(ui.chips)) {
    const deviationChip = ui.chips.find(chip => chip.label === 'Deviation');
    const actualDeviation = a.userReview?.distanceFromLastPct;
    
    if (deviationChip && actualDeviation != null && isFinite(actualDeviation)) {
      // Format the deviation value correctly with percentage sign
      deviationChip.value = actualDeviation.toFixed(2) + '%';
      
      // Set tone based on deviation value
      if (actualDeviation > 15) {
        deviationChip.tone = 'bad';
      } else if (actualDeviation > 10) {
        deviationChip.tone = 'warn';
      } else {
        deviationChip.tone = 'good';
      }
    }
  }
  
  // Fix medium-term RR issues if AI didn't follow instructions
  const isMediumTerm = 
    r?.userPlan?.term === 'medium' ||
    r?.yourPlan?.term === 'medium' ||
    r?.term === 'medium' ||
    a?.meta?.term === 'medium';
  if (isMediumTerm && a.userReview && a.plan) {
    const userRR = Number(a.userReview.rr);
    if (userRR > 0 && userRR < 1.8 && a.plan.side && a.plan.side !== 'none') {
      // AI should have corrected the targets but didn't - fix it
      const entry = Number(a.plan.entry);
      const stop = Number(a.plan.stop);
      
      if (isFinite(entry) && isFinite(stop) && Math.abs(entry - stop) > 0) {
        const riskAmount = Math.abs(entry - stop);
        const minReward = 1.8 * riskAmount;
        
        if (a.plan.side === 'long') {
          const newT1 = entry + minReward;
          const newT2 = entry + (minReward * 1.4); // 20% extension for T2
          a.plan.targets = [roundTick(newT1), roundTick(newT2)];
          a.plan.notes = a.plan.notes || [];
          a.plan.notes.push('Targets adjusted to meet 1.8R minimum requirement');
//           console.log(`Fixed medium-term RR: T1=${newT1}, T2=${newT2} for entry=${entry}, stop=${stop}`);
        } else if (a.plan.side === 'short') {
          const newT1 = entry - minReward;
          const newT2 = entry - (minReward * 1.4);
          a.plan.targets = [roundTick(newT1), roundTick(newT2)];
          a.plan.notes = a.plan.notes || [];
          a.plan.notes.push('Targets adjusted to meet 1.8R minimum requirement');
//           console.log(`Fixed medium-term RR: T1=${newT1}, T2=${newT2} for entry=${entry}, stop=${stop}`);
        }
        
        // Also update correctedPlan if it exists
        if (a.userReview.correctedPlan && a.userReview.correctedPlan.side === a.plan.side) {
          a.userReview.correctedPlan.targets = [...a.plan.targets];
        }
      }
    }
  }
  
  // Enforce userReview.isValidToday if model drifted
  if (a.userReview) {
    const u = a.userReview;
    const dev = Number(u.distanceFromLastPct);
    const side = String(r?.userPlan?.direction || '').toLowerCase();
    const vw = u.alignment?.withVWAP15m;
    const mom = u.alignment?.with1hMomentum;

    // numeric validity of user's plan
    const up = r.userPlan || {};
    const numericInvalid =
      side === 'buy'
        ? !(up.stop < up.entry && up.entry < up.target)
        : side === 'sell'
          ? !(up.target < up.entry && up.entry < up.stop)
          : false;

    if (typeof u.isValidToday === 'boolean') {
      const anyFail =
        dev > 15 || numericInvalid ||
        ((side === 'buy' || side === 'long')  && (vw === 'below' || mom === 'against')) ||
        ((side === 'sell'|| side === 'short') && (vw === 'above' || mom === 'against'));
      if (anyFail) u.isValidToday = false;
    }
  }

  // Language hygiene in plan.notes if still below VWAP / weak RSI
  if (Array.isArray(a.plan?.notes)) {
    const rsi1h = Number(a.meta?.rsi1h);
    const vwap = Number(a.meta?.vwap15m);
    const last = Number(a.meta?.last);
    const belowVWAP = isFinite(last) && isFinite(vwap) && last < vwap;
    if (belowVWAP || (isFinite(rsi1h) && rsi1h < 45)) {
      a.plan.notes = a.plan.notes.map(s =>
        s.replace(/Improved alignment/gi, 'Proceed only after VWAP reclaim and RSI improvement')
      );
    }
  }

  // Add glossary terms for beginner and intermediate users
  if (a.level === 'beginner') {
    a.notes ??= [];
    const txt = JSON.stringify(a); // crude scan is fine
    const need = [];
    if (/VWAP/i.test(txt)) need.push('VWAP = day\'s average price weighted by volume');
    if (/\bRR\b|Risk\/Reward/i.test(txt)) need.push('Risk/Reward = profit ÷ loss (higher is better)');
    if (/ATR/i.test(txt)) need.push('ATR = typical daily move size (volatility)');
    if (/RSI/i.test(txt)) need.push('RSI = momentum indicator (>70 overbought, <30 oversold)');
    if (/\bSMA\b/i.test(txt)) need.push('SMA = Simple Moving Average (average price over time)');
    if (/\bEMA\b/i.test(txt)) need.push('EMA = Exponential Moving Average (recent prices weighted more)');
    for (const n of need.slice(0,3)) if (!a.notes.includes(n)) a.notes.push(n);
  }

  if (a.level === 'intermediate') {
    a.notes ??= [];
    const txt = JSON.stringify(a);
    const addOnce = (s) => { if (!a.notes.includes(s)) a.notes.push(s); };
    if (/\bRR\b(?!\s*\()/i.test(txt)) addOnce('RR (risk/reward) = profit ÷ loss');
    if (/\bSL\b(?!\s*\()/i.test(txt)) addOnce('SL (stop-loss) = exit price if wrong');
    if (/\bTP\b(?!\s*\()/i.test(txt)) addOnce('TP (take-profit) = target price to book gains');
    if (/\bVWAP\b(?!\s*\()/i.test(txt)) addOnce('VWAP = day\'s average price weighted by volume');
    if (/\bMACD\b(?!\s*\()/i.test(txt)) addOnce('MACD = trend-following momentum indicator');
  }

  // Strip accidental BSON wrappers in strings
  const stripBson = (x) => {
    if (Array.isArray(x)) return x.map(stripBson);
    if (x && typeof x === 'object') {
      const out = {};
      for (const k of Object.keys(x)) out[k] = stripBson(x[k]);
      return out;
    }
    if (typeof x === 'string') {
      return x.replace(/\b(NumberInt|ObjectId|ISODate)\s*\(([^)]*)\)/g, '$2');
    }
    return x;
  };
  return stripBson(r);
}

  /**
   * Simple database update for market hours rejections (no AI processing)
   */
  async updateTradeLogWithRejection(logId, rejectionReason) {
    try {
      // Create a flat structure matching successful reviews
      const rejectionResult = {
        reviewId: `rejection_${Date.now()}`,
        status: "rejected",
        isAnalaysisCorrect: false,
        // Direct analysis object (not nested under 'result')
        analysis: {
          isValid: null,
          insight: rejectionReason,
          bias: 'neutral',
          marketHoursRejection: true,
          rejectionReason: rejectionReason,
          reviewedAt: new Date().toISOString()
        },
        // UI structure for consistent frontend handling  
        ui: {
          verdict: "reject",
          tldr: rejectionReason.split('\n')[0], // Use first line of rejection reason
          chips: []
        },
        error: null,
        metadata: {
          reviewedAt: new Date().toISOString(),
          reviewSource: "market_hours_validation",
          serviceVersion: "v2.1",
          rejectionType: "market_hours"
        }
      };

      const updatedLogEntry = await StockLog.findByIdAndUpdate(logId, {
        reviewResult: [rejectionResult],
        reviewStatus: 'rejected',
        reviewCompletedAt: new Date()
      }, { new: true });

//       console.log('✅ Trade log updated with market hours rejection');
      return updatedLogEntry;
      
    } catch (error) {
//       console.error('❌ Failed to update trade log with rejection:', error.message);
      throw error;
    }
  }

  /**
   * Update trade log directly and send notification (replaces webhook approach)
   */
  async updateTradeLogAndNotify(logId, result) {
    try {
      // Find the log entry
      const logEntry = await StockLog.findById(logId);
      if (!logEntry) {
        throw new Error('Log entry not found');
      }
      
      const isSuccess = result.isValid === true || result.bias !== undefined;
      
      // Get cost summary for this review
      
      // // Get user experience level for pattern analysis
      // const userExperience = logEntry.user ? await this.getUserExperience(logEntry.user) : 'intermediate';
      
      // // Execute chart generation in parallel (don't wait for it)
      // const chartPromise = this.generateTechnicalChart(logEntry, userExperience);
      
      // Create enhanced review result with both trade details and AI analysis
      // const enhancedResult = {
      //   // Include basic trade details from the log entry
      //   tradeDetails: {
      //     stock: logEntry.stock,
      //     direction: logEntry.direction,
      //     quantity: logEntry.quantity,
      //     entryPrice: logEntry.entryPrice,
      //     targetPrice: logEntry.targetPrice,
      //     stopLoss: logEntry.stopLoss,
      //     term: logEntry.term,
      //     reasoning: logEntry.reasoning,
      //     executedAt: logEntry.executedAt,
      //     createdAt: logEntry.createdAt
      //   },
      //   // Include the AI analysis result (without old chart generation)
      //   analysis: result
      // };
      
  
      // Extract tokenUsage from result if it exists
      const tokenUsage = result.tokenUsage;
      delete result.tokenUsage; // Remove from result before storing in reviewResult
      
      const updateData = {
        reviewResult: [result],
        reviewStatus: result?.analysis?.isValid != null ? 'completed' : 'failed',
        reviewCompletedAt: new Date()
      };
      
      // Add tokenUsage if it exists
      if (tokenUsage) {
        updateData.tokenUsage = tokenUsage;
      }
      
      const updatedLogEntry = await StockLog.findByIdAndUpdate(logId, updateData, { new: true });


//         console.log(`🔍 Credit deduction check: isValid = ${result?.analysis?.isValid}, condition passes: ${result?.analysis?.isValid != null}`);
//         console.log(`🔍 User ID: ${logEntry.user}, isFromRewardedAd: ${logEntry.isFromRewardedAd}`);
        
        if(result?.analysis?.isValid  != null){
          try {
//               console.log(`💳 Starting credit deduction for user ${logEntry.user}...`);
              // Deduct credits after successful AI review
              await subscriptionService.deductCredits(
                logEntry.user, 
                1, 
                'AI trade review', 
                'ai_review', 
                logEntry.isFromRewardedAd || false,
                this.creditType || 'regular'
              );
//               console.log(`✅ AI review successful for ${logEntry.stock.trading_symbol} - credits deducted`);
            } catch (error) {
//               console.error('❌ Error deducting credits after AI review:', error);
              // Continue even if credit deduction fails - review is already complete
            }
        } else {
//           console.log(`⚠️ Credits NOT deducted - isValid is null for user ${logEntry.user}`);
        }
      

    
//       console.log('✅ Trade log updated and notification sent successfully');
      return updatedLogEntry;
      
    } catch (error) {
//       console.error('❌ Failed to update trade log and send notification:', error.message);
      throw error;
    }
  }

  /**
   * Update stock log with comprehensive review metadata
   * @param {string} logId - The stock log ID
   * @param {object} metadata - Review metadata including costs, models, tokens, etc.
   */
  async updateTradeLogWithReviewMetadata(logId, metadata) {
    try {
      const stockLog = await StockLog.findById(logId);
      if (!stockLog) {
//         console.warn(`⚠️ Stock log not found for ID: ${logId}`);
        return;
      }

      // Initialize reviewMetadata if it doesn't exist
      if (!stockLog.reviewMetadata) {
        stockLog.reviewMetadata = {};
      }

      // Update with comprehensive metadata
      stockLog.reviewMetadata = {
        ...stockLog.reviewMetadata,
        totalCost: metadata.sessionCosts.totalCost,
        costBreakdown: {
          sentiment: metadata.sessionCosts.byCallType.sentiment?.totalCost || 0,
          analysis: metadata.sessionCosts.byCallType.analysis?.totalCost || 0,
          totalCalls: metadata.sessionCosts.callCount
        },
        modelsUsed: metadata.modelsUsed, // Now correctly an array of strings
        modelDetails: metadata.modelDetails, // Object with detailed model info
        userExperience: metadata.userExperience,
        tokenUsage: metadata.tokenUsage,
        reviewProcessedAt: metadata.reviewProcessedAt,
        modelBreakdown: metadata.sessionCosts.byModel
      };

      // Also update the existing apiCosts field for backward compatibility
      if (!stockLog.apiCosts) {
        stockLog.apiCosts = {
          sentiment: 0,
          analysis: 0,
          total: 0,
          breakdown: []
        };
      }

      stockLog.apiCosts.total = metadata.sessionCosts.totalCost;
      stockLog.apiCosts.sentiment = metadata.sessionCosts.byCallType.sentiment?.totalCost || 0;
      stockLog.apiCosts.analysis = metadata.sessionCosts.byCallType.analysis?.totalCost || 0;

      await stockLog.save();
//       console.log(`💾 Updated trade log ${logId} with comprehensive review metadata`);
//       console.log(`   Total Cost: $${metadata.sessionCosts.totalCost.toFixed(4)}`);
//       console.log(`   Models: ${metadata.modelDetails.sentimentModel} + ${metadata.modelDetails.analysisModel}`);
//       console.log(`   Tokens: ${metadata.tokenUsage.totalTokens} (${metadata.tokenUsage.inputTokens}+${metadata.tokenUsage.outputTokens})`);
//       console.log(`   User Level: ${metadata.userExperience}`);
    } catch (error) {
//       console.error(`❌ Failed to update trade log with metadata:`, error);
    }
  }

  /**
   * Save debug information to stock log for troubleshooting
   * @param {string} logId - The stock log ID
   * @param {Object} payload - The payload sent to AI
   * @param {string|Object} prompt - The prompt used for AI
   * @param {Object} candleSummary - Summary of candle data
   */
  async saveDebugInfo(logId, payload, prompt, candleSummary) {
    try {
      // Get existing debugInfo to preserve AI prompt
      const existingLog = await StockLog.findById(logId).select('debugInfo');
      const existingDebugInfo = existingLog?.debugInfo || {};
      
      const debugInfo = {
        payload: payload,
        prompt: typeof prompt === 'string' ? { content: prompt } : prompt,
        candleData: candleSummary,
        savedAt: new Date(),
        // Preserve the aiPrompt if it exists
        ...(existingDebugInfo.aiPrompt ? { aiPrompt: existingDebugInfo.aiPrompt } : {}),
        ...(existingDebugInfo.model ? { model: existingDebugInfo.model } : {})
      };

      await StockLog.findByIdAndUpdate(logId, 
        { debugInfo: debugInfo },
        { new: true }
      );

//       console.log(`🐛 Debug info saved for trade ${logId}`);
    } catch (error) {
//       console.error(`❌ Failed to save debug info:`, error);
    }
  }

  /**
   * Update stock log with API cost information
   * @param {string} logId - The stock log ID
   * @param {number} cost - The cost amount
   * @param {string} callType - Type of API call (sentiment, analysis, total_session)
   */
  async updateStockLogWithCost(logId, cost, callType) {
    try {
      const stockLog = await StockLog.findById(logId);
      if (!stockLog) {
//         console.warn(`⚠️ Stock log not found for ID: ${logId}`);
        return;
      }

      // Initialize apiCosts if it doesn't exist
      if (!stockLog.apiCosts) {
        stockLog.apiCosts = {
          sentiment: 0,
          analysis: 0,
          total: 0,
          breakdown: []
        };
      }

      // Add to breakdown array
      stockLog.apiCosts.breakdown.push({
        type: callType,
        cost: cost,
        timestamp: new Date()
      });

      // Update totals
      if (callType === 'sentiment') {
        stockLog.apiCosts.sentiment += cost;
      } else if (callType === 'analysis') {
        stockLog.apiCosts.analysis += cost;
      }
      
      // Update total cost
      stockLog.apiCosts.total = (stockLog.apiCosts.sentiment || 0) + (stockLog.apiCosts.analysis || 0);

      await stockLog.save();
//       console.log(`💾 Updated stock log ${logId} with ${callType} cost: $${cost.toFixed(4)}`);
    } catch (error) {
//       console.error(`❌ Failed to update stock log with cost:`, error);
    }
  }

  /**
   * Check if a model is from OpenAI and supports response_format
   * @param {string} model - The model name
   * @returns {boolean} - True if it's an OpenAI model that supports response_format (excludes o1 models)
   */
  isOpenAIModel(model) {
    // o1 models don't support response_format, temperature, top_p, etc.
    if (model.startsWith('o1')) {
      return false;
    }
    
    const openAIModels = [
   
      'gpt-4o-mini',
      'gpt-5',
      'o4-mini'

    ];
    
    // Check if the model starts with any OpenAI model prefix
    return openAIModels.some(openAiModel => model.includes(openAiModel));
  }

  /**
   * Save error status to database when AI review fails
   * @param {string} tradeLogId - The trade log ID
   * @param {Error} error - The error that occurred
   */
  async saveErrorStatus(tradeLogId, error) {
    try {
//       console.error(`❌ AI Review failed for trade ${tradeLogId}:`, error.message);
      
      const errorData = {
        reviewStatus: 'error',
        reviewCompletedAt: new Date(),
        reviewError: {
          message: error.message || 'Unknown error occurred',
          code: error.code || 'UNKNOWN_ERROR',
          type: this.getErrorType(error)
        },
        reviewResult: [{
          status: 'error',
          ui: {
            verdict: 'error',
            tldr: 'Review failed - ' + this.getErrorMessage(error)
          }
        }]
      };

     
      await StockLog.findByIdAndUpdate(tradeLogId, errorData, { new: true });
      
//       console.log(`💾 Updated trade log ${tradeLogId} with error status`);
    } catch (dbError) {
//       console.error(`❌ Failed to save error status for trade ${tradeLogId}:`, dbError);
    }
  }

  /**
   * Get error type for categorization
   * @param {Error} error - The error object
   * @returns {string} - Error type
   */
  getErrorType(error) {
    if (error.response) {
      if (error.response.status === 400) return 'BAD_REQUEST';
      if (error.response.status === 401) return 'UNAUTHORIZED';
      if (error.response.status === 429) return 'RATE_LIMIT';
      if (error.response.status >= 500) return 'SERVER_ERROR';
      return 'API_ERROR';
    }
    
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') return 'CONNECTION_ERROR';
    if (error.name === 'SyntaxError') return 'PARSE_ERROR';
    
    return 'UNKNOWN_ERROR';
  }

  /**
   * Get user-friendly error message
   * @param {Error} error - The error object
   * @returns {string} - User-friendly error message
   */
  getErrorMessage(error) {
    const errorType = this.getErrorType(error);
    
    switch (errorType) {
      case 'BAD_REQUEST':
        return 'Invalid request parameters';
      case 'UNAUTHORIZED':
        return 'Authentication failed';
      case 'RATE_LIMIT':
        return 'Too many requests, please try again later';
      case 'SERVER_ERROR':
        return 'AI service temporarily unavailable';
      case 'CONNECTION_ERROR':
        return 'Connection failed, please check your internet';
      case 'PARSE_ERROR':
        return 'Failed to process AI response';
      default:
        return 'An unexpected error occurred';
    }
  }

  /**
   * Build request payload for AI API calls with conditional response_format
   * @param {string} model - The model name
   * @param {Array} messages - The messages array
   * @param {boolean} requireJson - Whether JSON response format is required
   * @returns {Object} - Request payload
   */
  buildRequestPayload(model, messages, requireJson = true) {
    const payload = {
      model: model,
      messages: messages
    };

    // Only add response_format for OpenAI models that support it
    if (requireJson && this.isOpenAIModel(model)) {
      payload.response_format = { type: "json_object" };
    }

    return payload;
  }

}

export const aiReviewService = new AIReviewService();