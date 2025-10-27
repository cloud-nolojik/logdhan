/**
 * Date Calculation Utility
 * Centralizes all date-related calculations for candle data fetching
 */

import dailyDataPrefetchService from '../services/dailyDataPrefetch.service.js';

class DateCalculator {
    constructor() {
        // Required bars for each timeframe
        this.requiredBars = {
            '15m': 400,
            '1h': 900,
            '1d': 250
        };

        // Approximate bars per trading day for each timeframe
        this.barsPerTradingDay = {
            '5m': 75,   // 9:15 AM - 3:30 PM = 6.25 hours = 75 bars
            '15m': 25,  // 6.25 hours / 15 min = 25 bars
            '1h': 6,    // 6.25 hours = ~6 bars
            '1d': 1     // 1 bar per day
        };
    }

    /**
     * Calculate actual trading days needed by counting backwards from reference date
     */
    async calculateActualTradingDays(timeframe, referenceDate, targetBars = null) {
        const barsNeeded = targetBars || this.requiredBars[timeframe] || 100;
        const barsPerDay = this.barsPerTradingDay[timeframe] || 1;
        const baseTradingDaysNeeded = Math.ceil(barsNeeded / barsPerDay);
        const tradingDaysNeeded = baseTradingDaysNeeded + 20; // Add 20-day buffer for data gaps and missing bars
        
        console.log(`📅 [DATE CALC] ${timeframe}: need ${barsNeeded} bars, ~${barsPerDay}/day = ${baseTradingDaysNeeded} trading days + 20 buffer = ${tradingDaysNeeded} total trading days`);
        
        let currentDate = new Date(referenceDate);
        let tradingDaysFound = 0;
        let calendarDaysChecked = 0;
        const maxDaysToCheck = 365; // Safety limit
        
        // Count backwards to find exact number of trading days
        // Start from reference date and include it in the count
        let holidaysFound = 0;
        while (tradingDaysFound < tradingDaysNeeded && calendarDaysChecked < maxDaysToCheck) {
            // Check if current date is a trading day using database
            const isTradingDay = await dailyDataPrefetchService.isTradingDay(currentDate);
            if (isTradingDay) {
                tradingDaysFound++;
                if (tradingDaysFound <= 5 || tradingDaysFound >= tradingDaysNeeded - 5) {
                    console.log(`📅 [TRADING DAY ${tradingDaysFound}] ${this.formatDateISO(currentDate)}`);
                }
            } else {
                // Check if it's a weekday (Mon-Fri) but marked as non-trading (holiday)
                const dayOfWeek = currentDate.getDay();
                if (dayOfWeek >= 1 && dayOfWeek <= 5) {
                    holidaysFound++;
                    if (holidaysFound <= 10) {
                        console.log(`🚫 [HOLIDAY ${holidaysFound}] ${this.formatDateISO(currentDate)} (weekday but non-trading)`);
                    }
                }
            }
            
            // Move to previous day for next iteration (only if we need more days)
            if (tradingDaysFound < tradingDaysNeeded) {
                currentDate.setDate(currentDate.getDate() - 1);
                calendarDaysChecked++;
            } else {
                break; // We have enough trading days
            }
        }
        
        const totalCalendarDays = calendarDaysChecked;
        const fromDate = new Date(currentDate);
        
        console.log(`📅 [TRADING DAYS] Found ${tradingDaysFound} trading days in ${totalCalendarDays} calendar days`);
        console.log(`🚫 [HOLIDAYS SUMMARY] Found ${holidaysFound} holidays (weekdays marked as non-trading) in the range`);
        
        return {
            tradingDaysNeeded,
            tradingDaysFound,
            totalCalendarDays,
            fromDate
        };
    }

    /**
     * Get Upstox V3 API limits based on official documentation
     */
    getUpstoxLimits(timeframe) {
        const limits = {
            // minutes unit (15m): 1 month for intervals 1-15 minutes
            '15m': { maxMonths: 1, maxCalendarDays: 30 },    
            // hours unit (1h): 1 quarter leading up to to_date
            '1h': { maxMonths: 3, maxCalendarDays: 90 },     
            // days unit (1d): 1 decade leading up to to_date
            '1d': { maxMonths: 120, maxCalendarDays: 3650 }  
        };
        return limits[timeframe] || limits['1d'];
    }

    /**
     * Split large date ranges into Upstox-compliant chunks
     */
    async splitDateRangeIntoChunks(timeframe, fromDate, toDate) {
        const limits = this.getUpstoxLimits(timeframe);
        const chunks = [];
        
        let currentToDate = new Date(toDate);
        let currentFromDate = new Date(fromDate);
        
        // Calculate total days in the range
        const totalDays = Math.ceil((toDate - fromDate) / (1000 * 60 * 60 * 24));
        
        console.log(`🔍 [CHUNK DEBUG] ================================`);
        console.log(`🔍 [CHUNK DEBUG] Timeframe: ${timeframe}`);
        console.log(`🔍 [CHUNK DEBUG] Total range: ${this.formatDateISO(fromDate)} to ${this.formatDateISO(toDate)}`);
        console.log(`🔍 [CHUNK DEBUG] Total days: ${totalDays}`);
        console.log(`🔍 [CHUNK DEBUG] Upstox limit for ${timeframe}: ${limits.maxCalendarDays} days`);
        console.log(`🔍 [CHUNK DEBUG] Needs chunking: ${totalDays > limits.maxCalendarDays ? 'YES' : 'NO'}`);
        
        if (totalDays <= limits.maxCalendarDays) {
            console.log(`✅ [CHUNK DEBUG] Range fits in single call, no chunking needed`);
            return [{
                fromDate: new Date(fromDate),
                toDate: new Date(toDate)
            }];
        }
        
        console.log(`⚠️ [CHUNK DEBUG] Range exceeds limit, splitting into chunks...`);
        
        let chunkCount = 0;
        while (currentFromDate < currentToDate) {
            chunkCount++;
            console.log(`🔍 [CHUNK DEBUG] --- Processing chunk ${chunkCount} ---`);
            console.log(`🔍 [CHUNK DEBUG] Current iteration: fromDate=${this.formatDateISO(currentFromDate)}, toDate=${this.formatDateISO(currentToDate)}`);
            
            // Calculate max allowed from date for this chunk
            const chunkFromDate = new Date(currentToDate);
            chunkFromDate.setDate(chunkFromDate.getDate() - limits.maxCalendarDays);
            console.log(`🔍 [CHUNK DEBUG] Calculated chunkFromDate (toDate - ${limits.maxCalendarDays} days): ${this.formatDateISO(chunkFromDate)}`);
            
            // Use the later of calculated chunk start or actual start date
            const actualFromDate = chunkFromDate > currentFromDate ? chunkFromDate : currentFromDate;
            console.log(`🔍 [CHUNK DEBUG] ActualFromDate (max of chunk vs current): ${this.formatDateISO(actualFromDate)}`);
            
            const chunkDays = Math.ceil((currentToDate - actualFromDate) / (1000 * 60 * 60 * 24));
            console.log(`🔍 [CHUNK DEBUG] Chunk days: ${chunkDays}`);
            
            chunks.push({
                fromDate: new Date(actualFromDate),
                toDate: new Date(currentToDate)
            });
            
            console.log(`📦 [CHUNK ${chunkCount}] ${timeframe}: ${this.formatDateISO(actualFromDate)} to ${this.formatDateISO(currentToDate)} (${chunkDays} days)`);
            
            // Move to next chunk (subtract 1 day to avoid overlap)
            currentToDate = new Date(actualFromDate);
            currentToDate.setDate(currentToDate.getDate() - 1);
            console.log(`🔍 [CHUNK DEBUG] Next iteration toDate: ${this.formatDateISO(currentToDate)}`);
            
            // Safety check to prevent infinite loop
            if (chunkCount > 20) {
                console.error(`❌ [CHUNK DEBUG] Too many chunks (${chunkCount}), breaking to prevent infinite loop`);
                break;
            }
        }
        
        console.log(`📊 [CHUNKS] Split ${timeframe} into ${chunks.length} API calls`);
        console.log(`🔍 [CHUNK DEBUG] Final chunks:`);
        chunks.forEach((chunk, index) => {
            const days = Math.ceil((chunk.toDate - chunk.fromDate) / (1000 * 60 * 60 * 24));
            console.log(`🔍 [CHUNK DEBUG]   ${index + 1}. ${this.formatDateISO(chunk.fromDate)} to ${this.formatDateISO(chunk.toDate)} (${days} days)`);
        });
        console.log(`🔍 [CHUNK DEBUG] ================================`);
        
        return chunks.reverse(); // Return chronological order (oldest first)
    }

    /**
     * Get date range for fetching historical data using real trading days
     */
    async getHistoricalDateRange(timeframe, referenceDate = null, targetBars = null) {
        const toDate = referenceDate ? new Date(referenceDate) : new Date();
        console.log(`📅 [DEBUG] Input referenceDate: ${referenceDate ? this.formatDateISO(referenceDate) : 'null'}`);
        
        // Don't modify the reference date if it's already set correctly
        if (referenceDate) {
            // Keep the original date as-is to avoid timezone issues
            console.log(`📅 [DEBUG] Using original referenceDate as toDate: ${this.formatDateISO(toDate)}`);
        } else {
            toDate.setHours(0, 0, 0, 0);
            console.log(`📅 [DEBUG] After setHours toDate: ${this.formatDateISO(toDate)}`);
        }

        const tradingDayResult = await this.calculateActualTradingDays(timeframe, toDate, targetBars);
        
        console.log(`📅 [DATE RANGE] ${timeframe}: ${this.formatDateISO(tradingDayResult.fromDate)} to ${this.formatDateISO(toDate)} (${tradingDayResult.totalCalendarDays} calendar days, ${tradingDayResult.tradingDaysFound} trading days)`);
        
        // Split into chunks if needed
        const chunks = await this.splitDateRangeIntoChunks(timeframe, tradingDayResult.fromDate, toDate);
        
        return {
            fromDate: tradingDayResult.fromDate,
            toDate,
            tradingDaysNeeded: tradingDayResult.tradingDaysNeeded,
            tradingDaysFound: tradingDayResult.tradingDaysFound,
            calendarDaysNeeded: tradingDayResult.totalCalendarDays,
            chunks: chunks  // Add chunks for API calls
        };
    }

    /**
     * Format date to ISO string (YYYY-MM-DD)
     */
    formatDateISO(date) {
        return date.toISOString().split('T')[0];
    }

    /**
     * Check if a date is a trading day using database
     */
    async isTradingDay(date) {
        return await dailyDataPrefetchService.isTradingDay(date);
    }

    /**
     * Get the previous trading day using database
     */
    async getPreviousTradingDay(date = null) {
        const targetDate = date ? new Date(date) : new Date();
        
        do {
            targetDate.setDate(targetDate.getDate() - 1);
        } while (!(await this.isTradingDay(targetDate)));
        
        return targetDate;
    }

    /**
     * Check if current time is after market close (4:00 PM IST)
     */
    isAfterMarketClose() {
        const now = new Date();
        const hours = now.getHours();
        const minutes = now.getMinutes();
        const currentTimeMinutes = hours * 60 + minutes;
        const marketCloseTime = 16 * 60; // 4:00 PM in minutes
        
        return currentTimeMinutes >= marketCloseTime;
    }

    /**
     * Determine if we should use intraday (current day) or historical data
     */
    async shouldUseIntradayData() {
        // Use intraday data if:
        // 1. It's after 4:00 PM on a trading day
        // 2. Today is a trading day
        const now = new Date();
        const isTradingDay = await this.isTradingDay(now);
        const afterMarketClose = this.isAfterMarketClose();
        
        const useIntraday = isTradingDay && afterMarketClose;
        
        console.log(`📊 [DATA SELECTION] Trading Day: ${isTradingDay}, After 4PM: ${afterMarketClose} → ${useIntraday ? 'INTRADAY' : 'HISTORICAL'}`);
        
        return useIntraday;
    }

    /**
     * Get the appropriate reference date for data fetching
     */
    async getReferenceDate() {
        const now = new Date();
        
        if (await this.shouldUseIntradayData()) {
            // Use today for intraday data
            return now;
        } else {
            // Use previous trading day for historical data
            return await this.getPreviousTradingDay(now);
        }
    }

    /**
     * Calculate timeframe-specific parameters for API calls
     */
    async getTimeframeParams(timeframe, targetBars = null) {
        const referenceDate = await this.getReferenceDate();
        const dateRange = await this.getHistoricalDateRange(timeframe, referenceDate, targetBars);
        const useIntraday = await this.shouldUseIntradayData();
        
        return {
            timeframe,
            referenceDate,
            fromDate: dateRange.fromDate,
            toDate: dateRange.toDate,
            useIntraday,
            barsNeeded: targetBars || this.requiredBars[timeframe] || 100,
            tradingDaysNeeded: dateRange.tradingDaysNeeded,
            tradingDaysFound: dateRange.tradingDaysFound,
            calendarDaysNeeded: dateRange.calendarDaysNeeded
        };
    }
}

// Export singleton instance
const dateCalculator = new DateCalculator();
export default dateCalculator;