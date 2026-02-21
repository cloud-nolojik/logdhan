# Project Context — Logdhan / SwingSetups

## App Overview
- **Name**: Logdhan (brand: SwingSetups)
- **One-liner**: AI-powered Indian stock market swing trading platform that transforms complex technical analysis into beginner-friendly strategies with sport analogies, real-time monitoring, and automated bulk analysis
- **Market**: India (NSE/BSE stocks, INR pricing)
- **Platform**: Both — Mobile app (primary) + Marketing website + Backend API
- **Stage**: Production
- **Publisher**: Nolojik Innovations
- **Domains**: `logdhan.com`, `api.logdhan.com`

## Target Users
- **Primary**: Beginner to Intermediate retail stock traders in India who want AI-powered swing trading strategies without learning complex technical analysis
- **Secondary**: Admin users managing plans, credits, and monitoring system health
- **Devices**: Android & iOS smartphones (budget to mid-range), Desktop for admin panel
- **Network**: Mixed — 4G/5G mobile connectivity in India; app must handle spotty connections gracefully

## Architecture
- **Backend**: Node.js (ES Modules) + Express.js v4.18 on port 5650, PM2 managed
- **Database**: MongoDB (Mongoose v8.2, 37 collections) hosted on MongoDB Atlas
- **Frontend Web**: React 18 + Vite 5 + Tailwind CSS 3 (marketing/landing site + admin panel)
- **Mobile App**: Kotlin Multiplatform (Android + iOS + Desktop) with Jetpack Compose, Voyager navigation, Ktor HTTP client
- **Job Scheduler**: Agenda (MongoDB-backed) + node-cron for background jobs
- **Deployment**: DigitalOcean droplet (64.227.179.191), Nginx + SSL, PM2 process manager
- **External APIs**:
  - OpenAI GPT-4o/GPT-5.1 — 3-stage AI analysis pipeline
  - Anthropic Claude — Dual AI provider (fallback/A-B testing)
  - Upstox — Market data (candles, quotes, instruments), broker OAuth integration
  - Zerodha Kite Connect — Automated order placement (admin-only), auto-login via Puppeteer + TOTP
  - Firebase Admin — FCM push notifications + Analytics
  - Infobip — WhatsApp OTP delivery and alert messages
  - Cashfree — Payment gateway for subscriptions (UPI/Card)
  - Azure Blob Storage — Chart image storage (24h expiry)
  - Postmark — Transactional email
  - Chartink — Stock screener scraping (Cheerio + Puppeteer)
  - RSS Parser — News feed parsing for sentiment analysis

## Core Domain Concepts
- **Stock Analysis (3-Stage Pipeline)**: Stage 1 = Preflight & data validation, Stage 2 = Strategy skeleton with entry/target/SL, Stage 3 = Beginner-friendly enrichment with sport analogies
- **Strategy**: A BUY/SELL/NO_TRADE recommendation with entry zone, target, stop-loss, risk-reward ratio, archetype (breakout/pullback/trend-follow/mean-reversion/range-fade), triggers, and invalidation rules
- **Order Gate**: Automated order placement guard requiring ALL conditions: `can_place_order`, `all_triggers_true`, `no_pre_entry_invalidations`, `entry_type_sane`, `actionability_status='actionable_now'`
- **Monitoring Subscription**: Multi-user shared background job that checks entry trigger conditions every 60 seconds during market hours (9:15 AM - 3:30 PM IST). One job per stock, not per user
- **Bulk Analysis**: Daily automated analysis of all users' watchlists at 4 PM IST, parallel processing (5 concurrent), results released at 5 PM
- **Weekly Watchlist**: Weekend screening pipeline (Saturday 6 PM) generating curated stock picks scored 0-100 with grades A-F across scan types (breakout, pullback, momentum, consolidation_breakout)
- **Daily Picks**: Short-term intraday trade picks (max 3/day). Full lifecycle: 8:45 AM scan → 9:15 ORB → 9:30 validation gate → order → monitor every 3 min → trailing stop at 2 PM → forced exit at 3 PM
- **Experience Level**: Beginner/Intermediate/Advanced determined by Quick Quiz (6 questions) or Deep Diagnostic (12 questions). Adjusts UI complexity and content verbosity
- **Favorite Sport**: User picks a sport (cricket, football, kabaddi, etc.) that powers personalized analogies in strategy explanations
- **Subscription Plans**: Stock-limit based (not credit-based). free_plan (5 stocks), trial (7 days), paid monthly/annual with higher stock limits

## Business Rules (Non-Negotiable)
1. **SEBI Compliance**: All analysis must include disclaimer: "AI-generated educational interpretation of price behaviour. Not investment advice." Users must consent to checkboxes (not investment advice, terms/privacy, 18+, WhatsApp communication)
2. **Indian Market Hours**: NSE/BSE 9:15 AM - 3:30 PM IST. All time calculations use IST. No analysis during market hours or Sunday
3. **Analysis Time Windows**: Stock analysis restricted to 4 PM - 9 AM IST on trading days (post-market to pre-market). 3-4 PM is pre-close window. Bulk analysis blocks 4-5 PM
4. **Minimum 1.5:1 Risk-Reward Ratio**: No strategy generated below this threshold
5. **Watchlist Limits by Plan**: free_plan = 5 stocks, trial = 3 stocks, paid plans = 25-50 stocks. Hard enforcement, no exceptions
6. **JWT 7-day Expiry (mobile), 30-day (email/password)**. Token blacklisted on logout
7. **Kite Automated Trading (Admin-Only)**: 50% capital usage, 2x MIS leverage, 1L max per order, 10 max daily orders
8. **45-Minute Freshness Window**: Monitoring alerts older than 45 minutes show staleness warning
9. **Strategy Expiry**: Soft limit 5 trading sessions, hard limit 8 trading sessions

## Key Features
- **AI Stock Analysis**: 3-stage pipeline generating BUY/SELL/NO_TRADE strategies with sport analogies, money examples, risk meters, and beginner checklists
- **Watchlist Management**: Add/remove stocks from 5000+ NSE/BSE instruments with sector categorization
- **Real-Time Trigger Monitoring**: Shared multi-user jobs checking entry conditions every 60s during market hours with instant WhatsApp/Push alerts
- **Bulk Analysis Scheduling**: Automatic daily watchlist analysis at 4 PM with parallel processing and smart caching (60-80% cache hit rate)
- **Weekly Discovery**: AI-curated weekly stock picks with scoring (0-100), scan type classification, and structural ladder targets
- **Daily Picks**: Intraday trade picks with full automated lifecycle (scan → validate → order → monitor → exit)
- **Upstox Broker Integration**: OAuth-linked direct trading with pre-filled bracket orders from analysis screen
- **Kite Connect Integration**: Admin-only automated order placement with conservative risk management
- **Subscription & Payments**: Cashfree-integrated plans (free/trial/paid) with stock-limit enforcement and auto-renewal
- **Experience-Based Personalization**: Adaptive UI complexity based on user quiz results and behavioral signals
- **Trade Journal**: Manual trade logging with AI review and P&L tracking
- **Push & WhatsApp Notifications**: Firebase FCM + Infobip WhatsApp for analysis completion, trigger alerts, and subscription reminders
- **Referral Program**: Unique referral codes with bonus credits for both referrer and referee
- **AdMob Integration**: Rewarded video ads to earn free analysis credits

## API Patterns
- **Base URL**: `/api/v1/` (36 route files)
- **Auth**: JWT Bearer token in `Authorization` header. Three middleware levels: `auth` (required), `optionalAuth` (optional), `adminAuth` (admin-only). Separate `simpleAdminAuth` for admin panel with `ADMIN_SECRET`
- **Response Format (Success)**:
  ```json
  {
    "success": true,
    "message": "Profile fetched successfully",
    "data": { ... }
  }
  ```
- **Response Format (Error)**:
  ```json
  {
    "success": false,
    "message": "Insufficient credits",
    "code": "INSUFFICIENT_CREDITS",
    "available": 5,
    "requested": 10
  }
  ```
- **Error Codes**: `NO_SUBSCRIPTION`, `FIRST_WEEK_LIMIT`, `INSUFFICIENT_CREDITS`, `TRIAL_NO_TOPUP`, `NO_ACTIVE_SUBSCRIPTION`
- **HTTP Status Codes**: 200 (success), 400 (validation), 401 (auth), 402 (payment/credits), 403 (forbidden), 404 (not found), 500 (server error)
- **Rate Limiting**: express-rate-limit per-user and per-IP. Specific limiters: subscriptions (100/15min), plan listing (30/min), AI reviews (5/min)
- **Credit Middleware**: `validateCreditUsage` and `requireActivePaidPlan` guard premium endpoints

## Key Route Groups
| Route | Purpose |
|---|---|
| `/api/v1/auth` | OTP login, profile, consent |
| `/api/v1/stocks` | Stock master data |
| `/api/v1/watchlist` | Watchlist CRUD |
| `/api/v1/ai` | AI analysis endpoints |
| `/api/v1/bulk-analysis` | Bulk analysis sessions |
| `/api/v1/subscriptions` | Plan management |
| `/api/v1/payments` | Cashfree payments |
| `/api/v1/upstox` | Upstox broker integration |
| `/api/v1/market` | Market data, indices, timing |
| `/api/v1/weekly-watchlist` | Weekly curated picks |
| `/api/v1/daily-picks` | Daily trade picks |
| `/api/v1/positions` | Position tracking |
| `/api/v1/journal` | Trade journal |
| `/api/v1/notifications` | Push notifications |
| `/api/v1/referrals` | Referral system |
| `/api/v1/experience` | Experience assessment |
| `/api/v1/screener` | Stock screener |
| `/api/v1/admin` | Admin endpoints |
| `/api/v1/job-monitor` | Background job status |

## Scheduled Jobs
| Job | Schedule | Purpose |
|---|---|---|
| `weekendScreeningJob` | Saturday 6 PM IST | Weekly watchlist generation |
| `dailyTrackingJob` | 4:00 PM Mon-Fri IST | Daily bulk analysis |
| `dailyPicksJob` | 8:45 AM Mon-Fri IST | Scan + enrich + notify daily picks |
| `dailyEntryJob` | ORB 9:15, validate 9:30, monitor */3, tighten 14:00, exit 15:00 | Intraday trade lifecycle |
| `kiteOrderSyncJob` | Every 30 min market hours | Detect fills, place OCO orders |
| `kiteTokenRefreshJob` | 6:00 AM daily | Auto-refresh Kite access token |
| `priceCacheService` | Every 5 min market hours | In-memory price caching |

## Database Collections (37 Mongoose Models)
### Core
- `user` — Accounts, mobile, experience, watchlist, FCM tokens, consent, referral
- `stockAnalysis` — AI strategies (v1.4 schema), order gates, indicators, confidence
- `stock` — Stock master data
- `subscription` — Plans (free/trial/paid), billing, Cashfree integration
- `plan` — Subscription plan definitions
- `payment` — Payment records

### Analysis & Picks
- `weeklyWatchlist` — Weekly curated picks with scan types, scoring, trading levels
- `dailyPick` — Daily intraday picks, ORB data, trade execution, Kite order linking
- `analysisSession` — Bulk analysis session tracking
- `analysisFeedback` — User feedback on AI analysis
- `stockLog` — Historical analysis log
- `marketSentiment` — Market sentiment data
- `marketTiming` — Market timing signals
- `dailyNewsStock` — Stocks in daily news

### Trading
- `kiteSession` — Zerodha Kite session tokens
- `kiteOrder` — Kite order records
- `kiteAuditLog` — Kite API audit trail
- `pendingBracketOrder` — Pending bracket (SL+target) orders
- `userPosition` — User trading positions
- `positionAlert` — Position-based alerts
- `tradeJournal` — Trade journal entries
- `upstoxUser` — Upstox broker account linking

### System
- `notification` — Push notification records
- `tokenBlacklist` — Blacklisted JWTs
- `referralCode` — Referral codes
- `latestPrice` — Price cache in DB
- `preFetchedData` — Pre-fetched market data
- `coachingCache` — Cached educational content
- `sentimentCache` — Cached sentiment analysis
- `dailyJobStatus` — Scheduled job status
- `apiUsage` — API usage metering
- `aiUsageLog` — AI API call logging
- `userAnalyticsUsage` — Per-user analytics
- `fineTuneData` — AI fine-tuning data
- `appFeedback` — In-app feedback
- `bulkAlertLog` — Bulk analysis alert logs
- `chatMessage` — Chat message records

## Mobile App Structure (Kotlin Multiplatform)
- **Package**: `com.nolojik.swingsetups`
- **Navigation**: Voyager v1.0.0-rc10
- **HTTP**: Ktor Client v2.3.7
- **Serialization**: Kotlinx Serialization JSON v1.6.2
- **Image Loading**: Coil 3
- **27 Feature Modules**: aianalysis, auth, broker, bulkanalysis, candidatereview, consent, dailypicks, dashboard, discovery, jobmonitor, journal, logs, monitoring, notifications, onboarding, payment, positions, profile, search, stockdetails, stocksinnews, subscription, timer, tradeplanning, tradereview, watchlist
- **Android-Specific**: Firebase Messaging + Analytics, Google AdMob (banner/native/rewarded), Accompanist Permissions
