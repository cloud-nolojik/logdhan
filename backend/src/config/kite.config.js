/**
 * Kite Connect (Zerodha) Configuration
 *
 * This configuration is used for automated trading via Kite Connect API.
 * Orders are placed ONLY for the admin account specified by KITE_ADMIN_USER_ID.
 */

const kiteConfig = {
  // Kite Connect API credentials
  API_KEY: process.env.KITE_API_KEY,
  API_SECRET: process.env.KITE_API_SECRET,

  // API URLs
  BASE_URL: 'https://api.kite.trade',
  LOGIN_URL: 'https://kite.zerodha.com/connect/login',
  KITE_WEB_URL: 'https://kite.zerodha.com',
  REDIRECT_URL: process.env.KITE_REDIRECT_URL,

  // Auto-login credentials (for automated token refresh)
  USER_ID: process.env.KITE_USER_ID,
  PASSWORD: process.env.KITE_PASSWORD,
  TOTP_SECRET: process.env.KITE_TOTP_SECRET,

  // ADMIN ONLY - Orders placed only for this MongoDB user ID
  ADMIN_USER_ID: process.env.KITE_ADMIN_USER_ID,

  // Capital management
  CAPITAL_USAGE_PERCENT: 1.0,   // Use full available balance (risk managed by swing/intraday split)
  MIS_LEVERAGE_FACTOR: 5,       // MIS leverage multiplier (Zerodha allows ~5x)
  MAX_ORDER_VALUE: 100000,      // ₹1 lakh max per order
  MAX_DAILY_ORDERS: 10,         // Max orders per day
  SWING_CAPITAL_PERCENT: 0.60,   // 60% of usable capital for swing (CNC/GTT)
  INTRADAY_CAPITAL_PERCENT: 0.40, // 40% of usable capital for intraday (MIS)

  // Order settings
  DEFAULT_PRODUCT: 'CNC',       // Cash & Carry (delivery)
  DEFAULT_EXCHANGE: 'NSE',
  ORDER_VALIDITY: 'DAY',

  // Token refresh settings
  TOKEN_REFRESH_HOUR: 6,        // 6 AM IST
  TOKEN_REFRESH_MINUTE: 0,

  // Retry settings
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 1000,

  // API Endpoints
  ENDPOINTS: {
    // Authentication
    LOGIN: '/api/login',
    TWOFA: '/api/twofa',
    SESSION_TOKEN: '/session/token',

    // User
    PROFILE: '/user/profile',
    MARGINS: '/user/margins',

    // Orders
    ORDERS: '/orders',
    REGULAR_ORDER: '/orders/regular',
    AMO_ORDER: '/orders/amo',

    // GTT
    GTT_TRIGGERS: '/gtt/triggers',

    // Quotes
    QUOTE: '/quote',            // full quote incl. 5-level depth, buy/sell qty, OHLC
    QUOTE_LTP: '/quote/ltp',
    QUOTE_OHLC: '/quote/ohlc',

    // Historical / intraday candles
    // Usage: /instruments/historical/{instrument_token}/{interval}?from=...&to=...
    // Intervals: minute, 3minute, 5minute, 15minute, 30minute, 60minute, day
    HISTORICAL: '/instruments/historical',

    // Portfolio
    HOLDINGS: '/portfolio/holdings',
    POSITIONS: '/portfolio/positions',
  },

  // Order types
  ORDER_TYPES: {
    MARKET: 'MARKET',
    LIMIT: 'LIMIT',
    SL: 'SL',           // Stop Loss
    SL_M: 'SL-M',       // Stop Loss Market
  },

  // Market protection (%) — required by Kite for MARKET and SL-M orders
  // post SEBI retail-algo rules (effective 2026-04-01). Caps slippage from
  // the reference price; orders that would fill outside this band are rejected.
  // Set to 9 (not 10) — at 10%, Kite computes limit = prev_close × 1.10, which
  // after tick-snap rounds UP to exactly the upper circuit (also 10%), and NSE
  // rejects ("outside circuit limits"). GRASIM: 3154.5 × 1.10 = 3469.95 → snapped
  // to ₹3470.00, rejected (circuit was ₹3469.90). 9% stays comfortably below the
  // 10% circuit band regardless of tick rounding while still accommodating large
  // pre-open gaps. Kite web UI uses 1% as its default; we override for algo AMOs.
  DEFAULT_MARKET_PROTECTION: 9,

  // Market protection for SL-M orders specifically. Must be much tighter than
  // AMO MARKET because NSE error 16448 fires when the computed limit price
  // (trigger × (1 - mp%)) is too far from trigger OR below the day's lower
  // circuit price. At 10%, trigger=₹1687 → limit=₹1518, which is below
  // TATACOMM's circuit (₹1686.82) → 16448 every single cycle.
  // 1% keeps limit within NSE's permissible band for stocks well above circuit.
  // For stops near circuit, the protect-profit trail override handles escalation.
  DEFAULT_SLM_MARKET_PROTECTION: 1,

  // Product types
  PRODUCT_TYPES: {
    CNC: 'CNC',         // Cash & Carry (delivery)
    MIS: 'MIS',         // Margin Intraday Squareoff
    NRML: 'NRML',       // Normal (F&O)
  },

  // Transaction types
  TRANSACTION_TYPES: {
    BUY: 'BUY',
    SELL: 'SELL',
  },

  // GTT types
  GTT_TYPES: {
    SINGLE: 'single',   // Single leg GTT
    TWO_LEG: 'two-leg', // OCO (One Cancels Other)
  },

  // Order statuses
  ORDER_STATUSES: {
    PLACED: 'PLACED',
    OPEN: 'OPEN',
    COMPLETE: 'COMPLETE',
    CANCELLED: 'CANCELLED',
    REJECTED: 'REJECTED',
    PENDING: 'PENDING',
    TRIGGER_PENDING: 'TRIGGER PENDING',
  },

  // Audit log actions
  AUDIT_ACTIONS: {
    LOGIN: 'LOGIN',
    LOGIN_FAILED: 'LOGIN_FAILED',
    TOKEN_REFRESH: 'TOKEN_REFRESH',
    ORDER_PLACED: 'ORDER_PLACED',
    ORDER_MODIFIED: 'ORDER_MODIFIED',
    ORDER_CANCELLED: 'ORDER_CANCELLED',
    ORDER_EXECUTED: 'ORDER_EXECUTED',
    ORDER_REJECTED: 'ORDER_REJECTED',
    GTT_PLACED: 'GTT_PLACED',
    GTT_MODIFIED: 'GTT_MODIFIED',
    GTT_CANCELLED: 'GTT_CANCELLED',
    GTT_TRIGGERED: 'GTT_TRIGGERED',
    BALANCE_CHECK: 'BALANCE_CHECK',
    ERROR: 'ERROR',
  },
};

export default kiteConfig;
