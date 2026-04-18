/**
 * Regime v2 — one-shot backfill runner for all three data sources.
 *
 * Runs each of the three existing backfill scripts sequentially:
 *   1. backfillIndiaVix.js  (~1 year history from NSE / CSV)
 *   2. backfillFiiFlow.js   (~1 year history from NSE)
 *   3. backfillBreadth.js   (~400 trading days × Nifty 500 — heaviest)
 *
 * Run BEFORE enabling the new regime in production so that the first live
 * compute has a populated `india_vix_daily` (for percentile rank),
 * `institutional_flow_daily` (for prev-day flow input), and `breadth_daily`
 * (for Nifty 500 % above 50-DMA).
 *
 * Usage:
 *   node src/scripts/backfillAll.js            # default ranges (1 yr / 400 d)
 *   node src/scripts/backfillAll.js 250        # passes "250" to breadth only
 *
 * The VIX and FII scripts don't take a numeric arg; breadth does.
 *
 * Expects .env to be loaded (MONGO_URI, Upstox creds, etc.). If you usually
 * start the server with a dotenv wrapper, use the same wrapper here.
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const breadthDaysArg = process.argv[2] || '400';

const steps = [
  { label: 'india VIX',  script: 'backfillIndiaVix.js', args: [] },
  { label: 'FII/DII',    script: 'backfillFiiFlow.js',  args: [] },
  { label: 'breadth',    script: 'backfillBreadth.js',  args: [breadthDaysArg] },
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
