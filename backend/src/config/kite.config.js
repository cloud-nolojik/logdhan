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
    QUOTE_LTP: '/quote/ltp',
    QUOTE_OHLC: '/quote/ohlc',

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
  // 1 = 1% (matches Kite web default since 2025-03-25).
  DEFAULT_MARKET_PROTECTION: 1,

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
