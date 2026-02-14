/**
 * Self-Healing Module for health monitoring and auto-recovery
 *
 * Responsibilities:
 * - Run health checks on startup and periodically
 * - Monitor runtime errors and track patterns
 * - Provide automatic recovery actions based on error type
 * - Detect API deprecation and version drift
 * - Store health logs for analysis
 */

import * as fs from "fs/promises";
import * as path from "path";
import type {
  HealthCheckResult,
  CheckedEndpoint,
  RecoveryAction,
  HealthMetrics,
  AuthHealthStatus,
  VersionCheckResult,
} from "../types/index.js";

/** Default health data directory */
const DEFAULT_HEALTH_DIR = path.join(
  process.env.HOME || "~",
  ".thesun",
  "health",
);

/** Refresh buffer - consider auth needing refresh 5 minutes before expiry */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** Default timeout for health checks */
const HEALTH_CHECK_TIMEOUT_MS = 10000;

/** Base backoff duration in milliseconds */
const BASE_BACKOFF_MS = 1000;

/** Maximum backoff duration in milliseconds */
const MAX_BACKOFF_MS = 60000;

/** In-memory metrics storage per target */
interface MetricsState {
  successCount: number;
  failureCount: number;
  lastSuccess?: Date;
  lastFailure?: Date;
  errorPatterns: Record<string, number>;
}

/**
 * SelfHealingModule provides health monitoring and auto-recovery for MCPs
 */
export class SelfHealingModule {
  private healthDir: string;
  private metricsStore: Map<string, MetricsState> = new Map();
  private credentialsDir: string;

  constructor(healthDir: string = DEFAULT_HEALTH_DIR) {
    this.healthDir = healthDir;
    this.credentialsDir = path.join(
      process.env.HOME || "~",
      ".thesun",
      "credentials",
    );
  }

  /**
   * Run health check against a list of endpoints
   */
  async runHealthCheck(
    target: string,
    endpoints: string[],
  ): Promise<HealthCheckResult> {
    const checkedEndpoints: CheckedEndpoint[] = [];
    let allHealthy = true;

    for (const endpoint of endpoints) {
      const startTime = Date.now();
      let status: "ok" | "error" | "timeout" = "ok";
      let error: string | undefined;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          HEALTH_CHECK_TIMEOUT_MS,
        );

        const response = await fetch(endpoint, {
          method: "GET",
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          status = "error";
          error = `HTTP ${response.status}`;
          allHealthy = false;
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Unknown error";

        if (
          errorMessage.includes("abort") ||
          errorMessage.includes("timeout")
        ) {
          status = "timeout";
          error = `Timeout after ${HEALTH_CHECK_TIMEOUT_MS}ms`;
        } else {
          status = "timeout"; // Treat network errors as timeout
          error = errorMessage;
        }
        allHealthy = false;
      }

      const latencyMs = Date.now() - startTime;
      checkedEndpoints.push({
        endpoint,
        status,
        latencyMs,
        error,
      });
    }

    // Check auth status
    const authStatus = await this.checkAuth(target);

    return {
      target,
      healthy: allHealthy && authStatus.valid,
      checkedEndpoints,
      authValid: authStatus.valid,
      timestamp: new Date(),
    };
  }

  /**
   * Check authentication status for a target
   */
  async checkAuth(target: string): Promise<AuthHealthStatus> {
    const metaPath = path.join(this.credentialsDir, `${target}.meta.json`);

    try {
      const content = await fs.readFile(metaPath, "utf-8");
      const meta = JSON.parse(content);

      // API keys don't expire
      if (meta.authType === "api-key" || meta.authType === "none") {
        return {
          valid: true,
          needsRefresh: false,
        };
      }

      // Check expiration
      if (meta.expiresAt !== undefined) {
        const now = Date.now();

        if (now > meta.expiresAt) {
          return {
            valid: false,
            reason: "Credentials expired",
            expiresAt: meta.expiresAt,
            needsRefresh: true,
          };
        }

        // Check if within refresh buffer
        const timeUntilExpiry = meta.expiresAt - now;
        if (timeUntilExpiry < REFRESH_BUFFER_MS) {
          return {
            valid: true,
            expiresAt: meta.expiresAt,
            needsRefresh: true,
          };
        }
      }

      return {
        valid: true,
        expiresAt: meta.expiresAt,
        needsRefresh: false,
      };
    } catch {
      return {
        valid: false,
        reason: "Credentials not found",
        needsRefresh: false,
      };
    }
  }

  /**
   * Check API version compatibility
   */
  async checkApiVersion(
    target: string,
    expectedVersion: string,
    versionEndpoint: string = "/version",
  ): Promise<VersionCheckResult> {
    try {
      const response = await fetch(versionEndpoint);

      if (!response.ok) {
        return {
          target,
          expectedVersion,
          compatible: false,
        };
      }

      const data = (await response.json()) as {
        version?: string;
        deprecation_warning?: string;
      };

      const actualVersion = data.version;

      if (!actualVersion) {
        return {
          target,
          expectedVersion,
          compatible: false,
        };
      }

      // Compare major versions (semver)
      const expectedMajor = this.getMajorVersion(expectedVersion);
      const actualMajor = this.getMajorVersion(actualVersion);
      const compatible = expectedMajor === actualMajor;

      return {
        target,
        expectedVersion,
        actualVersion,
        compatible,
        deprecationWarning: data.deprecation_warning,
      };
    } catch {
      return {
        target,
        expectedVersion,
        compatible: false,
      };
    }
  }

  /**
   * Extract major version from semver string
   */
  private getMajorVersion(version: string): number {
    const match = version.match(/^(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  /**
   * Record a successful API call
   */
  recordSuccess(target: string, endpoint: string): void {
    const state = this.getOrCreateState(target);
    state.successCount++;
    state.lastSuccess = new Date();
  }

  /**
   * Record a failed API call
   */
  recordFailure(
    target: string,
    endpoint: string,
    statusCode: number,
    error: string,
  ): void {
    const state = this.getOrCreateState(target);
    state.failureCount++;
    state.lastFailure = new Date();

    // Track error pattern by status code
    const statusKey = statusCode.toString();
    state.errorPatterns[statusKey] = (state.errorPatterns[statusKey] || 0) + 1;
  }

  /**
   * Get health metrics for a target
   */
  getHealthMetrics(target: string): HealthMetrics {
    const state = this.metricsStore.get(target);

    if (!state) {
      return {
        target,
        successCount: 0,
        failureCount: 0,
        successRate: 1, // Default to healthy when no data
        errorPatterns: {},
      };
    }

    const total = state.successCount + state.failureCount;
    const successRate = total > 0 ? state.successCount / total : 1;

    return {
      target,
      successCount: state.successCount,
      failureCount: state.failureCount,
      successRate,
      lastSuccess: state.lastSuccess,
      lastFailure: state.lastFailure,
      errorPatterns: { ...state.errorPatterns },
    };
  }

  /**
   * Handle an error and determine recovery action
   */
  async handleError(
    target: string,
    statusCode: number,
    error: string,
  ): Promise<RecoveryAction> {
    // Get current failure count for backoff calculation
    const metrics = this.getHealthMetrics(target);
    const failureCount = metrics.errorPatterns[statusCode.toString()] || 0;

    switch (statusCode) {
      case 401:
        return {
          action: "refresh-auth",
          message: "Authentication failed - triggering auth refresh",
        };

      case 403:
        return {
          action: "none",
          message: "Permission denied - user must grant additional permissions",
        };

      case 404:
        return {
          action: "regenerate",
          message:
            "Endpoint not found - API may have changed, flagged for regeneration",
        };

      case 429:
        // Rate limiting - use longer backoff
        const rateLimitBackoff = Math.min(
          BASE_BACKOFF_MS * Math.pow(2, failureCount),
          MAX_BACKOFF_MS,
        );
        return {
          action: "backoff",
          waitMs: rateLimitBackoff,
          message: `Rate limited - waiting ${rateLimitBackoff}ms before retry`,
        };

      default:
        // Handle 5xx server errors with retry
        if (statusCode >= 500 && statusCode < 600) {
          const retryBackoff = Math.min(
            BASE_BACKOFF_MS * Math.pow(2, failureCount),
            MAX_BACKOFF_MS,
          );
          return {
            action: "retry",
            waitMs: retryBackoff,
            message: `Server error ${statusCode} - retrying after ${retryBackoff}ms`,
          };
        }

        // Unknown error
        return {
          action: "none",
          message: `Unknown error ${statusCode}: ${error}`,
        };
    }
  }

  /**
   * Save health check result to log file
   */
  async saveHealthLog(
    target: string,
    result: HealthCheckResult,
  ): Promise<void> {
    const targetDir = path.join(this.healthDir, target);
    await fs.mkdir(targetDir, { recursive: true });

    // Create filename with date
    const date = new Date().toISOString().split("T")[0];
    const logPath = path.join(targetDir, `health-${date}.json`);

    // Load existing logs for today or create new array
    let logs: HealthCheckResult[] = [];
    try {
      const existing = await fs.readFile(logPath, "utf-8");
      logs = JSON.parse(existing);
    } catch {
      // File doesn't exist, start fresh
    }

    logs.push(result);

    await fs.writeFile(logPath, JSON.stringify(logs, null, 2), "utf-8");
  }

  /**
   * Load recent health logs for a target
   */
  async loadHealthLogs(
    target: string,
    limit: number,
  ): Promise<HealthCheckResult[]> {
    const targetDir = path.join(this.healthDir, target);

    try {
      const files = await fs.readdir(targetDir);
      const healthFiles = files
        .filter((f) => f.startsWith("health-") && f.endsWith(".json"))
        .sort()
        .reverse();

      const logs: HealthCheckResult[] = [];

      for (const file of healthFiles) {
        if (logs.length >= limit) break;

        const filePath = path.join(targetDir, file);
        const stat = await fs.stat(filePath);

        if (stat.isFile()) {
          const content = await fs.readFile(filePath, "utf-8");
          const fileLogs: HealthCheckResult[] = JSON.parse(content);
          logs.push(...fileLogs);
        }
      }

      return logs.slice(0, limit);
    } catch {
      return [];
    }
  }

  /**
   * Get or create metrics state for a target
   */
  private getOrCreateState(target: string): MetricsState {
    let state = this.metricsStore.get(target);

    if (!state) {
      state = {
        successCount: 0,
        failureCount: 0,
        errorPatterns: {},
      };
      this.metricsStore.set(target, state);
    }

    return state;
  }

  /**
   * Reset metrics for a target (useful for testing or after recovery)
   */
  resetMetrics(target: string): void {
    this.metricsStore.delete(target);
  }

  /**
   * Get all targets being monitored
   */
  getMonitoredTargets(): string[] {
    return Array.from(this.metricsStore.keys());
  }
}
