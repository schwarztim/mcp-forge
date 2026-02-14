/**
 * Security Module
 *
 * Provides comprehensive security for generated MCP servers:
 * - OAuth 2.1 authentication with PKCE (when available)
 * - API Key authentication (common reality for many APIs)
 * - Multi-provider support (Entra ID, Okta, Auth0, Keycloak)
 * - Token validation (audience, resource indicators)
 * - Security hardening (injection prevention, scope minimization)
 *
 * References:
 * - https://modelcontextprotocol.io/specification/draft/basic/authorization
 * - https://modelcontextprotocol.io/specification/draft/basic/security_best_practices
 * - https://mcp-security.com
 */

// OAuth 2.1 Authentication (recommended when available)
export {
  AuthManager,
  OAuthConfigSchema,
  PROVIDER_DEFAULTS,
  generateAuthCodeSnippet,
  generateAuthEnvExample,
  type OAuthConfig,
  type IdentityProvider,
  type TokenValidationResult,
  type ToolPermission,
} from "./auth-manager.js";

// API Key Authentication (common reality)
export {
  ApiKeyAuth,
  ApiKeyConfigSchema,
  COMMON_API_KEY_PATTERNS,
  detectApiKeyPattern,
  generateApiKeyAuthSnippet,
  generateApiKeyEnvExample,
  type ApiKeyConfig,
  type ApiKeyPlacement,
} from "./api-key-auth.js";

// HAR-based Authentication (for webapps without APIs)
export {
  HARAuthManager,
  HARAuthConfigSchema,
  generateHARAuthCodeSnippet,
  generateHARAuthEnvDocs,
  type HARAuthConfig,
  type ExtractedAuth,
} from "./har-auth.js";

// Unified Authentication Generator (supports all methods with fallback)
export {
  generateUnifiedAuthCode,
  generateUnifiedEnvExample,
  generateUnifiedAuthReadme,
  type AuthMethod,
  type UnifiedAuthConfig,
} from "./unified-auth-generator.js";

// Security Hardening (applies to all auth methods)
export {
  SecurityHardening,
  SecurityConfigSchema,
  SecurityError,
  generateSecurityMiddleware,
  generateSecurityChecklist,
  type SecurityConfig,
} from "./hardening.js";

// Azure AD SSO Authentication (for enterprise Microsoft/Entra ID)
export {
  AZURE_AD_SSO_AUTH,
  AzureAdSsoConfigSchema,
  generateAzureAdAutomatorModule,
  generateLoggerModule,
  generateExecFileNoThrowModule,
  generateCredentialStoreModule,
  generateConfigManagerModule,
  generateRobustAuthModule,
  generateSetupWizardModule,
  generateHealthCheckModule,
  generatePackageJsonAdditions,
  generateAzureAdSsoReadme,
  generateAllAzureAdSsoFiles,
  type AzureAdSsoConfig,
  type GeneratedAuthFiles,
} from "./azure-ad-sso-auth.js";

// Global SSO Credential Store (shared credentials across MCPs)
export {
  GlobalSsoStore,
  getGlobalSsoStore,
  hasGlobalSsoCredentials,
  getGlobalSsoCredentials,
} from "./global-sso-store.js";
