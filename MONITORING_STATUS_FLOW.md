# Monitoring Status Flow - Backend to Android App

## Overview
This document explains the complete monitoring status flow, answering key questions about when different statuses are sent and what the app should expect.

---

## Status State Mapping

### Backend MonitoringSubscription Status → Android App State

| Backend Status | App State | Meaning | When It Happens |
|---------------|-----------|---------|-----------------|
| `active` | `active` | AI is watching the market | Monitoring is ongoing, not expired |
| `conditions_met` | `finished` | Alert sent, entry conditions met | Trigger conditions were satisfied |
| `expired` | `finished` | Expired at 3:30 PM | Market closed without conditions being met |
| `cancelled` | `finished` | User stopped monitoring | User manually stopped |
| `invalidated` | `finished` | Setup invalidated | Market conditions invalidated the setup |

---

## Critical Flow: Start → Status Check

### Scenario 1: Successfully Start Monitoring

**Step 1: User clicks "Start Monitoring"**
```
POST /api/v1/monitoring/start
Request: {
  analysisId: "...",
  strategyId: "strategy_1"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Monitoring started for strategy strategy_1",
  "jobId": "67890xxx_strategy_1_1234567890",
  "frequency": { "seconds": 60, "label": "Every minute" },
  "subscription_id": "subscriptionId123",
  "subscribed_users_count": 1
}
```

**Step 2: App immediately calls status check**
```
GET /api/v1/monitoring/status/:analysisId
```

**CRITICAL: Status Response MUST show isMonitoring: true**
```json
{
  "success": true,
  "data": {
    "isMonitoring": true,
    "strategies": {
      "strategy_1": {
        "isMonitoring": true,
        "state": "active",
        "message": "👁️ AI is watching the market",
        "jobId": "67890xxx_strategy_1_1234567890",
        "startedAt": "2025-11-05T10:30:00.000Z",
        "isPaused": false,
        "pausedReason": null,
        "subscription_id": "subscriptionId123",
        "subscribed_users_count": 1,
        "is_user_subscribed": true,
        "expires_at": "2025-11-05T15:30:00.000Z"
      }
    },
    "stock_symbol": "RELIANCE",
    "analysis_type": "swing",
    "total_strategies": 1,
    "active_monitoring_count": 1,
    "monitoring_engine": "agenda"
  }
}
```

---

## Status Scenarios

### Scenario 2: Conditions Already Met (Within 45 Minutes)

**When:** User tries to start monitoring, but conditions were met 20 minutes ago

**POST /api/v1/monitoring/start Response:**
```json
{
  "success": false,
  "error": "conditions_already_met",
  "message": "Entry conditions were met 20 minutes ago. Market setup may have changed. Please generate fresh analysis after 4:30 PM.",
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

**GET /api/v1/monitoring/status/:analysisId Response:**
```json
{
  "success": true,
  "data": {
    "isMonitoring": false,
    "strategies": {
      "strategy_1": {
        "isMonitoring": false,
        "state": "finished",
        "message": "✅ Entry conditions met! Alert sent.",
        "jobId": "67890xxx_strategy_1_1234567890",
        "startedAt": "2025-11-05T09:30:00.000Z",
        "isPaused": false,
        "pausedReason": null,
        "conditions_met_at": "2025-11-05T10:10:00.000Z",
        "notification_sent_at": "2025-11-05T10:10:05.000Z"
      }
    }
  }
}
```

---

### Scenario 3: Conditions Met During Monitoring

**What happens:** Agenda job detects trigger conditions are met

**Backend Actions:**
1. `MonitoringSubscription.monitoring_status` → `'conditions_met'`
2. `conditions_met_at` timestamp saved
3. `last_trigger_snapshot` captured (market data proof)
4. WhatsApp notifications sent to all subscribed users
5. `notification_sent_at` timestamp saved
6. Job continues running but won't send duplicate alerts

**GET /api/v1/monitoring/status/:analysisId Response:**
```json
{
  "success": true,
  "data": {
    "isMonitoring": false,
    "strategies": {
      "strategy_1": {
        "isMonitoring": false,
        "state": "finished",
        "message": "✅ Entry conditions met! Alert sent.",
        "jobId": "67890xxx_strategy_1_1234567890",
        "startedAt": "2025-11-05T09:30:00.000Z",
        "isPaused": false,
        "pausedReason": null,
        "conditions_met_at": "2025-11-05T11:25:00.000Z",
        "notification_sent_at": "2025-11-05T11:25:03.000Z",
        "expires_at": "2025-11-05T15:30:00.000Z"
      }
    }
  }
}
```

---

### Scenario 4: User Stops Monitoring

**When:** User clicks "Stop Monitoring" button

**POST /api/v1/monitoring/stop Response:**
```json
{
  "success": true,
  "message": "Monitoring stopped successfully",
  "cancelledJobs": 1
}
```

**Backend Actions:**
1. Agenda job cancelled
2. `MonitoringSubscription.monitoring_status` → `'cancelled'`
3. `stopped_at` timestamp saved
4. `stop_reason` → `'user_cancelled'`

**GET /api/v1/monitoring/status/:analysisId Response:**
```json
{
  "success": true,
  "data": {
    "isMonitoring": false,
    "strategies": {
      "strategy_1": {
        "isMonitoring": false,
        "state": "finished",
        "message": "Monitoring stopped by user",
        "jobId": "67890xxx_strategy_1_1234567890",
        "startedAt": "2025-11-05T09:30:00.000Z",
        "isPaused": false,
        "pausedReason": null,
        "expires_at": "2025-11-05T15:30:00.000Z"
      }
    }
  }
}
```

---

### Scenario 5: Monitoring Expired at 3:30 PM

**When:** Market closes at 3:30 PM IST without conditions being met

**Backend Actions:**
1. MongoDB TTL index auto-deletes expired subscriptions after `expires_at`
2. Agenda job stops running (no longer finds active subscription)

**GET /api/v1/monitoring/status/:analysisId Response (before TTL cleanup):**
```json
{
  "success": true,
  "data": {
    "isMonitoring": false,
    "strategies": {
      "strategy_1": {
        "isMonitoring": false,
        "state": "finished",
        "message": "⏰ Monitoring expired at 3:30 PM",
        "jobId": "67890xxx_strategy_1_1234567890",
        "startedAt": "2025-11-05T09:30:00.000Z",
        "isPaused": false,
        "pausedReason": null,
        "expires_at": "2025-11-05T15:30:00.000Z"
      }
    }
  }
}
```

**GET /api/v1/monitoring/status/:analysisId Response (after TTL cleanup):**
```json
{
  "success": true,
  "data": {
    "isMonitoring": false,
    "strategies": {
      "strategy_1": {
        "isMonitoring": false,
        "state": "inactive",
        "message": "No monitoring subscription found",
        "jobId": null,
        "startedAt": null,
        "isPaused": false,
        "pausedReason": null
      }
    }
  }
}
```

---

### Scenario 6: No Monitoring Ever Started

**When:** User has never started monitoring for this analysis

**GET /api/v1/monitoring/status/:analysisId Response:**
```json
{
  "success": true,
  "data": {
    "isMonitoring": false,
    "strategies": {
      "strategy_1": {
        "isMonitoring": false,
        "state": "inactive",
        "message": "No monitoring subscription found",
        "jobId": null,
        "startedAt": null,
        "isPaused": false,
        "pausedReason": null
      }
    },
    "stock_symbol": "RELIANCE",
    "analysis_type": "swing",
    "total_strategies": 1,
    "active_monitoring_count": 0,
    "monitoring_engine": "agenda"
  }
}
```

---

## App Button State Logic

### Android App Should Display:

```kotlin
when (strategy.state) {
    "active" -> {
        if (strategy.isMonitoring) {
            // Show "Stop Monitoring" button (green/active)
            // Show "AI is watching" indicator
        }
    }
    "finished", "inactive" -> {
        if (!strategy.isMonitoring) {
            // Show "Start Monitoring" button (inactive/gray)
            // Show appropriate message (conditions met, expired, etc.)
        }
    }
    else -> {
        // Show disabled state
    }
}
```

---

## Key Guarantees

### 1. Immediate Feedback
✅ **After `POST /api/v1/monitoring/start` succeeds, the immediate `GET /api/v1/monitoring/status` will return `isMonitoring: true`**

This is guaranteed because:
- `startMonitoring()` creates/updates `MonitoringSubscription` with status `'active'`
- `getMonitoringStatus()` queries `MonitoringSubscription` (source of truth)
- The subscription is saved before the start endpoint returns

### 2. Status Consistency
✅ **Status endpoint always reflects current MonitoringSubscription state**

- No caching delays
- Direct MongoDB queries
- User-specific subscription checks

### 3. Multi-User Support
✅ **Multiple users can monitor same analysis without conflicts**

- Shared Agenda job (one job serves multiple users)
- Individual subscription tracking per user
- `is_user_subscribed` field shows user's participation

---

## Testing Checklist

- [ ] Start monitoring → Immediately check status → Verify `isMonitoring: true`
- [ ] Start monitoring → Wait → Stop monitoring → Verify `state: "finished"`
- [ ] Start monitoring → Let conditions be met → Verify `state: "finished"` with conditions_met_at
- [ ] Start monitoring → Let expire at 3:30 PM → Verify `state: "finished"` with expiry message
- [ ] Try starting when conditions already met (within 45 min) → Verify error response
- [ ] Check status when never started → Verify `state: "inactive"`
- [ ] Multiple users start same analysis → Verify shared monitoring works

---

## Error Handling

### App Should Handle:

1. **`conditions_already_met` error**: Show user-friendly message suggesting fresh analysis
2. **`state: "finished"`**: Disable monitoring button, show appropriate completion message
3. **`state: "inactive"`**: Enable "Start Monitoring" button
4. **Network errors**: Show retry option, cached last known state

---

## Summary of Answers to User Questions

### Q: If monitoring is already met, what status will we send?
**A:** `state: "finished"`, `isMonitoring: false`, `message: "✅ Entry conditions met! Alert sent."`

The response also includes:
- `conditions_met_at`: Timestamp when conditions were met
- `notification_sent_at`: Timestamp when notifications were sent
- `conditions_met_count`: Number of strategies where conditions were met (in top-level response)

### Q: When we stop, what status do we send?
**A:** `state: "finished"`, `isMonitoring: false`, `message: "Monitoring stopped by user"`

### Q: When status check is happening, what do we send?
**A:** We send the current state from `MonitoringSubscription`:
- If active and not expired: `state: "active"`, `isMonitoring: true`
- If conditions met: `state: "finished"`, `isMonitoring: false`, `conditions_met_at` populated
- If stopped/expired/cancelled: `state: "finished"`, `isMonitoring: false`
- If never started: `state: "inactive"`, `isMonitoring: false`

The top-level response includes `conditions_met_count` to indicate how many strategies have completed.

### Q: If conditions are met, what status do we send?
**A:** `state: "finished"`, `isMonitoring: false`, includes `conditions_met_at` and `notification_sent_at` timestamps

---

## Enhanced Status API Response

The status endpoint now includes `conditions_met_count` in the top-level response:

```json
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
    },
    "stock_symbol": "RELIANCE",
    "analysis_type": "swing",
    "total_strategies": 1,
    "active_monitoring_count": 0,
    "conditions_met_count": 1,  // 🆕 NEW: Number of strategies where conditions were met
    "monitoring_engine": "agenda"
  }
}
```

This allows the Android app to:
1. **Show badge/indicator** when conditions are met even if user hasn't opened the analysis screen
2. **Display appropriate UI state** - "Entry conditions met! Check details"
3. **Navigate user to analysis** to see details of met conditions
