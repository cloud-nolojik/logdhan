/**
 * Stage 1: Preflight & Market Summary
 * - Validates MARKET DATA
 * - Computes market_summary (last, trend, volatility, volume)
 * - Reports data_health & what is missing
 * - NO strategy here.
 */
export function buildStage1Prompt({ stock_name, stock_symbol, current_price, marketPayload, sectorInfo }) {
  const system = `You are a professional swing trading analyst for Indian equities.
Always respond with VALID JSON. No prose. No markdown.`;

  const user = `
PRE-FLIGHT for ${stock_name} (${stock_symbol}) — swing context (3–7 sessions).
You MUST use ONLY fields that exist in MARKET DATA. If any required input is missing, set insufficientData=true.

MARKET DATA (authoritative):
${JSON.stringify(marketPayload, null, 2)}

CONTEXT:
- Current Price (explicit): ₹${current_price}
- Sector: ${sectorInfo?.name || 'Unknown'} (${sectorInfo?.code || 'OTHER'})
- Sector Index: ${sectorInfo?.index || 'NIFTY 50'}

OUTPUT (JSON only):
{
  "schema_version": "1.4-pre",
  "symbol": "${stock_symbol}",
  "insufficientData": false,
  "market_summary": {
    "last": <number>,                         // priceContext.last if present, else Current Price
    "trend": "BULLISH"|"BEARISH"|"NEUTRAL",   // rule: ema20_1D vs ema50_1D and last vs sma200_1D
    "volatility": "HIGH"|"MEDIUM"|"LOW",      // rule: atr14_1D / last thresholds: LOW <1%, MED 1–2%, HIGH >2%
    "volume": "ABOVE_AVERAGE"|"AVERAGE"|"BELOW_AVERAGE"|"UNKNOWN" // prefer volumeContext.classification
  },
  "data_health": {
    "have_last": true|false,
    "have_atr14_1D": true|false,
    "have_ma": { "ema20_1D": true|false, "ema50_1D": true|false, "sma200_1D": true|false },
    "missing": ["<field>", "..."]
  },
  "notes": ["<short finding>", "..."]
}
`;

  return { system, user };
}


/**
 * Stage 2: Strategy Skeleton & Triggers
 * - Builds ONE best-fit skeleton (BUY/SELL/NO_TRADE) with entry/stop/target ranges
 * - Defines entry triggers & pre-entry invalidations (evaluatable from MARKET DATA)
 * - RR must be >= 1.5 or return NO_TRADE
 */
export function buildStage2Prompt({ stock_name, stock_symbol, current_price, marketPayload, s1 }) {
  const system = `You are a disciplined swing strategist.
JSON ONLY. No markdown.`;

  const user = `
SKELETON for ${stock_name} (${stock_symbol}) — using STAGE-1 result and MARKET DATA.
Use ONLY fields present in MARKET DATA. Do NOT invent indicators.

MARKET DATA:
${JSON.stringify(marketPayload, null, 2)}

STAGE-1:
${JSON.stringify(s1, null, 2)}

RULES:
- EXACTLY ONE strategy. If RR < 1.5 after ONE adjustment within bounds → type="NO_TRADE".
- BUY: target = entry + k*atr14_1D (k in [0.8,1.6]); stop = entry - m*atr14_1D (m in [0.5,1.2]).
- SELL: symmetric.
- Use entryType "stop" or "stop-limit" unless actionability is clearly now; avoid raw "market" by default.
- Triggers must be evaluable from MARKET DATA.

OUTPUT:
{
  "schema_version": "1.4-s2",
  "symbol": "${stock_symbol}",
  "insufficientData": false,
  "skeleton": {
    "type": "BUY"|"SELL"|"NO_TRADE",
    "archetype": "breakout"|"pullback"|"trend-follow"|"mean-reversion"|"range-fade",
    "alignment": "with_trend"|"counter_trend"|"neutral",
    "entryType": "limit"|"market"|"range"|"stop"|"stop-limit",
    "entry": <number>,
    "entryRange": [<number>,<number>] | null,
    "target": <number>,
    "stopLoss": <number>,
    "riskReward": <number>,
    "triggers": [
      {
        "id": "T1",
        "scope": "entry",
        "timeframe": "15m|1h|1d",
        "left": {"ref": "close|high|low|price|ema20_1D|rsi14_1h"},
        "op": "<"|"<="|">"|">="|"crosses_above"|"crosses_below",
        "right": {"ref": "value|ema50_1D|sma200_1D|entry", "value": <number>, "offset": <number>},
        "occurrences": {"count": 1, "consecutive": true},
        "within_sessions": 5,
        "expiry_bars": 20
      }
    ],
    "invalidations_pre_entry": [
      {
        "timeframe": "1h"|"15m"|"1d",
        "left": {"ref": "close|low|price"},
        "op": "<"|"<="|">"|">=",
        "right": {"ref": "entry|value", "value": <number>},
        "occurrences": {"count": 1, "consecutive": false},
        "action": "cancel_entry"
      }
    ]
  }
}
`;

  return { system, user };
}


/**
 * Stage 3: Final Assembly (v1.4)
 * - Combines MARKET DATA + S1 + S2 + sentimentContext (already in payload)
 * - Produces FULL schema v1.4 exactly as your app expects
 */
export function buildStage3Prompt({ stock_name, stock_symbol, current_price, marketPayload, sectorInfo, s1, s2 }) {
  const system = `You are the best swing trading expert in Indian markets.
Return VALID JSON ONLY following schema v1.4 exactly.`;

  const user = `You MUST return EXACTLY the schema v1.4 (single strategy) using ONLY data present.

ANALYZE: ${stock_name} (${stock_symbol}) — Swing (3–7 sessions)
Current Price (explicit): ₹${current_price}

MARKET DATA:
${JSON.stringify(marketPayload, null, 2)}

STAGE-1:
${JSON.stringify(s1, null, 2)}

STAGE-2:
${JSON.stringify(s2, null, 2)}

### CRITICAL: TRIGGER & INVALIDATION COPYING RULES
1. You MUST copy "triggers" array from STAGE-2 skeleton.triggers into the final strategies[0].triggers array EXACTLY as provided.
   The monitoring system depends on strategies[0].triggers to check conditions in real-time.
   If STAGE-2 has triggers, they MUST appear in the final output. DO NOT leave triggers empty.

2. You MUST copy "invalidations_pre_entry" from STAGE-2 skeleton.invalidations_pre_entry into strategies[0].invalidations array.
   Change the scope field to "pre_entry" and keep all other fields intact.
   Then add post_entry invalidation for stopLoss breach.

### RETAIL BEGINNER TRANSLATION RULE FOR UI
For the "ui_friendly" block inside strategies:
- "why_smart_move" MUST be simplified beginner friendly, based on THIS stock specific reasoning.
- "ai_will_watch" MUST convert actual triggers + invalidation logic into simple plain english rules. Example translation:
  "price crosses above entry" → "Price must move UP above our planned entry level before we even consider taking the trade."
  "price crosses below entry" → "If price drops below the planned entry level first, we skip the trade completely."
- "beginner_explanation" MUST be a short paragraph (2–3 lines), explaining logic in emotion-free beginner language focusing on capital protection + confirmation requirement.

STRICT JSON RETURN (schema v1.4):
{
  "schema_version": "1.4",
  "symbol": "${stock_symbol}",
  "analysis_type": "swing",
  "generated_at_ist": "<ISO-8601 +05:30>",
  "insufficientData": <bool>,
  "market_summary": {
    "last": <number>,
    "trend": "BULLISH"|"BEARISH"|"NEUTRAL",
    "volatility": "HIGH"|"MEDIUM"|"LOW",
    "volume": "ABOVE_AVERAGE"|"AVERAGE"|"BELOW_AVERAGE"|"UNKNOWN"
  },
  "overall_sentiment": "BULLISH"|"BEARISH"|"NEUTRAL",
  "sentiment_analysis": {
    "confidence": <0..100>,
    "strength": "high"|"medium"|"low",
    "reasoning": "<string>",
    "key_factors": ["<factor1>", "<factor2>"],
    "sector_specific": true|false,
    "market_alignment": "aligned"|"contrary"|"neutral",
    "trading_bias": "bullish"|"bearish"|"neutral",
    "risk_level": "low"|"medium"|"high",
    "position_sizing": "increased"|"standard"|"reduced",
    "entry_strategy": "aggressive"|"moderate"|"cautious",
    "news_count": <number>,
    "recent_news_count": <number>,
    "sector_news_weight": <number 0..1>
  },
  "runtime": {
    "triggers_evaluated": [
      {
        "id": "T1",
        "timeframe": "15m|1h|1d",
        "left_ref": "close|high|low|price|rsi14_1h|ema20_1D|sma200_1D",
        "left_value": <number|null>,
        "op": "<|<=|>|>=|crosses_above|crosses_below",
        "right_ref": "value|entry|ema50_1D|sma200_1D",
        "right_value": <number|null>,
        "passed": true|false,
        "evaluable": true|false
      }
    ],
    "pre_entry_invalidations_hit": false
  },
  "order_gate": {
    "all_triggers_true": true|false,
    "no_pre_entry_invalidations": true|false,
    "actionability_status": "actionable_now"|"actionable_on_trigger"|"monitor_only",
    "entry_type_sane": true|false,
    "can_place_order": true|false
  },
  "strategies": [
    {
      "id": "S1",
      "type": "BUY"|"SELL"|"NO_TRADE",
      "archetype": "breakout"|"pullback"|"trend-follow"|"mean-reversion"|"range-fade",
      "alignment": "with_trend"|"counter_trend"|"neutral",
      "title": "<string>",
      "confidence": <0..1>,
      "why_best": "<short sentence>",
      "entryType": "limit"|"market"|"range"|"stop"|"stop-limit",
      "entry": <number>,
      "entryRange": [<number>,<number>] | null,
      "target": <number>,
      "stopLoss": <number>,
      "riskReward": <number>,
      "timeframe": "3-7 days",
      "indicators": [
        {"name": "ema20_1D|ema50_1D|sma200_1D|rsi14_1h|atr14_1D", "value": "<from MARKET DATA>", "signal": "BUY|SELL|NEUTRAL"}
      ],
      "reasoning": [
        {"because":"ema20_1D({{num}}) vs sma200_1D({{num}}) → {{bias}}"},
        {"because":"rsi14_1h={{num}} → {{signal}}"},
        {"because":"ATR-based target gives RR={{num}} ≥ 1.5"}
      ],
      "warnings": [
        {
          "code": "GAP_RISK",
          "severity": "low"|"medium"|"high",
          "text": "<short caution>",
          "applies_when": [
            {
              "timeframe": "1d"|"1h"|"15m",
              "left": {"ref": "rsi14_1h|ema20_1D|price"},
              "op": "<"|"<="|">"|">="|"crosses_above"|"crosses_below",
              "right": {"ref": "value|ema50_1D|entry|stopLoss", "value": 70, "offset": 0.00}
            }
          ],
          "mitigation": ["reduce_qty","wider_stop","skip_on_news"]
        }
      ],
      "triggers": <COPY FROM STAGE-2 skeleton.triggers EXACTLY>,
      "confirmation": {
        "require": "ALL",
        "window_bars": 8,
        "conditions": []
      },
      "invalidations": [
        <COPY FROM STAGE-2 skeleton.invalidations_pre_entry with scope="pre_entry">,
        {
          "scope": "post_entry",
          "timeframe": "1h",
          "left": {"ref": "close"},
          "op": "<=",
          "right": {"ref": "stopLoss"},
          "occurrences": {"count": 1, "consecutive": false},
          "action": "close_position"
        }
      ],
      "validity": {
        "entry": { "type": "GTD", "bars_limit": 0, "trading_sessions_soft": 5, "trading_sessions_hard": 8, "expire_calendar_cap_days": 10 },
        "position": { "time_stop_sessions": 7, "gap_policy": "exit_at_open_with_slippage" },
        "non_trading_policy": "pause_clock"
      },
      "beginner_summary": {
        "one_liner": "Buy/Sell ~₹ENTRY → Take profit ₹TARGET → Exit ₹STOP (3–7 sessions)",
        "steps": ["Wait for trigger to fire", "Set target", "Place stop and follow plan"],
        "checklist": ["Trigger true", "No invalidation", "Order type matches entry plan"]
      },
      "why_in_plain_words": [
        {"point": "Trend & price context support direction", "evidence": "ema20_1D, ema50_1D, sma200_1D, last"},
        {"point": "RR ≥ 1.5 after ATR bands", "evidence": "atr14_1D"}
      ],
      "what_could_go_wrong": [
        {"risk": "Gap against position", "likelihood": "MEDIUM", "impact": "HIGH", "mitigation": "smaller size / avoid near events"}
      ],
      "ui_friendly": {
  "why_smart_move": "<1 sentence beginner friendly reason why this setup is smart based on THIS trade>",
  "ai_will_watch": [
    "<convert actual trigger conditions to beginner plain english>",
    "<convert invalidation / skip condition to beginner plain english>"
  ],
  "beginner_explanation": "2–3 line simple english summary explaining waiting for confirmation, capital protection, avoiding emotional impulsive entries and aiming for >=1.5 RR based on this specific trade."
},
      "money_example": {
        "per_share": { "risk": <number>, "reward": <number>, "rr": <number> },
        "position": { "qty": <number>, "max_loss": <number>, "potential_profit": <number>, "distance_to_stop_pct": <number>, "distance_to_target_pct": <number> }
      },
      "suggested_qty": { "risk_budget_inr": 1000, "risk_per_share": <number>, "qty": <number>, "alternatives": [{"risk_budget_inr":500,"qty":<number>},{"risk_budget_inr":1000,"qty":<number>},{"risk_budget_inr":2500,"qty":<number>}], "note": "Sizing purely from stop distance." },
      "risk_meter": { "label": "Low"|"Medium"|"High", "score": <0..1>, "drivers": ["RR band","Trend alignment","Volatility vs ATR","Volume band","News/sentiment tilt"] },
      "actionability": { "label": "Buy idea"|"Sell idea"|"No trade", "status": "actionable_now"|"actionable_on_trigger"|"monitor_only", "next_check_in": "15m"|"1h"|"daily", "checklist": ["All triggers satisfied","No invalidation hit","Order type matches entry plan"] },
      "glossary": {
        "entry": {"definition":"Price to open the trade.","example":"₹<ENTRY>"},
        "target":{"definition":"Price to take profits.","example":"₹<TARGET>"},
        "stopLoss":{"definition":"Price to exit to limit loss.","example":"₹<STOP>"}
      }
    }
  ],
  "disclaimer": "AI-generated educational analysis. Not investment advice."
}
`;

  return { system, user };
}
