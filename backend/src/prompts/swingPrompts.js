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
export function buildStage3Prompt({
  stock_name,
  stock_symbol,
  current_price,
  marketPayload,
  sectorInfo,
  s1,
  s2,
  game_mode = "cricket"
}) {
  const system = `You are the best swing trading expert in Indian markets.
You ALWAYS return STRICT, VALID JSON ONLY following schema v1.4 exactly.
Do NOT add or remove any top-level or nested fields from the schema.
Do NOT include comments, explanations, or any extra text outside the JSON.
Wherever the schema example uses placeholder-style text (like <...> or {{...}}), you MUST replace it with concrete values.
NEVER output the characters "<", ">", "{{", or "}}" anywhere in the final JSON.`;

  const user = `You MUST return EXACTLY schema v1.4 (single strategy) using ONLY data present in this prompt.

ANALYZE: ${stock_name} (${stock_symbol}) — Swing (3–7 sessions)
Current Price (explicit): ₹${current_price}

MARKET DATA:
${JSON.stringify(marketPayload, null, 2)}

SECTOR INFO:
${JSON.stringify(sectorInfo || {}, null, 2)}

STAGE-1:
${JSON.stringify(s1, null, 2)}

STAGE-2:
${JSON.stringify(s2, null, 2)}

---

### CRITICAL: DATA HONESTY & INSUFFICIENT DATA

1. You are NOT allowed to fabricate or hallucinate:
   - Do NOT invent prices, indicators, volumes, support/resistance levels, or news.
   - Use ONLY values provided in MARKET DATA, SECTOR INFO, STAGE-1, and STAGE-2.

2. If you cannot confidently populate required numeric fields from given data:
   - Set "insufficientData": true.
   - Still return FULL schema with safe, neutral values:
     - For numbers: use 0 or null (whichever is less misleading).
     - For booleans: use false.
     - For enums: use neutral options like "NEUTRAL", "AVERAGE", "standard", "moderate".
   - Do NOT remove any fields.
   - Do NOT leave placeholder text.

3. If sufficient data IS available:
   - Set "insufficientData": false.
   - Fill all fields consistently and logically from the data.

---

### CRITICAL: TRIGGER & INVALIDATION COPYING RULES

1. strategies[0].triggers:
   - If STAGE-2.skeleton.triggers exists and is an array:
     - Copy it EXACTLY into strategies[0].triggers.
     - Do NOT modify keys, values, structure, or order.
     - Do NOT drop any triggers.
   - If there are NO triggers:
     - Use an empty array [].

2. strategies[0].invalidations:
   - Start from STAGE-2.skeleton.invalidations_pre_entry (if present).
   - For EACH item:
     - Copy all fields exactly.
     - Add or override "scope": "pre_entry".
   - THEN append EXACTLY ONE additional invalidation object:

     {
       "scope": "post_entry",
       "timeframe": "1h",
       "left": { "ref": "close" },
       "op": "<=",
       "right": { "ref": "stopLoss" },
       "occurrences": { "count": 1, "consecutive": false },
       "action": "close_position"
     }

   - Do NOT add any other post-entry rule unless it is a direct copy from provided data.

3. RUNTIME & ORDER GATE CONSISTENCY:
   - runtime.triggers_evaluated must reflect and be consistent with strategies[0].triggers.
   - order_gate must reflect:
     - whether all triggers are true,
     - whether any pre-entry invalidations are hit.
   - If evaluation is not possible:
     - Set "evaluable": false where needed.
     - Choose conservative, neutral flags.
   - Keep JSON valid at all times.

---

### LANGUAGE STYLE (GLOBAL)

All human-readable text fields MUST be clear and beginner-friendly:
- Applies to: why_best, reasoning[].because, warnings.text, what_could_go_wrong, beginner_summary,
  ui_friendly.*, glossary, actionability.checklist, risk_meter.drivers, etc.
- Use short, simple sentences.
- You MAY use basic trading terms (trend, support, resistance, RSI, moving average, risk-reward), BUT:
  - Immediately make their meaning obvious from context.
  - Example: "RSI is a simple strength meter" or "moving averages show the overall direction".
- NO heavy jargon: avoid terms like "orderblock", "liquidity sweep", "ICT", etc.
- NO hype / FOMO / guarantees:
  - Do NOT say "sure shot", "guaranteed", "can't lose", "safe bet", "100%".
  - Use "aims for", "can help", "if this fails we exit", etc.

Even the most detailed / advanced parts must be readable by a careful beginner, while still accurate for advanced users.

---

### RETAIL BEGINNER TRANSLATION WITH SPORTS ANALOGY

User learning preference (game_mode): "${game_mode || "none"}"

Valid sports:
"cricket","football","kabaddi","badminton","chess","racing",
"battle_royale","basketball","tennis","boxing","carrom","hockey","volleyball"

If game_mode is one of these:
- strategies[0].ui_friendly MUST:
  1. Use ONLY that sport across:
     - ui_friendly.why_smart_move
     - ui_friendly.ai_will_watch
     - ui_friendly.beginner_explanation
  2. Map:
     - Entry trigger → smart moment to attack.
     - Stop-loss → defensive line / guard / exit.
     - Risk-reward → high-percentage play.
     - Confirmation → patience / build-up.
     - Invalidation → walk away / reset.
  3. Sound natural, like a coach in that sport.
  4. Use REAL levels and rules from the strategy (no fake numbers).
  5. Stay realistic and educational.

If game_mode is "none", empty, null, or not recognized:
- Use plain, professional, beginner-friendly English (no sports).

---

### STRATEGY ARCHETYPE CONTEXT

Use strategies[0].archetype to keep explanation consistent with structure:
- "breakout": attacking a clear break above resistance / below support.
- "pullback": waiting for better price after a move.
- "trend-follow": going with existing direction.
- "mean-reversion": fading stretched moves with caution.
- "range-fade": trading edges of a sideways range.

Archetype must align with MARKET DATA, STAGE-2 skeleton, and chosen entry/target/stopLoss.

---

### ui_friendly (FOR LAYERED UI)

Use ui_friendly to drive the 3 UI layers:

1. why_smart_move (Snap view)
   - EXACTLY 1 sentence (~15–25 words).
   - Explain why the setup is a sensible, calculated idea using actual entry/target/stopLoss and trend.
   - Use chosen sport language if game_mode is valid; else plain English.
   - No hype.

2. ai_will_watch (Coach view)
   - 2–4 short sentences in an array.
   - Each sentence = ONE clear rule in simple language:
     - Entry trigger condition(s).
     - Pre-entry invalidation(s).
     - Post-entry invalidation (stopLoss exit).
   - MUST:
     - Use real numeric levels from triggers/invalidations/stopLoss.
     - Follow this logical order: trigger → pre-entry cancel → post-entry exit.
     - Use the same sport language if applicable.

3. beginner_explanation (Coach view)
   - 2–3 lines (about 50–80 words).
   - Explain in simple words:
     - We wait for confirmation before entering.
     - We use stop-loss to protect capital.
     - We aim for potential profit larger than the risk.
   - If sport mode is on:
     - End with ONE natural sentence tying it to that sport.
   - No FOMO, no promises.

---

### REASONING FIELD (EXPLICIT EDUCATIONAL STYLE)

For strategies[0].reasoning:
- Provide 3–5 short sentences.
- Each "because" MUST:
  - Use actual data (trend, moving averages, RSI, RR, etc.).
  - Immediately explain what that data means in simple words.
  - Optionally include a light sport reference consistent with game_mode.

Example style (you MUST adapt values to the real data):
- "because": "Price above key moving averages shows the overall trend supports this direction."
- "because": "RSI14_1h at a healthy level is a simple strength sign that buyers are active but not exhausted."
- "because": "Target is meaningfully farther than stopLoss, so potential reward is about 1.5x or more of the risk."

Do NOT leave template-sounding text. Always make it concrete and clear.

---

### STRICT JSON RETURN (schema v1.4)

Now construct and return ONLY this JSON structure:

{
  "schema_version": "1.4",
  "symbol": "${stock_symbol}",
  "analysis_type": "swing",
  "generated_at_ist": "<ISO-8601 timestamp in +05:30>",
  "insufficientData": <bool>,
  "market_summary": {
    "last": <number>,
    "trend": "BULLISH"|"BEARISH"|"NEUTRAL",
    "volatility": "HIGH"|"MEDIUM"|"LOW",
    "volume": "ABOVE_AVERAGE"|"AVERAGE"|"BELOW_AVERAGE"|"UNKNOWN"
  },
  "overall_sentiment": "BULLISH"|"BEARISH"|"NEUTRAL",
  "sentiment_analysis": {
    "confidence": <number 0-100>,
    "strength": "high"|"medium"|"low",
    "reasoning": "Short, clear explanation using real values in simple language.",
    "key_factors": ["short simple factor 1","short simple factor 2"],
    "sector_specific": true|false,
    "market_alignment": "aligned"|"contrary"|"neutral",
    "trading_bias": "bullish"|"bearish"|"neutral",
    "risk_level": "low"|"medium"|"high",
    "position_sizing": "increased"|"standard"|"reduced",
    "entry_strategy": "aggressive"|"moderate"|"cautious",
    "news_count": <number>,
    "recent_news_count": <number>,
    "sector_news_weight": <number between 0 and 1>
  },
  "runtime": {
    "triggers_evaluated": [
      {
        "id": "T1",
        "timeframe": "15m"|"1h"|"1d",
        "left_ref": "close"|"high"|"low"|"price"|"rsi14_1h"|"ema20_1D"|"sma200_1D",
        "left_value": <number|null>,
        "op": "<"|"<="|">"|">="|"crosses_above"|"crosses_below",
        "right_ref": "value"|"entry"|"ema50_1D"|"sma200_1D",
        "right_value": <number|null>,
        "passed": true|false,
        "evaluable": true|false
      }
    ],
    "pre_entry_invalidations_hit": true|false
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
      "title": "Concise, clear title describing the setup.",
      "confidence": <number between 0 and 1>,
      "why_best": "Short, simple sentence explaining why this is the chosen idea.",
      "entryType": "limit"|"market"|"range"|"stop"|"stop-limit",
      "entry": <number>,
      "entryRange": [<number>,<number>] | null,
      "target": <number>,
      "stopLoss": <number>,
      "riskReward": <number>,
      "timeframe": "3-7 days",
      "indicators": [
        {
          "name": "ema20_1D"|"ema50_1D"|"sma200_1D"|"rsi14_1h"|"atr14_1D",
          "value": "value taken directly from MARKET DATA or null if missing",
          "signal": "BUY"|"SELL"|"NEUTRAL"
        }
      ],
      "reasoning": [
        {
          "because": "Concrete, simple explanation using real trend/average data."
        },
        {
          "because": "Concrete, simple explanation using real RSI/volume or similar, with meaning made clear."
        },
        {
          "because": "Concrete, simple explanation that risk-reward is acceptable (for example, target distance >= 1.5x stop distance)."
        }
      ],
      "warnings": [
        {
          "code": "GAP_RISK",
          "severity": "low"|"medium"|"high",
          "text": "Short caution about a realistic risk in simple language.",
          "applies_when": [
            {
              "timeframe": "1d"|"1h"|"15m",
              "left": { "ref": "rsi14_1h"|"ema20_1D"|"price" },
              "op": "<"|"<="|">"|">="|"crosses_above"|"crosses_below",
              "right": { "ref": "value"|"ema50_1D"|"entry"|"stopLoss", "value": <number>, "offset": <number> }
            }
          ],
          "mitigation": ["reduce_qty","wider_stop","skip_on_news"]
        }
      ],
      "triggers": [],
      "confirmation": {
        "require": "ALL",
        "window_bars": 8,
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
        "one_liner": "Clear one-line summary: buy/sell near entry, aim for target, cut loss at stop within 3–7 sessions.",
        "steps": [
          "Wait for all trigger conditions to be met.",
          "Place target and stopLoss as given.",
          "Use a position size that fits your risk comfort."
        ],
        "checklist": [
          "All triggers satisfied",
          "No invalidation hit",
          "Order type matches entry plan"
        ]
      },
      "why_in_plain_words": [
        {
          "point": "Short point explaining why the market structure supports this idea.",
          "evidence": "Which indicators or levels support it, named clearly."
        },
        {
          "point": "Short point explaining that potential reward is larger than risk.",
          "evidence": "Based on actual entry, target, stopLoss, and volatility."
        }
      ],
      "what_could_go_wrong": [
        {
          "risk": "Short description of a realistic risk event.",
          "likelihood": "LOW"|"MEDIUM"|"HIGH",
          "impact": "LOW"|"MEDIUM"|"HIGH",
          "mitigation": "Short description of how a careful trader could handle or reduce this risk."
        }
      ],
      "ui_friendly": {
        "why_smart_move": "One concise sentence using chosen sport or plain English that explains why this plan is logical with real levels.",
        "ai_will_watch": [
          "Entry trigger mapped to real levels, explained simply and optionally in sport terms.",
          "Pre-entry invalidation mapped to real levels, explained as a clear 'walk away' condition.",
          "Post-entry invalidation based on stopLoss, explained as a clear 'cut loss and protect capital' rule."
        ],
        "beginner_explanation": "2–3 clear lines: wait for confirmation, protect with stopLoss, aim for better reward than risk, ending with one natural sport or plain-English summary line."
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
        "note": "Sizing based only on entry to stopLoss distance."
      },
      "risk_meter": {
        "label": "Low"|"Medium"|"High",
        "score": <number between 0 and 1>,
        "drivers": [
          "RR band",
          "Trend alignment",
          "Volatility vs ATR",
          "Volume band",
          "News/sentiment tilt"
        ]
      },
      "actionability": {
        "label": "Buy idea"|"Sell idea"|"No trade",
        "status": "actionable_now"|"actionable_on_trigger"|"monitor_only",
        "next_check_in": "15m"|"1h"|"daily",
        "checklist": [
          "All triggers satisfied",
          "No invalidation hit",
          "Order type matches entry plan"
        ]
      },
      "glossary": {
        "entry": {
          "definition": "Price where the trade is planned to start.",
          "example": "₹(actual entry price)"
        },
        "target": {
          "definition": "Price where profits are planned to be booked.",
          "example": "₹(actual target price)"
        },
        "stopLoss": {
          "definition": "Price where the trade will be closed to limit loss.",
          "example": "₹(actual stopLoss price)"
        }
      }
    }
  ],
  "disclaimer": "AI-generated educational analysis. Not investment advice."
}

REMINDERS:
- Output MUST be strictly valid JSON.
- Do NOT include backticks.
- Do NOT include any explanations or commentary outside the JSON.
- Do NOT leave any placeholder-style text; always use concrete values or safe neutral defaults.
- NEVER output the characters "<", ">", "{{", or "}}" in the JSON.`;

  return { system, user };
}