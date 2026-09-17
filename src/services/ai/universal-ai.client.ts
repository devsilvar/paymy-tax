import logger from '@/lib/logger';

export interface UniversalChatMessage {
  role: 'system' | 'user' | 'assistant' | 'developer';
  content: string;
}

export interface UniversalCompletionParams {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: UniversalChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
}

export interface UniversalCompletionResult {
  reply: string;
  model: string;
  latencyMs: number;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

/**
 * Normalizes an API base URL to ensure it targets the standard /chat/completions endpoint.
 */
export function normalizeChatEndpoint(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, '');

  // If the admin already provided the full endpoint
  if (url.endsWith('/chat/completions')) {
    return url;
  }

  // If Gemini native URL with generateContent
  if (url.includes('generativelanguage.googleapis.com') && url.includes(':generateContent')) {
    return url;
  }

  // Standard OpenAI-compatible path
  return `${url}/chat/completions`;
}

/**
 * Universal OpenAI-Compatible HTTP Client
 * Works across Groq, OpenAI, xAI Grok, DeepSeek, Google Gemini (OpenAI endpoint),
 * OpenRouter, Together AI, Mistral, and local Ollama/vLLM endpoints.
 */
export class UniversalAIClient {
  static async generateCompletion(params: UniversalCompletionParams): Promise<UniversalCompletionResult> {
    const {
      baseUrl,
      apiKey,
      model,
      messages,
      temperature = 0.3,
      maxTokens = 1024,
      timeoutMs = 35000,
      extraHeaders = {},
    } = params;

    const endpoint = normalizeChatEndpoint(baseUrl);
    const startTime = Date.now();

    // 1. Detect reasoning models (e.g. OpenAI o1, o3-mini, deepseek-reasoner)
    const isReasoningModel = /^(o1|o3|deepseek-reasoner)/i.test(model);

    // 2. Normalize messages for reasoning model constraints
    let normalizedMessages = messages;
    if (isReasoningModel) {
      normalizedMessages = messages.map((msg) => {
        if (msg.role === 'system') {
          // o1/o3 support 'developer' role, or prepend
          return { role: 'developer' as const, content: msg.content };
        }
        return msg;
      });
    }

    // 3. Build OpenAI-compatible request body
    const requestBody: Record<string, any> = {
      model,
      messages: normalizedMessages,
    };

    // Reasoning models prohibit custom temperatures or require max_completion_tokens
    if (isReasoningModel) {
      requestBody.max_completion_tokens = maxTokens;
    } else {
      requestBody.temperature = temperature;
      requestBody.max_tokens = maxTokens;
    }

    // 4. Setup request headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey.trim()}`,
      ...extraHeaders,
    };

    // OpenRouter attribution headers (helps with rankings and rate limits)
    if (baseUrl.includes('openrouter.ai')) {
      headers['HTTP-Referer'] = 'https://paymytax.ng';
      headers['X-Title'] = 'PayMyTax AI Copilot';
    }

    // 5. Setup AbortController for strict timeout
    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text();
        let parsedMessage = errorText;
        try {
          const errorJson = JSON.parse(errorText);
          parsedMessage =
            errorJson.error?.message ||
            errorJson.message ||
            errorJson.error ||
            JSON.stringify(errorJson);
        } catch {
          // If HTML (e.g., 502/504 Bad Gateway from proxy)
          if (errorText.includes('<html')) {
            parsedMessage = `Gateway Error ${response.status} (${response.statusText})`;
          }
        }

        throw new Error(
          `AI Provider Error (${response.status}): ${parsedMessage}`
        );
      }

      const data = (await response.json()) as any;

      // Extract generated text from OpenAI format
      const rawReply =
        data.choices?.[0]?.message?.content ||
        data.choices?.[0]?.text ||
        '';

      // Clean up internal reasoning traces (<think>...</think> or <thought>...</thought>)
      let reply = rawReply;
      if (typeof reply === 'string') {
        if (reply.includes('</think>')) {
          const parts = reply.split('</think>');
          const after = parts[parts.length - 1].trim();
          if (after) reply = after;
        } else if (reply.includes('</thought>')) {
          const parts = reply.split('</thought>');
          const after = parts[parts.length - 1].trim();
          if (after) reply = after;
        }
      }

      if (!reply && !rawReply) {
        throw new Error('AI provider returned an empty completion response');
      }
      reply = reply || rawReply;

      return {
        reply: reply.trim(),
        model: data.model || model,
        latencyMs,
        usage: {
          promptTokens: data.usage?.prompt_tokens,
          completionTokens: data.usage?.completion_tokens,
          totalTokens: data.usage?.total_tokens,
        },
      };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(`AI request timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      logger.warn('[UniversalAIClient] Outbound AI completion failed:', {
        endpoint,
        model,
        error: err.message,
      });
      throw err;
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  /**
   * Lightweight connection probe to verify credentials and model accessibility.
   */
  static async ping(baseUrl: string, apiKey: string, model: string): Promise<{ success: boolean; latencyMs: number; reply?: string; error?: string }> {
    try {
      const result = await this.generateCompletion({
        baseUrl,
        apiKey,
        model,
        messages: [{ role: 'user', content: 'Respond with "ONLINE" in 1 word.' }],
        maxTokens: 80,
        temperature: 0.2,
        timeoutMs: 30000,
      });

      return {
        success: true,
        latencyMs: result.latencyMs,
        reply: result.reply,
      };
    } catch (err: any) {
      return {
        success: false,
        latencyMs: 0,
        error: err.message || 'Connection test failed',
      };
    }
  }
}
