# Testing Bulk Analysis Notifications

This guide explains how to test the bulk analysis notification system.

## Overview

The bulk analysis notification system:
- Creates in-app notifications for all active users
- Sends Firebase push notifications to user devices
- Runs automatically daily at 5:00 PM IST (on trading days only)
- Can be manually triggered for testing

## Prerequisites

1. Backend server running (`npm start`)
2. Valid authentication token
3. At least one registered user in the database

## Test Script

We've created a convenient test script that triggers notifications and checks status.

### Quick Start

```bash
# Navigate to backend directory
cd /Users/nolojik/Documents/swingsetups/backend

# Option 1: Pass auth token as argument
node test-bulk-notification.js "your-auth-token-here"

# Option 2: Set token in .env file
# Add to .env: TEST_AUTH_TOKEN=your-auth-token-here
node test-bulk-notification.js
```

### Getting an Auth Token

1. **From Mobile App:**
   - Login to the app
   - Check app logs for auth token
   - Or use developer tools to inspect network requests

2. **From Backend:**
   - Login via API: `POST /api/v1/auth/verify-otp`
   - Response contains the token

3. **Using curl:**
```bash
# Send OTP
curl -X POST http://localhost:5650/api/v1/auth/send-otp \
  -H "Content-Type: application/json" \
  -d '{"mobileNumber": "+919876543210"}'

# Verify OTP and get token
curl -X POST http://localhost:5650/api/v1/auth/verify-otp \
  -H "Content-Type: application/json" \
  -d '{
    "mobileNumber": "+919876543210",
    "otp": "123456",
    "fcmToken": ""
  }'
```

## Manual Testing with cURL

### 1. Trigger Notification

```bash
curl -X POST http://localhost:5650/api/v1/monitoring/bulk-notification/trigger \
  -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
  -H "Content-Type: application/json"
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Bulk analysis notification job triggered successfully",
  "timestamp": "2025-01-08T12:00:00.000Z"
}
```

### 2. Check Status

```bash
curl -X GET http://localhost:5650/api/v1/monitoring/bulk-notification/status \
  -H "Authorization: Bearer YOUR_AUTH_TOKEN"
```

**Expected Response:**
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

## What to Expect

### Backend Logs

When you trigger the notification, you should see:

```
🚀 [BULK ANALYSIS NOTIFICATION] Manual trigger requested
📱 [BULK ANALYSIS NOTIFICATION] Starting to send notifications to all users
✅ [BULK ANALYSIS NOTIFICATION] Today is a trading day - proceeding with notifications
📱 [BULK ANALYSIS NOTIFICATION] Found 10 active users
📱 [BULK ANALYSIS NOTIFICATION] Processing batch 1 (10 users)
✅ [BULK ANALYSIS NOTIFICATION] Sent to user@email.com (UserName)
✅ [BULK ANALYSIS NOTIFICATION] Job completed in 2450ms
📊 [BULK ANALYSIS NOTIFICATION] Success: 10, Failed: 0, Total: 10
```

### On Non-Trading Days (Weekends/Holidays)

```
📱 [BULK ANALYSIS NOTIFICATION] Starting to send notifications to all users
⏭️  [BULK ANALYSIS NOTIFICATION] Skipping notification - today is not a trading day (holiday/weekend)
```

### Mobile App

1. **Push Notification:**
   - Title: "Bulk Analysis Available"
   - Body: "Hello {UserName}! Your daily bulk stock analysis is now ready at 5:00 PM."
   - Tapping navigates to bulk analysis screen

2. **In-App Notification:**
   - Appears in Notifications screen
   - Type: "alert"
   - Can be filtered by "Alerts"
   - Clicking navigates to bulk analysis

## Database Verification

Check if notifications were created in MongoDB:

```javascript
// MongoDB Shell
use logdhan

// Find recent notifications
db.notifications.find({
  type: 'alert',
  title: 'Bulk Analysis Available'
}).sort({ createdAt: -1 }).limit(10)

// Count notifications
db.notifications.countDocuments({
  type: 'alert',
  title: 'Bulk Analysis Available'
})

// Check specific user's notifications
db.notifications.find({
  user: ObjectId('YOUR_USER_ID'),
  type: 'alert'
})
```

## Troubleshooting

### No Notifications Sent

1. **Check if backend is running:**
   ```bash
   curl http://localhost:5650/api/v1/monitoring/health
   ```

2. **Check if users exist:**
   - Verify active users in database
   - Ensure users have `isActive: true` or not set to `false`

3. **Check logs:**
   - Look for error messages in backend console
   - Check if Firebase service is initialized

### Firebase Push Not Received

1. **Check FCM tokens:**
   - User must have logged in and FCM token registered
   - Check User model: `fcmTokens` array should have tokens

2. **Check Firebase credentials:**
   - Verify `logdhan-6ea73-firebase-adminsdk-fbsvc-e04bf48534.json` exists
   - Check Firebase Admin SDK is initialized

3. **Check app:**
   - App must be installed
   - Notification permissions granted
   - FCM service is running

### In-App Notification Not Showing

1. **Check notification API:**
   ```bash
   curl -X GET http://localhost:5650/api/v1/notifications \
     -H "Authorization: Bearer YOUR_AUTH_TOKEN"
   ```

2. **Check notification type:**
   - Should be type: `'alert'`
   - Filter by "Alerts" in app

3. **Refresh notifications:**
   - Pull to refresh in Notifications screen
   - Or restart the app

## Testing on Production

```bash
# Change API_BASE_URL to production
export API_BASE_URL=https://api.logdhan.com

# Use production auth token
node test-bulk-notification.js "production-auth-token"
```

## Automated Testing Schedule

The system automatically runs daily at:
- **Time:** 5:00 PM IST (17:00)
- **Days:** Trading days only (Mon-Fri, excluding holidays)
- **Timezone:** Asia/Kolkata
- **Cron:** `0 17 * * *`

## Additional Notes

- Notifications expire after 7 days (TTL index)
- Failed tokens are automatically cleaned up from user records
- Batch processing: 10 users per batch, 2-second delay between batches
- Rate limiting is applied to avoid Firebase/MongoDB overload

## Support

For issues or questions:
- Check backend logs: `/var/log/logdhan/` or console output
- Review notification model: `backend/src/models/notification.js`
- Review notification service: `backend/src/services/agendaBulkAnalysisNotificationService.js`
