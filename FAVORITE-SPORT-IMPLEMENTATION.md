# Favorite Sport Feature Implementation Guide

## ✅ Completed Backend Changes

### 1. User Model Update ([backend/src/models/user.js](backend/src/models/user.js#L42-L46))
Added `favorite_sport` field:
```javascript
favorite_sport: {
  type: String,
  enum: ['cricket', 'football', 'kabaddi', 'badminton', 'chess', 'racing', 'battle_royale', 'basketball', 'tennis', 'boxing', 'carrom', 'hockey', 'volleyball', 'none'],
  default: null
}
```

### 2. Profile API Update ([backend/src/routes/auth.js](backend/src/routes/auth.js#L201-L234))
Updated PUT `/auth/profile` endpoint to accept and validate `favorite_sport`:
- Validates sport against supported list
- Only updates if provided
- Returns updated user profile

###3. AI Analysis Integration ([backend/src/services/aiAnalyze.service.js](backend/src/services/aiAnalyze.service.js))
- **Line 363-374**: Fetches user's `favorite_sport` in `analyzeStock()`
- **Line 464**: Passes `game_mode: favoriteSport` to analysis
- **Line 545**: Updated `generateAIAnalysisWithProgress()` to accept `game_mode`
- **Line 2202**: Updated `stage3Finalize()` to pass `game_mode` to prompt builder
- **Line 2203**: Passes `game_mode` to `buildStage3Prompt()`

Result: AI now generates personalized sports analogies based on user's favorite sport!

---

## 📱 Remaining Frontend Tasks

### Task 1: Add ProfileCompletion Screen (NEW FILE)
**Location**: `/Users/nolojik/Documents/logdhan-app/composeApp/src/commonMain/kotlin/com/nolojik/logdhan/feature/auth/ProfileCompletionScreen.kt`

**Purpose**: Show after OTP verification if `firstName` or `favorite_sport` is missing

**Key Features**:
1. **Header**: "Complete Your Profile" with friendly message
2. **First Name Input**: Text field (required)
3. **Sport Selection Grid**: Beautiful grid of sport cards with icons
4. **Supported Sports**:
   - Cricket 🏏
   - Football ⚽
   - Kabaddi 🤼
   - Badminton 🏸
   - Chess ♟️
   - Racing 🏎️
   - Battle Royale 🎮
   - Basketball 🏀
   - Tennis 🎾
   - Boxing 🥊
   - Carrom 🎯
   - Hockey 🏑
   - Volleyball 🏐
   - None (Plain English)
5. **Explanation**: "We'll use your favorite sport to explain trading strategies in a fun way!"
6. **Submit Button**: "Continue" (enabled only when both fields filled)

**Design Guidelines**:
- Use gradient background like OTPLoginScreen
- Sport cards: 2 columns, rounded corners, with sport icon/emoji
- Selected sport: highlighted border with AppColors.LogOrange
- Smooth animations for selection
- Validation: Show error if firstName < 2 characters

### Task 2: Update Navigation Flow
**File**: `/Users/nolojik/Documents/logdhan-app/composeApp/src/commonMain/kotlin/com/nolojik/logdhan/navigation/AppNavigation.kt`

**Changes**:
1. Add new enum: `Screen.ProfileCompletion`
2. After OTP success (line 335-373), check if profile is complete:
```kotlin
onLoginSuccess = { loginResponse ->
    // ... existing auth token setup ...

    // Check if profile needs completion
    val needsProfileCompletion = loginResponse?.firstName.isNullOrBlank() ||
                                 loginResponse?.favorite_sport.isNullOrBlank()

    if (needsProfileCompletion) {
        currentScreen = Screen.ProfileCompletion
    } else {
        hasConsented = loginResponse?.hasConsented ?: false
        // ... existing consent flow ...
    }
}
```

3. Add ProfileCompletionScreen case:
```kotlin
Screen.ProfileCompletion -> {
    ProfileCompletionScreen(
        apiService = apiService,
        authRepository = authRepository,
        onProfileCompleted = {
            // Refetch profile and continue to consent gate/main app
            coroutineScope.launch {
                val profileResult = apiService.getUserProfile()
                profileResult.fold(
                    onSuccess = { response ->
                        hasConsented = response.data?.hasConsented ?: false
                        currentScreen = if (hasConsented) Screen.MainApp else Screen.ConsentGate
                    },
                    onFailure = { currentScreen = Screen.MainApp }
                )
            }
        }
    )
}
```

### Task 3: Update LoginResponse Model
**File**: `/Users/nolojik/Documents/logdhan-app/composeApp/src/commonMain/kotlin/com/nolojik/logdhan/network/models.kt` (or similar)

Add `favorite_sport` field to LoginResponse:
```kotlin
@Serializable
data class LoginResponse(
    val success: Boolean,
    val token: String? = null,
    val firstName: String? = null,
    val favorite_sport: String? = null,
    val hasConsented: Boolean = false,
    // ... other fields ...
)
```

### Task 4: Update PersonalInfoScreen
**File**: `/Users/nolojik/Documents/logdhan-app/composeApp/src/commonMain/kotlin/com/nolojik/logdhan/feature/profile/PersonalInfoScreen.kt`

**Changes**:
1. Add `favorite_sport` state variable
2. Add sport selection dropdown/picker
3. Include in profile update API call
4. Show current favorite sport

---

## 🎨 UI Design Reference

### Sport Selection Grid Example:
```
┌─────────────────────────────────────┐
│  Complete Your Profile              │
│                                     │
│  What's your name?                  │
│  ┌─────────────────────────────┐   │
│  │ First Name                   │   │
│  └─────────────────────────────┘   │
│                                     │
│  Pick your favorite sport          │
│  (We'll use it to explain trades!) │
│                                     │
│  ┌──────────┐  ┌──────────┐        │
│  │   🏏    │  │   ⚽    │        │
│  │ Cricket  │  │ Football │        │
│  └──────────┘  └──────────┘        │
│  ┌──────────┐  ┌──────────┐        │
│  │   🤼    │  │   🏸    │        │
│  │ Kabaddi  │  │ Badminton│        │
│  └──────────┘  └──────────┘        │
│  ... more sports ...                │
│                                     │
│  ┌─────────────────────────────┐   │
│  │      Continue ➔              │   │
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘
```

---

## 🧪 Testing

### Backend Tests:
1. **Profile API**:
   ```bash
   # Test profile update with favorite_sport
   curl -X PUT http://localhost:5000/api/auth/profile \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"firstName": "John", "lastName": "Doe", "favorite_sport": "cricket"}'
   ```

2. **Validation**:
   ```bash
   # Test invalid sport (should return 400)
   curl -X PUT http://localhost:5000/api/auth/profile \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"favorite_sport": "invalid_sport"}'
   ```

3. **AI Analysis**:
   - Create analysis for a user with `favorite_sport = "football"`
   - Check Stage 3 output in `debug-logs/` folder
   - Verify UI text uses football terminology

### Frontend Tests:
1. **New User Flow**:
   - Log in with new phone number
   - Should see ProfileCompletionScreen
   - Fill name and select sport
   - Should navigate to consent gate/main app

2. **Existing User Flow**:
   - Log in with existing account (has name + sport)
   - Should skip ProfileCompletionScreen
   - Go directly to consent gate/main app

3. **Profile Update**:
   - Go to Profile > Personal Info
   - Change favorite sport
   - Save and verify update

---

## 📝 API Response Examples

### GET /auth/profile
```json
{
  "success": true,
  "data": {
    "_id": "user123",
    "firstName": "John",
    "lastName": "Doe",
    "mobileNumber": "911234567890",
    "favorite_sport": "cricket",
    "hasConsented": true
  }
}
```

### PUT /auth/profile
```json
{
  "success": true,
  "message": "Profile updated successfully",
  "data": {
    "_id": "user123",
    "firstName": "John",
    "lastName": "Doe",
    "favorite_sport": "football",
    "hasConsented": true
  }
}
```

---

## 🔄 Migration

No migration needed! The `favorite_sport` field has `default: null`, so:
- Existing users: Will see ProfileCompletionScreen on next login
- New users: Will see it after OTP verification
- All users eventually complete their profile

---

## ✨ Example AI Output with Sports

**User with favorite_sport = "cricket"**:
```json
{
  "ui_friendly": {
    "why_smart_move": "Like timing a perfect cover drive, we wait for price to break ₹420 with volume before aiming for ₹450 boundary.",
    "ai_will_watch": [
      "I'll alert when price crosses ₹420 (like waiting for the right ball)",
      "If price drops below ₹405 before entry, we'll reset the field",
      "Stop-loss at ₹400 protects your wicket if the move fails"
    ]
  }
}
```

**User with favorite_sport = "football"**:
```json
{
  "ui_friendly": {
    "why_smart_move": "Like positioning for a counter-attack, we enter at ₹420 when defense breaks, targeting ₹450 goal.",
    "ai_will_watch": [
      "I'll alert when price breaks through ₹420 defense line",
      "If price retreats below ₹405, we abort the attack",
      "Stop-loss at ₹400 is your goalkeeper protection"
    ]
  }
}
```

**User with favorite_sport = "none"**:
```json
{
  "ui_friendly": {
    "why_smart_move": "Price breaking above ₹420 resistance with strong volume aims for ₹450 while protecting at ₹400.",
    "ai_will_watch": [
      "I'll alert when price crosses ₹420 with volume confirmation",
      "If price drops below ₹405 before entry, the setup is cancelled",
      "If price hits ₹400 after entry, I'll recommend exiting to protect capital"
    ]
  }
}
```

---

## 🎯 Summary

✅ **Completed**:
- Backend: User model, API endpoint, AI integration
- Database: Schema supports 13 sports + "none"
- AI: Personalized sports analogies based on user preference

📱 **Remaining** (Frontend):
1. Create ProfileCompletionScreen.kt
2. Update AppNavigation.kt
3. Update LoginResponse model
4. Update PersonalInfoScreen

**Estimated Time**: 2-3 hours for all frontend changes

---

**Questions? Check the prompt file for supported sports list:**
[backend/src/prompts/swingPrompts.js:287-289](backend/src/prompts/swingPrompts.js#L287-L289)
