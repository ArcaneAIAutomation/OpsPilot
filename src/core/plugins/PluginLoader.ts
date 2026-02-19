// ---------------------------------------------------------------------------
// OpsPilot — Dynamic Plugin Loader
// ---------------------------------------------------------------------------
// Discovers and loads external OpsPilot modules from a plugin directory.
//
// Plugin structure (each plugin is a directory under `pluginsDir`):
//
//   plugins/
//     my-plugin/
//       manifest.json    ← { id, name, version, type, description, entry }
//       index.js|.ts     ← exports default class implementing IModule
//
// The PluginLoader:
//   1. Scans the plugins directory for subdirectories
//   2. Reads each manifest.json to discover modules
//   3. Validates manifest fields
//   4. Dynamically imports the entry point
//   5. Instantiates the module and validates IModule contract
//   6. Returns factories for registration with ModuleLoader
//
// Security considerations:
//   - Only loads from configured directory (no arbitrary paths)
//   - Validates manifest schema before import
//   - Validates IModule contract after instantiation
//   - Logs all discovery and load operations for auditability
// ---------------------------------------------------------------------------

import * as fs from 'node:fs';
import * as path from 'node:path';
import { IModule, ILogger, ModuleType, ModuleFactory } from '../types/module';
import { ModuleError } from '../../shared/errors';

// ── Plugin Manifest ────────────────────────────────────────────────────────

/** On-disk manifest for a plugin (manifest.json). */
export interface PluginManifest {
  /** Module ID — must match the IModule.manifest.id at runtime. */
  id: string;

  /** Human-readable name. */
  name: string;

  /** Semver version. */
  version: string;

  /** Module type (connector, detector, enricher, notifier, action, openclaw, ui). */
  type: string;

  /** Optional description. */
  description?: string;

  /** Entry point file relative to the plugin directory (default: index.js). */
  entry?: string;

  /** Module IDs this plugin depends on. */
  dependencies?: string[];
}

/** Result of scanning a single plugin directory. */
export interface PluginDescriptor {
  /** Parsed manifest. */
  manifest: PluginManifest;

  /** Absolute path to the plugin directory. */
  directory: string;

  /** Absolute path to the resolved entry point. */
  entryPath: string;
}

/** Result of a full discovery scan. */
export interface PluginDiscoveryResult {
  /** Successfully discovered plugins. */
  plugins: PluginDescriptor[];

  /** Directories that failed to load (with reasons). */
  errors: Array<{ directory: string; reason: string }>;
}

/** Result of loading a single plugin. */
export interface PluginLoadResult {
  /** The plugin descriptor. */
  descriptor: PluginDescriptor;

  /** The module factory (if successful). */
  factory?: ModuleFactory;

  /** Error message (if failed). */
  error?: string;
}

// ── Valid Module Types ─────────────────────────────────────────────────────

const VALID_MODULE_TYPES = new Set<string>(Object.values(ModuleType));

// ── Plugin Loader ──────────────────────────────────────────────────────────

export class PluginLoader {
  private readonly logger: ILogger;
  private readonly pluginsDir: string;

  constructor(pluginsDir: string, logger: ILogger) {
    this.pluginsDir = path.resolve(pluginsDir);
    this.logger = logger.child('PluginLoader');
  }

  /** Get the resolved plugins directory path. */
  getPluginsDir(): string {
    return this.pluginsDir;
  }

  // ── Discovery ──────────────────────────────────────────────────────────

  /**
   * Scan the plugins directory and discover all valid plugin manifests.
   * Does NOT load/import any code — only reads manifest.json files.
   */
  discover(): PluginDiscoveryResult {
    const result: PluginDiscoveryResult = { plugins: [], errors: [] };

    if (!fs.existsSync(this.pluginsDir)) {
      this.logger.info('Plugins directory does not exist, skipping discovery', {
        pluginsDir: this.pluginsDir,
      });
      return result;
    }

    const stat = fs.statSync(this.pluginsDir);
    if (!stat.isDirectory()) {
      this.logger.warn('Plugins path is not a directory', {
        pluginsDir: this.pluginsDir,
      });
      return result;
    }

    const entries = fs.readdirSync(this.pluginsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pluginDir = path.join(this.pluginsDir, entry.name);
      try {
        const descriptor = this.readPlugin(pluginDir);
        result.plugins.push(descriptor);
        this.logger.info('Plugin discovered', {
          id: descriptor.manifest.id,
          name: descriptor.manifest.name,
          version: descriptor.manifest.version,
          directory: pluginDir,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        result.errors.push({ directory: pluginDir, reason });
        this.logger.warn('Failed to read plugin', {
          directory: pluginDir,
          reason,
        });
      }
    }

    this.logger.info('Plugin discovery complete', {
      found: result.plugins.length,
      errors: result.errors.length,
    });

    return result;
  }

  // ── Loading ────────────────────────────────────────────────────────────

  /**
   * Load a discovered plugin: dynamically import its entry point
   * and create a ModuleFactory that produces IModule instances.
   */
  async loadPlugin(descriptor: PluginDescriptor): Promise<PluginLoadResult> {
    try {
      // Import the module entry point
      const imported = await this.importEntry(descriptor.entryPath);
      
      // Resolve the module class/constructor
      const ModuleClass = this.resolveModuleExport(imported, descriptor);

      // Create a factory and validate the contract
      const factory: ModuleFactory = () => {
        const instance = new ModuleClass();
        this.validateModuleContract(instance, descriptor);
        return instance;
      };

      // Test the factory once to catch errors early
      const testInstance = factory();
      this.logger.info('Plugin loaded successfully', {
        id: descriptor.manifest.id,
        manifestId: testInstance.manifest.id,
      });

      return { descriptor, factory };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error(
        'Failed to load plugin',
        err instanceof Error ? err : new Error(error),
        { id: descriptor.manifest.id, directory: descriptor.directory },
      );
      return { descriptor, error };
    }
  }

  /**
   * Discover and load all plugins in the plugins directory.
   * Returns factories for all successfully loaded plugins.
   */
  async loadAll(): Promise<{
    factories: Array<{ id: string; factory: ModuleFactory }>;
    errors: Array<{ id: string; error: string }>;
  }> {
    const discovery = this.discover();
    const factories: Array<{ id: string; factory: ModuleFactory }> = [];
    const errors: Array<{ id: string; error: string }> = [];

    // Include discovery errors
    for (const err of discovery.errors) {
      errors.push({ id: path.basename(err.directory), error: err.reason });
    }

    // Load each discovered plugin
    for (const descriptor of discovery.plugins) {
      const result = await this.loadPlugin(descriptor);
      if (result.factory) {
        factories.push({ id: descriptor.manifest.id, factory: result.factory });
      } else {
        errors.push({
          id: descriptor.manifest.id,
          error: result.error ?? 'Unknown error',
        });
      }
    }

    this.logger.info('Plugin loading complete', {
      loaded: factories.length,
      errors: errors.length,
    });

    return { factories, errors };
  }

  // ── Internal ───────────────────────────────────────────────────────────

  /**
   * Read and validate a manifest.json from a plugin directory.
   */
  private readPlugin(pluginDir: string): PluginDescriptor {
    const manifestPath = path.join(pluginDir, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
      throw new Error(
        `No manifest.json found in ${pluginDir}`,
      );
    }

    let raw: string;
    try {
      raw = fs.readFileSync(manifestPath, 'utf-8');
    } catch (err) {
      throw new Error(
        `Failed to read manifest.json: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let manifest: PluginManifest;
    try {
      manifest = JSON.parse(raw) as PluginManifest;
    } catch {
      throw new Error('Invalid JSON in manifest.json');
    }

    // Validate required fields
    this.validateManifest(manifest, pluginDir);

    // Resolve entry point
    const entryFile = manifest.entry ?? 'index.js';
    const entryPath = path.resolve(pluginDir, entryFile);

    if (!fs.existsSync(entryPath)) {
      throw new Error(
        `Entry point "${entryFile}" not found at ${entryPath}`,
      );
    }

    return { manifest, directory: pluginDir, entryPath };
  }

  /**
   * Validate required manifest fields.
   */
  private validateManifest(manifest: PluginManifest, pluginDir: string): void {
    if (!manifest.id || typeof manifest.id !== 'string') {
      throw new Error('Manifest missing required field "id"');
    }

    if (!manifest.name || typeof manifest.name !== 'string') {
      throw new Error('Manifest missing required field "name"');
    }

    if (!manifest.version || typeof manifest.version !== 'string') {
      throw new Error('Manifest missing required field "version"');
    }

    if (!manifest.type || typeof manifest.type !== 'string') {
      throw new Error('Manifest missing required field "type"');
    }

    if (!VALID_MODULE_TYPES.has(manifest.type)) {
      throw new Error(
        `Invalid module type "${manifest.type}". Valid types: ${[...VALID_MODULE_TYPES].join(', ')}`,
      );
    }
  }

  /**
   * Import the plugin entry point.
   * Supports both CommonJS (require) and ES Module (import) patterns.
   */
  private async importEntry(entryPath: string): Promise<unknown> {
    try {
      // Use require for CommonJS modules (our project uses commonjs)
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require(entryPath);
    } catch (requireErr) {
      // Fall back to dynamic import for ES modules
      try {
        const fileUrl = `file://${entryPath.replace(/\\/g, '/')}`;
        return await import(fileUrl);
      } catch (importErr) {
        throw new Error(
          `Failed to import entry point: require error: ${
            requireErr instanceof Error ? requireErr.message : String(requireErr)
          }; import error: ${
            importErr instanceof Error ? importErr.message : String(importErr)
          }`,
        );
      }
    }
  }

  /**
   * Resolve the module class from the imported entry point.
   * Supports: default export, named export (Module), or direct class export.
   */
  private resolveModuleExport(
    imported: unknown,
    descriptor: PluginDescriptor,
  ): new () => IModule {
    const mod = imported as Record<string, unknown>;

    // Try: default export
    if (mod.default && typeof mod.default === 'function') {
      return mod.default as new () => IModule;
    }

    // Try: named export matching the manifest ID's PascalCase form
    // e.g., "connector.myPlugin" → "ConnectorMyPlugin" or just "Module"
    if (mod.Module && typeof mod.Module === 'function') {
      return mod.Module as new () => IModule;
    }

    // Try: iterate exports and find a constructor with a manifest property
    for (const key of Object.keys(mod)) {
      const val = mod[key];
      if (typeof val === 'function' && val.prototype?.manifest) {
        return val as new () => IModule;
      }
    }

    // Try: iterate exports and find any constructor function
    for (const key of Object.keys(mod)) {
      const val = mod[key];
      if (typeof val === 'function' && key !== '__esModule') {
        return val as new () => IModule;
      }
    }

    throw new Error(
      `No module class export found in ${descriptor.entryPath}. ` +
      `Expected a default export or named export "Module" that implements IModule.`,
    );
  }

  /**
   * Validate that an instantiated module satisfies the IModule contract.
   */
  private validateModuleContract(
    instance: IModule,
    descriptor: PluginDescriptor,
  ): void {
    if (!instance.manifest) {
      throw new ModuleError(
        `Plugin "${descriptor.manifest.id}" module instance has no manifest`,
        descriptor.manifest.id,
      );
    }

    if (instance.manifest.id !== descriptor.manifest.id) {
      throw new ModuleError(
        `Plugin manifest ID mismatch: manifest.json says "${descriptor.manifest.id}" ` +
        `but module says "${instance.manifest.id}"`,
        descriptor.manifest.id,
      );
    }

    // Check required lifecycle methods
    const requiredMethods = ['initialize', 'start', 'stop', 'destroy', 'health'] as const;
    for (const method of requiredMethods) {
      if (typeof instance[method] !== 'function') {
        throw new ModuleError(
          `Plugin "${descriptor.manifest.id}" is missing required method "${method}"`,
          descriptor.manifest.id,
        );
      }
    }
  }
}
