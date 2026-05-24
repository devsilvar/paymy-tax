# Phase 1: Authentication & Business Management — Implementation Log

## Overview

Phase 1 implements the core authentication system and business CRUD operations for the PayMyTax API. Every future feature (sales, expenses, tax reports, payments) depends on having authenticated users who own businesses, making this the foundational layer of the application.

---

## Files Created

### 1. `src/validators/auth.validator.ts` — Auth Input Validation

**Purpose:** Defines Zod schemas that validate and sanitize all auth-related request bodies before they reach the service layer.

**Schemas:**
- **`registerSchema`** — Validates email (lowercased, trimmed), password (min 8 chars, must contain uppercase + lowercase + number), and optional phone (E.164 format).
- **`loginSchema`** — Validates email and password presence.
- **`refreshTokenSchema`** — Ensures a refresh token string is provided.
- **`changePasswordSchema`** — Validates current password and new password (same strength rules as register).

**Why:** Zod validation runs before any database or bcrypt operations. If input is invalid, the request fails fast with a 400 error — no wasted CPU on hashing or DB queries. The existing `errorHandler.ts` already catches `ZodError` and formats field-level error details automatically.

---

### 2. `src/validators/business.validator.ts` — Business Input Validation

**Purpose:** Validates business creation, update, and listing query parameters.

**Schemas:**
- **`createBusinessSchema`** — Requires `businessName`, `ownerName`, `businessType`. Optional: `taxId`, `address`, `city`, `state`, `defaultProfitMargin` (0-100), `taxReminderDay` (1-28).
- **`updateBusinessSchema`** — Same fields as create but all optional (partial update).
- **`businessQuerySchema`** — Validates pagination params from query string (`page` defaults to 1, `limit` defaults to 10, max 100). Uses `z.coerce.number()` since query params arrive as strings.

---

### 3. `src/middleware/auth.ts` — JWT Authentication Middleware

**Purpose:** Protects routes by verifying JWT access tokens and attaching the decoded user to the request object.

**How it works:**
1. Extracts the `Authorization` header and checks for `Bearer <token>` format.
2. Verifies the token against `config.jwt.accessSecret` using `jsonwebtoken`.
3. On success: attaches `req.user = { userId, email }` and calls `next()`.
4. On failure: throws `AppError` with appropriate code:
   - Missing/malformed header → `UNAUTHORIZED` (401)
   - Expired token → `TOKEN_EXPIRED` (401)
   - Invalid signature → `UNAUTHORIZED` (401)

**Usage:** Applied as route-level middleware. Auth routes use it on `/me` and `/change-password`. Business routes apply it to the entire router via `router.use(authenticate)`.

---

### 4. `src/services/auth.service.ts` — Auth Business Logic

**Purpose:** Contains all authentication logic separated from HTTP concerns. Controllers call these functions; they know nothing about Express.

**Functions:**

#### `register(input)`
1. Checks if email already exists → throws `DUPLICATE_EMAIL` (409).
2. Checks if phone already exists (if provided) → throws `DUPLICATE_PHONE` (409).
3. Hashes password with bcrypt (12 salt rounds — industry standard balance of security vs. speed).
4. Creates user in database via Prisma.
5. Generates JWT pair (access + refresh tokens).
6. Returns user (without `passwordHash`) + both tokens.

#### `login(input)`
1. Finds user by email → throws `INVALID_CREDENTIALS` (401) if not found.
2. Checks `isActive` flag → throws `ACCOUNT_DEACTIVATED` (403) if deactivated.
3. Compares password with bcrypt → throws `INVALID_CREDENTIALS` (401) if wrong.
4. Updates `lastLoginAt` timestamp.
5. Generates and returns JWT pair + user.

#### `refreshAccessToken(refreshToken)`
1. Verifies the refresh token against `config.jwt.refreshSecret`.
2. Looks up the user to confirm they still exist and are active.
3. Issues a new access token only (refresh token stays the same until it expires).

#### `getMe(userId)`
1. Fetches user by ID, strips `passwordHash`, returns profile.

#### `changePassword(userId, currentPassword, newPassword)`
1. Fetches user, verifies current password with bcrypt.
2. Hashes new password, updates in database.

**Token design:**
- Access token: signed with `accessSecret`, expires in 15 minutes. Used for API requests.
- Refresh token: signed with `refreshSecret`, expires in 7 days. Used only to get new access tokens.
- Separate secrets mean a leaked access token can't be used to forge refresh tokens and vice versa.

**Security note:** The `sanitizeUser()` helper strips `passwordHash` from every response. The password hash never leaves the server.

---

### 5. `src/services/business.service.ts` — Business CRUD Logic

**Purpose:** All business operations with ownership enforcement.

**Functions:**

#### `createBusiness(userId, input)`
- Creates a business record linked to the authenticated user's ID.

#### `listBusinesses(userId, page, limit)`
- Fetches only businesses where `userId` matches (users never see other users' businesses).
- Returns paginated response with `{ data, pagination: { page, limit, total, totalPages, hasNext, hasPrev } }`.
- Uses `Promise.all` to run the data query and count query in parallel for performance.

#### `getBusinessById(userId, businessId)`
- Fetches business by ID, then checks `business.userId === userId`.
- Throws `BUSINESS_NOT_FOUND` (404) if doesn't exist, `FORBIDDEN` (403) if user doesn't own it.

#### `updateBusiness(userId, businessId, input)`
- Same ownership check as getById, then applies partial update.

#### `deleteBusiness(userId, businessId)`
- Same ownership check, then hard deletes the business.

**Ownership pattern:** Every function takes `userId` as the first parameter. The service never trusts client-provided user identity — it always comes from the JWT via the controller.

---

### 6. `src/controllers/auth.controller.ts` — Auth Route Handlers

**Purpose:** Thin layer that connects HTTP (req/res) to service functions. Each handler:
1. Parses and validates `req.body` with the appropriate Zod schema.
2. Calls the corresponding service function.
3. Returns a consistent JSON response: `{ success: true, data: ..., message: "..." }`.

**Handlers:**
- `register` → POST, returns 201
- `login` → POST, returns 200
- `refreshToken` → POST, returns 200
- `getMe` → GET, uses `req.user.userId` from JWT middleware
- `changePassword` → PUT, uses `req.user.userId` from JWT middleware

All handlers are wrapped with `asyncHandler` from `errorHandler.ts`, which catches any thrown errors (AppError, ZodError, Prisma errors) and forwards them to the global error handler.

---

### 7. `src/controllers/business.controller.ts` — Business Route Handlers

**Purpose:** Same pattern as auth controllers. Each handler validates input, calls the service, returns response.

**Handlers:**
- `create` → validates body with `createBusinessSchema`, returns 201
- `getAll` → validates query params with `businessQuerySchema`, returns paginated 200
- `getById` → reads `req.params.id`, returns 200
- `update` → validates body with `updateBusinessSchema`, returns 200
- `remove` → reads `req.params.id`, returns 200

All use `req.user!.userId` — the `!` is safe because the `authenticate` middleware runs first and guarantees `req.user` exists.

---

### 8. `src/routes/auth.routes.ts` — Auth Route Definitions

**Endpoints:**

| Method | Path | Middleware | Handler |
|--------|------|-----------|---------|
| POST | `/register` | `authRateLimiter` | `register` |
| POST | `/login` | `authRateLimiter` | `login` |
| POST | `/refresh` | (none) | `refreshToken` |
| GET | `/me` | `authenticate` | `getMe` |
| PUT | `/change-password` | `authenticate` | `changePassword` |

**Rate limiting:** Register and login use `authRateLimiter` (5 failed attempts per 15 minutes, successful requests don't count). This prevents brute-force attacks. Refresh doesn't need rate limiting since it requires a valid token. `/me` and `/change-password` require authentication which is protection enough.

---

### 9. `src/routes/business.routes.ts` — Business Route Definitions

**Endpoints:**

| Method | Path | Handler |
|--------|------|---------|
| POST | `/` | `create` |
| GET | `/` | `getAll` |
| GET | `/:id` | `getById` |
| PUT | `/:id` | `update` |
| DELETE | `/:id` | `remove` |

`authenticate` is applied at the router level via `router.use(authenticate)`, so every business endpoint requires a valid JWT. No anonymous access.

---

## Files Updated

### 10. `src/routes/index.ts` — Main Router

**Before:** Had a placeholder `/v1` route returning a static JSON message listing "coming soon" endpoints.

**After:** Creates a `v1` sub-router and mounts the actual route modules:
```
/health         → health.routes.ts (unchanged)
/v1/auth/*      → auth.routes.ts (new)
/v1/businesses/* → business.routes.ts (new)
```

The placeholder response was removed since real routes now exist.

---

## Architecture Decisions

### Why separate Service and Controller layers?
- **Controllers** handle HTTP: parsing request bodies, setting status codes, formatting responses.
- **Services** handle business logic: database queries, password hashing, token generation.
- This separation means services can be reused (e.g., called from a future CLI tool or background job) without importing Express.

### Why Zod for validation?
- Already a project dependency.
- The existing `errorHandler.ts` has built-in `ZodError` handling that formats field-level errors.
- Type inference via `z.infer<typeof schema>` gives TypeScript types for free.

### Why bcrypt with 12 rounds?
- OWASP recommends 10+ rounds. 12 rounds takes ~250ms to hash — slow enough to resist brute-force, fast enough for good UX.

### Why separate access and refresh secrets?
- If an access token is stolen (e.g., via XSS), the attacker gets 15 minutes of access but can't generate new tokens.
- Refresh tokens are only sent to `/refresh` and never stored in localStorage (the client should use httpOnly cookies or secure storage).

### Why ownership checks in the service layer?
- Every business operation verifies `business.userId === userId` before proceeding.
- This is defense-in-depth: even if a route is misconfigured, the service layer prevents unauthorized access.

---

## Response Format

All endpoints follow the same consistent format used by the existing health routes:

**Success:**
```json
{
  "success": true,
  "data": { ... },
  "message": "Optional success message"
}
```

**Paginated:**
```json
{
  "success": true,
  "data": [ ... ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 25,
    "totalPages": 3,
    "hasNext": true,
    "hasPrev": false
  }
}
```

**Error (handled by global errorHandler):**
```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message",
    "details": { ... }
  }
}
```

---

## Error Codes Reference

| Code | HTTP Status | When |
|------|-------------|------|
| `DUPLICATE_EMAIL` | 409 | Email already registered |
| `DUPLICATE_PHONE` | 409 | Phone number already registered |
| `INVALID_CREDENTIALS` | 401 | Wrong email/password or wrong current password |
| `ACCOUNT_DEACTIVATED` | 403 | User's `isActive` is false |
| `UNAUTHORIZED` | 401 | Missing/invalid/expired token |
| `TOKEN_EXPIRED` | 401 | Access token has expired (client should refresh) |
| `INVALID_REFRESH_TOKEN` | 401 | Refresh token invalid or expired |
| `USER_NOT_FOUND` | 404 | User ID from token doesn't match any user |
| `BUSINESS_NOT_FOUND` | 404 | Business ID doesn't exist |
| `FORBIDDEN` | 403 | User doesn't own the requested business |
| `VALIDATION_ERROR` | 400 | Zod schema validation failed (auto-handled) |

---

## Verification Results

All endpoints tested against the live server with real database operations:

| # | Test | Result |
|---|------|--------|
| 1 | `npm run dev` — server starts | Server started on port 3000 with no errors |
| 2 | `POST /api/v1/auth/register` | 201 — Created user, returned tokens |
| 3 | `POST /api/v1/auth/register` (duplicate) | 409 — `DUPLICATE_EMAIL` error |
| 4 | `POST /api/v1/auth/login` | 200 — Returned user + tokens, updated `lastLoginAt` |
| 5 | `POST /api/v1/auth/refresh` | 200 — Returned new access token |
| 6 | `GET /api/v1/auth/me` | 200 — Returned user profile (no password hash) |
| 7 | `GET /api/v1/auth/me` (no token) | 401 — `UNAUTHORIZED` error |
| 8 | `PUT /api/v1/auth/change-password` | 200 — Password changed |
| 9 | `POST /api/v1/businesses` | 201 — Business created with user ownership |
| 10 | `GET /api/v1/businesses` | 200 — Paginated list of user's businesses |
| 11 | `GET /api/v1/businesses/:id` | 200 — Single business returned |
| 12 | `PUT /api/v1/businesses/:id` | 200 — Business updated (partial update) |
| 13 | `DELETE /api/v1/businesses/:id` | 200 — Business deleted |

---

## Request Flow Diagram

```
Client Request
    │
    ▼
Express App (app.ts)
    │ helmet → cors → bodyParser → morgan → rateLimiter
    ▼
Main Router (routes/index.ts)
    │
    ├── /health → health.routes.ts
    │
    └── /v1
        ├── /auth → auth.routes.ts
        │   ├── POST /register  → [authRateLimiter] → auth.controller.register
        │   ├── POST /login     → [authRateLimiter] → auth.controller.login
        │   ├── POST /refresh   → auth.controller.refreshToken
        │   ├── GET  /me        → [authenticate] → auth.controller.getMe
        │   └── PUT  /change-password → [authenticate] → auth.controller.changePassword
        │
        └── /businesses → business.routes.ts
            │ [authenticate] (all routes)
            ├── POST /         → business.controller.create
            ├── GET  /         → business.controller.getAll
            ├── GET  /:id      → business.controller.getById
            ├── PUT  /:id      → business.controller.update
            └── DELETE /:id    → business.controller.remove

Controller Layer
    │ validates input (Zod) → calls service
    ▼
Service Layer
    │ business logic → Prisma queries → returns data
    ▼
Database (Neon PostgreSQL via Prisma)
```

---

## Phase 1.5: Role-Based Authorization, Admin Panel & Scalability Hardening

After the initial Phase 1 delivery, the following features were added to complete the backend foundation before moving to Phase 2.

---

### 13. Role-Based Authorization

**Files modified:**
- `prisma/schema.prisma` — Added `UserRole` enum (`user`, `admin`) and `role` field on User model with `@default(user)`
- `src/types/index.ts` — Added `role: string` to `JWTPayload`
- `src/middleware/auth.ts` — `authenticate` now extracts `role` from JWT; new `authorize(...roles)` middleware returns 403 if role not in allowed list
- `src/services/auth.service.ts` — `generateTokens`, `register`, `login`, `refreshAccessToken` all include `role` in JWT payload

**Migration:** `20260327190835_add_user_role`

---

### 14. Admin Panel

**Files created:**
- `src/services/admin.service.ts` — `getDashboardStats()`, `listUsers()`, `getUserDetail()`, `toggleUserStatus()`, `listAllBusinesses()`, `listAuditLogs()`
- `src/validators/admin.validator.ts` — Zod schemas for pagination, user search, toggle status, audit log filters
- `src/controllers/admin.controller.ts` — 6 handlers for admin endpoints
- `src/routes/admin.routes.ts` — All routes behind `authenticate` + `authorize('admin')`

**File updated:**
- `src/routes/index.ts` — Mounted admin routes at `/v1/admin`
- `prisma/seed.ts` — Added admin user seed (`admin@paymytax.com` / `Admin@123456`)

**Admin endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/admin/dashboard` | Dashboard stats (users, businesses, reports, revenue, recent signups) |
| GET | `/api/v1/admin/users` | List users (paginated, searchable) |
| GET | `/api/v1/admin/users/:id` | User detail + their businesses |
| PATCH | `/api/v1/admin/users/:id/status` | Activate/deactivate user (cannot modify admin) |
| GET | `/api/v1/admin/businesses` | All businesses across platform |
| GET | `/api/v1/admin/audit-logs` | Audit trail (filterable by userId, action) |

---

### 15. Audit Logging

**File created:** `src/lib/audit.ts`

`logAudit(entry, tx?)` — writes to `audit_logs` table. Accepts optional `TxClient` for transactional mode. Without `tx`, fires-and-forgets so the request is never blocked.

**11 audit events tracked:**

| Service | Action | Trigger |
|---------|--------|---------|
| auth | `user.registered` | User signs up |
| auth | `user.login` | User logs in |
| auth | `user.password_changed` | User changes password |
| auth | `user.password_reset_requested` | User requests reset email |
| auth | `user.password_reset_completed` | User resets password via token |
| business | `business.created` | User creates a business |
| business | `business.updated` | User updates business details |
| business | `business.deleted` | User deletes a business |
| admin | `admin.user_activated` | Admin reactivates a user |
| admin | `admin.user_deactivated` | Admin deactivates a user |

**Files updated:** `auth.service.ts`, `business.service.ts`, `admin.service.ts` — all import and call `logAudit()`.

---

### 16. Transaction Patterns

**File updated:** `src/lib/prisma.ts` — Exports `TxClient` type alias (`Prisma.TransactionClient`)

**Pattern established:**

- **Auth service** — owns its own `prisma.$transaction()` blocks. Register wraps uniqueness check + create user + audit log in one atomic operation. Login wraps lastLoginAt update + audit. Password operations wrap update + audit. Bcrypt hashing done outside the transaction to avoid holding DB locks during CPU work.

- **Business + Admin services** — accept optional `tx?: TxClient` parameter. When called standalone, use global `prisma`. When called inside a larger transaction (e.g., future payment processing), caller passes `tx` for atomicity.

- **`logAudit()`** — dual mode. With `tx`: audit row commits/rolls back with the transaction. Without `tx`: fire-and-forget.

**Files rewritten:** `auth.service.ts` (all mutations wrapped in `$transaction`), `business.service.ts` (accepts `tx`), `admin.service.ts` (accepts `tx`).

---

### 17. Bcrypt Rounds Consistency Fix

**File updated:** `prisma/seed.ts` — Changed `bcrypt.hash(password, 10)` to `bcrypt.hash(password, 12)` to match `auth.service.ts`.

---

## Scalability Review

A full scalability and security review was conducted and documented in `backend/scale.md`. Key findings:

**Resolved:**
- [x] Audit log writes (11 events across all services)
- [x] Bcrypt rounds inconsistency (12 everywhere)
- [x] Transaction patterns (`TxClient`, `$transaction()` on all mutations)

**Open (tracked in scale.md):**
- [ ] P0 — Refresh token revocation
- [ ] P1 — Integration test suite
- [ ] P1 — Background job system (BullMQ + Redis)
- [ ] P1 — Redis caching layer
- [ ] P2 — Docker containerization
- [ ] P2 — Production logging fix
- [ ] P2 — Cursor-based pagination
- [ ] P3 — Eager DB connection removal
- [ ] P3 — API versioning strategy

---

## Current Error Codes Reference (Updated)

| Code | HTTP Status | When |
|------|-------------|------|
| `DUPLICATE_EMAIL` | 409 | Email already registered |
| `DUPLICATE_PHONE` | 409 | Phone number already registered |
| `INVALID_CREDENTIALS` | 401 | Wrong email/password or wrong current password |
| `ACCOUNT_DEACTIVATED` | 403 | User's `isActive` is false |
| `UNAUTHORIZED` | 401 | Missing/invalid/expired token |
| `TOKEN_EXPIRED` | 401 | Access token has expired (client should refresh) |
| `INVALID_REFRESH_TOKEN` | 401 | Refresh token invalid or expired |
| `INVALID_RESET_TOKEN` | 400 | Password reset token invalid or expired |
| `USER_NOT_FOUND` | 404 | User ID from token doesn't match any user |
| `BUSINESS_NOT_FOUND` | 404 | Business ID doesn't exist |
| `FORBIDDEN` | 403 | User doesn't own the requested business / insufficient role |
| `CANNOT_MODIFY_ADMIN` | 400 | Attempted to deactivate an admin user |
| `VALIDATION_ERROR` | 400 | Zod schema validation failed (auto-handled) |

---

## Updated Request Flow Diagram

```
Client Request
    │
    ▼
Express App (app.ts)
    │ helmet → cors → bodyParser → morgan → rateLimiter
    ▼
Main Router (routes/index.ts)
    │
    ├── /health → health.routes.ts
    │
    └── /v1
        ├── /auth → auth.routes.ts
        │   ├── POST /register       → [authRateLimiter] → auth.controller.register
        │   ├── POST /login          → [authRateLimiter] → auth.controller.login
        │   ├── POST /refresh        → auth.controller.refreshToken
        │   ├── GET  /me             → [authenticate] → auth.controller.getMe
        │   ├── PUT  /change-password → [authenticate] → auth.controller.changePassword
        │   ├── POST /forgot-password → [authRateLimiter] → auth.controller.forgotPassword
        │   └── POST /reset-password  → [authRateLimiter] → auth.controller.resetPassword
        │
        ├── /businesses → business.routes.ts
        │   │ [authenticate] (all routes)
        │   ├── POST /         → business.controller.create
        │   ├── GET  /         → business.controller.getAll
        │   ├── GET  /:id      → business.controller.getById
        │   ├── PUT  /:id      → business.controller.update
        │   └── DELETE /:id    → business.controller.remove
        │
        └── /admin → admin.routes.ts
            │ [authenticate] + [authorize('admin')] (all routes)
            ├── GET  /dashboard       → admin.controller.getDashboard
            ├── GET  /users           → admin.controller.listUsers
            ├── GET  /users/:id       → admin.controller.getUserDetail
            ├── PATCH /users/:id/status → admin.controller.toggleUserStatus
            ├── GET  /businesses      → admin.controller.listBusinesses
            └── GET  /audit-logs      → admin.controller.listAuditLogs

Controller Layer
    │ validates input (Zod) → calls service
    ▼
Service Layer
    │ business logic → $transaction() → Prisma queries → logAudit() → returns data
    ▼
Database (Neon PostgreSQL via Prisma)
```

---

## What's Next (Phase 2)

With auth, business management, admin panel, audit logging, and transaction patterns in place, Phase 2 builds the data entry layer:

### Sales Module (Week 4)
- `SalesService` + `SalesController` + `sales.routes.ts` + `sales.validator.ts`
- CRUD with filters (month, source, date range, pagination)
- Monthly summary endpoint
- Period lock check (refuse edits if month's tax report is locked)
- Transaction + audit logging on all mutations

### Expenses Module (Week 5)
- `ExpenseService` + `ExpenseController` + `expenses.routes.ts` + `expense.validator.ts`
- CRUD with filters (month, category, pagination)
- Monthly summary + category breakdown endpoint
- Period lock check
- Expense intelligence alert (if expenses < 5% of sales, flag warning)
- Transaction + audit logging on all mutations

Both modules follow the same patterns established in Phase 1: validator → service (with `tx?`) → controller → route, with `authenticate` middleware and business ownership checks.

See `phase-by-phase-plan.md` for the full remaining roadmap through Phase 6.
