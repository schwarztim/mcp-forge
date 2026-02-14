/**
 * Unified Authentication Code Generator
 *
 * Generates authentication code for MCPs that supports multiple methods with graceful fallback:
 * 1. API Key/OAuth (if available)
 * 2. HAR file extraction (if HAR provided)
 * 3. Interactive Playwright login (if enabled)
 *
 * This ensures generated MCPs work even when official APIs aren't available.
 */

import { generateApiKeyAuthSnippet } from "./api-key-auth.js";
import { generateAuthCodeSnippet } from "./auth-manager.js";
import {
  generateHARAuthCodeSnippet,
  generateHARAuthEnvDocs,
} from "./har-auth.js";
import {
  generateRobustAuthModule,
  generateSetupWizardModule,
  generateAzureAdSsoReadme,
  type AzureAdSsoConfig,
} from "./azure-ad-sso-auth.js";
import type { OAuthConfig } from "./auth-manager.js";
import type { ApiKeyConfig } from "./api-key-auth.js";

export type AuthMethod =
  | "oauth"
  | "api_key"
  | "bearer"
  | "basic"
  | "har"
  | "azure_ad_sso"
  | "auto";

export interface UnifiedAuthConfig {
  toolName: string;
  primaryMethod?: AuthMethod;
  enableHARFallback?: boolean;
  oauthConfig?: OAuthConfig;
  apiKeyConfig?: ApiKeyConfig;
  azureAdSsoConfig?: AzureAdSsoConfig;
}

/**
 * Generate unified auth code that supports multiple authentication methods
 */
export function generateUnifiedAuthCode(config: UnifiedAuthConfig): string {
  const { toolName, primaryMethod = "auto", enableHARFallback = true } = config;
  const envPrefix = toolName.toUpperCase().replace(/-/g, "_");

  // Always include HAR auth as fallback
  const harAuthCode = generateHARAuthCodeSnippet(toolName);

  // Azure AD SSO authentication (enterprise Microsoft/Entra ID)
  if (primaryMethod === "azure_ad_sso" && config.azureAdSsoConfig) {
    return generateRobustAuthModule(config.azureAdSsoConfig);
  }

  if (primaryMethod === "har" || primaryMethod === "auto") {
    // HAR-first authentication (for webapps without APIs)
    return `
${harAuthCode}

/**
 * Unified authentication getter with fallback support
 *
 * Tries in order:
 * 1. API key (if ${envPrefix}_API_KEY set)
 * 2. HAR file extraction (if ${envPrefix}_HAR_FILE_PATH set)
 * 3. Interactive login (if ${envPrefix}_LOGIN_URL set and allowed)
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};

  // Try API key first (fastest)
  const apiKey = process.env.${envPrefix}_API_KEY;
  if (apiKey) {
    console.log('[Auth] Using API key');
    headers['Authorization'] = \`Bearer \${apiKey}\`;
    return headers;
  }

  // Fall back to HAR-based auth
  try {
    console.log('[Auth] Trying HAR-based authentication');
    const harAuth = await harAuthManager.getAuth();

    if (harAuth.type === 'bearer' && harAuth.token) {
      headers['Authorization'] = \`Bearer \${harAuth.token}\`;
    } else if (harAuth.type === 'api_key' && harAuth.token) {
      headers['Authorization'] = harAuth.token;
    } else if (harAuth.type === 'cookie' && harAuth.cookies) {
      headers['Cookie'] = harAuth.cookies.map(c => \`\${c.name}=\${c.value}\`).join('; ');
    }

    console.log('[Auth] Successfully authenticated via HAR/login');
    return headers;
  } catch (error) {
    console.error('[Auth] All authentication methods failed:', error);
    throw new Error(
      'Authentication failed. Please provide one of: ' +
      '${envPrefix}_API_KEY, ${envPrefix}_HAR_FILE_PATH, or ${envPrefix}_LOGIN_URL'
    );
  }
}

/**
 * Initialize authentication on MCP startup
 * Pre-loads and validates credentials to fail fast
 */
export async function initializeAuth(): Promise<void> {
  console.log('[Auth] Initializing authentication for ${toolName}');

  try {
    const headers = await getAuthHeaders();
    console.log('[Auth] Authentication initialized successfully');
    console.log('[Auth] Available auth headers:', Object.keys(headers).join(', '));
  } catch (error) {
    console.error('[Auth] Failed to initialize authentication');
    console.error('[Auth] Error:', error instanceof Error ? error.message : String(error));
    console.error('');
    console.error('Authentication Setup Guide:');
    console.error('==========================');
    console.error('');
    console.error('Option 1: Use API Key (recommended if available)');
    console.error('  Set ${envPrefix}_API_KEY in your .env file');
    console.error('');
    console.error('Option 2: Use HAR File');
    console.error('  1. Open Firefox DevTools (F12)');
    console.error('  2. Go to Network tab');
    console.error('  3. Log into ${toolName}');
    console.error('  4. Right-click → "Save all as HAR with content"');
    console.error('  5. Save to ./auth/${toolName}.har');
    console.error('  6. Set ${envPrefix}_HAR_FILE_PATH=./auth/${toolName}.har');
    console.error('');
    console.error('Option 3: Interactive Login (Playwright)');
    console.error('  Set ${envPrefix}_LOGIN_URL and ${envPrefix}_ALLOW_INTERACTIVE_LOGIN=true');
    console.error('');
    throw error;
  }
}
`;
  }

  // For OAuth or API key with HAR fallback
  let primaryAuthCode = "";
  if (config.oauthConfig) {
    primaryAuthCode = generateAuthCodeSnippet(config.oauthConfig);
  } else if (config.apiKeyConfig) {
    primaryAuthCode = generateApiKeyAuthSnippet(config.apiKeyConfig);
  }

  return `
${primaryAuthCode}

${enableHARFallback ? harAuthCode : ""}

/**
 * Unified authentication with fallback to HAR
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};

  // Try primary auth method
  try {
    const primaryAuth = await getPrimaryAuth();
    if (primaryAuth) {
      return primaryAuth;
    }
  } catch (error) {
    console.warn('[Auth] Primary auth failed, trying HAR fallback:', error);
  }

${
  enableHARFallback
    ? `
  // Fall back to HAR-based auth
  try {
    const harAuth = await harAuthManager.getAuth();

    if (harAuth.type === 'bearer' && harAuth.token) {
      headers['Authorization'] = \`Bearer \${harAuth.token}\`;
    } else if (harAuth.type === 'cookie' && harAuth.cookies) {
      headers['Cookie'] = harAuth.cookies.map(c => \`\${c.name}=\${c.value}\`).join('; ');
    }

    return headers;
  } catch (harError) {
    console.error('[Auth] HAR auth also failed:', harError);
  }
`
    : ""
}

  throw new Error('All authentication methods failed');
}

async function getPrimaryAuth(): Promise<Record<string, string> | null> {
  // Primary auth logic here (OAuth, API key, etc.)
  const apiKey = process.env.${envPrefix}_API_KEY;
  if (apiKey) {
    return { 'Authorization': \`Bearer \${apiKey}\` };
  }
  return null;
}
`;
}

/**
 * Generate comprehensive .env.example with all auth methods
 */
export function generateUnifiedEnvExample(config: UnifiedAuthConfig): string {
  const { toolName, enableHARFallback = true, azureAdSsoConfig } = config;
  const envPrefix = toolName.toUpperCase().replace(/-/g, "_");

  // If Azure AD SSO is configured, use minimal env since setup wizard handles creds
  if (azureAdSsoConfig) {
    return `# ${toolName.toUpperCase()} MCP Configuration
# Generated: ${new Date().toISOString()}

# ===========================================
# INSTANCE CONFIGURATION
# ===========================================

# Your ${toolName} instance URL (e.g., https://your-company.${toolName}.com)
${envPrefix}_INSTANCE_URL=

# ===========================================
# AUTHENTICATION
# ===========================================
#
# This MCP uses Azure AD SSO authentication.
# Run 'npm run setup' to configure credentials.
#
# Credentials are stored securely in your system keychain.
# See README.md for details.
#

# Optional: Override default log level
LOG_LEVEL=info
`;
  }

  let envDoc = `# ${toolName.toUpperCase()} MCP Authentication Configuration
# Generated: ${new Date().toISOString()}

# ===========================================
# AUTHENTICATION OPTIONS (choose one)
# ===========================================

# --- Option 1: API Key (Recommended) ---
# Use if ${toolName} provides API keys
${envPrefix}_API_KEY=

# --- Option 2: OAuth 2.0 ---
# Use if ${toolName} supports OAuth
${envPrefix}_CLIENT_ID=
${envPrefix}_CLIENT_SECRET=
${envPrefix}_ACCESS_TOKEN=
${envPrefix}_REFRESH_TOKEN=

# --- Option 3: Bearer Token ---
# Use if you have a long-lived token
${envPrefix}_TOKEN=

# --- Option 4: Basic Auth ---
${envPrefix}_USERNAME=
${envPrefix}_PASSWORD=
`;

  if (enableHARFallback) {
    envDoc += `
# --- Option 5: HAR File Authentication ---
# Use when ${toolName} doesn't have an API
# or you need to authenticate via web login
${generateHARAuthEnvDocs(toolName)}
`;
  }

  envDoc += `
# ===========================================
# GENERAL SETTINGS
# ===========================================

${envPrefix}_BASE_URL=https://api.${toolName.toLowerCase()}.com
LOG_LEVEL=info
REQUEST_TIMEOUT=30000
MAX_RETRIES=3

# ===========================================
# HELP
# ===========================================
#
# Not sure which option to use?
#
# 1. Check ${toolName}'s documentation for API access
# 2. If they have an API → use Option 1 (API Key) or 2 (OAuth)
# 3. If no API → use Option 5 (HAR File)
#
# HAR File Setup:
# 1. Open Firefox, go to ${toolName}
# 2. Open DevTools (F12) → Network tab
# 3. Log in to ${toolName}
# 4. Right-click any request → "Save all as HAR with content"
# 5. Save to ./auth/${toolName}.har
# 6. Set ${envPrefix}_HAR_FILE_PATH=./auth/${toolName}.har
#
`;

  return envDoc;
}

/**
 * Generate README section explaining multi-auth setup
 */
export function generateUnifiedAuthReadme(config: UnifiedAuthConfig): string {
  const { toolName, enableHARFallback = true, azureAdSsoConfig } = config;
  const envPrefix = toolName.toUpperCase().replace(/-/g, "_");

  // If Azure AD SSO is configured, use the specialized readme
  if (azureAdSsoConfig) {
    return generateAzureAdSsoReadme(azureAdSsoConfig);
  }

  return `## Authentication

This MCP supports multiple authentication methods to maximize flexibility:

### Option 1: API Key (Recommended)

If ${toolName} provides API keys, this is the fastest and most reliable method:

\`\`\`bash
${envPrefix}_API_KEY=your-api-key-here
\`\`\`

### Option 2: OAuth 2.0

For OAuth-enabled services:

\`\`\`bash
${envPrefix}_CLIENT_ID=your-client-id
${envPrefix}_CLIENT_SECRET=your-client-secret
\`\`\`

${
  enableHARFallback
    ? `### Option 3: HAR File Authentication

For services without official APIs, or when you need to authenticate as a real user:

\`\`\`bash
${envPrefix}_HAR_FILE_PATH=./auth/${toolName}.har
\`\`\`

**Capturing a HAR file:**

1. Open Firefox and go to ${toolName}
2. Open DevTools (F12) and go to the **Network** tab
3. Log in to ${toolName} (complete any 2FA if required)
4. Right-click on any network request → **Save all as HAR with content**
5. Save the file to \`./auth/${toolName}.har\`
6. Set \`${envPrefix}_HAR_FILE_PATH=./auth/${toolName}.har\` in your \`.env\`

The MCP will extract authentication tokens/cookies from the HAR file automatically.

### Option 4: Interactive Login (Playwright)

Let the MCP log you in automatically using Playwright:

\`\`\`bash
${envPrefix}_LOGIN_URL=https://login.${toolName}.com
${envPrefix}_ALLOW_INTERACTIVE_LOGIN=true
\`\`\`

The MCP will:
1. Open a browser window
2. Navigate to the login URL
3. Wait for you to complete login
4. Extract and cache your credentials

`
    : ""
}

### Authentication Priority

The MCP tries authentication methods in this order:

1. **API Key** (if \`${envPrefix}_API_KEY\` is set)
2. **OAuth** (if \`${envPrefix}_CLIENT_ID\` is set)
${enableHARFallback ? `3. **HAR File** (if \`${envPrefix}_HAR_FILE_PATH\` is set)` : ""}
${enableHARFallback ? `4. **Interactive Login** (if \`${envPrefix}_LOGIN_URL\` is set and allowed)` : ""}

This ensures the MCP works even when official API access isn't available.

### Security Notes

- All credentials are stored in \`.env\` (never committed to git)
- HAR files contain sensitive tokens - keep them secure
- Extracted credentials are cached to avoid repeated logins
- Use environment-specific credentials (dev/staging/prod)
`;
}
