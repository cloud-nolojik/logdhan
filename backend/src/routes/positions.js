import express from "express";
import axios from "axios";
import UserPosition from "../models/userPosition.js";
import LatestPrice from "../models/latestPrice.js";
import { calculateTrailingStop, checkExitConditions, calculateRiskReduction } from "../utils/trailingStopLoss.js";
import { auth } from "../middleware/auth.js";
import candleFetcherService from "../services/candleFetcher.service.js";

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
        _id: p._id,
        id: p._id,
        symbol: p.symbol,
        instrument_key: p.instrument_key,
        stock_name: p.stock_name,
        actual_entry: p.actual_entry,
        qty: p.qty,
        current_sl: p.current_sl,
        current_target: p.current_target,
        entered_at: p.entered_at,
        days_in_trade: p.days_in_trade,
        status: p.status,
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
 * POST /api/v1/positions
 * Create a new position manually (without analysis)
 */
router.post("/", auth, async (req, res) => {
  try {
    const {
      instrument_key,
      symbol,
      stock_name,
      actual_entry,
      qty,
      stop_loss,
      target,
      archetype,
      linked_orders
    } = req.body;

    // Validate required fields
    if (!instrument_key || !symbol || !actual_entry || !qty || !stop_loss || !target) {
      return res.status(400).json({
        success: false,
        message: "Required fields: instrument_key, symbol, actual_entry, qty, stop_loss, target"
      });
    }

    // Validate numeric fields
    if (typeof actual_entry !== "number" || typeof qty !== "number" ||
        typeof stop_loss !== "number" || typeof target !== "number") {
      return res.status(400).json({
        success: false,
        message: "actual_entry, qty, stop_loss, and target must be numbers"
      });
    }

    // Validate stop_loss < entry < target
    if (stop_loss >= actual_entry) {
      return res.status(400).json({
        success: false,
        message: "Stop loss must be below entry price"
      });
    }
    if (target <= actual_entry) {
      return res.status(400).json({
        success: false,
        message: "Target must be above entry price"
      });
    }

    // Check if position already exists
    const existingPosition = await UserPosition.findOpenPosition(req.user._id, instrument_key);
    if (existingPosition) {
      return res.status(400).json({
        success: false,
        message: `Open position already exists for ${symbol}`
      });
    }

    // Calculate risk/reward
    const risk = actual_entry - stop_loss;
    const reward = target - actual_entry;
    const riskReward = Math.round((reward / risk) * 100) / 100;

    // Create position
    const position = await UserPosition.create({
      user_id: req.user._id,
      instrument_key,
      symbol,
      stock_name: stock_name || symbol,
      original_analysis: {
        recommended_entry: actual_entry,
        recommended_target: target,
        recommended_sl: stop_loss,
        archetype: archetype || "manual",
        confidence: null,
        riskReward,
        generated_at: new Date()
      },
      actual_entry,
      qty,
      current_sl: stop_loss,
      current_target: target,
      linked_orders: linked_orders || {},
      status: "OPEN"
    });

    res.status(201).json({
      success: true,
      message: "Position created successfully",
      position: {
        _id: position._id,
        id: position._id,
        instrument_key: position.instrument_key,
        symbol: position.symbol,
        stock_name: position.stock_name,
        actual_entry: position.actual_entry,
        qty: position.qty,
        current_sl: position.current_sl,
        current_target: position.current_target,
        riskReward,
        entered_at: position.entered_at,
        status: position.status,
        days_in_trade: 0,
        sl_trail_count: 0
      }
    });
  } catch (error) {
    console.error("Error creating position:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create position",
      error: error.message
    });
  }
});

/**
 * GET /api/v1/positions/by-instrument/:instrumentKey
 * Get open position for a specific instrument (useful for analysis routing)
 * NOTE: Must be defined BEFORE /:id to avoid route matching issues
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
        stock_name: position.stock_name,
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
        _id: p._id,
        id: p._id,
        symbol: p.symbol,
        instrument_key: p.instrument_key,
        stock_name: p.stock_name,
        actual_entry: p.actual_entry,
        exit_price: p.exit_price,
        qty: p.qty,
        realized_pnl: p.realized_pnl,
        realized_pnl_pct: p.realized_pnl_pct,
        close_reason: p.close_reason,
        entered_at: p.entered_at,
        closed_at: p.closed_at,
        days_in_trade: p.days_in_trade,
        status: p.status
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
 * Uses AI for personalized explanations
 */
router.post("/:id/check-trail", auth, async (req, res) => {
  try {
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

    // 🆕 Fetch fresh market data with technical indicators
    let marketData = null;
    let indicators = {};
    let current_price = position.actual_entry;

    try {
      marketData = await candleFetcherService.getMarketDataForTriggers(
        position.instrument_key,
        [{ timeframe: '1d' }, { timeframe: '1h' }]
      );
      current_price = marketData.current_price || position.actual_entry;
      indicators = marketData.indicators?.['1d'] || marketData.indicators?.['1h'] || {};
    } catch (fetchError) {
      console.warn(`⚠️ [TRAIL CHECK] Failed to fetch market data: ${fetchError.message}`);
      const priceDoc = await LatestPrice.findOne({ instrument_key: position.instrument_key });
      current_price = priceDoc?.last_traded_price || priceDoc?.close || position.actual_entry;
    }

    // Extract indicators
    const atr = indicators.atr14 || indicators.atr || null;
    const ema20 = indicators.ema20 || indicators.ema20_1d || null;
    const rsi = indicators.rsi14 || indicators.rsi || null;
    const adx = indicators.adx14 || indicators.adx || null;

    // Calculate trailing recommendation using utility
    const trailResult = calculateTrailingStop({
      position: {
        actual_entry: position.actual_entry,
        current_sl: position.current_sl,
        current_target: position.current_target
      },
      current_price,
      atr,
      swing_low: null,
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
    const profit_pct = pnl.unrealized_pnl_pct;

    // 🆕 Use AI for personalized trail explanation
    let aiReason = trailResult.reason || "";
    let aiExplanation = "";

    try {
      const aiPrompt = `You are a swing trading coach. Give a brief, helpful explanation for trailing stop decision.

POSITION:
- Symbol: ${position.symbol}
- Entry: ₹${position.actual_entry}
- Current Price: ₹${current_price}
- Current SL: ₹${position.current_sl}
- Target: ₹${position.current_target}
- P&L: ${profit_pct >= 0 ? '+' : ''}${profit_pct.toFixed(2)}%
- Days held: ${position.days_in_trade}

TECHNICAL:
- RSI: ${rsi ? rsi.toFixed(1) : 'N/A'}
- 20 EMA: ₹${ema20 ? ema20.toFixed(2) : 'N/A'}
- ATR: ₹${atr ? atr.toFixed(2) : 'N/A'}
- ADX: ${adx ? adx.toFixed(1) : 'N/A'}

TRAIL RECOMMENDATION: ${trailResult.should_trail ? `Move SL to ₹${trailResult.new_sl} (${trailResult.method})` : 'No trail recommended'}
REASON: ${trailResult.reason || 'N/A'}

Respond in JSON:
{
  "reason": "1-2 sentence explanation of the recommendation using the actual numbers",
  "explanation": "1 sentence about why this protects the trade"
}`;

      const aiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a concise trading coach. Always respond in valid JSON. Be specific with numbers.' },
          { role: 'user', content: aiPrompt }
        ],
        response_format: { type: "json_object" },
        temperature: 0.7,
        max_tokens: 200
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      const aiContent = aiResponse.data.choices[0]?.message?.content;
      if (aiContent) {
        const parsed = JSON.parse(aiContent);
        aiReason = parsed.reason || trailResult.reason;
        aiExplanation = parsed.explanation || "";
      }
    } catch (aiError) {
      console.warn(`⚠️ [TRAIL CHECK] AI call failed: ${aiError.message}`);
      // Keep original reason from utility
    }

    // Enhance trail result with AI reason
    const enhancedTrailResult = {
      ...trailResult,
      reason: aiReason,
      explanation: aiExplanation
    };

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
      trail_recommendation: enhancedTrailResult,
      risk_reduction: riskReduction,
      alerts,
      technical_indicators: {
        rsi: rsi ? round2(rsi) : null,
        ema20: ema20 ? round2(ema20) : null,
        atr: atr ? round2(atr) : null,
        adx: adx ? round2(adx) : null
      }
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
 * Uses fresh candle data + technical indicators for smarter decisions
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

    // 🆕 Fetch fresh market data with technical indicators using candleFetcherService
    let marketData = null;
    let indicators = {};
    let current_price = position.actual_entry; // Fallback

    try {
      // Fetch candles and calculate indicators (1d timeframe for swing positions)
      marketData = await candleFetcherService.getMarketDataForTriggers(
        position.instrument_key,
        [{ timeframe: '1d' }, { timeframe: '1h' }]
      );

      // Get real-time current price from 1m candle
      current_price = marketData.current_price || position.actual_entry;

      // Get indicators from daily timeframe
      indicators = marketData.indicators?.['1d'] || marketData.indicators?.['1h'] || {};

      console.log(`📊 [EXIT COACH] ${position.symbol}: Price ₹${current_price}, RSI: ${indicators.rsi14?.toFixed(1)}, EMA20: ${indicators.ema20?.toFixed(2)}`);
    } catch (fetchError) {
      console.warn(`⚠️ [EXIT COACH] Failed to fetch market data, using cached price: ${fetchError.message}`);
      // Fallback to LatestPrice collection
      const priceDoc = await LatestPrice.findOne({ instrument_key: position.instrument_key });
      current_price = priceDoc?.last_traded_price || priceDoc?.close || position.actual_entry;
    }

    // Calculate current state
    const pnl = position.calculateUnrealizedPnl(current_price);
    const { actual_entry, current_sl, current_target, qty } = position;

    // Distance calculations
    const distance_to_target = ((current_target - current_price) / current_price) * 100;
    const distance_to_sl = ((current_price - current_sl) / current_price) * 100;
    const profit_pct = pnl.unrealized_pnl_pct;

    // 🆕 Extract technical indicators for smarter decisions
    const rsi = indicators.rsi14 || indicators.rsi || null;
    const ema20 = indicators.ema20 || indicators.ema20_1d || null;
    const ema50 = indicators.ema50 || indicators.ema50_1d || null;
    const atr = indicators.atr14 || indicators.atr || null;
    const adx = indicators.adx14 || indicators.adx || null;

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

    // Technical conditions for context
    const isAboveEma20 = ema20 && current_price > ema20;
    const isAboveEma50 = ema50 && current_price > ema50;
    const isOverbought = rsi && rsi > 70;
    const isOversold = rsi && rsi < 30;
    const isStrongTrend = adx && adx > 25;
    const isWeakTrend = adx && adx < 20;

    // 🆕 Use real AI for exit coaching
    let ai_suggestion = "TRAIL_HOLD";
    let ai_reasoning = "";
    let emotional_note = "";
    let ai_options = [];

    try {
      const aiPrompt = `You are an expert swing trading coach for Indian stock markets. Analyze this position and provide exit coaching.

POSITION DATA:
- Symbol: ${position.symbol}
- Entry Price: ₹${actual_entry}
- Current Price: ₹${current_price}
- Stop Loss: ₹${current_sl}
- Target: ₹${current_target}
- Quantity: ${qty} shares
- Days Held: ${position.days_in_trade} days
- Current P&L: ${profit_pct >= 0 ? '+' : ''}${profit_pct.toFixed(2)}% (₹${round2(pnl.unrealized_pnl)})
- Distance to Target: ${distance_to_target.toFixed(2)}%
- Distance to Stop: ${distance_to_sl.toFixed(2)}%

TECHNICAL INDICATORS:
- RSI(14): ${rsi ? rsi.toFixed(1) : 'N/A'}${isOverbought ? ' (Overbought >70)' : isOversold ? ' (Oversold <30)' : ''}
- 20 EMA: ₹${ema20 ? ema20.toFixed(2) : 'N/A'} (Price ${isAboveEma20 ? 'ABOVE' : 'BELOW'})
- 50 EMA: ₹${ema50 ? ema50.toFixed(2) : 'N/A'} (Price ${isAboveEma50 ? 'ABOVE' : 'BELOW'})
- ADX(14): ${adx ? adx.toFixed(1) : 'N/A'} (${isStrongTrend ? 'Strong Trend' : isWeakTrend ? 'Weak Trend' : 'Moderate'})
- ATR(14): ₹${atr ? atr.toFixed(2) : 'N/A'}

USER'S CURRENT THINKING: ${thinking || 'not_sure'}

Respond in JSON format:
{
  "suggestion": "TRAIL_HOLD" | "BOOK_50" | "EXIT_FULL",
  "reasoning": "2-3 sentence explanation of why this action based on technicals and position state",
  "emotional_note": "1 sentence empathetic acknowledgment of their feeling",
  "options": [
    {
      "action": "TRAIL_HOLD",
      "title": "Trail stop & hold",
      "description": "Specific description with numbers",
      "pros": ["Pro 1", "Pro 2"],
      "cons": ["Con 1", "Con 2"],
      "best_for": "Who this suits"
    },
    {
      "action": "BOOK_50",
      "title": "Book 50% profit",
      "description": "Specific description with numbers",
      "pros": ["Pro 1", "Pro 2"],
      "cons": ["Con 1", "Con 2"],
      "best_for": "Who this suits"
    },
    {
      "action": "EXIT_FULL",
      "title": "Exit fully",
      "description": "Specific description with numbers",
      "pros": ["Pro 1", "Pro 2"],
      "cons": ["Con 1", "Con 2"],
      "best_for": "Who this suits"
    }
  ],
  "reminder": "1 sentence motivational reminder about process"
}`;

      const aiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a swing trading exit coach. Always respond in valid JSON. Be specific with numbers and prices. Be concise but helpful.' },
          { role: 'user', content: aiPrompt }
        ],
        response_format: { type: "json_object" },
        temperature: 0.7,
        max_tokens: 800
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      });

      const aiContent = aiResponse.data.choices[0]?.message?.content;
      if (aiContent) {
        const parsed = JSON.parse(aiContent);
        ai_suggestion = parsed.suggestion || "TRAIL_HOLD";
        ai_reasoning = parsed.reasoning || "Position analysis complete.";
        emotional_note = parsed.emotional_note || "";
        ai_options = parsed.options || options;

        // Merge AI options with computed data (pnl_if_exit, qty_to_sell, etc.)
        if (ai_options.length > 0) {
          ai_options = ai_options.map(opt => {
            const baseOpt = options.find(o => o.action === opt.action) || {};
            return {
              ...opt,
              new_sl: baseOpt.new_sl,
              risk_after: baseOpt.risk_after,
              qty_to_sell: baseOpt.qty_to_sell,
              profit_locked: baseOpt.profit_locked,
              pnl_if_exit: baseOpt.pnl_if_exit
            };
          });
        }

        console.log(`🤖 [EXIT COACH AI] ${position.symbol}: ${ai_suggestion}`);
      }
    } catch (aiError) {
      console.warn(`⚠️ [EXIT COACH] AI call failed, using fallback: ${aiError.message}`);

      // Fallback to rule-based logic
      if (profit_pct >= 3 && distance_to_target <= 1) {
        ai_suggestion = "EXIT_FULL";
        ai_reasoning = "Very close to target with good profit. Consider booking.";
      } else if (profit_pct >= 2 && isOverbought) {
        ai_suggestion = "EXIT_FULL";
        ai_reasoning = `RSI at ${rsi?.toFixed(0)} indicates overbought. Good time to book profits.`;
      } else if (profit_pct >= 2 && isWeakTrend) {
        ai_suggestion = "BOOK_50";
        ai_reasoning = `Good profit but trend weakening. Lock half.`;
      } else if (profit_pct >= 2 && isStrongTrend && isAboveEma20) {
        ai_suggestion = "TRAIL_HOLD";
        ai_reasoning = `Strong trend and above 20 EMA. Trail stop and let it run.`;
      } else if (profit_pct > 0 && profit_pct < 2) {
        ai_suggestion = "TRAIL_HOLD";
        ai_reasoning = "Profit building. Trail stop and hold.";
      } else if (profit_pct < 0 && isOversold) {
        ai_suggestion = "TRAIL_HOLD";
        ai_reasoning = "Oversold conditions. Potential bounce ahead.";
      } else if (profit_pct <= -2 && !isAboveEma20 && !isAboveEma50) {
        ai_suggestion = "EXIT_FULL";
        ai_reasoning = "Price below key moving averages. Consider exit.";
      } else {
        ai_suggestion = "TRAIL_HOLD";
        ai_reasoning = "Position developing. Stick to original plan.";
      }

      emotional_note = thinking === "want_to_book"
        ? "The urge to lock in gains is natural. Here are your options."
        : thinking === "want_to_hold"
        ? "Conviction is good, but let's make sure the structure supports it."
        : "Let me help you think through this decision.";

      ai_options = options;
    }

    // Use AI options if available, otherwise use computed options
    const finalOptions = ai_options.length > 0 ? ai_options : options;

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
      // 🆕 Technical indicators for transparency
      technical_indicators: {
        rsi: rsi ? round2(rsi) : null,
        ema20: ema20 ? round2(ema20) : null,
        ema50: ema50 ? round2(ema50) : null,
        atr: atr ? round2(atr) : null,
        adx: adx ? round2(adx) : null,
        price_vs_ema20: ema20 ? round2(((current_price - ema20) / ema20) * 100) : null,
        is_above_ema20: isAboveEma20,
        is_overbought: isOverbought,
        is_oversold: isOversold,
        trend_strength: isStrongTrend ? "strong" : isWeakTrend ? "weak" : "moderate"
      },
      emotional_note,
      options: finalOptions,
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

export default router;
