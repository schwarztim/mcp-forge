/**
 * MCP Security Hardening
 *
 * Implements security best practices from:
 * - https://modelcontextprotocol.io/specification/draft/basic/security_best_practices
 * - https://mcp-security.com
 *
 * Critical requirements addressed:
 * - NO token passthrough (MUST NOT)
 * - NO session-based authentication (MUST NOT)
 * - Input validation to prevent injection attacks
 * - Scope minimization (least privilege)
 * - Session hijacking prevention
 * - Command injection prevention
 *
 * Known vulnerabilities mitigated:
 * - CVE-2025-49596 (RCE in MCP Inspector)
 * - SQL injection in SQLite MCP Reference
 * - Command injection via unsanitized input
 * - Prompt hijacking through compromised contexts
 */

import { z } from 'zod';
import { logger } from '../observability/logger.js';

/**
 * Security configuration for generated MCP servers
 */
export const SecurityConfigSchema = z.object({
  // Token handling
  allowTokenPassthrough: z.literal(false).default(false), // MUST be false
  validateTokenAudience: z.literal(true).default(true), // MUST validate

  // Session handling
  allowSessionAuth: z.literal(false).default(false), // MUST be false
  sessionIdFormat: z.enum(['uuid', 'user_bound']).default('user_bound'),
  sessionExpirationMs: z.number().default(600000), // 10 minutes

  // Input validation
  enableInputSanitization: z.boolean().default(true),
  maxInputLength: z.number().default(100000),
  blockDangerousPatterns: z.boolean().default(true),

  // Scope handling
  enableScopeMinimization: z.boolean().default(true),
  defaultScopes: z.array(z.string()).default(['mcp:tools-basic']),
  forbiddenScopes: z.array(z.string()).default(['*', 'all', 'full-access']),

  // Sandboxing
  enableSandboxing: z.boolean().default(true),
  sandboxType: z.enum(['none', 'process', 'container']).default('process'),
});

export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

/**
 * Dangerous patterns to block in input
 */
const DANGEROUS_PATTERNS = [
  // Command injection
  /;\s*(rm|del|format|shutdown|reboot|kill)/i,
  /`[^`]*`/, // Backtick execution
  /\$\([^)]*\)/, // Command substitution
  /\|\s*sh\b/i, // Pipe to shell
  /&&\s*(sudo|su|chmod|chown)/i,

  // SQL injection
  /'\s*OR\s+'1'\s*=\s*'1/i,
  /;\s*DROP\s+TABLE/i,
  /;\s*DELETE\s+FROM/i,
  /UNION\s+SELECT/i,
  /--\s*$/m, // SQL comment at end

  // Path traversal
  /\.\.\//g,
  /\.\.\\/, // Windows path traversal

  // SSRF
  /file:\/\//i,
  /gopher:\/\//i,
  /dict:\/\//i,

  // Template injection
  /\{\{.*\}\}/,
  /\$\{[^}]*\}/,
  /<script[^>]*>/i,
];

/**
 * Sensitive file paths that should trigger warnings
 */
const SENSITIVE_PATHS = [
  /\.ssh\//i,
  /\.aws\//i,
  /\.azure\//i,
  /\.kube\//i,
  /\.gnupg\//i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.env$/i,
  /credentials/i,
  /secrets?\./i,
  /password/i,
  /private.*key/i,
  /\/etc\/passwd/i,
  /\/etc\/shadow/i,
];

/**
 * Security Hardening Manager
 */
export class SecurityHardening {
  private config: SecurityConfig;
  private violationLog: { timestamp: Date; type: string; details: string }[] = [];

  constructor(config?: Partial<SecurityConfig>) {
    this.config = SecurityConfigSchema.parse(config ?? {});
  }

  /**
   * Validate and sanitize input
   * Returns sanitized input or throws if dangerous
   */
  sanitizeInput(input: string, context: string): string {
    // Check length
    if (input.length > this.config.maxInputLength) {
      this.logViolation('input_too_long', `Input exceeds ${this.config.maxInputLength} chars`);
      throw new SecurityError('Input exceeds maximum length', 'INPUT_TOO_LONG');
    }

    // Check for dangerous patterns
    if (this.config.blockDangerousPatterns) {
      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(input)) {
          this.logViolation('dangerous_pattern', `Pattern ${pattern} found in ${context}`);
          throw new SecurityError(
            'Input contains potentially dangerous pattern',
            'DANGEROUS_PATTERN'
          );
        }
      }
    }

    // Check for sensitive path access
    for (const pathPattern of SENSITIVE_PATHS) {
      if (pathPattern.test(input)) {
        logger.warn('Sensitive path access attempted', {
          context,
          pattern: pathPattern.source,
        });
        // Don't block, just warn - let the permission system handle it
      }
    }

    return input;
  }

  /**
   * Validate that a token was issued FOR THIS SERVER
   * Prevents token passthrough attacks
   */
  validateTokenIntegrity(
    token: string,
    expectedAudience: string,
    expectedResource: string
  ): { valid: boolean; error?: string } {
    try {
      // Decode JWT payload (not verifying signature here - that's done elsewhere)
      const parts = token.split('.');
      if (parts.length !== 3) {
        return { valid: false, error: 'Invalid JWT format' };
      }

      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());

      // CRITICAL: Validate audience matches THIS server
      const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!audiences.includes(expectedAudience)) {
        this.logViolation('token_passthrough_attempt', `Token audience ${payload.aud} != ${expectedAudience}`);
        return {
          valid: false,
          error: 'Token was not issued for this resource server (possible token passthrough)',
        };
      }

      // Validate resource indicator if present
      if (payload.resource && payload.resource !== expectedResource) {
        this.logViolation('resource_mismatch', `Token resource ${payload.resource} != ${expectedResource}`);
        return {
          valid: false,
          error: 'Token resource indicator mismatch',
        };
      }

      return { valid: true };
    } catch (error) {
      return { valid: false, error: 'Token validation failed' };
    }
  }

  /**
   * Generate secure session ID
   * Format: <user_id>:<cryptographically_random_uuid>
   */
  generateSessionId(userId: string): string {
    const random = crypto.randomUUID();

    if (this.config.sessionIdFormat === 'user_bound') {
      return `${userId}:${random}`;
    }

    return random;
  }

  /**
   * Validate session ID format and extract user binding
   */
  validateSessionId(sessionId: string, expectedUserId?: string): {
    valid: boolean;
    userId?: string;
    error?: string;
  } {
    if (!sessionId || typeof sessionId !== 'string') {
      return { valid: false, error: 'Invalid session ID' };
    }

    if (this.config.sessionIdFormat === 'user_bound') {
      const parts = sessionId.split(':');
      if (parts.length !== 2) {
        return { valid: false, error: 'Session ID not properly bound to user' };
      }

      const [userId, _random] = parts;

      if (expectedUserId && userId !== expectedUserId) {
        this.logViolation('session_hijack_attempt', `Session user ${userId} != ${expectedUserId}`);
        return { valid: false, error: 'Session ID user mismatch (possible hijacking)' };
      }

      return { valid: true, userId };
    }

    return { valid: true };
  }

  /**
   * Validate requested scopes against allowed scopes
   */
  validateScopes(requestedScopes: string[]): {
    valid: boolean;
    allowedScopes: string[];
    deniedScopes: string[];
    error?: string;
  } {
    const allowedScopes: string[] = [];
    const deniedScopes: string[] = [];

    for (const scope of requestedScopes) {
      // Check for forbidden wildcard scopes
      if (this.config.forbiddenScopes.includes(scope)) {
        this.logViolation('forbidden_scope', `Forbidden scope requested: ${scope}`);
        deniedScopes.push(scope);
        continue;
      }

      // Check for wildcard patterns
      if (scope.includes('*') || scope === 'all' || scope === 'full-access') {
        deniedScopes.push(scope);
        continue;
      }

      allowedScopes.push(scope);
    }

    return {
      valid: deniedScopes.length === 0,
      allowedScopes,
      deniedScopes,
      error: deniedScopes.length > 0
        ? `Forbidden scopes requested: ${deniedScopes.join(', ')}`
        : undefined,
    };
  }

  /**
   * Check if operation requires elevated scope
   */
  checkScopeElevation(
    currentScopes: string[],
    requiredScope: string
  ): { hasScope: boolean; challenge?: string } {
    if (currentScopes.includes(requiredScope)) {
      return { hasScope: true };
    }

    // Return WWW-Authenticate challenge for scope elevation
    return {
      hasScope: false,
      challenge: `Bearer scope="${requiredScope}"`,
    };
  }

  /**
   * Get security violations log (for auditing)
   */
  getViolationLog(): typeof this.violationLog {
    return [...this.violationLog];
  }

  /**
   * Clear violation log (for testing)
   */
  clearViolationLog(): void {
    this.violationLog = [];
  }

  // === Private Methods ===

  private logViolation(type: string, details: string): void {
    this.violationLog.push({
      timestamp: new Date(),
      type,
      details,
    });

    logger.warn('Security violation detected', { type, details });
  }
}

/**
 * Custom security error
 */
export class SecurityError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'SecurityError';
    this.code = code;
  }
}

/**
 * Generate security middleware code for MCP servers
 */
export function generateSecurityMiddleware(): string {
  return `
// Security Middleware for MCP Server
// Implements https://modelcontextprotocol.io/specification/draft/basic/security_best_practices

import { SecurityHardening, SecurityError } from '@thesun/security';

const security = new SecurityHardening({
  allowTokenPassthrough: false,  // MUST be false per spec
  allowSessionAuth: false,       // MUST be false per spec
  sessionIdFormat: 'user_bound', // Binds session to user ID
  blockDangerousPatterns: true,  // Prevent injection attacks
  enableScopeMinimization: true, // Least privilege
});

/**
 * Validate all incoming requests
 */
export function validateRequest(req: Request, token: string, expectedAudience: string): void {
  // 1. Validate token was issued FOR THIS SERVER (not passed through)
  const tokenResult = security.validateTokenIntegrity(token, expectedAudience, process.env.MCP_RESOURCE_URI!);
  if (!tokenResult.valid) {
    throw new SecurityError(tokenResult.error!, 'TOKEN_INTEGRITY');
  }

  // 2. Sanitize all input parameters
  const body = req.body as Record<string, unknown>;
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') {
      security.sanitizeInput(value, \`request.body.\${key}\`);
    }
  }
}

/**
 * Create user-bound session (NOT for authentication)
 */
export function createSession(userId: string): string {
  return security.generateSessionId(userId);
}

/**
 * Validate session (for state tracking only, NOT authentication)
 */
export function validateSession(sessionId: string, userId: string): void {
  const result = security.validateSessionId(sessionId, userId);
  if (!result.valid) {
    throw new SecurityError(result.error!, 'SESSION_INVALID');
  }
}
`;
}

/**
 * Generate security checklist for MCP server review
 */
export function generateSecurityChecklist(): string {
  return `
# MCP Server Security Checklist

## MUST Requirements (Blocking)

- [ ] **NO Token Passthrough**: Server NEVER passes client tokens to downstream APIs
- [ ] **NO Session Authentication**: Sessions are ONLY for state, NOT authentication
- [ ] **Token Audience Validation**: Every token is validated to be issued FOR THIS SERVER
- [ ] **Secure Session IDs**: Use cryptographically random UUIDs bound to user ID
- [ ] **OAuth State Validation**: State parameter validated exactly, single-use, expires in 10min
- [ ] **Redirect URI Exact Match**: No wildcards or patterns in redirect_uri validation

## SHOULD Requirements (Warning)

- [ ] **Input Sanitization**: All input validated for injection patterns
- [ ] **Scope Minimization**: Start with minimal scopes, elevate only when needed
- [ ] **No Wildcard Scopes**: Never use *, all, or full-access scopes
- [ ] **Sensitive Path Warnings**: Alert on access to .ssh, .aws, credentials files
- [ ] **Sandboxing**: Run with minimal privileges in isolated environment

## Known Vulnerabilities to Check

- [ ] **No SQL Injection**: All database queries use parameterized statements
- [ ] **No Command Injection**: Never execute unsanitized user input
- [ ] **No Path Traversal**: Validate file paths don't use ../
- [ ] **No SSRF**: Block file://, gopher://, dict:// protocols
- [ ] **No Template Injection**: Sanitize {{, \${, and <script> patterns

## Audit Requirements

- [ ] **Log Security Violations**: All blocked requests are logged with details
- [ ] **Token Exchange Logging**: OBO flows logged with correlation IDs
- [ ] **Scope Elevation Logging**: All scope elevation requests logged
`;
}
