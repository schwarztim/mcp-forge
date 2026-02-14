/**
 * Model Selection Strategy
 *
 * Selects appropriate Claude model based on task type:
 * - Opus: Planning, architecture, complex decisions, security reviews
 * - Sonnet: Implementation, iteration, testing, routine development
 * - Haiku: Quick lookups, validation, simple transformations
 */

import { BuildPhase } from '../types/index.js';
import { logger } from '../observability/logger.js';

export type ClaudeModel = 'opus' | 'sonnet' | 'haiku';

export interface ModelSelectionContext {
  phase: BuildPhase;
  taskType: TaskType;
  complexity?: 'low' | 'medium' | 'high';
  iterationCount?: number;
  isSecuritySensitive?: boolean;
}

export type TaskType =
  | 'planning'
  | 'architecture_design'
  | 'api_discovery'
  | 'code_generation'
  | 'test_generation'
  | 'test_iteration'
  | 'bug_fix'
  | 'security_review'
  | 'threat_modeling'
  | 'performance_optimization'
  | 'documentation'
  | 'validation'
  | 'simple_lookup';

/**
 * Model selection rules based on task characteristics
 */
const MODEL_RULES: Record<TaskType, ClaudeModel> = {
  // High-stakes planning and design → Opus
  planning: 'opus',
  architecture_design: 'opus',
  security_review: 'opus',
  threat_modeling: 'opus',

  // Initial discovery and generation → Sonnet (good balance)
  api_discovery: 'sonnet',
  code_generation: 'sonnet',
  test_generation: 'sonnet',
  performance_optimization: 'sonnet',

  // Iterative work (many calls) → Sonnet
  test_iteration: 'sonnet',
  bug_fix: 'sonnet',
  documentation: 'sonnet',

  // Quick/simple tasks → Haiku
  validation: 'haiku',
  simple_lookup: 'haiku',
};

/**
 * Phase-based model overrides
 * Some phases benefit from specific models regardless of task type
 */
const PHASE_OVERRIDES: Partial<Record<BuildPhase, ClaudeModel>> = {
  // Discovery phase benefits from Opus for comprehensive API analysis
  discovering: 'opus',
  // Security scan always uses Opus for thoroughness
  security_scan: 'opus',
};

/**
 * Select the appropriate model for a given context
 */
export function selectModel(context: ModelSelectionContext): ClaudeModel {
  const { phase, taskType, complexity, iterationCount, isSecuritySensitive } = context;

  // Security-sensitive tasks always use Opus
  if (isSecuritySensitive) {
    logger.debug('Model selection: Opus (security sensitive)', { taskType, phase });
    return 'opus';
  }

  // Check phase overrides
  if (PHASE_OVERRIDES[phase]) {
    const model = PHASE_OVERRIDES[phase]!;
    logger.debug(`Model selection: ${model} (phase override)`, { phase, taskType });
    return model;
  }

  // For iterations beyond first pass, use more efficient models
  if (iterationCount && iterationCount > 1) {
    // After initial passes, switch to faster models
    const model = iterationCount > 3 ? 'haiku' : 'sonnet';
    logger.debug(`Model selection: ${model} (iteration ${iterationCount})`, { taskType, phase });
    return model;
  }

  // High complexity tasks upgrade to Opus
  if (complexity === 'high') {
    logger.debug('Model selection: Opus (high complexity)', { taskType, phase });
    return 'opus';
  }

  // Use task-based rules
  const model = MODEL_RULES[taskType] ?? 'sonnet';
  logger.debug(`Model selection: ${model} (task rule)`, { taskType, phase });
  return model;
}

/**
 * Get model configuration for bob instance
 */
export function getModelConfig(model: ClaudeModel): { model: string; maxTokens?: number } {
  switch (model) {
    case 'opus':
      return { model: 'claude-opus-4-5-20251101', maxTokens: 32000 };
    case 'sonnet':
      return { model: 'claude-sonnet-4-20250514', maxTokens: 16000 };
    case 'haiku':
      return { model: 'claude-haiku-4-5-20251001', maxTokens: 8000 };
  }
}

/**
 * Estimate cost multiplier for model selection
 * Useful for budget planning
 */
export function getCostMultiplier(model: ClaudeModel): number {
  switch (model) {
    case 'opus':
      return 15; // ~15x base cost
    case 'sonnet':
      return 3; // ~3x base cost
    case 'haiku':
      return 1; // Base cost
  }
}

/**
 * Select model for a build phase
 * Convenience function for orchestrator
 */
export function selectModelForPhase(phase: BuildPhase, iterationCount = 0): ClaudeModel {
  const phaseTaskMap: Record<BuildPhase, TaskType> = {
    pending: 'planning',
    discovering: 'api_discovery',
    generating: 'code_generation',
    testing: iterationCount > 0 ? 'test_iteration' : 'test_generation',
    security_scan: 'security_review',
    optimizing: 'performance_optimization',
    validating: 'validation',
    validate_requirements: 'validation', // Final requirement validation
    completed: 'simple_lookup',
    failed: 'simple_lookup',
  };

  return selectModel({
    phase,
    taskType: phaseTaskMap[phase],
    iterationCount,
    isSecuritySensitive: phase === 'security_scan',
  });
}

/*
 * ★ Insight ─────────────────────────────────────
 * Model Selection Strategy:
 * 1. Opus ($15/MTok): Planning, architecture, security - decisions that matter
 * 2. Sonnet ($3/MTok): Implementation, iteration - bulk of the work
 * 3. Haiku ($1/MTok): Validation, lookups - quick checks
 * This optimizes for both cost (80% savings on iterations) and quality
 * (full Opus power for critical decisions)
 * ─────────────────────────────────────────────────
 */
