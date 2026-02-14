/**
 * Supervisor
 *
 * Global governance layer that:
 * - Manages all job watchers
 * - Monitors system-wide health
 * - Enforces global resource limits
 * - Provides centralized intervention capabilities
 * - Reports on overall system status
 *
 * The supervisor watches the watchers - it's the top-level governance.
 */

import { EventEmitter } from 'events';
import { JobWatcher, WatcherConfig, WatcherSummary, Intervention, createJobWatcher } from './job-watcher.js';
import { BuildPhase } from '../types/index.js';
import { logger } from '../observability/logger.js';

/**
 * Supervisor configuration
 */
export interface SupervisorConfig {
  /** Maximum concurrent jobs across all tools */
  maxConcurrentJobs: number;
  /** Maximum total cost per hour (USD) */
  maxHourlyCostUsd: number;
  /** Maximum total API calls per minute (across all jobs) */
  maxGlobalApiCallsPerMinute: number;
  /** Interval for health checks (ms) */
  healthCheckIntervalMs: number;
  /** Auto-terminate jobs that are stuck */
  autoTerminateStuckJobs: boolean;
  /** Stuck threshold (ms) - no progress for this long */
  stuckThresholdMs: number;
}

/**
 * Default supervisor configuration
 */
export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = {
  maxConcurrentJobs: 10,
  maxHourlyCostUsd: 200,
  maxGlobalApiCallsPerMinute: 200,
  healthCheckIntervalMs: 60000, // 1 minute
  autoTerminateStuckJobs: true,
  stuckThresholdMs: 15 * 60 * 1000, // 15 minutes
};

/**
 * Job status for dashboard
 */
export interface JobStatus {
  jobId: string;
  toolName: string;
  phase: BuildPhase;
  running: boolean;
  paused: boolean;
  durationMs: number;
  apiCalls: number;
  estimatedCost: number;
  warnings: number;
  lastProgress: Date;
}

/**
 * System health status
 */
export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'critical';
  activeJobs: number;
  pausedJobs: number;
  totalApiCallsLastMinute: number;
  totalCostLastHour: number;
  issues: string[];
}

/**
 * Supervisor events
 */
export interface SupervisorEvents {
  'job:started': (jobId: string, toolName: string) => void;
  'job:completed': (summary: WatcherSummary) => void;
  'job:intervention': (jobId: string, intervention: Intervention) => void;
  'system:health': (health: SystemHealth) => void;
  'system:alert': (message: string, severity: 'warning' | 'critical') => void;
}

/**
 * Supervisor - watches all job watchers
 */
export class Supervisor extends EventEmitter {
  private config: SupervisorConfig;
  private watchers: Map<string, JobWatcher> = new Map();
  private completedJobs: WatcherSummary[] = [];

  // Global metrics
  private globalApiCallsLastMinute = 0;
  private hourlyCostTracker: { timestamp: Date; cost: number }[] = [];

  // Timers
  private healthCheckTimer?: NodeJS.Timeout;
  private apiRateLimitTimer?: NodeJS.Timeout;

  private isRunning = false;

  constructor(config?: Partial<SupervisorConfig>) {
    super();
    this.config = { ...DEFAULT_SUPERVISOR_CONFIG, ...config };
  }

  /**
   * Start the supervisor
   */
  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    logger.info('Supervisor started', { config: this.config });

    // Start health check timer
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.config.healthCheckIntervalMs);

    // Start API rate limit reset timer
    this.apiRateLimitTimer = setInterval(() => {
      this.globalApiCallsLastMinute = 0;
    }, 60000);
  }

  /**
   * Stop the supervisor
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    logger.info('Supervisor stopping, terminating all jobs');

    // Stop all watchers
    for (const [jobId, watcher] of this.watchers) {
      const summary = watcher.stop();
      this.completedJobs.push(summary);
    }
    this.watchers.clear();

    // Clear timers
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
    if (this.apiRateLimitTimer) clearInterval(this.apiRateLimitTimer);

    this.isRunning = false;
    logger.info('Supervisor stopped');
  }

  /**
   * Create and register a new job watcher
   */
  createJobWatcher(jobId: string, toolName: string, config?: Partial<WatcherConfig>): JobWatcher {
    // Check concurrent job limit
    const activeJobs = Array.from(this.watchers.values()).filter(
      (w) => w.getStatus().running && !w.getStatus().paused
    ).length;

    if (activeJobs >= this.config.maxConcurrentJobs) {
      throw new Error(`Maximum concurrent jobs (${this.config.maxConcurrentJobs}) exceeded`);
    }

    const watcher = createJobWatcher(jobId, toolName, config);

    // Subscribe to watcher events
    watcher.on('intervention', (intervention) => {
      this.handleJobIntervention(jobId, intervention);
    });

    watcher.on('completed', (summary) => {
      this.handleJobCompleted(jobId, summary);
    });

    watcher.on('progress', () => {
      // Track API calls globally
      this.globalApiCallsLastMinute++;
    });

    this.watchers.set(jobId, watcher);
    this.emit('job:started', jobId, toolName);

    logger.info('Job watcher created', { jobId, toolName, activeJobs: activeJobs + 1 });

    return watcher;
  }

  /**
   * Get a job watcher by ID
   */
  getJobWatcher(jobId: string): JobWatcher | undefined {
    return this.watchers.get(jobId);
  }

  /**
   * Get all active job statuses
   */
  getActiveJobs(): JobStatus[] {
    return Array.from(this.watchers.entries()).map(([jobId, watcher]) => {
      const status = watcher.getStatus();
      return {
        jobId,
        toolName: '', // Would need to track this
        ...status,
        lastProgress: new Date(), // Would need to expose from watcher
      };
    });
  }

  /**
   * Get system health
   */
  getSystemHealth(): SystemHealth {
    const activeJobs = Array.from(this.watchers.values());
    const runningJobs = activeJobs.filter((w) => w.getStatus().running);
    const pausedJobs = activeJobs.filter((w) => w.paused);

    const issues: string[] = [];
    let status: SystemHealth['status'] = 'healthy';

    // Check global API rate
    if (this.globalApiCallsLastMinute > this.config.maxGlobalApiCallsPerMinute * 0.8) {
      issues.push('Approaching global API rate limit');
      status = 'degraded';
    }
    if (this.globalApiCallsLastMinute > this.config.maxGlobalApiCallsPerMinute) {
      issues.push('Global API rate limit exceeded');
      status = 'critical';
    }

    // Check hourly cost
    const hourlyCost = this.getHourlyCost();
    if (hourlyCost > this.config.maxHourlyCostUsd * 0.8) {
      issues.push(`Approaching hourly cost limit: $${hourlyCost.toFixed(2)}`);
      status = status === 'critical' ? 'critical' : 'degraded';
    }
    if (hourlyCost > this.config.maxHourlyCostUsd) {
      issues.push(`Hourly cost limit exceeded: $${hourlyCost.toFixed(2)}`);
      status = 'critical';
    }

    // Check for stuck jobs
    for (const [jobId, watcher] of this.watchers) {
      const watcherStatus = watcher.getStatus();
      if (watcherStatus.running && !watcherStatus.paused) {
        // Check if stuck (this would need lastProgress exposed)
        if (watcherStatus.warnings > 3) {
          issues.push(`Job ${jobId.slice(0, 8)} has multiple warnings`);
          status = status === 'critical' ? 'critical' : 'degraded';
        }
      }
    }

    // Check paused jobs
    if (pausedJobs.length > 0) {
      issues.push(`${pausedJobs.length} job(s) paused awaiting review`);
      status = status === 'critical' ? 'critical' : 'degraded';
    }

    return {
      status,
      activeJobs: runningJobs.length,
      pausedJobs: pausedJobs.length,
      totalApiCallsLastMinute: this.globalApiCallsLastMinute,
      totalCostLastHour: hourlyCost,
      issues,
    };
  }

  /**
   * Pause all jobs (emergency stop)
   */
  pauseAll(reason: string): void {
    logger.warn('Pausing all jobs', { reason });

    for (const [jobId, watcher] of this.watchers) {
      if (!watcher.paused) {
        watcher.pause(`Global pause: ${reason}`);
      }
    }

    this.emit('system:alert', `All jobs paused: ${reason}`, 'critical');
  }

  /**
   * Resume all paused jobs
   */
  resumeAll(): void {
    logger.info('Resuming all paused jobs');

    for (const [jobId, watcher] of this.watchers) {
      if (watcher.paused) {
        watcher.resume();
      }
    }
  }

  /**
   * Terminate a specific job
   */
  terminateJob(jobId: string, reason: string): WatcherSummary | undefined {
    const watcher = this.watchers.get(jobId);
    if (!watcher) return undefined;

    logger.warn('Terminating job', { jobId, reason });

    const summary = watcher.stop();
    this.watchers.delete(jobId);
    this.completedJobs.push(summary);

    return summary;
  }

  /**
   * Get dashboard data
   */
  getDashboard(): {
    health: SystemHealth;
    activeJobs: JobStatus[];
    recentCompletions: WatcherSummary[];
    metrics: {
      totalJobsCompleted: number;
      successRate: number;
      avgDurationMs: number;
      totalCostUsd: number;
    };
  } {
    const health = this.getSystemHealth();
    const activeJobs = this.getActiveJobs();

    const recentCompletions = this.completedJobs.slice(-10);
    const successfulJobs = this.completedJobs.filter((j) => j.success);

    const avgDuration =
      this.completedJobs.length > 0
        ? this.completedJobs.reduce((sum, j) => sum + j.totalDurationMs, 0) / this.completedJobs.length
        : 0;

    const totalCost = this.completedJobs.reduce((sum, j) => sum + j.estimatedCostUsd, 0);

    return {
      health,
      activeJobs,
      recentCompletions,
      metrics: {
        totalJobsCompleted: this.completedJobs.length,
        successRate: this.completedJobs.length > 0 ? successfulJobs.length / this.completedJobs.length : 0,
        avgDurationMs: avgDuration,
        totalCostUsd: totalCost,
      },
    };
  }

  // === Private Methods ===

  private handleJobIntervention(jobId: string, intervention: Intervention): void {
    this.emit('job:intervention', jobId, intervention);

    // Track cost for interventions
    if (intervention.type === 'terminate' || intervention.type === 'pause') {
      const watcher = this.watchers.get(jobId);
      if (watcher) {
        const status = watcher.getStatus();
        this.hourlyCostTracker.push({
          timestamp: new Date(),
          cost: status.estimatedCost,
        });
      }
    }

    // Check if we need system-wide intervention
    const health = this.getSystemHealth();
    if (health.status === 'critical') {
      this.emit('system:alert', 'System health critical, consider pausing new jobs', 'critical');
    }
  }

  private handleJobCompleted(jobId: string, summary: WatcherSummary): void {
    this.watchers.delete(jobId);
    this.completedJobs.push(summary);
    this.emit('job:completed', summary);

    // Track cost
    this.hourlyCostTracker.push({
      timestamp: new Date(),
      cost: summary.estimatedCostUsd,
    });

    logger.info('Job completed', {
      jobId,
      success: summary.success,
      durationMs: summary.totalDurationMs,
      cost: summary.estimatedCostUsd,
    });
  }

  private performHealthCheck(): void {
    const health = this.getSystemHealth();
    this.emit('system:health', health);

    if (health.status === 'critical') {
      logger.error('System health critical', { health });

      // Auto-pause if configured
      if (health.issues.some((i) => i.includes('cost limit exceeded'))) {
        this.pauseAll('Cost limit exceeded');
      }
    } else if (health.status === 'degraded') {
      logger.warn('System health degraded', { health });
    }

    // Clean up old cost tracking entries
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    this.hourlyCostTracker = this.hourlyCostTracker.filter(
      (entry) => entry.timestamp.getTime() > oneHourAgo
    );
  }

  private getHourlyCost(): number {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    return this.hourlyCostTracker
      .filter((entry) => entry.timestamp.getTime() > oneHourAgo)
      .reduce((sum, entry) => sum + entry.cost, 0);
  }
}

// Singleton supervisor
let globalSupervisor: Supervisor | null = null;

/**
 * Get or create the global supervisor
 */
export function getSupervisor(config?: Partial<SupervisorConfig>): Supervisor {
  if (!globalSupervisor) {
    globalSupervisor = new Supervisor(config);
  }
  return globalSupervisor;
}

/**
 * Reset the global supervisor (for testing)
 */
export function resetSupervisor(): void {
  if (globalSupervisor) {
    globalSupervisor.stop();
    globalSupervisor = null;
  }
}
