#!/usr/bin/env node
/**
 * MCP Forge — CLI
 *
 * Usage:
 *   mcp-forge forge <target>              # Generate from API name
 *   mcp-forge forge <spec.yaml>           # Generate from OpenAPI spec
 *   mcp-forge forge <capture.har>         # Generate from HAR capture
 *   mcp-forge forge <url>                 # Generate from URL
 *   mcp-forge list                        # List registered MCPs
 *   mcp-forge auth <mcp-name>             # Authenticate an MCP
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { ForgePipeline } from '../pipeline.js';
import { listRegistered } from '../registry/index.js';
import { detectInputFormat } from '../analyzer/index.js';
import { startDiscovery, convertPostmanToSpec } from '../discovery/optic.js';
import type { AuthStrategy } from '../types/index.js';

const program = new Command();

program
  .name('mcp-forge')
  .description('Autonomous MCP server factory — turns any API into a production-ready MCP server')
  .version('1.0.0');

program
  .command('forge <target>')
  .description('Generate an MCP server from an API name, OpenAPI spec, HAR file, or URL')
  .option('-o, --output <dir>', 'Output directory (default: ~/Scripts/mcp-servers/<name>-mcp/)')
  .option('-a, --auth <strategy>', 'Override auth strategy (none|api_key|oauth2|sso_browser|bearer|basic)')
  .option('-u, --base-url <url>', 'Override base URL')
  .option('--dry-run', 'Preview without writing files')
  .action(async (target: string, opts: any) => {
    console.log(chalk.bold.cyan('\n⚒️  MCP Forge\n'));

    const format = detectInputFormat(target);
    console.log(chalk.dim(`Target: ${target}`));
    console.log(chalk.dim(`Format: ${format}`));
    if (opts.auth) console.log(chalk.dim(`Auth override: ${opts.auth}`));
    console.log('');

    const pipeline = new ForgePipeline({
      target,
      inputFormat: format,
      specPath: ['openapi', 'har', 'swagger'].includes(format) ? target : undefined,
      outputDir: opts.output,
      authStrategy: opts.auth as AuthStrategy | undefined,
      baseUrl: opts.baseUrl,
      dryRun: opts.dryRun,
    });

    try {
      const result = await pipeline.run();

      if (result.success) {
        console.log(chalk.green.bold(`\n✅ MCP server generated successfully!\n`));
        console.log(chalk.white(`  Name:      ${result.mcpName}`));
        console.log(chalk.white(`  Location:  ${result.outputDir}`));
        console.log(chalk.white(`  Tools:     ${result.toolCount}`));
        console.log(chalk.white(`  Files:     ${result.files.length}`));

        if (result.warnings.length > 0) {
          console.log(chalk.yellow(`\n  Warnings:`));
          result.warnings.forEach((w: string) => console.log(chalk.yellow(`    ⚠ ${w}`)));
        }

        console.log(chalk.dim(`\n  Start:     node ${result.outputDir}/dist/index.js`));
        console.log(chalk.dim(`  Or:        cd ${result.outputDir} && npm start\n`));
      } else {
        console.log(chalk.red.bold(`\n❌ Generation failed\n`));
        result.errors.forEach((e: string) => console.log(chalk.red(`  ${e}`)));
        process.exit(1);
      }
    } catch (err: any) {
      console.log(chalk.red.bold(`\n❌ Fatal error: ${err.message}\n`));
      process.exit(1);
    }
  });

program
  .command('list')
  .description('List all registered MCP servers')
  .action(() => {
    const servers = listRegistered();
    const entries = Object.entries(servers);

    if (entries.length === 0) {
      console.log(chalk.dim('No MCP servers registered.'));
      return;
    }

    console.log(chalk.bold.cyan(`\n📦 Registered MCP Servers (${entries.length})\n`));
    for (const [name, reg] of entries) {
      const args = (reg as any).args?.join(' ') || '';
      console.log(chalk.white(`  ${chalk.bold(name)}`));
      console.log(chalk.dim(`    ${(reg as any).command} ${args}`));
      if ((reg as any).env) {
        const envKeys = Object.keys((reg as any).env).join(', ');
        console.log(chalk.dim(`    env: ${envKeys}`));
      }
      console.log('');
    }
  });

program
  .command('auth <mcp-name>')
  .description('Authenticate an MCP server')
  .option('--browser', 'Use browser-based SSO')
  .option('--har <file>', 'Import auth from HAR file')
  .option('--key <value>', 'Set API key')
  .action(async (mcpName: string, opts: any) => {
    console.log(chalk.bold.cyan(`\n🔐 Authenticating: ${mcpName}\n`));

    if (opts.browser) {
      console.log(chalk.dim('Opening browser for SSO login...'));
      // Browser auth would be handled by the generated MCP's auth module
      console.log(chalk.yellow('Browser auth must be run from the MCP directory.'));
      console.log(chalk.dim(`  cd ~/Scripts/mcp-servers/${mcpName}-mcp && node -e "import('./dist/auth.js').then(m => m.browserLogin())"`));
    } else if (opts.key) {
      // Save to Keychain
      const { execSync } = await import('child_process');
      try {
        try {
          execSync(`security delete-generic-password -s "${mcpName}-mcp" -a "api_key" 2>/dev/null`);
        } catch { /* ignore */ }
        execSync(`security add-generic-password -s "${mcpName}-mcp" -a "api_key" -w "${opts.key.replace(/"/g, '\\"')}"`);
        console.log(chalk.green('✅ API key saved to macOS Keychain.'));
      } catch (err: any) {
        console.log(chalk.red(`Failed to save: ${err.message}`));
      }
    } else {
      console.log(chalk.dim('Use --browser for SSO, --key <value> for API key, or --har <file> for HAR import.'));
    }
  });

// ─── Discover Command ────────────────────────────────────────

program
  .command('discover <target-url>')
  .description('Discover API endpoints via Optic reverse proxy + Postman traffic capture')
  .option('-n, --name <name>', 'Session name (default: derived from URL)')
  .option('-p, --port <port>', 'Proxy port (default: 8818)', '8818')
  .option('-t, --timeout <seconds>', 'Capture timeout in seconds (default: 300)', '300')
  .option('-o, --output <dir>', 'Output directory for generated MCP')
  .option('--spec-only', 'Only generate the OpenAPI spec, do not forge an MCP')
  .option('--rps <rate>', 'Max requests/sec for the generated MCP (default: 10)', '10')
  .action(async (targetUrl: string, opts: any) => {
    console.log(chalk.bold.cyan('\n🔍 MCP Forge — API Discovery\n'));

    const sessionName = opts.name || new URL(targetUrl).hostname.replace(/\./g, '-');

    console.log(chalk.white(`  Target API:  ${targetUrl}`));
    console.log(chalk.white(`  Session:     ${sessionName}`));
    console.log(chalk.white(`  Proxy port:  ${opts.port}`));
    console.log(chalk.white(`  Timeout:     ${opts.timeout}s`));
    console.log(chalk.white(`  Rate limit:  ${opts.rps} RPS`));
    console.log('');

    if (opts.specOnly) {
      // Just run discovery, output the spec
      const { startDiscovery } = await import('../discovery/optic.js');
      const result = await startDiscovery({
        targetUrl,
        sessionName,
        proxyPort: parseInt(opts.port, 10),
        timeout: parseInt(opts.timeout, 10),
      });
      if (result.success) {
        console.log(chalk.green.bold(`\n✅ Discovery complete!\n`));
        console.log(chalk.white(`  Requests captured: ${result.capturedRequests}`));
        console.log(chalk.white(`  Endpoints found:   ${result.endpointCount}`));
        console.log(chalk.white(`  Spec saved:        ${result.specPath}`));
        console.log(chalk.dim(`\n  Forge it:  mcp-forge forge ${result.specPath}\n`));
      } else {
        console.log(chalk.red.bold(`\n❌ Discovery failed: ${result.error}\n`));
        process.exit(1);
      }
    } else {
      // Full pipeline: discover → forge
      const pipeline = new ForgePipeline({
        target: sessionName,
        inputFormat: 'name_only',
        outputDir: opts.output,
      });

      try {
        const result = await pipeline.discoverAndForge({
          targetUrl,
          sessionName,
          proxyPort: parseInt(opts.port, 10),
          timeout: parseInt(opts.timeout, 10),
        });

        if (result.success) {
          console.log(chalk.green.bold(`\n✅ Discovered & Forged!\n`));
          console.log(chalk.white(`  Name:      ${result.mcpName}`));
          console.log(chalk.white(`  Location:  ${result.outputDir}`));
          console.log(chalk.white(`  Tools:     ${result.toolCount}`));
          console.log(chalk.dim(`\n  Start:     node ${result.outputDir}/dist/index.js\n`));
        } else {
          console.log(chalk.red.bold(`\n❌ Failed\n`));
          result.errors.forEach((e: string) => console.log(chalk.red(`  ${e}`)));
          process.exit(1);
        }
      } catch (err: any) {
        console.log(chalk.red.bold(`\n❌ ${err.message}\n`));
        process.exit(1);
      }
    }
  });

// ─── Import Postman Command ──────────────────────────────────

program
  .command('import-postman <collection.json>')
  .description('Convert a Postman collection export into an MCP server')
  .option('-o, --output <dir>', 'Output directory')
  .option('--rps <rate>', 'Max requests/sec for the generated MCP (default: 10)', '10')
  .action(async (collectionPath: string, opts: any) => {
    console.log(chalk.bold.cyan('\n📮 MCP Forge — Postman Import\n'));

    const pipeline = new ForgePipeline({
      target: collectionPath,
      inputFormat: 'name_only',
      outputDir: opts.output,
    });

    try {
      const result = await pipeline.forgeFromPostman(collectionPath);

      if (result.success) {
        console.log(chalk.green.bold(`\n✅ Postman collection → MCP server!\n`));
        console.log(chalk.white(`  Name:      ${result.mcpName}`));
        console.log(chalk.white(`  Location:  ${result.outputDir}`));
        console.log(chalk.white(`  Tools:     ${result.toolCount}`));
        console.log(chalk.dim(`\n  Start:     node ${result.outputDir}/dist/index.js\n`));
      } else {
        console.log(chalk.red.bold(`\n❌ Failed\n`));
        result.errors.forEach((e: string) => console.log(chalk.red(`  ${e}`)));
        process.exit(1);
      }
    } catch (err: any) {
      console.log(chalk.red.bold(`\n❌ ${err.message}\n`));
      process.exit(1);
    }
  });

program.parse();
