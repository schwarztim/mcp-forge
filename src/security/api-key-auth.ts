/**
 * API Key Authentication
 *
 * Supports simple API key authentication for tools that don't have OAuth.
 * This is the reality for many enterprise APIs - they just give you an API key.
 *
 * Supported patterns:
 * - Header-based (X-Api-Key, Authorization: Api-Key xxx, custom headers)
 * - Basic Auth (username:api_key or api_key:x)
 * - Query parameter (less secure, but some APIs require it)
 * - Bearer token (static token, not OAuth)
 *
 * Security considerations:
 * - API keys are static - can't be rotated without downtime
 * - No user context - harder to audit who did what
 * - No expiration - if leaked, valid forever until manually revoked
 * - Store in environment variables, NEVER in code
 */

import { z } from 'zod';
import { logger } from '../observability/logger.js';

/**
 * API Key placement options
 */
export type ApiKeyPlacement = 'header' | 'basic_auth' | 'query' | 'bearer';

/**
 * API Key configuration schema
 */
export const ApiKeyConfigSchema = z.object({
  // How to send the API key
  placement: z.enum(['header', 'basic_auth', 'query', 'bearer']),

  // Header name (for header placement)
  headerName: z.string().optional(),

  // Query parameter name (for query placement)
  queryParam: z.string().optional(),

  // For basic auth - is the key the username or password?
  basicAuthPosition: z.enum(['username', 'password']).optional(),

  // The other half of basic auth (if key is password, this is username)
  basicAuthOther: z.string().optional(),

  // Environment variable name that holds the API key
  envVar: z.string(),

  // Optional: rate limiting
  rateLimitPerMinute: z.number().optional(),

  // Optional: IP allowlist (for additional security)
  allowedIps: z.array(z.string()).optional(),
});

export type ApiKeyConfig = z.infer<typeof ApiKeyConfigSchema>;

/**
 * Common API key patterns for popular services
 */
export const COMMON_API_KEY_PATTERNS: Record<string, Partial<ApiKeyConfig>> = {
  // Header: X-Api-Key
  dynatrace: {
    placement: 'header',
    headerName: 'Api-Token',
    envVar: 'DYNATRACE_API_TOKEN',
  },

  datadog: {
    placement: 'header',
    headerName: 'DD-API-KEY',
    envVar: 'DATADOG_API_KEY',
  },

  splunk: {
    placement: 'bearer',
    envVar: 'SPLUNK_TOKEN',
  },

  pagerduty: {
    placement: 'header',
    headerName: 'Authorization',
    envVar: 'PAGERDUTY_API_KEY', // Sent as "Token token=xxx"
  },

  stripe: {
    placement: 'basic_auth',
    basicAuthPosition: 'username',
    basicAuthOther: '', // Empty password
    envVar: 'STRIPE_SECRET_KEY',
  },

  twilio: {
    placement: 'basic_auth',
    basicAuthPosition: 'password',
    envVar: 'TWILIO_AUTH_TOKEN', // Account SID is username
  },

  sendgrid: {
    placement: 'bearer',
    envVar: 'SENDGRID_API_KEY',
  },

  // Generic patterns
  'x-api-key': {
    placement: 'header',
    headerName: 'X-Api-Key',
    envVar: 'API_KEY',
  },

  bearer: {
    placement: 'bearer',
    envVar: 'API_TOKEN',
  },

  basic: {
    placement: 'basic_auth',
    basicAuthPosition: 'password',
    basicAuthOther: 'api',
    envVar: 'API_KEY',
  },
};

/**
 * API Key Authentication Manager
 */
export class ApiKeyAuth {
  private config: ApiKeyConfig;
  private rateLimitCounter: Map<string, { count: number; resetAt: number }> = new Map();

  constructor(config: ApiKeyConfig) {
    this.config = ApiKeyConfigSchema.parse(config);
  }

  /**
   * Get the API key from environment
   */
  getApiKey(): string | undefined {
    return process.env[this.config.envVar];
  }

  /**
   * Check if API key is configured
   */
  isConfigured(): boolean {
    const key = this.getApiKey();
    return !!key && key.length > 0;
  }

  /**
   * Generate headers for API request
   */
  getAuthHeaders(): Record<string, string> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error(`API key not found in environment variable: ${this.config.envVar}`);
    }

    const headers: Record<string, string> = {};

    switch (this.config.placement) {
      case 'header':
        headers[this.config.headerName || 'X-Api-Key'] = apiKey;
        break;

      case 'bearer':
        headers['Authorization'] = `Bearer ${apiKey}`;
        break;

      case 'basic_auth': {
        const username = this.config.basicAuthPosition === 'username'
          ? apiKey
          : this.config.basicAuthOther || '';
        const password = this.config.basicAuthPosition === 'password'
          ? apiKey
          : this.config.basicAuthOther || '';
        const encoded = Buffer.from(`${username}:${password}`).toString('base64');
        headers['Authorization'] = `Basic ${encoded}`;
        break;
      }

      case 'query':
        // Query params are handled separately in getAuthQueryParams
        break;
    }

    return headers;
  }

  /**
   * Get query parameters for API request (if using query placement)
   */
  getAuthQueryParams(): Record<string, string> {
    if (this.config.placement !== 'query') {
      return {};
    }

    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error(`API key not found in environment variable: ${this.config.envVar}`);
    }

    return {
      [this.config.queryParam || 'api_key']: apiKey,
    };
  }

  /**
   * Check rate limit (if configured)
   */
  checkRateLimit(clientId: string = 'default'): { allowed: boolean; retryAfter?: number } {
    if (!this.config.rateLimitPerMinute) {
      return { allowed: true };
    }

    const now = Date.now();
    const entry = this.rateLimitCounter.get(clientId);

    if (!entry || now > entry.resetAt) {
      // New window
      this.rateLimitCounter.set(clientId, {
        count: 1,
        resetAt: now + 60000, // 1 minute window
      });
      return { allowed: true };
    }

    if (entry.count >= this.config.rateLimitPerMinute) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      return { allowed: false, retryAfter };
    }

    entry.count++;
    return { allowed: true };
  }

  /**
   * Validate IP against allowlist (if configured)
   */
  validateIp(ip: string): boolean {
    if (!this.config.allowedIps || this.config.allowedIps.length === 0) {
      return true;
    }
    return this.config.allowedIps.includes(ip);
  }
}

/**
 * Detect API key pattern from tool name
 */
export function detectApiKeyPattern(toolName: string): Partial<ApiKeyConfig> | undefined {
  const normalized = toolName.toLowerCase();

  // Check for exact match
  if (COMMON_API_KEY_PATTERNS[normalized]) {
    return COMMON_API_KEY_PATTERNS[normalized];
  }

  // Check for partial match
  for (const [pattern, config] of Object.entries(COMMON_API_KEY_PATTERNS)) {
    if (normalized.includes(pattern) || pattern.includes(normalized)) {
      return config;
    }
  }

  // Default to X-Api-Key header pattern
  return {
    placement: 'header',
    headerName: 'X-Api-Key',
    envVar: `${toolName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`,
  };
}

/**
 * Generate API key auth code snippet for MCP server
 */
export function generateApiKeyAuthSnippet(config: ApiKeyConfig): string {
  return `
// API Key Authentication for MCP Server
// Generated by thesun

const API_KEY_CONFIG = {
  placement: '${config.placement}',
  ${config.headerName ? `headerName: '${config.headerName}',` : ''}
  ${config.queryParam ? `queryParam: '${config.queryParam}',` : ''}
  envVar: '${config.envVar}',
};

function getApiKey(): string {
  const key = process.env['${config.envVar}'];
  if (!key) {
    throw new Error('API key not configured. Set ${config.envVar} environment variable.');
  }
  return key;
}

function getAuthHeaders(): Record<string, string> {
  const apiKey = getApiKey();
  ${config.placement === 'header' ? `return { '${config.headerName || 'X-Api-Key'}': apiKey };` : ''}
  ${config.placement === 'bearer' ? `return { 'Authorization': \`Bearer \${apiKey}\` };` : ''}
  ${config.placement === 'basic_auth' ? `
  const encoded = Buffer.from(\`${config.basicAuthPosition === 'username' ? '${apiKey}:${config.basicAuthOther || ""}' : '${config.basicAuthOther || ""}:${apiKey}'}\`).toString('base64');
  return { 'Authorization': \`Basic \${encoded}\` };` : ''}
  ${config.placement === 'query' ? `return {}; // API key sent as query param` : ''}
}
`;
}

/**
 * Generate .env.example entry for API key
 */
export function generateApiKeyEnvExample(config: ApiKeyConfig, toolName: string): string {
  return `
# ${toolName} API Key Authentication
# Get your API key from the ${toolName} admin console
${config.envVar}=your-api-key-here

# Security notes:
# - NEVER commit this file with real values
# - Rotate keys regularly if supported
# - Use least-privilege keys when possible
`;
}
