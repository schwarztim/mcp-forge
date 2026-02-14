/**
 * Bob Instance Manager
 *
 * Manages isolated Claude Code sessions for parallel tool builds.
 * Each instance has:
 * - Git worktree for isolated code changes (parallel-safe)
 * - Inherited MCP servers from user config (Confluence, Jira, etc.)
 * - Inherited plugins from user plugin directories
 * - Separate workspace directory
 * - Isolated environment variables (except HOME - preserves MCP access)
 * - No cross-contamination between builds
 *
 * Key Features:
 * - Git worktrees enable multiple Claude sessions on same repo
 * - MCP inheritance allows searching Confluence, Jira, etc.
 * - Plugin inheritance allows using thesun's own tools recursively
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { BobInstance } from '../types/index.js';
import { logger, createBuildLogger } from '../observability/logger.js';
import { selectModelForPhase } from '../agents/model-selector.js';
import { BuildPhase } from '../types/index.js';

/**
 * Configuration for creating a new Bob instance
 */
export interface BobInstanceConfig {
  toolName: string;
  workspace?: string;
  env?: Record<string, string>;
  model?: 'opus' | 'sonnet' | 'haiku';
  /** Git repo to create worktree from (for parallel sessions) */
  gitRepo?: string;
  /** Branch name for the worktree */
  branch?: string;
  /** Inherit MCP servers from user config */
  inheritMcpServers?: boolean;
  /** Inherit plugins from user plugin directories */
  inheritPlugins?: boolean;
  /** Additional MCP config paths to load */
  mcpConfigPaths?: string[];
  /** Additional plugin directories */
  pluginDirs?: string[];
}

/**
 * User's Claude configuration paths
 */
interface UserClaudeConfig {
  mcpConfigPath: string;
  pluginDirs: string[];
  home: string;
}

/**
 * Detect user's Claude configuration from alias or defaults
 */
function detectUserClaudeConfig(): UserClaudeConfig {
  const home = homedir();
  const defaultMcpConfig = join(home, '.claude', 'user-mcps.json');
  const defaultPluginDir = join(home, 'Scripts', 'thesun');

  // Try to read from zshrc alias
  try {
    const zshrc = readFileSync(join(home, '.zshrc'), 'utf-8');
    const aliasMatch = zshrc.match(/alias\s+claude\s*=\s*['"]([^'"]+)['"]/);

    if (aliasMatch) {
      const alias = aliasMatch[1];
      const mcpMatch = alias.match(/--mcp-config\s+([^\s]+)/);
      const pluginMatch = alias.match(/--plugin-dir\s+([^\s]+)/);

      return {
        mcpConfigPath: mcpMatch ? mcpMatch[1].replace('~', home) : defaultMcpConfig,
        pluginDirs: pluginMatch ? [pluginMatch[1].replace('~', home)] : [defaultPluginDir],
        home,
      };
    }
  } catch {
    // Ignore errors reading zshrc
  }

  return {
    mcpConfigPath: defaultMcpConfig,
    pluginDirs: [defaultPluginDir],
    home,
  };
}

/**
 * Bob Instance Manager
 */
export class BobInstanceManager {
  private instances: Map<string, BobInstance> = new Map();
  private processes: Map<string, ChildProcess> = new Map();
  private worktrees: Map<string, { gitRepo: string; workspace: string }> = new Map();
  private baseWorkspace: string;
  private claudePath: string;
  private userConfig: UserClaudeConfig;
  private defaultInheritMcp: boolean;
  private defaultInheritPlugins: boolean;

  constructor(options: {
    baseWorkspace?: string;
    claudePath?: string;
    inheritMcpServers?: boolean;
    inheritPlugins?: boolean;
  } = {}) {
    this.baseWorkspace = options.baseWorkspace ?? '/tmp/thesun/builds';
    this.claudePath = options.claudePath ?? 'claude';
    this.defaultInheritMcp = options.inheritMcpServers ?? true;
    this.defaultInheritPlugins = options.inheritPlugins ?? true;
    this.userConfig = detectUserClaudeConfig();

    // Ensure base workspace exists
    if (!existsSync(this.baseWorkspace)) {
      mkdirSync(this.baseWorkspace, { recursive: true });
    }

    logger.info('Bob Instance Manager initialized', {
      baseWorkspace: this.baseWorkspace,
      mcpConfigPath: this.userConfig.mcpConfigPath,
      pluginDirs: this.userConfig.pluginDirs,
      inheritMcp: this.defaultInheritMcp,
      inheritPlugins: this.defaultInheritPlugins,
    });
  }

  /**
   * Run git command safely using execFileSync (no shell injection)
   */
  private runGitCommand(args: string[], cwd: string): { success: boolean; output: string } {
    try {
      const { execFileSync } = require('child_process');
      const output = execFileSync('git', args, {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { success: true, output: output.toString() };
    } catch (error) {
      return {
        success: false,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Create a git worktree for parallel development
   */
  private createWorktree(gitRepo: string, workspace: string, branch?: string): boolean {
    // Check if gitRepo is a git repository
    const checkResult = this.runGitCommand(['rev-parse', '--git-dir'], gitRepo);
    if (!checkResult.success) {
      logger.warn('Not a git repository, skipping worktree', { gitRepo });
      return false;
    }

    // Create unique branch name if not provided
    const worktreeBranch = branch ?? `bob-${crypto.randomUUID().slice(0, 8)}`;

    // Create the worktree with -B to force create branch
    const createResult = this.runGitCommand(
      ['worktree', 'add', '-B', worktreeBranch, workspace],
      gitRepo
    );

    if (createResult.success) {
      logger.info('Created git worktree', {
        gitRepo,
        workspace,
        branch: worktreeBranch,
      });
      return true;
    }

    logger.warn('Git worktree creation failed', {
      gitRepo,
      workspace,
      error: createResult.output,
    });
    return false;
  }

  /**
   * Remove a git worktree
   */
  private removeWorktree(gitRepo: string, workspace: string): void {
    const result = this.runGitCommand(['worktree', 'remove', workspace, '--force'], gitRepo);
    if (result.success) {
      logger.info('Removed git worktree', { workspace });
    } else {
      logger.warn('Failed to remove git worktree', {
        workspace,
        error: result.output,
      });
    }
  }

  /**
   * Copy directory recursively, excluding patterns
   */
  private copyDirRecursive(src: string, dest: string, exclude: string[] = []): void {
    if (!existsSync(dest)) {
      mkdirSync(dest, { recursive: true });
    }

    const entries = readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      if (exclude.includes(entry.name)) continue;

      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);

      if (entry.isDirectory()) {
        this.copyDirRecursive(srcPath, destPath, exclude);
      } else {
        const { copyFileSync } = require('fs');
        copyFileSync(srcPath, destPath);
      }
    }
  }

  /**
   * Create a new isolated Bob instance
   *
   * Features:
   * - Git worktree support for parallel sessions on same repo
   * - MCP server inheritance (Confluence, Jira, etc.)
   * - Plugin inheritance (thesun itself, etc.)
   * - Preserves HOME to maintain MCP access
   */
  async create(config: BobInstanceConfig): Promise<BobInstance> {
    const id = crypto.randomUUID();
    const workspace = config.workspace ?? join(this.baseWorkspace, `${config.toolName}-${id.slice(0, 8)}`);

    // Determine if we should use git worktree
    const useWorktree = config.gitRepo && existsSync(config.gitRepo);

    if (useWorktree) {
      // Create git worktree for parallel development
      const worktreeCreated = this.createWorktree(config.gitRepo!, workspace, config.branch);
      if (worktreeCreated) {
        this.worktrees.set(id, { gitRepo: config.gitRepo!, workspace });
      } else {
        // Fall back to copying directory
        if (!existsSync(workspace)) {
          mkdirSync(workspace, { recursive: true });
        }
        this.copyDirRecursive(config.gitRepo!, workspace, ['.git', 'node_modules', 'dist']);
      }
    } else {
      // Create isolated workspace
      if (!existsSync(workspace)) {
        mkdirSync(workspace, { recursive: true });
      }
    }

    // Create instance-specific .claude directory for settings
    const claudeDir = join(workspace, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    // Write instance-specific settings
    const settings = {
      model: config.model ?? 'sonnet',
      workspace,
      toolName: config.toolName,
      instanceId: id,
    };
    writeFileSync(join(claudeDir, 'settings.local.json'), JSON.stringify(settings, null, 2));

    // Determine MCP inheritance
    const inheritMcp = config.inheritMcpServers ?? this.defaultInheritMcp;
    const inheritPlugins = config.inheritPlugins ?? this.defaultInheritPlugins;

    // Build MCP config paths
    const mcpConfigPaths: string[] = [];
    if (inheritMcp && existsSync(this.userConfig.mcpConfigPath)) {
      mcpConfigPaths.push(this.userConfig.mcpConfigPath);
    }
    if (config.mcpConfigPaths) {
      mcpConfigPaths.push(...config.mcpConfigPaths.filter(existsSync));
    }

    // Build plugin directories
    const pluginDirs: string[] = [];
    if (inheritPlugins) {
      pluginDirs.push(...this.userConfig.pluginDirs.filter(existsSync));
    }
    if (config.pluginDirs) {
      pluginDirs.push(...config.pluginDirs.filter(existsSync));
    }

    // Build environment - IMPORTANT: Do NOT override HOME
    // This preserves access to user's MCP servers and plugins
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      // Workspace isolation (but keep HOME intact for MCP access)
      THESUN_WORKSPACE: workspace,
      THESUN_TOOL_NAME: config.toolName,
      THESUN_INSTANCE_ID: id,
      // Track MCP and plugin paths for this instance
      THESUN_MCP_CONFIGS: mcpConfigPaths.join(':'),
      THESUN_PLUGIN_DIRS: pluginDirs.join(':'),
      // Custom env vars from config
      ...config.env,
    };

    // Extended instance with MCP/plugin info
    const instance: BobInstance & {
      mcpConfigPaths?: string[];
      pluginDirs?: string[];
      useWorktree?: boolean;
    } = {
      id,
      toolName: config.toolName,
      workspace,
      env,
      status: 'creating',
      createdAt: new Date(),
      mcpConfigPaths,
      pluginDirs,
      useWorktree: !!(useWorktree && this.worktrees.has(id)),
    };

    this.instances.set(id, instance);

    logger.info('Created Bob instance', {
      instanceId: id,
      toolName: config.toolName,
      workspace,
      useWorktree: instance.useWorktree,
      mcpConfigPaths,
      pluginDirs,
      inheritMcp,
      inheritPlugins,
    });

    // Update status to running
    instance.status = 'running';
    this.instances.set(id, instance);

    return instance;
  }

  /**
   * Execute a command in the Bob instance
   *
   * Key features:
   * - Passes --mcp-config to enable MCP server access (Confluence, Jira, etc.)
   * - Passes --plugin-dir to enable plugin access (thesun tools, etc.)
   * - Uses --dangerously-skip-permissions for autonomous operation
   */
  async execute(
    instanceId: string,
    prompt: string,
    options: { phase?: BuildPhase; timeout?: number } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const instance = this.instances.get(instanceId) as BobInstance & {
      mcpConfigPaths?: string[];
      pluginDirs?: string[];
    };
    if (!instance) {
      throw new Error(`Bob instance not found: ${instanceId}`);
    }

    const buildLogger = createBuildLogger(instanceId, instance.toolName);

    // Select model based on phase
    const model = options.phase
      ? selectModelForPhase(options.phase)
      : 'sonnet';

    // Build claude arguments with MCP and plugin support
    const claudeArgs: string[] = [
      '-p', prompt,
      '--model', model,
      '--dangerously-skip-permissions', // Enable autonomous operation
    ];

    // Add MCP config paths
    if (instance.mcpConfigPaths && instance.mcpConfigPaths.length > 0) {
      // Claude only supports one --mcp-config, so use the first one
      claudeArgs.push('--mcp-config', instance.mcpConfigPaths[0]);
    }

    // Add plugin directories
    if (instance.pluginDirs && instance.pluginDirs.length > 0) {
      // Claude only supports one --plugin-dir, so use the first one
      claudeArgs.push('--plugin-dir', instance.pluginDirs[0]);
    }

    buildLogger.info('Executing in Bob instance', {
      model,
      phase: options.phase,
      promptLength: prompt.length,
      mcpConfigPaths: instance.mcpConfigPaths,
      pluginDirs: instance.pluginDirs,
      claudeArgs: claudeArgs.filter(arg => !arg.includes(prompt)), // Log args without prompt
    });

    return new Promise((resolve, reject) => {
      const timeout = options.timeout ?? 300000; // 5 minutes default

      // Spawn claude with MCP/plugin support
      const child = spawn(this.claudePath, claudeArgs, {
        cwd: instance.workspace,
        env: instance.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.processes.set(instanceId, child);

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Execution timeout after ${timeout}ms`));
      }, timeout);

      child.on('close', (code) => {
        clearTimeout(timer);
        this.processes.delete(instanceId);

        // Update last activity
        instance.lastActivityAt = new Date();
        this.instances.set(instanceId, instance);

        buildLogger.info(`Execution completed`, {
          exitCode: code,
          stdoutLength: stdout.length,
          stderrLength: stderr.length,
        });

        resolve({
          stdout,
          stderr,
          exitCode: code ?? 0,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        this.processes.delete(instanceId);
        buildLogger.error(`Execution error`, { error: err.message });
        reject(err);
      });
    });
  }

  /**
   * Execute a multi-turn conversation (for iterative work)
   */
  async executeConversation(
    instanceId: string,
    prompts: string[],
    options: { phase?: BuildPhase; timeout?: number } = {}
  ): Promise<string[]> {
    const results: string[] = [];

    for (const prompt of prompts) {
      const result = await this.execute(instanceId, prompt, options);
      results.push(result.stdout);

      // Check for failure
      if (result.exitCode !== 0) {
        throw new Error(`Conversation step failed: ${result.stderr}`);
      }
    }

    return results;
  }

  /**
   * Stop a running Bob instance
   */
  async stop(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      return;
    }

    // Kill any running process
    const process = this.processes.get(instanceId);
    if (process) {
      process.kill('SIGTERM');
      this.processes.delete(instanceId);
    }

    instance.status = 'stopped';
    this.instances.set(instanceId, instance);

    logger.info(`Stopped Bob instance`, { instanceId, toolName: instance.toolName });
  }

  /**
   * Destroy a Bob instance and clean up resources
   *
   * Handles:
   * - Git worktree removal (if used)
   * - Workspace cleanup
   * - Process termination
   */
  async destroy(instanceId: string, options: { keepWorkspace?: boolean } = {}): Promise<void> {
    await this.stop(instanceId);

    const instance = this.instances.get(instanceId);
    if (!instance) {
      return;
    }

    // Check if this instance used a git worktree
    const worktreeInfo = this.worktrees.get(instanceId);

    if (!options.keepWorkspace) {
      if (worktreeInfo) {
        // Remove the git worktree properly
        this.removeWorktree(worktreeInfo.gitRepo, worktreeInfo.workspace);
        this.worktrees.delete(instanceId);
      } else if (existsSync(instance.workspace)) {
        // Standard directory cleanup
        rmSync(instance.workspace, { recursive: true, force: true });
      }
    }

    instance.status = 'destroyed';
    this.instances.delete(instanceId);

    logger.info('Destroyed Bob instance', {
      instanceId,
      toolName: instance.toolName,
      workspaceKept: options.keepWorkspace,
      wasWorktree: !!worktreeInfo,
    });
  }

  /**
   * Get instance by ID
   */
  getInstance(instanceId: string): BobInstance | undefined {
    return this.instances.get(instanceId);
  }

  /**
   * Get all active instances
   */
  getActiveInstances(): BobInstance[] {
    return Array.from(this.instances.values()).filter(
      (i) => i.status === 'running' || i.status === 'creating'
    );
  }

  /**
   * Get instances for a specific tool
   */
  getInstancesForTool(toolName: string): BobInstance[] {
    return Array.from(this.instances.values()).filter((i) => i.toolName === toolName);
  }

  /**
   * Clean up all instances (for shutdown)
   */
  async destroyAll(): Promise<void> {
    const instanceIds = Array.from(this.instances.keys());
    await Promise.all(instanceIds.map((id) => this.destroy(id)));
    logger.info(`Destroyed all Bob instances`, { count: instanceIds.length });
  }

  /**
   * Get workspace path for an instance
   */
  getWorkspacePath(instanceId: string, subpath?: string): string | undefined {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      return undefined;
    }
    return subpath ? join(instance.workspace, subpath) : instance.workspace;
  }

  /**
   * Get all active worktrees
   */
  getActiveWorktrees(): Array<{ instanceId: string; gitRepo: string; workspace: string }> {
    return Array.from(this.worktrees.entries()).map(([instanceId, info]) => ({
      instanceId,
      ...info,
    }));
  }

  /**
   * Check if an instance is using a worktree
   */
  isUsingWorktree(instanceId: string): boolean {
    return this.worktrees.has(instanceId);
  }

  /**
   * Get user's detected Claude config (for debugging)
   */
  getUserConfig(): UserClaudeConfig {
    return { ...this.userConfig };
  }
}

// Singleton instance for convenience
let defaultManager: BobInstanceManager | null = null;

export function getBobManager(options?: {
  baseWorkspace?: string;
  inheritMcpServers?: boolean;
  inheritPlugins?: boolean;
}): BobInstanceManager {
  if (!defaultManager) {
    defaultManager = new BobInstanceManager(options);
  }
  return defaultManager;
}
