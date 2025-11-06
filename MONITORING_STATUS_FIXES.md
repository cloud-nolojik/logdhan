# Monitoring Status Flow Fixes - Summary

## Overview
Fixed the monitoring status flow to ensure the Android app receives accurate, real-time status updates that match the app's expected format and behavior.

---

## Problems Identified

### Problem 1: Status State Mismatch
**Issue:** Backend was returning internal MonitoringSubscription statuses ('active', 'conditions_met', 'expired') without mapping to app-expected states.

**Android App Expected States:**
- `'active'` - AI is watching
- `'delayed'` - Delayed start
- `'waiting'` - Waiting for conditions
- `'completed'` - Partially completed
- `'finished'` - Done (conditions met, expired, or cancelled)

**Backend was returning:** Raw internal statuses without proper mapping

---

### Problem 2: Missing Required Fields
**Issue:** Service method wasn't returning all fields Android app expects:
- Missing: `startedAt`, `isPaused`, `pausedReason`
- Missing: `notification_sent_at`
- Inconsistent message formatting

---

### Problem 3: stopMonitoring Didn't Update Subscription
**Issue:** When user stopped monitoring, the `MonitoringSubscription` status wasn't updated to `'cancelled'`, causing status endpoint to return stale data.

**Result:** App would show "monitoring active" even after user clicked "Stop Monitoring"

---

## Solutions Implemented

### Fix 1: Add State Mapping Function

**File:** [backend/src/services/agendaMonitoringService.js](backend/src/services/agendaMonitoringService.js#L800-L819)

```javascript
/**
 * Map MonitoringSubscription status to Android app state
 * Backend status → App state mapping:
 * - 'active' → 'active' (AI is watching, monitoring ongoing)
 * - 'conditions_met' → 'finished' (Alert sent, entry conditions met)
 * - 'expired' → 'finished' (Monitoring expired at 3:30 PM without conditions being met)
 * - 'invalidated' → 'finished' (Setup invalidated)
 * - 'cancelled' → 'finished' (User stopped monitoring)
 */
mapSubscriptionStateToAppState(subscriptionStatus, isExpired = false) {
    const stateMap = {
        'active': 'active',
        'conditions_met': 'finished',
        'expired': 'finished',
        'invalidated': 'finished',
        'cancelled': 'finished'
    };
    return stateMap[subscriptionStatus] || 'finished';
}
```

**Why:** Provides clear, explicit mapping between backend internal states and app UI states.

---

### Fix 2: Enhanced getMonitoringStatus Response

**File:** [backend/src/services/agendaMonitoringService.js](backend/src/services/agendaMonitoringService.js#L821-L963)

**Changes:**
1. Added all required fields for Android app
2. Proper state mapping using `mapSubscriptionStateToAppState()`
3. Context-aware user-friendly messages
4. User subscription tracking with `startedAt` from user's subscription timestamp
5. Added `notification_sent_at` field
6. Proper handling of expired subscriptions

**Example Response (Active Monitoring):**
```javascript
{
    isMonitoring: true,
    state: 'active',
    subscription_id: subscription._id,
    subscribed_users_count: subscription.subscribed_users.length,
    is_user_subscribed: true,
    conditions_met_at: null,
    notification_sent_at: null,
    expires_at: subscription.expires_at,
    jobId: subscription.job_id,
    startedAt: userSubscriptionData.subscribed_at,
    isPaused: false,
    pausedReason: null,
    message: '👁️ AI is watching the market'
}
```

**Example Response (Conditions Met):**
```javascript
{
    isMonitoring: false,
    state: 'finished',
    subscription_id: subscription._id,
    subscribed_users_count: subscription.subscribed_users.length,
    is_user_subscribed: true,
    conditions_met_at: subscription.conditions_met_at,
    notification_sent_at: subscription.notification_sent_at,
    expires_at: subscription.expires_at,
    jobId: subscription.job_id,
    startedAt: userSubscriptionData.subscribed_at,
    isPaused: false,
    pausedReason: null,
    message: '✅ Entry conditions met! Alert sent.'
}
```

---

### Fix 3: Update MonitoringSubscription on Stop

**File:** [backend/src/services/agendaMonitoringService.js](backend/src/services/agendaMonitoringService.js#L743-L838)

**Changes:**
1. Added `userId` parameter to `stopMonitoring()` method
2. Update MonitoringSubscription status BEFORE cancelling Agenda job
3. Support for multi-user subscriptions (remove single user vs stop for all)
4. Proper status updates using subscription instance methods

**Key Logic:**
```javascript
// CRITICAL: Update MonitoringSubscription status FIRST (source of truth)
if (strategyId) {
    const subscription = await MonitoringSubscription.findOne({
        analysis_id: analysisId,
        strategy_id: strategyId
    });

    if (subscription) {
        if (userId) {
            // Remove specific user from subscription
            await subscription.removeUser(userId);
            // If no users left, subscription is auto-marked as cancelled
        } else {
            // Stop monitoring for all users
            await subscription.stopMonitoring('user_cancelled');
        }
    }
}
```

**Why:** Ensures the subscription record (source of truth) is updated immediately so that status checks return accurate data.

---

### Fix 4: Pass userId to stopMonitoring

**File:** [backend/src/routes/agendaMonitoring.js](backend/src/routes/agendaMonitoring.js#L400-L403)

**Change:**
```javascript
// Before
const result = await agendaMonitoringService.stopMonitoring(analysisId, strategyId);

// After
const result = await agendaMonitoringService.stopMonitoring(analysisId, strategyId, userId);
```

**Why:** Enables proper multi-user subscription management and ensures user-specific tracking.

---

## Testing Scenarios

### Scenario 1: Start → Check Status
```bash
# Step 1: Start monitoring
POST /api/monitoring/start
{
  "analysisId": "...",
  "strategyId": "strategy_1"
}

# Expected: success: true, jobId returned

# Step 2: Immediately check status
GET /api/monitoring/status/:analysisId

# Expected Result:
{
  "success": true,
  "data": {
    "isMonitoring": true,
    "strategies": {
      "strategy_1": {
        "isMonitoring": true,
        "state": "active",
        "message": "👁️ AI is watching the market",
        "jobId": "...",
        "startedAt": "2025-11-05T10:30:00.000Z"
      }
    }
  }
}
```

✅ **Guarantee:** `isMonitoring: true` immediately after start succeeds

---

### Scenario 2: Conditions Met During Monitoring
```bash
# Agenda job detects trigger conditions are met
# Backend automatically:
# 1. Updates MonitoringSubscription.monitoring_status → 'conditions_met'
# 2. Saves conditions_met_at timestamp
# 3. Sends WhatsApp notifications to all subscribed users
# 4. Saves notification_sent_at timestamp

# App checks status
GET /api/monitoring/status/:analysisId

# Expected Result:
{
  "success": true,
  "data": {
    "isMonitoring": false,
    "strategies": {
      "strategy_1": {
        "isMonitoring": false,
        "state": "finished",
        "message": "✅ Entry conditions met! Alert sent.",
        "conditions_met_at": "2025-11-05T11:25:00.000Z",
        "notification_sent_at": "2025-11-05T11:25:03.000Z"
      }
    }
  }
}
```

✅ **Guarantee:** App immediately sees `state: "finished"` after conditions are met

---

### Scenario 3: User Stops Monitoring
```bash
# Step 1: User clicks "Stop Monitoring"
POST /api/monitoring/stop
{
  "analysisId": "...",
  "strategyId": "strategy_1"
}

# Expected: success: true

# Step 2: Check status
GET /api/monitoring/status/:analysisId

# Expected Result:
{
  "success": true,
  "data": {
    "isMonitoring": false,
    "strategies": {
      "strategy_1": {
        "isMonitoring": false,
        "state": "finished",
        "message": "Monitoring stopped by user"
      }
    }
  }
}
```

✅ **Guarantee:** Status immediately reflects stop action (not stale)

---

### Scenario 4: Conditions Already Met (Blocking)
```bash
# User tries to start monitoring when conditions were met 20 minutes ago
POST /api/monitoring/start
{
  "analysisId": "...",
  "strategyId": "strategy_1"
}

# Expected Result:
{
  "success": false,
  "error": "conditions_already_met",
  "message": "Entry conditions were met 20 minutes ago...",
  "data": {
    "conditions_met_at": "2025-11-05T10:10:00.000Z",
    "user_message": {
      "title": "⚠️ Monitoring Not Available",
      "description": "Entry conditions were met 20 minutes ago. Market setup may have changed. Please generate fresh analysis after 4:30 PM.",
      "action_button": "Generate Fresh Analysis",
      "suggestion": "Please wait until after 4:30 PM to generate fresh analysis with latest market data"
    }
  }
}
```

✅ **Guarantee:** User gets clear, actionable error message preventing stale monitoring

---

## Message Mapping Reference

| Backend Status | App State | User Message | When |
|---------------|-----------|--------------|------|
| `active` + not expired | `active` | "👁️ AI is watching the market" | Monitoring ongoing |
| `conditions_met` | `finished` | "✅ Entry conditions met! Alert sent." | Triggers satisfied |
| `expired` OR expired timestamp | `finished` | "⏰ Monitoring expired at 3:30 PM" | Market closed |
| `cancelled` | `finished` | "Monitoring stopped by user" | User clicked stop |
| `invalidated` | `finished` | "Setup invalidated" | Market invalidated setup |
| No subscription | `inactive` | "No monitoring subscription found" | Never started |

---

## Android App Integration

### Button State Logic
```kotlin
when (strategy.state) {
    "active" -> {
        if (strategy.isMonitoring) {
            // Show "Stop Monitoring" button (green)
            // Show "AI is watching" indicator
            binding.btnMonitoring.text = "Stop Monitoring"
            binding.btnMonitoring.backgroundTint = activeColor
        }
    }
    "finished", "inactive" -> {
        // Show "Start Monitoring" button (gray)
        // Show appropriate completion message
        binding.btnMonitoring.text = "Start Monitoring"
        binding.btnMonitoring.backgroundTint = inactiveColor

        // Display message
        binding.tvMonitoringMessage.text = strategy.message
    }
}
```

### Polling Strategy
```kotlin
// Poll status every 30 seconds when monitoring is active
if (strategy.isMonitoring) {
    handler.postDelayed({
        fetchMonitoringStatus()
    }, 30000)
}
```

---

## Key Guarantees

### ✅ Immediate Feedback
After `POST /api/monitoring/start` succeeds, the immediate `GET /api/monitoring/status` returns `isMonitoring: true`

**Why:** Because:
1. `startMonitoring()` creates/updates `MonitoringSubscription` with status `'active'`
2. `getMonitoringStatus()` queries `MonitoringSubscription` (source of truth)
3. Subscription is saved before start endpoint returns

---

### ✅ Status Consistency
Status endpoint always reflects current `MonitoringSubscription` state

**Why:**
- Direct MongoDB queries (no caching)
- Single source of truth (MonitoringSubscription model)
- User-specific subscription checks

---

### ✅ Multi-User Support
Multiple users can monitor same analysis without conflicts

**Why:**
- Shared Agenda job (one job serves multiple users)
- Individual user tracking in `subscribed_users` array
- `is_user_subscribed` field shows user's participation status

---

## Files Modified

1. **[backend/src/services/agendaMonitoringService.js](backend/src/services/agendaMonitoringService.js)**
   - Added `mapSubscriptionStateToAppState()` method
   - Enhanced `getMonitoringStatus()` with complete response fields
   - Updated `stopMonitoring()` to modify subscription status

2. **[backend/src/routes/agendaMonitoring.js](backend/src/routes/agendaMonitoring.js)**
   - Pass `userId` to `stopMonitoring()` method call

---

## Documentation Created

1. **[MONITORING_STATUS_FLOW.md](MONITORING_STATUS_FLOW.md)** - Complete status flow documentation with all scenarios
2. **[MONITORING_STATUS_FIXES.md](MONITORING_STATUS_FIXES.md)** - This document (summary of changes)

---

## Verification Checklist

- [x] Start monitoring → Immediately check status → Verify `isMonitoring: true`
- [x] State mapping function properly maps all backend statuses to app states
- [x] All required fields present in response (`startedAt`, `isPaused`, `pausedReason`, etc.)
- [x] Stop monitoring updates subscription status before cancelling job
- [x] User-specific subscription tracking works correctly
- [x] Context-aware messages provided for each state
- [x] Multi-user support maintained (shared job, individual user tracking)

---

## Next Steps for Android Team

1. **Update data models** to include new fields:
   - `notification_sent_at`
   - `is_user_subscribed`
   - `subscribed_users_count`

2. **Update UI logic** to use `state` field for button states:
   - `"active"` → Show "Stop Monitoring" button
   - `"finished"` or `"inactive"` → Show "Start Monitoring" button

3. **Test critical flow**:
   - Start monitoring → Check status (must show isMonitoring=true immediately)
   - Conditions met → Status check (must show state="finished")
   - Stop monitoring → Status check (must show state="finished")

4. **Handle error cases**:
   - `conditions_already_met` error → Show user-friendly message
   - Network errors → Show retry option with cached state
