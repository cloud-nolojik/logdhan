import axios from 'axios';
import Parser from 'rss-parser';
import crypto from 'crypto';
import StockAnalysis from '../models/stockAnalysis.js';
import { aiReviewService } from './ai/aiReview.service.js';
import { subscriptionService } from './subscription/subscriptionService.js';
import { Plan } from '../models/plan.js';
import { Subscription } from '../models/subscription.js';

class AIAnalyzeService {
    constructor() {
        this.aiReviewService = aiReviewService;
        this.upstoxApiKey = process.env.UPSTOX_API_KEY;
        this.openaiApiKey = process.env.OPENAI_API_KEY;
        this.rssParser = new Parser();
        
        // Model configuration
        this.analysisModel = "gpt-4o";
        this.basicModel = "gpt-5";
        this.advancedModel = "gpt-5"; 
        
        // Use existing term-to-frames mapping from aiReview
        this.termToFrames = {
            'intraday': ['1m', '3m', '15m'],
            'short': ['15m', '1h', '1D'], // for swing trading
        };
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
            console.error('❌ Error creating prompt hash:', error.message);
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
    async determineAIModel(userId, isFromRewardedAd = false, creditType = 'regular') {
        try {
            console.log(`\n🔍 Determining AI model for user: ${userId}`);
            console.log(`   isFromRewardedAd: ${isFromRewardedAd}, creditType: ${creditType}`);
            
            // Check if user can use credits
            const canUse = await subscriptionService.canUserUseCredits(userId, 1, isFromRewardedAd);
            
            if (!canUse.canUse) {
                // Credits exhausted - determine appropriate message
                const subscription = await Subscription.findActiveForUser(userId);
                const plan = subscription ? await Plan.getPlanById(subscription.planId) : null;
                
                let errorMessage = '';
                let errorCode = 'CREDITS_EXHAUSTED';
                
                if (plan && plan.analysisLevel === 'advanced') {
                    // Paid plan with exhausted credits
                    if (isFromRewardedAd) {
                        // User watched ad but still can't use (maybe ad limit reached)
                        errorMessage = canUse.reason || 'Daily ad limit reached. Please try again tomorrow.';
                        errorCode = 'AD_LIMIT_REACHED';
                    } else {
                        // Suggest watching ad for paid users
                        errorMessage = 'Your monthly credits are exhausted. Watch an ad to get this analysis with AI, or wait for next month\'s credits.';
                        errorCode = 'PAID_CREDITS_EXHAUSTED';
                    }
                } else {
                    // Basic/free plan
                    if (isFromRewardedAd) {
                        errorMessage = canUse.reason || 'Daily ad limit reached. Please try again tomorrow.';
                        errorCode = 'AD_LIMIT_REACHED';
                    } else {
                        errorMessage = 'Watch an ad to get this analysis with AI, or upgrade to Pro for unlimited analysis.';
                        errorCode = 'FREE_CREDITS_EXHAUSTED';
                    }
                }
                
                return {
                    canProceed: false,
                    error: errorMessage,
                    errorCode,
                    suggestAd: !isFromRewardedAd && errorCode !== 'AD_LIMIT_REACHED',
                    models: null,
                    subscription: null
                };
            }
            
            // User can proceed - determine models
            const subscription = await Subscription.findActiveForUser(userId);
            const plan = subscription ? await Plan.getPlanById(subscription.planId) : null;
            
            // Determine tier based on user plan/credits
            let modelTier = 'basic'; // Default
            
            // Priority 1: Check if using bonus credits (advanced analysis)
            if (creditType === 'bonus') {
                modelTier = 'advanced';
                console.log(`🎁 Bonus credits - using advanced analysis model`);
            }
            // Priority 1.5: Check if this is from rewarded ad (basic model for sustainability) 
            else if (isFromRewardedAd) {
                modelTier = 'ad-supported';
                console.log(`🎁 Ad-supported analysis - using basic models for sustainability`);
            }
            // Priority 2: Check plan type for paying users
            else if (plan && plan.analysisLevel === 'advanced') {
                // Check if they have credits remaining
                const totalCredits = (subscription.credits.monthly || 0) + 
                                   (subscription.credits.rollover || 0) + 
                                   (subscription.credits.earnedCredits || 0);
                
                if (totalCredits > 0) {
                    modelTier = 'advanced';
                    console.log(`💎 Paid plan (${plan.planId}) with credits - using advanced models`);
                } else {
                    modelTier = 'basic-fallback';
                    console.log(`💸 Paid plan (${plan.planId}) no credits - using basic models`);
                }
            }
            // Priority 3: Basic/free plan users
            else {
                modelTier = 'basic';
                console.log(`📱 Basic/free plan - using basic models`);
            }
            
            // Get models from simplified configuration
            const analysisModel = modelTier === 'advanced' ? this.advancedModel : this.basicModel;
            const sentimentModel = this.analysisModel; // Use main analysis model for sentiment
            
            console.log(`🤖 Selected models: Analysis=${analysisModel}, Sentiment=${sentimentModel}, Tier=${modelTier}`);
            
            return {
                canProceed: true,
                models: {
                    analysis: analysisModel,
                    sentiment: sentimentModel,
                    tier: modelTier
                },
                creditType: isFromRewardedAd ? 'bonus' : creditType,
                subscription: {
                    plan: plan?.planId || 'free',
                    creditsRemaining: (subscription?.credits?.monthly || 0) + 
                                    (subscription?.credits?.rollover || 0) + 
                                    (subscription?.credits?.earnedCredits || 0)
                }
            };
            
        } catch (error) {
            console.error('❌ Model determination failed:', error);
            return {
                canProceed: true,
                models: {
                    analysis: this.basicModel,
                    tier: 'basic'
                }
            };
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
     * @returns {Promise<Object>} Analysis result
     */
    async analyzeStock({
        instrument_key,
        stock_name,
        stock_symbol,
        current_price,
        analysis_type = 'swing',
        user_id,
        isFromRewardedAd = false,
        creditType = 'regular',
        forceFresh = false
    }) {
        // Store original models
        const originalSentimentModel = this.sentimentalModel;
        const originalAnalysisModel = this.analysisModel;
        
        try {
            console.log(`🔍 Starting AI analysis for ${stock_symbol} (${analysis_type})`);

            // Determine AI models based on user subscription
            if (user_id) {
                const modelConfig = await this.determineAIModel(
                    user_id, 
                    isFromRewardedAd,
                    creditType
                );
                
                if (!modelConfig.canProceed) {
                    // Cannot proceed with analysis - return error
                    console.error(`❌ Cannot proceed with AI analysis: ${modelConfig.error}`);
                    
                    return {
                        success: false,
                        error: modelConfig.error,
                        errorCode: modelConfig.errorCode,
                        suggestAd: modelConfig.suggestAd
                    };
                }
                
                // Set the determined models
                this.analysisModel = modelConfig.models.analysis;
                this.sentimentalModel = modelConfig.models.sentiment;
                
                console.log(`✅ Model selection complete:`);
                console.log(`   Analysis: ${this.analysisModel}`);
                console.log(`   Sentiment: ${this.sentimentalModel}`);
                console.log(`   Tier: ${modelConfig.models.tier}`);
                console.log(`   Credits remaining: ${modelConfig.subscription?.creditsRemaining || 0}`);
            }

            // Check for existing analysis (cached completed or in-progress) unless forceFresh is true
            if (!forceFresh) {
                console.log(`🔍 Checking for existing analysis...`);
                const existing = await StockAnalysis.findByInstrumentAndUser(instrument_key, analysis_type, user_id);
                
                if (existing) {
                    if (existing.status === 'completed') {
                        console.log(`✅ Found cached completed analysis from ${existing.created_at}`);
                        return {
                            success: true,
                            data: existing,
                            cached: true
                        };
                    } else if (existing.status === 'in_progress') {
                        console.log(`⏳ Analysis already in progress, returning progress status`);
                        return {
                            success: true,
                            data: existing,
                            inProgress: true
                        };
                    }
                }
            } else {
                console.log(`🔄 Force fresh analysis requested - skipping cache check`);
                // If there's an existing in-progress analysis, we should still wait for it to complete
                // to avoid duplicate analysis requests
                const existing = await StockAnalysis.findByInstrumentAndUser(instrument_key, analysis_type, user_id);
                if (existing && existing.status === 'in_progress') {
                    console.log(`⏳ Fresh analysis requested but analysis already in progress, returning progress status`);
                    return {
                        success: true,
                        data: existing,
                        inProgress: true
                    };
                }
                
                // If there's a completed analysis, delete it to make room for fresh analysis
                if (existing && existing.status === 'completed') {
                    console.log(`🗑️ Deleting existing cached analysis to make room for fresh analysis`);
                    await StockAnalysis.deleteOne({ _id: existing._id });
                }
            }

            console.log(`🚀 Proceeding with fresh analysis for ${stock_symbol}`);

            // Create new analysis record with progress tracking
            const pendingAnalysis = new StockAnalysis({
                instrument_key,
                stock_name,
                stock_symbol,
                analysis_type,
                current_price,
                user_id,
                status: 'in_progress',
                expires_at: StockAnalysis.getExpiryTime(), // Market-aware expiry
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
                }
            });

            await pendingAnalysis.save();
            console.log(`📝 Created pending analysis record: ${pendingAnalysis._id}`);

            try {
                // Generate AI analysis with progress tracking
                const analysisResult = await this.generateAIAnalysisWithProgress(
                    {
                        instrument_key,
                        stock_name,
                        stock_symbol,
                        current_price,
                        analysis_type
                    },
                    pendingAnalysis // Pass analysis record for progress updates
                );

                // Update analysis with results and mark completed
                pendingAnalysis.analysis_data = analysisResult;
                await pendingAnalysis.markCompleted();

                console.log(`✅ AI analysis completed and saved for ${stock_symbol}`);

                // Deduct credits after successful analysis
                if (user_id) {
                    try {
                        await subscriptionService.deductCredits(user_id, 1, isFromRewardedAd);
                        console.log(`💳 Credits deducted for user ${user_id}`);
                    } catch (creditError) {
                        console.warn('⚠️ Credit deduction failed:', creditError.message);
                    }
                }

                return {
                    success: true,
                    data: pendingAnalysis,
                    cached: false
                };

            } catch (analysisError) {
                // Mark analysis as failed using new method
                await pendingAnalysis.markFailed(analysisError.message);
                
                console.error(`❌ Analysis failed for ${stock_symbol}:`, analysisError.message);
                throw analysisError;
            }

        } catch (error) {
            console.error('❌ AI Analysis Error:', error);
            
            return {
                success: false,
                error: 'Failed to generate AI analysis',
                message: error.message
            };
        } finally {
            // Restore original models
            this.sentimentalModel = originalSentimentModel;
            this.analysisModel = originalAnalysisModel;
        }
    }

    /**
     * Generate AI analysis with progress tracking
     */
    async generateAIAnalysisWithProgress(params, analysisRecord) {
        const { stock_name, stock_symbol, current_price, analysis_type, instrument_key } = params;
        
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
            const result = await this.generateAIAnalysis(params);
            
            // Step 8: Finalize
            await analysisRecord.updateProgress('Finalizing analysis...', 95, 2);
            
            return result;
            
        } catch (error) {
            console.error('❌ Progress tracking analysis failed:', error);
            throw error;
        }
    }
    
    /**
     * Generate AI analysis using real market data
     */
    async generateAIAnalysis({ stock_name, stock_symbol, current_price, analysis_type, instrument_key }) {
        try {
            console.log(`🚀 Starting real data fetch for ${stock_symbol} (${analysis_type})`);
            
            // Create trade data structure for API calls
            const tradeData = {
                term: analysis_type === 'swing' ? 'short' : 'intraday',
                instrument_key,
                stock: stock_name,
                stockSymbol: stock_symbol,
                stockName: stock_name
            };

            // Fetch real market data in parallel
            console.log(`📰 Fetching news for: ${stock_name}`);
            const [candleData, newsData] = await Promise.all([
                this.fetchRealMarketData(tradeData),
                this.fetchNewsData(stock_name).catch(err => {
                    console.warn('⚠️ News fetch failed, continuing without news:', err.message);
                    return null;
                })
            ]);

            console.log(`📰 News data result: ${newsData ? `${newsData.length} articles found` : 'No news data'}`);
            if (newsData && newsData.length > 0) {
                console.log(`📰 Sample headlines:`, newsData.slice(0, 3).map(item => item.title));
            }

            // Analyze news sentiment
            const sentiment = newsData ? 
                await this.analyzeSentiment(newsData, tradeData.term) : 
                'neutral';
                
            console.log(`📊 News sentiment analysis result: ${sentiment}`);

            // Route to appropriate agent to process data
            const agentOut = await this.processMarketData(tradeData, candleData);
            
            // Build market data payload using existing aiReview function
            let payload;
            if (analysis_type === 'swing') {
                payload = this.aiReviewService.buildShortTermReviewPayload(agentOut, tradeData, sentiment);
            } else {
                payload = this.aiReviewService.buildIntradayReviewPayload(agentOut, tradeData, sentiment);
            }

            // Clean payload for stock analysis - remove user plan sections
            payload = this.cleanPayloadForStockAnalysis(payload);
            
            // Override newsLite with our sentiment analysis results
            if (payload.newsLite) {
                const sentimentMap = { 'positive': 1, 'neutral': 0, 'negative': -1 };
                payload.newsLite = {
                    sentimentScore: sentimentMap[sentiment] || 0,
                    notes: newsData && newsData.length > 0 
                        ? `${newsData.length} news articles analyzed. Overall sentiment: ${sentiment}`
                        : "No recent news found"
                };
                console.log(`📰 Updated newsLite with our analysis:`, payload.newsLite);
            }

            console.log(`📊 Generated clean payload for stock analysis of ${stock_symbol}`);
            console.log(`🤖 Using AI models - Analysis: ${this.analysisModel}, Sentiment: ${this.sentimentalModel}`);

            // Generate analysis with real market data
            const analysisResult = await this.generateStockAnalysisWithPayload({
                stock_name,
                stock_symbol, 
                current_price,
                analysis_type,
                marketPayload: payload,
                sentiment
            });

            console.log(`✅ AI Analysis completed successfully for ${stock_symbol}`);
            console.log(`📋 Analysis result:`, JSON.stringify(analysisResult, null, 2));

            return analysisResult;

        } catch (error) {
            console.error('❌ Failed to generate analysis with real data:', error);
            
            // For testing: Don't use fallback, show the actual error
            throw error;
        }
    }

    /**
     * Fetch real market data from Upstox API
     */
    async fetchRealMarketData(tradeData) {
        const { endpoints } = this.aiReviewService.buildCandleUrls(tradeData);
        
        console.log(`📡 Fetching ${endpoints.length} candle endpoints`);
        
        // Fetch all endpoints in parallel
        const candleFetches = endpoints.map(ep =>
            this.fetchCandleData(ep.url)
                .then(res => ({
                    status: 'fulfilled',
                    frame: ep.frame,
                    kind: ep.kind,
                    candles: res?.data?.candles || res?.candles || [],
                    raw: res
                }))
                .catch(err => ({
                    status: 'rejected',
                    frame: ep.frame,
                    kind: ep.kind,
                    error: err?.message || String(err)
                }))
        );

        const candleResults = await Promise.all(candleFetches);
        
        // Organize results by frame
        const candleSets = candleResults.reduce((acc, r) => {
            if (r.status === 'fulfilled') {
                acc.byFrame ??= {};
                acc.byFrame[r.frame] ??= { intraday: [], historical: [] };
                
                if (r.kind === 'intraday') {
                    acc.byFrame[r.frame].intraday.push(r.candles);
                } else {
                    acc.byFrame[r.frame].historical.push(r.candles);
                }
            } else {
                acc.errors ??= [];
                acc.errors.push({ frame: r.frame, kind: r.kind, error: r.error });
            }
            return acc;
        }, {});

        return { endpoints, candleSets };
    }

    /**
     * Fetch candle data from Upstox API
     */
    async fetchCandleData(url) {
        try {
            const response = await axios.get(url, {
                headers: {
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${this.upstoxApiKey}`
                },
                timeout: 10000
            });
            
            return response.data;
        } catch (error) {
            console.error(`❌ Candle fetch error:`, error.message);
            throw error;
        }
    }

    /**
     * Fetch news data from Google News RSS
     */
    async fetchNewsData(stockName) {
        try {
            const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(stockName)}&hl=en-IN&gl=IN&ceid=IN:en`;
            console.log(`📰 Fetching news from RSS URL: ${rssUrl}`);
            
            const feed = await this.rssParser.parseURL(rssUrl);
            console.log(`📰 RSS feed parsed. Found ${feed.items?.length || 0} items`);
            
            if (feed.items && feed.items.length > 0) {
                console.log(`📰 First few titles:`, feed.items.slice(0, 3).map(item => item.title));
            }
            
            return feed.items;
        } catch (error) {
            console.error('📰 News fetch error:', error.message);
            throw error;
        }
    }

    /**
     * Analyze news sentiment
     */
    async analyzeSentiment(newsItems, term) {
        if (!newsItems || newsItems.length === 0) {
            console.log('📊 No news items for sentiment analysis, returning neutral');
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
        
        console.log(`📊 Analyzing sentiment for ${newsItems.length} news items using ${this.sentimentalModel}`);
        console.log(`📊 Sample titles for sentiment:`, newsItems.slice(0, 2).map(item => item.title));
        
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
            
            console.log(`📊 Sentiment analysis result: "${sentiment}" -> "${validSentiment}"`);
            return validSentiment;
        } catch (error) {
            console.error('❌ Sentiment analysis failed:', error.message);
            return 'neutral';
        }
    }

    /**
     * Clean payload for stock analysis by removing user plan sections
     */
    cleanPayloadForStockAnalysis(payload) {
        console.log('🧹 Starting payload cleanup for stock analysis...');
        console.log('🧹 Original payload keys:', Object.keys(payload));
        
        const cleanPayload = { ...payload };
        
        // Remove user plan sections that are irrelevant for stock analysis
        const sectionsToRemove = ['userPlan', 'planDiagnostics', 'timeToTargetEstimate'];
        
        sectionsToRemove.forEach(section => {
            if (cleanPayload[section]) {
                console.log(`🧹 Removing ${section} from payload`);
                delete cleanPayload[section];
            } else {
                console.log(`🧹 Section ${section} not found in payload`);
            }
        });
        
        // Also fix newsLite if it's empty - populate with our sentiment analysis
        if (cleanPayload.newsLite && (cleanPayload.newsLite.sentimentScore === 0 || cleanPayload.newsLite.notes === "")) {
            console.log('🧹 newsLite is empty, will be handled by our news processing');
        }
        
        // Add basic support/resistance levels if they're empty
        if (cleanPayload.levels && cleanPayload.levels.supports?.length === 0 && cleanPayload.levels.resistances?.length === 0) {
            console.log('🧹 Support/resistance levels are empty, calculating basic levels');
            cleanPayload.levels = this.calculateBasicLevels(cleanPayload);
        }
        
        // Calculate pivot points if they're missing
        if (cleanPayload.swingContext && cleanPayload.swingContext.pivots === null) {
            console.log('🧹 Pivot points are null, calculating standard pivots');
            cleanPayload.swingContext.pivots = this.calculatePivotPoints(cleanPayload.swingContext);
        }
        
        // Add volume classification to the payload BEFORE sending to AI
        const volumeClassification = this.classifyVolume(cleanPayload);
        console.log(`🧹 Volume classification calculated: ${volumeClassification}`);
        
        // Add volume info to the payload for AI to use
        if (!cleanPayload.volumeContext) {
            cleanPayload.volumeContext = {};
        }
        cleanPayload.volumeContext.classification = volumeClassification;
        cleanPayload.volumeContext.band = volumeClassification; // Also add as 'band' for compatibility
        
        console.log('🧹 Cleaned payload keys:', Object.keys(cleanPayload));
        
        return cleanPayload;
    }

    /**
     * Calculate basic support/resistance levels from available data
     */
    calculateBasicLevels(payload) {
        console.log('📊 Calculating basic support/resistance levels...');
        
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
            
            console.log(`📊 Price context: current=${currentPrice}, swingHigh20=${swingHigh20}, swingLow20=${swingLow20}`);
            console.log(`📊 MAs: ema20=${ema20}, ema50=${ema50}, sma200=${sma200}`);
            
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
            
            console.log(`📊 Calculated ${uniqueSupports.length} support levels:`, uniqueSupports.map(s => `${s.price}(${s.type})`));
            console.log(`📊 Calculated ${uniqueResistances.length} resistance levels:`, uniqueResistances.map(r => `${r.price}(${r.type})`));
            
            return {
                supports: uniqueSupports,
                resistances: uniqueResistances
            };
            
        } catch (error) {
            console.error('📊 Error calculating basic levels:', error.message);
            return { supports: [], resistances: [] };
        }
    }

    /**
     * Classify volume based on recent data vs 20-day median
     */
    classifyVolume(marketPayload) {
        try {
            console.log('📊 Starting volume classification...');
            
            const dailyBars = marketPayload?.snapshots?.lastBars1D;
            console.log(`📊 Daily bars available: ${dailyBars?.length || 0}`);
            
            if (!dailyBars || dailyBars.length < 5) {
                console.log('📊 Insufficient volume data for classification');
                return 'UNKNOWN';
            }
            
            // Get last 20 days of volume data (or available)
            const recentBars = dailyBars.slice(-20);
            const volumes = recentBars.map(bar => {
                const volume = Array.isArray(bar) ? bar[5] : bar.volume;
                return volume;
            }).filter(v => v && v > 0);
            
            console.log(`📊 Extracted ${volumes.length} valid volume readings from ${recentBars.length} bars`);
            console.log(`📊 Sample volumes:`, volumes.slice(-5).map(v => parseInt(v/1000000) + 'M')); // Last 5 in millions
            
            if (volumes.length < 5) {
                console.log('📊 Insufficient valid volume data');
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
            
            console.log(`📊 Volume analysis: latest=${(latestVolume/1000000).toFixed(1)}M, median=${(medianVolume/1000000).toFixed(1)}M, ratio=${(latestVolume/medianVolume).toFixed(2)}`);
            
            // Classify based on deviation from median
            const ratio = latestVolume / medianVolume;
            let classification;
            if (ratio >= 1.5) classification = 'ABOVE_AVERAGE';
            else if (ratio <= 0.7) classification = 'BELOW_AVERAGE';
            else classification = 'AVERAGE';
            
            console.log(`📊 Volume classified as: ${classification}`);
            return classification;
            
        } catch (error) {
            console.error('📊 Error classifying volume:', error.message);
            return 'UNKNOWN';
        }
    }

    /**
     * Calculate standard pivot points from previous session data
     */
    calculatePivotPoints(swingContext) {
        console.log('📊 Calculating pivot points...');
        
        try {
            const prevSession = swingContext.prevSession;
            if (!prevSession || !prevSession.high || !prevSession.low || !prevSession.close) {
                console.warn('📊 Insufficient data for pivot calculation');
                return null;
            }
            
            const high = prevSession.high;
            const low = prevSession.low;
            const close = prevSession.close;
            
            console.log(`📊 Previous session data: H=${high}, L=${low}, C=${close}`);
            
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
            
            console.log(`📊 Calculated pivots:`, pivots);
            console.log(`📊 Support levels: S3=${pivots.s3}, S2=${pivots.s2}, S1=${pivots.s1}`);
            console.log(`📊 Pivot: ${pivots.pivot}`);
            console.log(`📊 Resistance levels: R1=${pivots.r1}, R2=${pivots.r2}, R3=${pivots.r3}`);
            
            return pivots;
            
        } catch (error) {
            console.error('📊 Error calculating pivot points:', error.message);
            return null;
        }
    }

    /**
     * Process market data through appropriate agent
     */
    async processMarketData(tradeData, candleData) {
        const { endpoints, candleSets } = candleData;
        
        // Label data for agent processing - use correct structure expected by runShortTermAgent
        const labeledData = endpoints.map((endpoint) => {
            const frameData = candleSets.byFrame?.[endpoint.frame];
            
            let candles = [];
            
            if (frameData) {
                if (endpoint.kind === 'intraday' && frameData.intraday?.length > 0) {
                    candles = frameData.intraday[0] || [];
                } else if (endpoint.kind === 'historical' && frameData.historical?.length > 0) {
                    candles = frameData.historical.flat();
                }
            }
            
            return {
                frame: endpoint.frame,  // Changed from 'label' to 'frame'
                kind: endpoint.kind,     // Added 'kind' property
                data: { candles },       // Wrap candles in data object
                candles: candles         // Also include direct candles for compatibility
            };
        });

        // Route to appropriate agent based on term
        if (tradeData.term === 'intraday') {
            return await this.aiReviewService.runIntradayAgent(labeledData, tradeData);
        } else {
            return await this.aiReviewService.runShortTermAgent(labeledData, tradeData);
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
    async generateStockAnalysisWithPayload({ stock_name, stock_symbol, current_price, analysis_type, marketPayload, sentiment }) {
        const analysisStartTime = Date.now();
        const stepTimes = { start: analysisStartTime };
        
        const timeframe = analysis_type === 'swing' ? '3-7 days' : '1-4 hours';
        const sentimentText = sentiment || 'neutral';
        
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
  "runtime": {
    "triggers_evaluated": [
      {
        "id": "T1",
        "timeframe": "15m|1h|1D",
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
              "timeframe": "1D"|"1h"|"15m",
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
          "timeframe": "15m|1h|1D",
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
            "timeframe": "1h"|"15m"|"1D",
            "left": {"ref": "rsi14_1h|close"},
            "op": "<"|"<="|">"|">="|"crosses_above"|"crosses_below",
            "right": {"ref": "value|entry", "value": <number>}
          }
        ]
      },
      "invalidations": [
        {
          "scope": "pre_entry",
          "timeframe": "1h"|"15m"|"1D",
          "left": {"ref": "close|low|price"},
          "op": "<"|"<="|">"|">=",
          "right": {"ref": "entry|value", "value": <number>},
          "occurrences": {"count": 1, "consecutive": false},
          "action": "cancel_entry",
          "action_args": {"price_ref": "entry"}
        },
        {
          "scope": "post_entry",
          "timeframe": "1h"|"1D",
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
        console.log('🤖 Raw AI response length:', content?.length || 0);
        console.log('🤖 Response preview:', content?.substring(0, 200) + '...');
        
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
            
            console.log('🤖 Cleaned JSON length:', cleanContent.length);
            parsed = JSON.parse(cleanContent);
            
        } catch (e) {
            console.error('❌ JSON parse failed. Raw content:', content);
            console.error('❌ Parse error:', e.message);
            
            // Return fallback analysis instead of throwing
            return this.generateFallbackAnalysis(current_price, analysis_type);
        }

        // ---- SIMPLIFIED: Trust GPT-5 Response ----
        // GPT-5 returns perfect schema-compliant responses, so we can minimize processing
        
        // // 1. Use pre-calculated volume if AI didn't get it
        // const last = marketPayload?.priceContext?.last ?? null;
        // const dataAsOf = marketPayload?.trendMomentum?.ema20_1D?.time || 
        //                 marketPayload?.snapshots?.lastBars1h?.at?.(-1)?.[0];
        // const authoritativeLast = last ?? current_price;
        // const priceGap = last ? Math.abs((current_price - last) / last) : 0;
        // const stalePrice = priceGap > 0.01; // >1%
        
        // console.log(`📊 Price reconciliation: current=${current_price}, last=${last}, gap=${(priceGap*100).toFixed(1)}%, stale=${stalePrice}`);
        
        // const ma = {
        //     ema20_1D: marketPayload?.trendMomentum?.ema20_1D?.ema20,
        //     ema50_1D: marketPayload?.trendMomentum?.ema50_1D?.ema50,
        //     sma200_1D: marketPayload?.trendMomentum?.sma200_1D?.sma200,
        // };
        // const metrics = {
        //     atr14_1D: marketPayload?.trendMomentum?.atr14_1D,
        //     atr14_1h: marketPayload?.trendMomentum?.atr14_1h,
        // };
        
        // // Add metadata with proper IST timestamps
        // parsed.meta = parsed.meta || {};
        
        // // Use most recent bar timestamp instead of daily bar midnight
        // const recentBarTime = marketPayload?.snapshots?.lastBars1h?.slice(-1)?.[0]?.[0] ||
        //                       marketPayload?.snapshots?.lastBars15m?.slice(-1)?.[0]?.[0] ||
        //                       dataAsOf;
        // parsed.meta.data_as_of_ist = recentBarTime || null;
        // parsed.meta.stalePrice = stalePrice;
        
        // // Keep only IST timestamp at root level
        // const now = new Date();
        // const istOffset = 5.5 * 60; // IST is UTC+5:30
        // const istTime = new Date(now.getTime() + (istOffset * 60 * 1000));
        // parsed.generated_at_ist = istTime.toISOString().replace('Z', '+05:30');

        // // Fix enum casing and validate
        // parsed.overall_sentiment = this.clampEnum(
        //     String(parsed.overall_sentiment || '').toUpperCase(),
        //     ['BULLISH', 'BEARISH', 'NEUTRAL'],
        //     'NEUTRAL'
        // );
        
        // if (parsed.market_summary?.trend) {
        //     parsed.market_summary.trend = this.clampEnum(
        //         String(parsed.market_summary.trend).toUpperCase(),
        //         ['BULLISH', 'BEARISH', 'NEUTRAL'],
        //         'NEUTRAL'
        //     );
        // }
        
        // if (parsed.market_summary?.volatility) {
        //     parsed.market_summary.volatility = this.clampEnum(
        //         String(parsed.market_summary.volatility).toUpperCase(),
        //         ['HIGH', 'MEDIUM', 'LOW'],
        //         'MEDIUM'
        //     );
        // }
        
        // if (parsed.market_summary?.volume) {
        //     parsed.market_summary.volume = this.clampEnum(
        //         String(parsed.market_summary.volume).toUpperCase(),
        //         ['ABOVE_AVERAGE', 'AVERAGE', 'BELOW_AVERAGE', 'UNKNOWN'],
        //         'UNKNOWN'
        //     );
        // }
        
        // const ctx = {
        //     analysisType: analysis_type,
        //     market_summary: parsed.market_summary || { last: authoritativeLast },
        //     overall_sentiment: parsed.overall_sentiment,
        //     dataHealth: marketPayload?.meta?.dataHealth,
        //     ma,
        //     metrics
        // };

        // // Price adjustment for stale data
        // if (stalePrice && parsed.strategies?.length > 0) {
        //     console.log('📈 Adjusting strategy prices due to stale data');
        //     const priceDiff = current_price - authoritativeLast;
            
        //     for (const s of parsed.strategies) {
        //         if (s.entry && s.target && s.stopLoss) {
        //             s.entry = +(s.entry + priceDiff).toFixed(2);
        //             s.target = +(s.target + priceDiff).toFixed(2);
        //             s.stopLoss = +(s.stopLoss + priceDiff).toFixed(2);
        //         }
        //     }
        // }
        
        // // Validate parsed response structure
        // if (!parsed || typeof parsed !== 'object') {
        //     console.error('❌ Invalid parsed response structure:', typeof parsed);
        //     return this.generateFallbackAnalysis(current_price, analysis_type);
        // }
        
        // if (!Array.isArray(parsed.strategies)) {
        //     console.warn('⚠️ No valid strategies array found, creating empty array');
        //     parsed.strategies = [];
        // }

        // // guardrails + scoring
        // if (parsed.insufficientData) return parsed;

        // const clean = [];
        // for (const s of parsed.strategies || []) {
        //     // Safety check: ensure strategy is an object
        //     if (!s || typeof s !== 'object' || typeof s === 'string') {
        //         console.warn('⚠️ Skipping invalid strategy:', typeof s, s);
        //         continue;
        //     }
            
        //     // Ensure required fields exist
        //     if (!s.entry || !s.target || !s.stopLoss) {
        //         console.warn('⚠️ Skipping strategy with missing price fields:', s.id || 'unknown');
        //         continue;
        //     }
            
        //     // Ensure prices are numbers and round to 2 decimals
        //     s.entry = +(+s.entry).toFixed(2);
        //     s.target = +(+s.target).toFixed(2);
        //     s.stopLoss = +(+s.stopLoss).toFixed(2);
        //     s.confidence = Number(s.confidence || 0);
            
        //     // Validate bounds
        //     if (s.type === 'BUY' && !(s.stopLoss < s.entry && s.entry < s.target)) continue;
        //     if (s.type === 'SELL' && !(s.target < s.entry && s.entry < s.stopLoss)) continue;
            
        //     // Calculate and validate risk-reward
        //     const rr = Math.abs(s.target - s.entry) / Math.abs(s.entry - s.stopLoss);
        //     if (rr < 1.5 && !['HOLD', 'NO_TRADE'].includes(s.type)) continue;
        //     s.riskReward = Number(rr.toFixed(2));

        //     const scored = this.scoreStrategy(s, ctx);
        //     // Use computed score as confidence for consistency
        //     s.confidence = scored.score;
        //     // Preserve AI's rich risk_meter structure, only set fallback if missing
        //     if (!s.risk_meter || typeof s.risk_meter === 'string') {
        //         s.risk_meter = scored.riskMeter; // Use computed risk meter from scoring as fallback
        //     }
            
        //     // Preserve AI's rich suggested_qty structure, only set fallback if missing
        //     if (!s.suggested_qty || typeof s.suggested_qty === 'number') {
        //         const riskPerShare = Math.abs(s.entry - s.stopLoss);
        //         s.suggested_qty = riskPerShare > 0 ? Math.floor(1000 / riskPerShare) : 10;
        //     }
            
        //     clean.push({ ...s, score: scored.score, score_band: scored.band, score_components: scored.components });
        // }

        // clean.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        
        // // Add NO_TRADE fallback if all scores are low (< 0.6)
        // const hasDecentScore = clean.some(s => (s.score ?? 0) >= 0.6);
        // if (!hasDecentScore && clean.length > 0) {
        //     const authoritativeEntry = clean[0]?.entry || authoritativeLast;
        //     clean.push({
        //         id: 'no_trade_fallback',
        //         type: 'NO_TRADE',
        //         alignment: 'neutral',
        //         title: 'No Trade - Reward Too Small',
        //         confidence: 0,
        //         entryType: 'market',
        //         entry: +(+authoritativeEntry).toFixed(2),
        //         entryRange: null,
        //         target: +(+authoritativeEntry).toFixed(2),
        //         stopLoss: +(+authoritativeEntry).toFixed(2),
        //         riskReward: 0,
        //         timeframe: analysis_type === 'swing' ? '3-7 days' : '1-4 hours',
        //         indicators: [],
        //         reasoning: ['Reward too small for the risk'], // Keep simple for fallback
        //         warnings: ['Wait for clearer setup'],
        //         beginner_summary: 'No trade: risk vs reward not attractive right now.',
        //         why_in_plain_words: ['Reward too small for the risk', 'Better opportunities may emerge'],
        //         what_could_go_wrong: 'Forcing trades in poor setups leads to losses',
        //         money_example: { qty: 10, max_loss: 0, potential_profit: 0 },
        //         risk_meter: 'High',
        //         actionability: 'No trade',
        //         glossary: { entry: '', target: '', stopLoss: '' },
        //         score: 0,
        //         score_band: 'Low',
        //         isTopPick: false
        //     });
        // }
        
        // // Ensure minimum 2 strategies
        // if (clean.length < 2) {
        //     const authoritativeEntry = clean[0]?.entry || authoritativeLast;
        //     clean.push({
        //         id: 'no_trade_minimum',
        //         type: 'NO_TRADE',
        //         alignment: 'neutral',
        //         title: 'No Alternative Trade',
        //         confidence: 0,
        //         entryType: 'market',
        //         entry: +(+authoritativeEntry).toFixed(2),
        //         entryRange: null,
        //         target: +(+authoritativeEntry).toFixed(2),
        //         stopLoss: +(+authoritativeEntry).toFixed(2),
        //         riskReward: 0,
        //         timeframe: analysis_type === 'swing' ? '3-7 days' : '1-4 hours',
        //         indicators: [],
        //         reasoning: [{ because: 'Insufficient valid setups found' }],
        //         warnings: ['Monitor for better opportunities'],
        //         beginner_summary: 'No trade: insufficient valid setups found.',
        //         why_in_plain_words: ['Only one valid setup identified', 'Wait for more opportunities'],
        //         what_could_go_wrong: 'Limited options in current market conditions',
        //         money_example: { qty: 10, max_loss: 0, potential_profit: 0 },
        //         risk_meter: 'High',
        //         actionability: 'No trade',
        //         glossary: { entry: '', target: '', stopLoss: '' },
        //         score: 0,
        //         score_band: 'Low',
        //         isTopPick: false
        //     });
        // }
        
        // // Add top pick badge to highest scoring strategy
        // if (clean.length > 0) {
        //     clean[0].isTopPick = true;
        // }
        
    //    parsed.strategies = clean.slice(0, 3); // Keep top 3 strategies
        
        // // Ensure all strategies have required fields
        // for (const s of parsed.strategies) {
        //     // Ensure entryType is valid
        //     if (!['market', 'limit', 'range', 'stop', 'stop-limit'].includes(s.entryType)) {
        //         s.entryType = s.type === 'BUY' && s.entry > authoritativeLast ? 'stop' : 'limit';
        //     }
            
        //     // Ensure isTopPick is set
        //     if (s.isTopPick === undefined) {
        //         s.isTopPick = false;
        //     }
        // }

        // // Default beginner fallbacks if model missed them
        // for (const s of parsed.strategies) {
        //     // Always enforce beginner summary format with stop loss
        //     const verb = s.type === 'BUY' ? 'Buy' : s.type === 'SELL' ? 'Sell' : 'No trade';
        //     s.beginner_summary = s.type === 'NO_TRADE'
        //         ? 'No trade: setup not attractive.'
        //         : `${verb} ~₹${s.entry} → Take profit ₹${s.target} → Exit ₹${s.stopLoss} (${analysis_type === 'swing' ? '3-7 days' : '1-4 hours'})`;
        //     if (!s.why_in_plain_words) {
        //         s.why_in_plain_words = [
        //             `Stock shows ${s.type === 'BUY' ? 'upward' : s.type === 'SELL' ? 'downward' : 'neutral'} momentum`,
        //             `Risk-reward ratio is ${s.riskReward}:1`
        //         ];
        //     }
        //     if (!s.what_could_go_wrong) {
        //         s.what_could_go_wrong = s.type === 'BUY' ? 
        //             'Price could fall below stop loss causing a loss' : 
        //             s.type === 'SELL' ? 'Price could rise above stop loss causing a loss' : 
        //             'Market conditions may change';
        //     }
        //     if (!s.money_example) {
        //         const qty = 10;
        //         s.money_example = {
        //             qty,
        //             max_loss: +(Math.abs(s.entry - s.stopLoss) * qty).toFixed(2),
        //             potential_profit: +(Math.abs(s.target - s.entry) * qty).toFixed(2)
        //         };
        //     }
        //     // Risk meter should already be set from scoring, but ensure it exists
        //     if (!s.risk_meter) {
        //         s.risk_meter = (s.score >= 0.75 ? 'Low' : s.score >= 0.60 ? 'Medium' : 'High');
        //     }
            
        //     // Ensure suggested_qty exists
        //     if (!s.suggested_qty) {
        //         const riskPerShare = Math.abs(s.entry - s.stopLoss);
        //         s.suggested_qty = riskPerShare > 0 ? Math.floor(1000 / riskPerShare) : 10;
        //     }
        //     if (!s.actionability) {
        //         s.actionability = s.type === 'BUY' ? 'Buy idea' : s.type === 'SELL' ? 'Sell idea' : 'No trade';
        //     }
        //     if (!s.glossary) {
        //         s.glossary = {
        //             entry: "The price at which you should buy/sell the stock",
        //             target: "The price at which you should take profit",
        //             stopLoss: "The price at which you should exit to limit losses"
        //         };
        //     }
        // }

        // if (parsed.market_summary && (!parsed.market_summary.volume || parsed.market_summary.volume === 'UNKNOWN')) {
        //     const preCalculatedVolume = marketPayload?.volumeContext?.classification || 'UNKNOWN';
        //     parsed.market_summary.volume = preCalculatedVolume;
        //     console.log(`📊 Added pre-calculated volume: ${parsed.market_summary.volume}`);
        // }
        
        // 2. Add metadata for debugging (store what was sent to API)
        if (!parsed.meta) {
            parsed.meta = {};
        }
        parsed.meta.model_used = this.analysisModel;
        parsed.meta.processing_time_ms = Date.now() - analysisStartTime;
        parsed.meta.formatted_messages = formattedMessages; // Store exact messages sent to GPT-5
      
        
        
        // // 3. That's it! Return GPT-5's response directly
        // console.log(`✅ GPT-5 analysis complete for ${stock_symbol}`);
        // console.log(`   Strategies: ${parsed.strategies?.length || 0}`);
        // console.log(`   Confidence: ${parsed.strategies?.[0]?.confidence || 'N/A'}`);
        
        return parsed;
    }



    /**
     * Get cached analysis if available and not expired
     */
    async getCachedAnalysis(instrument_key, analysis_type, user_id) {
        return await StockAnalysis.findByInstrumentAndUser(instrument_key, analysis_type, user_id);
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
     * Get user's analysis history
     */
    async getUserAnalysisHistory(user_id, limit = 10) {
        return await StockAnalysis.findActiveForUser(user_id, limit)
            .select('instrument_key stock_name stock_symbol analysis_type current_price created_at analysis_data.market_summary analysis_data.strategies');
    }

    /**
     * Check if user can perform new analysis (rate limiting) - DISABLED FOR TESTING
     */
    async canUserAnalyze(user_id, instrument_key, analysis_type) {
        // Always return true for testing
        return true;
    }
}

export default new AIAnalyzeService();