# How Comparative Context Flows to AI

## The Problem You Identified

The AI can only explain what it **knows**. When I analyzed BANKINDIA vs PNB vs SBIN, I had:
- All 3 stocks with their indicators
- Why PNB was eliminated (RSI 74)
- Why SBIN was eliminated (RSI 74 daily + 79 weekly)
- Why BANKINDIA was best entry NOW

Without this context, the AI can't explain **"why this stock over others"**.

---

## The Solution: Pass Comparative Context

### Step 1: Enrichment Pipeline Collects All Candidates

```javascript
// In stockEnrichmentService.js - runEnrichmentPipeline()

const enrichmentResult = {
  stocks: enrichedStocks,           // All qualified stocks, sorted by score
  eliminated: eliminatedStocks,      // Stocks that failed (RSI > 72, etc.)
  metadata: {
    total_scanned: allResults.length,
    total_eliminated: eliminatedStocks.length,
    elimination_reasons: eliminatedStocks.map(s => ({
      symbol: s.symbol,
      reason: s.eliminationReason,
      rsi: s.indicators?.rsi,
      volume: s.indicators?.volume_vs_avg
    }))
  }
};
```

### Step 2: Build Comparative Context

```javascript
// In analysis service (before calling buildStage3Prompt)

import { buildFrameworkContext, formatContextForPrompt } from './frameworkContextBuilder.js';

// Get the selected stock (rank #1)
const selectedStock = enrichedStocks[0];

// Get all candidates (including eliminated) for comparison
const allCandidates = [...enrichedStocks, ...eliminatedStocks];

// Build rich context
const frameworkContext = buildFrameworkContext(selectedStock, allCandidates);

// Format for prompt
const comparativePromptSection = formatContextForPrompt(frameworkContext);
```

### Step 3: Pass to buildStage3Prompt

```javascript
const prompt = await buildStage3Prompt({
  stock_name: selectedStock.stock_name,
  stock_symbol: selectedStock.symbol,
  current_price: selectedStock.current_price,
  // ... other params ...
  
  // NEW: Pass framework context
  framework_score: {
    score: selectedStock.setup_score,
    grade: selectedStock.grade,
    breakdown: selectedStock.score_breakdown
  },
  trading_levels: selectedStock.levels,
  
  // NEW: Pass comparative context
  comparative_context: frameworkContext,
  comparative_prompt: comparativePromptSection
});
```

### Step 4: Include in AI Prompt

In `swingPrompts.js`, add:

```javascript
${comparative_prompt ? comparative_prompt : ''}
```

---

## Example Context the AI Receives

```
═══════════════════════════════════════════════════════════════════════════
WHY BANKINDIA WAS SELECTED (COMPARATIVE ANALYSIS)
═══════════════════════════════════════════════════════════════════════════

WINNER: BANKINDIA
Score: 82/100 | Grade: A+
RSI: 62.3 | Volume: 1.8x | R:R: 1:2.5

COMPARISON TABLE:
| Stock     | RSI | Status         | Volume | R:R  | Score | Verdict                    |
|-----------|-----|----------------|--------|------|-------|----------------------------|
| BANKINDIA | 62  | ✅ Sweet spot  | 1.8x   | 1:2.5| 82    | 🏆 SELECTED - Best entry NOW |
| FEDERALBNK| 62  | ✅ Sweet spot  | 1.2x   | 1:1.8| 71    | #2 - Lower R:R             |
| PNB       | 74  | 🔴 Overbought  | 3.5x   | 1:2.0| 0     | ❌ ELIMINATED - RSI > 72   |
| SBIN      | 74  | 🔴 Overbought  | 1.1x   | 1:1.4| 0     | ❌ ELIMINATED - RSI > 72   |

ELIMINATED STOCKS (Why They Were Rejected):
❌ PNB: RSI 74.51 > 72 (too extended)
   - RSI: 74 | Volume: 3.5x
   - What was good: High volume (3.5x) - strong conviction
   - Fatal flaw: RSI 74.51 > 72 (too extended)

❌ SBIN: RSI 74.32 > 72 (too extended)  
   - RSI: 74 | Volume: 1.1x
   - What was good: Large cap stability
   - Fatal flaw: RSI 74.32 > 72 (too extended)

WHY BANKINDIA WINS (Plain English):
1. RSI Position: RSI at 62 is in the sweet spot (55-65) - showing momentum without being overbought
   ↳ Unlike PNB (RSI 74), SBIN (RSI 74) which are too extended
2. Volume Conviction: Volume at 1.8x average shows institutional buying, not just retail noise
3. Risk:Reward: R:R of 1:2.5 means you're risking ₹1 to potentially make ₹2.5
4. Entry Timing: This stock offers the best entry RIGHT NOW - not already extended

BOTTOM LINE:
BANKINDIA wins because it has the best combination of factors for entry RIGHT NOW - 
RSI in sweet spot, strong 2.5:1 R:R, institutional volume, not overbought like PNB

═══════════════════════════════════════════════════════════════════════════
⚠️ USE THIS CONTEXT to explain the selection in framework_analysis and why_in_plain_words
═══════════════════════════════════════════════════════════════════════════
```

---

## Now the AI Can Generate This:

```json
{
  "framework_analysis": {
    "total_score": 82,
    "grade": "A+",
    "factors": [...],
    "why_selected": [
      "RSI at 62 is in the sweet spot - unlike PNB (74) and SBIN (74) which are overbought",
      "Volume at 1.8x shows institutional buying, not retail noise",
      "R:R of 1:2.5 means risking ₹8 to potentially make ₹20",
      "Best entry RIGHT NOW - not waiting for pullback like others"
    ],
    "vs_eliminated": [
      {
        "symbol": "PNB",
        "had_going_for_it": "Highest volume (3.5x) - strongest conviction",
        "why_rejected": "RSI 74 > 72 - too extended, risky to chase"
      },
      {
        "symbol": "SBIN", 
        "had_going_for_it": "Large cap, stability",
        "why_rejected": "RSI 74 daily + 79 weekly - way too overbought"
      }
    ],
    "bottom_line": "BANKINDIA offers the best risk-adjusted entry NOW"
  }
}
```

---

## Files to Update

| File | Change |
|------|--------|
| `frameworkContextBuilder.js` | **NEW** - Builds comparative context |
| `stockEnrichmentService.js` | Return eliminated stocks with reasons |
| `weekendScreeningJob.js` | Pass eliminated stocks to analysis |
| `swingPrompts.js` | Accept & include comparative_prompt |
| Analysis service | Build and pass context before prompt |

---

## Key Insight

The AI explanation is only as good as the **context** we provide. By passing:

1. **Selected stock details** - What won
2. **Eliminated stocks** - What lost and WHY (RSI, R:R, etc.)
3. **Runners-up** - What was close but not best
4. **Plain English reasons** - Pre-built explanations

...the AI can now generate explanations **like I gave you** for BANKINDIA!
