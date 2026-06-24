import swaggerJsdoc from 'swagger-jsdoc';
import config from '@/config';

// Reusable parameter shorthands. Path params live alongside their owning
// path because they reference the route directly; common query params
// (pagination, month/year) are referenced via $ref to keep paths concise.
const PageParam = {
  name: 'page',
  in: 'query' as const,
  schema: { type: 'integer', default: 1, minimum: 1 },
};
const LimitParam = {
  name: 'limit',
  in: 'query' as const,
  schema: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
};
const MonthParam = {
  name: 'month',
  in: 'query' as const,
  required: true,
  schema: { type: 'integer', minimum: 1, maximum: 12 },
};
const YearParam = {
  name: 'year',
  in: 'query' as const,
  required: true,
  schema: { type: 'integer', minimum: 2020, maximum: 2100 },
};
const BusinessIdPathParam = {
  name: 'businessId',
  in: 'path' as const,
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

// Standard error responses — referenced from every authenticated path.
const Unauthorized = {
  description: 'Unauthorized — missing or invalid bearer token',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
};
const Forbidden = {
  description: 'Forbidden — caller does not own this resource (or non-admin hitting admin route)',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
};
const NotFound = {
  description: 'Resource not found',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
};
const ValidationError = {
  description: 'Validation error — Zod returns field-level details under error.details',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
};
const MonthLocked = {
  description: 'Target month is finalized or paid — edits refused',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
};

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'PayMyTax API',
      version: '1.0.0',
      description:
        'SME Tax Calculation, Reporting & Remittance API by WallX. ' +
        'All authenticated routes use Bearer JWT (15-minute access token; refresh via /v1/auth/refresh). ' +
        'Money fields are NGN unless stated; dates are ISO-8601.',
      contact: { name: 'WallX Engineering Team' },
    },
    servers: [
      {
        url: `http://localhost:${config.app.port}/api`,
        description: 'Development server',
      },
    ],
    tags: [
      { name: 'Health', description: 'Liveness / readiness probes' },
      { name: 'Auth', description: 'Registration, login, password lifecycle' },
      { name: 'Business', description: 'Business CRUD (one user → many businesses)' },
      { name: 'Sales', description: 'Sales transactions (manual + bulk import + DVA auto-capture)' },
      { name: 'Sales Import', description: 'Excel / CSV bulk import flow (template → preview → commit)' },
      { name: 'Expenses', description: 'Expense entries by category' },
      { name: 'Tax', description: 'Tax calculation, monthly reports, finalize/unfinalize, dashboard, analytics' },
      { name: 'Payments', description: 'Paystack-backed tax payments' },
      { name: 'Statements', description: 'PDF tax statements (monthly + period range)' },
      { name: 'Reminders', description: 'In-app reminders (deadline / unfiled / unpaid / margin / invoice / payment / DVA)' },
      { name: 'DVA', description: 'Dedicated Virtual Account — Paystack auto-capture for bank transfers' },
      { name: 'Invoices', description: 'Invoice CRUD + send via email/WhatsApp + PDF + paid → auto-create sale' },
      { name: 'Search', description: 'Cross-domain search across sales, expenses, invoices, reports' },
      { name: 'Admin', description: 'Admin-only endpoints (role: admin)' },
      { name: 'Webhooks', description: 'External webhook receivers (no auth, signature verified)' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      parameters: {
        PageParam,
        LimitParam,
        MonthParam,
        YearParam,
        BusinessIdPathParam,
      },
      schemas: {
        SuccessResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: { type: 'object' },
            message: { type: 'string' },
          },
        },
        PaginatedResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: { type: 'array', items: { type: 'object' } },
            pagination: {
              type: 'object',
              properties: {
                page: { type: 'integer', example: 1 },
                limit: { type: 'integer', example: 20 },
                total: { type: 'integer', example: 137 },
                totalPages: { type: 'integer', example: 7 },
                hasNext: { type: 'boolean' },
                hasPrev: { type: 'boolean' },
              },
            },
          },
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'VALIDATION_ERROR' },
                message: { type: 'string' },
                details: { type: 'object' },
                stack: { type: 'string' },
              },
            },
          },
        },

        // ─── Auth ─────────────────────────────────────────────
        RegisterInput: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email', example: 'user@example.com' },
            password: {
              type: 'string',
              minLength: 8,
              maxLength: 128,
              example: 'MyStr0ngPass',
              description: 'Must contain uppercase, lowercase, and number',
            },
            phone: { type: 'string', example: '+2348012345678' },
          },
        },
        LoginInput: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email', example: 'user@example.com' },
            password: { type: 'string', example: 'MyStr0ngPass' },
          },
        },
        RefreshTokenInput: {
          type: 'object',
          required: ['refreshToken'],
          properties: { refreshToken: { type: 'string' } },
        },
        ChangePasswordInput: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          properties: {
            currentPassword: { type: 'string' },
            newPassword: {
              type: 'string',
              minLength: 8,
              maxLength: 128,
              description: 'Must contain uppercase, lowercase, and number',
            },
          },
        },
        ForgotPasswordInput: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email', example: 'user@example.com' },
          },
        },
        ResetPasswordInput: {
          type: 'object',
          required: ['token', 'newPassword'],
          properties: {
            token: { type: 'string', description: 'Reset token from email' },
            newPassword: {
              type: 'string',
              minLength: 8,
              maxLength: 128,
              description: 'Must contain uppercase, lowercase, and number',
            },
          },
        },

        // ─── Business ────────────────────────────────────────
        CreateBusinessInput: {
          type: 'object',
          required: ['businessName', 'ownerName', 'businessType'],
          properties: {
            businessName: { type: 'string', minLength: 2, maxLength: 200, example: 'Acme Ltd' },
            ownerName: { type: 'string', minLength: 2, maxLength: 200, example: 'John Doe' },
            taxId: { type: 'string', maxLength: 50 },
            businessType: { type: 'string', maxLength: 100, example: 'Retail' },
            address: { type: 'string', maxLength: 500 },
            city: { type: 'string', maxLength: 100 },
            state: { type: 'string', maxLength: 100 },
            defaultProfitMargin: { type: 'number', minimum: 0, maximum: 100 },
            taxReminderDay: { type: 'integer', minimum: 1, maximum: 28, default: 25 },
          },
        },
        UpdateBusinessInput: {
          type: 'object',
          properties: {
            businessName: { type: 'string', minLength: 2, maxLength: 200 },
            ownerName: { type: 'string', minLength: 2, maxLength: 200 },
            taxId: { type: 'string', maxLength: 50 },
            businessType: { type: 'string', maxLength: 100 },
            address: { type: 'string', maxLength: 500 },
            city: { type: 'string', maxLength: 100 },
            state: { type: 'string', maxLength: 100 },
            defaultProfitMargin: { type: 'number', minimum: 0, maximum: 100 },
            taxReminderDay: { type: 'integer', minimum: 1, maximum: 28 },
          },
        },

        // ─── Sales ───────────────────────────────────────────
        SalesSource: {
          type: 'string',
          enum: ['bank_transfer', 'paycode', 'pos', 'online_store', 'manual'],
        },
        TransactionStatus: {
          type: 'string',
          enum: ['confirmed', 'pending', 'reversed', 'disputed'],
        },
        CreateSaleInput: {
          type: 'object',
          required: ['amount', 'source', 'transactionDate'],
          properties: {
            amount: { type: 'number', minimum: 0.01, example: 50000 },
            source: { $ref: '#/components/schemas/SalesSource' },
            status: { $ref: '#/components/schemas/TransactionStatus' },
            referenceId: {
              type: 'string',
              maxLength: 200,
              description: 'External reference. Combined with (businessId, source) under DB unique constraint to prevent double-booking.',
            },
            description: { type: 'string', maxLength: 500 },
            customerName: { type: 'string', maxLength: 200 },
            transactionDate: { type: 'string', format: 'date-time' },
            metadata: { type: 'object' },
          },
        },
        UpdateSaleInput: {
          type: 'object',
          properties: {
            amount: { type: 'number', minimum: 0.01 },
            source: { $ref: '#/components/schemas/SalesSource' },
            status: { $ref: '#/components/schemas/TransactionStatus' },
            referenceId: { type: 'string', maxLength: 200 },
            description: { type: 'string', maxLength: 500 },
            customerName: { type: 'string', maxLength: 200 },
            transactionDate: { type: 'string', format: 'date-time' },
            metadata: { type: 'object' },
          },
        },

        // ─── Expenses ────────────────────────────────────────
        ExpenseCategory: {
          type: 'string',
          enum: ['rent', 'inventory', 'salary', 'utility', 'fuel', 'logistics', 'marketing', 'other'],
        },
        CreateExpenseInput: {
          type: 'object',
          required: ['category', 'description', 'amount', 'expenseDate'],
          properties: {
            category: { $ref: '#/components/schemas/ExpenseCategory' },
            description: { type: 'string', minLength: 1, maxLength: 500 },
            amount: { type: 'number', minimum: 0.01 },
            expenseDate: { type: 'string', format: 'date-time' },
            receiptUrl: { type: 'string', format: 'uri', maxLength: 1000 },
          },
        },
        UpdateExpenseInput: {
          type: 'object',
          properties: {
            category: { $ref: '#/components/schemas/ExpenseCategory' },
            description: { type: 'string', minLength: 1, maxLength: 500 },
            amount: { type: 'number', minimum: 0.01 },
            expenseDate: { type: 'string', format: 'date-time' },
            receiptUrl: { type: 'string', nullable: true, format: 'uri', maxLength: 1000 },
          },
        },

        // ─── Tax ─────────────────────────────────────────────
        CalculateTaxInput: {
          type: 'object',
          required: ['month', 'year'],
          properties: {
            month: { type: 'integer', minimum: 1, maximum: 12 },
            year: { type: 'integer', minimum: 2020, maximum: 2100 },
            taxRate: {
              type: 'number',
              minimum: 0,
              maximum: 50,
              description: 'Override per-business default (7.5% standard FIRS rate)',
            },
          },
        },

        // ─── Payments ────────────────────────────────────────
        InitiatePaymentInput: {
          type: 'object',
          required: ['taxReportId'],
          properties: {
            taxReportId: { type: 'string', format: 'uuid' },
            callbackUrl: { type: 'string', format: 'uri' },
          },
        },

        // ─── Reminders ───────────────────────────────────────
        ReminderType: {
          type: 'string',
          enum: [
            'tax_deadline',
            'unfiled_tax',
            'unfinalized_report',
            'unpaid_tax',
            'margin_warning',
            'invoice_overdue',
            'payment_successful',
            'dva_received',
          ],
        },
        GenerateRemindersInput: {
          type: 'object',
          required: ['month', 'year'],
          properties: {
            month: { type: 'integer', minimum: 1, maximum: 12 },
            year: { type: 'integer', minimum: 2020, maximum: 2100 },
          },
        },

        // ─── DVA ─────────────────────────────────────────────
        ValidateCustomerBvnInput: {
          type: 'object',
          required: ['bvn'],
          properties: {
            bvn: {
              type: 'string',
              minLength: 11,
              maxLength: 11,
              pattern: '^\\d{11}$',
              example: '12345678901',
            },
          },
        },

        // ─── Invoices ────────────────────────────────────────
        InvoiceStatus: {
          type: 'string',
          enum: ['draft', 'sent', 'paid', 'overdue', 'cancelled'],
        },
        InvoiceLineInput: {
          type: 'object',
          required: ['description', 'quantity', 'unitPrice'],
          properties: {
            description: { type: 'string', minLength: 1, maxLength: 500 },
            quantity: { type: 'number', minimum: 0.01 },
            unitPrice: { type: 'number', minimum: 0 },
          },
        },
        CreateInvoiceInput: {
          type: 'object',
          required: ['customerName', 'issueDate', 'dueDate', 'lines'],
          properties: {
            customerName: { type: 'string', minLength: 1, maxLength: 200 },
            customerEmail: { type: 'string', maxLength: 200 },
            customerPhone: { type: 'string', maxLength: 30 },
            customerAddress: { type: 'string', maxLength: 500 },
            customerTaxId: { type: 'string', maxLength: 50 },
            issueDate: { type: 'string', format: 'date' },
            dueDate: { type: 'string', format: 'date', description: 'Must be ≥ issueDate' },
            vatRate: { type: 'number', minimum: 0, maximum: 100, default: 7.5 },
            discount: { type: 'number', minimum: 0, default: 0 },
            currency: { type: 'string', minLength: 3, maxLength: 3, default: 'NGN' },
            notes: { type: 'string', maxLength: 2000 },
            paymentTerms: { type: 'string', maxLength: 500 },
            lines: { type: 'array', minItems: 1, items: { $ref: '#/components/schemas/InvoiceLineInput' } },
          },
        },
        UpdateInvoiceInput: {
          type: 'object',
          description: 'Partial update — only allowed while status=draft. If `lines` is present, line items are replaced atomically.',
          properties: {
            customerName: { type: 'string', minLength: 1, maxLength: 200 },
            customerEmail: { type: 'string', maxLength: 200 },
            customerPhone: { type: 'string', maxLength: 30 },
            customerAddress: { type: 'string', maxLength: 500 },
            customerTaxId: { type: 'string', maxLength: 50 },
            issueDate: { type: 'string', format: 'date' },
            dueDate: { type: 'string', format: 'date' },
            vatRate: { type: 'number', minimum: 0, maximum: 100 },
            discount: { type: 'number', minimum: 0 },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            notes: { type: 'string', maxLength: 2000 },
            paymentTerms: { type: 'string', maxLength: 500 },
            lines: { type: 'array', minItems: 1, items: { $ref: '#/components/schemas/InvoiceLineInput' } },
          },
        },
        MarkInvoicePaidInput: {
          type: 'object',
          properties: {
            paymentDate: {
              type: 'string',
              format: 'date',
              description: 'Defaults to today. Must be ≥ issueDate and target month must not be locked.',
            },
            paymentReference: { type: 'string', maxLength: 100 },
          },
        },
        CancelInvoiceInput: {
          type: 'object',
          properties: { reason: { type: 'string', maxLength: 500 } },
        },

        // ─── Admin ───────────────────────────────────────────
        ToggleUserStatusInput: {
          type: 'object',
          required: ['isActive'],
          properties: { isActive: { type: 'boolean' } },
        },
      },
    },
    paths: {
      // ─── Health ────────────────────────────────────────────
      '/health': {
        get: {
          tags: ['Health'],
          summary: 'Basic health check',
          responses: { 200: { description: 'API is running' } },
        },
      },
      '/health/detailed': {
        get: {
          tags: ['Health'],
          summary: 'Detailed health check (DB connectivity, uptime, memory)',
          responses: {
            200: { description: 'Healthy' },
            503: { description: 'Unhealthy (DB unreachable)' },
          },
        },
      },

      // ─── Auth ──────────────────────────────────────────────
      '/v1/auth/register': {
        post: {
          tags: ['Auth'],
          summary: 'Register a new user',
          description: 'Rate-limited (5/15min in production).',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/RegisterInput' } } },
          },
          responses: {
            201: { description: 'User registered — returns user + tokens' },
            400: ValidationError,
            409: { description: 'Email already exists' },
            429: { description: 'Rate limit exceeded' },
          },
        },
      },
      '/v1/auth/login': {
        post: {
          tags: ['Auth'],
          summary: 'Login with email and password',
          description: 'Rate-limited (5/15min in production).',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginInput' } } },
          },
          responses: {
            200: { description: 'Login successful — returns user + access/refresh tokens' },
            401: { description: 'Invalid credentials or account disabled' },
            429: { description: 'Rate limit exceeded' },
          },
        },
      },
      '/v1/auth/refresh': {
        post: {
          tags: ['Auth'],
          summary: 'Exchange refresh token for a new access token',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/RefreshTokenInput' } } },
          },
          responses: {
            200: { description: 'New access token issued' },
            401: { description: 'Invalid or expired refresh token' },
          },
        },
      },
      '/v1/auth/me': {
        get: {
          tags: ['Auth'],
          summary: 'Get current user profile',
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: 'Current user profile' },
            401: Unauthorized,
          },
        },
      },
      '/v1/auth/change-password': {
        put: {
          tags: ['Auth'],
          summary: 'Change password (authenticated)',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ChangePasswordInput' } } },
          },
          responses: {
            200: { description: 'Password changed' },
            400: ValidationError,
            401: { description: 'Wrong current password' },
          },
        },
      },
      '/v1/auth/forgot-password': {
        post: {
          tags: ['Auth'],
          summary: 'Request a password reset email',
          description:
            'Rate-limited. Always returns 200 to avoid leaking whether the email is registered. ' +
            'Currently logs to Winston — Resend wiring is pending.',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ForgotPasswordInput' } } },
          },
          responses: {
            200: { description: 'Reset email dispatched (or pretended to be)' },
            429: { description: 'Rate limit exceeded' },
          },
        },
      },
      '/v1/auth/reset-password': {
        post: {
          tags: ['Auth'],
          summary: 'Reset password using a token from the reset email',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ResetPasswordInput' } } },
          },
          responses: {
            200: { description: 'Password reset successful' },
            400: { description: 'Invalid or expired token, or validation failed' },
            429: { description: 'Rate limit exceeded' },
          },
        },
      },

      // ─── Business ──────────────────────────────────────────
      '/v1/businesses': {
        post: {
          tags: ['Business'],
          summary: 'Create a new business',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateBusinessInput' } } },
          },
          responses: {
            201: { description: 'Business created — merchantId auto-generated as PMTW#######' },
            400: ValidationError,
            401: Unauthorized,
          },
        },
        get: {
          tags: ['Business'],
          summary: 'List all businesses for current user',
          security: [{ bearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/PageParam' }, { $ref: '#/components/parameters/LimitParam' }],
          responses: {
            200: {
              description: 'Paginated list of businesses',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/PaginatedResponse' } } },
            },
            401: Unauthorized,
          },
        },
      },
      '/v1/businesses/{id}': {
        get: {
          tags: ['Business'],
          summary: 'Get a business by ID',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Business details' }, 401: Unauthorized, 403: Forbidden, 404: NotFound },
        },
        put: {
          tags: ['Business'],
          summary: 'Update a business',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateBusinessInput' } } },
          },
          responses: { 200: { description: 'Business updated' }, 400: ValidationError, 401: Unauthorized, 403: Forbidden, 404: NotFound },
        },
        delete: {
          tags: ['Business'],
          summary: 'Delete a business',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Business deleted' }, 401: Unauthorized, 403: Forbidden, 404: NotFound },
        },
      },

      // ─── Sales ─────────────────────────────────────────────
      '/v1/businesses/{businessId}/sales': {
        post: {
          tags: ['Sales'],
          summary: 'Record a sale',
          security: [{ bearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/BusinessIdPathParam' }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateSaleInput' } } },
          },
          responses: {
            201: { description: 'Sale recorded' },
            400: ValidationError,
            401: Unauthorized,
            403: Forbidden,
            409: { description: 'Duplicate (businessId, source, referenceId) — protected by unique_sales_reference' },
            422: MonthLocked,
          },
        },
        get: {
          tags: ['Sales'],
          summary: 'List sales (filterable, paginated)',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { $ref: '#/components/parameters/PageParam' },
            { $ref: '#/components/parameters/LimitParam' },
            { name: 'source', in: 'query', schema: { $ref: '#/components/schemas/SalesSource' } },
            { name: 'status', in: 'query', schema: { $ref: '#/components/schemas/TransactionStatus' } },
            { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'month', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 12 } },
            { name: 'year', in: 'query', schema: { type: 'integer', minimum: 2020, maximum: 2100 } },
          ],
          responses: { 200: { description: 'Paginated sales' }, 401: Unauthorized, 403: Forbidden },
        },
      },
      '/v1/businesses/{businessId}/sales/summary': {
        get: {
          tags: ['Sales'],
          summary: 'Monthly sales summary (totals + breakdown by source)',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { $ref: '#/components/parameters/MonthParam' },
            { $ref: '#/components/parameters/YearParam' },
          ],
          responses: { 200: { description: 'Summary object' }, 400: ValidationError, 401: Unauthorized, 403: Forbidden },
        },
      },
      '/v1/businesses/{businessId}/sales/{id}': {
        get: {
          tags: ['Sales'],
          summary: 'Get a sale by ID',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: { 200: { description: 'Sale' }, 401: Unauthorized, 403: Forbidden, 404: NotFound },
        },
        put: {
          tags: ['Sales'],
          summary: 'Update a sale (refused if month is locked)',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateSaleInput' } } },
          },
          responses: {
            200: { description: 'Sale updated' },
            400: ValidationError,
            401: Unauthorized,
            403: Forbidden,
            404: NotFound,
            422: MonthLocked,
          },
        },
        delete: {
          tags: ['Sales'],
          summary: 'Delete a sale (refused if month is locked)',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            200: { description: 'Sale deleted' },
            401: Unauthorized,
            403: Forbidden,
            404: NotFound,
            422: MonthLocked,
          },
        },
      },

      // ─── Sales Import (Excel / CSV) ────────────────────────
      '/v1/businesses/{businessId}/sales/import/template': {
        get: {
          tags: ['Sales Import'],
          summary: 'Download the .xlsx import template',
          description: 'Streams a per-request Excel file with headers, example rows, and source dropdown validation.',
          security: [{ bearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/BusinessIdPathParam' }],
          responses: {
            200: {
              description: 'Excel file',
              content: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { schema: { type: 'string', format: 'binary' } } },
            },
            401: Unauthorized,
            403: Forbidden,
          },
        },
      },
      '/v1/businesses/{businessId}/sales/import/preview': {
        post: {
          tags: ['Sales Import'],
          summary: 'Upload + parse an .xlsx or .csv (no DB writes)',
          description:
            'Multipart upload (field: `file`, ≤ 2 MB, .xlsx or .csv). Returns a fileToken (15-min TTL) plus per-row classification ' +
            '(valid / invalid / duplicate_in_file / duplicate_in_db / locked). 100-row hard cap.',
          security: [{ bearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/BusinessIdPathParam' }],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file'],
                  properties: { file: { type: 'string', format: 'binary' } },
                },
              },
            },
          },
          responses: {
            200: { description: 'Parsed preview { fileToken, summary, rows[] }' },
            400: { description: 'IMPORT_BAD_EXTENSION / IMPORT_MISSING_COLUMNS / IMPORT_ROW_CAP_EXCEEDED' },
            401: Unauthorized,
            403: Forbidden,
          },
        },
      },
      '/v1/businesses/{businessId}/sales/import/commit': {
        post: {
          tags: ['Sales Import'],
          summary: 'Commit a previously-previewed import to the database',
          description: 'Re-checks month locks, then `createMany({ skipDuplicates: true })` inside a transaction with audit logging.',
          security: [{ bearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/BusinessIdPathParam' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['fileToken'],
                  properties: { fileToken: { type: 'string', format: 'uuid' } },
                },
              },
            },
          },
          responses: {
            200: { description: 'Import committed { imported, skipped }' },
            400: { description: 'IMPORT_TOKEN_EXPIRED / IMPORT_TOKEN_INVALID' },
            401: Unauthorized,
            403: Forbidden,
            422: MonthLocked,
          },
        },
      },

      // ─── Expenses ──────────────────────────────────────────
      '/v1/businesses/{businessId}/expenses': {
        post: {
          tags: ['Expenses'],
          summary: 'Record an expense',
          security: [{ bearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/BusinessIdPathParam' }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateExpenseInput' } } },
          },
          responses: {
            201: { description: 'Expense recorded' },
            400: ValidationError,
            401: Unauthorized,
            403: Forbidden,
            422: MonthLocked,
          },
        },
        get: {
          tags: ['Expenses'],
          summary: 'List expenses (filterable, paginated)',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { $ref: '#/components/parameters/PageParam' },
            { $ref: '#/components/parameters/LimitParam' },
            { name: 'category', in: 'query', schema: { $ref: '#/components/schemas/ExpenseCategory' } },
            { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'month', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 12 } },
            { name: 'year', in: 'query', schema: { type: 'integer', minimum: 2020, maximum: 2100 } },
          ],
          responses: { 200: { description: 'Paginated expenses' }, 401: Unauthorized, 403: Forbidden },
        },
      },
      '/v1/businesses/{businessId}/expenses/summary': {
        get: {
          tags: ['Expenses'],
          summary: 'Monthly expense summary (totals + category breakdown)',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { $ref: '#/components/parameters/MonthParam' },
            { $ref: '#/components/parameters/YearParam' },
          ],
          responses: { 200: { description: 'Summary object' }, 400: ValidationError, 401: Unauthorized, 403: Forbidden },
        },
      },
      '/v1/businesses/{businessId}/expenses/{id}': {
        get: {
          tags: ['Expenses'],
          summary: 'Get an expense by ID',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: { 200: { description: 'Expense' }, 401: Unauthorized, 403: Forbidden, 404: NotFound },
        },
        put: {
          tags: ['Expenses'],
          summary: 'Update an expense (refused if month is locked)',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateExpenseInput' } } },
          },
          responses: {
            200: { description: 'Expense updated' },
            400: ValidationError,
            401: Unauthorized,
            403: Forbidden,
            404: NotFound,
            422: MonthLocked,
          },
        },
        delete: {
          tags: ['Expenses'],
          summary: 'Delete an expense (refused if month is locked)',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            200: { description: 'Expense deleted' },
            401: Unauthorized,
            403: Forbidden,
            404: NotFound,
            422: MonthLocked,
          },
        },
      },

      // ─── Tax ───────────────────────────────────────────────
      '/v1/businesses/{businessId}/tax/calculate': {
        post: {
          tags: ['Tax'],
          summary: 'Calculate (or recalculate) tax for a month',
          description: 'Tax = 7.5% × (Sales − Expenses). Persists/updates a MonthlyTaxReport, fires margin_warning reminders.',
          security: [{ bearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/BusinessIdPathParam' }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CalculateTaxInput' } } },
          },
          responses: {
            200: { description: 'Tax report (with intelligence alerts)' },
            400: ValidationError,
            401: Unauthorized,
            403: Forbidden,
            422: { description: 'Month already finalized — unfinalize first' },
          },
        },
      },
      '/v1/businesses/{businessId}/tax/reports': {
        get: {
          tags: ['Tax'],
          summary: 'List monthly tax reports',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { $ref: '#/components/parameters/PageParam' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 12, minimum: 1, maximum: 100 } },
            { name: 'year', in: 'query', schema: { type: 'integer', minimum: 2020, maximum: 2100 } },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'processing', 'completed', 'failed', 'refunded'] } },
          ],
          responses: { 200: { description: 'Paginated reports' }, 401: Unauthorized, 403: Forbidden },
        },
      },
      '/v1/businesses/{businessId}/tax/reports/{id}': {
        get: {
          tags: ['Tax'],
          summary: 'Get a tax report by ID',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: { 200: { description: 'Tax report' }, 401: Unauthorized, 403: Forbidden, 404: NotFound },
        },
      },
      '/v1/businesses/{businessId}/tax/reports/{id}/finalize': {
        post: {
          tags: ['Tax'],
          summary: 'Finalize a tax report (locks the month for edits)',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            200: { description: 'Report finalized' },
            401: Unauthorized,
            403: Forbidden,
            404: NotFound,
            422: { description: 'Already finalized or already paid' },
          },
        },
      },
      '/v1/businesses/{businessId}/tax/reports/{id}/unfinalize': {
        post: {
          tags: ['Tax'],
          summary: 'Unfinalize a tax report (reopen the month)',
          description: 'Refused once the report is paid (isLocked=true).',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            200: { description: 'Report reopened' },
            401: Unauthorized,
            403: Forbidden,
            404: NotFound,
            422: { description: 'Report is paid — cannot unfinalize' },
          },
        },
      },
      '/v1/businesses/{businessId}/tax/dashboard': {
        get: {
          tags: ['Tax'],
          summary: 'Dashboard summary (sales/expenses/tax trends)',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { name: 'months', in: 'query', schema: { type: 'integer', default: 6, minimum: 1, maximum: 24 } },
          ],
          responses: { 200: { description: 'Dashboard payload' }, 401: Unauthorized, 403: Forbidden },
        },
      },
      '/v1/businesses/{businessId}/tax/analytics': {
        get: {
          tags: ['Tax'],
          summary: 'Tax analytics (KPIs, time series, status distribution, YoY)',
          description:
            '`range=all` resolves to [earliestReport, currentMonth] capped at 60 months. ' +
            '`range=custom` requires `from` + `to` (YYYY-MM); window > 60 months → 400 RANGE_TOO_WIDE.',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { name: 'range', in: 'query', schema: { type: 'string', enum: ['6m', '12m', '24m', 'all', 'custom'] } },
            { name: 'from', in: 'query', schema: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' }, description: 'YYYY-MM' },
            { name: 'to', in: 'query', schema: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' }, description: 'YYYY-MM' },
          ],
          responses: { 200: { description: 'Analytics payload' }, 400: ValidationError, 401: Unauthorized, 403: Forbidden },
        },
      },

      // ─── Payments ──────────────────────────────────────────
      '/v1/businesses/{businessId}/tax/pay': {
        post: {
          tags: ['Payments'],
          summary: 'Initiate a Paystack payment for a tax report',
          description: 'Report must be finalized with non-zero tax. Returns Paystack authorizationUrl. Rate-limited (5/hour).',
          security: [{ bearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/BusinessIdPathParam' }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/InitiatePaymentInput' } } },
          },
          responses: {
            200: { description: 'Payment initiated — { authorizationUrl, reference }' },
            400: ValidationError,
            401: Unauthorized,
            403: Forbidden,
            404: NotFound,
            422: { description: 'Report not finalized or tax is zero' },
            429: { description: 'Rate limit exceeded' },
          },
        },
      },
      '/v1/businesses/{businessId}/tax/payments': {
        get: {
          tags: ['Payments'],
          summary: 'List tax payments',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { $ref: '#/components/parameters/PageParam' },
            { $ref: '#/components/parameters/LimitParam' },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'processing', 'completed', 'failed', 'refunded'] } },
          ],
          responses: { 200: { description: 'Paginated payments' }, 401: Unauthorized, 403: Forbidden },
        },
      },
      '/v1/businesses/{businessId}/tax/payments/{paymentId}': {
        get: {
          tags: ['Payments'],
          summary: 'Get a payment by ID',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { name: 'paymentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: { 200: { description: 'Payment' }, 401: Unauthorized, 403: Forbidden, 404: NotFound },
        },
      },
      '/v1/businesses/{businessId}/tax/payments/{paymentId}/verify': {
        get: {
          tags: ['Payments'],
          summary: 'Verify payment via Paystack (polling fallback to webhook)',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { name: 'paymentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            200: { description: 'Verified payment with updated status' },
            401: Unauthorized,
            403: Forbidden,
            404: NotFound,
          },
        },
      },

      // ─── Statements ────────────────────────────────────────
      '/v1/businesses/{businessId}/tax/statements/monthly': {
        get: {
          tags: ['Statements'],
          summary: 'Download monthly tax statement (PDF)',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { $ref: '#/components/parameters/MonthParam' },
            { $ref: '#/components/parameters/YearParam' },
          ],
          responses: {
            200: {
              description: 'PDF file',
              content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
            },
            401: Unauthorized,
            403: Forbidden,
            404: { description: 'No report for that month' },
          },
        },
      },
      '/v1/businesses/{businessId}/tax/statements/period': {
        get: {
          tags: ['Statements'],
          summary: 'Download period tax statement (PDF, range of months)',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { name: 'startMonth', in: 'query', required: true, schema: { type: 'integer', minimum: 1, maximum: 12 } },
            { name: 'startYear', in: 'query', required: true, schema: { type: 'integer', minimum: 2020, maximum: 2100 } },
            { name: 'endMonth', in: 'query', required: true, schema: { type: 'integer', minimum: 1, maximum: 12 } },
            { name: 'endYear', in: 'query', required: true, schema: { type: 'integer', minimum: 2020, maximum: 2100 } },
          ],
          responses: {
            200: {
              description: 'PDF file',
              content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
            },
            400: ValidationError,
            401: Unauthorized,
            403: Forbidden,
          },
        },
      },

      // ─── Reminders ─────────────────────────────────────────
      '/v1/businesses/{businessId}/reminders': {
        get: {
          tags: ['Reminders'],
          summary: 'List reminders',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { $ref: '#/components/parameters/PageParam' },
            { $ref: '#/components/parameters/LimitParam' },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'sent', 'all'], default: 'all' } },
          ],
          responses: { 200: { description: 'Paginated reminders' }, 401: Unauthorized, 403: Forbidden },
        },
      },
      '/v1/businesses/{businessId}/reminders/active': {
        get: {
          tags: ['Reminders'],
          summary: 'Active reminders for the top-bar bell (≤10 unsent)',
          security: [{ bearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/BusinessIdPathParam' }],
          responses: { 200: { description: 'Up to 10 active reminders' }, 401: Unauthorized, 403: Forbidden },
        },
      },
      '/v1/businesses/{businessId}/reminders/generate': {
        post: {
          tags: ['Reminders'],
          summary: 'Manually trigger reminder generation for a month',
          description: 'Used by the "Generate Reminders" button on /reminders. The daily cron does the same automatically.',
          security: [{ bearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/BusinessIdPathParam' }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/GenerateRemindersInput' } } },
          },
          responses: { 200: { description: 'Generation summary' }, 400: ValidationError, 401: Unauthorized, 403: Forbidden },
        },
      },
      '/v1/businesses/{businessId}/reminders/{id}/mark-sent': {
        patch: {
          tags: ['Reminders'],
          summary: 'Mark a reminder as sent (idempotent)',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: { 200: { description: 'Marked sent' }, 401: Unauthorized, 403: Forbidden, 404: NotFound },
        },
      },
      '/v1/businesses/{businessId}/reminders/{id}': {
        delete: {
          tags: ['Reminders'],
          summary: 'Dismiss a reminder',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: { 200: { description: 'Dismissed' }, 401: Unauthorized, 403: Forbidden, 404: NotFound },
        },
      },

      // ─── DVA ───────────────────────────────────────────────
      '/v1/businesses/{businessId}/dva/setup-virtual-account': {
        post: {
          tags: ['DVA'],
          summary: 'Provision a Paystack Dedicated Virtual Account',
          description: 'Creates the Paystack customer + requests dedicated account assignment. Final account number arrives via webhook.',
          security: [{ bearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/BusinessIdPathParam' }],
          responses: { 200: { description: 'Setup pending or active' }, 401: Unauthorized, 403: Forbidden },
        },
      },
      '/v1/businesses/{businessId}/dva/validate-customer': {
        post: {
          tags: ['DVA'],
          summary: 'Submit BVN validation for the DVA customer',
          security: [{ bearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/BusinessIdPathParam' }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidateCustomerBvnInput' } } },
          },
          responses: { 200: { description: 'Validation submitted' }, 400: { description: 'INVALID_BVN' }, 401: Unauthorized, 403: Forbidden },
        },
      },
      '/v1/businesses/{businessId}/dva/virtual-account': {
        get: {
          tags: ['DVA'],
          summary: 'Get the current DVA assigned to the business',
          security: [{ bearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/BusinessIdPathParam' }],
          responses: { 200: { description: 'DVA details (or status if not yet active)' }, 401: Unauthorized, 403: Forbidden },
        },
      },

      // ─── Invoices ──────────────────────────────────────────
      '/v1/businesses/{businessId}/invoices': {
        post: {
          tags: ['Invoices'],
          summary: 'Create an invoice (status=draft, auto-generates INV-YYYY-NNN)',
          security: [{ bearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/BusinessIdPathParam' }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateInvoiceInput' } } },
          },
          responses: { 201: { description: 'Invoice created' }, 400: ValidationError, 401: Unauthorized, 403: Forbidden },
        },
        get: {
          tags: ['Invoices'],
          summary: 'List invoices (filterable, paginated)',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { $ref: '#/components/parameters/PageParam' },
            { $ref: '#/components/parameters/LimitParam' },
            { name: 'status', in: 'query', schema: { $ref: '#/components/schemas/InvoiceStatus' } },
            { name: 'search', in: 'query', schema: { type: 'string' } },
            { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } },
          ],
          responses: { 200: { description: 'Paginated invoices' }, 401: Unauthorized, 403: Forbidden },
        },
      },
      '/v1/businesses/{businessId}/invoices/{id}': {
        get: {
          tags: ['Invoices'],
          summary: 'Get an invoice by ID (with line items + linked sale)',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: { 200: { description: 'Invoice' }, 401: Unauthorized, 403: Forbidden, 404: NotFound },
        },
        put: {
          tags: ['Invoices'],
          summary: 'Update a draft invoice',
          description: 'Only allowed while status=draft. If `lines` is included, line items are replaced atomically.',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateInvoiceInput' } } },
          },
          responses: {
            200: { description: 'Invoice updated' },
            400: ValidationError,
            401: Unauthorized,
            403: Forbidden,
            404: NotFound,
            409: { description: 'Invoice is no longer in draft' },
          },
        },
        delete: {
          tags: ['Invoices'],
          summary: 'Delete a draft invoice',
          description: 'Only allowed while status=draft. Use `cancel` for sent/overdue invoices.',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            200: { description: 'Invoice deleted' },
            401: Unauthorized,
            403: Forbidden,
            404: NotFound,
            409: { description: 'Invoice is no longer in draft' },
          },
        },
      },
      '/v1/businesses/{businessId}/invoices/{id}/send': {
        post: {
          tags: ['Invoices'],
          summary: 'Mark a draft invoice as sent (offline/manual delivery)',
          description: 'Use this when delivery happens out-of-band. For electronic delivery use /send-whatsapp.',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            200: { description: 'Status flipped to sent' },
            401: Unauthorized,
            403: Forbidden,
            404: NotFound,
            409: { description: 'Invoice not in draft' },
          },
        },
      },
      '/v1/businesses/{businessId}/invoices/{id}/send-whatsapp': {
        post: {
          tags: ['Invoices'],
          summary: 'Build a wa.me deep link for the invoice',
          description:
            'Requires `customerPhone`. Normalizes phone to E.164. Returns `meta.waUrl` + `meta.message`. ' +
            'Server does not send — frontend opens the URL so the SME sends from their own WhatsApp account.',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            200: { description: 'Deep link returned' },
            400: { description: 'INVOICE_NO_PHONE — customerPhone is missing' },
            401: Unauthorized,
            403: Forbidden,
            404: NotFound,
            409: { description: 'Invoice is paid or cancelled' },
          },
        },
      },
      '/v1/businesses/{businessId}/invoices/{id}/mark-paid': {
        post: {
          tags: ['Invoices'],
          summary: 'Mark a sent/overdue invoice as paid',
          description:
            'Auto-creates a confirmed SalesTransaction (source=manual) and links via invoice.linkedSaleId. ' +
            'Refused if month is locked or invoice is still in draft.',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MarkInvoicePaidInput' } } },
          },
          responses: {
            200: { description: 'Invoice paid + sale created' },
            400: { description: 'paymentDate < issueDate' },
            401: Unauthorized,
            403: Forbidden,
            404: NotFound,
            409: { description: 'Invoice is draft (must send first) or already paid' },
            422: MonthLocked,
          },
        },
      },
      '/v1/businesses/{businessId}/invoices/{id}/cancel': {
        post: {
          tags: ['Invoices'],
          summary: 'Cancel an invoice (refused once paid)',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CancelInvoiceInput' } } },
          },
          responses: {
            200: { description: 'Invoice cancelled' },
            401: Unauthorized,
            403: Forbidden,
            404: NotFound,
            409: { description: 'Invoice is paid' },
          },
        },
      },
      '/v1/businesses/{businessId}/invoices/{id}/pdf': {
        get: {
          tags: ['Invoices'],
          summary: 'Download invoice PDF (any status)',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            200: {
              description: 'PDF file',
              content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
            },
            401: Unauthorized,
            403: Forbidden,
            404: NotFound,
          },
        },
      },

      // ─── Search ────────────────────────────────────────────
      '/v1/businesses/{businessId}/search': {
        get: {
          tags: ['Search'],
          summary: 'Cross-domain search (sales / expenses / invoices / reports)',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/BusinessIdPathParam' },
            { name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 100 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 5, minimum: 1, maximum: 10, description: 'Per-section limit. Total ≈ 4 × limit.' } },
          ],
          responses: { 200: { description: 'Grouped results' }, 400: ValidationError, 401: Unauthorized, 403: Forbidden },
        },
      },

      // ─── Admin ─────────────────────────────────────────────
      '/v1/admin/dashboard': {
        get: {
          tags: ['Admin'],
          summary: 'Admin dashboard (KPIs + recent signups)',
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'Dashboard payload' }, 401: Unauthorized, 403: Forbidden },
        },
      },
      '/v1/admin/users': {
        get: {
          tags: ['Admin'],
          summary: 'List users',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/PageParam' },
            { $ref: '#/components/parameters/LimitParam' },
            { name: 'search', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'Paginated users' }, 401: Unauthorized, 403: Forbidden },
        },
      },
      '/v1/admin/users/{id}': {
        get: {
          tags: ['Admin'],
          summary: 'Get user detail (with businesses)',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'User + businesses' }, 401: Unauthorized, 403: Forbidden, 404: NotFound },
        },
      },
      '/v1/admin/users/{id}/status': {
        patch: {
          tags: ['Admin'],
          summary: 'Activate / deactivate a user',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ToggleUserStatusInput' } } },
          },
          responses: { 200: { description: 'Status updated' }, 400: ValidationError, 401: Unauthorized, 403: Forbidden, 404: NotFound },
        },
      },
      '/v1/admin/businesses': {
        get: {
          tags: ['Admin'],
          summary: 'List all businesses (read-only across all users)',
          security: [{ bearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/PageParam' }, { $ref: '#/components/parameters/LimitParam' }],
          responses: { 200: { description: 'Paginated businesses' }, 401: Unauthorized, 403: Forbidden },
        },
      },
      '/v1/admin/audit-logs': {
        get: {
          tags: ['Admin'],
          summary: 'List audit logs',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/PageParam' },
            { $ref: '#/components/parameters/LimitParam' },
            { name: 'userId', in: 'query', schema: { type: 'string', format: 'uuid' } },
            { name: 'action', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'Paginated audit logs' }, 401: Unauthorized, 403: Forbidden },
        },
      },

      // ─── FIRS Remittance (admin) ───────────────────────────
      '/v1/admin/remittances/summary': {
        get: {
          tags: ['Admin'],
          summary: 'Collected tax awaiting FIRS remittance (total + count)',
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'Collected summary' }, 401: Unauthorized, 403: Forbidden },
        },
      },
      '/v1/admin/remittances': {
        get: {
          tags: ['Admin'],
          summary: 'List FIRS remittance batches',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/PageParam' },
            { $ref: '#/components/parameters/LimitParam' },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['collected', 'remitting', 'remitted'] } },
          ],
          responses: { 200: { description: 'Paginated remittance batches' }, 401: Unauthorized, 403: Forbidden },
        },
        post: {
          tags: ['Admin'],
          summary: 'Create a remittance batch from collected payments',
          description:
            'Groups completed+collected tax payments into a `remitting` batch. With no paymentIds, sweeps all collectable payments.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { paymentIds: { type: 'array', items: { type: 'string', format: 'uuid' } } },
                },
              },
            },
          },
          responses: {
            201: { description: 'Batch created' },
            400: { description: 'No collected payments to remit' },
            409: { description: 'One or more payments not collectable' },
            401: Unauthorized,
            403: Forbidden,
          },
        },
      },
      '/v1/admin/remittances/{id}': {
        get: {
          tags: ['Admin'],
          summary: 'Get a remittance batch (with member payments)',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Batch + payments' }, 401: Unauthorized, 403: Forbidden, 404: NotFound },
        },
      },
      '/v1/admin/remittances/{id}/record': {
        post: {
          tags: ['Admin'],
          summary: 'Record a manual FIRS remittance against a batch',
          description:
            'Marks the batch (and all member payments) remitted, recording the FIRS reference + optional receipt URL. Idempotent: a second call returns 409.',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['firsReference'],
                  properties: {
                    firsReference: { type: 'string' },
                    firsReceiptUrl: { type: 'string', format: 'uri' },
                    note: { type: 'string' },
                    transport: { type: 'string', enum: ['manual'], default: 'manual' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Remittance recorded' },
            400: ValidationError,
            409: { description: 'Already remitted' },
            401: Unauthorized,
            403: Forbidden,
            404: NotFound,
          },
        },
      },

      // ─── Webhooks ──────────────────────────────────────────
      '/webhooks/paystack': {
        post: {
          tags: ['Webhooks'],
          summary: 'Paystack webhook receiver (charge.success, dedicatedaccount.assign.success, transfer.success, etc.)',
          description:
            'No auth — verified via HMAC-SHA512 of the raw request body using PAYSTACK_WEBHOOK_SECRET. ' +
            'Drives payment confirmation, DVA assignment, and DVA-transfer auto-capture.',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            200: { description: 'Acknowledged' },
            401: { description: 'Signature verification failed' },
          },
        },
      },
    },
  },
  apis: [],
};

export const swaggerSpec = swaggerJsdoc(options);
