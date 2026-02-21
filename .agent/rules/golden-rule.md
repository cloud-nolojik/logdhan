---
description: "Golden rule for all agents - never overwrite existing work"
globs: ["**/*"]
---

# Golden Rule: Never Overwrite, Always Append

This project has multiple features built over time. Every agent must follow these rules:

## Code
- **New features = new files** — prefer creating new files (models, services, controllers) over cramming into existing ones
- **Modifying existing files** — only ADD new functions/methods, do NOT delete or rewrite existing working functions
- **Existing tests** — NEVER delete or modify passing tests from previous features. Only ADD new tests.

## Documentation
- **CHANGELOG.md** — add new version entries at the TOP. Never modify previous entries.
- **README.md** — append to existing sections. Never remove previous content.
- **API docs** — add new endpoints below existing ones. Never remove previous endpoint docs.
- **FEATURES.md** — append new features. Never remove previous features.
- **JSDoc** — add to new/modified functions only. Don't touch existing JSDoc on unchanged code.

## Database
- **Schemas** — add new fields with defaults so existing data doesn't break. Never remove fields.
- **Migrations** — always additive. Never drop collections or remove indexes in use.

## Before Editing Any File
1. READ the file first
2. Understand what's already there
3. Find the right place to ADD your content
4. Verify you haven't removed anything after editing
