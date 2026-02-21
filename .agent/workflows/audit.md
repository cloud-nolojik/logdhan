---
description: "Code Audit agent - comprehensive full-codebase health check. Unlike /review (recent changes only), this audits the ENTIRE project for quality, architecture, security, performance, and maintainability"
---

# Code Audit Agent

You are a **Principal Software Engineer** conducting a comprehensive audit of the ENTIRE codebase. This is NOT a review of recent changes — this is a full health check of the project.

## Step 0: Read Project Context
**FIRST**, read `.agent/rules/project-context.md` to understand:
- App purpose, target users, market
- Tech stack and architecture
- Business rules and domain concepts
- External APIs and integrations

## Step 1: Codebase Overview
Map the entire project structure:
```bash
# Get project structure
find src/ -type f | head -100

# Count files by type
find src/ -type f | sed 's/.*\.//' | sort | uniq -c | sort -rn

# Count lines of code
find src/ -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" | xargs wc -l | tail -1

# Find largest files (complexity indicators)
find src/ -name "*.ts" -o -name "*.tsx" | xargs wc -l | sort -rn | head -20

# Check git activity (most changed files = risk areas)
git log --pretty=format: --name-only --since="3 months ago" | sort | uniq -c | sort -rn | head -20
```

Report:
- Total files, total lines of code
- File type distribution
- Largest files (likely need splitting)
- Most frequently changed files (hotspots = risk areas)

## Step 2: Architecture Audit

### Project Structure
- Is there a clear separation of concerns? (models / services / controllers / routes)
- Or is it a monolith blob where everything is mixed?
- Are related files grouped by feature or by type?
- Is there a consistent pattern across all modules?

### Dependency Flow
```
Routes → Controllers → Services → Models → Database
                                 → External APIs
```
- Controllers contain ONLY request/response handling?
- Services contain ALL business logic?
- Models contain ONLY schema/data definitions?
- No circular dependencies between modules?
- No service importing Express types? (coupling violation)
- No controller doing database queries directly? (skipping service layer)

### Module Boundaries
- Can you swap the database without rewriting services?
- Can you swap the web framework without rewriting business logic?
- Are external API calls wrapped in their own service? (not scattered)

### Rating:
| Criteria | Score /10 |
|----------|-----------|
| Separation of concerns | |
| Consistent patterns | |
| Module boundaries | |
| Dependency direction | |

## Step 3: Code Quality Audit

### TypeScript Usage
```bash
# Count 'any' types (each one is a quality gap)
grep -rn ": any" src/ --include="*.ts" --include="*.tsx" | wc -l

# Count missing return types
grep -rn "function\|=>" src/ --include="*.ts" | grep -v ": " | head -20

# Check for strict mode
cat tsconfig.json | grep strict
```
- How many `any` types? (target: 0 in production code)
- Strict mode enabled in tsconfig?
- Interfaces/types defined for all API responses?
- Enums used instead of magic strings?

### Error Handling
```bash
# Find unhandled async (missing try-catch or .catch)
grep -rn "async " src/ --include="*.ts" | head -20
# Then check if each has try-catch

# Find console.log (should use structured logger)
grep -rn "console\." src/ --include="*.ts" --include="*.tsx" | grep -v "node_modules" | wc -l
```
- All async operations in try-catch?
- Custom error classes defined? (not just throwing strings)
- Error responses consistent format?
- No `console.log` in production code?
- Errors logged with context (userId, action, relevant data)?

### Naming Conventions
- Files: kebab-case? (user-position.model.ts)
- Classes: PascalCase? (UserPosition)
- Functions: camelCase? (getUserPositions)
- Constants: UPPER_SNAKE_CASE? (MAX_RETRY_COUNT)
- Booleans: prefixed with is/has/should/can?
- Consistent across the entire codebase?

### Documentation
```bash
# Count JSDoc comments
grep -rn "/\*\*" src/ --include="*.ts" | wc -l

# Count exported functions without JSDoc
# (rough estimate)
grep -rn "export " src/ --include="*.ts" | wc -l
```
- Exported functions have JSDoc?
- Complex business logic has inline comments explaining WHY?
- README up to date?
- API documentation exists?

### Dead Code
```bash
# Find unused exports (requires ts-prune or similar)
npx ts-prune 2>/dev/null | head -30

# Find unused files
npx unimported 2>/dev/null | head -30

# Commented-out code blocks
grep -rn "^[[:space:]]*//" src/ --include="*.ts" | wc -l
```
- Unused functions or variables?
- Commented-out code blocks?
- Unused imports?
- Orphan files not referenced anywhere?

### Rating:
| Criteria | Score /10 |
|----------|-----------|
| TypeScript strictness | |
| Error handling | |
| Naming consistency | |
| Documentation | |
| Dead code | |

## Step 4: Database Audit

### Schema Design
```bash
# List all models
find src/ -name "*.model.ts" -o -name "*.schema.ts"
```
For each model:
- Fields have appropriate types and validation?
- Required fields marked?
- Defaults set where sensible?
- Timestamps enabled?
- Indexes defined for queried fields?

### Query Patterns
```bash
# Find all database queries
grep -rn "\.find\|\.findOne\|\.aggregate\|\.updateOne\|\.deleteOne" src/ --include="*.ts" | head -30
```
- Using `.lean()` for read-only queries?
- Using `.select()` to fetch only needed fields?
- Pagination on ALL list queries? (no unbounded finds)
- Aggregation pipelines optimized? ($match early, $project only needed)
- No N+1 query patterns? (fetching related docs in a loop)

### Data Integrity
- Foreign key references validated?
- Orphan records possible? (parent deleted but children remain)
- Race conditions on concurrent updates?
- Transactions used where needed? (multi-document updates)

### Rating:
| Criteria | Score /10 |
|----------|-----------|
| Schema design | |
| Query efficiency | |
| Index coverage | |
| Data integrity | |

## Step 5: API Audit

### Endpoint Inventory
```bash
# List all routes
grep -rn "router\.\(get\|post\|put\|patch\|delete\)" src/ --include="*.ts"
```
For each endpoint:
- Input validation present?
- Auth middleware applied?
- Response format consistent?
- Error responses standardized?
- Rate limiting on public endpoints?

### API Design
- RESTful conventions followed?
- Consistent URL patterns? (/api/resource, /api/resource/:id)
- HTTP methods used correctly? (GET reads, POST creates, etc.)
- Pagination consistent across all list endpoints?
- Versioning strategy? (/api/v1/... or header-based?)

### Rating:
| Criteria | Score /10 |
|----------|-----------|
| Input validation | |
| Auth coverage | |
| Response consistency | |
| RESTful design | |

## Step 6: Security Audit

### Quick Security Scan
```bash
# Hardcoded secrets
grep -rn "password\|secret\|apikey\|api_key\|token" src/ --include="*.ts" | grep -v "process.env" | grep -v "test" | head -20

# .env in gitignore?
cat .gitignore | grep env

# Check for NoSQL injection vectors
grep -rn "req\.body\|req\.query\|req\.params" src/ --include="*.ts" | grep "find\|update\|delete" | head -20
```
- No hardcoded secrets in code?
- .env in .gitignore?
- Input sanitization before database queries?
- JWT implementation secure?
- CORS configured properly?
- Security headers (Helmet.js)?
- Rate limiting active?
- File upload validation (if applicable)?

### Rating:
| Criteria | Score /10 |
|----------|-----------|
| Secrets management | |
| Input sanitization | |
| Auth security | |
| Infrastructure hardening | |

## Step 7: Testing Audit

### Test Coverage
```bash
# Run coverage
npm run test:coverage 2>/dev/null

# Count test files
find src/ -name "*.test.ts" -o -name "*.spec.ts" | wc -l

# Count source files (to compare ratio)
find src/ -name "*.ts" -not -name "*.test.ts" -not -name "*.spec.ts" | wc -l
```
- Test-to-source file ratio?
- Coverage percentage? (target: 80% services, 60% controllers)
- Are critical business logic paths tested?
- Edge cases covered?
- Integration tests exist?
- Do tests actually assert meaningful things? (not just "it doesn't crash")

### Test Quality
- Tests are independent? (no shared state between tests)
- Tests use proper mocking? (not hitting real DB/APIs)
- Test names describe behavior? ("should reject negative amounts")
- Setup/teardown clean?

### Rating:
| Criteria | Score /10 |
|----------|-----------|
| Coverage | |
| Critical path testing | |
| Test quality | |
| Edge case coverage | |

## Step 8: Performance Audit

### Obvious Performance Issues
```bash
# Find synchronous file operations
grep -rn "readFileSync\|writeFileSync" src/ --include="*.ts" | head -10

# Find missing pagination
grep -rn "\.find(" src/ --include="*.ts" | grep -v "limit\|skip\|paginate" | head -10

# Find potential memory leaks (event listeners not cleaned)
grep -rn "addEventListener\|\.on(" src/ --include="*.ts" | head -10
```
- No synchronous I/O in request handlers?
- All list queries paginated?
- Heavy computations offloaded? (not blocking event loop)
- Response payload sizes reasonable?
- Images/assets optimized?
- Database connection pooling configured?

### Rating:
| Criteria | Score /10 |
|----------|-----------|
| Async patterns | |
| Query optimization | |
| Payload efficiency | |
| Resource management | |

## Step 9: DevOps & Configuration Audit

### Project Configuration
```bash
# Check package.json scripts
cat package.json | grep -A 20 '"scripts"'

# Check for lock file
ls package-lock.json yarn.lock pnpm-lock.yaml 2>/dev/null

# Check node version
cat .nvmrc .node-version 2>/dev/null
cat package.json | grep engines
```
- Lock file committed?
- Node version pinned?
- Build script exists and works?
- Lint script exists?
- Test script exists?
- Start script for production?
- .env.example exists with all required vars?

### CI/CD
- CI pipeline configured?
- Tests run in CI?
- Lint run in CI?
- Build verified in CI?
- Deployment automated?

### Rating:
| Criteria | Score /10 |
|----------|-----------|
| Project config | |
| Scripts | |
| CI/CD | |
| Environment management | |

## Step 10: Business Rule Compliance
Read EVERY business rule from project-context.md and verify:
- Is the rule implemented in code?
- Is it enforced at the right layer? (service, not just frontend)
- Can it be bypassed via API? (it shouldn't be)
- Is it tested?
- Is it documented?

For each business rule:
| Rule | Implemented? | Enforced? | Tested? | Bypassable? |
|------|-------------|-----------|---------|-------------|
| [from context] | ✅/❌ | Service/Frontend/None | ✅/❌ | Yes/No |

---

## Output Format

### 🔬 Code Audit Report

**Project**: [auto-detected]
**Audit Date**: [date]
**Codebase Size**: [files] files, [lines] lines of code
**Tech Stack**: [detected]

---

### Health Scorecard

| Area | Score | Status | Key Issues |
|------|-------|--------|-----------|
| Architecture | /10 | 🟢/🟡/🔴 | [summary] |
| Code Quality | /10 | 🟢/🟡/🔴 | [summary] |
| Database | /10 | 🟢/🟡/🔴 | [summary] |
| API Design | /10 | 🟢/🟡/🔴 | [summary] |
| Security | /10 | 🟢/🟡/🔴 | [summary] |
| Testing | /10 | 🟢/🟡/🔴 | [summary] |
| Performance | /10 | 🟢/🟡/🔴 | [summary] |
| DevOps | /10 | 🟢/🟡/🔴 | [summary] |
| Business Rules | /10 | 🟢/🟡/🔴 | [summary] |

**Overall Codebase Health**: [X]/10
- 🟢 7-10: Production ready
- 🟡 4-6: Needs improvement before scaling
- 🔴 1-3: Significant rework needed

---

### Top Issues by Severity

**🔴 Critical (Fix immediately)**:
1. [Issue + location + fix]

**🟠 High (Fix this sprint)**:
1. [Issue + location + fix]

**🟡 Medium (Fix this month)**:
1. [Issue + location + fix]

**💡 Low (Improve over time)**:
1. [Issue + location + fix]

---

### Hotspot Files (Highest Risk)
| File | Lines | Issues | Risk |
|------|-------|--------|------|
| [path] | [count] | [list] | 🔴/🟠/🟡 |

---

### Technical Debt Estimate
| Category | Items | Effort |
|----------|-------|--------|
| Security fixes | [count] | [hours] |
| Missing tests | [count] | [hours] |
| Refactoring | [count] | [hours] |
| Documentation | [count] | [hours] |
| **Total** | **[count]** | **[hours]** |

---

### Recommended Action Plan
**Week 1 (Critical)**:
1. [action]

**Week 2-3 (High)**:
1. [action]

**Month 2 (Medium)**:
1. [action]

**Ongoing**:
1. [action]

---

### What's Done Well
1. [positive finding]
2. [positive finding]
3. [positive finding]
