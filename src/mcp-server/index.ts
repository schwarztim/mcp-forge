#!/usr/bin/env node
/**
 * MCP Forge — MCP Server Interface
 *
 * Exposes the forge as an MCP tool, so Claude/Copilot can invoke it directly:
 *   "Use mcp-forge to create an MCP for ServiceNow"
 *
 * Single tool: forge({ target, spec, auth, output, dryRun })
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { ForgePipeline } from '../pipeline.js';
import { listRegistered } from '../registry/index.js';
import { detectInputFormat } from '../analyzer/index.js';
import type { AuthStrategy } from '../types/index.js';

const TOOLS: Tool[] = [
  {
    name: "forge",
    description: `Autonomous MCP server generator. Takes any API (name, URL, OpenAPI spec, or HAR file) and produces a complete, production-ready MCP server. Zero human intervention.

Examples:
- forge({ target: "servicenow" }) — Generate ServiceNow MCP from known patterns
- forge({ target: "/path/to/spec.yaml" }) — Generate from OpenAPI spec
- forge({ target: "/path/to/capture.har" }) — Generate from HAR traffic capture
- forge({ target: "https://api.example.com" }) — Generate from URL
- forge({ target: "stripe", auth: "bearer" }) — Override auth strategy`,
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "API name, OpenAPI spec path, HAR file path, or URL",
        },
        auth: {
          type: "string",
          enum: ["none", "api_key", "oauth2", "sso_browser", "bearer", "basic", "har_capture"],
          description: "Override auto-detected auth strategy",
        },
        baseUrl: {
          type: "string",
          description: "Override base URL for the API",
        },
        output: {
          type: "string",
          description: "Output directory (default: ~/Scripts/mcp-servers/<name>-mcp/)",
        },
        dryRun: {
          type: "boolean",
          description: "Preview generation without writing files",
        },
      },
      required: ["target"],
    },
  },
  {
    name: "forge_discover",
    description: `Live API discovery via Optic reverse proxy. Starts a proxy, captures Postman/browser traffic, generates an OpenAPI spec, then auto-forges the MCP server.

Flow: Optic proxy → Postman sends requests through it → Optic captures → OpenAPI spec → MCP server.

Examples:
- forge_discover({ targetUrl: "https://api.example.com", sessionName: "my-api" })
- forge_discover({ targetUrl: "https://api.corp.com", sessionName: "corp", proxyPort: 9000, timeout: 600 })`,
    inputSchema: {
      type: "object",
      properties: {
        targetUrl: {
          type: "string",
          description: "The real API base URL to proxy to",
        },
        sessionName: {
          type: "string",
          description: "Name for this discovery session",
        },
        proxyPort: {
          type: "number",
          description: "Local port for the Optic proxy (default: 8818)",
        },
        timeout: {
          type: "number",
          description: "Capture timeout in seconds (default: 300)",
        },
        specOnly: {
          type: "boolean",
          description: "Only generate the spec, don't forge an MCP",
        },
        output: {
          type: "string",
          description: "Output directory for the generated MCP",
        },
      },
      required: ["targetUrl", "sessionName"],
    },
  },
  {
    name: "forge_import_postman",
    description: `Convert a Postman collection export (.json) into a full MCP server.
Export your Postman collection as JSON, pass the path here, and Forge converts it to OpenAPI then generates the MCP.

Example: forge_import_postman({ collectionPath: "/path/to/collection.json" })`,
    inputSchema: {
      type: "object",
      properties: {
        collectionPath: {
          type: "string",
          description: "Path to the Postman collection JSON export",
        },
        output: {
          type: "string",
          description: "Output directory for the generated MCP",
        },
      },
      required: ["collectionPath"],
    },
  },
  {
    name: "forge_list",
    description: "List all registered MCP servers in ~/.claude/user-mcps.json",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "forge_status",
    description: "Show MCP Forge version, capabilities, and rate limiter health",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "forge_discover_browser",
    description: `Browser-based API discovery using Playwright. Navigates a web app, captures all API calls, and generates an MCP server.
Far more effective than Optic proxy for SPAs (Teams, SharePoint, etc.) that make API calls from the browser.

Flow: Playwright headless → SSO login → passive capture → active navigation → HAR → deduplicate → Forge MCP.

Examples:
- forge_discover_browser({ siteUrl: "https://teams.microsoft.com/v2/", sessionName: "teams" })
- forge_discover_browser({ siteUrl: "https://myapp.com", sessionName: "myapp", timeout: 600, forgeAfter: true })`,
    inputSchema: {
      type: "object",
      properties: {
        siteUrl: {
          type: "string",
          description: "URL of the web app to discover",
        },
        sessionName: {
          type: "string",
          description: "Name for this discovery session",
        },
        loginUrl: {
          type: "string",
          description: "Login page URL if different from siteUrl",
        },
        timeout: {
          type: "number",
          description: "Capture timeout in seconds (default: 300)",
        },
        forgeAfter: {
          type: "boolean",
          description: "Automatically forge an MCP from the captured endpoints (default: false — just capture)",
        },
        output: {
          type: "string",
          description: "Output directory for the generated MCP",
        },
      },
      required: ["siteUrl", "sessionName"],
    },
  },
  {
    name: "forge_merge_captures",
    description: `Merge multiple HAR captures or discovery passes into one deduplicated spec, then forge.
Essential for large APIs where single-pass discovery misses 60-70% of endpoints.

MS365 lesson: We needed 3+ discovery passes (passive → active → deep interactive) to find 311 endpoints.

Example: forge_merge_captures({ harPaths: ["/tmp/pass1.har", "/tmp/pass2.har"], sessionName: "my-api" })`,
    inputSchema: {
      type: "object",
      properties: {
        harPaths: {
          type: "array",
          items: { type: "string" },
          description: "Array of HAR file paths to merge",
        },
        sessionName: {
          type: "string",
          description: "Name for the merged session",
        },
        output: {
          type: "string",
          description: "Output directory for the generated MCP",
        },
      },
      required: ["harPaths", "sessionName"],
    },
  },
];

const server = new Server(
  { name: "mcp-forge", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "forge": {
        const target = (args as any).target as string;
        if (!target) throw new Error("target is required");

        const format = detectInputFormat(target);
        const pipeline = new ForgePipeline({
          target,
          inputFormat: format,
          specPath: ['openapi', 'har', 'swagger'].includes(format) ? target : undefined,
          outputDir: (args as any).output,
          authStrategy: (args as any).auth as AuthStrategy | undefined,
          baseUrl: (args as any).baseUrl,
          dryRun: (args as any).dryRun,
        });

        const result = await pipeline.run();
        const logs = pipeline.getLogs();

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: result.success,
              mcpName: result.mcpName,
              outputDir: result.outputDir,
              toolCount: result.toolCount,
              files: result.files.map((f: { path: string }) => f.path),
              warnings: result.warnings,
              errors: result.errors,
              logs: logs.slice(-20),
            }, null, 2),
          }],
        };
      }

      case "forge_discover": {
        const targetUrl = (args as any).targetUrl as string;
        const sessionName = (args as any).sessionName as string;
        if (!targetUrl || !sessionName) throw new Error("targetUrl and sessionName are required");

        const pipeline = new ForgePipeline({
          target: sessionName,
          inputFormat: 'name_only',
          outputDir: (args as any).output,
        });

        if ((args as any).specOnly) {
          const { startDiscovery } = await import('../discovery/optic.js');
          const discovery = await startDiscovery({
            targetUrl, sessionName,
            proxyPort: (args as any).proxyPort,
            timeout: (args as any).timeout,
          });
          return {
            content: [{
              type: "text",
              text: JSON.stringify(discovery, null, 2),
            }],
          };
        }

        const result = await pipeline.discoverAndForge({
          targetUrl, sessionName,
          proxyPort: (args as any).proxyPort,
          timeout: (args as any).timeout,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: result.success,
              mcpName: result.mcpName,
              outputDir: result.outputDir,
              toolCount: result.toolCount,
              files: result.files.map((f: { path: string }) => f.path),
              warnings: result.warnings,
              logs: pipeline.getLogs().slice(-20),
            }, null, 2),
          }],
        };
      }

      case "forge_import_postman": {
        const collectionPath = (args as any).collectionPath as string;
        if (!collectionPath) throw new Error("collectionPath is required");

        const pipeline = new ForgePipeline({
          target: collectionPath,
          inputFormat: 'name_only',
          outputDir: (args as any).output,
        });

        const result = await pipeline.forgeFromPostman(collectionPath);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: result.success,
              mcpName: result.mcpName,
              outputDir: result.outputDir,
              toolCount: result.toolCount,
              files: result.files.map((f: { path: string }) => f.path),
              warnings: result.warnings,
              logs: pipeline.getLogs().slice(-20),
            }, null, 2),
          }],
        };
      }

      case "forge_list": {
        const servers = listRegistered();
        return {
          content: [{
            type: "text",
            text: JSON.stringify(servers, null, 2),
          }],
        };
      }

      case "forge_status": {
        const servers = listRegistered();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              name: "MCP Forge",
              version: "2.0.0",
              capabilities: [
                "OpenAPI spec → MCP server",
                "HAR file → MCP server",
                "URL probe → MCP server",
                "Known API patterns (ServiceNow, GitHub, Jira, etc.)",
                "Optic reverse proxy → live API discovery",
                "Postman collection import → MCP server",
                "🆕 Playwright browser discovery → SPA API capture → MCP server",
                "🆕 Multi-pass HAR merge with deduplication",
                "🆕 Service-based code splitting (auto-splits >30 tools into modules)",
                "🆕 Multi-token auth (per-service token types)",
                "🆕 Region/tenant auto-detection",
                "Auto auth: API Key, OAuth2, SSO Browser, Bearer, Basic, HAR Capture",
                "macOS Keychain integration",
                "Adaptive rate limiting (token bucket + 429 detection + backoff)",
                "Auto-registration in ~/.claude/user-mcps.json",
                "Auto-build with TypeScript",
              ],
              learnings: "v2.0 built from lessons learned generating the 194-tool MS365 MCP server",
              rateLimiting: {
                generatedMcps: "Every generated MCP gets an adaptive rate limiter baked into its API client.",
                forgePipeline: "MCP Forge itself rate-limits builds and discovery operations.",
              },
              registeredServers: Object.keys(servers).length,
              knownApis: ["servicenow", "github", "jira", "confluence", "slack", "stripe", "akamai", "azure", "ms365"],
            }, null, 2),
          }],
        };
      }

      case "forge_discover_browser": {
        const siteUrl = (args as any).siteUrl as string;
        const sessionName = (args as any).sessionName as string;
        if (!siteUrl || !sessionName) throw new Error("siteUrl and sessionName are required");

        const pipeline = new ForgePipeline({
          target: sessionName,
          inputFormat: 'browser_capture',
          outputDir: (args as any).output,
        });

        const result = await pipeline.discoverWithBrowser({
          siteUrl,
          sessionName,
          loginUrl: (args as any).loginUrl,
          timeout: (args as any).timeout,
          forgeAfter: (args as any).forgeAfter,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      case "forge_merge_captures": {
        const harPaths = (args as any).harPaths as string[];
        const sessionName = (args as any).sessionName as string;
        if (!harPaths?.length || !sessionName) throw new Error("harPaths array and sessionName are required");

        const pipeline = new ForgePipeline({
          target: sessionName,
          inputFormat: 'har',
          outputDir: (args as any).output,
        });

        const result = await pipeline.mergeAndForge(harPaths, sessionName);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: result.success,
              mcpName: result.mcpName,
              outputDir: result.outputDir,
              toolCount: result.toolCount,
              files: result.files.map((f: { path: string }) => f.path),
              warnings: result.warnings,
              logs: pipeline.getLogs().slice(-20),
            }, null, 2),
          }],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Forge error: ${error.message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp-forge] MCP server running v2.0 (7 tools: forge, forge_discover, forge_discover_browser, forge_merge_captures, forge_import_postman, forge_list, forge_status)");
}

main().catch(console.error);
