/**
 * Smart Cache Tests
 *
 * Tests for the smart caching system that enables incremental MCP updates
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SmartCache } from "./smart-cache.js";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import type { HarFile } from "../types/index.js";

describe("SmartCache", () => {
  let cache: SmartCache;
  let testCacheDir: string;

  beforeEach(async () => {
    // Create a temporary directory for cache tests
    testCacheDir = path.join(os.tmpdir(), `thesun-cache-test-${Date.now()}`);
    await fs.mkdir(testCacheDir, { recursive: true });
    cache = new SmartCache(testCacheDir);
  });

  afterEach(async () => {
    // Clean up test directory
    await fs.rm(testCacheDir, { recursive: true, force: true });
  });

  describe("spec caching", () => {
    const testSpec = {
      openapi: "3.0.0",
      info: { title: "Test API", version: "1.0.0" },
      paths: {
        "/users": { get: { operationId: "listUsers" } },
        "/users/{id}": { get: { operationId: "getUser" } },
      },
    };

    it("should cache and retrieve a spec", async () => {
      await cache.cacheSpec("stripe", testSpec, "https://api.stripe.com/spec");

      const cached = await cache.getSpec("stripe");
      expect(cached).not.toBeNull();
      expect(cached?.target).toBe("stripe");
      expect(cached?.specUrl).toBe("https://api.stripe.com/spec");
      expect(cached?.endpoints).toContain("/users");
      expect(cached?.endpoints).toContain("/users/{id}");
    });

    it("should return null for non-existent spec", async () => {
      const cached = await cache.getSpec("nonexistent");
      expect(cached).toBeNull();
    });

    it("should include version from spec info", async () => {
      await cache.cacheSpec("stripe", testSpec, "https://api.stripe.com/spec");

      const cached = await cache.getSpec("stripe");
      expect(cached?.version).toBe("1.0.0");
    });

    it("should compute SHA256 hash of spec", async () => {
      await cache.cacheSpec("stripe", testSpec, "https://api.stripe.com/spec");

      const cached = await cache.getSpec("stripe");
      expect(cached?.hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe("staleness detection", () => {
    const oldSpec = {
      openapi: "3.0.0",
      info: { title: "Test API", version: "1.0.0" },
      paths: {
        "/users": { get: { operationId: "listUsers" } },
      },
    };

    const newSpec = {
      openapi: "3.0.0",
      info: { title: "Test API", version: "1.1.0" },
      paths: {
        "/users": { get: { operationId: "listUsers" } },
        "/orders": { post: { operationId: "createOrder" } },
      },
    };

    it("should detect stale spec when content changes", async () => {
      await cache.cacheSpec("stripe", oldSpec, "https://api.stripe.com/spec");

      const isStale = await cache.isSpecStale("stripe", newSpec);
      expect(isStale).toBe(true);
    });

    it("should not flag identical spec as stale", async () => {
      await cache.cacheSpec("stripe", oldSpec, "https://api.stripe.com/spec");

      const isStale = await cache.isSpecStale("stripe", oldSpec);
      expect(isStale).toBe(false);
    });

    it("should return true for uncached target", async () => {
      const isStale = await cache.isSpecStale("newapi", oldSpec);
      expect(isStale).toBe(true);
    });
  });

  describe("diff calculation", () => {
    const oldSpec = {
      openapi: "3.0.0",
      info: { title: "Test API", version: "1.0.0" },
      paths: {
        "/users": { get: { operationId: "listUsers" } },
        "/users/{id}": {
          get: { operationId: "getUser", summary: "Get a user" },
        },
        "/deprecated": { get: { operationId: "oldEndpoint" } },
      },
    };

    const newSpec = {
      openapi: "3.0.0",
      info: { title: "Test API", version: "1.1.0" },
      paths: {
        "/users": { get: { operationId: "listUsers" } }, // unchanged
        "/users/{id}": {
          get: { operationId: "getUser", summary: "Get a user v2" },
        }, // modified
        "/orders": { post: { operationId: "createOrder" } }, // added
        // /deprecated removed
      },
    };

    it("should detect added endpoints", async () => {
      const diff = await cache.diffSpecs(oldSpec, newSpec);
      expect(diff.added).toContain("/orders");
    });

    it("should detect removed endpoints", async () => {
      const diff = await cache.diffSpecs(oldSpec, newSpec);
      expect(diff.removed).toContain("/deprecated");
    });

    it("should detect modified endpoints", async () => {
      const diff = await cache.diffSpecs(oldSpec, newSpec);
      expect(diff.modified).toContain("/users/{id}");
    });

    it("should detect unchanged endpoints", async () => {
      const diff = await cache.diffSpecs(oldSpec, newSpec);
      expect(diff.unchanged).toContain("/users");
    });

    it("should return endpoints to regenerate for cached target", async () => {
      await cache.cacheSpec("stripe", oldSpec, "https://api.stripe.com/spec");

      const toRegenerate = await cache.getEndpointsToRegenerate(
        "stripe",
        newSpec,
      );
      expect(toRegenerate).toContain("/orders"); // added
      expect(toRegenerate).toContain("/users/{id}"); // modified
      expect(toRegenerate).not.toContain("/users"); // unchanged
      expect(toRegenerate).not.toContain("/deprecated"); // removed (no need to regenerate)
    });

    it("should return all cached endpoints when newSpec not provided", async () => {
      await cache.cacheSpec("stripe", oldSpec, "https://api.stripe.com/spec");

      const toRegenerate = await cache.getEndpointsToRegenerate("stripe");
      expect(toRegenerate).toContain("/users");
      expect(toRegenerate).toContain("/users/{id}");
      expect(toRegenerate).toContain("/deprecated");
      expect(toRegenerate).toHaveLength(3);
    });

    it("should return empty array when no cached spec and no newSpec", async () => {
      const toRegenerate = await cache.getEndpointsToRegenerate("nonexistent");
      expect(toRegenerate).toEqual([]);
    });
  });

  describe("HAR storage", () => {
    const testHar: HarFile = {
      log: {
        version: "1.2",
        creator: { name: "thesun", version: "1.0.0" },
        entries: [
          {
            request: {
              method: "GET",
              url: "https://api.example.com/users",
              headers: [{ name: "Authorization", value: "Bearer token" }],
            },
            response: {
              status: 200,
              statusText: "OK",
              headers: [{ name: "Content-Type", value: "application/json" }],
              content: { users: [] },
            },
            startedDateTime: "2025-01-23T10:00:00Z",
            time: 150,
          },
        ],
      },
    };

    it("should cache and retrieve HAR file", async () => {
      await cache.cacheHar("stripe", testHar);

      const retrieved = await cache.getHar("stripe");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.log.entries).toHaveLength(1);
      expect(retrieved?.log.entries[0].request.url).toBe(
        "https://api.example.com/users",
      );
    });

    it("should return null for non-existent HAR", async () => {
      const har = await cache.getHar("nonexistent");
      expect(har).toBeNull();
    });

    it("should store multiple HAR captures by date", async () => {
      await cache.cacheHar("stripe", testHar);
      await cache.cacheHar("stripe", {
        ...testHar,
        log: { ...testHar.log, entries: [] },
      });

      // Should get the latest one
      const retrieved = await cache.getHar("stripe");
      expect(retrieved?.log.entries).toHaveLength(0);
    });
  });

  describe("cache management", () => {
    const testSpec = {
      openapi: "3.0.0",
      info: { title: "Test API", version: "1.0.0" },
      paths: { "/users": { get: {} } },
    };

    it("should clear cache for a target", async () => {
      await cache.cacheSpec("stripe", testSpec, "https://api.stripe.com/spec");

      await cache.clearCache("stripe");

      const cached = await cache.getSpec("stripe");
      expect(cached).toBeNull();
    });

    it("should get cache stats", async () => {
      await cache.cacheSpec("stripe", testSpec, "https://api.stripe.com/spec");
      await cache.cacheSpec("jira", testSpec, "https://api.jira.com/spec");

      const stats = await cache.getCacheStats();
      expect(stats.targets).toContain("stripe");
      expect(stats.targets).toContain("jira");
      expect(stats.totalSize).toBeGreaterThan(0);
    });

    it("should prune old entries", async () => {
      await cache.cacheSpec("stripe", testSpec, "https://api.stripe.com/spec");

      // Prune entries older than -1 days (cutoff is tomorrow, so everything is older)
      // Using -1 because 0 creates race condition where entry and cutoff have same timestamp
      const pruned = await cache.pruneOldEntries(-1);
      expect(pruned).toBe(1);

      const cached = await cache.getSpec("stripe");
      expect(cached).toBeNull();
    });

    it("should not prune recent entries", async () => {
      await cache.cacheSpec("stripe", testSpec, "https://api.stripe.com/spec");

      // Prune entries older than 30 days (nothing should be pruned)
      const pruned = await cache.pruneOldEntries(30);
      expect(pruned).toBe(0);

      const cached = await cache.getSpec("stripe");
      expect(cached).not.toBeNull();
    });
  });

  describe("user modification tracking", () => {
    it("should mark file as modified", async () => {
      await cache.markAsModified("stripe", "src/tools/users.ts");

      const modified = await cache.getModifiedFiles("stripe");
      expect(modified).toContain("src/tools/users.ts");
    });

    it("should return empty array for target with no modifications", async () => {
      const modified = await cache.getModifiedFiles("stripe");
      expect(modified).toEqual([]);
    });

    it("should track multiple modified files", async () => {
      await cache.markAsModified("stripe", "src/tools/users.ts");
      await cache.markAsModified("stripe", "src/tools/orders.ts");

      const modified = await cache.getModifiedFiles("stripe");
      expect(modified).toHaveLength(2);
      expect(modified).toContain("src/tools/users.ts");
      expect(modified).toContain("src/tools/orders.ts");
    });

    it("should preserve modifications during regeneration", async () => {
      // Create a mock file to back up
      const targetDir = path.join(testCacheDir, "stripe", "generated");
      await fs.mkdir(targetDir, { recursive: true });
      const testFile = path.join(targetDir, "custom.ts");
      await fs.writeFile(testFile, "// user modifications");

      await cache.markAsModified("stripe", "custom.ts");
      await cache.preserveModifications("stripe");

      // Check backup exists
      const backupDir = path.join(testCacheDir, "stripe", "backups");
      const backupFiles = await fs.readdir(backupDir);
      expect(backupFiles.length).toBeGreaterThan(0);
    });
  });
});
