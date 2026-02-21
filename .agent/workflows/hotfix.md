---
description: "Quick bug fix pipeline - paste the bug, this workflow fixes, tests, documents, and commits"
---

# Hotfix Pipeline

You are the **Engineering Manager** handling an urgent bug fix. Execute this shortened pipeline for the bug described.

---

## PHASE 1: DIAGNOSE
Analyze the bug:
1. What is the expected behavior?
2. What is the actual behavior?
3. What is the root cause? (Search the codebase)
4. What files are affected?
5. What is the risk of the fix (could it break something else)?

```
🔍 PHASE 1: DIAGNOSIS
Root cause: [description]
Affected files: [list]
Risk level: Low / Medium / High
```

---

## PHASE 2: HAND OFF FIX TO CLAUDE CODE
⚠️ **STOP. DO NOT WRITE ANY CODE.**

Based on the diagnosis, generate a Claude Code prompt:

```
📋 COPY THIS TO CLAUDE CODE (bottom-right panel):
═══════════════════════════════════════════════════

Fix this bug:

Root cause: [from Phase 1 diagnosis]
File(s) to fix: [from Phase 1]

What to change:
[specific fix instructions]

Rules:
- Minimum change needed — do NOT refactor unrelated code
- Add a comment explaining why the fix was needed
- Write a test that would have caught this bug

═══════════════════════════════════════════════════
```

**Ask:** "Copy this to Claude Code. Once the fix is applied, reply 'done'."

**DO NOT write code yourself. DO NOT proceed until user replies 'done'.**

```
🔧 PHASE 2: FIX HANDED TO CLAUDE CODE
Status: Waiting for user to fix via Claude Code
```

---

## PHASE 3: VERIFY
1. Write a test that would have caught this bug
2. Run existing tests to make sure nothing broke
3. Verify the fix works for the reported scenario

```
🧪 PHASE 3: VERIFIED
New test added: [yes/no]
All existing tests passing: [yes/no]
Bug scenario fixed: [yes/no]
```

**If any check fails: go back to Phase 2.**

---

## PHASE 4: DOCUMENT & COMMIT
1. Add CHANGELOG entry under "Fixed"
2. Generate commit message:

```
fix(scope): short description of what was fixed

Root cause: [brief explanation]
Fix: [what was changed]

Fixes: #[issue number if available]
```

3. Suggest git commands

```
🚀 PHASE 4: READY TO COMMIT
[commit message]
[git commands]
```
