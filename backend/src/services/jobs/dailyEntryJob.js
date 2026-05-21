/**
 * Daily Entry Job — Scanner Path
 *
 * Scheduled runs (Mon-Fri IST):
 * 1. 08:30  — scanner.py scan + AMO MARKET MIS orders (owned by tradingDaySequenceJob)
 * 2. 09:05  — gapProtectionCheck: cancel adverse-gap AMOs before 9:08 pre-open auction
 * 3. Every 2 min (9:00–10:59)  — checkFillsFallback: detect fills → place SL-M + LIMIT target
 * 4. Every 3 min (9:30–14:59) — monitorDailyPickOrders: SL/target hits, trailing, +1R BE
 * 5. 15:15  — runDailyExit: force-exit remaining MIS positions
 *
 * ORB validate-entry passes (9:30 / 9:46 / 10:01) are scheduled by tradingDaySequenceJob
 * when DISABLE_INDIVIDUAL_CRONS is not explicitly set to false.
 * Manual triggers available for each step via API.
 */

import Agenda from 'agenda';
import {
  startOrbCollection,
  validateAndPlaceEntries,
  checkFillsFallback,
  gapProtectionCheck,
  monitorDailyPickOrders,
} from '../dailyPicks/dailyPicksService.js';
import { runDailyExit } from '../dailyPicks/dailyPicksExitService.js';
import { reconcilePositionsOnStartup } from '../dailyPicks/dailyPicksRiskService.js';
import MarketHoursUtil from '../../utils/marketHours.js';

const LOG = '[DAILY-ENTRY-JOB]';

class DailyEntryJob {
  constructor() {
    this.agenda = null;
    this.isInitialized = false;
    this.runningJobs = new Set();
    this.stats = {
      orbCollections: 0,
      entriesValidated: 0,
      fillsChecked: 0,
      monitorRuns: 0,
      errors: 0,
      lastRunAt: null,
      lastResult: null
    };
  }

  async initialize() {
    if (this.isInitialized) {
      console.log(`${LOG} Already initialized`);
      return;
    }

    try {
      console.log(`${LOG} Initializing (v2 — ORB + trailing)...`);

      this.agenda = new Agenda({
        db: {
          address: process.env.MONGODB_URI,
          collection: 'daily_entry_jobs',
          options: { useUnifiedTopology: true }
        },
        processEvery: '1 minute',
        maxConcurrency: 1,
        defaultConcurrency: 1
      });

      this.defineJobs();
      this.setupEventHandlers();
      await this.agenda.start();
      await this.scheduleRecurringJobs();

      this.isInitialized = true;
      console.log(`${LOG} Initialization complete`);

      // Run startup recovery — reconcile open positions in case of mid-day restart
      try {
        const recoveryResult = await reconcilePositionsOnStartup();
        console.log(`${LOG} Startup recovery: ${JSON.stringify(recoveryResult)}`);
      } catch (recoveryErr) {
        console.error(`${LOG} Startup recovery failed (non-fatal):`, recoveryErr.message);
      }

      // Immediate monitor run on mid-session restart
      // Agenda waits for the next scheduled tick after startup, so a restart at e.g.
      // 14:40:19 skips the 14:40 cycle entirely and doesn't run until 14:45.
      // If we're inside the 09:30–14:59 monitoring window fire one run right now so
      // active positions aren't left unguarded for up to 5 extra minutes.
      try {
        const nowIST = new Date(Date.now() + (5.5 * 60 * 60 * 1000)); // UTC → IST
        const hhmm   = nowIST.getUTCHours() * 100 + nowIST.getUTCMinutes();
        const inMonitorWindow = hhmm >= 930 && hhmm < 1500;
        if (inMonitorWindow && await MarketHoursUtil.isTradingDay()) {
          console.log(`${LOG} Mid-session restart detected (${String(Math.floor(hhmm/100)).padStart(2,'0')}:${String(hhmm%100).padStart(2,'0')} IST) — firing immediate monitor run`);
          await monitorDailyPickOrders();
          console.log(`${LOG} Immediate startup monitor run complete`);
        }
      } catch (immErr) {
        console.error(`${LOG} Immediate startup monitor run failed (non-fatal):`, immErr.message);
      }
    } catch (error) {
      console.error(`${LOG} Failed to initialize:`, error);
      throw error;
    }
  }

  defineJobs() {
    // Job 1: ORB collection (DISABLED — scanner.py path bypasses ORB)
    // startOrbCollection() is no longer called; scanner picks have pre-computed
    // structural levels (entry/stop/target from scanner.py pivots). Orders are
    // placed as MARKET at 09:30 via validateAndPlaceEntries.
    //
    // this.agenda.define('daily-picks-orb-collect', async (job) => {
    //   ...startOrbCollection()...
    // });

    // Job 2: Multi-pass ORB validate+entry — shared handler, 3 distinct job names
    // Pass 1 (9:30) = 15-min ORB, Pass 2 (9:46) = 30-min, Pass 3 (10:01) = 45-min FINAL
    // Note: agenda.every() enforces "single" per job name, so we define 3 separate names.
    const orbValidateHandler = async (job, orbPass) => {
      const jobKey = `validate-entry-pass${orbPass}`;

      if (this.runningJobs.has(jobKey)) {
        console.log(`${LOG} ${jobKey} already running, skipping`);
        return;
      }

      this.runningJobs.add(jobKey);
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping pass ${orbPass}`);
          return { skipped: true, reason: 'not_trading_day' };
        }

        const t0 = Date.now();
        console.log(`${LOG} [VALIDATE-ENTRY] Pass ${orbPass}: Fetching ORB OHLC...`);
        const orbResult = await startOrbCollection({ orbPass });
        const orbMs = Date.now() - t0;
        console.log(`${LOG} [VALIDATE-ENTRY] ORB fetch done in ${orbMs}ms:`, JSON.stringify(orbResult));

        if (!orbResult.success) {
          console.error(`${LOG} [VALIDATE-ENTRY] ORB fetch failed — skipping pass ${orbPass}`);
          return { ...orbResult, orders: 0 };
        }

        console.log(`${LOG} [VALIDATE-ENTRY] Pass ${orbPass}: Validating and placing entries...`);
        const result = await validateAndPlaceEntries({ orbPass });
        this.stats.entriesValidated++;
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        const totalMs = Date.now() - t0;
        console.log(`${LOG} [VALIDATE-ENTRY] Pass ${orbPass} done in ${totalMs}ms: validated=${result.validated} skipped=${result.skipped} retrying=${result.retrying || 0} orders=${result.orders}`);
        return result;
      } catch (error) {
        console.error(`${LOG} Validate+entry pass ${orbPass} failed:`, error);
        this.stats.errors++;
        throw error;
      } finally {
        this.runningJobs.delete(jobKey);
      }
    };

    this.agenda.define('daily-picks-validate-entry', async (job) => orbValidateHandler(job, 1));
    this.agenda.define('daily-picks-validate-entry-pass2', async (job) => orbValidateHandler(job, 2));
    this.agenda.define('daily-picks-validate-entry-pass3', async (job) => orbValidateHandler(job, 3));

    // Job 2b: Gap protection — 9:14 AM (1 min before market open)
    // Cancels AMO entries that gapped adversely (stock opened >1% below scanner entry).
    // For MARKET AMO orders the fill happens at 9:08 AM pre-open; this may not be able
    // to cancel already-filled orders, but it logs the gap info and sets status correctly
    // for the fill-fallback to skip/exit bad fills.
    this.agenda.define('daily-picks-gap-protection', async (job) => {
      if (this.runningJobs.has('gap-protection')) return;
      this.runningJobs.add('gap-protection');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) return { skipped: true, reason: 'not_trading_day' };
        console.log(`${LOG} [GAP-PROTECT] Running gap protection check...`);
        const result = await gapProtectionCheck();
        console.log(`${LOG} [GAP-PROTECT] Done: cancelled=${result.cancelled ?? 0}`);
        return result;
      } catch (err) {
        console.error(`${LOG} Gap protection failed:`, err);
        this.stats.errors++;
      } finally {
        this.runningJobs.delete('gap-protection');
      }
    });

    // Job 3: Polling fallback for fill detection (*/2 9-10)
    this.agenda.define('daily-picks-fill-fallback', async (job) => {
      if (this.runningJobs.has('fill-fallback')) {
        console.log(`${LOG} Fill fallback already running, skipping`);
        return;
      }

      this.runningJobs.add('fill-fallback');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) return { skipped: true, reason: 'not_trading_day' };

        console.log(`${LOG} [FILL-FALLBACK] Calling checkFillsFallback()...`);
        const result = await checkFillsFallback();
        this.stats.fillsChecked++;
        this.stats.lastRunAt = new Date();
        console.log(`${LOG} [FILL-FALLBACK] Completed: filled=${result.filled ?? result.message}`);
        return result;
      } catch (error) {
        console.error(`${LOG} Fill fallback failed:`, error);
        this.stats.errors++;
        throw error;
      } finally {
        this.runningJobs.delete('fill-fallback');
      }
    });

    // Job 5: Monitor orders every 5 min (9:30-14:59)
    this.agenda.define('daily-picks-monitor', async (job) => {
      if (this.runningJobs.has('monitor')) {
        console.log(`${LOG} Monitor already running, skipping`);
        return;
      }

      this.runningJobs.add('monitor');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping monitor`);
          return { skipped: true, reason: 'not_trading_day' };
        }

        const t0 = Date.now();
        console.log(`${LOG} [MONITOR] Calling monitorDailyPickOrders()...`);
        const result = await monitorDailyPickOrders();
        this.stats.monitorRuns++;
        this.stats.lastRunAt = new Date();
        console.log(`${LOG} [MONITOR] Completed in ${Date.now() - t0}ms: active=${result.active ?? result.message}`);
        return result;
      } catch (error) {
        console.error(`${LOG} Monitor failed:`, error);
        this.stats.errors++;
        throw error;
      } finally {
        this.runningJobs.delete('monitor');
      }
    });

    // Job 6: 14:45 HARD FLAT — exit all MIS positions 15 min before broker
    // force-close at 15:20. Gives us clean fills on liquid names and avoids
    // the end-of-day slippage spike. Reuses the same runDailyExit() path; the
    // 15:00 job below becomes a safety net for anything this 14:45 job missed.
    this.agenda.define('daily-picks-hard-flat', async () => {
      if (this.runningJobs.has('hard-flat')) {
        console.log(`${LOG} Hard flat already running, skipping`);
        return;
      }
      this.runningJobs.add('hard-flat');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping 14:45 hard flat`);
          return { skipped: true, reason: 'not_trading_day' };
        }
        console.log(`${LOG} [HARD-FLAT] ▶ Executing 14:45 hard-flat exit (15 min before broker auto-close)`);
        const result = await runDailyExit({ reason: 'hard_flat_14_45' });
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        console.log(`${LOG} [HARD-FLAT] ✅ Completed: ${result.exited} exited, ${result.cancelledUnfilled || 0} unfilled cancelled`);
        return result;
      } catch (error) {
        console.error(`${LOG} Hard flat failed:`, error);
        this.stats.errors++;
        throw error;
      } finally {
        this.runningJobs.delete('hard-flat');
      }
    });

    // Job 7: Force-exit all open positions at 3:00 PM (safety net)
    this.agenda.define('daily-picks-exit', async (job) => {
      if (this.runningJobs.has('exit')) {
        console.log(`${LOG} Exit already running, skipping`);
        return;
      }

      this.runningJobs.add('exit');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping 3:00 PM exit`);
          return { skipped: true, reason: 'not_trading_day' };
        }

        console.log(`${LOG} [EXIT] ▶ Executing 3:00 PM force-exit...`);
        const result = await runDailyExit();
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        console.log(`${LOG} [EXIT] ✅ Completed: ${result.exited} positions exited, ${result.cancelledUnfilled || 0} unfilled cancelled`);

        // Write daily performance summary (non-fatal on failure)
        try {
          const { recordDailyMetrics } = await import('../dailyPicks/metricsService.js');
          const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
          const dateStr = nowIst.toISOString().slice(0, 10);
          const row = await recordDailyMetrics(dateStr);
          if (row) console.log(`${LOG} [EXIT] DailyPerformance written for ${dateStr}`);
        } catch (metricsErr) {
          console.error(`${LOG} [EXIT] DailyPerformance write failed (non-fatal):`, metricsErr.message);
        }
        return result;
      } catch (error) {
        console.error(`${LOG} Exit failed:`, error);
        this.stats.errors++;
        throw error;
      } finally {
        this.runningJobs.delete('exit');
      }
    });

    // Manual triggers
    this.agenda.define('manual-daily-picks-orb-collect', async (job) => {
      const opts = job.attrs.data || {};
      return startOrbCollection(opts);
    });

    this.agenda.define('manual-daily-picks-validate-entry', async (job) => {
      const opts = job.attrs.data || {};
      return validateAndPlaceEntries(opts);
    });

    this.agenda.define('manual-daily-picks-monitor', async (job) => {
      const opts = job.attrs.data || {};
      return monitorDailyPickOrders(opts);
    });

    this.agenda.define('manual-daily-picks-exit', async (job) => {
      const opts = job.attrs.data || {};
      return runDailyExit(opts);
    });
  }

  setupEventHandlers() {
    this.agenda.on('ready', () => console.log(`${LOG} Agenda ready`));
    this.agenda.on('start', (job) => console.log(`${LOG} Job starting: ${job.attrs.name}`));
    this.agenda.on('complete', (job) => console.log(`${LOG} Job completed: ${job.attrs.name}`));
    this.agenda.on('fail', (err, job) => console.error(`${LOG} Job failed: ${job.attrs.name}`, err));
  }

  async scheduleRecurringJobs() {
    try {
      // Cancel existing to avoid duplicates
      await this.agenda.cancel({
        name: {
          $in: [
            'daily-picks-orb-collect',
            'daily-picks-validate-entry',
            'daily-picks-validate-entry-pass2',
            'daily-picks-validate-entry-pass3',
            'daily-picks-cancel-expired', // legacy — clean up
            'daily-picks-gap-protection',
            'daily-picks-fill-fallback',
            'daily-picks-monitor',
            'daily-picks-tighten',   // removed — kept in cancel list to clean up any lingering DB jobs
            'daily-picks-hard-flat',
            'daily-picks-exit',
            // Legacy v1 job names — clean up on first deploy
            'daily-picks-entry',
            'daily-picks-fill-check'
          ]
        }
      });

      // ORB validate entry passes (9:30 / 9:46 / 10:01) — by default owned by
      // tradingDaySequenceJob. Set DISABLE_INDIVIDUAL_CRONS=false to restore
      // the per-pass cron schedule here.
      const sequenceOwnsOrb = String(process.env.DISABLE_INDIVIDUAL_CRONS ?? 'true').toLowerCase() !== 'false';
      if (sequenceOwnsOrb) {
        console.log(`${LOG} Skipping ORB validate-entry cron schedule — owned by tradingDaySequenceJob`);
      } else {
        // Multi-pass ORB validation: 3 passes with widening time windows
        // Pass 1: 9:30 AM IST — 15-min ORB
        await this.agenda.every('30 9 * * 1-5', 'daily-picks-validate-entry', {}, {
          timezone: 'Asia/Kolkata'
        });

        // Pass 2: 9:46 AM IST — 30-min ORB (1 min buffer after 9:45 candle close)
        await this.agenda.every('46 9 * * 1-5', 'daily-picks-validate-entry-pass2', {}, {
          timezone: 'Asia/Kolkata'
        });

        // Pass 3: 10:01 AM IST — 45-min ORB (FINAL, 1 min buffer after 10:00 candle close)
        await this.agenda.every('1 10 * * 1-5', 'daily-picks-validate-entry-pass3', {}, {
          timezone: 'Asia/Kolkata'
        });
      }

      // 9:05 AM IST — Gap protection.
      // Pre-open session runs 9:00–9:08 AM. Indicative prices are live from 9:00 AM
      // and cancel requests are accepted up to ~9:07 AM before the auction settles.
      // 9:05 AM gives us a price read + cancellation window before the 9:08 fill.
      await this.agenda.every('5 9 * * 1-5', 'daily-picks-gap-protection', {}, {
        timezone: 'Asia/Kolkata'
      });

      // Every 2 min, 9:00–10:59 AM IST — Fill fallback.
      // Detects AMO fills (MARKET orders fill at 9:08 AM pre-open auction).
      // Fills detected before 9:15 AM are deferred (entered_awaiting_915) and
      // SL-M + target are placed on the first poll at or after 9:15 AM.
      await this.agenda.every('*/2 9-10 * * 1-5', 'daily-picks-fill-fallback', {}, {
        timezone: 'Asia/Kolkata'
      });

      // Every 5 min, 9:30 AM – 2:59 PM IST — Monitor SL/target hits, trailing stops,
      // and candle-based structure analysis (5-min + 15-min TF decision matrix).
      // 5-min aligns with candle closes so analysis always sees complete candles.
      // Starts at 9:30 so it can cancel the other leg immediately if SL or target
      // fires in the 9:16–10:00 window.
      await this.agenda.every('*/5 9-14 * * 1-5', 'daily-picks-monitor', {}, {
        timezone: 'Asia/Kolkata'
      });

      // 3:15 PM IST — Force-exit all remaining MIS positions.
      // SL-M + target LIMIT orders handle most exits during the day.
      // This catches anything that drifted sideways without hitting either level.
      // 3:15 = 5 min before Zerodha auto-square at 3:20 — clean fills, avoids
      // the bulk auto-square slippage spike.
      await this.agenda.every('15 15 * * 1-5', 'daily-picks-exit', {}, {
        timezone: 'Asia/Kolkata'
      });

      console.log(`${LOG} ═══════════════════════════════════════`);
      console.log(`${LOG} SCHEDULED JOBS (Mon-Fri IST) — SCANNER/AMO PATH:`);
      console.log(`${LOG}   08:30 — scanner.py → AMO MARKET MIS orders placed`);
      console.log(`${LOG}   09:05 — gap protection (cancel adverse-gap AMOs before 9:08 auction)`);
      console.log(`${LOG}   09:00–10:59 — fill fallback every 2 min → SL-M + target placed on fills`);
      console.log(`${LOG}   09:30–14:59 — monitor every 5 min → SL/target detection, +1R BE, candle structure (5-min+15-min)`);
      console.log(`${LOG}   15:15 — force-exit (5 min before Zerodha auto-square)`);
      console.log(`${LOG} ═══════════════════════════════════════`);
    } catch (error) {
      console.error(`${LOG} Failed to schedule:`, error);
      throw error;
    }
  }

  async triggerNow(opts = {}) {
    if (!this.isInitialized) throw new Error('Daily entry job not initialized');
    console.log(`${LOG} Manual trigger — running validate+entry now`);
    const job = await this.agenda.now('manual-daily-picks-validate-entry', opts);
    return { success: true, jobId: job.attrs._id };
  }

  async triggerOrbCollection(opts = {}) {
    if (!this.isInitialized) throw new Error('Daily entry job not initialized');
    console.log(`${LOG} Manual ORB collection trigger`);
    const job = await this.agenda.now('manual-daily-picks-orb-collect', opts);
    return { success: true, jobId: job.attrs._id };
  }

  async triggerMonitor(opts = {}) {
    if (!this.isInitialized) throw new Error('Daily entry job not initialized');
    console.log(`${LOG} Manual monitor trigger`);
    const job = await this.agenda.now('manual-daily-picks-monitor', opts);
    return { success: true, jobId: job.attrs._id };
  }

  async triggerExit(opts = {}) {
    if (!this.isInitialized) throw new Error('Daily entry job not initialized');
    console.log(`${LOG} Manual exit trigger`);
    const job = await this.agenda.now('manual-daily-picks-exit', opts);
    return { success: true, jobId: job.attrs._id };
  }

  getStats() {
    return { ...this.stats, isInitialized: this.isInitialized, runningJobs: [...this.runningJobs] };
  }

  async shutdown() {
    if (this.agenda) {
      await this.agenda.stop();
      console.log(`${LOG} Shutdown complete`);
    }
  }
}

const dailyEntryJob = new DailyEntryJob();

export default dailyEntryJob;
export { DailyEntryJob };
