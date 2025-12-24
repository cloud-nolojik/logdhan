import express from "express";
import TradeJournal from "../models/tradeJournal.js";
import UserPosition from "../models/userPosition.js";
import { auth } from "../middleware/auth.js";

const router = express.Router();

/**
 * GET /api/v1/journal
 * Get all journal entries for user
 */
router.get("/", auth, async (req, res) => {
  try {
    const { status, limit = 20, offset = 0, tag, setup_type } = req.query;

    const query = { user_id: req.user._id };

    if (status) {
      query.status = status.toUpperCase();
    }
    if (tag) {
      query.tags = tag;
    }
    if (setup_type) {
      query["entry.setup_type"] = setup_type;
    }

    const [entries, total] = await Promise.all([
      TradeJournal.find(query)
        .sort({ "entry.date": -1 })
        .skip(parseInt(offset))
        .limit(parseInt(limit))
        .lean(),
      TradeJournal.countDocuments(query)
    ]);

    res.json({
      success: true,
      entries,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: parseInt(offset) + entries.length < total
      }
    });

  } catch (error) {
    console.error("Error fetching journal entries:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/journal/:id
 * Get single journal entry
 */
router.get("/:id", auth, async (req, res) => {
  try {
    const entry = await TradeJournal.findOne({
      _id: req.params.id,
      user_id: req.user._id
    });

    if (!entry) {
      return res.status(404).json({ success: false, error: "Journal entry not found" });
    }

    res.json({ success: true, entry });

  } catch (error) {
    console.error("Error fetching journal entry:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/journal
 * Create new journal entry
 */
router.post("/", auth, async (req, res) => {
  try {
    const {
      instrument_key,
      symbol,
      stock_name,
      trade_type = "SWING",
      entry,
      execution,
      emotions,
      tags
    } = req.body;

    // Validate required fields
    if (!instrument_key || !symbol || !entry?.price || !entry?.quantity) {
      return res.status(400).json({
        success: false,
        error: "instrument_key, symbol, entry.price, and entry.quantity are required"
      });
    }

    const journalEntry = await TradeJournal.create({
      user_id: req.user._id,
      instrument_key,
      symbol,
      stock_name,
      trade_type,
      entry: {
        date: entry.date || new Date(),
        price: entry.price,
        quantity: entry.quantity,
        planned_sl: entry.planned_sl,
        planned_target: entry.planned_target,
        planned_risk_pct: entry.planned_risk_pct,
        setup_type: entry.setup_type,
        entry_trigger: entry.entry_trigger,
        setup_score: entry.setup_score,
        notes: entry.notes,
        confidence_level: entry.confidence_level
      },
      execution: execution || {},
      emotions: emotions || {},
      tags: tags || [],
      status: "OPEN"
    });

    res.status(201).json({
      success: true,
      message: "Journal entry created",
      entry: journalEntry
    });

  } catch (error) {
    console.error("Error creating journal entry:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/journal/from-position/:positionId
 * Create journal entry from existing position
 */
router.post("/from-position/:positionId", auth, async (req, res) => {
  try {
    const position = await UserPosition.findOne({
      _id: req.params.positionId,
      user_id: req.user._id
    });

    if (!position) {
      return res.status(404).json({ success: false, error: "Position not found" });
    }

    // Check if journal already exists for this position
    const existing = await TradeJournal.findOne({
      position_id: position._id,
      user_id: req.user._id
    });

    if (existing) {
      return res.json({
        success: true,
        message: "Journal entry already exists",
        entry: existing
      });
    }

    // Create from position
    const journalEntry = await TradeJournal.createFromPosition(position);

    res.status(201).json({
      success: true,
      message: "Journal entry created from position",
      entry: journalEntry
    });

  } catch (error) {
    console.error("Error creating journal from position:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/journal/:id/exit
 * Record exit for a journal entry
 */
router.post("/:id/exit", auth, async (req, res) => {
  try {
    const entry = await TradeJournal.findOne({
      _id: req.params.id,
      user_id: req.user._id
    });

    if (!entry) {
      return res.status(404).json({ success: false, error: "Journal entry not found" });
    }

    if (entry.status === "CLOSED") {
      return res.status(400).json({ success: false, error: "Trade already closed" });
    }

    const {
      price,
      quantity,
      exit_type,
      exit_trigger,
      notes,
      mae,
      mfe,
      brokerage,
      taxes,
      self_rating,
      followed_plan,
      post_emotion,
      lessons
    } = req.body;

    if (!price) {
      return res.status(400).json({ success: false, error: "exit price is required" });
    }

    await entry.recordExit({
      date: new Date(),
      price,
      quantity: quantity || entry.entry.quantity,
      exit_type,
      exit_trigger,
      notes,
      mae,
      mfe,
      brokerage,
      taxes,
      self_rating,
      followed_plan,
      post_emotion,
      lessons
    });

    res.json({
      success: true,
      message: "Exit recorded",
      entry,
      pnl: entry.pnl
    });

  } catch (error) {
    console.error("Error recording exit:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PATCH /api/v1/journal/:id
 * Update journal entry
 */
router.patch("/:id", auth, async (req, res) => {
  try {
    const entry = await TradeJournal.findOne({
      _id: req.params.id,
      user_id: req.user._id
    });

    if (!entry) {
      return res.status(404).json({ success: false, error: "Journal entry not found" });
    }

    // Update allowed fields
    const {
      tags,
      notes,
      emotions,
      execution,
      charts
    } = req.body;

    if (tags) entry.tags = tags;

    if (notes?.entry) entry.entry.notes = notes.entry;
    if (notes?.exit && entry.exit) entry.exit.notes = notes.exit;

    if (emotions) {
      if (emotions.pre_trade) entry.emotions.pre_trade = emotions.pre_trade;
      if (emotions.during_trade) entry.emotions.during_trade = emotions.during_trade;
      if (emotions.post_trade) entry.emotions.post_trade = emotions.post_trade;
      if (emotions.lessons_learned) entry.emotions.lessons_learned = emotions.lessons_learned;
    }

    if (execution) {
      if (execution.self_rating) entry.execution.self_rating = execution.self_rating;
      if (execution.followed_plan !== undefined) entry.execution.followed_plan = execution.followed_plan;
      if (execution.plan_deviation_notes) entry.execution.plan_deviation_notes = execution.plan_deviation_notes;
    }

    if (charts) entry.charts = charts;

    await entry.save();

    res.json({
      success: true,
      message: "Journal entry updated",
      entry
    });

  } catch (error) {
    console.error("Error updating journal entry:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/v1/journal/:id
 * Delete journal entry
 */
router.delete("/:id", auth, async (req, res) => {
  try {
    const result = await TradeJournal.findOneAndDelete({
      _id: req.params.id,
      user_id: req.user._id
    });

    if (!result) {
      return res.status(404).json({ success: false, error: "Journal entry not found" });
    }

    res.json({
      success: true,
      message: "Journal entry deleted"
    });

  } catch (error) {
    console.error("Error deleting journal entry:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/journal/stats/performance
 * Get overall performance stats
 */
router.get("/stats/performance", auth, async (req, res) => {
  try {
    const { from_date, to_date, tags } = req.query;

    const stats = await TradeJournal.getPerformanceStats(req.user._id, {
      fromDate: from_date,
      toDate: to_date,
      tags: tags ? tags.split(",") : undefined
    });

    res.json({
      success: true,
      stats
    });

  } catch (error) {
    console.error("Error fetching performance stats:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/journal/stats/weekly
 * Get weekly summary
 */
router.get("/stats/weekly", auth, async (req, res) => {
  try {
    const { week } = req.query;

    // Get current week if not specified
    let weekString = week;
    if (!weekString) {
      const now = new Date();
      const year = now.getFullYear();
      const oneJan = new Date(year, 0, 1);
      const weekNum = Math.ceil((((now - oneJan) / 86400000) + oneJan.getDay() + 1) / 7);
      weekString = `${year}-W${weekNum.toString().padStart(2, '0')}`;
    }

    const trades = await TradeJournal.getWeeklyTrades(req.user._id, weekString);

    // Calculate weekly stats
    const closedTrades = trades.filter(t => t.status === "CLOSED");
    const winners = closedTrades.filter(t => t.pnl?.net_pnl > 0);

    const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnl?.net_pnl || 0), 0);
    const rMultiples = closedTrades.map(t => t.pnl?.r_multiple).filter(r => typeof r === 'number');

    res.json({
      success: true,
      week: weekString,
      summary: {
        total_trades: trades.length,
        closed_trades: closedTrades.length,
        open_trades: trades.filter(t => t.status === "OPEN").length,
        winners: winners.length,
        losers: closedTrades.length - winners.length,
        win_rate: closedTrades.length > 0 ? Math.round((winners.length / closedTrades.length) * 100) : 0,
        total_pnl: Math.round(totalPnl * 100) / 100,
        avg_r_multiple: rMultiples.length > 0
          ? Math.round((rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length) * 100) / 100
          : null
      },
      trades
    });

  } catch (error) {
    console.error("Error fetching weekly stats:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/journal/stats/by-month
 * Get monthly breakdown
 */
router.get("/stats/by-month", auth, async (req, res) => {
  try {
    const { year = new Date().getFullYear() } = req.query;

    const trades = await TradeJournal.find({
      user_id: req.user._id,
      status: "CLOSED",
      "entry.date": {
        $gte: new Date(`${year}-01-01`),
        $lte: new Date(`${year}-12-31`)
      }
    }).lean();

    // Group by month
    const monthlyStats = {};

    for (let month = 1; month <= 12; month++) {
      const monthStr = month.toString().padStart(2, '0');
      monthlyStats[`${year}-${monthStr}`] = {
        trades: 0,
        winners: 0,
        total_pnl: 0
      };
    }

    for (const trade of trades) {
      const monthKey = trade.entry.date.toISOString().slice(0, 7);
      if (monthlyStats[monthKey]) {
        monthlyStats[monthKey].trades++;
        if (trade.pnl?.net_pnl > 0) monthlyStats[monthKey].winners++;
        monthlyStats[monthKey].total_pnl += trade.pnl?.net_pnl || 0;
      }
    }

    // Calculate win rate for each month
    for (const month of Object.keys(monthlyStats)) {
      const stats = monthlyStats[month];
      stats.win_rate = stats.trades > 0 ? Math.round((stats.winners / stats.trades) * 100) : 0;
      stats.total_pnl = Math.round(stats.total_pnl * 100) / 100;
    }

    res.json({
      success: true,
      year: parseInt(year),
      months: monthlyStats,
      total_trades: trades.length,
      total_pnl: Math.round(trades.reduce((sum, t) => sum + (t.pnl?.net_pnl || 0), 0) * 100) / 100
    });

  } catch (error) {
    console.error("Error fetching monthly stats:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/journal/tags
 * Get all unique tags used
 */
router.get("/tags/list", auth, async (req, res) => {
  try {
    const tags = await TradeJournal.distinct("tags", { user_id: req.user._id });

    res.json({
      success: true,
      tags: tags.filter(Boolean).sort()
    });

  } catch (error) {
    console.error("Error fetching tags:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
