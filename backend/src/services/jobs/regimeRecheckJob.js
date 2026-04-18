/**
 * Regime Recheck Job — 11:00 IST Mon–Fri.
 *
 * Why this exists: the 08:30 regime reads Nifty's previous close + overnight
 * signals. By 11:00, an actual 90 minutes of live trading has happened and
 * the tape may have flipped:
 *   - 08:30 scored STRONG_BULL → by 10:00 Nifty has reversed −1% → open longs
 *     are now counter-regime trades.
 *   - 08:30 scored WEAK_BEAR → by 10:00 Nifty has rallied +1.2% → open shorts
 *     are getting squeezed.
 *
 * Behavior at 11:00:
 *   1. Fetch current Nifty quote via Kite.
 *   2. Compute the SIGN of today's Nifty move so far.
 *   3. Compare against the 08:30 regime sign.
 *   4. If the sign has FLIPPED by ≥ threshold (±0.5%), force-flat all open
 *      picks. The thesis is dead.
 *   5. Log the decision and notify.
 *
 * This is a safety valve, not a re-entry mechanism. It only closes trades;
 * it does not open new ones.
 */

import Agenda from 'agenda';
import MarketHoursUtil from '../../utils/marketHours.js';
import DailyPick from '../../models/dailyPick.js';
import { runDailyExit } from '../dailyPicks/dailyPicksExitService.js';
import kiteOrderService from '../kiteOrder.service.js';
import kiteConfig from '../../config/kite.config.js';
import { firebaseService } from '../firebase/firebase.service.js';

const LOG = '[REGIME-RECHECK]';

// Threshold (% Nifty move from yesterday's close) that triggers a flip.
// Below this magnitude we don't force-flat — normal intraday noise.
const FLIP_THRESHOLD_PCT = 0.5;

/**
 * Classify a regime label as BULL / BEAR / NEUTRAL for flip comparison.
 */
function regimeSide(regime) {
  if (!regime) return 'NEUTRAL';
  if (regime.includes('BULL')) return 'BULL';
  if (regime.includes('BEAR')) return 'BEAR';
  return 'NEUTRAL';
}

function niftyMoveSide(changePct) {
  if (changePct > FLIP_THRESHOLD_PCT) return 'BULL';
  if (changePct < -FLIP_THRESHOLD_PCT) return 'BEAR';
  return 'NEUTRAL';
}

/**
 * Core recheck work. Exported so manual-trigger + scheduled variants share
 * the same body.
 */
export async function runRegimeRecheck() {
  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} runRegimeRecheck() starting at IST ${new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(11, 19)}`);

  // 1. Load today's DailyPick
  const doc = await DailyPick.findToday();
  if (!doc) {
    console.log(`${LOG} No DailyPick for today — nothing to recheck`);
    return { success: true, reason: 'no_doc' };
  }

  const openPicks = (doc.picks || []).filter(p => {
    const st = p?.trade?.status;
    return st === 'ENTERED' || st === 'VALIDATED' || st === 'ORDER_PLACED';
  });
  if (openPicks.length === 0) {
    console.log(`${LOG} No open positions to recheck`);
    return { success: true, reason: 'no_open_picks' };
  }

  // 2. Fetch current Nifty quote
  let niftyChangePct;
  try {
    const q = await kiteOrderService.getOHLC(['NSE:NIFTY 50']);
    const n = q?.['NSE:NIFTY 50'];
    if (!n) throw new Error('Nifty quote missing');
    const ltp = n.last_price || n.ltp;
    const prevClose = n.ohlc?.close;
    if (!ltp || !prevClose) throw new Error('Nifty LTP or prev close unavailable');
    niftyChangePct = ((ltp - prevClose) / prevClose) * 100;
    console.log(`${LOG} Nifty: LTP=${ltp} prevClose=${prevClose} change=${niftyChangePct.toFixed(2)}%`);
  } catch (err) {
    console.error(`${LOG} Nifty quote fetch failed: ${err.message} — skipping recheck`);
    return { success: false, reason: 'nifty_fetch_failed', error: err.message };
  }

  // 3. Compare regime side vs current Nifty move side
  const morningRegime = doc.market_context?.regime || 'UNKNOWN';
  const morningSide = regimeSide(morningRegime);
  const currentSide = niftyMoveSide(niftyChangePct);

  console.log(`${LOG} Morning regime=${morningRegime} (${morningSide}) | Now Nifty=${niftyChangePct.toFixed(2)}% (${currentSide})`);

  const flipped =
    (morningSide === 'BULL' && currentSide === 'BEAR') ||
    (morningSide === 'BEAR' && currentSide === 'BULL');

  if (!flipped) {
    console.log(`${LOG} ✅ Regime intact (${morningSide} → ${currentSide}). No action.`);
    return { success: true, flipped: false, morningSide, currentSide, niftyChangePct };
  }

  // 4. Regime flipped — force-flat everything
  console.log(`${LOG} ⚠️ REGIME FLIP DETECTED: ${morningSide} → ${currentSide} (Nifty ${niftyChangePct.toFixed(2)}%)`);
  console.log(`${LOG} Force-flatting ${openPicks.length} open position(s)`);

  const result = await runDailyExit({ reason: `regime_flip_${morningSide.toLowerCase()}_to_${currentSide.toLowerCase()}` });

  // 5. Notify
  try {
    if (kiteConfig.ADMIN_USER_ID) {
      await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID,
        '⚠️ Regime Flip — Positions Flattened',
        `Morning ${morningSide} → Now ${currentSide} (Nifty ${niftyChangePct.toFixed(2)}%). ${result.exited || 0} position(s) force-exited at 11:00. Thesis dead.`,
        { type: 'REGIME_FLIP', route: '/daily-picks' }
      );
    }
  } catch (_) { /* ignore */ }

  return {
    success: true,
    flipped: true,
    morningRegime,
    morningSide,
    currentSide,
    niftyChangePct: Number(niftyChangePct.toFixed(2)),
    exited: result.exited || 0,
  };
}

class RegimeRecheckJob {
  constructor() {
    this.agenda = null;
    this.isInitialized = false;
    this.isRunning = false;
    this.stats = { runs: 0, flips: 0, errors: 0, lastRunAt: null };
  }

  async initialize() {
    if (this.isInitialized) return;
    this.agenda = new Agenda({
      db: {
        address: process.env.MONGODB_URI,
        collection: 'regime_recheck_jobs',
        options: { useUnifiedTopology: true },
      },
      processEvery: '30 seconds',
      maxConcurrency: 1,
      defaultConcurrency: 1,
    });
    this.defineJobs();
    this.setupEventHandlers();
    await this.agenda.start();
    await this.scheduleRecurringJobs();
    this.isInitialized = true;
    console.log(`${LOG} Ready. Cron: 0 11 * * 1-5 IST.`);
  }

  defineJobs() {
    this.agenda.define('regime-recheck', async () => {
      if (this.isRunning) { console.log(`${LOG} Already running, skip`); return; }
      this.isRunning = true;
      try {
        const isTrading = await MarketHoursUtil.isTradingDay();
        if (!isTrading) return { skipped: true, reason: 'not_trading_day' };
        const result = await runRegimeRecheck();
        this.stats.runs++;
        if (result.flipped) this.stats.flips++;
        this.stats.lastRunAt = new Date();
        return result;
      } catch (err) {
        this.stats.errors++;
        console.error(`${LOG} Run failed:`, err);
        throw err;
      } finally {
        this.isRunning = false;
      }
    });

    this.agenda.define('manual-regime-recheck', async () => {
      if (this.isRunning) return;
      this.isRunning = true;
      try { return await runRegimeRecheck(); }
      finally { this.isRunning = false; }
    });
  }

  setupEventHandlers() {
    this.agenda.on('ready', () => console.log(`${LOG} Agenda ready`));
    this.agenda.on('fail', (e, j) => console.error(`${LOG} Job failed: ${j.attrs.name}`, e));
  }

  async scheduleRecurringJobs() {
    await this.agenda.cancel({ name: 'regime-recheck' });
    // 11:00 AM IST, Mon-Fri
    await this.agenda.every('0 11 * * 1-5', 'regime-recheck', {}, { timezone: 'Asia/Kolkata' });
    console.log(`${LOG} Scheduled: 11:00 IST, Mon-Fri`);
  }

  async triggerNow() {
    if (!this.isInitialized) throw new Error('RegimeRecheckJob not initialized');
    const job = await this.agenda.now('manual-regime-recheck', {});
    return { success: true, jobId: job.attrs._id };
  }

  getStats() {
    return { ...this.stats, isInitialized: this.isInitialized, isRunning: this.isRunning };
  }

  async shutdown() {
    if (this.agenda) {
      await this.agenda.stop();
      console.log(`${LOG} Shutdown complete`);
    }
  }
}

const regimeRecheckJob = new RegimeRecheckJob();
export default regimeRecheckJob;
export { RegimeRecheckJob };
