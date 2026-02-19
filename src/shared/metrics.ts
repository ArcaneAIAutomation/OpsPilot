// ---------------------------------------------------------------------------
// OpsPilot — Prometheus Metrics Collector
// ---------------------------------------------------------------------------
// Collects metrics from module health reports and system state, then
// formats them as Prometheus text exposition format for scraping.
//
// Metric naming follows Prometheus conventions:
//   opspilot_<module>_<metric_name> <value>
// ---------------------------------------------------------------------------

import { ModuleHealth } from '../core/types/module';

/**
 * A single Prometheus metric with optional labels.
 */
export interface PrometheusMetric {
  name: string;
  type: 'counter' | 'gauge' | 'histogram' | 'summary';
  help: string;
  value: number;
  labels?: Record<string, string>;
}

/**
 * Options for the metrics collector.
 */
export interface MetricsCollectorOptions {
  /** Prefix for all metric names. Default: 'opspilot'. */
  prefix?: string;
  /** Include process metrics (uptime, memory). Default: true. */
  includeProcess?: boolean;
}

/**
 * Collects and formats Prometheus metrics from OpsPilot module health data.
 */
export class MetricsCollector {
  private readonly prefix: string;
  private readonly includeProcess: boolean;
  /** Custom registered metrics (from middleware, rate limiter, etc.). */
  private readonly customMetrics: PrometheusMetric[] = [];

  constructor(options: MetricsCollectorOptions = {}) {
    this.prefix = options.prefix ?? 'opspilot';
    this.includeProcess = options.includeProcess ?? true;
  }

  /**
   * Register a custom metric that will be included in every scrape.
   */
  registerMetric(metric: PrometheusMetric): void {
    this.customMetrics.push(metric);
  }

  /**
   * Clear all custom metrics.
   */
  clearCustomMetrics(): void {
    this.customMetrics.length = 0;
  }

  /**
   * Collect metrics from module healths and generate Prometheus text exposition.
   */
  collect(moduleHealths: Record<string, ModuleHealth>): string {
    const lines: string[] = [];

    // ── Process Metrics ──────────────────────────────────────────────────
    if (this.includeProcess) {
      lines.push(...this.processMetrics());
    }

    // ── Module Status Metrics ────────────────────────────────────────────
    lines.push(`# HELP ${this.prefix}_module_status Module health status (1=healthy, 0.5=degraded, 0=unhealthy)`);
    lines.push(`# TYPE ${this.prefix}_module_status gauge`);

    for (const [id, health] of Object.entries(moduleHealths)) {
      const statusValue = health.status === 'healthy' ? 1 : health.status === 'degraded' ? 0.5 : 0;
      const safeId = this.sanitizeLabel(id);
      lines.push(`${this.prefix}_module_status{module="${safeId}"} ${statusValue}`);
    }

    // ── Module Detail Metrics ────────────────────────────────────────────
    for (const [id, health] of Object.entries(moduleHealths)) {
      if (!health.details) continue;
      const modulePrefix = `${this.prefix}_${this.sanitizeMetricName(id)}`;

      for (const [key, value] of Object.entries(health.details)) {
        if (typeof value === 'number' && isFinite(value)) {
          const metricName = `${modulePrefix}_${this.sanitizeMetricName(key)}`;
          // First occurrence: emit HELP and TYPE
          lines.push(`# HELP ${metricName} ${id} ${key}`);
          lines.push(`# TYPE ${metricName} gauge`);
          lines.push(`${metricName} ${value}`);
        }
      }
    }

    // ── Custom Metrics ───────────────────────────────────────────────────
    for (const metric of this.customMetrics) {
      const name = `${this.prefix}_${this.sanitizeMetricName(metric.name)}`;
      lines.push(`# HELP ${name} ${metric.help}`);
      lines.push(`# TYPE ${name} ${metric.type}`);
      if (metric.labels && Object.keys(metric.labels).length > 0) {
        const labelStr = Object.entries(metric.labels)
          .map(([k, v]) => `${k}="${this.sanitizeLabel(v)}"`)
          .join(',');
        lines.push(`${name}{${labelStr}} ${metric.value}`);
      } else {
        lines.push(`${name} ${metric.value}`);
      }
    }

    return lines.join('\n') + '\n';
  }

  // ── Process Metrics ──────────────────────────────────────────────────────

  private processMetrics(): string[] {
    const lines: string[] = [];
    const mem = process.memoryUsage();

    lines.push(`# HELP ${this.prefix}_process_uptime_seconds Process uptime in seconds`);
    lines.push(`# TYPE ${this.prefix}_process_uptime_seconds gauge`);
    lines.push(`${this.prefix}_process_uptime_seconds ${Math.floor(process.uptime())}`);

    lines.push(`# HELP ${this.prefix}_process_heap_used_bytes Process heap memory used`);
    lines.push(`# TYPE ${this.prefix}_process_heap_used_bytes gauge`);
    lines.push(`${this.prefix}_process_heap_used_bytes ${mem.heapUsed}`);

    lines.push(`# HELP ${this.prefix}_process_heap_total_bytes Process heap memory total`);
    lines.push(`# TYPE ${this.prefix}_process_heap_total_bytes gauge`);
    lines.push(`${this.prefix}_process_heap_total_bytes ${mem.heapTotal}`);

    lines.push(`# HELP ${this.prefix}_process_rss_bytes Process RSS memory`);
    lines.push(`# TYPE ${this.prefix}_process_rss_bytes gauge`);
    lines.push(`${this.prefix}_process_rss_bytes ${mem.rss}`);

    lines.push(`# HELP ${this.prefix}_process_external_bytes Process external memory`);
    lines.push(`# TYPE ${this.prefix}_process_external_bytes gauge`);
    lines.push(`${this.prefix}_process_external_bytes ${mem.external}`);

    return lines;
  }

  // ── Sanitization ─────────────────────────────────────────────────────────

  /**
   * Convert a module ID or metric name to a valid Prometheus metric name.
   * Replaces dots and dashes with underscores, strips invalid characters.
   */
  private sanitizeMetricName(name: string): string {
    return name
      .replace(/[.\-/]/g, '_')
      .replace(/[^a-zA-Z0-9_:]/g, '')
      .replace(/^_+/, '')
      .replace(/_+/g, '_');
  }

  /**
   * Sanitize a string for use as a Prometheus label value.
   */
  private sanitizeLabel(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }
}
