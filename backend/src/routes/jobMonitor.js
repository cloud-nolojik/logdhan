import express from 'express';
import mongoose from 'mongoose';
import { auth } from '../middleware/auth.js';

// Import all job singletons
import weekendScreeningJob from '../services/jobs/weekendScreeningJob.js';
import dailyTrackingJob from '../services/jobs/dailyTrackingJob.js';
import intradayMonitorJob from '../services/jobs/intradayMonitorJob.js';
import pendingAnalysisReminderJob from '../services/jobs/pendingAnalysisReminderJob.js';
import morningBriefJob from '../services/jobs/morningBriefJob.js';
import kiteOrderSyncJob from '../services/jobs/kiteOrderSyncJob.js';
import dailyPullbackScanJob from '../services/jobs/dailyPullbackScanJob.js';
import dailyPicksJob from '../services/jobs/dailyPicksJob.js';
import dailyEntryJob from '../services/jobs/dailyEntryJob.js';
import dailyExitJob from '../services/jobs/dailyExitJob.js';
import kiteTokenRefreshJob from '../services/jobs/kiteTokenRefreshJob.js';
import agendaDataPrefetchService from '../services/agendaDataPrefetchService.js';
import priceCacheService from '../services/priceCache.service.js';

const router = express.Router();

const ALLOWED_MOBILE = '919008108650';

// Job registry — maps each job to its singleton, Agenda collection, and metadata
const JOB_REGISTRY = [
  { key: 'weekendScreening', name: 'weekend-screening', description: 'ChartInk scans + AI analysis', schedule: 'Sat 6:00 PM', collection: 'weekend_screening_jobs', singleton: weekendScreeningJob },
  { key: 'dailyTracking', name: 'daily-tracking', description: 'Phase 1 status + Phase 2 AI', schedule: '4:00 PM Mon-Fri', collection: 'daily_tracking_jobs', singleton: dailyTrackingJob },
  { key: 'intradayMonitor', name: 'intraday-monitor', description: 'Stop/T1/T2/T3 monitoring', schedule: '*/15 9:15-15:30 Mon-Fri', collection: 'intraday_monitor_jobs', singleton: intradayMonitorJob },
  { key: 'pendingAnalysisReminder', name: 'pending-analysis-reminder', description: 'Notify pending analysis', schedule: '4:00 PM Mon-Fri', collection: 'pending_analysis_reminder_jobs', singleton: pendingAnalysisReminderJob },
  { key: 'morningBrief', name: 'morning-brief', description: 'Categorize stocks + GTT orders', schedule: '8:00 AM Monday', collection: 'morning_brief_jobs', singleton: morningBriefJob },
  { key: 'kiteOrderSync', name: 'kite-order-sync', description: 'GTT fill detection + OCO', schedule: '*/30 9:00-15:30 Mon-Fri', collection: 'kite_order_sync_jobs', singleton: kiteOrderSyncJob },
  { key: 'dailyPullbackScan', name: 'daily-pullback-scan', description: 'ChartInk pullback scan', schedule: '3:45 PM Tue-Fri', collection: 'daily_pullback_scan_jobs', singleton: dailyPullbackScanJob },
  { key: 'dailyPicksScan', name: 'daily-picks-scan', description: 'Scan + enrich + score picks', schedule: '9:09 AM Mon-Fri', collection: 'daily_picks_jobs', singleton: dailyPicksJob },
  { key: 'dailyEntry', name: 'daily-picks-entry', description: 'MIS orders + fill check + monitor', schedule: '9:15/9:45/*/15 Mon-Fri', collection: 'daily_entry_jobs', singleton: dailyEntryJob },
  { key: 'dailyExit', name: 'daily-exit', description: 'Force-exit open positions', schedule: '3:00 PM Mon-Fri', collection: 'daily_exit_jobs', singleton: dailyExitJob },
  { key: 'kiteTokenRefresh', name: 'kite-token-refresh', description: 'Refresh Kite access token', schedule: '6:00 AM Daily', collection: 'kite_token_jobs', singleton: kiteTokenRefreshJob },
  { key: 'dataPrefetch', name: 'daily-price-prefetch', description: 'Prefetch closing prices', schedule: '3:35 PM Mon-Fri', collection: 'data_prefetch_jobs', singleton: agendaDataPrefetchService },
  { key: 'priceCache', name: 'price-cache', description: 'In-memory price polling (5 min)', schedule: '*/5 during market hours', collection: null, singleton: priceCacheService },
];

/**
 * Middleware: auth + mobile number check
 */
const jobMonitorAuth = (req, res, next) => {
  if (req.user.mobileNumber !== ALLOWED_MOBILE) {
    return res.status(403).json({ success: false, error: 'Not authorized' });
  }
  next();
};

/**
 * GET /api/v1/job-monitor/status
 * Returns status of all registered jobs
 */
router.get('/status', auth, jobMonitorAuth, async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const jobs = [];

    for (const entry of JOB_REGISTRY) {
      const jobInfo = {
        key: entry.key,
        name: entry.name,
        description: entry.description,
        schedule: entry.schedule,
        stats: null,
        agenda: null
      };

      // Get in-memory stats from singleton
      try {
        if (entry.singleton && typeof entry.singleton.getStats === 'function') {
          jobInfo.stats = entry.singleton.getStats();
        }
      } catch (e) {
        jobInfo.stats = { error: e.message };
      }

      // Query Agenda MongoDB collection for latest job document
      if (entry.collection) {
        try {
          const col = db.collection(entry.collection);
          // Get the most recently scheduled recurring job
          const latestJob = await col.findOne(
            {},
            { sort: { lastRunAt: -1 } }
          );

          if (latestJob) {
            jobInfo.agenda = {
              lastRunAt: latestJob.lastRunAt || null,
              nextRunAt: latestJob.nextRunAt || null,
              lastFinishedAt: latestJob.lastFinishedAt || null,
              failReason: latestJob.failReason || null,
              failCount: latestJob.failCount || 0,
              lockedAt: latestJob.lockedAt || null,
              lastModifiedBy: latestJob.lastModifiedBy || null
            };
          }

          // Also check for recently failed jobs
          const failedJob = await col.findOne(
            { failReason: { $exists: true, $ne: null } },
            { sort: { lastRunAt: -1 } }
          );

          if (failedJob && (!latestJob || failedJob._id.toString() !== latestJob._id?.toString())) {
            jobInfo.lastFailure = {
              failReason: failedJob.failReason,
              failedAt: failedJob.lastRunAt,
              failCount: failedJob.failCount || 0
            };
          }
        } catch (e) {
          jobInfo.agenda = { error: e.message };
        }
      }

      jobs.push(jobInfo);
    }

    // Summary
    const summary = {
      total: jobs.length,
      initialized: jobs.filter(j => j.stats?.isInitialized).length,
      running: jobs.filter(j => j.stats?.isRunning).length,
      failed: jobs.filter(j => j.agenda?.failReason || j.lastFailure).length
    };

    res.json({ success: true, data: { jobs, summary } });
  } catch (error) {
    console.error('[JOB-MONITOR] Error fetching status:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch job status' });
  }
});

/**
 * POST /api/v1/job-monitor/trigger/:jobKey
 * Re-trigger a specific job by its registry key
 */
router.post('/trigger/:jobKey', auth, jobMonitorAuth, async (req, res) => {
  try {
    const { jobKey } = req.params;
    const entry = JOB_REGISTRY.find(j => j.key === jobKey);

    if (!entry) {
      return res.status(404).json({ success: false, error: `Job "${jobKey}" not found` });
    }

    if (!entry.singleton || typeof entry.singleton.triggerNow !== 'function') {
      // For priceCache, it doesn't have triggerNow — just re-poll
      if (entry.key === 'priceCache' && typeof entry.singleton.pollNow === 'function') {
        await entry.singleton.pollNow();
        return res.json({ success: true, data: { message: 'Price cache poll triggered' } });
      }
      return res.status(400).json({ success: false, error: `Job "${entry.name}" does not support manual triggering` });
    }

    const result = await entry.singleton.triggerNow();

    res.json({
      success: true,
      data: {
        jobName: entry.name,
        ...result
      }
    });
  } catch (error) {
    console.error(`[JOB-MONITOR] Error triggering job:`, error);
    res.status(500).json({ success: false, error: error.message || 'Failed to trigger job' });
  }
});

export default router;
