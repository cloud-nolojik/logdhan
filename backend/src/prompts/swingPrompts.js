import StockAnalysis from "../models/stockAnalysis.js";

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
export async function buildStage3Prompt({
  stock_name,
  stock_symbol,
  current_price,
  marketPayload,
  sectorInfo,
  s1,
  s2,
  instrument_key,
  game_mode = "cricket"
}) {

  // Extract existing Stage 3 analysis if present
  let existingStage3 = null;
  let existingMetadata = null;
  if (instrument_key) {
    const existingAnalysis = await StockAnalysis.findByInstrument(instrument_key, 'swing');
    existingStage3 = existingAnalysis?.analysis_data?.strategies?.[0] || null;
    existingMetadata = {
      generated_at: existingAnalysis?.analysis_data?.generated_at_ist || null,
      previous_price: existingAnalysis?.analysis_data?.market_summary?.last || null,
      valid_until: existingAnalysis?.valid_until || null
    };
  }

  const system = `You are the best swing trading expert in Indian markets.
You ALWAYS return STRICT, VALID JSON ONLY following schema v1.4 exactly.
Do NOT add or remove any top-level or nested fields from the schema.
Do NOT include comments, explanations, or any extra text outside the JSON.
Wherever the schema example uses placeholder-style text (like <...> or {{...}}), you MUST replace it with concrete values.
NEVER output the characters "<", ">", "{{", or "}}" anywhere in the final JSON.`;

  const user = `
=== 🎯 TL;DR FOR MODEL ===
Task: Analyze ${stock_symbol} swing trade - KEEP, ADJUST, or RETIRE existing strategy
Current Price: ₹${current_price}
Output: Valid JSON only, schema v1.4, single strategy
Data Source: Use ONLY provided MARKET DATA, STAGE-1, STAGE-2
Hallucination: FORBIDDEN - use insufficientData flag if needed
Sport Mode: ${game_mode}

=== CORE MISSION ===
Revalidate existing swing strategy OR make minimal adjustments OR retire it.
Return schema v1.4 JSON only. Use real data only. Be beginner-friendly.
Output MUST be strictly valid JSON with no backticks, no explanations outside JSON.

=== ANALYSIS CONTEXT ===

You MUST return EXACTLY schema v1.4 (single strategy) using ONLY data present in this prompt.

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

EXISTING_STAGE3 (optional):
${existingStage3 ? JSON.stringify(existingStage3, null, 2) : "None"}

EXISTING_STRATEGY_METADATA:
${existingMetadata ? JSON.stringify(existingMetadata, null, 2) : "None"}

---

=== EXISTING ANALYSIS REVISION POLICY ===

Goal: Revalidate the existing strategy OR make minimal adjustments OR retire it if invalid.

Choose exactly ONE of the following outcomes:

1) **KEEP (Revalidate)**  
   - Conditions: The existing strategy structure still holds (entry/stop/target consistent, RR acceptable, no obvious invalidation).  
   - Action: KEEP entry, stopLoss, target, type, alignment, archetype EXACTLY.  
   - Recompute runtime, order_gate, money_example, suggested_qty from Current Price.  
   - Prefix title with: "[Revalidated] " (include the space after the bracket).

2) **ADJUST (Minimal change)**  
   - Conditions: Minor update required (e.g., RR broken, entry > stopLoss for BUY, invalid levels).  
   - Action: Modify ONLY the minimum needed among: entry, target, stopLoss.  
   - Preserve original structure (type, archetype, alignment) unless impossible.  
   - If the fundamental direction is wrong (e.g., existing BUY but data strongly suggests SELL), use RETIRE instead.
   - Prefix title with: "[Adjusted] " (include the space after the bracket).
   - MUST enforce correct geometric structure:
   - For BUY: stopLoss < entry < target
   - For SELL: target < entry < stopLoss
   - If this cannot be satisfied with provided data → choose RETIRE.
   - Do NOT reuse old entry/target/stopLoss if any of them violate geometric structure, RR rules, or trend alignment — recompute safely.

3) **RETIRE (No Trade Now)**  
   - Conditions: Stop-loss hit, target hit, plan clearly invalid, major conflict with Stage-2, expired, or fundamental direction is wrong.  
   - Action:  
     - type = "NO_TRADE".  
     - entry = target = stopLoss = null.  
     - riskReward = 0.  
     - suggested_qty.qty = 0.  
     - actionability.status = "monitor_only".  
     - Prefix title with: "[Retired] " (include the space after the bracket).  
     - Add a simple reason inside why_best.

---

=== ABSOLUTE RULES ===

- NEVER flip BUY ↔ SELL automatically. If direction is fundamentally wrong, RETIRE instead.
- NEVER generate additional strategies (always return exactly one strategy).  
- NEVER alter schema structure or field names.  
- NEVER hallucinate missing prices, indicators, news, or levels.  
- NEVER modify validity.entry.* values (they are fixed for the strategy type).  
- ALWAYS use real numbers from provided MARKET DATA, STAGE-1, and STAGE-2 only.  
- ALWAYS round all numeric values (entry, target, stopLoss, indicators, RR, percentages, trigger values) to 2 decimal places unless the input data itself uses a different precision.
- NEVER output long floating-point numbers such as 431.492838482 or scientific notation.
- ALWAYS compute riskReward explicitly:
  - For BUY: (target - entry) / (entry - stopLoss)
  - For SELL: (entry - target) / (stopLoss - entry)
- Round riskReward to 2 decimal places.
- ALWAYS ensure money_example calculations match:
  - per_share.risk = |entry - stopLoss|
  - per_share.reward = |target - entry|
  - position.max_loss = qty * per_share.risk
---

=== 🔴 CRITICAL: DATA HONESTY & INSUFFICIENT DATA ===

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
   - Do NOT leave placeholder text like <...> or {{...}}.

3. If sufficient data IS available:
   - Set "insufficientData": false.
   - Fill all fields consistently and logically from the data.

---

=== 🔴 CRITICAL: TRIGGER & INVALIDATION COPYING RULES ===

1. strategies[0].triggers:
   - If STAGE-2.skeleton.triggers exists and is an array:
     - Copy it EXACTLY into strategies[0].triggers.
     - Do NOT modify keys, values, structure, or order.
     - Do NOT drop any triggers.
   - If there are NO triggers in STAGE-2:
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
   - Ensure internal logic consistency across runtime and order_gate:
   - If all_triggers_true = true AND no_pre_entry_invalidations = true → can_place_order MUST be true.
   - If type = "NO_TRADE":
         - entry MUST be null,
         - target MUST be null,
         - stopLoss MUST be null,
         - riskReward MUST be 0.
    - order_gate.entry_type_sane MUST be true unless entryType is structurally impossible for the level structure.

---

=== 🟡 IMPORTANT: TRIGGER EVALUATION EDGE CASES ===
- If indicator value is null → evaluable=false, passed=false
- If crossing operators used but no history → evaluable=false
- If timeframe data missing → use next available timeframe

=== 🟡 IMPORTANT: ERROR HANDLING ===
If JSON generation fails:
1. Return minimal valid structure with type="NO_TRADE"
2. Set insufficientData=true
3. Include error details in why_best field

=== 🟢 OPTIONAL: SPORTS ANALOGY GUIDELINES ===
- Max 30% of text should be sport-related
- Never compromise accuracy for analogy fit
- If no natural mapping exists, use plain language

---

=== 🟡 IMPORTANT: LANGUAGE MANIFESTO (APPLIES TO ALL TEXT FIELDS) ===

All human-readable text fields MUST be clear and beginner-friendly.

Applies to: why_best, reasoning[].because, warnings.text, what_could_go_wrong, beginner_summary,
ui_friendly.*, glossary, actionability.checklist, risk_meter.drivers, etc.

**Rules:**
- Use short, simple sentences (10-20 words each).
- You MAY use basic trading terms (trend, support, resistance, RSI, moving average, risk-reward), BUT:
  - Immediately make their meaning obvious from context.
  - Example: "RSI is a simple strength meter" or "moving averages show the overall direction".
- NO heavy jargon: avoid terms like "orderblock", "liquidity sweep", "ICT", "smart money", "wyckoff".
- NO hype / FOMO / guarantees:
  - Do NOT say "sure shot", "guaranteed", "can't lose", "safe bet", "100% profit", "easy money".
  - Use "aims for", "can help", "if this fails we exit", "potential target", "manages risk".
- Always use concrete values from the actual strategy (real entry, target, stopLoss prices).
- Even the most detailed parts must be readable by a careful beginner while remaining accurate for advanced users.

**Good vs Bad Examples:**

❌ Bad: "Liquidity sweep confirms orderblock at discount zone"
✅ Good: "Price bounced off support level showing buyers are active"

❌ Bad: "This is a guaranteed winner with massive upside!"
✅ Good: "This aims for ₹450 target while protecting at ₹400 stop-loss"

❌ Bad: "Smart money accumulation phase indicates institutional buying"
✅ Good: "Volume increase suggests growing interest at this price level"

---

=== RETAIL BEGINNER TRANSLATION WITH SPORTS ANALOGY ===

User learning preference (game_mode): "${game_mode || "none"}"

Valid sports:
"cricket", "football", "kabaddi", "badminton", "chess", "racing",
"battle_royale", "basketball", "tennis", "boxing", "carrom", "hockey", "volleyball"

If game_mode is one of these valid sports:
- strategies[0].ui_friendly MUST:
  1. Use ONLY that sport across:
     - ui_friendly.why_smart_move
     - ui_friendly.ai_will_watch
     - ui_friendly.beginner_explanation
  2. Map trading concepts naturally:
     - Entry trigger → smart moment to attack / make a move
     - Stop-loss → defensive line / guard / safe exit
     - Risk-reward → high-percentage play / strategic advantage
     - Confirmation → patience / build-up / waiting for the right moment
     - Invalidation → walk away / reset / retreat
  3. Sound natural, like a coach in that sport explaining strategy.
  4. Use REAL levels and rules from the strategy (no fake numbers).
  5. Stay realistic and educational (no hype).

If game_mode is "none", empty, null, or not in the valid list:
- Use plain, professional, beginner-friendly English (no sports analogies).

---

=== STRATEGY ARCHETYPE CONTEXT ===

Use strategies[0].archetype to keep explanation consistent with structure:
- "breakout": attacking a clear break above resistance / below support.
- "pullback": waiting for better price after a move.
- "trend-follow": going with existing direction.
- "mean-reversion": fading stretched moves with caution.
- "range-fade": trading edges of a sideways range.

Archetype must align with MARKET DATA, STAGE-2 skeleton, and chosen entry/target/stopLoss.

---

=== ui_friendly STRUCTURE (FOR LAYERED UI) ===

Use ui_friendly to drive the 3 UI layers:

1. **why_smart_move** (Snap view - Layer 1)
   - EXACTLY 1 sentence (15–25 words).
   - Explain why the setup is a sensible, calculated idea using actual entry/target/stopLoss and trend.
   - Use chosen sport language if game_mode is valid; else plain English.
   - No hype, no guarantees.
   - Example: "Price breaking above ₹420 resistance with strong volume aims for ₹450 while protecting at ₹400."

2. **ai_will_watch** (Coach view - Layer 2)
   - Array of 2–4 short sentences.
   - Each sentence = ONE clear rule in simple language:
     - Entry trigger condition(s).
     - Pre-entry invalidation(s).
     - Post-entry invalidation (stopLoss exit).
   - MUST:
     - Use real numeric levels from triggers/invalidations/stopLoss.
     - Follow this logical order: trigger → pre-entry cancel → post-entry exit.
     - Use the same sport language if applicable.
   - Example: 
     - "I'll alert when price crosses ₹420 with volume confirmation"
     - "If price drops below ₹405 before entry, the setup is cancelled"
     - "If price hits ₹400 after entry, I'll recommend exiting to protect capital"

3. **beginner_explanation** (Coach view - Layer 2)
   - 2–3 lines (50–80 words total).
   - Explain in simple words:
     - We wait for confirmation before entering.
     - We use stop-loss to protect capital.
     - We aim for potential profit larger than the risk.
   - If sport mode is on:
     - End with ONE natural sentence tying it to that sport.
   - No FOMO, no promises.

---

=== REASONING FIELD (EXPLICIT EDUCATIONAL STYLE) ===

For strategies[0].reasoning:
- Provide 3–5 short reasoning objects.
- Each "because" MUST:
  - Use actual data from MARKET DATA (trend, moving averages, RSI, volume, RR, etc.).
  - Immediately explain what that data means in simple words.
  - Be concrete (use real numbers, not templates).
  - Optionally include a light sport reference consistent with game_mode.

**Example format (adapt with REAL data):**

Example 1:
{ "because": "Price is above the 20-day moving average at ₹395, showing the overall trend supports upward movement." }

Example 2:
{ "because": "RSI at 58 is a healthy level showing buyers are active but not exhausted yet." }

Example 3:
{ "because": "Target at ₹450 is 2.5x farther than stop at ₹400, giving potential reward of 2.5x the risk." }

Do NOT leave template-sounding text like "indicator shows X" without concrete values.

---

=== EXAMPLE OUTPUT (SELL Scenario with Cricket Mode) ===
{
  "schema_version": "1.4",
  "symbol": "SBIN",
  "analysis_type": "swing",
  "generated_at_ist": "2024-11-07T14:30:00+05:30",
  "insufficientData": false,
  "market_summary": {
    "last": 433.6,
    "trend": "BEARISH",
    "volatility": "MEDIUM",
    "volume": "AVERAGE"
  },
  "strategies": [{
    "id": "S1",
    "type": "SELL",
    "archetype": "breakout",
    "alignment": "with_trend",
    "title": "[Revalidated] With-trend breakdown below 431 toward 416.51",
    "confidence": 0.62,
    "why_best": "Bearish trend, negative news tone, and clean breakdown plan with 1.75 risk-reward.",
    "entryType": "stop",
    "entry": 431,
    "target": 416.51,
    "stopLoss": 439.28,
    "riskReward": 1.75,
    "ui_friendly": {
      "why_smart_move": "Like timing a cut shot, we wait for a clean drop below 431 to aim for 416.51 with guard at 439.28.",
      "ai_will_watch": [
        "Enter only if 15-minute close crosses below 431, like playing the shot only when ball is wide enough.",
        "If any 1-hour close is 439.85 or higher before entry, we walk away and reset the field.",
        "After entry, if 1-hour close is at or below 439.28, we cut the trade and protect the wicket."
      ],
      "beginner_explanation": "We wait for the market to confirm weakness by closing below 431 before selling. Stop-loss at 439.28 protects capital if the move fails. Target at 416.51 offers more upside than risk taken, so math is sensible. In cricket terms, we play only the loose ball, keep safe guard, and look for boundary-sized reward."
    },
    "reasoning": [
      { "because": "Price 433.6 is below the 20, 50, and 200-day averages (437.22, 446.44, 452.48), showing bearish bigger picture." },
      { "because": "RSI 1h at 55.14 is only mildly strong, so waiting for break below 431 adds confirmation before selling." },
      { "because": "From entry 431 to stop 439.28 risk is 8.28, while reward to 416.51 is 14.49, giving solid 1.75 risk-reward." }
    ]
  }],
  "performance_hints": {
    "confidence_drivers": ["Price below all major averages", "Clean breakdown setup", "Good risk-reward ratio"],
    "uncertainty_factors": ["RSI not deeply oversold", "Proximity to support levels"],
    "data_quality_score": 0.85
  }
}

---

=== STRICT JSON RETURN (schema v1.4) ===

Now construct and return ONLY this JSON structure:

{
  "schema_version": "1.4",
  "symbol": "${stock_symbol}",
  "analysis_type": "swing",
  "generated_at_ist": "<ISO-8601 timestamp in +05:30 timezone>",
  "insufficientData": <boolean>,
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
      "title": "Concise, clear title describing the setup in plain language.",
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
          "because": "Concrete, simple explanation using real trend/average data with actual values."
        },
        {
          "because": "Concrete, simple explanation using real RSI/volume or similar, with meaning made clear."
        },
        {
          "because": "Concrete, simple explanation that risk-reward is acceptable with actual calculation."
        }
      ],
      "warnings": [
        {
          "code": "GAP_RISK"|"HIGH_VOLATILITY"|"LOW_VOLUME"|"NEWS_EVENT"|"SECTOR_WEAKNESS",
          "severity": "low"|"medium"|"high",
          "text": "Short caution about a realistic risk in simple language.",
          "applies_when": [
            {
              "timeframe": "1d"|"1h"|"15m",
              "left": { "ref": "rsi14_1h"|"ema20_1D"|"price"|"volume" },
              "op": "<"|"<="|">"|">="|"crosses_above"|"crosses_below",
              "right": { 
                "ref": "value"|"ema50_1D"|"entry"|"stopLoss", 
                "value": <number>, 
                "offset": <number> 
              }
            }
          ],
          "mitigation": ["reduce_qty","wider_stop","skip_on_news","wait_for_confirmation"]
        }
      ],
      "triggers": [],
      "confirmation": {
        "require": "ALL"|"ANY",
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
          "evidence": "Which indicators or levels support it, named clearly with values."
        },
        {
          "point": "Short point explaining that potential reward is larger than risk.",
          "evidence": "Based on actual entry, target, stopLoss distances with calculation."
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
        "why_smart_move": "One concise sentence (15-25 words) using chosen sport or plain English that explains why this plan is logical with real levels.",
        "ai_will_watch": [
          "Entry trigger mapped to real levels, explained simply and optionally in sport terms.",
          "Pre-entry invalidation mapped to real levels, explained as a clear 'walk away' condition.",
          "Post-entry invalidation based on stopLoss, explained as a clear 'cut loss and protect capital' rule."
        ],
        "beginner_explanation": "2–3 clear lines (50-80 words): wait for confirmation, protect with stopLoss, aim for better reward than risk, ending with one natural sport or plain-English summary line if applicable."
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
          "example": "₹<actual entry price from strategy>"
        },
        "target": {
          "definition": "Price where profits are planned to be booked.",
          "example": "₹<actual target price from strategy>"
        },
        "stopLoss": {
          "definition": "Price where the trade will be closed to limit loss.",
          "example": "₹<actual stopLoss price from strategy>"
        }
      }
    }
  ],
  "performance_hints": {
    "confidence_drivers": ["what increased confidence"],
    "uncertainty_factors": ["what reduced confidence"],
    "data_quality_score": <number between 0 and 1>
  },
  "disclaimer": "AI-generated educational analysis. Not investment advice."
}

=== PRE-OUTPUT CHECKLIST ===
Before outputting, verify:
□ Valid JSON syntax (no trailing commas, proper quotes)
□ All required fields present per schema v1.4
□ No template text (<...> or {{...}})
□ Real numbers from provided data only
□ Title has correct prefix: [Revalidated]/[Adjusted]/[Retired] if applicable
□ Sport language consistent if game_mode active
□ performance_hints populated with actual factors at ROOT level
□ Triggers and invalidations copied correctly from STAGE-2

=== FINAL REMINDERS ===

- Output MUST be strictly valid JSON (no syntax errors).
- Do NOT include markdown code fences like \`\`\`json or \`\`\`.
- Do NOT include any explanations or commentary outside the JSON.
- Do NOT leave any placeholder-style text like <...> or {{...}}; always use concrete values or safe neutral defaults.
- NEVER output the literal characters "<", ">", "{{", or "}}" in the JSON values.
- All string values must be properly escaped for JSON (use \\" for quotes inside strings).
- Use ONLY data from MARKET DATA, SECTOR INFO, STAGE-1, and STAGE-2.
- If data is insufficient, set insufficientData: true and use safe neutral values.
- Follow the LANGUAGE MANIFESTO for all text fields.
- Apply sport analogies consistently if game_mode is valid.
- Revalidate, adjust minimally, or retire the existing strategy as appropriate.
- Performance hints must be at the ROOT level, NOT inside strategies array.
`;

console.log("Stage 3 prompt built for", stock_symbol);
console.log("Stage 3 system:", JSON.stringify(system));
console.log("Stage 3 user:", JSON.stringify(user));

  return { system, user };
}