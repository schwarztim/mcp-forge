/**
 * MCP Forge — Optic Discovery Module
 *
 * Uses Optic as a reverse proxy to capture live API traffic from Postman
 * and auto-generate an OpenAPI spec.
 *
 * Flow:
 *   1. Ensure Optic is installed (auto-install if missing)
 *   2. Start Optic proxy pointing at the target API
 *   3. User sends requests via Postman through the proxy
 *   4. Optic captures all request/response pairs
 *   5. Optic generates an OpenAPI spec from captured traffic
 *   6. MCP Forge consumes the spec and generates the MCP server
 */

import { execSync, spawn, ChildProcess } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const FORGE_DIR = join(homedir(), '.mcp-forge');
const CAPTURES_DIR = join(FORGE_DIR, 'captures');

export interface DiscoveryConfig {
  /** The real API base URL to proxy to */
  targetUrl: string;
  /** Local port for the Optic proxy (default: 8818) */
  proxyPort?: number;
  /** Name for this capture session */
  sessionName: string;
  /** Path to output the captured OpenAPI spec */
  outputSpec?: string;
  /** Timeout in seconds before auto-stopping (default: 300) */
  timeout?: number;
}

export interface DiscoveryResult {
  success: boolean;
  specPath: string;
  endpointCount: number;
  capturedRequests: number;
  duration: number;
  proxyUrl: string;
  error?: string;
}

// ─── Optic Installation ──────────────────────────────────────

export function isOpticInstalled(): boolean {
  try {
    execSync('npx @useoptic/optic --version 2>/dev/null', { encoding: 'utf-8', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

export function installOptic(): void {
  console.error('[discovery] Installing Optic...');
  try {
    execSync('npm install -g @useoptic/optic@latest', {
      encoding: 'utf-8',
      stdio: 'inherit',
      timeout: 120_000,
    });
    console.error('[discovery] Optic installed successfully.');
  } catch (err: any) {
    throw new Error(`Failed to install Optic: ${err.message}. Run manually: npm install -g @useoptic/optic`);
  }
}

export function ensureOptic(): void {
  if (!isOpticInstalled()) {
    installOptic();
  }
}

// ─── Optic Proxy Capture ─────────────────────────────────────

export async function startDiscovery(config: DiscoveryConfig): Promise<DiscoveryResult> {
  const port = config.proxyPort || 8818;
  const timeout = (config.timeout || 300) * 1000;
  const startTime = Date.now();

  if (!existsSync(CAPTURES_DIR)) mkdirSync(CAPTURES_DIR, { recursive: true });

  const specPath = config.outputSpec || join(CAPTURES_DIR, `${config.sessionName}.yaml`);
  const proxyUrl = `http://localhost:${port}`;

  ensureOptic();

  console.error(`\n[discovery] ─── Optic API Discovery ───────────────────`);
  console.error(`[discovery] Target API:  ${config.targetUrl}`);
  console.error(`[discovery] Proxy URL:   ${proxyUrl}`);
  console.error(`[discovery] Output spec: ${specPath}`);
  console.error(`[discovery] Timeout:     ${config.timeout || 300}s`);
  console.error(`[discovery]`);
  console.error(`[discovery] 📮 POSTMAN SETUP:`);
  console.error(`[discovery]    1. Open Postman`);
  console.error(`[discovery]    2. Settings → Proxy → "Use custom proxy"`);
  console.error(`[discovery]    3. Proxy Server: localhost   Port: ${port}`);
  console.error(`[discovery]    4. Send requests to ${config.targetUrl} as normal`);
  console.error(`[discovery]    5. Traffic flows: Postman → Optic → Real API`);
  console.error(`[discovery]`);
  console.error(`[discovery]    OR: Prefix URLs with ${proxyUrl}`);
  console.error(`[discovery]         ${proxyUrl}/api/v1/users`);
  console.error(`[discovery]`);
  console.error(`[discovery] 🔄 Capturing... (Ctrl+C or wait ${config.timeout || 300}s to stop)`);
  console.error(`[discovery] ────────────────────────────────────────────\n`);

  return new Promise((resolve) => {
    let requestCount = 0;
    let opticProcess: ChildProcess | null = null;

    try {
      opticProcess = spawn('npx', [
        '@useoptic/optic',
        'capture',
        specPath,
        '--reverse-proxy', proxyUrl,
        '--target', config.targetUrl,
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, OPTIC_TELEMETRY_LEVEL: 'off' },
      });

      opticProcess.stdout?.on('data', (data: Buffer) => {
        const line = data.toString();
        if (line.includes('request') || line.includes('→') || line.includes('->')) {
          requestCount++;
          console.error(`[discovery] 📥 #${requestCount}: ${line.trim()}`);
        }
      });

      opticProcess.stderr?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line && !line.includes('telemetry')) {
          console.error(`[discovery] ${line}`);
        }
        const match = line.match(/(\d+)\s*(?:request|observed)/);
        if (match) requestCount = Math.max(requestCount, parseInt(match[1], 10));
      });

      const stopCapture = () => {
        if (opticProcess && !opticProcess.killed) opticProcess.kill('SIGINT');
      };

      const timer = setTimeout(() => {
        console.error(`\n[discovery] ⏱️ Timeout (${config.timeout || 300}s). Stopping...`);
        stopCapture();
      }, timeout);

      opticProcess.on('close', (code) => {
        clearTimeout(timer);
        const duration = (Date.now() - startTime) / 1000;
        let endpointCount = 0;
        if (existsSync(specPath)) {
          try {
            const content = readFileSync(specPath, 'utf-8');
            const pathMatches = content.match(/^\s{2}\/[^\s:]+:/gm);
            endpointCount = pathMatches?.length || 0;
          } catch { /* ignore */ }
        }
        resolve({
          success: existsSync(specPath) && requestCount > 0,
          specPath, endpointCount, capturedRequests: requestCount,
          duration, proxyUrl,
          error: code !== 0 && code !== null ? `Optic exited with code ${code}` : undefined,
        });
      });

      process.on('SIGINT', () => { console.error('\n[discovery] Stopping...'); stopCapture(); });

    } catch (err: any) {
      resolve({
        success: false, specPath, endpointCount: 0, capturedRequests: 0,
        duration: (Date.now() - startTime) / 1000, proxyUrl, error: err.message,
      });
    }
  });
}

// ─── HAR Fallback Discovery ──────────────────────────────────

export function convertHarToSpec(harPath: string, outputSpec?: string): string {
  if (!existsSync(harPath)) throw new Error(`HAR file not found: ${harPath}`);
  const specPath = outputSpec || harPath.replace(/\.har$/, '.yaml');

  try {
    ensureOptic();
    execSync(`npx @useoptic/optic capture ${specPath} --har ${harPath}`, {
      encoding: 'utf-8', timeout: 60_000,
    });
    if (existsSync(specPath)) return specPath;
  } catch {
    console.error('[discovery] Optic HAR import failed, using built-in parser.');
  }
  return harPath;
}

// ─── Postman Collection Import ───────────────────────────────

export function convertPostmanToSpec(collectionPath: string, outputSpec?: string): string {
  if (!existsSync(collectionPath)) throw new Error(`Collection not found: ${collectionPath}`);

  const raw = readFileSync(collectionPath, 'utf-8');
  const collection = JSON.parse(raw);
  if (!collection.info || !collection.item) throw new Error('Invalid Postman collection');

  const specPath = outputSpec || collectionPath.replace(/\.json$/, '-spec.yaml');
  const paths: Record<string, any> = {};
  const baseUrls = new Set<string>();

  function processItems(items: any[], parentPath = '') {
    for (const item of items) {
      if (item.item) { processItems(item.item, `${parentPath}/${item.name}`); continue; }
      if (!item.request) continue;

      const req = item.request;
      const method = (req.method || 'GET').toLowerCase();
      const url = typeof req.url === 'string' ? req.url : req.url?.raw || '';

      try {
        const parsed = new URL(url.replace(/\{\{[^}]+\}\}/g, 'placeholder'));
        baseUrls.add(parsed.origin);
        const path = parsed.pathname
          .replace(/\/placeholder/g, '/{param}')
          .replace(/\/\d{5,}/g, '/{id}')
          .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/{id}');

        if (!paths[path]) paths[path] = {};
        paths[path][method] = {
          summary: item.name || `${method.toUpperCase()} ${path}`,
          description: item.request.description || '',
          operationId: (item.name || `${method}_${path}`).replace(/[^a-zA-Z0-9]/g, '_').toLowerCase(),
          tags: parentPath ? [parentPath.split('/').filter(Boolean).pop() || 'default'] : ['default'],
          parameters: extractPostmanParams(req.url),
          responses: { '200': { description: 'Success' } },
        };
        if (['post', 'put', 'patch'].includes(method) && req.body) {
          paths[path][method].requestBody = { content: { 'application/json': { schema: { type: 'object' } } } };
        }
      } catch { /* skip */ }
    }
  }

  function extractPostmanParams(url: any): any[] {
    const params: any[] = [];
    if (typeof url === 'object' && url.query) {
      for (const q of url.query) params.push({ name: q.key, in: 'query', required: false, schema: { type: 'string' }, description: q.description || q.key });
    }
    if (typeof url === 'object' && url.variable) {
      for (const v of url.variable) params.push({ name: v.key, in: 'path', required: true, schema: { type: 'string' }, description: v.description || v.key });
    }
    return params;
  }

  processItems(collection.item);

  const baseUrl = [...baseUrls][0] || 'https://api.example.com';
  const spec: any = {
    openapi: '3.0.3',
    info: { title: collection.info.name || 'API', description: collection.info.description || 'From Postman', version: '1.0.0' },
    servers: [{ url: baseUrl }],
    paths,
  };

  if (collection.auth) {
    const authType = collection.auth.type;
    if (authType === 'bearer' || authType === 'oauth2') {
      spec.components = { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } };
      spec.security = [{ bearerAuth: [] }];
    } else if (authType === 'apikey') {
      spec.components = { securitySchemes: { apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' } } };
      spec.security = [{ apiKeyAuth: [] }];
    }
  }

  writeFileSync(specPath, jsonToYaml(spec));
  return specPath;
}

function jsonToYaml(obj: any, indent = 0): string {
  const pad = '  '.repeat(indent);
  let out = '';
  if (Array.isArray(obj)) {
    for (const item of obj) {
      out += typeof item === 'object' && item !== null
        ? `${pad}- ${jsonToYaml(item, indent + 1).trimStart()}`
        : `${pad}- ${JSON.stringify(item)}\n`;
    }
  } else if (typeof obj === 'object' && obj !== null) {
    for (const [key, val] of Object.entries(obj)) {
      if (val === null || val === undefined) continue;
      if (typeof val === 'object') {
        const nested = jsonToYaml(val, indent + 1);
        out += nested.trim() ? `${pad}${key}:\n${nested}` : `${pad}${key}: {}\n`;
      } else if (typeof val === 'string' && (val.includes('\n') || val.includes(':'))) {
        out += `${pad}${key}: ${JSON.stringify(val)}\n`;
      } else {
        out += `${pad}${key}: ${val}\n`;
      }
    }
  }
  return out;
}
