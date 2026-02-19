// ---------------------------------------------------------------------------
// OpsPilot — EventBus Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/bus/EventBus';
import { OpsPilotEvent } from '../src/core/types/events';
import { createSilentLogger } from './helpers';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus(createSilentLogger());
  });

  // ── Subscribe & Publish ────────────────────────────────────────────────

  it('should deliver events to subscribers', async () => {
    const received: string[] = [];

    bus.subscribe<{ msg: string }>('test.event', (event) => {
      received.push(event.payload.msg);
    });

    await bus.publish<{ msg: string }>({
      type: 'test.event',
      source: 'test',
      timestamp: new Date(),
      payload: { msg: 'hello' },
    });

    assert.deepStrictEqual(received, ['hello']);
  });

  it('should deliver to multiple subscribers', async () => {
    let count = 0;
    bus.subscribe('test.event', () => { count++; });
    bus.subscribe('test.event', () => { count++; });

    await bus.publish({ type: 'test.event', source: 'test', timestamp: new Date(), payload: null });

    assert.strictEqual(count, 2);
  });

  it('should not deliver events to wrong type', async () => {
    let called = false;
    bus.subscribe('other.event', () => { called = true; });

    await bus.publish({ type: 'test.event', source: 'test', timestamp: new Date(), payload: null });

    assert.strictEqual(called, false);
  });

  // ── subscribeOnce ──────────────────────────────────────────────────────

  it('subscribeOnce should fire only once', async () => {
    let count = 0;
    bus.subscribeOnce('test.event', () => { count++; });

    const event: OpsPilotEvent = { type: 'test.event', source: 'test', timestamp: new Date(), payload: null };
    await bus.publish(event);
    await bus.publish(event);

    assert.strictEqual(count, 1);
  });

  // ── Unsubscribe ────────────────────────────────────────────────────────

  it('unsubscribe should prevent future deliveries', async () => {
    let count = 0;
    const sub = bus.subscribe('test.event', () => { count++; });

    const event: OpsPilotEvent = { type: 'test.event', source: 'test', timestamp: new Date(), payload: null };
    await bus.publish(event);
    assert.strictEqual(count, 1);

    sub.unsubscribe();
    await bus.publish(event);
    assert.strictEqual(count, 1);
  });

  it('unsubscribeAll should clear all subscriptions', async () => {
    bus.subscribe('a', () => {});
    bus.subscribe('b', () => {});
    assert.strictEqual(bus.listenerCount(), 2);

    bus.unsubscribeAll();
    assert.strictEqual(bus.listenerCount(), 0);
  });

  it('unsubscribeAll with eventType should clear only that type', async () => {
    bus.subscribe('a', () => {});
    bus.subscribe('b', () => {});

    bus.unsubscribeAll('a');
    assert.strictEqual(bus.listenerCount('a'), 0);
    assert.strictEqual(bus.listenerCount('b'), 1);
  });

  // ── Error Isolation ────────────────────────────────────────────────────

  it('should not propagate handler errors to other handlers', async () => {
    let secondCalled = false;

    bus.subscribe('test.event', () => { throw new Error('boom'); });
    bus.subscribe('test.event', () => { secondCalled = true; });

    await bus.publish({ type: 'test.event', source: 'test', timestamp: new Date(), payload: null });

    assert.strictEqual(secondCalled, true);
  });

  // ── listenerCount ──────────────────────────────────────────────────────

  it('listenerCount should reflect subscriptions accurately', () => {
    assert.strictEqual(bus.listenerCount(), 0);
    assert.strictEqual(bus.listenerCount('test.event'), 0);

    const sub = bus.subscribe('test.event', () => {});
    assert.strictEqual(bus.listenerCount(), 1);
    assert.strictEqual(bus.listenerCount('test.event'), 1);

    sub.unsubscribe();
    assert.strictEqual(bus.listenerCount(), 0);
  });

  // ── Async Handlers ─────────────────────────────────────────────────────

  it('should await async handlers', async () => {
    let resolved = false;

    bus.subscribe('test.event', async () => {
      await new Promise((r) => setTimeout(r, 10));
      resolved = true;
    });

    await bus.publish({ type: 'test.event', source: 'test', timestamp: new Date(), payload: null });

    assert.strictEqual(resolved, true);
  });

  // ── Event Shape ────────────────────────────────────────────────────────

  it('should preserve full event structure', async () => {
    let received: OpsPilotEvent<unknown> | null = null;

    bus.subscribe('test.event', (event) => { received = event; });

    const sent: OpsPilotEvent<{ x: number }> = {
      type: 'test.event',
      source: 'unit-test',
      timestamp: new Date('2026-01-01'),
      correlationId: 'corr-123',
      payload: { x: 42 },
    };

    await bus.publish(sent);

    assert.ok(received !== null);
    assert.strictEqual((received as OpsPilotEvent<unknown>).type, 'test.event');
    assert.strictEqual((received as OpsPilotEvent<unknown>).source, 'unit-test');
    assert.strictEqual((received as OpsPilotEvent<unknown>).correlationId, 'corr-123');
    assert.deepStrictEqual((received as OpsPilotEvent<{ x: number }>).payload, { x: 42 });
  });
});
