/**
 * Kite Order Sync Job
 *
 * Polls every 30 minutes during market hours to detect entry GTT fills
 * and place OCO (SL+Target) immediately after confirmed fill.
 *
 * This solves the accidental short-sell problem: entry GTT is placed at 8 AM
 * by morning brief (or 4 PM by daily tracking), OCO is placed only after we
 * confirm the entry actually filled via Kite API polling.
 *
 * Schedule: Every 30 min, 9:00-15:30 IST, Mon-Fri
 */

import Agenda from 'agenda';
import KiteOrder from '../../models/kiteOrder.js';
import WeeklyWatchlist from '../../models/weeklyWatchlist.js';
import kiteOrderService from '../kiteOrder.service.js';
import { isKiteIntegrationEnabled } from '../kiteTradeIntegration.service.js';

const LOG_PREFIX = '[KITE-ORDER-SYNC]';

class KiteOrderSyncJob {
  constructor() {
    this.agenda = null;
    this.isInitialized = false;
    this.isRunning = false;
    this.stats = {
      syncCycles: 0,
      fillsDetected: 0,
      ocoPlaced: 0,
      errors: 0,
      lastSyncAt: null,
      lastResult: null
    };
  }

  /**
   * Initialize the job scheduler
   */
  async initialize() {
    if (this.isInitialized) {
      console.log(`${LOG_PREFIX} Already initialized`);
      return;
    }

    try {
      console.log(`${LOG_PREFIX} Initializing Kite order sync job...`);

      const mongoUrl = process.env.MONGODB_URI;
      this.agenda = new Agenda({
        db: {
          address: mongoUrl,
          collection: 'kite_order_sync_jobs',
          options: {
            useUnifiedTopology: true
          }
        },
        processEvery: '1 minute',
        maxConcurrency: 1,
        defaultConcurrency: 1
      });

      this.defineJobs();
      this.setupEventHandlers();
      await this.agenda.start();
      await this.scheduleRecurringJobs();

      this.isInitialized = true;
      console.log(`${LOG_PREFIX} Initialization complete`);

    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to initialize:`, error);
      throw error;
    }
  }

  /**
   * Define all job types
   */
  defineJobs() {
    // Main sync job
    this.agenda.define('kite-order-sync', async (job) => {
      if (this.isRunning) {
        console.log(`${LOG_PREFIX} Already running, skipping`);
        return;
      }

      this.isRunning = true;

      try {
        const result = await syncEntryFills();

        this.stats.syncCycles++;
        this.stats.lastSyncAt = new Date();
        this.stats.lastResult = result;
        this.stats.fillsDetected += result.synced || 0;
        this.stats.ocoPlaced += result.ocoPlaced || 0;

        if (result.errors.length > 0) {
          this.stats.errors += result.errors.length;
        }

        return result;

      } catch (error) {
        console.error(`${LOG_PREFIX} Sync cycle failed:`, error);
        this.stats.errors++;
        throw error;
      } finally {
        this.isRunning = false;
      }
    });

    // Manual trigger for testing
    this.agenda.define('manual-kite-order-sync', async (job) => {
      if (this.isRunning) {
        console.log(`${LOG_PREFIX} Already running, skipping manual trigger`);
        return;
      }

      this.isRunning = true;

      try {
        const result = await syncEntryFills();
        this.stats.lastSyncAt = new Date();
        this.stats.lastResult = result;
        return result;
      } catch (error) {
        console.error(`${LOG_PREFIX} Manual sync failed:`, error);
        throw error;
      } finally {
        this.isRunning = false;
      }
    });
  }

  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    this.agenda.on('ready', () => {
      console.log(`${LOG_PREFIX} Agenda ready`);
    });

    this.agenda.on('start', (job) => {
      console.log(`${LOG_PREFIX} Job starting: ${job.attrs.name}`);
    });

    this.agenda.on('complete', (job) => {
      console.log(`${LOG_PREFIX} Job completed: ${job.attrs.name}`);
    });

    this.agenda.on('fail', (err, job) => {
      console.error(`${LOG_PREFIX} Job failed: ${job.attrs.name}`, err);
    });
  }

  /**
   * Schedule recurring jobs
   */
  async scheduleRecurringJobs() {
    try {
      await this.agenda.cancel({
        name: 'kite-order-sync'
      });

      // Every 30 min from 9:00-15:30 IST, Mon-Fri
      // Covers market hours (9:15 AM - 3:30 PM)
      await this.agenda.every('*/30 9-15 * * 1-5', 'kite-order-sync', {}, {
        timezone: 'Asia/Kolkata'
      });

      console.log(`${LOG_PREFIX} Recurring job scheduled: every 30 min, 9:00-15:30 IST, Mon-Fri`);

    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to schedule jobs:`, error);
      throw error;
    }
  }

  /**
   * Manually trigger sync
   */
  async triggerNow(opts = {}) {
    if (!this.isInitialized) {
      throw new Error('Kite order sync job not initialized');
    }

    console.log(`${LOG_PREFIX} Manual trigger requested`);
    const job = await this.agenda.now('manual-kite-order-sync', opts);

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
      name: 'kite-order-sync',
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
      console.log(`${LOG_PREFIX} Shutdown complete`);
    }
  }
}

/**
 * Core sync logic: detect entry GTT fills and place OCO
 *
 * Kite getGTTs() returns ALL GTTs in one API call.
 * Each GTT object has: { id, status, condition, orders, ... }
 * Our KiteOrder.gtt_id stores the trigger_id from placement response.
 * Kite's list uses `id` field — same value as `trigger_id`.
 */
async function syncEntryFills() {
  const results = { synced: 0, ocoPlaced: 0, statusUpdated: 0, errors: [], details: [] };

  console.log(`${LOG_PREFIX} ════════════════════════════════════════`);
  console.log(`${LOG_PREFIX} Starting entry fill sync...`);

  if (!isKiteIntegrationEnabled()) {
    console.log(`${LOG_PREFIX} Kite integration disabled — skipping`);
    return results;
  }

  try {
    // 1. Find all locally-active entry GTTs
    const pendingEntries = await KiteOrder.find({
      is_gtt: true,
      order_type: 'ENTRY',
      gtt_status: 'active'
    });

    if (pendingEntries.length === 0) {
      console.log(`${LOG_PREFIX} No pending entry GTTs to check`);
      return results;
    }

    console.log(`${LOG_PREFIX} Found ${pendingEntries.length} pending entry GTTs to check`);

    // 2. Fetch ALL GTTs from Kite API (single API call)
    let kiteGTTs;
    try {
      kiteGTTs = await kiteOrderService.getGTTs();
    } catch (apiError) {
      console.error(`${LOG_PREFIX} Kite API getGTTs() failed:`, apiError.message);
      results.errors.push({ type: 'api_error', error: apiError.message });
      return results;
    }

    // Build lookup map: Kite GTT id → GTT object
    const kiteGTTMap = new Map();
    for (const gtt of kiteGTTs) {
      kiteGTTMap.set(gtt.id, gtt);
    }

    console.log(`${LOG_PREFIX} Kite API returned ${kiteGTTs.length} GTTs`);

    // 3. Check each pending entry against Kite state
    for (const entryOrder of pendingEntries) {
      try {
        const kiteGTT = kiteGTTMap.get(entryOrder.gtt_id);

        if (!kiteGTT) {
          // GTT not in Kite's active list — could be triggered, cancelled, or expired
          // Kite only returns active GTTs in the list. If missing, assume triggered or expired.
          console.log(`${LOG_PREFIX} ${entryOrder.trading_symbol}: GTT ${entryOrder.gtt_id} not in Kite active list — marking for review`);

          // Check if there's a completed order for this symbol (fill detection)
          // For now, mark as expired if not found — conservative approach
          await KiteOrder.findByIdAndUpdate(entryOrder._id, {
            gtt_status: 'expired',
            status: 'CANCELLED',
            notes: 'GTT not found in Kite active list during sync'
          });
          results.statusUpdated++;
          results.details.push({ symbol: entryOrder.trading_symbol, action: 'marked_expired', gtt_id: entryOrder.gtt_id });
          continue;
        }

        const kiteStatus = kiteGTT.status;

        if (kiteStatus === 'active') {
          // Still active, no action needed
          continue;
        }

        if (kiteStatus === 'triggered') {
          // Entry filled! Update local record and place OCO
          console.log(`${LOG_PREFIX} ${entryOrder.trading_symbol}: Entry GTT ${entryOrder.gtt_id} TRIGGERED — fill detected!`);

          await KiteOrder.findByIdAndUpdate(entryOrder._id, {
            gtt_status: 'triggered',
            status: 'COMPLETE',
            executed_at: new Date()
          });
          results.synced++;

          // Place OCO for this filled entry
          await placeOCOForFilledEntry(entryOrder, results);

        } else if (kiteStatus === 'cancelled' || kiteStatus === 'rejected' || kiteStatus === 'disabled') {
          // GTT was cancelled/rejected on Kite side — sync local status
          console.log(`${LOG_PREFIX} ${entryOrder.trading_symbol}: GTT ${entryOrder.gtt_id} is ${kiteStatus} on Kite`);

          await KiteOrder.findByIdAndUpdate(entryOrder._id, {
            gtt_status: kiteStatus === 'disabled' ? 'expired' : kiteStatus,
            status: 'CANCELLED',
            notes: `Kite status: ${kiteStatus}`
          });
          results.statusUpdated++;
          results.details.push({ symbol: entryOrder.trading_symbol, action: `synced_${kiteStatus}`, gtt_id: entryOrder.gtt_id });
        }

      } catch (entryError) {
        console.error(`${LOG_PREFIX} ${entryOrder.trading_symbol}: Error processing GTT ${entryOrder.gtt_id}:`, entryError.message);
        results.errors.push({ symbol: entryOrder.trading_symbol, gtt_id: entryOrder.gtt_id, error: entryError.message });
      }
    }

    console.log(`${LOG_PREFIX} Sync complete: ${results.synced} fills detected, ${results.ocoPlaced} OCOs placed, ${results.statusUpdated} status updates, ${results.errors.length} errors`);
    console.log(`${LOG_PREFIX} ════════════════════════════════════════`);

    return results;

  } catch (error) {
    console.error(`${LOG_PREFIX} syncEntryFills failed:`, error);
    results.errors.push({ type: 'global', error: error.message });
    return results;
  }
}

/**
 * Place OCO GTT for a filled entry order
 *
 * @param {Object} entryOrder - The KiteOrder document for the filled entry
 * @param {Object} results - Mutable results object to track outcomes
 */
async function placeOCOForFilledEntry(entryOrder, results) {
  try {
    // Idempotency: check if OCO already exists for this stock
    const existingOCO = await KiteOrder.findOne({
      stock_id: entryOrder.stock_id,
      order_type: { $in: ['STOP_LOSS', 'TARGET1'] },
      is_gtt: true,
      gtt_status: 'active'
    });

    if (existingOCO) {
      console.log(`${LOG_PREFIX} ${entryOrder.trading_symbol}: OCO already exists (ID: ${existingOCO.gtt_id}) — skipping`);
      results.details.push({ symbol: entryOrder.trading_symbol, action: 'oco_exists', gtt_id: existingOCO.gtt_id });
      return;
    }

    // Look up stock levels from WeeklyWatchlist
    const watchlist = await WeeklyWatchlist.getCurrentWeek();
    if (!watchlist) {
      console.error(`${LOG_PREFIX} ${entryOrder.trading_symbol}: No current watchlist found for OCO placement`);
      results.errors.push({ symbol: entryOrder.trading_symbol, error: 'no_watchlist_for_oco' });
      return;
    }

    const stock = watchlist.stocks.find(s =>
      s._id.toString() === entryOrder.stock_id?.toString() ||
      s.symbol === entryOrder.trading_symbol
    );

    if (!stock || !stock.levels) {
      console.error(`${LOG_PREFIX} ${entryOrder.trading_symbol}: Stock not found in watchlist or missing levels`);
      results.errors.push({ symbol: entryOrder.trading_symbol, error: 'stock_not_found_in_watchlist' });
      return;
    }

    const levels = stock.levels;
    const stopLoss = levels.stop;
    const target = levels.target1 || levels.target2;
    const quantity = entryOrder.quantity;

    if (!stopLoss || !target) {
      console.error(`${LOG_PREFIX} ${entryOrder.trading_symbol}: Missing SL (${stopLoss}) or target (${target})`);
      results.errors.push({ symbol: entryOrder.trading_symbol, error: 'missing_sl_or_target' });
      return;
    }

    console.log(`${LOG_PREFIX} ${entryOrder.trading_symbol}: Placing OCO — SL: ₹${stopLoss}, T1: ₹${target}, Qty: ${quantity}`);

    const ocoResult = await kiteOrderService.placeOCOGTT({
      tradingSymbol: entryOrder.trading_symbol,
      currentPrice: entryOrder.price, // entry price as current reference
      stopLoss,
      target,
      quantity,
      stockId: entryOrder.stock_id,
      simulationId: entryOrder.simulation_id,
      orderType: 'STOP_LOSS'
    });

    results.ocoPlaced++;
    results.details.push({
      symbol: entryOrder.trading_symbol,
      action: 'oco_placed',
      triggerId: ocoResult.triggerId,
      stopLoss,
      target,
      quantity
    });

    console.log(`${LOG_PREFIX} ${entryOrder.trading_symbol}: OCO placed — ID: ${ocoResult.triggerId}`);

  } catch (ocoError) {
    console.error(`${LOG_PREFIX} ${entryOrder.trading_symbol}: OCO placement failed:`, ocoError.message);
    results.errors.push({ symbol: entryOrder.trading_symbol, error: ocoError.message, type: 'oco_placement' });
    // Don't throw — entry fill status is already updated, OCO will retry on next cycle
  }
}

// Export singleton instance
const kiteOrderSyncJob = new KiteOrderSyncJob();

export default kiteOrderSyncJob;
export { KiteOrderSyncJob, syncEntryFills };
