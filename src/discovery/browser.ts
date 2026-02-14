/**
 * MCP Forge — Browser-based API Discovery
 *
 * Playwright-powered headless browser that navigates a web app,
 * captures all API traffic, deduplicates endpoints, and writes
 * a HAR-like capture plus a clean endpoint list.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ─── Public Interfaces ───────────────────────────────────────

export interface BrowserDiscoveryConfig {
  /** Web app URL to navigate */
  targetUrl: string;
  /** Name for this capture session */
  sessionName: string;
  /** Directory for output files (default: ~/.mcp-forge/captures/) */
  outputDir?: string;
  /** Max capture duration in seconds (default: 120) */
  timeout?: number;
  /** Run browser headlessly (default: true) */
  headless?: boolean;
  /** SSO / login credentials */
  credentials?: {
    email?: string;
    password?: string;
    /** Shell command that prints a TOTP code to stdout */
    totpCommand?: string;
  };
  /** CSS selectors or URLs to visit after initial page load */
  navigationSteps?: string[];
  /** Milliseconds to wait for auth redirects after login (default: 10000) */
  waitForAuth?: number;
}

export interface BrowserDiscoveryResult {
  success: boolean;
  harPath: string;
  endpointsPath: string;
  totalRequests: number;
  uniqueEndpoints: number;
  duration: number;
  error?: string;
}

interface CapturedRequest {
  method: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  responseContentType: string;
}

// ─── Constants ───────────────────────────────────────────────

const LOG_PREFIX = '[browser-discovery]';
const DEFAULT_OUTPUT_DIR = join(homedir(), '.mcp-forge', 'captures');
const DEFAULT_TIMEOUT_S = 120;
const DEFAULT_WAIT_AUTH_MS = 10_000;
const STEP_DELAY_MS = 3_000;

const STATIC_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.css', '.png', '.jpg', '.jpeg', '.gif',
  '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.map',
  '.webp', '.avif', '.mp4', '.webm',
]);

// ─── Helpers ─────────────────────────────────────────────────

function log(msg: string): void {
  console.error(`${LOG_PREFIX} ${msg}`);
}

function isApiResponse(url: string, contentType: string): boolean {
  // Reject obvious static assets by extension
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.slice(pathname.lastIndexOf('.'));
    if (STATIC_EXTENSIONS.has(ext.toLowerCase())) return false;
  } catch { /* non-parseable URL — keep it */ }

  // Accept JSON or common API content types
  const ct = contentType.toLowerCase();
  return (
    ct.includes('application/json') ||
    ct.includes('application/graphql') ||
    ct.includes('application/xml') ||
    ct.includes('text/xml') ||
    ct.includes('application/x-ndjson') ||
    ct.includes('text/event-stream') ||
    ct.includes('application/problem+json')
  );
}

/**
 * Parameterise a URL path so that concrete IDs collapse into tokens.
 *
 *   /api/users/3fa85f64-5717-4562-b3fc-2c963f66afa6/roles
 *     → /api/users/{id}/roles
 */
function parameterizePath(raw: string): string {
  try {
    const { pathname } = new URL(raw);
    return pathname
      .split('/')
      .map((seg) => {
        if (!seg) return seg;
        // UUIDs (v4-ish)
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '{id}';
        // Long numeric IDs (5+ digits)
        if (/^\d{5,}$/.test(seg)) return '{id}';
        // Email-like segments
        if (/^[^@]+@[^@]+\.[^@]+$/.test(seg)) return '{email}';
        return seg;
      })
      .join('/');
  } catch {
    return raw;
  }
}

// ─── Playwright Bootstrap ────────────────────────────────────

/**
 * Ensure Playwright and its Firefox browser are available.
 * Installs them via npx if missing.
 */
export function ensurePlaywright(): void {
  try {
    require.resolve('playwright');
  } catch {
    log('Playwright not found — installing Firefox via npx …');
    try {
      execSync('npx playwright install firefox', {
        stdio: 'inherit',
        timeout: 120_000,
      });
    } catch (err) {
      throw new Error(`${LOG_PREFIX} Failed to install Playwright Firefox: ${err}`);
    }
  }
}

// ─── Core Discovery Function ─────────────────────────────────

export async function discoverWithBrowser(
  config: BrowserDiscoveryConfig,
): Promise<BrowserDiscoveryResult> {
  const startTime = Date.now();

  const outputDir = config.outputDir ?? DEFAULT_OUTPUT_DIR;
  const timeoutMs = (config.timeout ?? DEFAULT_TIMEOUT_S) * 1_000;
  const headless = config.headless ?? true;
  const waitForAuth = config.waitForAuth ?? DEFAULT_WAIT_AUTH_MS;

  const rawPath = join(outputDir, `${config.sessionName}-raw.json`);
  const endpointsPath = join(outputDir, `${config.sessionName}-endpoints.txt`);

  // Prepare output directory
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const captured: CapturedRequest[] = [];

  let browser: import('playwright').Browser | undefined;
  try {
    // Dynamic import so the module doesn't hard-fail if playwright is absent
    const pw = await import('playwright');

    log(`Launching Firefox (headless=${headless}) …`);
    browser = await pw.firefox.launch({ headless, timeout: 30_000 });
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      userAgent: 'MCPForge-Discovery/1.0',
    });
    const page = await context.newPage();

    // ── Network capture ──────────────────────────────────────
    page.on('requestfinished', async (request) => {
      try {
        const response = request.response ? await request.response() : null;
        if (!response) return;

        const url = request.url();
        const responseContentType =
          response.headers()['content-type'] ?? '';

        if (!isApiResponse(url, responseContentType)) return;

        const status = response.status();
        const method = request.method();
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(response.headers())) {
          headers[k] = v;
        }

        captured.push({ method, url, status, headers, responseContentType });
        log(`  ▸ ${method} ${status} ${url.slice(0, 120)}`);
      } catch {
        // Response body may have been disposed — safe to ignore
      }
    });

    // ── Set up timeout guard ─────────────────────────────────
    const timeoutId = setTimeout(() => {
      log('Timeout reached — stopping capture');
    }, timeoutMs);

    try {
      // ── Navigate to target ───────────────────────────────────
      log(`Navigating to ${config.targetUrl}`);
      await page.goto(config.targetUrl, {
        waitUntil: 'networkidle',
        timeout: Math.min(timeoutMs, 60_000),
      });

      // ── Login flow ───────────────────────────────────────────
      if (config.credentials) {
        await handleLogin(page, config.credentials, waitForAuth);
      }

      // ── Navigation steps ─────────────────────────────────────
      if (config.navigationSteps?.length) {
        for (const step of config.navigationSteps) {
          if (Date.now() - startTime > timeoutMs) {
            log('Timeout during navigation steps — stopping');
            break;
          }

          if (step.startsWith('http://') || step.startsWith('https://')) {
            log(`  → navigating to ${step}`);
            await page.goto(step, {
              waitUntil: 'networkidle',
              timeout: 30_000,
            });
          } else {
            log(`  → clicking ${step}`);
            try {
              await page.click(step, { timeout: 10_000 });
              await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
            } catch (err) {
              log(`  ⚠ Could not interact with "${step}": ${err}`);
            }
          }

          await page.waitForTimeout(STEP_DELAY_MS);
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }

    await browser.close();
    browser = undefined;

    // ── Post-process ───────────────────────────────────────────
    const endpointSet = new Set<string>();
    for (const req of captured) {
      const paramPath = parameterizePath(req.url);
      endpointSet.add(`${req.method} ${paramPath}`);
    }
    const sortedEndpoints = [...endpointSet].sort();

    // Write raw capture
    writeFileSync(rawPath, JSON.stringify(captured, null, 2), 'utf-8');
    log(`Raw capture → ${rawPath}  (${captured.length} requests)`);

    // Write deduplicated endpoints
    writeFileSync(endpointsPath, sortedEndpoints.join('\n') + '\n', 'utf-8');
    log(`Endpoints   → ${endpointsPath}  (${sortedEndpoints.length} unique)`);

    const duration = Date.now() - startTime;
    log(`Done in ${(duration / 1_000).toFixed(1)}s`);

    return {
      success: true,
      harPath: rawPath,
      endpointsPath,
      totalRequests: captured.length,
      uniqueEndpoints: sortedEndpoints.length,
      duration,
    };
  } catch (err) {
    // Ensure browser is torn down on failure
    if (browser) {
      await browser.close().catch(() => {});
    }

    const duration = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);
    log(`ERROR: ${message}`);

    return {
      success: false,
      harPath: rawPath,
      endpointsPath,
      totalRequests: captured.length,
      uniqueEndpoints: 0,
      duration,
      error: message,
    };
  }
}

// ─── Login Helper ────────────────────────────────────────────

async function handleLogin(
  page: import('playwright').Page,
  creds: NonNullable<BrowserDiscoveryConfig['credentials']>,
  waitForAuth: number,
): Promise<void> {
  log('Attempting auto-login …');

  // Fill email field (common selectors)
  if (creds.email) {
    const emailSelector =
      'input[type="email"], input[name="email"], input[name="username"], input[id="i0116"], input[name="loginfmt"]';
    try {
      await page.waitForSelector(emailSelector, { timeout: 10_000 });
      await page.fill(emailSelector, creds.email);
      log('  ✓ Email filled');

      // Many SSO forms have a "Next" button after email
      const nextBtn = page.locator('input[type="submit"], button[type="submit"]').first();
      if (await nextBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await nextBtn.click();
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      }
    } catch {
      log('  ⚠ No email field found — skipping');
    }
  }

  // Fill password field
  if (creds.password) {
    const pwSelector = 'input[type="password"]';
    try {
      await page.waitForSelector(pwSelector, { timeout: 10_000 });
      await page.fill(pwSelector, creds.password);
      log('  ✓ Password filled');

      const submitBtn = page.locator('input[type="submit"], button[type="submit"]').first();
      if (await submitBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await submitBtn.click();
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      }
    } catch {
      log('  ⚠ No password field found — skipping');
    }
  }

  // Handle TOTP / MFA
  if (creds.totpCommand) {
    try {
      const totpCode = execSync(creds.totpCommand, { encoding: 'utf-8', timeout: 10_000 }).trim();
      log(`  ✓ TOTP code obtained (${totpCode.length} chars)`);

      const otpSelector =
        'input[name="otc"], input[name="totp"], input[name="code"], input[id="idTxtBx_SAOTCC_OTC"], input[type="tel"]';
      await page.waitForSelector(otpSelector, { timeout: 15_000 });
      await page.fill(otpSelector, totpCode);

      const verifyBtn = page.locator('input[type="submit"], button[type="submit"]').first();
      if (await verifyBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await verifyBtn.click();
      }
    } catch (err) {
      log(`  ⚠ TOTP handling failed: ${err}`);
    }
  }

  // Wait for post-auth redirects and token exchange
  log(`  Waiting ${waitForAuth / 1_000}s for auth to settle …`);
  await page.waitForTimeout(waitForAuth);
}
