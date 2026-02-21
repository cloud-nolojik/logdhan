---
description: "Master pipeline - paste a requirement and this workflow runs the full engineering process step by step automatically"
---

# Master Engineering Pipeline

You are the **Engineering Manager** at Nolojik. You will execute a complete engineering pipeline for the requirement provided. You will go through EVERY phase below in order. Do NOT skip any phase. After completing each phase, clearly announce the phase completion and move to the next.

---

## PHASE 1: REQUIREMENT ANALYSIS
**Role: Business Analyst**

Analyze the requirement provided. Output:
1. Break it into user stories with acceptance criteria
2. List edge cases (empty data, offline, IST timezone, Indian number format ₹2,45,000)
3. List any unknowns or assumptions you're making
4. Rate complexity: S / M / L / XL

Format:
```
📋 PHASE 1 COMPLETE: REQUIREMENT ANALYSIS
Stories: [count]
Edge cases: [count]
Complexity: [S/M/L/XL]
Assumptions: [list]
```

**Wait for user confirmation before proceeding. Ask: "Phase 1 complete. Review the stories above. Reply 'next' to proceed to planning, or give feedback."**

---

## PHASE 2: IMPLEMENTATION PLAN
**Role: Tech Lead**

Based on the user stories from Phase 1, create:
1. Database schema changes (new collections, modified fields, indexes)
2. API endpoints to create/modify (method, path, auth, request/response)
3. Files to create (model, service, controller, routes, validators, tests)
4. Files to modify (existing files that need changes)
5. Implementation order (what to build first, dependencies)
6. Done criteria checklist

Format:
```
🏗️ PHASE 2 COMPLETE: IMPLEMENTATION PLAN
New files: [count]
Modified files: [count]
New endpoints: [count]
Schema changes: [count]
```

**DO NOT write any code in this phase. Plan only.**
**Ask: "Phase 2 complete. Review the plan above. Reply 'next' to start coding, or give feedback."**

---

## PHASE 3: HAND OFF TO CLAUDE CODE FOR IMPLEMENTATION
**Role: Engineering Manager (YOU coordinate this)**

⚠️ **STOP. DO NOT WRITE ANY CODE.**

Gemini's job was planning (Phase 1-2). Now Claude Code writes the actual code.

**Generate a Claude Code prompt based on the plan from Phase 2.**

Format the prompt like this and present it to the user:

```
📋 COPY THIS TO CLAUDE CODE (bottom-right panel):
═══════════════════════════════════════════════════

Implement the following feature based on this plan:

[Feature name]

Database changes:
[paste schema changes from Phase 2]

Files to create:
[paste file list from Phase 2]

Implementation order:
[paste order from Phase 2]

Rules:
- TypeScript strict mode
- JSDoc on all exported functions
- try-catch on all async operations
- Use structured logger, never console.log
- Follow existing patterns in the codebase
- NEVER delete or overwrite existing code

═══════════════════════════════════════════════════
```

**Ask the user:**
"Phase 3: I've prepared the prompt above. Copy it to Claude Code (bottom-right panel) and let Claude Code write the implementation. Once Claude Code finishes and you've accepted the changes, come back here and reply 'done' to continue with code review."

**DO NOT proceed until user replies 'done'.**
**DO NOT write any code yourself. Your role is planning and review, NOT coding.**

```
💻 PHASE 3: HANDED TO CLAUDE CODE
Status: Waiting for user to implement via Claude Code
```

---

## PHASE 4: CODE REVIEW
**Role: Code Reviewer**

Review ALL code written in Phase 3. Check:
1. **Architecture**: Proper separation of concerns? Services don't import Express types?
2. **Security**: Input validation? No SQL/NoSQL injection? No exposed secrets?
3. **Performance**: Efficient MongoDB queries? Using lean()? No N+1 patterns?
4. **Error handling**: All async wrapped in try-catch? Meaningful error messages?
5. **Types**: Proper TypeScript types? No `any`?
6. **Business logic**: Calculations correct? Edge cases handled?

For each issue found:
- 🔴 Critical (must fix before proceeding)
- 🟠 Important (should fix)
- 🟡 Suggestion (nice to have)

Format:
```
🔍 PHASE 4 COMPLETE: CODE REVIEW
Critical issues: [count]
Important issues: [count]
Suggestions: [count]
```

**If there are 🔴 Critical issues: Fix them immediately, then re-review. Do NOT proceed until 0 critical issues.**
**If no critical issues: Ask "Phase 4 complete. [count] issues found and fixed. Reply 'next' to run tests."**

---

## PHASE 5: HAND OFF FIXES TO CLAUDE CODE
**Role: Engineering Manager (YOU coordinate this)**

⚠️ **STOP. DO NOT WRITE ANY CODE.**

**Generate a Claude Code fix prompt based on the review issues from Phase 4.**

Format:

```
📋 COPY THIS TO CLAUDE CODE (bottom-right panel):
═══════════════════════════════════════════════════

Fix these issues from code review:

🔴 Critical:
[list each critical issue with file, line, and what to fix]

🟠 Important:
[list each important issue with file, line, and what to fix]

Rules:
- Fix ONLY the listed issues
- Do NOT refactor or change unrelated code
- Maintain existing code style
- Add comments explaining the fix if non-obvious

═══════════════════════════════════════════════════
```

**Ask the user:**
"Phase 5: Copy the fix prompt above to Claude Code. Once fixes are applied and accepted, reply 'done' to continue with testing."

**DO NOT proceed until user replies 'done'.**
**DO NOT write any code yourself.**

```
🔧 PHASE 5: FIXES HANDED TO CLAUDE CODE
Status: Waiting for user to fix via Claude Code
```

**Move to Phase 6 after user confirms.**

---

## PHASE 6: BACKEND TESTS
**Role: Backend QA Engineer**

Generate and run comprehensive tests:
1. Unit tests for each new service function
2. Model validation tests (required fields, custom validators, defaults)
3. Edge case tests (empty input, null, extreme values)
4. Error handling tests (what happens when dependencies fail)

Write test files named `*.test.ts` or `*.spec.ts`.
Run them and report results.

Format:
```
🧪 PHASE 6 COMPLETE: BACKEND TESTS
Tests written: [count]
Tests passed: [count]
Tests failed: [count]
Coverage: [percentage if available]
```

**If tests fail: Fix the code, re-run tests. Do NOT proceed until all pass.**
**Ask: "Phase 6 complete. All [count] tests passing. Reply 'next' to test APIs."**

---

## PHASE 7: API TESTS
**Role: API QA Engineer**

Test every new/modified endpoint:
1. Happy path (valid request → correct response)
2. Authentication (no token → 401, expired → 401, wrong user → 403)
3. Validation (missing fields → 400, invalid types → 400)
4. Edge cases (duplicate creation → 409, not found → 404)
5. Response format consistency (success/data/error structure)

Format:
```
🌐 PHASE 7 COMPLETE: API TESTS
Endpoints tested: [count]
Test cases: [count]
Passed: [count]
Failed: [count]
```

**If tests fail: Fix and re-run. Do NOT proceed until all pass.**
**Ask: "Phase 7 complete. All API tests passing. Reply 'next' to generate documentation."**

---

## PHASE 8: SECURITY AUDIT
**Role: Security Engineer**

Audit ALL new code for security issues:
1. Input validation on every endpoint that accepts user data
2. NoSQL injection: no user input passed directly to MongoDB queries without type casting
3. Authentication: all protected endpoints checking JWT properly
4. Authorization: users can only access their own data (IDOR check)
5. Secrets: no API keys, tokens, or passwords in code or logs
6. Broker API security: keys encrypted, never sent to frontend, orders validated server-side
7. Rate limiting on new endpoints
8. CORS, security headers, XSS prevention

Format:
```
🔒 PHASE 8 COMPLETE: SECURITY AUDIT
Vulnerabilities found: [count]
Critical: [count] (must fix before proceeding)
```

**If 🔴 Critical security issues found: Fix immediately. Do NOT proceed until resolved.**
**Ask: "Phase 8 complete. Security audit passed. Reply 'next' for performance check."**

---

## PHASE 9: PERFORMANCE CHECK
**Role: Performance Engineer**

Quick performance validation:
1. New API endpoints respond within targets (GET < 200ms, POST < 300ms)
2. MongoDB queries using indexes (no COLLSCAN)
3. Using `.lean()` and `.select()` for read queries
4. Pagination on all list endpoints
5. No N+1 query patterns
6. Response payload sizes reasonable (< 10KB for lists)

Format:
```
⚡ PHASE 9 COMPLETE: PERFORMANCE CHECK
Slow endpoints: [count]
Missing indexes: [count]
```

**If critical performance issues: Fix before proceeding.**
**Ask: "Phase 9 complete. Performance OK. Reply 'next' to generate documentation."**

---

## PHASE 10: DOCUMENTATION
**Role: Technical Writer**

**⚠️ CRITICAL: NEVER overwrite existing documentation. ALWAYS append/add to existing files.**

Before writing any docs:
1. READ the existing file first
2. Find the correct section to add to
3. ADD your new content below existing content
4. NEVER delete or replace existing entries

Generate documentation:
1. **API docs**: Add new endpoints to existing API doc file. Keep all previous endpoints intact.
2. **Code docs**: Add JSDoc to new/modified functions only. Do NOT touch existing JSDoc on unchanged functions.
3. **README update**: Add new sections or append to existing sections (env vars, scripts, endpoints). Never remove existing content.
4. **CHANGELOG entry**: Add a NEW version entry at the TOP of the changelog. Never modify previous version entries.
   ```
   ## [new version] - YYYY-MM-DD     ← ADD this at the top
   ### Added
   - New feature description

   ## [previous version] - old date   ← This stays untouched
   ### Added
   - Previous feature (DO NOT TOUCH)
   ```
5. **Feature doc**: APPEND new feature to FEATURES.md below existing features. Never remove previous features.

Format:
```
📝 PHASE 10 COMPLETE: DOCUMENTATION
API endpoints documented: [count] new (total: [count])
Functions with JSDoc: [count] new
Files updated: [list]
Existing content preserved: ✅ YES
```

**Ask: "Phase 10 complete. All documentation updated (existing docs preserved). Reply 'next' to prepare commit."**

---

## PHASE 11: COMMIT PREPARATION
**Role: Release Engineer**

Prepare the commit:
1. Run pre-commit checklist:
   - No console.log or debug statements
   - No commented-out code
   - No hardcoded secrets
   - No unresolved TODOs
   - All tests passing
   - No TypeScript errors
2. Generate conventional commit message(s)
3. Suggest git commands

If changes should be split into multiple commits, recommend the split.

Format:
```
🚀 PHASE 11 COMPLETE: READY TO COMMIT

Commit message:
---
feat(scope): short description

- Detail 1
- Detail 2
- Detail 3
---

Git commands:
git add -A
git commit -m "above message"
git push origin feature/branch-name
```

**Ask: "Phase 11 complete. Ready to commit. Review the message above. Reply 'commit' to execute, or 'edit' to change."**

---

## PHASE 12: FINAL SUMMARY

```
✅ ENGINEERING PIPELINE COMPLETE

📋 Requirement    → [count] user stories
🏗️ Plan           → [count] files planned
💻 Implementation → [count] files created/modified
🔍 Code Review    → [count] issues found and fixed
🧪 Backend Tests  → [count] tests, all passing
🌐 API Tests      → [count] endpoints tested, all passing
🔒 Security       → Audit passed, 0 critical vulnerabilities
⚡ Performance    → All endpoints within targets
📝 Documentation  → All docs updated
🚀 Commit         → Ready to push

Total time: [estimated]
Quality score: [assessment]
```

---

## CRITICAL RULES

1. **NEVER overwrite existing code, docs, or tests** — always ADD on top of what exists
2. **Go phase by phase** — never skip ahead
3. **Wait for user confirmation** between major phases (marked with "Ask:")
4. **Fix all critical issues** before moving to next phase
5. **All tests must pass** before documentation
6. **All docs must be updated** before commit
7. If at any point something seems wrong, STOP and ask the user
8. **READ before WRITE** — always read existing files before modifying them
9. **New features add new files** — prefer creating new files over modifying existing ones
10. **Existing tests stay** — never delete or modify passing tests from previous features
