/**
 * MCP Forge — Adaptive Rate Limiter
 *
 * Smart rate control that every generated MCP server gets baked in.
 * Prevents getting blocked by APIs that enforce rate limits.
 *
 * Three layers of protection:
 *
 * 1. TOKEN BUCKET — Proactive: limits outgoing requests to a configurable
 *    rate (e.g., 10 req/sec). Queues excess requests instead of dropping.
 *
 * 2. 429 DETECTOR — Reactive: when a 429 (Too Many Requests) comes back,
 *    immediately throttles down and honors Retry-After headers.
 *
 * 3. ADAPTIVE BACKOFF — Learning: tracks 429 frequency over a rolling
 *    window. If the API keeps pushing back, the limiter permanently
 *    reduces its baseline rate. If things calm down, it slowly recovers.
 *
 * The generated API client wraps every request through this limiter
 * so the MCP server never hammers an API into blocking it.
 */

// ─── Configuration ───────────────────────────────────────────

export interface RateLimitConfig {
  /** Max requests per second (default: 10, set from env or spec) */
  maxRps: number;
  /** Max burst above steady rate (default: 5) */
  burstSize: number;
  /** Max concurrent in-flight requests (default: 10) */
  maxConcurrent: number;
  /** Minimum RPS the adaptive system will drop to (default: 1) */
  floorRps: number;
  /** How fast to recover after backing off, 0-1 (default: 0.1 = 10% per window) */
  recoveryRate: number;
  /** Rolling window for 429 tracking in ms (default: 60000 = 1 min) */
  windowMs: number;
  /** Max 429s in a window before permanent throttle (default: 3) */
  throttleThreshold: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  maxRps: 10,
  burstSize: 5,
  maxConcurrent: 10,
  floorRps: 1,
  recoveryRate: 0.1,
  windowMs: 60_000,
  throttleThreshold: 3,
};

// ─── Rate Limiter ────────────────────────────────────────────

export class AdaptiveRateLimiter {
  private config: RateLimitConfig;

  // Token bucket state
  private tokens: number;
  private lastRefill: number;
  private currentRps: number;

  // Concurrency gate
  private inFlight: number = 0;
  private waitQueue: Array<() => void> = [];

  // 429 tracking (rolling window)
  private recentThrottles: number[] = [];

  // Retry-After lock: if set, NO requests go out until this timestamp
  private retryAfterUntil: number = 0;

  // Stats
  private stats = {
    totalRequests: 0,
    totalThrottled: 0,
    totalQueued: 0,
    totalRetryAfter: 0,
    currentRps: 0,
    adaptiveReductions: 0,
  };

  constructor(config?: Partial<RateLimitConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.currentRps = this.config.maxRps;
    this.tokens = this.config.burstSize;
    this.lastRefill = Date.now();
  }

  /**
   * Acquire permission to make a request.
   * Resolves when it's safe to send. May delay if rate-limited.
   */
  async acquire(): Promise<void> {
    this.stats.totalRequests++;

    // Layer 1: Retry-After lock — hard stop
    const retryWait = this.retryAfterUntil - Date.now();
    if (retryWait > 0) {
      this.stats.totalRetryAfter++;
      await this.sleep(retryWait);
    }

    // Layer 2: Concurrency gate
    if (this.inFlight >= this.config.maxConcurrent) {
      this.stats.totalQueued++;
      await new Promise<void>(resolve => this.waitQueue.push(resolve));
    }

    // Layer 3: Token bucket
    this.refillTokens();
    while (this.tokens < 1) {
      const waitMs = (1 / this.currentRps) * 1000;
      this.stats.totalQueued++;
      await this.sleep(waitMs);
      this.refillTokens();
    }

    this.tokens -= 1;
    this.inFlight++;
  }

  /**
   * Release after request completes (success or failure).
   */
  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.waitQueue.shift();
    if (next) next();
  }

  /**
   * Call this when a 429 response is received.
   * Handles Retry-After header and adaptive throttling.
   */
  onThrottled(retryAfterSeconds?: number): void {
    this.stats.totalThrottled++;
    const now = Date.now();

    // Honor Retry-After header
    if (retryAfterSeconds && retryAfterSeconds > 0) {
      const until = now + retryAfterSeconds * 1000;
      this.retryAfterUntil = Math.max(this.retryAfterUntil, until);
      console.error(`[rate-limit] 429 received. Retry-After: ${retryAfterSeconds}s. Pausing until ${new Date(until).toISOString()}`);
    } else {
      // No Retry-After header — use exponential backoff based on recent throttle count
      const recentCount = this.pruneWindow();
      const backoffMs = Math.min(1000 * Math.pow(2, recentCount), 60_000);
      this.retryAfterUntil = Math.max(this.retryAfterUntil, now + backoffMs);
      console.error(`[rate-limit] 429 received (no Retry-After). Backing off ${backoffMs}ms.`);
    }

    // Track in rolling window
    this.recentThrottles.push(now);

    // Adaptive: if too many 429s in the window, permanently reduce rate
    const windowCount = this.pruneWindow();
    if (windowCount >= this.config.throttleThreshold) {
      const oldRps = this.currentRps;
      this.currentRps = Math.max(this.config.floorRps, this.currentRps * 0.5);
      this.stats.adaptiveReductions++;
      console.error(`[rate-limit] Adaptive throttle: ${windowCount} 429s in ${this.config.windowMs / 1000}s window. ` +
        `RPS: ${oldRps.toFixed(1)} → ${this.currentRps.toFixed(1)}`);
    }
  }

  /**
   * Call periodically (or after successful requests) to let the rate recover.
   */
  onSuccess(): void {
    const windowCount = this.pruneWindow();

    // If no recent throttles, slowly recover toward max RPS
    if (windowCount === 0 && this.currentRps < this.config.maxRps) {
      const oldRps = this.currentRps;
      this.currentRps = Math.min(
        this.config.maxRps,
        this.currentRps * (1 + this.config.recoveryRate)
      );
      if (Math.abs(this.currentRps - oldRps) > 0.5) {
        console.error(`[rate-limit] Recovering: RPS ${oldRps.toFixed(1)} → ${this.currentRps.toFixed(1)}`);
      }
    }
  }

  /**
   * Parse Retry-After from HTTP response headers.
   * Handles both seconds (integer) and HTTP-date formats.
   */
  static parseRetryAfter(headerValue: string | null): number | undefined {
    if (!headerValue) return undefined;

    // Integer seconds
    const seconds = parseInt(headerValue, 10);
    if (!isNaN(seconds) && seconds > 0) return seconds;

    // HTTP-date (RFC 7231)
    const date = new Date(headerValue);
    if (!isNaN(date.getTime())) {
      const diffMs = date.getTime() - Date.now();
      return diffMs > 0 ? Math.ceil(diffMs / 1000) : 1;
    }

    return undefined;
  }

  /**
   * Get current limiter stats for monitoring/logging.
   */
  getStats(): typeof this.stats & { currentRps: number; inFlight: number; queueDepth: number } {
    return {
      ...this.stats,
      currentRps: this.currentRps,
      inFlight: this.inFlight,
      queueDepth: this.waitQueue.length,
    };
  }

  /** Reset to initial state */
  reset(): void {
    this.currentRps = this.config.maxRps;
    this.tokens = this.config.burstSize;
    this.lastRefill = Date.now();
    this.inFlight = 0;
    this.waitQueue = [];
    this.recentThrottles = [];
    this.retryAfterUntil = 0;
  }

  // ─── Internal ────────────────────────────────────────────

  private refillTokens(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const newTokens = elapsed * this.currentRps;
    this.tokens = Math.min(this.tokens + newTokens, this.config.burstSize + this.currentRps);
    this.lastRefill = now;
  }

  private pruneWindow(): number {
    const cutoff = Date.now() - this.config.windowMs;
    this.recentThrottles = this.recentThrottles.filter(t => t > cutoff);
    return this.recentThrottles.length;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
  }
}

// ─── Code Generator Output ───────────────────────────────────

/**
 * Returns the TypeScript source code for the rate limiter that gets
 * baked into every generated MCP server's api-client.ts.
 */
export function generateRateLimiterCode(): string {
  return `
// ─── Adaptive Rate Limiter ─────────────────────────────────
// Auto-generated by MCP Forge
// Three layers: token bucket + 429 detection + adaptive backoff

const RATE_LIMIT_RPS = parseFloat(process.env['RATE_LIMIT_RPS'] || '10');
const RATE_LIMIT_BURST = parseInt(process.env['RATE_LIMIT_BURST'] || '5', 10);
const RATE_LIMIT_MAX_CONCURRENT = parseInt(process.env['RATE_LIMIT_MAX_CONCURRENT'] || '10', 10);
const RATE_LIMIT_FLOOR = parseFloat(process.env['RATE_LIMIT_FLOOR_RPS'] || '1');

class AdaptiveRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private currentRps: number;
  private maxRps: number;
  private burstSize: number;
  private floorRps: number;
  private inFlight = 0;
  private maxConcurrent: number;
  private waitQueue: Array<() => void> = [];
  private recentThrottles: number[] = [];
  private retryAfterUntil = 0;
  private windowMs = 60_000;
  private throttleThreshold = 3;
  private recoveryRate = 0.1;
  private stats = { total: 0, throttled: 0, queued: 0, reductions: 0 };

  constructor(rps = RATE_LIMIT_RPS, burst = RATE_LIMIT_BURST, concurrent = RATE_LIMIT_MAX_CONCURRENT) {
    this.maxRps = rps;
    this.currentRps = rps;
    this.burstSize = burst;
    this.maxConcurrent = concurrent;
    this.floorRps = RATE_LIMIT_FLOOR;
    this.tokens = burst;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.stats.total++;

    // Hard stop: Retry-After lock
    const retryWait = this.retryAfterUntil - Date.now();
    if (retryWait > 0) await this.sleep(retryWait);

    // Concurrency gate
    if (this.inFlight >= this.maxConcurrent) {
      this.stats.queued++;
      await new Promise<void>(r => this.waitQueue.push(r));
    }

    // Token bucket
    this.refill();
    while (this.tokens < 1) {
      this.stats.queued++;
      await this.sleep((1 / this.currentRps) * 1000);
      this.refill();
    }
    this.tokens -= 1;
    this.inFlight++;
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.waitQueue.shift();
    if (next) next();
  }

  onThrottled(retryAfterSec?: number): void {
    this.stats.throttled++;
    const now = Date.now();

    if (retryAfterSec && retryAfterSec > 0) {
      this.retryAfterUntil = Math.max(this.retryAfterUntil, now + retryAfterSec * 1000);
      console.error(\`[rate-limit] 429. Retry-After: \${retryAfterSec}s\`);
    } else {
      const count = this.pruneWindow();
      const backoff = Math.min(1000 * Math.pow(2, count), 60_000);
      this.retryAfterUntil = Math.max(this.retryAfterUntil, now + backoff);
      console.error(\`[rate-limit] 429. Backoff: \${backoff}ms\`);
    }

    this.recentThrottles.push(now);
    const windowCount = this.pruneWindow();
    if (windowCount >= this.throttleThreshold) {
      const old = this.currentRps;
      this.currentRps = Math.max(this.floorRps, this.currentRps * 0.5);
      this.stats.reductions++;
      console.error(\`[rate-limit] Adaptive: \${windowCount} 429s → RPS \${old.toFixed(1)} → \${this.currentRps.toFixed(1)}\`);
    }
  }

  onSuccess(): void {
    if (this.pruneWindow() === 0 && this.currentRps < this.maxRps) {
      this.currentRps = Math.min(this.maxRps, this.currentRps * (1 + this.recoveryRate));
    }
  }

  static parseRetryAfter(val: string | null): number | undefined {
    if (!val) return undefined;
    const sec = parseInt(val, 10);
    if (!isNaN(sec) && sec > 0) return sec;
    const d = new Date(val);
    if (!isNaN(d.getTime())) { const diff = d.getTime() - Date.now(); return diff > 0 ? Math.ceil(diff / 1000) : 1; }
    return undefined;
  }

  getStats() { return { ...this.stats, currentRps: this.currentRps, inFlight: this.inFlight, queueDepth: this.waitQueue.length }; }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.tokens + elapsed * this.currentRps, this.burstSize + this.currentRps);
    this.lastRefill = now;
  }

  private pruneWindow(): number {
    const cutoff = Date.now() - this.windowMs;
    this.recentThrottles = this.recentThrottles.filter(t => t > cutoff);
    return this.recentThrottles.length;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, Math.max(0, ms)));
  }
}
`;
}
