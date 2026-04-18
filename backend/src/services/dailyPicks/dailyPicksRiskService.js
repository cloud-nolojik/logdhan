/**
 * Daily Picks Risk Service — Portfolio-Level Risk Controls
 *
 * Circuit breaker: Halts new trades when daily drawdown exceeds threshold.
 * Startup recovery: Reconciles open positions after mid-day restart.
 *
 * Imported by dailyPicksService.js — checked before every order placement.
 */

import DailyPick from '../../models/dailyPick.js';
import kiteOrderService from '../kiteOrder.service.js';
import { isKiteIntegrationEnabled } from '../kiteTradeIntegration.service.js';
import { firebaseService } from '../firebase/firebase.service.js';
import kiteConfig from '../../config/kite.config.js';
import { round2 } from './dailyPicksHelpers.js';

const LOG = '[DAILY-RISK]';

// ═══════════════════════════════════════════════════════════════════════════════
// CIRCUIT BREAKER — Portfolio-level daily drawdown limit
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_DAILY_DRAWDOWN_PCT   = 2.0;   // Halt new trades if daily P&L < -2%
const MAX_DAILY_DRAWDOWN_ABS   = null;  // Or use absolute (₹), null = use % only
const MAX_WEEKLY_DRAWDOWN_PCT  = 5.0;   // Halt trades for rest of week if week P&L < -5%
const MAX_MONTHLY_DRAWDOWN_PCT = 10.0;  // Halt trades for rest of month if month P&L < -10%

let circuitBreakerTripped = false;
let circuitBreakerReason = '';

/**
 * Check if the daily drawdown circuit breaker has been tripped.
 * Call this before placing any new entry orders.
 * Persists to DailyPick doc so it survives server restarts.
 *
 * Returns: { allowed: boolean, reason?: string, dailyPnl?: number, dailyPnlPct?: number }
 */
async function checkCircuitBreaker() {
  // Fast path: if already tripped in-memory today, don't re-check
  if (circuitBreakerTripped) {
    return { allowed: false, reason: circuitBreakerReason };
  }

  // Rolling weekly / monthly drawdown gate — walks prior DailyPick docs.
  // This runs FIRST because if the week is already blown, daily-level check
  // is moot.
  const rolling = await checkRollingDrawdowns();
  if (!rolling.allowed) {
    circuitBreakerTripped = true;
    circuitBreakerReason = rolling.reason;
    await notifyCircuitBreaker(0, 0, rolling.reason);
    return { allowed: false, reason: rolling.reason, ...rolling };
  }

  try {
    const doc = await DailyPick.findToday();
    if (!doc) return { allowed: true, ...rolling };

    // Check if circuit breaker was persisted to DB (survives restarts)
    if (doc.circuit_breaker_tripped) {
      circuitBreakerTripped = true;
      circuitBreakerReason = doc.circuit_breaker_reason || 'Circuit breaker tripped (recovered from DB)';
      console.log(`${LOG} [CIRCUIT-BREAKER] Recovered tripped state from DB: ${circuitBreakerReason}`);
      return { allowed: false, reason: circuitBreakerReason };
    }

    // Sum realized P&L from completed trades
    let realizedPnl = 0;
    let unrealizedPnl = 0;
    let capitalDeployed = 0;

    const completedPicks = doc.picks.filter(p =>
      ['TARGET_HIT', 'STOPPED_OUT', 'TIME_EXIT', 'FAILED'].includes(p.trade.status)
    );
    console.log(`${LOG} [CIRCUIT-BREAKER] Completed trades: ${completedPicks.length}`);
    for (const pick of completedPicks) {
      realizedPnl += (pick.trade.pnl || 0);
      console.log(`${LOG} [CIRCUIT-BREAKER]   ${pick.symbol}: ${pick.trade.status} P&L=₹${round2(pick.trade.pnl || 0)}`);
    }

    // Estimate unrealized P&L from open positions using LTP
    const enteredPicks = doc.picks.filter(p => p.trade.status === 'ENTERED');
    console.log(`${LOG} [CIRCUIT-BREAKER] Open positions: ${enteredPicks.length}`);
    if (enteredPicks.length > 0 && isKiteIntegrationEnabled()) {
      try {
        const symbols = enteredPicks.map(p => `NSE:${p.symbol}`);
        const ltpData = await kiteOrderService.getLTP(symbols);

        for (const pick of enteredPicks) {
          const ltp = ltpData[`NSE:${pick.symbol}`]?.last_price;
          if (ltp && pick.trade.entry_price && pick.trade.qty) {
            const pnl = pick.direction === 'LONG'
              ? (ltp - pick.trade.entry_price) * pick.trade.qty
              : (pick.trade.entry_price - ltp) * pick.trade.qty;
            unrealizedPnl += pnl;
            console.log(`${LOG} [CIRCUIT-BREAKER]   ${pick.symbol}: ${pick.direction} entry=₹${pick.trade.entry_price} ltp=₹${ltp} qty=${pick.trade.qty} unrealizedPnl=₹${round2(pnl)}`);
          }
          if (pick.trade.entry_price && pick.trade.qty) {
            capitalDeployed += pick.trade.entry_price * pick.trade.qty;
          }
        }
      } catch (err) {
        console.error(`${LOG} [CIRCUIT-BREAKER] LTP fetch failed for unrealized P&L:`, err.message);
        // Conservative: use realized P&L only
      }
    }

    // Also count capital from completed trades
    for (const pick of completedPicks) {
      if (pick.trade.entry_price && pick.trade.qty) {
        capitalDeployed += pick.trade.entry_price * pick.trade.qty;
      }
    }

    const totalDailyPnl = realizedPnl + unrealizedPnl;

    // Calculate drawdown percentage against starting capital
    // Use the balance at time of first trade, or estimate from capital deployed + P&L
    const startingCapital = capitalDeployed > 0 ? capitalDeployed - totalDailyPnl : 0;
    const dailyPnlPct = startingCapital > 0 ? (totalDailyPnl / startingCapital) * 100 : 0;

    console.log(`${LOG} [CIRCUIT-BREAKER] P&L summary: realized=₹${round2(realizedPnl)} unrealized=₹${round2(unrealizedPnl)} total=₹${round2(totalDailyPnl)} (${round2(dailyPnlPct)}%) capital=₹${round2(capitalDeployed)} startingCap=₹${round2(startingCapital)}`);

    // Check absolute drawdown
    if (MAX_DAILY_DRAWDOWN_ABS && totalDailyPnl < -MAX_DAILY_DRAWDOWN_ABS) {
      circuitBreakerTripped = true;
      circuitBreakerReason = `Daily loss ₹${round2(Math.abs(totalDailyPnl))} exceeds max ₹${MAX_DAILY_DRAWDOWN_ABS}`;
      await persistCircuitBreaker(doc, circuitBreakerReason);
      await notifyCircuitBreaker(totalDailyPnl, dailyPnlPct);
      return { allowed: false, reason: circuitBreakerReason, dailyPnl: totalDailyPnl, dailyPnlPct };
    }

    // Check percentage drawdown
    if (dailyPnlPct < -MAX_DAILY_DRAWDOWN_PCT) {
      circuitBreakerTripped = true;
      circuitBreakerReason = `Daily drawdown ${round2(dailyPnlPct)}% exceeds -${MAX_DAILY_DRAWDOWN_PCT}% limit`;
      await persistCircuitBreaker(doc, circuitBreakerReason);
      await notifyCircuitBreaker(totalDailyPnl, dailyPnlPct);
      return { allowed: false, reason: circuitBreakerReason, dailyPnl: totalDailyPnl, dailyPnlPct };
    }

    return { allowed: true, dailyPnl: totalDailyPnl, dailyPnlPct: round2(dailyPnlPct) };

  } catch (err) {
    console.error(`${LOG} [CIRCUIT-BREAKER] Check failed:`, err.message);
    // Fail-open: allow trading if check fails (conservative alternative: fail-closed)
    return { allowed: true, error: err.message };
  }
}

/**
 * Persist circuit breaker state to DailyPick doc so it survives server restarts
 */
async function persistCircuitBreaker(doc, reason) {
  try {
    doc.circuit_breaker_tripped = true;
    doc.circuit_breaker_reason = reason;
    doc.circuit_breaker_at = new Date();
    doc.markModified('circuit_breaker_tripped');
    await doc.save();
    console.log(`${LOG} [CIRCUIT-BREAKER] Persisted to DB — survives restart`);
  } catch (err) {
    console.error(`${LOG} [CIRCUIT-BREAKER] Failed to persist to DB: ${err.message}`);
  }
}

/**
 * Notify admin that circuit breaker has been tripped
 */
async function notifyCircuitBreaker(dailyPnl, dailyPnlPct, overrideReason = null) {
  const reason = overrideReason || circuitBreakerReason;
  console.error(`${LOG} ⛔ CIRCUIT BREAKER TRIPPED: ${reason}`);
  try {
    const body = overrideReason
      ? `${reason}. No new trades will be placed. Open positions still managed (SL/target/trailing/exit).`
      : `${reason}. No new trades will be placed today. Open positions will still be managed (SL/target/trailing/exit). Daily P&L: ₹${round2(dailyPnl)} (${round2(dailyPnlPct)}%)`;
    await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID,
      '⛔ Circuit Breaker — Trading Halted',
      body,
      { type: 'CIRCUIT_BREAKER', route: '/daily-picks' }
    );
  } catch (_) { /* ignore */ }
}

/**
 * Check rolling weekly + monthly drawdown against DailyPick history.
 *
 * Walks prior trading days, sums realized P&L on closed trades, computes
 * drawdown % against starting capital (estimated from capital deployed + PnL).
 *
 * Returns:
 *   { allowed: boolean, reason?: string, weekly_pnl_pct?: number, monthly_pnl_pct?: number }
 */
async function checkRollingDrawdowns() {
  try {
    const now = new Date();
    const istMs = now.getTime() + (5.5 * 60 * 60 * 1000);
    const istNow = new Date(istMs);

    // Monday of current week (ISO week start = Monday)
    const mondayIstMs = (() => {
      const d = new Date(istNow);
      const weekdayMon0 = (d.getUTCDay() + 6) % 7; // 0 = Mon
      d.setUTCDate(d.getUTCDate() - weekdayMon0);
      d.setUTCHours(0, 0, 0, 0);
      return d.getTime();
    })();

    // 1st of current month
    const firstOfMonthIstMs = (() => {
      const d = new Date(istNow);
      d.setUTCDate(1);
      d.setUTCHours(0, 0, 0, 0);
      return d.getTime();
    })();

    // Query DailyPick docs for this month (includes this week)
    const monthStart = new Date(firstOfMonthIstMs - (5.5 * 60 * 60 * 1000));
    const docs = await DailyPick.find({
      trading_date: { $gte: monthStart }
    }).lean();

    let weeklyPnl = 0, weeklyCapital = 0;
    let monthlyPnl = 0, monthlyCapital = 0;

    for (const doc of docs) {
      const tradingTs = new Date(doc.trading_date).getTime() + (5.5 * 60 * 60 * 1000);

      let docPnl = 0, docCapital = 0;
      for (const p of (doc.picks || [])) {
        const status = p?.trade?.status;
        if (!['TARGET_HIT', 'STOPPED_OUT', 'TIME_EXIT', 'FAILED'].includes(status)) continue;
        docPnl += (p.trade.pnl || 0);
        if (p.trade.entry_price && p.trade.qty) {
          docCapital += p.trade.entry_price * p.trade.qty;
        }
      }

      if (tradingTs >= mondayIstMs)      { weeklyPnl  += docPnl; weeklyCapital  += docCapital; }
      if (tradingTs >= firstOfMonthIstMs){ monthlyPnl += docPnl; monthlyCapital += docCapital; }
    }

    const wkStart = weeklyCapital  > 0 ? weeklyCapital  - weeklyPnl  : 0;
    const moStart = monthlyCapital > 0 ? monthlyCapital - monthlyPnl : 0;
    const wkPct   = wkStart > 0 ? (weeklyPnl  / wkStart) * 100 : 0;
    const moPct   = moStart > 0 ? (monthlyPnl / moStart) * 100 : 0;

    console.log(`${LOG} [ROLLING-DD] week pnl=₹${round2(weeklyPnl)} (${round2(wkPct)}%) | month pnl=₹${round2(monthlyPnl)} (${round2(moPct)}%)`);

    if (wkPct < -MAX_WEEKLY_DRAWDOWN_PCT) {
      const reason = `Weekly drawdown ${round2(wkPct)}% exceeds -${MAX_WEEKLY_DRAWDOWN_PCT}% limit — trading paused for the rest of the week`;
      return { allowed: false, reason, weekly_pnl_pct: round2(wkPct), monthly_pnl_pct: round2(moPct) };
    }
    if (moPct < -MAX_MONTHLY_DRAWDOWN_PCT) {
      const reason = `Monthly drawdown ${round2(moPct)}% exceeds -${MAX_MONTHLY_DRAWDOWN_PCT}% limit — trading paused for the rest of the month`;
      return { allowed: false, reason, weekly_pnl_pct: round2(wkPct), monthly_pnl_pct: round2(moPct) };
    }
    return { allowed: true, weekly_pnl_pct: round2(wkPct), monthly_pnl_pct: round2(moPct) };

  } catch (err) {
    console.error(`${LOG} [ROLLING-DD] failed:`, err.message);
    return { allowed: true, error: err.message };  // fail-open (consistent with daily breaker)
  }
}

/**
 * Reset circuit breaker — called at start of each trading day (before scans)
 */
function resetCircuitBreaker() {
  if (circuitBreakerTripped) {
    console.log(`${LOG} Resetting circuit breaker from previous day`);
  }
  circuitBreakerTripped = false;
  circuitBreakerReason = '';
}

/**
 * Get current circuit breaker status
 */
function getCircuitBreakerStatus() {
  return { tripped: circuitBreakerTripped, reason: circuitBreakerReason };
}


// ═══════════════════════════════════════════════════════════════════════════════
// STARTUP RECOVERY — Reconcile positions after mid-day crash/restart
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Reconcile open positions on startup.
 * If the server restarts mid-day, open positions may have no monitoring.
 * This function:
 * 1. Queries Kite for current open positions
 * 2. Matches them against DailyPick DB records
 * 3. Ensures SL/target orders are in place
 * 4. Re-attaches them for monitoring by the existing monitor job
 */
async function reconcilePositionsOnStartup() {
  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} Startup position reconciliation`);
  console.log(`${LOG} ════════════════════════════════════════`);

  if (!isKiteIntegrationEnabled()) {
    console.log(`${LOG} Kite not enabled — skipping reconciliation`);
    return { success: true, reconciled: 0, message: 'Kite not enabled' };
  }

  try {
    // Step 1: Get today's doc
    const doc = await DailyPick.findToday();
    if (!doc) {
      console.log(`${LOG} No DailyPick doc for today — nothing to reconcile`);
      return { success: true, reconciled: 0, message: 'No picks today' };
    }

    // Step 2: Get open positions from Kite
    let positions;
    try {
      positions = await kiteOrderService.getPositions();
    } catch (err) {
      console.error(`${LOG} Failed to fetch positions from Kite:`, err.message);
      return { success: false, error: err.message };
    }

    const dayPositions = positions?.data?.day || [];
    const openPositions = dayPositions.filter(p => p.quantity !== 0);

    if (openPositions.length === 0) {
      console.log(`${LOG} No open positions on Kite — nothing to reconcile`);
      return { success: true, reconciled: 0, message: 'No open positions' };
    }

    console.log(`${LOG} Found ${openPositions.length} open positions on Kite`);

    // Step 3: Match against DB records
    let reconciled = 0;
    let orphaned = 0;

    for (const pos of openPositions) {
      const symbol = pos.tradingsymbol;
      const pick = doc.picks.find(p => p.symbol === symbol);

      if (!pick) {
        console.warn(`${LOG} ⚠️ ${symbol}: Open position on Kite but NOT in DailyPick DB — ORPHANED`);
        orphaned++;
        continue;
      }

      console.log(`${LOG} ${symbol}: DB status=${pick.trade.status} kite_status=${pick.kite.kite_status} | Kite: qty=${pos.quantity} avg=₹${pos.average_price} pnl=₹${pos.pnl}`);

      // If DB says ORDER_PLACED but Kite has open position → fill was missed
      if (pick.trade.status === 'ORDER_PLACED' && !pick.trade.entry_price) {
        console.log(`${LOG} ${symbol}: Recovering missed fill — updating to ENTERED @ ₹${pos.average_price}`);
        pick.trade.status = 'ENTERED';
        pick.trade.entry_price = pos.average_price;
        pick.trade.entry_time = new Date();
        pick.trade.qty = Math.abs(pos.quantity);
        pick.kite.kite_status = 'entered';

        // Check if SL/target need placement
        if (!pick.kite.stop_order_id) {
          console.warn(`${LOG} ${symbol}: No stop order — needs SL+target placement. Will be handled by monitor.`);
          // The import of placeSLAndTarget would create circular dependency,
          // so we just mark it for the monitor job to handle on next run.
          pick.kite.kite_status = 'entered_awaiting_915';
        }
        reconciled++;
      }

      // If DB says ENTERED but stop/target orders might be cancelled
      if (pick.trade.status === 'ENTERED' && pick.kite.stop_order_id) {
        try {
          const stopOrder = await kiteOrderService.getOrderDetails(pick.kite.stop_order_id);
          const stopStatus = stopOrder?.status?.toUpperCase();

          if (stopStatus === 'CANCELLED' || stopStatus === 'REJECTED') {
            console.warn(`${LOG} ${symbol}: Stop order ${stopStatus} — re-marking for SL placement`);
            pick.kite.stop_order_id = null;
            pick.kite.kite_status = 'entered_awaiting_915';
            reconciled++;
          } else if (stopStatus === 'COMPLETE') {
            console.log(`${LOG} ${symbol}: Stop already triggered — checking Kite position`);
            // Stop triggered but position still open? Possible race condition
          }
        } catch (err) {
          console.error(`${LOG} ${symbol}: Stop order check failed:`, err.message);
        }
      }
    }

    if (reconciled > 0 || orphaned > 0) {
      doc.markModified('picks');
      await doc.save();
    }

    console.log(`${LOG} Reconciliation complete: ${reconciled} reconciled, ${orphaned} orphaned`);

    if (orphaned > 0) {
      try {
        await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID,
          '⚠️ Orphaned Positions Detected',
          `${orphaned} open position(s) on Kite have no matching DailyPick record. Manual review required.`,
          { type: 'DAILY_PICKS_ALERT', route: '/daily-picks' }
        );
      } catch (_) { /* ignore */ }
    }

    return { success: true, reconciled, orphaned };

  } catch (err) {
    console.error(`${LOG} Reconciliation failed:`, err.message);
    return { success: false, error: err.message };
  }
}


export {
  checkCircuitBreaker,
  resetCircuitBreaker,
  getCircuitBreakerStatus,
  reconcilePositionsOnStartup,
  MAX_DAILY_DRAWDOWN_PCT
};

export default {
  checkCircuitBreaker,
  resetCircuitBreaker,
  getCircuitBreakerStatus,
  reconcilePositionsOnStartup
};
