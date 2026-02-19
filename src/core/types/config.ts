// ---------------------------------------------------------------------------
// OpsPilot — Configuration Types
// ---------------------------------------------------------------------------

/**
 * Root configuration shape loaded from YAML.
 */
export interface OpsPilotConfig {
  /** Top-level system settings. */
  system: SystemConfig;

  /** Per-module configuration keyed by module ID. */
  modules: Record<string, ModuleConfig>;

  /** Storage engine selection. */
  storage?: StorageConfig;

  /** Logging preferences. */
  logging?: LoggingConfig;
}

export interface SystemConfig {
  /** Display name for this OpsPilot instance. */
  name: string;

  /** Deployment environment — affects defaults and safety checks. */
  environment: 'development' | 'staging' | 'production';

  /** Optional HTTP port for future REST/WebSocket surface. */
  port?: number;
}

/**
 * Every module config section must at minimum contain `enabled`.
 * Additional keys are module-specific and validated via JSON Schema.
 */
export interface ModuleConfig {
  enabled: boolean;
  [key: string]: unknown;
}

export interface StorageConfig {
  /** Storage backend. Only `memory` is available in Phase 1. */
  engine: 'memory' | 'file' | 'sqlite' | 'database';

  /** Engine-specific options. */
  options?: Record<string, unknown>;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggingConfig {
  /** Minimum severity to emit. */
  level: LogLevel;

  /** Output format. */
  format: 'json' | 'text';

  /** Destination. */
  output: 'console' | 'file';

  /** File path when `output` is `'file'`. */
  file?: string;
}
