// ---------------------------------------------------------------------------
// OpsPilot — Rate Limiter Tests
// ---------------------------------------------------------------------------

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, KeyedRateLimiter } from '../src/shared/rate-limiter';

// ── RateLimiter ────────────────────────────────────────────────────────────

describe('RateLimiter', () => {

  it('should allow requests up to the limit', () => {
    const limiter = new RateLimiter({ maxRequests: 3, windowMs: 60_000 });
    assert.ok(limiter.tryAcquire().allowed);
    assert.ok(limiter.tryAcquire().allowed);
    assert.ok(limiter.tryAcquire().allowed);
    assert.ok(!limiter.tryAcquire().allowed);
  });

  it('should return correct remaining count', () => {
    const limiter = new RateLimiter({ maxRequests: 5, windowMs: 60_000 });
    assert.equal(limiter.tryAcquire().remaining, 4);
    assert.equal(limiter.tryAcquire().remaining, 3);
    assert.equal(limiter.tryAcquire().remaining, 2);
    assert.equal(limiter.tryAcquire().remaining, 1);
    assert.equal(limiter.tryAcquire().remaining, 0);
  });

  it('should reject when limit is reached', () => {
    const limiter = new RateLimiter({ maxRequests: 2, windowMs: 60_000 });
    limiter.tryAcquire();
    limiter.tryAcquire();
    const result = limiter.tryAcquire();
    assert.equal(result.allowed, false);
    assert.equal(result.remaining, 0);
  });

  it('should reset the window when timestamps expire', async () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 50 });
    limiter.tryAcquire();
    assert.ok(!limiter.tryAcquire().allowed);

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(limiter.tryAcquire().allowed);
  });

  it('should return limit in result', () => {
    const limiter = new RateLimiter({ maxRequests: 10, windowMs: 60_000 });
    assert.equal(limiter.tryAcquire().limit, 10);
  });

  it('should return resetAt in result', () => {
    const limiter = new RateLimiter({ maxRequests: 10, windowMs: 60_000 });
    const before = Date.now();
    const result = limiter.tryAcquire();
    assert.ok(result.resetAt >= before);
    assert.ok(result.resetAt <= before + 60_000 + 10);
  });

  it('should check without recording', () => {
    const limiter = new RateLimiter({ maxRequests: 2, windowMs: 60_000 });
    limiter.tryAcquire();
    const peek = limiter.check();
    assert.ok(peek.allowed);
    assert.equal(peek.remaining, 1);
    // check() should not consume a slot
    const peek2 = limiter.check();
    assert.equal(peek2.remaining, 1);
  });

  it('should track currentCount', () => {
    const limiter = new RateLimiter({ maxRequests: 10, windowMs: 60_000 });
    assert.equal(limiter.currentCount, 0);
    limiter.tryAcquire();
    limiter.tryAcquire();
    assert.equal(limiter.currentCount, 2);
  });

  it('should reset all timestamps', () => {
    const limiter = new RateLimiter({ maxRequests: 2, windowMs: 60_000 });
    limiter.tryAcquire();
    limiter.tryAcquire();
    assert.ok(!limiter.tryAcquire().allowed);
    limiter.reset();
    assert.ok(limiter.tryAcquire().allowed);
    assert.equal(limiter.currentCount, 1);
  });

  it('should default windowMs to 60 seconds', () => {
    const limiter = new RateLimiter({ maxRequests: 100 });
    const result = limiter.tryAcquire();
    const expectedReset = Date.now() + 60_000;
    // resetAt should be within a few ms of expected
    assert.ok(Math.abs(result.resetAt - expectedReset) < 100);
  });
});

// ── KeyedRateLimiter ───────────────────────────────────────────────────────

describe('KeyedRateLimiter', () => {

  it('should track limits per key independently', () => {
    const keyed = new KeyedRateLimiter({ maxRequests: 2, windowMs: 60_000 });
    assert.ok(keyed.tryAcquire('alice').allowed);
    assert.ok(keyed.tryAcquire('alice').allowed);
    assert.ok(!keyed.tryAcquire('alice').allowed);
    // Bob should still have his full allowance
    assert.ok(keyed.tryAcquire('bob').allowed);
    assert.ok(keyed.tryAcquire('bob').allowed);
    assert.ok(!keyed.tryAcquire('bob').allowed);
  });

  it('should check without recording per key', () => {
    const keyed = new KeyedRateLimiter({ maxRequests: 5, windowMs: 60_000 });
    keyed.tryAcquire('alice');
    const peek = keyed.check('alice');
    assert.ok(peek.allowed);
    assert.equal(peek.remaining, 4);
  });

  it('should check non-existent key as fully available', () => {
    const keyed = new KeyedRateLimiter({ maxRequests: 10, windowMs: 60_000 });
    const result = keyed.check('unknown');
    assert.ok(result.allowed);
    assert.equal(result.remaining, 10);
  });

  it('should reset a specific key', () => {
    const keyed = new KeyedRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    keyed.tryAcquire('alice');
    assert.ok(!keyed.tryAcquire('alice').allowed);
    keyed.reset('alice');
    assert.ok(keyed.tryAcquire('alice').allowed);
  });

  it('should reset all keys', () => {
    const keyed = new KeyedRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    keyed.tryAcquire('alice');
    keyed.tryAcquire('bob');
    keyed.resetAll();
    assert.equal(keyed.size, 0);
    assert.ok(keyed.tryAcquire('alice').allowed);
  });

  it('should track size', () => {
    const keyed = new KeyedRateLimiter({ maxRequests: 10, windowMs: 60_000 });
    assert.equal(keyed.size, 0);
    keyed.tryAcquire('a');
    keyed.tryAcquire('b');
    keyed.tryAcquire('c');
    assert.equal(keyed.size, 3);
  });
});
