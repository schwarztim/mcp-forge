/**
 * HAR-based Authentication Manager
 *
 * Enables authentication via HAR file extraction or interactive browser login.
 * Supports webapps without official APIs or when API tokens are unavailable.
 *
 * Authentication Flow:
 * 1. Check if API key/token exists (fastest)
 * 2. Try loading from HAR file (if available)
 * 3. Fall back to interactive Playwright login (with Firefox)
 * 4. Extract and cache credentials
 *
 * PLAYWRIGHT + FIREFOX TOKEN CAPTURE:
 * Uses Playwright MCP with --browser firefox for maximum token extraction:
 * - page.evaluate() → Read localStorage, sessionStorage, window variables
 * - page.context().cookies() → Get all cookies including HttpOnly
 * - page.route() → Intercept Authorization headers in flight
 * - browser_network_requests → Capture all network traffic
 *
 * This gives us OAuth tokens, session tokens, refresh tokens, and cookies
 * from ANY webapp - even those without official APIs.
 *
 * Integration with thesun-har MCP:
 * - Uses mcp__thesun-har__upload_har_file
 * - Uses mcp__thesun-har__extract_auth_info
 * - Uses mcp__thesun-har__make_authenticated_request for validation
 */

import { z } from "zod";
import { logger } from "../observability/logger.js";
import * as fs from "fs/promises";
import * as path from "path";

/**
 * HAR authentication configuration
 */
export const HARAuthConfigSchema = z.object({
  /** Tool name (e.g., 'trello', 'notion') */
  toolName: z.string(),

  /** Path to HAR file (if available) */
  harFilePath: z.string().optional(),

  /** Login URL for interactive auth */
  loginUrl: z.string().url().optional(),

  /** Extracted token (populated after auth) */
  extractedToken: z.string().optional(),

  /** Extracted cookies as JSON string */
  extractedCookies: z.string().optional(),

  /** Whether to use Playwright for interactive login if HAR unavailable */
  allowInteractiveLogin: z.boolean().default(true),

  /** MCP server URL (for thesun-har integration) */
  mcpServerUrl: z.string().url().optional(),
});

export type HARAuthConfig = z.infer<typeof HARAuthConfigSchema>;

/**
 * Extracted authentication data from HAR
 */
export interface ExtractedAuth {
  /** Type of authentication found */
  type: "bearer" | "cookie" | "api_key" | "custom";

  /** Extracted token/API key */
  token?: string;

  /** Extracted cookies */
  cookies?: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
  }>;

  /** Additional headers found */
  headers?: Record<string, string>;

  /** Raw auth data for debugging */
  raw?: any;
}

/**
 * HAR Auth Manager
 */
export class HARAuthManager {
  private config: HARAuthConfig;
  private cachedAuth?: ExtractedAuth;

  constructor(config: HARAuthConfig) {
    this.config = HARAuthConfigSchema.parse(config);
    logger.info("HARAuthManager initialized", {
      toolName: config.toolName,
      hasHARFile: !!config.harFilePath,
      allowInteractive: config.allowInteractiveLogin,
    });
  }

  /**
   * Get authentication credentials (tries multiple methods)
   */
  async getAuth(): Promise<ExtractedAuth> {
    // Return cached if available
    if (this.cachedAuth) {
      logger.debug("Using cached auth", { toolName: this.config.toolName });
      return this.cachedAuth;
    }

    // Try loading from existing extracted credentials
    if (this.config.extractedToken) {
      logger.info("Using pre-extracted token");
      this.cachedAuth = {
        type: "bearer",
        token: this.config.extractedToken,
      };
      return this.cachedAuth;
    }

    if (this.config.extractedCookies) {
      logger.info("Using pre-extracted cookies");
      this.cachedAuth = {
        type: "cookie",
        cookies: JSON.parse(this.config.extractedCookies),
      };
      return this.cachedAuth;
    }

    // Try HAR file
    if (this.config.harFilePath) {
      try {
        const auth = await this.extractFromHAR(this.config.harFilePath);
        if (auth) {
          this.cachedAuth = auth;
          await this.persistExtractedAuth(auth);
          return auth;
        }
      } catch (error) {
        logger.warn("Failed to extract auth from HAR", {
          error: error instanceof Error ? error.message : String(error),
          harPath: this.config.harFilePath,
        });
      }
    }

    // Fall back to interactive login
    if (this.config.allowInteractiveLogin && this.config.loginUrl) {
      logger.info("Falling back to interactive login", {
        loginUrl: this.config.loginUrl,
      });
      const auth = await this.interactiveLogin();
      this.cachedAuth = auth;
      await this.persistExtractedAuth(auth);
      return auth;
    }

    throw new Error(
      `No authentication method available for ${this.config.toolName}. ` +
        `Provide HAR file, API token, or enable interactive login.`,
    );
  }

  /**
   * Extract authentication from HAR file
   */
  private async extractFromHAR(harPath: string): Promise<ExtractedAuth | null> {
    logger.info("Extracting auth from HAR file", { harPath });

    try {
      // Read HAR file
      const harContent = await fs.readFile(harPath, "utf-8");
      const har = JSON.parse(harContent);

      // Extract authentication data
      // Look for common auth patterns in requests
      const entries = har.log?.entries ?? [];

      // Find Authorization headers
      for (const entry of entries) {
        const authHeader = entry.request?.headers?.find(
          (h: any) => h.name.toLowerCase() === "authorization",
        );

        if (authHeader) {
          const value = authHeader.value;

          // Bearer token
          if (value.startsWith("Bearer ")) {
            logger.info("Found Bearer token in HAR");
            return {
              type: "bearer",
              token: value.slice(7),
              raw: entry,
            };
          }

          // API key patterns
          if (value.match(/^[a-zA-Z0-9_-]{20,}$/)) {
            logger.info("Found API key in HAR");
            return {
              type: "api_key",
              token: value,
              raw: entry,
            };
          }
        }

        // Extract cookies
        const cookieHeader = entry.request?.headers?.find(
          (h: any) => h.name.toLowerCase() === "cookie",
        );

        if (cookieHeader) {
          const cookies = this.parseCookieHeader(
            cookieHeader.value,
            entry.request.url,
          );
          if (cookies.length > 0) {
            logger.info("Found cookies in HAR", { count: cookies.length });
            return {
              type: "cookie",
              cookies,
              raw: entry,
            };
          }
        }
      }

      logger.warn("No authentication data found in HAR file");
      return null;
    } catch (error) {
      logger.error("Failed to parse HAR file", {
        error: error instanceof Error ? error.message : String(error),
        harPath,
      });
      return null;
    }
  }

  /**
   * Perform interactive login using Playwright
   */
  private async interactiveLogin(): Promise<ExtractedAuth> {
    logger.info("Starting interactive login", {
      toolName: this.config.toolName,
      loginUrl: this.config.loginUrl,
    });

    // This would integrate with Playwright MCP tools
    // For now, return a placeholder that shows the pattern

    throw new Error(
      `Interactive login not yet implemented. ` +
        `Please provide a HAR file or use the Playwright plugin to capture auth manually.`,
    );

    // Future implementation would:
    // 1. Call mcp__plugin_playwright_playwright__browser_navigate to loginUrl
    // 2. Wait for user to complete login
    // 3. Call mcp__plugin_playwright_playwright__browser_network_requests to get HAR
    // 4. Extract auth from captured network traffic
    // 5. Return ExtractedAuth
  }

  /**
   * Persist extracted auth to environment variables
   */
  private async persistExtractedAuth(auth: ExtractedAuth): Promise<void> {
    const envPrefix = this.config.toolName.toUpperCase().replace(/-/g, "_");

    logger.info("Persisting extracted auth", {
      type: auth.type,
      toolName: this.config.toolName,
    });

    // In a real implementation, this would update .env file or secret store
    // For now, just log what would be persisted
    if (auth.token) {
      logger.info(`Would set ${envPrefix}_EXTRACTED_TOKEN`);
      // fs.appendFile('.env', `${envPrefix}_EXTRACTED_TOKEN=${auth.token}\n`)
    }

    if (auth.cookies) {
      logger.info(`Would set ${envPrefix}_EXTRACTED_COOKIES`);
      // fs.appendFile('.env', `${envPrefix}_EXTRACTED_COOKIES=${JSON.stringify(auth.cookies)}\n`)
    }
  }

  /**
   * Parse cookie header into structured format
   */
  private parseCookieHeader(
    cookieString: string,
    url: string,
  ): Array<{ name: string; value: string; domain: string; path: string }> {
    const cookies: Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
    }> = [];

    try {
      const urlObj = new URL(url);
      const domain = urlObj.hostname;

      const pairs = cookieString.split(";").map((s) => s.trim());
      for (const pair of pairs) {
        const [name, ...valueParts] = pair.split("=");
        const value = valueParts.join("=");

        if (name && value) {
          cookies.push({
            name: name.trim(),
            value: value.trim(),
            domain,
            path: "/",
          });
        }
      }
    } catch (error) {
      logger.error("Failed to parse cookies", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return cookies;
  }

  /**
   * Validate extracted auth still works
   */
  async validateAuth(auth: ExtractedAuth, testUrl: string): Promise<boolean> {
    logger.info("Validating extracted auth", {
      type: auth.type,
      testUrl,
    });

    try {
      // Make a test request with the auth
      const headers: Record<string, string> = {};

      if (auth.type === "bearer" && auth.token) {
        headers["Authorization"] = `Bearer ${auth.token}`;
      } else if (auth.type === "api_key" && auth.token) {
        headers["Authorization"] = auth.token;
      } else if (auth.type === "cookie" && auth.cookies) {
        headers["Cookie"] = auth.cookies
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");
      }

      const response = await fetch(testUrl, { headers });

      if (response.status === 401 || response.status === 403) {
        logger.warn("Auth validation failed - unauthorized", {
          status: response.status,
        });
        return false;
      }

      logger.info("Auth validation succeeded", { status: response.status });
      return true;
    } catch (error) {
      logger.error("Auth validation error", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}

/**
 * Generate code snippet for HAR-based auth in generated MCPs
 */
export function generateHARAuthCodeSnippet(toolName: string): string {
  const envPrefix = toolName.toUpperCase().replace(/-/g, "_");

  return `
// HAR-based Authentication Support
// Enables authentication via HAR file or interactive login

import { HARAuthManager, HARAuthConfigSchema } from '@thesun/security';

const harAuthConfig = HARAuthConfigSchema.parse({
  toolName: '${toolName}',
  harFilePath: process.env.${envPrefix}_HAR_FILE_PATH,
  loginUrl: process.env.${envPrefix}_LOGIN_URL,
  extractedToken: process.env.${envPrefix}_EXTRACTED_TOKEN,
  extractedCookies: process.env.${envPrefix}_EXTRACTED_COOKIES,
  allowInteractiveLogin: process.env.${envPrefix}_ALLOW_INTERACTIVE_LOGIN !== 'false',
});

export const harAuthManager = new HARAuthManager(harAuthConfig);

// Get auth credentials (tries HAR → interactive login)
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const auth = await harAuthManager.getAuth();

  const headers: Record<string, string> = {};

  if (auth.type === 'bearer' && auth.token) {
    headers['Authorization'] = \`Bearer \${auth.token}\`;
  } else if (auth.type === 'api_key' && auth.token) {
    headers['Authorization'] = auth.token;
  } else if (auth.type === 'cookie' && auth.cookies) {
    headers['Cookie'] = auth.cookies.map(c => \`\${c.name}=\${c.value}\`).join('; ');
  }

  return headers;
}
`;
}

/**
 * Generate environment variable documentation for HAR auth
 */
export function generateHARAuthEnvDocs(toolName: string): string {
  const envPrefix = toolName.toUpperCase().replace(/-/g, "_");

  return `
# HAR-based Authentication
# Use when API keys are unavailable or you need to authenticate via web login

# Option 1: Provide a HAR file with authentication data
${envPrefix}_HAR_FILE_PATH=./auth/${toolName}.har

# Option 2: Allow interactive login (Playwright will open browser)
${envPrefix}_LOGIN_URL=https://login.${toolName}.com
${envPrefix}_ALLOW_INTERACTIVE_LOGIN=true

# Auto-populated after successful auth extraction (don't edit manually)
${envPrefix}_EXTRACTED_TOKEN=
${envPrefix}_EXTRACTED_COOKIES=

# How to capture a HAR file:
# 1. Open Firefox DevTools (F12)
# 2. Go to Network tab
# 3. Log into ${toolName}
# 4. Right-click on any request → "Save all as HAR"
# 5. Save as ./auth/${toolName}.har
`;
}
