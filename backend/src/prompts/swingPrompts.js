import StockAnalysis from "../models/stockAnalysis.js";
import { pickBestStage2Candidate, shrinkCandidateForPrompt } from "../utils/pickBestCandidate.js";

/**
 * @typedef {"BULLISH" | "BEARISH" | "NEUTRAL"} Stage1Trend
 * @typedef {"HIGH" | "MEDIUM" | "LOW"} Stage1Volatility
 * @typedef {"ABOVE_AVERAGE" | "AVERAGE" | "BELOW_AVERAGE" | "UNKNOWN"} Stage1VolumeBand
 *
 * @typedef {Object} Stage1MarketSummary
 * @property {number} last
 * @property {Stage1Trend} trend
 * @property {Stage1Volatility} volatility
 * @property {Stage1VolumeBand} volume
 *
 * @typedef {Object} Stage1DataHealth
 * @property {boolean} have_last
 * @property {boolean} have_atr14_1D
 * @property {{ema20_1D: boolean, ema50_1D: boolean, sma200_1D: boolean}} have_ma
 * @property {string[]} missing
 *
 * @typedef {Object} Stage1Result
 * @property {"1.4-pre"} schema_version
 * @property {string} symbol
 * @property {boolean} insufficientData
 * @property {Stage1MarketSummary} market_summary
 * @property {Stage1DataHealth} data_health
 * @property {string[]} notes
 */

/**
 * Build Stage 1 analysis result
 * @param {Object} params
 * @param {string} params.stock_name
 * @param {string} params.stock_symbol
 * @param {number} params.current_price
 * @param {Object} params.marketPayload
 * @param {{code?: string, name?: string, index?: string}} [params.sectorInfo]
 * @returns {Stage1Result}
 */
export function buildStage1({
  stock_name,
  stock_symbol,
  current_price,
  marketPayload,
  sectorInfo,
}) {
  const priceContext = marketPayload?.priceContext ?? {};
  const trendMomentum = marketPayload?.trendMomentum ?? {};
  const volumeContext = marketPayload?.volumeContext ?? {};
  const sentimentContext = marketPayload?.sentimentContext ?? marketPayload?.newsLite?.detailedAnalysis;

  // -------- core values --------
  /** @type {number} */
  const last =
    typeof priceContext.last === "number" ? priceContext.last : current_price;

  /** @type {number|null} */
  const atr14_1D =
    typeof trendMomentum.atr14_1D === "number" ? trendMomentum.atr14_1D : null;

  /** @type {number|null} */
  const ema20_1D =
    typeof trendMomentum.ema20_1D === "number" ? trendMomentum.ema20_1D : null;

  /** @type {number|null} */
  const ema50_1D =
    typeof trendMomentum.ema50_1D === "number" ? trendMomentum.ema50_1D : null;

  /** @type {number|null} */
  const sma200_1D =
    typeof trendMomentum.sma200_1D === "number" ? trendMomentum.sma200_1D : null;

  // -------- trend (BULLISH / BEARISH / NEUTRAL) --------
  /** @type {Stage1Trend} */
  let trend = "NEUTRAL";

  if (ema20_1D != null && ema50_1D != null && sma200_1D != null) {
    if (last > sma200_1D && ema20_1D > ema50_1D) {
      trend = "BULLISH";
    } else if (last < sma200_1D && ema20_1D < ema50_1D) {
      trend = "BEARISH";
    } else {
      trend = "NEUTRAL";
    }
  } else if (typeof trendMomentum.trendBias === "string") {
    // fallback to backend's own trendBias if MAs are missing
    const bias = trendMomentum.trendBias.toLowerCase();
    if (bias === "bullish") trend = "BULLISH";
    else if (bias === "bearish") trend = "BEARISH";
    else trend = "NEUTRAL";
  }

  // -------- volatility from ATR% --------
  /** @type {Stage1Volatility} */
  let volatility = "MEDIUM";

  if (atr14_1D != null && last > 0) {
    const atrPct = (atr14_1D / last) * 100; // e.g. ~2.55% for this payload

    if (atrPct < 1) {
      volatility = "LOW";
    } else if (atrPct <= 2) {
      volatility = "MEDIUM";
    } else {
      volatility = "HIGH";
    }
  }

  // -------- volume band --------
  /** @type {Stage1VolumeBand} */
  let volume = "UNKNOWN";

  if (typeof volumeContext.classification === "string") {
    const cls = volumeContext.classification.toUpperCase();
    if (cls === "ABOVE_AVERAGE" || cls === "AVERAGE" || cls === "BELOW_AVERAGE") {
      volume = cls;
    }
  } else if (typeof volumeContext.band === "string") {
    const band = volumeContext.band.toUpperCase();
    if (band === "ABOVE_AVERAGE" || band === "AVERAGE" || band === "BELOW_AVERAGE") {
      volume = band;
    }
  }

  // -------- data health + insufficientData --------
  const have_last = typeof last === "number" && !Number.isNaN(last);
  const have_atr14_1D = atr14_1D != null;
  const have_ma = {
    ema20_1D: ema20_1D != null,
    ema50_1D: ema50_1D != null,
    sma200_1D: sma200_1D != null,
  };

  /** @type {string[]} */
  const missing = [];
  if (!have_last) missing.push("priceContext.last_or_current_price");
  if (!have_atr14_1D) missing.push("trendMomentum.atr14_1D");
  if (!have_ma.ema20_1D) missing.push("trendMomentum.ema20_1D");
  if (!have_ma.ema50_1D) missing.push("trendMomentum.ema50_1D");
  if (!have_ma.sma200_1D) missing.push("trendMomentum.sma200_1D");

  // your rule: if we miss key fields, later stages should mark insufficientData
  const insufficientData =
    !have_last || !have_atr14_1D || !have_ma.ema20_1D || !have_ma.ema50_1D;

  // -------- notes for debugging / Stage-3 context --------
  /** @type {string[]} */
  const notes = [];

  notes.push(
    `Sector: ${sectorInfo?.name || "Unknown"} (${sectorInfo?.code || "OTHER"})`
  );

  notes.push(
    `Last price used: ₹${last.toFixed(2)}, trend: ${trend}, volatility: ${volatility}, volume: ${volume}.`
  );

  if (sentimentContext) {
    const basicSent =
      sentimentContext.basicSentiment ||
      sentimentContext.sentiment ||
      "unknown";
    const conf =
      typeof sentimentContext.confidence === "number"
        ? sentimentContext.confidence
        : sentimentContext.metadata?.confidence;
    notes.push(
      `News sentiment: ${basicSent} with confidence ${conf ?? "n/a"} based on ${
        sentimentContext.newsAnalyzed ??
        sentimentContext.metadata?.newsCount ??
        "n/a"
      } articles.`
    );
  }

  if (insufficientData) {
    notes.push(
      "One or more key indicators are missing; downstream swing structure may need insufficientData=true."
    );
  }

  return {
    schema_version: "1.4-pre",
    symbol: stock_symbol,
    insufficientData,
    market_summary: {
      last,
      trend,
      volatility,
      volume,
    },
    data_health: {
      have_last,
      have_atr14_1D,
      have_ma,
      missing,
    },
    notes,
  };
}

function get(obj, path, fallback = undefined) {
  try {
    return path.split(".").reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj) ?? fallback;
  } catch {
    return fallback;
  }
}

function isNum(x) {
  return typeof x === "number" && Number.isFinite(x);
}

function round2(x) {
  if (!isNum(x)) return x;
  return Math.round(x * 100) / 100;
}

function calcClassicPivots(prevHigh, prevLow, prevClose) {
  // Classic / floor pivots: P=(H+L+C)/3; R1=2P-L; S1=2P-H; etc.  [oai_citation:1‡Investopedia](https://www.investopedia.com/articles/forex/05/fxpivots.asp?utm_source=chatgpt.com)
  const P = (prevHigh + prevLow + prevClose) / 3;
  const R1 = (2 * P) - prevLow;
  const S1 = (2 * P) - prevHigh;
  const R2 = P + (prevHigh - prevLow);
  const S2 = P - (prevHigh - prevLow);
  const R3 = prevHigh + 2 * (P - prevLow);
  const S3 = prevLow - 2 * (prevHigh - P);
  return {
    pivot: round2(P),
    r1: round2(R1), r2: round2(R2), r3: round2(R3),
    s1: round2(S1), s2: round2(S2), s3: round2(S3)
  };
}

function rrBuy(entry, target, stopLoss) {
  if (![entry, target, stopLoss].every(isNum)) return 0;
  const risk = entry - stopLoss;
  const reward = target - entry;
  if (risk <= 0 || reward <= 0) return 0;
  return round2(reward / risk);
}

function rrSell(entry, target, stopLoss) {
  // SELL geometry: target < entry < stopLoss
  if (![entry, target, stopLoss].every(isNum)) return 0;
  const risk = stopLoss - entry;
  const reward = entry - target;
  if (risk <= 0 || reward <= 0) return 0;
  return round2(reward / risk);
}

function buildTrigger({ id, timeframe, left_ref, op, right_ref, right_value }) {
  return {
    id,
    scope: "entry",
    timeframe, // "15m" | "1h" | "1d"
    left: { ref: left_ref },
    op,
    right: { ref: right_ref, value: isNum(right_value) ? round2(right_value) : 0, offset: 0 },
    occurrences: { count: 1, consecutive: true },
    within_sessions: 5,
    expiry_bars: 20
  };
}

function buildInvalidation(entry) {
  return {
    timeframe: "1h",
    left: { ref: "close" },
    op: "<",
    right: { ref: "entry", value: 0 },
    occurrences: { count: 1, consecutive: false },
    action: "cancel_entry"
  };
}

function computeDataHealth(marketPayload) {
  const needed = [
    "priceContext.last",
    "trendMomentum.ema20_1D",
    "trendMomentum.ema50_1D",
    "trendMomentum.sma200_1D",
    "trendMomentum.atr14_1D",
    "swingContext.prevSession.high",
    "swingContext.prevSession.low",
    "swingContext.prevSession.close"
  ];

  const missing = [];
  for (const p of needed) {
    const v = get(marketPayload, p);
    if (!isNum(v) && typeof v !== "string") missing.push(p);
  }

  return { missing, ok: missing.length === 0 };
}

export function buildStage2({ stock_name, stock_symbol, current_price, marketPayload, s1 }) {
  const system = `You are a disciplined swing strategist. JSON ONLY. No markdown.`;

  // If you still want an LLM here, keep prompts.
  // But since you asked for code-first: Stage2 can be fully deterministic and skip LLM.

  const last = get(marketPayload, "priceContext.last", current_price);
  const ema20 = get(marketPayload, "trendMomentum.ema20_1D");
  const ema50 = get(marketPayload, "trendMomentum.ema50_1D");
  const sma200 = get(marketPayload, "trendMomentum.sma200_1D");
  const rsi1h = get(marketPayload, "trendMomentum.rsi14_1h");
  const atrD = get(marketPayload, "trendMomentum.atr14_1D");

  const prevH = get(marketPayload, "swingContext.prevSession.high");
  const prevL = get(marketPayload, "swingContext.prevSession.low");
  const prevC = get(marketPayload, "swingContext.prevSession.close");

  // Prefer pivots provided; else compute classic pivots from prev session H/L/C  [oai_citation:2‡Investopedia](https://www.investopedia.com/articles/forex/05/fxpivots.asp?utm_source=chatgpt.com)
  let pivots = get(marketPayload, "swingContext.pivots");
  if (!pivots && [prevH, prevL, prevC].every(isNum)) {
    pivots = calcClassicPivots(prevH, prevL, prevC);
  }

  const recent20High = get(marketPayload, "swingContext.swingLevels.recent20.high");
  const recent20Low  = get(marketPayload, "swingContext.swingLevels.recent20.low");

  const dataHealth = computeDataHealth(marketPayload);
  const insufficientData = !dataHealth.ok || !isNum(last) || !isNum(atrD) || !pivots;

  const base = {
    schema_version: "1.4-s2",
    symbol: stock_symbol,
    insufficientData: !!insufficientData,
    data_health: dataHealth,
    notes: []
  };

  if (insufficientData) {
    base.notes.push("Insufficient inputs to generate reliable multi-candidate skeletons.");
    base.candidates = [];
    return { system, user: JSON.stringify(base, null, 2) };
  }

  // Simple trend bias from S1 (your Stage-1 already computed it)
  const trend = get(s1, "market_summary.trend", "NEUTRAL"); // "BULLISH" | "BEARISH" | "NEUTRAL"

  const candidates = [];

  // --- C1: Breakout (with trend) ---
  // Use recent swing high / R1 as reference “activation” level.
  const c1Entry = round2(Math.max(pivots.r1 || 0, recent20High || 0));
  const c1Stop  = round2(Math.max(pivots.pivot || 0, ema20 || 0)); // keep below entry
  const c1Target = round2((pivots.r2 && pivots.r2 > c1Entry) ? pivots.r2 : (c1Entry + 1.2 * atrD));
  const c1RR = rrBuy(c1Entry, c1Target, c1Stop);

  candidates.push({
    id: "C1",
    name: "breakout",
    score: {
      rr: c1RR,
      trend_align: trend === "BULLISH" ? 1 : 0.3,
      distance_pct: round2((Math.abs(last - c1Entry) / last) * 100)
    },
    skeleton: {
      type: "BUY",
      archetype: "breakout",
      alignment: trend === "BULLISH" ? "with_trend" : "neutral",
      entryType: "stop",
      entry: c1Entry,
      entryRange: null,
      target: c1Target,
      stopLoss: c1Stop,
      riskReward: c1RR,
      triggers: [
        buildTrigger({ id: "T1", timeframe: "1h", left_ref: "close", op: "crosses_above", right_ref: "entry", right_value: c1Entry })
      ],
      invalidations_pre_entry: [ buildInvalidation(c1Entry) ]
    }
  });

  // --- C2: Pullback (to EMA20 / Pivot) ---
  const c2Entry = round2(Math.max(ema20, pivots.pivot));
  const c2Stop  = round2(pivots.s1 && pivots.s1 < c2Entry ? pivots.s1 : (c2Entry - 0.8 * atrD));
  const c2Target = round2(recent20High && recent20High > c2Entry ? recent20High : (c2Entry + 1.0 * atrD));
  const c2RR = rrBuy(c2Entry, c2Target, c2Stop);

  candidates.push({
    id: "C2",
    name: "pullback",
    score: {
      rr: c2RR,
      trend_align: trend === "BULLISH" ? 1 : 0.4,
      distance_pct: round2((Math.abs(last - c2Entry) / last) * 100)
    },
    skeleton: {
      type: "BUY",
      archetype: "pullback",
      alignment: trend === "BULLISH" ? "with_trend" : "neutral",
      entryType: "limit",
      entry: c2Entry,
      entryRange: [round2(c2Entry - 0.2 * atrD), round2(c2Entry + 0.2 * atrD)],
      target: c2Target,
      stopLoss: c2Stop,
      riskReward: c2RR,
      triggers: [
        buildTrigger({ id: "T1", timeframe: "1h", left_ref: "price", op: ">=", right_ref: "value", right_value: round2(c2Entry - 0.2 * atrD) })
      ],
      invalidations_pre_entry: [ buildInvalidation(c2Entry) ]
    }
  });

  // --- C3: Mean-reversion (from S1/S2 toward Pivot) ---
  // Only “high quality” when RSI is low-ish; else score it down.
  const c3Entry = round2(pivots.s1);
  const c3Stop  = round2(pivots.s2 ? pivots.s2 : (c3Entry - 0.8 * atrD));
  const c3Target = round2(pivots.pivot);
  const c3RR = rrBuy(c3Entry, c3Target, c3Stop);

  candidates.push({
    id: "C3",
    name: "mean_reversion",
    score: {
      rr: c3RR,
      trend_align: trend === "NEUTRAL" ? 1 : 0.5,
      rsi_fit: isNum(rsi1h) ? (rsi1h < 45 ? 1 : 0.3) : 0.4,
      distance_pct: round2((Math.abs(last - c3Entry) / last) * 100)
    },
    skeleton: {
      type: "BUY",
      archetype: "mean-reversion",
      alignment: "neutral",
      entryType: "limit",
      entry: c3Entry,
      entryRange: [round2(c3Entry - 0.2 * atrD), round2(c3Entry + 0.2 * atrD)],
      target: c3Target,
      stopLoss: c3Stop,
      riskReward: c3RR,
      triggers: [
        buildTrigger({ id: "T1", timeframe: "1h", left_ref: "price", op: "<=", right_ref: "entry", right_value: c3Entry })
      ],
      invalidations_pre_entry: [ buildInvalidation(c3Entry) ]
    }
  });

  // --- C4: Range-fade (near R1/R2 back toward Pivot) ---
  const c4Entry = round2(pivots.r1);
  const c4Stop  = round2(pivots.r2 ? pivots.r2 : (c4Entry + 0.8 * atrD));
  const c4Target = round2(pivots.pivot);
  const c4RR = rrSell(c4Entry, c4Target, c4Stop);

  candidates.push({
    id: "C4",
    name: "range_fade",
    score: {
      rr: c4RR,
      trend_align: trend === "NEUTRAL" ? 1 : 0.4,
      distance_pct: round2((Math.abs(last - c4Entry) / last) * 100)
    },
    skeleton: {
      type: "SELL",
      archetype: "range-fade",
      alignment: trend === "BEARISH" ? "with_trend" : "counter_trend",
      entryType: "stop-limit",
      entry: c4Entry,
      entryRange: null,
      target: c4Target,
      stopLoss: c4Stop,
      riskReward: c4RR,
      triggers: [
        buildTrigger({ id: "T1", timeframe: "1h", left_ref: "close", op: "crosses_below", right_ref: "entry", right_value: c4Entry })
      ],
      invalidations_pre_entry: [
        {
          timeframe: "1h",
          left: { ref: "close" },
          op: ">",
          right: { ref: "value", value: c4Stop },
          occurrences: { count: 1, consecutive: false },
          action: "cancel_entry"
        }
      ]
    }
  });

  // Filter obvious invalid candidates (bad geometry or RR too low)
  const filtered = candidates
    .map(c => {
      const sk = c.skeleton;
      const rr = sk.riskReward;
      const geomOk =
        (sk.type === "BUY"  && sk.stopLoss < sk.entry && sk.entry < sk.target) ||
        (sk.type === "SELL" && sk.target < sk.entry && sk.entry < sk.stopLoss);
      return { ...c, ok: geomOk && rr > 0 };
    })
    .filter(c => c.ok);

  // Optional: label NO_TRADE if nothing passes min RR threshold
  const MIN_RR = 1.5;
  const passing = filtered.filter(c => c.skeleton.riskReward >= MIN_RR);

  const out = {
    ...base,
    insufficientData: false,
    candidates: (passing.length ? passing : filtered)
      .sort((a, b) => {
        // quick score: RR first, then trend alignment, then closeness
        const aScore = (a.score.rr || 0) + (a.score.trend_align || 0) - ((a.score.distance_pct || 0) / 100);
        const bScore = (b.score.rr || 0) + (b.score.trend_align || 0) - ((b.score.distance_pct || 0) / 100);
        return bScore - aScore;
      })
  };

  out.notes.push("Candidates are computed from pivots + swing highs/lows + ATR; pivots are classic H/L/C based.");//  [oai_citation:3‡Investopedia](https://www.investopedia.com/articles/forex/05/fxpivots.asp?utm_source=chatgpt.com)
  out.notes.push("ATR is used as a volatility proxy for sizing distances.");//  [oai_citation:4‡Fidelity](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/atr?utm_source=chatgpt.com)

  // If you're keeping the "prompt builder" pattern:
  const user = JSON.stringify(out, null, 2);
  return { system, user };
}

export async function buildStage3Prompt({
  stock_name,
  stock_symbol,
  current_price,
  marketPayload,
  sectorInfo,
  s1,
  s2,
  instrument_key,
  userTradeState,
  generatedAtIst
}) {
  let existingStage3 = null;
  let existingMetadata = null;

  if (instrument_key) {
    const existingAnalysis = await StockAnalysis.findByInstrument(instrument_key, "swing");
    existingStage3 = existingAnalysis?.analysis_data?.strategies?.[0] || null;
    existingMetadata = {
      generated_at: existingAnalysis?.analysis_data?.generated_at_ist || null,
      previous_price: existingAnalysis?.analysis_data?.market_summary?.last || null,
      valid_until: existingAnalysis?.valid_until || null
    };
  }

  // 1) Code selects best candidate (deterministic)
  const { best, ranked } = pickBestStage2Candidate(s2);

  // Selection trace for transparency (matches pickBestStage2Candidate weights)
  const selectionTrace = (ranked || []).map((r, idx) => {
    const c = r.c || {};
    const sk = c.skeleton || {};
    const sc = c.score || {};
    const rr = typeof sc.rr === "number" ? sc.rr : (sk.riskReward || 0);
    const trend = typeof sc.trend_align === "number" ? sc.trend_align : 0;
    const dist = typeof sc.distance_pct === "number" ? sc.distance_pct : 999;
    const rrPart = Number((rr * 0.55).toFixed(4));
    const trendPart = Number((trend * 0.35).toFixed(4));
    const distPenalty = Number((Math.min(dist, 5) * 0.10).toFixed(4));
    const total = Number((rrPart + trendPart - distPenalty).toFixed(4));
    return {
      rank: idx + 1,
      id: c.id,
      name: c.name,
      rr,
      trend_align: trend,
      distance_pct: dist,
      rrPart,
      trendPart,
      distPenalty,
      totalScore: total,
      type: sk.type,
      archetype: sk.archetype,
      entry: sk.entry,
      target: sk.target,
      stopLoss: sk.stopLoss
    };
  });

  const scoreBreakdown = selectionTrace.reduce((acc, st) => {
    const key = st.id || `rank_${st.rank}`;
    acc[key] = {
      rr: st.rr,
      trend_align: st.trend_align,
      distance_pct: st.distance_pct,
      rrPart: st.rrPart,
      trendPart: st.trendPart,
      distPenalty: st.distPenalty,
      totalScore: st.totalScore
    };
    return acc;
  }, {});

  const selectedLite = shrinkCandidateForPrompt(best);
  const comparisonLite = selectionTrace
    .filter(st => !best || st.id !== best.id)
    .slice(0, 3)
    .map(st => ({
      id: st.id,
      name: st.name,
      totalScore: st.totalScore,
      type: st.type,
      archetype: st.archetype
    }));

  const hasOpen =
    userTradeState?.hasOpenPosition === true ||
    userTradeState?.hasOpenOrder === true;

  const analysisMode = hasOpen ? "MANAGE_OPEN" : "DISCOVERY";

  if (analysisMode === "DISCOVERY") {
    // Avoid leaking non-schema keys from prior runs; prompt will also instruct not to copy.
    existingStage3 = null;
  }

  const system = `You are a highly reliable swing-market analysis engine for Indian equities.
Return STRICT, VALID JSON that follows schema v1.4 exactly.
No markdown. No extra text.
Never hallucinate values. Use only provided data and safe derived calculations.`;

  const user = `
=== MODE ===
analysis_mode: "${analysisMode}"

If analysis_mode = "MANAGE_OPEN":
- The user already has an open order/position.
- You MUST NOT produce "order_gate.can_place_order": true.
- You MUST set strategies[0].actionability.status = "monitor_only".
- Prefer KEEP, else ADJUST. If geometry/data breaks, switch to NO_TRADE per rules below.

If analysis_mode = "DISCOVERY":
- No open order/position is present.
- selectedCandidate is final and was selected by deterministic code.
- Do NOT re-rank or swap to other candidates. Use selectedId unless NO_TRADE is forced by geometry/invalid data.
- Choose ONE structure based on SELECTED_CANDIDATE (preferred), or output NO_TRADE if unusable.

=== INPUT CONTEXT ===
Stock: ${stock_name} (${stock_symbol})
Current Observed Price: ₹${current_price}

USER TRADE STATE:
${JSON.stringify(userTradeState || { hasOpenOrder: false, hasOpenPosition: false }, null, 2)}

MARKET PAYLOAD:
${JSON.stringify(marketPayload, null, 2)}

SECTOR INFO:
${JSON.stringify(sectorInfo || {}, null, 2)}

STAGE-1 (preflight):
${JSON.stringify(s1, null, 2)}

STAGE-2 (code-selected summary):
${JSON.stringify({
  selectedId: best?.id || null,
  selectedCandidate: selectedLite || null,
  selection_trace: {
    formula: "score = (rr*0.55) + (trend_align*0.35) - (min(distance_pct,5)*0.10)",
    rr_priority_note: "Pool prefers RR>=1.5 if available; otherwise uses all ok candidates.",
    score_breakdown: scoreBreakdown,
    top_alternatives: comparisonLite
  },
  s2_notes: s2?.notes || [],
  s2_data_health: s2?.data_health || null,
  s2_insufficient: s2?.insufficientData || false
}, null, 2)}

Existing Stage-3 (if available):
${existingStage3 ? JSON.stringify(existingStage3, null, 2) : "None"}

GENERATED_AT_IST_INPUT (must echo exactly):
${generatedAtIst}

Existing Metadata:
${existingMetadata ? JSON.stringify(existingMetadata, null, 2) : "None"}

=== STRICT SOURCE RULE ===
You must use ONLY:
- marketPayload
- sectorInfo
- s1
- STAGE-2 selection summary provided above (selectedCandidate + selection_trace)
- existingStage3 if present
- GENERATED_AT_IST_INPUT must be echoed exactly as generated_at_ist.

Do NOT invent indicators, levels, volume, sentiment, or triggers.
If required values cannot be produced reliably -> insufficientData = true (still output FULL schema).

=== OUTPUT STRICTNESS (HARD RULE) ===
- Output must include ONLY the keys defined in the schema below.
- Do NOT output any extra keys at any nesting level.
- Do NOT output database/serialization types (ObjectId, NumberInt, ISODate, __v, _id).
- Do NOT duplicate keys (e.g., two "why_best").

=== TYPE RULES (HARD) ===
- Any field described as <number> must be a JSON number (not a quoted string).
- indicators[].value must be a number or null (never a string).
- market_summary.last must be a number.

=== EXISTING STAGE-3 RULE ===
- If existingStage3 is present, treat it as reference-only.
- Do NOT copy keys from existingStage3 unless that key exists in the schema.

=== SELECTION RULE ===
- In DISCOVERY mode: Base the main structure on SELECTED_CANDIDATE if present.
- Allowed archetypes ONLY: breakout, pullback, trend-follow, mean-reversion, range-fade.
- Do NOT invent a new archetype outside this list.
- If selectedCandidate.skeleton entry/target/stopLoss is missing or violates required ordering (BUY: stop < entry < target; SELL: target < entry < stop), set type="NO_TRADE", entry=null, entryRange=null, target=null, stopLoss=null, riskReward=0, and mark insufficientData=true.
- If all required values exist but the structure is not acceptable (e.g., RR < 1.0), set type="NO_TRADE" but keep insufficientData=false.

=== OPEN-STATE RULE (VERY IMPORTANT) ===
If userTradeState.hasOpenOrder=true OR userTradeState.hasOpenPosition=true:
- order_gate.can_place_order = false
- strategies[0].actionability.status = "monitor_only"
- Do not simulate triggers; keep runtime.triggers_evaluated = [].

ORDER GATE RULE (DETERMINISTIC, since triggers are not evaluated here):
- If runtime.triggers_evaluated is empty:
  - order_gate.all_triggers_true = false
  - order_gate.no_pre_entry_invalidations = true
  - order_gate.can_place_order = false
  - order_gate.actionability_status = (analysis_mode === "MANAGE_OPEN") ? "monitor_only" : "actionable_on_trigger"
  - order_gate.entry_type_sane = true only if geometry ordering is valid and entryType is in allowed schema values; otherwise false.

ACTIONABILITY SYNC RULE:
- strategies[0].actionability.status MUST equal order_gate.actionability_status.

=== EXPLANATION REQUIREMENTS (MUST DO) ===
You must clearly explain:
1) Why this candidate was chosen (vs other candidates)
2) Why these exact levels (entry/target/stopLoss) were selected
3) How long the structure is intended to remain valid (sessions/days) and what behaviour would cause review/retire

RUNTIME RULE:
- runtime.triggers_evaluated = [] (do NOT simulate trigger evaluation in this version)

=== SENTIMENT MAPPING (DETERMINISTIC) ===
- Build sentiment_analysis from marketPayload.sentimentContext:
  - confidence = sentimentContext.confidence / 100
  - strength = sentimentContext.strength
  - key_factors = sentimentContext.keyFactors (use first 2 if longer)
  - sector_specific = sentimentContext.sectorSpecific
  - market_alignment = sentimentContext.marketAlignment
  - trading_bias = sentimentContext.tradingImplications.bias
  - risk_level = sentimentContext.tradingImplications.riskLevel
  - position_sizing = sentimentContext.tradingImplications.positionSizing
  - entry_strategy = sentimentContext.tradingImplications.entryStrategy
  - news_count = sentimentContext.newsAnalyzed
  - recent_news_count = sentimentContext.recentNewsCount
  - sector_news_weight = sentimentContext.sectorNewsWeight (must be 0–1)

INDICATOR SIGNALS (DETERMINISTIC):
- Use priceContext.last (fallback to current_price) against each indicator value when numeric; if either side is missing, set signal "NEUTRAL".
- For ema20_1D, ema50_1D, sma200_1D: if priceContext.last > value => signal "BUY"; if priceContext.last < value => "SELL"; else "NEUTRAL".
- For rsi14_1h: if value >= 55 => "BUY"; if value <= 45 => "SELL"; else "NEUTRAL".
- For atr14_1D: signal is always "NEUTRAL".

SENTIMENT REASONING SAFETY:
- Keep sentiment_analysis.reasoning numeric and generic (e.g., confidence, newsAnalyzed count, bias, risk level); do NOT cite publication names or external sources even if present in the data.

IMPORTANT LANGUAGE RULE (human-readable fields):
- RULE: Do NOT rename any schema keys. The word-ban applies only to values of free-text fields, not JSON keys.
- Do NOT use: "buy", "sell", "trade", "entry", "exit", "stoploss", "target", "recommend", "should", "must", "advice".
- In human-readable text, refer to:
  - entry as "middle price zone"
  - target as "upper price region"
  - stopLoss as "lower price region"
- You MAY use the numeric values (₹...) and indicator names (ema20_1D, atr14_1D, pivots.r1, etc.).
- Word-ban scope: apply to free-text fields only (why_best, reasoning[].because, warnings[].text, beginner_summary.*, why_in_plain_words, ui_friendly.*, suggested_qty.note, performance_hints strings, sentiment_analysis.reasoning/key_factors). Disclaimer text is exempt (keep the provided compliance sentence even though it includes "buy/sell"). Schema/enums and structured strings (gap_policy, actionability labels/status, order_gate fields, strategy.type/archetype/entryType, indicators[].signal) must use their schema values even if they contain banned words.

=== BEGINNER TEXT RULE (FOR beginner_summary + ui_friendly ONLY) ===
- In beginner_summary.one_liner, beginner_summary.steps, beginner_summary.checklist, ui_friendly.why_smart_move, ui_friendly.beginner_explanation:
  - Avoid jargon terms: pivot, vwap, atr, ema, sma, rsi, distance_pct, trend_align, window_bars.
  - Use plain equivalents like: "reference level", "intraday average", "daily swing range", "short-term average", "long-term average", "momentum gauge".
- In ui_friendly.ai_will_watch, phrase as "Over the next <confirmation.window_bars> × 1h candles" (or use the provided window_bars value; default to "20 × 1h candles" if missing).

=== TITLE RULE ===
- strategies[0].title must be short and plain; avoid jargon (pivot/VWAP/ATR/EMA).
- Suggested pattern: "Upward-leaning structure between ₹<lower> and ₹<upper>".

CONFIDENCE NORMALIZATION:
- If any confidence is provided in 0–100 scale, divide by 100 to fit the 0–1 requirement before outputting.

MONEY MATH (deterministic formulas, round to 2 decimals):
- For BUY: risk_per_share = entry - stopLoss; reward_per_share = target - entry; rr = (risk_per_share > 0) ? reward_per_share / risk_per_share : 0.
- distance_to_stop_pct = (risk_per_share / entry) * 100; distance_to_target_pct = (reward_per_share / entry) * 100.
- qty = (risk_per_share > 0) ? floor(risk_budget_inr / risk_per_share) : 0.
- Apply analogous geometry for SELL: risk_per_share = stopLoss - entry; reward_per_share = entry - target; rr = (risk_per_share > 0) ? reward_per_share / risk_per_share : 0.
- Round INR and percentage outputs to 2 decimals.

=== RISKREWARD CONSISTENCY ===
- Set strategies[0].riskReward = money_example.per_share.rr (rounded to 2 decimals).

=== CONFIDENCE CALCULATION (HYBRID - IMPORTANT) ===
Confidence is calculated using a hybrid approach: deterministic base + bounded AI adjustments.

STEP 1: BASE CONFIDENCE (from code)
- base_confidence = selectedId's totalScore from selection_trace.score_breakdown
- If missing, base_confidence = 0.50

STEP 2: AI ADJUSTMENTS (bounded, must justify each)
Apply these adjustments ONLY when the condition is met. Each adjustment can only be applied ONCE.

NEGATIVE ADJUSTMENTS (penalties):
| Condition | Adjustment | Code |
|-----------|------------|------|
| sentiment.trading_bias conflicts with strategy.type (e.g., bearish sentiment + BUY strategy) | -0.08 | SENT_CONFLICT |
| volatility = "HIGH" AND riskReward < 1.5 | -0.05 | HIGH_VOL_LOW_RR |
| 3+ indicators show signals opposite to strategy.type | -0.06 | IND_CONFLICT |
| sentiment_analysis.confidence < 0.50 | -0.04 | LOW_SENT_CONF |
| volume = "BELOW_AVERAGE" | -0.03 | LOW_VOLUME |
| gap.pct magnitude > 2% (abs value) | -0.03 | GAP_RISK |
| riskReward < 1.0 | -0.07 | POOR_RR |
| distance_pct > 3% (price far from entry) | -0.04 | FAR_ENTRY |

POSITIVE ADJUSTMENTS (bonuses):
| Condition | Adjustment | Code |
|-----------|------------|------|
| All 5 indicators align with strategy.type direction | +0.05 | IND_ALIGNED |
| sentiment.trading_bias matches strategy.type AND sentiment confidence >= 0.75 | +0.04 | SENT_ALIGNED |
| riskReward >= 2.0 | +0.04 | STRONG_RR |
| volume = "ABOVE_AVERAGE" | +0.02 | HIGH_VOLUME |
| distance_pct < 0.5% (price very close to entry) | +0.03 | CLOSE_ENTRY |

STEP 3: CALCULATE FINAL CONFIDENCE
- final_confidence = clamp(base_confidence + sum(adjustments), 0.30, 0.95)
- Round to 2 decimals

STEP 4: OUTPUT confidence_breakdown (REQUIRED)
You MUST output the confidence_breakdown object showing your calculation:
{
  "base_score": <number from totalScore>,
  "adjustments": [
    { "code": "<adjustment code>", "reason": "<brief explanation with values>", "delta": <number> }
  ],
  "final": <final clamped confidence>
}

EXAMPLE:
If base_score = 0.872, HIGH volatility with RR=1.0, and bearish sentiment with BUY strategy:
{
  "base_score": 0.872,
  "adjustments": [
    { "code": "HIGH_VOL_LOW_RR", "reason": "volatility HIGH with riskReward 1.0 < 1.5", "delta": -0.05 },
    { "code": "SENT_CONFLICT", "reason": "sentiment bias bearish conflicts with BUY type", "delta": -0.08 }
  ],
  "final": 0.74
}

CRITICAL RULES FOR CONFIDENCE:
- strategies[0].confidence MUST equal confidence_breakdown.final
- If no adjustments apply, adjustments array should be empty: []
- Never apply the same adjustment code twice
- Always justify with actual values from the data
- Maximum total negative adjustment: -0.40
- Maximum total positive adjustment: +0.18

=== PERFORMANCE_HINTS (REQUIRED) ===
- Must always populate performance_hints.
- confidence_drivers: derive from 2 concrete facts (e.g., "last 782 > ema20_1D 764.90", "distance_pct 0.28").
- uncertainty_factors: derive from 1–2 risks (e.g., "atr14_1D 20.13", "gap -1.51%").
- data_quality_score: 1.0 if s1.data_health.missing is empty else 0.7 (deterministic).

Where to place the explanations (schema fields you MUST fill well):
A) strategies[0].why_best:
   - Mention selectedId and selectedCandidate.name.
   - Compare against 1–2 alternatives from selection_trace.top_alternatives (by id + name).
   - Use numeric evidence (riskReward, distance_pct if present, trend alignment, ATR/levels).

B) strategies[0].reasoning (3–5 items):
   - Each "because" must contain at least ONE real number from marketPayload/s1/s2.
   - At least one "because" must justify the level selection using pivots/swingLevels/supports/resistances.

C) strategies[0].why_in_plain_words (2 items minimum):
   - Point #1: Explain why the three regions (lower/middle/upper) are anchored to specific provided levels
     (example sources: swingContext.pivots, levels.supports/resistances, swingLevels.recent20/recent50).
   - Point #2: Explain time horizon using validity + timeframe fields:
     - strategies[0].timeframe in human words (e.g., trading -sessions "3-7 days" and also why that fits)
     - validity.entry.trading_sessions_soft + trading_sessions_hard
     - validity.position.time_stop_sessions
     Use these numbers directly.

D) strategies[0].ui_friendly.beginner_explanation:
   - 50–80 words.
   - Must mention the intended review window in sessions/days using the validity fields.
   - Must mention what behaviour weakens the structure (neutral phrasing).

E) strategies[0].what_could_go_wrong (at least 1 item):
   - Include one realistic risk linked to provided data (e.g., HIGH volatility if atr/price is high, gap risk from swingContext.gap, news concentration).

=== OUTPUT SCHEMA v1.4 (REQUIRED STRUCTURE) ===

You MUST output ONLY one valid JSON object with EXACTLY this structure:

{
  "schema_version": "1.4",
  "symbol": "${stock_symbol}",
  "analysis_type": "swing",
  "generated_at_ist": "<ISO-8601 timestamp in +05:30 timezone> (must equal GENERATED_AT_IST_INPUT)",
  "insufficientData": <boolean>,
  "market_summary": {
    "last": <number>,
    "trend": "BULLISH" | "BEARISH" | "NEUTRAL",
    "volatility": "HIGH" | "MEDIUM" | "LOW",
    "volume": "ABOVE_AVERAGE" | "AVERAGE" | "BELOW_AVERAGE" | "UNKNOWN"
  },
  "overall_sentiment": "BULLISH" | "BEARISH" | "NEUTRAL",
  "sentiment_analysis": {
    "confidence": <number between 0 and 1>,
    "strength": "high" | "medium" | "low",
    "reasoning": "Short, neutral explanation using real values.",
    "key_factors": ["factor 1", "factor 2"],
    "sector_specific": true | false,
    "market_alignment": "aligned" | "contrary" | "neutral",
    "trading_bias": "bullish" | "bearish" | "neutral",
    "risk_level": "low" | "medium" | "high",
    "position_sizing": "increased" | "standard" | "reduced",
    "entry_strategy": "aggressive" | "moderate" | "cautious",
    "news_count": <number>,
    "recent_news_count": <number>,
    "sector_news_weight": <number between 0 and 1>
  },
  "runtime": {
    "triggers_evaluated": [],
    "pre_entry_invalidations_hit": false
  },
  "order_gate": {
    "all_triggers_true": true | false,
    "no_pre_entry_invalidations": true | false,
    "actionability_status": "actionable_now" | "actionable_on_trigger" | "monitor_only",
    "entry_type_sane": true | false,
    "can_place_order": true | false
  },
  "confidence_breakdown": {
    "base_score": <number from selection_trace totalScore>,
    "adjustments": [
      { "code": "<adjustment code>", "reason": "<brief explanation with values>", "delta": <number> }
    ],
    "final": <final clamped confidence>
  },
  "strategies": [
    {
      "id": "S1",
      "type": "BUY" | "SELL" | "NO_TRADE",
      "archetype": "breakout" | "pullback" | "trend-follow" | "mean-reversion" | "range-fade",
      "alignment": "with_trend" | "counter_trend" | "neutral",
      "title": "Short, neutral title describing the structure.",
      "confidence": <number between 0 and 1, MUST equal confidence_breakdown.final>,
      "why_best": "Short, neutral explanation of why this structure was chosen.",
      "entryType": "limit" | "market" | "range" | "stop" | "stop-limit",
      "entry": <number | null>,
      "entryRange": [<number>, <number>] | null,
      "target": <number | null>,
      "stopLoss": <number | null>,
      "riskReward": <number>,
      "timeframe": "3-7 days",
      "indicators": [
        {
          "name": "ema20_1D" | "ema50_1D" | "sma200_1D" | "rsi14_1h" | "atr14_1D",
          "value": <value from MARKET DATA or null>,
          "signal": "BUY" | "SELL" | "NEUTRAL"
        }
      ],
      "reasoning": [
        { "because": "Neutral explanation using actual values." }
      ],
      "warnings": [
        {
          "code": "GAP_RISK" | "HIGH_VOLATILITY" | "LOW_VOLUME" | "NEWS_EVENT" | "SECTOR_WEAKNESS",
          "severity": "low" | "medium" | "high",
          "text": "Short, factual caution.",
          "applies_when": [],
          "mitigation": ["reduce_qty", "wider_stop", "skip_on_news", "wait_for_confirmation"]
        }
      ],
      "triggers": [],
      "confirmation": {
        "require": "ALL" | "ANY" | "NONE",
        "window_bars": <number>,
        "conditions": []
      },
      "invalidations": [],
      "validity": {
        "entry": {
          "type": "GTD",
          "bars_limit": 0,
          "trading_sessions_soft": 5,
          "trading_sessions_hard": 8,
          "expire_calendar_cap_days": 10
        },
        "position": {
          "time_stop_sessions": 7,
          "gap_policy": "exit_at_open_with_slippage"
        },
        "non_trading_policy": "pause_clock"
      },
      "beginner_summary": {
        "one_liner": "One simple line explaining the structure.",
        "steps": ["step 1", "step 2", "step 3"],
        "checklist": ["check 1", "check 2", "check 3"]
      },
      "why_in_plain_words": [
        {
          "point": "Short point about level selection.",
          "evidence": "Evidence with actual values."
        }
      ],
      "what_could_go_wrong": [
        {
          "risk": "Short description of a realistic risk.",
          "likelihood": "LOW" | "MEDIUM" | "HIGH",
          "impact": "LOW" | "MEDIUM" | "HIGH",
          "mitigation": "How to handle this."
        }
      ],
      "ui_friendly": {
        "why_smart_move": "One neutral sentence (15–25 words).",
        "ai_will_watch": ["monitoring point 1", "monitoring point 2"],
        "beginner_explanation": "50–80 words explanation."
      },
      "money_example": {
        "per_share": {
          "risk": <number>,
          "reward": <number>,
          "rr": <number>
        },
        "position": {
          "qty": <number>,
          "max_loss": <number>,
          "potential_profit": <number>,
          "distance_to_stop_pct": <number>,
          "distance_to_target_pct": <number>
        }
      },
      "suggested_qty": {
        "risk_budget_inr": 1000,
        "risk_per_share": <number>,
        "qty": <number>,
        "alternatives": [
          { "risk_budget_inr": 500, "qty": <number> },
          { "risk_budget_inr": 1000, "qty": <number> },
          { "risk_budget_inr": 2500, "qty": <number> }
        ],
        "note": "Short neutral note."
      },
      "risk_meter": {
        "label": "Low" | "Medium" | "High",
        "score": <number between 0 and 1>,
        "drivers": ["driver 1", "driver 2"]
      },
      "actionability": {
        "label": "Observation structure" | "Upward-leaning structure" | "Downward-leaning structure" | "No structure",
        "status": "actionable_now" | "actionable_on_trigger" | "monitor_only",
        "next_check_in": "15m" | "1h" | "daily",
        "checklist": ["check 1", "check 2"]
      },
      "glossary": {
        "entry": {
          "definition": "Middle price zone used as a central reference.",
          "example": "₹<entry value>"
        },
        "target": {
          "definition": "Upper price region where movement has slowed.",
          "example": "₹<target value>"
        },
        "stopLoss": {
          "definition": "Lower price region where weakness has appeared.",
          "example": "₹<stopLoss value>"
        }
      }
    }
  ],
  "performance_hints": {
    "confidence_drivers": ["driver 1", "driver 2"],
    "uncertainty_factors": ["factor 1", "factor 2"],
    "data_quality_score": <number between 0 and 1>
  },
  "disclaimer": "AI-generated educational interpretation of price behaviour. Not investment advice or a recommendation to buy or sell any security."
}

=== CRITICAL REQUIRED FIELDS ===
These fields MUST be present and non-null:
- overall_sentiment (root level)
- confidence_breakdown (root level)
- strategies[0].type
- strategies[0].title
- strategies[0].confidence (MUST equal confidence_breakdown.final)

=== OUTPUT ===
Return exactly ONE JSON object matching the schema above. No markdown, no extra text.
`;

  return { system, user };
}
