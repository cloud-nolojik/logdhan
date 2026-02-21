---
description: "Coding standards enforced across all agent interactions"
globs: ["**/*.ts", "**/*.js", "**/*.jsx", "**/*.tsx"]
---

# Code Standards

## General
- Use TypeScript strict mode where possible
- All functions must have JSDoc comments with @param and @returns
- No magic numbers - use named constants
- Error handling: Always use try-catch with meaningful error messages
- No console.log in production code - use structured logger

## Naming Conventions
- Files: kebab-case (e.g., `user-position.model.ts`)
- Classes/Interfaces: PascalCase (e.g., `UserPosition`)
- Functions/Variables: camelCase (e.g., `calculateConfidence`)
- Constants: UPPER_SNAKE_CASE (e.g., `MAX_TRAILING_SL_MOVES`)
- MongoDB collections: lowercase plural (e.g., `userpositions`)

## Backend (Node.js/Express)
- Controllers: thin, delegate to services
- Services: business logic layer, never import Express types
- Models: Mongoose schemas with proper validation
- Middleware: reusable, single-purpose
- Routes: grouped by feature, not by HTTP method

## Frontend (React)
- Functional components only with hooks
- Custom hooks for shared logic (prefix: `use`)
- Component files: one component per file
- Props: always typed with TypeScript interfaces
- State management: minimal, local state preferred

## MongoDB
- Always use indexes for queried fields
- Aggregation pipelines over multiple queries
- Use lean() for read-only queries
- Never store calculated fields that can be derived

## Testing
- Unit tests for all service functions
- Integration tests for API endpoints
- Test file naming: `*.test.ts` or `*.spec.ts`
- Minimum coverage: 80% for services, 60% for controllers

## Security
- Never expose internal IDs in API responses without sanitization
- Validate all inputs at controller level
- Rate limit all public endpoints
- Sanitize MongoDB queries against injection
