/**
 * Volume signal — was yesterday's volume abnormally high?
 *
 * High relative volume (vs 20-day average) is a leading indicator that
 * institutional money is rotating into a stock. A stock with 2× normal volume
 * on an up day is a much stronger candidate than the same price move on
 * average volume.
 *
 * Data source: the daily OHLCV candles already fetched by relativeStrengthSignal.
 * Candle format (Upstox): [timestamp, open, high, low, close, volume]
 *                                                                  ^-- index 5
 *
 * NO extra API call — volume rides piggyback on the RS candle fetch.
 *
 * Signal output per stock:
 *   null  → candles unavailable / too few
 *   0     → volume normal or below average (< 1.2×)
 *   0.25  → mildly elevated (1.2× – 1.5×)
 *   0.5   → elevated (1.5× – 2.0×)
 *   0.75  → high (2.0× – 3.0×)
 *   1.0   → very high (≥ 3.0×)
 */

const LOG = '[shortlist/volume]';
const LOOKBACK = 20; // days for average volume denominator

/**
 * Determine candle ordering. Returns true if newest candle is at index 0.
 */
function isDescending(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return false;
  const t0   = candles[0]?.[0];
  const tEnd = candles[candles.length - 1]?.[0];
  return t0 && tEnd && new Date(t0).getTime() > new Date(tEnd).getTime();
}

/**
 * Compute the volume ratio: yesterday's volume / avg(prior N days).
 *
 * "Yesterday" = most recent completed session (index 0 if descending, last if ascending).
 * "Prior N days" = the N candles immediately before yesterday, used as baseline.
 *
 * We use N=20 (one trading month) for a robust average that smooths earnings
 * spikes and one-off events.
 *
 * @param {Array} candles   - OHLCV candle array from getCandleData
 * @param {number} lookback - number of prior days for average (default 20)
 * @returns {number|null}   - ratio (e.g. 2.3 = 2.3× normal), or null if insufficient data
 */
export function computeVolumeRatio(candles, lookback = LOOKBACK) {
  if (!Array.isArray(candles) || candles.length < lookback + 2) return null;

  const desc = isDescending(candles);

  // Most recent complete session
  const yesterday = desc ? candles[0] : candles[candles.length - 1];
  const yVol = yesterday?.[5];
  if (!yVol || yVol <= 0) return null;

  // The lookback window immediately prior to yesterday
  let priorCandles;
  if (desc) {
    // candles[0] = yesterday, candles[1..lookback] = prior N days
    priorCandles = candles.slice(1, lookback + 1);
  } else {
    // candles[last] = yesterday, candles[last-lookback..last-1] = prior N days
    const len = candles.length;
    priorCandles = candles.slice(len - 1 - lookback, len - 1);
  }

  if (priorCandles.length < Math.floor(lookback * 0.75)) {
    // Need at least 75% of lookback filled to be meaningful
    return null;
  }

  const validVolumes = priorCandles.map(c => c?.[5]).filter(v => v && v > 0);
  if (validVolumes.length === 0) return null;

  const avgVol = validVolumes.reduce((s, v) => s + v, 0) / validVolumes.length;
  if (avgVol === 0) return null;

  return Number((yVol / avgVol).toFixed(3));
}

/**
 * Convert volume ratio to a [0, 1] signal score.
 *
 * Thresholds:
 *   ≥ 3.0×  → 1.0   (very high — likely institutional event)
 *   ≥ 2.0×  → 0.75  (high — sector rotation / breakout day)
 *   ≥ 1.5×  → 0.5   (elevated)
 *   ≥ 1.2×  → 0.25  (mildly above normal)
 *   < 1.2×  → 0     (normal / below average)
 *   null    → null  (data unavailable)
 */
export function scoreVolume(ratio) {
  if (ratio === null || ratio === undefined) return null;
  if (ratio >= 3.0) return 1.0;
  if (ratio >= 2.0) return 0.75;
  if (ratio >= 1.5) return 0.5;
  if (ratio >= 1.2) return 0.25;
  return 0;
}

export default { computeVolumeRatio, scoreVolume, LOOKBACK };
