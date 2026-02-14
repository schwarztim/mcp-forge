/**
 * MCP Forge — Registry
 *
 * Auto-registers generated MCP servers in ~/.claude/user-mcps.json
 * so they're immediately available in Claude Desktop / Copilot CLI.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { GenerationResult, ApiSpec, McpRegistration } from '../types/index.js';

const CLAUDE_DIR = join(homedir(), '.claude');
const USER_MCPS_PATH = join(CLAUDE_DIR, 'user-mcps.json');

export function registerMcp(result: GenerationResult, spec: ApiSpec): McpRegistration {
  const serverName = result.mcpName.replace(/-mcp$/, '');
  const entryPoint = join(result.outputDir, 'dist', 'index.js');

  // Build env vars for registration
  const env: Record<string, string> = {};
  for (const v of spec.envVars) {
    if (!v.secret && v.default) {
      env[v.name] = v.default;
    }
  }

  const registration: McpRegistration = {
    command: 'node',
    args: [entryPoint],
    ...(Object.keys(env).length > 0 ? { env } : {}),
    autostart: false,
  };

  // Read existing config
  if (!existsSync(CLAUDE_DIR)) {
    mkdirSync(CLAUDE_DIR, { recursive: true });
  }

  let config: { mcpServers: Record<string, any> } = { mcpServers: {} };
  if (existsSync(USER_MCPS_PATH)) {
    try {
      config = JSON.parse(readFileSync(USER_MCPS_PATH, 'utf-8'));
      if (!config.mcpServers) config.mcpServers = {};
    } catch {
      config = { mcpServers: {} };
    }
  }

  // Register (or update existing)
  config.mcpServers[serverName] = registration;

  // Write back
  writeFileSync(USER_MCPS_PATH, JSON.stringify(config, null, 4) + '\n');

  return registration;
}

export function unregisterMcp(mcpName: string): boolean {
  const serverName = mcpName.replace(/-mcp$/, '');
  if (!existsSync(USER_MCPS_PATH)) return false;

  try {
    const config = JSON.parse(readFileSync(USER_MCPS_PATH, 'utf-8'));
    if (config.mcpServers?.[serverName]) {
      delete config.mcpServers[serverName];
      writeFileSync(USER_MCPS_PATH, JSON.stringify(config, null, 4) + '\n');
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

export function listRegistered(): Record<string, McpRegistration> {
  if (!existsSync(USER_MCPS_PATH)) return {};
  try {
    const config = JSON.parse(readFileSync(USER_MCPS_PATH, 'utf-8'));
    return config.mcpServers || {};
  } catch {
    return {};
  }
}
