/**
 * Smart Cache for Incremental MCP Updates
 *
 * Enables thesun to:
 * 1. Skip unchanged specs (compare hashes)
 * 2. Only regenerate changed endpoints
 * 3. Store HAR captures for replay
 * 4. Preserve user modifications during updates
 */

import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import type {
  CachedSpec,
  CacheDiff,
  CacheStats,
  HarFile,
  ModifiedFile,
} from "../types/index.js";

/**
 * OpenAPI spec structure (simplified for endpoint extraction)
 */
interface OpenAPISpec {
  openapi?: string;
  swagger?: string;
  info?: {
    title?: string;
    version?: string;
  };
  paths?: Record<string, Record<string, unknown>>;
}

/**
 * SmartCache provides intelligent caching for API specifications,
 * enabling incremental updates and preserving user modifications.
 */
export class SmartCache {
  private cacheDir: string;

  /**
   * Create a new SmartCache instance
   * @param cacheDir - Base directory for cache storage (defaults to ~/.thesun/cache)
   */
  constructor(cacheDir?: string) {
    this.cacheDir =
      cacheDir ?? path.join(process.env.HOME ?? "~", ".thesun", "cache");
  }

  /**
   * Get the cache directory for a specific target
   */
  private getTargetDir(target: string): string {
    return path.join(this.cacheDir, target);
  }

  /**
   * Ensure a directory exists
   */
  private async ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
  }

  /**
   * Compute SHA256 hash of an object
   */
  private computeHash(obj: unknown): string {
    const content = JSON.stringify(obj, null, 0);
    return createHash("sha256").update(content).digest("hex");
  }

  /**
   * Extract endpoint paths from an OpenAPI spec
   */
  private extractEndpoints(spec: OpenAPISpec): string[] {
    if (!spec.paths) return [];
    return Object.keys(spec.paths);
  }

  /**
   * Extract endpoint details for comparison (includes method and operation details)
   */
  private extractEndpointDetails(
    spec: OpenAPISpec,
  ): Map<string, Record<string, unknown>> {
    const details = new Map<string, Record<string, unknown>>();
    if (!spec.paths) return details;

    for (const [path, methods] of Object.entries(spec.paths)) {
      details.set(path, methods);
    }
    return details;
  }

  // ============================================================================
  // Spec Caching
  // ============================================================================

  /**
   * Cache an API specification
   * @param target - Target API name (e.g., "stripe")
   * @param spec - The OpenAPI/Swagger spec object
   * @param specUrl - URL where the spec was fetched from
   */
  async cacheSpec(
    target: string,
    spec: OpenAPISpec,
    specUrl: string,
  ): Promise<void> {
    const targetDir = this.getTargetDir(target);
    await this.ensureDir(targetDir);

    const hash = this.computeHash(spec);
    const endpoints = this.extractEndpoints(spec);
    const version = spec.info?.version;

    const cachedSpec: CachedSpec = {
      target,
      specUrl,
      hash,
      fetchedAt: new Date(),
      version,
      endpoints,
    };

    // Save spec file
    await fs.writeFile(
      path.join(targetDir, "openapi.json"),
      JSON.stringify(spec, null, 2),
    );

    // Save hash
    await fs.writeFile(path.join(targetDir, "openapi.hash"), hash);

    // Save metadata
    await fs.writeFile(
      path.join(targetDir, "metadata.json"),
      JSON.stringify(cachedSpec, null, 2),
    );

    // Save endpoints list
    await fs.writeFile(
      path.join(targetDir, "endpoints.json"),
      JSON.stringify(endpoints, null, 2),
    );
  }

  /**
   * Get a cached spec
   * @param target - Target API name
   * @returns Cached spec metadata or null if not found
   */
  async getSpec(target: string): Promise<CachedSpec | null> {
    const targetDir = this.getTargetDir(target);
    const metadataPath = path.join(targetDir, "metadata.json");

    try {
      const content = await fs.readFile(metadataPath, "utf-8");
      return JSON.parse(content) as CachedSpec;
    } catch {
      return null;
    }
  }

  /**
   * Check if a cached spec is stale compared to a new spec
   * @param target - Target API name
   * @param newSpec - New spec to compare against
   * @returns true if the spec has changed or doesn't exist
   */
  async isSpecStale(target: string, newSpec: OpenAPISpec): Promise<boolean> {
    const cached = await this.getSpec(target);
    if (!cached) return true;

    const newHash = this.computeHash(newSpec);
    return cached.hash !== newHash;
  }

  // ============================================================================
  // Diff Calculation
  // ============================================================================

  /**
   * Calculate the difference between two specs
   * @param oldSpec - Previous spec version
   * @param newSpec - New spec version
   * @returns Diff showing added, removed, modified, and unchanged endpoints
   */
  async diffSpecs(
    oldSpec: OpenAPISpec,
    newSpec: OpenAPISpec,
  ): Promise<CacheDiff> {
    const oldDetails = this.extractEndpointDetails(oldSpec);
    const newDetails = this.extractEndpointDetails(newSpec);

    const oldPaths = new Set(oldDetails.keys());
    const newPaths = new Set(newDetails.keys());

    const added: string[] = [];
    const removed: string[] = [];
    const modified: string[] = [];
    const unchanged: string[] = [];

    // Find added and modified endpoints
    for (const path of newPaths) {
      if (!oldPaths.has(path)) {
        added.push(path);
      } else {
        const oldHash = this.computeHash(oldDetails.get(path));
        const newHash = this.computeHash(newDetails.get(path));
        if (oldHash !== newHash) {
          modified.push(path);
        } else {
          unchanged.push(path);
        }
      }
    }

    // Find removed endpoints
    for (const path of oldPaths) {
      if (!newPaths.has(path)) {
        removed.push(path);
      }
    }

    return {
      target: "", // Will be set by caller if needed
      added,
      removed,
      modified,
      unchanged,
    };
  }

  /**
   * Get list of endpoints that need to be regenerated
   * @param target - Target API name
   * @param newSpec - Optional new spec to compare against cached version. If not provided,
   *                  returns all endpoints from the cached spec (useful when spec already stored).
   * @returns List of endpoint paths that need regeneration
   */
  async getEndpointsToRegenerate(
    target: string,
    newSpec?: OpenAPISpec,
  ): Promise<string[]> {
    const targetDir = this.getTargetDir(target);
    const specPath = path.join(targetDir, "openapi.json");

    try {
      const oldSpecContent = await fs.readFile(specPath, "utf-8");
      const oldSpec = JSON.parse(oldSpecContent) as OpenAPISpec;

      // If no new spec provided, return all endpoints from cached spec
      if (!newSpec) {
        return this.extractEndpoints(oldSpec);
      }

      const diff = await this.diffSpecs(oldSpec, newSpec);
      // Return added + modified (removed endpoints don't need regeneration)
      return [...diff.added, ...diff.modified];
    } catch {
      // No cached spec
      if (newSpec) {
        // Regenerate all from new spec
        return this.extractEndpoints(newSpec);
      }
      // No cached spec and no new spec provided
      return [];
    }
  }

  // ============================================================================
  // HAR Storage
  // ============================================================================

  /**
   * Cache a HAR file for a target
   * @param target - Target API name
   * @param har - HAR file object
   */
  async cacheHar(target: string, har: HarFile): Promise<void> {
    const harDir = path.join(this.getTargetDir(target), "har-captures");
    await this.ensureDir(harDir);

    const date = new Date().toISOString().split("T")[0];
    const filename = `${date}.har`;

    await fs.writeFile(
      path.join(harDir, filename),
      JSON.stringify(har, null, 2),
    );

    // Also save as latest
    await fs.writeFile(
      path.join(harDir, "latest.har"),
      JSON.stringify(har, null, 2),
    );
  }

  /**
   * Get the most recent HAR file for a target
   * @param target - Target API name
   * @returns HAR file or null if not found
   */
  async getHar(target: string): Promise<HarFile | null> {
    const harPath = path.join(
      this.getTargetDir(target),
      "har-captures",
      "latest.har",
    );

    try {
      const content = await fs.readFile(harPath, "utf-8");
      return JSON.parse(content) as HarFile;
    } catch {
      return null;
    }
  }

  // ============================================================================
  // Cache Management
  // ============================================================================

  /**
   * Clear all cached data for a target
   * @param target - Target API name
   */
  async clearCache(target: string): Promise<void> {
    const targetDir = this.getTargetDir(target);
    try {
      await fs.rm(targetDir, { recursive: true, force: true });
    } catch {
      // Directory doesn't exist, ignore
    }
  }

  /**
   * Get cache statistics
   * @returns Cache stats including targets, size, and date ranges
   */
  async getCacheStats(): Promise<CacheStats> {
    try {
      const entries = await fs.readdir(this.cacheDir, { withFileTypes: true });
      const targets = entries.filter((e) => e.isDirectory()).map((e) => e.name);

      let totalSize = 0;
      let oldestEntry: Date | undefined;
      let newestEntry: Date | undefined;

      for (const target of targets) {
        const targetDir = this.getTargetDir(target);
        const metadataPath = path.join(targetDir, "metadata.json");

        try {
          const stat = await fs.stat(targetDir);
          // Get directory size (rough estimate)
          const files = await this.getDirSize(targetDir);
          totalSize += files;

          // Get metadata date
          const metaContent = await fs.readFile(metadataPath, "utf-8");
          const meta = JSON.parse(metaContent) as CachedSpec;
          const fetchedAt = new Date(meta.fetchedAt);

          if (!oldestEntry || fetchedAt < oldestEntry) {
            oldestEntry = fetchedAt;
          }
          if (!newestEntry || fetchedAt > newestEntry) {
            newestEntry = fetchedAt;
          }
        } catch {
          // Skip invalid entries
        }
      }

      return {
        targets,
        totalSize,
        oldestEntry,
        newestEntry,
      };
    } catch {
      return {
        targets: [],
        totalSize: 0,
      };
    }
  }

  /**
   * Get total size of a directory in bytes
   */
  private async getDirSize(dir: string): Promise<number> {
    let size = 0;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile()) {
          const stat = await fs.stat(fullPath);
          size += stat.size;
        } else if (entry.isDirectory()) {
          size += await this.getDirSize(fullPath);
        }
      }
    } catch {
      // Ignore errors
    }
    return size;
  }

  /**
   * Remove cache entries older than specified days
   * @param maxAgeDays - Maximum age in days
   * @returns Number of entries pruned
   */
  async pruneOldEntries(maxAgeDays: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);

    let pruned = 0;

    try {
      const entries = await fs.readdir(this.cacheDir, { withFileTypes: true });
      const targets = entries.filter((e) => e.isDirectory()).map((e) => e.name);

      for (const target of targets) {
        const spec = await this.getSpec(target);
        if (spec) {
          const fetchedAt = new Date(spec.fetchedAt);
          if (fetchedAt < cutoff) {
            await this.clearCache(target);
            pruned++;
          }
        }
      }
    } catch {
      // Ignore errors
    }

    return pruned;
  }

  // ============================================================================
  // User Modification Tracking
  // ============================================================================

  /**
   * Mark a file as user-modified (should be preserved during regeneration)
   * @param target - Target API name
   * @param file - Relative path to the modified file
   */
  async markAsModified(target: string, file: string): Promise<void> {
    const targetDir = this.getTargetDir(target);
    await this.ensureDir(targetDir);

    const modifiedPath = path.join(targetDir, "modified.json");
    let modified: ModifiedFile[] = [];

    try {
      const content = await fs.readFile(modifiedPath, "utf-8");
      modified = JSON.parse(content) as ModifiedFile[];
    } catch {
      // No existing file
    }

    // Add or update entry
    const existing = modified.find((m) => m.path === file);
    if (existing) {
      existing.modifiedAt = new Date();
    } else {
      modified.push({
        path: file,
        modifiedAt: new Date(),
      });
    }

    await fs.writeFile(modifiedPath, JSON.stringify(modified, null, 2));
  }

  /**
   * Get list of user-modified files for a target
   * @param target - Target API name
   * @returns List of relative file paths
   */
  async getModifiedFiles(target: string): Promise<string[]> {
    const modifiedPath = path.join(this.getTargetDir(target), "modified.json");

    try {
      const content = await fs.readFile(modifiedPath, "utf-8");
      const modified = JSON.parse(content) as ModifiedFile[];
      return modified.map((m) => m.path);
    } catch {
      return [];
    }
  }

  /**
   * Create backups of user-modified files before regeneration
   * @param target - Target API name
   */
  async preserveModifications(target: string): Promise<void> {
    const targetDir = this.getTargetDir(target);
    const generatedDir = path.join(targetDir, "generated");
    const backupDir = path.join(targetDir, "backups");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(backupDir, timestamp);

    const modifiedFiles = await this.getModifiedFiles(target);
    if (modifiedFiles.length === 0) return;

    await this.ensureDir(backupPath);

    for (const file of modifiedFiles) {
      const sourcePath = path.join(generatedDir, file);
      const destPath = path.join(backupPath, file);

      try {
        // Ensure destination directory exists
        await this.ensureDir(path.dirname(destPath));
        await fs.copyFile(sourcePath, destPath);

        // Update backup path in modified.json
        const modifiedPath = path.join(targetDir, "modified.json");
        const content = await fs.readFile(modifiedPath, "utf-8");
        const modified = JSON.parse(content) as ModifiedFile[];
        const entry = modified.find((m) => m.path === file);
        if (entry) {
          entry.backupPath = destPath;
        }
        await fs.writeFile(modifiedPath, JSON.stringify(modified, null, 2));
      } catch {
        // File doesn't exist, skip
      }
    }
  }
}
