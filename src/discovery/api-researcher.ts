/**
 * API Researcher
 *
 * Exhaustively discovers all APIs for a tool before MCP generation.
 * Uses multiple strategies:
 * 1. Web search for existing MCPs and documentation
 * 2. Official vendor API documentation
 * 3. OpenAPI/Swagger spec fetching
 * 4. Endpoint enumeration and validation
 * 5. Gap analysis against reference implementations
 */

import { z } from 'zod';
import axios from 'axios';
import { logger } from '../observability/logger.js';
import {
  ToolSpec,
  DiscoveryResult,
  DiscoveredEndpoint,
  DiscoveredEndpointSchema,
} from '../types/index.js';

/**
 * Research result from web search
 */
export interface WebResearchResult {
  existingMcps: Array<{
    url: string;
    name: string;
    stars?: number;
    lastUpdated?: string;
  }>;
  officialDocs: Array<{
    url: string;
    title: string;
    type: 'api_reference' | 'guide' | 'changelog' | 'other';
  }>;
  openApiSpecs: Array<{
    url: string;
    version: string;
    format: 'openapi3' | 'openapi2' | 'swagger' | 'other';
  }>;
  communityResources: Array<{
    url: string;
    type: 'blog' | 'tutorial' | 'forum' | 'github';
  }>;
}

/**
 * API Researcher class
 */
export class ApiResearcher {
  private httpClient = axios.create({
    timeout: 30000,
    headers: {
      'User-Agent': 'thesun-api-researcher/1.0',
    },
  });

  /**
   * Perform comprehensive research for a tool
   */
  async research(toolSpec: ToolSpec): Promise<DiscoveryResult> {
    const startTime = Date.now();
    logger.info(`Starting API research for ${toolSpec.name}`, { tool: toolSpec.name });

    const result: DiscoveryResult = {
      toolName: toolSpec.name,
      timestamp: new Date(),
      endpoints: [],
      authSchemes: [],
      globalParameters: [],
    };

    try {
      // Step 1: Search for existing implementations
      const webResearch = await this.searchWeb(toolSpec);

      // Step 2: Analyze existing MCPs for reference
      if (webResearch.existingMcps.length > 0) {
        const mcpAnalysis = await this.analyzeExistingMcps(webResearch.existingMcps);
        result.existingMcpAnalysis = mcpAnalysis;
      }

      // Step 3: Fetch and parse OpenAPI specs
      const endpoints = await this.fetchAndParseSpecs(toolSpec, webResearch);
      result.endpoints = endpoints;

      // Step 4: Extract auth schemes
      result.authSchemes = await this.extractAuthSchemes(toolSpec, webResearch);

      // Step 5: Determine rate limits
      result.rateLimits = await this.determineRateLimits(toolSpec, webResearch);

      // Step 6: Gap analysis
      if (result.existingMcpAnalysis?.found) {
        const gaps = await this.identifyGaps(result.endpoints, result.existingMcpAnalysis);
        result.existingMcpAnalysis.gaps = gaps;
      }

      const duration = Date.now() - startTime;
      logger.info(`API research completed for ${toolSpec.name}`, {
        tool: toolSpec.name,
        endpointCount: result.endpoints.length,
        durationMs: duration,
      });

      return result;
    } catch (error) {
      logger.error(`API research failed for ${toolSpec.name}`, {
        tool: toolSpec.name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Search web for existing resources
   * In production, this would use actual web search APIs
   */
  private async searchWeb(toolSpec: ToolSpec): Promise<WebResearchResult> {
    logger.debug(`Searching web for ${toolSpec.name} resources`);

    const result: WebResearchResult = {
      existingMcps: [],
      officialDocs: [],
      openApiSpecs: [],
      communityResources: [],
    };

    // Add known spec sources from tool spec
    if (toolSpec.specSources) {
      for (const source of toolSpec.specSources) {
        if (source.url) {
          result.openApiSpecs.push({
            url: source.url,
            version: 'unknown',
            format: source.type === 'openapi' ? 'openapi3' : 'other',
          });
        }
      }
    }

    // Add known doc URLs
    if (toolSpec.docUrls) {
      for (const url of toolSpec.docUrls) {
        result.officialDocs.push({
          url,
          title: 'Official Documentation',
          type: 'api_reference',
        });
      }
    }

    // Add known existing MCPs
    if (toolSpec.existingMcps) {
      for (const url of toolSpec.existingMcps) {
        result.existingMcps.push({
          url,
          name: `${toolSpec.name}-mcp`,
        });
      }
    }

    return result;
  }

  /**
   * Analyze existing MCP implementations
   */
  private async analyzeExistingMcps(
    mcps: WebResearchResult['existingMcps']
  ): Promise<DiscoveryResult['existingMcpAnalysis']> {
    if (mcps.length === 0) {
      return { found: false };
    }

    // In production, this would actually fetch and analyze the MCP code
    const bestMcp = mcps[0];

    return {
      found: true,
      url: bestMcp.url,
      coverage: undefined, // Would be calculated from analysis
      gaps: [],
    };
  }

  /**
   * Fetch and parse OpenAPI specifications
   */
  private async fetchAndParseSpecs(
    toolSpec: ToolSpec,
    webResearch: WebResearchResult
  ): Promise<DiscoveredEndpoint[]> {
    const endpoints: DiscoveredEndpoint[] = [];

    for (const spec of webResearch.openApiSpecs) {
      try {
        logger.debug(`Fetching OpenAPI spec from ${spec.url}`);
        const response = await this.httpClient.get(spec.url);
        const parsed = await this.parseOpenApiSpec(response.data);
        endpoints.push(...parsed);
      } catch (error) {
        logger.warn(`Failed to fetch spec from ${spec.url}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Also try common spec paths if no specs found
    if (endpoints.length === 0 && toolSpec.vendor) {
      const commonPaths = [
        `/api/v1/openapi.json`,
        `/api/openapi.yaml`,
        `/swagger.json`,
        `/api-docs`,
      ];

      for (const path of commonPaths) {
        try {
          const url = `https://api.${toolSpec.vendor.toLowerCase()}.com${path}`;
          const response = await this.httpClient.get(url);
          const parsed = await this.parseOpenApiSpec(response.data);
          if (parsed.length > 0) {
            endpoints.push(...parsed);
            break;
          }
        } catch {
          // Expected to fail for most paths
        }
      }
    }

    return endpoints;
  }

  /**
   * Parse OpenAPI specification into endpoints
   */
  private async parseOpenApiSpec(spec: unknown): Promise<DiscoveredEndpoint[]> {
    const endpoints: DiscoveredEndpoint[] = [];

    if (!spec || typeof spec !== 'object') {
      return endpoints;
    }

    const specObj = spec as Record<string, unknown>;
    const paths = specObj.paths as Record<string, unknown> | undefined;

    if (!paths) {
      return endpoints;
    }

    for (const [path, pathItem] of Object.entries(paths)) {
      if (!pathItem || typeof pathItem !== 'object') continue;

      const methods = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'] as const;

      for (const method of methods) {
        const operation = (pathItem as Record<string, unknown>)[method];
        if (!operation || typeof operation !== 'object') continue;

        const op = operation as Record<string, unknown>;

        const endpoint: DiscoveredEndpoint = {
          path,
          method: method.toUpperCase() as DiscoveredEndpoint['method'],
          operationId: op.operationId as string | undefined,
          summary: op.summary as string | undefined,
          description: op.description as string | undefined,
          tags: (op.tags as string[]) ?? [],
          parameters: this.parseParameters(op.parameters as unknown[]),
          requestBody: op.requestBody,
          responses: op.responses as Record<string, unknown>,
          security: op.security as unknown[],
          pagination: this.detectPagination(op),
        };

        // Validate with Zod
        const parsed = DiscoveredEndpointSchema.safeParse(endpoint);
        if (parsed.success) {
          endpoints.push(parsed.data);
        }
      }
    }

    logger.debug(`Parsed ${endpoints.length} endpoints from OpenAPI spec`);
    return endpoints;
  }

  /**
   * Parse parameters from OpenAPI operation
   */
  private parseParameters(params: unknown[] | undefined): DiscoveredEndpoint['parameters'] {
    if (!params || !Array.isArray(params)) {
      return [];
    }

    return params
      .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object')
      .map((p) => ({
        name: String(p.name ?? ''),
        in: (p.in as 'path' | 'query' | 'header' | 'cookie') ?? 'query',
        required: Boolean(p.required),
        schema: p.schema,
      }));
  }

  /**
   * Detect pagination support in an operation
   */
  private detectPagination(operation: Record<string, unknown>): DiscoveredEndpoint['pagination'] {
    const params = operation.parameters as unknown[] | undefined;
    if (!params || !Array.isArray(params)) {
      return { supported: false };
    }

    const paramNames = params
      .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object')
      .map((p) => String(p.name ?? '').toLowerCase());

    // Check for common pagination patterns
    const hasOffset = paramNames.some((n) => n.includes('offset') || n.includes('skip'));
    const hasLimit = paramNames.some((n) => n.includes('limit') || n.includes('size') || n.includes('count'));
    const hasPage = paramNames.some((n) => n.includes('page'));
    const hasCursor = paramNames.some((n) => n.includes('cursor') || n.includes('token') || n.includes('after'));

    if (hasCursor) {
      return {
        supported: true,
        style: 'cursor',
        params: paramNames.filter((n) => n.includes('cursor') || n.includes('token') || n.includes('after')),
      };
    }

    if (hasPage) {
      return {
        supported: true,
        style: 'page',
        params: paramNames.filter((n) => n.includes('page')),
      };
    }

    if (hasOffset && hasLimit) {
      return {
        supported: true,
        style: 'offset',
        params: paramNames.filter((n) => n.includes('offset') || n.includes('limit')),
      };
    }

    return { supported: false };
  }

  /**
   * Extract authentication schemes
   */
  private async extractAuthSchemes(
    toolSpec: ToolSpec,
    _webResearch: WebResearchResult
  ): Promise<DiscoveryResult['authSchemes']> {
    // Map from tool auth type to detailed schemes
    const schemes: DiscoveryResult['authSchemes'] = [];

    switch (toolSpec.authType) {
      case 'oauth2':
        schemes.push({
          type: 'oauth2',
          name: 'OAuth 2.0',
          description: 'OAuth 2.0 authentication flow',
        });
        break;
      case 'api_key':
        schemes.push({
          type: 'apiKey',
          name: 'API Key',
          description: 'API key authentication (header or query parameter)',
        });
        break;
      case 'bearer':
        schemes.push({
          type: 'http',
          name: 'Bearer Token',
          description: 'HTTP Bearer authentication',
        });
        break;
      case 'basic':
        schemes.push({
          type: 'http',
          name: 'Basic Auth',
          description: 'HTTP Basic authentication',
        });
        break;
      case 'custom':
        schemes.push({
          type: 'custom',
          name: 'Custom Authentication',
          description: 'Vendor-specific authentication (see documentation)',
        });
        break;
    }

    return schemes;
  }

  /**
   * Determine rate limits from documentation or API headers
   */
  private async determineRateLimits(
    _toolSpec: ToolSpec,
    _webResearch: WebResearchResult
  ): Promise<DiscoveryResult['rateLimits']> {
    // In production, this would analyze docs or make test requests
    // For now, return conservative defaults
    return {
      requestsPerSecond: 10,
      requestsPerMinute: 100,
    };
  }

  /**
   * Identify gaps between discovered endpoints and existing MCP
   */
  private async identifyGaps(
    endpoints: DiscoveredEndpoint[],
    existingMcp: NonNullable<DiscoveryResult['existingMcpAnalysis']>
  ): Promise<string[]> {
    const gaps: string[] = [];

    // In production, this would compare discovered endpoints against
    // the tools exposed by the existing MCP

    if (endpoints.length === 0) {
      gaps.push('No endpoints discovered - manual spec analysis required');
    }

    // Check for common missing features
    const hasPagination = endpoints.some((e) => e.pagination?.supported);
    if (!hasPagination) {
      gaps.push('No pagination support detected - may need manual implementation');
    }

    return gaps;
  }
}

// Singleton instance
let defaultResearcher: ApiResearcher | null = null;

export function getApiResearcher(): ApiResearcher {
  if (!defaultResearcher) {
    defaultResearcher = new ApiResearcher();
  }
  return defaultResearcher;
}
