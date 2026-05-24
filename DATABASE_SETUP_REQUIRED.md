# ⚠️ Database Setup Required

## Current Issue

The Supabase database at `db.yohizqldizehbwtnjznl.supabase.co` is **not reachable**. This could mean:

1. ❌ The Supabase project has been deleted or paused
2. ❌ The hostname is incorrect
3. ❌ Network/firewall blocking the connection
4. ❌ The database instance is inactive (free tier pauses after inactivity)

## ✅ Quick Solutions (Choose One)

### Option 1: Neon (RECOMMENDED - From Your Implementation Plan)

**Why Neon?**
- ✅ Free tier with 0.5GB storage
- ✅ Auto-scaling
- ✅ Never pauses
- ✅ Fast serverless Postgres
- ✅ Great for development

**Setup Steps:**

1. **Go to https://neon.tech**
2. **Sign up** (free, no credit card required)
3. **Create a new project:**
   - Project name: `paymytax-dev`
   - Region: Choose closest to you
   - Postgres version: 16 (recommended)
4. **Copy connection string** from dashboard
   - Click "Connection Details"
   - Copy the connection string that looks like:
     ```
     postgresql://user:password@ep-xxx-xxx.us-east-2.aws.neon.tech/dbname?sslmode=require
     ```
5. **Update `.env` file:**
   ```bash
   DATABASE_URL=postgresql://user:password@ep-xxx-xxx.us-east-2.aws.neon.tech/dbname?sslmode=require
   ```
6. **Run setup:**
   ```bash
   cd backend
   npm run prisma:generate
   npm run prisma:migrate
   npm run prisma:seed
   npm run dev
   ```

### Option 2: Fix Supabase Connection

**If you want to keep using Supabase:**

1. **Log into Supabase Dashboard:** https://supabase.com/dashboard
2. **Check your project status:**
   - Is the project paused? Resume it
   - Is the project deleted? Create a new one
3. **Get the correct connection string:**
   - Go to: Settings → Database
   - Use "Connection Pooling" mode (recommended for Prisma)
   - Copy the connection string:
     ```
     postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
     ```
   - **Note:** Use port `6543` (pooler) NOT `5432` (direct)
4. **Add `?pgbouncer=true` to the URL:**
   ```bash
   DATABASE_URL=postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres?pgbouncer=true
   ```
5. **Update transaction mode in Prisma:**
   ```prisma
   // In prisma/schema.prisma
   datasource db {
     provider = "postgresql"
     url      = env("DATABASE_URL")
     // Add this line if using connection pooling
     directUrl = env("DIRECT_URL") // Optional: for migrations
   }
   ```
6. **Run setup:**
   ```bash
   cd backend
   npm run prisma:generate
   npm run prisma:migrate
   npm run prisma:seed
   npm run dev
   ```

### Option 3: Local PostgreSQL (For Quick Testing)

**Using Docker (Easiest):**

```bash
# Run PostgreSQL in Docker
docker run -d \
  --name paymytax-postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=paymytax_dev \
  -p 5432:5432 \
  postgres:16

# Update .env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/paymytax_dev

# Run setup
cd backend
npm run db:setup
npm run dev
```

**Manual Installation:**

1. **Download PostgreSQL 16:** https://www.postgresql.org/download/
2. **Install and remember your password**
3. **Create database:**
   ```sql
   -- Open pgAdmin or psql
   CREATE DATABASE paymytax_dev;
   ```
4. **Update `.env`:**
   ```bash
   DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/paymytax_dev
   ```
5. **Run setup:**
   ```bash
   cd backend
   npm run db:setup
   npm run dev
   ```

### Option 4: Railway (Free Tier)

1. **Go to https://railway.app**
2. **Sign up and create new project**
3. **Add PostgreSQL database**
4. **Copy connection string from Variables tab**
5. **Update `.env` and run setup**

## 🧪 Test Your Connection

After updating the DATABASE_URL, test the connection:

```bash
cd backend

# Test 1: Generate Prisma Client
npm run prisma:generate

# Test 2: Push schema to database (creates tables)
npx prisma db push

# Test 3: Check connection in Prisma Studio
npm run prisma:studio
```

If all succeed, you'll see:
```
✔ Generated Prisma Client
✔ The database is now in sync with your Prisma schema
✔ Prisma Studio is up on http://localhost:5555
```

## 📋 After Database is Connected

Once you have a working database connection, complete Phase 0:

```bash
# Full setup (recommended)
npm run db:setup

# Or step by step:
npm run prisma:generate    # Generate Prisma Client
npm run prisma:migrate     # Create database tables
npm run prisma:seed        # Add test data
npm run dev                # Start server

# Test endpoints
curl http://localhost:3000/api/health/detailed
```

## 🎯 Expected Output

When everything works, you should see:

```bash
=================================
🚀 PayMyTax API Server Started
=================================
Environment: development
Port: 3000
API Version: v1
Health Check: http://localhost:3000/api/health
=================================
```

And the health check should return:

```json
{
  "status": "healthy",
  "timestamp": "2026-03-23T17:06:00.000Z",
  "service": "paymytax-api",
  "version": "1.0.0",
  "checks": {
    "database": "connected",
    "uptime": 5.123,
    "memory": {
      "used": 45,
      "total": 120,
      "unit": "MB"
    }
  }
}
```

## 💡 Recommendation

**Use Neon for this project** because:
1. ✅ It's mentioned in your implementation plan
2. ✅ Free tier is generous
3. ✅ Never pauses (unlike Supabase free tier)
4. ✅ Great for serverless/edge deployments
5. ✅ Excellent for development and production

## 🆘 Still Having Issues?

If you continue to have problems:

1. **Check firewall:** Ensure ports 5432/6543 aren't blocked
2. **Check VPN:** Some VPNs block database connections
3. **Check antivirus:** Temporarily disable to test
4. **Try a different network:** Mobile hotspot, etc.
5. **Check database provider status:** Look for service outages

---

**Status:** ⏸️ Phase 0 paused - waiting for database connection  
**Next Step:** Set up database using one of the options above  
**Team:** WallX Engineering
