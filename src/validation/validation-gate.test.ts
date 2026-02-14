import { describe, it, expect, beforeEach, afterEach, vi, Mock } from "vitest";
import * as fs from "fs/promises";
import { ValidationGate, ExecCommandFn } from "./validation-gate.js";
import type {
  ValidationPhaseResult,
  DiscoveredEndpoint,
} from "../types/index.js";

// Mock modules
vi.mock("fs/promises");

// Mock fetch for HTTP calls
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("ValidationGate", () => {
  let gate: ValidationGate;
  const mockMcpPath = "/tmp/test-mcp";
  const mockTarget = "test-api";
  let mockExecCommand: Mock<ExecCommandFn>;

  beforeEach(() => {
    mockExecCommand = vi.fn();
    gate = new ValidationGate(undefined, mockExecCommand);
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("validateBuild", () => {
    it("passes when TypeScript compiles without errors", async () => {
      mockExecCommand.mockResolvedValue({
        stdout: "Compilation successful",
        stderr: "",
      });

      const mockReadFile = vi.mocked(fs.readFile);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          name: "test-mcp",
          scripts: { build: "tsc" },
        }),
      );

      const result = await gate.validateBuild(mockMcpPath);

      expect(result.phase).toBe("build");
      expect(result.passed).toBe(true);
      expect(result.details.some((d) => d.name === "typescript_compile")).toBe(
        true,
      );
    });

    it("fails when TypeScript has compilation errors", async () => {
      const error = new Error("Compilation failed");
      (error as any).stderr = "error TS2304: Cannot find name 'unknownVar'.";
      mockExecCommand.mockRejectedValue(error);

      const mockReadFile = vi.mocked(fs.readFile);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          name: "test-mcp",
          scripts: { build: "tsc" },
        }),
      );

      const result = await gate.validateBuild(mockMcpPath);

      expect(result.phase).toBe("build");
      expect(result.passed).toBe(false);
      expect(result.details.some((d) => !d.passed && d.error)).toBe(true);
    });

    it("checks that MCP server starts without crash", async () => {
      mockExecCommand.mockResolvedValue({
        stdout: "Server started",
        stderr: "",
      });

      const mockReadFile = vi.mocked(fs.readFile);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          name: "test-mcp",
          scripts: { build: "tsc" },
          main: "dist/index.js",
        }),
      );

      const result = await gate.validateBuild(mockMcpPath);

      expect(result.passed).toBe(true);
      expect(result.details.some((d) => d.name === "server_starts")).toBe(true);
    });

    it("verifies all imports resolve", async () => {
      mockExecCommand.mockResolvedValue({ stdout: "", stderr: "" });

      const mockReadFile = vi.mocked(fs.readFile);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          name: "test-mcp",
          scripts: { build: "tsc" },
        }),
      );

      const result = await gate.validateBuild(mockMcpPath);

      expect(result.passed).toBe(true);
      expect(result.details.some((d) => d.name === "imports_resolve")).toBe(
        true,
      );
    });
  });

  describe("validateEndpoints", () => {
    const mockEndpoints: DiscoveredEndpoint[] = [
      {
        path: "/users",
        method: "GET",
        operationId: "getUsers",
        tags: [],
        parameters: [],
      },
      {
        path: "/users/{id}",
        method: "GET",
        operationId: "getUserById",
        tags: [],
        parameters: [{ name: "id", in: "path", required: true }],
      },
    ];

    it("passes when all endpoints can be called", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      });

      const mockReadFile = vi.mocked(fs.readFile);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          target: mockTarget,
          authType: "api-key",
          apiKey: "test-key",
          baseUrl: "https://api.example.com",
        }),
      );

      const result = await gate.validateEndpoints(
        mockTarget,
        mockMcpPath,
        mockEndpoints,
      );

      expect(result.phase).toBe("endpoints");
      expect(result.passed).toBe(true);
      expect(result.details.length).toBeGreaterThanOrEqual(1);
    });

    it("fails when an endpoint returns auth error", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      });

      const mockReadFile = vi.mocked(fs.readFile);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          target: mockTarget,
          authType: "api-key",
          apiKey: "invalid-key",
          baseUrl: "https://api.example.com",
        }),
      );

      const result = await gate.validateEndpoints(
        mockTarget,
        mockMcpPath,
        mockEndpoints,
      );

      expect(result.phase).toBe("endpoints");
      expect(result.passed).toBe(false);
      expect(result.details.some((d) => d.error?.includes("401"))).toBe(true);
    });

    it("verifies response parses correctly", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ users: [{ id: 1, name: "Test" }] }),
      });

      const mockReadFile = vi.mocked(fs.readFile);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          target: mockTarget,
          authType: "api-key",
          apiKey: "test-key",
          baseUrl: "https://api.example.com",
        }),
      );

      const result = await gate.validateEndpoints(
        mockTarget,
        mockMcpPath,
        mockEndpoints,
      );

      expect(result.passed).toBe(true);
      expect(
        result.details.some((d) => d.name.includes("getUsers") && d.passed),
      ).toBe(true);
    });

    it("handles network errors gracefully", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

      const mockReadFile = vi.mocked(fs.readFile);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          target: mockTarget,
          authType: "api-key",
          apiKey: "test-key",
          baseUrl: "https://api.example.com",
        }),
      );

      const result = await gate.validateEndpoints(
        mockTarget,
        mockMcpPath,
        mockEndpoints,
      );

      expect(result.passed).toBe(false);
      expect(
        result.details.some((d) => d.error?.includes("ECONNREFUSED")),
      ).toBe(true);
    });
  });

  describe("validateAuth", () => {
    it("passes when initial auth succeeds", async () => {
      const mockReadFile = vi.mocked(fs.readFile);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          target: mockTarget,
          authType: "api-key",
          apiKey: "valid-key",
          baseUrl: "https://api.example.com",
        }),
      );

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      const result = await gate.validateAuth(mockTarget);

      expect(result.phase).toBe("auth");
      expect(result.passed).toBe(true);
      expect(
        result.details.some((d) => d.name === "initial_auth" && d.passed),
      ).toBe(true);
    });

    it("fails when auth token is missing", async () => {
      const mockReadFile = vi.mocked(fs.readFile);
      mockReadFile.mockRejectedValue(new Error("ENOENT"));

      const result = await gate.validateAuth(mockTarget);

      expect(result.phase).toBe("auth");
      expect(result.passed).toBe(false);
      expect(result.details.some((d) => d.error?.includes("not found"))).toBe(
        true,
      );
    });

    it("verifies token is stored correctly", async () => {
      const mockReadFile = vi.mocked(fs.readFile);
      const futureExpiry = Date.now() + 3600000;
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          target: mockTarget,
          authType: "bearer",
          accessToken: "valid-token",
          expiresAt: futureExpiry,
          baseUrl: "https://api.example.com",
        }),
      );

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      const result = await gate.validateAuth(mockTarget);

      expect(result.passed).toBe(true);
      expect(
        result.details.some((d) => d.name === "token_stored" && d.passed),
      ).toBe(true);
    });

    it("tests refresh flow for OAuth credentials", async () => {
      const mockReadFile = vi.mocked(fs.readFile);
      const futureExpiry = Date.now() + 3600000;
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          target: mockTarget,
          authType: "oauth2",
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresAt: futureExpiry,
          baseUrl: "https://api.example.com",
        }),
      );

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 3600,
        }),
      });

      const result = await gate.validateAuth(mockTarget);

      expect(result.passed).toBe(true);
      expect(result.details.some((d) => d.name === "refresh_works")).toBe(true);
    });

    it("skips refresh test for API key auth", async () => {
      const mockReadFile = vi.mocked(fs.readFile);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          target: mockTarget,
          authType: "api-key",
          apiKey: "valid-key",
          baseUrl: "https://api.example.com",
        }),
      );

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      const result = await gate.validateAuth(mockTarget);

      expect(result.passed).toBe(true);
      // Refresh should be skipped for api-key
      expect(
        result.details.some((d) => d.name === "refresh_works" && d.passed),
      ).toBe(true);
    });
  });

  describe("validateIntegration", () => {
    it("runs CRUD workflow successfully", async () => {
      const mockReadFile = vi.mocked(fs.readFile);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          target: mockTarget,
          authType: "api-key",
          apiKey: "test-key",
          baseUrl: "https://api.example.com",
        }),
      );

      // Mock CRUD responses
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => ({ id: "123", name: "Test Item" }),
        }) // CREATE
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: "123", name: "Test Item" }),
        }) // READ
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: "123", name: "Updated Item" }),
        }) // UPDATE
        .mockResolvedValueOnce({
          ok: true,
          status: 204,
        }); // DELETE

      const result = await gate.validateIntegration(mockTarget, mockMcpPath);

      expect(result.phase).toBe("integration");
      expect(result.passed).toBe(true);
      expect(result.details.some((d) => d.name === "crud_create")).toBe(true);
      expect(result.details.some((d) => d.name === "crud_read")).toBe(true);
      expect(result.details.some((d) => d.name === "crud_update")).toBe(true);
      expect(result.details.some((d) => d.name === "crud_delete")).toBe(true);
    });

    it("respects rate limiting", async () => {
      const mockReadFile = vi.mocked(fs.readFile);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          target: mockTarget,
          authType: "api-key",
          apiKey: "test-key",
          baseUrl: "https://api.example.com",
        }),
      );

      // First request returns 429, then succeeds
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: new Map([["retry-after", "1"]]),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => ({ id: "123" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: "123" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: "123" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 204,
        });

      const result = await gate.validateIntegration(mockTarget, mockMcpPath);

      expect(result.passed).toBe(true);
      expect(
        result.details.some((d) => d.name === "rate_limiting_respected"),
      ).toBe(true);
    });

    it("handles errors gracefully", async () => {
      const mockReadFile = vi.mocked(fs.readFile);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          target: mockTarget,
          authType: "api-key",
          apiKey: "test-key",
          baseUrl: "https://api.example.com",
        }),
      );

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      const result = await gate.validateIntegration(mockTarget, mockMcpPath);

      expect(result.passed).toBe(false);
      expect(
        result.details.some((d) => d.name === "error_handling" && d.passed),
      ).toBe(true);
    });
  });

  describe("runValidation", () => {
    it("runs all validation phases in order", async () => {
      mockExecCommand.mockResolvedValue({ stdout: "", stderr: "" });

      const mockReadFile = vi.mocked(fs.readFile);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          name: "test-mcp",
          scripts: { build: "tsc" },
          main: "dist/index.js",
          target: mockTarget,
          authType: "api-key",
          apiKey: "test-key",
          baseUrl: "https://api.example.com",
        }),
      );

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      });

      const result = await gate.runValidation(mockTarget, mockMcpPath);

      expect(result.target).toBe(mockTarget);
      expect(result.phases.length).toBeGreaterThanOrEqual(4);
      expect(result.phases.map((p) => p.phase)).toContain("build");
      expect(result.phases.map((p) => p.phase)).toContain("endpoints");
      expect(result.phases.map((p) => p.phase)).toContain("auth");
      expect(result.phases.map((p) => p.phase)).toContain("integration");
    });

    it("stops on first failed phase and reports it", async () => {
      // Make build phase fail
      const error = new Error("Build failed");
      (error as any).stderr = "Compilation error";
      mockExecCommand.mockRejectedValue(error);

      const mockReadFile = vi.mocked(fs.readFile);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          name: "test-mcp",
          scripts: { build: "tsc" },
        }),
      );

      const result = await gate.runValidation(mockTarget, mockMcpPath);

      expect(result.allPassed).toBe(false);
      expect(result.failedPhase).toBe("build");
    });

    it("attempts to fix issues up to 3 times", async () => {
      let callCount = 0;
      mockExecCommand.mockImplementation(async () => {
        callCount++;
        // Fail first attempts, succeed on later ones
        if (callCount <= 9) {
          // 3 build calls per iteration (compile + import check + start)
          const error = new Error("Build failed");
          (error as any).stderr = "Compilation error";
          throw error;
        }
        return { stdout: "", stderr: "" };
      });

      const mockReadFile = vi.mocked(fs.readFile);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          name: "test-mcp",
          scripts: { build: "tsc" },
          main: "dist/index.js",
          target: mockTarget,
          authType: "api-key",
          apiKey: "test-key",
          baseUrl: "https://api.example.com",
        }),
      );

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      });

      const result = await gate.runValidation(mockTarget, mockMcpPath);

      expect(result.iterations).toBeGreaterThanOrEqual(1);
      expect(result.iterations).toBeLessThanOrEqual(3);
    });

    it("tracks total duration across all iterations", async () => {
      mockExecCommand.mockResolvedValue({ stdout: "", stderr: "" });

      const mockReadFile = vi.mocked(fs.readFile);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          name: "test-mcp",
          scripts: { build: "tsc" },
          main: "dist/index.js",
          target: mockTarget,
          authType: "api-key",
          apiKey: "test-key",
          baseUrl: "https://api.example.com",
        }),
      );

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      });

      const result = await gate.runValidation(mockTarget, mockMcpPath);

      expect(result.totalDuration).toBeGreaterThanOrEqual(0);
    });

    it("returns success when all phases pass", async () => {
      mockExecCommand.mockResolvedValue({ stdout: "Success", stderr: "" });

      const mockReadFile = vi.mocked(fs.readFile);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          name: "test-mcp",
          scripts: { build: "tsc" },
          main: "dist/index.js",
          target: mockTarget,
          authType: "api-key",
          apiKey: "test-key",
          baseUrl: "https://api.example.com",
        }),
      );

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: "123" }),
      });

      const result = await gate.runValidation(mockTarget, mockMcpPath);

      expect(result.allPassed).toBe(true);
      expect(result.failedPhase).toBeUndefined();
    });
  });

  describe("attemptFix", () => {
    it("returns true when fix is successful", async () => {
      mockExecCommand.mockResolvedValue({ stdout: "Fixed", stderr: "" });

      const failedResult: ValidationPhaseResult = {
        phase: "build",
        passed: false,
        details: [
          {
            name: "typescript_compile",
            passed: false,
            error: "Missing module",
          },
        ],
        timestamp: new Date(),
      };

      const fixed = await gate.attemptFix(failedResult, mockMcpPath);

      expect(fixed).toBe(true);
    });

    it("returns false when fix fails", async () => {
      const error = new Error("Cannot fix");
      (error as any).stderr = "Cannot fix";
      mockExecCommand.mockRejectedValue(error);

      const failedResult: ValidationPhaseResult = {
        phase: "build",
        passed: false,
        details: [
          {
            name: "typescript_compile",
            passed: false,
            error: "Unrecoverable error",
          },
        ],
        timestamp: new Date(),
      };

      const fixed = await gate.attemptFix(failedResult, mockMcpPath);

      expect(fixed).toBe(false);
    });
  });
});
