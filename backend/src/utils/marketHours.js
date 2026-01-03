/**
 * Market Hours Utility
 * Handles Indian stock market trading hours and holidays
 */

// Indian Stock Market Hours (IST)
const MARKET_HOURS = {
  // Regular trading hours
  REGULAR: {
    start: { hour: 9, minute: 15 }, // 9:15 AM IST
    end: { hour: 15, minute: 30 } // 3:30 PM IST
  },

  // Pre-market session
  PRE_MARKET: {
    start: { hour: 9, minute: 0 }, // 9:00 AM IST
    end: { hour: 9, minute: 15 } // 9:15 AM IST
  },

  // Post-market session  
  POST_MARKET: {
    start: { hour: 15, minute: 30 }, // 3:30 PM IST
    end: { hour: 16, minute: 0 } // 4:00 PM IST
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

      // Convert to IST first, then get date string
      // This ensures we get the correct IST date, not UTC date
      const istDate = this.toIST(date);
      // Format as YYYY-MM-DD in IST timezone
      const year = istDate.getFullYear();
      const month = String(istDate.getMonth() + 1).padStart(2, '0');
      const day = String(istDate.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      const marketTiming = await MarketTiming.findOne({ date: dateStr });

      // If we have cached data in DB, use it
      if (marketTiming) {
        return marketTiming.isMarketOpen;
      }

      // No cached data - check if weekend (use IST day, not UTC)
      const dayOfWeek = istDate.getDay(); // 0=Sunday, 6=Saturday
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

    // Market hours: 9:00 AM to 4:00 PM IST (including pre/post market)
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
    // Pass original date to isMarketOpen - it converts internally
    const isMarketOpen = await this.isMarketOpen(date);

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
    // Market hours per day: 9:00 AM to 4:00 PM = 7 hours = 25,200 seconds
    const marketSecondsPerDay = 7 * 60 * 60; // 7 hours

    // Total market seconds for specified trading days
    const totalMarketSeconds = marketSecondsPerDay * tradingDays;

    // Calculate attempts
    const maxAttempts = Math.floor(totalMarketSeconds / frequencySeconds);

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
      return { session: 'post-market', hours: '3:30 PM - 4:00 PM IST' };
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
   * Get validity time for analysis (next market close)
   * Strategy should be revalidated after this time since it uses previous close data
   *
   * Examples:
   * - Created Friday 2:00 PM → Valid until Friday 3:30 PM (today's close)
   * - Created Friday 4:00 PM → Valid until Monday 3:30 PM (next trading day close)
   * - Created Monday 10:00 AM → Valid until Monday 3:30 PM (today's close)
   *
   * @param {Date} fromDate - Creation date (defaults to now)
   * @returns {Promise<Date>} - Validity time (next market close in IST)
   */
  static async getValidUntilTime(fromDate = new Date()) {
    try {
      const now = fromDate || new Date();
      const istNow = this.toIST(now);

      // Check if today is a trading day
      // Use the raw timestamp here to avoid double timezone conversion
      const isTodayTradingDay = await this.isTradingDay(now);

      // Market close time: 3:59:59 PM IST
      const marketCloseHour = 15;
      const marketCloseMinute = 59;
      const marketCloseTime = marketCloseHour * 60 + marketCloseMinute; // 15:59 = 959 minutes

      const currentHour = istNow.getHours();
      const currentMinute = istNow.getMinutes();
      const currentTimeInMinutes = currentHour * 60 + currentMinute;

      let validUntilDateIST;

      // If today is a trading day and before market close, valid until today's close
      if (isTodayTradingDay && currentTimeInMinutes < marketCloseTime) {

        validUntilDateIST = new Date(istNow);
      } else {
        // Otherwise, valid until next trading day's close

        validUntilDateIST = await this.getNextTradingDay(now);
      }

      // Extract IST date components
      const year = validUntilDateIST.getFullYear();
      const month = validUntilDateIST.getMonth();
      const day = validUntilDateIST.getDate();

      // Create UTC date for 3:59:59 PM IST (10:29:59 AM UTC)
      const validUntilUTC = this.getUtcForIstTime({
        baseDate: validUntilDateIST,
        hour: 15,
        minute: 59,
        second: 59,
        millisecond: 0
      });

      return validUntilUTC;
    } catch (error) {
      console.error('❌ [VALID UNTIL] Error calculating validity time:', error);
      // Fallback: 24 hours from now
      const fallback = new Date();
      fallback.setHours(fallback.getHours() + 24);
      return fallback;
    }
  }

  /**
   * Get monitoring expiry time (3:29:59 PM IST) on the current or next trading day
   * Stored as UTC - expires just before market close at 3:30 PM
   * NOTE: This function assumes server is in UTC timezone
   * @param {Date} fromDate - reference date (defaults to now)
   * @returns {Promise<Date>} UTC date representing 3:29:59 PM IST
   */
  static async getMonitoringExpiryTime(fromDate = new Date()) {
    try {
      const now = fromDate || new Date();

      // Get current IST time components using timezone-safe method
      const istTimeStr = now.toLocaleString('en-US', {
        timeZone: 'Asia/Kolkata',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false
      });
      const [currentHour, currentMinute] = istTimeStr.split(':').map(Number);
      const currentTimeInMinutes = currentHour * 60 + currentMinute;

      // Get IST date string for determining which day we're on
      const istDateStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD format

      // Use UTC timestamp for trading-day check to avoid double conversion
      const isTodayTradingDay = await this.isTradingDay(now);

      // Monitoring expiry time: 3:29:59 PM IST (just before market close)
      const expiryTimeMinutes = 15 * 60 + 29; // 15:29 = 929 minutes

      let expiryDateStr;

      if (isTodayTradingDay && currentTimeInMinutes < expiryTimeMinutes) {
        // Expiry is today
        expiryDateStr = istDateStr;
      } else {
        // Expiry is next trading day
        const nextTradingDay = await this.getNextTradingDay(now);
        expiryDateStr = nextTradingDay.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      }

      // Parse the IST date and create UTC expiry time
      // 3:29:59 PM IST = 09:59:59 UTC (IST is UTC+5:30)
      const [year, month, day] = expiryDateStr.split('-').map(Number);
      const expiryUTC = new Date(Date.UTC(year, month - 1, day, 9, 59, 59, 0));

      return expiryUTC;
    } catch (error) {
      console.error('❌ [MONITORING EXPIRY] Error calculating monitoring expiry time:', error);
      const fallback = new Date();
      fallback.setHours(fallback.getHours() + 24);
      return fallback;
    }
  }

  /**
   * Check if monitoring interactions should be blocked
   * Monitoring is only allowed from 8:00 AM to 3:29:59 PM IST on trading days
   * Blocked: 3:30 PM onwards until 8:00 AM next trading day
   * @param {Date} now - Reference time (defaults to current UTC time)
   * @returns {Promise<{blocked: boolean, reason?: string, next_allowed?: string}>}
   */
  static async isMonitoringWindowBlocked(now = new Date()) {
    // Use timezone-safe method to get current IST time
    const istTimeStr = now.toLocaleString('en-US', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });
    const [currentHour, currentMinute] = istTimeStr.split(':').map(Number);
    const currentMinutes = currentHour * 60 + currentMinute;

    // Monitoring window: 8:00 AM (480 min) to 3:29:59 PM (929 min) IST
    const allowedStart = 8 * 60; // 8:00 AM = 480 minutes
    const allowedEnd = 15 * 60 + 30; // 3:30 PM = 930 minutes (exclusive)

    const isTrading = await this.isTradingDay(now);

    // If not a trading day, always blocked
    if (!isTrading) {
      return {
        blocked: true,
        reason: 'Market is closed today. Monitoring available on next trading day from 8:00 AM IST.',
        next_allowed: 'Next trading day 8:00 AM IST'
      };
    }

    // On trading days: allow only between 8:00 AM and 3:29:59 PM IST
    const isWithinAllowedWindow = currentMinutes >= allowedStart && currentMinutes < allowedEnd;

    if (!isWithinAllowedWindow) {
      // Determine appropriate message based on time
      if (currentMinutes < allowedStart) {
        // Before 8:00 AM
        return {
          blocked: true,
          reason: 'Monitoring available from 8:00 AM IST. Please wait.',
          next_allowed: '8:00 AM IST today'
        };
      } else {
        // After 3:30 PM
        return {
          blocked: true,
          reason: 'Market closed for today. Monitoring available tomorrow from 8:00 AM IST.',
          next_allowed: 'Next trading day 8:00 AM IST'
        };
      }
    }

    // Within allowed window - not blocked
    return {
      blocked: false,
      reason: undefined,
      next_allowed: undefined
    };
  }

  /**
   * Convert an IST clock time on a given calendar day to UTC
   * @param {Object} params
   * @param {Date} [params.baseDate=new Date()] - Reference date (any timezone)
   * @param {number} [params.hour=0] - IST hour (0-23)
   * @param {number} [params.minute=0] - IST minute
   * @param {number} [params.second=0] - IST second
   * @param {number} [params.millisecond=0] - IST millisecond
   * @returns {Date} UTC Date matching the IST clock time on that calendar day
   */
  static getUtcForIstTime({
    baseDate = new Date(),
    hour = 0,
    minute = 0,
    second = 0,
    millisecond = 0
  } = {}) {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

    // Shift into IST day to read the correct calendar components regardless of server timezone
    const istDate = new Date(baseDate.getTime() + IST_OFFSET_MS);
    const year = istDate.getUTCFullYear();
    const month = istDate.getUTCMonth();
    const day = istDate.getUTCDate();

    const utcMs = Date.UTC(year, month, day, hour, minute, second, millisecond) - IST_OFFSET_MS;
    return new Date(utcMs);
  }

  /**
   * Get UTC timestamp for 5:00 PM IST on the provided date (defaults to today)
   * Used to schedule when bulk analyses become visible to users
   * @param {Date} baseDate - Reference date (any timezone)
   * @returns {Date} UTC Date corresponding to 5:00 PM IST
   */
  static getScheduledReleaseTime(baseDate = new Date()) {
    return this.getUtcForIstTime({
      baseDate,
      hour: 17,
      minute: 0,
      second: 0,
      millisecond: 0
    });
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

      // Scheduled window (not allowed)
      const scheduledWindowStart = 16 * 60; // 4.00 PM
      const scheduledWindowEnd = 16 * 60 + 59; // 4.45 PM

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
          validUntil: nextTradingDayEnd.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
        };
      }

      // Check if we're in the scheduled window (4:00 PM - 4:45 PM)
      if (currentTime >= scheduledWindowStart && currentTime < scheduledWindowEnd) {
        return {
          allowed: false,
          reason: "scheduled_window",
          nextAllowed: "Today 4.45 PM IST"
        };
      }

      // Handle afternoon/evening hours (8.59 AM onwards)
      const currentDateIsTradingDay = await this.isTradingDay(currentDate);
      const dayOfWeek = istNow.getDay();

      // Case 1: Friday afternoon/evening or Weekend
      if (dayOfWeek === 5 && currentTime >= bulkStartTime || dayOfWeek === 6 || dayOfWeek === 0) {
        // Find next trading day after current date
        const nextTradingDay = await this.getNextTradingDay(currentDate);
        const nextTradingDayEnd = new Date(nextTradingDay);
        nextTradingDayEnd.setHours(8, 59, 0, 0);

        return {
          allowed: true,
          reason: "weekend_session",
          validUntil: nextTradingDayEnd.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
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
              nextAllowed: "Today 4:00 PM IST"
            };
          }

          // After 4 PM: Allowed until next trading day 8.59 AM
          const nextTradingDay = await this.getNextTradingDay(currentDate);
          const nextTradingDayEnd = new Date(nextTradingDay);
          nextTradingDayEnd.setHours(8, 59, 0, 0);

          return {
            allowed: true,
            reason: "weekday_session",
            validUntil: nextTradingDayEnd.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
          };
        } else {
          // Current day is holiday - allow bulk all day (outside scheduled window)
          const nextTradingDay = await this.getNextTradingDay(currentDate);
          return {
            allowed: true,
            reason: "holiday_session",
            validUntil: `${nextTradingDay.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })} 8:59 AM IST`
          };
        }
      }

      // Default: Not allowed
      return {
        allowed: false,
        reason: "outside_window",
        nextAllowed: "Today 4:00 PM IST"
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

  /**
   * Check if current time is in downtime window
   * NOTE: Downtime disabled - bulk analysis now runs at 7:30 AM before market opens
   * Users can analyze anytime during the day
   *
   * @param {Date} now - Current date (defaults to now)
   * @returns {{isDowntime: boolean, message?: string, nextAllowed?: string}}
   */
  static async isDowntimeWindow(now = new Date()) {
    // No downtime - bulk analysis runs at 7:30 AM before market opens
    return { isDowntime: false };
  }

  /**
   * Get the current quota date in IST
   * Quota window: 5:00 PM (Day T) → 4:00 PM (Day T+1)
   * During 4:00-5:00 PM (downtime), quota_date is still the previous trading day
   *
   * @param {Date} now - Current date (defaults to now)
   * @returns {Promise<string>} Quota date in YYYY-MM-DD format (IST)
   */
  static async getCurrentQuotaDate(now = new Date()) {
    try {
      const istNow = this.toIST(now);
      const hours = istNow.getHours();
      const minutes = hours * 60 + istNow.getMinutes();

      // Downtime: 4:00 PM - 5:00 PM (16:00 - 17:00)
      if (minutes >= 16 * 60 && minutes < 17 * 60) {
        // During downtime, quota_date is still the previous trading day
        const lastTradingDay = await this.getLastTradingDay(istNow);
        return this.formatDateIST(lastTradingDay);
      }

      // After 5:00 PM (>= 17:00)
      if (minutes >= 17 * 60) {
        // If today is a trading day, quota_date is today
        // Otherwise, quota_date is last trading day
        const isTodayTrading = await this.isTradingDay(istNow);
        if (isTodayTrading) {
          return this.formatDateIST(istNow);
        } else {
          const lastTradingDay = await this.getLastTradingDay(istNow);
          return this.formatDateIST(lastTradingDay);
        }
      }

      // Before 4:00 PM (< 16:00)
      // Quota_date is last trading day
      const lastTradingDay = await this.getLastTradingDay(istNow);
      return this.formatDateIST(lastTradingDay);

    } catch (error) {
      console.error('❌ [QUOTA DATE] Error getting current quota date:', error);
      throw error;
    }
  }

  /**
   * Get last trading day before a given date
   * @param {Date} date - Reference date
   * @returns {Promise<Date>} Last trading day
   */
  static async getLastTradingDay(date) {
    let checkDate = new Date(date);

    // Go back one day at a time until we find a trading day
    for (let i = 0; i < 30; i++) {// Max 30 days back (safety limit)
      checkDate.setDate(checkDate.getDate() - 1);
      const isTrading = await this.isTradingDay(checkDate);
      if (isTrading) {
        return checkDate;
      }
    }

    // Fallback: return date from 1 day ago (shouldn't happen)
    const fallback = new Date(date);
    fallback.setDate(fallback.getDate() - 1);
    return fallback;
  }

  /**
   * Format date as YYYY-MM-DD in IST
   * @param {Date} date - Date to format
   * @returns {string} Formatted date string
   */
  static formatDateIST(date) {
    const istDate = this.toIST(date);
    const year = istDate.getFullYear();
    const month = String(istDate.getMonth() + 1).padStart(2, '0');
    const day = String(istDate.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * Get quota window start and end times in UTC
   * Quota window: 5:00 PM IST (Day T) → 4:00 PM IST (Day T+1)
   *
   * @param {Date} now - Current date (defaults to now)
   * @returns {Promise<{startUtc: Date, endUtc: Date, quotaDate: string}>}
   */
  static async getQuotaWindowUTC(now = new Date()) {
    try {
      const quotaDate = await this.getCurrentQuotaDate(now);

      // Parse quota_date
      const [year, month, day] = quotaDate.split('-').map(Number);

      // Create start time: quotaDate 5:00 PM IST → convert to UTC
      // IST is UTC+5:30, so 5:00 PM IST = 11:30 AM UTC (same day)
      const startUtc = new Date(Date.UTC(
        year,
        month - 1,
        day,
        11, // 17:00 IST - 5.5 hours = 11:30 UTC
        30,
        0,
        0
      ));

      // Get next trading day for end time
      // Create date at noon UTC to avoid timezone boundary issues
      const quotaDateObj = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
      const nextTradingDay = await this.getNextTradingDay(quotaDateObj);

      // Create end time: next trading day 4:00 PM IST → convert to UTC
      // 4:00 PM IST = 10:30 AM UTC (same day)
      const endUtc = new Date(Date.UTC(
        nextTradingDay.getFullYear(),
        nextTradingDay.getMonth(),
        nextTradingDay.getDate(),
        10, // 16:00 IST - 5.5 hours = 10:30 UTC
        30,
        0,
        0
      ));

      return {
        startUtc,
        endUtc,
        quotaDate
      };

    } catch (error) {
      console.error('❌ [QUOTA WINDOW] Error getting quota window:', error);
      throw error;
    }
  }

  /**
   * Check if user can analyze a stock (both watchlist quota and daily limit)
   *
   * @param {string} userId - User ID
   * @param {string} instrumentKey - Instrument key being analyzed
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} - {allowed, reason, message, limitInfo}
   */
  static async checkUserAnalysisLimits(userId, instrumentKey, options = {}) {
    try {
      const now = new Date(); // Current time for checks

      const mongoose = (await import('mongoose')).default;
      const { User } = await import('../models/user.js');
      const { Subscription } = await import('../models/subscription.js');
      const { default: Stock } = await import('../models/stock.js');
      const UserAnalyticsUsageModule = await import('../models/userAnalyticsUsage.js');
      const UserAnalyticsUsage = UserAnalyticsUsageModule.default;

      // Get stock symbol from instrument_key
      const stockInfo = await Stock.getByInstrumentKey(instrumentKey);
      const stockSymbol = stockInfo?.trading_symbol || instrumentKey;

      // Get user and subscription
      const user = await User.findById(userId);
      if (!user) {
        return {
          allowed: false,
          reason: 'user_not_found',
          message: 'User not found',
          limitInfo: {}
        };
      }

      const subscription = await Subscription.findActiveForUser(userId);
      if (!subscription) {
        return {
          allowed: true,
          reason: null,
          message: 'No active subscription - analysis allowed',
          limitInfo: {}
        };
      }

      const stockLimit = Number.isFinite(subscription.stockLimit) ?
      subscription.stockLimit :
      Number(subscription.stockLimit) || 0;

      if (stockLimit <= 0) {
        return {
          allowed: true,
          reason: null,
          message: 'No stock limit configured',
          limitInfo: { stockLimit: 0 }
        };
      }

      // Check 1: Watchlist Quota (can analyze if not filled)
      const currentWatchlistCount = user.watchlist.length;

      if (currentWatchlistCount < stockLimit) {

        return {
          allowed: true,
          reason: 'watchlist_quota_available',
          message: 'Analysis allowed - watchlist quota not filled',
          limitInfo: {
            watchlistCount: currentWatchlistCount,
            stockLimit,
            quotaAvailable: true
          }
        };
      }

      // Check 2: Daily Limit (if watchlist is full)

      // Normalize stock symbol
      const normalizeStockSymbol = (symbol) => {
        if (!symbol || typeof symbol !== 'string') return '';
        return symbol.replace(/[-\s]/g, '').toUpperCase();
      };
      const normalizedSymbol = normalizeStockSymbol(stockSymbol);

      const userObjectId = mongoose.Types.ObjectId.isValid(userId) ?
      new mongoose.Types.ObjectId(userId) :
      userId;

     
      const { startUtc, endUtc, quotaDate } = await this.getQuotaWindowUTC();

      // Query usage within quota window
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
      }]
      );

      // Count unique symbols (normalized)
      const uniqueSymbols = new Set();
      for (const entry of usage) {
        const normalized = normalizeStockSymbol(entry?._id);
        if (normalized) {
          uniqueSymbols.add(normalized);
        }
      }

      const usedCount = uniqueSymbols.size;
      const alreadyUsed = uniqueSymbols.has(normalizedSymbol);

      // If this stock was already analyzed today, allow re-analysis
      if (alreadyUsed) {

        return {
          allowed: true,
          reason: 'already_analyzed_today',
          message: 'Stock already analyzed in current quota window',
          limitInfo: {
            watchlistCount: currentWatchlistCount,
            stockLimit,
            dailyUsage: usedCount,
            quotaDate,
            alreadyUsed: true
          }
        };
      }

      // If daily limit reached
      if (usedCount >= stockLimit) {

        // Check current time and trading day status
        const istNow = this.toIST(now);
        const istHours = istNow.getHours();
        const istMinutes = istHours * 60 + istNow.getMinutes();

        // Check if today is a trading day
        const todayDateStr = this.formatDateIST(istNow);
        const isTodayTradingDay = await this.isTradingDay(todayDateStr);

        // Calculate next analysis time
        const nextTradingDay = await this.getNextTradingDay(istNow);
        const nextTradingDayStr = this.formatDateIST(nextTradingDay);

        // Check if we're in downtime (4:00-5:00 PM)
        const downtimeCheck = await this.isDowntimeWindow(now);

        let userMessage;

        // Scenario 1: During downtime (4:00-5:00 PM) on a trading day
        if (downtimeCheck.isDowntime && isTodayTradingDay) {
          userMessage = `You've reached your daily limit of ${stockLimit} analyses. We're processing today's bulk analysis right now! Quota resets at 4:00 PM today. 💡 Add stocks to watchlist - analysis will be ready at 4:00 PM today.`;
        }
        // Scenario 2: Before 4:00 PM on a trading day (but not in downtime)
        else if (istMinutes < 16 * 60 && isTodayTradingDay) {
          userMessage = `You've reached your daily limit of ${stockLimit} analyses. Quota resets at 4:00 PM today. 💡 Add stocks to watchlist now - analysis will be ready at 4:00 PM today.`;
        }
        // Scenario 3: After 4:00 PM or non-trading day (weekend/holiday)
        else {
          userMessage = `You've reached your daily limit of ${stockLimit} analyses. Quota resets on ${nextTradingDayStr} at 4:00 PM. 💡 Add stocks to watchlist now - analysis will be ready on ${nextTradingDayStr} at 4:00 PM.`;
        }

        return {
          allowed: false,
          reason: 'daily_limit_reached',
          message: userMessage,
          limitInfo: {
            watchlistCount: currentWatchlistCount,
            stockLimit,
            dailyUsage: usedCount,
            quotaDate,
            quotaResetsAt: endUtc.toISOString(),
            nextTradingDay: nextTradingDayStr,
            isTodayTradingDay
          }
        };
      }

      // Daily limit not reached - allow analysis

      return {
        allowed: true,
        reason: 'within_daily_limit',
        message: 'Analysis allowed - within daily limit',
        limitInfo: {
          watchlistCount: currentWatchlistCount,
          stockLimit,
          dailyUsage: usedCount,
          quotaDate
        }
      };

    } catch (error) {
      console.error('❌ [USER LIMITS] Error checking user limits:', error);
      return {
        allowed: false,
        reason: 'error',
        message: `Error checking limits: ${error.message}`,
        limitInfo: {}
      };
    }
  }

  /**
   * Get the last Friday's date (for weekly analysis cutoff)
   * If today is Saturday/Sunday, returns the Friday before
   * If today is Mon-Fri, returns the previous Friday
   * @param {Date} fromDate - Reference date (defaults to now)
   * @returns {Date} - Last Friday at market close (3:30 PM IST)
   */
  static getLastFriday(fromDate = new Date()) {
    const istDate = this.toIST(fromDate);
    const dayOfWeek = istDate.getDay(); // 0=Sunday, 1=Monday, ..., 5=Friday, 6=Saturday

    let daysToSubtract;
    if (dayOfWeek === 0) {
      // Sunday → go back 2 days to Friday
      daysToSubtract = 2;
    } else if (dayOfWeek === 6) {
      // Saturday → go back 1 day to Friday
      daysToSubtract = 1;
    } else if (dayOfWeek === 5) {
      // Friday → use previous Friday (7 days back) for consistency
      daysToSubtract = 7;
    } else {
      // Monday=1 → 3 days, Tuesday=2 → 4 days, Wednesday=3 → 5 days, Thursday=4 → 6 days
      daysToSubtract = dayOfWeek + 2;
    }

    const lastFriday = new Date(istDate);
    lastFriday.setDate(lastFriday.getDate() - daysToSubtract);
    // Set to market close time (3:30 PM IST)
    lastFriday.setHours(15, 30, 0, 0);

    return lastFriday;
  }

  /**
   * Get validity time for weekly watchlist analysis (end of trading week)
   * Weekly analysis expires at Friday 3:29:59 PM IST of the current trading week
   *
   * This is different from getValidUntilTime() which expires at next market close (daily).
   * Weekly watchlist analysis should remain valid for the entire trading week.
   *
   * Examples:
   * - Created Monday 10:00 AM → Valid until Friday 3:29:59 PM (same week)
   * - Created Friday 2:00 PM → Valid until Friday 3:29:59 PM (same day)
   * - Created Friday 4:00 PM → Valid until NEXT Friday 3:29:59 PM (next week)
   * - Created Saturday → Valid until NEXT Friday 3:29:59 PM (next week)
   *
   * @param {Date} fromDate - Creation date (defaults to now)
   * @returns {Promise<Date>} - Validity time (Friday 3:29:59 PM IST as UTC)
   */
  static async getWeeklyValidUntilTime(fromDate = new Date()) {
    try {
      const now = fromDate || new Date();
      const istNow = this.toIST(now);

      // Get current day and time in IST
      const dayOfWeek = istNow.getDay(); // 0=Sunday, 1=Monday, ..., 5=Friday, 6=Saturday
      const currentHour = istNow.getHours();
      const currentMinute = istNow.getMinutes();
      const currentTimeInMinutes = currentHour * 60 + currentMinute;

      // Weekly cutoff time: 3:29:59 PM IST (15:29 = 929 minutes)
      const weeklyCutoffTime = 15 * 60 + 29; // 929 minutes

      let targetFriday = new Date(istNow);

      if (dayOfWeek === 5) {
        // It's Friday
        if (currentTimeInMinutes < weeklyCutoffTime) {
          // Before 3:29:59 PM → expires today at 3:29:59 PM
          // targetFriday is already today
        } else {
          // After 3:29:59 PM → expires NEXT Friday
          targetFriday.setDate(targetFriday.getDate() + 7);
        }
      } else if (dayOfWeek === 6) {
        // Saturday → next Friday (6 days ahead)
        targetFriday.setDate(targetFriday.getDate() + 6);
      } else if (dayOfWeek === 0) {
        // Sunday → next Friday (5 days ahead)
        targetFriday.setDate(targetFriday.getDate() + 5);
      } else {
        // Monday (1) → Friday = +4 days
        // Tuesday (2) → Friday = +3 days
        // Wednesday (3) → Friday = +2 days
        // Thursday (4) → Friday = +1 day
        const daysUntilFriday = 5 - dayOfWeek;
        targetFriday.setDate(targetFriday.getDate() + daysUntilFriday);
      }

      // Check if targetFriday is a trading day (not a holiday)
      // If Friday is a holiday, use the last trading day of that week (Thursday, etc.)
      const isFridayTradingDay = await this.isTradingDay(targetFriday);

      if (!isFridayTradingDay) {
        // Friday is a holiday - find the last trading day of the week
        // Go backwards from Friday until we find a trading day
        for (let i = 1; i <= 4; i++) {
          const checkDate = new Date(targetFriday);
          checkDate.setDate(checkDate.getDate() - i);
          const isTrading = await this.isTradingDay(checkDate);
          if (isTrading) {
            targetFriday = checkDate;
            break;
          }
        }
      }

      // Convert to UTC for storage (3:29:59 PM IST = 09:59:59 AM UTC)
      // IST is UTC+5:30, so 15:29:59 IST - 5:30 = 09:59:59 UTC
      const validUntilUTC = this.getUtcForIstTime({
        baseDate: targetFriday,
        hour: 15,
        minute: 29,
        second: 59,
        millisecond: 0
      });

      console.log(`📅 [WEEKLY VALID UNTIL] fromDate IST: ${istNow.toISOString()}`);
      console.log(`📅 [WEEKLY VALID UNTIL] Target Friday IST: ${targetFriday.toISOString()}`);
      console.log(`📅 [WEEKLY VALID UNTIL] Valid until UTC: ${validUntilUTC.toISOString()}`);

      return validUntilUTC;
    } catch (error) {
      console.error('❌ [WEEKLY VALID UNTIL] Error calculating weekly validity time:', error);
      // Fallback: 7 days from now
      const fallback = new Date();
      fallback.setDate(fallback.getDate() + 7);
      return fallback;
    }
  }

  /**
   * Get the most recent Friday (including today if it's Friday)
   * Used for weekend analysis to get Friday's closing data
   * @param {Date} fromDate - Reference date (defaults to now)
   * @returns {Date} - Most recent Friday at market close (3:30 PM IST)
   */
  static getMostRecentFriday(fromDate = new Date()) {
    const istDate = this.toIST(fromDate);
    const dayOfWeek = istDate.getDay(); // 0=Sunday, 1=Monday, ..., 5=Friday, 6=Saturday
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    let daysToSubtract;
    if (dayOfWeek === 0) {
      // Sunday → go back 2 days to Friday
      daysToSubtract = 2;
    } else if (dayOfWeek === 6) {
      // Saturday → go back 1 day to Friday
      daysToSubtract = 1;
    } else if (dayOfWeek === 5) {
      // Friday → use today (0 days back)
      daysToSubtract = 0;
    } else {
      // Monday=1 → 3 days, Tuesday=2 → 4 days, Wednesday=3 → 5 days, Thursday=4 → 6 days
      daysToSubtract = dayOfWeek + 2;
    }

    const friday = new Date(istDate);
    friday.setDate(friday.getDate() - daysToSubtract);
    // Set to market close time (3:30 PM IST)
    friday.setHours(15, 30, 0, 0);

    // Log for verification
    console.log(`📅 [FRIDAY CUTOFF] Today: ${dayNames[dayOfWeek]} (${istDate.toISOString().split('T')[0]})`);
    console.log(`📅 [FRIDAY CUTOFF] Days to subtract: ${daysToSubtract}`);
    console.log(`📅 [FRIDAY CUTOFF] Cutoff date: ${friday.toISOString()} (IST: ${friday.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })})`);

    return friday;
  }
}

export default MarketHoursUtil;;