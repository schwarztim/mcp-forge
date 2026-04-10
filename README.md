# mcp-forge

Autonomous MCP server generator that transforms any REST API into a production-ready Model Context Protocol server.

## Overview

mcp-forge automates the conversion of REST API specifications into fully functional MCP (Model Context Protocol) servers. Rather than manual implementation of protocol bindings, mcp-forge introspects API schemas and generates type-safe, documented server implementations in TypeScript.

The tool is designed for teams needing rapid MCP integrations with external APIs while maintaining production quality, security, and maintainability standards.

## Key Features

- **Automated Server Generation**: Converts REST API specs (OpenAPI, AsyncAPI, or custom JSON schemas) into complete MCP server implementations
- **Type Safety**: Generates TypeScript with strict typing, reducing runtime errors and improving IDE support
- **Resource Definition**: Automatically creates MCP resource lists, templates, and tool definitions from API endpoints
- **Schema Introspection**: Analyzes API metadata to infer proper tool descriptions, parameter validation, and response handling
- **Production Ready**: Generated servers include error handling, input validation, rate limiting, and logging
- **Tool Composition**: Intelligently groups related API endpoints into cohesive tools with proper parameter mapping
- **Documentation Generation**: Creates comprehensive README and tool documentation from API schemas
- **Configuration Management**: Generates environment variable schemas and deployment configurations

## Quick Start

### Prerequisites

- Node.js 18+
- TypeScript 5+
- npm or yarn

### Installation

```bash
npm install -g mcp-forge
# or
git clone https://github.com/schwarztim/mcp-forge.git
cd mcp-forge
npm install
```

### Basic Usage

Generate an MCP server from an OpenAPI specification:

```bash
mcp-forge generate --api-spec ./api.openapi.json --output ./my-mcp-server
```

Or from a URL:

```bash
mcp-forge generate --api-url https://api.example.com/openapi.json --output ./my-mcp-server
```

### Configuration

Create an `mcp-forge.config.json` file in your project root:

```json
{
  "apiSpec": "./api.openapi.json",
  "output": "./dist",
  "serverName": "example-api-mcp",
  "description": "MCP server for Example API",
  "version": "1.0.0",
  "tools": {
    "groupBy": "tag",
    "maxParametersPerTool": 8
  },
  "security": {
    "apiKeyHeader": "X-API-Key",
    "rateLimitPerMinute": 60
  },
  "validation": {
    "validateResponses": true,
    "strictMode": true
  }
}
```

Then run:

```bash
mcp-forge generate
```

### Generated Structure

The output follows standard MCP project layout:

```
my-mcp-server/
├── src/
│   ├── index.ts           # Server entry point
│   ├── tools.ts           # Tool implementations
│   ├── resources.ts       # Resource definitions
│   ├── types.ts           # Generated TypeScript types
│   └── client.ts          # API client (auto-generated)
├── package.json
├── tsconfig.json
├── README.md
└── .env.example
```

## Development

### Building

```bash
npm run build
```

### Testing

```bash
npm test
```

### Linting

```bash
npm run lint
npm run lint:fix
```

## Architecture

mcp-forge consists of three main components:

1. **Schema Parser**: Reads and normalizes API specifications from multiple formats (OpenAPI 3.0+, AsyncAPI, JSON Schema)
2. **Code Generator**: Produces TypeScript code with proper imports, types, and runtime logic
3. **Validator**: Ensures generated servers conform to MCP protocol and best practices

The generator produces:
- MCP resource and tool definitions with full type safety
- HTTP client code with authentication and error handling
- Input validation middleware
- Comprehensive API documentation
- Docker and deployment configurations

## Comparison with thesun

mcp-forge and thesun are both MCP generation tools with different approaches:

- **mcp-forge**: Schema-first generator optimized for REST APIs with existing specifications. Emphasis on declarative generation from well-defined schemas.
- **thesun**: Language model-driven generator that can infer API structure from documentation and conversation. More flexible but requires less formal specifications.

Both produce production-ready MCP servers; choice depends on whether your API has formal specifications available.

## Configuration Options

### Tool Generation

- `groupBy`: How to organize tools - `tag` (OpenAPI tags), `resource` (endpoint patterns), or `operation` (one tool per endpoint)
- `maxParametersPerTool`: Split tools with too many parameters into multiple smaller tools
- `excludeOperations`: Comma-separated list of operation IDs to skip
- `includeOperations`: Whitelist specific operations (overrides excludeOperations)

### Security

- `apiKeyHeader`: Header name for API key authentication
- `apiKeyEnv`: Environment variable name for API key
- `bearerTokenEnv`: Environment variable for Bearer token
- `oauthConfig`: OAuth 2.0 flow configuration

### Validation

- `validateResponses`: Validate API responses against schema (slower but safer)
- `strictMode`: Fail on schema mismatches instead of warning
- `coerceTypes`: Automatically convert parameter types (loose validation)

## Tech Stack

- **Language**: TypeScript
- **MCP SDK**: @modelcontextprotocol/sdk
- **API Parsing**: openapi-types, swagger-parser, ajv (JSON Schema validator)
- **Code Generation**: TypeScript compiler API, handlebars
- **HTTP Client**: axios with retry logic
- **Testing**: Jest
- **Build**: esbuild
- **Linting**: ESLint + Prettier

## Security Considerations

Generated servers include:

- Input validation on all parameters
- Environment variable-based authentication (no hardcoded secrets)
- Rate limiting and request throttling
- HTTPS enforcement for API calls
- Audit logging for all tool invocations
- Response sanitization to prevent information leakage

## Limitations

- Requires API specification in supported format (OpenAPI 3.0+, AsyncAPI 3.0+, or JSON Schema)
- Generated servers assume stateless REST APIs (not ideal for stateful or streaming APIs)
- Complex authentication flows may require manual adjustments
- GraphQL APIs require wrapper layers for OpenAPI compatibility

## Contributing

Contributions welcome. Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Add tests for new functionality
4. Ensure linting passes (`npm run lint:fix`)
5. Submit a pull request

## License

MIT

## Support

For issues, feature requests, or questions:

- GitHub Issues: https://github.com/schwarztim/mcp-forge/issues
- Discussions: https://github.com/schwarztim/mcp-forge/discussions

## Related Projects

- [thesun](https://github.com/schwarztim/thesun) - Language model-driven MCP generator
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) - Official MCP TypeScript SDK
- [swagger-parser](https://github.com/APIDevTools/swagger-parser) - API specification parser
