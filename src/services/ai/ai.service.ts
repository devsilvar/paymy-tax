import Groq from 'groq-sdk';
import { config } from '@/config';
import logger from '@/lib/logger';
import { buildBusinessFinancialContext, BusinessFinancialContext } from './ai-context.service';
import { AIConfigService } from './ai-config.service';
import { UniversalAIClient, UniversalChatMessage } from './universal-ai.client';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AIResponse {
  reply: string;
  provider: string;
  model: string;
  contextSummary?: {
    totalSales: number;
    totalExpenses: number;
    grossProfit: number;
    profitMargin: number;
    taxPayable: number;
  };
}

interface CachedResponse {
  reply: string;
  provider: string;
  model: string;
  contextSummary?: any;
  cachedAt: number;
}

const responseCache = new Map<string, CachedResponse>();
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

function getCachedResponse(businessId: string, userMessage: string): AIResponse | null {
  const key = `${businessId}:${userMessage.trim().toLowerCase()}`;
  const hit = responseCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.cachedAt > CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  return {
    reply: hit.reply,
    provider: hit.provider,
    model: hit.model,
    contextSummary: hit.contextSummary,
  };
}

function setCachedResponse(businessId: string, userMessage: string, response: AIResponse): AIResponse {
  const key = `${businessId}:${userMessage.trim().toLowerCase()}`;
  responseCache.set(key, {
    ...response,
    cachedAt: Date.now(),
  });

  if (responseCache.size > 2000) {
    const now = Date.now();
    for (const [k, v] of responseCache.entries()) {
      if (now - v.cachedAt > CACHE_TTL_MS) {
        responseCache.delete(k);
      }
    }
  }
  return response;
}

/**
 * Generates an executive-level business advisory response grounded in real business data.
 */
export async function generateAIResponse(
  businessId: string,
  userId: string,
  userMessage: string,
  history: ChatMessage[] = []
): Promise<AIResponse> {
  // Check short-term deduplication cache (for rapid repeat clicks or identical queries)
  if (history.length === 0) {
    const cached = getCachedResponse(businessId, userMessage);
    if (cached) {
      return cached;
    }
  }

  // 1. Gather verified financial data from database
  const { context, summaryText } = await buildBusinessFinancialContext(businessId, userId);

  // 2. Build system prompt
  const systemPrompt = `
You are the Senior SME Financial Advisor & Tax Intelligence Copilot for PayMyTax by WallX, assisting Nigerian business owners.
Your mission is to help the business owner understand their financial health, diagnose operational bottlenecks, discover what can be improved, and ensure strict FIRS tax compliance.

STRICT GROUNDING RULES:
1. Always base your answers on the verified business financial data provided below. Do not invent, guess, or contradict these numbers.
2. The Nigerian tax rate is strictly 7.5% of Gross Profit (Sales minus Deductible Expenses).
3. All financial amounts must be formatted in Nigerian Naira using the symbol ₦ with comma separators (e.g., ₦350,000).
4. Organize your responses using clean Markdown formatting:
   - Use bold for key numbers and metrics.
   - Use bullet points for readability.
   - Include 2-3 specific, realistic, and actionable recommendations.
5. If the business is experiencing an operating loss or low margin, be direct and constructive: pinpoint the exact driver (e.g. rising inventory costs, uncollected receivables).
6. Always maintain an encouraging, highly professional, executive tone.

=== VERIFIED LIVE BUSINESS FINANCIAL DATA ===
${summaryText}
`.trim();

  // 3. Attempt Active Configured Universal Provider (Admin-Configured or Cached)
  try {
    const activeConfig = await AIConfigService.getActiveConfig();
    if (activeConfig.isActive && activeConfig.apiKey) {
      const messages: UniversalChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...history.slice(-6).map((msg) => ({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        })),
        { role: 'user', content: userMessage },
      ];

      const completion = await UniversalAIClient.generateCompletion({
        baseUrl: activeConfig.baseUrl,
        apiKey: activeConfig.apiKey,
        model: activeConfig.model,
        messages,
        temperature: activeConfig.temperature,
        maxTokens: activeConfig.maxTokens,
      });

      if (completion.reply) {
        return setCachedResponse(businessId, userMessage, {
          reply: completion.reply,
          provider: activeConfig.provider,
          model: activeConfig.model,
          contextSummary: extractContextSummary(context),
        });
      }
    }
  } catch (err: any) {
    logger.warn('[AI Service] Active provider execution failed, attempting fallback:', {
      message: err.message,
    });
  }

  // 4. Secondary Fallback: Attempt Groq if distinct from failed provider
  if (config.ai.groqApiKey) {
    try {
      const groq = new Groq({ apiKey: config.ai.groqApiKey });
      const model = config.ai.model || 'qwen/qwen3.8-27b';

      const conversationTurns = history.slice(-6).map((msg) => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      }));

      const completion = await groq.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...conversationTurns,
          { role: 'user', content: userMessage },
        ],
        temperature: 0.3,
        max_tokens: 1024,
      });

      const reply = completion.choices[0]?.message?.content;
      if (reply) {
        return setCachedResponse(businessId, userMessage, {
          reply,
          provider: 'groq',
          model,
          contextSummary: extractContextSummary(context),
        });
      }
    } catch (err: any) {
      logger.warn('[AI Service] Secondary Groq fallback failed:', {
        message: err.message,
      });
    }
  }

  // 5. Tertiary Fallback: Attempt Google Gemini
  if (config.ai.geminiApiKey) {
    try {
      const geminiModel = 'gemini-3.6-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${config.ai.geminiApiKey}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: systemPrompt }],
          },
          contents: [
            ...history.slice(-4).map((msg) => ({
              role: msg.role === 'user' ? 'user' : 'model',
              parts: [{ text: msg.content }],
            })),
            {
              role: 'user',
              parts: [{ text: userMessage }],
            },
          ],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 1024,
          },
        }),
      });

      if (response.ok) {
        const data = (await response.json()) as any;
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          return {
            reply: text,
            provider: 'gemini',
            model: geminiModel,
            contextSummary: extractContextSummary(context),
          };
        }
      }
    } catch (err: any) {
      logger.warn('[AI Service] Tertiary Gemini fallback failed:', { message: err.message });
    }
  }

  // 5. High-Quality Deterministic Local Rule-Based Mock Fallback
  // Ensures local development and test environments receive intelligent answers grounded in actual data
  logger.info('[AI Service] Serving deterministic business diagnostic fallback');
  const fallbackReply = generateDeterministicDiagnostic(userMessage, context);

  return {
    reply: fallbackReply,
    provider: 'mock_fallback',
    model: 'paymytax-financial-rules-engine',
    contextSummary: extractContextSummary(context),
  };
}

function extractContextSummary(context: BusinessFinancialContext) {
  return {
    totalSales: context.currentMonth.totalSales,
    totalExpenses: context.currentMonth.totalExpenses,
    grossProfit: context.currentMonth.grossProfit,
    profitMargin: context.currentMonth.profitMarginPercent,
    taxPayable: context.currentMonth.taxPayable,
  };
}

/**
 * Generates an intelligent, grounded diagnostic response when external LLM API is unavailable.
 */
function generateDeterministicDiagnostic(
  query: string,
  ctx: BusinessFinancialContext
): string {
  const q = query.toLowerCase();
  const cm = ctx.currentMonth;
  const topExpense = ctx.topExpenseDrivers[0];

  // Intent: Tax & Deadlines
  if (q.includes('tax') || q.includes('firs') || q.includes('deadline') || q.includes('due')) {
    return `### 🏛️ Tax Compliance & Obligation Summary for **${ctx.business.name}**

Here is your FIRS tax status for **${cm.periodName}**:
- **Gross Profit:** ₦${cm.grossProfit.toLocaleString()} (Sales ₦${cm.totalSales.toLocaleString()} − Deductible Expenses ₦${cm.totalExpenses.toLocaleString()})
- **Tax Rate:** **${cm.taxRatePercent}%** (FIRS Gross Profit Standard)
- **Estimated Tax Payable:** **₦${cm.taxPayable.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}**
- **Filing Status:** ${cm.isFinalized ? '✅ **Finalized**' : '📝 **Draft / Live Calculation**'}
- **Payment Status:** ${cm.paymentStatus === 'completed' ? '🟢 **Paid**' : '⏳ **Pending Remittance**'}

#### 💡 Compliance Guidelines:
1. **FIRS Remittance Deadline:** Monthly returns must be filed and remitted on or before the **21st of the following month**.
2. **Deductions:** Keep receipts for all deductible business expenses to defend your gross profit calculations during audit checks.
3. ${cm.taxPayable > 0 ? 'You can finalize this month’s report and pay directly via Paystack from your **Tax Reports** dashboard.' : 'No tax is payable when operating at a loss.'}`;
  }

  // Intent: What is going wrong / Problems
  if (q.includes('wrong') || q.includes('problem') || q.includes('issue') || q.includes('loss') || q.includes('bad')) {
    const issues: string[] = [];
    if (cm.isOperatingLoss) {
      issues.push(`⚠️ **Operating at a Loss:** Your expenses (**₦${cm.totalExpenses.toLocaleString()}**) currently exceed your sales (**₦${cm.totalSales.toLocaleString()}**), resulting in a net deficit of **-₦${Math.abs(cm.grossProfit).toLocaleString()}**.`);
    } else if (cm.profitMarginPercent < ctx.business.targetProfitMarginPercent) {
      issues.push(`⚠️ **Margin Erosion:** Your current margin (**${cm.profitMarginPercent}%**) is under your target of **${ctx.business.targetProfitMarginPercent}%**.`);
    }

    if (ctx.invoicingHealth.overdueAmount > 0) {
      issues.push(`⚠️ **Trapped Cashflow:** You have **₦${ctx.invoicingHealth.overdueAmount.toLocaleString()}** tied up across **${ctx.invoicingHealth.overdueInvoicesCount} overdue invoice(s)** that have not been collected.`);
    }

    if (topExpense && topExpense.sharePercent > 50) {
      issues.push(`⚠️ **Concentrated Expense Risk:** **${topExpense.category}** represents **${topExpense.sharePercent}%** of your total spending (₦${topExpense.amount.toLocaleString()}).`);
    }

    if (issues.length === 0) {
      return `### 📊 Health Check for **${ctx.business.name}**

Good news! Your core financial metrics are looking solid for **${cm.periodName}**:
- **Profit Margin:** **${cm.profitMarginPercent}%** (Target: ${ctx.business.targetProfitMarginPercent}%)
- **Gross Profit:** **₦${cm.grossProfit.toLocaleString()}**
- **Overdue Invoices:** ₦0.00 (All customer receivables are up to date)

#### 💡 Areas to Watch:
- Continuously monitor your top expense category: **${topExpense ? topExpense.category : 'General Operations'}**.
- Prepare your tax remittance of **₦${cm.taxPayable.toLocaleString()}** before the 21st.`;
    }

    return `### 🔍 Critical Diagnostic Findings for **${ctx.business.name}**

Here are the key bottlenecks currently impacting your business:

${issues.join('\n\n')}

#### 💡 Immediate Corrective Actions:
1. ${ctx.invoicingHealth.overdueAmount > 0 ? `**Send payment reminders** to clients with overdue balances to recover **₦${ctx.invoicingHealth.overdueAmount.toLocaleString()}** immediately.` : '**Focus on increasing high-margin sales volume.**'}
2. **Review spending** in **${topExpense?.category || 'your main expense areas'}** to renegotiate terms or eliminate recurring leakages.
3. Keep logging daily expenses to maintain an accurate view of operational cash flow.`;
  }

  // Intent: What to improve / Cost cutting / Growth
  if (q.includes('improve') || q.includes('increase') || q.includes('grow') || q.includes('better') || q.includes('cut')) {
    return `### 💡 Strategic Improvement Plan for **${ctx.business.name}**

Based on your actual performance figures for **${cm.periodName}**, here is where you have the highest leverage:

1. **Recover Overdue Invoices:**
   - You have **₦${ctx.invoicingHealth.overdueAmount.toLocaleString()}** in overdue client invoices. Following up today will immediately improve your cash position without incurring any loans.
2. **Optimize ${topExpense ? topExpense.category : 'Major Costs'}:**
   - ${topExpense ? `Your largest expense is **${topExpense.category}** at **₦${topExpense.amount.toLocaleString()}** (${topExpense.sharePercent}% of total expenses). Negotiating bulk supplier discounts or payment terms can save 5–10% straight to your gross profit.` : 'Record all operating costs to accurately see your cost drivers.'}
3. **Protect Your Profit Margin:**
   - Your current margin is **${cm.profitMarginPercent}%** (Target: **${ctx.business.targetProfitMarginPercent}%**). Focus marketing on your highest-margin products or service packages.
4. **Automate Sales Capture:**
   - Use your Dedicated Virtual Account (DVA) for customer bank transfers to ensure zero sales are missed.`;
  }

  // Intent: Biggest expenses / spending breakdown
  if (q.includes('expense') || q.includes('spending') || q.includes('cost') || q.includes('spend')) {
    const drivers = ctx.topExpenseDrivers;
    return `### 💸 Expense Breakdown for **${ctx.business.name}** (${cm.periodName})

Total Deductible Spending: **₦${cm.totalExpenses.toLocaleString()}**

${drivers.length > 0 ? drivers.map((d, i) => `${i + 1}. **${d.category}:** ₦${d.amount.toLocaleString()} (${d.sharePercent}% of total spending)`).join('\n') : '• No expenses recorded this month yet.'}

#### 💡 Cost Management Advice:
- **Tax Deductibility:** Ensure all expenses logged are wholly, exclusively, and necessarily incurred for business operations to qualify for FIRS gross profit deductions.
- **Top Driver:** Focus your cost-cutting efforts on **${drivers[0]?.category || 'primary operations'}**, which carries the largest financial weight.`;
  }

  // Default: General Overview & Health Snapshot
  return `### 📊 Executive Financial Overview: **${ctx.business.name}** (${cm.periodName})

Here is how your business is performing this month:
- **Total Sales Revenue:** **₦${cm.totalSales.toLocaleString()}**
- **Deductible Expenses:** **₦${cm.totalExpenses.toLocaleString()}**
- **Gross Profit:** **₦${cm.grossProfit.toLocaleString()}**
- **Profit Margin:** **${cm.profitMarginPercent}%** ${cm.profitMarginPercent >= ctx.business.targetProfitMarginPercent ? '🟢 (Healthy)' : '⚠️ (Below Target)'}
- **Estimated Tax (7.5%):** **₦${cm.taxPayable.toLocaleString()}**

#### 🔍 Health Assessment:
- ${cm.grossProfit > 0 ? `Your business is generating positive gross profit of **₦${cm.grossProfit.toLocaleString()}**.` : 'Your business is currently operating at a deficit this month.'}
- ${ctx.invoicingHealth.overdueAmount > 0 ? `You have **₦${ctx.invoicingHealth.overdueAmount.toLocaleString()}** in overdue client invoices requiring collection.` : 'Your invoice collections are up to date.'}

Ask me anything specific, such as *"What is going wrong?"*, *"Where am I spending the most money?"*, or *"What can I improve?"*`;
}
