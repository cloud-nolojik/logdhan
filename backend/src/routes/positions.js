import express from "express";
import UserPosition from "../models/userPosition.js";
import LatestPrice from "../models/latestPrice.js";
import { calculateTrailingStop, checkExitConditions, calculateRiskReduction } from "../utils/trailingStopLoss.js";
import { auth } from "../middleware/auth.js";

const router = express.Router();

/**
 * GET /api/v1/positions
 * List all open positions for authenticated user
 */
router.get("/", auth, async (req, res) => {
  try {
    const positions = await UserPosition.findAllOpenPositions(req.user._id);

    res.json({
      success: true,
      count: positions.length,
      positions: positions.map(p => ({
        id: p._id,
        symbol: p.symbol,
        instrument_key: p.instrument_key,
        actual_entry: p.actual_entry,
        qty: p.qty,
        current_sl: p.current_sl,
        current_target: p.current_target,
        entered_at: p.entered_at,
        days_in_trade: p.days_in_trade,
        original_analysis: p.original_analysis,
        sl_trail_count: p.sl_trail_history.length
      }))
    });
  } catch (error) {
    console.error("Error fetching positions:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch positions",
      error: error.message
    });
  }
});

/**
 * GET /api/v1/positions/history
 * List closed positions for authenticated user
 */
router.get("/history", auth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const skip = parseInt(req.query.skip) || 0;

    const positions = await UserPosition.find({
      user_id: req.user._id,
      status: "CLOSED"
    })
      .sort({ closed_at: -1 })
      .skip(skip)
      .limit(limit);

    const total = await UserPosition.countDocuments({
      user_id: req.user._id,
      status: "CLOSED"
    });

    res.json({
      success: true,
      count: positions.length,
      total,
      positions: positions.map(p => ({
        id: p._id,
        symbol: p.symbol,
        actual_entry: p.actual_entry,
        exit_price: p.exit_price,
        qty: p.qty,
        realized_pnl: p.realized_pnl,
        realized_pnl_pct: p.realized_pnl_pct,
        close_reason: p.close_reason,
        entered_at: p.entered_at,
        closed_at: p.closed_at,
        days_in_trade: p.days_in_trade
      }))
    });
  } catch (error) {
    console.error("Error fetching position history:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch position history",
      error: error.message
    });
  }
});

/**
 * GET /api/v1/positions/:id
 * Get detailed position information
 */
router.get("/:id", auth, async (req, res) => {
  try {
    const position = await UserPosition.findOne({
      _id: req.params.id,
      user_id: req.user._id
    });

    if (!position) {
      return res.status(404).json({
        success: false,
        message: "Position not found"
      });
    }

    res.json({
      success: true,
      position: {
        id: position._id,
        symbol: position.symbol,
        instrument_key: position.instrument_key,
        status: position.status,
        actual_entry: position.actual_entry,
        qty: position.qty,
        current_sl: position.current_sl,
        current_target: position.current_target,
        entered_at: position.entered_at,
        days_in_trade: position.days_in_trade,
        original_analysis: position.original_analysis,
        sl_trail_history: position.sl_trail_history,
        linked_orders: position.linked_orders,
        // Closed position fields
        closed_at: position.closed_at,
        close_reason: position.close_reason,
        exit_price: position.exit_price,
        realized_pnl: position.realized_pnl,
        realized_pnl_pct: position.realized_pnl_pct
      }
    });
  } catch (error) {
    console.error("Error fetching position:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch position",
      error: error.message
    });
  }
});

/**
 * POST /api/v1/positions/:id/check-trail
 * Check if trailing stop is recommended based on current price
 */
router.post("/:id/check-trail", auth, async (req, res) => {
  try {
    const { current_price, atr, swing_low, ema20 } = req.body;

    if (!current_price || typeof current_price !== "number") {
      return res.status(400).json({
        success: false,
        message: "current_price is required and must be a number"
      });
    }

    const position = await UserPosition.findOne({
      _id: req.params.id,
      user_id: req.user._id,
      status: "OPEN"
    });

    if (!position) {
      return res.status(404).json({
        success: false,
        message: "Open position not found"
      });
    }

    // Calculate trailing recommendation
    const trailResult = calculateTrailingStop({
      position: {
        actual_entry: position.actual_entry,
        current_sl: position.current_sl,
        current_target: position.current_target
      },
      current_price,
      atr,
      swing_low,
      ema20
    });

    // Check exit conditions
    const alerts = checkExitConditions({
      position: {
        actual_entry: position.actual_entry,
        current_sl: position.current_sl,
        current_target: position.current_target
      },
      current_price,
      atr
    });

    // Calculate risk reduction if trailing is recommended
    let riskReduction = null;
    if (trailResult.should_trail) {
      riskReduction = calculateRiskReduction({
        current_price,
        old_sl: position.current_sl,
        new_sl: trailResult.new_sl,
        qty: position.qty
      });
    }

    // Calculate unrealized P&L
    const pnl = position.calculateUnrealizedPnl(current_price);
    const riskMetrics = position.calculateRiskMetrics(current_price);

    res.json({
      success: true,
      symbol: position.symbol,
      current_price,
      position_state: {
        actual_entry: position.actual_entry,
        current_sl: position.current_sl,
        current_target: position.current_target,
        days_in_trade: position.days_in_trade
      },
      unrealized_pnl: pnl,
      risk_metrics: riskMetrics,
      trail_recommendation: trailResult,
      risk_reduction: riskReduction,
      alerts
    });
  } catch (error) {
    console.error("Error checking trail:", error);
    res.status(500).json({
      success: false,
      message: "Failed to check trailing stop",
      error: error.message
    });
  }
});

/**
 * POST /api/v1/positions/:id/trail-sl
 * Trail stop loss to a new level (can only move UP)
 */
router.post("/:id/trail-sl", auth, async (req, res) => {
  try {
    const { new_sl, reason, method = "MANUAL" } = req.body;

    if (!new_sl || typeof new_sl !== "number") {
      return res.status(400).json({
        success: false,
        message: "new_sl is required and must be a number"
      });
    }

    const position = await UserPosition.findOne({
      _id: req.params.id,
      user_id: req.user._id,
      status: "OPEN"
    });

    if (!position) {
      return res.status(404).json({
        success: false,
        message: "Open position not found"
      });
    }

    const old_sl = position.current_sl;

    // Trail the stop loss (method validates SL only moves up)
    await position.trailStopLoss(
      new_sl,
      reason || `Manual trail from ₹${old_sl} to ₹${new_sl}`,
      method
    );

    res.json({
      success: true,
      message: "Stop loss trailed successfully",
      symbol: position.symbol,
      old_sl,
      new_sl: position.current_sl,
      method,
      trail_history_count: position.sl_trail_history.length
    });
  } catch (error) {
    console.error("Error trailing stop loss:", error);

    // Handle validation errors from the model
    if (error.message.includes("Cannot trail stop loss DOWN") ||
        error.message.includes("cannot be at or above target")) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to trail stop loss",
      error: error.message
    });
  }
});

/**
 * POST /api/v1/positions/:id/close
 * Close a position manually
 */
router.post("/:id/close", auth, async (req, res) => {
  try {
    const { exit_price, reason = "MANUAL" } = req.body;

    if (!exit_price || typeof exit_price !== "number") {
      return res.status(400).json({
        success: false,
        message: "exit_price is required and must be a number"
      });
    }

    const validReasons = ["TARGET_HIT", "SL_HIT", "MANUAL", "TRAILED_OUT", "EXPIRED"];
    if (!validReasons.includes(reason)) {
      return res.status(400).json({
        success: false,
        message: `Invalid close reason. Must be one of: ${validReasons.join(", ")}`
      });
    }

    const position = await UserPosition.findOne({
      _id: req.params.id,
      user_id: req.user._id,
      status: "OPEN"
    });

    if (!position) {
      return res.status(404).json({
        success: false,
        message: "Open position not found"
      });
    }

    // Close the position
    await position.closePosition(reason, exit_price);

    res.json({
      success: true,
      message: "Position closed successfully",
      symbol: position.symbol,
      actual_entry: position.actual_entry,
      exit_price: position.exit_price,
      realized_pnl: position.realized_pnl,
      realized_pnl_pct: position.realized_pnl_pct,
      close_reason: position.close_reason,
      closed_at: position.closed_at,
      days_in_trade: position.days_in_trade
    });
  } catch (error) {
    console.error("Error closing position:", error);

    if (error.message === "Position is already closed") {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to close position",
      error: error.message
    });
  }
});

/**
 * POST /api/v1/positions/:id/exit-coach
 * Exit decision helper - provides options and recommendations
 */
router.post("/:id/exit-coach", auth, async (req, res) => {
  try {
    const { thinking } = req.body;  // "not_sure", "want_to_book", "want_to_hold"

    const position = await UserPosition.findOne({
      _id: req.params.id,
      user_id: req.user._id,
      status: "OPEN"
    });

    if (!position) {
      return res.status(404).json({ success: false, error: "Open position not found" });
    }

    // Get current price
    const priceDoc = await LatestPrice.findOne({ instrument_key: position.instrument_key });
    const current_price = priceDoc?.last_traded_price || priceDoc?.close || position.actual_entry;

    // Calculate current state
    const pnl = position.calculateUnrealizedPnl(current_price);
    const { actual_entry, current_sl, current_target, qty } = position;

    // Distance calculations
    const distance_to_target = ((current_target - current_price) / current_price) * 100;
    const distance_to_sl = ((current_price - current_sl) / current_price) * 100;
    const profit_pct = pnl.unrealized_pnl_pct;

    // Generate options
    const options = [];

    // Option 1: Trail and Hold
    const trailStop = Math.max(current_sl, actual_entry); // At least breakeven if in profit
    options.push({
      action: "TRAIL_HOLD",
      title: "Trail stop & let it run",
      description: profit_pct > 0
        ? `Move stop to ₹${round2(trailStop)} to lock in some gains, let the rest run toward target ₹${current_target}`
        : `Keep current stop at ₹${current_sl}, wait for move toward target`,
      pros: [
        "Captures more upside if move continues",
        profit_pct > 1 ? "Locks in minimum profit with trailed stop" : "Maintains original thesis"
      ],
      cons: [
        "May give back some gains if reverses",
        "Requires patience"
      ],
      new_sl: profit_pct > 1.5 ? round2(trailStop) : current_sl,
      risk_after: profit_pct > 1.5 ? round2(profit_pct - 1.5) : round2(distance_to_sl),
      best_for: "Patient traders, strong conviction in thesis"
    });

    // Option 2: Book 50%
    if (profit_pct > 0) {
      const halfQty = Math.floor(qty / 2);
      options.push({
        action: "BOOK_50",
        title: "Book 50% profit",
        description: `Sell ${halfQty} shares now at ₹${current_price}, lock in ₹${round2(pnl.unrealized_pnl / 2)} profit. Let remaining run.`,
        pros: [
          "Locks in definite profit",
          "Reduces emotional pressure",
          "Still participates in further upside"
        ],
        cons: [
          "Reduces position size for further gains",
          "Two transactions (cost)"
        ],
        qty_to_sell: halfQty,
        profit_locked: round2(pnl.unrealized_pnl / 2),
        best_for: "Balanced approach, reduces anxiety"
      });
    }

    // Option 3: Exit Fully
    options.push({
      action: "EXIT_FULL",
      title: "Exit fully now",
      description: profit_pct >= 0
        ? `Book full profit of ₹${round2(pnl.unrealized_pnl)} (${profit_pct.toFixed(1)}%)`
        : `Exit with loss of ₹${round2(Math.abs(pnl.unrealized_pnl))} (${profit_pct.toFixed(1)}%)`,
      pros: profit_pct >= 0
        ? ["Certainty - profit is locked", "Capital freed for next opportunity", "No regret if it reverses"]
        : ["Stops further loss", "Capital preserved for better setup", "Discipline maintained"],
      cons: profit_pct >= 0
        ? ["Misses further upside if continues", "May feel regret if it rallies"]
        : ["Realizes loss", "May reverse after you exit"],
      pnl_if_exit: round2(pnl.unrealized_pnl),
      best_for: profit_pct >= 0 ? "Risk-averse, need the capital" : "Thesis broken, cut loss"
    });

    // Determine AI suggestion
    let ai_suggestion = "TRAIL_HOLD";
    let ai_reasoning = "";

    if (profit_pct >= 3 && distance_to_target <= 1) {
      ai_suggestion = "EXIT_FULL";
      ai_reasoning = "Very close to target with good profit. Consider booking.";
    } else if (profit_pct >= 2 && profit_pct < 3) {
      ai_suggestion = "BOOK_50";
      ai_reasoning = "Good profit accumulated. Lock half, let half run.";
    } else if (profit_pct > 0 && profit_pct < 2) {
      ai_suggestion = "TRAIL_HOLD";
      ai_reasoning = "Profit building but room to target. Trail stop and hold.";
    } else if (profit_pct <= -3) {
      ai_suggestion = "EXIT_FULL";
      ai_reasoning = "Significant drawdown. Consider if thesis is still valid.";
    } else {
      ai_suggestion = "TRAIL_HOLD";
      ai_reasoning = "Position developing. Stick to original plan.";
    }

    // Emotional acknowledgment based on their thinking
    let emotional_note = "";
    switch (thinking) {
      case "not_sure":
        emotional_note = "It's okay to feel uncertain. Let's look at this objectively.";
        break;
      case "want_to_book":
        emotional_note = "The urge to lock in gains is natural. Here are your options.";
        break;
      case "want_to_hold":
        emotional_note = "Conviction is good, but let's make sure the structure supports it.";
        break;
      default:
        emotional_note = "Let me help you think through this decision.";
    }

    res.json({
      success: true,
      position_state: {
        symbol: position.symbol,
        entry: actual_entry,
        current_price,
        current_sl,
        current_target,
        qty: qty,
        days_held: position.days_in_trade,
        pnl_inr: round2(pnl.unrealized_pnl),
        pnl_pct: round2(profit_pct),
        distance_to_target_pct: round2(distance_to_target),
        distance_to_sl_pct: round2(distance_to_sl)
      },
      emotional_note,
      options,
      ai_suggestion,
      ai_reasoning,
      reminder: "Whatever you decide, you're following a process. That's what matters."
    });

  } catch (error) {
    console.error("Exit coach error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Round to 2 decimal places
 */
function round2(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return x;
  return Math.round(x * 100) / 100;
}

/**
 * GET /api/v1/positions/by-instrument/:instrumentKey
 * Get open position for a specific instrument (useful for analysis routing)
 */
router.get("/by-instrument/:instrumentKey", auth, async (req, res) => {
  try {
    const position = await UserPosition.findOpenPosition(
      req.user._id,
      req.params.instrumentKey
    );

    if (!position) {
      return res.json({
        success: true,
        has_position: false,
        position: null
      });
    }

    res.json({
      success: true,
      has_position: true,
      position: {
        id: position._id,
        symbol: position.symbol,
        actual_entry: position.actual_entry,
        qty: position.qty,
        current_sl: position.current_sl,
        current_target: position.current_target,
        days_in_trade: position.days_in_trade,
        original_analysis: position.original_analysis
      }
    });
  } catch (error) {
    console.error("Error fetching position by instrument:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch position",
      error: error.message
    });
  }
});

export default router;
