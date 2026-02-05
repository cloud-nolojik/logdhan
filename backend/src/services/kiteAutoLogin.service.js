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

      // Step 4: Follow redirect to get request_token
      console.log('[KITE AUTO-LOGIN] Step 4: Getting request_token...');
      const finalResp = await client.get(loginPageUrl, {
        maxRedirects: 5,
        validateStatus: () => true
      });

      // Extract request_token from redirect URL
      let requestToken = null;
      const responseUrl = finalResp.request?.res?.responseUrl || finalResp.headers?.location;

      if (responseUrl && responseUrl.includes('request_token')) {
        const url = new URL(responseUrl);
        requestToken = url.searchParams.get('request_token');
      }

      if (!requestToken) {
        throw new Error('Failed to get request_token from redirect');
      }
      console.log('[KITE AUTO-LOGIN] Step 4 complete. Got request_token.');

      // Step 5: Exchange request_token for access_token
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
      const session = await this.saveSession(sessionData);

      const durationMs = Date.now() - startTime;
      console.log(`[KITE AUTO-LOGIN] Login successful! Duration: ${durationMs}ms`);

      // Log successful login
      await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.LOGIN, {
        kiteUserId: this.userId,
        status: 'SUCCESS',
        response: { user_name: sessionData.user_name, email: sessionData.email },
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
      const resp = await axios.get(`${this.baseUrl}/user/profile`, {
        headers: {
          'Authorization': `token ${this.apiKey}:${accessToken}`,
          'X-Kite-Version': '3'
        }
      });

      return resp.status === 200 && resp.data?.data?.user_id;
    } catch (error) {
      console.log('[KITE] Token validation failed:', error.message);
      return false;
    }
  }

  /**
   * Get a valid session, auto-login if needed
   */
  async getValidSession() {
    try {
      // Try to get existing session
      const session = await KiteSession.findOne({ kite_user_id: this.userId });

      if (session && session.is_valid && session.access_token) {
        // Check if token is still valid
        const isValid = await this.validateToken(session.access_token);

        if (isValid) {
          // Update validation timestamp
          session.last_validated_at = new Date();
          session.validation_count += 1;
          await session.save();

          console.log('[KITE] Using existing valid session');
          return session;
        }

        console.log('[KITE] Existing token is invalid/expired');
      }

      // Token invalid or expired - perform auto login
      console.log('[KITE] Performing auto login...');
      return await this.performAutoLogin();

    } catch (error) {
      console.error('[KITE] Failed to get valid session:', error.message);
      throw error;
    }
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
   * Make authenticated API request to Kite
   */
  async makeRequest(method, endpoint, data = null, retryCount = 0) {
    try {
      const headers = await this.getAuthHeaders();

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
      return response.data;

    } catch (error) {
      // Check if token expired (403 or token error)
      if (error.response?.status === 403 || error.response?.data?.error_type === 'TokenException') {
        if (retryCount < kiteConfig.MAX_RETRIES) {
          console.log('[KITE] Token expired, refreshing...');

          // Mark session as expired
          await KiteSession.findOneAndUpdate(
            { kite_user_id: this.userId },
            { is_valid: false, connection_status: 'expired' }
          );

          // Retry with new token
          return this.makeRequest(method, endpoint, data, retryCount + 1);
        }
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
   * Get holdings
   */
  async getHoldings() {
    return this.makeRequest('GET', kiteConfig.ENDPOINTS.HOLDINGS);
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

    // Perform new login
    return this.performAutoLogin();
  }
}

// Export singleton instance
const kiteAutoLoginService = new KiteAutoLoginService();
export default kiteAutoLoginService;
