// ---------------------------------------------------------------------------
// OpsPilot — Application Bootstrap
// ---------------------------------------------------------------------------
// The Application class is the single composition root. It wires together
// all core subsystems, loads config, discovers modules, and drives the
// full startup/shutdown lifecycle.
//
// Usage:
//   const app = new Application();
//   app.registerModule(() => new MyModule());
//   await app.start('config/default.yaml');
//   // ... running ...
//   await app.stop();
// ---------------------------------------------------------------------------

import { OpsPilotConfig } from './types/config';
import { IModule, ModuleFactory, ModuleState } from './types/module';
import { IEventBus } from './types/events';
import { IStorageEngine } from './types/storage';
import { IAuditLogger, IApprovalGate } from './types/security';
import { IToolRegistry } from './types/openclaw';
import { ConfigLoader } from './config/ConfigLoader';
import { ConfigValidator } from './config/ConfigValidator';
import { EventBus } from './bus/EventBus';
import { ModuleLoader } from './modules/ModuleLoader';
import { ModuleRegistry } from './modules/ModuleRegistry';
import { MemoryStorage } from './storage/MemoryStorage';
import { FileStorage } from './storage/FileStorage';
import { SQLiteStorage } from './storage/SQLiteStorage';
import { AuditLogger } from './security/AuditLogger';
import { ApprovalGate } from './security/ApprovalGate';
import { AuthService } from './security/AuthService';
import { AuthConfig } from './types/auth';
import { ToolRegistry } from './openclaw/ToolRegistry';
import { Logger } from '../shared/logger';
import { ILogger } from './types/module';
import { ConfigError, OpsPilotError } from '../shared/errors';
import { PluginLoader } from './plugins/PluginLoader';

export enum ApplicationState {
  Created = 'created',
  Starting = 'starting',
  Running = 'running',
  Stopping = 'stopping',
  Stopped = 'stopped',
  Error = 'error',
}

export class Application {
  private state: ApplicationState = ApplicationState.Created;
  private config!: OpsPilotConfig;

  // Core subsystems — constructed during start()
  private logger!: ILogger;
  private bus!: IEventBus;
  private storage!: IStorageEngine;
  private auditLogger!: IAuditLogger;
  private approvalGate!: IApprovalGate;
  private authService!: AuthService;
  private toolRegistry!: IToolRegistry;
  private moduleLoader!: ModuleLoader;
  private moduleRegistry!: ModuleRegistry;

  // Factories registered before start()
  private readonly pendingFactories: Array<{ id: string; factory: ModuleFactory }> = [];

  // Callbacks invoked after core subsystems are constructed but before module init
  private readonly preInitHooks: Array<() => void> = [];

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Register a module factory. Can be called before `start()`.
   * The factory will be invoked during the module instantiation phase.
   */
  registerModule(id: string, factory: ModuleFactory): void {
    this.pendingFactories.push({ id, factory });
  }

  /**
   * Register a callback that runs after core subsystems (bus, storage,
   * approval gate, tool registry) are ready but before modules initialize.
   * Use this to inject dependencies into modules that need core references.
   */
  onPreInit(hook: () => void): void {
    this.preInitHooks.push(hook);
  }

  /**
   * Boot the entire system:
   *   1. Load & validate config
   *   2. Construct core subsystems
   *   3. Instantiate enabled modules
   *   4. Resolve dependencies
   *   5. Initialize modules in order
   *   6. Start modules in order
   *   7. Register shutdown hooks
   *
   * @param configPath  Path to the YAML config file.
   */
  async start(configPath: string = 'config/default.yaml'): Promise<void> {
    if (this.state !== ApplicationState.Created) {
      throw new OpsPilotError(
        `Cannot start: application is in "${this.state}" state`,
        'LIFECYCLE_ERROR',
      );
    }

    this.state = ApplicationState.Starting;

    try {
      // ── 1. Configuration ───────────────────────────────────────────────
      const configLoader = new ConfigLoader();
      this.config = configLoader.load(configPath);

      // ── 2. Logger (needs config first) ─────────────────────────────────
      this.logger = new Logger({
        level: this.config.logging?.level ?? 'info',
        format: this.config.logging?.format ?? 'text',
        prefix: 'OpsPilot',
        output: this.config.logging?.output ?? 'console',
        filePath: this.config.logging?.file,
        maxFileSize: this.config.logging?.maxFileSize,
        maxFiles: this.config.logging?.maxFiles,
      });

      this.logger.info('Starting OpsPilot', {
        name: this.config.system.name,
        environment: this.config.system.environment,
      });

      // Validate root config
      const configValidator = new ConfigValidator();
      const rootValidation = configValidator.validateRoot(this.config);
      if (!rootValidation.valid) {
        throw new ConfigError(
          `Invalid configuration:\n  ${rootValidation.errors.join('\n  ')}`,
        );
      }

      this.logger.info('Configuration validated');

      // ── 3. Core Subsystems ─────────────────────────────────────────────
      this.bus = new EventBus(this.logger);
      this.storage = this.createStorageEngine();
      this.auditLogger = new AuditLogger(this.storage, this.logger);
      this.approvalGate = new ApprovalGate(
        this.storage,
        this.bus,
        this.auditLogger,
        this.logger,
      );

      // Authentication service
      this.authService = this.createAuthService();

      // OpenClaw tool registry
      this.toolRegistry = new ToolRegistry(
        this.approvalGate,
        this.auditLogger,
        this.logger,
      );

      this.logger.info('Core subsystems initialized');

      // ── 4. Module Loader ───────────────────────────────────────────────
      this.moduleLoader = new ModuleLoader(this.logger);

      // Register all pending factories
      for (const { id, factory } of this.pendingFactories) {
        this.moduleLoader.registerFactory(id, factory);
      }

      // ── 4b. Dynamic Plugin Discovery ─────────────────────────────────
      const pluginsDir = (this.config as unknown as Record<string, unknown>)['pluginsDir'] as string | undefined;
      if (pluginsDir) {
        const pluginLoader = new PluginLoader(pluginsDir, this.logger);
        const pluginResult = await pluginLoader.loadAll();

        for (const { id, factory } of pluginResult.factories) {
          if (!this.moduleLoader.hasFactory(id)) {
            this.moduleLoader.registerFactory(id, factory);
            this.logger.info('Plugin module registered', { moduleId: id });
          } else {
            this.logger.warn('Plugin module skipped — ID already registered', { moduleId: id });
          }
        }

        for (const err of pluginResult.errors) {
          this.logger.warn('Plugin failed to load', { id: err.id, error: err.error });
        }
      }

      // Determine which modules are enabled
      const enabledIds = this.resolveEnabledModules();

      this.logger.info('Enabled modules', { modules: [...enabledIds] });

      // Instantiate enabled modules
      const modules = this.moduleLoader.instantiateAll(enabledIds);

      // ── 5. Pre-Init Hooks ──────────────────────────────────────────────
      // Allow external code to inject dependencies into module instances
      // before the registry initializes them.
      for (const hook of this.preInitHooks) {
        hook();
      }

      // ── 6. Module Registry ─────────────────────────────────────────────
      this.moduleRegistry = new ModuleRegistry(
        this.logger,
        this.bus,
        this.storage,
        this.approvalGate,
      );

      for (const mod of modules) {
        this.moduleRegistry.register(mod);
      }

      // ── 7. Initialize & Start ──────────────────────────────────────────
      await this.moduleRegistry.initializeAll(this.config);
      this.logger.info('All modules initialized');

      await this.moduleRegistry.startAll();
      this.logger.info('All modules started');

      // ── 8. Shutdown Hooks ──────────────────────────────────────────────
      this.registerShutdownHooks();

      // Audit the startup
      await this.auditLogger.log({
        action: 'system.started',
        actor: 'core',
        details: {
          name: this.config.system.name,
          environment: this.config.system.environment,
          modules: [...enabledIds],
        },
      });

      this.state = ApplicationState.Running;
      this.logger.info('OpsPilot is running', {
        name: this.config.system.name,
        moduleCount: modules.length,
      });
    } catch (err) {
      this.state = ApplicationState.Error;
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.logger) {
        this.logger.error('Failed to start OpsPilot', error);
      } else {
        console.error('Failed to start OpsPilot:', error);
      }
      throw err;
    }
  }

  /**
   * Gracefully shut down the entire system:
   *   1. Stop modules in reverse dependency order
   *   2. Destroy modules
   *   3. Clean up event bus
   *   4. Audit the shutdown
   */
  async stop(): Promise<void> {
    if (this.state !== ApplicationState.Running) {
      this.logger?.warn('Stop called but application is not running', {
        state: this.state,
      });
      return;
    }

    this.state = ApplicationState.Stopping;
    this.logger.info('Shutting down OpsPilot...');

    try {
      await this.moduleRegistry.stopAll();
      this.logger.info('All modules stopped');

      await this.moduleRegistry.destroyAll();
      this.logger.info('All modules destroyed');

      this.bus.unsubscribeAll();

      await this.auditLogger.log({
        action: 'system.stopped',
        actor: 'core',
      });

      this.state = ApplicationState.Stopped;
      this.logger.info('OpsPilot shutdown complete');
    } catch (err) {
      this.state = ApplicationState.Error;
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error('Error during shutdown', error);
      throw err;
    }
  }

  // ── Accessors (for testing / advanced use) ───────────────────────────────

  getState(): ApplicationState {
    return this.state;
  }

  getConfig(): OpsPilotConfig {
    return this.config;
  }

  getBus(): IEventBus {
    return this.bus;
  }

  getStorage(): IStorageEngine {
    return this.storage;
  }

  getModuleRegistry(): ModuleRegistry {
    return this.moduleRegistry;
  }

  getAuditLogger(): IAuditLogger {
    return this.auditLogger;
  }

  getApprovalGate(): IApprovalGate {
    return this.approvalGate;
  }

  getToolRegistry(): IToolRegistry {
    return this.toolRegistry;
  }

  getLogger(): ILogger {
    return this.logger;
  }

  getAuthService(): AuthService {
    return this.authService;
  }

  // ── Internal ───────────────────────────────────────────────────────────

  /**
   * Create the appropriate storage engine based on config.
   */
  private createStorageEngine(): IStorageEngine {
    const engine = this.config.storage?.engine ?? 'memory';
    switch (engine) {
      case 'sqlite': {
        const dbPath = (this.config.storage?.options?.dbPath as string) ?? './data/opspilot.db';
        this.logger.info('Using SQLite storage', { dbPath });
        return new SQLiteStorage(dbPath);
      }
      case 'file': {
        const dataDir = (this.config.storage?.options?.dataDir as string) ?? './data';
        this.logger.info('Using file-based storage', { dataDir });
        return new FileStorage(dataDir);
      }
      case 'memory':
      default:
        this.logger.info('Using in-memory storage (data will not persist)');
        return new MemoryStorage();
    }
  }

  /**
   * Determine which modules should be enabled based on config.
   *
   * A module is enabled if:
   *   - Its config section has `enabled: true`, OR
   *   - It has no config section (default: enabled)
   *
   * A module is disabled if:
   *   - Its config section has `enabled: false`
   */
  private resolveEnabledModules(): Set<string> {
    const enabled = new Set<string>();
    const registeredIds = this.moduleLoader.registeredIds();

    for (const id of registeredIds) {
      const moduleConfig = this.config.modules[id];
      if (moduleConfig && moduleConfig.enabled === false) {
        this.logger.info('Module disabled by configuration', { moduleId: id });
        continue;
      }
      enabled.add(id);
    }

    return enabled;
  }

  /**
   * Register process-level signal handlers for graceful shutdown.
   */
  private registerShutdownHooks(): void {
    const shutdown = async (signal: string) => {
      this.logger.info(`Received ${signal}, initiating graceful shutdown...`);
      try {
        await this.stop();
        process.exit(0);
      } catch {
        process.exit(1);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }

  /**
   * Build the AuthService from config and environment variables.
   *
   * Auth config can come from:
   *   - `auth` section in the YAML config
   *   - Environment variables: `OPSPILOT_JWT_SECRET`, `OPSPILOT_API_KEY`
   */
  private createAuthService(): AuthService {
    const rawAuth = (this.config as unknown as Record<string, unknown>).auth as
      | Partial<AuthConfig>
      | undefined;

    // Environment variable overrides
    const envSecret = process.env['OPSPILOT_JWT_SECRET'];
    const envApiKey = process.env['OPSPILOT_API_KEY'];

    const authConfig: AuthConfig = {
      enabled: rawAuth?.enabled ?? false,
      jwtSecret: rawAuth?.jwtSecret ?? envSecret,
      jwtExpiresIn: rawAuth?.jwtExpiresIn ?? '8h',
      jwtIssuer: rawAuth?.jwtIssuer ?? 'opspilot',
      apiKeys: [...(rawAuth?.apiKeys ?? [])],
      publicPaths: rawAuth?.publicPaths ?? ['/api/health'],
    };

    // If env API key is provided, add it as an admin key
    if (envApiKey) {
      authConfig.apiKeys!.push({
        label: 'env-api-key',
        key: envApiKey,
        role: 'admin',
      });
    }

    return new AuthService(authConfig, this.logger);
  }
}
