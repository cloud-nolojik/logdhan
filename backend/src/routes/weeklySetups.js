/**
 * Weekly Setups Routes
 *
 * Public API endpoints for weekly stock setups and technical data.
 */

import express from 'express';
import { getTechnicalData, getDailyAnalysisData } from '../services/technicalData.service.js';

const router = express.Router();

/**
 * GET /api/v1/weeklysetups/technical_data
 *
 * Get comprehensive technical data for given stock symbols.
 * Public endpoint - no authentication required.
 *
 * Query Parameters:
 *   symbols (required): Comma-separated list of trading symbols (e.g., "RELIANCE,TATASTEEL,HDFCBANK")
 *
 * Response:
 *   {
 *     success: true,
 *     generated_at: "2026-01-31T12:00:00.000Z",
 *     nifty: { current_level, trend, major_events },
 *     stocks: [{ symbol, cmp, daily_rsi, weekly_rsi, ... }]
 *   }
 */
router.get('/technical_data', async (req, res) => {
  try {
    const { symbols } = req.query;

    if (!symbols) {
      return res.status(400).json({
        success: false,
        error: 'symbols parameter is required',
        example: '/api/v1/weeklysetups/technical_data?symbols=RELIANCE,TATASTEEL'
      });
    }

    // Parse and validate symbols
    const symbolList = symbols
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(s => s.length > 0);

    if (symbolList.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No valid symbols provided'
      });
    }

    // Limit to prevent abuse
    if (symbolList.length > 20) {
      return res.status(400).json({
        success: false,
        error: 'Maximum 20 symbols allowed per request'
      });
    }

    console.log(`[TechnicalData] Fetching data for ${symbolList.length} symbols: ${symbolList.join(', ')}`);

    const data = await getTechnicalData(symbolList);

    res.json({
      success: true,
      ...data
    });

  } catch (error) {
    console.error('[TechnicalData] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/weeklysetups/daily_analysis
 *
 * Get daily analysis data for given stock symbols.
 * Public endpoint - no authentication required.
 *
 * Query Parameters:
 *   symbols (required): Comma-separated list of trading symbols
 *
 * Response:
 *   {
 *     date: "2026-02-03",
 *     generated_at_ist: "2026-02-03T11:00:00+05:30",
 *     nifty_level: 25320.7,
 *     nifty_change_pct: -0.5,
 *     stocks: [{ symbol, instrument_key, prev_close, open, high, low, ltp, daily_rsi, ... }]
 *   }
 */
router.get('/daily_analysis', async (req, res) => {
  try {
    const { symbols } = req.query;

    if (!symbols) {
      return res.status(400).json({
        success: false,
        error: 'symbols parameter is required',
        example: '/api/v1/weeklysetups/daily_analysis?symbols=RELIANCE,TATASTEEL'
      });
    }

    const symbolList = symbols
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(s => s.length > 0);

    if (symbolList.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No valid symbols provided'
      });
    }

    if (symbolList.length > 50) {
      return res.status(400).json({
        success: false,
        error: 'Maximum 50 symbols allowed per request'
      });
    }

    console.log(`[DailyAnalysis] Fetching data for ${symbolList.length} symbols`);

    const data = await getDailyAnalysisData(symbolList);

    res.json(data);

  } catch (error) {
    console.error('[DailyAnalysis] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

export default router;
