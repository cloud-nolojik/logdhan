/**
 * Unit tests for the 2026-06-05 rate-limit fixes:
 *   runWithConcurrency(tasks, limit)         — capped parallel execution
 *   KITE_HISTORICAL_CONCURRENCY              — constant = 3 (Kite's 3 req/sec)
 *
 * Background:
 *   On 2026-06-05, getIntradayMultiCandles fired Promise.all of 40+ historical-
 *   data tasks. Kite's historical endpoint rate limit is 3 req/sec — the burst
 *   produced 98 × 429 errors and silently dropped 45% of the breakout-scan
 *   universe to zero bars. Wrapping the task array in a 3-way concurrency
 *   limiter brings the request rate to ≤ 3/sec inflight.
 */

import { describe, it, expect } from 'vitest';
import { runWithConcurrency, KITE_HISTORICAL_CONCURRENCY } from '../services/kiteOrder.service.js';

describe('Constants', () => {
  it('KITE_HISTORICAL_CONCURRENCY is 3 (Kite docs rate limit)', () => {
    expect(KITE_HISTORICAL_CONCURRENCY).toBe(3);
  });
});

describe('runWithConcurrency', () => {
  it('returns [] for empty input', async () => {
    const out = await runWithConcurrency([], 3);
    expect(out).toEqual([]);
  });

  it('runs all tasks and preserves output order', async () => {
    const tasks = [1, 2, 3, 4, 5].map(n => async () => n * 10);
    const out = await runWithConcurrency(tasks, 2);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('respects the concurrency limit (never more than `limit` running)', async () => {
    let active = 0;
    let peakActive = 0;
    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      active++;
      peakActive = Math.max(peakActive, active);
      await new Promise(r => setTimeout(r, 20));
      active--;
      return i;
    });
    await runWithConcurrency(tasks, 3);
    expect(peakActive).toBeLessThanOrEqual(3);
    expect(peakActive).toBeGreaterThan(1);   // sanity: it should at least parallelize a bit
  });

  it('errors in individual tasks are captured as { _error } — pool does not reject', async () => {
    const tasks = [
      async () => 'ok-1',
      async () => { throw new Error('boom'); },
      async () => 'ok-3',
    ];
    const out = await runWithConcurrency(tasks, 2);
    expect(out[0]).toBe('ok-1');
    expect(out[1]).toHaveProperty('_error');
    expect(out[1]._error.message).toBe('boom');
    expect(out[2]).toBe('ok-3');
  });

  it('pool size capped at task count (limit > tasks → uses tasks.length workers)', async () => {
    let active = 0;
    let peak = 0;
    const tasks = [1, 2].map(() => async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 10));
      active--;
    });
    await runWithConcurrency(tasks, 100);   // limit much larger than tasks
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('limit of 1 → strictly sequential', async () => {
    const order = [];
    const tasks = Array.from({ length: 5 }, (_, i) => async () => {
      order.push(`start-${i}`);
      await new Promise(r => setTimeout(r, 5));
      order.push(`end-${i}`);
    });
    await runWithConcurrency(tasks, 1);
    // With concurrency=1, every "end-N" must come before the next "start-(N+1)"
    expect(order).toEqual([
      'start-0', 'end-0',
      'start-1', 'end-1',
      'start-2', 'end-2',
      'start-3', 'end-3',
      'start-4', 'end-4',
    ]);
  });

  it('2026-06-05 replay — 40 historical-data tasks, cap at 3, all succeed (no 429 sim here)', async () => {
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 40 }, (_, i) => async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
      return { symbol: `SYM${i}`, bars: 2 };
    });
    const out = await runWithConcurrency(tasks, KITE_HISTORICAL_CONCURRENCY);
    expect(out).toHaveLength(40);
    expect(out.every(r => r.bars === 2)).toBe(true);
    expect(peak).toBe(3);
  });

  it('limit of 0 → coerced to 1 (no infinite loop)', async () => {
    const tasks = [async () => 'a', async () => 'b'];
    const out = await runWithConcurrency(tasks, 0);
    expect(out).toEqual(['a', 'b']);
  });

  it('non-array input → returns []', async () => {
    expect(await runWithConcurrency(null, 3)).toEqual([]);
    expect(await runWithConcurrency(undefined, 3)).toEqual([]);
  });
});
