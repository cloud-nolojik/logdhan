import express from "express";
import DailyNewsStock from "../models/dailyNewsStock.js";
import streetGainsScraper from "../services/streetGainsScraper.service.js";
import dailyNewsStocksJob from "../services/jobs/dailyNewsStocksJob.js";
import intradayAnalyzeService from "../services/intradayAnalyze.service.js";
import { auth, optionalAuth, adminAuth } from "../middleware/auth.js";

const router = express.Router();

/**
 * GET /api/v1/daily-news-stocks
 * Get today's news stocks (or latest available)
 * Access: All users (auth optional for count, required for full data)
 */
router.get("/", optionalAuth, async (req, res) => {
  try {
    const { stocks, scrape_date, is_today, source, message } = await streetGainsScraper.getTodayNewsStocks();

    // Also get market sentiment (now includes Bank Nifty, sectors, SGX Nifty)
    const marketSentimentData = await streetGainsScraper.getTodayMarketSentiment();

    // Format enhanced market sentiment for response
    const formattedMarketSentiment = marketSentimentData.sentiment ? {
      nifty_50: marketSentimentData.sentiment,
      bank_nifty: marketSentimentData.bank_nifty || null,
      sgx_nifty: marketSentimentData.sgx_nifty || null,
      sectors: marketSentimentData.sectors || null
    } : null;

    if (stocks.length === 0) {
      return res.json({
        success: true,
        stocks: [],
        count: 0,
        scrape_date: null,
        is_today: false,
        market_sentiment: formattedMarketSentiment,
        message: message || "No news stocks available. Check back after 8:30 AM IST."
      });
    }

    // Format response (stock-centric)
    const formattedStocks = stocks.map(stock => ({
      symbol: stock.symbol,
      company_name: stock.company_name,
      instrument_key: stock.instrument_key,
      headlines: stock.news_items.map(item => ({
        text: item.headline,
        // Use description if available, otherwise fall back to sentiment_reason
        description: item.description || item.sentiment_reason || null,
        category: item.category
      })),
      sentiment: stock.aggregate_sentiment,
      impact: stock.aggregate_impact,
      confidence_score: stock.confidence_score,
      has_intraday_plan: !!stock.intraday_analysis_id
    }));

    // Get scrape metadata from first stock
    const firstStock = stocks[0];

    res.json({
      success: true,
      scrape_date: scrape_date,
      is_today,
      source: {
        name: source?.name || 'Web Search',
        url: source?.url,
        scraped_at: source?.scraped_at
      },
      scrape_run_id: firstStock.scrape_run_id,
      scrape_version: firstStock.scrape_version,
      market_sentiment: formattedMarketSentiment,
      stocks: formattedStocks,
      count: formattedStocks.length
    });

  } catch (error) {
    console.error("[Daily News] Error fetching stocks:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/daily-news-stocks/market-sentiment
 * Get today's market sentiment (Nifty 50, Bank Nifty, Sectors, SGX Nifty)
 * Access: All users
 */
router.get("/market-sentiment", optionalAuth, async (req, res) => {
  try {
    const { sentiment, bank_nifty, sgx_nifty, sectors, is_today, message } = await streetGainsScraper.getTodayMarketSentiment();

    if (!sentiment) {
      return res.json({
        success: true,
        market_sentiment: null,
        is_today: false,
        message: message || "No market sentiment available. Check back after 8:30 AM IST."
      });
    }

    res.json({
      success: true,
      market_sentiment: {
        nifty_50: sentiment,
        bank_nifty: bank_nifty || null,
        sgx_nifty: sgx_nifty || null,
        sectors: sectors || null
      },
      is_today
    });

  } catch (error) {
    console.error("[Daily News] Error fetching market sentiment:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/daily-news-stocks/:symbol
 * Get details for a specific news stock
 * Access: Authenticated users
 */
router.get("/:symbol", auth, async (req, res) => {
  try {
    const { symbol } = req.params;
    const upperSymbol = symbol.toUpperCase();

    // Get today's or latest scrape date
    const { stocks, scrape_date } = await streetGainsScraper.getTodayNewsStocks();

    if (stocks.length === 0) {
      return res.status(404).json({
        success: false,
        error: "No news data available"
      });
    }

    // Find the specific stock
    const stock = stocks.find(s => s.symbol === upperSymbol);

    if (!stock) {
      return res.status(404).json({
        success: false,
        error: `Stock ${upperSymbol} not found in today's news`
      });
    }

    res.json({
      success: true,
      stock: {
        symbol: stock.symbol,
        company_name: stock.company_name,
        instrument_key: stock.instrument_key,
        headlines: stock.news_items.map(item => ({
          text: item.headline,
          description: item.description || null,  // Detailed news description
          category: item.category,
          sentiment: item.sentiment,
          impact: item.impact,
          reason: item.sentiment_reason
        })),
        aggregate_sentiment: stock.aggregate_sentiment,
        aggregate_impact: stock.aggregate_impact,
        confidence_score: stock.confidence_score,
        has_intraday_plan: !!stock.intraday_analysis_id,
        intraday_analysis_id: stock.intraday_analysis_id,
        scrape_date: scrape_date
      }
    });

  } catch (error) {
    console.error("[Daily News] Error fetching stock:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/daily-news-stocks/:symbol/intraday-plan
 * Generate intraday analysis for a news stock
 * Access: Authenticated users
 */
router.post("/:symbol/intraday-plan", auth, async (req, res) => {
  try {
    const { symbol } = req.params;
    const { force_refresh = false } = req.body;
    const upperSymbol = symbol.toUpperCase();

    // Get today's or latest scrape date
    const { stocks, scrape_date } = await streetGainsScraper.getTodayNewsStocks();

    if (stocks.length === 0) {
      return res.status(404).json({
        success: false,
        error: "No news data available"
      });
    }

    // Find the specific stock
    const stock = stocks.find(s => s.symbol === upperSymbol);

    if (!stock) {
      return res.status(404).json({
        success: false,
        error: `Stock ${upperSymbol} not found in today's news`
      });
    }

    // Check if stock has instrument_key (required for analysis)
    if (!stock.instrument_key) {
      return res.status(400).json({
        success: false,
        error: "Stock not available for analysis",
        message: "This stock is not mapped to our trading database"
      });
    }

    // Generate or get cached intraday analysis
    const result = await intradayAnalyzeService.getOrGenerateAnalysis({
      instrumentKey: stock.instrument_key,
      symbol: stock.symbol,
      forceRefresh: force_refresh
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        message: result.message
      });
    }

    // Format response
    const analysis = result.analysis;
    const intradayData = analysis.analysis_data?.intraday;

    res.json({
      success: true,
      from_cache: result.from_cache,
      analysis: {
        id: analysis._id,
        symbol: analysis.stock_symbol,
        company_name: analysis.stock_name,
        direction: intradayData?.direction,
        levels: intradayData?.levels,
        sentiment: intradayData?.sentiment,
        impact: intradayData?.impact,
        confidence_score: intradayData?.confidence_score,
        reasoning: intradayData?.reasoning,
        valid_until: analysis.valid_until,
        created_at: analysis.created_at
      }
    });

  } catch (error) {
    console.error("[Daily News] Error generating intraday plan:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/daily-news-stocks/:symbol/intraday-status
 * Check intraday analysis status for a news stock
 * Access: Authenticated users
 */
router.get("/:symbol/intraday-status", auth, async (req, res) => {
  try {
    const { symbol } = req.params;
    const upperSymbol = symbol.toUpperCase();

    // Get today's or latest scrape date
    const { stocks } = await streetGainsScraper.getTodayNewsStocks();

    if (stocks.length === 0) {
      return res.json({
        success: true,
        has_analysis: false,
        in_news_today: false,
        can_analyze: false
      });
    }

    // Find the specific stock
    const stock = stocks.find(s => s.symbol === upperSymbol);

    if (!stock) {
      return res.json({
        success: true,
        has_analysis: false,
        in_news_today: false,
        can_analyze: false
      });
    }

    // Check if stock has instrument_key
    if (!stock.instrument_key) {
      return res.json({
        success: true,
        has_analysis: false,
        in_news_today: true,
        can_analyze: false,
        reason: "Stock not mapped to trading database"
      });
    }

    // Get analysis status
    const status = await intradayAnalyzeService.getAnalysisStatus(stock.instrument_key);

    res.json({
      success: true,
      symbol: upperSymbol,
      ...status
    });

  } catch (error) {
    console.error("[Daily News] Error checking intraday status:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/daily-news-stocks/refresh
 * Manually trigger news scrape (admin only)
 * Access: Admin only
 */
router.post("/refresh", adminAuth, async (req, res) => {
  try {
    console.log("[Daily News] Manual refresh triggered by admin");

    // Trigger scrape job
    const result = await dailyNewsStocksJob.triggerNow();

    res.json({
      success: true,
      message: "News scrape job triggered",
      jobId: result.jobId,
      scheduledAt: result.scheduledAt
    });

  } catch (error) {
    console.error("[Daily News] Error triggering refresh:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/daily-news-stocks/stats
 * Get scraper job stats (admin only)
 * Access: Admin only
 */
router.get("/admin/stats", adminAuth, async (req, res) => {
  try {
    const stats = dailyNewsStocksJob.getStats();
    const nextRun = await dailyNewsStocksJob.getNextRun();

    // Get today's stock count
    const todayStocks = await DailyNewsStock.getTodayStocks();

    res.json({
      success: true,
      stats: {
        ...stats,
        nextScheduledRun: nextRun,
        todayStocksCount: todayStocks.length
      }
    });

  } catch (error) {
    console.error("[Daily News] Error fetching stats:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/daily-news-stocks/history
 * Get historical news data (admin only)
 * Access: Admin only
 */
router.get("/admin/history", adminAuth, async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const daysNum = Math.min(parseInt(days) || 7, 30);

    // Get unique scrape dates in last N days
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysNum);

    const history = await DailyNewsStock.aggregate([
      { $match: { scrape_date: { $gte: startDate } } },
      {
        $group: {
          _id: "$scrape_date",
          stock_count: { $sum: 1 },
          scrape_run_id: { $first: "$scrape_run_id" },
          scrape_version: { $first: "$scrape_version" }
        }
      },
      { $sort: { _id: -1 } }
    ]);

    res.json({
      success: true,
      history: history.map(h => ({
        date: h._id,
        stock_count: h.stock_count,
        scrape_run_id: h.scrape_run_id,
        scrape_version: h.scrape_version
      })),
      days_requested: daysNum
    });

  } catch (error) {
    console.error("[Daily News] Error fetching history:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
