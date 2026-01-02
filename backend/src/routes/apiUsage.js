import express from 'express';
import { auth as authenticateToken } from '../middleware/auth.js';
import ApiUsage from '../models/apiUsage.js';

const router = express.Router();

/**
 * @route GET /api/usage/today
 * @desc Get today's API usage summary
 * @access Private (Admin)
 */
router.get('/today', authenticateToken, async (req, res) => {
  try {
    const summary = await ApiUsage.getTodaySummary();

    res.json({
      success: true,
      data: {
        date: summary.date,
        by_feature: summary.by_feature.map(item => ({
          feature: item._id.feature,
          model: item._id.model,
          requests: item.total_requests,
          tokens: {
            input: item.total_input_tokens,
            output: item.total_output_tokens,
            total: item.total_tokens
          },
          cost_usd: parseFloat(item.total_cost.toFixed(4)),
          avg_response_time_ms: Math.round(item.avg_response_time || 0),
          success_rate: item.total_requests > 0
            ? ((item.success_count / item.total_requests) * 100).toFixed(1) + '%'
            : 'N/A'
        })),
        totals: {
          requests: summary.totals.total_requests,
          tokens: summary.totals.total_tokens,
          cost_usd: parseFloat(summary.totals.total_cost.toFixed(4))
        }
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Failed to get today\'s API usage:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get API usage summary',
      message: error.message
    });
  }
});

/**
 * @route GET /api/usage/monthly
 * @desc Get monthly API usage summary
 * @access Private (Admin)
 */
router.get('/monthly', authenticateToken, async (req, res) => {
  try {
    const { year, month } = req.query;

    // Default to current month
    const now = new Date();
    const targetYear = year ? parseInt(year) : now.getFullYear();
    const targetMonth = month ? parseInt(month) : now.getMonth() + 1;

    const summary = await ApiUsage.getMonthlySummary(targetYear, targetMonth);

    res.json({
      success: true,
      data: {
        year: summary.year,
        month: summary.month,
        by_feature: summary.by_feature.map(item => ({
          feature: item._id,
          requests: item.total_requests,
          tokens: {
            input: item.total_input_tokens,
            output: item.total_output_tokens,
            total: item.total_tokens
          },
          cost_usd: parseFloat(item.total_cost.toFixed(4))
        })),
        totals: {
          requests: summary.totals.total_requests,
          tokens: summary.totals.total_tokens,
          cost_usd: parseFloat(summary.totals.total_cost.toFixed(4))
        }
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Failed to get monthly API usage:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get monthly API usage',
      message: error.message
    });
  }
});

/**
 * @route GET /api/usage/range
 * @desc Get API usage for a date range
 * @access Private (Admin)
 */
router.get('/range', authenticateToken, async (req, res) => {
  try {
    const { start_date, end_date, days = 7 } = req.query;

    let startDate, endDate;

    if (start_date && end_date) {
      startDate = new Date(start_date);
      endDate = new Date(end_date);
    } else {
      // Default to last N days
      endDate = ApiUsage.getISTDateAsUTC();
      startDate = new Date(endDate);
      startDate.setDate(startDate.getDate() - parseInt(days) + 1);
    }

    const result = await ApiUsage.getUsageSummary(startDate, endDate);

    // Group by date
    const byDate = {};
    for (const item of result) {
      const dateKey = item._id.date.toISOString().split('T')[0];
      if (!byDate[dateKey]) {
        byDate[dateKey] = {
          date: dateKey,
          features: [],
          total_requests: 0,
          total_tokens: 0,
          total_cost: 0
        };
      }
      byDate[dateKey].features.push({
        feature: item._id.feature,
        requests: item.total_requests,
        tokens: item.total_tokens,
        cost_usd: parseFloat(item.total_cost.toFixed(4))
      });
      byDate[dateKey].total_requests += item.total_requests;
      byDate[dateKey].total_tokens += item.total_tokens;
      byDate[dateKey].total_cost += item.total_cost;
    }

    // Convert to array and format costs
    const dailyData = Object.values(byDate).map(day => ({
      ...day,
      total_cost: parseFloat(day.total_cost.toFixed(4))
    }));

    // Calculate totals
    const totals = dailyData.reduce((acc, day) => {
      acc.requests += day.total_requests;
      acc.tokens += day.total_tokens;
      acc.cost += day.total_cost;
      return acc;
    }, { requests: 0, tokens: 0, cost: 0 });

    res.json({
      success: true,
      data: {
        start_date: startDate.toISOString().split('T')[0],
        end_date: endDate.toISOString().split('T')[0],
        days: dailyData.length,
        daily: dailyData,
        totals: {
          requests: totals.requests,
          tokens: totals.tokens,
          cost_usd: parseFloat(totals.cost.toFixed(4))
        }
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Failed to get API usage range:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get API usage range',
      message: error.message
    });
  }
});

/**
 * @route GET /api/usage/scrape-run/:scrapeRunId
 * @desc Get API usage for a specific scrape run
 * @access Private (Admin)
 */
router.get('/scrape-run/:scrapeRunId', authenticateToken, async (req, res) => {
  try {
    const { scrapeRunId } = req.params;

    const usageRecords = await ApiUsage.find({ scrape_run_id: scrapeRunId })
      .sort({ createdAt: 1 })
      .lean();

    if (usageRecords.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No usage records found for this scrape run'
      });
    }

    // Calculate totals
    const totals = usageRecords.reduce((acc, record) => {
      acc.input_tokens += record.tokens?.input || 0;
      acc.output_tokens += record.tokens?.output || 0;
      acc.total_tokens += record.tokens?.total || 0;
      acc.total_cost += record.cost?.total_cost || 0;
      acc.total_time_ms += record.response_time_ms || 0;
      return acc;
    }, { input_tokens: 0, output_tokens: 0, total_tokens: 0, total_cost: 0, total_time_ms: 0 });

    res.json({
      success: true,
      data: {
        scrape_run_id: scrapeRunId,
        records_count: usageRecords.length,
        records: usageRecords.map(r => ({
          feature: r.feature,
          model: r.model,
          tokens: r.tokens,
          cost_usd: parseFloat((r.cost?.total_cost || 0).toFixed(6)),
          response_time_ms: r.response_time_ms,
          success: r.success,
          context: r.context,
          timestamp: r.createdAt
        })),
        totals: {
          input_tokens: totals.input_tokens,
          output_tokens: totals.output_tokens,
          total_tokens: totals.total_tokens,
          cost_usd: parseFloat(totals.total_cost.toFixed(4)),
          total_time_ms: totals.total_time_ms
        }
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Failed to get scrape run usage:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get scrape run usage',
      message: error.message
    });
  }
});

/**
 * @route GET /api/usage/pricing
 * @desc Get current API pricing information
 * @access Private
 */
router.get('/pricing', authenticateToken, async (req, res) => {
  res.json({
    success: true,
    data: {
      provider: 'OpenAI',
      models: {
        'gpt-4o': {
          input: '$2.50 / 1M tokens',
          output: '$10.00 / 1M tokens',
          input_per_token: 0.0000025,
          output_per_token: 0.00001
        },
        'gpt-4o-mini': {
          input: '$0.15 / 1M tokens',
          output: '$0.60 / 1M tokens',
          input_per_token: 0.00000015,
          output_per_token: 0.0000006
        },
        'gpt-4-turbo': {
          input: '$10.00 / 1M tokens',
          output: '$30.00 / 1M tokens',
          input_per_token: 0.00001,
          output_per_token: 0.00003
        }
      },
      features: {
        'DAILY_NEWS_STOCKS': 'Stock news web search (gpt-4o)',
        'MARKET_SENTIMENT': 'Nifty 50 market sentiment (gpt-4o)',
        'HEADLINE_SENTIMENT': 'Headline sentiment analysis (gpt-4o-mini)',
        'AI_ANALYSIS': 'Stock analysis (gpt-4o)'
      },
      last_updated: '2025-01-01'
    }
  });
});

export default router;
