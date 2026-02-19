// ---------------------------------------------------------------------------
// OpsPilot — Configuration Validator
// ---------------------------------------------------------------------------
// Validates the root config shape and per-module config sections using
// JSON Schema (via Ajv). Invalid configuration fails gracefully — the
// system reports errors but does not crash.
// ---------------------------------------------------------------------------

import Ajv, { ValidateFunction, ErrorObject } from 'ajv';
import { OpsPilotConfig } from '../types/config';
import { ModuleManifest } from '../types/module';
import { ConfigError } from '../../shared/errors';

/** JSON Schema for the root OpsPilotConfig object. */
const ROOT_SCHEMA = {
  type: 'object',
  required: ['system'],
  properties: {
    system: {
      type: 'object',
      required: ['name', 'environment'],
      properties: {
        name: { type: 'string', minLength: 1 },
        environment: { type: 'string', enum: ['development', 'staging', 'production'] },
        port: { type: 'integer', minimum: 1, maximum: 65535 },
      },
      additionalProperties: false,
    },
    modules: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['enabled'],
        properties: {
          enabled: { type: 'boolean' },
        },
      },
    },
    storage: {
      type: 'object',
      properties: {
        engine: { type: 'string', enum: ['memory', 'file', 'database'] },
        options: { type: 'object' },
      },
      additionalProperties: false,
    },
    logging: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
        format: { type: 'string', enum: ['json', 'text'] },
        output: { type: 'string', enum: ['console', 'file'] },
        file: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export class ConfigValidator {
  private readonly ajv: Ajv;
  private readonly rootValidator: ValidateFunction;

  constructor() {
    this.ajv = new Ajv({ allErrors: true, strict: false });
    this.rootValidator = this.ajv.compile(ROOT_SCHEMA);
  }

  /**
   * Validate the root configuration shape.
   *
   * @returns A result with `valid: false` and human-readable errors if invalid.
   */
  validateRoot(config: OpsPilotConfig): ValidationResult {
    const valid = this.rootValidator(config);
    if (valid) {
      return { valid: true, errors: [] };
    }
    return {
      valid: false,
      errors: this.formatErrors(this.rootValidator.errors ?? []),
    };
  }

  /**
   * Validate a single module's config section against its declared JSON Schema.
   *
   * If the module provides no `configSchema`, validation always passes.
   *
   * @throws ConfigError only for schema compilation failures (programmer error).
   */
  validateModuleConfig(
    manifest: ModuleManifest,
    moduleConfig: Record<string, unknown>,
  ): ValidationResult {
    if (!manifest.configSchema) {
      return { valid: true, errors: [] };
    }

    let validate: ValidateFunction;
    try {
      validate = this.ajv.compile(manifest.configSchema);
    } catch (err) {
      throw new ConfigError(
        `Module "${manifest.id}" has an invalid config schema: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined,
      );
    }

    const valid = validate(moduleConfig);
    if (valid) {
      return { valid: true, errors: [] };
    }

    return {
      valid: false,
      errors: this.formatErrors(validate.errors ?? []).map(
        (e) => `[${manifest.id}] ${e}`,
      ),
    };
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private formatErrors(errors: ErrorObject[]): string[] {
    return errors.map((e) => {
      const path = e.instancePath || '/';
      return `${path}: ${e.message ?? 'unknown error'}`;
    });
  }
}
