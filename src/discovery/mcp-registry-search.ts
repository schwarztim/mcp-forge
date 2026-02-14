/**
 * MCP Registry Search
 *
 * Searches multiple registries for existing MCP implementations
 * before generating new ones. This saves time and leverages
 * battle-tested implementations.
 *
 * Search sources (in order of priority):
 * 1. User's installed MCPs (~/.claude/user-mcps.json)
 * 2. npm registry (mcp packages)
 * 3. GitHub (topic:mcp-server + target name)
 * 4. Smithery registry
 *
 * Quality scoring weights:
 * - Coverage: 30% - % of known endpoints implemented
 * - Maintenance: 25% - Last commit date, issue response time
 * - Security: 25% - No vulnerabilities, proper auth handling
 * - Auth Support: 20% - Supports required auth methods
 */

import axios, { AxiosInstance } from "axios";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { logger } from "../observability/logger.js";
import type {
  ExistingMcp,
  McpQualityScore,
  McpSearchResult,
} from "../types/index.js";

/**
 * Configuration options for MCP Registry Search
 */
export interface McpRegistrySearchConfig {
  /** Path to user-mcps.json file */
  userMcpsPath?: string;
  /** HTTP request timeout in milliseconds */
  timeout?: number;
  /** GitHub personal access token for higher rate limits */
  githubToken?: string;
}

/**
 * Inputs for calculating quality score
 */
export interface QualityScoreInputs {
  /** Percentage of endpoints covered (0-100) */
  coverage: number;
  /** Date of last commit/update */
  lastCommitDate?: Date;
  /** Whether the package has known vulnerabilities */
  hasVulnerabilities?: boolean;
  /** Whether required auth methods are supported */
  supportsRequiredAuth?: boolean;
  /** Average days to respond to issues */
  issueResponseTimeDays?: number;
}

/**
 * User MCPs configuration file structure
 */
interface UserMcpsConfig {
  mcpServers?: Record<
    string,
    {
      command: string;
      args?: string[];
      description?: string;
      env?: Record<string, string>;
    }
  >;
}

/**
 * npm search response structure
 */
interface NpmSearchResponse {
  objects?: Array<{
    package: {
      name: string;
      version?: string;
      description?: string;
      date?: string;
    };
    score?: {
      detail?: {
        popularity?: number;
      };
    };
  }>;
}

/**
 * GitHub search response structure
 */
interface GitHubSearchResponse {
  items?: Array<{
    full_name: string;
    html_url: string;
    description?: string;
    stargazers_count?: number;
    updated_at?: string;
  }>;
}

/**
 * Smithery search response structure
 */
interface SmitherySearchResponse {
  servers?: Array<{
    name: string;
    qualifiedName?: string;
    description?: string;
    version?: string;
    homepage?: string;
  }>;
}

/**
 * Searches multiple registries for existing MCP implementations
 */
export class McpRegistrySearch {
  private readonly userMcpsPath: string;
  private readonly httpClient: AxiosInstance;
  private readonly githubToken?: string;

  constructor(config: McpRegistrySearchConfig = {}) {
    this.userMcpsPath =
      config.userMcpsPath ??
      path.join(os.homedir(), ".claude", "user-mcps.json");
    this.githubToken = config.githubToken;

    this.httpClient = axios.create({
      timeout: config.timeout ?? 10000,
      headers: {
        "User-Agent": "thesun-mcp-registry-search/1.0",
        Accept: "application/json",
      },
    });
  }

  /**
   * Search all registries for existing MCP implementations
   */
  async search(
    target: string,
    requiredAuth?: string,
  ): Promise<McpSearchResult> {
    const startTime = Date.now();
    logger.info(`Searching for existing MCPs for target: ${target}`);

    const searched: string[] = [];
    const found: ExistingMcp[] = [];

    // Run all searches in parallel using Promise.allSettled
    const searchPromises = [
      { name: "user-installed", fn: () => this.searchUserInstalled(target) },
      { name: "npm", fn: () => this.searchNpm(target) },
      { name: "github", fn: () => this.searchGitHub(target) },
      { name: "smithery", fn: () => this.searchSmithery(target) },
    ];

    const results = await Promise.allSettled(
      searchPromises.map(async (search) => {
        const mcps = await search.fn();
        return { name: search.name, mcps };
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        searched.push(result.value.name);
        found.push(...result.value.mcps);
      } else {
        logger.warn(`Search failed for source`, { error: result.reason });
      }
    }

    // Calculate scores for all found MCPs
    for (const mcp of found) {
      if (!mcp.score) {
        mcp.score = this.calculateQualityScore({
          coverage: 70, // Default assumption
          lastCommitDate: mcp.lastUpdated,
          supportsRequiredAuth: requiredAuth ? undefined : true,
        });
      }
      mcp.recommendation = this.getIndividualRecommendation(mcp.score.overall);
    }

    // Sort by score (highest first)
    found.sort((a, b) => (b.score?.overall ?? 0) - (a.score?.overall ?? 0));

    // Determine best match and recommendation
    const bestMatch = found.length > 0 ? found[0] : undefined;
    const recommendation = this.getRecommendation(
      bestMatch?.score?.overall ?? 0,
    );

    const duration = Date.now() - startTime;
    logger.info(`MCP search completed`, {
      target,
      foundCount: found.length,
      recommendation,
      durationMs: duration,
    });

    return {
      target,
      searched,
      found,
      bestMatch,
      recommendation,
      timestamp: new Date(),
    };
  }

  /**
   * Search user's installed MCPs
   */
  async searchUserInstalled(target: string): Promise<ExistingMcp[]> {
    const results: ExistingMcp[] = [];

    try {
      const content = await fs.readFile(this.userMcpsPath, "utf-8");
      const config: UserMcpsConfig = JSON.parse(content);

      if (!config.mcpServers) {
        return results;
      }

      const targetLower = target.toLowerCase();

      for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
        const nameLower = name.toLowerCase();
        if (nameLower.includes(targetLower)) {
          results.push({
            name,
            source: "user-installed",
            url: `file://${this.userMcpsPath}#${name}`,
            description: serverConfig.description,
            score: this.calculateQualityScore({
              coverage: 80, // Assume installed MCPs are reasonably complete
              supportsRequiredAuth: true, // Already configured
            }),
          });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(`Failed to read user MCPs`, {
          path: this.userMcpsPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // Return empty array for missing file or parse errors
    }

    return results;
  }

  /**
   * Search npm registry for MCP packages
   */
  async searchNpm(target: string): Promise<ExistingMcp[]> {
    const results: ExistingMcp[] = [];

    try {
      const searchQuery = `mcp ${target}`;
      const response = await this.httpClient.get<NpmSearchResponse>(
        "https://registry.npmjs.org/-/v1/search",
        {
          params: {
            text: searchQuery,
            size: 20,
          },
        },
      );

      if (!response.data.objects) {
        return results;
      }

      for (const obj of response.data.objects) {
        const pkg = obj.package;
        const lastUpdated = pkg.date ? new Date(pkg.date) : undefined;

        results.push({
          name: pkg.name,
          source: "npm",
          url: `https://www.npmjs.com/package/${pkg.name}`,
          version: pkg.version,
          description: pkg.description,
          lastUpdated,
          score: this.calculateQualityScore({
            coverage: Math.round((obj.score?.detail?.popularity ?? 0.5) * 100),
            lastCommitDate: lastUpdated,
          }),
        });
      }
    } catch (error) {
      logger.warn(`npm search failed`, {
        target,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return results;
  }

  /**
   * Search GitHub for MCP repositories
   */
  async searchGitHub(target: string): Promise<ExistingMcp[]> {
    const results: ExistingMcp[] = [];

    try {
      const headers: Record<string, string> = {};
      if (this.githubToken) {
        headers["Authorization"] = `Bearer ${this.githubToken}`;
      }

      const searchQuery = `mcp ${target} in:name,description,readme`;
      const response = await this.httpClient.get<GitHubSearchResponse>(
        "https://api.github.com/search/repositories",
        {
          params: {
            q: searchQuery,
            sort: "stars",
            order: "desc",
            per_page: 20,
          },
          headers,
        },
      );

      if (!response.data.items) {
        return results;
      }

      for (const repo of response.data.items) {
        const lastUpdated = repo.updated_at
          ? new Date(repo.updated_at)
          : undefined;

        results.push({
          name: repo.full_name,
          source: "github",
          url: repo.html_url,
          description: repo.description ?? undefined,
          stars: repo.stargazers_count,
          lastUpdated,
          score: this.calculateQualityScore({
            coverage: Math.min(
              100,
              Math.round((repo.stargazers_count ?? 0) / 50),
            ),
            lastCommitDate: lastUpdated,
          }),
        });
      }
    } catch (error) {
      logger.warn(`GitHub search failed`, {
        target,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return results;
  }

  /**
   * Search Smithery registry for MCP servers
   */
  async searchSmithery(target: string): Promise<ExistingMcp[]> {
    const results: ExistingMcp[] = [];

    try {
      const response = await this.httpClient.get<SmitherySearchResponse>(
        "https://registry.smithery.ai/api/v1/servers",
        {
          params: {
            q: target,
          },
        },
      );

      if (!response.data.servers) {
        return results;
      }

      for (const server of response.data.servers) {
        results.push({
          name: server.qualifiedName ?? server.name,
          source: "smithery",
          url:
            server.homepage ??
            `https://smithery.ai/server/${server.qualifiedName ?? server.name}`,
          version: server.version,
          description: server.description,
          score: this.calculateQualityScore({
            coverage: 75, // Smithery has quality standards
            supportsRequiredAuth: true,
          }),
        });
      }
    } catch (error) {
      logger.warn(`Smithery search failed`, {
        target,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return results;
  }

  /**
   * Calculate quality score for an MCP
   *
   * Weights:
   * - Coverage: 30%
   * - Maintenance: 25%
   * - Security: 25%
   * - Auth Support: 20%
   */
  calculateQualityScore(inputs: QualityScoreInputs): McpQualityScore {
    const coverage = inputs.coverage;

    // Calculate maintenance score based on last commit date
    let maintenance = 50; // Default if no date provided
    if (inputs.lastCommitDate) {
      const daysSinceCommit = Math.floor(
        (Date.now() - inputs.lastCommitDate.getTime()) / (1000 * 60 * 60 * 24),
      );

      if (daysSinceCommit <= 7) {
        maintenance = 100;
      } else if (daysSinceCommit <= 30) {
        maintenance = 90;
      } else if (daysSinceCommit <= 90) {
        maintenance = 70;
      } else if (daysSinceCommit <= 180) {
        maintenance = 50;
      } else if (daysSinceCommit <= 365) {
        maintenance = 30;
      } else {
        maintenance = 10;
      }
    }

    // Adjust maintenance based on issue response time
    if (inputs.issueResponseTimeDays !== undefined) {
      if (inputs.issueResponseTimeDays <= 2) {
        maintenance = Math.min(100, maintenance + 10);
      } else if (inputs.issueResponseTimeDays >= 14) {
        maintenance = Math.max(0, maintenance - 20);
      }
    }

    // Security score
    let security = 100;
    if (inputs.hasVulnerabilities === true) {
      security = 0;
    } else if (inputs.hasVulnerabilities === undefined) {
      security = 75; // Unknown, assume some risk
    }

    // Auth support score
    let authSupport = 50; // Default if unknown
    if (inputs.supportsRequiredAuth === true) {
      authSupport = 100;
    } else if (inputs.supportsRequiredAuth === false) {
      authSupport = 0;
    }

    // Calculate weighted overall score
    const overall = Math.round(
      coverage * 0.3 + maintenance * 0.25 + security * 0.25 + authSupport * 0.2,
    );

    return {
      coverage,
      maintenance,
      security,
      authSupport,
      overall,
    };
  }

  /**
   * Get recommendation based on quality score
   */
  getRecommendation(
    score: number,
  ): "use-existing" | "extend-existing" | "generate-new" {
    if (score >= 90) {
      return "use-existing";
    } else if (score >= 70) {
      return "extend-existing";
    } else {
      return "generate-new";
    }
  }

  /**
   * Get individual MCP recommendation
   */
  private getIndividualRecommendation(
    score: number,
  ): "use" | "extend" | "generate-new" {
    if (score >= 90) {
      return "use";
    } else if (score >= 70) {
      return "extend";
    } else {
      return "generate-new";
    }
  }
}

// Singleton instance
let defaultSearcher: McpRegistrySearch | null = null;

/**
 * Get the default MCP registry searcher instance
 */
export function getMcpRegistrySearch(): McpRegistrySearch {
  if (!defaultSearcher) {
    defaultSearcher = new McpRegistrySearch();
  }
  return defaultSearcher;
}
