import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";

// Mock fs, os modules before importing the module under test
vi.mock("fs", async () => {
  const actual = await vi.importActual("fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

vi.mock("os", async () => {
  const actual = await vi.importActual("os");
  return {
    ...actual,
    homedir: vi.fn(() => "/mock/home"),
    platform: vi.fn(() => "darwin"),
  };
});

// Import after mocking
import {
  DependencyChecker,
  getDependencyChecker,
} from "./dependency-checker.js";
import type { DependencyStatus, PreflightCheckResult } from "../types/index.js";

describe("DependencyChecker", () => {
  let checker: DependencyChecker;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset singleton for each test
    checker = new DependencyChecker();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("checkPlaywrightMcp", () => {
    it("returns available=true when Playwright plugin is installed", async () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        if (
          typeof path === "string" &&
          path.includes("external_plugins/playwright")
        ) {
          return true;
        }
        return false;
      });

      const result = await checker.checkPlaywrightMcp();

      expect(result.name).toBe("playwright-mcp");
      expect(result.required).toBe(true);
      expect(result.available).toBe(true);
      expect(result.version).toBe("plugin");
    });

    it("returns available=true when playwright is in user-mcps.json", async () => {
      const mockConfig = {
        mcpServers: {
          playwright: {
            command: "npx",
            args: ["@playwright/mcp@latest", "--browser", "firefox"],
          },
        },
      };

      vi.mocked(existsSync).mockImplementation((path) => {
        if (typeof path === "string" && path.includes("user-mcps.json")) {
          return true;
        }
        return false;
      });
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockConfig));

      const result = await checker.checkPlaywrightMcp();

      expect(result.name).toBe("playwright-mcp");
      expect(result.required).toBe(true);
      expect(result.available).toBe(true);
    });

    it("returns available=false with install command when playwright is missing", async () => {
      const mockConfig = {
        mcpServers: {
          "other-mcp": {
            command: "node",
            args: ["/path/to/other-mcp/index.js"],
          },
        },
      };

      vi.mocked(existsSync).mockImplementation((path) => {
        if (typeof path === "string" && path.includes("user-mcps.json")) {
          return true;
        }
        return false;
      });
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockConfig));

      const result = await checker.checkPlaywrightMcp();

      expect(result.name).toBe("playwright-mcp");
      expect(result.required).toBe(true);
      expect(result.available).toBe(false);
      expect(result.installCommand).toBeDefined();
      expect(result.installCommand).toContain("playwright");
      expect(result.installCommand).toContain("firefox");
    });

    it("returns available=false when user-mcps.json does not exist and no plugin", async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = await checker.checkPlaywrightMcp();

      expect(result.name).toBe("playwright-mcp");
      expect(result.available).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("handles malformed JSON in user-mcps.json", async () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        if (typeof path === "string" && path.includes("user-mcps.json")) {
          return true;
        }
        return false;
      });
      vi.mocked(readFileSync).mockReturnValue("{ invalid json }");

      const result = await checker.checkPlaywrightMcp();

      expect(result.available).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("checkFirefoxBrowser", () => {
    it("detects Firefox on macOS (required for Playwright --browser firefox)", async () => {
      vi.mocked(platform).mockReturnValue("darwin");
      vi.mocked(existsSync).mockImplementation((path) => {
        if (typeof path === "string" && path.includes("Firefox.app")) {
          return true;
        }
        return false;
      });

      const result = await checker.checkFirefoxBrowser();

      expect(result.name).toBe("firefox-browser");
      expect(result.available).toBe(true);
    });

    it("detects Firefox on Linux", async () => {
      vi.mocked(platform).mockReturnValue("linux");
      vi.mocked(existsSync).mockImplementation((path) => {
        if (typeof path === "string" && path.includes("/usr/bin/firefox")) {
          return true;
        }
        return false;
      });

      const result = await checker.checkFirefoxBrowser();

      expect(result.name).toBe("firefox-browser");
      expect(result.available).toBe(true);
    });

    it("detects Firefox on Windows", async () => {
      vi.mocked(platform).mockReturnValue("win32");
      vi.mocked(existsSync).mockImplementation((path) => {
        if (typeof path === "string" && path.includes("firefox.exe")) {
          return true;
        }
        return false;
      });

      const result = await checker.checkFirefoxBrowser();

      expect(result.name).toBe("firefox-browser");
      expect(result.available).toBe(true);
    });

    it("returns available=false when Firefox is not found", async () => {
      vi.mocked(platform).mockReturnValue("darwin");
      vi.mocked(existsSync).mockReturnValue(false);

      const result = await checker.checkFirefoxBrowser();

      expect(result.name).toBe("firefox-browser");
      expect(result.available).toBe(false);
      expect(result.installCommand).toBeDefined();
    });
  });

  describe("checkThesunDirectory", () => {
    it("returns available=true when directory structure exists", async () => {
      vi.mocked(existsSync).mockReturnValue(true);

      const result = await checker.checkThesunDirectory();

      expect(result.name).toBe("thesun-directory");
      expect(result.available).toBe(true);
    });

    it("creates directory structure if missing and returns available=true", async () => {
      // First call for main dir returns false, subsequent calls return true (after creation)
      let callCount = 0;
      vi.mocked(existsSync).mockImplementation(() => {
        callCount++;
        return callCount > 1; // First call returns false, rest return true
      });
      vi.mocked(mkdirSync).mockReturnValue(undefined);

      const result = await checker.checkThesunDirectory();

      expect(result.name).toBe("thesun-directory");
      expect(result.available).toBe(true);
      expect(mkdirSync).toHaveBeenCalled();
    });

    it("creates all required subdirectories", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(mkdirSync).mockReturnValue(undefined);

      await checker.checkThesunDirectory();

      // Should create credentials, cache, patterns, health subdirs
      expect(mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining("credentials"),
        expect.any(Object),
      );
      expect(mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining("cache"),
        expect.any(Object),
      );
      expect(mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining("patterns"),
        expect.any(Object),
      );
      expect(mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining("health"),
        expect.any(Object),
      );
    });

    it("handles directory creation errors gracefully", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(mkdirSync).mockImplementation(() => {
        throw new Error("Permission denied");
      });

      const result = await checker.checkThesunDirectory();

      expect(result.available).toBe(false);
      expect(result.error).toContain("Permission denied");
    });
  });

  describe("runPreflight", () => {
    it("passes when all dependencies are available", async () => {
      const mockConfig = {
        mcpServers: {
          playwright: {
            command: "npx",
            args: ["@playwright/mcp@latest", "--browser", "firefox"],
          },
        },
      };

      vi.mocked(platform).mockReturnValue("darwin");
      vi.mocked(existsSync).mockImplementation((path) => {
        if (typeof path === "string") {
          if (path.includes("user-mcps.json")) return true;
          if (path.includes("Firefox.app")) return true;
          if (path.includes(".thesun")) return true;
        }
        return false;
      });
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockConfig));

      const result = await checker.runPreflight();

      expect(result.passed).toBe(true);
      expect(result.missingRequired).toHaveLength(0);
      expect(result.dependencies).toHaveLength(3);
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it("fails when playwright-mcp is missing", async () => {
      const mockConfig = {
        mcpServers: {},
      };

      vi.mocked(platform).mockReturnValue("darwin");
      vi.mocked(existsSync).mockImplementation((path) => {
        if (typeof path === "string") {
          // user-mcps.json exists
          if (path.includes("user-mcps.json")) return true;
          // Firefox exists
          if (path.includes("Firefox.app")) return true;
          // thesun directory exists
          if (path.includes(".thesun")) return true;
        }
        return false;
      });
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockConfig));

      const result = await checker.runPreflight();

      expect(result.passed).toBe(false);
      expect(result.missingRequired).toContain("playwright-mcp");
    });

    it("includes all dependency statuses in result", async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = await checker.runPreflight();

      const dependencyNames = result.dependencies.map((d) => d.name);
      expect(dependencyNames).toContain("playwright-mcp");
      expect(dependencyNames).toContain("firefox-browser");
      expect(dependencyNames).toContain("thesun-directory");
    });
  });

  describe("formatMissingDependencies", () => {
    it("returns user-friendly error message", () => {
      const result: PreflightCheckResult = {
        passed: false,
        dependencies: [
          {
            name: "playwright-mcp",
            required: true,
            available: false,
            installCommand:
              "Install via: npx @playwright/mcp@latest --browser firefox",
          },
          {
            name: "firefox-browser",
            required: true,
            available: false,
            installCommand: "brew install --cask firefox",
          },
        ],
        missingRequired: ["playwright-mcp", "firefox-browser"],
        timestamp: new Date(),
      };

      const message = checker.formatMissingDependencies(result);

      expect(message).toContain("Missing required dependencies");
      expect(message).toContain("playwright-mcp");
      expect(message).toContain("firefox-browser");
      expect(message).toContain("brew install");
    });

    it("returns empty string when all dependencies available", () => {
      const result: PreflightCheckResult = {
        passed: true,
        dependencies: [
          {
            name: "playwright-mcp",
            required: true,
            available: true,
          },
        ],
        missingRequired: [],
        timestamp: new Date(),
      };

      const message = checker.formatMissingDependencies(result);

      expect(message).toBe("");
    });
  });

  describe("getDependencyChecker (singleton)", () => {
    it("returns the same instance on multiple calls", () => {
      const instance1 = getDependencyChecker();
      const instance2 = getDependencyChecker();

      expect(instance1).toBe(instance2);
    });
  });
});
