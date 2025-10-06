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
        end: { hour: 16, minute: 0 }     // 4:00 PM IST
    }
};

// Trading days (Monday = 1, Sunday = 0)
const TRADING_DAYS = [1, 2, 3, 4, 5]; // Monday to Friday

// Indian market holidays (simplified - would need to be updated annually)
const MARKET_HOLIDAYS_2025 = [
    '2025-01-26', // Republic Day
    '2025-03-14', // Holi
    '2025-04-14', // Ram Navami
    '2025-04-18', // Good Friday
    '2025-08-15', // Independence Day
    '2025-10-02', // Gandhi Jayanti
    '2025-10-20', // Dussehra
    '2025-11-07', // Diwali
    '2025-12-25'  // Christmas
];

class MarketHoursUtil {
    /**
     * Check if market is currently open
     * @param {Date} date - Date to check (defaults to now)
     * @returns {boolean}
     */
    static isMarketOpen(date = new Date()) {
        const istDate = this.toIST(date);
        
        // Check if it's a trading day
        if (!this.isTradingDay(istDate)) {
            return false;
        }
        
        // Check if it's within trading hours
        return this.isWithinTradingHours(istDate);
    }
    
    /**
     * Check if it's a trading day (Monday-Friday, not a holiday)
     * @param {Date} istDate - Date in IST
     * @returns {boolean}
     */
    static isTradingDay(istDate) {
        const dayOfWeek = istDate.getDay();
        
        // Check if it's weekend
        if (!TRADING_DAYS.includes(dayOfWeek)) {
            return false;
        }
        
        // Check if it's a holiday
        const dateString = istDate.toISOString().split('T')[0];
        if (MARKET_HOLIDAYS_2025.includes(dateString)) {
            return false;
        }
        
        return true;
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
        
        // Market hours: 9:00 AM to 4:00 PM IST (including pre/post market)
        const startTime = MARKET_HOURS.PRE_MARKET.start.hour * 60 + MARKET_HOURS.PRE_MARKET.start.minute;
        const endTime = MARKET_HOURS.POST_MARKET.end.hour * 60 + MARKET_HOURS.POST_MARKET.end.minute;
        
        return currentTime >= startTime && currentTime <= endTime;
    }
    
    /**
     * Get next market opening time
     * @param {Date} date - Starting date
     * @returns {Date} - Next market open time in IST
     */
    static getNextMarketOpen(date = new Date()) {
        let nextOpen = new Date(this.toIST(date));
        
        // If market is currently open, return current time
        if (this.isMarketOpen(nextOpen)) {
            return nextOpen;
        }
        
        // Check if today is a trading day and before market hours
        if (this.isTradingDay(nextOpen)) {
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
        
        // Find next trading day
        while (!this.isTradingDay(nextOpen)) {
            nextOpen.setDate(nextOpen.getDate() + 1);
        }
        
        // Set to market opening time
        nextOpen.setHours(MARKET_HOURS.PRE_MARKET.start.hour, MARKET_HOURS.PRE_MARKET.start.minute, 0, 0);
        
        return nextOpen;
    }
    
    /**
     * Calculate max attempts based on market hours only
     * @param {number} frequencySeconds - Monitoring frequency in seconds
     * @param {number} tradingDays - Number of trading days to monitor (default: 5)
     * @returns {number}
     */
    static calculateMaxAttemptsForMarketHours(frequencySeconds, tradingDays = 5) {
        // Market hours per day: 9:00 AM to 4:00 PM = 7 hours = 25,200 seconds
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
     * @param {Date} date 
     * @returns {Date}
     */
    static toIST(date) {
        // Create a new date in IST timezone properly
        return new Date(date.toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
    }
    
    /**
     * Get trading session info
     * @param {Date} date 
     * @returns {Object}
     */
    static getTradingSession(date = new Date()) {
        const istDate = this.toIST(date);
        
        if (!this.isTradingDay(istDate)) {
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
            return { session: 'post-market', hours: '3:30 PM - 4:00 PM IST' };
        } else {
            return { session: 'closed', reason: 'after market hours' };
        }
    }
}

export default MarketHoursUtil;