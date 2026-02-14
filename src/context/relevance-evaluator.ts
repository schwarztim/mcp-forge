/**
 * Relevance Evaluator
 *
 * Uses Haiku (fast, cheap) to evaluate whether search results
 * are relevant to the current task. This prevents context pollution
 * by aggressively filtering out irrelevant results BEFORE they
 * enter the context window.
 *
 * Applies to ALL sources:
 * - Confluence, Jira, ServiceNow, GitHub
 * - Web searches (critical - these are often the noisiest)
 * - File searches
 */

import { logger } from '../observability/logger.js';
import { RelevanceEvaluation, RELEVANCE_THRESHOLDS } from './context-manager.js';

export interface EvaluationRequest {
  content: string;
  query: string;
  source: 'confluence' | 'jira' | 'servicenow' | 'github' | 'web' | 'file' | 'user';
  contentType?: string;
  url?: string;
}

export interface EvaluationResult {
  score: number;
  reasoning: string;
  keyFacts: string[];
  irrelevantParts: string[];
  suggestedAction: 'keep' | 'summarize' | 'compress' | 'discard';
}

/**
 * Relevance Evaluator using Haiku
 *
 * The evaluator uses Haiku because:
 * 1. It's fast (~200ms vs ~2s for Sonnet)
 * 2. It's cheap ($1/MTok vs $15/MTok for Opus)
 * 3. Relevance scoring is a well-defined task that doesn't need Opus-level reasoning
 * 4. We call this MANY times (every search result), so cost/speed matters
 */
export class RelevanceEvaluator {
  private jobId: string;
  private evaluationCache: Map<string, EvaluationResult> = new Map();

  constructor(jobId: string) {
    this.jobId = jobId;
  }

  /**
   * Evaluate relevance of content to query
   *
   * In production, this would call Haiku with a prompt like:
   * "Rate relevance 0-1, extract key facts, identify irrelevant parts"
   */
  async evaluate(request: EvaluationRequest): Promise<EvaluationResult> {
    const cacheKey = this.getCacheKey(request);

    // Check cache first
    const cached = this.evaluationCache.get(cacheKey);
    if (cached) {
      logger.debug('Relevance evaluation cache hit', { jobId: this.jobId });
      return cached;
    }

    logger.debug('Evaluating relevance', {
      jobId: this.jobId,
      source: request.source,
      contentLength: request.content.length,
      query: request.query.slice(0, 50),
    });

    // In production, this would be an actual Haiku call
    // For now, implement heuristic-based evaluation
    const result = await this.heuristicEvaluate(request);

    // Cache the result
    this.evaluationCache.set(cacheKey, result);

    logger.info('Relevance evaluated', {
      jobId: this.jobId,
      source: request.source,
      score: result.score,
      action: result.suggestedAction,
      keyFactsCount: result.keyFacts.length,
    });

    return result;
  }

  /**
   * Batch evaluate multiple items (parallel processing)
   */
  async evaluateBatch(requests: EvaluationRequest[]): Promise<Map<string, EvaluationResult>> {
    const results = new Map<string, EvaluationResult>();

    // Process in parallel
    const evaluations = await Promise.all(
      requests.map(async (req) => {
        const result = await this.evaluate(req);
        return { key: this.getCacheKey(req), result };
      })
    );

    for (const { key, result } of evaluations) {
      results.set(key, result);
    }

    return results;
  }

  /**
   * Clear the evaluation cache
   */
  clearCache(): void {
    this.evaluationCache.clear();
  }

  // === Private Methods ===

  private getCacheKey(request: EvaluationRequest): string {
    // Create a cache key based on content hash and query
    const contentSample = request.content.slice(0, 500);
    return `${request.source}:${request.query}:${this.simpleHash(contentSample)}`;
  }

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(16);
  }

  /**
   * Heuristic-based evaluation (placeholder for Haiku)
   *
   * In production, this would be replaced with actual Haiku call:
   *
   * const response = await claude.messages.create({
   *   model: 'claude-haiku-4-5-20251001',
   *   max_tokens: 500,
   *   system: 'You are a relevance evaluator. Score content 0-1 for relevance to a query.',
   *   messages: [{
   *     role: 'user',
   *     content: `Query: ${query}\n\nContent:\n${content}\n\nEvaluate relevance...`
   *   }]
   * });
   */
  private async heuristicEvaluate(request: EvaluationRequest): Promise<EvaluationResult> {
    const { content, query, source } = request;
    const queryTerms = this.extractQueryTerms(query);
    const contentLower = content.toLowerCase();

    // Calculate term overlap
    let matchedTerms = 0;
    let strongMatches = 0;
    const keyFacts: string[] = [];
    const irrelevantParts: string[] = [];

    for (const term of queryTerms) {
      if (contentLower.includes(term.toLowerCase())) {
        matchedTerms++;

        // Check for strong matches (term appears in meaningful context)
        const termIndex = contentLower.indexOf(term.toLowerCase());
        const context = content.slice(Math.max(0, termIndex - 50), termIndex + term.length + 50);

        // Look for patterns that indicate relevance
        if (this.isStrongMatch(context, term)) {
          strongMatches++;
          keyFacts.push(this.extractFactAround(content, termIndex, term.length));
        }
      }
    }

    // Calculate base score
    let score = queryTerms.length > 0 ? matchedTerms / queryTerms.length : 0;

    // Boost for strong matches
    if (strongMatches > 0) {
      score = Math.min(1, score + (strongMatches * 0.1));
    }

    // Source-specific adjustments
    score = this.applySourceAdjustments(score, source, content);

    // Web search results often contain noise - apply stricter filtering
    if (source === 'web') {
      score = this.applyWebSearchFilters(score, content, query);
    }

    // Identify irrelevant parts
    const sentences = content.split(/[.!?]+/);
    for (const sentence of sentences) {
      if (sentence.length > 20 && !this.sentenceContainsQueryTerms(sentence, queryTerms)) {
        // Only flag as irrelevant if it's substantial
        if (sentence.length > 100) {
          irrelevantParts.push(sentence.trim().slice(0, 100) + '...');
        }
      }
    }

    // Determine action based on score
    let suggestedAction: EvaluationResult['suggestedAction'];
    if (score < RELEVANCE_THRESHOLDS.DISCARD) {
      suggestedAction = 'discard';
    } else if (score < RELEVANCE_THRESHOLDS.SUMMARIZE) {
      suggestedAction = 'summarize';
    } else if (score < RELEVANCE_THRESHOLDS.COMPRESS) {
      suggestedAction = 'compress';
    } else {
      suggestedAction = 'keep';
    }

    return {
      score: Math.round(score * 100) / 100, // Round to 2 decimal places
      reasoning: this.generateReasoning(matchedTerms, queryTerms.length, strongMatches, source),
      keyFacts: keyFacts.slice(0, 5), // Limit to top 5 facts
      irrelevantParts: irrelevantParts.slice(0, 3), // Limit to 3 examples
      suggestedAction,
    };
  }

  private extractQueryTerms(query: string): string[] {
    // Extract meaningful terms, ignoring common words
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'must', 'shall', 'can', 'could', 'need',
      'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'up',
      'about', 'into', 'over', 'after', 'and', 'or', 'but', 'if', 'then',
      'how', 'what', 'where', 'when', 'why', 'which', 'who', 'this', 'that',
    ]);

    return query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 2 && !stopWords.has(term))
      .map((term) => term.replace(/[^\w]/g, ''));
  }

  private isStrongMatch(context: string, _term: string): boolean {
    const contextLower = context.toLowerCase();

    // Check for patterns indicating meaningful context
    const meaningfulPatterns = [
      /api/i, /endpoint/i, /integration/i, /mcp/i, /server/i,
      /implements?/i, /provides?/i, /supports?/i, /enables?/i,
      /configuration/i, /authentication/i, /authorization/i,
      /error/i, /solution/i, /resolution/i, /workaround/i,
    ];

    return meaningfulPatterns.some((pattern) => pattern.test(contextLower));
  }

  private extractFactAround(content: string, index: number, termLength: number): string {
    // Extract a sentence or meaningful phrase around the match
    const start = Math.max(0, content.lastIndexOf('.', index) + 1);
    const end = content.indexOf('.', index + termLength);
    const fact = content.slice(start, end > -1 ? end + 1 : index + termLength + 100);
    return fact.trim().slice(0, 200);
  }

  private applySourceAdjustments(
    score: number,
    source: EvaluationRequest['source'],
    content: string
  ): number {
    // Source-specific adjustments
    switch (source) {
      case 'confluence':
        // Confluence docs are usually curated - slight boost
        return Math.min(1, score * 1.1);

      case 'jira':
        // Jira issues with resolutions are more valuable
        if (content.includes('Resolution:') || content.includes('Fixed')) {
          return Math.min(1, score * 1.2);
        }
        return score;

      case 'servicenow':
        // ServiceNow incidents with root cause are valuable
        if (content.includes('Root Cause') || content.includes('Workaround')) {
          return Math.min(1, score * 1.2);
        }
        return score;

      case 'github':
        // GitHub code is highly relevant if it matches
        return Math.min(1, score * 1.15);

      case 'web':
        // Web results need stricter filtering (more noise)
        return score * 0.85;

      case 'file':
        // Local files are usually intentionally relevant
        return Math.min(1, score * 1.1);

      default:
        return score;
    }
  }

  private applyWebSearchFilters(score: number, content: string, _query: string): number {
    // Web search results often contain a lot of noise
    // Apply additional filters

    // Check for common noise patterns
    const noisePatterns = [
      /cookie policy/i,
      /privacy policy/i,
      /terms of service/i,
      /subscribe to newsletter/i,
      /sign up for free/i,
      /advertisement/i,
      /sponsored content/i,
      /related articles/i,
      /you may also like/i,
      /share on (twitter|facebook|linkedin)/i,
    ];

    let noiseCount = 0;
    for (const pattern of noisePatterns) {
      if (pattern.test(content)) {
        noiseCount++;
      }
    }

    // Reduce score based on noise
    if (noiseCount > 0) {
      score = score * (1 - (noiseCount * 0.1));
    }

    // Boost if contains API/technical content
    const technicalPatterns = [
      /api\s*documentation/i,
      /rest\s*api/i,
      /graphql/i,
      /openapi/i,
      /swagger/i,
      /sdk/i,
      /rate\s*limit/i,
      /authentication/i,
      /oauth/i,
    ];

    let technicalCount = 0;
    for (const pattern of technicalPatterns) {
      if (pattern.test(content)) {
        technicalCount++;
      }
    }

    if (technicalCount > 0) {
      score = Math.min(1, score * (1 + (technicalCount * 0.05)));
    }

    return score;
  }

  private sentenceContainsQueryTerms(sentence: string, queryTerms: string[]): boolean {
    const sentenceLower = sentence.toLowerCase();
    return queryTerms.some((term) => sentenceLower.includes(term.toLowerCase()));
  }

  private generateReasoning(
    matchedTerms: number,
    totalTerms: number,
    strongMatches: number,
    source: string
  ): string {
    const matchRatio = totalTerms > 0 ? matchedTerms / totalTerms : 0;

    if (matchRatio === 0) {
      return `No query terms found in ${source} content`;
    } else if (matchRatio < 0.3) {
      return `Weak match: ${matchedTerms}/${totalTerms} terms, ${strongMatches} strong matches`;
    } else if (matchRatio < 0.6) {
      return `Moderate match: ${matchedTerms}/${totalTerms} terms, ${strongMatches} strong matches`;
    } else {
      return `Strong match: ${matchedTerms}/${totalTerms} terms, ${strongMatches} strong in context`;
    }
  }
}

/**
 * Create a relevance evaluation function compatible with ContextManager
 */
export function createRelevanceEvaluatorFn(
  evaluator: RelevanceEvaluator
): (content: string, query: string) => Promise<RelevanceEvaluation> {
  return async (content: string, query: string): Promise<RelevanceEvaluation> => {
    const result = await evaluator.evaluate({
      content,
      query,
      source: 'web', // Default to web, can be overridden
    });

    return {
      score: result.score,
      reasoning: result.reasoning,
      keyFacts: result.keyFacts,
      irrelevantParts: result.irrelevantParts,
      suggestedAction: result.suggestedAction,
    };
  };
}
