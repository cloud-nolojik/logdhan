/**
 * Candle archive — stores raw intraday OHLCV for the F&O universe + Nifty into
 * MongoDB so the trading system can be backtested against real historical data
 * (2026-06-02).
 *
 * Two entry points:
 *   • archiveDay(dateStr)      — persist one trading day (called daily after close,
 *                                and by the backfill loop).
 *   • backfillRange(from, to)  — walk weekdays in a range and archive each.
 *
 * Storage: one BacktestCandle doc per { symbol, date, interval }. Canonical
 * interval is 1-minute ('minute') — 5/15-min are resampled by the replay harness.
 * Idempotent: re-archiving a day upserts (overwrites), never duplicates.
 */

import kiteOrderService from '../kiteOrder.service.js';
import { getFnoSymbols } from '../../constants/fnoUniverse.js';
import BacktestCandle from '../../models/backtestCandle.js';

const LOG = '[CANDLE-ARCHIVE]';
const NIFTY_SYMBOL = 'NIFTY 50';

/**
 * Build the archive universe: every F&O underlying + the Nifty index.
 */
async function getArchiveUniverse() {
  const fno = await getFnoSymbols();
  return [...new Set([...fno, NIFTY_SYMBOL])];
}

/**
 * Archive one trading day's candles for the whole universe.
 * @param {string} dateStr  - IST trading day 'YYYY-MM-DD'
 * @param {Object} [opts]
 * @param {string} [opts.interval='minute']
 * @returns {{date, saved, empty, total, interval}}
 */
export async function archiveDay(dateStr, { interval = 'minute' } = {}) {
  const universe = await getArchiveUniverse();
  const from = `${dateStr} 09:15:00`;
  const to   = `${dateStr} 15:30:00`;

  console.log(`${LOG} ▶ Archiving ${universe.length} symbols for ${dateStr} (${interval})  ${from} → ${to}`);
  const data = await kiteOrderService.getHistoricalCandles(universe, interval, from, to);

  let saved = 0, empty = 0;
  const ops = [];
  for (const [symbol, candles] of Object.entries(data)) {
    if (!candles?.length) { empty++; continue; }
    const bars = candles.map(c => ({
      t: typeof c.date === 'string' ? c.date : new Date(c.date).toISOString(),
      o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume,
    }));
    ops.push({
      updateOne: {
        filter: { symbol, date: dateStr, interval },
        update: { $set: { symbol, date: dateStr, interval, bars, barCount: bars.length, source: 'kite' } },
        upsert: true,
      },
    });
    saved++;
  }

  if (ops.length) {
    // Chunk bulk writes to keep individual ops modest.
    for (let i = 0; i < ops.length; i += 50) {
      await BacktestCandle.bulkWrite(ops.slice(i, i + 50), { ordered: false });
    }
  }

  console.log(`${LOG} ✅ ${dateStr}: saved=${saved}  empty=${empty}  of ${universe.length}`);
  return { date: dateStr, saved, empty, total: universe.length, interval };
}

/**
 * Iterate calendar dates (inclusive), skipping Sat/Sun. Uses UTC-based date math
 * on the Y-M-D components so there's no timezone drift — the string is just a
 * calendar label. (NSE holidays aren't excluded; Kite simply returns 0 bars for
 * them and archiveDay records them as empty — harmless.)
 */
function* tradingDates(fromStr, toStr) {
  const [fy, fm, fd] = fromStr.split('-').map(Number);
  const [ty, tm, td] = toStr.split('-').map(Number);
  let cur = new Date(Date.UTC(fy, fm - 1, fd));
  const end = new Date(Date.UTC(ty, tm - 1, td));
  while (cur <= end) {
    const dow = cur.getUTCDay();          // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) yield cur.toISOString().slice(0, 10);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
}

/**
 * Backfill a date range (inclusive). One day per archiveDay call (well within
 * Kite's 60-day-per-request 1-min limit). Returns a per-day summary array.
 * @param {string} fromStr - 'YYYY-MM-DD'
 * @param {string} toStr   - 'YYYY-MM-DD'
 */
export async function backfillRange(fromStr, toStr, opts = {}) {
  const results = [];
  for (const dateStr of tradingDates(fromStr, toStr)) {
    try {
      results.push(await archiveDay(dateStr, opts));
    } catch (err) {
      console.error(`${LOG} ❌ ${dateStr} failed: ${err.message}`);
      results.push({ date: dateStr, error: err.message });
    }
  }
  const totals = results.reduce((a, r) => ({
    days:  a.days + 1,
    saved: a.saved + (r.saved || 0),
  }), { days: 0, saved: 0 });
  console.log(`${LOG} ◼ Backfill complete: ${totals.days} days, ${totals.saved} symbol-days saved`);
  return results;
}

/**
 * Archive *today* (IST). Convenience for the daily post-close cron.
 */
export async function archiveToday(opts = {}) {
  const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const dateStr = istNow.toISOString().slice(0, 10);
  return archiveDay(dateStr, opts);
}

export default { archiveDay, backfillRange, archiveToday };
