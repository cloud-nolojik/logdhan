/**
 * Intraday Monitor Job
 *
 * Scheduled every 15 minutes during market hours (9:15 AM - 3:30 PM IST, weekdays)
 * Monitors for stop loss, T1, and T2 hits for stocks with active positions.
 *
 * Purpose:
 * - Execute entries for ENTRY_SIGNALED stocks at market open (first run of the day)
 * - Detect stop/T1/T2 hits DURING market hours (not just at EOD)
 * - Create intraday alerts that persist to the stock
 *
 * The GET endpoint is now a pure read — this job handles intraday monitoring.
 */

import Agenda from 'agenda';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import WeeklyWatchlist from '../../models/weeklyWatchlist.js';
import priceCacheService from '../priceCache.service.js';
import { firebaseService } from '../firebase/firebase.service.js';
import kiteOrderService from '../kiteOrder.service.js';
import { isKiteIntegrationEnabled } from '../kiteTradeIntegration.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class IntradayMonitorJob {
  constructor() {
    this.agenda = null;
    this.isInitialized = false;
    this.isRunning = false;
    this.stats = {
      runsCompleted: 0,
      alertsTriggered: 0,
      lastRunAt: null,
      lastAlerts: []
    };
  }

  /**
   * Initialize the job scheduler
   */
  async initialize() {
    if (this.isInitialized) {
      console.log('[INTRADAY-MONITOR] Already initialized');
      return;
    }

    try {
      console.log('[INTRADAY-MONITOR] Initializing intraday monitor job...');

      const mongoUrl = process.env.MONGODB_URI;
      this.agenda = new Agenda({
        db: {
          address: mongoUrl,
          collection: 'intraday_monitor_jobs',
          options: {
            useUnifiedTopology: true
          }
        },
        processEvery: '1 minute',
        maxConcurrency: 1,
        defaultConcurrency: 1
      });

      // Define jobs
      this.defineJobs();

      // Setup event handlers
      this.setupEventHandlers();

      // Wait for Agenda to be ready
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Agenda MongoDB connection timeout after 30s'));
        }, 30000);

        this.agenda.on('ready', () => {
          clearTimeout(timeout);
          console.log('[INTRADAY-MONITOR] Agenda MongoDB connection ready');
          resolve();
        });

        this.agenda.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // Start agenda
      await this.agenda.start();

      // Schedule recurring jobs
      await this.scheduleRecurringJobs();

      this.isInitialized = true;
      console.log('[INTRADAY-MONITOR] Initialization complete');

    } catch (error) {
      console.error('[INTRADAY-MONITOR] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Define all job types
   */
  defineJobs() {
    // Main intraday monitoring job - runs every 15 min during market hours
    this.agenda.define('intraday-monitor', async (job) => {
      if (this.isRunning) {
        console.log('[INTRADAY-MONITOR] Already running, skipping duplicate trigger');
        return { skipped: true, reason: 'already_running' };
      }

      // Check if we're in market hours (9:15 AM - 3:30 PM IST, weekdays)
      if (!this.isMarketHours()) {
        console.log('[INTRADAY-MONITOR] Outside market hours, skipping');
        return { skipped: true, reason: 'outside_market_hours' };
      }

      this.isRunning = true;
      console.log('[INTRADAY-MONITOR] Starting intraday monitoring...');

      try {
        const result = await this.runMonitoring();

        this.stats.runsCompleted++;
        this.stats.lastRunAt = new Date();
        this.stats.alertsTriggered += result.alerts?.length || 0;
        this.stats.lastAlerts = result.alerts || [];

        console.log(`[INTRADAY-MONITOR] Completed: ${result.stocksChecked} stocks checked, ${result.alerts?.length || 0} alerts`);

        return result;

      } catch (error) {
        console.error('[INTRADAY-MONITOR] Monitoring failed:', error);
        throw error;
      } finally {
        this.isRunning = false;
      }
    });

    // Manual trigger for testing
    this.agenda.define('manual-intraday-monitor', async (job) => {
      if (this.isRunning) {
        console.log('[INTRADAY-MONITOR] Already running, skipping manual trigger');
        return { skipped: true, reason: 'already_running' };
      }

      this.isRunning = true;
      console.log('[INTRADAY-MONITOR] Manual monitoring requested');

      try {
        const result = await this.runMonitoring();
        this.stats.lastRunAt = new Date();
        return result;

      } catch (error) {
        console.error('[INTRADAY-MONITOR] Manual monitoring failed:', error);
        throw error;
      } finally {
        this.isRunning = false;
      }
    });
  }

  /**
   * Check if current time is within market hours (IST)
   */
  isMarketHours() {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);

    const dayOfWeek = istNow.getUTCDay(); // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
    const hour = istNow.getUTCHours();
    const minute = istNow.getUTCMinutes();
    const timeInMinutes = hour * 60 + minute;

    // Market hours: 9:15 AM (555 min) to 3:30 PM (930 min), Mon-Fri
    const marketOpen = 9 * 60 + 15;  // 9:15 AM = 555 minutes
    const marketClose = 15 * 60 + 30; // 3:30 PM = 930 minutes

    const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
    const isMarketTime = timeInMinutes >= marketOpen && timeInMinutes <= marketClose;

    return isWeekday && isMarketTime;
  }

  /**
   * Load price from JSON file (15-min candle format for testing)
   * Format: { status, data: { candles: [[ts, o, h, l, c, v], ...] } }
   * Uses latest candle (index 0) for testing
   */
  loadPriceFromFile(filePath) {
    const runLabel = '[INTRADAY-MONITOR]';
    try {
      const rawData = fs.readFileSync(filePath, 'utf-8');
      const jsonData = JSON.parse(rawData);

      if (jsonData.status !== 'success' || !jsonData.data?.candles) {
        throw new Error('Invalid candle data format in file');
      }

      const candles = jsonData.data.candles;
      const latestCandle = candles[0];
      const [timestamp, open, high, low, close, volume] = latestCandle;
      console.log(`${runLabel} Loaded 15-min candle: H:₹${high} L:₹${low} C:₹${close} @ ${timestamp}`);
      return { type: 'candle', close, high, low, open, timestamp, volume };
    } catch (error) {
      console.error(`${runLabel} Failed to load price from file:`, error.message);
      throw error;
    }
  }

  /**
   * Execute entry for ENTRY_SIGNALED stock
   * Uses qty from ENTRY_SIGNAL event (already adjusted for entry quality)
   * @param {Object} stock - The stock object from watchlist
   * @param {Object} options - { dryRun, runLabel }
   * @returns {Object} { executed: boolean, alert: Object|null }
   */
  async executeEntry(stock, options = {}) {
    const { dryRun = false, runLabel = '[INTRADAY-MONITOR]' } = options;
    const sim = stock.trade_simulation;
    const levels = stock.levels;
    const stop = levels.stop;

    // Get entry price and qty from ENTRY_SIGNAL event
    // The signal price (close on signal day) is the realistic entry price
    const signalEvent = sim.events?.find(e => e.type === 'ENTRY_SIGNAL');
    const entryPrice = signalEvent?.price || sim.signal_close || levels.entry;
    const qty = signalEvent?.qty || sim.qty_total || Math.floor((sim.capital || 100000) / entryPrice);
    const entryDate = new Date();

    // Execute the entry at planned entry price
    sim.entry_price = entryPrice;
    sim.entry_date = entryDate;
    sim.trailing_stop = stop;
    sim.status = 'ENTERED';
    sim.qty_total = qty;
    sim.qty_remaining = qty;
    sim.realized_pnl = 0;
    sim.unrealized_pnl = 0;
    sim.peak_price = entryPrice;
    sim.peak_gain_pct = 0;

    const signalDateStr = sim.signal_date
      ? (sim.signal_date instanceof Date
          ? sim.signal_date.toISOString().split('T')[0]
          : new Date(sim.signal_date).toISOString().split('T')[0])
      : 'N/A';

    if (!sim.events) sim.events = [];
    sim.events.push({
      date: entryDate,
      type: 'ENTRY',
      price: entryPrice,
      qty: qty,
      pnl: 0,
      detail: `Bought ${qty} shares at ₹${entryPrice.toFixed(2)}. Signal confirmed on ${signalDateStr}.`
    });

    // Clear signal fields
    sim.signal_date = null;
    sim.signal_close = null;

    // Sync tracking_status (ABOVE_ENTRY = triggered and running)
    stock.tracking_status = 'ABOVE_ENTRY';

    console.log(`${runLabel} ✅ ${stock.symbol}: ENTERED at ₹${entryPrice.toFixed(2)} — ${qty} shares`);

    // Send push notification for entry
    if (!dryRun) {
      try {
        await firebaseService.sendAnalysisCompleteToAllUsers(
          `🚀 Entry Executed: ${stock.symbol}`,
          `Bought ${qty} shares at ₹${entryPrice.toFixed(2)}`,
          { type: 'entry_executed', symbol: stock.symbol, route: '/weekly-watchlist' }
        );
      } catch (notifError) {
        console.error(`${runLabel} Failed to send entry notification:`, notifError.message);
      }
    } else {
      console.log(`${runLabel} [DRY-RUN] Would send entry notification (skipped)`);
    }

    // Create alert for tracking
    const alert = {
      symbol: stock.symbol,
      date: entryDate,
      type: 'ENTRY_EXECUTED',
      price: entryPrice,
      message: `Entry executed at ₹${entryPrice.toFixed(2)} (${qty} shares)`
    };

    // Place OCO GTT for SL + Target (Kite integration)
    if (!dryRun && isKiteIntegrationEnabled()) {
      try {
        const t1 = levels.target1 || levels.target2;
        if (t1 && stop && qty > 0) {
          console.log(`${runLabel} [KITE] Placing OCO GTT for ${stock.symbol}: SL=₹${stop}, T1=₹${t1}, Qty=${qty}`);

          const ocoResult = await kiteOrderService.placeOCOGTT({
            tradingSymbol: stock.symbol,
            currentPrice: entryPrice,
            stopLoss: stop,
            target: t1,
            quantity: qty,
            stockId: stock._id,
            simulationId: sim._id || `sim_${stock._id}`,
            orderType: 'STOP_LOSS'
          });

          console.log(`${runLabel} [KITE] OCO GTT placed successfully: ${ocoResult.triggerId}`);
        } else {
          console.log(`${runLabel} [KITE] Skipping OCO GTT - missing levels: t1=${t1}, stop=${stop}, qty=${qty}`);
        }
      } catch (kiteError) {
        console.error(`${runLabel} [KITE] Failed to place OCO GTT for ${stock.symbol}:`, kiteError.message);
        // Don't fail the entry execution if GTT placement fails
      }
    }

    return { executed: true, alert };
  }

  /**
   * Run the monitoring logic
   * @param {Object} options - Optional settings
   * @param {boolean} options.dryRun - If true, don't save to DB or send notifications
   * @param {string} options.priceFile - Path to JSON file for price data (instead of price cache)
   * @param {string} options.symbol - Filter to specific symbol
   */
  async runMonitoring(options = {}) {
    const { dryRun = false, priceFile = null, symbol = null } = options;
    const runLabel = '[INTRADAY-MONITOR]';

    if (dryRun) console.log(`${runLabel} DRY-RUN MODE - no DB writes or notifications`);
    if (priceFile) console.log(`${runLabel} Using price from file: ${priceFile}`);
    if (symbol) console.log(`${runLabel} Filtering to symbol: ${symbol}`);

    // Get current week's watchlist
    const watchlist = await WeeklyWatchlist.getCurrentWeek();
    if (!watchlist || watchlist.stocks.length === 0) {
      console.log(`${runLabel} No active watchlist or no stocks. Skipping.`);
      return { stocksChecked: 0, alerts: [] };
    }

    // ══════════════════════════════════════════════
    // PHASE 1: Execute entries for ENTRY_SIGNALED stocks
    // ══════════════════════════════════════════════
    let signaledStocks = watchlist.stocks.filter(s => {
      const simStatus = s.trade_simulation?.status;
      return simStatus === 'ENTRY_SIGNALED';
    });

    // Apply symbol filter if specified
    if (symbol) {
      signaledStocks = signaledStocks.filter(s => s.symbol.toUpperCase() === symbol.toUpperCase());
    }

    const alerts = [];
    let needsSave = false;

    if (signaledStocks.length > 0) {
      console.log(`${runLabel} Found ${signaledStocks.length} ENTRY_SIGNALED stocks - executing entries at today's open`);

      for (const stock of signaledStocks) {
        const entryResult = await this.executeEntry(stock, { dryRun, runLabel });
        if (entryResult.executed) {
          needsSave = true;
          if (entryResult.alert) {
            alerts.push(entryResult.alert);
          }
        }
      }
    }

    // ══════════════════════════════════════════════
    // PHASE 2: Monitor active positions (ENTERED, PARTIAL_EXIT)
    // Skip stocks that were just entered in Phase 1 (same run)
    // ══════════════════════════════════════════════
    const justEnteredSymbols = signaledStocks.map(s => s.symbol);
    let activeStocks = watchlist.stocks.filter(s => {
      const simStatus = s.trade_simulation?.status;
      const isActive = simStatus === 'ENTERED' || simStatus === 'PARTIAL_EXIT';
      const wasJustEntered = justEnteredSymbols.includes(s.symbol);
      return isActive && !wasJustEntered;
    });

    // Apply symbol filter if specified
    if (symbol) {
      activeStocks = activeStocks.filter(s => s.symbol.toUpperCase() === symbol.toUpperCase());
    }

    if (activeStocks.length === 0 && signaledStocks.length === 0) {
      console.log(`${runLabel} No stocks to process. Skipping.`);
      return { stocksChecked: 0, alerts: [] };
    }

    if (activeStocks.length > 0) {
      console.log(`${runLabel} Checking ${activeStocks.length} stocks with active positions`);
    }

    // Fetch prices - from test file (candle format) or real-time API
    let priceDataMap = {};
    if (activeStocks.length > 0) {
      if (priceFile) {
        // Test mode: load 15-min candle from file (same candle for all stocks)
        const fileData = this.loadPriceFromFile(priceFile);
        activeStocks.forEach(s => {
          priceDataMap[s.instrument_key] = {
            price: fileData.close,
            high: fileData.high,
            low: fileData.low,
            open: fileData.open,
            timestamp: fileData.timestamp
          };
        });
      } else {
        // Production: fetch real-time 15-min candles from Upstox API
        // TODO: Replace priceCacheService with direct Upstox intraday candle API call
        const instrumentKeys = activeStocks.map(s => s.instrument_key);
        priceDataMap = await priceCacheService.getLatestPricesWithChange(instrumentKeys);
      }
    }

    for (const stock of activeStocks) {
      const priceData = priceDataMap[stock.instrument_key];
      const livePrice = priceData?.price;
      const priceTimestamp = priceData?.timestamp || priceData?.last_trade_time || null;

      // For candle data: use high for T1/T2, low for stop, close for current price
      // For LTP data: high/low will be undefined, fall back to livePrice
      const candleHigh = priceData?.high || livePrice;
      const candleLow = priceData?.low || livePrice;

      if (!livePrice) {
        console.log(`${runLabel} ${stock.symbol}: No price data, skipping`);
        continue;
      }

      // Log candle data if available, otherwise just LTP
      if (priceData?.high && priceData?.low) {
        console.log(`${runLabel} ${stock.symbol}: Candle H:₹${candleHigh} L:₹${candleLow} C:₹${livePrice} @ ${priceTimestamp || 'N/A'}`);
      } else {
        console.log(`${runLabel} ${stock.symbol}: LTP ₹${livePrice} @ ${priceTimestamp || 'N/A'}`);
      }

      const sim = stock.trade_simulation;
      const levels = stock.levels;
      // 3-stage targets: T1 → T2 → T3 (T3 is optional)
      const t1 = levels.target1;           // T1: 50% booking
      const t2 = levels.target2;           // T2: Main target (70% of remaining if T3 exists, else 100%)
      const t3 = levels.target3;           // T3: Extension target (optional - book final 30%)
      const trailingStop = sim.trailing_stop || levels.stop;

      // Debug: show current status and levels
      console.log(`${runLabel} ${stock.symbol}: Status=${sim.status}, T1=₹${t1?.toFixed(2)}, T2=₹${t2?.toFixed(2)}, T3=₹${t3?.toFixed(2) || 'N/A'}, Stop=₹${trailingStop?.toFixed(2)}`);

      // Initialize intraday_alerts if needed
      if (!stock.intraday_alerts) {
        stock.intraday_alerts = [];
      }

      // Update peak price if candle high is higher than current peak
      const currentPeak = sim.peak_price || sim.entry_price;
      if (candleHigh > currentPeak) {
        sim.peak_price = candleHigh;
        sim.peak_gain_pct = parseFloat((((candleHigh - sim.entry_price) / sim.entry_price) * 100).toFixed(2));
        needsSave = true;
      }

      // Check for alerts (only if not already alerted today for this type)
      const todayStr = new Date().toISOString().split('T')[0];
      const todaysAlerts = stock.intraday_alerts.filter(a =>
        a.date.toISOString().split('T')[0] === todayStr
      );

      // ══════════════════════════════════════════════
      // CHECK STOP LOSS (use candle low to catch intraday hits)
      // ══════════════════════════════════════════════
      if (candleLow <= trailingStop) {
        const hasStopAlert = todaysAlerts.some(a => a.type === 'STOP_HIT' || a.type === 'TRAILING_STOP_HIT');
        if (!hasStopAlert) {
          const isTrailing = trailingStop > levels.stop;
          const alertType = isTrailing ? 'TRAILING_STOP_HIT' : 'STOP_HIT';

          // Calculate P&L for this exit
          const exitPnl = (trailingStop - sim.entry_price) * sim.qty_remaining;
          sim.realized_pnl = (sim.realized_pnl || 0) + exitPnl;
          sim.qty_exited = (sim.qty_exited || 0) + sim.qty_remaining;
          sim.qty_remaining = 0;
          sim.status = 'STOPPED_OUT';
          sim.total_pnl = Math.round(sim.realized_pnl);
          sim.total_return_pct = parseFloat(((sim.total_pnl / sim.capital) * 100).toFixed(2));

          // Add event to simulation
          if (!sim.events) sim.events = [];
          sim.events.push({
            date: new Date(),
            type: isTrailing ? 'TRAILING_STOP' : 'STOPPED_OUT',
            price: trailingStop,
            qty: sim.qty_exited,
            pnl: Math.round(exitPnl),
            detail: isTrailing
              ? `Trailing stop hit at ₹${trailingStop.toFixed(2)} — position closed intraday`
              : `Stop loss hit at ₹${trailingStop.toFixed(2)} — position closed intraday`
          });

          // Sync tracking_status
          stock.tracking_status = 'STOPPED_OUT';

          const alert = {
            date: new Date(),
            type: alertType,
            price: livePrice,
            level: trailingStop,
            price_timestamp: priceTimestamp,
            message: isTrailing
              ? `Trailing stop hit at ₹${livePrice.toFixed(2)} (stop: ₹${trailingStop.toFixed(2)})`
              : `Stop loss hit at ₹${livePrice.toFixed(2)} (stop: ₹${trailingStop.toFixed(2)})`
          };

          stock.intraday_alerts.push(alert);
          alerts.push({ symbol: stock.symbol, ...alert });
          needsSave = true;

          console.log(`${runLabel} 🔴 ${stock.symbol}: ${alertType} at ₹${livePrice.toFixed(2)} @ ${priceTimestamp || 'N/A'} — sim updated to STOPPED_OUT`);

          // Send push notification
          if (!dryRun) {
            try {
              await firebaseService.sendAnalysisCompleteToAllUsers(
                `⚠️ Stop Hit: ${stock.symbol}`,
                alert.message,
                { type: 'stop_hit', symbol: stock.symbol, route: '/weekly-watchlist' }
              );
            } catch (notifError) {
              console.error(`${runLabel} Failed to send notification:`, notifError.message);
            }
          } else {
            console.log(`${runLabel} [DRY-RUN] Would send stop notification (skipped)`);
          }
        }
        continue; // Stop hit takes priority, skip other checks
      }

      // ══════════════════════════════════════════════
      // CHECK T1 (only for ENTERED status, use candle high to catch intraday hits)
      // ══════════════════════════════════════════════
      if (sim.status === 'ENTERED' && t1 && candleHigh >= t1) {
        const hasT1Alert = todaysAlerts.some(a => a.type === 'T1_HIT');
        if (!hasT1Alert) {
          // Calculate P&L for 50% booking
          const exitQty = Math.floor(sim.qty_total / 2);
          const exitPnl = (t1 - sim.entry_price) * exitQty;
          sim.realized_pnl = (sim.realized_pnl || 0) + exitPnl;
          sim.qty_remaining -= exitQty;
          sim.qty_exited = (sim.qty_exited || 0) + exitQty;
          sim.trailing_stop = sim.entry_price;  // Move stop to breakeven
          sim.status = 'PARTIAL_EXIT';

          // Update P&L (unrealized for remaining position)
          sim.unrealized_pnl = (livePrice - sim.entry_price) * sim.qty_remaining;
          sim.total_pnl = Math.round(sim.realized_pnl + sim.unrealized_pnl);
          sim.total_return_pct = parseFloat(((sim.total_pnl / sim.capital) * 100).toFixed(2));

          // Add event to simulation
          if (!sim.events) sim.events = [];
          sim.events.push({
            date: new Date(),
            type: 'T1_HIT',
            price: t1,
            qty: exitQty,
            pnl: Math.round(exitPnl),
            detail: `T1 hit intraday! Booked 50% (${exitQty} shares) at ₹${t1.toFixed(2)} | Stop → entry ₹${sim.entry_price.toFixed(2)}`
          });

          // Sync tracking_status
          stock.tracking_status = 'TARGET1_HIT';

          const alert = {
            date: new Date(),
            type: 'T1_HIT',
            price: livePrice,
            level: t1,
            price_timestamp: priceTimestamp,
            message: `T1 hit at ₹${livePrice.toFixed(2)} (target: ₹${t1.toFixed(2)}) — Book 50% profits!`
          };

          stock.intraday_alerts.push(alert);
          alerts.push({ symbol: stock.symbol, ...alert });
          needsSave = true;

          console.log(`${runLabel} 🎯 ${stock.symbol}: T1_HIT at ₹${livePrice.toFixed(2)} @ ${priceTimestamp || 'N/A'} — sim updated to PARTIAL_EXIT`);

          // Send push notification
          if (!dryRun) {
            try {
              await firebaseService.sendAnalysisCompleteToAllUsers(
                `🎯 T1 Hit: ${stock.symbol}`,
                alert.message,
                { type: 't1_hit', symbol: stock.symbol, route: '/weekly-watchlist' }
              );
            } catch (notifError) {
              console.error(`${runLabel} Failed to send notification:`, notifError.message);
            }
          } else {
            console.log(`${runLabel} [DRY-RUN] Would send T1 notification (skipped)`);
          }
        }
      }

      // ══════════════════════════════════════════════
      // CHECK T2 (main swing target)
      // If T3 exists: book 70% of remaining, keep 30% for T3
      // If T3 does NOT exist: book 100% (full exit)
      // Only for PARTIAL_EXIT status, use candle high to catch intraday hits
      // ══════════════════════════════════════════════
      if (sim.status === 'PARTIAL_EXIT' && t2 && candleHigh >= t2) {
        const hasT2Alert = todaysAlerts.some(a => a.type === 'T2_HIT');
        if (!hasT2Alert) {
          // If T3 exists: book 70%, keep 30% for T3
          // If T3 does NOT exist: book 100% (full exit at T2)
          const bookingPct = t3 ? 0.7 : 1.0;
          const exitQty = t3 ? Math.floor(sim.qty_remaining * bookingPct) : sim.qty_remaining;
          const keepQty = sim.qty_remaining - exitQty;
          const exitPnl = (t2 - sim.entry_price) * exitQty;

          sim.realized_pnl = (sim.realized_pnl || 0) + exitPnl;
          sim.qty_remaining = keepQty;
          sim.qty_exited = (sim.qty_exited || 0) + exitQty;

          // If holding for T3, move trailing stop to T2
          if (t3) {
            sim.trailing_stop = t2;
          }

          // Update P&L
          sim.unrealized_pnl = keepQty > 0 ? (livePrice - sim.entry_price) * sim.qty_remaining : 0;
          sim.total_pnl = Math.round(sim.realized_pnl + sim.unrealized_pnl);
          sim.total_return_pct = parseFloat(((sim.total_pnl / sim.capital) * 100).toFixed(2));

          // If no T3, this is full exit
          if (!t3) {
            sim.status = 'FULL_EXIT';
          }

          // Add event to simulation
          if (!sim.events) sim.events = [];
          const detailMsg = t3
            ? `T2 hit! Booked 70% (${exitQty} shares) at ₹${t2.toFixed(2)} | Holding ${keepQty} shares for T3 (₹${t3.toFixed(2)}) | Stop → T2 ₹${t2.toFixed(2)}`
            : `T2 hit! Booked 100% (${exitQty} shares) at ₹${t2.toFixed(2)} — FULL TARGET (no T3) 🏆`;
          sim.events.push({
            date: new Date(),
            type: 'T2_HIT',
            price: t2,
            qty: exitQty,
            pnl: Math.round(exitPnl),
            detail: detailMsg
          });

          // Sync tracking_status
          stock.tracking_status = t3 ? 'TARGET_HIT' : 'FULL_EXIT';

          const alertMsg = t3
            ? `T2 hit! Booked ${exitQty} shares at ₹${t2.toFixed(2)} — Holding ${keepQty} for T3 | Stop → T2`
            : `T2 hit! Booked all ${exitQty} shares at ₹${t2.toFixed(2)} — Full target achieved! 🏆`;
          const alert = {
            date: new Date(),
            type: 'T2_HIT',
            price: livePrice,
            level: t2,
            price_timestamp: priceTimestamp,
            message: alertMsg
          };

          stock.intraday_alerts.push(alert);
          alerts.push({ symbol: stock.symbol, ...alert });
          needsSave = true;

          console.log(`${runLabel} ⭐ ${stock.symbol}: T2_HIT at ₹${livePrice.toFixed(2)} @ ${priceTimestamp || 'N/A'} — booked ${exitQty}${t3 ? `, holding ${keepQty} for T3` : ' (FULL EXIT)'}`);

          // Send push notification
          if (!dryRun) {
            try {
              await firebaseService.sendAnalysisCompleteToAllUsers(
                t3 ? `⭐ T2 Hit: ${stock.symbol}` : `🏆 T2 Hit: ${stock.symbol}`,
                alert.message,
                { type: 't2_hit', symbol: stock.symbol, route: '/weekly-watchlist' }
              );
            } catch (notifError) {
              console.error(`${runLabel} Failed to send notification:`, notifError.message);
            }
          } else {
            console.log(`${runLabel} [DRY-RUN] Would send T2 notification (skipped)`);
          }
        }
      }

      // ══════════════════════════════════════════════
      // CHECK T3 (extension target - only if T3 exists)
      // Full exit - maximum profit target
      // Only for PARTIAL_EXIT status (after T2 hit with T3 existing)
      // ══════════════════════════════════════════════
      if (sim.status === 'PARTIAL_EXIT' && t3 && candleHigh >= t3) {
        const hasT3Alert = todaysAlerts.some(a => a.type === 'T3_HIT');
        if (!hasT3Alert) {
          // Calculate P&L for remaining position (final 30%)
          const exitPnl = (t3 - sim.entry_price) * sim.qty_remaining;
          sim.realized_pnl = (sim.realized_pnl || 0) + exitPnl;
          sim.qty_exited = (sim.qty_exited || 0) + sim.qty_remaining;
          sim.qty_remaining = 0;
          sim.unrealized_pnl = 0;
          sim.status = 'FULL_EXIT';
          sim.total_pnl = Math.round(sim.realized_pnl);
          sim.total_return_pct = parseFloat(((sim.total_pnl / sim.capital) * 100).toFixed(2));

          // Add event to simulation
          if (!sim.events) sim.events = [];
          sim.events.push({
            date: new Date(),
            type: 'T3_HIT',
            price: t3,
            qty: sim.qty_exited,
            pnl: Math.round(exitPnl),
            detail: `T3 hit intraday! Full target achieved at ₹${t3.toFixed(2)} 🏆`
          });

          // Sync tracking_status
          stock.tracking_status = 'FULL_EXIT';

          const alert = {
            date: new Date(),
            type: 'T3_HIT',
            price: livePrice,
            level: t3,
            price_timestamp: priceTimestamp,
            message: `T3 hit at ₹${livePrice.toFixed(2)} (target: ₹${t3.toFixed(2)}) — Full target achieved! 🏆`
          };

          stock.intraday_alerts.push(alert);
          alerts.push({ symbol: stock.symbol, ...alert });
          needsSave = true;

          console.log(`${runLabel} 🏆 ${stock.symbol}: T3_HIT at ₹${livePrice.toFixed(2)} @ ${priceTimestamp || 'N/A'} — sim updated to FULL_EXIT`);

          // Send push notification
          if (!dryRun) {
            try {
              await firebaseService.sendAnalysisCompleteToAllUsers(
                `🏆 T3 Hit: ${stock.symbol}`,
                alert.message,
                { type: 't3_hit', symbol: stock.symbol, route: '/weekly-watchlist' }
              );
            } catch (notifError) {
              console.error(`${runLabel} Failed to send notification:`, notifError.message);
            }
          } else {
            console.log(`${runLabel} [DRY-RUN] Would send T3 notification (skipped)`);
          }
        }
      }
    }

    // Save watchlist if any alerts were created
    if (needsSave) {
      if (dryRun) {
        console.log(`${runLabel} [DRY-RUN] Would save ${alerts.length} intraday alerts (skipped)`);
      } else {
        await watchlist.save();
        console.log(`${runLabel} Saved ${alerts.length} intraday alerts`);
      }
    }

    return {
      stocksChecked: activeStocks.length,
      alerts,
      dryRun
    };
  }

  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    this.agenda.on('ready', () => {
      console.log('[INTRADAY-MONITOR] Agenda ready');
    });

    this.agenda.on('start', (job) => {
      console.log(`[INTRADAY-MONITOR] Job starting: ${job.attrs.name}`);
    });

    this.agenda.on('complete', (job) => {
      console.log(`[INTRADAY-MONITOR] Job completed: ${job.attrs.name}`);
    });

    this.agenda.on('fail', (err, job) => {
      console.error(`[INTRADAY-MONITOR] Job failed: ${job.attrs.name}`, err);
    });
  }

  /**
   * Schedule recurring jobs
   */
  async scheduleRecurringJobs() {
    try {
      // Cancel existing jobs to avoid duplicates
      await this.agenda.cancel({
        name: 'intraday-monitor'
      });

      // Every 15 minutes during market hours (9:15 AM - 3:30 PM IST, weekdays)
      // The job itself checks if we're in market hours
      // Cron: */15 = every 15 minutes
      await this.agenda.every('*/15 * * * 1-5', 'intraday-monitor', {}, {
        timezone: 'Asia/Kolkata'
      });

      console.log('[INTRADAY-MONITOR] Recurring job scheduled: every 15 min, weekdays');

    } catch (error) {
      console.error('[INTRADAY-MONITOR] Failed to schedule jobs:', error);
      throw error;
    }
  }

  /**
   * Manually trigger monitoring
   */
  async triggerNow() {
    if (!this.isInitialized) {
      throw new Error('Intraday monitor job not initialized');
    }

    console.log('[INTRADAY-MONITOR] Manual trigger requested');

    const job = await this.agenda.now('manual-intraday-monitor', {});

    return {
      success: true,
      jobId: job.attrs._id,
      scheduledAt: job.attrs.nextRunAt
    };
  }

  /**
   * Get job stats
   */
  getStats() {
    return {
      ...this.stats,
      isInitialized: this.isInitialized,
      isRunning: this.isRunning
    };
  }

  /**
   * Get next scheduled run
   */
  async getNextRun() {
    if (!this.agenda) return null;

    const jobs = await this.agenda.jobs({
      name: 'intraday-monitor',
      nextRunAt: { $exists: true }
    });

    if (jobs.length > 0) {
      return jobs[0].attrs.nextRunAt;
    }

    return null;
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    if (this.agenda) {
      await this.agenda.stop();
      console.log('[INTRADAY-MONITOR] Shutdown complete');
    }
  }
}

// Export singleton instance
const intradayMonitorJob = new IntradayMonitorJob();

export default intradayMonitorJob;
export { IntradayMonitorJob };
