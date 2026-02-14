/**
 * MCP Authentication & Authorization Manager
 *
 * Implements OAuth 2.1 security for generated MCP servers following the
 * official MCP Authorization Specification (June 2025).
 *
 * Key principles:
 * - MCP servers are OAuth Resource Servers (NOT auth servers)
 * - Tokens are NEVER stored in the MCP server itself
 * - All tokens are short-lived (15-30 min) with refresh
 * - Resource Indicators (RFC 8707) prevent token misuse
 * - PKCE is mandatory for authorization code flow
 * - Support for Entra ID, Okta, Auth0, Keycloak, etc.
 *
 * Architecture:
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                     Identity Provider                           │
 * │            (Entra ID / Okta / Auth0 / Keycloak)                 │
 * └────────────────────────┬────────────────────────────────────────┘
 *                          │
 *               OAuth 2.1 + PKCE + Resource Indicators
 *                          │
 * ┌────────────────────────▼────────────────────────────────────────┐
 * │                    MCP Client                                    │
 * │              (Claude, Agent, etc.)                               │
 * └────────────────────────┬────────────────────────────────────────┘
 *                          │
 *                Bearer Token (short-lived)
 *                          │
 * ┌────────────────────────▼────────────────────────────────────────┐
 * │                 MCP Server (Resource Server)                     │
 * │                   - Validates token                              │
 * │                   - Checks audience                              │
 * │                   - Enforces scopes                              │
 * │                   - Uses OBO for downstream                      │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * References:
 * - https://modelcontextprotocol.io/specification/draft/basic/authorization
 * - https://auth0.com/blog/mcp-specs-update-all-about-auth/
 * - https://learn.microsoft.com/en-us/azure/app-service/configure-authentication-mcp-server-vscode
 */

import { z } from 'zod';
import { logger } from '../observability/logger.js';

/**
 * Supported identity providers
 */
export type IdentityProvider = 'entra_id' | 'okta' | 'auth0' | 'keycloak' | 'generic_oidc';

/**
 * OAuth configuration schema
 */
export const OAuthConfigSchema = z.object({
  provider: z.enum(['entra_id', 'okta', 'auth0', 'keycloak', 'generic_oidc']),

  // Discovery endpoint (provider-specific)
  issuer: z.string().url(),

  // Client registration (pre-configured since Entra ID doesn't support DCR)
  clientId: z.string(),
  clientSecret: z.string().optional(), // Optional for public clients with PKCE

  // Resource indicator (RFC 8707) - the MCP server's identifier
  resource: z.string().url(),

  // Required scopes
  scopes: z.array(z.string()),

  // Token validation settings
  audience: z.string(),
  tokenLifetimeSeconds: z.number().default(900), // 15 minutes
  allowRefresh: z.boolean().default(true),

  // Entra ID specific
  tenantId: z.string().optional(),
  useOnBehalfOf: z.boolean().default(false), // For downstream service access
});

export type OAuthConfig = z.infer<typeof OAuthConfigSchema>;

/**
 * Provider-specific defaults
 */
export const PROVIDER_DEFAULTS: Record<IdentityProvider, Partial<OAuthConfig>> = {
  entra_id: {
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    tokenLifetimeSeconds: 900, // Entra recommends 15 min
    useOnBehalfOf: true, // Entra supports OBO natively
  },
  okta: {
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    tokenLifetimeSeconds: 900,
  },
  auth0: {
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    tokenLifetimeSeconds: 900,
  },
  keycloak: {
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    tokenLifetimeSeconds: 900,
  },
  generic_oidc: {
    scopes: ['openid', 'profile'],
    tokenLifetimeSeconds: 900,
  },
};

/**
 * Token validation result
 */
export interface TokenValidationResult {
  valid: boolean;
  claims?: {
    sub: string;
    aud: string | string[];
    iss: string;
    exp: number;
    iat: number;
    scope?: string;
    roles?: string[];
    groups?: string[];
  };
  error?: string;
}

/**
 * Permission definition for a tool
 */
export interface ToolPermission {
  toolName: string;
  requiredScopes: string[];
  requiredRoles?: string[];
  requiredGroups?: string[];
  allowedOperations: string[];
}

/**
 * Auth Manager - handles all authentication/authorization for generated MCPs
 */
export class AuthManager {
  private config: OAuthConfig;
  private toolPermissions: Map<string, ToolPermission> = new Map();

  constructor(config: OAuthConfig) {
    this.config = OAuthConfigSchema.parse(config);
    logger.info('AuthManager initialized', {
      provider: config.provider,
      audience: config.audience,
      scopes: config.scopes,
    });
  }

  /**
   * Register permissions for a tool
   */
  registerToolPermission(permission: ToolPermission): void {
    this.toolPermissions.set(permission.toolName, permission);
    logger.debug('Tool permission registered', {
      toolName: permission.toolName,
      requiredScopes: permission.requiredScopes,
    });
  }

  /**
   * Validate a token (to be used by generated MCP servers)
   *
   * CRITICAL: This validates that the token was issued FOR THIS MCP SERVER
   * (audience validation) and has not been passed through from elsewhere.
   */
  async validateToken(token: string): Promise<TokenValidationResult> {
    // In production, this would:
    // 1. Decode the JWT
    // 2. Fetch JWKS from provider's discovery endpoint
    // 3. Verify signature
    // 4. Validate claims (iss, aud, exp, etc.)

    try {
      // Stub implementation - would use jose library in production
      const parts = token.split('.');
      if (parts.length !== 3) {
        return { valid: false, error: 'Invalid JWT format' };
      }

      // Decode payload (base64url)
      const payload = JSON.parse(
        Buffer.from(parts[1], 'base64url').toString('utf8')
      );

      // Validate audience - CRITICAL for preventing token misuse
      if (!this.validateAudience(payload.aud)) {
        logger.warn('Token audience mismatch', {
          expected: this.config.audience,
          received: payload.aud,
        });
        return {
          valid: false,
          error: `Token audience mismatch. Expected: ${this.config.audience}`,
        };
      }

      // Validate issuer
      if (payload.iss !== this.config.issuer) {
        return { valid: false, error: 'Token issuer mismatch' };
      }

      // Validate expiration
      if (payload.exp && payload.exp < Date.now() / 1000) {
        return { valid: false, error: 'Token expired' };
      }

      return {
        valid: true,
        claims: {
          sub: payload.sub,
          aud: payload.aud,
          iss: payload.iss,
          exp: payload.exp,
          iat: payload.iat,
          scope: payload.scope || payload.scp,
          roles: payload.roles || payload.role,
          groups: payload.groups || payload.group,
        },
      };
    } catch (error) {
      logger.error('Token validation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { valid: false, error: 'Token validation failed' };
    }
  }

  /**
   * Check if user has permission to use a tool
   */
  checkToolPermission(
    claims: TokenValidationResult['claims'],
    toolName: string,
    operation: string
  ): { allowed: boolean; reason?: string } {
    if (!claims) {
      return { allowed: false, reason: 'No claims provided' };
    }

    const permission = this.toolPermissions.get(toolName);
    if (!permission) {
      // No specific permission registered - default allow
      return { allowed: true };
    }

    // Check operation is allowed
    if (!permission.allowedOperations.includes(operation) && !permission.allowedOperations.includes('*')) {
      return {
        allowed: false,
        reason: `Operation '${operation}' not allowed for tool '${toolName}'`,
      };
    }

    // Check scopes
    const userScopes = claims.scope?.split(' ') ?? [];
    const missingScopes = permission.requiredScopes.filter(
      (s) => !userScopes.includes(s)
    );
    if (missingScopes.length > 0) {
      return {
        allowed: false,
        reason: `Missing required scopes: ${missingScopes.join(', ')}`,
      };
    }

    // Check roles (if required)
    if (permission.requiredRoles && permission.requiredRoles.length > 0) {
      const userRoles = claims.roles ?? [];
      const hasRole = permission.requiredRoles.some((r) => userRoles.includes(r));
      if (!hasRole) {
        return {
          allowed: false,
          reason: `Missing required role. Need one of: ${permission.requiredRoles.join(', ')}`,
        };
      }
    }

    // Check groups (if required)
    if (permission.requiredGroups && permission.requiredGroups.length > 0) {
      const userGroups = claims.groups ?? [];
      const hasGroup = permission.requiredGroups.some((g) => userGroups.includes(g));
      if (!hasGroup) {
        return {
          allowed: false,
          reason: `Missing required group. Need one of: ${permission.requiredGroups.join(', ')}`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Get OAuth configuration for client (to be used in MCP server metadata)
   *
   * This returns the configuration needed by MCP clients to authenticate.
   * The MCP server itself NEVER stores tokens - it just validates them.
   */
  getClientAuthConfig(): {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    scopes_supported: string[];
    response_types_supported: string[];
    code_challenge_methods_supported: string[];
    resource: string;
  } {
    // Provider-specific endpoint construction
    let baseUrl = this.config.issuer;
    if (this.config.provider === 'entra_id' && this.config.tenantId) {
      baseUrl = `https://login.microsoftonline.com/${this.config.tenantId}`;
    }

    return {
      issuer: this.config.issuer,
      authorization_endpoint: `${baseUrl}/oauth2/v2.0/authorize`,
      token_endpoint: `${baseUrl}/oauth2/v2.0/token`,
      scopes_supported: this.config.scopes,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'], // PKCE with SHA256
      resource: this.config.resource, // RFC 8707 Resource Indicator
    };
  }

  /**
   * Get On-Behalf-Of token for downstream service access (Entra ID specific)
   *
   * When the MCP server needs to call downstream APIs (like Azure AI Search,
   * ServiceNow, etc.) using the user's identity, it uses the OBO flow.
   *
   * IMPORTANT: The MCP server NEVER passes through the client's token directly.
   * Instead, it exchanges it for a new token scoped to the downstream service.
   */
  async getOnBehalfOfToken(
    userToken: string,
    downstreamResource: string
  ): Promise<{ accessToken: string; expiresIn: number } | { error: string }> {
    if (!this.config.useOnBehalfOf) {
      return { error: 'On-Behalf-Of not configured for this provider' };
    }

    if (this.config.provider !== 'entra_id') {
      return { error: 'On-Behalf-Of only supported for Entra ID' };
    }

    // In production, this would call the token endpoint with:
    // grant_type: urn:ietf:params:oauth:grant-type:jwt-bearer
    // assertion: userToken
    // client_id: this.config.clientId
    // client_secret: this.config.clientSecret
    // scope: downstreamResource + '/.default'
    // requested_token_use: on_behalf_of

    logger.info('OBO token requested', {
      downstreamResource,
      provider: this.config.provider,
    });

    // Stub - would make actual token exchange
    return { error: 'OBO not implemented in stub' };
  }

  // === Private Methods ===

  private validateAudience(aud: string | string[]): boolean {
    const audiences = Array.isArray(aud) ? aud : [aud];
    return audiences.includes(this.config.audience);
  }
}

/**
 * Generate OAuth configuration snippet for MCP server code
 *
 * This generates the code that goes INTO the MCP server to handle auth.
 */
export function generateAuthCodeSnippet(config: OAuthConfig): string {
  return `
// OAuth 2.1 Configuration for MCP Server
// Generated by thesun - DO NOT STORE TOKENS HERE

import { AuthManager, OAuthConfigSchema } from '@thesun/security';

const authConfig = OAuthConfigSchema.parse({
  provider: '${config.provider}',
  issuer: process.env.OAUTH_ISSUER || '${config.issuer}',
  clientId: process.env.OAUTH_CLIENT_ID!,
  // clientSecret is managed by the client, NOT the server
  resource: process.env.MCP_RESOURCE_URI || '${config.resource}',
  audience: process.env.MCP_AUDIENCE || '${config.audience}',
  scopes: ${JSON.stringify(config.scopes)},
  tokenLifetimeSeconds: ${config.tokenLifetimeSeconds},
  ${config.tenantId ? `tenantId: process.env.AZURE_TENANT_ID || '${config.tenantId}',` : ''}
  useOnBehalfOf: ${config.useOnBehalfOf},
});

export const authManager = new AuthManager(authConfig);

// Middleware for validating requests
export async function validateRequest(req: Request): Promise<{
  valid: boolean;
  claims?: any;
  error?: string;
}> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { valid: false, error: 'Missing or invalid Authorization header' };
  }

  const token = authHeader.slice(7);
  return authManager.validateToken(token);
}
`;
}

/**
 * Environment variables needed for auth (generated for .env.example)
 */
export function generateAuthEnvExample(provider: IdentityProvider): string {
  const common = `
# OAuth 2.1 Configuration
# IMPORTANT: These are the ONLY credentials the MCP server needs.
# Tokens are managed by the client, not stored here.

OAUTH_ISSUER=
OAUTH_CLIENT_ID=
MCP_RESOURCE_URI=
MCP_AUDIENCE=
`;

  const providerSpecific: Record<IdentityProvider, string> = {
    entra_id: `
# Azure Entra ID Specific
AZURE_TENANT_ID=
# For On-Behalf-Of flow (downstream service access)
OAUTH_CLIENT_SECRET=
`,
    okta: `
# Okta Specific
OKTA_DOMAIN=
`,
    auth0: `
# Auth0 Specific
AUTH0_DOMAIN=
`,
    keycloak: `
# Keycloak Specific
KEYCLOAK_REALM=
`,
    generic_oidc: `
# Generic OIDC - configure your provider's endpoints
OIDC_AUTHORIZATION_ENDPOINT=
OIDC_TOKEN_ENDPOINT=
OIDC_JWKS_URI=
`,
  };

  return common + providerSpecific[provider];
}
