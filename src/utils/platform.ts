/**
 * Cross-Platform Utilities
 *
 * Ensures thesun works on Windows, macOS, and Linux.
 * All file paths, process spawning, and shell commands use these utilities.
 */

import { platform, homedir, tmpdir } from 'os';
import { join, sep, normalize, posix, win32 } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { spawn, SpawnOptions } from 'child_process';

/**
 * Current platform
 */
export const PLATFORM = platform();
export const IS_WINDOWS = PLATFORM === 'win32';
export const IS_MAC = PLATFORM === 'darwin';
export const IS_LINUX = PLATFORM === 'linux';

/**
 * Path separator for current platform
 */
export const PATH_SEP = sep;

/**
 * Normalize a path for the current platform
 */
export function normalizePath(inputPath: string): string {
  // Convert forward slashes to platform-specific separator
  const normalized = normalize(inputPath);

  // On Windows, also handle drive letters
  if (IS_WINDOWS && normalized.startsWith('/')) {
    // Unix-style absolute path on Windows - try to make it work
    return normalized.replace(/\//g, '\\');
  }

  return normalized;
}

/**
 * Join paths in a cross-platform way
 */
export function joinPaths(...paths: string[]): string {
  return join(...paths);
}

/**
 * Convert a path to POSIX style (for config files, URLs, etc.)
 */
export function toPosixPath(inputPath: string): string {
  if (IS_WINDOWS) {
    return inputPath.replace(/\\/g, '/');
  }
  return inputPath;
}

/**
 * Get home directory
 */
export function getHomeDir(): string {
  return homedir();
}

/**
 * Get temp directory
 */
export function getTempDir(): string {
  return tmpdir();
}

/**
 * Get default data directory for thesun
 */
export function getDefaultDataDir(): string {
  if (IS_WINDOWS) {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'thesun');
  } else if (IS_MAC) {
    return join(homedir(), 'Library', 'Application Support', 'thesun');
  } else {
    return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'thesun');
  }
}

/**
 * Get default config directory for thesun
 */
export function getDefaultConfigDir(): string {
  if (IS_WINDOWS) {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'thesun');
  } else if (IS_MAC) {
    return join(homedir(), 'Library', 'Application Support', 'thesun');
  } else {
    return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'thesun');
  }
}

/**
 * Get default cache directory for thesun
 */
export function getDefaultCacheDir(): string {
  if (IS_WINDOWS) {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'thesun', 'cache');
  } else if (IS_MAC) {
    return join(homedir(), 'Library', 'Caches', 'thesun');
  } else {
    return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'thesun');
  }
}

/**
 * Ensure directory exists
 */
export function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Get executable name with platform-specific extension
 */
export function getExecutableName(name: string): string {
  if (IS_WINDOWS) {
    return `${name}.exe`;
  }
  return name;
}

/**
 * Get shell command for current platform
 */
export function getShellCommand(): { shell: string; flag: string } {
  if (IS_WINDOWS) {
    // Prefer PowerShell, fall back to cmd
    return { shell: 'powershell.exe', flag: '-Command' };
  }
  return { shell: '/bin/sh', flag: '-c' };
}

/**
 * Spawn a process in a cross-platform way
 */
export function spawnCrossPlatform(
  command: string,
  args: string[],
  options: SpawnOptions = {}
): ReturnType<typeof spawn> {
  if (IS_WINDOWS) {
    // On Windows, use shell to handle command resolution
    return spawn(command, args, {
      ...options,
      shell: true,
      windowsHide: true,
    });
  }

  return spawn(command, args, options);
}

/**
 * Run a shell command in a cross-platform way
 */
export async function runShellCommand(
  command: string,
  options: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { shell, flag } = getShellCommand();

  return new Promise((resolve, reject) => {
    const child = spawn(shell, [flag, command], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    const timeout = options.timeout ?? 60000;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timeout after ${timeout}ms`));
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Get platform-specific npm command
 */
export function getNpmCommand(): string {
  return IS_WINDOWS ? 'npm.cmd' : 'npm';
}

/**
 * Get platform-specific node command
 */
export function getNodeCommand(): string {
  return IS_WINDOWS ? 'node.exe' : 'node';
}

/**
 * Get Claude Code command
 */
export function getClaudeCommand(): string {
  // Claude Code CLI name
  return IS_WINDOWS ? 'claude.exe' : 'claude';
}

/**
 * Check if a command exists on the system
 */
export async function commandExists(command: string): Promise<boolean> {
  try {
    const checkCommand = IS_WINDOWS
      ? `where ${command}`
      : `which ${command}`;

    const result = await runShellCommand(checkCommand, { timeout: 5000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Get environment variable with default
 */
export function getEnv(name: string, defaultValue?: string): string | undefined {
  return process.env[name] ?? defaultValue;
}

/**
 * Get environment variable or throw
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

/**
 * Sanitize filename for all platforms
 */
export function sanitizeFilename(name: string): string {
  // Remove/replace characters invalid on any platform
  return name
    .replace(/[<>:"/\\|?*]/g, '-') // Invalid on Windows
    .replace(/[\x00-\x1f]/g, '') // Control characters
    .replace(/^\.+/, '') // Leading dots (hidden files)
    .replace(/\.+$/, '') // Trailing dots
    .slice(0, 255); // Max filename length
}

/**
 * Create a temporary file path
 */
export function createTempPath(prefix: string, extension?: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  const filename = sanitizeFilename(`${prefix}-${timestamp}-${random}${extension ?? ''}`);
  return join(getTempDir(), filename);
}
