import axios from 'axios';
import { generateSync as generateTOTP } from 'otplib';
import crypto from 'crypto';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import KiteSession from '../models/kiteSession.js';
import KiteAuditLog from '../models/kiteAuditLog.js';
import kiteConfig from '../config/kite.config.js';

/**
 * KiteAutoLoginService
 * Handles fully automated login to Kite Connect using TOTP.
 * No manual intervention required.
 */
class KiteAutoLoginService {
  constructor() {
    this.apiKey = kiteConfig.API_KEY;
    this.apiSecret = kiteConfig.API_SECRET;
    this.userId = kiteConfig.USER_ID;
    this.password = kiteConfig.PASSWORD;
    this.totpSecret = kiteConfig.TOTP_SECRET;
    this.baseUrl = kiteConfig.BASE_URL;
    this.kiteWebUrl = kiteConfig.KITE_WEB_URL;

    // Dedup guard: concurrent callers share a single login attempt
    this._loginPromise = null;
  }

  /**
   * Perform full automated login flow
   * 1. POST login credentials
   * 2. POST 2FA TOTP
   * 3. Get request_token
   * 4. Exchange for access_token
   */
  async performAutoLogin() {
    const startTime = Date.now();
    console.log('[KITE AUTO-LOGIN] Starting automated login...');

    try {
      // Create axios client with cookie jar for session management
      const jar = new CookieJar();
      const client = wrapper(axios.create({
        jar,
        withCredentials: true,
        maxRedirects: 0, // Handle redirects manually
        validateStatus: (status) => status < 400 || status === 302
      }));

      // Step 1: Get the login page to establish session
      const loginPageUrl = `${this.kiteWebUrl}/connect/login?v=3&api_key=${this.apiKey}`;
      console.log('[KITE AUTO-LOGIN] Step 1: Fetching login page...');
      await client.get(loginPageUrl);

      // Step 2: POST login credentials
      console.log('[KITE AUTO-LOGIN] Step 2: Submitting login credentials...');
      const loginResp = await client.post(
        `${this.kiteWebUrl}/api/login`,
        new URLSearchParams({
          user_id: this.userId,
          password: this.password
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      if (!loginResp.data?.data?.request_id) {
        throw new Error(`Login failed: ${JSON.stringify(loginResp.data)}`);
      }

      const requestId = loginResp.data.data.request_id;
      console.log('[KITE AUTO-LOGIN] Step 2 complete. Got request_id.');

      // Step 3: Generate TOTP and POST 2FA
      console.log('[KITE AUTO-LOGIN] Step 3: Submitting 2FA TOTP...');
      const totp = generateTOTP({ secret: this.totpSecret });
      console.log(`[KITE AUTO-LOGIN] Generated TOTP: ${totp} (length: ${totp.length})`);

      try {
        const twofaResp = await client.post(
          `${this.kiteWebUrl}/api/twofa`,
          new URLSearchParams({
            user_id: this.userId,
            request_id: requestId,
            twofa_value: totp
          }),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          }
        );

        console.log('[KITE AUTO-LOGIN] 2FA Response:', JSON.stringify(twofaResp.data));

        if (twofaResp.data?.status !== 'success') {
          throw new Error(`2FA failed: ${JSON.stringify(twofaResp.data)}`);
        }
        console.log('[KITE AUTO-LOGIN] Step 3 complete. 2FA successful.');
      } catch (twofaError) {
        console.log('[KITE AUTO-LOGIN] 2FA Error:', twofaError.message);
        if (twofaError.response) {
          console.log('[KITE AUTO-LOGIN] 2FA Error Response:', JSON.stringify(twofaError.response.data));
          console.log('[KITE AUTO-LOGIN] 2FA Error Status:', twofaError.response.status);
        }
        throw twofaError;
      }

      // Step 4: Follow the login page URL again - should redirect to redirect_url with request_token
      // After successful 2FA, the session cookies are set, so visiting the login page
      // should automatically redirect through authorization to the redirect URL
      console.log('[KITE AUTO-LOGIN] Step 4: Following redirect to get request_token...');

      // Use maxRedirects: 10 but we need to catch the redirect to our redirect_url
      // Since our redirect_url might not exist, we'll get an error - but we can extract from it
      let requestToken = null;

      try {
        const finalResp = await client.get(loginPageUrl, {
          maxRedirects: 10,
          validateStatus: () => true
        });

        // Check final URL
        const finalUrl = finalResp.request?.res?.responseUrl;
        console.log('[KITE AUTO-LOGIN] Step 4 - Final URL:', finalUrl);
        console.log('[KITE AUTO-LOGIN] Step 4 - Status:', finalResp.status);

        if (finalUrl && finalUrl.includes('request_token')) {
          const url = new URL(finalUrl);
          requestToken = url.searchParams.get('request_token');
        }

        // Also check Location header in case redirect wasn't followed
        if (!requestToken && finalResp.headers?.location) {
          const locationUrl = finalResp.headers.location;
          console.log('[KITE AUTO-LOGIN] Step 4 - Location header:', locationUrl);
          if (locationUrl.includes('request_token')) {
            const url = new URL(locationUrl);
            requestToken = url.searchParams.get('request_token');
          }
        }

      } catch (redirectError) {
        // If we get an error following redirects (e.g., redirect to non-existent URL),
        // the request_token might be in the error response
        console.log('[KITE AUTO-LOGIN] Step 4 - Redirect error:', redirectError.message);

        if (redirectError.response?.headers?.location) {
          const locationUrl = redirectError.response.headers.location;
          console.log('[KITE AUTO-LOGIN] Step 4 - Error redirect location:', locationUrl);
          if (locationUrl.includes('request_token')) {
            const url = new URL(locationUrl);
            requestToken = url.searchParams.get('request_token');
          }
        }

        if (redirectError.request?.res?.responseUrl) {
          const errorUrl = redirectError.request.res.responseUrl;
          console.log('[KITE AUTO-LOGIN] Step 4 - Error response URL:', errorUrl);
          if (errorUrl.includes('request_token')) {
            const url = new URL(errorUrl);
            requestToken = url.searchParams.get('request_token');
          }
        }
      }

      if (!requestToken) {
        // Last resort: try the finish endpoint
        console.log('[KITE AUTO-LOGIN] Step 4 - Trying /connect/finish endpoint...');

        // First get the authorize page to get sess_id
        const authPageResp = await client.get(loginPageUrl, {
          maxRedirects: 5,
          validateStatus: () => true
        });

        const authPageUrl = authPageResp.request?.res?.responseUrl || authPageResp.headers?.location || '';
        console.log('[KITE AUTO-LOGIN] Step 4 - Auth page URL:', authPageUrl);

        let sessId = null;
        if (authPageUrl.includes('sess_id')) {
          const authUrl = new URL(authPageUrl);
          sessId = authUrl.searchParams.get('sess_id');
        }

        if (sessId) {
          // Try POST to /api/connect/authorize to grant permission
          console.log('[KITE AUTO-LOGIN] Step 4 - Trying POST to /api/connect/authorize...');

          try {
            const authorizeResp = await client.post(
              `${this.kiteWebUrl}/api/connect/authorize`,
              new URLSearchParams({
                api_key: this.apiKey,
                sess_id: sessId,
                action: 'authorize'
              }),
              {
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded'
                }
              }
            );

            console.log('[KITE AUTO-LOGIN] Step 4 - Authorize API response:', JSON.stringify(authorizeResp.data));

            // Check if response contains request_token
            if (authorizeResp.data?.data?.request_token) {
              requestToken = authorizeResp.data.data.request_token;
            } else if (authorizeResp.data?.request_token) {
              requestToken = authorizeResp.data.request_token;
            }

            // If we got a redirect URL in response, extract token from it
            if (!requestToken && authorizeResp.data?.data?.redirect_url) {
              const redirectUrl = authorizeResp.data.data.redirect_url;
              console.log('[KITE AUTO-LOGIN] Step 4 - Redirect URL from API:', redirectUrl);
              if (redirectUrl.includes('request_token')) {
                const url = new URL(redirectUrl);
                requestToken = url.searchParams.get('request_token');
              }
            }

          } catch (authorizeError) {
            console.log('[KITE AUTO-LOGIN] Step 4 - Authorize API error:', authorizeError.message);
            if (authorizeError.response?.data) {
              console.log('[KITE AUTO-LOGIN] Step 4 - Authorize API error response:', JSON.stringify(authorizeError.response.data));
            }

            // Try finish endpoint as fallback
            const finishUrl = `${this.kiteWebUrl}/connect/finish?api_key=${this.apiKey}&sess_id=${sessId}`;
            console.log('[KITE AUTO-LOGIN] Step 4 - Finish URL:', finishUrl);

            try {
              const finishResp = await client.get(finishUrl, {
                maxRedirects: 10,
                validateStatus: () => true
              });

              const finishFinalUrl = finishResp.request?.res?.responseUrl;
              console.log('[KITE AUTO-LOGIN] Step 4 - Finish final URL:', finishFinalUrl);

              if (finishFinalUrl && finishFinalUrl.includes('request_token')) {
                const url = new URL(finishFinalUrl);
                requestToken = url.searchParams.get('request_token');
              }

              if (!requestToken && finishResp.headers?.location?.includes('request_token')) {
                const url = new URL(finishResp.headers.location);
                requestToken = url.searchParams.get('request_token');
              }
            } catch (finishError) {
              console.log('[KITE AUTO-LOGIN] Step 4 - Finish error:', finishError.message);
            }
          }
        }
      }

      if (!requestToken) {
        throw new Error('Failed to get request_token after all attempts');
      }
      console.log('[KITE AUTO-LOGIN] Step 4 complete. Got request_token.');

      // Step 5: Exchange request_token for access_token
      // IMPORTANT: If Step 4 followed the redirect to our own /api/kite/auth/callback,
      // that callback already exchanged the request_token (they're single-use on Kite).
      // Check if a valid session was saved by the callback before trying to exchange again.
      const SESSION_FRESHNESS_MS = 30_000; // 30 seconds — callback exchange should complete well within this
      let session;
      const existingSession = await KiteSession.findOne({
        kite_user_id: this.userId,
        is_valid: true,
        access_token: { $exists: true, $ne: null }
      }).sort({ token_created_at: -1 });

      if (existingSession && existingSession.token_created_at &&
          (Date.now() - existingSession.token_created_at.getTime()) < SESSION_FRESHNESS_MS) {
        // Session was saved within the last 30 seconds — callback already exchanged the token
        console.log('[KITE AUTO-LOGIN] Step 5: Skipped — token already exchanged by OAuth callback');
        session = existingSession;
      } else {
        // Callback didn't exchange it — do it ourselves
        console.log('[KITE AUTO-LOGIN] Step 5: Exchanging for access_token...');
        const checksum = crypto.createHash('sha256')
          .update(this.apiKey + requestToken + this.apiSecret)
          .digest('hex');

        const sessionResp = await axios.post(
          `${this.baseUrl}/session/token`,
          new URLSearchParams({
            api_key: this.apiKey,
            request_token: requestToken,
            checksum: checksum
          }),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-Kite-Version': '3'
            }
          }
        );

        if (!sessionResp.data?.data?.access_token) {
          throw new Error(`Token exchange failed: ${JSON.stringify(sessionResp.data)}`);
        }

        const sessionData = sessionResp.data.data;
        console.log('[KITE AUTO-LOGIN] Step 5 complete. Got access_token.');

        // Save session to database
        session = await this.saveSession(sessionData);
      }

      const durationMs = Date.now() - startTime;
      console.log(`[KITE AUTO-LOGIN] Login successful! Duration: ${durationMs}ms`);

      // Log successful login
      await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.LOGIN, {
        kiteUserId: this.userId,
        status: 'SUCCESS',
        response: { user_name: session.user_name, email: session.email },
        durationMs,
        source: 'AUTO'
      });

      return session;

    } catch (error) {
      const durationMs = Date.now() - startTime;
      console.error('[KITE AUTO-LOGIN] Login failed:', error.message);

      // Log failed login
      await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.LOGIN_FAILED, {
        kiteUserId: this.userId,
        status: 'FAILED',
        error: error.message,
        durationMs,
        source: 'AUTO'
      });

      // Update session with error
      await KiteSession.findOneAndUpdate(
        { kite_user_id: this.userId },
        {
          is_valid: false,
          connection_status: 'error',
          last_login_error: error.message,
          updated_at: new Date()
        },
        { upsert: true }
      );

      throw error;
    }
  }

  /**
   * Save session data to database
   */
  async saveSession(sessionData) {
    const session = await KiteSession.findOneAndUpdate(
      { kite_user_id: this.userId },
      {
        access_token: sessionData.access_token,
        public_token: sessionData.public_token,
        user_name: sessionData.user_name,
        email: sessionData.email,
        user_type: sessionData.user_type,
        is_valid: true,
        connection_status: 'connected',
        token_created_at: new Date(),
        token_expiry: this.getNextExpiry(),
        last_login_at: new Date(),
        last_login_error: null,
        $inc: { login_count: 1 },
        updated_at: new Date()
      },
      { upsert: true, new: true }
    );

    return session;
  }

  /**
   * Validate existing token by making a profile API call
   */
  async validateToken(accessToken) {
    try {
      console.log('[KITE] validateToken: Making profile API call...');
      const resp = await axios.get(`${this.baseUrl}/user/profile`, {
        headers: {
          'Authorization': `token ${this.apiKey}:${accessToken}`,
          'X-Kite-Version': '3'
        }
      });

      console.log('[KITE] validateToken: Response status:', resp.status);
      console.log('[KITE] validateToken: user_id in response:', resp.data?.data?.user_id || 'none');
      return resp.status === 200 && resp.data?.data?.user_id;
    } catch (error) {
      console.log('[KITE] Token validation failed:', error.message);
      if (error.response) {
        console.log('[KITE] Token validation error status:', error.response.status);
        console.log('[KITE] Token validation error data:', JSON.stringify(error.response.data));
      }
      return false;
    }
  }

  /**
   * Get a valid session, auto-login if needed.
   *
   * DESIGN: The 6 AM token refresh job already performs a full login and saves
   * a valid token to the DB. That token is good until 6 AM next day. So during
   * market hours (9:15-15:30) we just trust whatever is in the DB — no profile
   * API validation call. If the token happens to be bad, the actual API call
   * in makeRequest() will get a 403, and ONLY THEN do we trigger auto-login.
   *
   * This eliminates the race condition where a profile-validation call succeeds
   * but the real API call fails because a concurrent login overwrote the token.
   */
  async getValidSession() {
    try {
      const session = await KiteSession.findOne({ kite_user_id: this.userId });
      console.log(`[KITE] getValidSession: found=${!!session}, is_valid=${session?.is_valid}, has_token=${!!session?.access_token}, expiry=${session?.token_expiry?.toISOString() || 'none'}`);

      if (session && session.is_valid && session.access_token) {
        // Check token_expiry (6 AM IST next day). If past expiry, don't use it.
        if (session.token_expiry && session.token_expiry > new Date()) {
          console.log('[KITE] getValidSession: Using existing DB token (not expired)');
          return session;
        }
        console.log('[KITE] Token past expiry, need fresh login');
      }

      // No valid session in DB — need auto login
      console.log('[KITE] getValidSession: No valid token in DB, triggering auto-login');
      return await this._doAutoLogin();

    } catch (error) {
      console.error('[KITE] Failed to get valid session:', error.message);
      throw error;
    }
  }

  /**
   * Dedup-guarded auto login. Multiple concurrent callers share a single
   * login attempt so we never generate two access_tokens that clobber each other.
   */
  async _doAutoLogin() {
    if (this._loginPromise) {
      console.log('[KITE] _doAutoLogin: login already in progress — waiting for existing attempt...');
      const session = await this._loginPromise;
      console.log(`[KITE] _doAutoLogin: existing attempt finished, got token=...${session?.access_token?.slice(-6) || 'none'}`);
      return session;
    }

    console.log('[KITE] _doAutoLogin: starting new auto login...');
    this._loginPromise = this.performAutoLogin().finally(() => {
      this._loginPromise = null;
    });
    const session = await this._loginPromise;
    console.log(`[KITE] _doAutoLogin: login complete, got token=...${session?.access_token?.slice(-6) || 'none'}`);
    return session;
  }

  /**
   * Get authorization headers for Kite API calls
   */
  async getAuthHeaders() {
    const session = await this.getValidSession();

    return {
      'Authorization': `token ${this.apiKey}:${session.access_token}`,
      'X-Kite-Version': '3'
    };
  }

  /**
   * Make authenticated API request to Kite.
   *
   * On 403 / TokenException: invalidate the stale token, auto-login ONCE,
   * and retry the request with the fresh token. No exponential retries —
   * each retry was triggering a full login, and concurrent logins clobber
   * each other on Kite (new access_token kills the old one).
   */
  async makeRequest(method, endpoint, data = null, isRetry = false, throttleAttempt = 0) {
    const headers = await this.getAuthHeaders();
    const usedToken = headers['Authorization']?.split(':')[1];
    const tokenSnippet = usedToken ? `...${usedToken.slice(-6)}` : 'none';

    console.log(`[KITE] makeRequest: ${method} ${endpoint} (token=${tokenSnippet}, isRetry=${isRetry}${throttleAttempt > 0 ? `, throttleAttempt=${throttleAttempt}` : ''})`);

    try {
      const config = {
        method,
        url: `${this.baseUrl}${endpoint}`,
        headers
      };

      if (data) {
        if (method.toUpperCase() === 'GET') {
          config.params = data;
        } else {
          config.data = new URLSearchParams(data);
          config.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
      }

      const response = await axios(config);
      console.log(`[KITE] makeRequest: ${method} ${endpoint} → ${response.status} OK${throttleAttempt > 0 ? ` (after ${throttleAttempt} 429-retry)` : ''}`);
      return response.data;

    } catch (error) {
      const status = error.response?.status;
      const errorType = error.response?.data?.error_type;
      const errorMessage = error.response?.data?.message || error.message;
      console.log(`[KITE] makeRequest: ${method} ${endpoint} → FAILED status=${status} error_type=${errorType} msg=${errorMessage}`);

      // ── 2026-06-05: 429 retry-with-backoff safety net ─────────────────────
      // The getIntradayMultiCandles concurrency cap (3 req/sec) prevents most
      // 429s up-front, but Kite occasionally bursts on its end — a singleton
      // request can still get throttled if it lands while another caller is
      // mid-burst. Retry up to 3 times with exponential backoff 500ms, 1s, 2s.
      // The token-expiry retry above is independent — both can fire (but each
      // independently caps at one retry, so total ≤ 4 attempts).
      const isRateLimited = status === 429 ||
                            errorType === 'NetworkException' && /too many requests/i.test(errorMessage);
      if (isRateLimited && throttleAttempt < 3) {
        const backoffMs = 500 * Math.pow(2, throttleAttempt);   // 500, 1000, 2000
        console.warn(`[KITE] 429/too-many-requests on ${endpoint} — backing off ${backoffMs}ms (attempt ${throttleAttempt + 1}/3)`);
        await new Promise(r => setTimeout(r, backoffMs));
        return this.makeRequest(method, endpoint, data, isRetry, throttleAttempt + 1);
      }

      // Only retry on actual token expiry — NOT on PermissionException (which is permanent)
      const isTokenExpired = errorType === 'TokenException' ||
                             (status === 403 && errorType !== 'PermissionException');

      if (isTokenExpired && !isRetry) {
        console.log(`[KITE] Token expired on API call (token=${tokenSnippet}), invalidating and re-logging in...`);

        // Mark only THIS token as expired (don't clobber a fresh one from another caller)
        const invalidated = await KiteSession.findOneAndUpdate(
          { kite_user_id: this.userId, access_token: usedToken },
          { is_valid: false, connection_status: 'expired' }
        );
        console.log(`[KITE] Token invalidation: ${invalidated ? 'matched & updated' : 'no match (already replaced)'}`);

        // Auto-login once (dedup-guarded), then retry the request exactly once
        await this._doAutoLogin();
        return this.makeRequest(method, endpoint, data, true, throttleAttempt);
      }

      throw error;
    }
  }

  /**
   * Get user profile
   */
  async getProfile() {
    return this.makeRequest('GET', kiteConfig.ENDPOINTS.PROFILE);
  }

  /**
   * Get account margins/balance
   */
  async getMargins() {
    return this.makeRequest('GET', kiteConfig.ENDPOINTS.MARGINS);
  }

  /**
   * Get full market quotes (incl. 5-level depth, buy/sell pending totals, OHLC).
   *
   * Kite's /quote expects `i` repeated for each instrument: ?i=NSE:INFY&i=NSE:TCS
   * We build that query string manually because axios' default array serializer
   * produces `i[]=...` which Kite rejects.
   *
   * @param {string[]} instruments - e.g. ['NSE:INFY', 'NSE:ICICIBANK']
   * @returns {Promise<Object>} { status, data: { 'NSE:INFY': {...}, ... } }
   */
  async getQuote(instruments) {
    if (!Array.isArray(instruments) || instruments.length === 0) {
      return { status: 'success', data: {} };
    }
    if (instruments.length > 500) {
      throw new Error(`Kite /quote accepts max 500 instruments per call; got ${instruments.length}`);
    }
    const query = instruments.map(i => `i=${encodeURIComponent(i)}`).join('&');
    const endpoint = `${kiteConfig.ENDPOINTS.QUOTE}?${query}`;
    return this.makeRequest('GET', endpoint);
  }

  /**
   * Get holdings
   */
  async getHoldings() {
    return this.makeRequest('GET', kiteConfig.ENDPOINTS.HOLDINGS);
  }

  /**
   * Fetch OHLCV candles for a single instrument.
   *
   * @param {number} instrumentToken - numeric token from getLTP response
   * @param {string} interval        - '5minute' | '15minute' | 'minute' | 'day' etc.
   * @param {string} from            - ISO or 'YYYY-MM-DD HH:MM:SS' in IST
   * @param {string} to              - ISO or 'YYYY-MM-DD HH:MM:SS' in IST
   * @returns {Promise<Array>}       - array of { date, open, high, low, close, volume }
   */
  async getHistoricalData(instrumentToken, interval, from, to) {
    const endpoint = `${kiteConfig.ENDPOINTS.HISTORICAL}/${instrumentToken}/${interval}`;
    const resp = await this.makeRequest('GET', endpoint, { from, to, oi: 0 });
    const raw = resp?.data?.candles || [];
    // Each candle: [timestamp, open, high, low, close, volume, oi]
    return raw.map(c => ({
      date:   c[0],
      open:   c[1],
      high:   c[2],
      low:    c[3],
      close:  c[4],
      volume: c[5],
    }));
  }

  /**
   * Get positions
   */
  async getPositions() {
    return this.makeRequest('GET', kiteConfig.ENDPOINTS.POSITIONS);
  }

  /**
   * Get all orders for the day
   */
  async getOrders() {
    return this.makeRequest('GET', kiteConfig.ENDPOINTS.ORDERS);
  }

  /**
   * Get next token expiry time (6 AM IST)
   */
  getNextExpiry() {
    const now = new Date();
    // IST offset in milliseconds (5 hours 30 minutes)
    const istOffset = 5.5 * 60 * 60 * 1000;

    // Convert current time to IST
    const istNow = new Date(now.getTime() + istOffset);

    // Set to 6 AM IST
    const expiry = new Date(istNow);
    expiry.setHours(6, 0, 0, 0);

    // If current IST time is past 6 AM, set to next day
    if (istNow.getHours() >= 6) {
      expiry.setDate(expiry.getDate() + 1);
    }

    // Convert back to UTC for storage
    return new Date(expiry.getTime() - istOffset);
  }

  /**
   * Check if current session is valid
   */
  async isSessionValid() {
    try {
      const session = await KiteSession.findOne({ kite_user_id: this.userId });

      if (!session || !session.is_valid || !session.access_token) {
        return false;
      }

      // Check if token has expired
      if (session.token_expiry && session.token_expiry < new Date()) {
        return false;
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Force refresh the token
   */
  async forceRefresh() {
    console.log('[KITE] Force refreshing token...');

    // Mark current session as invalid
    await KiteSession.findOneAndUpdate(
      { kite_user_id: this.userId },
      { is_valid: false }
    );

    // Perform new login (dedup-guarded)
    return await this._doAutoLogin();
  }

  /**
   * Exchange request_token for access_token (used by OAuth callback)
   * This is called when the user completes authorization in the browser
   */
  async exchangeToken(requestToken) {
    console.log('[KITE] Exchanging request_token for access_token...');

    try {
      // Generate checksum
      const checksum = crypto.createHash('sha256')
        .update(this.apiKey + requestToken + this.apiSecret)
        .digest('hex');

      // Exchange for access_token
      const sessionResp = await axios.post(
        `${this.baseUrl}/session/token`,
        new URLSearchParams({
          api_key: this.apiKey,
          request_token: requestToken,
          checksum: checksum
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Kite-Version': '3'
          }
        }
      );

      if (!sessionResp.data?.data?.access_token) {
        throw new Error(`Token exchange failed: ${JSON.stringify(sessionResp.data)}`);
      }

      const sessionData = sessionResp.data.data;
      console.log('[KITE] Token exchange successful. User:', sessionData.user_name);

      // Save session to database
      const session = await this.saveSession(sessionData);

      // Log successful token exchange
      await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.LOGIN, {
        kiteUserId: this.userId,
        status: 'SUCCESS',
        response: { user_name: sessionData.user_name, email: sessionData.email },
        source: 'OAUTH'
      });

      return session;

    } catch (error) {
      console.error('[KITE] Token exchange failed:', error.message);

      // Log failed exchange
      await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.LOGIN_FAILED, {
        kiteUserId: this.userId,
        status: 'FAILED',
        error: error.message,
        source: 'OAUTH'
      });

      throw error;
    }
  }
}

// Export singleton instance
const kiteAutoLoginService = new KiteAutoLoginService();
export default kiteAutoLoginService;
