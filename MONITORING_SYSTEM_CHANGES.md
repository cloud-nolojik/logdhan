# Multi-User Shared Monitoring System - Complete Changes Summary

## Overview
Implemented a comprehensive multi-user shared monitoring system where multiple users can monitor the same stock/strategy without creating duplicate Agenda jobs. The system includes trigger snapshots, per-user acknowledgement tracking, and intelligent blocking logic.

---

## 1. NEW FILES CREATED

### `/backend/src/models/monitoringSubscription.js`
**Purpose**: Core model for tracking multi-user subscriptions to monitoring jobs

**Key Features**:
- Tracks multiple users subscribed to same monitoring job
- Stores trigger snapshots when conditions are met
- Per-user acknowledgement tracking
- Same-day 3:30 PM IST expiry (not next trading day)
- 45-minute blocking window to prevent joining stale monitoring

**Key Schema Fields**:
```javascript
{
    analysis_id: ObjectId,
    strategy_id: String,
    stock_symbol: String,
    instrument_key: String,
    job_id: String,  // Agenda job ID

    // Array of subscribed users
    subscribed_users: [{
        user_id: ObjectId,
        subscribed_at: Date,
        acknowledged_at: Date,  // When user viewed notification
        notification_preferences: {
            whatsapp: Boolean,
            email: Boolean
        }
    }],

    // Monitoring status
    monitoring_status: 'active' | 'conditions_met' | 'expired' | 'invalidated' | 'cancelled',

    // Trigger snapshot (immutable proof of conditions met)
    last_trigger_snapshot: {
        price: Number,
        timestamp: Date,
        timeframe_data: Object,
        evaluated_triggers: Array,
        market_conditions: Object,
        snapshot_timestamp: Date
    },

    conditions_met_at: Date,
    notification_sent_at: Date,
    stopped_at: Date,
    stop_reason: String,
    expires_at: Date,  // Same day 3:30 PM IST

    monitoring_config: {
        frequency_seconds: Number,
        timeframes: [String]
    }
}
```

**Key Static Methods**:
```javascript
// Calculate expiry time (same day 3:30 PM IST)
getExpiryTime()

// Find or create subscription, add user to existing if found
findOrCreateSubscription(analysisId, strategyId, userId, stockSymbol, instrumentKey, jobId, config)

// Get active subscription for analysis+strategy
getActiveSubscription(analysisId, strategyId)

// Get all subscriptions for a user
getUserSubscriptions(userId, status)

// Check if user can start monitoring (45-minute blocking logic)
canUserStartMonitoring(analysisId, strategyId)
// Returns: { can_start: Boolean, reason: String, conditions_met_at: Date }
```

**Key Instance Methods**:
```javascript
// Add user to subscription
addUser(userId, notificationPreferences)

// Remove user from subscription
removeUser(userId)

// Mark conditions as met and save trigger snapshot
markConditionsMet(triggerSnapshot)

// Mark notification as sent
markNotificationSent()

// Mark monitoring as stopped
stopMonitoring(reason)

// Mark user acknowledgement
markUserAcknowledged(userId)

// Get unacknowledged users
getUnacknowledgedUsers()
```

---

## 2. MODIFIED FILES

### `/backend/src/services/agendaMonitoringService.js`

**Major Changes**:

#### 1. Job Definition (Removed userId from job data)
**BEFORE**:
```javascript
this.agenda.define('check-triggers', async (job) => {
    const { analysisId, strategyId, userId } = job.attrs.data;
    await this.executeMonitoringCheck(analysisId, strategyId, userId);
});
```

**AFTER**:
```javascript
this.agenda.define('check-triggers', async (job) => {
    const { analysisId, strategyId } = job.attrs.data;  // NO userId
    await this.executeMonitoringCheck(analysisId, strategyId);
});
```

#### 2. `executeMonitoringCheck()` - Multi-user notification logic
**BEFORE**: Notified single user
```javascript
async executeMonitoringCheck(analysisId, strategyId, userId) {
    // ... fetch single user
    // ... check triggers
    // ... notify single user
    // ... create single history entry
}
```

**AFTER**: Notifies ALL subscribed users
```javascript
async executeMonitoringCheck(analysisId, strategyId) {
    // Fetch subscription with ALL users
    const subscription = await MonitoringSubscription.findOne({
        analysis_id: analysisId,
        strategy_id: strategyId,
        monitoring_status: 'active'
    }).populate('subscribed_users.user_id');

    if (!subscription || subscription.subscribed_users.length === 0) {
        console.log('No active subscribers, stopping job');
        await this.stopMonitoring(analysisId, strategyId);
        return;
    }

    // ... check triggers

    if (triggerCheck.triggersConditionsMet) {
        // Create trigger snapshot
        const triggerSnapshot = {
            price: triggerCheck.data.current_price,
            timestamp: new Date(),
            timeframe_data: triggerCheck.data.timeframes,
            evaluated_triggers: triggerCheck.data.triggers,
            market_conditions: {
                trend: triggerCheck.data.market_summary?.trend,
                volatility: triggerCheck.data.market_summary?.volatility,
                volume_profile: triggerCheck.data.market_summary?.volume
            }
        };

        // Mark conditions met with snapshot
        await subscription.markConditionsMet(triggerSnapshot);

        // Notify ALL subscribed users
        for (const userSubscription of subscription.subscribed_users) {
            const user = userSubscription.user_id;

            // Send notification
            await messagingService.sendMonitoringConditionsMet(
                user.mobile_number,
                alertData
            );

            // Create per-user monitoring history
            await MonitoringHistory.create({
                user_id: user._id,
                analysis_id: analysisId,
                stock_symbol: analysis.stock_symbol,
                strategy_id: strategyId,
                event_type: 'conditions_met',
                trigger_snapshot: triggerSnapshot,
                // ... other fields
            });
        }

        // Mark notification sent
        await subscription.markNotificationSent();

        // Stop monitoring immediately after conditions met
        await subscription.stopMonitoring('conditions_met');
        await this.stopMonitoring(analysisId, strategyId);
    }
}
```

#### 3. `startMonitoring()` - Shared job detection and subscription logic
**NEW ADDITIONS**:
```javascript
async startMonitoring(analysisId, strategyId, userId, config = {}) {
    // 1. Check if user can start monitoring (45-minute blocking)
    const canStart = await MonitoringSubscription.canUserStartMonitoring(
        analysisId,
        strategyId
    );

    if (!canStart.can_start) {
        return {
            success: false,
            message: canStart.reason,
            conditions_met_at: canStart.conditions_met_at
        };
    }

    // 2. Generate unique job ID
    const jobId = `monitor-${analysisId}-${strategyId}`;

    // 3. Find or create subscription
    let subscription = await MonitoringSubscription.findOrCreateSubscription(
        analysisId,
        strategyId,
        userId,
        stockSymbol,
        instrumentKey,
        jobId,
        config
    );

    // 4. Check if Agenda job already exists (shared monitoring)
    const existingJobs = await this.agenda.jobs({
        name: 'check-triggers',
        'data.analysisId': analysisId,
        'data.strategyId': strategyId
    });

    if (existingJobs.length > 0) {
        console.log(`✅ User joined existing monitoring job`);
        return {
            success: true,
            message: 'Monitoring started for strategy (joined existing job)',
            jobId,
            subscription_id: subscription._id,
            subscribed_users_count: subscription.subscribed_users.length,
            frequency: config.frequency_seconds || 60
        };
    }

    // 5. Create new Agenda job (NO userId in job data)
    const job = this.agenda.create('check-triggers', {
        analysisId,
        strategyId
        // NO userId field
    });

    // ... schedule job

    return {
        success: true,
        message: 'Monitoring started for strategy',
        jobId,
        subscription_id: subscription._id,
        subscribed_users_count: subscription.subscribed_users.length,
        frequency: config.frequency_seconds || 60
    };
}
```

#### 4. `stopMonitoring()` - Updated to handle subscriptions
```javascript
async stopMonitoring(analysisId, strategyId, userId = null) {
    const jobId = `monitor-${analysisId}-${strategyId}`;

    // Find subscription
    const subscription = await MonitoringSubscription.findOne({
        analysis_id: analysisId,
        strategy_id: strategyId
    });

    if (subscription && userId) {
        // Remove specific user from subscription
        await subscription.removeUser(userId);

        // If still has other users, don't stop the job
        if (subscription.subscribed_users.length > 0) {
            console.log(`User removed but ${subscription.subscribed_users.length} users still monitoring`);
            return {
                success: true,
                message: 'You have stopped monitoring, but other users continue monitoring'
            };
        }
    }

    // Stop the Agenda job
    await this.agenda.cancel({ name: 'check-triggers', 'data.analysisId': analysisId, 'data.strategyId': strategyId });

    // Update subscription status
    if (subscription) {
        await subscription.stopMonitoring('user_cancelled');
    }

    return {
        success: true,
        message: 'Monitoring stopped for all users'
    };
}
```

---

### `/backend/src/routes/agendaMonitoring.js`

#### Modified `POST /api/monitoring/start` Route

**Key Changes**:

1. **Added new response fields for shared monitoring** (Lines 309-311):
```javascript
res.json({
    success: true,
    message: `🎯 Smart monitoring activated...`,
    monitoring_status: 'ACTIVE',
    data: {
        jobId: result.jobId,
        frequency: result.frequency,
        analysisId,
        strategyId,
        stock_symbol: analysis.stock_symbol,
        // 🆕 NEW FIELDS
        subscription_id: result.subscription_id,
        subscribed_users_count: result.subscribed_users_count,
        failed_triggers: triggerCheck.data?.failed_triggers || [],
        user_message: {
            // ... existing user message
        }
    }
});
```

2. **Added new error handling for blocking scenario** (Lines 331-347):
```javascript
if (result.conditions_met_at) {
    return res.status(400).json({
        success: false,
        error: 'conditions_already_met',
        message: result.message,
        data: {
            conditions_met_at: result.conditions_met_at,
            user_message: {
                title: '⚠️ Monitoring Not Available',
                description: result.message,
                action_button: 'Generate Fresh Analysis',
                suggestion: 'Please wait until after 4:30 PM to generate fresh analysis with latest market data'
            }
        }
    });
}
```

---

### `/backend/src/routes/ai.js`

#### Modified `GET /api/ai/analysis/by-instrument/:instrumentKey` Route

**Added monitoring status checks for all strategies**:

```javascript
// After fetching analysis, check monitoring status for each strategy
const monitoringStatus = {};

for (const strategy of analysis.analysis_data.strategies) {
    const canMonitor = await MonitoringSubscription.canUserStartMonitoring(
        analysis._id,
        strategy.id
    );

    monitoringStatus[strategy.id] = {
        can_start_monitoring: canMonitor.can_start,
        reason: canMonitor.reason,
        conditions_met_at: canMonitor.conditions_met_at
    };
}

// Determine global monitoring status
const globalCanStartMonitoring = Object.values(monitoringStatus).every(
    status => status.can_start_monitoring
);
const globalConditionsMetAt = Object.values(monitoringStatus).find(
    status => !status.can_start_monitoring
)?.conditions_met_at;
const globalMonitoringMessage = Object.values(monitoringStatus).find(
    status => !status.can_start_monitoring
)?.reason;

// Include in response
res.json({
    success: true,
    data: {
        analysis: {
            // ... existing analysis fields

            // 🆕 NEW FIELDS
            can_start_monitoring: globalCanStartMonitoring,
            monitoring_status: !globalCanStartMonitoring ? 'conditions_met' : null,
            conditions_met_at: globalConditionsMetAt,
            monitoring_message: globalMonitoringMessage,
            strategy_monitoring_status: monitoringStatus
        }
    }
});
```

**Response Structure**:
```javascript
{
    "success": true,
    "data": {
        "analysis": {
            // ... existing fields ...

            // Global monitoring flags
            "can_start_monitoring": false,
            "monitoring_status": "conditions_met",
            "conditions_met_at": "2025-01-05T10:30:00.000Z",
            "monitoring_message": "Entry conditions were met 50 minutes ago...",

            // Per-strategy monitoring status
            "strategy_monitoring_status": {
                "strategy-123": {
                    "can_start_monitoring": false,
                    "reason": "Entry conditions were met 50 minutes ago...",
                    "conditions_met_at": "2025-01-05T10:30:00.000Z"
                },
                "strategy-456": {
                    "can_start_monitoring": true,
                    "reason": null,
                    "conditions_met_at": null
                }
            }
        }
    }
}
```

---

### `/backend/src/services/triggerOrderService.js`

**Changes**: Enhanced logging and debugging output (no functional changes to API contract)

---

### `/backend/src/models/analysisFeedback.js`

**Changes**: Added strategy and analysis snapshots for feedback system (already implemented earlier, no new changes needed)

---

## 3. API CONTRACT CHANGES FOR ANDROID APP

### 3.1. `GET /api/ai/analysis/by-instrument/:instrumentKey`

**NEW Response Fields**:
```kotlin
data class AnalysisResponse(
    val success: Boolean,
    val data: AnalysisData
)

data class AnalysisData(
    val analysis: Analysis
)

data class Analysis(
    // ... existing fields ...

    // 🆕 NEW FIELDS
    val can_start_monitoring: Boolean,
    val monitoring_status: String?,  // "conditions_met" or null
    val conditions_met_at: String?,  // ISO timestamp or null
    val monitoring_message: String?,  // User-friendly message
    val strategy_monitoring_status: Map<String, StrategyMonitoringStatus>
)

data class StrategyMonitoringStatus(
    val can_start_monitoring: Boolean,
    val reason: String?,
    val conditions_met_at: String?
)
```

**Usage in Android**:
```kotlin
// When fetching analysis
val response = apiService.getAnalysisByInstrument(instrumentKey)
val analysis = response.data.analysis

// Check if monitoring can be started
if (!analysis.can_start_monitoring) {
    // Show blocking UI
    showBlockingDialog(
        title = "⚠️ Monitoring Not Available",
        message = analysis.monitoring_message ?: "Cannot start monitoring at this time",
        conditionsMetAt = analysis.conditions_met_at
    )
} else {
    // Show "Start Monitoring" button
    showStartMonitoringButton()
}

// Check per-strategy monitoring status
for (strategy in analysis.strategies) {
    val strategyStatus = analysis.strategy_monitoring_status[strategy.id]
    if (strategyStatus?.can_start_monitoring == false) {
        // Disable monitoring for this strategy
        disableMonitoringButton(strategy.id)
    }
}
```

---

### 3.2. `POST /api/monitoring/start`

**NEW Response Fields (Success)**:
```kotlin
data class StartMonitoringResponse(
    val success: Boolean,
    val message: String,
    val monitoring_status: String,  // "ACTIVE"
    val data: MonitoringData
)

data class MonitoringData(
    val jobId: String,
    val frequency: Int,
    val analysisId: String,
    val strategyId: String,
    val stock_symbol: String,

    // 🆕 NEW FIELDS
    val subscription_id: String?,  // MongoDB ObjectId
    val subscribed_users_count: Int?,  // Number of users monitoring

    val failed_triggers: List<FailedTrigger>,
    val user_message: UserMessage
)
```

**NEW Error Response (Blocking Scenario)**:
```kotlin
data class StartMonitoringErrorResponse(
    val success: Boolean,  // false
    val error: String,  // "conditions_already_met"
    val message: String,  // Error message
    val data: BlockingData?
)

data class BlockingData(
    val conditions_met_at: String,  // ISO timestamp
    val user_message: BlockingUserMessage
)

data class BlockingUserMessage(
    val title: String,  // "⚠️ Monitoring Not Available"
    val description: String,  // Detailed message
    val action_button: String,  // "Generate Fresh Analysis"
    val suggestion: String  // "Please wait until after 4:30 PM..."
)
```

**Usage in Android**:
```kotlin
// When starting monitoring
try {
    val response = apiService.startMonitoring(analysisId, strategyId)

    if (response.success) {
        // Show success message
        showSuccessMessage(
            "Monitoring started! ${response.data.subscribed_users_count} users monitoring this stock"
        )

        // Store subscription ID for later use
        saveSubscriptionId(response.data.subscription_id)
    }
} catch (e: HttpException) {
    if (e.code() == 400) {
        val errorBody = e.response()?.errorBody()?.string()
        val errorResponse = gson.fromJson(errorBody, StartMonitoringErrorResponse::class.java)

        if (errorResponse.error == "conditions_already_met") {
            // Show blocking dialog
            showBlockingDialog(
                title = errorResponse.data?.user_message?.title ?: "Error",
                description = errorResponse.data?.user_message?.description ?: "Cannot start monitoring",
                actionButton = errorResponse.data?.user_message?.action_button ?: "OK",
                suggestion = errorResponse.data?.user_message?.suggestion
            )
        }
    }
}
```

---

## 4. KEY FEATURES IMPLEMENTED

### 4.1. Multi-User Shared Monitoring
- ✅ Multiple users can monitor same stock/strategy without duplicate jobs
- ✅ One Agenda job serves multiple users
- ✅ Users can join existing monitoring sessions
- ✅ Job continues until conditions met or expired

### 4.2. Trigger Snapshots
- ✅ Immutable snapshot of market data when conditions are met
- ✅ Preserves proof for disputes and audit trails
- ✅ Captures: price, timestamp, timeframe data, evaluated triggers, market conditions

### 4.3. Per-User Acknowledgement Tracking
- ✅ Tracks when each user views notification
- ✅ `acknowledged_at` field per user
- ✅ Can identify unacknowledged users for follow-up nudges

### 4.4. 45-Minute Blocking Logic
- ✅ Prevents users from joining monitoring if conditions met >45 minutes ago
- ✅ User-friendly error messages
- ✅ Suggests waiting until after 4:30 PM for fresh analysis

### 4.5. Same-Day Expiry
- ✅ Jobs expire at 3:30 PM IST same trading day (not next trading day)
- ✅ Automatic TTL deletion of expired subscriptions

### 4.6. Immediate Job Stopping After Conditions Met
- ✅ Job stops immediately after notifying all users
- ✅ No unnecessary API calls after conditions met

---

## 5. TESTING CHECKLIST FOR ANDROID APP

### 5.1. Fetch Analysis API
- [ ] Verify `can_start_monitoring` field is present
- [ ] Verify `monitoring_status` field is present
- [ ] Verify `conditions_met_at` field is present when conditions met
- [ ] Verify `monitoring_message` field is present when blocking
- [ ] Verify `strategy_monitoring_status` map is populated

### 5.2. Start Monitoring API (Success)
- [ ] Verify `subscription_id` field is present
- [ ] Verify `subscribed_users_count` field is present
- [ ] Verify count increases when multiple users join

### 5.3. Start Monitoring API (Blocking)
- [ ] Verify 400 error response when conditions met >45 min ago
- [ ] Verify `error` field equals "conditions_already_met"
- [ ] Verify `data.user_message` contains blocking UI data
- [ ] Verify UI shows blocking dialog with action button

### 5.4. Shared Monitoring
- [ ] Test multiple users monitoring same stock
- [ ] Verify only one Agenda job is created
- [ ] Verify all users receive notifications when conditions met
- [ ] Verify job stops after all users notified

### 5.5. Acknowledgement
- [ ] Implement API call to mark user acknowledgement
- [ ] Test per-user acknowledgement tracking

---

## 6. MIGRATION NOTES

### Database Migration
No migration script needed. New collection will be created automatically:
- `monitoring_subscriptions` collection

### Backward Compatibility
- ✅ New fields in API responses are optional/nullable
- ✅ Old monitoring system still works (will be deprecated)
- ✅ Existing monitoring jobs will continue to work

### Deprecation Timeline
1. **Phase 1 (Current)**: Both old and new systems coexist
2. **Phase 2**: Migrate all active monitoring to new system
3. **Phase 3**: Remove old monitoring system

---

## 7. SUPPORT AND TROUBLESHOOTING

### Common Issues

#### Issue: "Entry conditions were met X minutes ago"
**Cause**: Conditions were met more than 45 minutes ago
**Solution**: Wait until after 4:30 PM and generate fresh analysis

#### Issue: Monitoring not starting
**Cause**: Invalid triggers or missing market data
**Solution**: Check trigger configuration, verify market data is available

#### Issue: Not receiving notifications
**Cause**: WhatsApp number not verified or messaging service down
**Solution**: Verify phone number in user profile, check messaging service logs

---

## 8. NEXT STEPS FOR ANDROID TEAM

1. **Update Data Models**: Add new fields to Kotlin data classes
2. **Update API Service**: Handle new response structures
3. **Implement Blocking UI**: Show blocking dialog when conditions met >45 min ago
4. **Update Monitoring UI**: Show subscription count and shared monitoring status
5. **Test End-to-End**: Test full monitoring flow with multiple users
6. **Implement Acknowledgement**: Add API call to mark user viewed notification

---

## QUESTIONS OR ISSUES?

Contact backend team with:
- API endpoint having issues
- Expected vs. actual response
- Error messages or logs
- Steps to reproduce
