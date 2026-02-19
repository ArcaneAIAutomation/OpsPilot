// ---------------------------------------------------------------------------
// OpsPilot — Circuit Breaker
// ---------------------------------------------------------------------------
// Implements the circuit breaker pattern for outbound calls (notifiers,
// connectors). Prevents cascading failures by short-circuiting calls
// to failing endpoints.
//
// State machine:
//   CLOSED → (failures ≥ threshold) → OPEN → (timeout expires) →
//   HALF_OPEN → (success) → CLOSED
//             → (failure) → OPEN
// ---------------------------------------------------------------------------

/**
 * Circuit breaker states.
 */
export enum CircuitState {
  /** Normal operation — calls pass through. */
  Closed = 'closed',
  /** Failing — calls are rejected immediately. */
  Open = 'open',
  /** Testing — one trial call allowed to probe recovery. */
  HalfOpen = 'half-open',
}

/**
 * Configuration for the circuit breaker.
 */
export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit. Default: 5. */
  failureThreshold?: number;
  /** Time in ms to wait before transitioning from OPEN to HALF_OPEN. Default: 30000. */
  resetTimeoutMs?: number;
  /** Optional name for logging/metrics. */
  name?: string;
}

/**
 * Error thrown when the circuit is open and calls are rejected.
 */
export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`Circuit breaker "${name}" is OPEN — call rejected`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Snapshot of circuit breaker state for monitoring.
 */
export interface CircuitBreakerSnapshot {
  name: string;
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailure: Date | null;
  lastSuccess: Date | null;
}

/**
 * Circuit breaker for outbound calls.
 *
 * Usage:
 * ```typescript
 * const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 10000, name: 'slack' });
 * const result = await breaker.execute(() => fetch(url, options));
 * ```
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.Closed;
  private failures: number = 0;
  private successes: number = 0;
  private lastFailureTime: number = 0;
  private lastSuccessTime: number = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  readonly name: string;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    this.name = options.name ?? 'default';
  }

  /**
   * Execute a function through the circuit breaker.
   *
   * @throws CircuitOpenError if the circuit is open.
   * @throws The original error if the function fails and the circuit is closed/half-open.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check for state transition: OPEN → HALF_OPEN
    if (this.state === CircuitState.Open) {
      if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        this.state = CircuitState.HalfOpen;
      } else {
        throw new CircuitOpenError(this.name);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Get the current state of the circuit breaker.
   */
  getState(): CircuitState {
    // Check for pending state transition
    if (this.state === CircuitState.Open) {
      if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        return CircuitState.HalfOpen;
      }
    }
    return this.state;
  }

  /**
   * Get a snapshot of the circuit breaker for monitoring.
   */
  snapshot(): CircuitBreakerSnapshot {
    return {
      name: this.name,
      state: this.getState(),
      failures: this.failures,
      successes: this.successes,
      lastFailure: this.lastFailureTime > 0 ? new Date(this.lastFailureTime) : null,
      lastSuccess: this.lastSuccessTime > 0 ? new Date(this.lastSuccessTime) : null,
    };
  }

  /**
   * Manually reset the circuit breaker to CLOSED state.
   */
  reset(): void {
    this.state = CircuitState.Closed;
    this.failures = 0;
  }

  /**
   * Force the circuit breaker to OPEN state (manual trip).
   */
  trip(): void {
    this.state = CircuitState.Open;
    this.lastFailureTime = Date.now();
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private onSuccess(): void {
    this.successes++;
    this.lastSuccessTime = Date.now();

    if (this.state === CircuitState.HalfOpen) {
      // Recovery confirmed — close the circuit
      this.state = CircuitState.Closed;
      this.failures = 0;
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.HalfOpen) {
      // Recovery failed — re-open the circuit
      this.state = CircuitState.Open;
    } else if (this.state === CircuitState.Closed) {
      if (this.failures >= this.failureThreshold) {
        this.state = CircuitState.Open;
      }
    }
  }
}
