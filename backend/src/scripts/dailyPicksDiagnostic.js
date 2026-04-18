#!/usr/bin/env node
/**
 * Daily Picks DIAGNOSTIC Report
 *
 * Unlike the backtest script (which only looks at completed trades),
 * this script shows EVERYTHING that happened on each trading day:
 *
 *   - How many candidates were scanned
 *   - Which ones were selected vs rejected (and why)
 *   - ORB validation results (pass/fail reasons)
 *   - Order placement status
 *   - Entry fills
 *   - Exit outcomes
 *   - The full pipeline funnel for each day
 *
 * This is a DIAGNOSTIC tool — it reads raw DailyPick documents from MongoDB
 * and prints a day-by-day breakdown of exactly what happened at each stage.
 *
 * NOTE: This does NOT re-run the trading logic. It reads the stored results
 * of what the live system actually did. If a pick was SKIPPED, it shows why.
 *
 * Usage:
 *   node dailyPicksDiagnostic.js                    # Last 30 days
 *   node dailyPicksDiagnostic.js --days 60          # Last 60 days
 *   node dailyPicksDiagnostic.js --from 2026-01-01  # From specific date
 *   node dailyPicksDiagnostic.js --verbose          # Show rejected candidates too
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: resolve(__dirname, '../../.env') });

// ═══════════════════════════════════════════════════════════════════════════════
// PARSE CLI ARGS
// ═══════════════════════════════════════════════════════════════════════════════

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 30, from: null, verbose: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) opts.days = parseInt(args[i + 1]);
    if (args[i] === '--from' && args[i + 1]) opts.from = args[i + 1];
    if (args[i] === '--verbose') opts.verbose = true;
  }
  return opts;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const opts = parseArgs();

  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║         DAILY PICKS — FULL DIAGNOSTIC REPORT                 ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log(`  Period: ${opts.from || `last ${opts.days} days`}`);
  console.log(`  Verbose: ${opts.verbose ? 'YES (showing rejected candidates)' : 'NO (use --verbose for full detail)'}`);
  console.log('');

  // Connect
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('  ✓ Connected to MongoDB\n');
  } catch (err) {
    console.error('  ✗ MongoDB connection failed:', err.message);
    process.exit(1);
  }

  const DailyPick = (await import('../../src/models/dailyPick.js')).default;

  const cutoff = opts.from
    ? new Date(opts.from)
    : new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000);

  const docs = await DailyPick.find({
    trading_date: { $gte: cutoff }
  }).sort({ trading_date: 1 }).lean();

  console.log(`  Found ${docs.length} trading days\n`);

  if (docs.length === 0) {
    console.log('  No data to analyze.');
    await mongoose.disconnect();
    process.exit(0);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AGGREGATE COUNTERS
  // ═══════════════════════════════════════════════════════════════════════════

  const totals = {
    tradingDays: docs.length,
    totalCandidates: 0,
    totalSelected: 0,
    totalPicks: 0,
    byTradeStatus: {},
    byKiteStatus: {},
    bySkipReason: {},
    byOrbResult: {},
    byValidationFail: {},
    byExitReason: {},
    totalPnl: 0,
    winners: 0,
    losers: 0,
    daysWithZeroPicks: 0,
    daysWithZeroEntries: 0,
    daysWithZeroCompletedTrades: 0
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // DAY-BY-DAY BREAKDOWN
  // ═══════════════════════════════════════════════════════════════════════════

  for (const doc of docs) {
    const date = doc.trading_date?.toISOString().split('T')[0];
    const regime = doc.market_context?.regime || 'UNKNOWN';
    const summary = doc.summary || {};
    const picks = doc.picks || [];
    const candidates = doc.candidates_review || [];

    totals.totalCandidates += summary.total_candidates || 0;
    totals.totalSelected += summary.selected_count || 0;
    totals.totalPicks += picks.length;

    if (picks.length === 0) totals.daysWithZeroPicks++;

    const enteredPicks = picks.filter(p => p.trade?.entry_price > 0);
    if (enteredPicks.length === 0) totals.daysWithZeroEntries++;

    const terminalStatuses = ['TARGET_HIT', 'STOPPED_OUT', 'TIME_EXIT'];
    const completedPicks = picks.filter(p => terminalStatuses.includes(p.trade?.status));
    if (completedPicks.length === 0) totals.daysWithZeroCompletedTrades++;

    // Day P&L
    let dayPnl = 0;
    for (const pick of picks) {
      if (pick.trade?.pnl) {
        dayPnl += pick.trade.pnl;
        totals.totalPnl += pick.trade.pnl;
        if (pick.trade.pnl > 0) totals.winners++;
        else if (pick.trade.pnl < 0) totals.losers++;
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // PRINT DAY HEADER
    // ─────────────────────────────────────────────────────────────────────

    console.log('┌─────────────────────────────────────────────────────────────┐');
    console.log(`│  📅 ${date}  │  Regime: ${regime.padEnd(16)}  │  P&L: ₹${String(r2(dayPnl)).padStart(8)}  │`);
    console.log('├─────────────────────────────────────────────────────────────┤');

    // PIPELINE FUNNEL
    console.log(`│  📊 PIPELINE FUNNEL:                                        │`);
    console.log(`│     Candidates scanned:  ${String(summary.total_candidates || 0).padStart(3)}  (${String(summary.bullish_count || 0).padStart(2)} bull / ${String(summary.bearish_count || 0).padStart(2)} bear)     │`);
    console.log(`│     Selected for trade:  ${String(summary.selected_count || 0).padStart(3)}                                │`);
    console.log(`│     Actual picks:        ${String(picks.length).padStart(3)}                                │`);
    console.log(`│     Got entry fills:     ${String(enteredPicks.length).padStart(3)}                                │`);
    console.log(`│     Completed trades:    ${String(completedPicks.length).padStart(3)}                                │`);

    // ─────────────────────────────────────────────────────────────────────
    // EACH PICK DETAIL
    // ─────────────────────────────────────────────────────────────────────

    if (picks.length > 0) {
      console.log('│                                                             │');
      console.log('│  🎯 PICKS:                                                  │');

      for (let i = 0; i < picks.length; i++) {
        const p = picks[i];
        const ts = p.trade?.status || 'NO_STATUS';
        const ks = p.kite?.kite_status || 'unknown';
        const score = p.rank_score || 0;

        // Count statuses
        totals.byTradeStatus[ts] = (totals.byTradeStatus[ts] || 0) + 1;
        totals.byKiteStatus[ks] = (totals.byKiteStatus[ks] || 0) + 1;

        const statusIcon = getStatusIcon(ts);
        console.log(`│                                                             │`);
        console.log(`│  ${statusIcon} Pick ${i + 1}: ${(p.symbol || '???').padEnd(12)} ${p.direction || '?'}  Score: ${String(score).padStart(3)}           │`);
        console.log(`│     Scan: ${(p.scan_type || 'unknown').padEnd(25)}                    │`);

        // Levels
        if (p.levels) {
          const l = p.levels;
          console.log(`│     Entry: ₹${r2(l.entry || 0)}  Stop: ₹${r2(l.stop || 0)}  Target: ₹${r2(l.target || 0)}  │`);
          console.log(`│     Risk: ${r2(l.risk_pct || 0)}%  Reward: ${r2(l.reward_pct || 0)}%  R:R ${r2(l.risk_reward || 0)}  Mode: ${l.mode || '?'}  │`);
        }

        // Trade status chain
        console.log(`│     Trade status: ${ts.padEnd(15)}  Kite: ${ks.padEnd(15)}       │`);

        // ORB info
        if (p.orb) {
          const orb = p.orb;
          console.log(`│     ORB: Gap ${r2(orb.gap_percent || 0)}%  Dir: ${(orb.orb_direction || '?').padEnd(7)}  Nifty: ${(orb.nifty_orb_direction || '?').padEnd(7)}  │`);

          if (orb.orb_passes && orb.orb_passes.length > 0) {
            for (const pass of orb.orb_passes) {
              const result = pass.result || '?';
              totals.byOrbResult[result] = (totals.byOrbResult[result] || 0) + 1;
              const icon = result === 'PASSED' ? '✅' : result === 'PERMANENT_FAIL' ? '🚫' : '❌';
              console.log(`│       Pass ${pass.pass}: ${icon} ${result.padEnd(15)} ${(pass.reason || '').substring(0, 30).padEnd(30)} │`);
            }
          }
        }

        // Validation
        if (p.validation) {
          const v = p.validation;
          const vIcon = v.passed ? '✅' : '❌';
          console.log(`│     Validation: ${vIcon} ${v.passed ? 'PASSED' : 'FAILED'}                                  │`);

          if (!v.passed && v.skip_reason) {
            totals.bySkipReason[v.skip_reason] = (totals.bySkipReason[v.skip_reason] || 0) + 1;
            console.log(`│       Skip reason: ${v.skip_reason.substring(0, 40).padEnd(40)} │`);
          }

          if (v.checks) {
            const checks = v.checks;
            const checkNames = ['gap_check', 'gap_direction', 'orb_alignment', 'nifty_alignment', 'orb_range_width', 'volume_check'];
            const failedChecks = checkNames.filter(c => checks[c] && checks[c].passed === false);
            if (failedChecks.length > 0) {
              for (const fc of failedChecks) {
                const checkKey = `validation:${fc}`;
                totals.byValidationFail[checkKey] = (totals.byValidationFail[checkKey] || 0) + 1;
                const detail = getCheckDetail(checks[fc], fc);
                console.log(`│       ❌ ${fc.padEnd(20)}: ${detail.padEnd(28)} │`);
              }
            }
          }
        }

        // Entry/Exit details
        if (p.trade?.entry_price > 0) {
          const t = p.trade;
          const entryTimeStr = t.entry_time ? new Date(t.entry_time).toISOString().split('T')[1].substring(0, 8) : '?';
          console.log(`│     Entry: ₹${r2(t.entry_price)} at ${entryTimeStr}  Qty: ${t.qty || '?'}           │`);

          if (t.partial_exit_qty > 0) {
            console.log(`│     Partial exit: ${t.partial_exit_qty} qty at ₹${r2(t.partial_exit_price || 0)}           │`);
          }

          if (t.exit_price > 0) {
            const exitTimeStr = t.exit_time ? new Date(t.exit_time).toISOString().split('T')[1].substring(0, 8) : '?';
            const pnlStr = t.pnl >= 0 ? `+₹${r2(t.pnl)}` : `-₹${r2(Math.abs(t.pnl))}`;
            const retStr = t.return_pct >= 0 ? `+${r2(t.return_pct)}%` : `${r2(t.return_pct)}%`;
            console.log(`│     Exit: ₹${r2(t.exit_price)} at ${exitTimeStr}  ${pnlStr} (${retStr})  │`);
            console.log(`│     Exit reason: ${(t.exit_reason || ts).padEnd(40)}  │`);

            if (t.exit_reason) {
              totals.byExitReason[t.exit_reason] = (totals.byExitReason[t.exit_reason] || 0) + 1;
            }
          } else {
            console.log(`│     ⚠️  No exit recorded                                    │`);
          }
        } else if (ts === 'SKIPPED' || ts === 'FAILED') {
          console.log(`│     ⛔ Never entered — ${ts}                               │`);
        } else if (ts === 'PENDING' || ts === 'COLLECTING_ORB' || ts === 'VALIDATED' || ts === 'ORDER_PLACED') {
          console.log(`│     ⏳ Stuck at: ${ts.padEnd(40)}   │`);
        }

        // Trailing history
        if (p.trailing_history && p.trailing_history.length > 0) {
          console.log(`│     Trailing adjustments: ${p.trailing_history.length}                             │`);
          for (const th of p.trailing_history.slice(0, 3)) {
            const tTime = th.timestamp ? new Date(th.timestamp).toISOString().split('T')[1].substring(0, 8) : '?';
            console.log(`│       ${tTime}: SL ₹${r2(th.old_stop)} → ₹${r2(th.new_stop)} (price: ₹${r2(th.price_at_trail)})  │`);
          }
          if (p.trailing_history.length > 3) {
            console.log(`│       ... and ${p.trailing_history.length - 3} more adjustments                      │`);
          }
        }
      }
    } else {
      console.log('│  ⚠️  NO PICKS on this day                                   │');
    }

    // ─────────────────────────────────────────────────────────────────────
    // REJECTED CANDIDATES (verbose mode)
    // ─────────────────────────────────────────────────────────────────────

    if (opts.verbose && candidates.length > 0) {
      const rejected = candidates.filter(c => c.status === 'rejected' || c.rejection_reason);
      if (rejected.length > 0) {
        console.log('│                                                             │');
        console.log(`│  📋 REJECTED CANDIDATES (${rejected.length}):                               │`);
        for (const c of rejected.slice(0, 10)) {
          const reason = (c.rejection_reason || 'unknown').substring(0, 35);
          console.log(`│     ${(c.symbol || '?').padEnd(12)} ${(c.scan_type || '?').padEnd(20)} ${reason} │`);
        }
        if (rejected.length > 10) {
          console.log(`│     ... and ${rejected.length - 10} more rejected                          │`);
        }
      }
    }

    console.log('└─────────────────────────────────────────────────────────────┘');
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AGGREGATE SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║           AGGREGATE SUMMARY — ALL DAYS                       ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log('');

  // Pipeline funnel
  console.log('  📊 PIPELINE FUNNEL (totals across all days):');
  console.log(`     Trading days:              ${totals.tradingDays}`);
  console.log(`     Total candidates scanned:  ${totals.totalCandidates}`);
  console.log(`     Total selected:            ${totals.totalSelected}`);
  console.log(`     Total picks stored:        ${totals.totalPicks}`);
  console.log(`     Days with ZERO picks:      ${totals.daysWithZeroPicks}`);
  console.log(`     Days with ZERO entries:    ${totals.daysWithZeroEntries}`);
  console.log(`     Days with ZERO completed:  ${totals.daysWithZeroCompletedTrades}`);
  console.log('');

  // Trade status distribution
  console.log('  📈 TRADE STATUS DISTRIBUTION:');
  const statusOrder = ['TARGET_HIT', 'STOPPED_OUT', 'TIME_EXIT', 'ENTERED', 'VALIDATED', 'ORDER_PLACED', 'COLLECTING_ORB', 'PENDING', 'SKIPPED', 'FAILED'];
  for (const status of statusOrder) {
    if (totals.byTradeStatus[status]) {
      const icon = getStatusIcon(status);
      console.log(`     ${icon} ${status.padEnd(18)} ${String(totals.byTradeStatus[status]).padStart(3)} picks`);
    }
  }
  // Any other statuses not in our list
  for (const [status, count] of Object.entries(totals.byTradeStatus)) {
    if (!statusOrder.includes(status)) {
      console.log(`     ❓ ${status.padEnd(18)} ${String(count).padStart(3)} picks`);
    }
  }
  console.log('');

  // Kite status distribution
  console.log('  🔗 KITE STATUS DISTRIBUTION:');
  for (const [status, count] of Object.entries(totals.byKiteStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${status.padEnd(20)} ${String(count).padStart(3)} picks`);
  }
  console.log('');

  // ORB results
  if (Object.keys(totals.byOrbResult).length > 0) {
    console.log('  🕐 ORB VALIDATION RESULTS:');
    for (const [result, count] of Object.entries(totals.byOrbResult).sort((a, b) => b[1] - a[1])) {
      const icon = result === 'PASSED' ? '✅' : '❌';
      console.log(`     ${icon} ${result.padEnd(18)} ${String(count).padStart(3)} passes`);
    }
    console.log('');
  }

  // Skip reasons
  if (Object.keys(totals.bySkipReason).length > 0) {
    console.log('  ⛔ SKIP REASONS:');
    for (const [reason, count] of Object.entries(totals.bySkipReason).sort((a, b) => b[1] - a[1])) {
      console.log(`     ${String(count).padStart(3)}x  ${reason}`);
    }
    console.log('');
  }

  // Validation failures
  if (Object.keys(totals.byValidationFail).length > 0) {
    console.log('  ❌ VALIDATION FAILURE BREAKDOWN:');
    for (const [check, count] of Object.entries(totals.byValidationFail).sort((a, b) => b[1] - a[1])) {
      console.log(`     ${String(count).padStart(3)}x  ${check}`);
    }
    console.log('');
  }

  // Exit reasons
  if (Object.keys(totals.byExitReason).length > 0) {
    console.log('  🚪 EXIT REASON DISTRIBUTION:');
    for (const [reason, count] of Object.entries(totals.byExitReason).sort((a, b) => b[1] - a[1])) {
      console.log(`     ${String(count).padStart(3)}x  ${reason}`);
    }
    console.log('');
  }

  // P&L summary
  console.log('  💰 P&L SUMMARY:');
  console.log(`     Total P&L:    ₹${r2(totals.totalPnl)}`);
  console.log(`     Winners:      ${totals.winners}`);
  console.log(`     Losers:       ${totals.losers}`);
  if (totals.winners + totals.losers > 0) {
    console.log(`     Win rate:     ${r2((totals.winners / (totals.winners + totals.losers)) * 100)}%`);
  }
  console.log('');

  // BOTTLENECK ANALYSIS
  console.log('  🔍 BOTTLENECK ANALYSIS:');
  if (totals.totalPicks > 0) {
    const entryRate = ((totals.totalPicks - (totals.byTradeStatus['SKIPPED'] || 0) - (totals.byTradeStatus['FAILED'] || 0) - (totals.byTradeStatus['PENDING'] || 0) - (totals.byTradeStatus['COLLECTING_ORB'] || 0)) / totals.totalPicks * 100);
    console.log(`     Picks → Entry rate:    ${r2(entryRate)}%`);

    const completedCount = (totals.byTradeStatus['TARGET_HIT'] || 0) + (totals.byTradeStatus['STOPPED_OUT'] || 0) + (totals.byTradeStatus['TIME_EXIT'] || 0);
    const completionRate = (completedCount / totals.totalPicks) * 100;
    console.log(`     Picks → Completed:     ${r2(completionRate)}%`);
  }

  if (totals.totalCandidates > 0) {
    const selectionRate = (totals.totalSelected / totals.totalCandidates) * 100;
    console.log(`     Candidates → Selected: ${r2(selectionRate)}%`);
  }

  const biggestBlocker = Object.entries({
    ...totals.bySkipReason,
    ...totals.byValidationFail
  }).sort((a, b) => b[1] - a[1])[0];

  if (biggestBlocker) {
    console.log(`     Biggest blocker:       ${biggestBlocker[0]} (${biggestBlocker[1]}x)`);
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  TIP: Run with --verbose to see rejected candidates');
  console.log('  TIP: This reads STORED results, not re-simulation');
  console.log('═══════════════════════════════════════════════════════════════');

  await mongoose.disconnect();
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function r2(n) { return Math.round((n || 0) * 100) / 100; }

function getStatusIcon(status) {
  const icons = {
    'TARGET_HIT': '🎯',
    'STOPPED_OUT': '🛑',
    'TIME_EXIT': '⏰',
    'ENTERED': '📈',
    'VALIDATED': '✅',
    'ORDER_PLACED': '📋',
    'COLLECTING_ORB': '🕐',
    'PENDING': '⏳',
    'SKIPPED': '⛔',
    'FAILED': '💥'
  };
  return icons[status] || '❓';
}

function getCheckDetail(check, name) {
  if (!check) return 'no data';
  switch (name) {
    case 'gap_check':
      return `gap: ${r2(check.value || 0)}%`;
    case 'gap_direction':
      return `dir: ${check.direction || '?'} val: ${r2(check.value || 0)}%`;
    case 'orb_alignment':
      return `bias: ${check.scan_bias || '?'} orb: ${check.orb_dir || '?'} rr: ${r2(check.new_rr || 0)}`;
    case 'nifty_alignment':
      return `nifty: ${check.nifty_dir || '?'} ${r2(check.nifty_change_pct || 0)}%`;
    case 'orb_range_width':
      return `orb_range: ${r2(check.orb_range_pct || 0)}% max: ${r2(check.max_allowed || 0)}%`;
    case 'volume_check':
      return `ratio: ${r2(check.ratio || 0)}`;
    default:
      return JSON.stringify(check).substring(0, 28);
  }
}

// Run
main().catch(err => {
  console.error('Diagnostic failed:', err);
  process.exit(1);
});
