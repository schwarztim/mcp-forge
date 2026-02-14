/**
 * MCP Authentication Status Checker
 *
 * Determines if MCPs have valid credentials configured.
 * Used by skills to decide if they should activate.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface McpAuthStatus {
  name: string;
  isAuthenticated: boolean;
  missingCredentials: string[];
  configPath: string;
}

export interface McpConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Reads MCP configuration from user-mcps.json
 */
export function readMcpConfig(): Record<string, McpConfig> {
  const configPath = join(homedir(), '.claude', 'user-mcps.json');
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return config.mcpServers || {};
  } catch (error) {
    console.error(`Failed to read MCP config: ${error}`);
    return {};
  }
}

/**
 * TODO: Implement authentication validation logic
 *
 * This is a KEY BUSINESS LOGIC decision. Consider:
 * - What counts as "authenticated"? Empty string? Placeholder like "your_token_here"?
 * - Should we validate token format (e.g., UUID for Snyk, JWT for others)?
 * - Should we ping the API to verify credentials work?
 *
 * Trade-offs:
 * - Strict: Fewer false positives, but might block valid configs
 * - Lenient: More permissive, but might try to use broken MCPs
 * - API validation: Most accurate, but adds latency and API calls
 *
 * @param mcpName - Name of the MCP to check
 * @param config - MCP configuration object
 * @returns Authentication status with missing credentials
 */
export function checkMcpAuthentication(
  mcpName: string,
  config: McpConfig
): McpAuthStatus {
  // TODO: Implement your authentication validation logic here
  //
  // Suggested approach:
  // 1. Check if env object exists
  // 2. Identify required credentials (tokens, keys, etc.)
  // 3. Validate each credential:
  //    - Not empty string
  //    - Not placeholder value ("your_token_here", "")
  //    - Optionally: matches expected format
  // 4. Return status with list of missing credentials

  const missingCredentials: string[] = [];

  // Example logic (you can replace this):
  if (config.env) {
    for (const [key, value] of Object.entries(config.env)) {
      if (!value || value === '' || value.includes('your_') || value.includes('REPLACE')) {
        missingCredentials.push(key);
      }
    }
  }

  return {
    name: mcpName,
    isAuthenticated: missingCredentials.length === 0,
    missingCredentials,
    configPath: join(homedir(), '.claude', 'user-mcps.json'),
  };
}

/**
 * Get authentication status for all MCPs
 */
export function getAllMcpAuthStatus(): McpAuthStatus[] {
  const mcps = readMcpConfig();
  return Object.entries(mcps).map(([name, config]) =>
    checkMcpAuthentication(name, config)
  );
}

/**
 * Get only authenticated MCPs
 */
export function getAuthenticatedMcps(): string[] {
  return getAllMcpAuthStatus()
    .filter(status => status.isAuthenticated)
    .map(status => status.name);
}

/**
 * Get only unauthenticated MCPs
 */
export function getUnauthenticatedMcps(): string[] {
  return getAllMcpAuthStatus()
    .filter(status => !status.isAuthenticated)
    .map(status => status.name);
}
