/**
 * Discovery Logger
 *
 * Logs all sources discovered during API research phase,
 * tracks which sources were used in generation, and provides
 * transparency into the discovery process.
 */

import {
  DiscoveryLog,
  DiscoverySource,
} from '../types/index.js';
import { logger } from '../observability/logger.js';

/**
 * DiscoveryLogger class for tracking discovery sources
 */
export class DiscoveryLogger {
  private log: DiscoveryLog;

  constructor(toolName: string) {
    this.log = {
      toolName,
      startedAt: new Date(),
      sources: [],
    };
    logger.info('Discovery logging started', { toolName });
  }

  /**
   * Log a discovered source
   */
  addSource(source: Omit<DiscoverySource, 'timestamp'>): void {
    const fullSource: DiscoverySource = {
      ...source,
      timestamp: new Date(),
    };
    this.log.sources.push(fullSource);

    logger.info('Discovery source found', {
      toolName: this.log.toolName,
      type: source.type,
      url: source.url,
      title: source.title,
      relevance: source.relevance,
    });
  }

  /**
   * Log a web search result
   */
  logWebSearch(url: string, title: string, relevance?: number, content?: string): void {
    this.addSource({
      type: 'web_search',
      url,
      title,
      relevance,
      content,
      usedInGeneration: false,
    });
  }

  /**
   * Log an OpenAPI spec discovery
   */
  logOpenApiSpec(url: string, title?: string, content?: string): void {
    this.addSource({
      type: 'openapi_spec',
      url,
      title: title || 'OpenAPI Specification',
      relevance: 1.0, // Specs are always highly relevant
      content,
      usedInGeneration: true, // Specs are always used
    });
  }

  /**
   * Log an existing MCP discovery
   */
  logExistingMcp(url: string, title: string, relevance?: number): void {
    this.addSource({
      type: 'existing_mcp',
      url,
      title,
      relevance,
      usedInGeneration: false,
    });
  }

  /**
   * Log vendor documentation
   */
  logVendorDocs(url: string, title: string, relevance?: number, content?: string): void {
    this.addSource({
      type: 'vendor_docs',
      url,
      title,
      relevance,
      content,
      usedInGeneration: false,
    });
  }

  /**
   * Log GitHub repository
   */
  logGitHub(url: string, title: string, relevance?: number): void {
    this.addSource({
      type: 'github',
      url,
      title,
      relevance,
      usedInGeneration: false,
    });
  }

  /**
   * Log npm package
   */
  logNpm(url: string, title: string, relevance?: number): void {
    this.addSource({
      type: 'npm',
      url,
      title,
      relevance,
      usedInGeneration: false,
    });
  }

  /**
   * Mark a source as used in generation
   */
  markUsed(url: string, reason?: string): void {
    const source = this.log.sources.find((s) => s.url === url);
    if (source) {
      source.usedInGeneration = true;
      if (!this.log.decisions) {
        this.log.decisions = [];
      }
      this.log.decisions.push({
        source: url,
        decision: 'used',
        reason: reason || 'Selected for code generation',
      });
      logger.info('Source marked as used', {
        toolName: this.log.toolName,
        url,
        reason,
      });
    }
  }

  /**
   * Mark a source as rejected
   */
  markRejected(url: string, reason: string): void {
    if (!this.log.decisions) {
      this.log.decisions = [];
    }
    this.log.decisions.push({
      source: url,
      decision: 'rejected',
      reason,
    });
    logger.info('Source rejected', {
      toolName: this.log.toolName,
      url,
      reason,
    });
  }

  /**
   * Complete discovery logging
   */
  complete(): DiscoveryLog {
    this.log.completedAt = new Date();

    // Calculate summary
    const sources = this.log.sources;
    this.log.summary = {
      totalSourcesFound: sources.length,
      sourcesUsed: sources.filter((s) => s.usedInGeneration).length,
      openApiSpecsFound: sources.filter((s) => s.type === 'openapi_spec').length,
      existingMcpsFound: sources.filter((s) => s.type === 'existing_mcp').length,
      vendorDocsFound: sources.filter((s) => s.type === 'vendor_docs').length,
    };

    logger.info('Discovery logging completed', {
      toolName: this.log.toolName,
      duration: this.log.completedAt.getTime() - this.log.startedAt.getTime(),
      ...this.log.summary,
    });

    return this.log;
  }

  /**
   * Get sources by type
   */
  getSourcesByType(type: DiscoverySource['type']): DiscoverySource[] {
    return this.log.sources.filter((s) => s.type === type);
  }

  /**
   * Get all used sources
   */
  getUsedSources(): DiscoverySource[] {
    return this.log.sources.filter((s) => s.usedInGeneration);
  }

  /**
   * Get the full discovery log
   */
  getLog(): DiscoveryLog {
    return this.log;
  }

  /**
   * Export as markdown
   */
  toMarkdown(): string {
    const lines: string[] = [
      `# Discovery Log: ${this.log.toolName}`,
      '',
      `**Started:** ${this.log.startedAt.toISOString()}`,
      this.log.completedAt ? `**Completed:** ${this.log.completedAt.toISOString()}` : '',
      '',
      '## Sources Found',
      '',
    ];

    // Group by type
    const byType = new Map<string, DiscoverySource[]>();
    for (const source of this.log.sources) {
      const existing = byType.get(source.type) || [];
      existing.push(source);
      byType.set(source.type, existing);
    }

    for (const [type, sources] of byType) {
      lines.push(`### ${type.replace(/_/g, ' ').toUpperCase()}`);
      lines.push('');
      for (const source of sources) {
        const used = source.usedInGeneration ? '✅ USED' : '⬜';
        const relevance = source.relevance ? ` (relevance: ${(source.relevance * 100).toFixed(0)}%)` : '';
        lines.push(`- ${used} [${source.title || source.url}](${source.url})${relevance}`);
      }
      lines.push('');
    }

    if (this.log.decisions && this.log.decisions.length > 0) {
      lines.push('## Decisions');
      lines.push('');
      for (const decision of this.log.decisions) {
        const icon = decision.decision === 'used' ? '✅' : decision.decision === 'rejected' ? '❌' : '📎';
        lines.push(`- ${icon} **${decision.decision}**: ${decision.source}`);
        lines.push(`  - Reason: ${decision.reason}`);
      }
      lines.push('');
    }

    if (this.log.summary) {
      lines.push('## Summary');
      lines.push('');
      lines.push(`- Total sources found: ${this.log.summary.totalSourcesFound}`);
      lines.push(`- Sources used: ${this.log.summary.sourcesUsed}`);
      lines.push(`- OpenAPI specs: ${this.log.summary.openApiSpecsFound}`);
      lines.push(`- Existing MCPs: ${this.log.summary.existingMcpsFound}`);
      lines.push(`- Vendor docs: ${this.log.summary.vendorDocsFound}`);
    }

    return lines.join('\n');
  }
}

/**
 * Factory function
 */
export function createDiscoveryLogger(toolName: string): DiscoveryLogger {
  return new DiscoveryLogger(toolName);
}
