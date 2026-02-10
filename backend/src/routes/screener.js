import express from "express";
import chartinkService from "../services/chartinkService.js";
import { WEEKLY_SCAN_QUERIES as SCAN_QUERIES } from "../services/weeklyPicks/weeklyPicksScans.js";
import stockEnrichmentService from "../services/stockEnrichmentService.js";
import weekendScreeningJob from "../services/weeklyPicks/weekendScreeningJob.js";
import dailyPullbackScanJob from "../services/jobs/dailyPullbackScanJob.js";
import { auth } from "../middleware/auth.js";

const router = express.Router();

/**
 * GET /api/v1/screener/scans
 * List available scan types
 */
router.get("/scans", auth, async (req, res) => {
  try {
    res.json({
      success: true,
      scans: [
        {
          id: "a_plus_momentum",
          name: "A+ Next Week",
          description: "NR7 compression with tight base for explosive moves"
        },
        {
          id: "pullback",
          name: "Pullback to EMA20",
          description: "Stocks pulling back to EMA20 support with low volume"
        }
        // Legacy scans - commented out
        // {
        //   id: "breakout",
        //   name: "Breakout Candidates",
        //   description: "Stocks at 20-day highs with volume surge"
        // },
        // {
        //   id: "pullback",
        //   name: "Pullback to 20 DMA",
        //   description: "Stocks pulling back to moving average support"
        // },
        // {
        //   id: "momentum",
        //   name: "Momentum with Volume",
        //   description: "Strong momentum stocks with volume confirmation"
        // },
        // {
        //   id: "consolidation",
        //   name: "Consolidation Breakout",
        //   description: "Breaking out of tight consolidation range"
        // }
      ]
    });
  } catch (error) {
    console.error("Error listing scans:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/screener/run
 * Run a specific scan and return enriched results
 */
router.post("/run", auth, async (req, res) => {
  try {
    const { scan_type = "a_plus_momentum", min_score = 40, limit = 20 } = req.body;

    // Validate scan type
    const validTypes = ["a_plus_momentum", "pullback", "combined"];
    if (!validTypes.includes(scan_type)) {
      return res.status(400).json({
        success: false,
        error: `Invalid scan_type. Use: ${validTypes.join(", ")}`
      });
    }

    // Run the appropriate scan
    let scanResults = [];
    console.log(`[SCREENER] Running ${scan_type} scan...`);

    switch (scan_type) {
      case "a_plus_momentum":
        scanResults = await chartinkService.runAPlusNextWeekScan();
        break;
      case "pullback":
        scanResults = await chartinkService.runPullbackScan();
        break;
      case "combined":
        const combined = await chartinkService.runCombinedScan();
        scanResults = combined.combined;
        break;
      // Legacy scans - commented out
      // case "breakout":
      //   scanResults = await chartinkService.runBreakoutScan();
      //   break;
      // case "pullback":
      //   scanResults = await chartinkService.runPullbackScan();
      //   break;
      // case "momentum":
      //   scanResults = await chartinkService.runMomentumScan();
      //   break;
      // case "consolidation":
      //   scanResults = await chartinkService.runConsolidationScan();
      //   break;
    }

    if (scanResults.length === 0) {
      return res.json({
        success: true,
        message: "No stocks matched the scan criteria",
        stocks: [],
        metadata: { scan_type, raw_results: 0, enriched_results: 0 }
      });
    }

    // Enrich results
    console.log(`[SCREENER] Enriching ${scanResults.length} results...`);
    const { stocks, metadata } = await stockEnrichmentService.runEnrichmentPipeline(
      scanResults,
      {
        minScore: min_score,
        maxResults: Math.min(limit, 50)
      }
    );

    res.json({
      success: true,
      stocks,
      metadata: {
        scan_type,
        ...metadata
      }
    });

  } catch (error) {
    console.error("Error running scan:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/screener/custom
 * Run a custom ChartInk query
 */
router.post("/custom", auth, async (req, res) => {
  try {
    const { query, name = "custom", min_score = 0, limit = 20 } = req.body;

    if (!query) {
      return res.status(400).json({ success: false, error: "query is required" });
    }

    console.log(`[SCREENER] Running custom scan: ${name}`);

    // Run custom scan
    const scanResults = await chartinkService.runCustomScan(query, name);

    if (scanResults.length === 0) {
      return res.json({
        success: true,
        message: "No stocks matched the custom query",
        stocks: [],
        metadata: { scan_type: name, raw_results: 0 }
      });
    }

    // Enrich results
    const { stocks, metadata } = await stockEnrichmentService.runEnrichmentPipeline(
      scanResults,
      {
        minScore: min_score,
        maxResults: Math.min(limit, 50)
      }
    );

    res.json({
      success: true,
      stocks,
      metadata: {
        scan_type: name,
        ...metadata
      }
    });

  } catch (error) {
    console.error("Error running custom scan:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/screener/queries
 * Get built-in ChartInk queries
 */
router.get("/queries", auth, async (req, res) => {
  try {
    res.json({
      success: true,
      queries: {
        a_plus_momentum: {
          name: "A+ Next Week",
          query: SCAN_QUERIES.a_plus_momentum
        },
        pullback: {
          name: "Pullback to EMA20",
          query: SCAN_QUERIES.pullback
        }
        // Legacy queries - commented out
        // breakout: {
        //   name: "Breakout Candidates",
        //   query: SCAN_QUERIES.breakout
        // },
        // pullback: {
        //   name: "Pullback to 20 DMA",
        //   query: SCAN_QUERIES.pullback
        // },
        // momentum: {
        //   name: "Momentum with Volume",
        //   query: SCAN_QUERIES.momentum
        // },
        // consolidation_breakout: {
        //   name: "Consolidation Breakout",
        //   query: SCAN_QUERIES.consolidation_breakout
        // }
      }
    });
  } catch (error) {
    console.error("Error getting queries:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/screener/enrich
 * Enrich a list of symbols with technical data
 */
router.post("/enrich", auth, async (req, res) => {
  try {
    const { symbols } = req.body;

    if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
      return res.status(400).json({ success: false, error: "symbols array required" });
    }

    if (symbols.length > 20) {
      return res.status(400).json({ success: false, error: "Maximum 20 symbols per request" });
    }

    // Convert symbols to ChartInk-like format
    const stockData = symbols.map(s => ({
      nsecode: s.toUpperCase(),
      name: s,
      per_change: 0,
      close: 0,
      volume: 0
    }));

    const { stocks, metadata } = await stockEnrichmentService.runEnrichmentPipeline(stockData, {
      minScore: 0,
      maxResults: 20
    });

    res.json({
      success: true,
      stocks,
      metadata
    });

  } catch (error) {
    console.error("Error enriching symbols:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/screener/trigger-weekend
 * Manually trigger weekend screening job (admin only)
 */
router.post("/trigger-weekend", auth, async (req, res) => {
  try {
    // Optional: Add admin check here
    // if (!req.user.isAdmin) {
    //   return res.status(403).json({ success: false, error: "Admin access required" });
    // }

    const { scan_types = ["a_plus_momentum", "pullback"], user_id } = req.body;

    const result = await weekendScreeningJob.triggerNow({
      scanTypes: scan_types,
      userId: user_id
    });

    res.json({
      success: true,
      message: "Weekend screening triggered",
      ...result
    });

  } catch (error) {
    console.error("Error triggering weekend screening:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/screener/job-status
 * Get screening job status
 */
router.get("/job-status", auth, async (req, res) => {
  try {
    const stats = weekendScreeningJob.getStats();

    res.json({
      success: true,
      stats
    });

  } catch (error) {
    console.error("Error getting job status:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/screener/trigger-daily-pullback
 * Manually trigger daily pullback scan job
 */
router.post("/trigger-daily-pullback", auth, async (req, res) => {
  try {
    const result = await dailyPullbackScanJob.triggerNow(req.body || {});

    res.json({
      success: true,
      message: "Daily pullback scan triggered",
      ...result
    });

  } catch (error) {
    console.error("Error triggering daily pullback scan:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/screener/daily-pullback-status
 * Get daily pullback scan job status
 */
router.get("/daily-pullback-status", auth, async (req, res) => {
  try {
    const stats = dailyPullbackScanJob.getStats();
    const nextRun = await dailyPullbackScanJob.getNextRun();

    res.json({
      success: true,
      stats,
      nextRun
    });

  } catch (error) {
    console.error("Error getting daily pullback status:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
