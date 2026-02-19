// ---------------------------------------------------------------------------
// OpsPilot — Retry with Exponential Backoff
// ---------------------------------------------------------------------------
// Retries a failing async operation with exponential backoff and jitter.
// Composes inside a circuit breaker: retry exhaustion counts as a failure.
// ---------------------------------------------------------------------------

/**
 * Configuration for retry behavior.
 */
export interface RetryOptions {
  /** Maximum number of retry attempts. Default: 3. */
  maxRetries?: number;
  /** Base delay in ms for the first retry. Default: 1000. */
  baseDelayMs?: number;
  /** Maximum delay in ms (cap). Default: 30000. */
  maxDelayMs?: number;
  /** Jitter factor (0-1). 0 = no jitter, 1 = full random jitter. Default: 0.3. */
  jitter?: number;
  /** Optional predicate to decide if an error is retryable. Default: all errors are retryable. */
  isRetryable?: (error: unknown) => boolean;
  /** Optional callback invoked before each retry. */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

/**
 * Result of a retry operation.
 */
export interface RetryResult<T> {
  /** The successful result, if any. */
  result?: T;
  /** The last error, if all retries failed. */
  error?: unknown;
  /** Total number of attempts made (1 = no retries). */
  attempts: number;
  /** Whether the operation succeeded. */
  success: boolean;
}

/**
 * Execute an async function with exponential backoff retry.
 *
 * Usage:
 * ```typescript
 * const result = await retryWithBackoff(
 *   () => fetch(url),
 *   { maxRetries: 3, baseDelayMs: 1000 }
 * );
 * ```
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const jitter = options.jitter ?? 0.3;
  const isRetryable = options.isRetryable ?? (() => true);
  const onRetry = options.onRetry;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry if we're out of attempts or the error isn't retryable
      if (attempt >= maxRetries || !isRetryable(error)) {
        throw error;
      }

      // Calculate delay: exponential with jitter
      const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
      const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
      const jitterAmount = cappedDelay * jitter * Math.random();
      const delay = Math.floor(cappedDelay + jitterAmount);

      if (onRetry) {
        onRetry(attempt + 1, error, delay);
      }

      await sleep(delay);
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError;
}

/**
 * Execute an async function with retry, returning a result object instead of throwing.
 */
export async function retryWithBackoffResult<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<RetryResult<T>> {
  let attempts = 0;
  const wrappedOnRetry = options.onRetry;

  try {
    const result = await retryWithBackoff(fn, {
      ...options,
      onRetry: (attempt, error, delayMs) => {
        attempts = attempt;
        if (wrappedOnRetry) wrappedOnRetry(attempt, error, delayMs);
      },
    });
    return { result, attempts: attempts + 1, success: true };
  } catch (error) {
    return { error, attempts: attempts + 1, success: false };
  }
}

/**
 * Predicate: retry on HTTP 429 (Too Many Requests) and 5xx errors.
 */
export function isRetryableHttpError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message;
    // Match "returned 429" or "returned 5xx" patterns
    const statusMatch = msg.match(/returned (\d{3})/);
    if (statusMatch) {
      const status = parseInt(statusMatch[1], 10);
      return status === 429 || (status >= 500 && status < 600);
    }
    // Network errors are retryable
    if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED') ||
        msg.includes('ETIMEDOUT') || msg.includes('ENOTFOUND') ||
        msg.includes('AbortError') || msg.includes('network')) {
      return true;
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
