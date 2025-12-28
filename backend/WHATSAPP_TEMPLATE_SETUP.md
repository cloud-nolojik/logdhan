# WhatsApp Template Setup for Bulk Analysis Notifications

## Overview
This document describes how to set up the WhatsApp Business template for bulk analysis availability notifications.

## Template Details

### Template Name
`bulk_analysis_available`

### Template Category
**UTILITY** (transactional notifications)

### Template Language
English (en)

### Template Content

**Header:** None (optional)

**Body:**
```
Hello {{1}}! 📊

Your daily bulk stock analysis is now ready and available in the LogDhan app at {{2}}.

✅ Comprehensive AI analysis for multiple stocks
✅ Entry/exit triggers with risk-reward ratios
✅ Educational insights for learning purposes

⚠️ IMPORTANT: This is educational content only, not investment advice.

Open the app to view your analysis now!
```

**Footer:**
```
LogDhan - Educational Trading Tools
```

**Buttons:** None (optional)

### Template Variables

1. `{{1}}` - **userName**: User's name or email prefix
2. `{{2}}` - **time**: Time when analysis becomes available (e.g., "4:00 PM")

### Example Output

```
Hello Rahul! 📊

Your daily bulk stock analysis is now ready and available in the SwingSetups app at 4:00 PM.

✅ Comprehensive AI analysis for multiple stocks
✅ Entry/exit triggers with risk-reward ratios
✅ Educational insights for learning purposes

⚠️ IMPORTANT: This is educational content only, not investment advice.

Open the app to view your analysis now!

---
LogDhan - Educational Trading Tools
```

## Setup Instructions

### 1. Log in to Infobip Dashboard
Go to https://portal.infobip.com and log in with your credentials.

### 2. Navigate to WhatsApp Templates
1. Click on **Channels & Numbers**
2. Select **WhatsApp**
3. Click on **Templates** or **Message Templates**

### 3. Create New Template
1. Click **Create Template** or **New Template**
2. Fill in the details:
   - **Template Name**: `bulk_analysis_available`
   - **Category**: `UTILITY`
   - **Language**: English (en)
   - **Header**: Skip (not required)
   - **Body**: Copy the body text above
   - **Footer**: `LogDhan - Educational Trading Tools`
   - **Buttons**: Skip (not required)

### 4. Define Variables
Make sure to mark the placeholders:
- `{{1}}` for userName
- `{{2}}` for time

### 5. Submit for Approval
1. Review the template
2. Submit to Meta (Facebook) for approval
3. Wait for approval (typically 1-24 hours)

### 6. Get Template ID
Once approved:
1. Note down the template name: `bulk_analysis_available`
2. The template will be available for use via the Infobip API

## Code Implementation

The template is already implemented in the codebase:

### File: `src/services/messaging/messaging.service.js`

```javascript
async sendBulkAnalysisAvailable(mobileNumber, notificationData) {
    return await this.infobipProvider.sendMessage({
        to: mobileNumber,
        templateName: 'bulk_analysis_available',
        templateData: {
            userName: notificationData.userName || 'User',
            time: notificationData.time || '4:00 PM'
        }
    });
}
```

### File: `src/services/agendaBulkAnalysisNotificationService.js`

The service automatically:
- Runs daily at 4:00 PM IST
- Fetches all active users with mobile numbers
- Sends notifications in batches of 10 with 2-second delays
- Logs success/failure for each notification

## Testing

### Manual Trigger (for testing)

**Endpoint:** `POST /api/v1/monitoring/bulk-notification/trigger`

**Authentication:** Required (Bearer token)

**Example:**
```bash
curl -X POST https://api.logdhan.com/api/v1/monitoring/bulk-notification/trigger \
  -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
  -H "Content-Type: application/json"
```

**Response:**
```json
{
    "success": true,
    "message": "Bulk analysis notification job triggered successfully",
    "timestamp": "2025-01-08T12:00:00.000Z"
}
```

### Check Job Status

**Endpoint:** `GET /api/v1/monitoring/bulk-notification/status`

**Authentication:** Required (Bearer token)

**Example:**
```bash
curl -X GET https://api.logdhan.com/api/v1/monitoring/bulk-notification/status \
  -H "Authorization: Bearer YOUR_AUTH_TOKEN"
```

**Response (After Sending Notifications):**
```json
{
    "success": true,
    "data": {
        "status": "scheduled",
        "nextRunAt": "2025-01-08T11:30:00.000Z",
        "lastRunAt": "2025-01-07T11:30:00.000Z",
        "lastFinishedAt": "2025-01-07T11:32:15.000Z",
        "data": {
            "lastRun": "2025-01-07T11:32:15.000Z",
            "skipped": false,
            "success": 150,
            "failed": 2,
            "total": 152
        }
    },
    "timestamp": "2025-01-08T10:00:00.000Z"
}
```

**Response (After Skipping on Holiday/Weekend):**
```json
{
    "success": true,
    "data": {
        "status": "scheduled",
        "nextRunAt": "2025-01-13T11:30:00.000Z",
        "lastRunAt": "2025-01-12T11:30:00.000Z",
        "lastFinishedAt": "2025-01-12T11:30:05.000Z",
        "data": {
            "lastRun": "2025-01-12T11:30:00.000Z",
            "skipped": true,
            "reason": "non_trading_day",
            "message": "Notification skipped - today is a holiday or weekend"
        }
    },
    "timestamp": "2025-01-13T10:00:00.000Z"
}
```

## Monitoring & Logs

### Server Logs

The service provides comprehensive logging:

**On Trading Days:**
```
✅ [BULK ANALYSIS NOTIFICATION] Agenda service initialized successfully
✅ [BULK ANALYSIS NOTIFICATION] Scheduled daily 4 PM notification job
📱 [BULK ANALYSIS NOTIFICATION] Starting to send notifications to all users
✅ [BULK ANALYSIS NOTIFICATION] Today is a trading day - proceeding with notifications
📱 [BULK ANALYSIS NOTIFICATION] Found 150 users with mobile numbers
📱 [BULK ANALYSIS NOTIFICATION] Processing batch 1 (10 users)
✅ [BULK ANALYSIS NOTIFICATION] Sent to +919876543210 (Rahul)
✅ [BULK ANALYSIS NOTIFICATION] Job completed in 32450ms
📊 [BULK ANALYSIS NOTIFICATION] Success: 148, Failed: 2, Total: 150
```

**On Non-Trading Days (Holidays/Weekends):**
```
📱 [BULK ANALYSIS NOTIFICATION] Starting to send notifications to all users
⏭️  [BULK ANALYSIS NOTIFICATION] Skipping notification - today is not a trading day (holiday/weekend)
```

### Error Handling

The service handles errors gracefully:
- If Infobip provider is not initialized, warns but doesn't crash
- Logs individual failures without stopping the batch
- Stores error details in job data for debugging
- Continues with next batch even if one fails

## Environment Variables

Ensure these are set in your `.env` file:

```env
INFOBIP_API_KEY=your_api_key_here
INFOBIP_BASE_URL=https://api.infobip.com
INFOBIP_FROM_NUMBER=your_whatsapp_number_here
INFOBIP_WEBHOOK_URL=https://api.logdhan.com/api/v1/webhook/infobip
```

## Scheduled Job Details

- **Cron Pattern**: `0 16 * * *` (every day at 4:00 PM)
- **Timezone**: `Asia/Kolkata` (IST)
- **Trading Day Check**: Automatically skips notifications on holidays and weekends
- **Collection**: `bulk_analysis_notification_jobs` in MongoDB
- **Process Interval**: Every 1 minute
- **Max Concurrency**: 10 jobs

### Trading Day Verification

The service automatically checks if the current day is a trading day before sending notifications:

```javascript
// Check if today is a trading day using MarketTiming database
const isTradingDay = await MarketHoursUtil.isTradingDay(today);

if (!isTradingDay) {
    console.log(`⏭️  [BULK ANALYSIS NOTIFICATION] Skipping notification - today is not a trading day`);
    // Job is marked as skipped with reason
    return;
}
```

**Benefits:**
- No notifications on weekends (Saturday, Sunday)
- No notifications on NSE/BSE holidays
- Uses MarketTiming database for accurate holiday checking
- Skipped jobs are logged with reason for tracking

## Rate Limiting

To avoid hitting Infobip rate limits:
- **Batch Size**: 10 users per batch
- **Batch Delay**: 2 seconds between batches
- **Parallel Processing**: Within each batch only

Example: For 100 users, it takes ~20 seconds (10 batches × 2 seconds)

## Compliance & Best Practices

### Educational Purpose Disclaimer
The template includes:
> ⚠️ IMPORTANT: This is educational content only, not investment advice.

This ensures SEBI compliance and user awareness.

### User Consent
Only users who have:
- Provided their mobile number
- Are marked as active (`isActive: { $ne: false }`)

will receive notifications.

### Opt-out
Users can disable WhatsApp notifications in their profile settings.

## Troubleshooting

### Template Not Approved
- Check Meta's template policies
- Ensure template follows WhatsApp Business guidelines
- Remove any promotional language
- Keep it transactional/utility focused

### Messages Not Sending
1. Check Infobip API key is valid
2. Verify WhatsApp number is registered
3. Check template is approved
4. Review server logs for errors
5. Test with manual trigger endpoint

### Rate Limit Errors
- Increase `BATCH_DELAY` in service configuration
- Decrease `BATCH_SIZE`
- Contact Infobip support for rate limit increase

## Support

For issues or questions:
- **Email**: support@nolojik.com
- **Infobip Support**: https://www.infobip.com/support
