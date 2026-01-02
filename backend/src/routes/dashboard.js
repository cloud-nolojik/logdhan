import express from "express";
import UserPosition from "../models/userPosition.js";
import LatestPrice from "../models/latestPrice.js";
import { auth } from "../middleware/auth.js";
import { checkExitConditions, round2 } from "../engine/index.js";

const router = express.Router();

/**
 * Get time-appropriate greeting
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/**
 * GET /api/v1/dashboard/morning-glance
 * Quick 30-second status for busy traders
 */
router.get("/morning-glance", auth, async (req, res) => {
  try {
    const user_id = req.user._id;
    console.log("📊 [MORNING GLANCE] User ID:", user_id);
    console.log("📊 [MORNING GLANCE] User watchlist length:", req.user?.watchlist?.length || 0);
    console.log("📊 [MORNING GLANCE] User watchlist:", JSON.stringify(req.user?.watchlist?.map(w => w.trading_symbol) || []));

    // 1. Get open positions
    const positions = await UserPosition.findAllOpenPositions(user_id);

    // 2. Enrich positions with current price and status
    const positionSummaries = await Promise.all(positions.map(async (pos) => {
      const priceDoc = await LatestPrice.findOne({ instrument_key: pos.instrument_key });
      const current_price = priceDoc?.last_traded_price || priceDoc?.close || pos.actual_entry;
      const pnl = pos.calculateUnrealizedPnl(current_price);
      const isExecuted = pos.execution_status === "EXECUTED";

      // Quick status check - only relevant for executed positions
      const alerts = isExecuted ? checkExitConditions({
        position: {
          actual_entry: pos.actual_entry,
          current_sl: pos.current_sl,
          current_target: pos.current_target
        },
        current_price
      }) : [];

      // Determine status emoji and message
      let status_emoji = "✅";
      let status_text = "Structure intact";
      let needs_attention = false;

      // Only check alerts for executed positions
      if (!isExecuted) {
        status_emoji = "⏳";
        status_text = "Order pending";
        needs_attention = false; // Pending orders don't need attention
      } else if (alerts.some(a => a.type === "STOP_HIT")) {
        status_emoji = "🔴";
        status_text = "Stop hit - Exit";
        needs_attention = true;
      } else if (alerts.some(a => a.type === "NEAR_STOP")) {
        status_emoji = "⚠️";
        status_text = `Watch ₹${pos.current_sl} support`;
        needs_attention = true;
      } else if (alerts.some(a => a.type === "NEAR_TARGET" || a.type === "BEYOND_TARGET")) {
        status_emoji = "🎯";
        status_text = "Near target - Consider profit";
        needs_attention = true;
      } else if (pnl.unrealized_pnl_pct < -2) {
        status_emoji = "⚠️";
        status_text = "In drawdown";
      } else if (pnl.unrealized_pnl_pct > 2) {
        status_emoji = "📈";
        status_text = "In profit - Trail stop?";
      }

      return {
        symbol: pos.symbol,
        pnl_pct: isExecuted ? pnl.unrealized_pnl_pct : 0,
        pnl_inr: isExecuted ? pnl.unrealized_pnl : 0,
        current_price,
        status_emoji,
        status_text,
        needs_attention,
        days_held: pos.days_in_trade,
        execution_status: pos.execution_status || "PENDING"
      };
    }));

    // 3. Get user's personal watchlist and generate alerts
    const userWatchlist = req.user?.watchlist || [];
    const watchlistAlerts = [];

    // Generate watchlist alerts from user's watchlist stocks
    for (const stock of userWatchlist) {
      try {
        const priceDoc = await LatestPrice.findOne({ instrument_key: stock.instrument_key });
        const currentPrice = priceDoc?.last_traded_price || priceDoc?.close;

        if (currentPrice) {
          // Show each watchlist stock with current price info
          watchlistAlerts.push({
            symbol: stock.trading_symbol,
            message: `₹${round2(currentPrice)}`,
            type: "WATCHING",
            urgency: "low"
          });
        }
      } catch (err) {
        console.warn(`Failed to get price for watchlist stock ${stock.trading_symbol}:`, err.message);
      }
    }

    // 4. Calculate overall status (only executed positions count towards P&L)
    const executedPositions = positionSummaries.filter(p => p.execution_status === "EXECUTED");
    const pendingPositions = positionSummaries.filter(p => p.execution_status === "PENDING");
    const totalPnl = executedPositions.reduce((sum, p) => sum + p.pnl_inr, 0);
    const needsAttention = positionSummaries.filter(p => p.needs_attention).length;

    // 5. Generate market vibe (simple heuristic)
    let marketVibe = "Markets steady, follow your plan";
    if (needsAttention > 0) {
      marketVibe = `${needsAttention} position(s) need attention`;
    } else if (totalPnl > 0) {
      marketVibe = "Positions looking good, stay patient";
    } else if (totalPnl < 0) {
      marketVibe = "Some drawdown, but structure intact";
    }

    res.json({
      success: true,
      glance: {
        // Header
        greeting: getGreeting(),
        date: new Date().toLocaleDateString('en-IN', {
          weekday: 'long',
          month: 'short',
          day: 'numeric'
        }),

        // Positions summary (only executed positions)
        positions: {
          count: executedPositions.length,
          total_pnl_inr: round2(totalPnl),
          items: executedPositions
        },

        // Pending positions (not yet executed with broker)
        pending_positions: {
          count: pendingPositions.length,
          items: pendingPositions
        },

        // Watchlist alerts
        watchlist_alerts: watchlistAlerts,

        // Overall
        action_needed: needsAttention > 0 || watchlistAlerts.some(a => a.urgency === "high"),
        market_vibe: marketVibe,

        // Quick stats
        stats: {
          open_positions: executedPositions.length,
          pending_positions: pendingPositions.length,
          positions_in_profit: executedPositions.filter(p => p.pnl_pct > 0).length,
          watchlist_stocks: userWatchlist.length,
          alerts_count: watchlistAlerts.length
        }
      }
    });

  } catch (error) {
    console.error("Morning glance error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/dashboard/should-i-buy
 * Quick check if now is a good time to enter
 */
router.post("/should-i-buy", auth, async (req, res) => {
  try {
    const { instrument_key } = req.body;

    if (!instrument_key) {
      return res.status(400).json({ success: false, error: "instrument_key required" });
    }

    // 1. Check if already have position
    const existingPosition = await UserPosition.findOpenPosition(req.user._id, instrument_key);
    if (existingPosition) {
      return res.json({
        success: true,
        verdict: "NO",
        reason: "You already have an open position in this stock",
        existing_position: {
          entry: existingPosition.actual_entry,
          current_sl: existingPosition.current_sl,
          days_held: existingPosition.days_in_trade
        }
      });
    }

    // 2. Get current price and indicators
    const priceDoc = await LatestPrice.findOne({ instrument_key });
    if (!priceDoc) {
      return res.status(404).json({ success: false, error: "Price data not available" });
    }

    const current_price = priceDoc.last_traded_price || priceDoc.close;

    // 3. Get stock data from price cache or use defaults
    // Note: These may come from a separate indicators collection in production
    const dma20 = priceDoc.ema20 || priceDoc.dma20;
    const dma50 = priceDoc.ema50 || priceDoc.dma50;
    const rsi = priceDoc.rsi;
    const atr = priceDoc.atr;

    // 4. Evaluate entry quality
    const evaluation = evaluateEntryQuality({
      current_price,
      dma20,
      dma50,
      rsi,
      atr
    });

    // 5. Suggest better entry if not ideal
    let better_entry = null;
    if (evaluation.verdict !== "YES" && dma20) {
      better_entry = round2(dma20);
    }

    res.json({
      success: true,
      symbol: priceDoc.stock_symbol || instrument_key,
      current_price,
      ...evaluation,
      better_entry,
      set_alert_at: better_entry,
      indicators: {
        dma20: dma20 ? round2(dma20) : null,
        dma50: dma50 ? round2(dma50) : null,
        rsi: rsi ? round2(rsi) : null,
        atr: atr ? round2(atr) : null
      }
    });

  } catch (error) {
    console.error("Should I buy error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Evaluate entry quality based on technical indicators
 */
function evaluateEntryQuality({ current_price, dma20, dma50, rsi, atr }) {
  const issues = [];
  const positives = [];

  // Check distance from 20 DMA
  if (dma20) {
    const distFrom20 = ((current_price - dma20) / dma20) * 100;

    if (distFrom20 > 5) {
      issues.push({
        factor: "Extended from average",
        detail: `Price is ${distFrom20.toFixed(1)}% above 20-day average`,
        severity: "high"
      });
    } else if (distFrom20 > 3) {
      issues.push({
        factor: "Slightly extended",
        detail: `Price is ${distFrom20.toFixed(1)}% above 20-day average`,
        severity: "medium"
      });
    } else if (distFrom20 >= 0 && distFrom20 <= 3) {
      positives.push({
        factor: "Good entry zone",
        detail: `Price is close to 20-day average (${distFrom20.toFixed(1)}% above)`
      });
    } else if (distFrom20 < 0 && distFrom20 >= -3) {
      positives.push({
        factor: "Pullback entry",
        detail: `Price is ${Math.abs(distFrom20).toFixed(1)}% below 20-day average`
      });
    }
  }

  // Check RSI
  if (rsi) {
    if (rsi > 70) {
      issues.push({
        factor: "Overbought",
        detail: `RSI at ${rsi.toFixed(0)} indicates overbought conditions`,
        severity: "high"
      });
    } else if (rsi > 65) {
      issues.push({
        factor: "RSI elevated",
        detail: `RSI at ${rsi.toFixed(0)} is getting stretched`,
        severity: "medium"
      });
    } else if (rsi >= 50 && rsi <= 65) {
      positives.push({
        factor: "Healthy momentum",
        detail: `RSI at ${rsi.toFixed(0)} shows good momentum without overextension`
      });
    }
  }

  // Check if in uptrend
  if (dma20 && dma50 && current_price) {
    if (current_price > dma20 && dma20 > dma50) {
      positives.push({
        factor: "In uptrend",
        detail: "Price above 20 DMA, 20 DMA above 50 DMA"
      });
    } else if (current_price < dma20) {
      issues.push({
        factor: "Below short-term average",
        detail: "Price below 20 DMA may indicate weakness",
        severity: "medium"
      });
    }
  }

  // Calculate risk if entering now
  let risk_assessment = null;
  if (atr && dma20) {
    const suggestedSL = Math.max(dma20 - atr, current_price - 1.5 * atr);
    const riskPct = ((current_price - suggestedSL) / current_price) * 100;

    if (riskPct > 4) {
      issues.push({
        factor: "Wide stop required",
        detail: `Stop loss would need to be ${riskPct.toFixed(1)}% away`,
        severity: "medium"
      });
    }

    risk_assessment = {
      suggested_sl: round2(suggestedSL),
      risk_pct: round2(riskPct)
    };
  }

  // Determine verdict
  let verdict = "YES";
  let confidence = "high";
  let reason = "";

  const highSeverityIssues = issues.filter(i => i.severity === "high").length;
  const mediumSeverityIssues = issues.filter(i => i.severity === "medium").length;

  if (highSeverityIssues >= 1) {
    verdict = "NO";
    confidence = "high";
    reason = issues.find(i => i.severity === "high").detail;
  } else if (mediumSeverityIssues >= 2) {
    verdict = "WAIT";
    confidence = "medium";
    reason = "Multiple caution flags. Wait for better entry.";
  } else if (mediumSeverityIssues === 1) {
    verdict = "WAIT";
    confidence = "low";
    reason = issues[0]?.detail || "Slightly extended. Consider waiting.";
  } else if (positives.length >= 2) {
    verdict = "YES";
    confidence = "high";
    reason = "Good entry conditions. Structure supports the trade.";
  } else {
    verdict = "YES";
    confidence = "medium";
    reason = "Acceptable entry. Follow your plan.";
  }

  return {
    verdict,
    confidence,
    reason,
    issues,
    positives,
    risk_assessment
  };
}

export default router;
