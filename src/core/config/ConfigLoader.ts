// ---------------------------------------------------------------------------
// OpsPilot — Configuration Loader
// ---------------------------------------------------------------------------
// Loads YAML config from disk, applies environment variable overrides,
// and returns a typed OpsPilotConfig.
// ---------------------------------------------------------------------------

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { OpsPilotConfig } from '../types/config';
import { ConfigError } from '../../shared/errors';

/** Default config values applied when keys are absent. */
const DEFAULTS: OpsPilotConfig = {
  system: {
    name: 'OpsPilot',
    environment: 'development',
  },
  modules: {},
  storage: {
    engine: 'memory',
  },
  logging: {
    level: 'info',
    format: 'text',
    output: 'console',
  },
};

export class ConfigLoader {
  /**
   * Load configuration from a YAML file.
   *
   * @param configPath  Absolute or relative path to the YAML file.
   * @returns Merged configuration (defaults ← file ← env overrides).
   * @throws ConfigError if the file cannot be read or parsed.
   */
  load(configPath: string): OpsPilotConfig {
    const resolvedPath = path.resolve(configPath);

    if (!fs.existsSync(resolvedPath)) {
      // No config file is a valid scenario — use defaults
      return this.applyEnvOverrides(structuredClone(DEFAULTS));
    }

    let raw: string;
    try {
      raw = fs.readFileSync(resolvedPath, 'utf-8');
    } catch (err) {
      throw new ConfigError(
        `Failed to read config file: ${resolvedPath}`,
        err instanceof Error ? err : undefined,
      );
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = parseYaml(raw) as Record<string, unknown>;
    } catch (err) {
      throw new ConfigError(
        `Failed to parse YAML in config file: ${resolvedPath}`,
        err instanceof Error ? err : undefined,
      );
    }

    if (parsed === null || typeof parsed !== 'object') {
      throw new ConfigError(`Config file is empty or not an object: ${resolvedPath}`);
    }

    const merged = this.deepMerge(
      structuredClone(DEFAULTS) as unknown as Record<string, unknown>,
      parsed,
    ) as unknown as OpsPilotConfig;
    return this.applyEnvOverrides(merged);
  }

  // ── Internal ───────────────────────────────────────────────────────────

  /**
   * Environment variable overrides follow the convention:
   *   OPSPILOT_SYSTEM_ENVIRONMENT=production
   *   OPSPILOT_LOGGING_LEVEL=debug
   */
  private applyEnvOverrides(config: OpsPilotConfig): OpsPilotConfig {
    const env = process.env;

    if (env.OPSPILOT_SYSTEM_NAME) {
      config.system.name = env.OPSPILOT_SYSTEM_NAME;
    }
    if (env.OPSPILOT_SYSTEM_ENVIRONMENT) {
      config.system.environment = env.OPSPILOT_SYSTEM_ENVIRONMENT as OpsPilotConfig['system']['environment'];
    }
    if (env.OPSPILOT_SYSTEM_PORT) {
      config.system.port = parseInt(env.OPSPILOT_SYSTEM_PORT, 10);
    }
    if (env.OPSPILOT_LOGGING_LEVEL) {
      config.logging = config.logging ?? DEFAULTS.logging!;
      config.logging.level = env.OPSPILOT_LOGGING_LEVEL as OpsPilotConfig['logging'] extends undefined ? never : NonNullable<OpsPilotConfig['logging']>['level'];
    }

    return config;
  }

  /**
   * Recursively merge `source` into `target`, with `source` winning.
   * Arrays are replaced, not concatenated.
   */
  private deepMerge(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
  ): Record<string, unknown> {
    for (const key of Object.keys(source)) {
      const srcVal = source[key];
      const tgtVal = target[key];

      if (
        srcVal !== null &&
        typeof srcVal === 'object' &&
        !Array.isArray(srcVal) &&
        tgtVal !== null &&
        typeof tgtVal === 'object' &&
        !Array.isArray(tgtVal)
      ) {
        target[key] = this.deepMerge(
          tgtVal as Record<string, unknown>,
          srcVal as Record<string, unknown>,
        );
      } else {
        target[key] = srcVal;
      }
    }
    return target;
  }
}
