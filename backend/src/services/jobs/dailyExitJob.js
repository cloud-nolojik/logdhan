/**
 * Daily Exit Job — 3:00 PM IST (node-cron)
 *
 * Force-exits all open daily pick positions at 3:00 PM IST.
 *
 * WHY node-cron instead of Agenda:
 * Agenda uses MongoDB polling (processEvery: '1 minute') to pick up due jobs.
 * On every deploy/restart, it cancels + recreates the job document. If deploys happen
 * during market hours, the job can end up with stale locks or missed nextRunAt windows.
 * On Feb 10 2026, Agenda failed to fire the 3 PM exit — Zerodha auto-squaredoff at 3:25 PM instead.
 * node-cron runs in-process with zero DB dependency — fires exactly at 3:00 PM IST every time.
 *
 * MIS auto-squareoff at 3:20 PM by exchange as safety net.
 */

import cron from 'node-cron';
import { runDailyExit } from '../dailyPicks/dailyPicksExitService.js';
import MarketHoursUtil from '../../utils/marketHours.js';

const LOG = '[DAILY-EXIT-JOB]';

class DailyExitJob {
  constructor() {
    this.cronTask = null; // node-cron task handle (replaces Agenda instance)
    this.isInitialized = false;
    this.isRunning = false;
    this.stats = {
      runsCompleted: 0,
      positionsExited: 0,
      errors: 0,
      lastRunAt: null,
      lastResult: null
    };
  }

  /**
   * Schedule the 3:00 PM IST cron. Safe to call multiple times (idempotent).
   */
  async initialize() {
    if (this.isInitialized) {
      console.log(`${LOG} Already initialized`);
      return;
    }

    try {
      console.log(`${LOG} Initializing with node-cron...`);

      // 3:00 PM IST, Monday-Friday — force-exit all open daily pick MIS positions
      // node-cron fires in-process at exactly 3:00 PM IST, no MongoDB polling needed
      this.cronTask = cron.schedule('0 15 * * 1-5', () => {
        // Cron callback — this fires at 3:00 PM IST every weekday
        console.log(`${LOG} ⏰ 3:00 PM IST cron fired — starting force-exit`);
        this.executeExit().catch(err => {
          // Catch here so node-cron doesn't swallow the error silently
          console.error(`${LOG} ❌ 3:00 PM cron execution failed:`, err);
        });
      }, {
        scheduled: true,
        timezone: 'Asia/Kolkata' // IST — 3:00 PM Indian market close time
      });

      this.isInitialized = true;
      console.log(`${LOG} ✅ Scheduled: 3:00 PM IST, Mon-Fri (node-cron — in-process, no DB polling)`);
    } catch (error) {
      console.error(`${LOG} Failed to initialize:`, error);
      throw error;
    }
  }

  /**
   * Core execution — called at 3:00 PM IST by node-cron or manually via triggerNow().
   * 1. Checks if today is a trading day
   * 2. Calls runDailyExit() which cancels SL/target, places MARKET exit, records PnL
   * 3. Updates stats for job monitor dashboard
   */
  async executeExit(opts = {}) {
    // Guard against overlapping runs (e.g. manual trigger while cron is already running)
    if (this.isRunning) {
      console.log(`${LOG} Already running, skipping`);
      return { skipped: true, reason: 'already_running' };
    }

    this.isRunning = true;
    try {
      // Skip on holidays/weekends — MarketHoursUtil checks NSE calendar
      const isTradingDay = await MarketHoursUtil.isTradingDay();
      if (!isTradingDay) {
        console.log(`${LOG} Not a trading day — skipping 3:00 PM exit`);
        return { skipped: true, reason: 'not_trading_day' };
      }

      // 3:00 PM IST — cancel SL/target protection orders, place MARKET exit orders, record PnL
      console.log(`${LOG} ▶ Executing 3:00 PM force-exit of all open daily pick positions...`);
      const result = await runDailyExit(opts);

      // Update stats for job monitor dashboard (/api/v1/job-monitor/status)
      this.stats.runsCompleted++;
      this.stats.positionsExited += result.exited || 0;
      this.stats.lastRunAt = new Date(); // Track when 3:00 PM exit last ran
      this.stats.lastResult = result;

      console.log(`${LOG} ✅ 3:00 PM exit completed: ${result.exited} positions force-exited`);
      return result;
    } catch (error) {
      console.error(`${LOG} ❌ 3:00 PM exit failed:`, error);
      this.stats.errors++;
      this.stats.lastRunAt = new Date();
      this.stats.lastResult = { error: error.message };
      throw error;
    } finally {
      this.isRunning = false; // Always release the lock
    }
  }

  /**
   * Manual trigger — called from job monitor API (POST /api/v1/job-monitor/trigger/dailyExit).
   * Runs the 3:00 PM exit immediately regardless of cron schedule.
   */
  async triggerNow(opts = {}) {
    if (!this.isInitialized) throw new Error('Daily exit job not initialized');

    console.log(`${LOG} Manual trigger requested — running 3:00 PM exit now`);
    const result = await this.executeExit(opts);

    return {
      success: true,
      result
    };
  }

  /**
   * Returns job stats for the job monitor dashboard.
   */
  getStats() {
    return { ...this.stats, isInitialized: this.isInitialized, isRunning: this.isRunning };
  }

  /**
   * Graceful shutdown — stops the node-cron task on SIGINT/deploy.
   */
  async shutdown() {
    if (this.cronTask) {
      this.cronTask.stop(); // node-cron stop is synchronous and instant (no DB cleanup needed)
      console.log(`${LOG} Shutdown complete (node-cron stopped)`);
    }
  }
}

const dailyExitJob = new DailyExitJob();

export default dailyExitJob;
export { DailyExitJob };
