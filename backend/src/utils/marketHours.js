/**
 * Market Hours Utility
 * Handles Indian stock market trading hours and holidays
 */

// Indian Stock Market Hours (IST)
const MARKET_HOURS = {
    // Regular trading hours
    REGULAR: {
        start: { hour: 9, minute: 15 }, // 9:15 AM IST
        end: { hour: 15, minute: 30 }   // 3:30 PM IST
    },
    
    // Pre-market session
    PRE_MARKET: {
        start: { hour: 9, minute: 0 },  // 9:00 AM IST
        end: { hour: 9, minute: 15 }    // 9:15 AM IST
    },
    
    // Post-market session  
    POST_MARKET: {
        start: { hour: 15, minute: 30 }, // 3:30 PM IST
        end: { hour: 16, minute: 0 }     // 5.00 PM IST
    }
};

class MarketHoursUtil {
    /**
     * Normalize a date to midnight (00:00:00.000)
     * Used for MongoDB trading_date field (TTL indexes and date-based queries)
     * @param {Date|string} date - Date to normalize
     * @returns {Date} Date normalized to midnight
     */
    static normalizeDateToMidnight(date) {
        const normalized = new Date(date);
        normalized.setHours(0, 0, 0, 0);
        return normalized;
    }

    /**
     * Check if date is a trading day
     * Uses MarketTiming database for accurate holiday checking
     * @param {Date} date - Date to check
     * @returns {Promise<boolean>}
     */
    static async isTradingDay(date) {
        try {
            // Dynamic import to avoid circular dependency
            const MarketTiming = (await import('../models/marketTiming.js')).default;

            const dateStr = date.toISOString().split('T')[0];
            const marketTiming = await MarketTiming.findOne({ date: dateStr });

            // If we have cached data in DB, use it
            if (marketTiming) {
                return marketTiming.isMarketOpen;
            }

            // No cached data - check if weekend
            const dayOfWeek = date.getUTCDay(); // 0=Sunday, 6=Saturday
            if (dayOfWeek === 0 || dayOfWeek === 6) {
                return false;
            }

            // It's a weekday with no cached data - assume trading day
            // (holidays will be handled once market timing data is populated)
            return true;

        } catch (error) {
            console.error(`❌ [MARKET HOURS] Error checking trading day:`, error);
            throw error;
        }
    }

    /**
     * Check if market is currently open
     * Uses database for accurate trading day checking
     * @param {Date} date - Date to check (defaults to now)
     * @returns {Promise<boolean>}
     */
    static async isMarketOpen(date = new Date()) {
        const istDate = this.toIST(date);

        // Check if it's a trading day
        const isTradingDay = await this.isTradingDay(istDate);

        if (!isTradingDay) {
            return false;
        }

        // Check if it's within trading hours
        return this.isWithinTradingHours(istDate);
    }
    
    /**
     * Check if time is within trading hours (including pre/post market)
     * @param {Date} istDate - Date in IST
     * @returns {boolean}
     */
    static isWithinTradingHours(istDate) {
        const hour = istDate.getHours();
        const minute = istDate.getMinutes();
        const currentTime = hour * 60 + minute; // Convert to minutes
        
        // Market hours: 9:00 AM to 5.00 PM IST (including pre/post market)
        const startTime = MARKET_HOURS.PRE_MARKET.start.hour * 60 + MARKET_HOURS.PRE_MARKET.start.minute;
        const endTime = MARKET_HOURS.POST_MARKET.end.hour * 60 + MARKET_HOURS.POST_MARKET.end.minute;
        
        return currentTime >= startTime && currentTime <= endTime;
    }
    
    /**
     * Get next market opening time
     * Uses database for accurate trading day checking
     * @param {Date} date - Starting date
     * @returns {Promise<Date>} - Next market open time in IST
     */
    static async getNextMarketOpen(date = new Date()) {
        let nextOpen = new Date(this.toIST(date));

        // If market is currently open, return current time
        if (await this.isMarketOpen(nextOpen)) {
            return nextOpen;
        }

        // Check if today is a trading day and before market hours
        const isTodayTradingDay = await this.isTradingDay(nextOpen);
        if (isTodayTradingDay) {
            const hour = nextOpen.getHours();
            const minute = nextOpen.getMinutes();
            const currentTime = hour * 60 + minute;
            const marketStart = MARKET_HOURS.PRE_MARKET.start.hour * 60 + MARKET_HOURS.PRE_MARKET.start.minute;

            if (currentTime < marketStart) {
                // Market opens today
                nextOpen.setHours(MARKET_HOURS.PRE_MARKET.start.hour, MARKET_HOURS.PRE_MARKET.start.minute, 0, 0);
                return nextOpen;
            }
        }

        // Find next trading day using getNextTradingDay (which uses database)
        nextOpen = await this.getNextTradingDay(nextOpen);

        // Set to market opening time
        nextOpen.setHours(MARKET_HOURS.PRE_MARKET.start.hour, MARKET_HOURS.PRE_MARKET.start.minute, 0, 0);

        return nextOpen;
    }

    /**
     * Get effective trading time for data freshness checks
     * - If market is OPEN: Returns current IST time
     * - If market is CLOSED: Returns last trading day at expected candle time based on timeframe
     *   - For intraday (15m, 1h): 3:15 PM (market close time)
     *   - For daily (1d): 00:00 (midnight)
     *
     * This simplifies freshness checks by always returning the "expected last candle time"
     * @param {Date} date - Date to check (defaults to now)
     * @param {string} timeframe - Timeframe to check ('15m', '1h', '1d')
     * @returns {Promise<Date>} - Effective trading time in IST
     */
    static async getEffectiveTradingTime(date = new Date(), timeframe = '15m') {
        const nowIST = this.toIST(date);
        const isMarketOpen = await this.isMarketOpen(nowIST);

        // If market is open, return current time
        if (isMarketOpen) {
            return nowIST;
        }

        // Market is closed - find last trading day
        let lastTradingDay = new Date(nowIST);
        lastTradingDay.setHours(0, 0, 0, 0);

        const isTodayTradingDay = await this.isTradingDay(lastTradingDay);

        // If today is not a trading day, find the last trading day (go back max 5 days)
        if (!isTodayTradingDay) {
            for (let i = 1; i <= 5; i++) {
                const checkDate = new Date(lastTradingDay);
                checkDate.setDate(checkDate.getDate() - i);
                if (await this.isTradingDay(checkDate)) {
                    lastTradingDay = checkDate;
                    break;
                }
            }
        }

        // Set expected candle time based on timeframe
        if (timeframe === '1d') {
            // Daily: expect candle at midnight (00:00:00)
            lastTradingDay.setHours(0, 0, 0, 0);
        } else {
            // Intraday (15m, 1h): expect candle at market close (3:15 PM)
            lastTradingDay.setHours(15, 15, 0, 0);
        }

        return lastTradingDay;
    }

    /**
     * Calculate max attempts based on market hours only
     * @param {number} frequencySeconds - Monitoring frequency in seconds
     * @param {number} tradingDays - Number of trading days to monitor (default: 5)
     * @returns {number}
     */
    static calculateMaxAttemptsForMarketHours(frequencySeconds, tradingDays = 5) {
        // Market hours per day: 9:00 AM to 5.00 PM = 7 hours = 25,200 seconds
        const marketSecondsPerDay = 7 * 60 * 60; // 7 hours
        
        // Total market seconds for specified trading days
        const totalMarketSeconds = marketSecondsPerDay * tradingDays;
        
        // Calculate attempts
        const maxAttempts = Math.floor(totalMarketSeconds / frequencySeconds);
        
        console.log(`📊 Market Hours Calculation:`, {
            frequencySeconds,
            tradingDays,
            marketHoursPerDay: '7 hours (9 AM - 4 PM IST)',
            totalMarketSeconds,
            maxAttempts,
            description: `${maxAttempts} attempts over ${tradingDays} trading days`
        });
        
        return maxAttempts;
    }
    
    /**
     * Convert date to IST
     * Returns a Date object that represents the IST time
     * @param {Date} date
     * @returns {Date}
     */
    static toIST(date) {
        // Use toLocaleString to get IST time string, then parse it back
        // This ensures we get the actual IST time regardless of server timezone
        const istString = date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
        return new Date(istString);
    }
    
    /**
     * Get trading session info
     * Uses database for accurate trading day checking
     * @param {Date} date
     * @returns {Promise<Object>}
     */
    static async getTradingSession(date = new Date()) {
        const istDate = this.toIST(date);

        const isTradingDay = await this.isTradingDay(istDate);
        if (!isTradingDay) {
            return { session: 'closed', reason: 'non-trading day' };
        }

        const hour = istDate.getHours();
        const minute = istDate.getMinutes();
        const currentTime = hour * 60 + minute;

        const preMarketStart = MARKET_HOURS.PRE_MARKET.start.hour * 60 + MARKET_HOURS.PRE_MARKET.start.minute;
        const regularStart = MARKET_HOURS.REGULAR.start.hour * 60 + MARKET_HOURS.REGULAR.start.minute;
        const regularEnd = MARKET_HOURS.REGULAR.end.hour * 60 + MARKET_HOURS.REGULAR.end.minute;
        const postMarketEnd = MARKET_HOURS.POST_MARKET.end.hour * 60 + MARKET_HOURS.POST_MARKET.end.minute;

        if (currentTime < preMarketStart) {
            return { session: 'closed', reason: 'before market hours' };
        } else if (currentTime < regularStart) {
            return { session: 'pre-market', hours: '9:00 AM - 9:15 AM IST' };
        } else if (currentTime < regularEnd) {
            return { session: 'regular', hours: '9:15 AM - 3:30 PM IST' };
        } else if (currentTime < postMarketEnd) {
            return { session: 'post-market', hours: '3:30 PM - 5.00 PM IST' };
        } else {
            return { session: 'closed', reason: 'after market hours' };
        }
    }

    /**
     * Get next trading day from a given date
     * Uses MarketTiming database for accurate holiday checking
     * @param {Date} fromDate - Starting date
     * @returns {Promise<Date>} - Next trading day
     */
    static async getNextTradingDay(fromDate = new Date()) {
        let checkDate = new Date(fromDate);
        checkDate.setDate(checkDate.getDate() + 1); // Start from next day

        let maxDays = 10; // Prevent infinite loop
        while (maxDays > 0) {
            // Use isTradingDay() - checks MarketTiming DB
            const isTradingDay = await this.isTradingDay(checkDate);

            if (isTradingDay) {
                return checkDate;
            }

            checkDate.setDate(checkDate.getDate() + 1);
            maxDays--;
        }

        // Fallback: return next Monday
        const nextMonday = new Date(fromDate);
        nextMonday.setDate(nextMonday.getDate() + ((1 + 7 - nextMonday.getDay()) % 7 || 7));
        return nextMonday;
    }

    /**
     * COMMON EXPIRY TIME FUNCTION
     * Calculate expiry time for ALL analyses, monitoring, sessions
     * Rules:
     * - If today is a trading day and current time is before 3:55 PM IST: Expires TODAY at 3:55 PM IST
     * - Otherwise: Expires on NEXT trading day at 3:55 PM IST
     * Stored in DB as UTC (3:55 PM IST - 5:30 = 10:25 AM UTC)
     *
     * @param {Date} fromDate - Starting date (defaults to now)
     * @returns {Date} - Expiry time in UTC for database storage
     */
    static async getExpiryTime(fromDate = new Date()) {
        try {
            const now = fromDate || new Date();
            const istNow = this.toIST(now);

            console.log(`📅 [EXPIRY CALC] Current time IST: ${istNow.toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})}`);

            // Check if today is a trading day using database
            const isTodayTradingDay = await this.isTradingDay(istNow);
            const currentHour = istNow.getHours();
            const currentMinute = istNow.getMinutes();
            const currentTimeInMinutes = currentHour * 60 + currentMinute;
            const expiryTimeInMinutes = 15 * 60 + 55; // 3:55 PM = 15:55

            let expiryDate;

            // If today is a trading day and we're before 3:55 PM, expire today
            if (isTodayTradingDay && currentTimeInMinutes < expiryTimeInMinutes) {
                console.log(`📅 [EXPIRY CALC] Today is a trading day and before 3:55 PM - expiring TODAY`);
                expiryDate = new Date(istNow);
            } else {
                // Otherwise, get next trading day
                console.log(`📅 [EXPIRY CALC] ${!isTodayTradingDay ? 'Today is not a trading day' : 'Already past 3:55 PM'} - expiring NEXT trading day`);
                expiryDate = await this.getNextTradingDay(istNow);
            }

            console.log(`📅 [EXPIRY CALC] Expiry trading day: ${expiryDate.toISOString()}`);

            // Create expiry time in UTC directly
            // We want 3:55 PM IST = 10:25 AM UTC
            // So we set the UTC date to the expiry day, then set UTC hours to 10:25
            const expiryUTC = new Date(expiryDate);
            expiryUTC.setUTCHours(10, 25, 0, 0); // 10:25 AM UTC = 3:55 PM IST

            console.log(`📅 [EXPIRY CALC] Expiry IST: ${expiryUTC.toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})} (should be 3:55 PM IST)`);
            console.log(`📅 [EXPIRY CALC] Expiry UTC (DB): ${expiryUTC.toISOString()} (should be 10:25 AM UTC)`);

            return expiryUTC;
        } catch (error) {
            console.error('❌ [EXPIRY CALC] Error calculating expiry time:', error);
            // Fallback: 24 hours from now
            const fallback = new Date();
            fallback.setHours(fallback.getHours() + 24);
            return fallback;
        }
    }

    /**
     * Check if bulk analysis is allowed
     * Window: 5.00 PM to next trading day 8.59 AM IST
     * @param {Date} fromDate - Date to check (defaults to now)
     * @returns {Promise<Object>} - { allowed: boolean, reason: string, validUntil/nextAllowed: string }
     */
    static async isBulkAnalysisAllowed(fromDate = new Date()) {
        try {
            const now = fromDate || new Date();
            const istNow = this.toIST(now);

            const currentTime = istNow.getHours() * 60 + istNow.getMinutes(); // Total minutes

            // Bulk analysis window
            const bulkStartTime = 17 * 60; // 5.00 PM
            const bulkEndTime = 8 * 60 + 45; // 8.59 AM

            // Current date for checking if it's a trading day
            const currentDate = new Date(istNow);
            currentDate.setHours(0, 0, 0, 0);

            // IMPORTANT: Handle early morning hours (12 AM - 8.59 AM) first
            // These are continuation of previous day's session
            if (currentTime < bulkEndTime) {
                // This is early morning - check if we're in continuation of yesterday's session
                const yesterdayDate = new Date(currentDate);
                yesterdayDate.setDate(yesterdayDate.getDate() - 1);

                const yesterdayWasTradingDay = await this.isTradingDay(yesterdayDate);

                // If yesterday was a trading day, then we're in the continuation session
                if (yesterdayWasTradingDay) {
                    return {
                        allowed: true,
                        reason: "morning_session",
                        validUntil: `Today 8.59 AM IST`
                    };
                }

                // If yesterday was not a trading day, check if today is a trading day
                const todayIsTradingDay = await this.isTradingDay(currentDate);
                if (todayIsTradingDay) {
                    return {
                        allowed: true,
                        reason: "monday_morning",
                        validUntil: "Today 8.59 AM IST"
                    };
                }

                // Neither yesterday nor today is trading day - weekend/holiday
                // Weekends and holidays should ALLOW analysis anytime
                const nextTradingDay = await this.getNextTradingDay(currentDate);
                const nextTradingDayEnd = new Date(nextTradingDay);
                nextTradingDayEnd.setHours(8, 59, 0, 0);

                return {
                    allowed: true,
                    reason: "weekend_session",
                    validUntil: nextTradingDayEnd.toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})
                };
            }

            // Handle afternoon/evening hours (8.59 AM onwards)
            const currentDateIsTradingDay = await this.isTradingDay(currentDate);
            const dayOfWeek = istNow.getDay();

            // Case 1: Friday afternoon/evening or Weekend
            if ((dayOfWeek === 5 && currentTime >= bulkStartTime) || dayOfWeek === 6 || dayOfWeek === 0) {
                // Find next trading day after current date
                const nextTradingDay = await this.getNextTradingDay(currentDate);
                const nextTradingDayEnd = new Date(nextTradingDay);
                nextTradingDayEnd.setHours(8, 59, 0, 0);

                return {
                    allowed: true,
                    reason: "weekend_session",
                    validUntil: nextTradingDayEnd.toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})
                };
            }

            // Case 2: Weekday afternoon/evening (Monday-Thursday)
            if (dayOfWeek >= 1 && dayOfWeek <= 5) {
                // If current day is a trading day
                if (currentDateIsTradingDay) {
                    // Before 4 PM: Not allowed
                    if (currentTime < bulkStartTime) {
                        return {
                            allowed: false,
                            reason: "before_session",
                            nextAllowed: "Today 5.00 PM IST"
                        };
                    }

                    // After 4 PM: Allowed until next trading day 8.59 AM
                    const nextTradingDay = await this.getNextTradingDay(currentDate);
                    const nextTradingDayEnd = new Date(nextTradingDay);
                    nextTradingDayEnd.setHours(8, 59, 0, 0);

                    return {
                        allowed: true,
                        reason: "weekday_session",
                        validUntil: nextTradingDayEnd.toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})
                    };
                } else {
                    // Current day is holiday
                    const nextTradingDay = await this.getNextTradingDay(currentDate);
                    return {
                        allowed: false,
                        reason: "holiday",
                        nextAllowed: `${nextTradingDay.toLocaleDateString('en-IN', {timeZone: 'Asia/Kolkata'})} 5.00 PM IST`
                    };
                }
            }

            // Default: Not allowed
            return {
                allowed: false,
                reason: "outside_window",
                nextAllowed: "Today 5.00 PM IST"
            };
        } catch (error) {
            console.error('❌ [BULK ANALYSIS CHECK] Error checking bulk analysis window:', error);
            return {
                allowed: false,
                reason: "error",
                nextAllowed: "Please try again"
            };
        }
    }
}

export default MarketHoursUtil;