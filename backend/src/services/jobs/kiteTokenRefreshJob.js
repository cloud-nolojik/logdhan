import cron from 'node-cron';
import kiteAutoLoginService from '../kiteAutoLogin.service.js';
import KiteAuditLog from '../../models/kiteAuditLog.js';
import kiteConfig from '../../config/kite.config.js';

/**
 * Kite Token Refresh Job
 * Runs daily at 6:00 AM IST to refresh the Kite access token.
 * Token expires at 6 AM, so we refresh right at that time.
 */

let isJobRunning = false;

/**
 * Perform token refresh with retry logic
 */
async function refreshToken(retryCount = 0) {
  if (isJobRunning) {
    console.log('[KITE TOKEN JOB] Job already running, skipping...');
    return;
  }

  isJobRunning = true;
  const startTime = Date.now();

  try {
    console.log('[KITE TOKEN JOB] Starting scheduled token refresh...');
    console.log(`[KITE TOKEN JOB] Current time: ${new Date().toISOString()}`);

    // Perform auto login
    const session = await kiteAutoLoginService.performAutoLogin();

    const durationMs = Date.now() - startTime;
    console.log(`[KITE TOKEN JOB] Token refreshed successfully in ${durationMs}ms`);
    console.log(`[KITE TOKEN JOB] User: ${session.user_name}, Expiry: ${session.token_expiry}`);

    // Log successful refresh
    await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.TOKEN_REFRESH, {
      kiteUserId: kiteConfig.USER_ID,
      status: 'SUCCESS',
      response: {
        user_name: session.user_name,
        token_expiry: session.token_expiry
      },
      durationMs,
      source: 'SCHEDULED'
    });

    return session;

  } catch (error) {
    const durationMs = Date.now() - startTime;
    console.error(`[KITE TOKEN JOB] Token refresh failed (attempt ${retryCount + 1}):`, error.message);

    // Log failed refresh
    await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.TOKEN_REFRESH, {
      kiteUserId: kiteConfig.USER_ID,
      status: 'FAILED',
      error: error.message,
      durationMs,
      source: 'SCHEDULED',
      notes: `Attempt ${retryCount + 1}`
    });

    // Retry logic
    if (retryCount < kiteConfig.MAX_RETRIES) {
      console.log(`[KITE TOKEN JOB] Retrying in ${kiteConfig.RETRY_DELAY_MS}ms...`);
      await new Promise(resolve => setTimeout(resolve, kiteConfig.RETRY_DELAY_MS));
      isJobRunning = false;
      return refreshToken(retryCount + 1);
    }

    // All retries failed - send alert
    console.error('[KITE TOKEN JOB] All retry attempts failed. Manual intervention required.');

    // TODO: Send push notification/alert to admin
    // await sendAdminAlert('Kite token refresh failed after 3 attempts');

    throw error;

  } finally {
    isJobRunning = false;
  }
}

/**
 * Start the scheduled job
 * Runs at 6:00 AM IST daily
 */
function startKiteTokenRefreshJob() {
  // Schedule for 6:00 AM IST
  // IST is UTC+5:30, so 6:00 AM IST = 00:30 UTC
  const schedule = '30 0 * * *'; // 00:30 UTC = 6:00 AM IST

  console.log('[KITE TOKEN JOB] Scheduling daily token refresh at 6:00 AM IST (00:30 UTC)');

  cron.schedule(schedule, async () => {
    console.log('[KITE TOKEN JOB] Cron triggered at:', new Date().toISOString());
    try {
      await refreshToken();
    } catch (error) {
      console.error('[KITE TOKEN JOB] Scheduled refresh failed:', error.message);
    }
  }, {
    timezone: 'UTC'
  });

  // Also schedule a backup refresh at 6:05 AM IST in case 6:00 fails
  const backupSchedule = '35 0 * * *'; // 00:35 UTC = 6:05 AM IST

  cron.schedule(backupSchedule, async () => {
    // Check if token is valid, if not, refresh
    const isValid = await kiteAutoLoginService.isSessionValid();
    if (!isValid) {
      console.log('[KITE TOKEN JOB] Backup refresh triggered - token invalid');
      try {
        await refreshToken();
      } catch (error) {
        console.error('[KITE TOKEN JOB] Backup refresh failed:', error.message);
      }
    } else {
      console.log('[KITE TOKEN JOB] Backup check - token already valid');
    }
  }, {
    timezone: 'UTC'
  });

  console.log('[KITE TOKEN JOB] Job scheduled successfully');
}

/**
 * Manually trigger token refresh (for admin use)
 */
async function manualRefresh() {
  console.log('[KITE TOKEN JOB] Manual refresh triggered');
  return refreshToken();
}

/**
 * Check job status
 */
function isRunning() {
  return isJobRunning;
}

export {
  startKiteTokenRefreshJob,
  manualRefresh,
  refreshToken,
  isRunning
};

export default {
  startKiteTokenRefreshJob,
  manualRefresh,
  refreshToken,
  isRunning
};
