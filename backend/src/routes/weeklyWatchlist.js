import express from "express";
import WeeklyWatchlist from "../models/weeklyWatchlist.js";
import LatestPrice from "../models/latestPrice.js";
import { auth } from "../middleware/auth.js";
import { calculateSetupScore, getEntryZone, checkEntryZoneProximity } from "../engine/index.js";
import { getCurrentPrice, findLevelCrossTime, getDailyCandlesForRange } from "../utils/stockDb.js";
import { simulateTrade } from "../services/dailyTrackingService.js";

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════════════════
// SCORE EXPLANATIONS - Helps users understand what each score means
// ═══════════════════════════════════════════════════════════════════════════════

const SCORE_EXPLANATIONS = {
  setup_score: {
    label: "Setup Score",
    max: 100,
    source: "engine",
    description: "Technical quality score calculated by the screening engine",
    what_it_measures: "How strong the technical setup is based on chart patterns, volume, and momentum",
    factors: [
      { name: "Volume Conviction", max: 20, description: "Trading volume vs 20-day average" },
      { name: "Risk:Reward", max: 20, description: "Potential profit vs potential loss ratio" },
      { name: "RSI Position", max: 15, description: "Whether RSI is in the sweet spot (not overbought)" },
      { name: "Weekly Move", max: 15, description: "Price momentum over the past week" },
      { name: "Upside to Target", max: 15, description: "Potential percentage gain to target" },
      { name: "Promoter & Institutional", max: 10, description: "Promoter pledge risk and FII/DII activity" },
      { name: "Price Accessibility", max: 5, description: "Whether price allows good position sizing" }
    ],
    grades: {
      "A+": "90-100 - Exceptional setup",
      "A": "80-89 - Strong setup",
      "B+": "70-79 - Good setup",
      "B": "60-69 - Average setup",
      "C": "50-59 - Below average",
      "D": "<50 - Weak setup"
    }
  },
  ai_confidence: {
    label: "AI Confidence",
    max: 100,
    source: "claude",
    description: "How confident the AI is in this trade recommendation",
    what_it_measures: "Overall conviction factoring in fundamentals, news, market context, and risks",
    adjustments: [
      { example: "VOLUME_SURGE", effect: "+5 to +15%", description: "Unusually high volume confirms institutional interest" },
      { example: "PROMOTER_PLEDGE", effect: "-10 to -20%", description: "High promoter pledge adds risk" },
      { example: "RSI_EXTENDED", effect: "-5 to -10%", description: "RSI approaching overbought territory" },
      { example: "STRONG_FUNDAMENTALS", effect: "+5 to +10%", description: "Good earnings, low debt, FII buying" }
    ],
    interpretation: {
      "80-95%": "High confidence - Strong conviction in the trade",
      "65-79%": "Moderate confidence - Good setup with some concerns",
      "50-64%": "Low confidence - Proceed with caution",
      "<50%": "Very low - Consider skipping this trade"
    }
  }
};

/**
 * Check if we need to run intraday simulation for a stock
 * This handles the case where price crosses entry/stop/target during market hours
 * before the 4 PM daily tracking job runs
 *
 * @param {Object} stock - Stock from WeeklyWatchlist
 * @param {number} livePrice - Current live price
 * @param {Date} weekStart - The week_start date from watchlist (Monday of trading week)
 * @returns {Promise<boolean>} - Whether simulation was updated and needs saving
 */
async function checkIntradayTriggers(stock, livePrice, weekStart) {
  if (!livePrice || !stock.levels) return false;

  const sim = stock.trade_simulation;
  const levels = stock.levels;
  // Use entry zone LOW as the trigger point (not entry which might be mid-point)
  // Entry is triggered when price rises ABOVE the low of entry zone
  const entryRange = levels.entryRange || [];
  const entryZoneLow = entryRange[0] || levels.entry;
  const entry = entryZoneLow;  // Use zone low for entry trigger
  const stop = levels.stop;
  // T1 = target1 (partial booking at 50%), fallback to target if not set
  const t1 = levels.target1 || levels.target;
  const t2 = levels.target2 || (levels.target1 ? levels.target : null);  // T2 = target if target1 exists

  console.log(`[INTRADAY-CHECK] ${stock.symbol}: livePrice=${livePrice}, entryZoneLow=${entryZoneLow}, levels.entry=${levels.entry}`);

  // Get today's date in IST
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const todayStr = istNow.toISOString().split('T')[0];

  // Check if we already have today's snapshot
  const hasToday = stock.daily_snapshots?.some(s => {
    const snapDate = new Date(s.date);
    const snapIst = new Date(snapDate.getTime() + istOffset);
    return snapIst.toISOString().split('T')[0] === todayStr;
  });

  console.log(`[INTRADAY-CHECK] ${stock.symbol}: todayStr=${todayStr}, hasToday=${hasToday}, sim.status=${sim?.status || 'null'}`);
  console.log(`[INTRADAY-CHECK] ${stock.symbol}: snapshots count=${stock.daily_snapshots?.length || 0}`);
  if (stock.daily_snapshots?.length > 0) {
    const lastSnap = stock.daily_snapshots[stock.daily_snapshots.length - 1];
    console.log(`[INTRADAY-CHECK] ${stock.symbol}: lastSnapshot date=${lastSnap.date}, is_intraday=${lastSnap.is_intraday}`);
  }

  // If we have today's snapshot AND trade_simulation exists, simulation is up to date
  if (hasToday && sim && sim.status !== 'WAITING') {
    console.log(`[INTRADAY-CHECK] ${stock.symbol}: Skipping - already have today's snapshot with sim.status=${sim.status}`);
    return false;
  }

  // RECOVERY: If trade_simulation is missing or WAITING, but previous snapshots show entry was triggered
  // This can happen if 4PM job ran before simulateTrade code was deployed
  if ((!sim || sim.status === 'WAITING') && stock.daily_snapshots?.length > 0) {
    const anySnapshotTriggeredEntry = stock.daily_snapshots.some(s => s.high >= entry);
    if (anySnapshotTriggeredEntry) {
      console.log(`[INTRADAY-CHECK] ${stock.symbol}: RECOVERY - Previous snapshot shows entry was triggered, re-running simulation`);
      const allSnapshots = stock.daily_snapshots.map(s => ({
        date: s.date,
        open: s.open,
        high: s.high,
        low: s.low,
        close: s.close
      }));
      stock.trade_simulation = simulateTrade(stock, allSnapshots, livePrice);
      console.log(`[INTRADAY-CHECK] ${stock.symbol}: RECOVERY complete - sim.status=${stock.trade_simulation.status}`);
      return true; // Mark as changed so it gets saved
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // BACKFILL: If no snapshots exist, fetch historical 1-min candles from week start
  // This catches cases where 4PM job hasn't run yet but entry may have triggered earlier
  // ══════════════════════════════════════════════════════════════════
  if ((!sim || sim.status === 'WAITING') && (!stock.daily_snapshots || stock.daily_snapshots.length === 0)) {
    console.log(`[INTRADAY-CHECK] ${stock.symbol}: No snapshots - attempting historical backfill from week start`);

    try {
      // week_start is stored as Sunday 18:30 UTC = Monday 00:00 IST
      // We need to convert to IST to get the correct Monday date
      const weekStartUtc = new Date(weekStart);
      const istOffsetMs = 5.5 * 60 * 60 * 1000; // IST = UTC + 5:30
      const weekStartIst = new Date(weekStartUtc.getTime() + istOffsetMs);

      // Extract the IST date (this will be Monday)
      const weekStartDateStr = weekStartIst.toISOString().split('T')[0]; // "2026-02-02" (Monday)

      const todayUtc = new Date();
      const todayIst = new Date(todayUtc.getTime() + istOffsetMs);
      const todayDateStr = todayIst.toISOString().split('T')[0];

      console.log(`[INTRADAY-CHECK] ${stock.symbol}: week_start UTC=${weekStartUtc.toISOString()}, IST date=${weekStartDateStr}`);
      console.log(`[INTRADAY-CHECK] ${stock.symbol}: Fetching 1-min candles from ${weekStartDateStr} to ${todayDateStr}`);

      const historicalCandles = await getDailyCandlesForRange(stock.instrument_key, weekStartDateStr, todayDateStr);

      if (historicalCandles && historicalCandles.length > 0) {
        console.log(`[INTRADAY-CHECK] ${stock.symbol}: Got ${historicalCandles.length} daily candles from historical data`);

        // Check if any day's high crossed entry
        const entryTriggeredDay = historicalCandles.find(c => c.high >= entry);

        if (entryTriggeredDay) {
          console.log(`[INTRADAY-CHECK] ${stock.symbol}: BACKFILL - Entry was triggered on ${entryTriggeredDay.date.toISOString().split('T')[0]} (high=${entryTriggeredDay.high} >= entry=${entry})`);

          // Add all historical candles as snapshots
          stock.daily_snapshots = historicalCandles.map(c => ({
            date: c.date,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
            is_backfill: true  // Flag to indicate this came from historical backfill
          }));

          // Run simulation with all snapshots
          const allSnapshots = stock.daily_snapshots.map(s => ({
            date: s.date,
            open: s.open,
            high: s.high,
            low: s.low,
            close: s.close
          }));

          stock.trade_simulation = simulateTrade(stock, allSnapshots, livePrice);
          console.log(`[INTRADAY-CHECK] ${stock.symbol}: BACKFILL complete - sim.status=${stock.trade_simulation.status}, entry_date=${stock.trade_simulation.entry_date}`);
          return true; // Mark as changed so it gets saved
        } else {
          console.log(`[INTRADAY-CHECK] ${stock.symbol}: BACKFILL - No entry trigger found in historical data (highest=${Math.max(...historicalCandles.map(c => c.high))} < entry=${entry})`);
        }
      } else {
        console.log(`[INTRADAY-CHECK] ${stock.symbol}: BACKFILL - No historical candles found`);
      }
    } catch (backfillError) {
      console.error(`[INTRADAY-CHECK] ${stock.symbol}: BACKFILL error:`, backfillError.message);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // CASE 1: WAITING → check if entry triggered (using live price)
  // ══════════════════════════════════════════════════════════════════
  if (!sim || sim.status === 'WAITING') {
    console.log(`[INTRADAY-CHECK] ${stock.symbol}: WAITING check - livePrice=${livePrice} >= entry=${entry}? ${livePrice >= entry}`);
    if (livePrice >= entry) {
      // Entry triggered! Find the EXACT time it crossed using intraday candles
      console.log(`[INTRADAY] ${stock.symbol}: Entry triggered at ₹${livePrice} (entry: ₹${entry})`);
      console.log(`[INTRADAY] ${stock.symbol}: Finding exact crossing time from intraday candles...`);

      // Try to find exact crossing time from intraday candle data
      let crossTime = now;
      let crossPrice = livePrice;

      try {
        const crossResult = await findLevelCrossTime(stock.instrument_key, entry, 'above');
        if (crossResult) {
          crossTime = crossResult.crossTime;
          crossPrice = crossResult.crossPrice;
          console.log(`[INTRADAY] ${stock.symbol}: Found exact crossing at ${crossTime.toISOString()} @ ₹${crossPrice}`);
        } else {
          console.log(`[INTRADAY] ${stock.symbol}: Could not find exact crossing time, using current time`);
        }
      } catch (err) {
        console.error(`[INTRADAY] ${stock.symbol}: Error finding cross time:`, err.message);
      }

      console.log(`[INTRADAY] ${stock.symbol}: Creating snapshot with date=${crossTime.toISOString()}`);
      console.log(`[INTRADAY] ${stock.symbol}: Existing snapshots count=${stock.daily_snapshots?.length || 0}`);

      // Create intraday snapshot with the crossing time and price
      const intradaySnapshot = {
        date: crossTime,
        open: crossPrice,
        high: livePrice,  // Current price might be higher
        low: Math.min(crossPrice, livePrice),
        close: livePrice,
        volume: 0,
        is_intraday: true  // Flag to indicate this is not from EOD
      };

      if (!stock.daily_snapshots) stock.daily_snapshots = [];
      stock.daily_snapshots.push(intradaySnapshot);

      // Run simulation with all snapshots
      const allSnapshots = stock.daily_snapshots.map(s => ({
        date: s.date,
        open: s.open,
        high: s.high,
        low: s.low,
        close: s.close
      }));

      stock.trade_simulation = simulateTrade(stock, allSnapshots, livePrice);
      console.log(`[INTRADAY] ${stock.symbol}: After simulation - entry_date=${stock.trade_simulation.entry_date?.toISOString?.() || stock.trade_simulation.entry_date}`);
      console.log(`[INTRADAY] ${stock.symbol}: Events=${JSON.stringify(stock.trade_simulation.events?.map(e => ({ type: e.type, date: e.date })))}`);
      return true;
    }
    return false;
  }

  // ══════════════════════════════════════════════════════════════════
  // CASE 2: ENTERED → check if stop or T1 hit
  // ══════════════════════════════════════════════════════════════════
  if (sim.status === 'ENTERED') {
    const trailingStop = sim.trailing_stop || stop;

    // Check stop loss first (worst case)
    if (livePrice <= trailingStop) {
      console.log(`[INTRADAY] ${stock.symbol}: Stop hit at ₹${livePrice} (stop: ₹${trailingStop})`);
      await updateIntradaySimulation(stock, livePrice, now, trailingStop, 'below');
      return true;
    }

    // Check T1
    if (livePrice >= t1) {
      console.log(`[INTRADAY] ${stock.symbol}: T1 hit at ₹${livePrice} (T1: ₹${t1})`);
      await updateIntradaySimulation(stock, livePrice, now, t1, 'above');
      return true;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // CASE 3: PARTIAL_EXIT → check if trailing stop or T2 hit
  // ══════════════════════════════════════════════════════════════════
  if (sim.status === 'PARTIAL_EXIT') {
    const trailingStop = sim.trailing_stop || sim.entry_price;

    // Check trailing stop (now at entry)
    if (livePrice <= trailingStop) {
      console.log(`[INTRADAY] ${stock.symbol}: Trailing stop hit at ₹${livePrice} (stop: ₹${trailingStop})`);
      await updateIntradaySimulation(stock, livePrice, now, trailingStop, 'below');
      return true;
    }

    // Check T2
    if (t2 && livePrice >= t2) {
      console.log(`[INTRADAY] ${stock.symbol}: T2 hit at ₹${livePrice} (T2: ₹${t2})`);
      await updateIntradaySimulation(stock, livePrice, now, t2, 'above');
      return true;
    }
  }

  return false;
}

/**
 * Update today's intraday snapshot with new high/low and re-run simulation
 * @param {Object} stock - Stock from WeeklyWatchlist
 * @param {number} livePrice - Current live price
 * @param {Date} now - Current timestamp
 * @param {number} level - The price level that was crossed (for finding exact time)
 * @param {string} direction - 'above' or 'below' for crossing direction
 */
async function updateIntradaySimulation(stock, livePrice, now, level = null, direction = 'above') {
  // Get or create today's snapshot
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const todayStr = istNow.toISOString().split('T')[0];

  // Try to find exact crossing time if level is provided
  let crossTime = now;
  if (level) {
    try {
      const crossResult = await findLevelCrossTime(stock.instrument_key, level, direction);
      if (crossResult) {
        crossTime = crossResult.crossTime;
        console.log(`[INTRADAY] ${stock.symbol}: Found exact ${direction} crossing at ${crossTime.toISOString()}`);
      }
    } catch (err) {
      console.error(`[INTRADAY] ${stock.symbol}: Error finding cross time:`, err.message);
    }
  }

  let todayIndex = stock.daily_snapshots?.findIndex(s => {
    const snapDate = new Date(s.date);
    const snapIst = new Date(snapDate.getTime() + istOffset);
    return snapIst.toISOString().split('T')[0] === todayStr && s.is_intraday;
  });

  if (todayIndex === -1 || todayIndex === undefined) {
    // Create new intraday snapshot
    if (!stock.daily_snapshots) stock.daily_snapshots = [];
    stock.daily_snapshots.push({
      date: crossTime,
      open: livePrice,
      high: livePrice,
      low: livePrice,
      close: livePrice,
      volume: 0,
      is_intraday: true
    });
  } else {
    // Update existing intraday snapshot
    const snap = stock.daily_snapshots[todayIndex];
    snap.high = Math.max(snap.high, livePrice);
    snap.low = Math.min(snap.low, livePrice);
    snap.close = livePrice;
    // Update date to crossing time if we found it and it's earlier
    if (crossTime < snap.date) {
      snap.date = crossTime;
    }
  }

  // Re-run simulation with all snapshots
  const allSnapshots = stock.daily_snapshots.map(s => ({
    date: s.date,
    open: s.open,
    high: s.high,
    low: s.low,
    close: s.close
  }));

  stock.trade_simulation = simulateTrade(stock, allSnapshots, livePrice);

  // Fix event timestamps: use the exact crossing time we found for the most recent event
  // (The simulation uses snapshot dates, but we found the actual crossing time)
  if (crossTime && stock.trade_simulation?.events?.length > 0) {
    const lastEvent = stock.trade_simulation.events[stock.trade_simulation.events.length - 1];
    // Only update if this event happened on the same day as our crossing
    const eventDate = new Date(lastEvent.date);
    const crossDate = new Date(crossTime);
    if (eventDate.toISOString().split('T')[0] === crossDate.toISOString().split('T')[0]) {
      lastEvent.date = crossTime;
      console.log(`[INTRADAY] ${stock.symbol}: Updated ${lastEvent.type} event time to ${crossTime.toISOString()}`);
    }
  }
}

/**
 * Calculate card_display for a stock with trade simulation
 * Returns all fields needed for Home Screen card + AI Analysis screen
 */
function calculateCardDisplay(stock, livePrice) {
  const sim = stock.trade_simulation;
  const levels = stock.levels || {};

  // Build levels_summary for the card (new v2 fields)
  const levelsSummary = {
    entry: levels.entry,
    entry_range: levels.entryRange,
    stop: levels.stop,
    t1: levels.target1,
    t1_basis: levels.target1Basis,
    target: levels.target,
    target2: levels.target2,
    entry_confirmation: levels.entryConfirmation || 'close_above',
    entry_window_days: levels.entryWindowDays || 3,
    max_hold_days: levels.maxHoldDays || 5,
    week_end_rule: levels.weekEndRule || 'exit_if_no_t1'
  };

  // Default response for stocks without simulation or not yet entered
  if (!sim || sim.status === 'WAITING') {
    // Get entry zone from levels.entryRange array or entry_zone object
    const entryRange = levels.entryRange;
    const entryZoneLow = entryRange?.[0] || stock.entry_zone?.low;
    const entryZoneHigh = entryRange?.[1] || stock.entry_zone?.high;

    // Build subtext based on entry confirmation type
    const entryConfirmation = levels.entryConfirmation || 'close_above';
    const entryWindowDays = levels.entryWindowDays || 3;
    let entryZoneText;

    if (entryConfirmation === 'close_above') {
      entryZoneText = entryZoneLow
        ? `Needs daily CLOSE above ₹${entryZoneLow.toFixed(2)}`
        : 'Waiting for close-based confirmation';
    } else {
      // touch or limit entry
      entryZoneText = entryZoneLow && entryZoneHigh
        ? `Entry zone: ₹${entryZoneLow.toFixed(2)} - ₹${entryZoneHigh.toFixed(2)}`
        : 'No entry zone set';
    }

    return {
      journey_status: 'WAITING',
      emoji: '⏳',
      headline: 'Waiting for Entry',
      subtext: entryZoneText,
      entry_window_hint: `${entryWindowDays} days to trigger`,
      pnl_line: null,
      live_price: livePrice,
      entry_price: null,
      entry_date: null,
      total_pnl: null,
      total_return_pct: null,
      investment_value: null,
      realized_pnl: 0,
      unrealized_pnl: 0,
      trailing_stop: null,
      peak_price: null,
      peak_gain_pct: null,
      qty_total: null,
      qty_remaining: null,
      events: [],
      dist_from_entry_pct: null,
      dist_from_stop_pct: null,
      dist_from_target_pct: null,
      dist_from_target2_pct: null,
      levels_summary: levelsSummary
    };
  }

  const entryPrice = sim.entry_price;
  const qtyRemaining = sim.qty_remaining || 0;
  const qtyTotal = sim.qty_total || 0;
  const realizedPnl = sim.realized_pnl || 0;
  const trailingStop = sim.trailing_stop;
  const peakPrice = sim.peak_price || entryPrice;

  // Calculate unrealized P&L based on current position
  let unrealizedPnl = 0;
  if (qtyRemaining > 0 && livePrice) {
    unrealizedPnl = (livePrice - entryPrice) * qtyRemaining;
  }

  // Total P&L = realized + unrealized
  const totalPnl = realizedPnl + unrealizedPnl;
  const capital = sim.capital || 100000;
  const totalReturnPct = (totalPnl / capital) * 100;

  // Current investment value
  const investmentValue = qtyRemaining > 0 && livePrice ? qtyRemaining * livePrice : 0;

  // Peak gain percentage
  const peakGainPct = entryPrice > 0 ? ((peakPrice - entryPrice) / entryPrice) * 100 : 0;

  // Get price levels for progress bar (prefer levels object, fallback to screening_data)
  const t1 = stock.levels?.target1 || stock.levels?.target || stock.screening_data?.T1;
  const t2 = stock.levels?.target2 || stock.levels?.target || stock.screening_data?.T2 || stock.screening_data?.swing_target;
  const stopLoss = stock.levels?.stop || stock.screening_data?.stop_loss || stock.entry_zone?.stop_loss;

  let distFromEntryPct = null;
  let distFromStopPct = null;
  let distFromTargetPct = null;
  let distFromTarget2Pct = null;

  if (livePrice && entryPrice) {
    distFromEntryPct = ((livePrice - entryPrice) / entryPrice) * 100;

    if (stopLoss) {
      distFromStopPct = ((livePrice - stopLoss) / stopLoss) * 100;
    }
    if (t1) {
      distFromTargetPct = ((t1 - livePrice) / livePrice) * 100;
    }
    if (t2) {
      distFromTarget2Pct = ((t2 - livePrice) / livePrice) * 100;
    }
  }

  // Generate emoji, headline, subtext based on status
  let emoji, headline, subtext, pnlLine;
  const pnlSign = totalPnl >= 0 ? '+' : '';

  switch (sim.status) {
    case 'ENTERED':
      emoji = '🟢';
      headline = 'Entry Triggered';
      subtext = `If you bought ${qtyTotal} shares @ ₹${entryPrice?.toFixed(2)}`;
      pnlLine = `${pnlSign}₹${totalPnl.toFixed(0)} (${pnlSign}${totalReturnPct.toFixed(1)}%)`;
      break;

    case 'PARTIAL_EXIT':
      emoji = '🟡';
      headline = 'T1 Hit - Trailing Stop';
      subtext = `50% booked at T1, ${qtyRemaining} shares trailing with SL @ ₹${trailingStop?.toFixed(2)}`;
      pnlLine = `${pnlSign}₹${totalPnl.toFixed(0)} (${pnlSign}${totalReturnPct.toFixed(1)}%)`;
      break;

    case 'FULL_EXIT':
      emoji = '🎯';
      headline = 'Full Target Hit';
      subtext = 'Both T1 & T2 achieved';
      pnlLine = `${pnlSign}₹${realizedPnl.toFixed(0)} (${pnlSign}${totalReturnPct.toFixed(1)}%)`;
      break;

    case 'STOPPED_OUT':
      emoji = '🔴';
      headline = 'Stop Loss Hit';
      const lastEvent = sim.events?.[sim.events.length - 1];
      subtext = lastEvent?.detail || 'Stop loss triggered';
      pnlLine = `${pnlSign}₹${realizedPnl.toFixed(0)} (${pnlSign}${totalReturnPct.toFixed(1)}%)`;
      break;

    case 'EXPIRED':
      emoji = '⏰';
      // Check if this was an entry window expiry (never entered) vs week-end exit
      if (!sim.entry_date) {
        headline = 'Entry Window Expired';
        subtext = 'Stock didn\'t confirm entry in time';
        pnlLine = null;
      } else if (qtyRemaining > 0) {
        headline = 'Week Ended';
        subtext = `Position closed at week end`;
        pnlLine = `${pnlSign}₹${totalPnl.toFixed(0)} (${pnlSign}${totalReturnPct.toFixed(1)}%)`;
      } else {
        headline = 'Trade Completed';
        subtext = 'Trade completed before expiry';
        pnlLine = `${pnlSign}₹${totalPnl.toFixed(0)} (${pnlSign}${totalReturnPct.toFixed(1)}%)`;
      }
      break;

    default:
      emoji = '❓';
      headline = 'Unknown Status';
      subtext = sim.status;
      pnlLine = null;
  }

  return {
    journey_status: sim.status,
    emoji,
    headline,
    subtext,
    pnl_line: pnlLine,
    live_price: livePrice,
    entry_price: entryPrice,
    entry_date: sim.entry_date,
    total_pnl: totalPnl,
    total_return_pct: totalReturnPct,
    investment_value: investmentValue,
    realized_pnl: realizedPnl,
    unrealized_pnl: unrealizedPnl,
    trailing_stop: trailingStop,
    peak_price: peakPrice,
    peak_gain_pct: peakGainPct,
    qty_total: qtyTotal,
    qty_remaining: qtyRemaining,
    events: sim.events || [],
    dist_from_entry_pct: distFromEntryPct,
    dist_from_stop_pct: distFromStopPct,
    dist_from_target_pct: distFromTargetPct,
    dist_from_target2_pct: distFromTarget2Pct,
    // Price levels for progress bar visualization
    stop_level: stopLoss,
    t1_level: t1,
    t2_level: t2,
    // v2: levels summary with new fields
    levels_summary: levelsSummary
  };
}

/**
 * GET /api/v1/weekly-watchlist
 * Get current week's watchlist
 */
router.get("/", auth, async (req, res) => {
  try {
    const now = new Date();
    console.log(`[WEEKLY-WATCHLIST] GET request at ${now.toISOString()}`);
    console.log(`[WEEKLY-WATCHLIST] Day of week: ${now.getDay()} (0=Sun, 5=Fri, 6=Sat)`);

    const watchlist = await WeeklyWatchlist.getCurrentWeek();

    if (!watchlist) {
      console.log(`[WEEKLY-WATCHLIST] No watchlist found for current week`);
      return res.json({
        success: true,
        watchlist: null,
        message: "No watchlist for current week. Add stocks to create one."
      });
    }

    console.log(`[WEEKLY-WATCHLIST] Found watchlist: ${watchlist.week_label}`);
    console.log(`[WEEKLY-WATCHLIST] week_start: ${watchlist.week_start?.toISOString()}`);
    console.log(`[WEEKLY-WATCHLIST] week_end: ${watchlist.week_end?.toISOString()}`);
    console.log(`[WEEKLY-WATCHLIST] stocks count: ${watchlist.stocks?.length || 0}`);
    console.log(`[WEEKLY-WATCHLIST] Is now (${now.toISOString()}) between week_start and week_end?`);
    console.log(`[WEEKLY-WATCHLIST] now >= week_start: ${now >= watchlist.week_start}`);
    console.log(`[WEEKLY-WATCHLIST] now <= week_end: ${now <= watchlist.week_end}`);
    console.log(`[WEEKLY-WATCHLIST] week_end already passed: ${now > watchlist.week_end}`)

    // Track if any stock needs DB update (intraday trigger detected)
    let needsSave = false;

    // Enrich with current prices (real-time from Upstox API)
    const enrichedStocks = await Promise.all(watchlist.stocks.map(async (stock) => {
      let currentPrice = null;

      try {
        // Try real-time price first
        currentPrice = await getCurrentPrice(stock.instrument_key);
      } catch (priceError) {
        console.warn(`Failed to get real-time price for ${stock.symbol}:`, priceError.message);
      }

      // Fallback to cached price if real-time fails
      if (!currentPrice) {
        const priceDoc = await LatestPrice.findOne({ instrument_key: stock.instrument_key });
        currentPrice = priceDoc?.last_traded_price || priceDoc?.close;
      }

      // If cache price seems stale (doesn't match recent snapshot), prefer last snapshot's close
      // This handles the case when market is closed and LatestPrice wasn't updated after 4PM job
      console.log(`[PRICE-FIX] ${stock.symbol}: Checking for stale price. currentPrice=${currentPrice}, snapshots=${stock.daily_snapshots?.length || 0}`);
      if (stock.daily_snapshots?.length > 0 && currentPrice) {
        const lastSnapshot = stock.daily_snapshots[stock.daily_snapshots.length - 1];
        const lastSnapshotClose = lastSnapshot.close;

        // Check if cached price is from before the last snapshot (stale)
        // If the difference is > 5%, the cache is likely stale
        const priceDiffPct = Math.abs((currentPrice - lastSnapshotClose) / lastSnapshotClose) * 100;
        console.log(`[PRICE-FIX] ${stock.symbol}: lastSnapshotClose=${lastSnapshotClose}, priceDiffPct=${priceDiffPct.toFixed(1)}%`);
        if (priceDiffPct > 5) {
          console.log(`[PRICE-FIX] ${stock.symbol}: FIXING! Cache price ₹${currentPrice} → last snapshot close ₹${lastSnapshotClose}`);
          currentPrice = lastSnapshotClose;
        }
      }
      console.log(`[PRICE-FIX] ${stock.symbol}: Final currentPrice=${currentPrice}`);

      // Check for intraday triggers (entry/stop/target hit today before 4PM job)
      // This updates stock.trade_simulation and stock.daily_snapshots in place
      // Pass week_start for historical backfill (Monday of current trading week)
      const triggered = await checkIntradayTriggers(stock, currentPrice, watchlist.week_start);
      if (triggered) {
        needsSave = true;
      }

      let zoneStatus = null;
      if (currentPrice && stock.entry_zone) {
        zoneStatus = checkEntryZoneProximity(currentPrice, stock.entry_zone);
      }

      // Calculate card_display for trade journey visualization
      const cardDisplay = calculateCardDisplay(stock, currentPrice);

      return {
        ...stock.toObject(),
        current_price: currentPrice || null,
        zone_status: zoneStatus,
        card_display: cardDisplay
      };
    }));

    // Save watchlist if any intraday triggers were detected
    if (needsSave) {
      await watchlist.save();
      console.log(`[WEEKLY-WATCHLIST] Saved intraday simulation updates`);
    }

    res.json({
      success: true,
      watchlist: {
        ...watchlist.toObject(),
        stocks: enrichedStocks
      },
      score_explanations: SCORE_EXPLANATIONS
    });
  } catch (error) {
    console.error("Error fetching weekly watchlist:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/weekly-watchlist/add-stock
 * Add stock to current week's watchlist
 */
router.post("/add-stock", auth, async (req, res) => {
  try {
    const { instrument_key, symbol, stock_name, screening_data, reason } = req.body;

    if (!instrument_key || !symbol) {
      return res.status(400).json({ success: false, error: "instrument_key and symbol required" });
    }

    // Calculate setup score if screening data provided
    let setup_score = 50; // default
    let score_breakdown = null;
    let entry_zone = null;

    if (screening_data) {
      const scoreResult = calculateSetupScore(screening_data);
      setup_score = scoreResult.score;
      score_breakdown = scoreResult.breakdown;
      entry_zone = getEntryZone(screening_data);
    }

    const result = await WeeklyWatchlist.addStockToWeek(req.user._id, {
      instrument_key,
      symbol,
      stock_name,
      selection_reason: reason || "Manual add",
      setup_score,
      screening_data,
      entry_zone,
      status: "WATCHING"
    });

    if (!result.added) {
      return res.status(400).json({ success: false, error: result.reason });
    }

    res.json({
      success: true,
      message: `${symbol} added to weekly watchlist`,
      setup_score,
      score_breakdown,
      entry_zone,
      watchlist: result.watchlist
    });
  } catch (error) {
    console.error("Error adding stock to watchlist:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/weekly-watchlist/:stockId/update-status
 * Update a stock's status in the watchlist
 */
router.post("/:stockId/update-status", auth, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ["WATCHING", "APPROACHING", "TRIGGERED", "ENTERED", "SKIPPED", "EXPIRED"];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid status. Use: ${validStatuses.join(", ")}`
      });
    }

    const watchlist = await WeeklyWatchlist.getCurrentWeek();
    if (!watchlist) {
      return res.status(404).json({ success: false, error: "No active watchlist" });
    }

    const stock = watchlist.stocks.id(req.params.stockId);
    if (!stock) {
      return res.status(404).json({ success: false, error: "Stock not found in watchlist" });
    }

    stock.status = status;
    await watchlist.save();

    res.json({ success: true, message: `Status updated to ${status}`, stock });
  } catch (error) {
    console.error("Error updating stock status:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/weekly-watchlist/:stockId/notes
 * Update notes for a stock
 */
router.post("/:stockId/notes", auth, async (req, res) => {
  try {
    const { user_notes } = req.body;

    const watchlist = await WeeklyWatchlist.getCurrentWeek();
    if (!watchlist) {
      return res.status(404).json({ success: false, error: "No active watchlist" });
    }

    const stock = watchlist.stocks.id(req.params.stockId);
    if (!stock) {
      return res.status(404).json({ success: false, error: "Stock not found in watchlist" });
    }

    stock.user_notes = user_notes;
    await watchlist.save();

    res.json({ success: true, message: "Notes updated", stock });
  } catch (error) {
    console.error("Error updating stock notes:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/weekly-watchlist/:stockId/alert
 * Set price alert for a stock
 */
router.post("/:stockId/alert", auth, async (req, res) => {
  try {
    const { alert_price } = req.body;

    if (!alert_price || typeof alert_price !== "number") {
      return res.status(400).json({ success: false, error: "alert_price required and must be a number" });
    }

    const watchlist = await WeeklyWatchlist.getCurrentWeek();
    if (!watchlist) {
      return res.status(404).json({ success: false, error: "No active watchlist" });
    }

    const stock = watchlist.stocks.id(req.params.stockId);
    if (!stock) {
      return res.status(404).json({ success: false, error: "Stock not found in watchlist" });
    }

    stock.alert_price = alert_price;
    await watchlist.save();

    res.json({
      success: true,
      message: `Alert set at ₹${alert_price} for ${stock.symbol}`,
      stock
    });
  } catch (error) {
    console.error("Error setting alert:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/v1/weekly-watchlist/:stockId
 * Remove stock from watchlist
 */
router.delete("/:stockId", auth, async (req, res) => {
  try {
    const watchlist = await WeeklyWatchlist.getCurrentWeek();
    if (!watchlist) {
      return res.status(404).json({ success: false, error: "No active watchlist" });
    }

    const stock = watchlist.stocks.id(req.params.stockId);
    if (!stock) {
      return res.status(404).json({ success: false, error: "Stock not found in watchlist" });
    }

    const symbol = stock.symbol;
    watchlist.stocks.pull(req.params.stockId);
    await watchlist.save();

    res.json({ success: true, message: `${symbol} removed from watchlist` });
  } catch (error) {
    console.error("Error removing stock:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/weekly-watchlist/history
 * Get past weeks' watchlists
 */
router.get("/history", auth, async (req, res) => {
  try {
    const { limit = 4 } = req.query;

    const watchlists = await WeeklyWatchlist.find({
      user_id: req.user._id,
      status: { $in: ["COMPLETED", "ARCHIVED"] }
    })
      .sort({ week_start: -1 })
      .limit(parseInt(limit));

    res.json({ success: true, watchlists });
  } catch (error) {
    console.error("Error fetching watchlist history:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/weekly-watchlist/stats
 * Get stats across all watchlists
 */
router.get("/stats", auth, async (req, res) => {
  try {
    const watchlists = await WeeklyWatchlist.find({
      user_id: req.user._id,
      status: "COMPLETED"
    });

    const totalWeeks = watchlists.length;
    const totalStocksTracked = watchlists.reduce((sum, w) => sum + w.stocks.length, 0);
    const totalEntered = watchlists.reduce((sum, w) => sum + w.week_summary.stocks_entered, 0);
    const totalTriggered = watchlists.reduce((sum, w) => sum + w.week_summary.stocks_triggered, 0);

    const avgScores = watchlists
      .map(w => w.week_summary.avg_setup_score)
      .filter(s => typeof s === "number");
    const overallAvgScore = avgScores.length > 0
      ? Math.round(avgScores.reduce((a, b) => a + b, 0) / avgScores.length)
      : null;

    res.json({
      success: true,
      stats: {
        total_weeks: totalWeeks,
        total_stocks_tracked: totalStocksTracked,
        total_entered: totalEntered,
        total_triggered: totalTriggered,
        conversion_rate: totalTriggered > 0 ? Math.round((totalEntered / totalTriggered) * 100) : 0,
        avg_setup_score: overallAvgScore
      }
    });
  } catch (error) {
    console.error("Error fetching stats:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/weekly-watchlist/complete-week
 * Manually complete the current week (admin/testing)
 */
router.post("/complete-week", auth, async (req, res) => {
  try {
    const watchlist = await WeeklyWatchlist.getCurrentWeek();
    if (!watchlist) {
      return res.status(404).json({ success: false, error: "No active watchlist" });
    }

    await watchlist.completeWeek();

    res.json({
      success: true,
      message: "Week completed",
      summary: watchlist.week_summary
    });
  } catch (error) {
    console.error("Error completing week:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
