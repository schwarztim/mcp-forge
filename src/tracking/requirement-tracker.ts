/**
 * Requirement Tracker
 *
 * Parses user requests to extract explicit requirements,
 * tracks completion status, and validates all requirements are met.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  Requirement,
  RequirementSet,
  RequirementType,
  RequirementStatus,
  RequirementValidationReport,
  ValidationResult,
} from '../types/index.js';
import { logger } from '../observability/logger.js';

/**
 * Patterns for detecting requirement types in user requests
 */
const REQUIREMENT_PATTERNS: Array<{
  type: RequirementType;
  patterns: RegExp[];
  extractTarget?: (match: RegExpMatchArray, fullText: string) => string | undefined;
}> = [
  {
    type: 'generate_mcp',
    patterns: [
      /generate\s+(?:an?\s+)?mcp(?:s)?\s+(?:for|server)/i,
      /create\s+(?:an?\s+)?mcp(?:s)?/i,
      /use\s+thesun\s+(?:for|to)/i,
      /thesun\s*\(\s*\{\s*target/i,
    ],
  },
  {
    type: 'run_archcheck',
    patterns: [
      /run\s+(?:the\s+)?(?:skill\s+)?['"]?archcheck['"]?/i,
      /archcheck\s+on\s+each/i,
      /run\s+archcheck/i,
    ],
  },
  {
    type: 'publish_github',
    patterns: [
      /publish(?:ed)?\s+to\s+github/i,
      /push\s+to\s+github/i,
      /create\s+(?:a\s+)?github\s+repo/i,
      /github\s+publish/i,
    ],
  },
  {
    type: 'create_confluence',
    patterns: [
      /create\s+(?:a\s+)?(?:page|pages?)\s+(?:on|in|under)\s+(?:.*)?confluence/i,
      /confluence\s+(?:page|documentation)/i,
      /document(?:ing)?\s+(?:them\s+)?(?:on|in)\s+confluence/i,
      /subpage(?:s)?\s+documenting/i,
    ],
  },
  {
    type: 'run_tests',
    patterns: [
      /run\s+(?:the\s+)?tests?/i,
      /test\s+(?:the\s+)?(?:mcp|server)/i,
      /npm\s+test/i,
    ],
  },
  {
    type: 'security_scan',
    patterns: [
      /security\s+scan/i,
      /run\s+security/i,
      /scan\s+for\s+(?:vulnerabilities|secrets)/i,
    ],
  },
];

/**
 * Extract tool/API names from user request
 */
function extractTargets(request: string): string[] {
  const targets: string[] = [];

  // Pattern: targets: ["tool1", "tool2", "tool3"]
  const arrayMatch = request.match(/targets?\s*:\s*\[\s*["']([^"'\]]+)["']/gi);
  if (arrayMatch) {
    for (const match of arrayMatch) {
      const inner = match.match(/["']([^"']+)["']/g);
      if (inner) {
        for (const t of inner) {
          targets.push(t.replace(/["']/g, '').trim());
        }
      }
    }
  }

  // Pattern: target: "tool1, tool2, tool3"
  const commaMatch = request.match(/target\s*:\s*["']([^"']+)["']/i);
  if (commaMatch) {
    const parts = commaMatch[1].split(',').map((t) => t.trim());
    targets.push(...parts);
  }

  // Pattern: for X, Y, Z or for X, Y, and Z
  const forMatch = request.match(/(?:for|generate\s+mcps?\s+for)\s+([a-z0-9,\s]+(?:and\s+[a-z0-9]+)?)/i);
  if (forMatch) {
    const parts = forMatch[1]
      .replace(/\s+and\s+/gi, ', ')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && !['the', 'each', 'all', 'following'].includes(t.toLowerCase()));
    targets.push(...parts);
  }

  // Deduplicate and normalize
  return [...new Set(targets.map((t) => t.toLowerCase().replace(/[^a-z0-9-]/g, '')))].filter(
    (t) => t.length > 0
  );
}

/**
 * Parse user request and extract all requirements
 */
export function parseRequirements(request: string): RequirementSet {
  const id = uuidv4();
  const requirements: Requirement[] = [];
  const targets = extractTargets(request);
  let reqIndex = 0;

  logger.info('Parsing requirements from user request', {
    requestLength: request.length,
    detectedTargets: targets,
  });

  // Detect each requirement type
  for (const { type, patterns } of REQUIREMENT_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(request)) {
        // For per-target requirements, create one per target
        if (['generate_mcp', 'run_archcheck', 'publish_github'].includes(type) && targets.length > 0) {
          for (const target of targets) {
            requirements.push({
              id: `req-${reqIndex++}`,
              type,
              description: getRequirementDescription(type, target),
              target,
              status: 'pending',
            });
          }
        } else if (type === 'create_confluence') {
          // Create parent page requirement
          requirements.push({
            id: `req-${reqIndex++}`,
            type,
            description: 'Create parent Confluence page for MCP documentation',
            target: 'MCP Documentation',
            status: 'pending',
          });
          // Create subpage requirements for each target
          for (const target of targets) {
            requirements.push({
              id: `req-${reqIndex++}`,
              type,
              description: `Create Confluence subpage for ${target} MCP`,
              target,
              status: 'pending',
              dependencies: [`req-${reqIndex - targets.length - 1}`], // Depends on parent page
            });
          }
        } else {
          requirements.push({
            id: `req-${reqIndex++}`,
            type,
            description: getRequirementDescription(type),
            status: 'pending',
          });
        }
        break; // Only match once per type
      }
    }
  }

  // Add implicit validation requirement at the end
  requirements.push({
    id: `req-${reqIndex++}`,
    type: 'custom',
    description: 'Validate all requirements are met before completion',
    status: 'pending',
    dependencies: requirements.map((r) => r.id).filter((id) => id !== `req-${reqIndex - 1}`),
  });

  const requirementSet: RequirementSet = {
    id,
    originalRequest: request,
    parsedAt: new Date(),
    requirements,
    targets,
  };

  logger.info('Requirements parsed', {
    setId: id,
    totalRequirements: requirements.length,
    targets,
    types: [...new Set(requirements.map((r) => r.type))],
  });

  return requirementSet;
}

/**
 * Get human-readable description for requirement type
 */
function getRequirementDescription(type: RequirementType, target?: string): string {
  const descriptions: Record<RequirementType, string> = {
    generate_mcp: target ? `Generate MCP server for ${target}` : 'Generate MCP server',
    run_archcheck: target ? `Run archcheck on ${target} MCP` : 'Run archcheck skill',
    publish_github: target ? `Publish ${target} MCP to GitHub` : 'Publish to GitHub',
    create_confluence: target
      ? `Create Confluence page for ${target}`
      : 'Create Confluence documentation',
    run_tests: target ? `Run tests for ${target} MCP` : 'Run test suite',
    security_scan: target ? `Security scan ${target} MCP` : 'Run security scan',
    custom: 'Custom requirement',
  };
  return descriptions[type];
}

/**
 * RequirementTracker class for managing requirement lifecycle
 */
export class RequirementTracker {
  private requirementSet: RequirementSet;
  private listeners: Map<string, (req: Requirement) => void> = new Map();

  constructor(request: string) {
    this.requirementSet = parseRequirements(request);
  }

  /**
   * Get all requirements
   */
  getRequirements(): Requirement[] {
    return this.requirementSet.requirements;
  }

  /**
   * Get requirements by type
   */
  getRequirementsByType(type: RequirementType): Requirement[] {
    return this.requirementSet.requirements.filter((r) => r.type === type);
  }

  /**
   * Get requirement by ID
   */
  getRequirement(id: string): Requirement | undefined {
    return this.requirementSet.requirements.find((r) => r.id === id);
  }

  /**
   * Get all targets
   */
  getTargets(): string[] {
    return this.requirementSet.targets;
  }

  /**
   * Update requirement status
   */
  updateStatus(
    id: string,
    status: RequirementStatus,
    evidence?: Requirement['evidence'],
    error?: string
  ): void {
    const req = this.requirementSet.requirements.find((r) => r.id === id);
    if (!req) {
      logger.warn('Requirement not found', { id });
      return;
    }

    req.status = status;
    if (status === 'in_progress' && !req.startedAt) {
      req.startedAt = new Date();
    }
    if (['completed', 'failed', 'skipped'].includes(status)) {
      req.completedAt = new Date();
    }
    if (evidence) {
      req.evidence = { ...req.evidence, ...evidence };
    }
    if (error) {
      req.error = error;
    }

    logger.info('Requirement status updated', {
      id,
      type: req.type,
      target: req.target,
      status,
      hasEvidence: !!evidence,
    });

    // Notify listeners
    const listener = this.listeners.get(id);
    if (listener) {
      listener(req);
    }
  }

  /**
   * Mark requirement as completed with evidence
   */
  complete(id: string, evidence: Requirement['evidence']): void {
    this.updateStatus(id, 'completed', evidence);
  }

  /**
   * Mark requirement as failed
   */
  fail(id: string, error: string): void {
    this.updateStatus(id, 'failed', undefined, error);
  }

  /**
   * Check if all dependencies for a requirement are met
   */
  canStart(id: string): boolean {
    const req = this.getRequirement(id);
    if (!req) return false;
    if (!req.dependencies || req.dependencies.length === 0) return true;

    return req.dependencies.every((depId) => {
      const dep = this.getRequirement(depId);
      return dep && dep.status === 'completed';
    });
  }

  /**
   * Get next requirements that can be started (dependencies met, status pending)
   */
  getNextActionable(): Requirement[] {
    return this.requirementSet.requirements.filter(
      (r) => r.status === 'pending' && this.canStart(r.id)
    );
  }

  /**
   * Get current progress summary
   */
  getProgress(): {
    total: number;
    completed: number;
    failed: number;
    inProgress: number;
    pending: number;
    percentComplete: number;
  } {
    const reqs = this.requirementSet.requirements;
    const completed = reqs.filter((r) => r.status === 'completed').length;
    const failed = reqs.filter((r) => r.status === 'failed').length;
    const inProgress = reqs.filter((r) => r.status === 'in_progress').length;
    const pending = reqs.filter((r) => r.status === 'pending').length;

    return {
      total: reqs.length,
      completed,
      failed,
      inProgress,
      pending,
      percentComplete: Math.round((completed / reqs.length) * 100),
    };
  }

  /**
   * Check if all requirements are complete (or failed/skipped)
   */
  isComplete(): boolean {
    return this.requirementSet.requirements.every((r) =>
      ['completed', 'failed', 'skipped'].includes(r.status)
    );
  }

  /**
   * Check if all requirements passed (none failed)
   */
  allPassed(): boolean {
    return (
      this.isComplete() && this.requirementSet.requirements.every((r) => r.status !== 'failed')
    );
  }

  /**
   * Get failed requirements for remediation
   */
  getFailedRequirements(): Requirement[] {
    return this.requirementSet.requirements.filter((r) => r.status === 'failed');
  }

  /**
   * Generate validation report
   */
  generateReport(): RequirementValidationReport {
    const results = this.requirementSet.requirements.map((req) => {
      const validationResults: ValidationResult[] = [];

      // Add evidence-based validation
      if (req.evidence?.files) {
        validationResults.push({
          ruleId: `${req.id}-files`,
          passed: req.evidence.files.length > 0,
          message: `${req.evidence.files.length} files created`,
          details: { files: req.evidence.files },
          timestamp: new Date(),
        });
      }
      if (req.evidence?.urls) {
        validationResults.push({
          ruleId: `${req.id}-urls`,
          passed: req.evidence.urls.length > 0,
          message: `${req.evidence.urls.length} URLs published`,
          details: { urls: req.evidence.urls },
          timestamp: new Date(),
        });
      }

      return {
        requirementId: req.id,
        requirementDescription: req.description,
        passed: req.status === 'completed',
        validationResults,
        remediationNeeded: req.status === 'failed',
        remediationSteps: req.error ? [`Fix: ${req.error}`] : undefined,
      };
    });

    const summary = this.getProgress();

    return {
      requirementSetId: this.requirementSet.id,
      validatedAt: new Date(),
      allPassed: this.allPassed(),
      results,
      summary: {
        totalRequirements: summary.total,
        passed: summary.completed,
        failed: summary.failed,
        skipped: this.requirementSet.requirements.filter((r) => r.status === 'skipped').length,
      },
    };
  }

  /**
   * Get the requirement set
   */
  getRequirementSet(): RequirementSet {
    return this.requirementSet;
  }

  /**
   * Subscribe to requirement updates
   */
  onUpdate(id: string, callback: (req: Requirement) => void): void {
    this.listeners.set(id, callback);
  }

  /**
   * Export requirements as markdown checklist
   */
  toMarkdown(): string {
    const lines: string[] = [
      '# Requirement Checklist',
      '',
      `**Original Request:** ${this.requirementSet.originalRequest.substring(0, 200)}...`,
      '',
      `**Targets:** ${this.requirementSet.targets.join(', ')}`,
      '',
      '## Requirements',
      '',
    ];

    for (const req of this.requirementSet.requirements) {
      const status =
        req.status === 'completed' ? '✅' : req.status === 'failed' ? '❌' : '⬜';
      lines.push(`- ${status} **${req.type}**: ${req.description}`);
      if (req.error) {
        lines.push(`  - Error: ${req.error}`);
      }
      if (req.evidence?.urls) {
        for (const url of req.evidence.urls) {
          lines.push(`  - URL: ${url}`);
        }
      }
    }

    const progress = this.getProgress();
    lines.push('');
    lines.push('## Progress');
    lines.push(`- Completed: ${progress.completed}/${progress.total} (${progress.percentComplete}%)`);
    lines.push(`- Failed: ${progress.failed}`);
    lines.push(`- In Progress: ${progress.inProgress}`);

    return lines.join('\n');
  }
}

/**
 * Factory function
 */
export function createRequirementTracker(request: string): RequirementTracker {
  return new RequirementTracker(request);
}
