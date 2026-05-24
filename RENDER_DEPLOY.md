# Deploying PayMyTax API to Render

This backend is ready to deploy on Render as a Web Service. The
`render.yaml` Blueprint in this directory automates most of the setup.

## Quick path (Blueprint)

1. Push this repo to GitHub.
2. On Render: **New → Blueprint → connect your repo**.
3. When prompted, set the **Root Directory** to `backend`.
4. After provisioning, open the service and fill in every env var marked
   "Set in dashboard" (those have `sync: false` in `render.yaml`):
   - `DATABASE_URL` — Neon / Supabase / Render Postgres connection string
   - `FRONTEND_URL` — comma-separated allowed origins
     (e.g. `https://app.paymytax.ng,https://www.paymytax.ng`)
   - `PUBLIC_API_URL` — public hostname of this service
     (e.g. `https://api.paymytax.ng`)
   - `PAYSTACK_*`, `RESEND_API_KEY`, `TERMII_API_KEY`, etc. (optional)
5. Trigger a manual deploy. Render runs `npm ci && npm run build`, then
   `npm start` which executes `prisma migrate deploy` before booting.

## Manual path (no Blueprint)

If you'd rather wire it up by hand:

| Setting | Value |
|---|---|
| **Root Directory** | `backend` |
| **Runtime** | Node |
| **Build Command** | `npm ci && npm run build` |
| **Start Command** | `npm start` |
| **Health Check Path** | `/api/health` |
| **Node Version** | 22 (read from `.nvmrc`) |

Then add the env vars listed in `.env.example`.

## What the start command does

`npm start` runs:
```
prisma migrate deploy && node dist/server.js
```

`prisma migrate deploy` applies any pending migrations against the
production database — safe to run on every boot (no-op if up to date).

If you want to start without running migrations (e.g. a blue/green
deploy where migrations run elsewhere first), use `npm run start:no-migrate`.

## Health check

Render pings `GET /api/health` and expects a 200. That endpoint returns
immediately without touching the database, so a slow DB cold-start
won't cause Render to mark the service unhealthy.

For a deeper check, `GET /api/health/detailed` runs `SELECT 1` against
Postgres. Use this from your own uptime monitor, not as Render's health
check (it can flap on DB hiccups).

## Logs

The Winston logger writes to **stdout only** by default. Render captures
stdout — view logs from the dashboard or stream them with `render logs`.

File logging (`logs/error.log`, `logs/combined.log`) is opt-in via
`ENABLE_FILE_LOGS=true`. Don't enable it on Render — the filesystem is
ephemeral and files vanish on restart.

## Scheduled jobs (reminder cron)

The daily reminder sweep auto-enables when `NODE_ENV=production` (also
the default in the Blueprint). It runs at 00:30 Africa/Lagos and uses
a Postgres advisory lock, so multi-instance deploys won't double-run.

## CORS — the gotcha

`FRONTEND_URL` accepts a **comma-separated list**. If your frontend is
on `https://app.paymytax.ng` and you also serve a marketing site at
`https://www.paymytax.ng` that calls the API, set:

```
FRONTEND_URL=https://app.paymytax.ng,https://www.paymytax.ng
```

A single URL also works. Localhost is always permitted in development.

## Trust proxy

Already handled — when `NODE_ENV=production`, the app sets
`trust proxy: 1` so rate limiting sees the real client IP through
Render's load balancer.
