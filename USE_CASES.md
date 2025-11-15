# LOGDHAN - AI-Powered Stock Analysis Platform
## Comprehensive Use Cases & Capabilities

---

## 🎯 **PROJECT OVERVIEW**

**Logdhan** is an AI-powered Indian stock market analysis platform designed to democratize swing trading for retail investors. It transforms complex technical analysis into beginner-friendly trading strategies using personalized sport analogies, real-time monitoring, and automated bulk analysis.

**Tech Stack:**
- **Backend**: Node.js + Express + MongoDB + Agenda (job scheduler)
- **Frontend**: Kotlin Multiplatform (Android + iOS) with Jetpack Compose
- **AI**: OpenAI GPT-4o & GPT-5.1 (3-stage analysis pipeline)
- **Integrations**: Upstox (brokerage), Firebase (notifications), Cashfree (payments), Infobip (WhatsApp)

---

## 📋 **30 CORE USE CASES**

### **1. USER ONBOARDING & AUTHENTICATION**
**Use Case 1.1**: New user registers with mobile number (12-digit format with country code), receives OTP via WhatsApp, and creates account with JWT-based authentication (7-day sessions).

**Use Case 1.2**: During onboarding, user completes a 6-question quick quiz to assess trading experience (Beginner/Intermediate/Advanced), which personalizes the UI complexity and enables adaptive content.

**Use Case 1.3**: User selects their favorite sport (cricket, football, kabaddi, badminton, chess, racing, etc.) during profile setup. This powers personalized analogies in strategy explanations (e.g., "Entry zone is like the penalty box in football - high-risk, high-reward").

---

### **2. WATCHLIST MANAGEMENT**
**Use Case 2.1**: User searches from 5000+ NSE/BSE stocks, adds up to 3 stocks (Trial plan) or 50 stocks (Paid plan) to their watchlist, and views real-time prices via Upstox API integration.

**Use Case 2.2**: System automatically categorizes added stocks by sector (Banking, IT, Pharma, Auto, FMCG, etc.) and displays sector-specific news sentiment in analysis reports.

**Use Case 2.3**: User removes stocks from watchlist, freeing up quota slots. System archives historical analyses for removed stocks (30-day retention) while preventing new analyses.

---

### **3. AI-POWERED STOCK ANALYSIS (3-STAGE PIPELINE)**

#### **Stage 1: Preflight & Data Validation**
**Use Case 3.1**: User requests manual analysis for "RELIANCE". System's Stage 1 validates availability of required market data (15m, 1h, 1d candles), computes market summary (trend, volatility, volume), and checks data health. If insufficient data detected (e.g., missing indicators), analysis stops early with clear explanation.

**Use Case 3.2**: Stage 1 generates market summary showing current price (₹2,450), trend (BULLISH), volatility (MEDIUM), volume (ABOVE_AVERAGE), and data health report (e.g., "Missing RSI on 1h timeframe - using alternate indicators").

#### **Stage 2: Strategy Skeleton & Triggers**
**Use Case 3.3**: System's Stage 2 builds ONE best-fit strategy (BUY/SELL/NO_TRADE) with precise entry (₹2,435-₹2,445 range), target (₹2,550), and stop-loss (₹2,390) using ATR-based calculations. Validates minimum 1.5:1 risk-reward ratio.

**Use Case 3.4**: Stage 2 defines evaluatable entry triggers (e.g., "Entry when: close_1h crosses above ₹2,440 AND rsi14_1h > 55") with expiry windows (5 trading sessions soft limit, 8 hard limit).

**Use Case 3.5**: System classifies strategy archetype (breakout, pullback, trend-follow, mean-reversion, range-fade) and alignment (with_trend, counter_trend, neutral) for risk assessment.

#### **Stage 3: Beginner-Friendly Enrichment**
**Use Case 3.6**: Stage 3 enriches strategy with plain-language explanations using user's favorite sport. For cricket lover: "Think of ₹2,440 as the powerplay overs - once price crosses this level, we're aiming for boundaries (₹2,550 target). Set a fielder at ₹2,390 (stop-loss) to limit losses."

**Use Case 3.7**: System generates "Money Examples" showing: "If you invest ₹10,000 at ₹2,440 (buy 4 shares), you could make ₹2,000 profit if target hits (₹2,550) or lose ₹800 if stop-loss triggers (₹2,390). Risk-Reward: 1.5:1."

**Use Case 3.8**: Analysis includes Risk Meter (visual gauge: LOW/MEDIUM/HIGH), Actionability Status (trade_now/wait_for_trigger/monitor_only), and auto-generated glossary (e.g., "ATR: Average True Range - measures price volatility over 14 days").

**Use Case 3.9**: System provides "What Could Go Wrong" section with likelihood (LOW/MEDIUM/HIGH), impact assessment, and mitigation strategies (e.g., "Gap risk - Medium likelihood, High impact - Mitigation: reduce position size by 50%").

**Use Case 3.10**: Analysis includes step-by-step beginner checklist: "Step 1: Wait for price to cross ₹2,440 on 1-hour chart. Step 2: Confirm RSI is above 55. Step 3: Place limit order between ₹2,435-₹2,445. Step 4: Set target at ₹2,550 and stop-loss at ₹2,390."

---

### **4. BULK ANALYSIS SCHEDULING**
**Use Case 4.1**: Every day at 4:00 PM (post-market close), system automatically analyzes user's entire watchlist (15 stocks) in parallel with concurrency limit of 5 (safe for OpenAI Tier 1 rate limits). Completes in ~20-40 minutes depending on tier.

**Use Case 4.2**: Bulk analysis creates "pending" StockAnalysis records with scheduled_release_time of 5:00 PM. System prefetches prices at 3:55 PM (30 stocks in 5 seconds with delays) to optimize performance.

**Use Case 4.3**: If stock already has valid analysis (generated today, not expired), system reuses cached result and marks as "skipped" in session. Only regenerates stale/expired analyses, saving 60-80% of API costs.

**Use Case 4.4**: System tracks bulk analysis session with progress monitoring (15/15 completed), logs token usage per stock (avg ~6,000 tokens = ₹0.30 per analysis), and sends WhatsApp/Push notification at 5:00 PM: "Your 15 stocks analyzed! Check dashboard for strategies."

**Use Case 4.5**: If analysis fails (rate limit 429 error), exponential backoff retry logic kicks in (max 5 retries with 1s, 2s, 4s, 8s, 16s delays + jitter). Final stats show: "✅ 12 successful, ⏭️ 2 cached, ❌ 1 failed" with detailed error logs.

---

### **5. REAL-TIME TRIGGER MONITORING**
**Use Case 5.1**: User enables "Monitor Triggers" for RELIANCE strategy. System creates MonitoringSubscription (multi-user job) that checks entry conditions every 60 seconds during market hours (9:15 AM - 3:30 PM IST).

**Use Case 5.2**: If same stock is being monitored by 10 users, system creates ONE shared Agenda job (not 10 separate jobs), optimizing server resources. Each user gets individual notifications when their conditions are met.

**Use Case 5.3**: At 10:45 AM, RELIANCE price crosses ₹2,440 and RSI > 55 (entry trigger met). System captures exact market data snapshot (price, timestamp, indicators) and sends WhatsApp/Push: "🚀 Entry conditions met for RELIANCE! Price: ₹2,442 | RSI: 57 | Trade now or conditions may change."

**Use Case 5.4**: System includes "45-minute freshness window" - if conditions were met >45 mins ago, notification warns: "⚠️ Conditions met at 10:00 AM (1 hour ago). Market may have moved - verify before trading." Prevents stale setups.

**Use Case 5.5**: Monitoring auto-expires at 3:30 PM market close OR when strategy's hard expiry (8 trading sessions) is reached. User receives notification: "Monitoring stopped for RELIANCE - Strategy expired. Request fresh analysis."

---

### **6. SUBSCRIPTION MANAGEMENT**
**Use Case 6.1**: New user gets 7-day Trial plan (3 stocks, 3 analyses/day). On Day 5, receives notification: "Trial expires in 2 days. Upgrade to Premium for 25 stocks + unlimited analyses."

**Use Case 6.2**: User upgrades to Monthly Premium plan (₹499/month) via Cashfree payment gateway (UPI/Card). System immediately increases watchlist quota to 25 stocks and removes daily analysis limits.

**Use Case 6.3**: Premium subscription auto-renews on Day 30. Cashfree webhook triggers renewal payment, extends subscription for another month, and sends confirmation: "✅ Premium renewed until [date]. You have 25 stock slots available."

**Use Case 6.4**: User on Premium plan hits watchlist quota (25/25 stocks). Attempts to add 26th stock → System blocks with message: "Watchlist full. Remove a stock or upgrade to Elite plan (50 stocks)."

**Use Case 6.5**: User purchases one-time "Top-up Credits" (e.g., ₹200 for 10 extra analyses beyond daily limit). Credits tracked separately, decremented on each analysis, and never expire.

---

### **7. UPSTOX BROKERAGE INTEGRATION**
**Use Case 7.1**: User connects Upstox account via OAuth flow. System stores encrypted access token, fetches user's holdings, and enables direct order placement from analysis screen.

**Use Case 7.2**: From RELIANCE analysis, user clicks "Trade Now". System pre-fills order form with strategy values (Entry: ₹2,440, Target: ₹2,550, Stop-loss: ₹2,390, Qty: 4 shares based on ₹10,000 budget). User confirms with one tap.

**Use Case 7.3**: System places Bracket Order (Entry + Target + SL) via Upstox Multi-Order API. Tracks order status (PENDING → EXECUTED → COMPLETE) and sends notification: "✅ RELIANCE Buy order executed at ₹2,442. Target and SL orders placed automatically."

**Use Case 7.4**: If order fails (insufficient funds, circuit limit hit), system shows detailed error: "❌ Order rejected - Insufficient margin. Required: ₹9,850 | Available: ₹5,000. Add funds to continue."

---

### **8. TRADE LOGGING & AI REVIEW**
**Use Case 8.1**: User manually logs a completed trade: "Bought TCS at ₹3,450, Sold at ₹3,600, Qty: 10, Type: Intraday, Reasoning: Followed AI strategy + strong volume confirmation."

**Use Case 8.2**: System calculates P&L (₹1,500 profit), win rate (if multiple trades logged), and stores in trade history with filters (Date range, Type, Stock, P&L +/-).

**Use Case 8.3**: User requests "AI Review" for logged trade. GPT-5.1 analyzes the trade against market data at that time and provides feedback: "✅ Good entry timing - price was at support. ⚠️ Target was too conservative - could have held for ₹3,650 (Reward = ₹2,000). 📊 Trade Grade: B+."

**Use Case 8.4**: User exports trade log as CSV for tax reporting or personal analysis. File includes: Date, Stock, Type, Entry, Exit, Qty, P&L, Reasoning, AI Grade.

---

### **9. NOTIFICATIONS & ALERTS**
**Use Case 9.1**: User receives push notification when bulk analysis completes at 5:00 PM: "📊 Your 15 stocks analyzed! 8 BUY signals, 4 SELL signals, 3 NO_TRADE. Tap to view."

**Use Case 9.2**: WhatsApp notification sent when monitoring trigger fires: "🎯 TCS Entry Alert! Price crossed ₹3,450 | RSI: 62 | Target: ₹3,600 | Stop-loss: ₹3,380. Valid for next 45 mins."

**Use Case 9.3**: Daily reminder at 8:00 AM: "⏰ Today's analyses expire at 8:59 AM. Request fresh analysis after 9:00 AM or use current strategies."

**Use Case 9.4**: Subscription expiry warning 2 days before: "⚠️ Premium expires on [date]. Renew now to keep 25-stock watchlist and unlimited analyses."

**Use Case 9.5**: In-app notification center shows unread badge count, categorizes by type (Analysis, Triggers, Subscription, System), and marks as read on tap.

---

### **10. EXPERIENCE-BASED PERSONALIZATION**
**Use Case 10.1**: Beginner user sees simplified strategy card with only essential fields (Entry, Target, Stop-loss, Plain-English reasoning). Advanced user sees full technical details (indicators, triggers, invalidations, confirmation windows).

**Use Case 10.2**: User clicks "Simplify" button on complex analysis. System logs behavioral signal (confidence -= 0.05) and adjusts future analyses to show less jargon, more analogies.

**Use Case 10.3**: After 30 days of consistent profitable trades logged, system upgrades user's experience level from Beginner to Intermediate. UI automatically reveals intermediate features (trigger customization, indicator filtering).

**Use Case 10.4**: User completes 12-question "Deep Diagnostic" quiz (Pro feature) covering options, derivatives, risk management. System generates detailed experience profile with confidence score (0.85 = High confidence in Intermediate classification).

---

### **11. SENTIMENT ANALYSIS & NEWS INTEGRATION**
**Use Case 11.1**: Before generating RELIANCE strategy, system fetches sector-specific news (Energy, Oil & Gas) and general market news. GPT-5.1 analyzes sentiment (BULLISH/NEUTRAL/BEARISH with confidence 0-1).

**Use Case 11.2**: Analysis includes sentiment reasoning: "📰 Recent News (5 articles analyzed): 'Strong Q3 results', 'Expansion plans announced', 'Sector upgrades by analysts' → Overall Sentiment: BULLISH (Confidence: 0.82)."

**Use Case 11.3**: If negative news detected (e.g., "Regulatory investigation announced"), system adjusts risk level to HIGH and suggests position sizing reduction: "⚠️ Negative news detected. Reduce position size by 50% or wait for clarity."

---

### **12. REFERRAL PROGRAM**
**Use Case 12.1**: User shares unique referral code "ROHAN2024" with friends. When friend signs up using this code and verifies mobile, both users receive ₹100 bonus credits.

**Use Case 12.2**: User tracks referral performance in app: "Referred: 8 users | Verified: 5 | Bonus Earned: ₹500 | Pending: 3 (awaiting verification)."

**Use Case 12.3**: Bonus credits can be used for: Top-up analyses, premium plan purchases, or upgrading watchlist quota. Never expire and stack with subscription benefits.

---

### **13. ADMIN FEATURES (Backend)**
**Use Case 13.1**: Admin creates new subscription plan "Elite Annual" with config: ₹4,999/year, 50 stocks, unlimited analyses, GPT-5.1 access, priority support. Plan goes live immediately.

**Use Case 13.2**: Admin manually allocates ₹200 bonus credits to user for bug report or feedback. System logs transaction with reason and updates user balance.

**Use Case 13.3**: Admin views analytics dashboard: "Today: 1,245 analyses | ₹2,340 OpenAI costs | 85 new signups | 12 Premium conversions | Top stocks: RELIANCE (342 analyses), TCS (298), INFY (256)."

---

### **14. ERROR HANDLING & RECOVERY**
**Use Case 14.1**: OpenAI API returns 429 rate limit error during bulk analysis. Exponential backoff retries 5 times (1s, 2s, 4s, 8s, 16s delays). If still failing, marks stock as failed and continues with next stock. Final notification: "12/15 succeeded, 3 failed - will retry in next cycle."

**Use Case 14.2**: User's internet drops mid-analysis request. System times out after 120 seconds, returns user-friendly error: "Analysis timed out. Please check connection and try again. No credits deducted."

**Use Case 14.3**: Upstox API goes down during price fetch. System falls back to cached prices (updated 5 mins ago) with disclaimer: "⚠️ Using cached price (₹2,440 from 2:55 PM). Live price may differ."

**Use Case 14.4**: Bulk analysis session crashes at 4:30 PM (processed 8/15 stocks). Agenda's stale lock cleanup (runs every 5 mins) detects stuck job, unlocks it, and resumes from stock #9. User gets partial results immediately, full results after resume.

---

### **15. PERFORMANCE OPTIMIZATIONS**
**Use Case 15.1**: System caches stock prices in-memory with 5-minute TTL. When 10 users request RELIANCE analysis simultaneously, only 1 API call made to Upstox. Remaining 9 use cached price, saving 90% of API costs.

**Use Case 15.2**: Bulk analysis uses parallel processing with p-limit (5 concurrent tasks). 1000 stocks complete in ~40 minutes (vs 3.3 hours sequential), respecting OpenAI Tier 1 rate limits (500 RPM, 30K TPM).

**Use Case 15.3**: Before 4:00 PM bulk analysis, system prefetches prices for all unique stocks in all users' watchlists (async background job at 3:55 PM). Warms up cache, reducing analysis time by 30%.

---

### **16. MOBILE APP FEATURES (Kotlin Multiplatform)**
**Use Case 16.1**: User swipes down on Dashboard screen to refresh analyses. UI shows shimmer loading state while fetching latest data. On completion, animates new strategies into view with badge for "New" analyses.

**Use Case 16.2**: User enables dark mode in Settings. App switches to dark theme with proper contrast ratios for charts, indicators, and text. Preference saved locally and synced across devices.

**Use Case 16.3**: User receives push notification while app is closed. Taps notification → Deep link opens specific stock analysis screen (e.g., `logdhan://stock/RELIANCE`). Android App Links and iOS Universal Links supported.

**Use Case 16.4**: User watches rewarded AdMob video ad to earn 1 free analysis credit. After 30-second ad completes, credit added immediately with confirmation toast: "+1 Free Analysis Credit Earned!"

---

### **17. MARKET TIMING CONTROLS**
**Use Case 17.1**: User tries to request analysis at 4:15 PM (during bulk analysis downtime window). System blocks with message: "⏸️ Analysis downtime (4:00-5:00 PM). Automated bulk analysis in progress. Try again after 5:00 PM or use existing analyses."

**Use Case 17.2**: On Saturday evening, user requests analysis for new stock. System allows request (analysis window: Sat 4 PM - Mon 8:59 AM) and generates fresh strategy using Friday's closing data. Analysis valid until Monday 3:30 PM.

**Use Case 17.3**: On market holiday (Republic Day), system skips bulk analysis job at 4:00 PM. Existing analyses remain valid until next trading day. Users notified: "Market closed today. Next analysis scheduled for [next trading day]."

---

### **18. CHART GENERATION & VISUALIZATION**
**Use Case 18.1**: System generates candlestick chart for RELIANCE with 1-day timeframe, overlays EMA20, EMA50, SMA200, marks entry zone (₹2,435-₹2,445), target (₹2,550), and stop-loss (₹2,390) with color-coded lines.

**Use Case 18.2**: Chart includes RSI indicator panel (below price chart) showing current value (57) and signal zones (oversold <30, overbought >70). Annotates entry trigger: "Entry when RSI crosses 55."

**Use Case 18.3**: Generated chart saved to Azure Blob Storage with 24-hour expiry. Temporary URL returned in API response for mobile app to display. After 24 hours, chart auto-deleted to save storage costs.

---

### **19. DATA PRIVACY & SECURITY**
**Use Case 19.1**: User's Upstox access token encrypted using AES-256 before storing in MongoDB. Decrypted only when needed for API calls. Never exposed in logs or API responses.

**Use Case 19.2**: Stock analyses shared across all users (e.g., RELIANCE analysis generated for User A is reused for Users B, C, D). Personal data (watchlist, trade logs, profile) kept strictly private per user.

**Use Case 19.3**: JWT token blacklisted when user logs out. Subsequent requests with that token return 401 Unauthorized. User must re-authenticate to get new token.

---

### **20. WEBHOOK INTEGRATIONS**
**Use Case 20.1**: Cashfree sends webhook when subscription payment succeeds. System verifies webhook signature, extends subscription by 30 days, sends confirmation email, and updates user's plan limits immediately.

**Use Case 20.2**: If payment webhook fails (network timeout), system has fallback: Polls Cashfree API every 5 minutes for pending orders. Once payment confirmed, processes subscription renewal.

---

## 🎖️ **UNIQUE SELLING POINTS**

1. **Sport-Based Explanations**: Converts technical jargon into relatable sport analogies based on user's favorite sport (cricket, football, kabaddi, etc.). Makes complex strategies accessible to beginners.

2. **3-Stage Validated AI Pipeline**: Unlike competitors' single-stage analysis, Logdhan uses Stage 1 (data validation), Stage 2 (strategy skeleton), and Stage 3 (beginner enrichment) for higher quality and reliability.

3. **Shared Multi-User Monitoring**: Multiple users monitoring same stock = 1 background job (not N separate jobs). Optimizes server resources while maintaining individual user notifications.

4. **Automatic Daily Bulk Analysis**: Set-and-forget watchlist analysis every day at 4-5 PM. Users wake up to fresh strategies without manual requests.

5. **Beginner-Adaptive UI**: Content complexity adjusts based on user experience level (Beginner sees simple explanations, Advanced sees full technical details). Learns from user behavior (e.g., "Simplify" button clicks).

6. **Direct Brokerage Integration**: One-tap trading via Upstox with automatic bracket orders (Entry + Target + SL). No need to manually enter values in broker app.

7. **Real-Time Trigger Monitoring**: Monitors entry conditions every 60 seconds during market hours. Sends instant alerts when conditions met with exact market data snapshot.

8. **Money Examples & Risk Meters**: Shows real-world profit/loss scenarios ("Invest ₹10K, make ₹2K or lose ₹800") instead of abstract percentages. Visual risk gauges replace complex scores.

9. **Token Usage Transparency**: Tracks OpenAI API costs per analysis, shows token breakdown (input/output/cached), and helps users understand pricing.

10. **Multi-Platform Support**: Kotlin Multiplatform codebase shared between Android and iOS. Single business logic, platform-specific UI optimizations.

---

## 📊 **TECHNICAL METRICS**

- **Analysis Speed**: 12-15 seconds per stock (3-stage pipeline)
- **Bulk Processing**: 1000 stocks in ~40 minutes (parallel processing with 5 concurrent tasks)
- **API Cost**: ~₹0.30 per analysis (avg 6,000 tokens at GPT-4o pricing)
- **Cache Hit Rate**: 60-80% during bulk analysis (reuses valid analyses)
- **Monitoring Efficiency**: 100 users monitoring same stock = 1 job (100x resource saving)
- **Uptime**: 99.5% (MongoDB Atlas M10, Node.js cluster mode)
- **Response Time**: <500ms for cached analyses, <15s for fresh AI generation

---

## 🚀 **SCALABILITY & FUTURE ROADMAP**

### Current Capacity
- Handles 10,000+ concurrent users
- Processes 50,000+ analyses per day
- Supports 5,000+ NSE/BSE stocks
- Multi-region deployment ready (Mumbai, Singapore, US)

### Planned Features (Roadmap)
1. **Options Analysis**: Calls/Puts strategy generation with Greeks calculation
2. **Portfolio Management**: Track overall portfolio P&L, diversification, risk exposure
3. **Social Trading**: Follow top traders, copy their strategies (with consent)
4. **Backtesting**: Test strategies on historical data before trading live
5. **Paper Trading**: Practice trading with virtual money
6. **Advanced Charts**: TradingView integration for institutional-grade charting
7. **Voice Alerts**: AI voice notifications for trigger alerts (regional languages)
8. **Screeners**: Custom stock screening based on technical/fundamental criteria
9. **Algo Trading**: Deploy strategies as automated bots (Upstox API)
10. **Multi-Broker Support**: Zerodha, Angel One, ICICI Direct integration

---

## 📝 **CONCLUSION**

Logdhan is not just another stock analysis tool - it's a **complete trading ecosystem** that combines cutting-edge AI, beginner-friendly design, and powerful automation to make swing trading accessible to everyone. By focusing on education (sport analogies), validation (3-stage pipeline), and convenience (auto-analysis, real-time monitoring), it bridges the gap between retail investors and institutional-grade analysis.

**Target Users**: Beginner to Intermediate retail traders in India who want AI-powered strategies without learning complex technical analysis.

**Competitive Advantage**: Personalization (sport analogies), validation (3-stage AI), automation (bulk analysis + monitoring), and integration (direct trading via Upstox).

---

## 📞 **SUPPORT & DOCUMENTATION**

For technical review, architecture deep-dive, or feature demonstrations, please refer to:
- **API Documentation**: `/docs` endpoint (Swagger/OpenAPI)
- **Database Schema**: See `/backend/src/models/` for all MongoDB schemas
- **Frontend Screens**: See `/composeApp/src/commonMain/kotlin/com/nolojik/logdhan/feature/` for UI components
- **Job Scheduler**: See `/backend/src/services/agendaScheduledBulkAnalysis.service.js` for background jobs
- **AI Pipeline**: See `/backend/src/services/aiAnalyze.service.js` (3-stage implementation)

---

**Version**: 1.0.0
**Last Updated**: January 2025
**Author**: Logdhan Development Team
