import AIAnalysisCache from '../models/aiAnalysisCache.js';
import StockAnalysis from '../models/stockAnalysis.js';
import dailyDataPrefetchService from './dailyDataPrefetch.service.js';
import MarketTiming from '../models/marketTiming.js';

/**
 * Enhanced AI Analysis Service with Cross-User Caching
 * 
 * Features:
 * - Cross-user analysis sharing via AIAnalysisCache
 * - Market-aware expiry management (8:45 AM next trading day)
 * - Payload caching for debugging
 * - Cache hit/miss statistics
 * - Automatic fallback to per-user analysis if cache fails
 */
class CachedAiAnalysisService {
    constructor(aiAnalyzeService) {
        this.aiAnalyzeService = aiAnalyzeService;
    }

    /**
     * Main entry point for cached AI analysis
     */
    async analyzeStockWithCache({
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
        const startTime = Date.now();
        
        try {
            console.log(`🧠 [CACHED AI] Starting analysis for ${stock_symbol} (${analysis_type})`);

            // Get current trading date
            const tradingDate = await this.getCurrentTradingDate();
            
            // Step 1: Check cross-user cache first (unless forceFresh)
            if (!forceFresh) {
                const cachedResult = await this.checkCrossUserCache(
                    instrument_key, 
                    analysis_type, 
                    tradingDate, 
                    user_id,
                    current_price
                );
                
                if (cachedResult.found) {
                    console.log(`🎯 [CACHE HIT] Served cached analysis for ${stock_symbol} (used ${cachedResult.data.usage_count} times)`);
                    
                    // Create user-specific StockAnalysis record pointing to cached data
                    await this.createUserAnalysisFromCache(cachedResult.data, user_id);
                    
                    return {
                        success: true,
                        data: cachedResult.userAnalysis,
                        cached: true,
                        cache_info: {
                            expires_at: cachedResult.data.expires_at,
                            generated_at: cachedResult.data.generated_at,
                            usage_count: cachedResult.data.usage_count,
                            served_from: 'cross_user_cache'
                        }
                    };
                } else if (cachedResult.expired) {
                    console.log(`⏰ [CACHE EXPIRED] Found expired analysis for ${stock_symbol}, will generate fresh`);
                }
            }

            // Step 2: Check per-user cache (existing StockAnalysis logic)
            const userAnalysis = await this.checkUserSpecificCache(
                instrument_key, 
                analysis_type, 
                user_id, 
                forceFresh
            );
            
            if (userAnalysis.found) {
                return userAnalysis.result;
            }

            // Step 3: Generate fresh analysis
            console.log(`🔄 [FRESH ANALYSIS] Generating new analysis for ${stock_symbol}`);
            
            const analysisResult = await this.generateFreshAnalysis({
                instrument_key,
                stock_name,
                stock_symbol,
                current_price,
                analysis_type,
                user_id,
                isFromRewardedAd,
                creditType,
                forceFresh,
                tradingDate,
                startTime
            });

            return analysisResult;

        } catch (error) {
            console.error(`❌ [CACHED AI] Analysis failed for ${stock_symbol}:`, error);
            throw error;
        }
    }

    /**
     * Check cross-user cache for existing analysis
     */
    async checkCrossUserCache(instrumentKey, analysisType, tradingDate, userId, currentPrice) {
        try {
            // Check for valid cached analysis
            const cached = await AIAnalysisCache.getCachedAnalysis(
                instrumentKey, 
                analysisType, 
                tradingDate, 
                userId
            );

            if (cached) {
                // Validate price hasn't changed significantly (>5% difference)
                const priceDiff = Math.abs(cached.current_price - currentPrice) / cached.current_price;
                
                if (priceDiff > 0.05) {
                    console.log(`💰 [CACHE] Price changed significantly (${(priceDiff * 100).toFixed(1)}%), cache may be stale`);
                    // Don't return cache but don't mark as expired either
                    return { found: false, priceChanged: true };
                }

                // Create user-specific analysis record
                const userAnalysis = await this.createUserAnalysisFromCache(cached, userId);
                
                return { 
                    found: true, 
                    data: cached,
                    userAnalysis: userAnalysis
                };
            }

            // Check for expired cache
            const expiredCache = await AIAnalysisCache.findOne({
                instrument_key: instrumentKey,
                analysis_type: analysisType,
                trading_date: tradingDate,
                expires_at: { $lt: new Date() }
            });

            if (expiredCache) {
                return { found: false, expired: true };
            }

            return { found: false };

        } catch (error) {
            console.error(`❌ [CACHE] Error checking cross-user cache:`, error);
            return { found: false, error: error.message };
        }
    }

    /**
     * Check user-specific cache (existing StockAnalysis)
     */
    async checkUserSpecificCache(instrumentKey, analysisType, userId, forceFresh) {
        if (forceFresh) {
            return { found: false };
        }

        try {
            const existing = await StockAnalysis.findByInstrumentAndUser(instrumentKey, analysisType, userId);
            
            if (existing) {
                if (existing.status === 'completed') {
                    console.log(`📋 [USER CACHE] Found user-specific cached analysis`);
                    return {
                        found: true,
                        result: {
                            success: true,
                            data: existing,
                            cached: true,
                            cache_info: {
                                served_from: 'user_specific_cache'
                            }
                        }
                    };
                } else if (existing.status === 'in_progress') {
                    console.log(`⏳ [USER CACHE] Analysis already in progress`);
                    return {
                        found: true,
                        result: {
                            success: true,
                            data: existing,
                            inProgress: true
                        }
                    };
                }
            }

            return { found: false };

        } catch (error) {
            console.error(`❌ [USER CACHE] Error checking user cache:`, error);
            return { found: false, error: error.message };
        }
    }

    /**
     * Generate fresh analysis and cache it
     */
    async generateFreshAnalysis({
        instrument_key,
        stock_name,
        stock_symbol,
        current_price,
        analysis_type,
        user_id,
        isFromRewardedAd,
        creditType,
        forceFresh,
        tradingDate,
        startTime
    }) {
        // Use original AI analysis service
        const result = await this.aiAnalyzeService.analyzeStock({
            instrument_key,
            stock_name,
            stock_symbol,
            current_price,
            analysis_type,
            user_id,
            isFromRewardedAd,
            creditType,
            forceFresh
        });

        // If analysis was successful, cache it for cross-user sharing
        if (result.success && result.data && result.data.status === 'completed') {
            try {
                await this.cacheAnalysisResult({
                    instrument_key,
                    stock_symbol,
                    analysis_type,
                    tradingDate,
                    current_price,
                    analysisData: result.data,
                    generationTime: Date.now() - startTime
                });
            } catch (cacheError) {
                console.warn(`⚠️ [CACHE] Failed to cache analysis result:`, cacheError.message);
                // Don't fail the entire request if caching fails
            }
        }

        return result;
    }

    /**
     * Cache analysis result for cross-user sharing
     */
    async cacheAnalysisResult({
        instrument_key,
        stock_symbol,
        analysis_type,
        tradingDate,
        current_price,
        analysisData,
        generationTime
    }) {
        try {
            // Calculate expiry time (8:45 AM next trading day)
            const expiryTime = await this.calculateExpiryTime(tradingDate);
            
            // Get market data used for the analysis
            const marketDataUsed = await this.getMarketDataSnapshot(instrument_key, analysis_type);
            
            // Create AI request payload for debugging
            const aiRequestPayload = {
                instrument_key,
                stock_symbol,
                analysis_type,
                current_price,
                trading_date: tradingDate,
                market_data_sources: marketDataUsed.sources,
                timestamp: new Date()
            };

            // Store in cross-user cache
            const cacheEntry = await AIAnalysisCache.storeAnalysis(
                instrument_key,
                stock_symbol,
                analysis_type,
                tradingDate,
                analysisData.analysis_data, // Store the actual analysis result
                aiRequestPayload,
                marketDataUsed,
                current_price,
                expiryTime,
                generationTime,
                analysisData.ai_model_used || 'gpt-4o'
            );

            if (cacheEntry) {
                console.log(`💾 [CACHE STORE] Cached analysis for ${stock_symbol}, expires at ${expiryTime.toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})}`);
            }

            return cacheEntry;

        } catch (error) {
            console.error(`❌ [CACHE STORE] Failed to cache analysis:`, error);
            throw error;
        }
    }

    /**
     * Create user-specific StockAnalysis record from cached data
     */
    async createUserAnalysisFromCache(cachedData, userId) {
        try {
            // Check if user already has this analysis
            const existing = await StockAnalysis.findByInstrumentAndUser(
                cachedData.instrument_key, 
                cachedData.analysis_type, 
                userId
            );

            if (existing && existing.status === 'completed') {
                return existing;
            }

            // Create new user analysis record
            const userAnalysis = new StockAnalysis({
                instrument_key: cachedData.instrument_key,
                stock_name: cachedData.stock_symbol, // Note: using symbol as name fallback
                stock_symbol: cachedData.stock_symbol,
                analysis_type: cachedData.analysis_type,
                current_price: cachedData.current_price,
                user_id: userId,
                status: 'completed',
                expires_at: cachedData.expires_at,
                analysis_data: cachedData.analysis_result,
                cache_source: {
                    from_cross_user_cache: true,
                    cache_id: cachedData._id,
                    original_generated_at: cachedData.generated_at
                }
            });

            await userAnalysis.markCompleted();
            console.log(`📝 [USER RECORD] Created user analysis record from cache for user ${userId}`);
            
            return userAnalysis;

        } catch (error) {
            console.error(`❌ [USER RECORD] Failed to create user analysis from cache:`, error);
            throw error;
        }
    }

    /**
     * Get current trading date
     */
    async getCurrentTradingDate() {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        // Check if today is a trading day
        const dateStr = today.toISOString().split('T')[0];
        const marketTiming = await MarketTiming.findOne({ date: dateStr });
        
        if (marketTiming && marketTiming.isMarketOpen) {
            return today;
        }
        
        // Fallback: find last trading day
        const lastWeek = new Date(today);
        lastWeek.setDate(lastWeek.getDate() - 7);
        
        const lastTradingDay = await MarketTiming.findOne({
            date: { $gte: lastWeek.toISOString().split('T')[0], $lt: dateStr },
            isMarketOpen: true
        }).sort({ date: -1 });
        
        if (lastTradingDay) {
            return new Date(lastTradingDay.date);
        }
        
        // Ultimate fallback: return today
        return today;
    }

    /**
     * Calculate expiry time (8:45 AM next trading day)
     */
    async calculateExpiryTime(tradingDate) {
        try {
            // Find next trading day after current trading date
            const nextDay = new Date(tradingDate);
            nextDay.setDate(nextDay.getDate() + 1);
            
            // Look for next 7 days to find next trading day
            for (let i = 0; i < 7; i++) {
                const checkDate = new Date(nextDay);
                checkDate.setDate(checkDate.getDate() + i);
                
                const dateStr = checkDate.toISOString().split('T')[0];
                const marketTiming = await MarketTiming.findOne({ date: dateStr });
                
                if (marketTiming && marketTiming.isMarketOpen) {
                    // Found next trading day - set expiry to 8:45 AM IST
                    const expiryTime = new Date(checkDate);
                    expiryTime.setHours(8, 45, 0, 0); // 8:45 AM IST
                    return expiryTime;
                }
            }
            
            // Fallback: expire tomorrow at 8:45 AM
            const fallbackExpiry = new Date(tradingDate);
            fallbackExpiry.setDate(fallbackExpiry.getDate() + 1);
            fallbackExpiry.setHours(8, 45, 0, 0);
            return fallbackExpiry;
            
        } catch (error) {
            console.error(`❌ [EXPIRY] Error calculating expiry time:`, error);
            // Fallback: expire in 24 hours
            const fallback = new Date();
            fallback.setHours(fallback.getHours() + 24);
            return fallback;
        }
    }

    /**
     * Get market data snapshot for debugging
     */
    async getMarketDataSnapshot(instrumentKey, analysisType) {
        try {
            // Check if we have pre-fetched data
            const preFetchedResult = await dailyDataPrefetchService.constructor.getDataForAnalysis(
                instrumentKey, 
                analysisType
            );
            
            const sources = [];
            const dataInfo = {
                sources: sources,
                timestamp: new Date(),
                timeframes_available: []
            };

            if (preFetchedResult.success) {
                sources.push('prefetched');
                dataInfo.timeframes_available = preFetchedResult.timeframes || [];
                dataInfo.prefetched_data_count = preFetchedResult.data?.length || 0;
            } else {
                sources.push('live');
                dataInfo.fallback_reason = preFetchedResult.reason;
            }

            return dataInfo;

        } catch (error) {
            console.error(`❌ [MARKET DATA] Error getting market data snapshot:`, error);
            return {
                sources: ['unknown'],
                error: error.message,
                timestamp: new Date()
            };
        }
    }

    /**
     * Get cache statistics for monitoring
     */
    async getCacheStats(tradingDate = null) {
        const date = tradingDate || await this.getCurrentTradingDate();
        
        try {
            const stats = await AIAnalysisCache.getCacheStats(date);
            const summary = {
                date: date,
                cache_performance: stats,
                current_cache_size: await AIAnalysisCache.countDocuments({
                    trading_date: date,
                    expires_at: { $gt: new Date() }
                }),
                expired_cache_size: await AIAnalysisCache.countDocuments({
                    trading_date: date,
                    expires_at: { $lt: new Date() }
                })
            };
            
            return summary;
            
        } catch (error) {
            console.error(`❌ [CACHE STATS] Error getting cache statistics:`, error);
            throw error;
        }
    }

    /**
     * Manually expire cache for a specific analysis (for testing)
     */
    async expireCache(instrumentKey, analysisType, tradingDate) {
        try {
            const result = await AIAnalysisCache.updateOne(
                {
                    instrument_key: instrumentKey,
                    analysis_type: analysisType,
                    trading_date: tradingDate
                },
                {
                    expires_at: new Date() // Set to expire now
                }
            );
            
            console.log(`🗑️ [CACHE EXPIRE] Manually expired cache for ${instrumentKey}_${analysisType}`);
            return result;
            
        } catch (error) {
            console.error(`❌ [CACHE EXPIRE] Error expiring cache:`, error);
            throw error;
        }
    }
}

export default CachedAiAnalysisService;