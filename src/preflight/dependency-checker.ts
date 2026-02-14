/**
 * Preflight dependency checker for browser-enhanced MCP generation.
 * Verifies all required dependencies are available before starting generation.
 *
 * Uses Playwright MCP with Firefox for browser automation - giving us:
 * - Full JS evaluation (localStorage, sessionStorage, cookies)
 * - Network request interception
 * - Token capture from any webapp
 * - No Google/Chrome dependency
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";
import { logger } from "../observability/logger.js";
import type { DependencyStatus, PreflightCheckResult } from "../types/index.js";

/**
 * Platform-specific Firefox browser paths
 * Required for Playwright's --browser firefox option
 */
const FIREFOX_PATHS: Record<string, string[]> = {
  darwin: [
    "/Applications/Firefox.app/Contents/MacOS/firefox",
    join(homedir(), "Applications/Firefox.app/Contents/MacOS/firefox"),
  ],
  linux: [
    "/usr/bin/firefox",
    "/usr/bin/firefox-esr",
    "/snap/bin/firefox",
    "/usr/lib/firefox/firefox",
    "/opt/firefox/firefox",
  ],
  win32: [
    join(
      process.env.PROGRAMFILES || "C:\\Program Files",
      "Mozilla Firefox\\firefox.exe",
    ),
    join(
      process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
      "Mozilla Firefox\\firefox.exe",
    ),
    join(process.env.LOCALAPPDATA || "", "Mozilla Firefox\\firefox.exe"),
  ],
};

/**
 * Required subdirectories under ~/.thesun/
 */
const THESUN_SUBDIRS = ["credentials", "cache", "patterns", "health"];

/**
 * DependencyChecker verifies all required dependencies for browser-enhanced MCP generation.
 */
export class DependencyChecker {
  private userMcpsPath: string;
  private thesunDir: string;

  constructor() {
    this.userMcpsPath = join(homedir(), ".claude", "user-mcps.json");
    this.thesunDir = join(homedir(), ".thesun");
  }

  /**
   * Runs all preflight checks and returns the combined result.
   */
  async runPreflight(): Promise<PreflightCheckResult> {
    logger.info("Running preflight dependency checks");

    const checks = await Promise.all([
      this.checkPlaywrightMcp(),
      this.checkFirefoxBrowser(),
      this.checkThesunDirectory(),
    ]);

    const missingRequired = checks
      .filter((c) => c.required && !c.available)
      .map((c) => c.name);

    const result: PreflightCheckResult = {
      passed: missingRequired.length === 0,
      dependencies: checks,
      missingRequired,
      timestamp: new Date(),
    };

    if (result.passed) {
      logger.info("Preflight checks passed", { dependencies: checks.length });
    } else {
      logger.warn("Preflight checks failed", { missingRequired });
    }

    return result;
  }

  /**
   * Checks if Playwright MCP is available (via Claude plugin or user-mcps.json)
   *
   * Playwright MCP with --browser firefox gives us:
   * - page.evaluate() for localStorage/sessionStorage/cookies
   * - page.context().cookies() for all cookies including HttpOnly
   * - Network interception for token capture
   * - Full browser automation
   */
  async checkPlaywrightMcp(): Promise<DependencyStatus> {
    const name = "playwright-mcp";

    try {
      // First check if Playwright plugin is installed (preferred)
      const pluginPath = join(
        homedir(),
        ".claude",
        "plugins",
        "marketplaces",
        "claude-plugins-official",
        "external_plugins",
        "playwright",
      );

      if (existsSync(pluginPath)) {
        logger.debug("Playwright plugin found", { path: pluginPath });
        return {
          name,
          required: true,
          available: true,
          version: "plugin",
        };
      }

      // Fall back to checking user-mcps.json
      if (!existsSync(this.userMcpsPath)) {
        return {
          name,
          required: true,
          available: false,
          error: `Config file not found: ${this.userMcpsPath}`,
          installCommand: this.getPlaywrightInstallCommand(),
        };
      }

      const content = readFileSync(this.userMcpsPath, "utf-8");
      let config: { mcpServers?: Record<string, unknown> };

      try {
        config = JSON.parse(content);
      } catch {
        return {
          name,
          required: true,
          available: false,
          error: `Failed to parse ${this.userMcpsPath}: Invalid JSON`,
          installCommand: this.getPlaywrightInstallCommand(),
        };
      }

      // Check for playwright in any form
      const mcpServers = config.mcpServers || {};
      const hasPlaywright = Object.keys(mcpServers).some(
        (key) =>
          key.includes("playwright") ||
          key.includes("Playwright") ||
          key.includes("PLAYWRIGHT"),
      );

      if (hasPlaywright) {
        logger.debug("Playwright MCP found in user-mcps.json");
        return {
          name,
          required: true,
          available: true,
        };
      }

      return {
        name,
        required: true,
        available: false,
        installCommand: this.getPlaywrightInstallCommand(),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        name,
        required: true,
        available: false,
        error: errorMessage,
        installCommand: this.getPlaywrightInstallCommand(),
      };
    }
  }

  /**
   * Checks if Firefox browser is installed on the system.
   * Required for Playwright's --browser firefox option.
   * This ensures we use Mozilla's freedom-respecting browser instead of Chrome.
   */
  async checkFirefoxBrowser(): Promise<DependencyStatus> {
    const name = "firefox-browser";
    const currentPlatform = platform();
    const paths = FIREFOX_PATHS[currentPlatform] || [];

    for (const firefoxPath of paths) {
      if (existsSync(firefoxPath)) {
        logger.debug("Firefox browser found", { path: firefoxPath });
        return {
          name,
          required: true,
          available: true,
          version: firefoxPath,
        };
      }
    }

    return {
      name,
      required: true,
      available: false,
      installCommand: this.getFirefoxInstallCommand(currentPlatform),
    };
  }

  /**
   * Checks and creates ~/.thesun/ directory structure if needed
   */
  async checkThesunDirectory(): Promise<DependencyStatus> {
    const name = "thesun-directory";

    try {
      // Check if main directory exists
      const mainDirExists = existsSync(this.thesunDir);

      if (!mainDirExists) {
        // Create main directory and all subdirectories
        mkdirSync(this.thesunDir, { recursive: true });
        logger.info("Created thesun directory", { path: this.thesunDir });
      }

      // Create all subdirectories
      for (const subdir of THESUN_SUBDIRS) {
        const subdirPath = join(this.thesunDir, subdir);
        if (!existsSync(subdirPath)) {
          mkdirSync(subdirPath, { recursive: true });
          logger.debug("Created subdirectory", { path: subdirPath });
        }
      }

      return {
        name,
        required: true,
        available: true,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error("Failed to create thesun directory", {
        error: errorMessage,
      });
      return {
        name,
        required: true,
        available: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Formats missing dependencies into a user-friendly error message
   */
  formatMissingDependencies(result: PreflightCheckResult): string {
    if (result.passed || result.missingRequired.length === 0) {
      return "";
    }

    const lines = [
      "Missing required dependencies for browser-enhanced mode:",
      "",
    ];

    for (const dep of result.dependencies) {
      if (!dep.available && dep.required) {
        lines.push(`  - ${dep.name}`);
        if (dep.error) {
          lines.push(`    Error: ${dep.error}`);
        }
        if (dep.installCommand) {
          lines.push(`    Install: ${dep.installCommand}`);
        }
        lines.push("");
      }
    }

    return lines.join("\n");
  }

  /**
   * Returns the install command for Playwright MCP
   */
  private getPlaywrightInstallCommand(): string {
    return `Install Playwright plugin via Claude Code settings, or add to ~/.claude/user-mcps.json:
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--browser", "firefox"]
    }
  }
}`;
  }

  /**
   * Returns the platform-specific Firefox install command
   */
  private getFirefoxInstallCommand(currentPlatform: string): string {
    switch (currentPlatform) {
      case "darwin":
        return "brew install --cask firefox";
      case "linux":
        return "sudo apt install firefox (or your distro's package manager)";
      case "win32":
        return "Download from https://www.mozilla.org/firefox/";
      default:
        return "Download from https://www.mozilla.org/firefox/";
    }
  }
}

// Singleton instance
let instance: DependencyChecker | null = null;

/**
 * Returns the singleton DependencyChecker instance
 */
export function getDependencyChecker(): DependencyChecker {
  if (!instance) {
    instance = new DependencyChecker();
  }
  return instance;
}
