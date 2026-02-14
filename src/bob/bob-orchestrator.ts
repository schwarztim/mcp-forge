/**
 * Bob Orchestrator
 *
 * Manages background execution and rotation of Bob instances.
 * Key features:
 * - Background task execution with parent-child relationships
 * - Plugin refresh/rotation to use latest updates
 * - Sub-bob tracking for watchers to monitor
 * - Automatic cleanup of stale instances
 *
 * Philosophy: Each major task gets a "parent bob", which can spawn
 * "child bobs" (sub-bobs) for sub-tasks. The watcher sees all levels.
 */

import { EventEmitter } from 'events';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { BobInstanceManager, BobInstanceConfig, getBobManager } from './instance-manager.js';
import { BobInstance, BuildPhase } from '../types/index.js';
import { logger } from '../observability/logger.js';

/**
 * Sub-bob task definition
 */
export interface SubBobTask {
  id: string;
  parentBobId: string;
  name: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  result?: string;
  error?: string;
}

/**
 * Bob hierarchy (parent with children)
 */
export interface BobHierarchy {
  parentBob: BobInstance;
  subBobs: SubBobTask[];
  currentPhase: BuildPhase;
  pluginVersion: string;
  lastRefreshed: Date;
}

/**
 * Plugin version info
 */
interface PluginVersion {
  version: string;
  path: string;
  timestamp: Date;
}

/**
 * Bob Orchestrator
 */
export class BobOrchestrator extends EventEmitter {
  private manager: BobInstanceManager;
  private hierarchies: Map<string, BobHierarchy> = new Map();
  private subBobs: Map<string, SubBobTask> = new Map();
  private pluginPath: string;
  private currentPluginVersion: PluginVersion | null = null;
  private refreshCheckInterval: NodeJS.Timeout | null = null;

  constructor(options: {
    manager?: BobInstanceManager;
    pluginPath?: string;
    checkIntervalMs?: number;
  } = {}) {
    super();
    this.manager = options.manager ?? getBobManager();
    this.pluginPath = options.pluginPath ?? join(process.cwd(), '.claude-plugin');

    // Start background plugin check
    const checkInterval = options.checkIntervalMs ?? 30000; // 30 seconds
    this.startPluginWatcher(checkInterval);
  }

  /**
   * Create a parent bob for a build job
   */
  async createParentBob(config: BobInstanceConfig): Promise<BobHierarchy> {
    const parentBob = await this.manager.create(config);

    // Copy current plugin to bob's workspace
    await this.syncPluginToBob(parentBob);

    const hierarchy: BobHierarchy = {
      parentBob,
      subBobs: [],
      currentPhase: 'pending',
      pluginVersion: this.currentPluginVersion?.version ?? 'unknown',
      lastRefreshed: new Date(),
    };

    this.hierarchies.set(parentBob.id, hierarchy);

    logger.info('Created parent bob with hierarchy tracking', {
      parentBobId: parentBob.id,
      toolName: config.toolName,
      pluginVersion: hierarchy.pluginVersion,
    });

    this.emit('parentBobCreated', hierarchy);
    return hierarchy;
  }

  /**
   * Spawn a sub-bob for a specific task under a parent
   */
  async spawnSubBob(
    parentBobId: string,
    task: { name: string; description: string }
  ): Promise<SubBobTask> {
    const hierarchy = this.hierarchies.get(parentBobId);
    if (!hierarchy) {
      throw new Error(`Parent bob not found: ${parentBobId}`);
    }

    const subBob: SubBobTask = {
      id: crypto.randomUUID(),
      parentBobId,
      name: task.name,
      description: task.description,
      status: 'pending',
      createdAt: new Date(),
    };

    hierarchy.subBobs.push(subBob);
    this.subBobs.set(subBob.id, subBob);

    logger.info('Spawned sub-bob', {
      subBobId: subBob.id,
      parentBobId,
      name: task.name,
    });

    this.emit('subBobSpawned', { parentBobId, subBob });
    return subBob;
  }

  /**
   * Execute a sub-bob task
   */
  async executeSubBob(
    subBobId: string,
    prompt: string,
    options: { phase?: BuildPhase; timeout?: number } = {}
  ): Promise<string> {
    const subBob = this.subBobs.get(subBobId);
    if (!subBob) {
      throw new Error(`Sub-bob not found: ${subBobId}`);
    }

    const hierarchy = this.hierarchies.get(subBob.parentBobId);
    if (!hierarchy) {
      throw new Error(`Parent bob not found: ${subBob.parentBobId}`);
    }

    // Update status
    subBob.status = 'running';
    subBob.startedAt = new Date();
    this.emit('subBobStarted', { subBob });

    try {
      const result = await this.manager.execute(
        hierarchy.parentBob.id,
        prompt,
        options
      );

      subBob.status = 'completed';
      subBob.completedAt = new Date();
      subBob.result = result.stdout;

      this.emit('subBobCompleted', { subBob });

      logger.info('Sub-bob completed', {
        subBobId,
        name: subBob.name,
        duration: subBob.completedAt.getTime() - (subBob.startedAt?.getTime() ?? 0),
      });

      return result.stdout;
    } catch (error) {
      subBob.status = 'failed';
      subBob.completedAt = new Date();
      subBob.error = error instanceof Error ? error.message : String(error);

      this.emit('subBobFailed', { subBob, error });

      logger.error('Sub-bob failed', {
        subBobId,
        name: subBob.name,
        error: subBob.error,
      });

      throw error;
    }
  }

  /**
   * Refresh a bob to use the latest plugin
   */
  async refreshBob(bobId: string): Promise<void> {
    const hierarchy = this.hierarchies.get(bobId);
    if (!hierarchy) {
      throw new Error(`Bob hierarchy not found: ${bobId}`);
    }

    // Check if refresh is needed
    if (
      this.currentPluginVersion &&
      hierarchy.pluginVersion === this.currentPluginVersion.version
    ) {
      logger.debug('Bob already on latest plugin version', {
        bobId,
        version: hierarchy.pluginVersion,
      });
      return;
    }

    logger.info('Refreshing bob with latest plugin', {
      bobId,
      oldVersion: hierarchy.pluginVersion,
      newVersion: this.currentPluginVersion?.version,
    });

    // Sync new plugin to bob's workspace
    await this.syncPluginToBob(hierarchy.parentBob);

    // Update hierarchy
    hierarchy.pluginVersion = this.currentPluginVersion?.version ?? 'unknown';
    hierarchy.lastRefreshed = new Date();

    this.emit('bobRefreshed', { bobId, hierarchy });
  }

  /**
   * Get all sub-bobs for a parent
   */
  getSubBobs(parentBobId: string): SubBobTask[] {
    const hierarchy = this.hierarchies.get(parentBobId);
    return hierarchy?.subBobs ?? [];
  }

  /**
   * Get hierarchy for watcher visibility
   */
  getHierarchy(parentBobId: string): BobHierarchy | undefined {
    return this.hierarchies.get(parentBobId);
  }

  /**
   * Get all hierarchies (for global visibility)
   */
  getAllHierarchies(): Map<string, BobHierarchy> {
    return this.hierarchies;
  }

  /**
   * Update the phase for a bob hierarchy
   */
  updatePhase(bobId: string, phase: BuildPhase): void {
    const hierarchy = this.hierarchies.get(bobId);
    if (hierarchy) {
      hierarchy.currentPhase = phase;
      this.emit('phaseChanged', { bobId, phase });
    }
  }

  /**
   * Clean up a bob and its sub-bobs
   */
  async cleanup(bobId: string, keepWorkspace: boolean = false): Promise<void> {
    const hierarchy = this.hierarchies.get(bobId);
    if (!hierarchy) {
      return;
    }

    // Clean up sub-bobs
    for (const subBob of hierarchy.subBobs) {
      this.subBobs.delete(subBob.id);
    }

    // Destroy the parent bob
    await this.manager.destroy(bobId, { keepWorkspace });

    // Remove hierarchy
    this.hierarchies.delete(bobId);

    logger.info('Cleaned up bob hierarchy', {
      bobId,
      subBobCount: hierarchy.subBobs.length,
    });
  }

  /**
   * Shutdown the orchestrator
   */
  async shutdown(): Promise<void> {
    // Stop plugin watcher
    if (this.refreshCheckInterval) {
      clearInterval(this.refreshCheckInterval);
      this.refreshCheckInterval = null;
    }

    // Clean up all hierarchies
    for (const [bobId] of this.hierarchies) {
      await this.cleanup(bobId);
    }

    logger.info('Bob orchestrator shut down');
  }

  // === Private Methods ===

  /**
   * Start watching for plugin updates
   */
  private startPluginWatcher(intervalMs: number): void {
    // Initial plugin version check
    this.checkPluginVersion();

    // Start periodic checks
    this.refreshCheckInterval = setInterval(() => {
      this.checkPluginVersion();
    }, intervalMs);

    logger.info('Plugin watcher started', { intervalMs });
  }

  /**
   * Check for plugin version updates
   */
  private checkPluginVersion(): void {
    try {
      const pluginJsonPath = join(this.pluginPath, 'plugin.json');
      if (!existsSync(pluginJsonPath)) {
        return;
      }

      const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
      const version = pluginJson.version ?? 'unknown';
      const stat = require('fs').statSync(pluginJsonPath);

      const newVersion: PluginVersion = {
        version,
        path: this.pluginPath,
        timestamp: stat.mtime,
      };

      // Check if version changed
      if (
        !this.currentPluginVersion ||
        this.currentPluginVersion.version !== newVersion.version ||
        this.currentPluginVersion.timestamp.getTime() !== newVersion.timestamp.getTime()
      ) {
        const oldVersion = this.currentPluginVersion?.version;
        this.currentPluginVersion = newVersion;

        logger.info('Plugin version updated', {
          oldVersion,
          newVersion: version,
        });

        this.emit('pluginUpdated', { oldVersion, newVersion: version });

        // Notify all bobs to refresh
        for (const [bobId] of this.hierarchies) {
          this.emit('refreshNeeded', { bobId, newVersion: version });
        }
      }
    } catch (error) {
      logger.error('Failed to check plugin version', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Sync plugin files to a bob's workspace
   */
  private async syncPluginToBob(bob: BobInstance): Promise<void> {
    const targetDir = join(bob.workspace, '.claude-plugin');

    // Create target directory
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    // Copy plugin files
    if (existsSync(this.pluginPath)) {
      this.copyDirRecursive(this.pluginPath, targetDir);
    }

    logger.debug('Synced plugin to bob workspace', {
      bobId: bob.id,
      pluginPath: this.pluginPath,
      targetDir,
    });
  }

  /**
   * Recursively copy directory
   */
  private copyDirRecursive(src: string, dest: string): void {
    if (!existsSync(dest)) {
      mkdirSync(dest, { recursive: true });
    }

    const entries = readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);

      if (entry.isDirectory()) {
        this.copyDirRecursive(srcPath, destPath);
      } else {
        const content = readFileSync(srcPath);
        writeFileSync(destPath, content);
      }
    }
  }
}

// Singleton instance
let orchestrator: BobOrchestrator | null = null;

export function getBobOrchestrator(options?: {
  pluginPath?: string;
  checkIntervalMs?: number;
}): BobOrchestrator {
  if (!orchestrator) {
    orchestrator = new BobOrchestrator(options);
  }
  return orchestrator;
}

/**
 * Sub-bob status summary for watchers
 */
export interface SubBobSummary {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

/**
 * Get summary of sub-bobs for a parent
 */
export function getSubBobSummary(orchestrator: BobOrchestrator, parentBobId: string): SubBobSummary {
  const subBobs = orchestrator.getSubBobs(parentBobId);

  return {
    total: subBobs.length,
    pending: subBobs.filter((s) => s.status === 'pending').length,
    running: subBobs.filter((s) => s.status === 'running').length,
    completed: subBobs.filter((s) => s.status === 'completed').length,
    failed: subBobs.filter((s) => s.status === 'failed').length,
  };
}
