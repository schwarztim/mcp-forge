/**
 * Knowledge Aggregator
 *
 * Unified interface for gathering context from multiple enterprise sources:
 * - Confluence: Documentation, architecture, runbooks
 * - Jira: Issues, solutions, implementation patterns, team knowledge
 * - ServiceNow: Incidents, problems, changes, resolutions
 * - GitHub: Existing implementations, discussions, code patterns
 * - Web: API documentation, tutorials, Stack Overflow, official docs
 *
 * This powers the "context-aware" generation by understanding:
 * - How similar tools were implemented
 * - Common issues and their solutions
 * - Team preferences and patterns
 * - Public API documentation and best practices
 *
 * CRITICAL: All results pass through ContextManager for relevance filtering.
 * Irrelevant results are discarded BEFORE entering the context window.
 */

import { z } from 'zod';
import { logger } from '../observability/logger.js';
import { ContextManager, ContextItem } from '../context/context-manager.js';
import { RelevanceEvaluator, createRelevanceEvaluatorFn } from '../context/relevance-evaluator.js';

/**
 * Knowledge source types
 */
export type KnowledgeSource = 'confluence' | 'jira' | 'servicenow' | 'github' | 'web';

/**
 * Knowledge item schema
 */
export const KnowledgeItemSchema = z.object({
  id: z.string(),
  source: z.enum(['confluence', 'jira', 'servicenow', 'github', 'web']),
  type: z.enum([
    'documentation',
    'issue',
    'incident',
    'problem',
    'change',
    'solution',
    'runbook',
    'code',
    'discussion',
  ]),
  title: z.string(),
  content: z.string(),
  url: z.string().url().optional(),
  metadata: z.record(z.unknown()).optional(),
  relevanceScore: z.number().min(0).max(1).optional(),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});

export type KnowledgeItem = z.infer<typeof KnowledgeItemSchema>;

/**
 * Search query for knowledge
 */
export interface KnowledgeQuery {
  /** Free-text search query */
  query: string;
  /** Filter by sources */
  sources?: KnowledgeSource[];
  /** Filter by knowledge types */
  types?: KnowledgeItem['type'][];
  /** Filter by tool/integration name */
  toolName?: string;
  /** Maximum results per source */
  limit?: number;
  /** Include resolved/closed items */
  includeResolved?: boolean;
}

/**
 * Aggregated search results
 */
export interface KnowledgeResults {
  items: KnowledgeItem[];
  totalCount: number;
  sources: {
    source: KnowledgeSource;
    count: number;
    searchTime: number;
  }[];
  query: KnowledgeQuery;
}

/**
 * Source-specific client interface
 */
export interface KnowledgeSourceClient {
  search(query: KnowledgeQuery): Promise<KnowledgeItem[]>;
  isAvailable(): Promise<boolean>;
}

/**
 * Knowledge Aggregator class
 *
 * Now integrates with ContextManager to filter irrelevant results
 * BEFORE they enter the context window. This is critical for preventing
 * token bloat and context pollution.
 */
export class KnowledgeAggregator {
  private clients: Map<KnowledgeSource, KnowledgeSourceClient> = new Map();
  private contextManager?: ContextManager;
  private relevanceEvaluator?: RelevanceEvaluator;

  /**
   * Set the context manager for relevance filtering
   */
  setContextManager(contextManager: ContextManager, jobId: string): void {
    this.contextManager = contextManager;
    this.relevanceEvaluator = new RelevanceEvaluator(jobId);
    logger.info('Context manager attached to knowledge aggregator', { jobId });
  }

  /**
   * Register a knowledge source client
   */
  registerClient(source: KnowledgeSource, client: KnowledgeSourceClient): void {
    this.clients.set(source, client);
    logger.info(`Registered knowledge source: ${source}`);
  }

  /**
   * Search across all registered sources
   * Results are filtered through ContextManager if set
   */
  async search(query: KnowledgeQuery): Promise<KnowledgeResults> {
    const startTime = Date.now();
    const sources = query.sources ?? Array.from(this.clients.keys());
    const limit = query.limit ?? 10;

    logger.info('Searching knowledge sources', {
      query: query.query,
      sources,
      toolName: query.toolName,
    });

    const sourceResults: KnowledgeResults['sources'] = [];
    const allItems: KnowledgeItem[] = [];

    // Search all sources in parallel
    const searchPromises = sources.map(async (source) => {
      const client = this.clients.get(source);
      if (!client) {
        logger.warn(`No client registered for source: ${source}`);
        return { source, items: [], time: 0 };
      }

      const sourceStart = Date.now();
      try {
        const isAvailable = await client.isAvailable();
        if (!isAvailable) {
          logger.warn(`Source not available: ${source}`);
          return { source, items: [], time: Date.now() - sourceStart };
        }

        const items = await client.search({ ...query, limit });
        return { source, items, time: Date.now() - sourceStart };
      } catch (error) {
        logger.error(`Error searching ${source}`, {
          error: error instanceof Error ? error.message : String(error),
        });
        return { source, items: [], time: Date.now() - sourceStart };
      }
    });

    const results = await Promise.all(searchPromises);

    let rawItemCount = 0;
    let discardedCount = 0;

    for (const result of results) {
      rawItemCount += result.items.length;

      // Filter through context manager if available
      if (this.contextManager && this.relevanceEvaluator) {
        const evaluateFn = createRelevanceEvaluatorFn(this.relevanceEvaluator);

        for (const item of result.items) {
          const addResult = await this.contextManager.addSearchResult(
            item.source,
            item.content,
            query.query,
            evaluateFn
          );

          if (addResult.kept && addResult.item) {
            // Update the item with the context manager's relevance score
            item.relevanceScore = addResult.item.relevanceScore;
            allItems.push(item);
          } else {
            discardedCount++;
            logger.debug('Search result filtered out', {
              source: result.source,
              reason: addResult.reason,
              title: item.title?.slice(0, 50),
            });
          }
        }

        sourceResults.push({
          source: result.source,
          count: result.items.length - discardedCount,
          searchTime: result.time,
        });
      } else {
        // No context manager - add all items (legacy behavior)
        sourceResults.push({
          source: result.source,
          count: result.items.length,
          searchTime: result.time,
        });
        allItems.push(...result.items);
      }
    }

    // Sort by relevance score (if available) then by recency
    allItems.sort((a, b) => {
      if (a.relevanceScore !== undefined && b.relevanceScore !== undefined) {
        return b.relevanceScore - a.relevanceScore;
      }
      const aTime = a.updatedAt?.getTime() ?? 0;
      const bTime = b.updatedAt?.getTime() ?? 0;
      return bTime - aTime;
    });

    const totalTime = Date.now() - startTime;
    logger.info('Knowledge search completed', {
      rawItems: rawItemCount,
      keptItems: allItems.length,
      discardedItems: discardedCount,
      filteringEnabled: !!this.contextManager,
      totalTime,
      sources: sourceResults.map((s) => `${s.source}:${s.count}`).join(', '),
    });

    return {
      items: allItems,
      totalCount: allItems.length,
      sources: sourceResults,
      query,
    };
  }

  /**
   * Get context for a specific tool/integration
   */
  async getToolContext(toolName: string): Promise<KnowledgeResults> {
    return this.search({
      query: toolName,
      toolName,
      types: ['documentation', 'issue', 'solution', 'runbook'],
      includeResolved: true,
      limit: 20,
    });
  }

  /**
   * Get similar issues and their solutions
   */
  async getSimilarIssues(description: string): Promise<KnowledgeResults> {
    return this.search({
      query: description,
      types: ['issue', 'incident', 'problem'],
      includeResolved: true,
      limit: 15,
    });
  }

  /**
   * Get implementation patterns for a tool type
   */
  async getImplementationPatterns(toolType: string): Promise<KnowledgeResults> {
    return this.search({
      query: `${toolType} implementation pattern MCP integration`,
      types: ['documentation', 'code', 'solution'],
      sources: ['confluence', 'github', 'jira'],
      limit: 10,
    });
  }

  /**
   * Find related incidents/problems for error diagnosis
   */
  async findRelatedIncidents(errorSignature: string): Promise<KnowledgeResults> {
    return this.search({
      query: errorSignature,
      types: ['incident', 'problem'],
      sources: ['servicenow', 'jira'],
      includeResolved: true,
      limit: 10,
    });
  }
}

/**
 * Jira Knowledge Client (stub - would use actual Jira API)
 */
export class JiraKnowledgeClient implements KnowledgeSourceClient {
  private baseUrl: string;
  private apiToken: string;

  constructor(config: { baseUrl: string; apiToken: string }) {
    this.baseUrl = config.baseUrl;
    this.apiToken = config.apiToken;
  }

  async isAvailable(): Promise<boolean> {
    // Would check API connectivity
    return !!this.apiToken;
  }

  async search(query: KnowledgeQuery): Promise<KnowledgeItem[]> {
    // In production, would use Jira REST API or MCP
    // JQL query would be constructed from query params
    logger.debug('Jira search', { query: query.query, toolName: query.toolName });

    // Stub - would return actual Jira issues
    return [];
  }
}

/**
 * Confluence Knowledge Client (stub - would use actual Confluence API)
 */
export class ConfluenceKnowledgeClient implements KnowledgeSourceClient {
  private baseUrl: string;
  private apiToken: string;

  constructor(config: { baseUrl: string; apiToken: string }) {
    this.baseUrl = config.baseUrl;
    this.apiToken = config.apiToken;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiToken;
  }

  async search(query: KnowledgeQuery): Promise<KnowledgeItem[]> {
    // Would use Confluence CQL search
    logger.debug('Confluence search', { query: query.query });
    return [];
  }
}

/**
 * ServiceNow Knowledge Client (stub - would use ServiceNow API)
 */
export class ServiceNowKnowledgeClient implements KnowledgeSourceClient {
  private instanceUrl: string;
  private credentials: { username: string; password: string };

  constructor(config: { instanceUrl: string; username: string; password: string }) {
    this.instanceUrl = config.instanceUrl;
    this.credentials = { username: config.username, password: config.password };
  }

  async isAvailable(): Promise<boolean> {
    return !!this.credentials.username;
  }

  async search(query: KnowledgeQuery): Promise<KnowledgeItem[]> {
    // Would search incidents, problems, changes, KB articles
    logger.debug('ServiceNow search', { query: query.query });

    // Would construct queries like:
    // - Incidents: /api/now/table/incident?sysparm_query=short_descriptionLIKE${query}
    // - Problems: /api/now/table/problem?sysparm_query=...
    // - Knowledge: /api/now/table/kb_knowledge?sysparm_query=...

    return [];
  }
}

/**
 * GitHub Knowledge Client (for existing implementations, discussions)
 */
export class GitHubKnowledgeClient implements KnowledgeSourceClient {
  private token: string;

  constructor(config: { token: string }) {
    this.token = config.token;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.token;
  }

  async search(query: KnowledgeQuery): Promise<KnowledgeItem[]> {
    // Would use GitHub Search API for:
    // - Existing MCP implementations
    // - Issues and discussions
    // - Code patterns
    logger.debug('GitHub search', { query: query.query });
    return [];
  }
}

/**
 * Web Search Knowledge Client
 *
 * Searches the public web for:
 * - Official API documentation
 * - OpenAPI/Swagger specifications
 * - Stack Overflow discussions
 * - Blog posts and tutorials
 * - Existing MCP implementations
 *
 * CRITICAL: Web search results are the noisiest and MUST be filtered
 * aggressively through the ContextManager.
 */
export class WebSearchKnowledgeClient implements KnowledgeSourceClient {
  private searchProvider: 'brave' | 'serper' | 'tavily';
  private apiKey: string;

  constructor(config: { provider: 'brave' | 'serper' | 'tavily'; apiKey: string }) {
    this.searchProvider = config.provider;
    this.apiKey = config.apiKey;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  async search(query: KnowledgeQuery): Promise<KnowledgeItem[]> {
    const searchQuery = this.buildSearchQuery(query);
    logger.debug('Web search', {
      query: searchQuery,
      provider: this.searchProvider,
      toolName: query.toolName,
    });

    // In production, would call the actual search API:
    // - Brave Search API: https://api.search.brave.com/res/v1/web/search
    // - Serper: https://google.serper.dev/search
    // - Tavily: https://api.tavily.com/search

    // Would search for:
    // 1. Official API documentation
    // 2. OpenAPI/Swagger specs
    // 3. Existing MCP implementations on GitHub
    // 4. Stack Overflow questions and answers
    // 5. Blog posts about the integration

    return [];
  }

  private buildSearchQuery(query: KnowledgeQuery): string {
    const parts = [query.query];

    if (query.toolName) {
      // Add tool-specific search modifiers
      parts.push(`${query.toolName} API documentation`);
    }

    // Add type-specific filters
    if (query.types?.includes('documentation')) {
      parts.push('official documentation');
    }
    if (query.types?.includes('code')) {
      parts.push('github MCP server');
    }

    return parts.join(' ');
  }

  /**
   * Search specifically for OpenAPI/Swagger specs
   */
  async searchOpenApiSpecs(toolName: string): Promise<KnowledgeItem[]> {
    const searchQuery = `${toolName} openapi swagger spec site:github.com OR site:apis.guru`;
    logger.debug('OpenAPI spec search', { toolName, query: searchQuery });
    return [];
  }

  /**
   * Search for existing MCP implementations
   */
  async searchExistingMCPs(toolName: string): Promise<KnowledgeItem[]> {
    const searchQuery = `${toolName} MCP server "model context protocol" site:github.com`;
    logger.debug('Existing MCP search', { toolName, query: searchQuery });
    return [];
  }
}

// Singleton instance
let aggregator: KnowledgeAggregator | null = null;

export function getKnowledgeAggregator(): KnowledgeAggregator {
  if (!aggregator) {
    aggregator = new KnowledgeAggregator();

    // Register clients based on available env vars
    if (process.env.JIRA_BASE_URL && process.env.JIRA_API_TOKEN) {
      aggregator.registerClient(
        'jira',
        new JiraKnowledgeClient({
          baseUrl: process.env.JIRA_BASE_URL,
          apiToken: process.env.JIRA_API_TOKEN,
        })
      );
    }

    if (process.env.CONFLUENCE_BASE_URL && process.env.CONFLUENCE_API_TOKEN) {
      aggregator.registerClient(
        'confluence',
        new ConfluenceKnowledgeClient({
          baseUrl: process.env.CONFLUENCE_BASE_URL,
          apiToken: process.env.CONFLUENCE_API_TOKEN,
        })
      );
    }

    if (process.env.SERVICENOW_INSTANCE && process.env.SERVICENOW_USERNAME) {
      aggregator.registerClient(
        'servicenow',
        new ServiceNowKnowledgeClient({
          instanceUrl: process.env.SERVICENOW_INSTANCE,
          username: process.env.SERVICENOW_USERNAME,
          password: process.env.SERVICENOW_PASSWORD ?? '',
        })
      );
    }

    if (process.env.GITHUB_TOKEN) {
      aggregator.registerClient(
        'github',
        new GitHubKnowledgeClient({
          token: process.env.GITHUB_TOKEN,
        })
      );
    }

    // Web search - supports multiple providers
    const webSearchProvider = (process.env.WEB_SEARCH_PROVIDER as 'brave' | 'serper' | 'tavily') || 'brave';
    const webSearchApiKey =
      process.env.BRAVE_API_KEY ||
      process.env.SERPER_API_KEY ||
      process.env.TAVILY_API_KEY;

    if (webSearchApiKey) {
      aggregator.registerClient(
        'web',
        new WebSearchKnowledgeClient({
          provider: webSearchProvider,
          apiKey: webSearchApiKey,
        })
      );
    }
  }

  return aggregator;
}
