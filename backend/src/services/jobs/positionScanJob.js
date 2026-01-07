/**
 * Position Scan Job
 *
 * Scheduled 4 PM IST job that scans all open positions using rule-based logic.
 * Zero AI cost - uses engine functions (calculateTrailingStop, checkExitConditions).
 *
 * Output: PositionAlert documents with status (GOOD, WATCH, ACTION_NEEDED)
 * On-demand AI coaching happens when user clicks (exit-coach endpoint).
 */

import Agenda from 'agenda';
import UserPosition from '../../models/userPosition.js';
import PositionAlert from '../../models/positionAlert.js';
import LatestPrice from '../../models/latestPrice.js';
import {
  calculateTrailingStop,
  checkExitConditions,
  checkPositionStatus,
  round2
} from '../../engine/index.js';
import candleFetcherService from '../candleFetcher.service.js';

class PositionScanJob {
  constructor() {
    this.agenda = null;
    this.isInitialized = false;
    this.stats = {
      runsCompleted: 0,
      positionsScanned: 0,
      alertsGenerated: 0,
      errors: 0,
      lastRunAt: null
    };
  }

  /**
   * Initialize the job scheduler
   */
  async initialize() {
    if (this.isInitialized) {
      console.log('[POSITION SCAN] Already initialized');
      return;
    }

    try {
      console.log('[POSITION SCAN] Initializing position scan job...');

      const mongoUrl = process.env.MONGODB_URI;
      this.agenda = new Agenda({
        db: {
          address: mongoUrl,
          collection: 'position_scan_jobs',
          options: {
            useUnifiedTopology: true
          }
        },
        processEvery: '1 minute',
        maxConcurrency: 1,
        defaultConcurrency: 1
      });

      // Define jobs
      this.defineJobs();

      // Setup event handlers
      this.setupEventHandlers();

      // Wait for Agenda to be ready
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Agenda MongoDB connection timeout after 30s'));
        }, 30000);

        this.agenda.on('ready', () => {
          clearTimeout(timeout);
          console.log('[POSITION SCAN] Agenda MongoDB connection ready');
          resolve();
        });

        this.agenda.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // Start agenda
      await this.agenda.start();

      // Schedule recurring jobs
      await this.scheduleRecurringJobs();

      this.isInitialized = true;
      console.log('[POSITION SCAN] Initialization complete');

    } catch (error) {
      console.error('[POSITION SCAN] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Define all job types
   */
  defineJobs() {
    // Main position scan job
    this.agenda.define('position-scan', async (job) => {
      console.log('[POSITION SCAN] Starting scheduled position scan...');

      try {
        const result = await this.runPositionScan(job.attrs.data || {});
        this.stats.runsCompleted++;
        this.stats.lastRunAt = new Date();
        console.log(`[POSITION SCAN] Completed: ${result.positionsScanned} positions, ${result.alertsGenerated} alerts`);
      } catch (error) {
        console.error('[POSITION SCAN] Scan failed:', error);
        this.stats.errors++;
        throw error;
      }
    });

    // Manual trigger job
    this.agenda.define('manual-position-scan', async (job) => {
      console.log('[POSITION SCAN] Manual scan triggered');
      try {
        return await this.runPositionScan(job.attrs.data || {});
      } catch (error) {
        console.error('[POSITION SCAN] Manual scan failed:', error);
        throw error;
      }
    });
  }

  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    this.agenda.on('ready', () => {
      console.log('[POSITION SCAN] Agenda ready');
    });

    this.agenda.on('start', (job) => {
      console.log(`[POSITION SCAN] Job starting: ${job.attrs.name}`);
    });

    this.agenda.on('complete', (job) => {
      console.log(`[POSITION SCAN] Job completed: ${job.attrs.name}`);
    });

    this.agenda.on('fail', (err, job) => {
      console.error(`[POSITION SCAN] Job failed: ${job.attrs.name}`, err);
    });
  }

  /**
   * Schedule recurring jobs
   */
  async scheduleRecurringJobs() {
    try {
      // Cancel existing jobs to avoid duplicates
      await this.agenda.cancel({
        name: 'position-scan'
      });

      // 4 PM IST every weekday (Monday-Friday)
      await this.agenda.every('0 16 * * 1-5', 'position-scan', {}, {
        timezone: 'Asia/Kolkata'
      });

      console.log('[POSITION SCAN] Recurring job scheduled: 4 PM IST weekdays');

    } catch (error) {
      console.error('[POSITION SCAN] Failed to schedule jobs:', error);
      throw error;
    }
  }

  /**
   * Main scan function - scans all open positions
   * @param {Object} options
   * @param {string} [options.userId] - Scan specific user only (optional)
   */
  async runPositionScan(options = {}) {
    const { userId = null } = options;
    const runLabel = '[SCAN-4PM]';
    const jobId = `scan_${Date.now()}`;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`${runLabel} POSITION SCAN STARTED`);
    console.log(`${'='.repeat(60)}`);
    console.log(`${runLabel} Job ID: ${jobId}`);
    console.log(`${runLabel} Time: ${new Date().toISOString()}`);

    const result = {
      positionsScanned: 0,
      alertsGenerated: 0,
      actionNeeded: 0,
      watching: 0,
      onTrack: 0,
      errors: []
    };

    try {
      // Step 1: Get all open positions
      const query = { status: 'OPEN' };
      if (userId) {
        query.user_id = userId;
      }

      const openPositions = await UserPosition.find(query)
        .populate('user_id', 'email name')
        .lean();

      console.log(`${runLabel} Found ${openPositions.length} open positions`);

      if (openPositions.length === 0) {
        console.log(`${runLabel} No open positions to scan`);
        return result;
      }

      // Step 2: Get unique instrument keys
      const instrumentKeys = [...new Set(openPositions.map(p => p.instrument_key))];
      console.log(`${runLabel} Unique instruments: ${instrumentKeys.length}`);

      // Step 3: Fetch current prices for all instruments
      console.log(`${runLabel} Fetching current prices...`);
      const priceMap = {};

      for (const instrumentKey of instrumentKeys) {
        try {
          // Try to get fresh price
          const marketData = await candleFetcherService.getMarketDataForTriggers(instrumentKey);
          if (marketData?.ltp || marketData?.current_price) {
            priceMap[instrumentKey] = {
              price: marketData.ltp || marketData.current_price,
              atr: marketData.indicators?.['1d']?.atr14 || marketData.indicators?.['1h']?.atr14,
              ema20: marketData.indicators?.['1d']?.ema20 || marketData.indicators?.['1h']?.ema20
            };
          }
        } catch (fetchError) {
          // Fallback to LatestPrice collection
          try {
            const priceDoc = await LatestPrice.findOne({ instrument_key: instrumentKey }).lean();
            if (priceDoc) {
              priceMap[instrumentKey] = {
                price: priceDoc.last_traded_price || priceDoc.close,
                atr: null,
                ema20: null
              };
            }
          } catch (fallbackError) {
            console.warn(`${runLabel} Could not fetch price for ${instrumentKey}`);
          }
        }
      }

      console.log(`${runLabel} Fetched prices for ${Object.keys(priceMap).length} instruments`);

      // Step 4: Scan each position
      console.log(`${runLabel} Scanning positions...`);

      for (const position of openPositions) {
        try {
          const priceData = priceMap[position.instrument_key];
          if (!priceData || !priceData.price) {
            console.warn(`${runLabel} Skipping ${position.symbol} - no price data`);
            result.errors.push({ symbol: position.symbol, error: 'No price data' });
            continue;
          }

          const alert = await this.scanSinglePosition(position, priceData, jobId);
          result.positionsScanned++;
          result.alertsGenerated++;

          // Count by status
          if (alert.alert_status === 'ACTION_NEEDED') {
            result.actionNeeded++;
            console.log(`${runLabel} 🔴 ${position.symbol}: ACTION_NEEDED - ${alert.alert_reason}`);
          } else if (alert.alert_status === 'WATCH') {
            result.watching++;
            console.log(`${runLabel} 🟡 ${position.symbol}: WATCH - ${alert.alert_reason}`);
          } else {
            result.onTrack++;
            console.log(`${runLabel} 🟢 ${position.symbol}: GOOD`);
          }

        } catch (positionError) {
          console.error(`${runLabel} Error scanning ${position.symbol}:`, positionError.message);
          result.errors.push({ symbol: position.symbol, error: positionError.message });
        }
      }

      // Step 5: Summary
      console.log(`\n${runLabel} ${'─'.repeat(40)}`);
      console.log(`${runLabel} SCAN COMPLETE`);
      console.log(`${runLabel} ${'─'.repeat(40)}`);
      console.log(`${runLabel} Positions scanned: ${result.positionsScanned}`);
      console.log(`${runLabel} 🔴 Action needed: ${result.actionNeeded}`);
      console.log(`${runLabel} 🟡 Watching: ${result.watching}`);
      console.log(`${runLabel} 🟢 On track: ${result.onTrack}`);
      console.log(`${runLabel} Errors: ${result.errors.length}`);
      console.log(`${'='.repeat(60)}\n`);

      this.stats.positionsScanned += result.positionsScanned;
      this.stats.alertsGenerated += result.alertsGenerated;

      return result;

    } catch (error) {
      console.error(`${runLabel} Scan failed:`, error);
      throw error;
    }
  }

  /**
   * Scan a single position and create/update alert
   * @param {Object} position - UserPosition document
   * @param {Object} priceData - { price, atr, ema20 }
   * @param {string} jobId - Scan job ID
   * @returns {Object} Created/updated PositionAlert
   */
  async scanSinglePosition(position, priceData, jobId) {
    const { price: currentPrice, atr, ema20 } = priceData;
    const { actual_entry, current_sl, current_target, days_in_trade } = position;

    // 1. Check trailing stop conditions (rule-based)
    const trailResult = calculateTrailingStop({
      position: {
        actual_entry,
        current_sl,
        current_target
      },
      current_price: currentPrice,
      atr,
      swing_low: null,
      ema20
    });

    // 2. Check exit conditions
    const exitAlerts = checkExitConditions({
      position: {
        actual_entry,
        current_sl,
        current_target
      },
      current_price: currentPrice,
      atr
    });

    // 3. Check position status (P&L)
    const positionStatus = checkPositionStatus({
      current_price: currentPrice,
      actual_entry,
      qty: position.qty || 1
    });

    // 4. Determine alert status
    let alert_status = 'GOOD';
    let alert_reason = 'Position on track';

    // Critical: SL breach or target hit
    const hasCriticalAlert = exitAlerts.some(a =>
      a.type === 'STOP_HIT' || a.type === 'TARGET_HIT'
    );

    // High priority: Near SL/target, trail recommended, time decay
    const hasHighAlert = exitAlerts.some(a =>
      a.type === 'NEAR_STOP' || a.type === 'NEAR_TARGET'
    );

    if (hasCriticalAlert) {
      alert_status = 'ACTION_NEEDED';
      const slHit = exitAlerts.find(a => a.type === 'STOP_HIT');
      const targetHit = exitAlerts.find(a => a.type === 'TARGET_HIT');
      alert_reason = slHit ? 'Stop loss breached' : 'Target hit';
    } else if (trailResult.should_trail) {
      alert_status = 'WATCH';
      alert_reason = `Trail stop recommended: ${trailResult.method}`;
    } else if (hasHighAlert) {
      alert_status = 'WATCH';
      const nearStop = exitAlerts.find(a => a.type === 'NEAR_STOP');
      const nearTarget = exitAlerts.find(a => a.type === 'NEAR_TARGET');
      alert_reason = nearStop ? 'Approaching stop loss' : 'Approaching target';
    } else if (days_in_trade >= 7) {
      alert_status = 'WATCH';
      alert_reason = `Held for ${days_in_trade} days - review thesis`;
    } else if (positionStatus.pnl_pct <= -5) {
      alert_status = 'WATCH';
      alert_reason = `Significant drawdown: ${positionStatus.pnl_pct}%`;
    }

    // 5. Create alert document
    const alertData = {
      position_id: position._id,
      user_id: position.user_id._id || position.user_id,
      instrument_key: position.instrument_key,
      symbol: position.symbol,
      alert_status,
      alert_reason,
      price_at_scan: round2(currentPrice),
      sl_at_scan: position.current_sl,
      target_at_scan: position.current_target,
      pnl_pct_at_scan: round2(positionStatus.pnl_pct),
      days_in_trade,
      trail_recommendation: trailResult.should_trail ? {
        should_trail: true,
        new_sl: trailResult.new_sl,
        method: trailResult.method,
        reason: trailResult.reason
      } : { should_trail: false },
      exit_alerts: exitAlerts.map(a => ({
        type: a.type,
        details: a.message
      })),
      indicators_at_scan: {
        atr: atr ? round2(atr) : null,
        ema20: ema20 ? round2(ema20) : null
      },
      scanned_at: new Date(),
      scan_job_id: jobId
    };

    // 6. Upsert alert (one per position per day)
    const alert = await PositionAlert.upsertAlert(alertData);

    return alert;
  }

  /**
   * Manually trigger a scan
   * @param {Object} options
   */
  async triggerNow(options = {}) {
    if (!this.isInitialized) {
      throw new Error('Position scan job not initialized');
    }

    console.log('[POSITION SCAN] Manual trigger requested');

    const job = await this.agenda.now('manual-position-scan', options);

    return {
      success: true,
      jobId: job.attrs._id,
      scheduledAt: job.attrs.nextRunAt
    };
  }

  /**
   * Get job stats
   */
  getStats() {
    return {
      ...this.stats,
      isInitialized: this.isInitialized
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    if (this.agenda) {
      await this.agenda.stop();
      console.log('[POSITION SCAN] Shutdown complete');
    }
  }
}

// Export singleton instance
const positionScanJob = new PositionScanJob();

export default positionScanJob;
export { PositionScanJob };
