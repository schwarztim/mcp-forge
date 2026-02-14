import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs/promises";
import { SelfHealingModule } from "./self-healing.js";
import type {
  HealthCheckResult,
  RecoveryAction,
  HealthMetrics,
  AuthHealthStatus,
  VersionCheckResult,
} from "../types/index.js";

// Mock fs module
vi.mock("fs/promises");

// Mock fetch for HTTP calls
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("SelfHealingModule", () => {
  let module: SelfHealingModule;
  const mockHealthDir = "/tmp/test-thesun/health";

  beforeEach(() => {
    module = new SelfHealingModule(mockHealthDir);
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("runHealthCheck", () => {
    it("returns healthy when all endpoints respond with 2xx", async () => {
      // Mock credentials to exist and be valid
      const mockReadFile = vi.mocked(fs.readFile);
      mockReadFile.mockImplementation(async (filePath) => {
        if (String(filePath).endsWith(".meta.json")) {
          return JSON.stringify({
            target: "myapi",
            authType: "api-key", // api-key doesn't expire
          });
        }
        return "";
      });

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      const result = await module.runHealthCheck("myapi", [
        "https://api.example.com/health",
        "https://api.example.com/status",
      ]);

      expect(result.healthy).toBe(true);
      expect(result.target).toBe("myapi");
      expect(result.checkedEndpoints).toHaveLength(2);
      expect(result.checkedEndpoints[0].status).toBe("ok");
      expect(result.checkedEndpoints[1].status).toBe("ok");
    });

    it("returns unhealthy when any endpoint fails", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 })
        .mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await module.runHealthCheck("myapi", [
        "https://api.example.com/health",
        "https://api.example.com/failing",
      ]);

      expect(result.healthy).toBe(false);
      expect(result.checkedEndpoints[0].status).toBe("ok");
      expect(result.checkedEndpoints[1].status).toBe("error");
    });

    it("handles timeout errors", async () => {
      mockFetch.mockRejectedValue(new Error("timeout"));

      const result = await module.runHealthCheck("myapi", [
        "https://api.example.com/slow",
      ]);

      expect(result.healthy).toBe(false);
      expect(result.checkedEndpoints[0].status).toBe("timeout");
      // Case-insensitive check for "timeout" or "Timeout"
      expect(result.checkedEndpoints[0].error?.toLowerCase()).toContain(
        "timeout",
      );
    });

    it("returns healthy with empty endpoints array", async () => {
      // Mock credentials to exist and be valid
      const mockReadFile = vi.mocked(fs.readFile);
      mockReadFile.mockImplementation(async (filePath) => {
        if (String(filePath).endsWith(".meta.json")) {
          return JSON.stringify({
            target: "myapi",
            authType: "api-key", // api-key doesn't expire
          });
        }
        return "";
      });

      const result = await module.runHealthCheck("myapi", []);

      expect(result.healthy).toBe(true);
      expect(result.checkedEndpoints).toHaveLength(0);
    });

    it("records latency for each endpoint", async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      const result = await module.runHealthCheck("myapi", [
        "https://api.example.com/health",
      ]);

      expect(result.checkedEndpoints[0].latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("checkAuth", () => {
    it("returns valid when credentials are not expired", async () => {
      const mockReadFile = vi.mocked(fs.readFile);
      const futureTime = Date.now() + 3600000; // 1 hour from now

      mockReadFile.mockImplementation(async (filePath) => {
        if (String(filePath).endsWith(".meta.json")) {
          return JSON.stringify({
            target: "myapi",
            authType: "bearer",
            expiresAt: futureTime,
          });
        }
        return "";
      });

      const result = await module.checkAuth("myapi");

      expect(result.valid).toBe(true);
      expect(result.needsRefresh).toBe(false);
    });

    it("returns invalid when credentials are expired", async () => {
      const mockReadFile = vi.mocked(fs.readFile);
      const pastTime = Date.now() - 1000; // 1 second ago

      mockReadFile.mockImplementation(async (filePath) => {
        if (String(filePath).endsWith(".meta.json")) {
          return JSON.stringify({
            target: "myapi",
            authType: "bearer",
            expiresAt: pastTime,
          });
        }
        return "";
      });

      const result = await module.checkAuth("myapi");

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("expired");
    });

    it("returns needsRefresh when close to expiry", async () => {
      const mockReadFile = vi.mocked(fs.readFile);
      const nearFutureTime = Date.now() + 3 * 60 * 1000; // 3 minutes from now

      mockReadFile.mockImplementation(async (filePath) => {
        if (String(filePath).endsWith(".meta.json")) {
          return JSON.stringify({
            target: "myapi",
            authType: "bearer",
            expiresAt: nearFutureTime,
          });
        }
        return "";
      });

      const result = await module.checkAuth("myapi");

      expect(result.valid).toBe(true);
      expect(result.needsRefresh).toBe(true);
    });

    it("returns valid with no expiry for api-key auth", async () => {
      const mockReadFile = vi.mocked(fs.readFile);

      mockReadFile.mockImplementation(async (filePath) => {
        if (String(filePath).endsWith(".meta.json")) {
          return JSON.stringify({
            target: "myapi",
            authType: "api-key",
          });
        }
        return "";
      });

      const result = await module.checkAuth("myapi");

      expect(result.valid).toBe(true);
      expect(result.needsRefresh).toBe(false);
    });

    it("returns invalid when no credentials found", async () => {
      const mockReadFile = vi.mocked(fs.readFile);
      mockReadFile.mockRejectedValue(new Error("ENOENT"));

      const result = await module.checkAuth("nonexistent");

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("not found");
    });
  });

  describe("checkApiVersion", () => {
    it("returns compatible when versions match", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ version: "2.0.0" }),
      });

      const result = await module.checkApiVersion(
        "myapi",
        "2.0.0",
        "https://api.example.com/version",
      );

      expect(result.compatible).toBe(true);
      expect(result.actualVersion).toBe("2.0.0");
    });

    it("returns compatible when major versions match (semver)", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ version: "2.1.5" }),
      });

      const result = await module.checkApiVersion(
        "myapi",
        "2.0.0",
        "https://api.example.com/version",
      );

      expect(result.compatible).toBe(true);
    });

    it("returns incompatible when major versions differ", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ version: "3.0.0" }),
      });

      const result = await module.checkApiVersion(
        "myapi",
        "2.0.0",
        "https://api.example.com/version",
      );

      expect(result.compatible).toBe(false);
      expect(result.actualVersion).toBe("3.0.0");
    });

    it("includes deprecation warning when present in response", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          version: "2.5.0",
          deprecation_warning: "This version will be deprecated on 2025-01-01",
        }),
      });

      const result = await module.checkApiVersion(
        "myapi",
        "2.0.0",
        "https://api.example.com/version",
      );

      expect(result.deprecationWarning).toContain("deprecated");
    });

    it("returns incompatible when version endpoint fails", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      const result = await module.checkApiVersion(
        "myapi",
        "2.0.0",
        "https://api.example.com/version",
      );

      expect(result.compatible).toBe(false);
      expect(result.actualVersion).toBeUndefined();
    });
  });

  describe("recordSuccess", () => {
    it("increments success count", () => {
      module.recordSuccess("myapi", "/health");
      module.recordSuccess("myapi", "/health");

      const metrics = module.getHealthMetrics("myapi");

      expect(metrics.successCount).toBe(2);
      expect(metrics.lastSuccess).toBeDefined();
    });

    it("updates success rate", () => {
      module.recordSuccess("myapi", "/health");
      module.recordSuccess("myapi", "/health");
      module.recordFailure("myapi", "/health", 500, "Server error");

      const metrics = module.getHealthMetrics("myapi");

      expect(metrics.successRate).toBeCloseTo(2 / 3, 2);
    });
  });

  describe("recordFailure", () => {
    it("increments failure count", () => {
      module.recordFailure("myapi", "/health", 500, "Server error");
      module.recordFailure("myapi", "/health", 503, "Service unavailable");

      const metrics = module.getHealthMetrics("myapi");

      expect(metrics.failureCount).toBe(2);
      expect(metrics.lastFailure).toBeDefined();
    });

    it("tracks error patterns by status code", () => {
      module.recordFailure("myapi", "/health", 500, "Server error");
      module.recordFailure("myapi", "/health", 500, "Server error");
      module.recordFailure("myapi", "/health", 429, "Rate limited");

      const metrics = module.getHealthMetrics("myapi");

      expect(metrics.errorPatterns["500"]).toBe(2);
      expect(metrics.errorPatterns["429"]).toBe(1);
    });
  });

  describe("getHealthMetrics", () => {
    it("returns zero metrics for unknown target", () => {
      const metrics = module.getHealthMetrics("unknown");

      expect(metrics.target).toBe("unknown");
      expect(metrics.successCount).toBe(0);
      expect(metrics.failureCount).toBe(0);
      expect(metrics.successRate).toBe(1); // Default to healthy
      expect(metrics.errorPatterns).toEqual({});
    });

    it("calculates correct success rate", () => {
      module.recordSuccess("myapi", "/health");
      module.recordSuccess("myapi", "/health");
      module.recordSuccess("myapi", "/health");
      module.recordFailure("myapi", "/health", 500, "Error");

      const metrics = module.getHealthMetrics("myapi");

      expect(metrics.successRate).toBe(0.75);
    });
  });

  describe("handleError", () => {
    it("returns refresh-auth action for 401", async () => {
      const result = await module.handleError("myapi", 401, "Unauthorized");

      expect(result.action).toBe("refresh-auth");
      expect(result.message).toContain("auth");
    });

    it("returns none action for 403", async () => {
      const result = await module.handleError("myapi", 403, "Forbidden");

      expect(result.action).toBe("none");
      expect(result.message).toContain("permission");
    });

    it("returns regenerate action for 404", async () => {
      const result = await module.handleError("myapi", 404, "Not found");

      expect(result.action).toBe("regenerate");
      expect(result.message).toContain("changed");
    });

    it("returns backoff action for 429 with wait duration", async () => {
      const result = await module.handleError("myapi", 429, "Rate limited");

      expect(result.action).toBe("backoff");
      expect(result.waitMs).toBeGreaterThan(0);
      // Case-insensitive check for "rate"
      expect(result.message.toLowerCase()).toContain("rate");
    });

    it("returns retry action for 5xx errors", async () => {
      const result500 = await module.handleError("myapi", 500, "Server error");
      const result502 = await module.handleError("myapi", 502, "Bad gateway");
      const result503 = await module.handleError(
        "myapi",
        503,
        "Service unavailable",
      );

      expect(result500.action).toBe("retry");
      expect(result502.action).toBe("retry");
      expect(result503.action).toBe("retry");
      expect(result500.waitMs).toBeGreaterThan(0);
    });

    it("uses exponential backoff for repeated errors", async () => {
      // Record multiple failures to trigger increased backoff
      module.recordFailure("myapi", "/health", 500, "Error");
      module.recordFailure("myapi", "/health", 500, "Error");
      module.recordFailure("myapi", "/health", 500, "Error");

      const result = await module.handleError("myapi", 500, "Server error");

      // Backoff should increase with more failures
      expect(result.waitMs).toBeGreaterThan(1000);
    });

    it("returns none action for unknown status codes", async () => {
      const result = await module.handleError("myapi", 418, "I'm a teapot");

      expect(result.action).toBe("none");
    });
  });

  describe("saveHealthLog", () => {
    it("saves health check results to file", async () => {
      const mockMkdir = vi.mocked(fs.mkdir);
      const mockWriteFile = vi.mocked(fs.writeFile);
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      const healthCheck: HealthCheckResult = {
        target: "myapi",
        healthy: true,
        checkedEndpoints: [
          { endpoint: "/health", status: "ok", latencyMs: 50 },
        ],
        authValid: true,
        timestamp: new Date(),
      };

      await module.saveHealthLog("myapi", healthCheck);

      expect(mockMkdir).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalled();
    });
  });

  describe("loadHealthLog", () => {
    it("loads recent health logs from file", async () => {
      const mockReadFile = vi.mocked(fs.readFile);
      const mockReaddir = vi.mocked(fs.readdir);
      const mockStat = vi.mocked(fs.stat);

      mockReaddir.mockResolvedValue(["health-2025-01-01.json"] as any);
      mockStat.mockResolvedValue({ isFile: () => true } as any);
      mockReadFile.mockResolvedValue(
        JSON.stringify([
          {
            target: "myapi",
            healthy: true,
            checkedEndpoints: [],
            authValid: true,
            timestamp: new Date().toISOString(),
          },
        ]),
      );

      const logs = await module.loadHealthLogs("myapi", 10);

      expect(logs).toHaveLength(1);
      expect(logs[0].target).toBe("myapi");
    });

    it("returns empty array when no logs exist", async () => {
      const mockReaddir = vi.mocked(fs.readdir);
      mockReaddir.mockRejectedValue(new Error("ENOENT"));

      const logs = await module.loadHealthLogs("nonexistent", 10);

      expect(logs).toEqual([]);
    });
  });
});
