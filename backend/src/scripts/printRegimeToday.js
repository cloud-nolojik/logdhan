/**
 * Print today's market regime — standalone runner for computeMarketContextV2().
 *
 * Usage:
 *   node src/scripts/printRegimeToday.js
 *
 * Useful for:
 *   - Quick "what would the 8:30 job decide right now?" check before market open
 *   - Verifying after backfill that VIX/breadth/FII inputs are flowing
 *   - Debugging why the live system sat out or chose a particular scanner
 */

import 'dotenv/config';
import mongoose from 'mongoose';

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('[regime] MONGODB_URI not set — aborting');
    process.exit(1);
  }

  const t0 = Date.now();
  console.log('[regime] connecting to Mongo...');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  console.log(`[regime] connected in ${Date.now() - t0}ms\n`);

  const { computeMarketContextV2 } = await import('../engine/regimeV2.js');
  const {
    selectScannerModeForRegime,
    REGIME_TO_INTRADAY_MODE,
    REGIME_TO_SWING_MODE,
    getActiveScannerType,
  } = await import('../services/dailyPicks/dailyPicksService.js');

  console.log('[regime] computing market context for TODAY');
  console.log('[regime] timestamp:', new Date().toISOString(), '(UTC)');
  console.log('');

  const t1 = Date.now();
  let ctx;
  try {
    ctx = await computeMarketContextV2();
  } catch (err) {
    console.error('[regime] ❌ computeMarketContextV2 threw:', err.message);
    console.error('[regime] stack:', err.stack?.split('\n').slice(0, 8).join('\n'));
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`[regime] ✔ computed in ${Date.now() - t1}ms\n`);

  // ─── Pretty-printed summary ────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  TODAY\'S MARKET REGIME');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Label:      ${ctx.regime}`);
  console.log(`  Score:      ${ctx.regime_score}`);
  console.log(`  Playbook:   ${ctx.playbook}`);
  console.log(`  Max trades: ${ctx.max_trades}`);
  console.log(`  Size mult:  ${ctx.size_multiplier}`);
  if (ctx.halt_reason) {
    console.log(`  ⚠️  halt_reason: ${ctx.halt_reason}`);
  }
  console.log('');

  if (ctx.inputs) {
    console.log('  Directional inputs (each -1..+1, null = missing):');
    console.log(`    structure  = ${ctx.inputs.structure ?? 'null'}`);
    console.log(`    breadth    = ${ctx.inputs.breadth ?? 'null'}`);
    console.log(`    overnight  = ${ctx.inputs.overnight ?? 'null'}`);
    console.log(`    flow       = ${ctx.inputs.flow ?? 'null'}`);
    console.log(`    volatility = ${ctx.inputs.volatility ?? 'null'} (amplifier, not directional)`);
    console.log('');
  }

  if (ctx.raw_data) {
    const r = ctx.raw_data;
    console.log('  Raw data behind the inputs:');
    console.log(`    Nifty close = ${r.nifty_close}, EMA20 = ${r.ema20}, EMA50 = ${r.ema50}`);
    console.log(`    India VIX   = ${r.vix_close} (percentile ${r.vix_percentile})`);
    console.log(`    Breadth     = ${r.breadth_pct}% of Nifty 500 above 50-DMA`);
    console.log(`    GIFT Nifty  = ${r.gift_pct}%`);
    console.log(`    Asia comp   = ${r.asia_pct}%`);
    console.log(`    DXY         = ${r.dxy_pct}%`);
    console.log(`    FII         = ₹${r.fii_cr} cr`);
    console.log(`    DII         = ₹${r.dii_cr} cr`);
    console.log('');
  }

  // ─── What the 8:30 job would do ────────────────────────────────────────────
  const activeType = getActiveScannerType();
  const chosenMode = selectScannerModeForRegime(ctx.regime, activeType);
  const SHORT_MODES = new Set([
    'failed_bounce', 'breakdown',
    'intraday_failed_rally', 'intraday_gap_short',
  ]);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  WHAT THE 8:30 JOB WOULD DO');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  SCANNER_TYPE=${activeType}  (override with SCANNER_TYPE=swing|intraday)`);
  if (chosenMode == null) {
    console.log(`  → SIT OUT (no picks today). Reason: regime=${ctx.regime} maps to null.`);
  } else {
    const direction = SHORT_MODES.has(chosenMode) ? 'SHORT' : 'LONG';
    const script = activeType === 'swing' ? 'scanner_swing.py' : 'scanner.py';
    console.log(`  → Route to scanner mode = "${chosenMode}" (${direction})`);
    console.log(`  → Spawn: python3 ${script} --mode ${chosenMode} --top 3`);
  }
  console.log('');

  // ─── Full mapping reference (both tables side-by-side) ─────────────────────
  console.log('  Regime → mode tables (active=' + activeType + '):');
  console.log('    ' + 'regime'.padEnd(14) + '  ' + 'intraday'.padEnd(24) + '  ' + 'swing');
  const allRegimes = new Set([
    ...Object.keys(REGIME_TO_INTRADAY_MODE),
    ...Object.keys(REGIME_TO_SWING_MODE),
  ]);
  for (const regime of allRegimes) {
    const intra = REGIME_TO_INTRADAY_MODE[regime];
    const swing = REGIME_TO_SWING_MODE[regime];
    const marker = regime === ctx.regime ? '  ← TODAY' : '';
    console.log(
      `    ${regime.padEnd(14)}  ${(intra || 'SIT OUT').padEnd(24)}  ${(swing || 'SIT OUT')}${marker}`
    );
  }
  console.log('');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('[regime] FATAL:', err);
  process.exit(1);
});
