// ---------------------------------------------------------------------------
// OpsPilot — detector.anomaly (Statistical Anomaly Detector)
// ---------------------------------------------------------------------------
// Subscribes to `log.ingested` events, extracts numeric metrics using
// configurable regex patterns, and maintains a rolling statistical
// baseline. When new values deviate significantly from the baseline,
// emits `incident.created` events.
//
// Supported detection methods:
//   - Z-Score: classical Gaussian deviation (mean ± k·σ)
//   - MAD:    Median Absolute Deviation (robust to outliers)
//   - IQR:    Interquartile Range (Q1 − k·IQR, Q3 + k·IQR)
//   - EWMA:   Exponentially Weighted Moving Average with control limits
//
// Safety features:
//   - Configurable minimum training samples before detection activates
//   - Per-metric cooldown prevents alert storms
//   - Global rate limit caps total incidents/minute
//   - Direction-aware detection (high-only, low-only, or both)
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

type AnomalyMethod = 'zscore' | 'mad' | 'iqr' | 'ewma';
type AnomalyDirection = 'both' | 'high' | 'low';

interface MetricConfig {
  id: string;
  name: string;
  pattern: string;
  valuePattern: string;
  flags: string;
  method: AnomalyMethod;
  sensitivity: number;
  direction: AnomalyDirection;
  trainingWindowSize: number;
  minTrainingSamples: number;
  ewmaAlpha: number;
  severity: IncidentSeverity;
  cooldownMs: number;
  enabled: boolean;
}

interface AnomalyDetectorConfig {
  metrics: MetricConfig[];
  maxIncidentsPerMinute: number;
}

// ── Compiled Metric Monitor ────────────────────────────────────────────────

interface CompiledMetric extends MetricConfig {
  metricRegex: RegExp;
  valueRegex: RegExp;
  /** Rolling data window (bounded by trainingWindowSize). */
  window: number[];
  /** EWMA state. */
  ewmaValue: number | null;
  ewmaVariance: number | null;
  /** Cooldown tracking. */
  lastFiredAt: number;
}

// ── Anomaly Result ─────────────────────────────────────────────────────────

export interface AnomalyResult {
  isAnomaly: boolean;
  value: number;
  /** The expected baseline value (mean, median, or EWMA). */
  expected: number;
  /** How many standard deviations / MADs / IQRs away. */
  deviationScore: number;
  /** Upper boundary of the normal range. */
  upperBound: number;
  /** Lower boundary of the normal range. */
  lowerBound: number;
  method: AnomalyMethod;
}

// ── Statistical Helpers ────────────────────────────────────────────────────

function mean(data: number[]): number {
  let sum = 0;
  for (const v of data) sum += v;
  return sum / data.length;
}

function stddev(data: number[], avg: number): number {
  let sumSq = 0;
  for (const v of data) sumSq += (v - avg) ** 2;
  return Math.sqrt(sumSq / data.length);
}

function median(data: number[]): number {
  const sorted = [...data].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function medianAbsoluteDeviation(data: number[], med: number): number {
  const deviations = data.map((v) => Math.abs(v - med));
  return median(deviations);
}

function quartiles(data: number[]): { q1: number; q3: number } {
  const sorted = [...data].sort((a, b) => a - b);
  const n = sorted.length;
  const q1Idx = Math.floor(n * 0.25);
  const q3Idx = Math.floor(n * 0.75);
  return { q1: sorted[q1Idx], q3: sorted[q3Idx] };
}

// ── Module Implementation ──────────────────────────────────────────────────

export class AnomalyDetector implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'detector.anomaly',
    name: 'Anomaly Detector',
    version: '1.0.0',
    type: ModuleType.Detector,
    description: 'Detects statistical anomalies in numeric metrics from log events.',
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private config!: AnomalyDetectorConfig;
  private compiledMetrics: CompiledMetric[] = [];
  private subscription: EventSubscription | null = null;

  // Rate limiting
  private incidentTimestamps: number[] = [];

  // Metrics
  private linesScanned = 0;
  private samplesCollected = 0;
  private anomaliesDetected = 0;
  private incidentsCreated = 0;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(context: ModuleContext): Promise<void> {
    this.ctx = context;

    const raw = context.config as Partial<AnomalyDetectorConfig>;
    this.config = {
      metrics: raw.metrics ?? [],
      maxIncidentsPerMinute: raw.maxIncidentsPerMinute ?? 10,
    };

    this.compiledMetrics = [];

    for (const metric of this.config.metrics) {
      const merged: MetricConfig = {
        ...metric,
        flags: metric.flags ?? 'i',
        method: metric.method ?? 'zscore',
        sensitivity: metric.sensitivity ?? 3.0,
        direction: metric.direction ?? 'both',
        trainingWindowSize: metric.trainingWindowSize ?? 100,
        minTrainingSamples: metric.minTrainingSamples ?? 20,
        ewmaAlpha: metric.ewmaAlpha ?? 0.3,
        severity: metric.severity ?? 'warning',
        cooldownMs: metric.cooldownMs ?? 300_000,
        enabled: metric.enabled ?? true,
      };

      if (!merged.enabled) {
        this.ctx.logger.debug('Metric disabled, skipping', { metricId: merged.id });
        continue;
      }

      try {
        const metricRegex = new RegExp(merged.pattern, merged.flags);
        const valueRegex = new RegExp(merged.valuePattern, merged.flags);

        this.compiledMetrics.push({
          ...merged,
          metricRegex,
          valueRegex,
          window: [],
          ewmaValue: null,
          ewmaVariance: null,
          lastFiredAt: 0,
        });

        this.ctx.logger.debug('Metric compiled', {
          metricId: merged.id,
          method: merged.method,
          sensitivity: merged.sensitivity,
        });
      } catch (err) {
        throw new Error(
          `Metric "${merged.id}" has invalid regex: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.ctx.logger.info('Initialized', {
      activeMetrics: this.compiledMetrics.length,
      totalConfigured: this.config.metrics.length,
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
      anomaliesDetected: this.anomaliesDetected,
      incidentsCreated: this.incidentsCreated,
    });
  }

  async destroy(): Promise<void> {
    for (const m of this.compiledMetrics) {
      m.window = [];
      m.ewmaValue = null;
      m.ewmaVariance = null;
    }
  }

  health(): ModuleHealth {
    return {
      status: 'healthy',
      details: {
        activeMetrics: this.compiledMetrics.length,
        linesScanned: this.linesScanned,
        samplesCollected: this.samplesCollected,
        anomaliesDetected: this.anomaliesDetected,
        incidentsCreated: this.incidentsCreated,
        windowSizes: Object.fromEntries(
          this.compiledMetrics.map((m) => [m.id, m.window.length]),
        ),
      },
      lastCheck: new Date(),
    };
  }

  // ── Event Processing ─────────────────────────────────────────────────────

  private onLogIngested(event: OpsPilotEvent<LogIngestedPayload>): void {
    this.linesScanned++;
    const line = event.payload.line;

    for (const metric of this.compiledMetrics) {
      if (!metric.metricRegex.test(line)) continue;

      // Reset lastIndex for global/sticky flags
      metric.valueRegex.lastIndex = 0;
      const valueMatch = metric.valueRegex.exec(line);
      if (!valueMatch || valueMatch.length < 2) continue;

      const value = parseFloat(valueMatch[1]);
      if (isNaN(value)) continue;

      this.samplesCollected++;

      // Skip anomaly detection until we have enough training data
      if (metric.window.length < metric.minTrainingSamples) {
        this.addSample(metric, value);
        continue;
      }

      // Detect BEFORE adding the sample so the baseline is uncontaminated
      const result = this.detect(metric, value);
      this.addSample(metric, value);

      if (result.isAnomaly) {
        this.anomaliesDetected++;

        // Cooldown check
        const now = Date.now();
        if (now - metric.lastFiredAt < metric.cooldownMs) continue;

        // Global rate limit
        if (!this.checkRateLimit()) continue;

        metric.lastFiredAt = now;
        this.fireIncident(metric, result, event);
      }
    }
  }

  // ── Sample Management ────────────────────────────────────────────────────

  private addSample(metric: CompiledMetric, value: number): void {
    metric.window.push(value);
    if (metric.window.length > metric.trainingWindowSize) {
      metric.window.shift();
    }

    // Update EWMA state
    if (metric.method === 'ewma') {
      const alpha = metric.ewmaAlpha;
      if (metric.ewmaValue === null) {
        metric.ewmaValue = value;
        metric.ewmaVariance = 0;
      } else {
        const diff = value - metric.ewmaValue;
        metric.ewmaValue = alpha * value + (1 - alpha) * metric.ewmaValue;
        metric.ewmaVariance = (1 - alpha) * (metric.ewmaVariance! + alpha * diff * diff);
      }
    }
  }

  // ── Anomaly Detection ────────────────────────────────────────────────────

  /** Run anomaly detection for the given metric and value. Public for testing. */
  detect(metric: CompiledMetric, value: number): AnomalyResult {
    switch (metric.method) {
      case 'zscore':
        return this.detectZScore(metric, value);
      case 'mad':
        return this.detectMAD(metric, value);
      case 'iqr':
        return this.detectIQR(metric, value);
      case 'ewma':
        return this.detectEWMA(metric, value);
      default:
        return this.detectZScore(metric, value);
    }
  }

  private detectZScore(metric: CompiledMetric, value: number): AnomalyResult {
    const avg = mean(metric.window);
    const sd = stddev(metric.window, avg);

    // If standard deviation is ~0, all values are identical — only flag exact deviations
    const effectiveSD = sd < 1e-10 ? 1 : sd;
    const zScore = Math.abs(value - avg) / effectiveSD;

    const upperBound = avg + metric.sensitivity * effectiveSD;
    const lowerBound = avg - metric.sensitivity * effectiveSD;

    const isAnomaly = this.checkDirection(metric, value, upperBound, lowerBound);

    return {
      isAnomaly,
      value,
      expected: avg,
      deviationScore: zScore,
      upperBound,
      lowerBound,
      method: 'zscore',
    };
  }

  private detectMAD(metric: CompiledMetric, value: number): AnomalyResult {
    const med = median(metric.window);
    const mad = medianAbsoluteDeviation(metric.window, med);

    // MAD constant for normal distribution: 1.4826
    const effectiveMAD = mad < 1e-10 ? 1 : mad * 1.4826;
    const modifiedZScore = Math.abs(value - med) / effectiveMAD;

    const upperBound = med + metric.sensitivity * effectiveMAD;
    const lowerBound = med - metric.sensitivity * effectiveMAD;

    const isAnomaly = this.checkDirection(metric, value, upperBound, lowerBound);

    return {
      isAnomaly,
      value,
      expected: med,
      deviationScore: modifiedZScore,
      upperBound,
      lowerBound,
      method: 'mad',
    };
  }

  private detectIQR(metric: CompiledMetric, value: number): AnomalyResult {
    const { q1, q3 } = quartiles(metric.window);
    const iqr = q3 - q1;
    const effectiveIQR = iqr < 1e-10 ? 1 : iqr;

    const upperBound = q3 + metric.sensitivity * effectiveIQR;
    const lowerBound = q1 - metric.sensitivity * effectiveIQR;

    const center = (q1 + q3) / 2;
    const deviationScore = value > center
      ? (value - q3) / effectiveIQR
      : (q1 - value) / effectiveIQR;

    const isAnomaly = this.checkDirection(metric, value, upperBound, lowerBound);

    return {
      isAnomaly,
      value,
      expected: center,
      deviationScore: Math.max(0, deviationScore),
      upperBound,
      lowerBound,
      method: 'iqr',
    };
  }

  private detectEWMA(metric: CompiledMetric, value: number): AnomalyResult {
    const ewma = metric.ewmaValue ?? value;
    const ewmaVar = metric.ewmaVariance ?? 0;
    const ewmaSD = Math.sqrt(ewmaVar);

    const effectiveSD = ewmaSD < 1e-10 ? 1 : ewmaSD;
    const zScore = Math.abs(value - ewma) / effectiveSD;

    const upperBound = ewma + metric.sensitivity * effectiveSD;
    const lowerBound = ewma - metric.sensitivity * effectiveSD;

    const isAnomaly = this.checkDirection(metric, value, upperBound, lowerBound);

    return {
      isAnomaly,
      value,
      expected: ewma,
      deviationScore: zScore,
      upperBound,
      lowerBound,
      method: 'ewma',
    };
  }

  // ── Direction Check ──────────────────────────────────────────────────────

  private checkDirection(
    metric: CompiledMetric,
    value: number,
    upperBound: number,
    lowerBound: number,
  ): boolean {
    switch (metric.direction) {
      case 'high':
        return value > upperBound;
      case 'low':
        return value < lowerBound;
      case 'both':
      default:
        return value > upperBound || value < lowerBound;
    }
  }

  // ── Incident Emission ────────────────────────────────────────────────────

  private fireIncident(
    metric: CompiledMetric,
    result: AnomalyResult,
    sourceEvent: OpsPilotEvent<LogIngestedPayload>,
  ): void {
    const direction = result.value > result.upperBound ? 'above' : 'below';

    const payload: IncidentCreatedPayload = {
      incidentId: `INC-ANOM-${generateId()}`,
      title: `Anomaly: ${metric.name} is ${direction} normal range`,
      description:
        `${metric.name} = ${result.value.toFixed(2)} (expected ≈ ${result.expected.toFixed(2)}, ` +
        `range [${result.lowerBound.toFixed(2)}, ${result.upperBound.toFixed(2)}]). ` +
        `Deviation score: ${result.deviationScore.toFixed(2)} (method: ${result.method}, ` +
        `sensitivity: ${metric.sensitivity}).`,
      severity: metric.severity,
      detectedBy: 'detector.anomaly',
      sourceEvent: sourceEvent.payload.source,
      detectedAt: new Date(),
      context: {
        metricId: metric.id,
        method: result.method,
        value: result.value,
        expected: result.expected,
        deviationScore: result.deviationScore,
        upperBound: result.upperBound,
        lowerBound: result.lowerBound,
        direction,
        windowSize: metric.window.length,
        source: sourceEvent.payload.source,
      },
    };

    this.ctx.bus.publish<IncidentCreatedPayload>({
      type: 'incident.created',
      source: 'detector.anomaly',
      timestamp: new Date(),
      payload,
    });

    this.incidentsCreated++;
    this.ctx.logger.warn('Anomaly detected', {
      metricId: metric.id,
      value: result.value,
      expected: result.expected,
      deviationScore: result.deviationScore,
      method: result.method,
    });
  }

  // ── Rate Limiter ─────────────────────────────────────────────────────────

  private checkRateLimit(): boolean {
    const now = Date.now();
    this.incidentTimestamps = this.incidentTimestamps.filter((ts) => ts > now - 60_000);
    if (this.incidentTimestamps.length >= this.config.maxIncidentsPerMinute) return false;
    this.incidentTimestamps.push(now);
    return true;
  }

  // ── Test Accessors ───────────────────────────────────────────────────────

  getConfig(): AnomalyDetectorConfig {
    return this.config;
  }

  getCompiledMetrics(): CompiledMetric[] {
    return this.compiledMetrics;
  }

  getMetrics(): {
    linesScanned: number;
    samplesCollected: number;
    anomaliesDetected: number;
    incidentsCreated: number;
  } {
    return {
      linesScanned: this.linesScanned,
      samplesCollected: this.samplesCollected,
      anomaliesDetected: this.anomaliesDetected,
      incidentsCreated: this.incidentsCreated,
    };
  }

  /** Feed a value directly into a metric for testing (bypasses log parsing). */
  injectValue(metricId: string, value: number): AnomalyResult | null {
    const metric = this.compiledMetrics.find((m) => m.id === metricId);
    if (!metric) return null;

    this.samplesCollected++;

    if (metric.window.length < metric.minTrainingSamples) {
      this.addSample(metric, value);
      return { isAnomaly: false, value, expected: 0, deviationScore: 0, upperBound: 0, lowerBound: 0, method: metric.method };
    }

    const result = this.detect(metric, value);
    this.addSample(metric, value);
    return result;
  }

  /** Inject multiple values for training baseline. */
  trainMetric(metricId: string, values: number[]): void {
    for (const v of values) {
      this.injectValue(metricId, v);
    }
  }

  /** Get the current window for a metric. */
  getWindow(metricId: string): number[] {
    const metric = this.compiledMetrics.find((m) => m.id === metricId);
    return metric ? [...metric.window] : [];
  }
}
