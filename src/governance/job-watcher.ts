/**
 * Job Watcher
 *
 * Dedicated watcher per job that maintains full context and ensures:
 * - Progress is being made (no stalls)
 * - Resources aren't being abused (runaway processes)
 * - Tasks complete within expected bounds
 * - Quality gates are enforced
 *
 * Each job gets its own watcher instance that persists for the job lifetime.
 */

import { EventEmitter } from 'events';
import { BuildState, BuildPhase } from '../types/index.js';
import { logger, createBuildLogger } from '../observability/logger.js';

/**
 * Watcher configuration per job
 */
export interface WatcherConfig {
  /** Maximum time for any single phase (ms) */
  phaseTimeoutMs: number;
  /** Maximum total job time (ms) */
  jobTimeoutMs: number;
  /** Maximum iterations before intervention */
  maxIterations: number;
  /** Minimum progress interval - if no progress in this time, alert (ms) */
  progressIntervalMs: number;
  /** Maximum API calls per minute */
  maxApiCallsPerMinute: number;
  /** Maximum memory usage (MB) before warning */
  maxMemoryMb: number;
  /** Maximum cost per job (USD) */
  maxCostUsd: number;
}

/**
 * Default watcher configuration
 */
export const DEFAULT_WATCHER_CONFIG: WatcherConfig = {
  phaseTimeoutMs: 10 * 60 * 1000, // 10 minutes per phase
  jobTimeoutMs: 60 * 60 * 1000, // 1 hour total
  maxIterations: 5,
  progressIntervalMs: 2 * 60 * 1000, // 2 minutes without progress
  maxApiCallsPerMinute: 60,
  maxMemoryMb: 512,
  maxCostUsd: 50,
};

/**
 * Progress checkpoint
 */
interface ProgressCheckpoint {
  timestamp: Date;
  phase: BuildPhase;
  iteration: number;
  description: string;
  metrics?: {
    apiCalls?: number;
    tokensUsed?: number;
    filesChanged?: number;
    testsRun?: number;
  };
}

/**
 * Intervention types
 */
export type InterventionType =
  | 'warning' // Log and continue
  | 'throttle' // Slow down execution
  | 'pause' // Pause for human review
  | 'terminate'; // Kill the job

/**
 * Intervention event
 */
export interface Intervention {
  type: InterventionType;
  reason: string;
  timestamp: Date;
  metrics: Record<string, unknown>;
  action?: string;
}

/**
 * Watcher events
 */
export interface WatcherEvents {
  'progress': (checkpoint: ProgressCheckpoint) => void;
  'warning': (message: string, metrics: Record<string, unknown>) => void;
  'intervention': (intervention: Intervention) => void;
  'completed': (summary: WatcherSummary) => void;
}

/**
 * Watcher summary at job completion
 */
export interface WatcherSummary {
  jobId: string;
  toolName: string;
  startTime: Date;
  endTime: Date;
  totalDurationMs: number;
  phases: {
    phase: BuildPhase;
    durationMs: number;
    iterations: number;
  }[];
  totalIterations: number;
  totalApiCalls: number;
  totalTokensUsed: number;
  estimatedCostUsd: number;
  interventions: Intervention[];
  success: boolean;
}

/**
 * Job Watcher - one instance per job
 */
export class JobWatcher extends EventEmitter {
  private jobId: string;
  private toolName: string;
  private config: WatcherConfig;
  private logger: ReturnType<typeof createBuildLogger>;

  // State tracking
  private startTime: Date;
  private currentPhase: BuildPhase = BuildPhase.PENDING;
  private phaseStartTime: Date;
  private lastProgressTime: Date;
  private checkpoints: ProgressCheckpoint[] = [];
  private interventions: Intervention[] = [];

  // Metrics
  private apiCallsThisMinute = 0;
  private apiCallsTotal = 0;
  private tokensUsed = 0;
  private iterationsByPhase: Map<BuildPhase, number> = new Map();

  // Timers
  private progressCheckTimer?: NodeJS.Timeout;
  private phaseTimeoutTimer?: NodeJS.Timeout;
  private jobTimeoutTimer?: NodeJS.Timeout;
  private apiRateLimitTimer?: NodeJS.Timeout;

  // Status
  private isRunning = false;
  private isPaused = false;

  constructor(jobId: string, toolName: string, config?: Partial<WatcherConfig>) {
    super();
    this.jobId = jobId;
    this.toolName = toolName;
    this.config = { ...DEFAULT_WATCHER_CONFIG, ...config };
    this.logger = createBuildLogger(jobId, toolName);

    this.startTime = new Date();
    this.phaseStartTime = new Date();
    this.lastProgressTime = new Date();
  }

  /**
   * Start watching the job
   */
  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    this.logger.info('Job watcher started', { config: this.config });

    // Start progress check timer
    this.progressCheckTimer = setInterval(() => {
      this.checkProgress();
    }, 30000); // Check every 30 seconds

    // Start job timeout timer
    this.jobTimeoutTimer = setTimeout(() => {
      this.handleJobTimeout();
    }, this.config.jobTimeoutMs);

    // Start API rate limit reset timer
    this.apiRateLimitTimer = setInterval(() => {
      this.apiCallsThisMinute = 0;
    }, 60000);
  }

  /**
   * Stop watching (job completed or terminated)
   */
  stop(): WatcherSummary {
    this.isRunning = false;

    // Clear all timers
    if (this.progressCheckTimer) clearInterval(this.progressCheckTimer);
    if (this.phaseTimeoutTimer) clearTimeout(this.phaseTimeoutTimer);
    if (this.jobTimeoutTimer) clearTimeout(this.jobTimeoutTimer);
    if (this.apiRateLimitTimer) clearInterval(this.apiRateLimitTimer);

    const summary = this.generateSummary();
    this.emit('completed', summary);
    this.logger.info('Job watcher stopped', { summary });

    return summary;
  }

  /**
   * Record progress checkpoint
   */
  recordProgress(description: string, metrics?: ProgressCheckpoint['metrics']): void {
    const checkpoint: ProgressCheckpoint = {
      timestamp: new Date(),
      phase: this.currentPhase,
      iteration: this.iterationsByPhase.get(this.currentPhase) ?? 0,
      description,
      metrics,
    };

    this.checkpoints.push(checkpoint);
    this.lastProgressTime = new Date();

    this.emit('progress', checkpoint);
    this.logger.debug('Progress checkpoint', { checkpoint });
  }

  /**
   * Record phase transition
   */
  recordPhaseTransition(newPhase: BuildPhase): void {
    const now = new Date();
    const phaseDuration = now.getTime() - this.phaseStartTime.getTime();

    this.logger.info('Phase transition', {
      from: this.currentPhase,
      to: newPhase,
      durationMs: phaseDuration,
    });

    // Track iteration count if looping back
    if (this.isLoopBack(this.currentPhase, newPhase)) {
      const currentIterations = this.iterationsByPhase.get(newPhase) ?? 0;
      this.iterationsByPhase.set(newPhase, currentIterations + 1);

      // Check for excessive iterations
      if (currentIterations + 1 >= this.config.maxIterations) {
        this.intervene('warning', `Phase ${newPhase} has iterated ${currentIterations + 1} times`, {
          phase: newPhase,
          iterations: currentIterations + 1,
        });
      }
    }

    this.currentPhase = newPhase;
    this.phaseStartTime = now;
    this.lastProgressTime = now;

    // Reset phase timeout
    if (this.phaseTimeoutTimer) clearTimeout(this.phaseTimeoutTimer);
    this.phaseTimeoutTimer = setTimeout(() => {
      this.handlePhaseTimeout();
    }, this.config.phaseTimeoutMs);

    this.recordProgress(`Entered phase: ${newPhase}`);
  }

  /**
   * Record API call (for rate limiting)
   */
  recordApiCall(tokens?: number): void {
    this.apiCallsThisMinute++;
    this.apiCallsTotal++;

    if (tokens) {
      this.tokensUsed += tokens;
    }

    // Check rate limit
    if (this.apiCallsThisMinute > this.config.maxApiCallsPerMinute) {
      this.intervene('throttle', 'API rate limit exceeded', {
        callsThisMinute: this.apiCallsThisMinute,
        limit: this.config.maxApiCallsPerMinute,
      });
    }

    // Check cost estimate
    const estimatedCost = this.estimateCost();
    if (estimatedCost > this.config.maxCostUsd * 0.8) {
      this.intervene('warning', `Approaching cost limit: $${estimatedCost.toFixed(2)}`, {
        estimatedCost,
        limit: this.config.maxCostUsd,
      });
    }

    if (estimatedCost > this.config.maxCostUsd) {
      this.intervene('terminate', `Cost limit exceeded: $${estimatedCost.toFixed(2)}`, {
        estimatedCost,
        limit: this.config.maxCostUsd,
      });
    }
  }

  /**
   * Pause the job for human review
   */
  pause(reason: string): void {
    this.isPaused = true;
    this.intervene('pause', reason, { manualPause: false });
  }

  /**
   * Resume a paused job
   */
  resume(): void {
    if (!this.isPaused) return;

    this.isPaused = false;
    this.lastProgressTime = new Date(); // Reset progress timer
    this.logger.info('Job resumed');
  }

  /**
   * Check if job is paused
   */
  get paused(): boolean {
    return this.isPaused;
  }

  /**
   * Get current status
   */
  getStatus(): {
    phase: BuildPhase;
    running: boolean;
    paused: boolean;
    durationMs: number;
    apiCalls: number;
    estimatedCost: number;
    warnings: number;
  } {
    return {
      phase: this.currentPhase,
      running: this.isRunning,
      paused: this.isPaused,
      durationMs: Date.now() - this.startTime.getTime(),
      apiCalls: this.apiCallsTotal,
      estimatedCost: this.estimateCost(),
      warnings: this.interventions.filter((i) => i.type === 'warning').length,
    };
  }

  // === Private Methods ===

  private checkProgress(): void {
    if (this.isPaused) return;

    const timeSinceProgress = Date.now() - this.lastProgressTime.getTime();

    if (timeSinceProgress > this.config.progressIntervalMs) {
      this.intervene('warning', 'No progress detected', {
        timeSinceProgressMs: timeSinceProgress,
        threshold: this.config.progressIntervalMs,
        currentPhase: this.currentPhase,
      });
    }
  }

  private handlePhaseTimeout(): void {
    this.intervene('pause', `Phase timeout: ${this.currentPhase}`, {
      phase: this.currentPhase,
      timeoutMs: this.config.phaseTimeoutMs,
      elapsed: Date.now() - this.phaseStartTime.getTime(),
    });
  }

  private handleJobTimeout(): void {
    this.intervene('terminate', 'Job timeout exceeded', {
      timeoutMs: this.config.jobTimeoutMs,
      elapsed: Date.now() - this.startTime.getTime(),
    });
  }

  private intervene(type: InterventionType, reason: string, metrics: Record<string, unknown>): void {
    const intervention: Intervention = {
      type,
      reason,
      timestamp: new Date(),
      metrics,
    };

    // Add recommended action
    switch (type) {
      case 'warning':
        intervention.action = 'Logged for review, continuing execution';
        break;
      case 'throttle':
        intervention.action = 'Reducing execution speed';
        break;
      case 'pause':
        intervention.action = 'Execution paused, awaiting human review';
        this.isPaused = true;
        break;
      case 'terminate':
        intervention.action = 'Job will be terminated';
        break;
    }

    this.interventions.push(intervention);
    this.emit('intervention', intervention);

    const logLevel = type === 'terminate' ? 'error' : type === 'pause' ? 'warn' : 'info';
    this.logger[logLevel](`Intervention: ${type}`, { reason, metrics, action: intervention.action });
  }

  private isLoopBack(from: BuildPhase, to: BuildPhase): boolean {
    // Failed is a terminal state, not part of normal progression
    if (from === BuildPhase.FAILED || to === BuildPhase.FAILED) {
      return false;
    }

    const phaseOrder: BuildPhase[] = [
      BuildPhase.PENDING,
      BuildPhase.DISCOVERING,
      BuildPhase.GENERATING,
      BuildPhase.TESTING,
      BuildPhase.SECURITY_SCAN,
      BuildPhase.OPTIMIZING,
      BuildPhase.VALIDATING,
      BuildPhase.COMPLETED,
    ];

    const fromIndex = phaseOrder.indexOf(from);
    const toIndex = phaseOrder.indexOf(to);

    return toIndex < fromIndex && toIndex !== -1;
  }

  private estimateCost(): number {
    // Rough cost estimate based on tokens
    // Assumes mix of Opus ($15/MTok), Sonnet ($3/MTok), Haiku ($1/MTok)
    // Average ~$5/MTok for estimation
    return (this.tokensUsed / 1_000_000) * 5;
  }

  private generateSummary(): WatcherSummary {
    const endTime = new Date();

    // Calculate phase durations from checkpoints
    const phases: WatcherSummary['phases'] = [];
    let currentPhase: BuildPhase | null = null;
    let phaseStart = this.startTime;

    for (const checkpoint of this.checkpoints) {
      if (checkpoint.phase !== currentPhase) {
        if (currentPhase !== null) {
          phases.push({
            phase: currentPhase,
            durationMs: checkpoint.timestamp.getTime() - phaseStart.getTime(),
            iterations: this.iterationsByPhase.get(currentPhase) ?? 1,
          });
        }
        currentPhase = checkpoint.phase;
        phaseStart = checkpoint.timestamp;
      }
    }

    // Add final phase
    if (currentPhase !== null) {
      phases.push({
        phase: currentPhase,
        durationMs: endTime.getTime() - phaseStart.getTime(),
        iterations: this.iterationsByPhase.get(currentPhase) ?? 1,
      });
    }

    const totalIterations = Array.from(this.iterationsByPhase.values()).reduce((a, b) => a + b, 0);

    return {
      jobId: this.jobId,
      toolName: this.toolName,
      startTime: this.startTime,
      endTime,
      totalDurationMs: endTime.getTime() - this.startTime.getTime(),
      phases,
      totalIterations,
      totalApiCalls: this.apiCallsTotal,
      totalTokensUsed: this.tokensUsed,
      estimatedCostUsd: this.estimateCost(),
      interventions: this.interventions,
      success: this.currentPhase === BuildPhase.COMPLETED,
    };
  }
}

/**
 * Create a new job watcher
 */
export function createJobWatcher(
  jobId: string,
  toolName: string,
  config?: Partial<WatcherConfig>
): JobWatcher {
  return new JobWatcher(jobId, toolName, config);
}
