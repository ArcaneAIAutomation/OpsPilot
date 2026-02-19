// ---------------------------------------------------------------------------
// OpsPilot — Module Registry & Lifecycle Manager
// ---------------------------------------------------------------------------
// Owns the lifecycle of all active modules. Transitions modules through
// the state machine in dependency order. Maintains runtime state map.
// ---------------------------------------------------------------------------

import {
  IModule,
  ModuleState,
  ModuleContext,
  ModuleHealth,
  ILogger,
} from '../types/module';
import { IEventBus, OpsPilotEvent } from '../types/events';
import { IStorageEngine } from '../types/storage';
import { IApprovalGate } from '../types/security';
import { OpsPilotConfig, ModuleConfig } from '../types/config';
import { ConfigValidator } from '../config/ConfigValidator';
import { DependencyResolver } from './DependencyResolver';
import { ModuleError } from '../../shared/errors';
import { NamespacedStorage } from '../storage/NamespacedStorage';

// ── Internal tracking entry ────────────────────────────────────────────────

interface ModuleEntry {
  module: IModule;
  state: ModuleState;
  error?: Error;
}

// ── System lifecycle events ────────────────────────────────────────────────

interface ModuleLifecyclePayload {
  moduleId: string;
  state: ModuleState;
  error?: string;
}

export class ModuleRegistry {
  private readonly entries = new Map<string, ModuleEntry>();
  private readonly logger: ILogger;
  private readonly bus: IEventBus;
  private readonly storage: IStorageEngine;
  private readonly approvalGate: IApprovalGate;
  private readonly configValidator: ConfigValidator;
  private readonly dependencyResolver: DependencyResolver;
  private startupOrder: string[] = [];

  constructor(
    logger: ILogger,
    bus: IEventBus,
    storage: IStorageEngine,
    approvalGate: IApprovalGate,
  ) {
    this.logger = logger.child('ModuleRegistry');
    this.bus = bus;
    this.storage = storage;
    this.approvalGate = approvalGate;
    this.configValidator = new ConfigValidator();
    this.dependencyResolver = new DependencyResolver();
  }

  // ── Registration ─────────────────────────────────────────────────────────

  /**
   * Register an instantiated module. Does NOT initialize or start it.
   */
  register(module: IModule): void {
    const id = module.manifest.id;
    if (this.entries.has(id)) {
      throw new ModuleError(`Module already registered: "${id}"`, id);
    }

    this.entries.set(id, {
      module,
      state: ModuleState.Registered,
    });

    this.logger.info('Module registered', {
      moduleId: id,
      type: module.manifest.type,
      version: module.manifest.version,
    });
  }

  // ── Lifecycle: Initialize All ────────────────────────────────────────────

  /**
   * Resolve dependencies and initialize all registered modules in order.
   *
   * @param config  Full system config (each module extracts its own section).
   */
  async initializeAll(config: OpsPilotConfig): Promise<void> {
    const manifests = [...this.entries.values()].map((e) => e.module.manifest);

    // Resolve dependency order
    const graph = this.dependencyResolver.resolve(manifests);
    this.startupOrder = graph.order;

    this.logger.info('Dependency order resolved', { order: this.startupOrder });

    // Initialize in dependency order
    for (const id of this.startupOrder) {
      await this.initializeOne(id, config);
    }
  }

  /**
   * Start all initialized modules in dependency order.
   */
  async startAll(): Promise<void> {
    for (const id of this.startupOrder) {
      const entry = this.entries.get(id);
      if (!entry || entry.state !== ModuleState.Initialized) continue;
      await this.startOne(id);
    }
  }

  /**
   * Stop all running modules in REVERSE dependency order.
   */
  async stopAll(): Promise<void> {
    const reverseOrder = [...this.startupOrder].reverse();
    for (const id of reverseOrder) {
      const entry = this.entries.get(id);
      if (!entry || entry.state !== ModuleState.Running) continue;
      await this.stopOne(id);
    }
  }

  /**
   * Destroy all stopped modules in reverse dependency order.
   */
  async destroyAll(): Promise<void> {
    const reverseOrder = [...this.startupOrder].reverse();
    for (const id of reverseOrder) {
      const entry = this.entries.get(id);
      if (!entry || entry.state !== ModuleState.Stopped) continue;
      await this.destroyOne(id);
    }
  }

  // ── Individual lifecycle transitions ─────────────────────────────────────

  private async initializeOne(id: string, config: OpsPilotConfig): Promise<void> {
    const entry = this.entries.get(id)!;
    const manifest = entry.module.manifest;

    // Extract and validate module config
    const moduleConfig: ModuleConfig = config.modules[id] ?? { enabled: true };
    const { enabled: _, ...configWithoutEnabled } = moduleConfig;

    if (manifest.configSchema) {
      const result = this.configValidator.validateModuleConfig(manifest, configWithoutEnabled);
      if (!result.valid) {
        const err = new ModuleError(
          `Config validation failed for "${id}": ${result.errors.join('; ')}`,
          id,
        );
        this.transitionState(id, ModuleState.Error, err);
        throw err;
      }
    }

    // Build scoped context
    const context: ModuleContext = {
      moduleId: id,
      config: configWithoutEnabled,
      bus: this.bus,
      storage: new NamespacedStorage(this.storage, id),
      logger: this.logger.child(id),
      approvalGate: this.approvalGate,
    };

    this.transitionState(id, ModuleState.Initializing);

    try {
      await entry.module.initialize(context);
      this.transitionState(id, ModuleState.Initialized);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.transitionState(id, ModuleState.Error, error);
      throw new ModuleError(
        `Module "${id}" failed to initialize: ${error.message}`,
        id,
        error,
      );
    }
  }

  private async startOne(id: string): Promise<void> {
    const entry = this.entries.get(id)!;
    this.transitionState(id, ModuleState.Starting);

    try {
      await entry.module.start();
      this.transitionState(id, ModuleState.Running);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.transitionState(id, ModuleState.Error, error);
      throw new ModuleError(
        `Module "${id}" failed to start: ${error.message}`,
        id,
        error,
      );
    }
  }

  private async stopOne(id: string): Promise<void> {
    const entry = this.entries.get(id)!;
    this.transitionState(id, ModuleState.Stopping);

    try {
      await entry.module.stop();
      this.transitionState(id, ModuleState.Stopped);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error(`Module "${id}" failed to stop cleanly`, error);
      // Force to stopped state even on error — we must continue shutdown
      this.transitionState(id, ModuleState.Stopped);
    }
  }

  private async destroyOne(id: string): Promise<void> {
    const entry = this.entries.get(id)!;

    try {
      await entry.module.destroy();
      this.transitionState(id, ModuleState.Destroyed);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error(`Module "${id}" failed to destroy cleanly`, error);
      this.transitionState(id, ModuleState.Destroyed);
    }
  }

  // ── State Machine ────────────────────────────────────────────────────────

  private transitionState(id: string, newState: ModuleState, error?: Error): void {
    const entry = this.entries.get(id)!;
    const oldState = entry.state;
    entry.state = newState;
    entry.error = error;

    this.logger.info('Module state transition', {
      moduleId: id,
      from: oldState,
      to: newState,
      ...(error ? { error: error.message } : {}),
    });

    // Emit lifecycle event (fire-and-forget — lifecycle events are informational)
    const payload: ModuleLifecyclePayload = {
      moduleId: id,
      state: newState,
      ...(error ? { error: error.message } : {}),
    };

    const event: OpsPilotEvent<ModuleLifecyclePayload> = {
      type: 'module.lifecycle',
      source: 'core.registry',
      timestamp: new Date(),
      payload,
    };

    // Intentionally not awaited — lifecycle events are best-effort
    this.bus.publish(event).catch((e) => {
      this.logger.error('Failed to emit lifecycle event', e instanceof Error ? e : new Error(String(e)));
    });
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  getState(id: string): ModuleState | undefined {
    return this.entries.get(id)?.state;
  }

  getModule(id: string): IModule | undefined {
    return this.entries.get(id)?.module;
  }

  getHealth(id: string): ModuleHealth | undefined {
    return this.entries.get(id)?.module.health();
  }

  getAllStates(): Map<string, ModuleState> {
    const states = new Map<string, ModuleState>();
    for (const [id, entry] of this.entries) {
      states.set(id, entry.state);
    }
    return states;
  }

  getRegisteredIds(): string[] {
    return [...this.entries.keys()];
  }

  isRunning(id: string): boolean {
    return this.entries.get(id)?.state === ModuleState.Running;
  }
}
