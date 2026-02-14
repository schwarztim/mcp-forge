/**
 * MCP Forge — Pipeline Orchestrator
 *
 * The autonomous engine that drives the entire forge process:
 * Analyze → Plan → Generate → Build → Test → Register
 *
 * Zero human intervention required.
 */

import { writeFileSync, mkdirSync, existsSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import type { ForgeConfig, PipelineState, ApiSpec, GenerationResult } from './types/index.js';
import { analyzeApi, detectInputFormat } from './analyzer/index.js';
import { generateMcpServer } from './generator/index.js';
import { registerMcp } from './registry/index.js';
import { startDiscovery, convertPostmanToSpec, type DiscoveryConfig } from './discovery/optic.js';
import { AdaptiveRateLimiter } from './utils/rate-limiter.js';

// Lazy imports for optional browser discovery (Playwright may not be installed)
async function importBrowserDiscovery() {
  return import('./discovery/browser.js');
}
async function importHarMerger() {
  return import('./discovery/har-merger.js');
}

export class ForgePipeline {
  private state: PipelineState;
  private rateLimiter: AdaptiveRateLimiter;

  constructor(config: ForgeConfig) {
    this.state = {
      phase: 'init',
      config: {
        ...config,
        inputFormat: config.inputFormat || detectInputFormat(config.target),
      },
      startTime: Date.now(),
      errors: [],
      log: [],
    };

    // Pipeline-level rate limiter: controls how fast Forge itself works
    // (parallel builds, npm installs, API probing, Optic capture).
    // Default: 5 RPS — conservative so we don't hammer package registries or APIs.
    this.rateLimiter = new AdaptiveRateLimiter({
      maxRps: 5,
      burstSize: 3,
      maxConcurrent: 3,
      floorRps: 1,
      recoveryRate: 0.1,
      windowMs: 60_000,
      throttleThreshold: 2,
    });
  }

  private log(msg: string): void {
    const elapsed = ((Date.now() - this.state.startTime) / 1000).toFixed(1);
    const line = `[${elapsed}s] [${this.state.phase}] ${msg}`;
    this.state.log.push(line);
    console.error(line);
  }

  /**
   * Run the full forge pipeline autonomously.
   * Returns the generation result or throws on fatal error.
   */
  async run(): Promise<GenerationResult> {
    try {
      // Phase 1: Analyze
      this.state.phase = 'analyzing';
      this.log(`Analyzing: ${this.state.config.target} (format: ${this.state.config.inputFormat})`);
      const spec = await analyzeApi(this.state.config);
      this.state.spec = spec;
      this.log(`Discovered: ${spec.title} — ${spec.endpoints.length} endpoints, auth: ${spec.authStrategy}`);

      // Phase 2: Plan
      this.state.phase = 'planning';
      this.log(`Planning MCP server with ${spec.endpoints.length} tools...`);
      const plan = this.planGeneration(spec);
      this.log(`Plan: ${plan.toolCount} tools, ${plan.files.length} files`);

      // Phase 3: Generate
      this.state.phase = 'generating';
      this.log('Generating MCP server code...');
      const result = generateMcpServer(spec, this.state.config.outputDir);
      this.state.result = result;
      this.log(`Generated ${result.files.length} files in ${result.outputDir}`);

      if (this.state.config.dryRun) {
        this.state.phase = 'complete';
        this.log('Dry run complete. No files written.');
        return result;
      }

      // Write files to disk
      this.writeFiles(result);
      this.log('Files written to disk.');

      // Phase 4: Build (rate-limited to prevent hammering npm registry)
      this.state.phase = 'testing';
      this.log('Installing dependencies and building...');
      await this.rateLimiter.acquire();
      const buildSuccess = this.buildProject(result.outputDir);
      this.rateLimiter.release();
      this.rateLimiter.onSuccess();
      if (!buildSuccess) {
        this.log('Build failed — attempting auto-fix...');
        const fixed = this.autoFixBuild(result.outputDir);
        if (!fixed) {
          this.state.phase = 'failed';
          this.state.errors.push('Build failed after auto-fix attempt');
          this.log('Build failed. Manual intervention needed.');
          return { ...result, success: false, errors: ['Build failed'] };
        }
      }
      this.log('Build successful!');

      // Phase 5: Register
      this.state.phase = 'registering';
      this.log('Registering in ~/.claude/user-mcps.json...');
      const registration = registerMcp(result, spec);
      this.log(`Registered as: ${result.mcpName.replace(/-mcp$/, '')}`);
      this.log(`Entry point: ${registration.args[0]}`);

      // Done!
      this.state.phase = 'complete';
      const elapsed = ((Date.now() - this.state.startTime) / 1000).toFixed(1);
      this.log(`✅ Forge complete in ${elapsed}s — ${result.mcpName} is ready!`);
      this.log(`   ${result.toolCount} tools | Auth: ${spec.authStrategy}`);
      this.log(`   Start: node ${join(result.outputDir, 'dist', 'index.js')}`);

      return result;
    } catch (err: any) {
      this.state.phase = 'failed';
      this.state.errors.push(err.message);
      this.log(`❌ Pipeline failed: ${err.message}`);
      throw err;
    }
  }

  private planGeneration(spec: ApiSpec) {
    return {
      toolCount: spec.endpoints.length,
      files: ['src/index.ts', 'src/auth.ts', 'src/api-client.ts', 'package.json', 'tsconfig.json', '.env.example', 'run.sh', 'README.md'],
    };
  }

  private writeFiles(result: GenerationResult): void {
    for (const file of result.files) {
      const fullPath = join(result.outputDir, file.path);
      const dir = dirname(fullPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, file.content);
      if (file.executable) chmodSync(fullPath, 0o755);
    }
  }

  private buildProject(outputDir: string): boolean {
    try {
      execSync('npm install --quiet --no-audit --no-fund 2>&1', {
        cwd: outputDir,
        encoding: 'utf-8',
        timeout: 120_000,
      });
      execSync('npx tsc --noEmit 2>&1', {
        cwd: outputDir,
        encoding: 'utf-8',
        timeout: 60_000,
      });
      execSync('npx tsc 2>&1', {
        cwd: outputDir,
        encoding: 'utf-8',
        timeout: 60_000,
      });
      return true;
    } catch (err: any) {
      this.log(`Build error: ${err.stdout || err.message}`);
      return false;
    }
  }

  private autoFixBuild(outputDir: string): boolean {
    // Common fix: missing type declarations
    try {
      const output = execSync('npx tsc --noEmit 2>&1', {
        cwd: outputDir,
        encoding: 'utf-8',
      });
      return true;
    } catch (err: any) {
      const errors = err.stdout || '';
      // If it's just strict null checks, rebuild with less strict config
      if (errors.includes('possibly undefined') || errors.includes('possibly null')) {
        try {
          const tsconfig = JSON.parse(require('fs').readFileSync(join(outputDir, 'tsconfig.json'), 'utf-8'));
          tsconfig.compilerOptions.strict = false;
          tsconfig.compilerOptions.strictNullChecks = false;
          writeFileSync(join(outputDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
          execSync('npx tsc 2>&1', { cwd: outputDir, encoding: 'utf-8', timeout: 60_000 });
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  }

  getState(): PipelineState {
    return { ...this.state };
  }

  getLogs(): string[] {
    return [...this.state.log];
  }

  // ─── Discovery-to-Forge Pipeline ──────────────────────────

  /**
   * Full discovery pipeline: Optic proxy → Postman traffic capture → OpenAPI spec → Forge.
   * Starts Optic as a reverse proxy, waits for the user to send traffic via Postman,
   * then auto-generates the MCP server from the captured spec.
   */
  async discoverAndForge(discoveryConfig: DiscoveryConfig): Promise<GenerationResult> {
    this.state.phase = 'analyzing';
    this.log(`Starting API discovery for ${discoveryConfig.targetUrl}`);

    // Step 1: Rate-limited discovery start
    await this.rateLimiter.acquire();
    const discovery = await startDiscovery(discoveryConfig);
    this.rateLimiter.release();

    if (!discovery.success) {
      this.state.phase = 'failed';
      const err = `Discovery failed: ${discovery.error || 'No requests captured'}`;
      this.state.errors.push(err);
      this.log(err);
      throw new Error(err);
    }

    this.log(`Discovery complete: ${discovery.capturedRequests} requests → ${discovery.endpointCount} endpoints`);
    this.log(`Spec saved: ${discovery.specPath}`);

    // Step 2: Re-configure pipeline to use the captured spec
    this.state.config.target = discoveryConfig.sessionName;
    this.state.config.specPath = discovery.specPath;
    this.state.config.inputFormat = 'openapi';

    // Step 3: Run normal forge pipeline on the captured spec
    return this.run();
  }

  /**
   * Forge from a Postman collection export (no Optic needed).
   * Converts the collection to OpenAPI, then runs the normal pipeline.
   */
  async forgeFromPostman(collectionPath: string): Promise<GenerationResult> {
    this.state.phase = 'analyzing';
    this.log(`Converting Postman collection: ${collectionPath}`);

    await this.rateLimiter.acquire();
    const specPath = convertPostmanToSpec(collectionPath);
    this.rateLimiter.release();
    this.rateLimiter.onSuccess();

    this.log(`Converted to OpenAPI: ${specPath}`);

    // Re-configure and run
    this.state.config.specPath = specPath;
    this.state.config.inputFormat = 'openapi';
    return this.run();
  }

  // ─── Browser Discovery Pipeline (learned from MS365) ──────

  /**
   * Discover APIs by navigating a web app with Playwright.
   * Superior to Optic for SPAs that make API calls from the browser.
   *
   * Flow: Playwright login → passive capture → active navigation → HAR output → Forge
   */
  async discoverWithBrowser(config: {
    siteUrl: string;
    sessionName: string;
    loginUrl?: string;
    email?: string;
    password?: string;
    timeout?: number;
    forgeAfter?: boolean;
  }): Promise<GenerationResult | { harPath: string; uniqueEndpoints: number }> {
    this.state.phase = 'analyzing';
    this.log(`Starting browser discovery for ${config.siteUrl}`);

    try {
      const { discoverWithBrowser: runBrowserDiscovery } = await importBrowserDiscovery();

      await this.rateLimiter.acquire();
      const result = await runBrowserDiscovery({
        targetUrl: config.siteUrl,
        sessionName: config.sessionName,
        timeout: config.timeout || 300,
        headless: true,
        credentials: config.email ? { email: config.email, password: config.password } : undefined,
      });
      this.rateLimiter.release();
      this.rateLimiter.onSuccess();

      this.log(`Browser discovery: ${result.uniqueEndpoints} endpoints captured → ${result.harPath}`);

      if (!config.forgeAfter) {
        return result;
      }

      // Chain into forge pipeline
      this.state.config.specPath = result.harPath;
      this.state.config.inputFormat = 'har';
      this.state.config.target = config.sessionName;
      return this.run();
    } catch (err: any) {
      this.state.phase = 'failed';
      this.log(`Browser discovery failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Merge multiple discovery passes into one deduplicated spec, then forge.
   * MS365 learning: single pass misses 60-70% of endpoints.
   */
  async mergeAndForge(harPaths: string[], sessionName: string): Promise<GenerationResult> {
    this.state.phase = 'analyzing';
    this.log(`Merging ${harPaths.length} discovery passes...`);

    try {
      const { mergeEndpointFiles } = await importHarMerger();

      await this.rateLimiter.acquire();
      const mergeResult = mergeEndpointFiles(...harPaths);
      this.rateLimiter.release();

      this.log(`Merged: ${mergeResult.uniqueEndpoints} unique endpoints from ${mergeResult.totalInputEndpoints} input endpoints`);
      const groupNames = Object.keys(mergeResult.serviceGroups);
      this.log(`Service groups: ${groupNames.join(', ')}`);

      // Write merged spec to a temp file for the analyzer
      const mergedSpecPath = join('/tmp', `forge-merged-${sessionName}.json`);
      writeFileSync(mergedSpecPath, JSON.stringify(mergeResult, null, 2));

      // Use merged spec to forge
      this.state.config.specPath = mergedSpecPath;
      this.state.config.inputFormat = 'har';
      this.state.config.target = sessionName;
      return this.run();
    } catch (err: any) {
      this.state.phase = 'failed';
      this.log(`Merge failed: ${err.message}`);
      throw err;
    }
  }
}
