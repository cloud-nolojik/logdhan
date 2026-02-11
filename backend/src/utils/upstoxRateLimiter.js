/**
 * Centralized Upstox API Rate Limiter
 *
 * WHY: Upstox API is fronted by Cloudflare which rate-limits at ~10-15 req/sec.
 * priceCache.service.js fires getDailyCandles() for 100+ stocks via Promise.all() in parallel.
 * On server restart, this creates a burst that triggers Cloudflare Error 1015 (IP ban).
 * This cascades to daily picks enrichment (9:09 AM) — Upstox returns 429 → 0 stocks picked.
 *
 * HOW: All Upstox HTTP calls go through this singleton Bottleneck limiter.
 * - Max 8 requests/second (token bucket)
 * - Max 8 concurrent in-flight requests
 * - Auto-retry on 429/403 with exponential backoff (2s → 4s → 8s)
 * - Promise.all() callers don't need changes — Bottleneck queues them automatically
 */

import Bottleneck from 'bottleneck';
import axios from 'axios';

const LOG = '[UpstoxRateLimiter]';

// Singleton limiter — shared across ALL Upstox API calls in the process
const limiter = new Bottleneck({
  maxConcurrent: 8,               // max 8 requests in-flight at once
  minTime: 125,                   // min 125ms between requests = 8 req/sec max
  reservoir: 8,                   // token bucket starts with 8 tokens
  reservoirRefreshInterval: 1000, // refill every 1 second
  reservoirRefreshAmount: 8,      // refill to 8 tokens per second
});

// 429 retry config
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;   // 2s initial backoff
const MAX_DELAY_MS = 30000;   // 30s max backoff
const BACKOFF_FACTOR = 2;     // exponential: 2s, 4s, 8s

// Metrics for monitoring via job-monitor or health endpoint
let metrics = {
  startedAt: Date.now(),
  totalRequests: 0,
  successfulRequests: 0,
  retriedRequests: 0,
  failedRequests: 0,
  rateLimitHits: 0,
};

/**
 * Extract a short readable endpoint from a full Upstox URL for logging.
 * e.g. "https://api.upstox.com/v2/historical-candle/NSE_EQ|INE..." → "/historical-candle/NSE_EQ|INE..."
 */
function extractEndpoint(url) {
  try {
    const parsed = new URL(url);
    // Strip the /v2 or /v3 prefix for brevity, keep the rest
    return parsed.pathname.replace(/^\/v[23]/, '');
  } catch {
    return url; // If URL parsing fails, return as-is
  }
}

/**
 * Rate-limited GET request to Upstox API.
 * Queued by Bottleneck (max 8/sec), retries on 429/403 with exponential backoff.
 *
 * Drop-in replacement for axios.get(url, config) — same return type (Axios response).
 *
 * @param {string} url - Full Upstox API URL
 * @param {Object} config - Axios config (headers, timeout, etc.)
 * @param {Object} [options] - { caller: 'functionName' } for logging
 * @returns {Promise<import('axios').AxiosResponse>}
 */
async function rateLimitedGet(url, config = {}, options = {}) {
  const { caller = 'unknown' } = options;

  // Extract a short readable path from the full URL for logs
  const shortUrl = extractEndpoint(url);
  const counts = limiter.counts();

  if (counts.QUEUED > 0) {
    console.log(`${LOG} ⏳ QUEUED GET ${shortUrl} caller=${caller} (queue=${counts.QUEUED}, running=${counts.RUNNING})`);
  }

  // Bottleneck queues this — if 8 requests are in-flight, this waits
  return limiter.schedule(async () => {
    metrics.totalRequests++;
    let lastError;
    const startTime = Date.now();

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await axios.get(url, config);
        const elapsed = Date.now() - startTime;
        metrics.successfulRequests++;
        console.log(`${LOG} ✅ GET ${shortUrl} caller=${caller} ${response.status} ${elapsed}ms`);
        return response;
      } catch (error) {
        lastError = error;
        const status = error.response?.status;

        // Only retry on rate limit (429) or Cloudflare block (403)
        if ((status === 429 || status === 403) && attempt < MAX_RETRIES) {
          metrics.rateLimitHits++;
          metrics.retriedRequests++;
          const delay = Math.min(BASE_DELAY_MS * Math.pow(BACKOFF_FACTOR, attempt), MAX_DELAY_MS);
          console.warn(
            `${LOG} ⚠️ ${status} GET ${shortUrl} caller=${caller} (attempt ${attempt + 1}/${MAX_RETRIES + 1}). ` +
            `Pausing limiter for ${delay}ms then retrying...`
          );
          // Cloudflare 429 = IP-level ban — all requests will fail, not just this one.
          // Pause the limiter (reservoir=0) so other queued requests don't waste slots on guaranteed 429s.
          // The backoff does block this slot, which is intentional — after the pause lifts,
          // this request retries first, then the queue resumes at normal rate.
          limiter.updateSettings({ reservoir: 0 });
          await new Promise(resolve => setTimeout(resolve, delay));
          limiter.updateSettings({ reservoir: 8 });
          continue;
        }

        // Non-retryable error or max retries exceeded — let caller handle it
        break;
      }
    }

    const elapsed = Date.now() - startTime;
    metrics.failedRequests++;
    console.error(`${LOG} ❌ GET ${shortUrl} caller=${caller} ${lastError.response?.status || 'NETWORK_ERR'} ${elapsed}ms`);
    throw lastError;
  });
}

/**
 * Rate-limited POST request to Upstox API.
 * No 429 retry (POST is not idempotent — retrying could double-place orders).
 */
async function rateLimitedPost(url, data, config = {}, options = {}) {
  const { caller = 'unknown' } = options;
  const shortUrl = extractEndpoint(url);

  return limiter.schedule(async () => {
    metrics.totalRequests++;
    const startTime = Date.now();
    try {
      const response = await axios.post(url, data, config);
      const elapsed = Date.now() - startTime;
      metrics.successfulRequests++;
      console.log(`${LOG} ✅ POST ${shortUrl} caller=${caller} ${response.status} ${elapsed}ms`);
      return response;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      metrics.failedRequests++;
      console.error(`${LOG} ❌ POST ${shortUrl} caller=${caller} ${error.response?.status || 'NETWORK_ERR'} ${elapsed}ms`);
      throw error;
    }
  });
}

/**
 * Rate-limited DELETE request to Upstox API.
 * No 429 retry (DELETE is typically idempotent but order cancels shouldn't be retried blindly).
 */
async function rateLimitedDelete(url, config = {}, options = {}) {
  const { caller = 'unknown' } = options;
  const shortUrl = extractEndpoint(url);

  return limiter.schedule(async () => {
    metrics.totalRequests++;
    const startTime = Date.now();
    try {
      const response = await axios.delete(url, config);
      const elapsed = Date.now() - startTime;
      metrics.successfulRequests++;
      console.log(`${LOG} ✅ DELETE ${shortUrl} caller=${caller} ${response.status} ${elapsed}ms`);
      return response;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      metrics.failedRequests++;
      console.error(`${LOG} ❌ DELETE ${shortUrl} caller=${caller} ${error.response?.status || 'NETWORK_ERR'} ${elapsed}ms`);
      throw error;
    }
  });
}

/**
 * Current rate limiter metrics — expose via job-monitor or health endpoint.
 */
function getMetrics() {
  const counts = limiter.counts();
  return {
    ...metrics,
    queueDepth: counts.QUEUED,       // requests waiting in queue
    running: counts.RUNNING,          // requests currently in-flight
    executing: counts.EXECUTING,      // requests actively executing
  };
}

export {
  rateLimitedGet,
  rateLimitedPost,
  rateLimitedDelete,
  getMetrics,
};

export default {
  get: rateLimitedGet,
  post: rateLimitedPost,
  delete: rateLimitedDelete,
  getMetrics,
};
