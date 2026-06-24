# PayMyTax Backend API

> SME Tax Calculation & Remittance Platform - Backend Service

## 🚀 Quick Start

### Prerequisites
- Node.js 20+
- PostgreSQL 16+ (or Neon account)
- npm or yarn

### Installation

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your actual credentials

# Generate Prisma client
npm run prisma:generate

# Run database migrations
npm run prisma:migrate

# Seed the database with test data
npm run prisma:seed
```

### Development

```bash
# Start development server with hot reload
npm run dev

# Server will be available at http://localhost:3000
```

### Testing Paystack webhooks locally (ngrok)

Paystack can't reach `localhost`. Run `ngrok http 3000`, copy the
`https://<id>.ngrok-free.app` URL, append `/api/webhooks/paystack`, and paste
into the Paystack dashboard (Test Mode → Settings → API Keys & Webhooks →
Webhook URL). Full walkthrough + gotchas in `../paymentPlan.md` →
"Local webhook tunneling (ngrok)". `PAYSTACK_PREFERRED_BANK` is auto-detected
from `PAYSTACK_SECRET_KEY` (`sk_test_*` → `test-bank`, else `wema-bank`) — no
config needed unless you use a non-Wema live partner bank.

### Database Commands

```bash
# Generate Prisma client
npm run prisma:generate

# Create and run migrations
npm run prisma:migrate

# Open Prisma Studio (Database GUI)
npm run prisma:studio

# Seed database with test data
npm run prisma:seed

# Reset database (WARNING: deletes all data)
npm run prisma:reset

# Full database setup (generate + migrate + seed)
npm run db:setup
```

### Production

```bash
# Build TypeScript
npm run build

# Run production migrations
npm run prisma:migrate:prod

# Start production server
npm start
```

## 📁 Project Structure

```
backend/
├── prisma/
│   ├── schema.prisma      # Database schema
│   └── seed.ts            # Database seeding script
├── src/
│   ├── config/            # Configuration management
│   │   └── index.ts       # Central config with env validation
│   ├── controllers/       # Route controllers (coming in Phase 1+)
│   ├── lib/               # Shared utilities
│   │   ├── logger.ts      # Winston logger setup
│   │   └── prisma.ts      # Prisma client singleton
│   ├── middleware/        # Express middleware
│   │   ├── errorHandler.ts    # Global error handler
│   │   ├── requestLogger.ts   # HTTP request logger
│   │   └── security.ts        # Security middleware (helmet, cors, rate limit)
│   ├── routes/            # API route definitions
│   │   ├── index.ts       # Main router
│   │   └── health.routes.ts   # Health check endpoints
│   ├── services/          # Business logic (coming in Phase 1+)
│   ├── types/             # TypeScript type definitions
│   ├── validators/        # Zod schemas for validation
│   ├── app.ts             # Express app configuration
│   └── server.ts          # Server entry point
├── .env                   # Environment variables (gitignored)
├── .env.example           # Environment variables template
├── .gitignore            # Git ignore rules
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript configuration
└── README.md             # This file
```

## 🔌 API Endpoints

### Health Check
```
GET  /api/health          # Basic health check
GET  /api/health/detailed # Detailed health with DB status
```

### API Info
```
GET  /                    # API information
GET  /api/v1              # API v1 information
```

### Coming Soon (Phase 1+)
- Authentication (`/api/v1/auth`)
- Business Management (`/api/v1/businesses`)
- Sales Tracking (`/api/v1/businesses/:id/sales`)
- Expense Tracking (`/api/v1/businesses/:id/expenses`)
- Tax Calculation (`/api/v1/businesses/:id/tax`)
- Tax Payments (`/api/v1/businesses/:id/tax/pay`)

## 🧪 Testing

```bash
# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Generate coverage report
npm run test:coverage
```

## 🔐 Environment Variables

See `.env.example` for all available configuration options.

**Required for development:**
- `DATABASE_URL` - PostgreSQL connection string
- `JWT_ACCESS_SECRET` - JWT signing secret
- `JWT_REFRESH_SECRET` - JWT refresh token secret

**Optional (for full features):**
- Paystack API keys
- Resend email API key
- Termii SMS API key
- DigitalOcean Spaces credentials
- Upstash Redis URL
- Sentry DSN

## 📊 Database Schema

### Core Tables
- `users` - User accounts
- `businesses` - Business profiles
- `sales_transactions` - Sales records
- `expenses` - Expense records
- `monthly_tax_reports` - Calculated tax obligations
- `tax_payments` - Payment transactions
- `tax_statements` - Generated PDF statements
- `audit_logs` - Security audit trail
- `reminders` - Tax deadline notifications

### Tax Calculation Formula
```
Gross Profit = Total Sales - Total Expenses
Tax Payable = Gross Profit × 7.5%
```

## 🛠️ Tech Stack

- **Runtime:** Node.js 20
- **Framework:** Express
- **Language:** TypeScript
- **Database:** PostgreSQL (Neon)
- **ORM:** Prisma
- **Cache:** Redis (Upstash)
- **Logger:** Winston
- **Validation:** Zod
- **Payment:** Paystack
- **Storage:** DigitalOcean Spaces
- **Email:** Resend
- **SMS:** Termii

## 📝 Development Guidelines

1. **Code Organization:** Follow the established folder structure
2. **Error Handling:** Use `asyncHandler` wrapper for async routes
3. **Validation:** Use Zod schemas in `/validators`
4. **Logging:** Use Winston logger, never `console.log`
5. **Database:** Always use Prisma, never raw SQL
6. **Types:** Define interfaces in `/types`
7. **Configuration:** Add env vars to `config/index.ts`

## 🔒 Security Features

- ✅ Helmet for HTTP header security
- ✅ CORS configuration
- ✅ Rate limiting (global + route-specific)
- ✅ JWT authentication (coming in Phase 1)
- ✅ Input validation with Zod
- ✅ SQL injection protection via Prisma
- ✅ Audit logging for compliance
- ✅ Password hashing with bcrypt

## 📚 Additional Resources

- [Prisma Documentation](https://www.prisma.io/docs)
- [Express Documentation](https://expressjs.com/)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [Paystack API Docs](https://paystack.com/docs/api/)

## 👥 Team

**WallX Engineering Team**

## 📄 License

Proprietary - All rights reserved

---

**Current Phase:** Phase 0 - Infrastructure Setup ✅  
**Next Phase:** Phase 1 - Authentication & Business Management (Week 2-3)
