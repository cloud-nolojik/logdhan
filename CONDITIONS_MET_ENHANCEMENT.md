# Enhanced Conditions Met Detection - Android Integration Guide

## Overview
Added `conditions_met_count` field to the monitoring status API response, allowing the Android app to easily detect when entry conditions have been met for any strategy, even before the user opens the analysis screen.

---

## What's New

### New Field in Status Response: `conditions_met_count`

**Location:** `GET /api/monitoring/status/:analysisId`

**Purpose:** Indicates how many strategies have had their entry conditions met and notifications sent.

---

## API Response Changes

### Before (Old Response)
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
        "conditions_met_at": "2025-11-05T11:25:00.000Z"
      }
    },
    "stock_symbol": "RELIANCE",
    "total_strategies": 1,
    "active_monitoring_count": 0
  }
}
```

### After (New Response)
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
    "total_strategies": 1,
    "active_monitoring_count": 0,
    "conditions_met_count": 1  // 🆕 NEW FIELD
  }
}
```

---

## Android Implementation

### 1. Update Data Model

Add the new field to your response data class:

```kotlin
data class MonitoringStatusResponse(
    val success: Boolean,
    val data: MonitoringStatusData
)

data class MonitoringStatusData(
    val isMonitoring: Boolean,
    val strategies: Map<String, StrategyStatus>,
    val stock_symbol: String,
    val analysis_type: String,
    val total_strategies: Int,
    val active_monitoring_count: Int,
    val conditions_met_count: Int,  // 🆕 NEW
    val monitoring_engine: String
)
```

---

### 2. UI Use Cases

#### Use Case 1: Analysis List Screen - Badge Indicator

Show a badge/indicator on analysis cards when conditions are met:

```kotlin
// In your AnalysisListAdapter or Composable
if (analysis.conditions_met_count > 0) {
    // Show badge
    Badge(
        text = "Entry Ready!",
        backgroundColor = Color.Green,
        icon = Icons.Filled.CheckCircle
    )
}
```

**Visual Example:**
```
┌──────────────────────────────────────┐
│ RELIANCE - Swing Trade               │
│ Generated: 2 hours ago          [✓ Entry Ready!] │
│ Entry: ₹2,450 | Target: ₹2,580      │
└──────────────────────────────────────┘
```

---

#### Use Case 2: Analysis Detail Screen - Status Banner

Show a prominent banner when conditions are met:

```kotlin
if (statusData.conditions_met_count > 0) {
    // Get the strategy details
    val strategy = statusData.strategies.values.firstOrNull {
        it.conditions_met_at != null
    }

    if (strategy != null) {
        // Show banner
        AlertBanner(
            title = "🎯 Entry Conditions Met!",
            message = strategy.message,
            timestamp = strategy.conditions_met_at,
            actionButton = "View Details",
            backgroundColor = Color(0xFF4CAF50)  // Green
        )
    }
}
```

**Visual Example:**
```
╔════════════════════════════════════════════╗
║  🎯 Entry Conditions Met!                  ║
║  ✅ Entry conditions met! Alert sent.      ║
║  Time: 11:25 AM (2 minutes ago)            ║
║  [View Details]                [Dismiss]   ║
╚════════════════════════════════════════════╝
```

---

#### Use Case 3: Home Screen Widget/Notification

Use conditions_met_count to show active alerts on home screen:

```kotlin
// In your HomeViewModel
fun fetchActiveAlerts() {
    viewModelScope.launch {
        val analyses = analysisRepository.getAllAnalyses()

        val analysesWithConditionsMet = analyses.filter {
            it.conditions_met_count > 0
        }

        if (analysesWithConditionsMet.isNotEmpty()) {
            // Show notification or widget
            notificationManager.showConditionsMetNotification(
                count = analysesWithConditionsMet.size,
                stocks = analysesWithConditionsMet.map { it.stock_symbol }
            )
        }
    }
}
```

**Visual Example (Notification):**
```
┌─────────────────────────────────────┐
│ 📊 Logdhan Trading Alert            │
│ 2 stocks ready for entry            │
│ RELIANCE, INFY                      │
│ [Open App]                          │
└─────────────────────────────────────┘
```

---

### 3. Complete Integration Example

```kotlin
class AnalysisDetailViewModel @Inject constructor(
    private val monitoringRepository: MonitoringRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow<AnalysisDetailUiState>(Loading)
    val uiState: StateFlow<AnalysisDetailUiState> = _uiState.asStateFlow()

    fun fetchMonitoringStatus(analysisId: String) {
        viewModelScope.launch {
            try {
                val response = monitoringRepository.getMonitoringStatus(analysisId)

                if (response.success) {
                    val data = response.data

                    // Determine UI state based on conditions
                    val uiState = when {
                        // Case 1: Conditions met
                        data.conditions_met_count > 0 -> {
                            val strategy = data.strategies.values.firstOrNull {
                                it.conditions_met_at != null
                            }

                            AnalysisDetailUiState.ConditionsMet(
                                stockSymbol = data.stock_symbol,
                                message = strategy?.message ?: "Entry conditions met",
                                conditionsMetAt = strategy?.conditions_met_at,
                                notificationSentAt = strategy?.notification_sent_at,
                                strategyDetails = strategy
                            )
                        }

                        // Case 2: Monitoring active
                        data.isMonitoring -> {
                            AnalysisDetailUiState.MonitoringActive(
                                stockSymbol = data.stock_symbol,
                                activeCount = data.active_monitoring_count,
                                strategies = data.strategies
                            )
                        }

                        // Case 3: No monitoring
                        else -> {
                            AnalysisDetailUiState.MonitoringInactive(
                                stockSymbol = data.stock_symbol,
                                strategies = data.strategies
                            )
                        }
                    }

                    _uiState.value = uiState
                }
            } catch (e: Exception) {
                _uiState.value = AnalysisDetailUiState.Error(e.message ?: "Unknown error")
            }
        }
    }
}

// UI States
sealed class AnalysisDetailUiState {
    object Loading : AnalysisDetailUiState()

    data class ConditionsMet(
        val stockSymbol: String,
        val message: String,
        val conditionsMetAt: String?,
        val notificationSentAt: String?,
        val strategyDetails: StrategyStatus?
    ) : AnalysisDetailUiState()

    data class MonitoringActive(
        val stockSymbol: String,
        val activeCount: Int,
        val strategies: Map<String, StrategyStatus>
    ) : AnalysisDetailUiState()

    data class MonitoringInactive(
        val stockSymbol: String,
        val strategies: Map<String, StrategyStatus>
    ) : AnalysisDetailUiState()

    data class Error(val message: String) : AnalysisDetailUiState()
}
```

---

### 4. UI Composable Implementation

```kotlin
@Composable
fun AnalysisDetailScreen(
    viewModel: AnalysisDetailViewModel,
    analysisId: String
) {
    val uiState by viewModel.uiState.collectAsState()

    LaunchedEffect(analysisId) {
        viewModel.fetchMonitoringStatus(analysisId)
    }

    Column(modifier = Modifier.fillMaxSize()) {
        when (val state = uiState) {
            is Loading -> {
                CircularProgressIndicator()
            }

            is AnalysisDetailUiState.ConditionsMet -> {
                // Show conditions met banner
                ConditionsMetBanner(
                    stockSymbol = state.stockSymbol,
                    message = state.message,
                    timestamp = state.conditionsMetAt,
                    onViewDetails = { /* Navigate to details */ },
                    onDismiss = { /* Dismiss banner */ }
                )

                // Show strategy details below
                StrategyDetailsCard(state.strategyDetails)
            }

            is AnalysisDetailUiState.MonitoringActive -> {
                // Show monitoring active indicator
                MonitoringActiveCard(
                    stockSymbol = state.stockSymbol,
                    activeCount = state.activeCount
                )

                // Show stop monitoring button
                Button(
                    onClick = { viewModel.stopMonitoring(analysisId) },
                    colors = ButtonDefaults.buttonColors(backgroundColor = Color.Red)
                ) {
                    Text("Stop Monitoring")
                }
            }

            is AnalysisDetailUiState.MonitoringInactive -> {
                // Show start monitoring button
                Button(
                    onClick = { viewModel.startMonitoring(analysisId) },
                    colors = ButtonDefaults.buttonColors(backgroundColor = Color.Blue)
                ) {
                    Text("Start Monitoring")
                }
            }

            is AnalysisDetailUiState.Error -> {
                ErrorMessage(state.message)
            }
        }
    }
}

@Composable
fun ConditionsMetBanner(
    stockSymbol: String,
    message: String,
    timestamp: String?,
    onViewDetails: () -> Unit,
    onDismiss: () -> Unit
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(16.dp),
        backgroundColor = Color(0xFF4CAF50),  // Green
        elevation = 4.dp
    ) {
        Column(
            modifier = Modifier.padding(16.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(
                    text = "🎯 Entry Conditions Met!",
                    style = MaterialTheme.typography.h6,
                    color = Color.White
                )
                IconButton(onClick = onDismiss) {
                    Icon(
                        imageVector = Icons.Default.Close,
                        contentDescription = "Dismiss",
                        tint = Color.White
                    )
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            Text(
                text = message,
                style = MaterialTheme.typography.body1,
                color = Color.White
            )

            timestamp?.let {
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "Time: ${formatTimestamp(it)}",
                    style = MaterialTheme.typography.caption,
                    color = Color.White.copy(alpha = 0.9f)
                )
            }

            Spacer(modifier = Modifier.height(12.dp))

            Button(
                onClick = onViewDetails,
                colors = ButtonDefaults.buttonColors(backgroundColor = Color.White)
            ) {
                Text("View Details", color = Color(0xFF4CAF50))
            }
        }
    }
}
```

---

## Benefits for Android App

### 1. Proactive User Engagement
- **Before:** Users had to open each analysis to check if conditions were met
- **After:** App shows badges/indicators on list screen, user immediately knows which stocks are ready

### 2. Better UX for Multiple Analyses
- **Before:** No way to know if any monitored stock's conditions were met without checking each one
- **After:** `conditions_met_count` provides instant overview across all analyses

### 3. Notification/Alert Triggers
- **Before:** Had to poll all strategies individually to trigger notifications
- **After:** Single field (`conditions_met_count > 0`) triggers notification logic

### 4. Reduced API Calls
- **Before:** Might need to fetch full strategy details to check conditions_met_at
- **After:** Top-level field provides immediate answer without parsing strategies

---

## Testing Scenarios

### Test 1: List Screen Badge
1. Start monitoring for 2 different analyses
2. Backend triggers conditions met for 1 analysis
3. Fetch list of analyses
4. Verify: Badge appears only on the analysis with conditions_met_count = 1

### Test 2: Status Polling
1. Start monitoring
2. Poll status every 30 seconds
3. When backend triggers conditions met
4. Verify: Next poll returns conditions_met_count = 1
5. Verify: UI updates to show banner

### Test 3: Multiple Strategies (Future)
1. Analysis has 3 strategies (future feature)
2. Conditions met for 2 strategies
3. Verify: conditions_met_count = 2
4. Verify: UI shows correct count in badge/banner

---

## Migration Checklist

- [ ] Update data models to include `conditions_met_count` field
- [ ] Update API response parsing
- [ ] Implement badge indicator on analysis list screen
- [ ] Implement banner on analysis detail screen
- [ ] Add notification trigger logic using `conditions_met_count`
- [ ] Test status polling with conditions met scenario
- [ ] Test UI updates when conditions_met_count changes
- [ ] Update any cached/offline data structures

---

## Summary

| Feature | Old Behavior | New Behavior |
|---------|-------------|--------------|
| Detect conditions met | Parse each strategy's `conditions_met_at` | Use top-level `conditions_met_count` |
| Show list badges | Manual logic per strategy | Simple check: `conditions_met_count > 0` |
| Trigger notifications | Check each strategy individually | Single field indicates any conditions met |
| Performance | Multiple field checks | Single integer comparison |

---

## Support

If you have questions about integration, refer to:
- [MONITORING_STATUS_FLOW.md](MONITORING_STATUS_FLOW.md) - Complete status flow documentation
- [MONITORING_STATUS_FIXES.md](MONITORING_STATUS_FIXES.md) - Technical implementation details
- Backend endpoint: `GET /api/monitoring/status/:analysisId`
