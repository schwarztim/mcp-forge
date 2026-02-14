/**
 * Build lifecycle state machine
 * Manages transitions between build phases with validation
 */

import { BuildPhase, BuildState } from '../types/index.js';
import { logger } from '../observability/logger.js';

/**
 * Valid state transitions for the build lifecycle
 */
const VALID_TRANSITIONS: Record<BuildPhase, BuildPhase[]> = {
  [BuildPhase.PENDING]: [BuildPhase.DISCOVERING, BuildPhase.FAILED],
  [BuildPhase.DISCOVERING]: [BuildPhase.GENERATING, BuildPhase.FAILED],
  [BuildPhase.GENERATING]: [BuildPhase.TESTING, BuildPhase.FAILED],
  [BuildPhase.TESTING]: [BuildPhase.SECURITY_SCAN, BuildPhase.GENERATING, BuildPhase.FAILED], // Can loop back
  [BuildPhase.SECURITY_SCAN]: [BuildPhase.OPTIMIZING, BuildPhase.GENERATING, BuildPhase.FAILED], // Can loop back
  [BuildPhase.OPTIMIZING]: [BuildPhase.VALIDATING, BuildPhase.TESTING, BuildPhase.FAILED], // Can loop back
  [BuildPhase.VALIDATING]: [BuildPhase.VALIDATE_REQUIREMENTS, BuildPhase.TESTING, BuildPhase.FAILED], // Can loop back
  [BuildPhase.VALIDATE_REQUIREMENTS]: [BuildPhase.COMPLETED, BuildPhase.GENERATING, BuildPhase.FAILED], // Final check, can remediate
  [BuildPhase.COMPLETED]: [], // Terminal state
  [BuildPhase.FAILED]: [], // Terminal state
};

/**
 * Check if a transition is valid
 */
export function isValidTransition(from: BuildPhase, to: BuildPhase): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Transition build state to a new phase
 * @throws Error if transition is invalid
 */
export function transitionState(
  state: BuildState,
  newPhase: BuildPhase,
  updates?: Partial<BuildState>
): BuildState {
  const currentPhase = state.phase;

  if (!isValidTransition(currentPhase, newPhase)) {
    const error = `Invalid state transition: ${currentPhase} → ${newPhase}`;
    logger.error(error, { buildId: state.id, toolName: state.toolName });
    throw new Error(error);
  }

  const now = new Date();
  const newState: BuildState = {
    ...state,
    ...updates,
    phase: newPhase,
    ...(newPhase === BuildPhase.COMPLETED || newPhase === BuildPhase.FAILED
      ? { completedAt: now }
      : {}),
  };

  logger.info(`Build state transition: ${currentPhase} → ${newPhase}`, {
    buildId: state.id,
    toolName: state.toolName,
    phase: newPhase,
  });

  return newState;
}

/**
 * Create initial build state
 */
export function createInitialState(toolName: string): BuildState {
  return {
    id: crypto.randomUUID(),
    toolName,
    phase: BuildPhase.PENDING,
    startedAt: new Date(),
    discovery: {
      endpoints: 0,
      specFiles: [],
      authMethods: [],
      gaps: [],
    },
    generation: {
      toolsGenerated: 0,
      filesCreated: [],
    },
    testing: {
      totalTests: 0,
      passed: 0,
      failed: 0,
      coverage: 0,
      iterations: 0,
    },
    security: {
      sastIssues: 0,
      criticalCves: 0,
      secretsDetected: 0,
      passed: false,
    },
    metadata: {},
  };
}

/**
 * Check if build is in a terminal state
 */
export function isTerminalState(state: BuildState): boolean {
  return state.phase === BuildPhase.COMPLETED || state.phase === BuildPhase.FAILED;
}

/**
 * Check if build should loop back for fixes
 */
export function shouldLoopBack(state: BuildState): { shouldLoop: boolean; targetPhase?: BuildPhase; reason?: string } {
  // Check test failures
  if (state.phase === BuildPhase.TESTING && state.testing) {
    if (state.testing.failed > 0 && state.testing.iterations < 5) {
      return {
        shouldLoop: true,
        targetPhase: BuildPhase.GENERATING,
        reason: `${state.testing.failed} tests failed, iteration ${state.testing.iterations + 1}/5`,
      };
    }
  }

  // Check security issues
  if (state.phase === BuildPhase.SECURITY_SCAN && state.security) {
    if (state.security.criticalCves > 0 || state.security.secretsDetected > 0) {
      return {
        shouldLoop: true,
        targetPhase: BuildPhase.GENERATING,
        reason: `Security issues: ${state.security.criticalCves} CVEs, ${state.security.secretsDetected} secrets`,
      };
    }
  }

  // Check coverage threshold
  if (state.phase === BuildPhase.TESTING && state.testing) {
    if (state.testing.coverage < 70 && state.testing.iterations < 5) {
      return {
        shouldLoop: true,
        targetPhase: BuildPhase.GENERATING,
        reason: `Coverage ${state.testing.coverage}% below 70% threshold`,
      };
    }
  }

  // Check requirement validation failures - remediation loop
  if (state.phase === BuildPhase.VALIDATE_REQUIREMENTS && state.requirementValidation) {
    const maxRemediationAttempts = 3;
    if (
      state.requirementValidation.failed > 0 &&
      state.requirementValidation.remediationAttempts < maxRemediationAttempts
    ) {
      return {
        shouldLoop: true,
        targetPhase: BuildPhase.GENERATING,
        reason: `${state.requirementValidation.failed} requirements failed, remediation attempt ${state.requirementValidation.remediationAttempts + 1}/${maxRemediationAttempts}`,
      };
    }
  }

  return { shouldLoop: false };
}

/**
 * Get next phase based on current state
 */
export function getNextPhase(state: BuildState): BuildPhase | null {
  const loopCheck = shouldLoopBack(state);
  if (loopCheck.shouldLoop && loopCheck.targetPhase) {
    logger.info(`Looping back: ${loopCheck.reason}`, { buildId: state.id });
    return loopCheck.targetPhase;
  }

  const transitions = VALID_TRANSITIONS[state.phase];
  // Return first non-FAILED transition (prefer forward progress)
  return transitions.find((p) => p !== BuildPhase.FAILED) ?? null;
}
