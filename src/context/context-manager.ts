/**
 * Context Manager
 *
 * Manages what information stays in context and what gets discarded.
 * Critical for:
 * - Preventing token bloat from irrelevant search results
 * - Keeping agents focused on relevant information
 * - Reducing costs by not carrying garbage
 * - Preventing context pollution that derails reasoning
 *
 * Philosophy: Be AGGRESSIVE about discarding. It's better to re-search
 * than to carry irrelevant data that confuses the agent.
 */

import { z } from 'zod';
import { logger } from '../observability/logger.js';

/**
 * Relevance score thresholds
 */
export const RELEVANCE_THRESHOLDS = {
  /** Below this, discard immediately */
  DISCARD: 0.3,
  /** Below this, summarize aggressively */
  SUMMARIZE: 0.5,
  /** Below this, compress */
  COMPRESS: 0.7,
  /** Above this, keep full detail */
  KEEP_FULL: 0.7,
} as const;

/**
 * Token budget configuration
 */
export interface TokenBudget {
  /** Maximum tokens for search results */
  searchResults: number;
  /** Maximum tokens for accumulated context */
  totalContext: number;
  /** Reserved tokens for agent reasoning */
  reservedForReasoning: number;
  /** Warning threshold (percentage of budget) */
  warningThreshold: number;
}

export const DEFAULT_TOKEN_BUDGET: TokenBudget = {
  searchResults: 10000, // ~2500 words for search results
  totalContext: 50000, // ~12500 words total
  reservedForReasoning: 20000, // Keep 20k tokens free for thinking
  warningThreshold: 0.8,
};

/**
 * Context item with metadata
 */
export interface ContextItem {
  id: string;
  source: 'confluence' | 'jira' | 'servicenow' | 'github' | 'web' | 'file' | 'user';
  type: 'search_result' | 'document' | 'issue' | 'code' | 'summary' | 'fact';
  content: string;
  relevanceScore: number;
  tokenCount: number;
  addedAt: Date;
  lastAccessedAt: Date;
  accessCount: number;
  query?: string; // What query produced this
  compressed?: boolean;
  originalTokenCount?: number; // Before compression
}

/**
 * Relevance evaluation result
 */
export interface RelevanceEvaluation {
  score: number;
  reasoning: string;
  keyFacts: string[]; // What's actually useful
  irrelevantParts: string[]; // What should be discarded
  suggestedAction: 'keep' | 'summarize' | 'compress' | 'discard';
}

/**
 * Context state snapshot
 */
export interface ContextSnapshot {
  totalTokens: number;
  itemCount: number;
  bySource: Record<string, { count: number; tokens: number }>;
  byRelevance: {
    high: number;
    medium: number;
    low: number;
  };
  discardedCount: number;
  discardedTokens: number;
}

/**
 * Context Manager
 */
export class ContextManager {
  private items: Map<string, ContextItem> = new Map();
  private discardedLog: { id: string; reason: string; timestamp: Date }[] = [];
  private budget: TokenBudget;
  private jobId: string;
  private currentQuery: string = '';

  constructor(jobId: string, budget?: Partial<TokenBudget>) {
    this.jobId = jobId;
    this.budget = { ...DEFAULT_TOKEN_BUDGET, ...budget };
  }

  /**
   * Set the current query/task context for relevance evaluation
   */
  setCurrentQuery(query: string): void {
    this.currentQuery = query;
    logger.debug('Context query updated', { jobId: this.jobId, query });
  }

  /**
   * Add a search result with relevance evaluation
   * Returns what was actually kept (may be compressed/summarized)
   */
  async addSearchResult(
    source: ContextItem['source'],
    content: string,
    query: string,
    evaluateRelevance: (content: string, query: string) => Promise<RelevanceEvaluation>
  ): Promise<{ kept: boolean; reason: string; item?: ContextItem }> {
    // Evaluate relevance BEFORE adding
    const evaluation = await evaluateRelevance(content, this.currentQuery || query);

    logger.debug('Relevance evaluation', {
      jobId: this.jobId,
      source,
      score: evaluation.score,
      action: evaluation.suggestedAction,
    });

    // Discard if below threshold
    if (evaluation.score < RELEVANCE_THRESHOLDS.DISCARD) {
      this.discardedLog.push({
        id: crypto.randomUUID(),
        reason: `Low relevance (${evaluation.score.toFixed(2)}): ${evaluation.reasoning}`,
        timestamp: new Date(),
      });

      logger.info('Discarding irrelevant search result', {
        jobId: this.jobId,
        source,
        score: evaluation.score,
        reason: evaluation.reasoning,
      });

      return {
        kept: false,
        reason: `Discarded: ${evaluation.reasoning}`,
      };
    }

    // Determine what to keep
    let finalContent: string;
    let compressed = false;

    if (evaluation.score < RELEVANCE_THRESHOLDS.SUMMARIZE) {
      // Extract only key facts
      finalContent = this.extractKeyFacts(evaluation.keyFacts);
      compressed = true;
    } else if (evaluation.score < RELEVANCE_THRESHOLDS.COMPRESS) {
      // Remove irrelevant parts, keep structure
      finalContent = this.removeIrrelevantParts(content, evaluation.irrelevantParts);
      compressed = true;
    } else {
      // Keep full content
      finalContent = content;
    }

    // Check token budget
    const tokenCount = this.estimateTokens(finalContent);
    const currentTokens = this.getTotalTokens();

    if (currentTokens + tokenCount > this.budget.searchResults) {
      // Need to make room - evict lowest relevance items
      await this.evictToMakeRoom(tokenCount);
    }

    // Create and store item
    const item: ContextItem = {
      id: crypto.randomUUID(),
      source,
      type: 'search_result',
      content: finalContent,
      relevanceScore: evaluation.score,
      tokenCount,
      addedAt: new Date(),
      lastAccessedAt: new Date(),
      accessCount: 1,
      query,
      compressed,
      originalTokenCount: compressed ? this.estimateTokens(content) : undefined,
    };

    this.items.set(item.id, item);

    logger.info('Added search result to context', {
      jobId: this.jobId,
      source,
      relevance: evaluation.score,
      tokens: tokenCount,
      compressed,
    });

    return {
      kept: true,
      reason: compressed ? 'Kept (compressed)' : 'Kept (full)',
      item,
    };
  }

  /**
   * Add a verified fact (high confidence, always kept)
   */
  addFact(fact: string, source: ContextItem['source']): ContextItem {
    const item: ContextItem = {
      id: crypto.randomUUID(),
      source,
      type: 'fact',
      content: fact,
      relevanceScore: 1.0, // Facts are always relevant
      tokenCount: this.estimateTokens(fact),
      addedAt: new Date(),
      lastAccessedAt: new Date(),
      accessCount: 1,
    };

    this.items.set(item.id, item);
    return item;
  }

  /**
   * Get all context as formatted string for agent consumption
   */
  getContextForAgent(): string {
    // Sort by relevance, then by recency
    const sortedItems = Array.from(this.items.values())
      .sort((a, b) => {
        if (b.relevanceScore !== a.relevanceScore) {
          return b.relevanceScore - a.relevanceScore;
        }
        return b.lastAccessedAt.getTime() - a.lastAccessedAt.getTime();
      });

    // Format for agent
    const sections: string[] = [];

    // Group by source
    const bySource = new Map<string, ContextItem[]>();
    for (const item of sortedItems) {
      const list = bySource.get(item.source) ?? [];
      list.push(item);
      bySource.set(item.source, list);
    }

    for (const [source, items] of bySource) {
      if (items.length === 0) continue;

      sections.push(`\n## Context from ${source.toUpperCase()}\n`);

      for (const item of items) {
        const marker = item.type === 'fact' ? '✓' : '•';
        const relevance = item.relevanceScore >= 0.7 ? '' : ` [relevance: ${item.relevanceScore.toFixed(1)}]`;
        sections.push(`${marker} ${item.content}${relevance}\n`);
      }
    }

    return sections.join('');
  }

  /**
   * Prune context - remove low-value items
   */
  prune(): { removed: number; tokensSaved: number } {
    const toRemove: string[] = [];
    let tokensSaved = 0;

    for (const [id, item] of this.items) {
      // Remove items that haven't been accessed and have low relevance
      if (item.accessCount === 1 && item.relevanceScore < RELEVANCE_THRESHOLDS.SUMMARIZE) {
        const age = Date.now() - item.addedAt.getTime();
        if (age > 5 * 60 * 1000) { // Older than 5 minutes
          toRemove.push(id);
          tokensSaved += item.tokenCount;
        }
      }
    }

    for (const id of toRemove) {
      const item = this.items.get(id);
      this.items.delete(id);
      this.discardedLog.push({
        id,
        reason: 'Pruned: low relevance, unused',
        timestamp: new Date(),
      });
    }

    if (toRemove.length > 0) {
      logger.info('Context pruned', {
        jobId: this.jobId,
        removed: toRemove.length,
        tokensSaved,
      });
    }

    return { removed: toRemove.length, tokensSaved };
  }

  /**
   * Get snapshot of current context state
   */
  getSnapshot(): ContextSnapshot {
    const bySource: Record<string, { count: number; tokens: number }> = {};
    let highRelevance = 0;
    let mediumRelevance = 0;
    let lowRelevance = 0;
    let totalTokens = 0;

    for (const item of this.items.values()) {
      totalTokens += item.tokenCount;

      if (!bySource[item.source]) {
        bySource[item.source] = { count: 0, tokens: 0 };
      }
      bySource[item.source].count++;
      bySource[item.source].tokens += item.tokenCount;

      if (item.relevanceScore >= RELEVANCE_THRESHOLDS.KEEP_FULL) {
        highRelevance++;
      } else if (item.relevanceScore >= RELEVANCE_THRESHOLDS.SUMMARIZE) {
        mediumRelevance++;
      } else {
        lowRelevance++;
      }
    }

    return {
      totalTokens,
      itemCount: this.items.size,
      bySource,
      byRelevance: {
        high: highRelevance,
        medium: mediumRelevance,
        low: lowRelevance,
      },
      discardedCount: this.discardedLog.length,
      discardedTokens: 0, // Would need to track this
    };
  }

  /**
   * Check if context is within budget
   */
  isWithinBudget(): { ok: boolean; usage: number; budget: number; warning?: string } {
    const totalTokens = this.getTotalTokens();
    const usage = totalTokens / this.budget.totalContext;

    if (usage > 1) {
      return {
        ok: false,
        usage: totalTokens,
        budget: this.budget.totalContext,
        warning: 'Context budget exceeded!',
      };
    }

    if (usage > this.budget.warningThreshold) {
      return {
        ok: true,
        usage: totalTokens,
        budget: this.budget.totalContext,
        warning: `Context at ${(usage * 100).toFixed(0)}% of budget`,
      };
    }

    return {
      ok: true,
      usage: totalTokens,
      budget: this.budget.totalContext,
    };
  }

  /**
   * Clear all context (for fresh start)
   */
  clear(): void {
    const count = this.items.size;
    this.items.clear();
    logger.info('Context cleared', { jobId: this.jobId, itemsCleared: count });
  }

  // === Private Methods ===

  private getTotalTokens(): number {
    let total = 0;
    for (const item of this.items.values()) {
      total += item.tokenCount;
    }
    return total;
  }

  private estimateTokens(text: string): number {
    // Rough estimate: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  private extractKeyFacts(facts: string[]): string {
    if (facts.length === 0) {
      return '[No key facts extracted]';
    }
    return 'Key facts:\n' + facts.map((f) => `• ${f}`).join('\n');
  }

  private removeIrrelevantParts(content: string, irrelevantParts: string[]): string {
    let result = content;
    for (const part of irrelevantParts) {
      // Simple removal - in production, would be smarter
      result = result.replace(part, '');
    }
    return result.trim();
  }

  private async evictToMakeRoom(neededTokens: number): Promise<void> {
    // Sort by relevance (ascending) then by age (oldest first)
    const candidates = Array.from(this.items.entries())
      .filter(([_, item]) => item.type !== 'fact') // Never evict facts
      .sort(([_, a], [__, b]) => {
        if (a.relevanceScore !== b.relevanceScore) {
          return a.relevanceScore - b.relevanceScore;
        }
        return a.addedAt.getTime() - b.addedAt.getTime();
      });

    let freedTokens = 0;
    const evicted: string[] = [];

    for (const [id, item] of candidates) {
      if (freedTokens >= neededTokens) break;

      this.items.delete(id);
      freedTokens += item.tokenCount;
      evicted.push(id);

      this.discardedLog.push({
        id,
        reason: `Evicted to make room (relevance: ${item.relevanceScore.toFixed(2)})`,
        timestamp: new Date(),
      });
    }

    logger.info('Evicted items to make room', {
      jobId: this.jobId,
      evicted: evicted.length,
      freedTokens,
      neededTokens,
    });
  }
}

/**
 * Create relevance evaluator function
 * This would typically call an LLM to evaluate relevance
 */
export function createRelevanceEvaluator(
  evaluateFn: (content: string, query: string) => Promise<{ score: number; reasoning: string; keyFacts: string[] }>
): (content: string, query: string) => Promise<RelevanceEvaluation> {
  return async (content: string, query: string): Promise<RelevanceEvaluation> => {
    const result = await evaluateFn(content, query);

    let suggestedAction: RelevanceEvaluation['suggestedAction'];
    if (result.score < RELEVANCE_THRESHOLDS.DISCARD) {
      suggestedAction = 'discard';
    } else if (result.score < RELEVANCE_THRESHOLDS.SUMMARIZE) {
      suggestedAction = 'summarize';
    } else if (result.score < RELEVANCE_THRESHOLDS.COMPRESS) {
      suggestedAction = 'compress';
    } else {
      suggestedAction = 'keep';
    }

    return {
      score: result.score,
      reasoning: result.reasoning,
      keyFacts: result.keyFacts,
      irrelevantParts: [], // Would be populated by smarter analysis
      suggestedAction,
    };
  };
}
