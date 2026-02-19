// ---------------------------------------------------------------------------
// OpsPilot — Core Event Types
// ---------------------------------------------------------------------------
// All module-to-module communication flows through typed events.
// Events are immutable data objects — they describe what happened, never
// what should happen next. Handlers decide how to react.
// ---------------------------------------------------------------------------

/**
 * Canonical event envelope carried by the EventBus.
 *
 * @typeParam T  Payload shape. Defaults to `unknown` for untyped subscriptions.
 */
export interface OpsPilotEvent<T = unknown> {
  /** Dot-namespaced event type, e.g. `log.ingested`, `incident.created`. */
  readonly type: string;

  /** Module ID that produced this event. */
  readonly source: string;

  /** ISO-precision timestamp set by the bus at publish time. */
  readonly timestamp: Date;

  /** Optional correlation ID for tracing causal chains across modules. */
  readonly correlationId?: string;

  /** Event-specific data. */
  readonly payload: T;
}

/**
 * Handler function invoked when a matching event arrives.
 * May return a Promise — the bus awaits all handlers before resolving.
 */
export type EventHandler<T = unknown> = (
  event: OpsPilotEvent<T>,
) => void | Promise<void>;

/**
 * Opaque handle returned by `subscribe` / `subscribeOnce`.
 * Calling `unsubscribe()` removes the handler.
 */
export interface EventSubscription {
  /** Unique subscription ID. */
  readonly id: string;

  /** The event type this subscription listens to. */
  readonly eventType: string;

  /** Remove this subscription from the bus. */
  unsubscribe(): void;
}

/**
 * Public contract for the system event bus.
 *
 * Modules receive an `IEventBus` reference via their `ModuleContext` and use
 * it to publish events and subscribe to events from other modules.
 */
export interface IEventBus {
  /**
   * Publish an event to all subscribers of the given type.
   * Returns after every handler has settled (resolved or rejected).
   */
  publish<T>(event: OpsPilotEvent<T>): Promise<void>;

  /**
   * Subscribe to all events of a given type.
   * Returns a subscription handle that can unsubscribe.
   */
  subscribe<T = unknown>(
    eventType: string,
    handler: EventHandler<T>,
  ): EventSubscription;

  /**
   * Subscribe to the *next* occurrence of an event type, then auto-remove.
   */
  subscribeOnce<T = unknown>(
    eventType: string,
    handler: EventHandler<T>,
  ): EventSubscription;

  /** Remove a specific subscription by ID. */
  unsubscribe(subscriptionId: string): void;

  /**
   * Remove all subscriptions.
   * If `eventType` is supplied, only subscriptions for that type are removed.
   */
  unsubscribeAll(eventType?: string): void;

  /** Return the number of active subscriptions (useful for diagnostics). */
  listenerCount(eventType?: string): number;
}
