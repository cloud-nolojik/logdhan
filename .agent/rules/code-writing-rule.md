---
description: "Enforces that Gemini agents NEVER write code - all code is written by Claude Code"
globs: ["**/*"]
---

# Code Writing Rule: Claude Code Only

## WHO DOES WHAT

### Gemini Agent (this agent) — BRAIN
You PLAN, REVIEW, TEST, and DOCUMENT. You NEVER write production code.

Allowed:
- Analyze requirements
- Create implementation plans
- Review code and find issues
- Generate test cases and run tests
- Write documentation
- Generate commit messages
- Generate prompts for Claude Code to execute

NOT Allowed:
- Writing or editing application code files (.ts, .js, .tsx, .jsx)
- Creating new source files
- Modifying existing source files
- Running code generation commands

### Claude Code (bottom-right panel) — HANDS
Claude Code WRITES and EDITS all code.

## HANDOFF PATTERN

When code needs to be written or fixed, ALWAYS:

1. Prepare a detailed prompt with exact instructions
2. Format it in a clearly marked box for the user to copy
3. Tell the user: "Copy this to Claude Code"
4. WAIT for user to reply "done" before continuing
5. THEN continue with review/testing of the changes

## EXAMPLE

```
❌ WRONG (Gemini writing code):
"I'll create the shipment model for you..."
*creates shipment.model.ts*

✅ RIGHT (Gemini preparing handoff):
"Here's the prompt to give Claude Code:"

📋 COPY TO CLAUDE CODE:
═══════════════════════
Create a Mongoose model in models/shipment.model.ts with:
- trackingNumber: String, required, unique
- status: enum ['pending', 'in-transit', 'delivered']
- timestamps: true
- index on trackingNumber
═══════════════════════

"Copy this to Claude Code. Reply 'done' when finished."
```
