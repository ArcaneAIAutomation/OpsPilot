// ---------------------------------------------------------------------------
// OpsPilot — EventBus Implementation
// ---------------------------------------------------------------------------
// Async publish/subscribe bus. Handlers run concurrently per-event.
// Errors in one handler never prevent other handlers from executing.
// The bus logs handler failures but does not re-throw — system stability
// takes priority over individual handler correctness.
// ---------------------------------------------------------------------------

import {
  IEventBus,
  EventHandler,
  EventSubscription,
  OpsPilotEvent,
} from '../types/events';
import { ILogger } from '../types/module';
import { generateId } from '../../shared/utils';

interface InternalSubscription<T = unknown> {
  id: string;
  eventType: string;
  handler: EventHandler<T>;
  once: boolean;
}

export class EventBus implements IEventBus {
  /**
   * Map of event type → list of subscriptions.
   * Using a Map of arrays gives O(1) lookup by type and O(n) broadcast.
   */
  private readonly subscriptions = new Map<string, InternalSubscription[]>();
  private readonly logger: ILogger;

  constructor(logger: ILogger) {
    this.logger = logger.child('EventBus');
  }

  // ── Publish ──────────────────────────────────────────────────────────────

  async publish<T>(event: OpsPilotEvent<T>): Promise<void> {
    const subs = this.subscriptions.get(event.type);
    if (!subs || subs.length === 0) {
      this.logger.debug('No subscribers for event', { type: event.type, source: event.source });
      return;
    }

    this.logger.debug('Publishing event', {
      type: event.type,
      source: event.source,
      subscriberCount: subs.length,
    });

    // Snapshot the list to avoid mutation during iteration
    const snapshot = [...subs];
    const toRemove: string[] = [];

    // Run all handlers concurrently, settle all before returning
    const results = await Promise.allSettled(
      snapshot.map(async (sub) => {
        try {
          await sub.handler(event as OpsPilotEvent<unknown>);
        } finally {
          if (sub.once) {
            toRemove.push(sub.id);
          }
        }
      }),
    );

    // Remove one-shot subscriptions
    for (const id of toRemove) {
      this.removeSub(id);
    }

    // Log failures (but never re-throw — system stability first)
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error(
          'Event handler failed',
          result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
          { eventType: event.type },
        );
      }
    }
  }

  // ── Subscribe ────────────────────────────────────────────────────────────

  subscribe<T = unknown>(
    eventType: string,
    handler: EventHandler<T>,
  ): EventSubscription {
    return this.addSub(eventType, handler, false);
  }

  subscribeOnce<T = unknown>(
    eventType: string,
    handler: EventHandler<T>,
  ): EventSubscription {
    return this.addSub(eventType, handler, true);
  }

  // ── Unsubscribe ──────────────────────────────────────────────────────────

  unsubscribe(subscriptionId: string): void {
    this.removeSub(subscriptionId);
  }

  unsubscribeAll(eventType?: string): void {
    if (eventType) {
      this.subscriptions.delete(eventType);
    } else {
      this.subscriptions.clear();
    }
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  listenerCount(eventType?: string): number {
    if (eventType) {
      return this.subscriptions.get(eventType)?.length ?? 0;
    }
    let total = 0;
    for (const subs of this.subscriptions.values()) {
      total += subs.length;
    }
    return total;
  }

  // ── Internal Helpers ─────────────────────────────────────────────────────

  private addSub<T>(
    eventType: string,
    handler: EventHandler<T>,
    once: boolean,
  ): EventSubscription {
    const id = generateId();
    const sub: InternalSubscription = { id, eventType, handler: handler as EventHandler, once };

    let list = this.subscriptions.get(eventType);
    if (!list) {
      list = [];
      this.subscriptions.set(eventType, list);
    }
    list.push(sub);

    this.logger.debug('Subscription added', { id, eventType, once });

    return {
      id,
      eventType,
      unsubscribe: () => this.removeSub(id),
    };
  }

  private removeSub(subscriptionId: string): void {
    for (const [type, subs] of this.subscriptions.entries()) {
      const idx = subs.findIndex((s) => s.id === subscriptionId);
      if (idx !== -1) {
        subs.splice(idx, 1);
        if (subs.length === 0) {
          this.subscriptions.delete(type);
        }
        this.logger.debug('Subscription removed', { id: subscriptionId, eventType: type });
        return;
      }
    }
  }
}
