// ---------------------------------------------------------------------------
// OpsPilot — Rate Limiter (Sliding Window)
// ---------------------------------------------------------------------------
// Token-bucket-style rate limiter that uses a sliding time window.
// Used by both the HTTP API (per-IP/key) and outbound notifiers.
// ---------------------------------------------------------------------------

/**
 * Configuration for the rate limiter.
 */
export interface RateLimiterOptions {
  /** Maximum number of requests allowed within the window. */
  maxRequests: number;
  /** Window size in milliseconds. Default: 60000 (60 seconds). */
  windowMs?: number;
}

/**
 * Result of a rate limit check.
 */
export interface RateLimitResult {
  /** Whether the request is allowed. */
  allowed: boolean;
  /** Number of remaining requests in the current window. */
  remaining: number;
  /** Unix timestamp (ms) when the window resets. */
  resetAt: number;
  /** Total allowed per window. */
  limit: number;
}

/**
 * Sliding-window rate limiter.
 *
 * Tracks request timestamps and prunes entries outside the window.
 * Thread-safe for single-threaded Node.js (no async gap between check and record).
 */
export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly timestamps: number[] = [];

  constructor(options: RateLimiterOptions) {
    this.maxRequests = options.maxRequests;
    this.windowMs = options.windowMs ?? 60_000;
  }

  /**
   * Check if a request is allowed and record it if so.
   */
  tryAcquire(): RateLimitResult {
    const now = Date.now();
    this.prune(now);

    const allowed = this.timestamps.length < this.maxRequests;
    if (allowed) {
      this.timestamps.push(now);
    }

    const oldest = this.timestamps.length > 0 ? this.timestamps[0] : now;
    return {
      allowed,
      remaining: Math.max(0, this.maxRequests - this.timestamps.length),
      resetAt: oldest + this.windowMs,
      limit: this.maxRequests,
    };
  }

  /**
   * Check without recording (peek).
   */
  check(): RateLimitResult {
    const now = Date.now();
    this.prune(now);

    return {
      allowed: this.timestamps.length < this.maxRequests,
      remaining: Math.max(0, this.maxRequests - this.timestamps.length),
      resetAt: this.timestamps.length > 0 ? this.timestamps[0] + this.windowMs : now + this.windowMs,
      limit: this.maxRequests,
    };
  }

  /**
   * Reset all tracked timestamps.
   */
  reset(): void {
    this.timestamps.length = 0;
  }

  /**
   * Number of requests currently tracked in the window.
   */
  get currentCount(): number {
    this.prune(Date.now());
    return this.timestamps.length;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0] <= cutoff) {
      this.timestamps.shift();
    }
  }
}

/**
 * Keyed rate limiter — maintains separate rate limiters per key (e.g. IP address).
 *
 * Automatically cleans up stale entries to prevent memory leaks.
 */
export class KeyedRateLimiter {
  private readonly limiters = new Map<string, RateLimiter>();
  private readonly options: RateLimiterOptions;
  private lastCleanup: number = Date.now();
  private readonly cleanupIntervalMs: number;

  constructor(options: RateLimiterOptions, cleanupIntervalMs: number = 300_000) {
    this.options = options;
    this.cleanupIntervalMs = cleanupIntervalMs;
  }

  /**
   * Check rate limit for a specific key.
   */
  tryAcquire(key: string): RateLimitResult {
    this.maybeCleanup();

    let limiter = this.limiters.get(key);
    if (!limiter) {
      limiter = new RateLimiter(this.options);
      this.limiters.set(key, limiter);
    }
    return limiter.tryAcquire();
  }

  /**
   * Check without recording for a specific key.
   */
  check(key: string): RateLimitResult {
    const limiter = this.limiters.get(key);
    if (!limiter) {
      return {
        allowed: true,
        remaining: this.options.maxRequests,
        resetAt: Date.now() + (this.options.windowMs ?? 60_000),
        limit: this.options.maxRequests,
      };
    }
    return limiter.check();
  }

  /**
   * Reset rate limit for a specific key.
   */
  reset(key: string): void {
    this.limiters.delete(key);
  }

  /**
   * Reset all keys.
   */
  resetAll(): void {
    this.limiters.clear();
  }

  /**
   * Number of tracked keys.
   */
  get size(): number {
    return this.limiters.size;
  }

  /**
   * Clean up keys with no recent activity.
   */
  private maybeCleanup(): void {
    const now = Date.now();
    if (now - this.lastCleanup < this.cleanupIntervalMs) return;
    this.lastCleanup = now;

    for (const [key, limiter] of this.limiters.entries()) {
      if (limiter.currentCount === 0) {
        this.limiters.delete(key);
      }
    }
  }
}
