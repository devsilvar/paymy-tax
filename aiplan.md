# AI Business Assistant Implementation Plan
**Senior Engineer Review - Production-Ready Approach**

## Overview
Build an AI business advisor that analyzes business data and provides insights. **CRITICAL**: This is a high-risk feature - AI can hallucinate bad financial advice. Plan for failure, not just success.

---

## Phase 0: Pre-Implementation (DO THIS FIRST)

### 0.1 Legal & Liability
**BLOCKER - Must complete before coding:**
- [ ] Legal disclaimer: "AI suggestions are not financial/tax advice"
- [ ] Terms update: User accepts AI can make mistakes
- [ ] Insurance: Check if liability insurance covers AI advice
- [ ] Compliance: NDPR (Nigerian data protection) review

### 0.2 Cost Controls (Prevent Bankruptcy)
**Real Cost Risk**: 1000 users × 100 messages = $2000/day if exploited

**Hard Limits Required:**
```typescript
// Per user per day
const LIMITS = {
  free: { messages: 5, tokens: 2000 },
  paid: { messages: 50, tokens: 20000 },
  admin: { messages: 100, tokens: 50000 }
}

// Global circuit breaker
const DAILY_BUDGET_USD = 100; // Kill switch if exceeded
```

**Emergency Controls:**
- Feature flag to disable AI instantly (via env var)
- Admin dashboard showing real-time API spend
- Alerts when daily cost exceeds 50% of budget
- Automatic shutdown at 80% budget

### 0.3 Data Privacy Audit
**What goes to AI** (3rd party servers):
- ✅ Aggregated numbers (total sales, expenses)
- ✅ Month/year info
- ❌ Customer names, emails, phone numbers
- ❌ Bank account details
- ❌ Transaction reference IDs
- ❌ User emails/passwords

**Compliance:**
- Log all AI requests for audit
- Allow users to delete AI history (GDPR/NDPR)
- Encrypt conversation data at rest

---

## Phase 1: MVP Frontend (3-4 days, not 1 week)

### 1.1 Chat Interface - KISS Principle
**File**: `frontend/src/pages/AIAssistant.tsx`

**Core Features ONLY:**
- Message list (user/AI bubbles)
- Text input + send button
- Loading spinner (no fancy typing animation yet)
- Error toast when API fails
- LocalStorage persistence (server-side later)

**NOT in MVP:**
- ❌ Conversation history API (use localStorage first)
- ❌ Export to PDF
- ❌ Voice input
- ❌ Markdown rendering (plain text first)

**Suggested Questions** (MVP):
- "How's my business doing this month?"
- "What are my top 3 expenses?"
- "When is my next tax due?"

### 1.2 Component Structure (Keep Simple)
```typescript
// Single file, ~300 lines, no over-engineering
AIAssistant.tsx
  ├─ ChatBubble (inline component)
  ├─ MessageInput (inline component)
  └─ SuggestedQuestions (inline component)
```

**NO separate files until you have 3+ use cases**

### 1.3 State Management (React State, Not Redux)
```typescript
interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number; // Use number, not Date (serialization issues)
  error?: string; // Track which messages failed
}

// Store in localStorage
const STORAGE_KEY = `ai_chat_${businessId}`;
const MAX_STORED_MESSAGES = 50; // Prevent localStorage bloat
```

**Why localStorage first?**
- Faster to build (no backend DB changes)
- Works offline
- Easy to test
- Add server persistence later when proven valuable

---

## Phase 2: Backend API (Week 1-2)

### 2.1 Data Context Builder
**File**: `backend/src/services/ai-context.service.ts`

**Purpose**: Gather business data to send to AI

**Functions**:
```typescript
- getBusinessContext(businessId) → {
    businessInfo: { name, type, location }
    currentMonth: { sales, expenses, profit, tax }
    last3Months: [ { month, sales, expenses, profit } ]
    topExpenseCategories: [ { category, amount } ]
    salesTrends: { growth%, topSources }
    taxStatus: { unpaid, upcoming, overdue }
    unverifiedTransactions: count
  }
```

### 2.2 AI Service Integration
**File**: `backend/src/services/ai.service.ts`

**AI Provider Options**:
1. **OpenAI GPT-4** (Recommended)
   - Best reasoning and context understanding
   - Cost: ~$0.03 per 1K tokens (output)
   
2. **Anthropic Claude 3.5**
   - Great at structured analysis
   - Cost: ~$0.015 per 1K tokens
   
3. **Google Gemini Pro**
   - Free tier available
   - Good for budget-conscious start

**Functions**:
```typescript
- sendMessage(businessId, userMessage, conversationHistory)
  → AI response with business context injected

- buildSystemPrompt(businessContext)
  → "You are a Nigerian tax and business advisor..."
```

### 2.3 API Endpoints
**File**: `backend/src/routes/ai.routes.ts`

```
POST   /businesses/:id/ai/chat
  Body: { message: string, conversationHistory?: Message[] }
  Response: { reply: string, contextUsed: {...} }

GET    /businesses/:id/ai/context
  Response: { businessContext: {...} }

DELETE /businesses/:id/ai/history
  Response: { success: true }
```

---

## Phase 3: Security & Privacy (Week 2)

### 3.1 Data Sanitization
- Never send user emails, phone numbers, or PII to AI
- Anonymize customer names: "Customer A", "Customer B"
- Only send aggregated financial data, not individual transactions

### 3.2 Rate Limiting
- Max 20 messages per user per day (prevent abuse)
- Max 5 concurrent requests per business
- Implement cooldown between messages (2 seconds)

### 3.3 Cost Control
```typescript
- Set max tokens per request (500 output tokens)
- Cache business context (refresh every 5 minutes)
- Track API usage per business for billing
```

---

## Phase 4: AI Prompt Engineering (Week 2)

### 4.1 System Prompt Template
```
You are TaxBot, an AI assistant for Nigerian small businesses using PayMyTax.

Your expertise:
- Nigerian tax laws (7.5% turnover tax for SMEs)
- Business finance and accounting
- Profit margin analysis
- Cash flow management
- Expense categorization

Current Business Context:
[INJECTED BUSINESS DATA]

Guidelines:
1. Be conversational but professional
2. Use Nigerian Naira (₦) for all amounts
3. Provide actionable advice, not generic tips
4. If data is insufficient, ask clarifying questions
5. Always cite specific numbers from their data
6. Suggest next steps they can take in the app

Do NOT:
- Give legal advice
- Make investment recommendations
- Share information about other businesses
```

### 4.2 Context Injection Format
```
Business: ABC Retail Store
Type: Retail | Location: Lagos, Lagos

This Month (June 2026):
- Sales: ₦700,000
- Expenses: ₦400,000
- Gross Profit: ₦300,000
- Tax Payable: ₦52,500 (7.5%)

Last 3 Months Trend:
- March: ₦600K sales, ₦350K expenses
- April: ₦650K sales, ₦380K expenses
- May: ₦680K sales, ₦390K expenses

Top Expense Categories:
1. Inventory - ₦200,000
2. Rent - ₦50,000
3. Salary - ₦80,000

Alerts:
- 3 unverified transactions (₦15,000 total)
- Tax payment due in 15 days
```

---

## Phase 5: Advanced Features (Week 3+)

### 5.1 Smart Suggestions
- Proactive insights: "Your profit margin dropped 5% this month"
- Tax reminders: "You have ₦50K tax due in 5 days"
- Anomaly detection: "Your electricity bill is 3x higher than usual"

### 5.2 Export & History
- Save important conversations
- Export chat as PDF
- Search through past conversations

### 5.3 Voice Input (Future)
- Speech-to-text for Nigerian accents
- Hands-free business queries

---

## Technical Architecture

```
┌─────────────────┐
│   Frontend      │
│  AIAssistant    │
│   Component     │
└────────┬────────┘
         │
         │ POST /ai/chat
         ▼
┌─────────────────┐
│   Backend       │
│  AI Controller  │
└────────┬────────┘
         │
         ├──▶ ai-context.service.ts
         │    (Fetch business data)
         │
         └──▶ ai.service.ts
              │
              ├──▶ Build system prompt
              ├──▶ Inject business context
              ├──▶ Call OpenAI/Claude API
              └──▶ Return formatted response
```

---

## Cost Estimation

### OpenAI GPT-4 Turbo (Recommended)
- Input: $0.01 per 1K tokens
- Output: $0.03 per 1K tokens

**Per Conversation** (average):
- System prompt + context: ~800 tokens = $0.008
- User message: ~50 tokens = $0.0005
- AI response: ~300 tokens = $0.009
- **Total per message: ~$0.02 (₦30)**

**Monthly Cost** (1000 active users, 10 messages each):
- 10,000 messages × $0.02 = **$200/month (₦300,000)**

### Cost Reduction Strategies
1. Cache business context (reduce input tokens)
2. Use GPT-4-mini for simple queries (80% cheaper)
3. Implement free tier (5 messages/day) + paid upgrade

---

## Environment Variables

```env
# AI Provider (choose one)
AI_PROVIDER=openai  # openai | anthropic | gemini

# OpenAI
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4-turbo-preview
OPENAI_MAX_TOKENS=500

# Anthropic Claude
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-3-5-sonnet-20241022

# Google Gemini
GOOGLE_API_KEY=...
GEMINI_MODEL=gemini-pro

# Rate Limiting
AI_MAX_MESSAGES_PER_DAY=20
AI_MAX_TOKENS_PER_REQUEST=500
AI_COOLDOWN_SECONDS=2
```

---

## Database Schema

```prisma
model AIConversation {
  id         String   @id @default(uuid())
  businessId String
  business   Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  messages AIMessage[]

  @@index([businessId, createdAt])
}

model AIMessage {
  id             String         @id @default(uuid())
  conversationId String
  conversation   AIConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  
  role           String         // 'user' | 'assistant'
  content        String         @db.Text
  tokensUsed     Int?           // track API costs
  
  createdAt      DateTime       @default(now())

  @@index([conversationId, createdAt])
}

model AIUsage {
  id             String   @id @default(uuid())
  businessId     String
  business       Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  
  date           DateTime @db.Date
  messagesCount  Int      @default(0)
  tokensUsed     Int      @default(0)
  costUSD        Decimal  @db.Decimal(10, 4)
  
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([businessId, date])
  @@index([businessId, date])
}
```

---

## Implementation Timeline

### Week 1: Frontend + Basic Backend
- ✅ Day 1-2: Build chat UI component
- ✅ Day 3-4: Create backend API endpoints
- ✅ Day 5: Integrate OpenAI API
- ✅ Day 6-7: Connect frontend to backend

### Week 2: Intelligence & Security
- ✅ Day 1-2: Build context service (business data)
- ✅ Day 3-4: Prompt engineering and testing
- ✅ Day 5-6: Rate limiting and cost controls
- ✅ Day 7: Security audit and sanitization

### Week 3: Polish & Launch
- ✅ Day 1-2: Error handling and edge cases
- ✅ Day 3-4: User testing and feedback
- ✅ Day 5-6: Performance optimization
- ✅ Day 7: Production deployment

---

## Success Metrics

1. **Engagement**: % of users who try AI assistant
2. **Retention**: Users who return after first use
3. **Quality**: Average user rating (thumbs up/down)
4. **Cost**: Average cost per message
5. **Business Impact**: Do AI users pay taxes faster?

---

## Next Steps

1. **Approve this plan** and choose AI provider (OpenAI recommended)
2. **Get API key** from chosen provider
3. **Start with Phase 1**: Build frontend chat interface
4. **Iterate**: Launch MVP, gather feedback, improve prompts

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| High API costs | Rate limiting + token limits + caching |
| Bad AI advice | Disclaimer + human review for critical decisions |
| Data privacy | Anonymize PII + audit logs + user consent |
| API downtime | Graceful fallbacks + error messages |
| Prompt injection | Input sanitization + output validation |

---

**Ready to start? Let's build the frontend first! 🚀**
