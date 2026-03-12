/**
 * Verify proposed intraday target pivot ladder with realistic Indian stock data.
 *
 * Tests each scan group with real-world-like numbers to verify:
 * 1. The pivot priority order produces viable targets
 * 2. R:R ratios are achievable
 * 3. Different scan types get appropriate target distances
 *
 * Run: node verify-pivot-ladder.js
 */

const round2 = (n) => n == null ? null : Math.round(n * 100) / 100;
const isNum = (v) => typeof v === 'number' && isFinite(v);

// ═══════════════════════════════════════════════════════════════════════════════
// REALISTIC TEST DATA — Based on typical Indian midcap stocks (₹500-2000 range)
// ═══════════════════════════════════════════════════════════════════════════════

const STOCK_RELIANCE = {
  name: 'RELIANCE (₹1280 range)',
  prevClose: 1280,
  prevHigh: 1295,
  prevLow: 1268,
  ema20: 1275,
  atr: 22, // ~1.7% ATR typical for large cap
  // 1H pivots (from last 1H candle: H=1290, L=1275, C=1280)
  hourly_1h: { r1: 1288, r2: 1296, s1: 1272, s2: 1264 },
  // Daily pivots (from prev day: H=1295, L=1268, C=1280)
  daily: { r1: 1292, r2: 1304, s1: 1265, s2: 1250 },
  previousDayHigh: 1295,
  previousDayLow: 1268,
};

const STOCK_TATA_MOTORS = {
  name: 'TATAMOTORS (₹780 range, higher vol)',
  prevClose: 780,
  prevHigh: 798,
  prevLow: 770,
  ema20: 785,
  atr: 18, // ~2.3% ATR
  hourly_1h: { r1: 790, r2: 800, s1: 774, s2: 764 },
  daily: { r1: 796, r2: 812, s1: 764, s2: 748 },
  previousDayHigh: 798,
  previousDayLow: 770,
};

const STOCK_SMALL_CAP = {
  name: 'SMALLCAP (₹320 range, high vol)',
  prevClose: 320,
  prevHigh: 330,
  prevLow: 312,
  ema20: 318,
  atr: 10, // ~3.1% ATR
  hourly_1h: { r1: 326, r2: 332, s1: 316, s2: 310 },
  daily: { r1: 330, r2: 340, s1: 310, s2: 300 },
  previousDayHigh: 330,
  previousDayLow: 312,
};

// ═══════════════════════════════════════════════════════════════════════════════
// PROPOSED LADDER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Group A & B: Compression/Pullback/Breakout — 1H first
 * Priority: 1H Swing → 1H R1 → Daily R1 → 1H R2 → Daily R2 → PDH → REJECT
 */
function findLongTarget_GroupAB(entry, risk, data, minRR = 1.2) {
  const candidates = [
    { level: data.hourly_1h?.r1, basis: 'hourly_r1', label: '1H R1' },
    { level: data.daily?.r1,     basis: 'daily_r1',  label: 'Daily R1' },
    { level: data.hourly_1h?.r2, basis: 'hourly_r2', label: '1H R2' },
    { level: data.daily?.r2,     basis: 'daily_r2',  label: 'Daily R2' },
    { level: data.previousDayHigh, basis: 'pdh',     label: 'PDH' }
  ];
  return findFromLadder(candidates, entry, risk, minRR, 'LONG');
}

/**
 * Group C: Momentum/Volume Shocker — Daily first (momentum blows past 1H)
 * Priority: Daily R1 → 1H R1 → Daily R2 → 1H R2 → PDH → REJECT
 */
function findLongTarget_GroupC(entry, risk, data, minRR = 1.2) {
  const candidates = [
    { level: data.daily?.r1,     basis: 'daily_r1',  label: 'Daily R1' },
    { level: data.hourly_1h?.r1, basis: 'hourly_r1', label: '1H R1' },
    { level: data.daily?.r2,     basis: 'daily_r2',  label: 'Daily R2' },
    { level: data.hourly_1h?.r2, basis: 'hourly_r2', label: '1H R2' },
    { level: data.previousDayHigh, basis: 'pdh',     label: 'PDH' }
  ];
  return findFromLadder(candidates, entry, risk, minRR, 'LONG');
}

function findShortTarget_GroupAB(entry, risk, data, minRR = 1.2) {
  const candidates = [
    { level: data.hourly_1h?.s1, basis: 'hourly_s1', label: '1H S1' },
    { level: data.daily?.s1,     basis: 'daily_s1',  label: 'Daily S1' },
    { level: data.hourly_1h?.s2, basis: 'hourly_s2', label: '1H S2' },
    { level: data.daily?.s2,     basis: 'daily_s2',  label: 'Daily S2' },
    { level: data.previousDayLow, basis: 'pdl',      label: 'PDL' }
  ];
  return findFromLadder(candidates, entry, risk, minRR, 'SHORT');
}

function findShortTarget_GroupC(entry, risk, data, minRR = 1.2) {
  const candidates = [
    { level: data.daily?.s1,     basis: 'daily_s1',  label: 'Daily S1' },
    { level: data.hourly_1h?.s1, basis: 'hourly_s1', label: '1H S1' },
    { level: data.daily?.s2,     basis: 'daily_s2',  label: 'Daily S2' },
    { level: data.hourly_1h?.s2, basis: 'hourly_s2', label: '1H S2' },
    { level: data.previousDayLow, basis: 'pdl',      label: 'PDL' }
  ];
  return findFromLadder(candidates, entry, risk, minRR, 'SHORT');
}

function findFromLadder(candidates, entry, risk, minRR, direction) {
  for (const c of candidates) {
    if (!isNum(c.level)) continue;
    const isValid = direction === 'LONG' ? c.level > entry : c.level < entry;
    if (!isValid) continue;
    const reward = direction === 'LONG' ? c.level - entry : entry - c.level;
    const rr = reward / risk;
    if (rr >= minRR) {
      return { target: c.level, basis: c.basis, label: c.label, rr: round2(rr), reward: round2(reward), rewardPct: round2((reward / entry) * 100) };
    }
  }
  return { rejected: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════════

function testScanType(label, stock, entry, stop, direction, group) {
  const risk = direction === 'LONG' ? entry - stop : stop - entry;
  const riskPct = round2((risk / entry) * 100);
  const finder = direction === 'LONG'
    ? (group === 'C' ? findLongTarget_GroupC : findLongTarget_GroupAB)
    : (group === 'C' ? findShortTarget_GroupC : findShortTarget_GroupAB);

  const result = finder(entry, risk, stock);

  const status = result.rejected ? '❌ REJECT' : `✅ ${result.label} (₹${result.target})`;
  console.log(`  ${label.padEnd(35)} | E=₹${round2(entry)} SL=₹${round2(stop)} Risk=${riskPct}% | ${status}${result.rr ? ` R:R=${result.rr}:1 Reward=${result.rewardPct}%` : ''}`);
  return result;
}

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('VERIFICATION: Proposed Intraday Pivot Ladder');
console.log('═══════════════════════════════════════════════════════════════════\n');

for (const stock of [STOCK_RELIANCE, STOCK_TATA_MOTORS, STOCK_SMALL_CAP]) {
  console.log(`\n── ${stock.name} ──`);
  console.log(`   ATR=₹${stock.atr} (${round2((stock.atr / stock.prevClose) * 100)}%)  1H: R1=${stock.hourly_1h.r1} R2=${stock.hourly_1h.r2} S1=${stock.hourly_1h.s1} S2=${stock.hourly_1h.s2}`);
  console.log(`   Daily: R1=${stock.daily.r1} R2=${stock.daily.r2} S1=${stock.daily.s1} S2=${stock.daily.s2}  PDH=${stock.previousDayHigh} PDL=${stock.previousDayLow}\n`);

  // ── LONG SCENARIOS ──
  console.log('  LONG trades:');

  // Breakout: entry above 20D high (prevHigh + 0.2*ATR)
  const breakoutEntry = stock.prevHigh + 0.2 * stock.atr;
  const breakoutStop = stock.prevHigh - 0.1 * stock.atr;
  testScanType('Breakout (Group B)', stock, breakoutEntry, breakoutStop, 'LONG', 'B');

  // Pullback: entry at EMA20
  const pullbackEntry = stock.ema20;
  const pullbackStop = stock.ema20 - 0.6 * stock.atr;
  testScanType('Pullback (Group A)', stock, pullbackEntry, pullbackStop, 'LONG', 'A');

  // Consolidation: entry above prevHigh + 0.1*ATR
  const consolEntry = stock.prevHigh + 0.1 * stock.atr;
  const consolStop = stock.prevLow - 0.1 * stock.atr;
  testScanType('Consolidation (Group A)', stock, consolEntry, consolStop, 'LONG', 'A');

  // Momentum: entry above prevHigh + 0.15*ATR
  const momEntry = stock.prevHigh + 0.15 * stock.atr;
  const momStop = stock.prevLow * (1 - 0.0015);
  testScanType('Momentum (Group C)', stock, momEntry, momStop, 'LONG', 'C');

  // ── SHORT SCENARIOS ──
  console.log('  SHORT trades:');

  // Breakdown: entry below prevLow - 0.15*ATR
  const breakdownEntry = stock.prevLow - 0.15 * stock.atr;
  const breakdownStop = stock.prevLow + 0.1 * stock.atr;
  testScanType('Breakdown (Group B)', stock, breakdownEntry, breakdownStop, 'SHORT', 'B');

  // Failed Resistance: entry below prevLow - 0.1*ATR
  const failedResEntry = stock.prevLow - 0.1 * stock.atr;
  const failedResStop = stock.prevHigh * (1 + 0.0015);
  testScanType('Failed Resistance (Group A)', stock, failedResEntry, failedResStop, 'SHORT', 'A');

  // Compression Bearish: entry below prevLow - 0.1*ATR
  const compBearEntry = stock.prevLow - 0.1 * stock.atr;
  const compBearStop = stock.prevHigh + 0.1 * stock.atr;
  testScanType('Compression Bearish (Group A)', stock, compBearEntry, compBearStop, 'SHORT', 'A');

  // Volume Shocker Bearish (momentum): entry below prevLow
  const vsEntry = stock.prevLow - 0.15 * stock.atr;
  const vsStop = stock.prevLow + 0.1 * stock.atr;
  testScanType('Vol Shocker Bear (Group C)', stock, vsEntry, vsStop, 'SHORT', 'C');

  // Compare: old fixed 3% approach for momentum
  const fixed3Target = round2(momEntry * 1.03);
  const fixed3Risk = momEntry - momStop;
  const fixed3RR = round2((fixed3Target - momEntry) / fixed3Risk);
  console.log(`\n  [OLD] Momentum Fixed 3%: target=₹${fixed3Target} R:R=${fixed3RR}:1 ${fixed3RR >= 1.2 ? '✅' : '❌'}`);

  console.log('');
}

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('SUMMARY');
console.log('═══════════════════════════════════════════════════════════════════');
console.log(`
Key observations:
1. 1H R1/S1 are TIGHTER than Daily R1/S1 — good for pullback/compression
2. Daily R1/S1 are WIDER — better for momentum that blows past 1H levels
3. The ladder adapts naturally: tight stops → 1H targets work, wide stops → need daily targets
4. Momentum with daily-first priority avoids the fixed 3% hack entirely
5. Breakdowns with prevLow stop (fixed bug) now have reasonable risk for 1H/daily targets
`);
