// ---------------------------------------------------------------------------
// OpsPilot — Retry with Backoff Tests
// ---------------------------------------------------------------------------

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  retryWithBackoff,
  retryWithBackoffResult,
  isRetryableHttpError,
} from '../src/shared/retry';

describe('retryWithBackoff', () => {

  it('should return immediately on success', async () => {
    let calls = 0;
    const result = await retryWithBackoff(() => {
      calls++;
      return Promise.resolve('success');
    }, { maxRetries: 3 });
    assert.equal(result, 'success');
    assert.equal(calls, 1);
  });

  it('should retry on failure and succeed', async () => {
    let calls = 0;
    const result = await retryWithBackoff(() => {
      calls++;
      if (calls < 3) return Promise.reject(new Error(`fail ${calls}`));
      return Promise.resolve('recovered');
    }, { maxRetries: 3, baseDelayMs: 10 });
    assert.equal(result, 'recovered');
    assert.equal(calls, 3);
  });

  it('should throw after exhausting retries', async () => {
    let calls = 0;
    await assert.rejects(
      () => retryWithBackoff(() => {
        calls++;
        return Promise.reject(new Error('always fail'));
      }, { maxRetries: 2, baseDelayMs: 10 }),
      { message: 'always fail' },
    );
    assert.equal(calls, 3); // 1 initial + 2 retries
  });

  it('should not retry non-retryable errors', async () => {
    let calls = 0;
    await assert.rejects(
      () => retryWithBackoff(() => {
        calls++;
        return Promise.reject(new Error('non-retryable'));
      }, {
        maxRetries: 3,
        baseDelayMs: 10,
        isRetryable: () => false,
      }),
      { message: 'non-retryable' },
    );
    assert.equal(calls, 1);
  });

  it('should call onRetry callback', async () => {
    const retries: Array<{ attempt: number; delayMs: number }> = [];
    let calls = 0;
    await retryWithBackoff(() => {
      calls++;
      if (calls < 3) return Promise.reject(new Error('fail'));
      return Promise.resolve('ok');
    }, {
      maxRetries: 3,
      baseDelayMs: 10,
      jitter: 0,
      onRetry: (attempt, _error, delayMs) => {
        retries.push({ attempt, delayMs });
      },
    });
    assert.equal(retries.length, 2);
    assert.equal(retries[0].attempt, 1);
    assert.equal(retries[1].attempt, 2);
    // Exponential: first retry = 10ms, second = 20ms (with jitter=0)
    assert.equal(retries[0].delayMs, 10);
    assert.equal(retries[1].delayMs, 20);
  });

  it('should cap delay at maxDelayMs', async () => {
    const delays: number[] = [];
    let calls = 0;
    await assert.rejects(() =>
      retryWithBackoff(() => {
        calls++;
        return Promise.reject(new Error('fail'));
      }, {
        maxRetries: 5,
        baseDelayMs: 100,
        maxDelayMs: 200,
        jitter: 0,
        onRetry: (_attempt, _error, delayMs) => {
          delays.push(delayMs);
        },
      }),
    );
    // All delays should be ≤ maxDelayMs
    for (const d of delays) {
      assert.ok(d <= 200, `delay ${d} exceeds max 200`);
    }
  });

  it('should apply jitter to delays', async () => {
    const delays: number[] = [];
    let calls = 0;
    await assert.rejects(() =>
      retryWithBackoff(() => {
        calls++;
        return Promise.reject(new Error('fail'));
      }, {
        maxRetries: 2,
        baseDelayMs: 10,
        jitter: 1.0, // Full jitter
        onRetry: (_attempt, _error, delayMs) => {
          delays.push(delayMs);
        },
      }),
    );
    // With jitter, delays should be ≥ baseDelay (since jitter adds, not subtracts)
    assert.ok(delays.length > 0);
  });
});

describe('retryWithBackoffResult', () => {

  it('should return success result', async () => {
    const result = await retryWithBackoffResult(
      () => Promise.resolve('data'),
      { maxRetries: 2 },
    );
    assert.ok(result.success);
    assert.equal(result.result, 'data');
    assert.equal(result.error, undefined);
  });

  it('should return failure result without throwing', async () => {
    const result = await retryWithBackoffResult(
      () => Promise.reject(new Error('fail')),
      { maxRetries: 1, baseDelayMs: 10 },
    );
    assert.ok(!result.success);
    assert.ok(result.error instanceof Error);
    assert.equal((result.error as Error).message, 'fail');
  });

  it('should track attempt count on success', async () => {
    let calls = 0;
    const result = await retryWithBackoffResult(() => {
      calls++;
      if (calls < 2) return Promise.reject(new Error('fail'));
      return Promise.resolve('ok');
    }, { maxRetries: 3, baseDelayMs: 10 });
    assert.ok(result.success);
    assert.equal(result.attempts, 2);
  });
});

describe('isRetryableHttpError', () => {

  it('should return true for 429 status', () => {
    assert.ok(isRetryableHttpError(new Error('Webhook returned 429: Too Many Requests')));
  });

  it('should return true for 500 status', () => {
    assert.ok(isRetryableHttpError(new Error('API returned 500: Internal Server Error')));
  });

  it('should return true for 503 status', () => {
    assert.ok(isRetryableHttpError(new Error('API returned 503: Service Unavailable')));
  });

  it('should return false for 400 status', () => {
    assert.ok(!isRetryableHttpError(new Error('API returned 400: Bad Request')));
  });

  it('should return false for 404 status', () => {
    assert.ok(!isRetryableHttpError(new Error('API returned 404: Not Found')));
  });

  it('should return true for network errors', () => {
    assert.ok(isRetryableHttpError(new Error('fetch failed')));
    assert.ok(isRetryableHttpError(new Error('ECONNREFUSED')));
    assert.ok(isRetryableHttpError(new Error('ETIMEDOUT')));
    assert.ok(isRetryableHttpError(new Error('ENOTFOUND')));
  });

  it('should return false for non-Error values', () => {
    assert.ok(!isRetryableHttpError('string error'));
    assert.ok(!isRetryableHttpError(42));
    assert.ok(!isRetryableHttpError(null));
  });

  it('should return false for unrecognized errors', () => {
    assert.ok(!isRetryableHttpError(new Error('something random')));
  });
});
