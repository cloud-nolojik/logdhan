/**
 * Regime v2 — one-shot backfill runner for all three data sources.
 *
 * Runs each backfill script sequentially with the same `days` argument:
 *   1. backfillIndiaVixYahoo.js  (Yahoo — hands-off, no CSV required)
 *   2. backfillFiiFlow.js        (NSE historical endpoint)
 *   3. backfillBreadth.js        (Upstox candles × Nifty 500 — heaviest)
 *
 * Run BEFORE enabling the new regime in production so that the first live
 * compute has a populated `india_vix_daily` (for percentile rank),
 * `institutional_flow_daily` (for prev-day flow input), and `breadth_daily`
 * (for Nifty 500 % above 50-DMA).
 *
 * Usage:
 *   node src/scripts/backfillAll.js            # default 400 days
 *   node src/scripts/backfillAll.js 120        # 4-month backfill for backtest
 *   node src/scripts/backfillAll.js 250        # 1-year for production
 *
 * Note: the `days` arg is calendar days for VIX/FII, trading days for
 * breadth. ~400 calendar ≈ 250 trading days. For a 4-month backtest pass
 * 120 (calendar) — it covers ~80 trading days comfortably.
 *
 * Expects .env to be loaded (MONGO_URI, Upstox creds, etc.). If you usually
 * start the server with a dotenv wrapper, use the same wrapper here.
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const daysArg = process.argv[2] || '400';

const steps = [
  // Yahoo-based VIX backfill takes days-back as argv[2], default 730. Pass through.
  { label: 'india VIX',  script: 'backfillIndiaVixYahoo.js', args: [daysArg] },
  // FII/DII script takes days-back as argv[2], default 500. Pass through.
  { label: 'FII/DII',    script: 'backfillFiiFlow.js',       args: [daysArg] },
  // Breadth takes trading-days as argv[2], default 400. Same arg works fine.
  { label: 'breadth',    script: 'backfillBreadth.js',       args: [daysArg] },
];

function runStep({ label, script, args }) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, script);
    console.log(`\n═══════════════════════════════════════════════`);
    console.log(`▶ Starting: ${label}  (${script} ${args.join(' ')})`);
    console.log(`═══════════════════════════════════════════════`);
    const t0 = Date.now();

    const child = spawn('node', [scriptPath, ...args], {
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (code === 0) {
        console.log(`✔ ${label} done in ${secs}s`);
        resolve();
      } else {
        reject(new Error(`${label} failed with exit code ${code} (ran ${secs}s)`));
      }
    });
  });
}

async function main() {
  const totalT0 = Date.now();
  try {
    for (const step of steps) {
      await runStep(step);
    }
  } catch (err) {
    console.error('\n❌ Backfill aborted:', err.message);
    process.exit(1);
  }
  const mins = ((Date.now() - totalT0) / 60000).toFixed(1);
  console.log(`\n═══════════════════════════════════════════════`);
  console.log(`✅ All backfills complete in ${mins} min.`);
  console.log(`   Collections now populated:`);
  console.log(`     • india_vix_daily`);
  console.log(`     • institutional_flow_daily`);
  console.log(`     • breadth_daily`);
  console.log(`   Regime v2 is ready for live use.`);
  console.log(`═══════════════════════════════════════════════`);
}

main();
