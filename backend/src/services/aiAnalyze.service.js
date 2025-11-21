import axios from 'axios';
import Parser from 'rss-parser';
import crypto from 'crypto';
import mongoose from 'mongoose';
import StockAnalysis from '../models/stockAnalysis.js';
import { aiReviewService } from './ai/aiReview.service.js';
import { subscriptionService } from './subscription/subscriptionService.js';
import { Plan } from '../models/plan.js';
import { Subscription } from '../models/subscription.js';
import { getSectorForStock, getSectorNewsKeywords, getTrailingStopSuggestions, getSectorCorrelationMessage } from '../utils/sectorMapping.js';
import candleFetcherService from './candleFetcher.service.js';
import { messagingService } from './messaging/messaging.service.js';
import { User } from '../models/user.js';
import modelSelectorService from './ai/modelSelector.service.js';
import AnalysisSession from '../models/analysisSession.js';
import { buildStage1Prompt, buildStage2Prompt, buildStage3Prompt } from '../prompts/swingPrompts.js';
import Notification from '../models/notification.js';
import { firebaseService } from './firebase/firebase.service.js';
import FineTuneData from '../models/fineTuneData.js';
import { getIstDayRange } from '../utils/tradingDay.js';
import priceCacheService from '../services/priceCache.service.js';
import MarketHoursUtil from '../utils/marketHours.js';
import UserAnalyticsUsage from '../models/userAnalyticsUsage.js';

class AIAnalyzeService {
    constructor() {
        this.aiReviewService = aiReviewService;
        this.upstoxApiKey = process.env.UPSTOX_API_KEY;
        this.openaiApiKey = process.env.OPENAI_API_KEY;
        this.rssParser = new Parser();
        
        // Model configuration
        this.analysisModel = "gpt-4o";
        this.basicModel = "gpt-5.1-2025-11-13";
        this.advancedModel = "gpt-5.1-2025-11-13"; 
        
        // Use existing term-to-frames mapping from aiReview
        this.termToFrames = {
            'intraday': ['1m', '3m', '15m'],
            'short': ['15m', '1h', '1d'], // for swing trading
        };
    }

    /**
     * Save prompt-response pair for fine-tuning dataset
     */
    async saveFineTuneData({
        instrument_key,
        stock_symbol,
        stock_name,
        analysis_type,
        current_price,
        stage,
        prompt,
        response,
        model_used,
        token_usage,
        analysis_status,
        analysis_id = null,
        market_context = {}
    }) {
        try {
            await FineTuneData.create({
                instrument_key,
                stock_symbol,
                stock_name,
                analysis_type,
                current_price,
                stage,
                prompt: typeof prompt === 'string' ? prompt : JSON.stringify(prompt),
                response: typeof response === 'string' ? response : JSON.stringify(response),
                model_used,
                token_usage,
                analysis_status,
                analysis_id,
                market_context
            });
            console.log(`💾 [FINE-TUNE] Saved ${stage} data for ${stock_symbol}`);
        } catch (error) {
            console.error(`❌ [FINE-TUNE] Failed to save ${stage} data for ${stock_symbol}:`, error.message);
            // Don't throw - fine-tune logging failure shouldn't break analysis
        }
    }


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
     * Build request payload for OpenAI API
     */
    buildRequestPayload(model, messages, forceJson = true) {
        const payload = {
            model: model,
            messages: messages,
           
        };

        // Only add response_format for OpenAI models that support it
        if (forceJson ) {
            payload.response_format = { type: "json_object" };
        }

        return payload;
    }

    /**
     * Create a hash of the prompt content for debugging purposes
     */
    createPromptHash(content) {
        try {
            const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
            return crypto.createHash('sha256').update(contentStr).digest('hex').substring(0, 16);
        } catch (error) {
            // console.error('❌ Error creating prompt hash:', error.message);
            return 'hash_error';
        }
    }

    /**
     * Determine which AI model to use based on user's subscription and credits
     * @param {String} userId - User ID
     * @param {Boolean} isFromRewardedAd - Whether this is from a rewarded ad
     * @param {String} creditType - Type of credit (regular, bonus, paid)
     * @returns {Object} - Model configuration and status
     */

    /**
     * Check if user can analyze a stock (common method used by routes and scheduled tasks)
     * @param {string} userId - User ID
     * @param {string} instrumentKey - Stock instrument key
     * @returns {Promise<Object>} - { allowed: boolean, reason: string, message: string, limitInfo: object }
     */
    async checkAnalysisLimits(userId, instrumentKey) {
        try {
            const MarketHoursUtil = (await import('../utils/marketHours.js')).default;

            // Check user limits (watchlist quota + daily limit)
            const limitsCheck = await MarketHoursUtil.checkUserAnalysisLimits(userId, instrumentKey);

            return limitsCheck;
        } catch (error) {
            console.error(`❌ [CHECK LIMITS] Error checking analysis limits:`, error.message);
            // In case of error, allow the analysis to proceed (fail-open)
            return {
                allowed: true,
                reason: 'error_checking_limits',
                message: 'Unable to verify limits, proceeding with analysis'
            };
        }
    }

    /**
     * Create or update pending analysis record in database
     * Centralized method to be used by all analysis entry points
     * @param {Object} params - Analysis parameters
     * @param {string} params.instrument_key - Stock instrument key
     * @param {string} params.stock_name - Stock name
     * @param {string} params.stock_symbol - Stock symbol
     * @param {string} params.analysis_type - Analysis type (swing/intraday)
     * @param {number} params.current_price - Current stock price
     * @param {Date} params.scheduled_release_time - Optional scheduled release time for bulk analysis
     * @returns {Promise<Object>} Created/updated analysis record
     */
    async createPendingAnalysisRecord({
        instrument_key,
        stock_name,
        stock_symbol,
        analysis_type,
        current_price,
        scheduled_release_time = null,
       
    }) {
        try {
            const validPrice = parseFloat(current_price);
            if (!validPrice || isNaN(validPrice) || validPrice <= 0) {
                throw new Error(`Invalid current price: ${current_price}. Cannot create analysis record.`);
            }

            // Check if existing analysis exists
            const existing = await StockAnalysis.findOne({
                instrument_key,
                analysis_type
            });

            // Calculate valid_until time (next market close)
            const MarketHoursUtil = (await import('../utils/marketHours.js')).default;
            const valid_until = await MarketHoursUtil.getValidUntilTime();
            const now = new Date();
            // If existing analysis has valid_until field, preserve existing data
            // Just update status to pending for validation
            if (existing && existing.valid_until &&  now > existing.valid_until)  {
                // Preserve existing strategy, but mark as pending for revalidation and refresh release time
                existing.status = 'pending';
                existing.current_price = validPrice;
                existing.scheduled_release_time = scheduled_release_time;
                existing.progress = {
                    percentage: 0,
                    current_step:  'Starting validation...',
                    steps_completed: 0,
                    total_steps: 8,
                    estimated_time_remaining: 90,
                    last_updated: new Date()
                };
                await existing.save();

                console.log(`📝 [PRESERVE] Updated ${stock_symbol} to pending, refreshed release time: ${existing._id}`);
                return existing;
            } else {
                // No existing analysis OR no valid_until (legacy) - create/replace with upsert
                const pendingAnalysis = await StockAnalysis.findOneAndUpdate(
                    {
                        instrument_key,
                        analysis_type
                    },
                    {
                        $set: {
                            instrument_key,
                            stock_name,
                            stock_symbol,
                            analysis_type,
                            current_price: validPrice,
                            status: 'pending',
                            scheduled_release_time: scheduled_release_time,
                            valid_until: valid_until,
                            progress: {
                                percentage: 0,
                                current_step: 'Starting analysis...',
                                steps_completed: 0,
                                total_steps: 8,
                                estimated_time_remaining: 90,
                                last_updated: new Date()
                            },
                            analysis_data: {
                                schema_version: '1.3',
                                symbol: stock_symbol,
                                analysis_type,
                                insufficientData: false,
                                strategies: [],
                                overall_sentiment: 'NEUTRAL'
                            },
                            created_at: new Date()
                        }
                    },
                    {
                        upsert: true,
                        new: true,
                        runValidators: true
                    }
                );

                console.log(`📝 [NEW/REPLACE] Created/updated record for ${stock_symbol}: ${pendingAnalysis._id}`);
                return pendingAnalysis;
            }

        } catch (error) {
            console.error(`❌ [PENDING ANALYSIS] Failed to create record for ${stock_symbol}:`, error.message);
            throw error;
        }
    }

    /**
     * Duplicate UserAnalyticsUsage record for cached analysis
     * When returning existing analysis to a new user, create a usage record to track they accessed it
     * @param {string} analysisId - ID of the existing analysis
     * @param {string} userId - User ID who is accessing the cached analysis
     * @param {string} stockSymbol - Stock symbol
     * @param {string} analysisType - Analysis type
     */
    async duplicateUserAnalyticsUsage(analysisId, userId, stockSymbol, analysisType) {
        try {
            // Find existing UserAnalyticsUsage record for this analysis (not a cached one)
            const existingUsage = await UserAnalyticsUsage.findOne({
                analysis_id: analysisId,
                is_cached_analysis: false
            }).sort({ createdAt: -1 }).lean();

            if (!existingUsage) {
                console.log(`⚠️ [USER ANALYTICS] No existing usage record found for analysis ${analysisId}`);
                return null;
            }

            // Create duplicate record for new user with is_cached_analysis = true
            const duplicateUsage = new UserAnalyticsUsage({
                ...existingUsage,
                _id: new mongoose.Types.ObjectId(), // Generate new ID
                user_id: userId, // Change to new user
                is_cached_analysis: true, // Mark as cached
                createdAt: new Date(),
                updatedAt: new Date()
            });

            await duplicateUsage.save();
            console.log(`✅ [USER ANALYTICS] Duplicated usage record for user ${userId}, analysis ${analysisId}, cached=true`);

            return duplicateUsage;

        } catch (error) {
            console.error(`❌ [USER ANALYTICS] Failed to duplicate usage record:`, error.message);
            // Don't throw - usage tracking failure shouldn't break analysis flow
            return null;
        }
    }

    /**
     * Analyze stock for trading strategies
     * @param {Object} params - Analysis parameters
     * @param {string} params.instrument_key - Stock instrument key
     * @param {string} params.stock_name - Stock name
     * @param {string} params.stock_symbol - Stock symbol
     * @param {number} params.current_price - Current stock price
     * @param {string} params.analysis_type - Analysis type (swing/intraday)
     * @param {string} params.user_id - User ID for caching
     * @param {boolean} params.skipNotification - Skip sending in-app/Firebase notifications (for scheduled bulk analysis)
     * @param {Date} params.scheduled_release_time - Release time for scheduled analyses (null for immediate visibility)
     * @returns {Promise<Object>} Analysis result
     */
    async analyzeStock({
        instrument_key,
        stock_name,
        stock_symbol,
        current_price = null,
        analysis_type = 'swing',
        user_id,
        userId,  // Accept both user_id and userId for compatibility
        skipNotification = false,
        scheduled_release_time = null,
        skipIntraday= false,



    }) {
        // ⏱️ START TIMING
        const analysisStartTime = Date.now();
        console.log(`\n⏱️ ========== ANALYSIS START: ${stock_symbol} (${instrument_key}) ==========`);
        console.log(`⏱️ Start Time: ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })} IST`);

        // Normalize user_id (accept both formats)
        const normalizedUserId = user_id || userId;

        // Fetch user's favorite sport for personalized analysis
        let favoriteSport = 'cricket'; // default
        if (normalizedUserId) {
            try {
                const user = await User.findById(normalizedUserId).select('favorite_sport');
                if (user && user.favorite_sport) {
                    favoriteSport = user.favorite_sport;
                }
            } catch (error) {
                console.log(`⚠️ Could not fetch user favorite sport, using default: ${error.message}`);
            }
        }


        try {

            const modelConfig = await modelSelectorService.determineAIModel();

               // Set the determined models
                this.analysisModel = modelConfig.models.analysis;
                this.sentimentalModel = modelConfig.models.sentiment;
            

            // Check for existing analysis (completed or in-progress)
            const cacheCheckStart = Date.now();
            const existing = await StockAnalysis.findByInstrument(instrument_key, analysis_type);
            const cacheCheckTime = Date.now() - cacheCheckStart;
            console.log(`⏱️ [TIMING] Cache check: ${cacheCheckTime}ms`);

            if (existing) {
                if (existing.status === 'completed') {
                    const now = new Date();

                    // Check if strategy is still valid
                    if (existing.valid_until && now <= existing.valid_until) {
                        const totalTime = Date.now() - analysisStartTime;
                        console.log(`✅ [CACHE] Strategy valid until ${existing.valid_until.toISOString()}`);
                        console.log(`⏱️ ========== ANALYSIS COMPLETE (CACHED): ${stock_symbol} ==========`);
                        console.log(`⏱️ Total Time: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s)`);

                        // Duplicate UserAnalyticsUsage record for this user if userId is provided
                        if (normalizedUserId) {
                            await this.duplicateUserAnalyticsUsage(
                                existing._id,
                                normalizedUserId,
                                stock_symbol,
                                analysis_type
                            );
                        }

                        return {
                            success: true,
                            data: existing,
                            cached: true
                        };
                    }
                    // If completed but expired, fall through to create new analysis
                    console.log(`🔄 [RETRY] Previous analysis expired (valid_until: ${existing.valid_until}), creating new analysis`);

                } else if (existing.status === 'in_progress') {
                    // Don't duplicate for in_progress - no UserAnalyticsUsage record exists yet
                    // It will be created when the analysis completes
                    return {
                        success: true,
                        data: existing,
                        inProgress: true
                    };
                } else if (existing.status === 'failed') {
                    // Failed analysis found - retry automatically
                    console.log(`🔄 [RETRY] Previous analysis failed, retrying...`);
                    // Fall through to create new analysis
                }
            }

            // If current_price is not provided or invalid, fetch from price cache
            if(!current_price || isNaN(current_price) || current_price <= 0) {
                console.log(`⚡ [PRICE FETCH] No valid price provided, fetching from cache for ${instrument_key}...`);
                const priceMap = await priceCacheService.getLatestPrices([instrument_key]);
                current_price = priceMap[instrument_key] || null;

                if (!current_price) {
                    console.log(`❌ [PRICE FETCH] Failed to fetch price for ${instrument_key}`);
                    throw new Error(`Unable to fetch current price for ${instrument_key}. Please try again.`);
                }

                console.log(`✅ [PRICE FETCH] Got price from cache: ${current_price}`);
            }


                 // Create pending analysis record using common method
            const pendingAnalysis = await this.createPendingAnalysisRecord({
                instrument_key,
                stock_name,
                stock_symbol,
                analysis_type,
                current_price,
                scheduled_release_time,
               
            });




            try {
                // Generate AI analysis with progress tracking
                const aiAnalysisStart = Date.now();
                console.log(`⏱️ [TIMING] Starting AI analysis generation...`);

                const analysisResult = await this.generateAIAnalysisWithProgress(
                    {
                        instrument_key,
                        stock_name,
                        stock_symbol,
                        current_price,
                        analysis_type,
                        skipIntraday,
                        game_mode: favoriteSport
                    },
                    pendingAnalysis // Pass analysis record for progress updates
                );

                const aiAnalysisTime = Date.now() - aiAnalysisStart;
                console.log(`⏱️ [TIMING] AI analysis generation: ${aiAnalysisTime}ms (${(aiAnalysisTime / 1000).toFixed(2)}s)`);

                // Update analysis with results and mark completed or failed based on data sufficiency
                pendingAnalysis.analysis_data = analysisResult;
                
                // Check if AI returned insufficientData and mark as failed if so
                if (analysisResult.insufficientData === true) {
                    const totalTime = Date.now() - analysisStartTime;
                    console.log(`❌ [ANALYSIS STATUS] Marking ${stock_symbol} as failed due to insufficient data`);
                    await pendingAnalysis.markFailed('Insufficient market data for analysis');

                    console.log(`⏱️ ========== ANALYSIS COMPLETE (INSUFFICIENT DATA): ${stock_symbol} ==========`);
                    console.log(`⏱️ Total Time: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s)`);

                    // Update bulk session if this analysis is part of one
                    await this.updateBulkSessionProgress(instrument_key, analysis_type, 'failed');
                } else {
                    console.log(`✅ [ANALYSIS STATUS] Marking ${stock_symbol} as completed with valid analysis`);
                    await pendingAnalysis.markCompleted();

                    // Calculate and log total time
                    const totalTime = Date.now() - analysisStartTime;
                    console.log(`⏱️ ========== ANALYSIS COMPLETE (SUCCESS): ${stock_symbol} ==========`);
                    console.log(`⏱️ Total Time: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s)`);
                    console.log(`⏱️ Breakdown:`);
                    console.log(`   - Cache check: ${cacheCheckTime}ms`);
                    console.log(`   - AI generation: ${aiAnalysisTime}ms`);
                    console.log(`   - Other operations: ${totalTime - cacheCheckTime - aiAnalysisTime}ms`);

                    // Update bulk session if this analysis is part of one
                   // await this.updateBulkSessionProgress(instrument_key, analysis_type, 'completed');

                    // 💰 Save token usage for cost tracking (if we have token data)
                    if (analysisResult._tokenTracking && normalizedUserId) {
                        await this.saveTokenUsage({
                            userId: normalizedUserId,
                            analysisId: pendingAnalysis._id,
                            stockSymbol: stock_symbol,
                            analysisType: analysis_type,
                            analysisData: analysisResult,
                            tokenTracking: analysisResult._tokenTracking,
                            processingTime: analysisResult._processingTime || 0
                        }).catch(err => {
                            // Log but don't fail the analysis if tracking fails
                            console.error(`⚠️ Failed to save token usage for ${stock_symbol}:`, err.message);
                        });
                    }

                     // - skipNotification=true: Bulk analysis during downtime, never send notification
                    // - Default: Send notification if user_id exists and not explicitly skipped


                    if (normalizedUserId && !skipNotification) {
                        console.log(`📬 [NOTIFICATION] Sending analysis complete notification for ${stock_symbol} to user ${normalizedUserId}`);
                        await this.sendAnalysisCompleteNotification(normalizedUserId, pendingAnalysis);
                    } else {
                        console.log(`🔕 [NOTIFICATION] Skipping notification for ${stock_symbol} skipNotification=${skipNotification})`);
                    }
                }

                // console.log(`✅ AI analysis completed and saved for ${stock_symbol}`);

                // Note: Credit deduction removed - bulk analysis is free for all users

                return {
                    success: true,
                    data: pendingAnalysis,
                    cached: false
                };

            } catch (analysisError) {
                const totalTime = Date.now() - analysisStartTime;
                console.log(`⏱️ ========== ANALYSIS FAILED (ERROR): ${stock_symbol} ==========`);
                console.log(`⏱️ Total Time: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s)`);
                console.error(`❌ Error: ${analysisError.message}`);

                // Mark analysis as failed using new method
                await pendingAnalysis.markFailed(analysisError.message);

                throw analysisError;
            }

        } catch (error) {
            const totalTime = Date.now() - analysisStartTime;
            console.log(`⏱️ ========== ANALYSIS FAILED (OUTER CATCH): ${stock_symbol} ==========`);
            console.log(`⏱️ Total Time: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s)`);
            console.error(`❌ Error: ${error.message}`);

            return {
                success: false,
                error: 'Failed to generate AI analysis',
                message: error.message
            };
        } 
    }

    /**
     * Generate AI analysis with progress tracking
     */
    async generateAIAnalysisWithProgress(params, analysisRecord) {
        const { stock_name, stock_symbol, current_price, analysis_type, instrument_key, game_mode = 'cricket' } = params;

        const stageStart = Date.now();
        console.log(`⏱️ [STAGE TIMING] Starting generateAIAnalysisWithProgress for ${stock_symbol}`);

        try {
            // Step 1: Initialize
            await analysisRecord.updateProgress('Initializing analysis...', 5, 85);

            // Step 2: Fetch market data
            await analysisRecord.updateProgress('Fetching market data...', 15, 75);

            // Step 3: Calculate technical indicators
            await analysisRecord.updateProgress('Calculating technical indicators...', 30, 60);

            // Step 4: Analyze patterns
            await analysisRecord.updateProgress('Analyzing price patterns...', 45, 50);

            // Step 5: Generate sentiment analysis
            await analysisRecord.updateProgress('Analyzing market sentiment...', 60, 35);

            // Step 6: Generate strategies
            await analysisRecord.updateProgress('Generating trading strategies...', 75, 20);

            // Step 7: Score and validate strategies
            await analysisRecord.updateProgress('Scoring and validating strategies...', 90, 10);

            // Call the actual analysis method
            const analysisMethodStart = Date.now();
            const result = await this.generateAIAnalysis(params);
            const analysisMethodTime = Date.now() - analysisMethodStart;
            console.log(`⏱️ [STAGE TIMING] generateAIAnalysis (core logic): ${analysisMethodTime}ms (${(analysisMethodTime / 1000).toFixed(2)}s)`);

            // Step 8: Finalize
            await analysisRecord.updateProgress('Finalizing analysis...', 95, 2);

            const totalStageTime = Date.now() - stageStart;
            console.log(`⏱️ [STAGE TIMING] Total generateAIAnalysisWithProgress: ${totalStageTime}ms (${(totalStageTime / 1000).toFixed(2)}s)`);

            return result;

        } catch (error) {
            const totalStageTime = Date.now() - stageStart;
            console.log(`⏱️ [STAGE TIMING] generateAIAnalysisWithProgress FAILED after ${totalStageTime}ms`);
            throw error;
        }
    }
    
    /**
     * Generate AI analysis using real market data
     */
    async generateAIAnalysis({ stock_name, stock_symbol, current_price, analysis_type, instrument_key,skipIntraday }) {
        const methodStart = Date.now();
        console.log(`⏱️ [METHOD TIMING] Starting generateAIAnalysis for ${stock_symbol}`);

        try {
            // Create trade data structure for API calls
            const tradeData = {
                term: analysis_type === 'swing' ? 'short' : 'intraday',
                instrument_key,
                stock: stock_name,
                stockSymbol: stock_symbol,
                stockName: stock_name,
                skipIntraday
            };

            // Get sector information for enhanced analysis
            const sectorInfo = getSectorForStock(stock_symbol, stock_name);

            // Fetch optimized market data (DB first, API fallback) in parallel
            const dataFetchStart = Date.now();
            console.log(`⏱️ [DATA FETCH] Starting parallel fetch (candles + news)...`);

            const [candleData, newsData] = await Promise.all([
                this.fetchOptimizedMarketData(tradeData),
                this.fetchSectorEnhancedNews(stock_name, sectorInfo).catch(err => {
                    return null;
                })
            ]);

            const dataFetchTime = Date.now() - dataFetchStart;
            console.log(`⏱️ [DATA FETCH] Completed in ${dataFetchTime}ms`);
            console.log(`   - Candle data source: ${candleData.source} (${candleData.fetchTime}ms)`);
            console.log(`   - News articles: ${newsData ? newsData.length : 0}`);

            // Check for insufficient data from candle fetcher
            if (candleData.insufficientData) {
                console.log(`⚠️ [INSUFFICIENT DATA] ${candleData.reason} - Returning NO_TRADE response`);

                // Return minimal v1.4-shaped NO_TRADE response
                return {
                    schema_version: "1.4",
                    symbol: stock_symbol,
                    analysis_type: "swing",
                    generated_at_ist: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata', hour12: false }).replace(' ', 'T') + "+05:30",
                    insufficientData: true,
                    market_summary: {
                        last: Number(current_price) || null,
                        trend: "NEUTRAL",
                        volatility: "MEDIUM",
                        volume: "UNKNOWN"
                    },
                    strategies: [{
                        type: "NO_TRADE",
                        action: {
                            now: "wait_for_data",
                            why_not: `Insufficient historical data: ${candleData.reason}`
                        },
                        beginner_explanation: "We need more historical price data to provide reliable trading recommendations. Please try again later when more data becomes available."
                    }]
                };
            }

            // Log data source for monitoring
            console.log(`📊 [DATA SOURCE] ${stock_symbol}: ${candleData.source} (${candleData.fetchTime}ms)`);

//             console.log(`📰 News data result: ${newsData ? `${newsData.length} articles found` : 'No news data'}`);
            if (newsData && newsData.length > 0) {
//                 console.log(`📰 Sample headlines:`, newsData.slice(0, 3).map(item => item.title));
            }

            // Analyze news sentiment with sector context - now returns detailed analysis
            const sentimentStart = Date.now();
            const sentimentAnalysis = newsData ?
                await this.analyzeSectorSentiment(newsData, tradeData.term, sectorInfo) :
                {
                    sentiment: 'neutral',
                    confidence: 50,
                    reasoning: 'No news data available',
                    keyFactors: [],
                    sectorSpecific: false
                };
            const sentimentTime = Date.now() - sentimentStart;
            console.log(`⏱️ [SENTIMENT] Analysis completed in ${sentimentTime}ms`);

            // Extract simple sentiment for backward compatibility
            const sentiment = typeof sentimentAnalysis === 'string' ? sentimentAnalysis : sentimentAnalysis.sentiment;
                
//             console.log(`📊 Enhanced sector sentiment analysis result:`, sentimentAnalysis);

            // Use aiReviewService's simplified routeToTradingAgent directly with candleFetcherService data
            const agentOut = await this.aiReviewService.routeToTradingAgent(tradeData, candleData.candleSets, newsData);
            
            // Build market data payload using existing aiReview function
            let payload;
            if (analysis_type === 'swing') {
                payload = this.aiReviewService.buildShortTermReviewPayload(agentOut, tradeData, sentiment);
            } else {
                payload = this.aiReviewService.buildIntradayReviewPayload(agentOut, tradeData, sentiment);
            }
            
            // Enhance payload with detailed sentiment analysis
            if (typeof sentimentAnalysis === 'object' && payload) {
                // Add enhanced sentiment context to payload
                if (!payload.sentimentContext) {
                    payload.sentimentContext = {};
                }
                
                payload.sentimentContext = {
                    basicSentiment: sentiment,
                    confidence: sentimentAnalysis.confidence,
                    reasoning: sentimentAnalysis.reasoning,
                    keyFactors: sentimentAnalysis.keyFactors,
                    sectorSpecific: sentimentAnalysis.sectorSpecific,
                    positiveSignals: sentimentAnalysis.positiveSignals,
                    negativeSignals: sentimentAnalysis.negativeSignals,
                    marketAlignment: sentimentAnalysis.marketAlignment,
                    sectorName: sentimentAnalysis.metadata?.sectorName,
                    sectorCode: sentimentAnalysis.metadata?.sectorCode,
                    newsAnalyzed: sentimentAnalysis.metadata?.newsCount,
                    recentNewsCount: sentimentAnalysis.metadata?.recentNewsCount,
                    sectorNewsWeight: sentimentAnalysis.metadata?.sectorNewsWeight
                };
                
                // Add sentiment strength indicator based on confidence
                const strengthMap = {
                    high: sentimentAnalysis.confidence >= 80,
                    medium: sentimentAnalysis.confidence >= 60,
                    low: sentimentAnalysis.confidence < 60
                };
                
                payload.sentimentContext.strength = Object.keys(strengthMap).find(key => strengthMap[key]) || 'low';
                
                // Add trading implications based on sentiment analysis
                payload.sentimentContext.tradingImplications = this.generateTradingImplications(sentimentAnalysis, analysis_type);
                
//                 console.log(`📊 Enhanced payload with detailed sentiment context:`, payload.sentimentContext);
            }
            
            // // Log critical market data being sent to AI
            // console.log(`📊 [DATA AUDIT] Market data payload for ${stock_symbol}:`, {
            //     priceContext: payload?.priceContext ? {
            //         last: payload.priceContext.last,
            //         open: payload.priceContext.open,
            //         high: payload.priceContext.high,
            //         low: payload.priceContext.low
            //     } : 'missing',
            //     indicators_1D: payload?.indicators_1D ? {
            //         atr14_1D: payload.indicators_1D.atr14_1D,
            //         ema20_1D: payload.indicators_1D.ema20_1D,
            //         ema50_1D: payload.indicators_1D.ema50_1D,
            //         sma200_1D: payload.indicators_1D.sma200_1D,
            //         availableIndicators: Object.keys(payload.indicators_1D)
            //     } : 'missing',
            //     volumeContext: payload?.volumeContext || 'missing'
            // });

            // Clean payload for stock analysis - remove user plan sections
            payload = this.cleanPayloadForStockAnalysis(payload);
            
            // Override newsLite with our enhanced sentiment analysis results
            if (payload.newsLite) {
                const sentimentMap = { 'positive': 1, 'neutral': 0, 'negative': -1 };
                
                // Build enhanced notes with detailed analysis
                let enhancedNotes = newsData && newsData.length > 0 
                    ? `${newsData.length} news articles analyzed. Overall sentiment: ${sentiment}`
                    : "No recent news found";
                
                // Add detailed analysis if available
                if (typeof sentimentAnalysis === 'object' && sentimentAnalysis.reasoning) {
                    enhancedNotes += `\n\nAnalysis: ${sentimentAnalysis.reasoning}`;
                    
                    if (sentimentAnalysis.keyFactors && sentimentAnalysis.keyFactors.length > 0) {
                        enhancedNotes += `\nKey factors: ${sentimentAnalysis.keyFactors.join(', ')}`;
                    }
                    
                    if (sentimentAnalysis.confidence) {
                        enhancedNotes += `\nConfidence: ${sentimentAnalysis.confidence}%`;
                    }
                }
                
                payload.newsLite = {
                    sentimentScore: sentimentMap[sentiment] || 0,
                    notes: enhancedNotes,
                    // Add detailed analysis for API consumers
                    detailedAnalysis: typeof sentimentAnalysis === 'object' ? sentimentAnalysis : null
                };
//                 console.log(`📰 Updated newsLite with enhanced analysis:`, payload.newsLite);
            }

            // Generate analysis with real market data and sector context using 3-stage process
            const aiGenerationStart = Date.now();
            console.log(`⏱️ [AI GENERATION] Starting 3-stage analysis for ${stock_symbol}...`);

            const analysisResult = await this.generateStockAnalysis3Call({
                instrument_key,
                stock_name,
                stock_symbol,
                current_price,
                analysis_type,
                marketPayload: payload,
                sentiment,
                sectorInfo
            });

            const aiGenerationTime = Date.now() - aiGenerationStart;
            const totalMethodTime = Date.now() - methodStart;

            console.log(`⏱️ [AI GENERATION] 3-stage analysis completed in ${aiGenerationTime}ms (${(aiGenerationTime / 1000).toFixed(2)}s)`);
            console.log(`⏱️ [METHOD TIMING] Total generateAIAnalysis time: ${totalMethodTime}ms (${(totalMethodTime / 1000).toFixed(2)}s)`);
            console.log(`⏱️ [METHOD BREAKDOWN]:`);
            console.log(`   - Data fetch (candles + news): ${dataFetchTime}ms`);
            console.log(`   - Sentiment analysis: ${sentimentTime}ms`);
            console.log(`   - AI generation (3-stage): ${aiGenerationTime}ms`);
            console.log(`   - Other operations: ${totalMethodTime - dataFetchTime - sentimentTime - aiGenerationTime}ms`);

            return analysisResult;

        } catch (error) {
//             console.error('❌ Failed to generate analysis with real data:', error);
            
            // For testing: Don't use fallback, show the actual error
            throw error;
        }
    }

    /**
     * Get market data for analysis (simplified - uses dedicated candle fetcher service)
     */
    async fetchOptimizedMarketData(tradeData) {
        const startTime = Date.now();

        try {
            
            // Ensure MarketHoursUtil is loaded
            const candleResult = await candleFetcherService.getCandleDataForAnalysis(
                tradeData.instrument_key,
                tradeData.term,
                tradeData.skipIntraday || false
            );

            if (candleResult.success) {
                console.log(`✅ [MARKET DATA] Got data from ${candleResult.source}: ${Object.keys(candleResult.data).length} timeframes`);

                // Pass clean data directly to AI analysis - no conversions needed
                return {
                    candleSets: candleResult.data, // Clean: { '15m': [candles], '1h': [candles], '1d': [candles] }
                    source: candleResult.source,
                    fetchTime: Date.now() - startTime
                };
            } else if (candleResult.error === 'insufficient_data') {
                // Return insufficient data marker instead of throwing error
                console.log(`⚠️ [MARKET DATA] Insufficient data: ${candleResult.reason}`);
                return {
                    insufficientData: true,
                    reason: candleResult.reason,
                    source: candleResult.source
                };
            } else {
                throw new Error('Failed to get candle data');
            }

        } catch (error) {
            console.error(`❌ [MARKET DATA] Failed to get data: ${error.message}`);
            throw error;
        }
    }

    // All data fetching logic moved to candleFetcher.service.js

    /**
     * Fetch news data from Google News RSS
     */
    async fetchNewsData(stockName) {
        try {
            const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(stockName)}&hl=en-IN&gl=IN&ceid=IN:en`;
//             console.log(`📰 Fetching news from RSS URL: ${rssUrl}`);
            
            const feed = await this.rssParser.parseURL(rssUrl);
//             console.log(`📰 RSS feed parsed. Found ${feed.items?.length || 0} items`);
            
            if (feed.items && feed.items.length > 0) {
//                 console.log(`📰 First few titles:`, feed.items.slice(0, 3).map(item => item.title));
            }
            
            return feed.items;
        } catch (error) {
//             console.error('📰 News fetch error:', error.message);
            throw error;
        }
    }

    /**
     * Fetch sector-enhanced news data with broader keywords
     */
    async fetchSectorEnhancedNews(stockName, sectorInfo) {
        try {
//             console.log(`📰 Fetching sector-enhanced news for ${stockName} in ${sectorInfo.name} sector`);
            
            // Primary search for stock-specific news
            const stockNews = await this.fetchNewsData(stockName);
            
            // Secondary search for sector-wide news if we have sector info
            let sectorNews = [];
            if (sectorInfo && sectorInfo.code !== 'OTHER') {
                const sectorKeywords = getSectorNewsKeywords(sectorInfo.code);
                const sectorQuery = `${sectorInfo.name} ${sectorKeywords.slice(0, 3).join(' ')}`;
                
                try {
                    const sectorRssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(sectorQuery)}&hl=en-IN&gl=IN&ceid=IN:en`;
//                     console.log(`📰 Fetching sector news from: ${sectorRssUrl}`);
                    
                    const sectorFeed = await this.rssParser.parseURL(sectorRssUrl);
                    sectorNews = sectorFeed.items?.slice(0, 5) || []; // Limit to 5 sector news
//                     console.log(`📰 Found ${sectorNews.length} sector-specific news items`);
                } catch (sectorError) {
//                     console.warn(`⚠️ Sector news fetch failed: ${sectorError.message}`);
                }
            }
            
            // Combine and deduplicate news
            const allNews = [...stockNews, ...sectorNews];
            const uniqueNews = allNews.filter((item, index, self) => 
                index === self.findIndex(t => t.title === item.title)
            );
            
//             console.log(`📰 Total unique news items: ${uniqueNews.length} (${stockNews.length} stock + ${sectorNews.length} sector)`);
            return uniqueNews.slice(0, 15); // Limit total to 15 items
            
        } catch (error) {
//             console.error('❌ Error fetching sector-enhanced news:', error.message);
            // Fallback to regular news
            return await this.fetchNewsData(stockName);
        }
    }

    /**
     * Analyze news sentiment
     */
    async analyzeSentiment(newsItems, term) {
        if (!newsItems || newsItems.length === 0) {
//             console.log('📊 No news items for sentiment analysis, returning neutral');
            return 'neutral';
        }
        
        const titles = newsItems.slice(0, 5).map(item => item.title).join('\n');
       const prompt = `
            You are a financial news sentiment classifier.

            TASK
            Classify the overall ${term}-term sentiment implied by the headlines below.
            Return exactly one lowercase label: positive | neutral | negative

            INPUT
            Headlines (one per line):
            ${titles}

            RULES
            1) Use the headlines only; do not invent facts or read between the lines.
            2) Consider a headline relevant only if it clearly refers to the same company/ETF/asset as the set (name/ticker/obvious synonym). Ignore purely macro/market-wide items unless the asset is a macro proxy (e.g., commodity ETF).
            3) De-duplicate near-identical headlines.
            4) Polarity cues (examples, not exhaustive):
            • Positive: beat, upgrade, record, jump, surge, wins, profit, expands, buyback, approval, partnership.
            • Negative: miss, downgrade, slump, probe, fraud, ban, recall, default, loss, layoffs, fine, investigation.
            • Hedge words (may/might/could/plans/reportedly) reduce polarity strength.
            5) Decision logic (tally relevant headlines):
            • If positives – negatives ≥ 2 or positives / max(1, negatives) ≥ 1.5 → positive.
            • If negatives – positives ≥ 2 or negatives / max(1, positives) ≥ 1.5 → negative.
            • Otherwise → neutral.
            6) If fewer than 3 relevant headlines, or signals are weak/mixed, return neutral.
            7) Non-English/ambiguous headlines → neutral.
            8) OUTPUT MUST BE ONLY one of: positive, neutral, negative. No quotes, no punctuation, no extra words.
            `;
        
//         console.log(`📊 Analyzing sentiment for ${newsItems.length} news items using ${this.sentimentalModel}`);
//         console.log(`📊 Sample titles for sentiment:`, newsItems.slice(0, 2).map(item => item.title));
        
        try {
            const formattedMessages = this.formatMessagesForModel(this.sentimentalModel, prompt);
            
            const response = await axios.post('https://api.openai.com/v1/chat/completions', 
                this.buildRequestPayload(
                    this.sentimentalModel,
                    formattedMessages,
                    false // Sentiment analysis doesn't require JSON format
                ), 
                {
                    headers: {
                        'Authorization': `Bearer ${this.openaiApiKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            const sentiment = response.data.choices[0].message.content.toLowerCase().trim();
            const validSentiment = ['positive', 'negative', 'neutral'].includes(sentiment) ? sentiment : 'neutral';
            
//             console.log(`📊 Sentiment analysis result: "${sentiment}" -> "${validSentiment}"`);
            return validSentiment;
        } catch (error) {
//             console.error('❌ Sentiment analysis failed:', error.message);
            return 'neutral';
        }
    }

    /**
     * Analyze news sentiment with sector context
     */
    async analyzeSectorSentiment(newsItems, term, sectorInfo) {
        if (!newsItems || newsItems.length === 0) {
//             console.log('📊 No news items for sector sentiment analysis, returning neutral');
            return {
                sentiment: 'neutral',
                confidence: 50,
                reasoning: 'No news items available for analysis',
                keyFactors: [],
                sectorSpecific: false,
                positiveSignals: [],
                negativeSignals: [],
                marketAlignment: 'neutral',
                metadata: {
                    sectorName: sectorInfo?.name || 'General Market',
                    sectorCode: sectorInfo?.code,
                    newsCount: 0,
                    analysisTimestamp: new Date().toISOString()
                }
            };
        }
        
        // Enhanced preprocessing - prioritize recent news
        const recentNews = newsItems
            .filter(item => {
                const itemDate = new Date(item.timestamp || item.publishedAt || Date.now());
                const hoursSincePublished = (Date.now() - itemDate.getTime()) / (1000 * 60 * 60);
                return hoursSincePublished <= 24; // Prioritize last 24h
            })
            .slice(0, 5);
        
        const allNewsForAnalysis = recentNews.length > 0 ? recentNews : newsItems.slice(0, 8);
        const titles = allNewsForAnalysis.map(item => item.title).join('\n');
        
        const sectorKeywords = sectorInfo ? getSectorNewsKeywords(sectorInfo.code) : [];
        const sectorName = sectorInfo?.name || 'General Market';
        
        // Identify sector-specific news
        const sectorNews = allNewsForAnalysis.filter(item => 
            sectorKeywords.some(keyword => 
                item.title.toLowerCase().includes(keyword.toLowerCase())
            )
        );
        const sectorWeight = sectorNews.length / allNewsForAnalysis.length;
        
        // Get market context if available
        const marketTrend = this.getMarketTrend(); // You can implement this based on your market data
      //  const sectorVsMarket = this.getSectorVsMarketPerformance(sectorInfo); // You can implement this
        
        const prompt = `
            You are a financial news sentiment classifier with sector expertise.
            
            TASK
            Analyze ${term}-term sentiment for ${sectorName} sector and return a detailed JSON response.
            
            SECTOR CONTEXT
            - Sector: ${sectorName} (${sectorInfo?.code || 'OTHER'})
            - Key Sector Keywords: ${sectorKeywords.slice(0, 8).join(', ')}
            - Sector Index: ${sectorInfo?.index || 'NIFTY 50'}
            - Sector News Weight: ${(sectorWeight * 100).toFixed(1)}% of analyzed news
            - Market Context: ${marketTrend || 'Unknown'}
            - Recent News Count: ${recentNews.length} in last 24h, ${allNewsForAnalysis.length} total
            
            INPUT
            Headlines (mix of company-specific and sector news):
            ${titles}
            
            ENHANCED ANALYSIS WEIGHTS
            - Sector-wide news: 70%
            - Company-specific news: 30%
            - Recent vs older news: Prioritize last 24h
            - Regulatory/policy news: High weight for ${sectorName}
            
            POLARITY CUES FOR ${sectorName}
            • Positive: expansion, approval, policy support, demand growth, price increases, new orders, capacity additions, export growth
            • Negative: regulation, restrictions, demand decline, input cost inflation, policy headwinds, production cuts, import competition
            • Neutral: routine updates, mixed signals, balanced reports
            
            DECISION LOGIC
            1) If sector-wide positives dominate OR individual positives + sector support → positive
            2) If sector-wide negatives dominate OR individual negatives + sector headwinds → negative  
            3) Otherwise → neutral
            
            RESPONSE FORMAT (JSON only):
            {
                "sentiment": "positive|neutral|negative",
                "confidence": <0-100 integer>,
                "reasoning": "<2-3 sentences explaining the decision with specific examples>",
                "keyFactors": ["<factor1>", "<factor2>", "<factor3>"],
                "sectorSpecific": <true if sector themes dominate, false if company-specific>,
                "positiveSignals": ["<signal1>", "<signal2>"],
                "negativeSignals": ["<signal1>", "<signal2>"],
                "marketAlignment": "<aligned|contrary|neutral> compared to broader market"
            }
            
            REQUIREMENTS
            - confidence: Higher if multiple consistent signals, lower if mixed/unclear
            - reasoning: Cite specific headlines or themes, mention sector impact
            - keyFactors: 2-4 most important drivers of sentiment
            - Include both positiveSignals and negativeSignals even if one sentiment dominates
            - marketAlignment: How this sector sentiment relates to broader market trends
            `;
        
//         console.log(`📊 Analyzing sector sentiment for ${allNewsForAnalysis.length} news items (${sectorName}, ${(sectorWeight*100).toFixed(1)}% sector-specific)`);
        
        try {
            const formattedMessages = this.formatMessagesForModel(this.sentimentalModel, prompt);
            
            const response = await axios.post('https://api.openai.com/v1/chat/completions', 
                this.buildRequestPayload(
                    this.sentimentalModel,
                    formattedMessages,
                    true // Request JSON format for detailed response
                ), 
                {
                    headers: {
                        'Authorization': `Bearer ${this.openaiApiKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            const responseContent = response.data.choices[0].message.content;
            let analysisResult;
            
            try {
                analysisResult = JSON.parse(responseContent);
                
                // Validate and sanitize the response
                const validSentiment = ['positive', 'negative', 'neutral'].includes(analysisResult.sentiment) 
                    ? analysisResult.sentiment : 'neutral';
                
                const enhancedResult = {
                    sentiment: validSentiment,
                    confidence: Math.min(100, Math.max(0, parseInt(analysisResult.confidence) || 50)),
                    reasoning: analysisResult.reasoning || 'Analysis completed but no specific reasoning provided',
                    keyFactors: Array.isArray(analysisResult.keyFactors) ? analysisResult.keyFactors.slice(0, 5) : [],
                    sectorSpecific: Boolean(analysisResult.sectorSpecific),
                    positiveSignals: Array.isArray(analysisResult.positiveSignals) ? analysisResult.positiveSignals.slice(0, 3) : [],
                    negativeSignals: Array.isArray(analysisResult.negativeSignals) ? analysisResult.negativeSignals.slice(0, 3) : [],
                    marketAlignment: ['aligned', 'contrary', 'neutral'].includes(analysisResult.marketAlignment) 
                        ? analysisResult.marketAlignment : 'neutral',
                    metadata: {
                        sectorName,
                        sectorCode: sectorInfo?.code,
                        newsCount: allNewsForAnalysis.length,
                        recentNewsCount: recentNews.length,
                        sectorNewsWeight: sectorWeight,
                        analysisTimestamp: new Date().toISOString()
                    }
                };
                
//                 console.log(`📊 Enhanced sector sentiment analysis completed:`, enhancedResult);
                return enhancedResult;
                
            } catch (parseError) {
//                 console.warn('⚠️ Failed to parse detailed sentiment response, extracting basic sentiment');
                // Fallback: extract basic sentiment from response
                const basicSentiment = responseContent.toLowerCase().match(/(positive|negative|neutral)/)?.[1] || 'neutral';
                return {
                    sentiment: basicSentiment,
                    confidence: 60,
                    reasoning: 'Basic sentiment extracted due to parsing error',
                    keyFactors: ['Analysis parsing error'],
                    sectorSpecific: false,
                    positiveSignals: [],
                    negativeSignals: [],
                    marketAlignment: 'neutral',
                    metadata: {
                        sectorName,
                        sectorCode: sectorInfo?.code,
                        newsCount: allNewsForAnalysis.length,
                        parseError: true,
                        analysisTimestamp: new Date().toISOString()
                    }
                };
            }
            
        } catch (error) {
//             console.error('❌ Enhanced sector sentiment analysis failed:', error.message);
            // Fallback to basic analysis
            const basicResult = await this.analyzeSentiment(newsItems, term);
            return {
                sentiment: typeof basicResult === 'string' ? basicResult : 'neutral',
                confidence: 40,
                reasoning: 'Fallback analysis due to API error',
                keyFactors: ['API error fallback'],
                sectorSpecific: false,
                positiveSignals: [],
                negativeSignals: [],
                marketAlignment: 'neutral',
                metadata: {
                    sectorName,
                    fallback: true,
                    error: error.message,
                    analysisTimestamp: new Date().toISOString()
                }
            };
        }
    }
    
    /**
     * Helper method to get market trend (implement based on your market data)
     */
    getMarketTrend() {
        // TODO: Implement based on your market data (NIFTY movement, VIX, etc.)
        return 'neutral'; // placeholder
    }
    
    /**
     * Helper method to get sector vs market performance (implement based on your data)
     */
    getSectorVsMarketPerformance(sectorInfo) {
        // TODO: Implement based on sector index vs NIFTY performance
        return 'neutral'; // placeholder
    }
    
    /**
     * Generate trading implications based on detailed sentiment analysis
     */
    generateTradingImplications(sentimentAnalysis, analysisType) {
        const implications = {
            bias: 'neutral',
            riskLevel: 'medium',
            positionSizing: 'standard',
            entryStrategy: 'cautious',
            recommendations: []
        };
        
        const { sentiment, confidence, sectorSpecific, marketAlignment, positiveSignals, negativeSignals } = sentimentAnalysis;
        
        // Determine bias based on sentiment and confidence
        if (sentiment === 'positive' && confidence >= 70) {
            implications.bias = 'bullish';
            implications.entryStrategy = confidence >= 85 ? 'aggressive' : 'moderate';
        } else if (sentiment === 'negative' && confidence >= 70) {
            implications.bias = 'bearish';
            implications.entryStrategy = confidence >= 85 ? 'aggressive' : 'moderate';
        } else {
            implications.bias = 'neutral';
            implications.entryStrategy = 'cautious';
        }
        
        // Adjust risk level based on confidence and market alignment
        if (confidence >= 80 && marketAlignment === 'aligned') {
            implications.riskLevel = 'low';
            implications.positionSizing = 'increased';
        } else if (confidence < 60 || marketAlignment === 'contrary') {
            implications.riskLevel = 'high';
            implications.positionSizing = 'reduced';
        }
        
        // Generate specific recommendations
        if (sentiment === 'positive') {
            if (sectorSpecific) {
                implications.recommendations.push('Sector-wide positive sentiment supports long positions');
            }
            if (confidence >= 80) {
                implications.recommendations.push('High confidence suggests strong conviction trades');
            }
            if (positiveSignals.length > negativeSignals.length) {
                implications.recommendations.push('Multiple positive catalysts support upward momentum');
            }
        } else if (sentiment === 'negative') {
            if (sectorSpecific) {
                implications.recommendations.push('Sector headwinds suggest defensive positioning');
            }
            if (confidence >= 80) {
                implications.recommendations.push('High confidence in negative sentiment - consider short bias');
            }
            if (negativeSignals.length > positiveSignals.length) {
                implications.recommendations.push('Multiple negative factors suggest downward pressure');
            }
        } else {
            implications.recommendations.push('Mixed sentiment suggests range-bound trading');
            if (analysisType === 'intraday') {
                implications.recommendations.push('Focus on technical levels for intraday opportunities');
            }
        }
        
        // Analysis type specific recommendations
        if (analysisType === 'swing') {
            if (sentiment !== 'neutral' && confidence >= 70) {
                implications.recommendations.push('Strong sentiment supports swing position holds');
            }
        } else if (analysisType === 'intraday') {
            if (confidence < 60) {
                implications.recommendations.push('Low sentiment confidence - prefer quick scalps over position trades');
            }
        }
        
        return implications;
    }

    /**
     * Clean payload for stock analysis by removing user plan sections
     */
    cleanPayloadForStockAnalysis(payload) {
//         console.log('🧹 Starting payload cleanup for stock analysis...');
//         console.log('🧹 Original payload keys:', Object.keys(payload));
        
        const cleanPayload = { ...payload };
        
        // Remove user plan sections that are irrelevant for stock analysis
        const sectionsToRemove = ['userPlan', 'planDiagnostics', 'timeToTargetEstimate'];
        
        sectionsToRemove.forEach(section => {
            if (cleanPayload[section]) {
//                 console.log(`🧹 Removing ${section} from payload`);
                delete cleanPayload[section];
            } else {
//                 console.log(`🧹 Section ${section} not found in payload`);
            }
        });
        
        // Also fix newsLite if it's empty - populate with our sentiment analysis
        if (cleanPayload.newsLite && (cleanPayload.newsLite.sentimentScore === 0 || cleanPayload.newsLite.notes === "")) {
//             console.log('🧹 newsLite is empty, will be handled by our news processing');
        }
        
        // Add basic support/resistance levels if they're empty
        if (cleanPayload.levels && cleanPayload.levels.supports?.length === 0 && cleanPayload.levels.resistances?.length === 0) {
//             console.log('🧹 Support/resistance levels are empty, calculating basic levels');
            cleanPayload.levels = this.calculateBasicLevels(cleanPayload);
        }
        
        // Calculate pivot points if they're missing
        if (cleanPayload.swingContext && cleanPayload.swingContext.pivots === null) {
//             console.log('🧹 Pivot points are null, calculating standard pivots');
            cleanPayload.swingContext.pivots = this.calculatePivotPoints(cleanPayload.swingContext);
        }
        
        // Add volume classification to the payload BEFORE sending to AI
        const volumeClassification = this.classifyVolume(cleanPayload);
//         console.log(`🧹 Volume classification calculated: ${volumeClassification}`);
        
        // Add volume info to the payload for AI to use
        if (!cleanPayload.volumeContext) {
            cleanPayload.volumeContext = {};
        }
        cleanPayload.volumeContext.classification = volumeClassification;
        cleanPayload.volumeContext.band = volumeClassification; // Also add as 'band' for compatibility
        
//         console.log('🧹 Cleaned payload keys:', Object.keys(cleanPayload));
        
        return cleanPayload;
    }

    /**
     * Calculate basic support/resistance levels from available data
     */
    calculateBasicLevels(payload) {
//         console.log('📊 Calculating basic support/resistance levels...');
        
        const supports = [];
        const resistances = [];
        
        try {
            // Get price data from various sources
            const currentPrice = payload.priceContext?.last || 0;
            const swingHigh20 = payload.swingContext?.swingLevels?.recent20?.high;
            const swingLow20 = payload.swingContext?.swingLevels?.recent20?.low;
            const weeklyHigh = payload.swingContext?.weeklyRange?.high;
            const weeklyLow = payload.swingContext?.weeklyRange?.low;
            const prevClose = payload.swingContext?.prevSession?.close;
            
            // Add EMA/SMA levels as dynamic support/resistance
            const ema20 = payload.trendMomentum?.ema20_1D?.ema20;
            const ema50 = payload.trendMomentum?.ema50_1D?.ema50;
            const sma200 = payload.trendMomentum?.sma200_1D?.sma200;
            
//             console.log(`📊 Price context: current=${currentPrice}, swingHigh20=${swingHigh20}, swingLow20=${swingLow20}`);
//             console.log(`📊 MAs: ema20=${ema20}, ema50=${ema50}, sma200=${sma200}`);
            
            // Calculate resistance levels (above current price)
            [swingHigh20, weeklyHigh, ema20, ema50, sma200, prevClose].forEach((level, index) => {
                if (level && level > currentPrice) {
                    const types = ['swing_high_20', 'weekly_high', 'ema20', 'ema50', 'sma200', 'prev_close'];
                    resistances.push({
                        price: +level.toFixed(2),
                        type: types[index],
                        strength: level === swingHigh20 || level === weeklyHigh ? 'strong' : 'medium'
                    });
                }
            });
            
            // Calculate support levels (below current price)
            [swingLow20, weeklyLow, ema20, ema50, sma200, prevClose].forEach((level, index) => {
                if (level && level < currentPrice) {
                    const types = ['swing_low_20', 'weekly_low', 'ema20', 'ema50', 'sma200', 'prev_close'];
                    supports.push({
                        price: +level.toFixed(2),
                        type: types[index],
                        strength: level === swingLow20 || level === weeklyLow ? 'strong' : 'medium'
                    });
                }
            });
            
            // Get recent highs/lows from candle data
            if (payload.snapshots?.lastBars1h?.length > 0) {
                const recentBars = payload.snapshots.lastBars1h.slice(-10); // Last 10 hours
                const recentHighs = recentBars.map(bar => bar[2]).sort((a, b) => b - a); // High prices
                const recentLows = recentBars.map(bar => bar[3]).sort((a, b) => a - b); // Low prices
                
                // Add recent significant highs as resistance
                const significantHigh = recentHighs[0];
                if (significantHigh && significantHigh > currentPrice) {
                    resistances.push({
                        price: +significantHigh.toFixed(2),
                        type: 'recent_high',
                        strength: 'medium'
                    });
                }
                
                // Add recent significant lows as support
                const significantLow = recentLows[0];
                if (significantLow && significantLow < currentPrice) {
                    supports.push({
                        price: +significantLow.toFixed(2),
                        type: 'recent_low',
                        strength: 'medium'
                    });
                }
            }
            
            // Remove duplicates and sort
            const uniqueResistances = resistances.filter((level, index, self) => 
                index === self.findIndex(l => Math.abs(l.price - level.price) < 2) // Within ₹2
            ).sort((a, b) => a.price - b.price).slice(0, 3); // Top 3 closest
            
            const uniqueSupports = supports.filter((level, index, self) => 
                index === self.findIndex(l => Math.abs(l.price - level.price) < 2) // Within ₹2
            ).sort((a, b) => b.price - a.price).slice(0, 3); // Top 3 closest
            
//             console.log(`📊 Calculated ${uniqueSupports.length} support levels:`, uniqueSupports.map(s => `${s.price}(${s.type})`));
//             console.log(`📊 Calculated ${uniqueResistances.length} resistance levels:`, uniqueResistances.map(r => `${r.price}(${r.type})`));
            
            return {
                supports: uniqueSupports,
                resistances: uniqueResistances
            };
            
        } catch (error) {
//             console.error('📊 Error calculating basic levels:', error.message);
            return { supports: [], resistances: [] };
        }
    }

    /**
     * Classify volume based on recent data vs 20-day median
     */
    classifyVolume(marketPayload) {
        try {
//             console.log('📊 Starting volume classification...');
            
            const dailyBars = marketPayload?.snapshots?.lastBars1D;
//             console.log(`📊 Daily bars available: ${dailyBars?.length || 0}`);
            
            if (!dailyBars || dailyBars.length < 5) {
//                 console.log('📊 Insufficient volume data for classification');
                return 'UNKNOWN';
            }
            
            // Get last 20 days of volume data (or available)
            const recentBars = dailyBars.slice(-20);
            const volumes = recentBars.map(bar => {
                const volume = Array.isArray(bar) ? bar[5] : bar.volume;
                return volume;
            }).filter(v => v && v > 0);
            
//             console.log(`📊 Extracted ${volumes.length} valid volume readings from ${recentBars.length} bars`);
//             console.log(`📊 Sample volumes:`, volumes.slice(-5).map(v => parseInt(v/1000000) + 'M')); // Last 5 in millions
            
            if (volumes.length < 5) {
//                 console.log('📊 Insufficient valid volume data');
                return 'UNKNOWN';
            }
            
            // Calculate median volume
            const sortedVolumes = [...volumes].sort((a, b) => a - b);
            const medianIndex = Math.floor(sortedVolumes.length / 2);
            const medianVolume = sortedVolumes.length % 2 === 0 
                ? (sortedVolumes[medianIndex - 1] + sortedVolumes[medianIndex]) / 2
                : sortedVolumes[medianIndex];
            
            // Get latest volume
            const latestVolume = volumes[volumes.length - 1];
            
//             console.log(`📊 Volume analysis: latest=${(latestVolume/1000000).toFixed(1)}M, median=${(medianVolume/1000000).toFixed(1)}M, ratio=${(latestVolume/medianVolume).toFixed(2)}`);
            
            // Classify based on deviation from median
            const ratio = latestVolume / medianVolume;
            let classification;
            if (ratio >= 1.5) classification = 'ABOVE_AVERAGE';
            else if (ratio <= 0.7) classification = 'BELOW_AVERAGE';
            else classification = 'AVERAGE';
            
//             console.log(`📊 Volume classified as: ${classification}`);
            return classification;
            
        } catch (error) {
//             console.error('📊 Error classifying volume:', error.message);
            return 'UNKNOWN';
        }
    }

    /**
     * Calculate standard pivot points from previous session data
     */
    calculatePivotPoints(swingContext) {
//         console.log('📊 Calculating pivot points...');
        
        try {
            const prevSession = swingContext.prevSession;
            if (!prevSession || !prevSession.high || !prevSession.low || !prevSession.close) {
//                 console.warn('📊 Insufficient data for pivot calculation');
                return null;
            }
            
            const high = prevSession.high;
            const low = prevSession.low;
            const close = prevSession.close;
            
//             console.log(`📊 Previous session data: H=${high}, L=${low}, C=${close}`);
            
            // Standard Pivot Point calculation
            const pivot = (high + low + close) / 3;
            
            // Resistance levels
            const r1 = (2 * pivot) - low;      // First resistance
            const r2 = pivot + (high - low);   // Second resistance  
            const r3 = high + 2 * (pivot - low); // Third resistance
            
            // Support levels
            const s1 = (2 * pivot) - high;     // First support
            const s2 = pivot - (high - low);   // Second support
            const s3 = low - 2 * (high - pivot); // Third support
            
            const pivots = {
                pivot: +pivot.toFixed(2),
                r1: +r1.toFixed(2),
                r2: +r2.toFixed(2),
                r3: +r3.toFixed(2),
                s1: +s1.toFixed(2),
                s2: +s2.toFixed(2),
                s3: +s3.toFixed(2),
                calculatedFrom: {
                    high,
                    low,
                    close,
                    date: prevSession.date
                }
            };
            
//             console.log(`📊 Calculated pivots:`, pivots);
//             console.log(`📊 Support levels: S3=${pivots.s3}, S2=${pivots.s2}, S1=${pivots.s1}`);
//             console.log(`📊 Pivot: ${pivots.pivot}`);
//             console.log(`📊 Resistance levels: R1=${pivots.r1}, R2=${pivots.r2}, R3=${pivots.r3}`);
            
            return pivots;
            
        } catch (error) {
//             console.error('📊 Error calculating pivot points:', error.message);
            return null;
        }
    }

    /**
     * Helper functions for data processing
     */
    clampEnum(s, allowed, fallback) {
        return allowed.includes(s) ? s : fallback;
    }

    /**
     * Scoring utilities for strategy evaluation
     */
    clamp(x, a = 0, b = 1) {
        return Math.min(b, Math.max(a, x));
    }

    lerp(x, x0, x1, y0, y1) {
        return this.clamp(y0 + (y1 - y0) * ((x - x0) / (x1 - x0)));
    }

    rrScore(rr) {
        if (rr < 1.5) return 0.2;
        if (rr >= 3.5) return 0.95;
        return this.lerp(rr, 1.5, 3.5, 0.5, 0.9);
    }

    trendScore(alignment, ma) {
        let base = alignment === 'with_trend' ? 0.8 : alignment === 'neutral' ? 0.6 : 0.4;
        if (ma?.ema20_1D && ma?.ema50_1D && ma?.sma200_1D) {
            const bull = ma.ema20_1D > ma.ema50_1D && ma.ema50_1D > ma.sma200_1D;
            const bear = ma.ema20_1D < ma.ema50_1D && ma.ema50_1D < ma.sma200_1D;
            if (bull) base += 0.05;
            if (bear) base -= 0.05;
        }
        return this.clamp(base);
    }

    volatilityFit(entry, target, stop, atr, isSwing) {
        if (!atr || atr <= 0) return 0.5;
        const k = Math.abs(target - entry) / atr;
        const m = Math.abs(entry - stop) / atr;
        const kBand = isSwing ? [0.8, 1.6] : [0.6, 1.2];
        const mBand = isSwing ? [0.5, 1.2] : [0.4, 0.8];
        const center = (a, b) => (a + b) / 2;
        const half = (a, b) => (b - a) / 2;
        const fit = (x, a, b) => this.clamp(1 - Math.abs((x - center(a, b)) / half(a, b)));
        const volFit = 0.5 * fit(k, ...kBand) + 0.5 * fit(m, ...mBand);
        // Add floor to prevent harsh edge penalties for valid setups
        return Math.max(0.3, volFit);
    }

    confluenceScore(strat) {
        const inds = strat.indicators || [];
        const dir = strat.type;
        let score = 0;
        let used = 0;
        
        for (const i of inds) {
            if (i.signal === 'NEUTRAL') { 
                score += 0.5; 
                used++; 
                continue; 
            }
            if (dir === 'BUY' && i.signal === 'BUY') { 
                score += 1; 
                used++; 
                continue; 
            }
            if (dir === 'SELL' && i.signal === 'SELL') { 
                score += 1; 
                used++; 
                continue; 
            }
            used++;
        }
        
        return used ? this.clamp(score / used) : 0.5;
    }

    volumeScore(band) {
        if (band === 'ABOVE_AVERAGE') return 0.8;
        if (band === 'AVERAGE') return 0.6;
        if (band === 'BELOW_AVERAGE') return 0.4;
        return 0.5; // UNKNOWN
    }

    sentimentScore(sentiment, dir) {
        if (!sentiment || dir === 'HOLD' || dir === 'NO_TRADE') return 0.5;
        if ((sentiment === 'BULLISH' && dir === 'BUY') || (sentiment === 'BEARISH' && dir === 'SELL')) return 0.7;
        if ((sentiment === 'BULLISH' && dir === 'SELL') || (sentiment === 'BEARISH' && dir === 'BUY')) return 0.3;
        return 0.5;
    }

    dataQualityScore(missingFrames, barsOk) {
        let s = 0.8;
        s -= Math.min(0.5, (missingFrames || 0) * 0.1);
        if (!barsOk) s -= 0.2;
        return this.clamp(s);
    }

    scoreStrategy(strat, ctx) {
        const { analysisType, market_summary, overall_sentiment, dataHealth } = ctx;
        const last = market_summary?.last;
        const atr = analysisType === 'swing' ? ctx.metrics?.atr14_1D : ctx.metrics?.atr14_1h;
        const rr = Math.abs(strat.target - strat.entry) / Math.abs(strat.entry - strat.stopLoss);
        const w = { rr: 0.35, trend: 0.20, vol: 0.15, conf: 0.15, volm: 0.05, senti: 0.05, data: 0.05 };

        const parts = {
            riskReward: this.rrScore(rr),
            trend: this.trendScore(strat.alignment, ctx.ma),
            volatilityFit: this.volatilityFit(strat.entry, strat.target, strat.stopLoss, atr || 0, analysisType === 'swing'),
            confluence: this.confluenceScore(strat),
            volume: this.volumeScore(market_summary?.volume),
            sentiment: this.sentimentScore(overall_sentiment, strat.type),
            dataQuality: this.dataQualityScore(dataHealth?.missingFrames?.length || 0, !!last),
        };

        let s = w.rr * parts.riskReward + w.trend * parts.trend + w.vol * parts.volatilityFit
            + w.conf * parts.confluence + w.volm * parts.volume + w.senti * parts.sentiment + w.data * parts.dataQuality;

        s = this.clamp(s);
        const band = s >= 0.75 ? 'High' : s >= 0.60 ? 'Medium' : 'Low';
        // Risk meter is inverse of confidence (higher score = lower risk)
        const riskMeter = s >= 0.75 ? 'Low' : s >= 0.60 ? 'Medium' : 'High';
        return { score: +s.toFixed(2), band, riskMeter, components: parts };
    }

    /**
     * Generate stock analysis using market payload
     */
    async generateStockAnalysisWithPayload({ instrument_key, stock_name, stock_symbol, current_price, analysis_type, marketPayload, sentiment, sectorInfo }) {
        const analysisStartTime = Date.now();
        const stepTimes = { start: analysisStartTime };
        
        const timeframe = analysis_type === 'swing' ? '3-7 days' : '1-4 hours';
        const sentimentText = sentiment || 'neutral';
        
        // Extract enhanced sentiment context from payload
        const sentimentContext = marketPayload?.sentimentContext || null;
        const newsLiteDetails = marketPayload?.newsLite?.detailedAnalysis || null;
        
        // Get sector-specific enhancements
        const trailingStops = sectorInfo ? getTrailingStopSuggestions(sectorInfo.code, analysis_type) : null;
        const sectorCorrelation = sectorInfo ? getSectorCorrelationMessage(sectorInfo.code) : null;
        
        stepTimes.prompt_creation = Date.now();
        
        // Create improved analysis prompt with strict JSON requirements
// Create improved analysis prompt with strict JSON requirements and code-actionable gating
const prompt = `
You are a professional stock analyst. Output MUST be valid JSON only (no extra text, no markdown, no comments, no trailing commas).
Use ONLY fields present in MARKET DATA (authoritative). Do NOT invent indicators/values/timeframes not present in MARKET DATA.
Return EXACTLY ONE strategy (the best fit for current data). If no valid setup with RR ≥ 1.5 after ONE adjustment, return EXACTLY ONE NO_TRADE strategy.

ANALYZE: ${stock_name} (${stock_symbol}) for swing opportunities.

MARKET DATA (authoritative):
${JSON.stringify(marketPayload, null, 2)}

CONTEXT:
- Current Price (fallback): ₹${current_price}
- Analysis Type: swing
- Timeframe: 3–7 trading sessions
- Market Sentiment: ${sentiment || 'neutral'}
- Sector: ${sectorInfo?.name || 'Unknown'} (${sectorInfo?.code || 'OTHER'})
- Sector Index: ${sectorInfo?.index || 'NIFTY 50'}
- Sector Correlation: ${sectorCorrelation || 'Monitor broader market trends'}${trailingStops ? `
- Sector Trailing Stops: Conservative: ${trailingStops.conservative}x ATR, Moderate: ${trailingStops.moderate}x ATR, Aggressive: ${trailingStops.aggressive}x ATR` : ''}

ENHANCED SENTIMENT ANALYSIS:${sentimentContext ? `
- Sentiment Confidence: ${sentimentContext.confidence}% (${sentimentContext.strength} strength)
- Reasoning: ${sentimentContext.reasoning}
- Key Factors: ${sentimentContext.keyFactors?.join(', ') || 'None specified'}
- Sector Specific: ${sentimentContext.sectorSpecific ? 'Yes' : 'No'}
- Market Alignment: ${sentimentContext.marketAlignment || 'neutral'}
- Positive Signals: ${sentimentContext.positiveSignals?.join(', ') || 'None'}
- Negative Signals: ${sentimentContext.negativeSignals?.join(', ') || 'None'}
- News Analyzed: ${sentimentContext.newsAnalyzed || 0} articles (${sentimentContext.recentNewsCount || 0} recent)
- Sector News Weight: ${((sentimentContext.sectorNewsWeight || 0) * 100).toFixed(1)}%

TRADING IMPLICATIONS:
- Bias: ${sentimentContext.tradingImplications?.bias || 'neutral'}
- Risk Level: ${sentimentContext.tradingImplications?.riskLevel || 'medium'}
- Position Sizing: ${sentimentContext.tradingImplications?.positionSizing || 'standard'}
- Entry Strategy: ${sentimentContext.tradingImplications?.entryStrategy || 'cautious'}
- Recommendations: ${sentimentContext.tradingImplications?.recommendations?.join('; ') || 'None'}` : `
- Sentiment Confidence: Not available
- Enhanced Analysis: No detailed sentiment data available`}

NEWS CONTEXT:${marketPayload?.newsLite?.notes ? `
${marketPayload.newsLite.notes}` : `
No recent news analysis available`}

EXECUTION CONTRACT (MANDATORY):
- You MUST compute a top-level "runtime" and "order_gate" object for code-actionable gating.
- "order_gate.can_place_order" MUST be true ONLY when:
  (1) strategy.type is BUY or SELL (not NO_TRADE),
  (2) ALL entry "triggers" evaluate TRUE using ONLY MARKET DATA (no missing inputs),
  (3) NO pre_entry invalidations are hit,
  (4) actionability.status = "actionable_now",
  (5) If entryType = "market", conditions (1)-(4) MUST be true; otherwise prefer "stop" or "stop-limit" so the broker gates the fill at \`entry\`.
- If any required input for RULES or triggers is missing (e.g., last or atr14_1D), set insufficientData=true and strategies=[] and set order_gate.can_place_order=false.

RULES (SWING ONLY):
1) Authoritative last = priceContext.last if present; else use Current Price.
2) Daily trend: BULLISH if ema20_1D > ema50_1D AND last > sma200_1D; BEARISH if inverse; else NEUTRAL.
3) Volatility (daily): LOW <1%, MED 1–2%, HIGH >2% using (atr14_1D / last).
4) ATR targets/stops (round to 2 decimals):
   • BUY: target = entry + k*atr14_1D (k∈[0.8,1.6]); stop = entry - m*atr14_1D (m∈[0.5,1.2]).
   • SELL: target = entry - k*atr14_1D; stop = entry + m*atr14_1D (same k,m bounds).
5) Risk–Reward rr = |target-entry| / |entry-stop|. If rr < 1.5, adjust ONCE by tuning k,m within bounds; if still < 1.5 → return NO_TRADE (keep rr field as computed).
6) Bounds: BUY => stop < entry < target. SELL => target < entry < stop. Enforce strictly.
7) Indicators MUST be objects with {name, value, signal} fields. Use ONLY indicators present in MARKET DATA. Do NOT reference pivots/RSI/etc if not present.
8) If required inputs missing (e.g., atr14_1D or last), set insufficientData=true and strategies=[] (no strategy objects).
9) If sentiment contradicts trend, set alignment="counter_trend"; if aligned, "with_trend"; else "neutral".
10) Currency: INR (₹). Round prices, risk, reward, RR to 2 decimals. Numbers MUST be numeric (not strings).
11) Volume band: Use volumeContext.classification from MARKET DATA if available; else "UNKNOWN".
12) EXACTLY ONE strategy in "strategies". If NO_TRADE, fill the single strategy with type="NO_TRADE" and minimal required fields; set order_gate.can_place_order=false.
13) Triggers/invalidations MUST use ONLY fields/timeframes present in MARKET DATA. If a referenced field is absent, you MUST NOT include that trigger/invalid.
14) "runtime.triggers_evaluated" MUST list each trigger with evaluated values and pass/fail booleans. If any trigger cannot be evaluated from MARKET DATA, mark insufficientData=true.
15) Post-entry exits MUST be expressed via "invalidations" with scope="post_entry" and an action (e.g., close_position or move_stop_to).
16) ENHANCED SENTIMENT INTEGRATION:
   • If sentiment confidence ≥ 80% AND sector-specific: Increase target multiplier by 0.2 (within bounds)
   • If sentiment confidence < 60% OR market alignment = "contrary": Reduce target multiplier by 0.2, tighter stops
   • If trading implications suggest "aggressive" entry: Use market orders when all triggers pass
   • If trading implications suggest "cautious" entry: Use stop-limit orders with buffer
   • Consider positive/negative signals from sentiment analysis when setting invalidation triggers
   • If sector news weight > 70%: Weight sector sentiment heavily in overall bias determination
   • Risk Level from trading implications should influence position sizing recommendation in reasoning

VALIDITY (SWING):
- Entry validity: type="GTD" with trading_sessions_soft=5, trading_sessions_hard=8, bars_limit=0, expire_calendar_cap_days=10.
- Position validity: time_stop_sessions=7; gap_policy="exit_at_open_with_slippage".
- Non-trading days: non_trading_policy="pause_clock".

STRICT JSON RETURN (schema v1.4 — include ALL fields exactly as named):
{
  "schema_version": "1.4",
  "symbol": "${stock_symbol}",
  "analysis_type": "swing",
  "generated_at_ist": "<ISO-8601 with +05:30 offset>",
  "insufficientData": false,
  "market_summary": {
    "last": <number>,
    "trend": "BULLISH"|"BEARISH"|"NEUTRAL",
    "volatility": "HIGH"|"MEDIUM"|"LOW",
    "volume": "ABOVE_AVERAGE"|"AVERAGE"|"BELOW_AVERAGE"|"UNKNOWN"
  },
  "overall_sentiment": "BULLISH"|"BEARISH"|"NEUTRAL",
  "sentiment_analysis": {
    "confidence": <number 0..100>,
    "strength": "high"|"medium"|"low",
    "reasoning": "<string from enhanced analysis>",
    "key_factors": ["<factor1>", "<factor2>"],
    "sector_specific": true|false,
    "market_alignment": "aligned"|"contrary"|"neutral",
    "trading_bias": "bullish"|"bearish"|"neutral",
    "risk_level": "low"|"medium"|"high",
    "position_sizing": "increased"|"standard"|"reduced",
    "entry_strategy": "aggressive"|"moderate"|"cautious",
    "news_count": <number>,
    "recent_news_count": <number>,
    "sector_news_weight": <number 0..1>
  },
  "runtime": {
    "triggers_evaluated": [
      {
        "id": "T1",
        "timeframe": "15m|1h|1d",
        "left_ref": "close|high|low|price|rsi14_1h|ema20_1D|sma200_1D",
        "left_value": <number|null>,
        "op": "<|<=|>|>=|crosses_above|crosses_below",
        "right_ref": "value|entry|ema50_1D|sma200_1D",
        "right_value": <number|null>,
        "passed": true|false,
        "evaluable": true|false
      }
    ],
    "pre_entry_invalidations_hit": false
  },
  "order_gate": {
    "all_triggers_true": true|false,
    "no_pre_entry_invalidations": true|false,
    "actionability_status": "actionable_now"|"actionable_on_trigger"|"monitor_only",
    "entry_type_sane": true|false,          // true if "market" only when actionable_now; stop/stop-limit otherwise
    "can_place_order": true|false
  },
  "strategies": [
    {
      "id": "<string>",
      "type": "BUY"|"SELL"|"NO_TRADE",
      "archetype": "breakout"|"pullback"|"trend-follow"|"mean-reversion"|"range-fade",
      "alignment": "with_trend"|"counter_trend"|"neutral",
      "title": "<string>",
      "confidence": <number 0..1>,
      "why_best": "<1 short sentence>",
      "entryType": "limit"|"market"|"range"|"stop"|"stop-limit",
      "entry": <number>,
      "entryRange": [<number>,<number>] | null,
      "target": <number>,
      "stopLoss": <number>,
      "riskReward": <number>,
      "timeframe": "3-7 days",
      "indicators": [
        {
          "name": "ema20_1D|ema50_1D|sma200_1D|rsi14_1h|atr14_1D",
          "value": "<actual value from MARKET DATA>",
          "signal": "BUY|SELL|NEUTRAL"
        }
      ],
      "reasoning": [
        {"because":"ema20_1D({{num}}) vs sma200_1D({{num}}) → {{bias}}"},
        {"because":"rsi14_1h={{num}} → {{signal}}"},
        {"because":"ATR-based target gives RR={{num}} ≥ 1.5"}
      ],
      "warnings": [
        {
          "code": "GAP_RISK",
          "severity": "low"|"medium"|"high",
          "text": "<short caution>",
          "applies_when": [
            {
              "timeframe": "1d"|"1h"|"15m",
              "left": {"ref": "rsi14_1h|ema20_1D|price"},
              "op": "<"|"<="|">"|">="|"crosses_above"|"crosses_below",
              "right": {"ref": "value|ema50_1D|entry|stopLoss", "value": 70, "offset": 0.00}
            }
          ],
          "mitigation": ["reduce_qty","wider_stop","skip_on_news"]
        }
      ],
      "triggers": [
        {
          "id": "T1",
          "scope": "entry",
          "timeframe": "15m|1h|1d",
          "left": {"ref": "close|high|low|price|rsi14_1h|ema20_1D"},
          "op": "<"|"<="|">"|">="|"crosses_above"|"crosses_below",
          "right": {"ref": "value|ema50_1D|sma200_1D|entry", "value": <number>, "offset": <number>},
          "occurrences": {"count": 1, "consecutive": true},
          "within_sessions": 5,
          "expiry_bars": 20
        }
      ],
      "confirmation": {
        "require": "ALL"|"ANY"|"NONE",
        "window_bars": 8,
        "conditions": [
          {
            "timeframe": "1h"|"15m"|"1d",
            "left": {"ref": "rsi14_1h|close"},
            "op": "<"|"<="|">"|">="|"crosses_above"|"crosses_below",
            "right": {"ref": "value|entry", "value": <number>}
          }
        ]
      },
      "invalidations": [
        {
          "scope": "pre_entry",
          "timeframe": "1h"|"15m"|"1d",
          "left": {"ref": "close|low|price"},
          "op": "<"|"<="|">"|">=",
          "right": {"ref": "entry|value", "value": <number>},
          "occurrences": {"count": 1, "consecutive": false},
          "action": "cancel_entry",
          "action_args": {"price_ref": "entry"}
        },
        {
          "scope": "post_entry",
          "timeframe": "1h"|"1d",
          "left": {"ref": "close|low|price"},
          "op": "<"|"<=",
          "right": {"ref": "stopLoss"},
          "occurrences": {"count": 1, "consecutive": false},
          "action": "close_position"
        }
      ],
      "validity": {
        "entry": {
          "type": "GTD",
          "bars_limit": 0,
          "trading_sessions_soft": 5,
          "trading_sessions_hard": 8,
          "expire_calendar_cap_days": 10
        },
        "position": {
          "time_stop_sessions": 7,
          "gap_policy": "exit_at_open_with_slippage"
        },
        "non_trading_policy": "pause_clock"
      },
      "beginner_summary": {
        "one_liner": "<120 chars: Buy/Sell ~₹ENTRY → Take profit ₹TARGET → Exit ₹STOP (3–7 sessions)>",
        "steps": [
          "Step 1 (entry in plain words)",
          "Step 2 (target in plain words)",
          "Step 3 (stop/invalidation in plain words)"
        ],
        "checklist": [
          "Confirm timeframe (swing, daily/1h context)",
          "Make sure trigger condition is true",
          "Place order type that matches entryType"
        ]
      },
      "ui_friendly": {
      "why_smart_move": "Simple 1-2 sentence explanation for the non technical retail trader ",
      "ai_will_watch": [
        "Non-Technical-Human-Retail-Trader-readable trigger 1",
        Non-Technical-Human-Retail-Trader-readable trigger 2"
      ],
      "beginner_explanation": "One paragraph summary for Non-Technical-Human-Retail-Trader"
    },
      "why_in_plain_words": [
        {"point": "<short reason>", "evidence": "<field reference from MARKET DATA>"},
        {"point": "<short reason>", "evidence": "<field reference from MARKET DATA>"}
      ],
      "what_could_go_wrong": [
        {"risk": "<concise risk>", "likelihood": "LOW"|"MEDIUM"|"HIGH", "impact": "LOW"|"MEDIUM"|"HIGH", "mitigation": "<simple rule>"}
      ],
      "money_example": {
        "per_share": {
          "risk": <number>,
          "reward": <number>,
          "rr": <number>
        },
        "position": {
          "qty": <number>,
          "max_loss": <number>,
          "potential_profit": <number>,
          "distance_to_stop_pct": <number>,
          "distance_to_target_pct": <number>
        }
      },
      "suggested_qty": {
        "risk_budget_inr": 1000,
        "risk_per_share": <number>,
        "qty": <number>,
        "alternatives": [
          {"risk_budget_inr": 500, "qty": <number>},
          {"risk_budget_inr": 1000, "qty": <number>},
          {"risk_budget_inr": 2500, "qty": <number>}
        ],
        "note": "Position sizing is based purely on stop distance and a fixed risk budget."
      },

      "risk_meter": {
        "label": "Low"|"Medium"|"High",
        "score": <number 0..1>,
        "drivers": [
          "RR band",
          "Trend alignment",
          "Volatility vs ATR",
          "Volume band",
          "News/sentiment tilt"
        ]
      },
      "actionability": {
        "label": "Buy idea"|"Sell idea"|"No trade",
        "status": "actionable_now"|"actionable_on_trigger"|"monitor_only",
        "next_check_in": "15m"|"1h"|"daily",
        "checklist": [
          "All triggers satisfied",
          "No invalidation hit",
          "Order type matches entry plan"
        ]
      },
      "glossary": {
        "entry": {"definition": "Price to open the trade.", "example": "₹<ENTRY>"},
        "target": {"definition": "Price to take profits.", "example": "₹<TARGET>"},
        "stopLoss": {"definition": "Price to exit to limit loss.", "example": "₹<STOP>"}
      }
    }
  ],
  "disclaimer": "AI-generated educational analysis. Not investment advice."
}
`;

        const systemPrompt = "You are the best swing trading expert in Indian stock markets. Always respond in valid JSON only, with precise and professional analysis based on Indian equities, indices (NIFTY, BANKNIFTY, etc.), and sector trends.";
        stepTimes.message_formatting = Date.now();
        const formattedMessages = this.formatMessagesForModel(this.analysisModel, systemPrompt, prompt);
        
        stepTimes.payload_building = Date.now();
        const requestPayload = this.buildRequestPayload(this.analysisModel, formattedMessages, true);
        
        // Create prompt hash for debugging
        
        
        stepTimes.api_call_start = Date.now();
        const completion = await axios.post('https://api.openai.com/v1/chat/completions',
            requestPayload,
            {
                headers: {
                    'Authorization': `Bearer ${this.openaiApiKey}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        stepTimes.api_call_end = Date.now();

        const content = completion.data.choices[0]?.message?.content;
//         console.log('🤖 Raw AI response length:', content?.length || 0);
//         console.log('🤖 Response preview:', content?.substring(0, 200) + '...');
        
        let parsed;
        try {
            if (!content || typeof content !== 'string') {
                throw new Error('Invalid AI response: empty or non-string content');
            }
            
            // Try to clean up common JSON formatting issues
            let cleanContent = content.trim();
            
            // Remove markdown code blocks if present
            if (cleanContent.startsWith('```json')) {
                cleanContent = cleanContent.replace(/^```json\s*/, '').replace(/\s*```$/, '');
            } else if (cleanContent.startsWith('```')) {
                cleanContent = cleanContent.replace(/^```\s*/, '').replace(/\s*```$/, '');
            }
            
            // Ensure it starts and ends with braces
            if (!cleanContent.startsWith('{')) {
                const jsonStart = cleanContent.indexOf('{');
                if (jsonStart > -1) {
                    cleanContent = cleanContent.substring(jsonStart);
                } else {
                    throw new Error('No JSON object found in response');
                }
            }
            
            if (!cleanContent.endsWith('}')) {
                const jsonEnd = cleanContent.lastIndexOf('}');
                if (jsonEnd > -1) {
                    cleanContent = cleanContent.substring(0, jsonEnd + 1);
                } else {
                    throw new Error('Incomplete JSON object in response');
                }
            }
            
//             console.log('🤖 Cleaned JSON length:', cleanContent.length);
            parsed = JSON.parse(cleanContent);
            
        } catch (e) {
//             console.error('❌ JSON parse failed. Raw content:', content);
//             console.error('❌ Parse error:', e.message);
            
            // Return fallback analysis instead of throwing
            return this.generateFallbackAnalysis(current_price, analysis_type);
        }
        
        // 2. Add metadata for debugging (store what was sent to API)
        if (!parsed.meta) {
            parsed.meta = {};
        }
        parsed.meta.model_used = this.analysisModel;
        parsed.meta.processing_time_ms = Date.now() - analysisStartTime;
        parsed.meta.formatted_messages = formattedMessages; // Store exact messages sent to GPT-5
      
        
        
        // Check if AI returned insufficientData and log the reason
        if (parsed.insufficientData === true) {
            console.log(`🚨 [INSUFFICIENT DATA] AI detected missing data for ${stock_symbol}:`);
            console.log(`   insufficientData: ${parsed.insufficientData}`);
            console.log(`   strategies: ${parsed.strategies?.length || 0} strategies`);
            console.log(`   market_summary:`, parsed.market_summary || 'missing');
            console.log(`   runtime.triggers_evaluated:`, parsed.runtime?.triggers_evaluated || 'missing');
            
            // Log what data was missing based on the AI's analysis
            const missingData = [];
            if (!parsed.market_summary?.last) missingData.push('market_summary.last');
            if (!parsed.runtime?.triggers_evaluated?.length) missingData.push('runtime.triggers_evaluated');
            if (parsed.strategies?.length === 0) missingData.push('no strategies generated');
            
            console.log(`🔍 [INSUFFICIENT DATA] Likely missing data elements:`, missingData);
        }
        
        // // 3. That's it! Return GPT-5's response directly
        // console.log(`✅ GPT-5 analysis complete for ${stock_symbol}`);
        // console.log(`   Strategies: ${parsed.strategies?.length || 0}`);
        // console.log(`   Confidence: ${parsed.strategies?.[0]?.confidence || 'N/A'}`);

        return parsed;
    }


    /**
     * Helper function to call OpenAI API with JSON strict mode and token tracking
     */
    async callOpenAIJsonStrict(model, messages, forceJson = true) {
        const payload = this.buildRequestPayload(model, messages, !!forceJson);

        const res = await axios.post('https://api.openai.com/v1/chat/completions', payload, {
            headers: {
                'Authorization': `Bearer ${this.openaiApiKey}`,
                'Content-Type': 'application/json'
            }
        });

        // Extract token usage from response
        const usage = res.data?.usage || {};
        const tokenUsage = {
            input_tokens: usage.prompt_tokens || 0,
            output_tokens: usage.completion_tokens || 0,
            cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0,
            total_tokens: usage.total_tokens || 0
        };

        let content = res.data?.choices?.[0]?.message?.content ?? '';

        // Strip accidental code fences
        content = content.trim().replace(/^```json\s*/i, '').replace(/```$/,'');

        return {
            data: JSON.parse(content),
            tokenUsage
        };
    }


    /**
     * Stage 1: Preflight & Market Summary
     * Validates MARKET DATA and computes market_summary
     */
    async stage1Preflight({ stock_name, stock_symbol, current_price, marketPayload, sectorInfo }) {
        try {
            const { system, user } = buildStage1Prompt({ stock_name, stock_symbol, current_price, marketPayload, sectorInfo });
            const msgs = this.formatMessagesForModel(this.analysisModel, system, user);

            console.log(`🛫 [STAGE 1] ${stock_symbol} - Calling OpenAI API...`);
            const { data: out, tokenUsage } = await this.callOpenAIJsonStrict(this.analysisModel, msgs, true);

            // Gate quickly
            if (out.insufficientData === true) {
                console.log(`⚠️ [STAGE 1] ${stock_symbol} - Insufficient data detected`);
                return { ok: false, s1: out, tokenUsage };
            }
            console.log(`✅ [STAGE 1] ${stock_symbol} - Success (Tokens: ${tokenUsage.total_tokens})`);
            return { ok: true, s1: out, tokenUsage };
        } catch (error) {
            console.error(`❌ [STAGE 1] ${stock_symbol} - FAILED`);
            console.error(`❌ [STAGE 1] Error message: ${error.message}`);
            console.error(`❌ [STAGE 1] Error stack: ${error.stack}`);
            if (error.response) {
                console.error(`❌ [STAGE 1] OpenAI Response Status: ${error.response.status}`);
                console.error(`❌ [STAGE 1] OpenAI Response Data:`, JSON.stringify(error.response.data, null, 2));
            }
            throw error;
        }
    }


    /**
     * Stage 2: Strategy Skeleton & Triggers
     * Builds ONE best-fit skeleton (BUY/SELL/NO_TRADE) with entry/stop/target ranges
     */
    async stage2Skeleton({ stock_name, stock_symbol, current_price, marketPayload, s1 }) {
        try {
            const { system, user } = buildStage2Prompt({ stock_name, stock_symbol, current_price, marketPayload, s1 });
            const msgs = this.formatMessagesForModel(this.analysisModel, system, user);

            console.log(`🛫 [STAGE 2] ${stock_symbol} - Calling OpenAI API...`);
            const { data: out, tokenUsage } = await this.callOpenAIJsonStrict(this.analysisModel, msgs, true);

            // Gate: if NO_TRADE is returned we still go to Stage 3 (final will carry NO_TRADE)
            if (out.insufficientData === true) {
                console.log(`⚠️ [STAGE 2] ${stock_symbol} - Insufficient data detected`);
                return { ok: false, s2: out, tokenUsage };
            }
            console.log(`✅ [STAGE 2] ${stock_symbol} - Success (Tokens: ${tokenUsage.total_tokens})`);
            return { ok: true, s2: out, tokenUsage };
        } catch (error) {
            console.error(`❌ [STAGE 2] ${stock_symbol} - FAILED`);
            console.error(`❌ [STAGE 2] Error message: ${error.message}`);
            console.error(`❌ [STAGE 2] Error stack: ${error.stack}`);
            if (error.response) {
                console.error(`❌ [STAGE 2] OpenAI Response Status: ${error.response.status}`);
                console.error(`❌ [STAGE 2] OpenAI Response Data:`, JSON.stringify(error.response.data, null, 2));
            }
            throw error;
        }
    }


    /**
     * Stage 3: Final Assembly (v1.4)
     * Combines MARKET DATA + S1 + S2 + sentimentContext
     */
    async stage3Finalize({ stock_name, stock_symbol, current_price, marketPayload, sectorInfo, s1, s2, instrument_key, game_mode = 'cricket' }) {
        try {
            const { system, user } = await buildStage3Prompt({ stock_name, stock_symbol, current_price, marketPayload, sectorInfo, s1, s2, instrument_key, game_mode });
            const msgs = this.formatMessagesForModel(this.analysisModel, system, user);

            console.log(`🛫 [STAGE 3] ${stock_symbol} - Calling OpenAI API...`);
            const { data: out, tokenUsage } = await this.callOpenAIJsonStrict(this.analysisModel, msgs, true);

            // 🧪 DEBUG: Write Stage 3 output to file for inspection
            // try {
            //     const fs = await import('fs/promises');
            //     const path = await import('path');
            //     const debugDir = path.join(process.cwd(), 'debug-logs');
            //     await fs.mkdir(debugDir, { recursive: true });

            //     const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            //     const filename = `stage3-${stock_symbol}-${timestamp}.json`;
            //     const filepath = path.join(debugDir, filename);

            //     await fs.writeFile(filepath, JSON.stringify({
            //         stock_symbol,
            //         timestamp: new Date().toISOString(),
            //         output: out,
            //         tokenUsage
            //     }, null, 2));

            //     console.log(`📝 [DEBUG] Stage 3 output written to: ${filepath}`);
            // } catch (err) {
            //     console.error('❌ [DEBUG] Failed to write Stage 3 output:', err.message);
            // }

            console.log(`✅ [STAGE 3] ${stock_symbol} - Success (Tokens: ${tokenUsage.total_tokens})`);
            return { data: out, tokenUsage };
        } catch (error) {
            console.error(`❌ [STAGE 3] ${stock_symbol} - FAILED`);
            console.error(`❌ [STAGE 3] Error message: ${error.message}`);
            console.error(`❌ [STAGE 3] Error stack: ${error.stack}`);
            if (error.response) {
                console.error(`❌ [STAGE 3] OpenAI Response Status: ${error.response.status}`);
                console.error(`❌ [STAGE 3] OpenAI Response Data:`, JSON.stringify(error.response.data, null, 2));
            }
            throw error;
        }
    }


    /**
     * NEW ORCHESTRATOR (3-call) - Generates stock analysis using 3-stage process
     * Includes token tracking for cost calculation
     */
    async generateStockAnalysis3Call({ stock_name, stock_symbol, current_price, analysis_type, marketPayload, sentiment, sectorInfo, instrument_key }) {
        const t0 = Date.now();
        console.log(`⏱️ [3-STAGE] Starting 3-stage analysis for ${stock_symbol}`);

        // Initialize token tracking
        const tokenTracking = {
            stage1: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, total_tokens: 0 },
            stage2: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, total_tokens: 0 },
            stage3: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, total_tokens: 0 },
            total: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, total_tokens: 0 }
        };

        // STAGE 1
        const stage1Start = Date.now();
        console.log(`⏱️ [STAGE 1] ${stock_symbol} - Starting preflight validation...`);
        const stage1Prompts = buildStage1Prompt({ stock_name, stock_symbol, current_price, marketPayload, sectorInfo });

        let s1r;
        let stage1Time = 0;
        try {
            s1r = await this.stage1Preflight({ stock_name, stock_symbol, current_price, marketPayload, sectorInfo });
            tokenTracking.stage1 = s1r.tokenUsage;
            stage1Time = Date.now() - stage1Start;
            console.log(`⏱️ [STAGE 1] ${stock_symbol} - Completed in ${stage1Time}ms - Tokens: ${s1r.tokenUsage.total_tokens} (${s1r.ok ? 'PASS ✅' : 'FAIL ⚠️'})`);
        } catch (error) {
            stage1Time = Date.now() - stage1Start;
            console.error(`⏱️ [STAGE 1] ${stock_symbol} - FAILED in ${stage1Time}ms`);
            console.error(`❌ [STAGE 1 ERROR] ${stock_symbol}:`, error.message);
            throw error;
        }

        // Save Stage 1 fine-tune data
        if (instrument_key) {
            this.saveFineTuneData({
                instrument_key,
                stock_symbol,
                stock_name,
                analysis_type,
                current_price,
                stage: 'stage1',
                prompt: stage1Prompts.user,
                response: s1r.s1,
                model_used: this.analysisModel,
                token_usage: tokenTracking.stage1,
                analysis_status: s1r.ok ? 'completed' : 'insufficient_data',
                market_context: {
                    trend: marketPayload?.market_summary?.trend,
                    volatility: marketPayload?.market_summary?.volatility,
                    volume: marketPayload?.market_summary?.volume,
                    sentiment: marketPayload?.sentimentContext?.basicSentiment
                }
            }).catch(err => console.error('Failed to save stage1 fine-tune data:', err));
        }

        if (!s1r.ok) {
            // Calculate totals
            Object.keys(tokenTracking.total).forEach(key => {
                tokenTracking.total[key] = tokenTracking.stage1[key];
            });

            // Return minimal v1.4-shaped NO_TRADE with insufficientData flag
            return {
                schema_version: "1.4",
                symbol: stock_symbol,
                analysis_type: "swing",
                generated_at_ist: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata', hour12: false }).replace(' ', 'T') + "+05:30",
                insufficientData: true,
                market_summary: s1r.s1?.market_summary ?? {
                    last: Number(current_price) || null,
                    trend: "NEUTRAL",
                    volatility: "MEDIUM",
                    volume: "UNKNOWN"
                },
                overall_sentiment: (marketPayload?.sentimentContext?.basicSentiment || 'neutral').toUpperCase(),
                sentiment_analysis: {
                    confidence: marketPayload?.sentimentContext?.confidence ?? 0,
                    strength: marketPayload?.sentimentContext?.strength ?? "low",
                    reasoning: "Insufficient market data to build a valid setup.",
                    key_factors: [],
                    sector_specific: !!marketPayload?.sentimentContext?.sectorSpecific,
                    market_alignment: marketPayload?.sentimentContext?.marketAlignment || "neutral",
                    trading_bias: "neutral",
                    risk_level: "high",
                    position_sizing: "reduced",
                    entry_strategy: "cautious",
                    news_count: marketPayload?.sentimentContext?.newsAnalyzed ?? 0,
                    recent_news_count: marketPayload?.sentimentContext?.recentNewsCount ?? 0,
                    sector_news_weight: marketPayload?.sentimentContext?.sectorNewsWeight ?? 0
                },
                runtime: { triggers_evaluated: [], pre_entry_invalidations_hit: false },
                order_gate: {
                    all_triggers_true: false,
                    no_pre_entry_invalidations: true,
                    actionability_status: "monitor_only",
                    entry_type_sane: true,
                    can_place_order: false
                },
                strategies: [
                    {
                        "id": "S1",
                        "type": "NO_TRADE",
                        "archetype": "trend-follow",
                        "alignment": "neutral",
                        "title": "No trade — insufficient data",
                        "confidence": 0.0,
                        "why_best": "Cannot satisfy data requirements safely.",
                        "entryType": "limit",
                        "entry": Number(current_price) || 0,
                        "entryRange": null,
                        "target": Number(current_price) || 0,
                        "stopLoss": Number(current_price) || 0,
                        "riskReward": 0.0,
                        "timeframe": "3-7 days",
                        "indicators": [],
                        "reasoning": [],
                        "warnings": [],
                        "triggers": [],
                        "confirmation": { "require": "NONE", "window_bars": 0, "conditions": [] },
                        "invalidations": [],
                        "validity": {
                            "entry": { "type": "GTD", "bars_limit": 0, "trading_sessions_soft": 5, "trading_sessions_hard": 8, "expire_calendar_cap_days": 10 },
                            "position": { "time_stop_sessions": 7, "gap_policy": "exit_at_open_with_slippage" },
                            "non_trading_policy": "pause_clock"
                        },
                        "beginner_summary": { "one_liner": "No trade due to missing data.", "steps": [], "checklist": [] },
                        "why_in_plain_words": [],
                        "what_could_go_wrong": [],
                        "ui_friendly": {
                            "why_smart_move": "Skipping avoids random risk.",
                            "ai_will_watch": [],
                            "beginner_explanation": "Wait for better data quality before acting."
                        },
                        "money_example": {
                            "per_share": { "risk": 0, "reward": 0, "rr": 0 },
                            "position": { "qty": 0, "max_loss": 0, "potential_profit": 0, "distance_to_stop_pct": 0, "distance_to_target_pct": 0 }
                        },
                        "suggested_qty": {
                            "risk_budget_inr": 1000,
                            "risk_per_share": 0,
                            "qty": 0,
                            "alternatives": [
                                {"risk_budget_inr":500,"qty":0},
                                {"risk_budget_inr":1000,"qty":0},
                                {"risk_budget_inr":2500,"qty":0}
                            ],
                            "note": "No trade."
                        },
                        "risk_meter": { "label": "High", "score": 1.0, "drivers": ["Data quality"] },
                        "actionability": { "label": "No trade", "status": "monitor_only", "next_check_in": "daily", "checklist": [] },
                        "glossary": {
                            "entry": {"definition":"Price to open the trade.","example":"₹0"},
                            "target":{"definition":"Price to take profits.","example":"₹0"},
                            "stopLoss":{"definition":"Price to exit to limit loss.","example":"₹0"}
                        }
                    }
                ],
                "disclaimer": "AI-generated educational analysis. Not investment advice.",
                "meta": {
                    "processing_time_ms": Date.now() - t0,
                    "stage": "s1-stop",
                    "model_used": this.analysisModel,
                    "token_usage": tokenTracking
                }
            };
        }

        // STAGE 2
        const stage2Start = Date.now();
        console.log(`⏱️ [STAGE 2] ${stock_symbol} - Starting strategy skeleton generation...`);
        const stage2Prompts = buildStage2Prompt({ stock_name, stock_symbol, current_price, marketPayload, s1: s1r.s1 });

        let s2r;
        let stage2Time = 0;
        try {
            s2r = await this.stage2Skeleton({ stock_name, stock_symbol, current_price, marketPayload, s1: s1r.s1 });
            tokenTracking.stage2 = s2r.tokenUsage;
            stage2Time = Date.now() - stage2Start;
            console.log(`⏱️ [STAGE 2] ${stock_symbol} - Completed in ${stage2Time}ms - Tokens: ${s2r.tokenUsage.total_tokens} (${s2r.ok ? 'PASS ✅' : 'FAIL ⚠️'})`);
        } catch (error) {
            stage2Time = Date.now() - stage2Start;
            console.error(`⏱️ [STAGE 2] ${stock_symbol} - FAILED in ${stage2Time}ms`);
            console.error(`❌ [STAGE 2 ERROR] ${stock_symbol}:`, error.message);
            throw error;
        }

        // Save Stage 2 fine-tune data
        if (instrument_key) {
            this.saveFineTuneData({
                instrument_key,
                stock_symbol,
                stock_name,
                analysis_type,
                current_price,
                stage: 'stage2',
                prompt: stage2Prompts.user,
                response: s2r.s2,
                model_used: this.analysisModel,
                token_usage: tokenTracking.stage2,
                analysis_status: s2r.ok ? 'completed' : 'insufficient_data',
                market_context: {
                    trend: marketPayload?.market_summary?.trend,
                    volatility: marketPayload?.market_summary?.volatility,
                    volume: marketPayload?.market_summary?.volume,
                    sentiment: marketPayload?.sentimentContext?.basicSentiment
                }
            }).catch(err => console.error('Failed to save stage2 fine-tune data:', err));
        }
        let s3result;
        let stage3Time = 0;

        let game_mode = "badminton";

        // STAGE 3
        const stage3Start = Date.now();
        console.log(`⏱️ [STAGE 3] ${stock_symbol} - Starting final assembly with UI-friendly fields...`);

        try {
            s3result = await this.stage3Finalize({
                stock_name, stock_symbol, current_price, marketPayload, sectorInfo, s1: s1r.s1, s2: s2r.s2, instrument_key, game_mode
            });
            tokenTracking.stage3 = s3result.tokenUsage;
            stage3Time = Date.now() - stage3Start;
            console.log(`⏱️ [STAGE 3] ${stock_symbol} - Completed in ${stage3Time}ms - Tokens: ${s3result.tokenUsage.total_tokens} ✅`);
        } catch (error) {
            stage3Time = Date.now() - stage3Start;
            console.error(`⏱️ [STAGE 3] ${stock_symbol} - FAILED in ${stage3Time}ms`);
            console.error(`❌ [STAGE 3 ERROR] ${stock_symbol}:`, error.message);
            throw error;
        }
        
        // Generate Stage 3 prompts for fine-tune data
        const stage3Prompts = await buildStage3Prompt({
            stock_name,
            stock_symbol,
            current_price,
            marketPayload,
            sectorInfo,
            s1: s1r.s1,
            s2: s2r.s2,
            instrument_key,
            game_mode
        });

        // Save Stage 3 fine-tune data
        if (instrument_key) {
            this.saveFineTuneData({
                instrument_key,
                stock_symbol,
                stock_name,
                analysis_type,
                current_price,
                stage: 'stage3',
                prompt: stage3Prompts.user,
                response: s3result.data,
                model_used: this.analysisModel,
                token_usage: tokenTracking.stage3,
                analysis_status: 'completed',
                market_context: {
                    trend: marketPayload?.market_summary?.trend,
                    volatility: marketPayload?.market_summary?.volatility,
                    volume: marketPayload?.market_summary?.volume,
                    sentiment: marketPayload?.sentimentContext?.basicSentiment
                }
            }).catch(err => console.error('Failed to save stage3 fine-tune data:', err));
        }

        const finalOut = s3result.data;

        // Calculate total token usage
        Object.keys(tokenTracking.total).forEach(key => {
            tokenTracking.total[key] =
                tokenTracking.stage1[key] +
                tokenTracking.stage2[key] +
                tokenTracking.stage3[key];
        });

        // Attach meta with token tracking
        if (!finalOut.meta) finalOut.meta = {};
        finalOut.meta.model_used = this.analysisModel;
        finalOut.meta.processing_time_ms = Date.now() - t0;
        finalOut.meta.stage_chain = ["s1","s2","s3"];
        finalOut.meta.token_usage = tokenTracking;

        // Add candle metadata for UI display
        finalOut.meta.candle_info = this.extractCandleMetadata(marketPayload);

        const total3StageTime = Date.now() - t0;
        console.log(`⏱️ [3-STAGE] ========== COMPLETE: ${stock_symbol} ==========`);
        console.log(`⏱️ [3-STAGE] Total Time: ${total3StageTime}ms (${(total3StageTime / 1000).toFixed(2)}s)`);
        console.log(`⏱️ [3-STAGE] Breakdown:`);
        console.log(`   - Stage 1 (Preflight): ${stage1Time}ms`);
        console.log(`   - Stage 2 (Skeleton): ${stage2Time}ms`);
        console.log(`   - Stage 3 (Finalize): ${stage3Time}ms`);
        console.log(`   - Other operations: ${total3StageTime - stage1Time - stage2Time - stage3Time}ms`);
        console.log(`📊 [TOKEN USAGE] ${stock_symbol} - Total: ${tokenTracking.total.total_tokens} (Input: ${tokenTracking.total.input_tokens}, Output: ${tokenTracking.total.output_tokens}, Cached: ${tokenTracking.total.cached_tokens})`);

        // Store usage data in separate collection for persistent cost tracking
        // Note: This will be called from the caller with userId
        finalOut._tokenTracking = tokenTracking;  // Pass along for caller to save
        finalOut._processingTime = Date.now() - t0;

        return finalOut;
    }

    /**
     * Save token usage data for cost tracking
     * Call this AFTER analysis is generated and you have userId
     * If records already exist for this analysis_id (from cached/in_progress calls),
     * update all of them with token usage data while keeping each user's user_id
     */
    async saveTokenUsage({ userId, analysisId, stockSymbol, analysisType, analysisData, tokenTracking, processingTime }) {
        try {
            // Extract result metadata
            const strategy = analysisData?.strategies?.[0];
            const resultMeta = {
                insufficient_data: analysisData?.insufficientData || false,
                strategy_type: strategy?.type || 'UNKNOWN',
                confidence: strategy?.confidence || 0,
                risk_reward: strategy?.riskReward || 0
            };

            // OpenAI pricing (as of Jan 2025 for gpt-4o)
            const pricing = {
                model_name: 'gpt-4o',
                input_price_per_1k: 0.0025,   // $2.50 per 1M input tokens
                output_price_per_1k: 0.010,   // $10.00 per 1M output tokens
                cached_price_per_1k: 0.00125, // 50% discount for cached
                usd_to_inr_rate: 83.0
            };

            // Calculate costs
            const inputCost = (tokenTracking.total.input_tokens / 1000) * pricing.input_price_per_1k;
            const outputCost = (tokenTracking.total.output_tokens / 1000) * pricing.output_price_per_1k;
            const cachedCost = (tokenTracking.total.cached_tokens / 1000) * pricing.cached_price_per_1k;
            const totalCostUsd = inputCost + outputCost + cachedCost;
            const totalCostInr = totalCostUsd * pricing.usd_to_inr_rate;

            // Calculate cache hit rate
            const totalNonCachedTokens = tokenTracking.total.input_tokens + tokenTracking.total.output_tokens;
            const cacheHitRate = totalNonCachedTokens > 0
                ? (tokenTracking.total.cached_tokens / (tokenTracking.total.cached_tokens + totalNonCachedTokens)) * 100
                : 0;

            const usageData = {
                token_usage: tokenTracking,
                cost_breakdown: {
                    input_cost: inputCost,
                    output_cost: outputCost,
                    cached_cost: cachedCost,
                    total_cost_usd: totalCostUsd,
                    total_cost_inr: totalCostInr
                },
                pricing_model: pricing,
                performance: {
                    total_duration_ms: processingTime,
                    stage1_duration_ms: 0,
                    stage2_duration_ms: 0,
                    stage3_duration_ms: 0,
                    cache_hit_rate: cacheHitRate
                },
                result: resultMeta
            };

            // Check if records already exist for this analysis_id (from cached/duplicate calls)
            if (analysisId) {
                const existingRecords = await UserAnalyticsUsage.find({
                    analysis_id: analysisId
                }).sort({ createdAt: 1 }); // Sort by creation time (oldest first)

                if (existingRecords && existingRecords.length > 0) {
                    // Update first record (original user who triggered analysis) - set is_cached_analysis = false
                    const firstRecordId = existingRecords[0]._id;
                    await UserAnalyticsUsage.updateOne(
                        { _id: firstRecordId },
                        {
                            $set: {
                                ...usageData,
                                stock_symbol: stockSymbol,
                                analysis_type: analysisType,
                                is_cached_analysis: false // Original user who generated it
                            }
                        }
                    );

                    // Update rest of the records - set is_cached_analysis = true
                    if (existingRecords.length > 1) {
                        const restRecordIds = existingRecords.slice(1).map(r => r._id);
                        await UserAnalyticsUsage.updateMany(
                            { _id: { $in: restRecordIds } },
                            {
                                $set: {
                                    ...usageData,
                                    stock_symbol: stockSymbol,
                                    analysis_type: analysisType,
                                    is_cached_analysis: true // Other users who accessed cached version
                                }
                            }
                        );
                    }

                    console.log(`💰 [COST TRACKING] Updated ${existingRecords.length} existing usage records for ${stockSymbol}: ₹${totalCostInr.toFixed(4)} (${tokenTracking.total.total_tokens} tokens) - 1 original + ${existingRecords.length - 1} cached`);
                    return existingRecords[0]; // Return first record
                }
                else{
                    const usageRecord = await UserAnalyticsUsage.create({
                        user_id: userId,
                        analysis_id: analysisId || null,
                        stock_symbol: stockSymbol,
                        analysis_type: analysisType,
                        ...usageData,
                        billing_context: {
                            is_free_tier: true,
                            is_trial: false,
                            subscription_plan: 'free',
                            charge_user: false
                        }
                    });

                    console.log(`💰 [COST TRACKING] Created new usage record for ${stockSymbol}: ₹${totalCostInr.toFixed(4)} (${tokenTracking.total.total_tokens} tokens)`);

                    return usageRecord;
                }
            }

            // No existing records - create new one for this user
           

        } catch (error) {
            console.error(`❌ [COST TRACKING] Failed to save usage data:`, error);
            // Don't throw - tracking failure shouldn't break analysis
            return null;
        }
    }


    /**
     * Get cached analysis if available and not expired
     */
    async getCachedAnalysis(instrument_key, analysis_type) {
        return await StockAnalysis.findByInstrument(instrument_key, analysis_type);
    }

    /**
     * Get expiry date based on analysis type
     */
    getExpiryDate(analysis_type) {
        const now = new Date();
        if (analysis_type === 'swing') {
            // Swing analysis valid for 24 hours
            return new Date(now.getTime() + (24 * 60 * 60 * 1000));
        } else {
            // Intraday analysis valid for 1 hour
            return new Date(now.getTime() + (1 * 60 * 60 * 1000));
        }
    }

    /**
     * Validate and format AI response
     */
    validateAndFormatResponse(response, current_price, analysis_type) {
        // Ensure required fields exist
        if (!response.strategies || !Array.isArray(response.strategies)) {
            throw new Error('Invalid strategies format');
        }

        // Format strategies
        const formattedStrategies = response.strategies.map((strategy, index) => ({
            id: strategy.id || (index + 1).toString(),
            type: strategy.type || 'HOLD',
            title: strategy.title || 'Technical Analysis',
            confidence: Math.min(Math.max(strategy.confidence || 0.7, 0), 1),
            entry: strategy.entry || current_price.toString(),
            target: strategy.target || (current_price * 1.05).toFixed(2),
            stopLoss: strategy.stopLoss || (current_price * 0.95).toFixed(2),
            reasoning: strategy.reasoning || ['Technical analysis indicates potential movement'],
            indicators: strategy.indicators || [],
            riskReward: strategy.riskReward || '1:2',
            timeframe: analysis_type === 'swing' ? '3-7 days' : '1-4 hours'
        }));

        return {
            strategies: formattedStrategies,
            market_conditions: response.market_conditions || {
                trend: 'NEUTRAL',
                volatility: 'MEDIUM',
                volume: 'AVERAGE'
            },
            overall_sentiment: response.overall_sentiment || 'NEUTRAL'
        };
    }

    /**
     * Generate fallback analysis if AI fails
     */
    generateFallbackAnalysis(current_price, analysis_type) {
        const price = parseFloat(current_price);
        const timeframe = analysis_type === 'swing' ? '3-7 days' : '1-4 hours';

        return {
            strategies: [
                {
                    id: '1',
                    type: 'HOLD',
                    title: 'Technical Hold Strategy',
                    confidence: 0.65,
                    entry: price.toFixed(2),
                    target: (price * 1.03).toFixed(2),
                    stopLoss: (price * 0.97).toFixed(2),
                    reasoning: [
                        'Current market conditions suggest a wait-and-watch approach',
                        'Technical indicators showing mixed signals',
                        'Volume analysis indicates consolidation phase'
                    ],
                    indicators: [
                        { name: 'RSI', value: '50', signal: 'NEUTRAL' },
                        { name: 'MACD', value: 'Neutral', signal: 'NEUTRAL' }
                    ],
                    riskReward: '1:1',
                    timeframe
                }
            ],
            market_conditions: {
                trend: 'NEUTRAL',
                volatility: 'MEDIUM',
                volume: 'AVERAGE'
            },
            overall_sentiment: 'NEUTRAL'
        };
    }

    /**
     * Get recent analysis history (shared across all users)
     */
    async getUserAnalysisHistory(user_id, limit = 10) {
        return await StockAnalysis.findActive(limit)
            .select('instrument_key stock_name stock_symbol analysis_type current_price created_at analysis_data.market_summary analysis_data.strategies');
    }

    /**
     * Check if user can perform new analysis (rate limiting) - DISABLED FOR TESTING
     */
    async canUserAnalyze(user_id, instrument_key, analysis_type) {
        // Always return true for testing
        return true;
    }

    /**
     * Store fetched candle data in PreFetchedData collection for future use
     * This optimizes performance by caching user-requested data for other users
     */
    async storeFetchedDataInCache(tradeData, candleResult) {
        try {
            const { stockSymbol, instrument_key } = tradeData;
            const candleSets = candleResult.candleSets;
            
            if (!candleSets?.byFrame) {
                console.log(`⚠️ [CACHE STORE] No candle data to store for ${stockSymbol}`);
                return;
            }

            const currentDate = new Date();
            const istTime = new Date(currentDate.toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
            const tradingDate = new Date(istTime);
            tradingDate.setHours(0, 0, 0, 0);

            let storedCount = 0;

            // Process each timeframe
            for (const [timeframe, data] of Object.entries(candleSets.byFrame)) {
                try {
                    // Combine intraday and historical candles
                    const allCandles = [];
                    
                    // Add historical candles first
                    if (data.historical) {
                        data.historical.forEach(candleArray => {
                            if (Array.isArray(candleArray)) {
                                allCandles.push(...candleArray);
                            }
                        });
                    }
                    
                    // Add intraday candles
                    if (data.intraday) {
                        data.intraday.forEach(candleArray => {
                            if (Array.isArray(candleArray)) {
                                allCandles.push(...candleArray);
                            }
                        });
                    }

                    if (allCandles.length === 0) {
                        console.log(`⚠️ [CACHE STORE] No candles found for ${stockSymbol} ${timeframe}`);
                        continue;
                    }

                    // Transform candles to our schema format, preserving original IST timezone
                    const transformedCandles = allCandles.map(candle => ({
                        timestamp: candle[0], // Keep original IST string from Upstox: "2025-10-23T15:15:00+05:30"
                        open: parseFloat(candle[1]),
                        high: parseFloat(candle[2]),
                        low: parseFloat(candle[3]),
                        close: parseFloat(candle[4]),
                        volume: parseInt(candle[5] || 0)
                    }));

                    // Sort by timestamp
                    transformedCandles.sort((a, b) => a.timestamp - b.timestamp);

                    const lastBarTime = transformedCandles.length > 0 ? 
                        transformedCandles[transformedCandles.length - 1].timestamp : null;

                    // Upsert the data (update if exists, insert if new)
                    await PreFetchedData.findOneAndUpdate(
                        {
                            instrument_key: instrument_key,
                            timeframe: timeframe.toLowerCase() // Normalize to lowercase
                        },
                        {
                            $set: {
                                stock_symbol: stockSymbol,
                                trading_date: tradingDate,
                                candle_data: transformedCandles,
                                updated_at: new Date(),
                                bars_count: transformedCandles.length,
                                data_quality: {
                                    missing_bars: 0,
                                    has_gaps: false,
                                    last_bar_time: lastBarTime
                                },
                                upstox_payload: {
                                    source: 'user_request',
                                    fetched_at: new Date(),
                                    total_bars_received: data?.historical?.length || 0,
                                    request_timeframe: timeframe
                                }
                            },
                            $setOnInsert: {
                                fetched_at: new Date()
                            }
                        },
                        {
                            upsert: true,
                            new: true
                        }
                    );

                    storedCount++;
                    console.log(`✅ [CACHE STORE] Stored ${transformedCandles.length} ${timeframe} candles for ${stockSymbol}`);

                } catch (error) {
                    console.error(`❌ [CACHE STORE] Failed to store ${timeframe} data for ${stockSymbol}:`, error.message);
                }
            }

            if (storedCount > 0) {
                console.log(`🎯 [CACHE STORE] Successfully stored ${storedCount} timeframes for ${stockSymbol} in PreFetchedData`);
            }

        } catch (error) {
            console.error(`❌ [CACHE STORE] Failed to store fetched data for ${tradeData.stockSymbol}:`, error.message);
            // Don't throw error - storage failure shouldn't break analysis
        }
    }

    /**
     * Extract candle metadata from market payload for UI display
     * Returns information about which timeframes were used and their last candle timestamps
     */
    extractCandleMetadata(marketPayload) {
        if (!marketPayload) {
            return null;
        }

        const candleInfo = {
            timeframes_used: [],
            primary_timeframe: null,
            last_candle_time: null,
            data_quality: {}
        };

        // Extract data from snapshots (last 30 bars)
        const snapshots = marketPayload.snapshots || {};

        // Map of timeframe keys to display names
        const timeframeMap = {
            'lastBars15m': { display: '15-min', key: '15m' },
            'lastBars1h': { display: '1-hour', key: '1h' },
            'lastBars1D': { display: 'daily', key: '1d' },
            'lastBars1W': { display: 'weekly', key: '1w' }
        };

        // Extract last candle timestamps from each timeframe
        for (const [snapshotKey, timeframeData] of Object.entries(timeframeMap)) {
            const candles = snapshots[snapshotKey];
            if (candles && candles.length > 0) {
                // Candles are in format: [time, open, high, low, close, volume]
                const lastCandle = candles[candles.length - 1];
                const lastCandleTime = lastCandle[0]; // First element is timestamp

                candleInfo.timeframes_used.push({
                    timeframe: timeframeData.display,
                    key: timeframeData.key,
                    bars_count: candles.length,
                    last_candle_time: lastCandleTime
                });

                // Set primary timeframe (prefer daily, then 1h, then 15m)
                if (timeframeData.key === '1d' || !candleInfo.primary_timeframe) {
                    candleInfo.primary_timeframe = timeframeData.display;
                    candleInfo.last_candle_time = lastCandleTime;
                }
            }
        }

        // Add data health info if available
        if (marketPayload.meta && marketPayload.meta.dataHealth) {
            candleInfo.data_quality = {
                bars_15m: marketPayload.meta.dataHealth.bars15m || 0,
                bars_1h: marketPayload.meta.dataHealth.bars1h || 0,
                bars_1d: marketPayload.meta.dataHealth.bars1D || 0
            };
        }

        return candleInfo;
    }

    /**
     * Enforce per-user daily slot limit before analyzing a new stock.
     */
    async checkDailyStockLimit(userId, stockSymbol) {
        if (!userId || !stockSymbol) {
            return { allowed: true };
        }

        const normalizedSymbol = normalizeStockSymbol(stockSymbol);
        if (!normalizedSymbol) {
            return { allowed: true };
        }

        const subscription = await Subscription.findActiveForUser(userId);
        if (!subscription) {
            return { allowed: true };
        }

        const stockLimit = Number.isFinite(subscription.stockLimit)
            ? subscription.stockLimit
            : Number(subscription.stockLimit) || 0;

        if (stockLimit <= 0) {
            return { allowed: true };
        }

        const userObjectId = mongoose.Types.ObjectId.isValid(userId)
            ? mongoose.Types.ObjectId(userId)
            : userId;

        // ⚡ NEW: Use quota window (5 PM IST Day T → 4 PM IST Day T+1) instead of IST day range
        const MarketHoursUtil = (await import('../utils/marketHours.js')).default;
        const { startUtc, endUtc, quotaDate } = await MarketHoursUtil.getQuotaWindowUTC();

        console.log(`📊 [DAILY LIMIT] Checking quota window: ${quotaDate} (${startUtc.toISOString()} → ${endUtc.toISOString()})`);

        const { default: UserAnalyticsUsage } = await import('../models/userAnalyticsUsage.js');

        const usage = await UserAnalyticsUsage.aggregate([
            {
                $match: {
                    user_id: userObjectId,
                    createdAt: { $gte: startUtc, $lt: endUtc },
                    stock_symbol: { $exists: true, $ne: null }
                }
            },
            {
                $group: {
                    _id: '$stock_symbol'
                }
            }
        ]);

        const uniqueSymbols = new Set();
        for (const entry of usage) {
            const normalized = normalizeStockSymbol(entry?._id);
            if (normalized) {
                uniqueSymbols.add(normalized);
            }
        }

        const usedCount = uniqueSymbols.size;
        const alreadyUsed = uniqueSymbols.has(normalizedSymbol);

        if (alreadyUsed) {
            return {
                allowed: true,
                uniqueCount: usedCount,
                stockLimit,
                symbol: normalizedSymbol,
                alreadyUsed: true
            };
        }

        if (usedCount >= stockLimit) {
            console.log(`❌ [DAILY LIMIT] User ${userId} has reached limit: ${usedCount}/${stockLimit} (quota_date: ${quotaDate})`);
            return {
                allowed: false,
                uniqueCount: usedCount,
                stockLimit,
                symbol: normalizedSymbol,
                quotaDate,
                quotaResetsAt: endUtc.toISOString()
            };
        }

        return {
            allowed: true,
            uniqueCount: usedCount,
            stockLimit,
            symbol: normalizedSymbol
        };
    }

    /**
     * Send in-app notification + Firebase push when analysis is complete
     */
    async sendAnalysisCompleteNotification(userId, analysisRecord) {
        try {
            // Get user details
            const user = await User.findById(userId);
            if (!user) {
                console.log(`⚠️ User ${userId} not found for analysis complete notification`);
                return;
            }

            // Count strategies found in the analysis
            const strategiesCount = analysisRecord.analysis_data?.strategies?.length || 0;
            const userName = user.name || user.email?.split('@')[0] || 'User';
            const stockName = analysisRecord.stock_name || analysisRecord.stock_symbol;

            // Create in-app notification
            await Notification.createNotification({
                userId: userId,
                title: 'Analysis Complete',
                message: `${stockName} analysis is ready! Found ${strategiesCount} ${strategiesCount === 1 ? 'strategy' : 'strategies'}.`,
                type: 'ai_review',
                relatedStock: {
                    trading_symbol: analysisRecord.stock_symbol,
                    instrument_key: analysisRecord.instrument_key
                },
                metadata: {
                    analysisId: analysisRecord._id.toString(),
                    analysisType: analysisRecord.analysis_type,
                    strategiesCount: strategiesCount
                }
            });

            console.log(`✅ [NOTIFICATION] In-app notification created for ${stockName}`);

            // Send Firebase push notification if user has FCM tokens
            if (user.fcmTokens && user.fcmTokens.length > 0) {
                await firebaseService.sendToUser(
                    userId,
                    'Analysis Complete',
                    `${stockName} analysis ready with ${strategiesCount} ${strategiesCount === 1 ? 'strategy' : 'strategies'}!`,
                    {
                        type: 'AI_ANALYSIS_COMPLETE',
                        stockSymbol: analysisRecord.stock_symbol,
                        analysisId: analysisRecord._id.toString(),
                        route: '/analysis'
                    }
                );

                console.log(`📱 [NOTIFICATION] Firebase push sent for ${stockName} to ${user.fcmTokens.length} device(s)`);
            } else {
                console.log(`⚠️ [NOTIFICATION] No FCM tokens for user ${userId}, skipping Firebase push`);
            }

            // WhatsApp notification removed - using in-app + Firebase instead
            // Old WhatsApp code commented out for reference:
            // const whatsappResult = await messagingService.sendAnalysisComplete(
            //     user.mobile_number,
            //     analysisData
            // );

        } catch (error) {
            console.error(`❌ Error sending analysis complete notification:`, error);
            // Don't throw error - notification failure shouldn't break analysis
        }
    }

    /**
     * Update bulk session progress when individual stock analysis completes
     */
    async updateBulkSessionProgress(instrument_key, analysis_type, status) {
        try {
            // Find active bulk session that contains this stock
            const activeSession = await AnalysisSession.findOne({
                status: { $in: ['running', 'in_progress'] },
                analysis_type: analysis_type,
                'metadata.watchlist_stocks.instrument_key': instrument_key
            });

            if (!activeSession) {
                // No active bulk session found - this is probably an individual analysis
                console.log(`📊 [SESSION UPDATE] No active bulk session found for ${instrument_key} - skipping session update`);
                return;
            }

            // Update the specific stock in the watchlist
            const stockIndex = activeSession.metadata.watchlist_stocks.findIndex(
                stock => stock.instrument_key === instrument_key
            );

            if (stockIndex === -1) {
                console.log(`⚠️ [SESSION UPDATE] Stock ${instrument_key} not found in session watchlist`);
                return;
            }

            const stock = activeSession.metadata.watchlist_stocks[stockIndex];
            const now = new Date();

            // Update stock status based on analysis result
            if (status === 'completed') {
                stock.processed = true;
                stock.processing_completed_at = now;
                stock.error_reason = null;
                
                activeSession.successful_stocks = (activeSession.successful_stocks || 0) + 1;
                console.log(`✅ [SESSION UPDATE] Marked ${stock.trading_symbol} as completed in bulk session`);
            } else if (status === 'failed') {
                stock.processed = true;
                stock.processing_completed_at = now;
                stock.error_reason = 'Analysis failed or insufficient data';
                
                activeSession.failed_stocks = (activeSession.failed_stocks || 0) + 1;
                console.log(`❌ [SESSION UPDATE] Marked ${stock.trading_symbol} as failed in bulk session`);
            }

            // Update session counters
            activeSession.processed_stocks = activeSession.successful_stocks + activeSession.failed_stocks;
            activeSession.last_updated = now;

            // Check if all stocks are completed
            const totalProcessed = activeSession.processed_stocks;
            const totalStocks = activeSession.total_stocks;

            if (totalProcessed >= totalStocks) {
                // All stocks completed - mark session as completed
                activeSession.status = 'completed';
                activeSession.completed_at = now;
                activeSession.current_stock_key = null;
                activeSession.current_stock_index = totalStocks;

                console.log(`🎉 [SESSION UPDATE] Bulk session completed! ${totalProcessed}/${totalStocks} stocks processed`);

                // Send completion notification (in-app + Firebase push)
                await this.sendBulkSessionCompleteNotification(activeSession);
            }

            await activeSession.save();
            console.log(`📊 [SESSION UPDATE] Updated bulk session progress: ${totalProcessed}/${totalStocks} complete`);

        } catch (error) {
            console.error(`❌ [SESSION UPDATE] Failed to update bulk session progress:`, error.message);
            // Don't throw error - session update failure shouldn't break analysis
        }
    }

    /**
     * Send in-app notification + Firebase push when bulk analysis session completes
     */
    async sendBulkSessionCompleteNotification(session) {
        try {
            const userId = session.user_id;
            const user = await User.findById(userId);

            if (!user) {
                console.log(`⚠️ User ${userId} not found for bulk session completion notification`);
                return;
            }

            const userName = user.name || user.email?.split('@')[0] || 'User';
            const totalStocks = session.total_stocks || 0;
            const successfulStocks = session.successful_stocks || 0;
            const failedStocks = session.failed_stocks || 0;

            // Create in-app notification
            await Notification.createNotification({
                userId: userId,
                title: 'Bulk Analysis Complete',
                message: `Hello ${userName}! Your bulk analysis is complete. Successfully analyzed ${successfulStocks} out of ${totalStocks} stocks.`,
                type: 'alert',
                metadata: {
                    sessionId: session._id.toString(),
                    totalStocks: totalStocks,
                    successfulStocks: successfulStocks,
                    failedStocks: failedStocks,
                    analysisType: session.analysis_type,
                    completedAt: session.completed_at
                }
            });

            console.log(`✅ [NOTIFICATION] In-app notification created for bulk session completion`);

            // Send Firebase push notification if user has FCM tokens
            if (user.fcmTokens && user.fcmTokens.length > 0) {
                await firebaseService.sendToUser(
                    userId,
                    'Bulk Analysis Complete',
                    `Your bulk analysis is complete! ${successfulStocks}/${totalStocks} stocks analyzed successfully.`,
                    {
                        type: 'BULK_ANALYSIS_COMPLETE',
                        sessionId: session._id.toString(),
                        route: '/bulk-analysis'
                    }
                );

                console.log(`📱 [NOTIFICATION] Firebase push sent for bulk session completion to ${user.fcmTokens.length} device(s)`);
            } else {
                console.log(`⚠️ [NOTIFICATION] No FCM tokens for user ${userId}, skipping Firebase push`);
            }

            // WhatsApp notification removed - using in-app + Firebase instead

        } catch (error) {
            console.error(`❌ Error sending bulk session completion notification:`, error);
            // Don't throw error - notification failure shouldn't break analysis
        }
    }
}

export default new AIAnalyzeService();

function normalizeStockSymbol(symbol) {
    if (!symbol) {
        return '';
    }
    return symbol.toString().trim().toUpperCase();
}
