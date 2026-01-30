import express from "express";
import WeeklyWatchlist from "../models/weeklyWatchlist.js";
import LatestPrice from "../models/latestPrice.js";
import { auth } from "../middleware/auth.js";
import { calculateSetupScore, getEntryZone, checkEntryZoneProximity } from "../engine/index.js";
import { getCurrentPrice } from "../utils/stockDb.js";

const router = express.Router();

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

      let zoneStatus = null;
      if (currentPrice && stock.entry_zone) {
        zoneStatus = checkEntryZoneProximity(currentPrice, stock.entry_zone);
      }

      return {
        ...stock.toObject(),
        current_price: currentPrice || null,
        zone_status: zoneStatus
      };
    }));

    res.json({
      success: true,
      watchlist: {
        ...watchlist.toObject(),
        stocks: enrichedStocks
      }
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
