# Scalability & Security Review — PayMyTax Backend

> Reviewed: 2026-03-27
> Last updated: 2026-03-27
> Codebase state: MVP with auth, business CRUD, admin panel, role-based authorization

---

## What's Done Well

- **Clean layered architecture** — controller -> service -> Prisma. Separation of concerns is solid.
- **Centralized config** — single source of truth, validated on startup.
- **Prisma singleton** — prevents connection pool exhaustion during dev hot-reload.
- **Structured logging** — Winston with JSON format in production, ready for log aggregation (ELK, Datadog).
- **Graceful shutdown** — handles SIGTERM/SIGINT, closes DB connections. Production-ready.
- **Rate limiting** — tiered (global, auth, payment). Correct approach.
- **Error handling** — centralized with AppError, Zod, and Prisma error mapping. Consistent API error format.
- **Zod validation** — input validation at the boundary, before business logic.
- **Role-based authorization** — admin/user roles with middleware-level enforcement.
- **Audit logging** — `logAudit()` helper writes to audit_logs table across all mutations (auth, business, admin). Supports both fire-and-forget and transactional modes.
- **Transaction patterns** — `TxClient` type established. Auth service owns its own `$transaction()` blocks. Business/admin services accept optional `tx` for composability. Audit writes participate in transactions when `tx` is passed.
- **Consistent bcrypt rounds** — 12 everywhere (auth service + seed).

---

## Scalability Concerns

### ~~1. No Test Suite (Critical)~~ — Still open

**Current state:** Zero tests. Only a `test-setup.ts` that checks imports can load.

**Why it matters:** As more features integrate (payments, tax filing, notifications), you'll ship regressions constantly. Every new developer on the team becomes afraid to change existing code. Refactoring becomes impossible without confidence.

**What's needed:**
- Service-layer unit tests (Vitest or Jest)
- API integration tests (Supertest)
- At minimum: auth flow tests, business CRUD tests, admin authorization tests

**Files affected:** New `__tests__/` or `*.test.ts` files alongside services/controllers.

---

### 2. No Refresh Token Rotation / Blacklisting — Still open

**Current state:** Refresh tokens are stateless JWTs with no revocation mechanism. Once issued, they're valid until expiry (7 days by default).

**Why it matters:** If a refresh token leaks (XSS, stolen device, compromised client), there is zero way to invalidate it. For a financial platform handling tax payments, this is a security risk.

**What's needed (pick one):**
- **Option A:** Store refresh tokens in DB, validate on each use, delete on logout
- **Option B:** Token rotation — issue a new refresh token on every use, invalidate the old one
- **Option C:** Redis-based token blacklist with TTL matching token expiry

**Files affected:** `auth.service.ts`, possibly new `RefreshToken` model in schema.prisma.

---

### ~~3. No Audit Log Writes~~ — RESOLVED

Implemented `src/lib/audit.ts` with `logAudit()` helper. 11 audit events tracked across auth (register, login, password change, password reset request, password reset complete), business (create, update, delete), and admin (activate/deactivate user). Supports transactional mode via optional `tx` parameter.

---

### 4. No Background Job System — Still open

**Current state:** Everything runs in the HTTP request cycle. No queues, no workers, no cron jobs.

**Why it matters:** The platform will need:
- Scheduled tax reminders (the `Reminder` model exists but nothing sends them)
- Payment reconciliation with Paystack
- PDF generation for tax statements
- Email/SMS sending (currently just logs to console)
- Monthly tax report auto-generation

Running these in the request cycle blocks responses, causes timeouts, and fails silently if the server restarts mid-operation.

**What's needed:**
- BullMQ + Redis for job queues
- A separate worker process (or use the same process with BullMQ workers)
- Job types: `send-email`, `send-sms`, `generate-pdf`, `send-reminder`, `reconcile-payment`

**Files affected:** New `src/jobs/` directory, `src/lib/queue.ts`, worker entry point.

---

### 5. No Caching Layer — Still open

**Current state:** Redis URL is in `.env.example` and config, but Redis is never actually connected or used anywhere.

**Why it matters:**
- Admin dashboard stats (`getDashboardStats()`) runs 5 DB queries on every request — fine now, expensive at scale
- Rate limiting uses in-memory store — breaks with multiple server instances (each instance has its own counter)
- Frequently accessed data (user profile, business details) could benefit from caching

**What's needed:**
- Connect Redis client (`ioredis` or `@upstash/redis`)
- Cache dashboard stats with short TTL (60s)
- Use Redis-backed rate limiter (`rate-limit-redis`) for distributed deployments
- Optionally cache user sessions

**Files affected:** New `src/lib/redis.ts`, update `security.ts` rate limiters, update `admin.service.ts`.

---

### 6. File-Based Logging Won't Scale in Production — Still open

**Current state:** Production logging writes to `logs/error.log` and `logs/combined.log` on the local filesystem.

**Why it matters:** In containerized or serverless environments (Docker, Lambda, Railway, Fly.io), the filesystem is ephemeral. Logs disappear when containers restart. Multiple instances write to separate files with no aggregation.

**What's needed:**
- Log to stdout/stderr only (containers capture this automatically)
- Ship logs to a centralized service: CloudWatch, Datadog, Logtail, or Betterstack
- Remove file transports or make them dev-only

**Files affected:** `src/lib/logger.ts`

---

### 7. No Cursor-Based Pagination — Still open

**Current state:** All pagination uses offset-based (`skip/take`). Example: page 500 with limit 20 means the DB scans and discards 9,980 rows before returning 20.

**Why it matters:** Audit logs, sales transactions, and tax reports will grow into millions of rows. Offset pagination degrades linearly — page 10,000 is 10,000x slower than page 1.

**What's needed:**
- Cursor-based pagination using `createdAt` + `id` as cursor
- Keep offset pagination for admin panels (where page numbers matter for UX)
- Use cursor pagination for API consumers and infinite-scroll UIs

**Files affected:** Services that return paginated data, new cursor pagination utility.

---

### 8. Eager Database Connection at Import Time — Still open

**Current state:** `src/lib/prisma.ts` calls `prisma.$connect()` at import time (module load).

**Why it matters:**
- In serverless (Vercel, Lambda), this adds cold-start latency on every function invocation
- Prisma already lazy-connects on the first query — the explicit `$connect()` is redundant
- If the DB is temporarily down at startup, the app crashes instead of gracefully retrying

**What's needed:**
- Remove the explicit `$connect()` call
- Let Prisma handle connection lifecycle automatically
- If you want a health check, do it in the `/health` endpoint instead

**Files affected:** `src/lib/prisma.ts`

---

### 9. No API Versioning Strategy — Still open

**Current state:** Routes are prefixed with `/v1` but there's no plan for how v2 routes would coexist alongside v1.

**Why it matters:** Once external clients (mobile app, third-party integrations) consume your API, breaking changes require versioning. Without a strategy, you'll either break clients or accumulate hacks.

**What's needed:**
- Decide on versioning approach: URL-based (`/v1`, `/v2`) vs header-based (`Accept-Version`)
- Document which routes are stable vs experimental
- Plan deprecation process (sunset headers, migration guides)

**Files affected:** `src/routes/index.ts`, documentation.

---

### 10. No Docker / Containerization — Still open

**Current state:** No Dockerfile, no docker-compose.yml. Development runs directly on the host machine.

**Why it matters:**
- "Works on my machine" problems across team members
- No consistent environment between dev/staging/production
- Can't horizontally scale without containerization
- Most deployment platforms (Railway, Fly.io, AWS ECS) expect Docker images

**What's needed:**
- `Dockerfile` with multi-stage build (build stage + production stage)
- `docker-compose.yml` for local development (API + PostgreSQL + Redis)
- `.dockerignore` to exclude node_modules, .env, etc.

**Files affected:** New files at project root.

---

### ~~11. Hardcoded Business Logic Values~~ — PARTIALLY RESOLVED

**Resolved:** Bcrypt rounds now consistent at 12 across auth service and seed.

**Still open:**
- Tax rate `7.5%` hardcoded in seed data
- Rate limit values partially in config, partially hardcoded
- Reset token expiry `60 minutes` hardcoded in auth service
- Auth rate limiter `5 requests / 15 minutes` hardcoded in security middleware

---

### ~~12. No Request-Level Transaction Handling~~ — RESOLVED

Implemented `TxClient` type alias exported from `src/lib/prisma.ts`. Auth service uses `prisma.$transaction()` internally for all multi-step mutations. Business and admin services accept optional `tx?: TxClient` parameter for composability in future multi-service operations (e.g., payment processing). `logAudit()` participates in transactions when `tx` is passed, falls back to fire-and-forget otherwise.

---

## Priority Matrix (Updated)

| Priority | Issue | Status | Effort | Impact |
|----------|-------|--------|--------|--------|
| ~~**P0**~~ | ~~#3 — Audit log writes~~ | DONE | ~~Low~~ | ~~High~~ |
| ~~**P0**~~ | ~~#11 — Bcrypt inconsistency~~ | DONE | ~~Trivial~~ | ~~Medium~~ |
| ~~**P1**~~ | ~~#12 — Transaction patterns~~ | DONE | ~~Low~~ | ~~High~~ |
| **P0** | #2 — Refresh token revocation | Open | Medium | High (security) |
| **P1** | #1 — Add integration tests | Open | Medium | High (reliability) |
| **P1** | #4 — Background job system | Open | Medium | High (feature enablement) |
| **P1** | #5 — Connect Redis for caching | Open | Low | Medium (performance) |
| **P2** | #10 — Dockerfile + docker-compose | Open | Low | Medium (deployment) |
| **P2** | #6 — Fix production logging | Open | Low | Medium (observability) |
| **P2** | #7 — Cursor-based pagination | Open | Medium | Low (until data grows) |
| **P2** | #11 — Remaining hardcoded values | Open | Low | Low |
| **P3** | #8 — Remove eager DB connection | Open | Trivial | Low |
| **P3** | #9 — API versioning strategy | Open | Low | Low |
