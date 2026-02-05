import express from "express";
import LatestPrice from "../models/latestPrice.js";
import { auth } from "../middleware/auth.js";
import { round2 } from "../engine/index.js";

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
 * Deprecated - returns success response only
 */
router.get("/morning-glance", auth, async (req, res) => {
  res.json({ success: true });
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
