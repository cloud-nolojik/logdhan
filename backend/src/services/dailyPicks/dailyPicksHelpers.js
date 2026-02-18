/**
 * Shared helpers for Daily Picks service & exit service.
 */

import { getIstDayRange } from '../../utils/tradingDay.js';

/**
 * Get IST midnight as a UTC Date.
 * Replaces the broken `new Date(); d.setHours(0,0,0,0)` pattern.
 */
export function getISTMidnight(referenceDate = new Date()) {
  return getIstDayRange(referenceDate).startUtc;
}

/**
 * Calculate PnL for a pick after exit
 */
export function calculatePnl(pick) {
  const { entry_price, exit_price, qty } = pick.trade;
  if (!entry_price || !exit_price || !qty) return;

  const multiplier = pick.direction === 'LONG' ? 1 : -1;
  pick.trade.pnl = round2((exit_price - entry_price) * qty * multiplier);
  pick.trade.return_pct = round2(((exit_price - entry_price) / entry_price) * 100 * multiplier);
}

/**
 * Update daily results from current pick statuses
 */
export function updateDailyResults(doc) {
  const completedPicks = doc.picks.filter(p =>
    ['TARGET_HIT', 'STOPPED_OUT', 'TIME_EXIT'].includes(p.trade.status)
  );

  if (completedPicks.length === 0) return;

  const winners = completedPicks.filter(p => (p.trade.pnl || 0) > 0).length;
  const losers = completedPicks.filter(p => (p.trade.pnl || 0) < 0).length;
  const returns = completedPicks.map(p => p.trade.return_pct || 0);
  const avgReturn = returns.length > 0 ? round2(returns.reduce((a, b) => a + b, 0) / returns.length) : 0;
  const totalPnl = round2(completedPicks.reduce((sum, p) => sum + (p.trade.pnl || 0), 0));

  let bestPick = null, worstPick = null;
  let bestReturn = -Infinity, worstReturn = Infinity;
  for (const p of completedPicks) {
    const ret = p.trade.return_pct || 0;
    if (ret > bestReturn) { bestReturn = ret; bestPick = p.symbol; }
    if (ret < worstReturn) { worstReturn = ret; worstPick = p.symbol; }
  }

  doc.results = {
    winners,
    losers,
    avg_return_pct: avgReturn,
    total_pnl: totalPnl,
    best_pick: bestPick,
    worst_pick: worstPick
  };
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Get NSE tick size based on price band (revised April 15, 2025).
 * @see https://zerodha.com/marketintel/bulletin/408151/revision-in-tick-size-for-nse-derivatives-and-cash-segment-from-april-15-2025
 */
export function getNseTickSize(price) {
  if (price <= 250) return 0.01;
  if (price <= 1000) return 0.05;
  if (price <= 5000) return 0.10;
  if (price <= 10000) return 0.50;
  if (price <= 20000) return 1.00;
  return 5.00;
}

/** Round price to NSE tick size based on price band */
export function roundToTick(price, tick) {
  const t = tick ?? getNseTickSize(price);
  const rounded = Math.round(price / t) * t;
  // Precision: 2 decimals for ticks < 1, 0 decimals for ticks >= 1
  const decimals = t >= 1 ? 0 : 2;
  return parseFloat(rounded.toFixed(decimals));
}

export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
