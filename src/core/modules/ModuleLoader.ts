// ---------------------------------------------------------------------------
// OpsPilot — Module Loader
// ---------------------------------------------------------------------------
// Discovers and instantiates modules. In Phase 1 modules are registered
// programmatically via factories. Future phases will add filesystem
// discovery (scanning `src/modules/` for packages).
// ---------------------------------------------------------------------------

import { IModule, ModuleFactory } from '../types/module';
import { ILogger } from '../types/module';
import { ModuleError } from '../../shared/errors';

export class ModuleLoader {
  /** Registered factories keyed by module ID. */
  private readonly factories = new Map<string, ModuleFactory>();
  private readonly logger: ILogger;

  constructor(logger: ILogger) {
    this.logger = logger.child('ModuleLoader');
  }

  /**
   * Register a module factory. The factory will be called once when the
   * module is instantiated during startup.
   *
   * @param id       Module ID (must match the manifest ID of the produced module).
   * @param factory  Zero-argument function that creates an `IModule` instance.
   */
  registerFactory(id: string, factory: ModuleFactory): void {
    if (this.factories.has(id)) {
      throw new ModuleError(`Module factory already registered: "${id}"`, id);
    }
    this.factories.set(id, factory);
    this.logger.debug('Factory registered', { moduleId: id });
  }

  /**
   * Instantiate a module by invoking its registered factory.
   *
   * @throws ModuleError if no factory is registered or instantiation fails.
   */
  instantiate(id: string): IModule {
    const factory = this.factories.get(id);
    if (!factory) {
      throw new ModuleError(`No factory registered for module: "${id}"`, id);
    }

    try {
      const mod = factory();

      // Sanity check: manifest ID must match the registered ID
      if (mod.manifest.id !== id) {
        throw new ModuleError(
          `Module factory for "${id}" produced a module with mismatched manifest ID "${mod.manifest.id}"`,
          id,
        );
      }

      this.logger.info('Module instantiated', {
        moduleId: id,
        version: mod.manifest.version,
        type: mod.manifest.type,
      });

      return mod;
    } catch (err) {
      if (err instanceof ModuleError) throw err;
      throw new ModuleError(
        `Failed to instantiate module "${id}": ${err instanceof Error ? err.message : String(err)}`,
        id,
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * Instantiate all registered modules whose IDs appear in the provided set.
   * Modules not in the set are skipped (they are disabled).
   *
   * @param enabledIds  Set of module IDs that should be instantiated.
   */
  instantiateAll(enabledIds: Set<string>): IModule[] {
    const modules: IModule[] = [];

    for (const id of this.factories.keys()) {
      if (!enabledIds.has(id)) {
        this.logger.info('Module skipped (disabled)', { moduleId: id });
        continue;
      }
      modules.push(this.instantiate(id));
    }

    return modules;
  }

  /** Return all registered factory IDs. */
  registeredIds(): string[] {
    return [...this.factories.keys()];
  }

  /** Check if a factory is registered for the given ID. */
  hasFactory(id: string): boolean {
    return this.factories.has(id);
  }
}
