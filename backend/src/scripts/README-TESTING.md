# 🧪 Comprehensive Bulk Analysis Flow Testing

This directory contains comprehensive test scripts to validate the bulk analysis system under various scenarios and user conditions.

## 📋 Available Test Scripts

### 1. `testBulkAnalysisFlow.js` - Database Integration Tests
**Full system testing with database integration**

```bash
npm run test:bulk-flow
# or
node src/scripts/testBulkAnalysisFlow.js
```

**What it tests:**
- ✅ Market timing restrictions at different hours
- ✅ Cross-user cache sharing and efficiency  
- ✅ Session lifecycle management and cancellation
- ✅ Restart behavior with selective deletion logic
- ✅ Error handling for edge cases
- ✅ Concurrent user simulation
- ✅ Performance metrics and cache utilization

### 2. `testLiveBulkAnalysis.js` - Live API Tests
**Real API endpoint testing against running backend**

```bash
npm run test:live
# or  
node src/scripts/testLiveBulkAnalysis.js
```

**What it tests:**
- 🏥 API Health checks
- 🕐 Market timing validation
- 🚀 Complete bulk analysis flow
- 🛑 Session management and cancellation  
- 🔄 Cross-user cache behavior
- 🔄 Restart and selective deletion
- 📊 Strategies endpoint functionality

---

## 🚀 Quick Start

### Prerequisites
```bash
# Install dependencies (if needed)
npm install chalk  # For colored output in live tests

# Ensure backend is running
npm run dev        # In another terminal
```

### Run All Tests
```bash
# Database integration tests (requires MongoDB)
npm run test:bulk-flow

# Live API tests (requires running backend)
npm run test:live
```

---

## 📊 Test Scenarios Covered

### 🕐 **Market Timing Tests**
```
Scenario 1: Before 4 PM     → ❌ Should be blocked
Scenario 2: 4:05 PM         → ✅ Should be allowed  
Scenario 3: 11:30 PM        → ✅ Should be allowed
Scenario 4: Holiday         → ❌ Should be blocked
Scenario 5: Weekend         → ✅ Should be allowed (weekend session)
```

### 👥 **Multi-User Cache Tests**
```
User A: Starts analysis     → Fresh AI analysis generated
User B: Same stocks         → Cache hit, instant response  
User C: Overlapping stocks  → Partial cache hits
User D: Different stocks    → Fresh analysis for new stocks
```

### 🔄 **Session Management Tests**
```
Start → Check Status → Cancel → Restart → Verify Cleanup
   ↓         ↓           ↓        ↓           ↓
 Running   Progress   Cancelled  New Session  Clean State
```

### 🗑️ **Selective Deletion Tests**
```
Before Restart:
✅ 20 completed analyses  (preserved)
❌ 25 failed analyses    (deleted)  
⏳ 5 pending analyses   (deleted)
🔄 3 in-progress        (deleted)

After Restart:
✅ 20 completed analyses  (reused via cache)
🔄 33 stocks to process   (25 failed + 5 pending + 3 in-progress)
```

---

## 📈 Expected Test Results

### ✅ **Successful Test Run Output**
```
🚀 Starting Comprehensive Bulk Analysis Flow Tests

✅ [PASS] Analysis blocked before market session
✅ [PASS] Analysis allowed during permitted hours  
✅ [PASS] Cross-user cache sharing works correctly
✅ [PASS] Session cancellation successful
✅ [PASS] Restart preserves completed analyses
✅ [PASS] Concurrent users handled properly

📊 FINAL TEST RESULTS
================================================================================
Total Tests: 25
✅ Passed: 25  
❌ Failed: 0
Success Rate: 100.00%
```

### ❌ **Failed Test Indicators**
```
❌ [FAIL] Market timing validation incorrect
❌ [FAIL] Cache sharing not working  
❌ [FAIL] Session state inconsistent
❌ [FAIL] Selective deletion logic broken
```

---

## 🛠️ Configuration

### Backend URL Configuration
```javascript
// In testLiveBulkAnalysis.js
const BASE_URL = process.env.BACKEND_URL || 'http://localhost:3000';
```

### Test User Setup
```javascript
// Update with real JWT tokens for live testing
const TEST_SCENARIOS = [
    {
        name: 'Alice - Morning Rush',
        token: 'your_real_jwt_token_here', // ⚠️ Replace this
        expectedTiming: 'allowed'
    }
    // ... more users
];
```

### Database Configuration
```javascript
// Uses MONGODB_URI from environment
await mongoose.connect(process.env.MONGODB_URI);
```

---

## 🎯 Test Categories

### 🔧 **Unit Tests** (Individual Functions)
- Market timing validation logic
- Cache key generation  
- Session state transitions
- Deletion query logic

### 🔗 **Integration Tests** (Database + Logic)
- Cross-user cache sharing
- Session lifecycle management
- Selective deletion behavior
- Error handling and recovery

### 🌐 **API Tests** (Live Endpoints)
- HTTP response validation
- Authentication and authorization
- Error response formats
- Performance characteristics

### 👥 **Concurrency Tests** (Multiple Users)
- Simultaneous analysis starts
- Cache contention handling
- Session isolation
- Database consistency

---

## 📝 Writing Custom Tests

### Add New Test Function
```javascript
async function testNewFeature() {
    log('\\n🆕 Testing New Feature', 'info');
    
    const response = await makeRequest('POST', '/api/new-endpoint', {
        param: 'value'
    }, userToken);
    
    assert(
        response.success,
        'New feature works correctly',
        `Status: ${response.status}`
    );
}

// Add to main test runner
async function runAllTests() {
    // ... existing tests
    await testNewFeature();
}
```

### Custom Assertions
```javascript
function assertCacheHit(response, testName) {
    assert(
        response.data?.cached === true,
        testName,
        `Cache info: ${JSON.stringify(response.data?.cache_info)}`
    );
}

function assertTiming(response, expected, testName) {
    const allowed = response.data?.data?.allowed;
    assert(
        allowed === expected,
        testName,
        `Expected: ${expected}, Got: ${allowed}, Reason: ${response.data?.data?.reason}`
    );
}
```

---

## 🐛 Debugging Failed Tests

### Enable Verbose Logging
```javascript
// In test files, uncomment debug logs
console.log('🔍 Debug:', JSON.stringify(response.data, null, 2));
```

### Common Issues & Solutions

**1. Connection Refused**
```bash
Error: connect ECONNREFUSED 127.0.0.1:3000
Solution: Ensure backend is running on correct port
```

**2. Authentication Errors**
```bash
Error: 401 Unauthorized  
Solution: Update JWT tokens in TEST_SCENARIOS
```

**3. Database Connection Issues**
```bash
Error: MongooseError: Operation failed
Solution: Check MONGODB_URI environment variable
```

**4. Timing Test Failures**
```bash
Error: Expected blocked, got allowed
Solution: Check system time and market timing data
```

---

## 📊 Performance Benchmarks

### Expected Response Times
```
Health Check:        < 100ms
Timing Check:        < 200ms  
Start Analysis:      < 500ms
Status Check:        < 300ms
Cancel Analysis:     < 200ms
Cache Hit:           < 200ms
Fresh Analysis:      60-90 seconds per stock
```

### Cache Hit Rates
```
Single User:         20-30% (no sharing)
Multiple Users:      60-80% (with sharing)
Popular Stocks:      90%+ (high demand stocks)
```

---

## 🎯 Continuous Integration

### GitHub Actions Example
```yaml
name: Bulk Analysis Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
      - run: npm install
      - run: npm run test:bulk-flow
        env:
          MONGODB_URI: ${{ secrets.MONGODB_URI }}
```

### Local Pre-commit Hook
```bash
#!/bin/sh
# .git/hooks/pre-commit
npm run test:bulk-flow
if [ $? -ne 0 ]; then
  echo "❌ Bulk analysis tests failed"
  exit 1
fi
```

---

## 🔍 Monitoring Test Results

### Test Metrics Dashboard
```javascript
// Example metrics collection
const metrics = {
    testDuration: endTime - startTime,
    cacheHitRate: (cacheHits / totalRequests) * 100,
    errorRate: (failures / totalTests) * 100,
    averageResponseTime: totalResponseTime / totalRequests
};
```

### Alerting on Failures
```javascript
if (results.failed > 0) {
    // Send alert to monitoring system
    await sendAlert({
        message: `${results.failed} bulk analysis tests failed`,
        severity: 'high',
        details: results.details
    });
}
```

---

## 📚 Additional Resources

- [Bulk Analysis API Documentation](../docs/bulk-analysis-api.md)
- [Cache Strategy Guide](../docs/caching-strategy.md)
- [Market Timing Rules](../docs/market-timing.md)
- [Performance Optimization](../docs/performance.md)

---

**Happy Testing! 🎉**

Run the tests regularly to ensure your bulk analysis system maintains high reliability and performance as you add new features.