# Antigravity Multi-Agent Engineering Team — Workflow Guide

## How It Works

All agents **auto-adapt** to your project. You just need ONE file per project:

```
your-project/
├── .agent/
│   ├── rules/
│   │   ├── project-context.md    ← YOU FILL THIS (describes YOUR app)
│   │   ├── golden-rule.md        ← Copy from package
│   │   ├── code-standards.md     ← Copy from package
│   │   ├── code-writing-rule.md  ← Copy from package
│   │   └── read-context-first.md ← Copy from package
│   └── workflows/
│       ├── (all .md workflow files)  ← Copy ALL from package
```

**That's it.** Every agent reads `project-context.md` and adapts automatically.
Personas, product vision, business rules — all auto-detected from your context.

## Setup Steps

1. Copy `rules/` into your project's `.agent/rules/`
2. Copy `workflows/` into your project's `.agent/workflows/`
3. Copy `templates/project-context.template.md` → `.agent/rules/project-context.md`
4. **Fill in project-context.md** with YOUR app's details
5. Open Antigravity → verify workflows under `...` → Customizations → Workflows

## Gemini + Claude Code Workflow

```
Gemini (top-right)          You (Director)         Claude Code (bottom-right)
─────────────────          ──────────────         ─────────────────────────
Plans & reviews     →→→    Reads output    →→→    Writes code
                    ←←←    Types 'next'    ←←←    
Reviews code        →→→    Types 'done'    ←←←    Fixes issues
```

Gemini NEVER writes code. Claude Code NEVER plans. You coordinate.

## All 21 Commands

| Command | Agent | What It Does |
|---------|-------|-------------|
| `/build` | Full Pipeline | 12-phase from requirement to commit |
| `/hotfix` | Quick Fix | 4-phase bug fix |
| `/requirement` | Business Analyst | Stories + edge cases |
| `/plan` | Tech Lead | Implementation blueprint |
| `/review` | Code Reviewer | Architecture, security, performance |
| `/refactor` | Architect | Tech debt cleanup |
| `/design-web` | Web Designer | Responsive, accessibility, Indian UX |
| `/design-mobile` | Mobile Designer | Android/iOS, budget devices |
| `/test-backend` | Backend QA | Services, models, database |
| `/test-api` | API QA | Endpoints, auth, validation |
| `/test-ui` | Frontend QA | User flows, responsive |
| `/security` | Security Auditor | Vulnerabilities, injection, auth |
| `/perf` | Performance Tester | Response times, slow networks |
| `/deps` | Dependency Auditor | Vulnerable npm packages |
| `/docs` | Technical Writer | API docs, CHANGELOG |
| `/commit` | Release Engineer | Conventional commits |
| `/migrate` | DB Migration | Safe schema changes |
| `/deploy` | Pre-Deploy Gate | Final production checklist |
| `/pm-review` | Product Manager | Vision alignment |
| `/client` | Client Simulator | Auto-generates personas + simulates |

## `/build` Pipeline (12 Phases)

```
Phase 1:  📋 Requirement Analysis         (Gemini)
Phase 2:  🏗️ Implementation Plan           (Gemini)
Phase 3:  💻 → HAND OFF TO CLAUDE CODE     (You paste prompt)
Phase 4:  🔍 Code Review                   (Gemini)
Phase 5:  🔧 → HAND OFF FIXES             (You paste fix prompt)
Phase 6:  🧪 Backend Tests                 (Gemini)
Phase 7:  🌐 API Tests                     (Gemini)
Phase 8:  🔒 Security Audit                (Gemini)
Phase 9:  ⚡ Performance Check              (Gemini)
Phase 10: 📝 Documentation                 (Gemini)
Phase 11: 🚀 Commit Preparation            (Gemini)
Phase 12: ✅ Done
```

## Your Reply Keywords

| You Type | What Happens |
|----------|-------------|
| `next` | Move to next phase |
| `done` | Claude Code finished, continue review |
| `commit` | Execute git commands |
| `edit` | Modify commit message |

## Auto-Adaptive — No Manual Personas Needed

Every agent reads project-context.md and adapts:

| Agent | Auto-Adapts |
|-------|------------|
| `/client` | Generates 4 personas from your target users |
| `/pm-review` | Detects product principles from context |
| `/security` | Adapts to app type (fintech/civic/SaaS) |
| `/perf` | Targets your devices and network |
| `/review` | Validates your business rules |
| `/design-*` | Uses your brand and platform info |
| `/test-*` | Tests your domain logic |
