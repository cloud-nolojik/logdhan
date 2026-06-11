/**
 * ORB Job — Opening Range Breakout Scheduler
 *
 * Completely independent of the daily-picks pipeline.
 * Runs its own Agenda instance (collection: orb_jobs) so it never
 * interferes with daily-picks-* job names or lock state.
 *
 * Scheduled runs (Mon-Fri IST):
 * 1. 09:08 — orb-pre-open      : fetch NSE pre-open IEP, build universe, persist to DB
 * 2. 09:30 — orb-record-range  : read first 15-min candle OHLC, set OR high/low per candidate
 * 3. every-1min 9-10 — orb-check-breakout : check LTP vs OR high; enter if breakout (active 9:30–10:30)
 * 4. every-5min 9-14 — orb-monitor    : track SL-M / target hits, time-exit at 10:30 if still open
 * 5. 15:15 — orb-force-exit    : hard-flat any remaining ORB MIS positions
 *
 * Manual triggers via triggerXxx() methods (for API or dev console).
 */

import Agenda from 'agenda';
import {
  fetchPreOpenUniverse,
  takeRvolSnapshot,
  placeOrbEntryOrders,
  recordOpeningRanges,
  checkBreakouts,
  monitorOrbPositions,
  forceExitOrb,
  prefetchVolumeBaselines,
} from '../orb/orbService.js';
import { archiveToday, backfillRange } from '../backtest/candleArchive.service.js';
import MarketHoursUtil from '../../utils/marketHours.js';

const LOG = '[ORB-JOB]';

class OrbJob {
  constructor() {
    this.agenda        = null;
    this.isInitialized = false;
    this.runningJobs   = new Set();
    this.stats = {
      preOpenRuns:   0,
      rangeRecords:  0,
      breakoutChecks: 0,
      monitorRuns:   0,
      errors:        0,
      lastRunAt:     null,
      lastResult:    null,
    };
  }

  // ─── Initialization ──────────────────────────────────────────────────────────

  async initialize() {
    if (this.isInitialized) {
      console.log(`${LOG} Already initialized`);
      return;
    }

    try {
      console.log(`${LOG} Initializing ORB job scheduler...`);

      this.agenda = new Agenda({
        db: {
          address: process.env.MONGODB_URI,
          collection: 'orb_jobs',           // separate from daily_entry_jobs
          options: { useUnifiedTopology: true },
        },
        processEvery:    '30 seconds',       // breakout check runs every minute
        maxConcurrency:  1,
        defaultConcurrency: 1,
      });

      this.defineJobs();
      this.setupEventHandlers();
      await this.agenda.start();
      await this.scheduleRecurringJobs();

      this.isInitialized = true;
      console.log(`${LOG} Initialization complete`);
    } catch (error) {
      console.error(`${LOG} Failed to initialize:`, error);
      throw error;
    }
  }

  // ─── Job Definitions ─────────────────────────────────────────────────────────

  defineJobs() {

    // ── 1. Pre-open universe (9:08 AM) ──────────────────────────────────────────
    this.agenda.define('orb-pre-open', async (job) => {
      if (this.runningJobs.has('pre-open')) {
        console.log(`${LOG} pre-open already running, skipping`);
        return;
      }
      this.runningJobs.add('pre-open');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping pre-open`);
          return { skipped: true, reason: 'not_trading_day' };
        }

        const t0 = Date.now();
        console.log(`${LOG} [PRE-OPEN] Fetching NSE pre-open universe...`);
        const result = await fetchPreOpenUniverse();
        this.stats.preOpenRuns++;
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        console.log(`${LOG} [PRE-OPEN] Done in ${Date.now() - t0}ms — candidates=${result.count ?? 0}`);
        return result;
      } catch (err) {
        console.error(`${LOG} [PRE-OPEN] Failed:`, err);
        this.stats.errors++;
        throw err;
      } finally {
        this.runningJobs.delete('pre-open');
      }
    });

    // ── 1.5 In-play RVOL snapshot (9:21 AM) ─────────────────────────────────────
    // Ranks the WATCHING universe by first-minutes RVOL (one batched /quote call)
    // and marks the top names inPlay. Phase 2 then only sets ranges for those.
    // FAIL-OPEN: if this job fails or never runs, Phase 2 takes the full universe.
    this.agenda.define('orb-rvol-snapshot', async (job) => {
      if (this.runningJobs.has('rvol-snapshot')) {
        console.log(`${LOG} rvol-snapshot already running, skipping`);
        return;
      }
      this.runningJobs.add('rvol-snapshot');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping rvol-snapshot`);
          return { skipped: true, reason: 'not_trading_day' };
        }

        const t0 = Date.now();
        console.log(`${LOG} [RVOL-SNAPSHOT] Ranking universe by first-minutes RVOL...`);
        const result = await takeRvolSnapshot();
        this.stats.lastRunAt  = new Date();
        this.stats.lastResult = result;
        console.log(`${LOG} [RVOL-SNAPSHOT] Done in ${Date.now() - t0}ms — inPlay=${result.inPlay ?? 'n/a'}/${result.total ?? 'n/a'}${result.fallback ? ' (FALLBACK)' : ''}${result.success ? '' : ` FAIL-OPEN (${result.reason})`}`);
        return result;
      } catch (err) {
        // Fail-open: log + count, do NOT rethrow side effects into the pipeline —
        // Phase 2 simply sees no inPlay flags and runs on the full universe.
        console.error(`${LOG} [RVOL-SNAPSHOT] Failed (fail-open, full universe stands):`, err);
        this.stats.errors++;
        throw err;
      } finally {
        this.runningJobs.delete('rvol-snapshot');
      }
    });

    // ── 1.6 Paper-spec entry arming (9:24 AM) ───────────────────────────────────
    // Reads the 09:15–09:20 5-min candle for the in-play names and places resting
    // SL-M entry orders at the OR edge (Zarattini spec).
    this.agenda.define('orb-place-entries', async (job) => {
      if (this.runningJobs.has('place-entries')) {
        console.log(`${LOG} place-entries already running, skipping`);
        return;
      }
      this.runningJobs.add('place-entries');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping place-entries`);
          return { skipped: true, reason: 'not_trading_day' };
        }

        const t0 = Date.now();
        console.log(`${LOG} [PLACE-ENTRIES] Arming paper-spec entries at 5-min OR edges...`);
        const result = await placeOrbEntryOrders();
        this.stats.lastRunAt  = new Date();
        this.stats.lastResult = result;
        console.log(`${LOG} [PLACE-ENTRIES] Done in ${Date.now() - t0}ms — armed=${result.armed ?? 0} immediate=${result.immediate ?? 0} skipped=${result.skipped ?? 0}`);
        return result;
      } catch (err) {
        console.error(`${LOG} [PLACE-ENTRIES] Failed:`, err);
        this.stats.errors++;
        throw err;
      } finally {
        this.runningJobs.delete('place-entries');
      }
    });

    // ── 2. Record opening ranges (9:30 AM) ──────────────────────────────────────
    this.agenda.define('orb-record-range', async (job) => {
      if (this.runningJobs.has('record-range')) {
        console.log(`${LOG} record-range already running, skipping`);
        return;
      }
      this.runningJobs.add('record-range');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping record-range`);
          return { skipped: true, reason: 'not_trading_day' };
        }

        const t0 = Date.now();
        console.log(`${LOG} [RECORD-RANGE] Reading first 15-min candle OHLC...`);
        const result = await recordOpeningRanges();
        this.stats.rangeRecords++;
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        console.log(`${LOG} [RECORD-RANGE] Done in ${Date.now() - t0}ms — set=${result.set ?? 0}, skipped=${result.skipped ?? 0}`);
        return result;
      } catch (err) {
        console.error(`${LOG} [RECORD-RANGE] Failed:`, err);
        this.stats.errors++;
        throw err;
      } finally {
        this.runningJobs.delete('record-range');
      }
    });

    // ── 3. Check breakouts (every 1 min, 9:00–10:59 IST) ────────────────────────
    //    Internal guard in orbService.checkBreakouts() rejects calls before 9:30
    //    or after 10:30 to avoid unnecessary Kite LTP hits outside the entry window.
    this.agenda.define('orb-check-breakout', async (job) => {
      if (this.runningJobs.has('check-breakout')) {
        console.log(`${LOG} check-breakout already running, skipping`);
        return;
      }
      this.runningJobs.add('check-breakout');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) return { skipped: true, reason: 'not_trading_day' };

        const t0 = Date.now();
        const result = await checkBreakouts();
        this.stats.breakoutChecks++;
        this.stats.lastRunAt = new Date();
        if (result.entered > 0) {
          console.log(`${LOG} [BREAKOUT] ${result.entered} new entry(ies) in ${Date.now() - t0}ms`);
        }
        return result;
      } catch (err) {
        console.error(`${LOG} [BREAKOUT] Failed:`, err);
        this.stats.errors++;
        throw err;
      } finally {
        this.runningJobs.delete('check-breakout');
      }
    });

    // ── 4. Monitor open positions (every 5 min, 9:00–14:59 IST) ─────────────────
    this.agenda.define('orb-monitor', async (job) => {
      if (this.runningJobs.has('monitor')) {
        console.log(`${LOG} monitor already running, skipping`);
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
        console.log(`${LOG} [MONITOR] Checking ORB positions...`);
        const result = await monitorOrbPositions();
        this.stats.monitorRuns++;
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        console.log(`${LOG} [MONITOR] Done in ${Date.now() - t0}ms — active=${result.active ?? 0}, exited=${result.exited ?? 0}`);
        return result;
      } catch (err) {
        console.error(`${LOG} [MONITOR] Failed:`, err);
        this.stats.errors++;
        throw err;
      } finally {
        this.runningJobs.delete('monitor');
      }
    });

    // ── 5. Force-exit (3:15 PM) — safety net for anything still open ────────────
    this.agenda.define('orb-force-exit', async (job) => {
      if (this.runningJobs.has('force-exit')) {
        console.log(`${LOG} force-exit already running, skipping`);
        return;
      }
      this.runningJobs.add('force-exit');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping force-exit`);
          return { skipped: true, reason: 'not_trading_day' };
        }

        console.log(`${LOG} [FORCE-EXIT] ▶ Hard-flat all remaining ORB MIS positions`);
        const result = await forceExitOrb();
        this.stats.lastRunAt  = new Date();
        this.stats.lastResult = result;
        console.log(`${LOG} [FORCE-EXIT] ✅ Exited=${result.exited ?? 0}`);
        return result;
      } catch (err) {
        console.error(`${LOG} [FORCE-EXIT] Failed:`, err);
        this.stats.errors++;
        throw err;
      } finally {
        this.runningJobs.delete('force-exit');
      }
    });

    // ── 6. Backtest candle archive (3:45 PM) — store the day's raw 1-min candles ──
    // Persists OHLCV for the F&O universe + Nifty so the trading system can be
    // backtested against real data. Runs in-process so it reuses the already-authed
    // Kite session. No-op outside trading days.
    this.agenda.define('orb-archive-candles', async (job) => {
      if (this.runningJobs.has('archive')) {
        console.log(`${LOG} archive already running, skipping`);
        return;
      }
      this.runningJobs.add('archive');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping candle archive`);
          return { skipped: true, reason: 'not_trading_day' };
        }
        console.log(`${LOG} [ARCHIVE] ▶ Archiving today's 1-min candles for backtest`);
        const result = await archiveToday({ interval: 'minute' });
        console.log(`${LOG} [ARCHIVE] ✅ ${result.date}: saved=${result.saved}/${result.total}`);
        return result;
      } catch (err) {
        console.error(`${LOG} [ARCHIVE] Failed:`, err);
        this.stats.errors++;
        throw err;
      } finally {
        this.runningJobs.delete('archive');
      }
    });

    // ── 7. Baseline prefetch (8:30 AM) ──────────────────────────────────────────
    // Computes the 20-day RVOL volume profiles for the FULL F&O universe and
    // caches them in orb_baselines. Moves the ~215-call historical burst from
    // 09:08 (rate-ceiling hotspot, load-bearing for the paper pipeline) to the
    // idle pre-market window. The 09:08 pre-open reads the cache; live fetch
    // remains as per-symbol fallback.
    this.agenda.define('orb-baseline-prefetch', async (job) => {
      if (this.runningJobs.has('baseline-prefetch')) {
        console.log(`${LOG} baseline-prefetch already running, skipping`);
        return;
      }
      this.runningJobs.add('baseline-prefetch');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping baseline-prefetch`);
          return { skipped: true, reason: 'not_trading_day' };
        }
        const t0 = Date.now();
        console.log(`${LOG} [BASELINE-PREFETCH] ▶ Computing RVOL baselines for tomorrow...`);
        const result = await prefetchVolumeBaselines();
        console.log(`${LOG} [BASELINE-PREFETCH] ✅ Done in ${Date.now() - t0}ms — upserted=${result.upserted ?? 0}/${result.total ?? 0}`);
        return result;
      } catch (err) {
        console.error(`${LOG} [BASELINE-PREFETCH] Failed (morning will live-fetch):`, err);
        this.stats.errors++;
        throw err;
      } finally {
        this.runningJobs.delete('baseline-prefetch');
      }
    });

    // ── Manual triggers (one-shot, no concurrency guard needed) ─────────────────
    this.agenda.define('manual-orb-pre-open',    async (job) => fetchPreOpenUniverse(job.attrs.data || {}));
    this.agenda.define('manual-orb-rvol-snapshot', async (job) => takeRvolSnapshot(job.attrs.data || {}));
    this.agenda.define('manual-orb-place-entries', async (job) => placeOrbEntryOrders(job.attrs.data || {}));
    this.agenda.define('manual-orb-baseline-prefetch', async (job) => prefetchVolumeBaselines(job.attrs.data || {}));
    this.agenda.define('manual-orb-record-range', async (job) => recordOpeningRanges(job.attrs.data || {}));
    this.agenda.define('manual-orb-check-breakout', async (job) => checkBreakouts(job.attrs.data || {}));
    this.agenda.define('manual-orb-monitor',     async (job) => monitorOrbPositions(job.attrs.data || {}));
    this.agenda.define('manual-orb-force-exit',  async (job) => forceExitOrb(job.attrs.data || {}));
    // Backfill any historical range in-process (reuses live Kite auth):
    //   agenda.now('manual-archive-backfill', { from: '2026-03-01', to: '2026-05-31' })
    this.agenda.define('manual-archive-candles', async (job) => archiveToday(job.attrs.data || {}));
    this.agenda.define('manual-archive-backfill', async (job) => {
      const { from, to, interval = 'minute' } = job.attrs.data || {};
      if (!from || !to) { console.error(`${LOG} [BACKFILL] needs { from, to }`); return; }
      return backfillRange(from, to, { interval });
    });
  }

  // ─── Event Handlers ───────────────────────────────────────────────────────────

  setupEventHandlers() {
    this.agenda.on('ready',    ()          => console.log(`${LOG} Agenda ready`));
    this.agenda.on('start',    (job)       => console.log(`${LOG} Job starting: ${job.attrs.name}`));
    this.agenda.on('complete', (job)       => console.log(`${LOG} Job completed: ${job.attrs.name}`));
    this.agenda.on('fail',     (err, job)  => console.error(`${LOG} Job failed: ${job.attrs.name}`, err));
  }

  // ─── Schedule Crons ──────────────────────────────────────────────────────────

  async scheduleRecurringJobs() {
    try {
      // Cancel existing to avoid duplicates on restart
      await this.agenda.cancel({
        name: {
          $in: [
            'orb-pre-open',
            'orb-rvol-snapshot',
            'orb-place-entries',
            'orb-record-range',
            'orb-check-breakout',
            'orb-monitor',
            'orb-force-exit',
          ],
        },
      });

      // 8:35 AM IST — bootstrap the day (moved from 09:08, 2026-06-11).
      // The paper pipeline depends on NOTHING from the pre-open auction: rvol5
      // needs volumeProfile (cached at 08:30), arming needs the first 5-min
      // candle (09:24), direction comes from that candle. So the day's doc +
      // universe + baselines-from-cache + capital preflight all run at 08:35,
      // right after the prefetch — 40 idle minutes before the open instead of
      // 13 pressured ones. IEP/gap fields read ≈0 pre-auction (observability
      // only; revisit if a gap/catalyst layer is built later).
      // Agenda maxConcurrency=1 serialises this behind the 08:30 prefetch.
      await this.agenda.every('35 8 * * 1-5', 'orb-pre-open', {}, {
        timezone: 'Asia/Kolkata',
      });

      // 9:21 AM IST — in-play RVOL snapshot. Market opened 09:15, so day-cumulative
      // volume at 09:21 ≈ the first 6 minutes — the "opening relative volume" that
      // Zarattini/Barbon/Aziz showed carries the entire ORB edge. Runs BEFORE the
      // 09:30 record-range so Phase 2 only tracks the in-play names.
      await this.agenda.every('21 9 * * 1-5', 'orb-rvol-snapshot', {}, {
        timezone: 'Asia/Kolkata',
      });

      // 9:24 AM IST — arm resting SL-M entries at the 5-min OR edge
      // (09:15–09:20 candle closed at 09:20; snapshot ran 09:21; 3-min buffer).
      await this.agenda.every('24 9 * * 1-5', 'orb-place-entries', {}, {
        timezone: 'Asia/Kolkata',
      });

      // RETIRED 2026-06-11 (paper cutover): orb-record-range (09:30, 15-min OR) is
      // no longer scheduled — the 5-min OR is set by orb-place-entries at 09:24.
      // The name stays in the cancel list above so stale Mongo entries are purged.

      // Breakout check at every 15-min boundary + 1 sec (10:01, 10:16, ... 14:01).
      // N-bar 15-min confirmation (CONFIRM_BARS in orbService, =2): at each check
      // we look at the last CONFIRM_BARS completed 15-min candles; all must close
      // past OR in the same direction → enter.
      //
      // Model: OR = 09:15-09:30; the 09:30-09:45 candle breaks out; if the
      // 09:45-10:00 candle also closes past OR it confirms → order at ~10:01.
      // A name that falls back inside OR on the 2nd candle is dropped.
      //
      // Schedule: minutes 1, 16, 31, 46 of hours 9-11 (Mon-Fri IST). With CONFIRM_BARS=1
      // first entry is 09:46 (the 09:30-09:45 candle has closed); last entry 11:46 —
      // entries stay in the morning high-edge window (ORB edge is front-loaded;
      // 11:30-14:00 is midday chop). The 09:01/09:16/09:31 fires are no-ops (the
      // window guard in checkBreakouts rejects anything before 09:46). Per-scan cap
      // (MAX_ENTRIES_PER_SCAN) spreads the daily budget across scans. The window guard
      // (BREAKOUT_START/END) is the source of truth; this cron just bounds the firing.
      // RETIRED 2026-06-11 (paper cutover): orb-check-breakout is no longer
      // scheduled — resting SL-M entries at the OR edge replace scanning entirely
      // (the exchange does the breakout detection). Name stays in the cancel list.

      // Every 5 min, 9:00 AM – 3:59 PM IST — position monitor.
      // Extended 9-14 → 9-15 (2026-06-11 audit): the 15:00 unfilled-entry cutoff
      // lives in the monitor, so it MUST run at 15:00/15:05/15:10 — with the old
      // 9-14 bound the last run was 14:55 and the cutoff could never fire, and a
      // fill between 14:55 and 15:15 would sit unprotected until force-exit.
      // Runs after 15:15 are harmless no-ops (nothing ENTERED/ARMED remains).
      await this.agenda.every('*/5 9-15 * * 1-5', 'orb-monitor', {}, {
        timezone: 'Asia/Kolkata',
      });

      // 3:15 PM IST — force-exit (5 min before Zerodha auto-square at 3:20)
      await this.agenda.every('15 15 * * 1-5', 'orb-force-exit', {}, {
        timezone: 'Asia/Kolkata',
      });

      // 3:45 PM IST — archive the day's raw 1-min candles for backtesting
      // (after the session has fully settled and historical data has propagated).
      await this.agenda.every('45 15 * * 1-5', 'orb-archive-candles', {}, {
        timezone: 'Asia/Kolkata',
      });

      // 8:30 AM IST — RVOL-baseline prefetch into orb_baselines (pre-market idle
      // window, 38 min before the 09:08 pre-open). Moved from 16:15 (2026-06-11):
      // a morning run has no dependency on the server having been up the previous
      // evening, and "through yesterday" is unambiguous at this hour. The window
      // logic in prefetchVolumeBaselines is time-aware either way.
      await this.agenda.every('30 8 * * 1-5', 'orb-baseline-prefetch', {}, {
        timezone: 'Asia/Kolkata',
      });

      console.log(`${LOG} ═══════════════════════════════════════`);
      console.log(`${LOG} SCHEDULED JOBS (Mon-Fri IST) — PAPER-SPEC ORB (Zarattini, cutover 2026-06-11):`);
      console.log(`${LOG}   09:21       — in-play RVOL snapshot: rank universe by first-6-min RVOL,`);
      console.log(`${LOG}                   top-20 (rvol5 ≥ 1.0×) marked inPlay (fail-open on snapshot failure)`);
      console.log(`${LOG}   09:24       — resting SL-M entries at the 5-min OR edge for top-8 in-play`);
      console.log(`${LOG}                   direction = first-candle close vs open (doji = skip, NO index gate)`);
      console.log(`${LOG}                   sizing = min(1% cash risk ÷ stopDist, slotCap ÷ price)`);
      console.log(`${LOG}   09:00–14:59 — monitor every 5 min: ARMED fill → protective SL @ fill ∓ 0.10×ATR(14d);`);
      console.log(`${LOG}                   SL fill check; unfilled entries cancelled at 15:00`);
      console.log(`${LOG}   15:15       — force-exit: flat all positions + cancel stray resting entries`);
      console.log(`${LOG}   08:30       — RVOL-baseline prefetch → orb_baselines (the day's only heavy API work)`);
      console.log(`${LOG}   08:35       — day bootstrap: universe doc + baselines from cache + capital preflight`);
      console.log(`${LOG}   15:45       — archive 1-min candles for backtesting`);
      console.log(`${LOG} EXITS: stop hit or 15:15 ONLY — no target, no BE, no trail, no candle/RSI/VWAP exits`);
      console.log(`${LOG} LEGACY (15-min OR, 2-bar scan, regime gate, candle engine) RETIRED 2026-06-11 — see git history`);
      console.log(`${LOG} ═══════════════════════════════════════`);
    } catch (error) {
      console.error(`${LOG} Failed to schedule:`, error);
      throw error;
    }
  }

  // ─── Manual Trigger API ───────────────────────────────────────────────────────

  async triggerPreOpen(opts = {}) {
    if (!this.isInitialized) throw new Error('ORB job not initialized');
    console.log(`${LOG} Manual pre-open trigger`);
    const job = await this.agenda.now('manual-orb-pre-open', opts);
    return { success: true, jobId: job.attrs._id };
  }

  async triggerBaselinePrefetch(opts = {}) {
    if (!this.isInitialized) throw new Error('ORB job not initialized');
    console.log(`${LOG} Manual baseline-prefetch trigger`);
    const job = await this.agenda.now('manual-orb-baseline-prefetch', opts);
    return { success: true, jobId: job.attrs._id };
  }

  async triggerRvolSnapshot(opts = {}) {
    if (!this.isInitialized) throw new Error('ORB job not initialized');
    console.log(`${LOG} Manual rvol-snapshot trigger`);
    const job = await this.agenda.now('manual-orb-rvol-snapshot', opts);
    return { success: true, jobId: job.attrs._id };
  }

  async triggerRecordRange(opts = {}) {
    if (!this.isInitialized) throw new Error('ORB job not initialized');
    console.log(`${LOG} Manual record-range trigger`);
    const job = await this.agenda.now('manual-orb-record-range', opts);
    return { success: true, jobId: job.attrs._id };
  }

  async triggerCheckBreakout(opts = {}) {
    if (!this.isInitialized) throw new Error('ORB job not initialized');
    console.log(`${LOG} Manual check-breakout trigger`);
    const job = await this.agenda.now('manual-orb-check-breakout', opts);
    return { success: true, jobId: job.attrs._id };
  }

  async triggerMonitor(opts = {}) {
    if (!this.isInitialized) throw new Error('ORB job not initialized');
    console.log(`${LOG} Manual monitor trigger`);
    const job = await this.agenda.now('manual-orb-monitor', opts);
    return { success: true, jobId: job.attrs._id };
  }

  async triggerForceExit(opts = {}) {
    if (!this.isInitialized) throw new Error('ORB job not initialized');
    console.log(`${LOG} Manual force-exit trigger`);
    const job = await this.agenda.now('manual-orb-force-exit', opts);
    return { success: true, jobId: job.attrs._id };
  }

  // ─── Introspection ───────────────────────────────────────────────────────────

  getStats() {
    return {
      ...this.stats,
      isInitialized: this.isInitialized,
      runningJobs:   [...this.runningJobs],
    };
  }

  // ─── Shutdown ────────────────────────────────────────────────────────────────

  async shutdown() {
    if (this.agenda) {
      await this.agenda.stop();
      console.log(`${LOG} Shutdown complete`);
    }
  }
}

const orbJob = new OrbJob();

export default orbJob;
export { OrbJob };
