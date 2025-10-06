/**
 * Upstox Market Timing Service
 * Uses Upstox API to get real-time market timings and holidays
 * Now with database caching to avoid unnecessary API calls
 */

import fetch from 'node-fetch';
import MarketTiming from '../models/marketTiming.js';

class UpstoxMarketTimingService {
    constructor() {
        this.baseUrl = 'https://api.upstox.com/v2';
        this.cache = new Map(); // Cache market timings
        this.cacheTimeout = 24 * 60 * 60 * 1000; // 24 hours
    }

    /**
     * Get market timings for a specific date using database cache first, then Upstox API
     * @param {string} date - Date in YYYY-MM-DD format
     * @param {string} accessToken - Upstox access token
     * @returns {Promise<Object>}
     */
    async getMarketTimings(date, accessToken) {
        const cacheKey = `timings_${date}`;
        
        try {
            // 1. Check database first
            const dbCache = await MarketTiming.findOne({ 
                date: date,
                exchange: 'NSE',
                validUntil: { $gt: new Date() }
            });

            if (dbCache) {
                console.log(`🗄️ Using database cached market timings for ${date}`);
                
                // Return in Upstox API format for compatibility
                const apiFormat = {
                    status: 'success',
                    data: [{
                        exchange: dbCache.exchange,
                        start_time: dbCache.startTime ? dbCache.startTime.getTime() : null,
                        end_time: dbCache.endTime ? dbCache.endTime.getTime() : null,
                        is_holiday: dbCache.isHoliday,
                        reason: dbCache.reason
                    }]
                };

                // Also store in memory cache for immediate access
                this.cache.set(cacheKey, {
                    data: apiFormat,
                    timestamp: Date.now()
                });

                return apiFormat;
            }

            // 2. Check memory cache second
            if (this.cache.has(cacheKey)) {
                const cached = this.cache.get(cacheKey);
                if (Date.now() - cached.timestamp < this.cacheTimeout) {
                    console.log(`💾 Using memory cached market timings for ${date}`);
                    return cached.data;
                }
            }

            // 3. Fetch from Upstox API as last resort
            const url = `${this.baseUrl}/market/timings/${date}`;
            console.log(`📅 Fetching market timings from Upstox API for ${date}`);
            
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${accessToken}`
                }
            });

            if (!response.ok) {
                throw new Error(`Upstox API error: ${response.status} ${response.statusText}`);
            }

            const result = await response.json();
            
            if (result.status !== 'success') {
                throw new Error(`Upstox API returned error status: ${result.status}`);
            }

            // 4. Cache in memory
            this.cache.set(cacheKey, {
                data: result,
                timestamp: Date.now()
            });

            // 5. Cache in database for future use
            await this.cacheMarketTimingInDB(date, result);

            console.log(`✅ Market timings fetched from API for ${date}: ${result.data.length} exchanges`);
            return result;

        } catch (error) {
            console.error(`❌ Failed to fetch market timings for ${date}:`, error.message);
            throw error;
        }
    }

    /**
     * Cache market timing data in database
     * @param {string} date - Date in YYYY-MM-DD format
     * @param {Object} upstoxResponse - Original Upstox API response
     */
    async cacheMarketTimingInDB(date, upstoxResponse) {
        try {
            // Focus on NSE exchange data
            const nseData = upstoxResponse.data.find(exchange => exchange.exchange === 'NSE');
            if (!nseData) {
                console.log(`⚠️ No NSE data found for ${date}, skipping database cache`);
                return;
            }

            // Determine if it's a holiday or market closed day
            const isHoliday = !nseData.start_time || !nseData.end_time;
            const isMarketOpen = !isHoliday && nseData.start_time && nseData.end_time;

            // Set cache validity (valid for 30 days for holidays, 1 day for market days)
            const validUntil = new Date();
            validUntil.setDate(validUntil.getDate() + (isHoliday ? 30 : 1));

            // Upsert the record
            await MarketTiming.findOneAndUpdate(
                { date: date, exchange: 'NSE' },
                {
                    date: date,
                    exchange: 'NSE',
                    isHoliday: isHoliday,
                    isMarketOpen: isMarketOpen,
                    startTime: nseData.start_time ? new Date(nseData.start_time) : null,
                    endTime: nseData.end_time ? new Date(nseData.end_time) : null,
                    reason: isHoliday ? 'Holiday' : 'Trading Day',
                    upstoxData: upstoxResponse,
                    fetchedAt: new Date(),
                    validUntil: validUntil
                },
                { 
                    upsert: true, 
                    new: true,
                    runValidators: true
                }
            );

            console.log(`💾 Cached market timing for ${date} in database (valid until ${validUntil.toISOString()})`);

        } catch (error) {
            console.error(`❌ Failed to cache market timing in database for ${date}:`, error.message);
            // Don't throw - caching failure shouldn't break the main flow
        }
    }

    /**
     * Check if market is open for NSE exchange
     * @param {string} date - Date in YYYY-MM-DD format
     * @param {string} accessToken - Upstox access token
     * @returns {Promise<Object>}
     */
    async isMarketOpen(date, accessToken) {
        try {
            const timings = await this.getMarketTimings(date, accessToken);
            const nseData = timings.data.find(exchange => exchange.exchange === 'NSE');
            
            if (!nseData) {
                return {
                    isOpen: false,
                    reason: 'NSE data not found',
                    nextOpen: null
                };
            }

            const now = Date.now();
            const marketStart = nseData.start_time;
            const marketEnd = nseData.end_time;

            if (now >= marketStart && now <= marketEnd) {
                return {
                    isOpen: true,
                    reason: 'Market is currently open',
                    startTime: new Date(marketStart),
                    endTime: new Date(marketEnd)
                };
            } else if (now < marketStart) {
                return {
                    isOpen: false,
                    reason: 'Market not yet open',
                    nextOpen: new Date(marketStart),
                    startTime: new Date(marketStart),
                    endTime: new Date(marketEnd)
                };
            } else {
                return {
                    isOpen: false,
                    reason: 'Market closed for the day',
                    nextOpen: await this.getNextMarketOpen(date, accessToken)
                };
            }

        } catch (error) {
            console.error('❌ Error checking market status:', error.message);
            // Fallback to weekend/holiday assumption
            return {
                isOpen: false,
                reason: 'Could not determine market status (API error)',
                nextOpen: null
            };
        }
    }

    /**
     * Get next market opening time
     * @param {string} currentDate - Current date in YYYY-MM-DD format
     * @param {string} accessToken - Upstox access token
     * @returns {Promise<Date|null>}
     */
    async getNextMarketOpen(currentDate, accessToken) {
        try {
            // Check next 7 days to find next market open
            for (let i = 1; i <= 7; i++) {
                const checkDate = new Date(currentDate);
                checkDate.setDate(checkDate.getDate() + i);
                const dateStr = checkDate.toISOString().split('T')[0];
                
                try {
                    const timings = await this.getMarketTimings(dateStr, accessToken);
                    const nseData = timings.data.find(exchange => exchange.exchange === 'NSE');
                    
                    if (nseData && nseData.start_time) {
                        console.log(`📅 Next market open: ${new Date(nseData.start_time).toISOString()}`);
                        return new Date(nseData.start_time);
                    }
                } catch (error) {
                    console.log(`📅 No market data for ${dateStr}, checking next day...`);
                    continue;
                }
            }
            
            console.log('📅 Could not find next market open within 7 days');
            return null;

        } catch (error) {
            console.error('❌ Error finding next market open:', error.message);
            return null;
        }
    }

    /**
     * Get next monitoring schedule based on market timings (optimized)
     * @param {string} analysisId - Analysis ID
     * @param {string} accessToken - Upstox access token
     * @param {number} frequencySeconds - Monitoring frequency in seconds
     * @returns {Promise<Object>}
     */
    async getNextMonitoringSchedule(analysisId, accessToken, frequencySeconds = 900) {
        const today = new Date().toISOString().split('T')[0];
        const marketStatus = await this.getMarketStatusOptimized(today, accessToken);

        if (marketStatus.isOpen) {
            // Market is open, schedule next check based on frequency
            const nextCheck = new Date(Date.now() + (frequencySeconds * 1000));
            return {
                nextCheck,
                reason: `Market is open${marketStatus.optimized ? ' (cached)' : ''}`,
                marketStatus: 'open',
                optimized: marketStatus.optimized
            };
        } else if (marketStatus.nextOpen) {
            // Market is closed, schedule for next market open
            return {
                nextCheck: marketStatus.nextOpen,
                reason: `${marketStatus.reason}${marketStatus.optimized ? ' (cached)' : ''}`,
                marketStatus: 'closed',
                nextMarketOpen: marketStatus.nextOpen,
                optimized: marketStatus.optimized
            };
        } else {
            // Could not determine next market open
            return {
                nextCheck: null,
                reason: 'Could not determine next market timing',
                marketStatus: 'unknown',
                optimized: marketStatus.optimized
            };
        }
    }

    /**
     * Check if today is a known holiday without making API calls
     * @param {string} date - Date in YYYY-MM-DD format (optional, defaults to today)
     * @returns {Promise<Object>} - { isKnownHoliday: boolean, reason?: string }
     */
    async isKnownHoliday(date = null) {
        try {
            const checkDate = date || new Date().toISOString().split('T')[0];
            
            // Check database for cached holiday information
            const dbCache = await MarketTiming.findOne({ 
                date: checkDate,
                exchange: 'NSE',
                validUntil: { $gt: new Date() }
            });

            if (dbCache) {
                console.log(`🗄️ Found cached holiday info for ${checkDate}: isHoliday=${dbCache.isHoliday}`);
                return {
                    isKnownHoliday: dbCache.isHoliday,
                    reason: dbCache.reason,
                    cached: true
                };
            }

            // No cached data found
            return {
                isKnownHoliday: false,
                reason: 'No cached data available',
                cached: false
            };

        } catch (error) {
            console.error('❌ Error checking known holiday status:', error.message);
            return {
                isKnownHoliday: false,
                reason: 'Error checking cache',
                cached: false
            };
        }
    }

    /**
     * Get market status with optimized API usage
     * Only makes API calls if no cached data is available
     * @param {string} date - Date in YYYY-MM-DD format
     * @param {string} accessToken - Upstox access token
     * @returns {Promise<Object>}
     */
    async getMarketStatusOptimized(date, accessToken) {
        try {
            // First check if we have cached holiday information
            const holidayCheck = await this.isKnownHoliday(date);
            
            if (holidayCheck.cached && holidayCheck.isKnownHoliday) {
                console.log(`🏖️ Known holiday ${date}, skipping API call`);
                return {
                    isOpen: false,
                    reason: `Known holiday: ${holidayCheck.reason}`,
                    nextOpen: null,
                    optimized: true
                };
            }

            // If we have cached data showing it's NOT a holiday, check market hours
            if (holidayCheck.cached && !holidayCheck.isKnownHoliday) {
                const dbCache = await MarketTiming.findOne({ 
                    date: date,
                    exchange: 'NSE',
                    validUntil: { $gt: new Date() }
                });

                if (dbCache && dbCache.startTime && dbCache.endTime) {
                    const now = Date.now();
                    const marketStart = dbCache.startTime.getTime();
                    const marketEnd = dbCache.endTime.getTime();

                    console.log(`📊 Using cached market hours for ${date}, skipping API call`);

                    if (now >= marketStart && now <= marketEnd) {
                        return {
                            isOpen: true,
                            reason: 'Market is currently open (cached)',
                            startTime: dbCache.startTime,
                            endTime: dbCache.endTime,
                            optimized: true
                        };
                    } else if (now < marketStart) {
                        return {
                            isOpen: false,
                            reason: 'Market not yet open (cached)',
                            nextOpen: dbCache.startTime,
                            startTime: dbCache.startTime,
                            endTime: dbCache.endTime,
                            optimized: true
                        };
                    } else {
                        return {
                            isOpen: false,
                            reason: 'Market closed for the day (cached)',
                            nextOpen: await this.getNextMarketOpen(date, accessToken),
                            optimized: true
                        };
                    }
                }
            }

            // No cached data or incomplete data, fall back to API call
            console.log(`📞 No cached data for ${date}, making API call`);
            return await this.isMarketOpen(date, accessToken);

        } catch (error) {
            console.error('❌ Error in optimized market status check:', error.message);
            // Fallback to original method
            return await this.isMarketOpen(date, accessToken);
        }
    }

    /**
     * Clear cache (useful for testing or force refresh)
     */
    clearCache() {
        this.cache.clear();
        console.log('📅 Market timing cache cleared');
    }

    /**
     * Clear database cache for a specific date (useful for testing)
     */
    async clearDatabaseCache(date = null) {
        try {
            const query = date ? { date } : {};
            const result = await MarketTiming.deleteMany(query);
            console.log(`🗑️ Cleared ${result.deletedCount} database cache entries${date ? ` for ${date}` : ''}`);
            return result;
        } catch (error) {
            console.error('❌ Error clearing database cache:', error.message);
            throw error;
        }
    }
}

export default new UpstoxMarketTimingService();