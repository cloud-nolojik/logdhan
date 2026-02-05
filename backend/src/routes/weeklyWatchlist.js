import express from "express";
import WeeklyWatchlist from "../models/weeklyWatchlist.js";
import { auth } from "../middleware/auth.js";
import { calculateSetupScore, getEntryZone, checkEntryZoneProximity } from "../engine/index.js";
import priceCacheService from "../services/priceCache.service.js";

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
 * Calculate Daily Update card display based on journey_status and tracking_status
 * Returns message, icon, and colors for the banner - frontend just renders
 */
function calculateDailyUpdateCard(journeyStatus, trackingStatus, trackingFlags, _levels, latestSnapshot) {
  const entry = _levels?.entry;
  const stop = _levels?.stop;
  const target1 = _levels?.target1;
  const target = _levels?.target;
  const target2 = _levels?.target2;
  const close = latestSnapshot?.close;

  // Priority 1: Trade simulation states that override tracking_status

  // ENTRY_SIGNALED — signal confirmed, user needs to buy tomorrow
  if (journeyStatus === 'ENTRY_SIGNALED') {
    const premiumPct = (entry && close) ? (((close - entry) / entry) * 100).toFixed(1) : null;
    return {
      icon: 'signal',  // 📡
      message: 'Entry signal confirmed',
      subtext: premiumPct
        ? `Close ₹${close.toFixed(2)} — ${premiumPct}% above entry ₹${entry.toFixed(2)}`
        : `Close ₹${close?.toFixed(2)} confirmed above entry`,
      background_color: '#7C3AED',  // Solid purple
      text_color: '#FFFFFF',
      value_color: '#FFFFFF',
      show_metrics: false
    };
  }

  // FULL_EXIT — trade completed at T2
  if (journeyStatus === 'FULL_EXIT') {
    const totalPnl = latestSnapshot?.sim_total_pnl;
    const isProfit = totalPnl >= 0;
    return {
      icon: isProfit ? 'celebration' : 'error',
      message: isProfit ? 'Trade completed — full target hit' : 'Trade completed',
      subtext: totalPnl != null ? `Final P&L: ${isProfit ? '+' : ''}₹${totalPnl.toFixed(0)}` : 'All positions closed',
      background_color: isProfit ? '#1B5E20' : '#C62828',  // Dark green or dark red
      text_color: '#FFFFFF',
      value_color: '#FFFFFF',
      show_metrics: false
    };
  }

  // STOPPED_OUT — stop loss hit
  if (journeyStatus === 'STOPPED_OUT') {
    return {
      icon: 'error',  // ❌
      message: 'Stop loss triggered',
      subtext: stop ? `Exited at ₹${stop.toFixed(2)}` : 'Position closed at stop',
      background_color: '#C62828',  // Dark red
      text_color: '#FFFFFF',
      value_color: '#FFFFFF',
      show_metrics: false
    };
  }

  // PARTIAL_EXIT — T1 hit, trailing remainder (check if TARGET also hit)
  if (journeyStatus === 'PARTIAL_EXIT') {
    // Check if main target was also hit (tracking_status = TARGET_HIT)
    if (trackingStatus === 'TARGET_HIT') {
      return {
        icon: 'star',  // ⭐
        message: 'Target hit — 70% booked, trailing to T2',
        subtext: target2 ? `T2: ₹${target2.toFixed(2)}` : 'Full target achieved!',
        background_color: '#1B5E20',  // Dark green
        text_color: '#FFFFFF',
        value_color: '#FFFFFF',
        show_metrics: true
      };
    }
    let rsiNote = '';
    if (trackingFlags.includes('RSI_EXIT')) {
      rsiNote = ' — RSI overbought';
    }
    return {
      icon: 'check_circle',  // ✅
      message: `T1 booked — trailing remainder${rsiNote}`,
      subtext: target ? `Next target: ₹${target.toFixed(2)}` : 'Trailing with stop at entry',
      background_color: '#2E7D32',  // Dark green
      text_color: '#FFFFFF',
      value_color: '#FFFFFF',
      show_metrics: true
    };
  }

  // Priority 2: Tracking status for pre-entry and active trade states
  switch (trackingStatus) {
    case 'ENTRY_ZONE':
      return {
        icon: 'login',  // 🎯
        message: 'Price in entry zone',
        subtext: entry ? `Near entry level ₹${entry.toFixed(2)}` : 'Approaching entry level',
        background_color: '#2E7D32',  // Dark green
        text_color: '#FFFFFF',
        value_color: '#FFFFFF',
        show_metrics: true
      };

    case 'ABOVE_ENTRY':
      // Active trade — ENTERED status
      if (journeyStatus === 'ENTERED') {
        let rsiNote = '';
        if (trackingFlags.includes('RSI_EXIT')) {
          rsiNote = ' — RSI overbought';
        } else if (trackingFlags.includes('RSI_DANGER')) {
          rsiNote = ' — RSI elevated';
        }
        return {
          icon: 'trending_up',  // 📈
          message: `Trade running${rsiNote}`,
          subtext: null,  // Distance metrics shown separately
          background_color: '#1565C0',  // Dark blue
          text_color: '#FFFFFF',
          value_color: '#FFFFFF',
          show_metrics: true
        };
      }
      // ABOVE_ENTRY but WAITING — price moved above entry without close confirmation
      if (journeyStatus === 'WAITING') {
        return {
          icon: 'info',  // ℹ️
          message: 'Price above entry — awaiting close confirmation',
          subtext: entry ? `Needs daily close above ₹${entry.toFixed(2)}` : 'Watching for close confirmation',
          background_color: '#E65100',  // Dark orange
          text_color: '#FFFFFF',
          value_color: '#FFFFFF',
          show_metrics: true
        };
      }
      return null;

    case 'RETEST_ZONE':
      return {
        icon: 'refresh',  // 🔄
        message: 'Retesting breakout level',
        subtext: entry ? `Testing support near ₹${entry.toFixed(2)}` : 'Potential re-entry point',
        background_color: '#7B1FA2',  // Dark purple
        text_color: '#FFFFFF',
        value_color: '#FFFFFF',
        show_metrics: true
      };

    case 'BELOW_STOP':
      return {
        icon: 'warning',  // ⚠️
        message: 'Below stop loss level',
        subtext: 'Setup invalidated',
        background_color: '#C62828',  // Dark red
        text_color: '#FFFFFF',
        value_color: '#FFFFFF',
        show_metrics: false
      };

    case 'TARGET1_HIT':
      return {
        icon: 'check_circle',  // ✅
        message: 'T1 hit — 50% booked',
        subtext: target ? `Trailing to target ₹${target.toFixed(2)}` : 'Stop moved to entry',
        background_color: '#2E7D32',  // Dark green
        text_color: '#FFFFFF',
        value_color: '#FFFFFF',
        show_metrics: true
      };

    case 'TARGET_HIT':
      return {
        icon: 'star',  // ⭐
        message: 'Target hit — exit or hold for T2?',
        subtext: target2 ? `T2: ₹${target2.toFixed(2)}` : 'Main target achieved!',
        background_color: '#1B5E20',  // Dark green
        text_color: '#FFFFFF',
        value_color: '#FFFFFF',
        show_metrics: true
      };

    case 'TARGET2_HIT':
      return {
        icon: 'celebration',  // 🎉
        message: 'T2 hit — full target achieved!',
        subtext: 'Trade completed successfully',
        background_color: '#1B5E20',  // Dark green
        text_color: '#FFFFFF',
        value_color: '#FFFFFF',
        show_metrics: false
      };

    case 'WATCHING':
      if (trackingFlags.includes('VOLUME_SPIKE')) {
        return {
          icon: 'bar_chart',  // 📊
          message: 'Volume spike detected',
          subtext: 'Unusual activity — watch for breakout',
          background_color: '#1565C0',  // Dark blue
          text_color: '#FFFFFF',
          value_color: '#FFFFFF',
          show_metrics: false
        };
      }
      if (trackingFlags.includes('APPROACHING_ENTRY')) {
        return {
          icon: 'info',  // ℹ️
          message: 'Approaching entry zone',
          subtext: entry ? `Getting close to ₹${entry.toFixed(2)}` : 'Watch for entry trigger',
          background_color: '#E65100',  // Dark orange
          text_color: '#FFFFFF',
          value_color: '#FFFFFF',
          show_metrics: false
        };
      }
      return null;  // No banner for plain WATCHING

    default:
      return null;
  }
}

/**
 * Calculate card_display for a stock with trade simulation
 * Returns all fields needed for Home Screen card + AI Analysis screen
 */
function calculateCardDisplay(stock, livePrice) {
  const sim = stock.trade_simulation;
  const levels = stock.levels || {};

  // Get the last snapshot date for the Daily Update card
  const snapshots = stock.daily_snapshots || [];
  const lastSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  const lastSnapshotDate = lastSnapshot?.date || null;

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

  // Get tracking status and flags for daily update card
  const trackingStatus = stock.tracking_status || 'WATCHING';
  const trackingFlags = stock.tracking_flags || [];
  const journeyStatus = sim?.status || 'WAITING';

  // Handle ENTRY_SIGNALED status (two-phase entry: signal confirmed, awaiting execution)
  if (sim?.status === 'ENTRY_SIGNALED') {
    const signalClose = sim.signal_close;
    const stopLoss = levels.stop;
    const plannedQty = sim.planned_qty;

    // Find the ENTRY_SIGNAL event to get the recommended qty (may be adjusted for EXTENDED)
    const signalEvent = sim.events?.find(e => e.type === 'ENTRY_SIGNAL');
    const recommendedQty = signalEvent?.qty || plannedQty;

    // Calculate daily update card for ENTRY_SIGNALED
    const dailyUpdateCard = calculateDailyUpdateCard(journeyStatus, trackingStatus, trackingFlags, levels, lastSnapshot);

    return {
      journey_status: 'ENTRY_SIGNALED',
      emoji: '📡',
      headline: 'Entry Signal!',
      subtext: `Buy ${recommendedQty} shares at tomorrow's open. Stop: ₹${stopLoss?.toFixed(2)}`,
      entry_window_hint: null,
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
      events: sim.events || [],
      dist_from_entry_pct: null,
      dist_from_stop_pct: null,
      dist_from_target_pct: null,
      dist_from_target2_pct: null,
      levels_summary: levelsSummary,
      last_snapshot_date: lastSnapshotDate,
      signal_close: signalClose,
      signal_date: sim.signal_date,
      daily_update_card: dailyUpdateCard
    };
  }

  // Default response for stocks without simulation or still waiting for entry
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

    // Calculate daily update card for WAITING status
    const dailyUpdateCard = calculateDailyUpdateCard(journeyStatus, trackingStatus, trackingFlags, levels, lastSnapshot);

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
      levels_summary: levelsSummary,
      last_snapshot_date: lastSnapshotDate,
      daily_update_card: dailyUpdateCard
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
  const totalReturnPct = (totalPnl / capital) * 100;  // ROI on capital

  // Stock gain % - price change from entry to current (more intuitive)
  const stockGainPct = entryPrice > 0 && livePrice ? ((livePrice - entryPrice) / entryPrice) * 100 : 0;

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
  const stockGainSign = stockGainPct >= 0 ? '+' : '';

  switch (sim.status) {
    case 'ENTERED':
      emoji = '🟢';
      headline = 'Entry Triggered';
      subtext = `If you bought ${qtyTotal} shares @ ₹${entryPrice?.toFixed(2)}`;
      pnlLine = `${pnlSign}₹${totalPnl.toFixed(0)} (${stockGainSign}${stockGainPct.toFixed(1)}%)`;
      break;

    case 'PARTIAL_EXIT':
      // Check if main target was also hit
      if (trackingStatus === 'TARGET_HIT') {
        emoji = '⭐';
        headline = 'Target Hit - Trailing to T2';
        const t2Level = stock.levels?.target2;
        subtext = t2Level
          ? `70% booked at Target, ${qtyRemaining} shares trailing to T2 (₹${t2Level.toFixed(2)})`
          : `Target reached! ${qtyRemaining} shares remaining`;
      } else {
        emoji = '🟡';
        headline = 'T1 Hit - Trailing Stop';
        subtext = `50% booked at T1, ${qtyRemaining} shares trailing with SL @ ₹${trailingStop?.toFixed(2)}`;
      }
      pnlLine = `${pnlSign}₹${totalPnl.toFixed(0)} (${stockGainSign}${stockGainPct.toFixed(1)}%)`;
      break;

    case 'FULL_EXIT':
      emoji = '🎯';
      headline = 'Full Target Hit';
      subtext = 'Both T1 & T2 achieved';
      pnlLine = `${pnlSign}₹${realizedPnl.toFixed(0)} (${stockGainSign}${stockGainPct.toFixed(1)}%)`;
      break;

    case 'STOPPED_OUT':
      emoji = '🔴';
      headline = 'Stop Loss Hit';
      const lastEvent = sim.events?.[sim.events.length - 1];
      subtext = lastEvent?.detail || 'Stop loss triggered';
      pnlLine = `${pnlSign}₹${realizedPnl.toFixed(0)} (${stockGainSign}${stockGainPct.toFixed(1)}%)`;
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
        pnlLine = `${pnlSign}₹${totalPnl.toFixed(0)} (${stockGainSign}${stockGainPct.toFixed(1)}%)`;
      } else {
        headline = 'Trade Completed';
        subtext = 'Trade completed before expiry';
        pnlLine = `${pnlSign}₹${totalPnl.toFixed(0)} (${stockGainSign}${stockGainPct.toFixed(1)}%)`;
      }
      break;

    default:
      emoji = '❓';
      headline = 'Unknown Status';
      subtext = sim.status;
      pnlLine = null;
  }

  // Calculate daily update card for active trade statuses
  const dailyUpdateCard = calculateDailyUpdateCard(journeyStatus, trackingStatus, trackingFlags, levels, lastSnapshot);

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
    total_return_pct: totalReturnPct,      // ROI on ₹1L capital
    stock_gain_pct: stockGainPct,          // Stock price gain % (entry vs current)
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
    levels_summary: levelsSummary,
    last_snapshot_date: lastSnapshotDate,
    daily_update_card: dailyUpdateCard
  };
}

/**
 * GET /api/v1/weekly-watchlist
 * Get current week's watchlist (pure read, no simulation updates)
 *
 * Simulation updates are handled by:
 * - 4 PM Daily Tracking Job (EOD data, close-based entry)
 * - 15-min Intraday Monitor Job (stop/T1/T2 alerts during market hours)
 */
router.get("/", auth, async (req, res) => {
  try {
    const watchlist = await WeeklyWatchlist.getCurrentWeek();

    if (!watchlist) {
      return res.json({
        success: true,
        watchlist: null,
        message: "No watchlist for current week. Add stocks to create one."
      });
    }

    // Fetch all prices at once using price cache service
    const instrumentKeys = watchlist.stocks.map(stock => stock.instrument_key);
    const priceDataMap = await priceCacheService.getLatestPricesWithChange(instrumentKeys);

    // Enrich stocks with current prices and card_display (no DB writes)
    const enrichedStocks = watchlist.stocks.map((stock) => {
      const currentPrice = priceDataMap[stock.instrument_key]?.price || null;

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
    });

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
