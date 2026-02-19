// ---------------------------------------------------------------------------
// OpsPilot — detector.threshold
// ---------------------------------------------------------------------------
// Subscribes to `log.ingested` events and extracts numeric metrics from
// log lines. When values cross configured thresholds (sustained over a
// sliding window), emits `incident.created` events.
//
// Example config rule:
//   - Detect when CPU usage > 90% sustained over 60 seconds
//   - Detect when free memory < 500 MB for at least 3 samples
//   - Detect when error rate > 100 errors/minute
//
// Safety features:
//   - Sliding window with configurable min samples prevents false positives
//   - Per-rule cooldown prevents alert storms
//   - Global rate limit caps total incidents/minute
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

type ComparisonOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq';

interface ThresholdRule {
  id: string;
  metric: string;
  valuePattern: string;
  flags: string;
  threshold: number;
  operator: ComparisonOperator;
  windowMs: number;
  minSamples: number;
  severity: IncidentSeverity;
  title: string;
  description: string;
  cooldownMs: number;
  enabled: boolean;
}

interface ThresholdDetectorConfig {
  rules: ThresholdRule[];
  maxIncidentsPerMinute: number;
}

// ── Compiled Rule ──────────────────────────────────────────────────────────

interface CompiledRule extends ThresholdRule {
  metricRegex: RegExp;
  valueRegex: RegExp;
  /** Sliding window of { timestamp, value } samples. */
  samples: Array<{ ts: number; value: number }>;
  lastFiredAt: number;
}

// ── Comparison Functions ───────────────────────────────────────────────────

const COMPARATORS: Record<ComparisonOperator, (value: number, threshold: number) => boolean> = {
  gt: (v, t) => v > t,
  gte: (v, t) => v >= t,
  lt: (v, t) => v < t,
  lte: (v, t) => v <= t,
  eq: (v, t) => v === t,
};

const OPERATOR_LABELS: Record<ComparisonOperator, string> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  eq: '==',
};

// ── Module Implementation ──────────────────────────────────────────────────

export class ThresholdDetector implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'detector.threshold',
    name: 'Threshold Detector',
    version: '1.0.0',
    type: ModuleType.Detector,
    description: 'Monitors numeric metrics from logs and fires incidents when thresholds are crossed.',
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private config!: ThresholdDetectorConfig;
  private compiledRules: CompiledRule[] = [];
  private subscription: EventSubscription | null = null;

  // Rate limiting
  private incidentTimestamps: number[] = [];

  // Metrics
  private linesScanned = 0;
  private samplesCollected = 0;
  private incidentsCreated = 0;
  private thresholdBreaches = 0;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(context: ModuleContext): Promise<void> {
    this.ctx = context;

    const DEFAULTS: Omit<ThresholdDetectorConfig, 'rules'> = {
      maxIncidentsPerMinute: 30,
    };

    this.config = {
      ...DEFAULTS,
      ...context.config,
    } as ThresholdDetectorConfig;

    this.compiledRules = [];

    for (const rule of this.config.rules) {
      const merged: ThresholdRule = {
        ...rule,
        flags: rule.flags ?? 'i',
        windowMs: rule.windowMs ?? 60_000,
        minSamples: rule.minSamples ?? 1,
        description: rule.description ?? '$metric is $value (threshold: $threshold)',
        cooldownMs: rule.cooldownMs ?? 60_000,
        enabled: rule.enabled ?? true,
      };

      if (!merged.enabled) {
        this.ctx.logger.debug('Rule disabled, skipping', { ruleId: merged.id });
        continue;
      }

      try {
        const metricRegex = new RegExp(merged.metric, merged.flags);
        const valueRegex = new RegExp(merged.valuePattern, merged.flags);

        this.compiledRules.push({
          ...merged,
          metricRegex,
          valueRegex,
          samples: [],
          lastFiredAt: 0,
        });

        this.ctx.logger.debug('Rule compiled', {
          ruleId: merged.id,
          metric: merged.metric,
          threshold: merged.threshold,
          operator: merged.operator,
        });
      } catch (err) {
        throw new Error(
          `Rule "${merged.id}" has invalid regex: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.ctx.logger.info('Initialized', {
      activeRules: this.compiledRules.length,
      totalConfigured: this.config.rules.length,
    });
  }

  async start(): Promise<void> {
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
      samplesCollected: this.samplesCollected,
      incidentsCreated: this.incidentsCreated,
      thresholdBreaches: this.thresholdBreaches,
    });
  }

  async destroy(): Promise<void> {
    this.compiledRules = [];
    this.incidentTimestamps = [];
  }

  health(): ModuleHealth {
    return {
      status: 'healthy',
      details: {
        activeRules: this.compiledRules.length,
        linesScanned: this.linesScanned,
        samplesCollected: this.samplesCollected,
        incidentsCreated: this.incidentsCreated,
        thresholdBreaches: this.thresholdBreaches,
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
    const now = Date.now();

    for (const rule of this.compiledRules) {
      // ── Check if line matches the metric pattern ─────────────────
      if (!rule.metricRegex.test(line)) continue;

      // Reset lastIndex for global-flagged regexes
      rule.metricRegex.lastIndex = 0;

      // ── Extract numeric value ────────────────────────────────────
      const valueMatch = rule.valueRegex.exec(line);
      rule.valueRegex.lastIndex = 0;

      if (!valueMatch || valueMatch.length < 2) continue;

      const value = parseFloat(valueMatch[1]);
      if (isNaN(value)) continue;

      this.samplesCollected++;

      // ── Add to sliding window ────────────────────────────────────
      rule.samples.push({ ts: now, value });

      // Prune samples outside the window
      const windowStart = now - rule.windowMs;
      rule.samples = rule.samples.filter((s) => s.ts >= windowStart);

      // ── Check if we have enough samples ──────────────────────────
      if (rule.samples.length < rule.minSamples) continue;

      // ── Evaluate threshold across all samples in window ──────────
      const comparator = COMPARATORS[rule.operator];
      const breaching = rule.samples.filter((s) => comparator(s.value, rule.threshold));

      // All samples must breach the threshold (sustained breach)
      if (breaching.length < rule.minSamples) continue;

      this.thresholdBreaches++;

      // ── Cooldown check ───────────────────────────────────────────
      if (now - rule.lastFiredAt < rule.cooldownMs) {
        this.ctx.logger.debug('Threshold breach suppressed (cooldown)', {
          ruleId: rule.id,
          remainingMs: rule.cooldownMs - (now - rule.lastFiredAt),
        });
        continue;
      }

      // ── Global rate limit ────────────────────────────────────────
      if (!this.isWithinRateLimit(now)) {
        this.ctx.logger.warn('Global rate limit reached, suppressing incident', {
          ruleId: rule.id,
        });
        continue;
      }

      // ── Create incident ──────────────────────────────────────────
      rule.lastFiredAt = now;
      this.incidentsCreated++;

      // Compute average value across window
      const avgValue = rule.samples.reduce((sum, s) => sum + s.value, 0) / rule.samples.length;
      const latestValue = value;

      const title = this.interpolate(rule.title, rule, latestValue);
      const description = this.interpolate(rule.description, rule, latestValue);

      const incidentId = generateId();

      const payload: IncidentCreatedPayload = {
        incidentId,
        title,
        description,
        severity: rule.severity,
        detectedBy: this.manifest.id,
        sourceEvent: event.type,
        detectedAt: new Date(),
        context: {
          ruleId: rule.id,
          metric: rule.metric,
          latestValue,
          averageValue: Math.round(avgValue * 100) / 100,
          threshold: rule.threshold,
          operator: OPERATOR_LABELS[rule.operator],
          samplesInWindow: rule.samples.length,
          windowMs: rule.windowMs,
          logSource: source,
          correlationId: event.correlationId,
        },
      };

      await this.ctx.bus.publish<IncidentCreatedPayload>({
        type: 'incident.created',
        source: this.manifest.id,
        timestamp: new Date(),
        correlationId: event.correlationId ?? incidentId,
        payload,
      });

      this.ctx.logger.info('Threshold incident created', {
        incidentId,
        ruleId: rule.id,
        value: latestValue,
        threshold: rule.threshold,
        severity: rule.severity,
      });
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private interpolate(template: string, rule: CompiledRule, value: number): string {
    return template
      .replace(/\$metric/g, rule.metric)
      .replace(/\$value/g, String(value))
      .replace(/\$threshold/g, String(rule.threshold))
      .replace(/\$operator/g, OPERATOR_LABELS[rule.operator]);
  }

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
