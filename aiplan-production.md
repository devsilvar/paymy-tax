# AI Business Assistant - PRODUCTION PLAN
**Senior Engineer Review (50+ years shipping experience)**

## 🚨 CRITICAL: Read This First

**This is HIGH-RISK**. AI can give bad financial advice that costs users money. Plan for failure.

### Legal Requirements (DO BEFORE ANY CODE)
1. ✅ Add disclaimer: "AI is not a financial advisor"
2. ✅ Update Terms of Service
3. ✅ Get liability insurance approval
4. ✅ Nigerian Data Protection Review (NDPR)

### Cost Risk
- **Worst case**: Exploited by bots = $2000/day in API costs
- **Solution**: Hard limits + kill switch

---

## Phase 0: Foundation (Day 1)

### A. Feature Flag
```typescript
// Can disable instantly without deployment
AI_ENABLED=true  // Set to false in emergency
```

### B. Cost Controls (REQUIRED)
```typescript
// Hard limits per user per day
FREE_TIER: 5 messages/day
PAID_TIER: 20 messages/day (future)

// Global circuit breaker
DAILY_BUDGET: $50
AUTO_SHUTDOWN_AT: 80% budget

// Per message
MAX_OUTPUT_TOKENS: 400
TIMEOUT: 30 seconds
```

### C. Privacy Rules
**Send to AI:**
- ✅ Sales: ₦500K (aggregated)
- ✅ Expenses: ₦300K (aggregated)
- ✅ Month/Year: June 2026

**NEVER send:**
- ❌ Customer names/emails/phones
- ❌ User emails
- ❌ Bank details
- ❌ Transaction IDs
- ❌ Specific transaction descriptions

---

## Phase 1: MVP Frontend (2-3 Days)

### File Structure (Simple)
```
frontend/src/pages/
  AIAssistant.tsx  (single file, ~300 lines)
```

### Features (MVP Only)
- ✅ Message bubbles (user/AI)
- ✅ Text input + send
- ✅ Loading spinner
- ✅ Error messages
- ✅ 3 suggested questions
- ✅ Store in localStorage (NOT server yet)

### NOT in MVP
- ❌ Fancy typing animation
- ❌ Message history API
- ❌ Export chat
- ❌ Voice input
- ❌ Markdown rendering
- ❌ Edit messages

### State Management
```typescript
// Use React useState, NOT Redux
interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  error?: string;
}

// localStorage key per business
const key = `ai_chat_${businessId}`;
const MAX_MESSAGES = 50; // Prevent bloat
```

### Why localStorage First?
1. Faster to build (no DB schema)
2. Works offline
3. Easy to test
4. Add server later if users want it

---

## Phase 2: Backend API (2-3 Days)

### A. Endpoint
```
POST /api/v1/businesses/:id/ai/chat
Auth: Bearer token
Body: { message: string }
Response: { reply: string, tokensUsed: number }
```

### B. Architecture
```typescript
// ai.controller.ts
export async function chat(req, res) {
  // 1. Rate limit check
  // 2. Get business context
  // 3. Call AI provider
  // 4. Log usage
  // 5. Return response
}
```

### C. Business Context Service
```typescript
// ai-context.service.ts
async function getBusinessContext(businessId) {
  const [sales, expenses, tax] = await Promise.all([
    getSalesThisMonth(businessId),
    getExpensesThisMonth(businessId),
    getTaxStatus(businessId)
  ]);
  
  return {
    month: "June 2026",
    sales: 500000,  // Aggregated only
    expenses: 300000,
    profit: 200000,
    taxDue: 37500,
    topExpenses: [
      { category: "inventory", amount: 150000 },
      { category: "rent", amount: 50000 }
    ],
    alerts: {
      unverified: 3,
      taxDueInDays: 15
    }
  };
}
```

### D. AI Provider Choice
**Recommendation: OpenAI GPT-4o-mini**

Why NOT GPT-4?
- GPT-4: $0.03/1K tokens = ₦45/message
- GPT-4o-mini: $0.006/1K tokens = ₦9/message
- **5x cheaper, 95% as good for this use case**

Alternative: Claude 3.5 Haiku (similar cost)

### E. System Prompt (Critical)
```typescript
const SYSTEM_PROMPT = `You are TaxBot, a Nigerian business advisor.

Context for ${business.name}:
- Type: ${business.type}
- This month: ₦${sales} sales, ₦${expenses} expenses
- Tax due: ₦${taxDue} in ${daysUntil} days

Rules:
1. Use Nigerian Naira (₦) 
2. Reference SPECIFIC numbers from their data
3. Be concise (2-3 sentences max)
4. If unsure, say "I don't have enough data"
5. NEVER give legal/investment advice
6. End with ONE actionable next step

Example:
"Your profit margin is ${margin}% this month. Your rent (₦${rent}) is ${pct}% of expenses. Consider reviewing your lease when it renews."
`;
```

**Why short responses?**
- Cheaper (fewer tokens)
- Users read more
- Faster response time

---

## Phase 3: Rate Limiting (Critical)

### Implementation
```typescript
// Use Redis or in-memory cache
interface RateLimit {
  userId: string;
  date: string;  // YYYY-MM-DD
  count: number;
}

async function checkRateLimit(userId: string) {
  const key = `ai_limit:${userId}:${today}`;
  const count = await redis.incr(key);
  await redis.expire(key, 86400); // 24 hours
  
  if (count > DAILY_LIMIT) {
    throw new AppError(429, 'Daily AI limit reached. Try tomorrow.');
  }
  
  return count;
}
```

### Per-Message Timeout
```typescript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30000);

try {
  const response = await openai.chat.completions.create({
    messages: [...],
    signal: controller.signal
  });
} finally {
  clearTimeout(timeout);
}
```

---

## Phase 4: Cost Monitoring (Required)

### Admin Dashboard Endpoint
```typescript
GET /api/v1/admin/ai/usage
Response: {
  today: { messages: 45, cost: 12.50, budget: 50 },
  users: [
    { email: "user@example.com", messages: 15 },
    ...
  ]
}
```

### Database Tracking
```prisma
model AIUsage {
  id        String   @id
  userId    String
  date      DateTime @db.Date
  messages  Int
  tokens    Int
  costUSD   Decimal  @db.Decimal(10,4)
  
  @@unique([userId, date])
  @@index([date])
}
```

### Alert System
```typescript
async function logUsage(userId, tokens, cost) {
  // Save to DB
  await prisma.aIUsage.upsert({...});
  
  // Check daily total
  const todayTotal = await getTodayTotalCost();
  
  if (todayTotal > DAILY_BUDGET * 0.8) {
    await sendSlackAlert('AI cost at 80%!');
    
    if (todayTotal > DAILY_BUDGET) {
      await disableAIFeature();
      await sendSlackAlert('🚨 AI DISABLED - Budget exceeded');
    }
  }
}
```

---

## Phase 5: Error Handling (Production)

### AI Response Validation
```typescript
async function validateAIResponse(response: string) {
  // Check for hallucinations
  if (response.includes('invest in crypto')) return false;
  if (response.includes('guaranteed returns')) return false;
  if (response.includes('legal advice')) return false;
  
  // Check length
  if (response.length > 1000) return false;
  
  // Check for personal info leak
  if (containsEmail(response)) return false;
  if (containsPhoneNumber(response)) return false;
  
  return true;
}
```

### Graceful Degradation
```typescript
try {
  const reply = await aiService.chat(message);
  
  if (!validateAIResponse(reply)) {
    throw new Error('Invalid AI response');
  }
  
  return reply;
} catch (error) {
  logger.error('AI failed', { error, userId });
  
  // Fallback response
  return "I'm having trouble right now. Please try again in a few minutes.";
}
```



---

## Phase 6: Testing Strategy

### Unit Tests (Required)
```typescript
describe('AI Context Builder', () => {
  it('should aggregate sales correctly');
  it('should never include PII');
  it('should handle missing data gracefully');
});

describe('Rate Limiter', () => {
  it('should block after daily limit');
  it('should reset at midnight');
});

describe('Response Validator', () => {
  it('should reject responses with PII');
  it('should reject investment advice');
});
```

### Integration Tests
```typescript
// Test full flow with mocked AI
POST /businesses/:id/ai/chat
  ✅ Returns response within 5 seconds
  ✅ Increments rate limit counter
  ✅ Logs usage to database
  ✅ Returns 429 after limit exceeded
```

### Load Testing
```bash
# Simulate 100 concurrent users
artillery run ai-load-test.yml

# Expected:
# - p95 latency < 3s
# - Error rate < 1%
# - No memory leaks
```

---

## Phase 7: Rollout Strategy (Critical)

### Week 1: Internal Testing
- ✅ Team members only
- ✅ 10 messages/day limit
- ✅ Monitor costs daily
- ✅ Fix bugs

### Week 2: Beta (10% of users)
- ✅ Feature flag: 10% rollout
- ✅ Email opt-in required
- ✅ Feedback form after each chat
- ✅ Daily cost monitoring

### Week 3: Expand (50% of users)
- ✅ If Week 2 successful
- ✅ Increase daily limit to 10 messages
- ✅ Add analytics

### Week 4: Full Launch (100%)
- ✅ If Week 3 successful
- ✅ Press release
- ✅ User education content

**NEVER do 100% day 1** - You can't rollback AI conversations

---

## Cost Projections (Realistic)

### Best Case (GPT-4o-mini)
```
1000 users × 5 messages/day × $0.002/message
= $10/day = $300/month = ₦450K/month
```

### Realistic Case
```
1000 users × 3 messages/day (actual usage)
= $6/day = $180/month = ₦270K/month
```

### Worst Case (No limits)
```
10 bots × 1000 messages/day × $0.002
= $20,000/day = BANKRUPTCY
```

**This is why rate limiting is NON-NEGOTIABLE**

---

## Success Metrics (Track These)

### Engagement
- % users who send first message
- % users who send 2+ messages
- Messages per user per day
- Daily active users

### Quality
- Thumbs up/down per message (add this!)
- User feedback scores
- Messages marked "not helpful"

### Cost
- Cost per message
- Cost per user per month
- % of budget used

### Business Impact
- Do AI users verify transactions faster?
- Do AI users pay tax on time more often?
- Do AI users churn less?

---

## Maintenance Plan

### Daily
- Check AI cost dashboard (5 min)
- Review error logs (5 min)

### Weekly
- Review user feedback (30 min)
- Analyze usage patterns (30 min)
- Update system prompt if needed (1 hour)

### Monthly
- Cost optimization review
- Prompt engineering improvements
- Feature requests prioritization

---

## Emergency Procedures

### AI Giving Bad Advice
1. Disable feature via env var
2. Post announcement: "AI temporarily offline"
3. Review conversation logs
4. Fix prompt
5. Re-enable

### Cost Spike
1. Check alert dashboard
2. Identify abusive users
3. Ban if necessary
4. Adjust rate limits
5. Add stricter validation

### API Downtime (OpenAI/Claude)
1. Show friendly error message
2. Queue failed messages (optional)
3. Wait for recovery
4. Consider fallback provider

---

## Implementation Checklist

### Before Writing Code
- [ ] Legal disclaimer drafted
- [ ] Terms of Service updated
- [ ] Choose AI provider (recommend: OpenAI GPT-4o-mini)
- [ ] Get API key
- [ ] Set up cost monitoring

### MVP Backend (3 days)
- [ ] POST /ai/chat endpoint
- [ ] Business context builder
- [ ] AI service integration
- [ ] Rate limiting (Redis/in-memory)
- [ ] Usage logging
- [ ] Error handling

### MVP Frontend (2 days)
- [ ] Chat UI component
- [ ] Message bubbles
- [ ] Text input
- [ ] Suggested questions
- [ ] localStorage persistence
- [ ] Error toasts

### Testing (2 days)
- [ ] Unit tests
- [ ] Integration tests
- [ ] Manual QA
- [ ] Load testing
- [ ] Cost simulation

### Deployment (1 day)
- [ ] Feature flag setup
- [ ] Environment variables
- [ ] Admin dashboard
- [ ] Alert system
- [ ] Rollout to 10 users

**Total: ~8 working days for production-ready MVP**

---

## What Could Go Wrong (Murphy's Law)

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| API costs spiral | High | Critical | Rate limits + circuit breaker |
| AI gives wrong tax advice | Medium | High | Disclaimer + response validation |
| Users spam for fun | High | Medium | Rate limiting + cooldown |
| OpenAI API down | Medium | Medium | Graceful error + fallback message |
| Slow response time (>10s) | Medium | Medium | Timeout + loading UX |
| Data leak to AI | Low | Critical | Sanitization + audit logs |
| Prompt injection attack | Low | Medium | Input validation |

---

## Recommended Approach

### Start Small
1. **Week 1**: Build MVP (backend + frontend)
2. **Week 2**: Test with 10 internal users
3. **Week 3**: Beta with 50 paying customers
4. **Week 4**: Expand to 500 users
5. **Month 2**: Full launch if successful

### Validate Before Scaling
- Get 100 real conversations
- Measure satisfaction score
- Calculate actual cost per user
- Fix top 3 complaints
- THEN scale

### Don't Over-Engineer
- ❌ Don't build conversation branching
- ❌ Don't build AI model fine-tuning
- ❌ Don't build custom embeddings
- ❌ Don't build voice interface

**Do one thing well: Answer business questions accurately**

---

## Final Recommendation

**GO/NO-GO Decision:**
- ✅ GO if:
  - You have $500/month AI budget
  - Legal reviewed disclaimer
  - Can monitor costs daily
  - Comfortable with risk

- ❌ NO-GO if:
  - Budget < $200/month
  - Can't handle bad advice liability
  - No time for monitoring
  - Other priorities more urgent

**My Call**: GO, but start with 50 users max until proven

---

## Next Steps

1. **Get legal approval** (1-2 days)
2. **Get OpenAI API key** (10 minutes)
3. **Build MVP backend** (3 days) ← START HERE
4. **Build MVP frontend** (2 days)
5. **Test with team** (2 days)
6. **Beta launch** (10 users, 1 week)

Ready to build? Let's start with the frontend chat UI! 🚀
