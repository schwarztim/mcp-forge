/**
 * MCP Forge — Code Generator
 *
 * Takes an ApiSpec and produces a complete, ready-to-run MCP server.
 * Generates: index.ts, auth.ts, package.json, tsconfig.json, .env.example, run.sh
 */

import { join } from 'path';
import { homedir } from 'os';
import type { ApiSpec, GeneratedFile, GenerationResult, McpTool, ApiEndpoint, ServiceGroup } from '../types/index.js';
import { generateAuthModule } from '../auth/generator.js';
import { generateRateLimiterCode } from '../utils/rate-limiter.js';

const MCP_OUTPUT_BASE = join(homedir(), 'Scripts', 'mcp-servers');

export function generateMcpServer(spec: ApiSpec, outputDir?: string): GenerationResult {
  const mcpName = spec.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '') + '-mcp';
  const outDir = outputDir || join(MCP_OUTPUT_BASE, mcpName);
  const prefix = spec.title.toUpperCase().replace(/[^A-Z0-9]/g, '_');

  const tools = mapEndpointsToTools(spec.endpoints);
  const files: GeneratedFile[] = [];
  const warnings: string[] = [];

  if (spec.endpoints.length === 0) {
    warnings.push('No endpoints discovered. The MCP server will have placeholder tools. Provide an OpenAPI spec or HAR file for full generation.');
  }

  // Learned from MS365: when > 30 tools, split into service modules
  const serviceGroups = groupEndpointsByService(spec.endpoints);
  const useServiceSplit = tools.length > 30 && serviceGroups.length > 1;

  if (useServiceSplit) {
    warnings.push(`Large API (${tools.length} tools) — auto-splitting into ${serviceGroups.length} service modules to avoid monolith.`);

    // Generate service client modules
    for (const group of serviceGroups) {
      const groupTools = mapEndpointsToTools(group.endpoints);
      files.push({
        path: `src/${group.name}-client.ts`,
        content: generateServiceClient(spec, group, groupTools, prefix),
      });
    }

    // Generate index.ts that imports from service modules
    files.push({
      path: 'src/index.ts',
      content: generateSplitIndexTs(spec, tools, serviceGroups, prefix, mcpName),
    });
  } else {
    // 1. Generate index.ts (single-file MCP server)
    files.push({
      path: 'src/index.ts',
      content: generateIndexTs(spec, tools, prefix, mcpName),
    });
  }

  // 2. Generate auth.ts (with multi-token support if service groups detected)
  files.push({
    path: 'src/auth.ts',
    content: generateAuthModule(spec),
  });

  // 3. Generate api-client.ts
  files.push({
    path: 'src/api-client.ts',
    content: generateApiClient(spec, prefix),
  });

  // 4. Generate package.json
  files.push({
    path: 'package.json',
    content: generatePackageJson(mcpName, spec),
  });

  // 5. Generate tsconfig.json
  files.push({
    path: 'tsconfig.json',
    content: generateTsConfig(),
  });

  // 6. Generate .env.example
  files.push({
    path: '.env.example',
    content: generateEnvExample(spec),
  });

  // 7. Generate run.sh
  files.push({
    path: 'run.sh',
    content: generateRunScript(mcpName),
    executable: true,
  });

  // 8. Generate README.md
  files.push({
    path: 'README.md',
    content: generateReadme(spec, mcpName, tools),
  });

  // 9. Generate .gitignore
  files.push({
    path: '.gitignore',
    content: 'node_modules/\ndist/\n.env\n*.log\n.cookie-cache.json\n',
  });

  return {
    success: true,
    outputDir: outDir,
    files,
    mcpName,
    toolCount: tools.length,
    resourceCount: 0,
    errors: [],
    warnings,
  };
}

// ─── Tool Mapping ────────────────────────────────────────────

function mapEndpointsToTools(endpoints: ApiEndpoint[]): McpTool[] {
  return endpoints.map(ep => {
    const toolName = ep.operationId
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .toLowerCase();

    const properties: Record<string, any> = {};
    const required: string[] = [];

    for (const param of ep.parameters) {
      properties[param.name] = {
        type: param.type === 'integer' ? 'number' : param.type || 'string',
        description: param.description,
      };
      if (param.enum) properties[param.name].enum = param.enum;
      if (param.default !== undefined) properties[param.name].default = param.default;
      if (param.required) required.push(param.name);
    }

    // Add body parameter for POST/PUT/PATCH
    if (ep.requestBody || ['POST', 'PUT', 'PATCH'].includes(ep.method)) {
      if (ep.requestBody?.schema && Object.keys(ep.requestBody.schema).length > 0) {
        // Flatten schema properties into tool params
        const schemaProps = (ep.requestBody.schema as any).properties || {};
        for (const [key, val] of Object.entries<any>(schemaProps)) {
          if (!properties[key]) {
            properties[key] = { type: val.type || 'string', description: val.description || key };
          }
        }
      } else {
        properties['body'] = {
          type: 'object',
          description: 'Request body (JSON object)',
        };
      }
    }

    return {
      name: toolName,
      description: ep.summary || `${ep.method} ${ep.path}`,
      inputSchema: {
        type: 'object',
        properties,
        required: required.length > 0 ? required : undefined,
      },
      endpoint: ep,
    };
  });
}

// ─── index.ts Generator ─────────────────────────────────────

function generateIndexTs(spec: ApiSpec, tools: McpTool[], prefix: string, mcpName: string): string {
  const toolDefs = tools.map(t => `  {
    name: "${t.name}",
    description: ${JSON.stringify(t.description)},
    inputSchema: ${JSON.stringify(t.inputSchema, null, 6).replace(/\n/g, '\n    ')},
  }`).join(',\n');

  const toolCases = tools.map(t => {
    const ep = t.endpoint;
    const pathParams = ep.parameters.filter(p => p.in === 'path');
    const queryParams = ep.parameters.filter(p => p.in === 'query');

    let pathExpr = `'${ep.path}'`;
    for (const pp of pathParams) {
      pathExpr = pathExpr.replace(`{${pp.name}}`, `\${args.${pp.name}}`);
    }
    pathExpr = '`' + pathExpr.slice(1, -1) + '`';

    const queryBuild = queryParams.length > 0
      ? `\n        const query = new URLSearchParams();\n${queryParams.map(q =>
        `        if (args.${q.name} !== undefined) query.set('${q.name}', String(args.${q.name}));`
      ).join('\n')}\n        const qs = query.toString() ? '?' + query.toString() : '';`
      : `\n        const qs = '';`;

    const hasBody = ['POST', 'PUT', 'PATCH'].includes(ep.method);
    const bodyArg = hasBody ? `, args.body || args` : '';

    return `      case "${t.name}":
        {${queryBuild}
          result = await apiClient.request('${ep.method}', ${pathExpr} + qs${bodyArg});
        }
        break;`;
  }).join('\n');

  return `#!/usr/bin/env node
/**
 * ${spec.title} MCP Server
 * Auto-generated by MCP Forge
 *
 * ${spec.description}
 * Tools: ${tools.length} | Auth: ${spec.authStrategy}
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { ApiClient } from './api-client.js';

const apiClient = new ApiClient();

const TOOLS: Tool[] = [
${toolDefs}
];

const server = new Server(
  { name: "${mcpName}", version: "${spec.version}" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  let result: any;

  try {
    switch (name) {
${toolCases}
      default:
        return {
          content: [{ type: "text", text: \`Unknown tool: \${name}\` }],
          isError: true,
        };
    }

    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: "text", text }] };
  } catch (error: any) {
    return {
      content: [{ type: "text", text: \`Error: \${error.message}\` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(\`[${mcpName}] MCP server running (${tools.length} tools, auth: ${spec.authStrategy})\`);
}

main().catch(console.error);
`;
}

// ─── API Client Generator ────────────────────────────────────

function generateApiClient(spec: ApiSpec, prefix: string): string {
  const rateLimiterCode = generateRateLimiterCode();
  return `/**
 * API Client — Auto-generated by MCP Forge
 * Base URL: ${spec.baseUrl}
 * Auth: ${spec.authStrategy}
 *
 * Features adaptive rate limiting:
 *   - Token bucket: limits outgoing req/s (configurable via RATE_LIMIT_RPS)
 *   - 429 detection: honors Retry-After headers, exponential backoff
 *   - Adaptive throttle: permanently reduces RPS if API keeps pushing back
 *   - Auto-recovery: slowly ramps back up when 429s stop
 */

import { getAuthHeaders } from './auth.js';

const BASE_URL = process.env['${prefix}_BASE_URL'] || '${spec.baseUrl}';
const TIMEOUT = parseInt(process.env['REQUEST_TIMEOUT'] || '30000', 10);
const MAX_RETRIES = parseInt(process.env['MAX_RETRIES'] || '3', 10);

${rateLimiterCode}

const rateLimiter = new AdaptiveRateLimiter();

export class ApiClient {

  async request(method: string, path: string, body?: any): Promise<any> {
    const url = \`\${BASE_URL}\${path}\`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(await getAuthHeaders()),
    };

    // Wait for rate limiter to grant permission
    await rateLimiter.acquire();

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT);

      try {
        const resp = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        // 429 — feed into adaptive rate limiter
        if (resp.status === 429) {
          const retryAfterVal = resp.headers.get('Retry-After');
          const retryAfterSec = AdaptiveRateLimiter.parseRetryAfter(retryAfterVal);
          rateLimiter.onThrottled(retryAfterSec);

          // Re-acquire before retry (this will block for Retry-After)
          rateLimiter.release();
          await rateLimiter.acquire();
          continue;
        }

        // Auth failure
        if (resp.status === 401 || resp.status === 403) {
          rateLimiter.release();
          throw new Error(\`Authentication failed (\${resp.status}). Run: mcp-forge auth\`);
        }

        // Server errors — retry
        if (resp.status >= 500 && attempt < MAX_RETRIES) {
          console.error(\`[api] Server error \${resp.status}. Retry \${attempt}/\${MAX_RETRIES}...\`);
          await new Promise(r => setTimeout(r, 1000 * attempt));
          continue;
        }

        // Success — tell limiter to recover
        rateLimiter.onSuccess();

        const contentType = resp.headers.get('content-type') || '';
        if (contentType.includes('json')) {
          const data = await resp.json();
          rateLimiter.release();
          if (!resp.ok) {
            throw new Error(\`API error \${resp.status}: \${JSON.stringify(data)}\`);
          }
          return data;
        }

        const text = await resp.text();
        rateLimiter.release();
        if (!resp.ok) {
          throw new Error(\`API error \${resp.status}: \${text}\`);
        }
        return text;

      } catch (err: any) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') {
          rateLimiter.release();
          throw new Error(\`Request timeout after \${TIMEOUT}ms: \${method} \${path}\`);
        }
        if (attempt === MAX_RETRIES) {
          rateLimiter.release();
          throw err;
        }
        console.error(\`[api] Attempt \${attempt} failed: \${err.message}\`);
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }

    rateLimiter.release();
    throw new Error(\`Request failed after \${MAX_RETRIES} attempts: \${method} \${path}\`);
  }

  /** Get current rate limiter stats (for monitoring/debug tools) */
  getRateLimitStats() {
    return rateLimiter.getStats();
  }
}
`;
}

// ─── Package JSON Generator ──────────────────────────────────

function generatePackageJson(mcpName: string, spec: ApiSpec): string {
  const pkg = {
    name: mcpName,
    version: '1.0.0',
    description: `MCP server for ${spec.title} — auto-generated by MCP Forge`,
    type: 'module',
    main: 'dist/index.js',
    scripts: {
      build: 'tsc',
      start: 'node dist/index.js',
      dev: 'tsc --watch',
    },
    dependencies: {
      '@modelcontextprotocol/sdk': '^1.0.4',
    },
    devDependencies: {
      '@types/node': '^22.10.2',
      typescript: '^5.7.2',
    },
    engines: { node: '>=20' },
    author: 'MCP Forge',
    license: 'MIT',
  };

  // Add playwright for browser auth
  if (spec.authStrategy === 'sso_browser') {
    (pkg.dependencies as any)['playwright'] = '^1.49.0';
  }

  return JSON.stringify(pkg, null, 2) + '\n';
}

// ─── TSConfig Generator ──────────────────────────────────────

function generateTsConfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      outDir: 'dist',
      rootDir: 'src',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true,
      declaration: true,
      sourceMap: true,
    },
    include: ['src/**/*'],
    exclude: ['node_modules', 'dist'],
  }, null, 2) + '\n';
}

// ─── .env.example Generator ──────────────────────────────────

function generateEnvExample(spec: ApiSpec): string {
  let content = `# ${spec.title} MCP Server — Environment Variables\n# Auto-generated by MCP Forge\n\n`;
  for (const v of spec.envVars) {
    content += `# ${v.description}${v.required ? ' (REQUIRED)' : ''}\n`;
    if (v.secret) {
      content += `# ${v.name}=${v.example}\n`;
    } else {
      content += `${v.name}=${v.default || v.example}\n`;
    }
    content += '\n';
  }
  content += `# ─── Rate Limiting (Adaptive) ───────────────────────
# Max requests per second (default: 10). Automatically reduces on 429s.
RATE_LIMIT_RPS=10

# Max burst above steady rate (default: 5)
RATE_LIMIT_BURST=5

# Max concurrent in-flight requests (default: 10)
RATE_LIMIT_MAX_CONCURRENT=10

# Lowest RPS the adaptive system will drop to (default: 1)
RATE_LIMIT_FLOOR_RPS=1

# ─── General ──────────────────────────────────────────
LOG_LEVEL=info
REQUEST_TIMEOUT=30000
MAX_RETRIES=3
`;
  return content;
}

// ─── Run Script Generator ────────────────────────────────────

function generateRunScript(mcpName: string): string {
  return `#!/bin/bash
# ${mcpName} — Start Script
# Auto-generated by MCP Forge

set -e
cd "$(dirname "$0")"

# Load .env if present
if [ -f .env ]; then
  set -a; source .env; set +a
fi

# Build if needed
if [ ! -d dist ] || [ src/index.ts -nt dist/index.js ]; then
  echo "[forge] Building..."
  npm run build
fi

echo "[forge] Starting ${mcpName}..."
exec node dist/index.js
`;
}

// ─── README Generator ────────────────────────────────────────

function generateReadme(spec: ApiSpec, mcpName: string, tools: McpTool[]): string {
  const toolList = tools.map(t => `| \`${t.name}\` | ${t.description} |`).join('\n');

  return `# ${spec.title} MCP Server

> Auto-generated by [MCP Forge](https://github.com/schwarztim/mcp-forge)

${spec.description}

## Quick Start

\`\`\`bash
npm install
npm run build
npm start
\`\`\`

## Configuration

Copy \`.env.example\` to \`.env\` and fill in your credentials:

\`\`\`bash
cp .env.example .env
\`\`\`

${spec.envVars.filter(v => v.required).map(v => `- **${v.name}**: ${v.description}`).join('\n')}

## Authentication

**Strategy:** ${spec.authStrategy}

${spec.authStrategy === 'sso_browser' ? `This MCP uses browser-based SSO. Run \`mcp-forge auth --browser\` to authenticate.` : ''}
${spec.authStrategy === 'api_key' ? `Set your API key in the environment or run \`mcp-forge auth\` to save it to macOS Keychain.` : ''}
${spec.authStrategy === 'oauth2' ? `Configure OAuth2 client credentials in \`.env\`. Tokens auto-refresh via macOS Keychain.` : ''}

## Tools (${tools.length})

| Tool | Description |
|------|-------------|
${toolList}

## Claude Desktop Integration

Add to \`~/.claude/user-mcps.json\`:

\`\`\`json
{
  "${mcpName.replace(/-mcp$/, '')}": {
    "command": "node",
    "args": ["${join(homedir(), 'Scripts', 'mcp-servers', mcpName, 'dist', 'index.js')}"],
    "autostart": false
  }
}
\`\`\`

## License

MIT — Generated by MCP Forge
`;
}

// ─── Service-Based Code Splitting (learned from MS365 build) ─

/**
 * Group endpoints by service based on path prefixes and tags.
 * MS365 learning: a 6000-line monolith is unmaintainable.
 * Auto-split at 30+ tools into service modules.
 */
function groupEndpointsByService(endpoints: ApiEndpoint[]): ServiceGroup[] {
  const groups = new Map<string, ApiEndpoint[]>();

  for (const ep of endpoints) {
    // Use first tag as service name, or derive from path
    let service = ep.tags[0] || 'default';

    // Also try to detect from path prefix patterns
    const pathService = detectServiceFromPath(ep.path);
    if (pathService && pathService !== 'default') {
      service = pathService;
    }

    service = service.toLowerCase().replace(/[^a-z0-9]/g, '-');
    if (!groups.has(service)) groups.set(service, []);
    groups.get(service)!.push(ep);
  }

  // Merge tiny groups (< 3 endpoints) into "misc"
  const result: ServiceGroup[] = [];
  const misc: ApiEndpoint[] = [];

  for (const [name, eps] of groups) {
    if (eps.length < 3) {
      misc.push(...eps);
    } else {
      result.push({
        name,
        prefix: name,
        tokenType: 'primary',
        endpoints: eps,
      });
    }
  }

  if (misc.length > 0) {
    result.push({ name: 'misc', prefix: 'misc', tokenType: 'primary', endpoints: misc });
  }

  return result;
}

function detectServiceFromPath(path: string): string | null {
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  // Known MS365/Teams/SharePoint patterns
  const knownPrefixes: Record<string, string> = {
    'chatsvc': 'teams-chat',
    'mt': 'teams-middletier',
    'csa': 'teams-channels',
    'presence': 'teams-presence',
    '_api': 'sharepoint',
    'onenote': 'onenote',
    'beta': 'graph',
    'v1.0': 'graph',
    'owa': 'outlook',
    'api': segments[1] || 'api',
  };

  const first = segments[0].toLowerCase();
  return knownPrefixes[first] || null;
}

/**
 * Generate a service client module — one per service group.
 * Each module exports handler functions for its tools.
 */
function generateServiceClient(spec: ApiSpec, group: ServiceGroup, tools: McpTool[], prefix: string): string {
  const handlers = tools.map(t => {
    const ep = t.endpoint;
    const pathParams = ep.parameters.filter(p => p.in === 'path');
    const queryParams = ep.parameters.filter(p => p.in === 'query');

    let pathExpr = `'${ep.path}'`;
    for (const pp of pathParams) {
      pathExpr = pathExpr.replace(`{${pp.name}}`, `\${args.${pp.name}}`);
    }
    pathExpr = '`' + pathExpr.slice(1, -1) + '`';

    const queryBuild = queryParams.length > 0
      ? `\n  const query = new URLSearchParams();\n${queryParams.map(q =>
        `  if (args.${q.name} !== undefined) query.set('${q.name}', String(args.${q.name}));`
      ).join('\n')}\n  const qs = query.toString() ? '?' + query.toString() : '';`
      : `\n  const qs = '';`;

    const hasBody = ['POST', 'PUT', 'PATCH'].includes(ep.method);
    const bodyArg = hasBody ? `, args.body || args` : '';

    return `export async function ${t.name}(args: Record<string, any>, client: any): Promise<any> {${queryBuild}
  return client.request('${ep.method}', ${pathExpr} + qs${bodyArg});
}`;
  }).join('\n\n');

  return `/**
 * ${group.name} Service Client — Auto-generated by MCP Forge
 * ${tools.length} tools | Token: ${group.tokenType}
 */

${handlers}
`;
}

/**
 * Generate index.ts that imports from service modules (split mode).
 * Keeps index.ts slim: just tool registration + delegation.
 */
function generateSplitIndexTs(spec: ApiSpec, tools: McpTool[], groups: ServiceGroup[], prefix: string, mcpName: string): string {
  const imports = groups.map(g => {
    const groupTools = mapEndpointsToTools(g.endpoints);
    const funcNames = groupTools.map(t => t.name);
    return `import { ${funcNames.join(', ')} } from './${g.name}-client.js';`;
  }).join('\n');

  const toolDefs = tools.map(t => `  {
    name: "${t.name}",
    description: ${JSON.stringify(t.description)},
    inputSchema: ${JSON.stringify(t.inputSchema, null, 6).replace(/\n/g, '\n    ')},
  }`).join(',\n');

  const toolCases = tools.map(t =>
    `      case "${t.name}":
        result = await ${t.name}(args, apiClient);
        break;`
  ).join('\n');

  return `#!/usr/bin/env node
/**
 * ${spec.title} MCP Server (Split Architecture)
 * Auto-generated by MCP Forge
 *
 * ${spec.description}
 * Tools: ${tools.length} | Services: ${groups.length} | Auth: ${spec.authStrategy}
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { ApiClient } from './api-client.js';
${imports}

const apiClient = new ApiClient();

const TOOLS: Tool[] = [
${toolDefs}
];

const server = new Server(
  { name: "${mcpName}", version: "${spec.version}" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  let result: any;

  try {
    switch (name) {
${toolCases}
      default:
        return {
          content: [{ type: "text", text: \`Unknown tool: \${name}\` }],
          isError: true,
        };
    }

    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: "text", text }] };
  } catch (error: any) {
    return {
      content: [{ type: "text", text: \`Error: \${error.message}\` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(\`[${mcpName}] MCP server running (${tools.length} tools across ${groups.length} services, auth: ${spec.authStrategy})\`);
}

main().catch(console.error);
`;
}
