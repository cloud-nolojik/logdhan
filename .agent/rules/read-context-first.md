---
description: "Project context rule - all agents must read this file first to understand the current project"
globs: ["**/*"]
---

# Project Context Rule

**Every agent workflow MUST read `.agent/rules/project-context.md` as its FIRST action before doing any analysis, review, testing, or generation.**

This file contains:
- App name and purpose
- Target users and market
- Architecture and tech stack
- Core domain concepts
- Business rules (non-negotiable)
- Key features
- API patterns

If `project-context.md` is missing or empty, agents should ask the user:
"I need project context to work effectively. Please describe: What does this app do? Who is it for? What tech stack?"
