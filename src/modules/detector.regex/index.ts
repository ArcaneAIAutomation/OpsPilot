// ---------------------------------------------------------------------------
// OpsPilot — detector.regex
// ---------------------------------------------------------------------------
// Subscribes to `log.ingested` events and matches each log line against
// a configurable set of regex rules. When a match is found, emits an
// `incident.created` event.
//
// Safety features:
//   - Per-rule cooldown prevents alert storms
//   - Global rate limit caps total incidents/minute
//   - Regex patterns are compiled once at init, not per-line
//   - Invalid patterns fail at initialization, not at runtime
// ---------------------------------------------------------------------------

import {
  IModule,
  ModuleManifest,
  ModuleType,
  ModuleContext,
  ModuleHealth,
} from '../../core/types/module';
import { OpsPilotEvent, EventSubscription } from '../../core/types/events';
import {
  LogIngestedPayload,
  IncidentCreatedPayload,
  IncidentSeverity,
} from '../../shared/events';
import { generateId } from '../../shared/utils';
import configSchema from './schema.json';

// ── Config Types ───────────────────────────────────────────────────────────

interface DetectionRule {
  id: string;
  pattern: string;
  flags: string;
  severity: IncidentSeverity;
  title: string;
  description: string;
  cooldownMs: number;
  enabled: boolean;
}

interface RegexDetectorConfig {
  rules: DetectionRule[];
  maxIncidentsPerMinute: number;
}

// ── Compiled Rule ──────────────────────────────────────────────────────────

interface CompiledRule extends DetectionRule {
  regex: RegExp;
  lastFiredAt: number; // epoch ms
}

// ── Module Implementation ──────────────────────────────────────────────────

export class RegexDetector implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'detector.regex',
    name: 'Regex Incident Detector',
    version: '0.1.0',
    type: ModuleType.Detector,
    description: 'Applies regex rules to log lines and creates incidents on match.',
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private config!: RegexDetectorConfig;
  private compiledRules: CompiledRule[] = [];
  private subscription: EventSubscription | null = null;

  // Rate limiting
  private incidentTimestamps: number[] = [];

  // Metrics
  private linesScanned = 0;
  private incidentsCreated = 0;
  private rulesMatched = 0;
  private healthy = true;
  private lastError: string | undefined;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(context: ModuleContext): Promise<void> {
    this.ctx = context;

    const DEFAULTS: Omit<RegexDetectorConfig, 'rules'> = {
      maxIncidentsPerMinute: 30,
    };

    this.config = {
      ...DEFAULTS,
      ...context.config,
    } as RegexDetectorConfig;

    // Compile all regex patterns once
    this.compiledRules = [];

    for (const rule of this.config.rules) {
      const merged: DetectionRule = {
        ...rule,
        flags: rule.flags ?? 'i',
        description: rule.description ?? 'Pattern matched: $0',
        cooldownMs: rule.cooldownMs ?? 60000,
        enabled: rule.enabled ?? true,
      };

      if (!merged.enabled) {
        this.ctx.logger.debug('Rule disabled, skipping', { ruleId: merged.id });
        continue;
      }

      try {
        const regex = new RegExp(merged.pattern, merged.flags);
        this.compiledRules.push({
          ...merged,
          regex,
          lastFiredAt: 0,
        });
        this.ctx.logger.debug('Rule compiled', { ruleId: merged.id, pattern: merged.pattern });
      } catch (err) {
        // Invalid regex — fail at init, not at runtime
        throw new Error(
          `Rule "${merged.id}" has invalid regex pattern "${merged.pattern}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.ctx.logger.info('Initialized', {
      activeRules: this.compiledRules.length,
      totalConfigured: this.config.rules.length,
      maxIncidentsPerMinute: this.config.maxIncidentsPerMinute,
    });
  }

  async start(): Promise<void> {
    // Subscribe to log.ingested events from any connector
    this.subscription = this.ctx.bus.subscribe<LogIngestedPayload>(
      'log.ingested',
      (event) => this.onLogIngested(event),
    );

    this.ctx.logger.info('Started — listening for log.ingested events');
  }

  async stop(): Promise<void> {
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }

    this.ctx.logger.info('Stopped', {
      linesScanned: this.linesScanned,
      incidentsCreated: this.incidentsCreated,
      rulesMatched: this.rulesMatched,
    });
  }

  async destroy(): Promise<void> {
    this.compiledRules = [];
    this.incidentTimestamps = [];
    this.ctx = undefined!;
    this.config = undefined!;
  }

  health(): ModuleHealth {
    return {
      status: this.healthy ? 'healthy' : 'degraded',
      message: this.lastError,
      details: {
        activeRules: this.compiledRules.length,
        linesScanned: this.linesScanned,
        incidentsCreated: this.incidentsCreated,
        rulesMatched: this.rulesMatched,
      },
      lastCheck: new Date(),
    };
  }

  // ── Event Handler ────────────────────────────────────────────────────────

  private async onLogIngested(
    event: OpsPilotEvent<LogIngestedPayload>,
  ): Promise<void> {
    this.linesScanned++;
    const { line, source } = event.payload;

    for (const rule of this.compiledRules) {
      const match = rule.regex.exec(line);
      if (!match) continue;

      this.rulesMatched++;

      // ── Cooldown check ─────────────────────────────────────────────
      const now = Date.now();
      if (now - rule.lastFiredAt < rule.cooldownMs) {
        this.ctx.logger.debug('Rule match suppressed (cooldown)', {
          ruleId: rule.id,
          remainingMs: rule.cooldownMs - (now - rule.lastFiredAt),
        });
        continue;
      }

      // ── Global rate limit ──────────────────────────────────────────
      if (!this.isWithinRateLimit(now)) {
        this.ctx.logger.warn('Global rate limit reached, suppressing incident', {
          ruleId: rule.id,
          maxPerMinute: this.config.maxIncidentsPerMinute,
        });
        continue;
      }

      // ── Build incident ─────────────────────────────────────────────
      rule.lastFiredAt = now;
      this.incidentsCreated++;

      const description = this.interpolateDescription(rule.description, match);
      const incidentId = generateId();

      const payload: IncidentCreatedPayload = {
        incidentId,
        title: rule.title,
        description,
        severity: rule.severity,
        detectedBy: this.manifest.id,
        sourceEvent: event.type,
        detectedAt: new Date(),
        context: {
          ruleId: rule.id,
          pattern: rule.pattern,
          matchedLine: line,
          matchedGroups: match.slice(1),
          logSource: source,
          logLineNumber: event.payload.lineNumber,
          correlationId: event.correlationId,
        },
      };

      const incidentEvent: OpsPilotEvent<IncidentCreatedPayload> = {
        type: 'incident.created',
        source: this.manifest.id,
        timestamp: new Date(),
        correlationId: event.correlationId ?? incidentId,
        payload,
      };

      await this.ctx.bus.publish(incidentEvent);

      this.ctx.logger.info('Incident created', {
        incidentId,
        ruleId: rule.id,
        severity: rule.severity,
        title: rule.title,
      });
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Interpolate `$0` through `$9` in the description template with
   * regex match groups.
   */
  private interpolateDescription(template: string, match: RegExpExecArray): string {
    let result = template;
    for (let i = 0; i <= 9; i++) {
      const value = match[i] ?? '';
      result = result.replaceAll(`$${i}`, value);
    }
    return result;
  }

  /**
   * Sliding-window rate limiter.
   * Prunes timestamps older than 60 seconds, then checks count.
   */
  private isWithinRateLimit(now: number): boolean {
    const oneMinuteAgo = now - 60_000;
    this.incidentTimestamps = this.incidentTimestamps.filter((t) => t > oneMinuteAgo);

    if (this.incidentTimestamps.length >= this.config.maxIncidentsPerMinute) {
      return false;
    }

    this.incidentTimestamps.push(now);
    return true;
  }
}
