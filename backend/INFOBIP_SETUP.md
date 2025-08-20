# Infobip WhatsApp OTP Integration Setup

## Overview
LogDhan backend now supports Infobip WhatsApp API for OTP verification. This provides a more reliable and scalable messaging solution.

## Environment Variables

Add these variables to your `.env` file:

```env
# Infobip WhatsApp Configuration
INFOBIP_API_KEY=your_infobip_api_key_here
INFOBIP_BASE_URL=nmjz82.api.infobip.com
INFOBIP_FROM_NUMBER=441134960000
INFOBIP_WEBHOOK_URL=https://yourdomain.com/api/webhooks/infobip

# Optional: OTP Configuration
OTP_VALIDITY_MINUTES=10
APP_NAME=LogDhan
```

## Required Setup Steps

### 1. Infobip Account Setup
1. Create an account at [Infobip](https://www.infobip.com/)
2. Get your API key from the dashboard
3. Note your base URL (e.g., `nmjz82.api.infobip.com`)
4. Configure your WhatsApp Business number

### 2. WhatsApp Template Creation
Create a template in Infobip dashboard with these specifications:

**Template Name:** `logdhan_otp_verification`
**Language:** `en_GB`
**Category:** `AUTHENTICATION`

**Template Content:**
```
Your LogDhan verification code is {{1}}. This code will expire in 10 minutes. Do not share this code with anyone.

For support, contact: logdhan-help@nolojik.com
```

**Placeholders:**
- `{{1}}` - OTP code (6 digits)

### 3. API Configuration
The system will automatically:
- Use Infobip as primary provider if configured
- Fallback to Meta WhatsApp API if Infobip fails
- Disable OTP sending if no provider is configured (development mode)

## Testing

### 1. Test OTP Sending
```bash
curl -X POST http://localhost:3000/api/auth/send-otp \
  -H "Content-Type: application/json" \
  -d '{"mobileNumber": "919999999999"}'
```

### 2. Test OTP Verification
```bash
curl -X POST http://localhost:3000/api/auth/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"mobileNumber": "919999999999", "otp": "123456"}'
```

## Phone Number Format
- Input: `919999999999` (12 digits without +)
- Infobip API: `+919999999999` (automatically formatted)

## Error Handling
- Invalid template: Template not found error
- API failures: Logged but don't block user registration
- Network issues: Graceful fallback to development mode

## Monitoring
Check server logs for:
- `✅ Infobip WhatsApp provider initialized as default`
- `✅ OTP sent successfully to {number}`
- `❌ Failed to send OTP via messaging service: {error}`

## Security Considerations
1. Store API keys securely in environment variables
2. Use HTTPS for webhook URLs
3. Validate webhook signatures (if implementing webhooks)
4. Monitor API usage and rate limits
5. Implement phone number validation and spam protection

## Cost Optimization
- Infobip charges per message sent
- Monitor usage through Infobip dashboard
- Implement rate limiting for OTP requests
- Consider SMS fallback for cost-sensitive scenarios

## Webhook Integration (Optional)
To track delivery status, implement webhook endpoint:

```javascript
// /api/webhooks/infobip
router.post('/infobip', (req, res) => {
  const { messageId, status, timestamp } = req.body;
  // Log delivery status
  console.log(`Message ${messageId} status: ${status} at ${timestamp}`);
  res.status(200).send('OK');
});
```

## Support
For Infobip-specific issues:
- Check Infobip documentation: https://www.infobip.com/docs
- Contact Infobip support
- Review API logs in Infobip dashboard

For LogDhan integration issues:
- Check server logs
- Verify environment variables
- Test with development mode (OTP in console)