// ---------------------------------------------------------------------------
// OpsPilot — Core Module Types
// ---------------------------------------------------------------------------
// These interfaces define the contract between the core framework and every
// module that plugs into OpsPilot. Modules MUST implement `IModule`.
// The core provides a `ModuleContext` at initialization time so modules
// can access infrastructure without importing core internals directly.
// ---------------------------------------------------------------------------

import { IEventBus } from './events';
import { IStorageEngine } from './storage';
import { IApprovalGate } from './security';

// ── Module Classification ──────────────────────────────────────────────────

/** Every module declares exactly one primary type. */
export enum ModuleType {
  Connector = 'connector',
  Detector = 'detector',
  Enricher = 'enricher',
  Notifier = 'notifier',
  Action = 'action',
  OpenClawTool = 'openclaw',
  UIExtension = 'ui',
}

// ── Lifecycle State Machine ────────────────────────────────────────────────

/**
 * Deterministic lifecycle states.
 *
 * ```
 * Registered → Initializing → Initialized → Starting → Running
 *                                                         │
 *                                          Stopping ← ────┘
 *                                             │
 *                                          Stopped → Destroyed
 *
 * Any state may transition to → Error
 * ```
 */
export enum ModuleState {
  Registered = 'registered',
  Initializing = 'initializing',
  Initialized = 'initialized',
  Starting = 'starting',
  Running = 'running',
  Stopping = 'stopping',
  Stopped = 'stopped',
  Destroyed = 'destroyed',
  Error = 'error',
}

// ── Module Manifest ────────────────────────────────────────────────────────

/**
 * Static metadata that every module exposes.
 *
 * The manifest is read by the `ModuleRegistry` to perform dependency
 * resolution, config validation, and lifecycle orchestration.
 */
export interface ModuleManifest {
  /** Unique identifier using `<type>.<name>` convention, e.g. `connector.fileTail`. */
  readonly id: string;

  /** Human-readable display name. */
  readonly name: string;

  /** Semver version string. */
  readonly version: string;

  /** Primary module category. */
  readonly type: ModuleType;

  /** Optional one-line description for dashboards / docs. */
  readonly description?: string;

  /**
   * IDs of modules that MUST be present and running before this module
   * can initialize. The `DependencyResolver` uses this to compute
   * startup order and detect cycles.
   */
  readonly dependencies?: readonly string[];

  /**
   * JSON Schema object that validates the module's config section.
   * If provided, `ConfigValidator` applies it before initialization.
   */
  readonly configSchema?: Record<string, unknown>;
}

// ── Module Health ──────────────────────────────────────────────────────────

export interface ModuleHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  message?: string;
  details?: Record<string, unknown>;
  lastCheck: Date;
}

// ── Logger Interface ───────────────────────────────────────────────────────

/**
 * Structured logger. Modules receive a child logger prefixed with their ID.
 */
export interface ILogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, error?: Error, context?: Record<string, unknown>): void;
  child(prefix: string): ILogger;
}

// ── Module Context ─────────────────────────────────────────────────────────

/**
 * Scoped runtime context injected into every module at `initialize()`.
 *
 * This is the ONLY way modules interact with core infrastructure.
 * Modules must NOT import core internals directly.
 */
export interface ModuleContext {
  /** The module's own ID (convenience mirror of `manifest.id`). */
  readonly moduleId: string;

  /** Module-specific configuration (already validated). */
  readonly config: Readonly<Record<string, unknown>>;

  /** Event bus for publishing and subscribing. */
  readonly bus: IEventBus;

  /** Namespaced storage engine. */
  readonly storage: IStorageEngine;

  /** Prefixed structured logger. */
  readonly logger: ILogger;

  /** Approval gate for action safety flow. */
  readonly approvalGate: IApprovalGate;
}

// ── Module Interface ───────────────────────────────────────────────────────

/**
 * The contract that every OpsPilot module must implement.
 *
 * Lifecycle methods are called in strict order by the `ModuleRegistry`:
 *
 * 1. `initialize(context)` — receive context, set up internal state
 * 2. `start()` — begin active work (subscribe to events, open connections)
 * 3. `stop()` — cease active work (unsubscribe, close connections)
 * 4. `destroy()` — release all resources
 *
 * Each method may be async. Errors transition the module to `Error` state.
 */
export interface IModule {
  /** Static metadata — must be available before `initialize()`. */
  readonly manifest: ModuleManifest;

  /** Set up internal state using the provided context. */
  initialize(context: ModuleContext): Promise<void>;

  /** Begin active processing. */
  start(): Promise<void>;

  /** Gracefully cease processing. */
  stop(): Promise<void>;

  /** Release all resources. */
  destroy(): Promise<void>;

  /** Return current health status (called periodically by core). */
  health(): ModuleHealth;
}

// ── Module Factory ─────────────────────────────────────────────────────────

/**
 * A factory function that instantiates a module.
 * Used by `ModuleLoader` for dynamic module discovery.
 */
export type ModuleFactory = () => IModule;
