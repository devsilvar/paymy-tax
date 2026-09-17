import prisma from '@/lib/prisma';
import { config } from '@/config';
import { encrypt, decrypt } from '@/lib/crypto';
import { logAudit } from '@/lib/audit';
import logger from '@/lib/logger';
import { UniversalAIClient } from './universal-ai.client';

export interface ActiveAIConfig {
  id: string;
  provider: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  isActive: boolean;
  source: 'database' | 'env_fallback';
  updatedAt?: Date;
  updatedBy?: string | null;
}

export interface AdminAIConfigResponse {
  id: string;
  provider: string;
  name: string;
  baseUrl: string;
  maskedApiKey: string;
  hasApiKey: boolean;
  model: string;
  temperature: number;
  maxTokens: number;
  isActive: boolean;
  source: 'database' | 'env_fallback';
  updatedAt?: Date;
  updatedBy?: string | null;
}

export interface UpdateAIConfigParams {
  provider: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  isActive?: boolean;
}

export interface TestAIConfigParams {
  provider?: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
}

let cachedConfig: ActiveAIConfig | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 30 * 1000; // 30-second memory cache for high throughput

function maskApiKey(key?: string | null): string {
  if (!key || key.length < 8) return '';
  const prefix = key.slice(0, 6);
  const suffix = key.slice(-4);
  return `${prefix}${'•'.repeat(8)}${suffix}`;
}

export class AIConfigService {
  /**
   * Retrieves the active runtime AI provider configuration.
   * Cached for 30s in-memory. Decrypts stored API key with AES-256-GCM.
   * Falls back to .env if DB record is empty, inactive, or unconfigured.
   */
  static async getActiveConfig(): Promise<ActiveAIConfig> {
    const now = Date.now();
    if (cachedConfig && now < cacheExpiry) {
      return cachedConfig;
    }

    try {
      const record = await (prisma as any).aiProviderConfig.findUnique({
        where: { id: 'default' },
      });

      if (record) {
        let decryptedKey = '';
        if (record.apiKeyEncrypted) {
          decryptedKey = decrypt(record.apiKeyEncrypted) || '';
        }

        // If active in DB and has an API key (or if local endpoint like ollama doesn't need a key)
        const isLocalEndpoint = record.baseUrl.includes('localhost') || record.baseUrl.includes('127.0.0.1');
        if (record.isActive && (decryptedKey || isLocalEndpoint)) {
          cachedConfig = {
            id: record.id,
            provider: record.provider,
            name: record.name,
            baseUrl: record.baseUrl,
            apiKey: decryptedKey || 'local-key',
            model: record.model,
            temperature: Number(record.temperature || 0.3),
            maxTokens: record.maxTokens || 1024,
            isActive: record.isActive,
            source: 'database',
            updatedAt: record.updatedAt,
            updatedBy: record.updatedBy,
          };
          cacheExpiry = now + CACHE_TTL_MS;
          return cachedConfig;
        }
      }
    } catch (err: any) {
      logger.warn('[AIConfigService] Failed to load config from DB, using .env fallback:', {
        message: err.message,
      });
    }

    // Tier 2 Fallback: Read from .env
    const envProvider = config.ai.provider || 'groq';
    let envBaseUrl = 'https://api.groq.com/openai/v1';
    let envApiKey = config.ai.groqApiKey;
    let envModel = config.ai.model || 'qwen/qwen3.8-27b';

    if (envProvider === 'gemini' || (!envApiKey && config.ai.geminiApiKey)) {
      envBaseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai';
      envApiKey = config.ai.geminiApiKey;
      envModel = 'gemini-2.5-flash';
    }

    cachedConfig = {
      id: 'default',
      provider: envProvider,
      name: envProvider === 'groq' ? 'Groq Cloud (.env)' : 'Google Gemini (.env)',
      baseUrl: envBaseUrl,
      apiKey: envApiKey,
      model: envModel,
      temperature: 0.3,
      maxTokens: 1024,
      isActive: true,
      source: 'env_fallback',
    };
    cacheExpiry = now + CACHE_TTL_MS;
    return cachedConfig;
  }

  /**
   * Retrieves sanitized configuration for Admin Management UI.
   * Masks secret API key to prevent browser exposure.
   */
  static async getAdminConfig(): Promise<AdminAIConfigResponse> {
    const active = await this.getActiveConfig();

    return {
      id: active.id,
      provider: active.provider,
      name: active.name,
      baseUrl: active.baseUrl,
      maskedApiKey: maskApiKey(active.apiKey),
      hasApiKey: Boolean(active.apiKey && active.apiKey !== 'local-key'),
      model: active.model,
      temperature: active.temperature,
      maxTokens: active.maxTokens,
      isActive: active.isActive,
      source: active.source,
      updatedAt: active.updatedAt,
      updatedBy: active.updatedBy,
    };
  }

  /**
   * Updates the global AI provider configuration in the database.
   * Encrypts the API key with AES-256-GCM.
   */
  static async updateConfig(
    params: UpdateAIConfigParams,
    adminUserId: string
  ): Promise<AdminAIConfigResponse> {
    const existing = await (prisma as any).aiProviderConfig.findUnique({
      where: { id: 'default' },
    });

    let newEncryptedKey: string | null = existing?.apiKeyEncrypted || null;

    // Check if a fresh API key was provided
    if (params.apiKey && !params.apiKey.includes('•') && params.apiKey.trim().length > 0) {
      newEncryptedKey = encrypt(params.apiKey.trim());
    }

    const updated = await (prisma as any).aiProviderConfig.upsert({
      where: { id: 'default' },
      update: {
        provider: params.provider.trim(),
        name: params.name.trim(),
        baseUrl: params.baseUrl.trim(),
        apiKeyEncrypted: newEncryptedKey,
        model: params.model.trim(),
        temperature: params.temperature !== undefined ? params.temperature : 0.3,
        maxTokens: params.maxTokens || 1024,
        isActive: params.isActive !== undefined ? params.isActive : true,
        updatedBy: adminUserId,
      },
      create: {
        id: 'default',
        provider: params.provider.trim(),
        name: params.name.trim(),
        baseUrl: params.baseUrl.trim(),
        apiKeyEncrypted: newEncryptedKey,
        model: params.model.trim(),
        temperature: params.temperature !== undefined ? params.temperature : 0.3,
        maxTokens: params.maxTokens || 1024,
        isActive: params.isActive !== undefined ? params.isActive : true,
        updatedBy: adminUserId,
      },
    });

    // Invalidate in-memory cache immediately
    cachedConfig = null;
    cacheExpiry = 0;

    await logAudit({
      userId: adminUserId,
      action: 'admin.ai_config_updated',
      newData: {
        provider: updated.provider,
        name: updated.name,
        baseUrl: updated.baseUrl,
        model: updated.model,
        isActive: updated.isActive,
        keyUpdated: Boolean(params.apiKey && !params.apiKey.includes('•')),
      },
    });

    return this.getAdminConfig();
  }

  /**
   * Tests connection with the provided or existing credentials before saving.
   */
  static async testConnection(
    params: TestAIConfigParams
  ): Promise<{ success: boolean; latencyMs: number; reply?: string; error?: string }> {
    let apiKeyToTest = params.apiKey?.trim() || '';

    // If key is masked or empty, resolve from current stored active configuration
    if (!apiKeyToTest || apiKeyToTest.includes('•')) {
      const active = await this.getActiveConfig();
      apiKeyToTest = active.apiKey;
    }

    return UniversalAIClient.ping(params.baseUrl, apiKeyToTest, params.model);
  }
}
