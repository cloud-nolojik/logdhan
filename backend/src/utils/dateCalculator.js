/**
 * Date Calculation Utility
 * Centralizes all date-related calculations for candle data fetching
 */

import MarketHoursUtil from './marketHours.js';

class DateCalculator {
  constructor() {
    // Required bars for each timeframe
    this.requiredBars = {
      '15m': 400,
      '1h': 900,
      '1d': 240
    };

    // Approximate bars per trading day for each timeframe
    this.barsPerTradingDay = {
      '5m': 75, // 9:15 AM - 3:30 PM = 6.25 hours = 75 bars
      '15m': 25, // 6.25 hours / 15 min = 25 bars
      '1h': 6, // 6.25 hours = ~6 bars
      '1d': 1 // 1 bar per day
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

    let currentDate = new Date(referenceDate);
    let tradingDaysFound = 0;
    let calendarDaysChecked = 0;
    const maxDaysToCheck = 365; // Safety limit

    // Count backwards to find exact number of trading days
    // Start from reference date and include it in the count
    let holidaysFound = 0;
    while (tradingDaysFound < tradingDaysNeeded && calendarDaysChecked < maxDaysToCheck) {
      // Check if current date is a trading day using database
      const isTradingDay = await MarketHoursUtil.isTradingDay(currentDate);
      if (isTradingDay) {
        tradingDaysFound++;
        if (tradingDaysFound <= 5 || tradingDaysFound >= tradingDaysNeeded - 5) {

        }
      } else {
        // Check if it's a weekday (Mon-Fri) but marked as non-trading (holiday)
        const dayOfWeek = currentDate.getDay();
        if (dayOfWeek >= 1 && dayOfWeek <= 5) {
          holidaysFound++;
          if (holidaysFound <= 10) {

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

    if (totalDays <= limits.maxCalendarDays) {

      return [{
        fromDate: new Date(fromDate),
        toDate: new Date(toDate)
      }];
    }

    let chunkCount = 0;
    while (currentFromDate < currentToDate) {
      chunkCount++;

      // Calculate max allowed from date for this chunk
      const chunkFromDate = new Date(currentToDate);
      chunkFromDate.setDate(chunkFromDate.getDate() - limits.maxCalendarDays);

      // Use the later of calculated chunk start or actual start date
      const actualFromDate = chunkFromDate > currentFromDate ? chunkFromDate : currentFromDate;

      const chunkDays = Math.ceil((currentToDate - actualFromDate) / (1000 * 60 * 60 * 24));

      chunks.push({
        fromDate: new Date(actualFromDate),
        toDate: new Date(currentToDate)
      });

      // Move to next chunk (subtract 1 day to avoid overlap)
      currentToDate = new Date(actualFromDate);
      currentToDate.setDate(currentToDate.getDate() - 1);

      // Safety check to prevent infinite loop
      if (chunkCount > 20) {
        console.error(`❌ [CHUNK DEBUG] Too many chunks (${chunkCount}), breaking to prevent infinite loop`);
        break;
      }
    }

    chunks.forEach((chunk, index) => {
      const days = Math.ceil((chunk.toDate - chunk.fromDate) / (1000 * 60 * 60 * 24));

    });

    return chunks.reverse(); // Return chronological order (oldest first)
  }

  /**
   * Get date range for fetching historical data using calendar days
   * Upstox API automatically filters out non-trading days, so we just need to request
   * enough calendar days to ensure we get the required number of bars
   */
  async getHistoricalDateRange(timeframe, referenceDate = null, targetBars = null) {
    // ✅ FIX: Convert to IST timezone to ensure dates are in Indian market timezone
    let toDate;
    if (referenceDate) {
      // Convert the provided reference date to IST
      toDate = MarketHoursUtil.toIST(new Date(referenceDate));
    } else {
      // Get current time in IST
      toDate = MarketHoursUtil.toIST(new Date());
      // Set to midnight IST for today
      toDate.setHours(0, 0, 0, 0);
    }

    // Simple calendar day calculation (no DB queries needed!)
    const barsNeeded = targetBars || this.requiredBars[timeframe] || 100;
    const barsPerDay = this.barsPerTradingDay[timeframe] || 1;

    // Calculate trading days needed
    const tradingDaysNeeded = Math.ceil(barsNeeded / barsPerDay);

    // Add buffer and convert to calendar days (trading days * 1.4 accounts for weekends/holidays)
    // Formula: ~5 trading days per 7 calendar days, so multiply by 1.4
    let calendarDaysNeeded = Math.ceil(tradingDaysNeeded * 1.4) + 10; // Extra 10 day buffer

    // Respect Upstox API limits per timeframe
    const limits = this.getUpstoxLimits(timeframe);
    if (calendarDaysNeeded > limits.maxCalendarDays) {

    }

    // Calculate fromDate by subtracting calendar days
    const fromDate = new Date(toDate);
    fromDate.setDate(fromDate.getDate() - calendarDaysNeeded);

    // Split into chunks if needed (based on Upstox API limits)
    const chunks = await this.splitDateRangeIntoChunks(timeframe, fromDate, toDate);

    return {
      fromDate,
      toDate,
      tradingDaysNeeded,
      calendarDaysNeeded,
      chunks: chunks // Add chunks for API calls
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
    return await MarketHoursUtil.isTradingDay(date);
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
   * Check if current time is in post-market window for intraday data
   * Post-market window: After 5.00 PM but before 9:00 AM next day (pre-market)
   */
  isAfterMarketClose() {
    // ✅ FIX: Use IST timezone instead of server timezone
    const now = MarketHoursUtil.toIST(new Date());
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const currentTimeMinutes = hours * 60 + minutes;

    const marketCloseTime = 16 * 60; // 5.00 PM IST (960 minutes)
    const nextDayPreMarketStart = 9 * 60; // 9:00 AM IST (540 minutes)

    // Valid post-market window:
    // 1. After 5.00 PM same day (16:00 - 23:59)
    // 2. OR Before 9:00 AM next day (00:00 - 08:59)
    const afterClose = currentTimeMinutes >= marketCloseTime; // 5.00 PM - 11:59 PM
    const beforePreMarket = currentTimeMinutes < nextDayPreMarketStart; // 12:00 AM - 8:59 AM

    return afterClose || beforePreMarket;
  }

  /**
   * Determine if we should use intraday (current day) or historical data
   */
  async shouldUseIntradayData() {
    // ✅ FIX: Get current time in IST timezone
    const now = MarketHoursUtil.toIST(new Date());
    const afterMarketClose = this.isAfterMarketClose();

    // Determine which trading day to check:
    // - Before 9:00 AM: Check YESTERDAY (we're in post-market window of previous day)
    // - After 5.00 PM: Check TODAY (we're in post-market window of current day)
    let tradingDateToCheck;
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const currentTimeMinutes = hours * 60 + minutes;
    const preMarketStart = 9 * 60; // 9:00 AM IST

    if (currentTimeMinutes < preMarketStart) {
      // Before 9:00 AM → Check if YESTERDAY was a trading day
      tradingDateToCheck = new Date(now);
      tradingDateToCheck.setDate(tradingDateToCheck.getDate() - 1);
    } else {
      // After 9:00 AM → Check if TODAY is a trading day
      tradingDateToCheck = now;
    }

    const isTradingDay = await this.isTradingDay(tradingDateToCheck);
    const useIntraday = isTradingDay && afterMarketClose;

    return useIntraday;
  }

  /**
   * Get the appropriate reference date for data fetching
   */
  async getReferenceDate() {
    // ✅ FIX: Get current time in IST timezone
    const now = MarketHoursUtil.toIST(new Date());

    if (await this.shouldUseIntradayData()) {
      // Use intraday data - need to determine which day's data to fetch
      const hours = now.getHours();
      const minutes = now.getMinutes();
      const currentTimeMinutes = hours * 60 + minutes;
      const preMarketStart = 9 * 60; // 9:00 AM IST

      if (currentTimeMinutes < preMarketStart) {
        // Before 9:00 AM → Fetch YESTERDAY's intraday data
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        return yesterday;
      } else {
        // After 5.00 PM → Fetch TODAY's intraday data
        return now;
      }
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
      calendarDaysNeeded: dateRange.calendarDaysNeeded,
      chunks: dateRange.chunks // ✅ Include chunks for multi-call API support
    };
  }
}

// Export singleton instance
const dateCalculator = new DateCalculator();
export default dateCalculator;