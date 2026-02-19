// ---------------------------------------------------------------------------
// OpsPilot — Circuit Breaker Tests
// ---------------------------------------------------------------------------

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CircuitBreaker,
  CircuitState,
  CircuitOpenError,
} from '../src/shared/circuit-breaker';

describe('CircuitBreaker', () => {

  it('should start in closed state', () => {
    const breaker = new CircuitBreaker({ name: 'test' });
    assert.equal(breaker.getState(), CircuitState.Closed);
  });

  it('should pass through successful calls in closed state', async () => {
    const breaker = new CircuitBreaker({ name: 'test' });
    const result = await breaker.execute(() => Promise.resolve(42));
    assert.equal(result, 42);
  });

  it('should propagate errors in closed state', async () => {
    const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 5 });
    await assert.rejects(
      () => breaker.execute(() => Promise.reject(new Error('fail'))),
      { message: 'fail' },
    );
  });

  it('should open after reaching failure threshold', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, name: 'test' });
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => breaker.execute(() => Promise.reject(new Error('fail'))));
    }
    assert.equal(breaker.getState(), CircuitState.Open);
  });

  it('should reject calls when open', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, name: 'test-reject' });
    await assert.rejects(() => breaker.execute(() => Promise.reject(new Error('fail'))));
    assert.equal(breaker.getState(), CircuitState.Open);

    await assert.rejects(
      () => breaker.execute(() => Promise.resolve('should not run')),
      (err) => {
        assert.ok(err instanceof CircuitOpenError);
        assert.ok(err.message.includes('test-reject'));
        return true;
      },
    );
  });

  it('should transition to half-open after reset timeout', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 50,
      name: 'test',
    });
    await assert.rejects(() => breaker.execute(() => Promise.reject(new Error('fail'))));
    assert.equal(breaker.getState(), CircuitState.Open);

    await new Promise((r) => setTimeout(r, 60));
    assert.equal(breaker.getState(), CircuitState.HalfOpen);
  });

  it('should close on success in half-open state', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 50,
      name: 'test',
    });
    await assert.rejects(() => breaker.execute(() => Promise.reject(new Error('fail'))));
    await new Promise((r) => setTimeout(r, 60));

    const result = await breaker.execute(() => Promise.resolve('recovered'));
    assert.equal(result, 'recovered');
    assert.equal(breaker.getState(), CircuitState.Closed);
  });

  it('should re-open on failure in half-open state', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 50,
      name: 'test',
    });
    await assert.rejects(() => breaker.execute(() => Promise.reject(new Error('fail1'))));
    await new Promise((r) => setTimeout(r, 60));

    await assert.rejects(() => breaker.execute(() => Promise.reject(new Error('fail2'))));
    assert.equal(breaker.getState(), CircuitState.Open);
  });

  it('should track successes and failures in snapshot', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 5, name: 'snap' });
    await breaker.execute(() => Promise.resolve(1));
    await breaker.execute(() => Promise.resolve(2));
    await assert.rejects(() => breaker.execute(() => Promise.reject(new Error('x'))));

    const snap = breaker.snapshot();
    assert.equal(snap.name, 'snap');
    assert.equal(snap.successes, 2);
    assert.equal(snap.failures, 1);
    assert.ok(snap.lastSuccess instanceof Date);
    assert.ok(snap.lastFailure instanceof Date);
  });

  it('should support manual reset', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, name: 'test' });
    await assert.rejects(() => breaker.execute(() => Promise.reject(new Error('fail'))));
    assert.equal(breaker.getState(), CircuitState.Open);

    breaker.reset();
    assert.equal(breaker.getState(), CircuitState.Closed);
    const result = await breaker.execute(() => Promise.resolve('ok'));
    assert.equal(result, 'ok');
  });

  it('should support manual trip', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 100, name: 'test' });
    breaker.trip();
    assert.equal(breaker.getState(), CircuitState.Open);
    await assert.rejects(
      () => breaker.execute(() => Promise.resolve('nope')),
      (err) => err instanceof CircuitOpenError,
    );
  });

  it('should default failureThreshold to 5', async () => {
    const breaker = new CircuitBreaker({ name: 'default' });
    for (let i = 0; i < 4; i++) {
      await assert.rejects(() => breaker.execute(() => Promise.reject(new Error('fail'))));
    }
    assert.equal(breaker.getState(), CircuitState.Closed);
    await assert.rejects(() => breaker.execute(() => Promise.reject(new Error('fail'))));
    assert.equal(breaker.getState(), CircuitState.Open);
  });

  it('should report null dates when no success/failure has occurred', () => {
    const breaker = new CircuitBreaker({ name: 'fresh' });
    const snap = breaker.snapshot();
    assert.equal(snap.lastSuccess, null);
    assert.equal(snap.lastFailure, null);
  });

  it('should use default name when none provided', () => {
    const breaker = new CircuitBreaker();
    assert.equal(breaker.name, 'default');
  });
});
