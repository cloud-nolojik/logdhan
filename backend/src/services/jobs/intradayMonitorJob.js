/**
 * Intraday Monitor Job
 *
 * Scheduled every 15 minutes during market hours (9:15 AM - 3:30 PM IST, weekdays)
 * Monitors for stop loss, T1, and T2 hits for stocks with active positions.
 *
 * Purpose:
 * - Detect stop/T1/T2 hits DURING market hours (not just at EOD)
 * - Create intraday alerts that persist to the stock
 * - DO NOT modify snapshots or run simulation (that's the 4PM job's responsibility)
 *
 * The GET endpoint is now a pure read — this job handles intraday monitoring.
 */

import Agenda from 'agenda';
import WeeklyWatchlist from '../../models/weeklyWatchlist.js';
import priceCacheService from '../priceCache.service.js';
import { firebaseService } from '../firebase/firebase.service.js';

class IntradayMonitorJob {
  constructor() {
    this.agenda = null;
    this.isInitialized = false;
    this.isRunning = false;
    this.stats = {
      runsCompleted: 0,
      alertsTriggered: 0,
      lastRunAt: null,
      lastAlerts: []
    };
  }

  /**
   * Initialize the job scheduler
   */
  async initialize() {
    if (this.isInitialized) {
      console.log('[INTRADAY-MONITOR] Already initialized');
      return;
    }

    try {
      console.log('[INTRADAY-MONITOR] Initializing intraday monitor job...');

      const mongoUrl = process.env.MONGODB_URI;
      this.agenda = new Agenda({
        db: {
          address: mongoUrl,
          collection: 'intraday_monitor_jobs',
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
          console.log('[INTRADAY-MONITOR] Agenda MongoDB connection ready');
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
      console.log('[INTRADAY-MONITOR] Initialization complete');

    } catch (error) {
      console.error('[INTRADAY-MONITOR] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Define all job types
   */
  defineJobs() {
    // Main intraday monitoring job - runs every 15 min during market hours
    this.agenda.define('intraday-monitor', async (job) => {
      if (this.isRunning) {
        console.log('[INTRADAY-MONITOR] Already running, skipping duplicate trigger');
        return { skipped: true, reason: 'already_running' };
      }

      // Check if we're in market hours (9:15 AM - 3:30 PM IST, weekdays)
      if (!this.isMarketHours()) {
        console.log('[INTRADAY-MONITOR] Outside market hours, skipping');
        return { skipped: true, reason: 'outside_market_hours' };
      }

      this.isRunning = true;
      console.log('[INTRADAY-MONITOR] Starting intraday monitoring...');

      try {
        const result = await this.runMonitoring();

        this.stats.runsCompleted++;
        this.stats.lastRunAt = new Date();
        this.stats.alertsTriggered += result.alerts?.length || 0;
        this.stats.lastAlerts = result.alerts || [];

        console.log(`[INTRADAY-MONITOR] Completed: ${result.stocksChecked} stocks checked, ${result.alerts?.length || 0} alerts`);

        return result;

      } catch (error) {
        console.error('[INTRADAY-MONITOR] Monitoring failed:', error);
        throw error;
      } finally {
        this.isRunning = false;
      }
    });

    // Manual trigger for testing
    this.agenda.define('manual-intraday-monitor', async (job) => {
      if (this.isRunning) {
        console.log('[INTRADAY-MONITOR] Already running, skipping manual trigger');
        return { skipped: true, reason: 'already_running' };
      }

      this.isRunning = true;
      console.log('[INTRADAY-MONITOR] Manual monitoring requested');

      try {
        const result = await this.runMonitoring();
        this.stats.lastRunAt = new Date();
        return result;

      } catch (error) {
        console.error('[INTRADAY-MONITOR] Manual monitoring failed:', error);
        throw error;
      } finally {
        this.isRunning = false;
      }
    });
  }

  /**
   * Check if current time is within market hours (IST)
   */
  isMarketHours() {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);

    const dayOfWeek = istNow.getUTCDay(); // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
    const hour = istNow.getUTCHours();
    const minute = istNow.getUTCMinutes();
    const timeInMinutes = hour * 60 + minute;

    // Market hours: 9:15 AM (555 min) to 3:30 PM (930 min), Mon-Fri
    const marketOpen = 9 * 60 + 15;  // 9:15 AM = 555 minutes
    const marketClose = 15 * 60 + 30; // 3:30 PM = 930 minutes

    const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
    const isMarketTime = timeInMinutes >= marketOpen && timeInMinutes <= marketClose;

    return isWeekday && isMarketTime;
  }

  /**
   * Run the monitoring logic
   */
  async runMonitoring() {
    const runLabel = '[INTRADAY-MONITOR]';

    // Get current week's watchlist
    const watchlist = await WeeklyWatchlist.getCurrentWeek();
    if (!watchlist || watchlist.stocks.length === 0) {
      console.log(`${runLabel} No active watchlist or no stocks. Skipping.`);
      return { stocksChecked: 0, alerts: [] };
    }

    // Filter to stocks with active positions (ENTERED or PARTIAL_EXIT)
    const activeStocks = watchlist.stocks.filter(s => {
      const simStatus = s.trade_simulation?.status;
      return simStatus === 'ENTERED' || simStatus === 'PARTIAL_EXIT';
    });

    if (activeStocks.length === 0) {
      console.log(`${runLabel} No stocks with active positions. Skipping.`);
      return { stocksChecked: 0, alerts: [] };
    }

    console.log(`${runLabel} Checking ${activeStocks.length} stocks with active positions`);

    // Fetch live prices
    const instrumentKeys = activeStocks.map(s => s.instrument_key);
    const priceDataMap = await priceCacheService.getLatestPricesWithChange(instrumentKeys);

    const alerts = [];
    let needsSave = false;

    for (const stock of activeStocks) {
      const livePrice = priceDataMap[stock.instrument_key]?.price;
      if (!livePrice) {
        console.log(`${runLabel} ${stock.symbol}: No price data, skipping`);
        continue;
      }

      const sim = stock.trade_simulation;
      const levels = stock.levels;
      const t1 = levels.target1 || levels.target;
      const t2 = levels.target2 || (levels.target1 ? levels.target : null);
      const trailingStop = sim.trailing_stop || levels.stop;

      // Initialize intraday_alerts if needed
      if (!stock.intraday_alerts) {
        stock.intraday_alerts = [];
      }

      // Check for alerts (only if not already alerted today for this type)
      const todayStr = new Date().toISOString().split('T')[0];
      const todaysAlerts = stock.intraday_alerts.filter(a =>
        a.date.toISOString().split('T')[0] === todayStr
      );

      // ══════════════════════════════════════════════
      // CHECK STOP LOSS
      // ══════════════════════════════════════════════
      if (livePrice <= trailingStop) {
        const hasStopAlert = todaysAlerts.some(a => a.type === 'STOP_HIT' || a.type === 'TRAILING_STOP_HIT');
        if (!hasStopAlert) {
          const isTrailing = trailingStop > levels.stop;
          const alertType = isTrailing ? 'TRAILING_STOP_HIT' : 'STOP_HIT';

          // Calculate P&L for this exit
          const exitPnl = (trailingStop - sim.entry_price) * sim.qty_remaining;
          sim.realized_pnl = (sim.realized_pnl || 0) + exitPnl;
          sim.qty_exited = (sim.qty_exited || 0) + sim.qty_remaining;
          sim.qty_remaining = 0;
          sim.status = 'STOPPED_OUT';
          sim.total_pnl = Math.round(sim.realized_pnl);
          sim.total_return_pct = parseFloat(((sim.total_pnl / sim.capital) * 100).toFixed(2));

          // Add event to simulation
          if (!sim.events) sim.events = [];
          sim.events.push({
            date: new Date(),
            type: isTrailing ? 'TRAILING_STOP' : 'STOPPED_OUT',
            price: trailingStop,
            qty: sim.qty_exited,
            pnl: Math.round(exitPnl),
            detail: isTrailing
              ? `Trailing stop hit at ₹${trailingStop.toFixed(2)} — position closed intraday`
              : `Stop loss hit at ₹${trailingStop.toFixed(2)} — position closed intraday`
          });

          // Sync tracking_status
          stock.tracking_status = 'STOPPED_OUT';

          const alert = {
            date: new Date(),
            type: alertType,
            price: livePrice,
            level: trailingStop,
            message: isTrailing
              ? `Trailing stop hit at ₹${livePrice.toFixed(2)} (stop: ₹${trailingStop.toFixed(2)})`
              : `Stop loss hit at ₹${livePrice.toFixed(2)} (stop: ₹${trailingStop.toFixed(2)})`
          };

          stock.intraday_alerts.push(alert);
          alerts.push({ symbol: stock.symbol, ...alert });
          needsSave = true;

          console.log(`${runLabel} 🔴 ${stock.symbol}: ${alertType} at ₹${livePrice.toFixed(2)} — sim updated to STOPPED_OUT`);

          // Send push notification
          try {
            await firebaseService.sendAnalysisCompleteToAllUsers(
              `⚠️ Stop Hit: ${stock.symbol}`,
              alert.message,
              { type: 'stop_hit', symbol: stock.symbol, route: '/weekly-watchlist' }
            );
          } catch (notifError) {
            console.error(`${runLabel} Failed to send notification:`, notifError.message);
          }
        }
        continue; // Stop hit takes priority, skip other checks
      }

      // ══════════════════════════════════════════════
      // CHECK T1 (only for ENTERED status)
      // ══════════════════════════════════════════════
      if (sim.status === 'ENTERED' && livePrice >= t1) {
        const hasT1Alert = todaysAlerts.some(a => a.type === 'T1_HIT');
        if (!hasT1Alert) {
          // Calculate P&L for 50% booking
          const exitQty = Math.floor(sim.qty_total / 2);
          const exitPnl = (t1 - sim.entry_price) * exitQty;
          sim.realized_pnl = (sim.realized_pnl || 0) + exitPnl;
          sim.qty_remaining -= exitQty;
          sim.qty_exited = (sim.qty_exited || 0) + exitQty;
          sim.trailing_stop = sim.entry_price;  // Move stop to breakeven
          sim.status = 'PARTIAL_EXIT';

          // Update P&L (unrealized for remaining position)
          sim.unrealized_pnl = (livePrice - sim.entry_price) * sim.qty_remaining;
          sim.total_pnl = Math.round(sim.realized_pnl + sim.unrealized_pnl);
          sim.total_return_pct = parseFloat(((sim.total_pnl / sim.capital) * 100).toFixed(2));

          // Add event to simulation
          if (!sim.events) sim.events = [];
          sim.events.push({
            date: new Date(),
            type: 'T1_HIT',
            price: t1,
            qty: exitQty,
            pnl: Math.round(exitPnl),
            detail: `T1 hit intraday! Booked 50% (${exitQty} shares) at ₹${t1.toFixed(2)} | Stop → entry ₹${sim.entry_price.toFixed(2)}`
          });

          // Sync tracking_status
          stock.tracking_status = 'TARGET1_HIT';

          const alert = {
            date: new Date(),
            type: 'T1_HIT',
            price: livePrice,
            level: t1,
            message: `T1 hit at ₹${livePrice.toFixed(2)} (target: ₹${t1.toFixed(2)}) — Book 50% profits!`
          };

          stock.intraday_alerts.push(alert);
          alerts.push({ symbol: stock.symbol, ...alert });
          needsSave = true;

          console.log(`${runLabel} 🎯 ${stock.symbol}: T1_HIT at ₹${livePrice.toFixed(2)} — sim updated to PARTIAL_EXIT`);

          // Send push notification
          try {
            await firebaseService.sendAnalysisCompleteToAllUsers(
              `🎯 T1 Hit: ${stock.symbol}`,
              alert.message,
              { type: 't1_hit', symbol: stock.symbol, route: '/weekly-watchlist' }
            );
          } catch (notifError) {
            console.error(`${runLabel} Failed to send notification:`, notifError.message);
          }
        }
      }

      // ══════════════════════════════════════════════
      // CHECK T2 (only for PARTIAL_EXIT status)
      // ══════════════════════════════════════════════
      if (sim.status === 'PARTIAL_EXIT' && t2 && livePrice >= t2) {
        const hasT2Alert = todaysAlerts.some(a => a.type === 'T2_HIT');
        if (!hasT2Alert) {
          // Calculate P&L for remaining position
          const exitPnl = (t2 - sim.entry_price) * sim.qty_remaining;
          sim.realized_pnl = (sim.realized_pnl || 0) + exitPnl;
          sim.qty_exited = (sim.qty_exited || 0) + sim.qty_remaining;
          sim.qty_remaining = 0;
          sim.unrealized_pnl = 0;
          sim.status = 'FULL_EXIT';
          sim.total_pnl = Math.round(sim.realized_pnl);
          sim.total_return_pct = parseFloat(((sim.total_pnl / sim.capital) * 100).toFixed(2));

          // Add event to simulation
          if (!sim.events) sim.events = [];
          sim.events.push({
            date: new Date(),
            type: 'T2_HIT',
            price: t2,
            qty: sim.qty_exited,
            pnl: Math.round(exitPnl),
            detail: `T2 hit intraday! Full target achieved at ₹${t2.toFixed(2)} 🏆`
          });

          // Sync tracking_status
          stock.tracking_status = 'FULL_EXIT';

          const alert = {
            date: new Date(),
            type: 'T2_HIT',
            price: livePrice,
            level: t2,
            message: `T2 hit at ₹${livePrice.toFixed(2)} (target: ₹${t2.toFixed(2)}) — Full target achieved! 🏆`
          };

          stock.intraday_alerts.push(alert);
          alerts.push({ symbol: stock.symbol, ...alert });
          needsSave = true;

          console.log(`${runLabel} 🏆 ${stock.symbol}: T2_HIT at ₹${livePrice.toFixed(2)} — sim updated to FULL_EXIT`);

          // Send push notification
          try {
            await firebaseService.sendAnalysisCompleteToAllUsers(
              `🏆 T2 Hit: ${stock.symbol}`,
              alert.message,
              { type: 't2_hit', symbol: stock.symbol, route: '/weekly-watchlist' }
            );
          } catch (notifError) {
            console.error(`${runLabel} Failed to send notification:`, notifError.message);
          }
        }
      }
    }

    // Save watchlist if any alerts were created
    if (needsSave) {
      await watchlist.save();
      console.log(`${runLabel} Saved ${alerts.length} intraday alerts`);
    }

    return {
      stocksChecked: activeStocks.length,
      alerts
    };
  }

  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    this.agenda.on('ready', () => {
      console.log('[INTRADAY-MONITOR] Agenda ready');
    });

    this.agenda.on('start', (job) => {
      console.log(`[INTRADAY-MONITOR] Job starting: ${job.attrs.name}`);
    });

    this.agenda.on('complete', (job) => {
      console.log(`[INTRADAY-MONITOR] Job completed: ${job.attrs.name}`);
    });

    this.agenda.on('fail', (err, job) => {
      console.error(`[INTRADAY-MONITOR] Job failed: ${job.attrs.name}`, err);
    });
  }

  /**
   * Schedule recurring jobs
   */
  async scheduleRecurringJobs() {
    try {
      // Cancel existing jobs to avoid duplicates
      await this.agenda.cancel({
        name: 'intraday-monitor'
      });

      // Every 15 minutes during market hours (9:15 AM - 3:30 PM IST, weekdays)
      // The job itself checks if we're in market hours
      // Cron: */15 = every 15 minutes
      await this.agenda.every('*/15 * * * 1-5', 'intraday-monitor', {}, {
        timezone: 'Asia/Kolkata'
      });

      console.log('[INTRADAY-MONITOR] Recurring job scheduled: every 15 min, weekdays');

    } catch (error) {
      console.error('[INTRADAY-MONITOR] Failed to schedule jobs:', error);
      throw error;
    }
  }

  /**
   * Manually trigger monitoring
   */
  async triggerNow() {
    if (!this.isInitialized) {
      throw new Error('Intraday monitor job not initialized');
    }

    console.log('[INTRADAY-MONITOR] Manual trigger requested');

    const job = await this.agenda.now('manual-intraday-monitor', {});

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
      isInitialized: this.isInitialized,
      isRunning: this.isRunning
    };
  }

  /**
   * Get next scheduled run
   */
  async getNextRun() {
    if (!this.agenda) return null;

    const jobs = await this.agenda.jobs({
      name: 'intraday-monitor',
      nextRunAt: { $exists: true }
    });

    if (jobs.length > 0) {
      return jobs[0].attrs.nextRunAt;
    }

    return null;
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    if (this.agenda) {
      await this.agenda.stop();
      console.log('[INTRADAY-MONITOR] Shutdown complete');
    }
  }
}

// Export singleton instance
const intradayMonitorJob = new IntradayMonitorJob();

export default intradayMonitorJob;
export { IntradayMonitorJob };
