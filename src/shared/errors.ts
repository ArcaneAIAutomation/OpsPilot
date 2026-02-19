// ---------------------------------------------------------------------------
// OpsPilot — Shared Error Types
// ---------------------------------------------------------------------------
// Typed errors make it possible to distinguish between operational failures
// and programming mistakes. Every core subsystem throws one of these.
// ---------------------------------------------------------------------------

/**
 * Base class for all OpsPilot errors.
 * Preserves the original error chain via `cause`.
 */
export class OpsPilotError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'OpsPilotError';
  }
}

/** Thrown when configuration is invalid or missing. */
export class ConfigError extends OpsPilotError {
  constructor(message: string, cause?: Error) {
    super(message, 'CONFIG_ERROR', cause);
    this.name = 'ConfigError';
  }
}

/** Thrown when a module fails to load, initialize, or transition state. */
export class ModuleError extends OpsPilotError {
  constructor(
    message: string,
    public readonly moduleId: string,
    cause?: Error,
  ) {
    super(message, 'MODULE_ERROR', cause);
    this.name = 'ModuleError';
  }
}

/** Thrown when dependency resolution fails (missing deps, cycles). */
export class DependencyError extends OpsPilotError {
  constructor(message: string, cause?: Error) {
    super(message, 'DEPENDENCY_ERROR', cause);
    this.name = 'DependencyError';
  }
}

/** Thrown when an approval/security check fails. */
export class SecurityError extends OpsPilotError {
  constructor(message: string, cause?: Error) {
    super(message, 'SECURITY_ERROR', cause);
    this.name = 'SecurityError';
  }
}

/** Thrown when a storage operation fails. */
export class StorageError extends OpsPilotError {
  constructor(message: string, cause?: Error) {
    super(message, 'STORAGE_ERROR', cause);
    this.name = 'StorageError';
  }
}
