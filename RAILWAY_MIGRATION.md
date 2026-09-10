# Railway Migration Guide — Live on Railway, Tests on Supabase

Target architecture:

| Environment | Where | Purpose |
|---|---|---|
| **Live / production** | Railway (backend service + Postgres) | Real user data. Tests NEVER touch it. |
| **Tests** | Supabase Postgres (current DB) | Sacrificial — `clearDatabase()` wipes it freely. |

Everything below assumes `backend/`.

---

## 1. Environment variable layout (after cutover)

```env
# LIVE — Railway Postgres (Railway provides DATABASE_URL; also wire DIRECT_URL)
DATABASE_URL=postgresql://postgres:***@<railway-proxy-host>:<port>/railway
DIRECT_URL=postgresql://postgres:***@<railway-proxy-host>:<port>/railway

# TESTS — the existing Supabase database
TEST_DATABASE_URL=postgresql://postgres.yohizqldizehbwtnjznl:***@aws-1-eu-west-1.pooler.supabase.com:5432/postgres
```

How the wiring works (already implemented):
- `tests/helpers/loadEnv.ts` redirects `DATABASE_URL` + `DIRECT_URL` to
  `TEST_DATABASE_URL` for the whole jest process — including `src/lib/prisma`
  used by e2e tests via `createApp()`. Jest runs cannot see Railway at all.
- `tests/helpers/test-db.ts` allows `clearDatabase()` unconditionally when
  `TEST_DATABASE_URL` is set (it's a dedicated test DB — wiping is the point).

⚠️ **In `.env` today `TEST_DATABASE_URL` is still commented out — keep it that
way until step 3 is done.** While Supabase holds the only copy of real data,
activating it turns your test suite back into a data-shredder.

---

## 2. Provision Railway

1. Create a Railway project → add **PostgreSQL** → add the backend service
   (repo root dir: `backend`, start command `npm start` — the package.json
   already runs `prisma migrate deploy` before boot).
2. Backend service variables (Railway → Variables). Reference the Postgres
   service with `${{Postgres.DATABASE_URL}}` for both:
   - `DATABASE_URL` and `DIRECT_URL` (same value is fine on Railway — it's a
     direct connection, no pooler, so migrations work).
   - Carry over **all** secrets from `.env`: `JWT_ACCESS_SECRET`,
     `JWT_REFRESH_SECRET`, `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`,
     `PAYSTACK_WEBHOOK_SECRET`, `RESEND_API_KEY`,
     **`PII_ENCRYPTION_KEY`** (critical — different key = BVN/NIN ciphertext
     becomes undecryptable), `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` (only
     if any code still uses Supabase storage), `FRONTEND_URL`.
   - `NODE_ENV=production`. Leave `ENABLE_CRON` unset (prod auto-enables the
     reminder cron — note it will run against Railway data).
3. Set the public domain; note the API URL for the frontend/Vite proxy.

---

## 3. Move the data (Supabase → Railway)

1. `prisma migrate deploy` runs automatically on Railway start and builds the
   full schema on the empty Railway DB (all 40 migrations are in
   `prisma/migrations/`).
2. Restore the data from local backup, pointed at Railway:
   ```powershell
   cd backend
   $env:DATABASE_URL = '<RAILWAY DATABASE_URL>'; npx tsx src/scripts/db-restore.ts
   ```
   (`db-restore.ts` is idempotent — safe to re-run.) Restore #4 already proved
   this exact flow works against a live Postgres.
3. Verify with `npx tsx src/scripts/db-verify-login.ts` after temporarily
   setting `DATABASE_URL` to Railway (it also simulates logins).

---

## 4. Flip tests to Supabase (the cutover moment)

Only AFTER step 3 is verified:

1. Uncomment `TEST_DATABASE_URL` in `.env` (point it at Supabase — use the
   **5432 direct** URL for reliability under jest).
2. Sanity-run: `npx jest tests/env-redirect.check.test.ts`-style check or any
   single test — the setup banner must say
   `🧪 Tests redirected to TEST_DATABASE_URL (db: "postgres")`.
3. Run the full suite freely: `npm run test:integration`,
   `npm run test:e2e`. It wipes/fills Supabase and never touches Railway.

Keeping the Supabase test schema in sync: when migrations change, run
`$env:DATABASE_URL='<SUPABASE_URL>'; npx prisma migrate deploy` once in a while
(or before a test session that needs new columns).

---

## 5. Post-cutover checklist

- [ ] Paystack dashboard: update webhook URL to
      `https://<railway-domain>/api/webhooks/paystack`
- [ ] `FRONTEND_URL` includes your production frontend origin (CORS)
- [ ] Frontend: point `/api` proxy or `VITE_API_BASE_URL` at the Railway API
- [ ] `npm run db:backup` against Railway (add it to Railway as a cron service
      later; the script is plain tsx)
- [ ] Supabase test DB: expect it to be wiped constantly — never store real
      data there again
- [ ] Delete `ALLOW_TEST_DB_WIPE` from any shell profile — with the dedicated
      test DB it's unnecessary
