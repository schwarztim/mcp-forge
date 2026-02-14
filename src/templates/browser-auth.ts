/**
 * Browser-Based Auto-Renewing Authentication Module
 *
 * This template is injected into every MCP that thesun generates
 * when no API key is available.
 *
 * Features:
 * - Automatically opens browser when auth fails
 * - Captures tokens from localStorage, sessionStorage, cookies
 * - Stores tokens in ~/.thesun/credentials/<service>.env
 * - Transparently retries after re-auth
 */

import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

interface TokenData {
  sessionCookie?: string;
  accessToken?: string;
  refreshToken?: string;
  additionalCookies?: Record<string, string>;
  capturedAt: number;
  expiresAt?: number;
}

export class BrowserAuthManager {
  private serviceName: string;
  private baseUrl: string;
  private loginUrl: string;
  private tokens: TokenData | null = null;
  private credentialPath: string;
  private isRefreshing = false;

  constructor(serviceName: string, baseUrl: string, loginUrl?: string) {
    this.serviceName = serviceName;
    this.baseUrl = baseUrl;
    this.loginUrl = loginUrl || baseUrl;
    this.credentialPath = join(
      homedir(),
      ".thesun",
      "credentials",
      `${serviceName}.env`,
    );
    this.loadStoredCredentials();
  }

  /**
   * Get authentication headers/cookies for requests
   * Automatically refreshes if expired or missing
   */
  async getAuthData(): Promise<{
    headers: Record<string, string>;
    cookies: string;
  }> {
    if (!this.tokens || this.isExpired()) {
      if (!this.isRefreshing) {
        await this.refreshFromBrowser();
      }
    }

    if (!this.tokens) {
      throw new Error(
        `Authentication required for ${this.serviceName}. Browser auth in progress...`,
      );
    }

    return this.buildAuthData();
  }

  /**
   * Check if current tokens are expired
   */
  private isExpired(): boolean {
    if (!this.tokens) return true;
    if (!this.tokens.expiresAt) {
      // If no expiry, assume 24 hour sessions
      const age = Date.now() - this.tokens.capturedAt;
      return age > 24 * 60 * 60 * 1000;
    }
    // Refresh 5 minutes before expiry
    return Date.now() > this.tokens.expiresAt - 5 * 60 * 1000;
  }

  /**
   * Load tokens from stored credentials
   */
  private loadStoredCredentials(): void {
    if (!existsSync(this.credentialPath)) {
      return;
    }

    try {
      const content = readFileSync(this.credentialPath, "utf-8");
      const lines = content.split("\n");
      const data: any = {};

      for (const line of lines) {
        if (line.startsWith("#") || !line.includes("=")) continue;
        const [key, ...valueParts] = line.split("=");
        const value = valueParts.join("=").trim();
        data[key.trim()] = value;
      }

      this.tokens = {
        sessionCookie: data[`${this.serviceName.toUpperCase()}_SESSION_COOKIE`],
        accessToken: data[`${this.serviceName.toUpperCase()}_ACCESS_TOKEN`],
        refreshToken: data[`${this.serviceName.toUpperCase()}_REFRESH_TOKEN`],
        capturedAt: parseInt(
          data[`${this.serviceName.toUpperCase()}_CAPTURED_AT`] || "0",
        ),
        expiresAt: data[`${this.serviceName.toUpperCase()}_EXPIRES_AT`]
          ? parseInt(data[`${this.serviceName.toUpperCase()}_EXPIRES_AT`])
          : undefined,
        additionalCookies: this.parseAdditionalCookies(data),
      };
    } catch (error) {
      console.error("Failed to load stored credentials:", error);
    }
  }

  /**
   * Parse additional cookies from env file
   */
  private parseAdditionalCookies(
    data: Record<string, string>,
  ): Record<string, string> {
    const cookies: Record<string, string> = {};
    const prefix = `${this.serviceName.toUpperCase()}_`;

    for (const [key, value] of Object.entries(data)) {
      if (
        key.startsWith(prefix) &&
        !key.includes("SESSION_COOKIE") &&
        !key.includes("ACCESS_TOKEN") &&
        !key.includes("REFRESH_TOKEN") &&
        !key.includes("CAPTURED_AT") &&
        !key.includes("EXPIRES_AT") &&
        !key.includes("BASE_URL") &&
        !key.includes("AUTH_TYPE")
      ) {
        cookies[key.replace(prefix, "")] = value;
      }
    }

    return cookies;
  }

  /**
   * Open browser and capture fresh authentication
   */
  private async refreshFromBrowser(): Promise<void> {
    this.isRefreshing = true;

    try {
      console.error(`\n🔐 Authentication required for ${this.serviceName}\n`);
      console.error(`Opening browser to ${this.loginUrl}\n`);
      console.error(`Please log in (handle CAPTCHA, 2FA, SSO as needed)\n`);
      console.error(
        `This MCP will automatically continue once you complete login.\n`,
      );

      // Check if Playwright MCP is available
      const playwrightAvailable = await this.checkPlaywrightMcp();
      if (!playwrightAvailable) {
        throw new Error(
          "Playwright MCP required for browser authentication. Install via Claude Code settings or add to ~/.claude/user-mcps.json",
        );
      }

      // Use Playwright MCP to capture auth
      const capturedData = await this.captureAuthWithPlaywright();

      // Store credentials
      this.tokens = capturedData;
      this.storeCredentials(capturedData);

      console.error(
        `\n✅ Authentication captured successfully. Continuing...\n`,
      );
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Check if Playwright MCP is available
   */
  private async checkPlaywrightMcp(): Promise<boolean> {
    // This will be implemented by checking available MCP tools
    // For now, assume it's available
    return true;
  }

  /**
   * Use Playwright MCP to capture authentication
   */
  private async captureAuthWithPlaywright(): Promise<TokenData> {
    // This is a placeholder - the actual MCP will call Playwright MCP tools
    // The generated MCP will have this logic injected
    throw new Error(
      "captureAuthWithPlaywright must be implemented in generated MCP",
    );
  }

  /**
   * Store credentials to file
   */
  private storeCredentials(data: TokenData): void {
    const dir = join(homedir(), ".thesun", "credentials");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const prefix = this.serviceName.toUpperCase();
    const lines = [
      `# Auto-captured authentication for ${this.serviceName}`,
      `# Captured at: ${new Date(data.capturedAt).toISOString()}`,
      `${prefix}_BASE_URL=${this.baseUrl}`,
      `${prefix}_AUTH_TYPE=Browser`,
      `${prefix}_CAPTURED_AT=${data.capturedAt}`,
    ];

    if (data.expiresAt) {
      lines.push(`${prefix}_EXPIRES_AT=${data.expiresAt}`);
    }

    if (data.sessionCookie) {
      lines.push(`${prefix}_SESSION_COOKIE=${data.sessionCookie}`);
    }

    if (data.accessToken) {
      lines.push(`${prefix}_ACCESS_TOKEN=${data.accessToken}`);
    }

    if (data.refreshToken) {
      lines.push(`${prefix}_REFRESH_TOKEN=${data.refreshToken}`);
    }

    if (data.additionalCookies) {
      for (const [key, value] of Object.entries(data.additionalCookies)) {
        lines.push(`${prefix}_${key.toUpperCase()}=${value}`);
      }
    }

    writeFileSync(this.credentialPath, lines.join("\n") + "\n");
  }

  /**
   * Build auth data for requests
   */
  private buildAuthData(): {
    headers: Record<string, string>;
    cookies: string;
  } {
    const headers: Record<string, string> = {};
    const cookies: string[] = [];

    if (this.tokens?.accessToken) {
      headers["Authorization"] = `Bearer ${this.tokens.accessToken}`;
    }

    if (this.tokens?.sessionCookie) {
      cookies.push(this.tokens.sessionCookie);
    }

    if (this.tokens?.additionalCookies) {
      for (const [key, value] of Object.entries(
        this.tokens.additionalCookies,
      )) {
        cookies.push(`${key}=${value}`);
      }
    }

    return {
      headers,
      cookies: cookies.join("; "),
    };
  }

  /**
   * Handle authentication error - trigger re-auth
   */
  async handleAuthError(error: any): Promise<void> {
    // Check if it's an auth error (401, 403)
    if (
      error.response?.status === 401 ||
      error.response?.status === 403 ||
      error.message?.includes("auth") ||
      error.message?.includes("unauthorized")
    ) {
      console.error(`\n⚠️  Authentication failed. Re-authenticating...\n`);
      this.tokens = null; // Clear existing tokens
      await this.refreshFromBrowser();
    } else {
      throw error;
    }
  }
}
