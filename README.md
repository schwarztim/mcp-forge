<p align="center">
  <h1 align="center">⚒️ MCP Forge</h1>
  <p align="center">
    <strong>Autonomous MCP server generator</strong><br>
    Turn any REST API into a production-ready <a href="https://modelcontextprotocol.io">Model Context Protocol</a> server — zero manual coding required.
  </p>
  <p align="center">
    <img src="https://img.shields.io/badge/version-2.0.0-blue" alt="Version">
    <img src="https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript" alt="TypeScript">
    <img src="https://img.shields.io/badge/Node.js-≥20-green?logo=node.js" alt="Node">
    <img src="https://img.shields.io/badge/License-MIT-yellow" alt="License">
    <img src="https://img.shields.io/badge/MCP_Tools-7-purple" alt="Tools">
  </p>
</p>

---

## What is MCP Forge?

MCP Forge takes any API — an OpenAPI spec, a HAR traffic capture, a URL, or just a name — and autonomously generates a complete, type-safe MCP server that Claude, Copilot, and other AI assistants can use as tools.

**No manual coding. No boilerplate. No config files to edit.**

```
Input: "servicenow"  →  Output: 8-tool MCP server, built, registered, ready to use.
Input: capture.har   →  Output: Full MCP server from captured API traffic.
Input: spec.yaml     →  Output: Every endpoint becomes an MCP tool.
```

## Features

| Feature | Description |
|---------|-------------|
| **🔍 Multi-Mode Discovery** | OpenAPI specs, HAR files, URLs, Optic proxy, Playwright browser capture |
| **🌐 Browser Discovery** | Navigate SPAs with Playwright, capture every API call automatically |
| **🔀 Multi-Pass Merge** | Combine multiple discovery passes with intelligent deduplication |
| **📦 Auto Code Splitting** | Large APIs (30+ tools) auto-split into service modules |
| **🔐 Keychain Auth** | Tokens stored in macOS Keychain — never plaintext on disk |
| **🔑 Multi-Token Auth** | Per-service token types for complex platforms |
| **🌍 Region Detection** | Auto-detect API regional endpoints (EMEA, AMER, APAC) |
| **⚡ Adaptive Rate Limiting** | Token bucket + 429 detection + backoff baked into every generated MCP |
| **🏗️ Auto Build** | Installs deps, compiles TypeScript, auto-fixes errors |
| **📋 Auto Register** | Adds to `~/.claude/user-mcps.json` for immediate use |

## Quick Start

### Install

```bash
git clone https://github.com/schwarztim/mcp-forge.git
cd mcp-forge
npm install
npm run build
```

### Generate an MCP Server

```bash
# From a known API name
node dist/cli/index.js forge servicenow
node dist/cli/index.js forge github

# From an OpenAPI spec
node dist/cli/index.js forge ./api-spec.yaml

# From a HAR traffic capture
node dist/cli/index.js forge ./captured-traffic.har

# From a URL
node dist/cli/index.js forge https://api.example.com

# Override auth strategy
node dist/cli/index.js forge myapi --auth sso_browser --base-url https://myapi.corp.com

# Dry run (preview without writing files)
node dist/cli/index.js forge stripe --dry-run
```

### Use as an MCP Tool

MCP Forge is itself an MCP server with 7 tools. Register it in `~/.claude/user-mcps.json`:

```json
{
  "mcp-forge": {
    "command": "node",
    "args": ["/path/to/mcp-forge/dist/mcp-server/index.js"]
  }
}
```

Then in Claude: *"Use mcp-forge to create an MCP for Datadog"*

## Tools

| Tool | Description |
|------|-------------|
| `forge` | Generate an MCP server from any input (spec, HAR, URL, name) |
| `forge_discover` | Live API discovery via Optic reverse proxy |
| `forge_discover_browser` | **v2.0** — Playwright browser-based SPA discovery |
| `forge_merge_captures` | **v2.0** — Merge multiple HAR captures with deduplication |
| `forge_import_postman` | Convert a Postman collection to an MCP server |
| `forge_list` | List all registered MCP servers |
| `forge_status` | Version, capabilities, and health check |

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                        MCP Forge Pipeline                       │
│                                                                 │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌────────────┐  │
│  │ Discover │ → │ Analyze  │ → │ Generate │ → │   Build    │  │
│  │          │   │          │   │          │   │            │  │
│  │ • Optic  │   │ • Parse  │   │ • Tools  │   │ • npm i    │  │
│  │ • Browser│   │ • Detect │   │ • Auth   │   │ • tsc      │  │
│  │ • HAR    │   │   auth   │   │ • Client │   │ • Auto-fix │  │
│  │ • Merge  │   │ • Group  │   │ • Split  │   │ • Register │  │
│  └──────────┘   └──────────┘   └──────────┘   └────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Phase 1: Discovery
Accepts any input format and normalizes to an API specification:

- **OpenAPI/Swagger** — Parsed directly
- **HAR File** — Extracted endpoints, methods, parameters
- **URL** — Probed for common API patterns
- **API Name** — Matched against built-in pattern library
- **Browser Capture** — Playwright navigates the app, captures all XHR/fetch calls
- **Multi-Pass Merge** — Deduplicates across multiple captures, parameterizes UUIDs/IDs

### Phase 2: Analysis
Detects authentication strategy, groups endpoints by service, identifies parameters, and maps to MCP tool schemas.

### Phase 3: Generation
Produces a complete TypeScript MCP server:

```
<name>-mcp/
├── src/
│   ├── index.ts          # MCP server — tool registration + handlers
│   ├── auth.ts           # Auth module — Keychain + auto-refresh
│   ├── api-client.ts     # HTTP client — retry + adaptive rate limiting
│   ├── *-client.ts       # Service modules (auto-split for large APIs)
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── run.sh
└── README.md
```

### Phase 4: Build & Register
Installs dependencies, compiles TypeScript (with auto-fix for common errors), and registers in `~/.claude/user-mcps.json`.

## Authentication

Every generated MCP uses **macOS Keychain** for credential storage:

| Strategy | Detection | Storage |
|----------|-----------|---------|
| `api_key` | X-API-Key header in spec | Keychain |
| `bearer` | Bearer token auth | Keychain |
| `oauth2` | OAuth2 flows in spec | Keychain + auto-refresh |
| `sso_browser` | Corporate SSO / OpenID Connect | Playwright + Keychain |
| `basic` | HTTP Basic Auth | Keychain |
| `har_capture` | Session cookies from HAR | Keychain |

**Multi-token support** (v2.0): Complex platforms like Microsoft 365 use different tokens for different services. MCP Forge generates per-service token management automatically.

## Built-in API Patterns

Instant generation from name alone — no spec needed:

| API | Tools | Endpoints |
|-----|-------|-----------|
| ServiceNow | 8 | Table CRUD, CMDB, Catalog, Scripted REST |
| GitHub | 6 | Repos, Issues, PRs, Actions |
| Jira | 7 | Issues, Projects, Boards, Sprints |
| Confluence | 5 | Pages, Spaces, Search |
| Slack | 5 | Channels, Messages, Users |
| Stripe | 6 | Customers, Charges, Subscriptions |
| Akamai | 4 | Properties, Purge, Certificates |
| Azure | 5 | Resource Management |

## v2.0 — Lessons from MS365

Version 2.0 was rebuilt from lessons learned generating a 194-tool Microsoft 365 MCP server:

1. **Browser discovery beats proxy capture** for SPAs — apps like Teams make API calls from the browser, not through a proxy
2. **Multi-pass discovery is essential** — single pass misses 60-70% of endpoints
3. **HAR deduplication** — UUIDs, numeric IDs, emails, and base64 tokens must be parameterized to collapse duplicate endpoints
4. **Service-based code splitting** — APIs with 30+ tools should auto-split into service modules
5. **Multi-token authentication** — complex platforms need different tokens for different services
6. **Region detection** — APIs route to regional endpoints that must be auto-detected

## Project Structure

```
src/
├── analyzer/
│   ├── index.ts          # API analysis and format detection
│   └── known-apis.ts     # Built-in API pattern library
├── auth/
│   └── generator.ts      # Auth code generator (6 strategies + multi-token)
├── cli/
│   └── index.ts          # Command-line interface
├── discovery/
│   ├── optic.ts          # Optic reverse proxy discovery
│   ├── browser.ts        # Playwright browser discovery (v2.0)
│   └── har-merger.ts     # Multi-pass HAR dedup/merge (v2.0)
├── generator/
│   └── index.ts          # MCP server code generator (with auto-splitting)
├── mcp-server/
│   └── index.ts          # MCP Forge as an MCP tool (7 tools)
├── registry/
│   └── index.ts          # ~/.claude/user-mcps.json management
├── utils/
│   ├── rate-limiter.ts   # Adaptive rate limiter (3-layer)
│   └── region-detect.ts  # API region auto-detection (v2.0)
├── pipeline.ts           # Pipeline orchestrator
└── types/
    └── index.ts          # TypeScript type definitions
```

## Requirements

- **Node.js** ≥ 20
- **macOS** (uses Keychain for credential storage)
- **Playwright** (optional, for browser discovery — installed automatically)

## License

MIT © Timothy Schwarz
