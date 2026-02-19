// ---------------------------------------------------------------------------
// OpsPilot — connector.metrics (System Metric Collector)
// ---------------------------------------------------------------------------
// Periodically collects system metrics (CPU, memory, load average, uptime)
// using Node.js built-in `os` module and emits `log.ingested` events.
//
// The emitted log lines follow a structured format that the threshold
// detector can parse, e.g.:
//   "[METRIC] cpu_usage_percent=72.3"
//   "[METRIC] memory_usage_percent=58.1 memory_used_mb=4712 memory_total_mb=8096"
//   "[METRIC] load_avg_1m=1.24 load_avg_5m=0.98 load_avg_15m=0.72"
//   "[METRIC] uptime_hours=142.5"
//
// High usage values additionally produce a WARNING-level line to trigger
// regex/threshold detectors:
//   "[WARNING] cpu_usage_percent=95.2 exceeds threshold 90"
// ---------------------------------------------------------------------------

import * as os from 'node:os';
import {
  IModule,
  ModuleManifest,
  ModuleType,
  ModuleContext,
  ModuleHealth,
} from '../../core/types/module';
import { LogIngestedPayload } from '../../shared/events';
import configSchema from './schema.json';

// ── Config ─────────────────────────────────────────────────────────────────

interface MetricsConfig {
  intervalMs: number;
  enabledMetrics: Array<'cpu' | 'memory' | 'loadAvg' | 'uptime'>;
  thresholds: {
    cpuPercent: number;
    memoryPercent: number;
  };
  source: string;
}

const DEFAULTS: MetricsConfig = {
  intervalMs: 10_000,
  enabledMetrics: ['cpu', 'memory', 'loadAvg'],
  thresholds: {
    cpuPercent: 90,
    memoryPercent: 90,
  },
  source: 'system-metrics',
};

// ── CPU Measurement ────────────────────────────────────────────────────────

interface CpuSnapshot {
  idle: number;
  total: number;
}

function takeCpuSnapshot(): CpuSnapshot {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

function computeCpuPercent(prev: CpuSnapshot, curr: CpuSnapshot): number {
  const idleDelta = curr.idle - prev.idle;
  const totalDelta = curr.total - prev.total;
  if (totalDelta === 0) return 0;
  return Math.round(((totalDelta - idleDelta) / totalDelta) * 1000) / 10; // one decimal
}

// ── Module Implementation ──────────────────────────────────────────────────

export class MetricCollector implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'connector.metrics',
    name: 'System Metric Collector',
    version: '0.1.0',
    type: ModuleType.Connector,
    description: 'Collects system metrics and emits log.ingested events.',
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private config!: MetricsConfig;

  private collectTimer: ReturnType<typeof setInterval> | null = null;
  private prevCpu: CpuSnapshot | null = null;
  private cycleCount = 0;
  private linesEmitted = 0;
  private healthy = true;
  private lastError: string | undefined;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(context: ModuleContext): Promise<void> {
    this.ctx = context;

    const rawConfig = context.config as Partial<MetricsConfig>;
    this.config = {
      intervalMs: rawConfig.intervalMs ?? DEFAULTS.intervalMs,
      enabledMetrics: rawConfig.enabledMetrics ?? [...DEFAULTS.enabledMetrics],
      thresholds: {
        cpuPercent: rawConfig.thresholds?.cpuPercent ?? DEFAULTS.thresholds.cpuPercent,
        memoryPercent: rawConfig.thresholds?.memoryPercent ?? DEFAULTS.thresholds.memoryPercent,
      },
      source: rawConfig.source ?? DEFAULTS.source,
    };

    // Take initial CPU snapshot so first cycle has a baseline
    if (this.config.enabledMetrics.includes('cpu')) {
      this.prevCpu = takeCpuSnapshot();
    }

    this.ctx.logger.info('Initialized', {
      intervalMs: this.config.intervalMs,
      enabledMetrics: this.config.enabledMetrics,
      thresholds: this.config.thresholds,
    });
  }

  async start(): Promise<void> {
    this.collectTimer = setInterval(() => {
      this.collect();
    }, this.config.intervalMs);

    this.ctx.logger.info('Started metric collection', {
      intervalMs: this.config.intervalMs,
    });
  }

  async stop(): Promise<void> {
    if (this.collectTimer) {
      clearInterval(this.collectTimer);
      this.collectTimer = null;
    }

    this.ctx.logger.info('Stopped metric collection', {
      cycleCount: this.cycleCount,
      linesEmitted: this.linesEmitted,
    });
  }

  async destroy(): Promise<void> {
    if (this.collectTimer) {
      clearInterval(this.collectTimer);
      this.collectTimer = null;
    }
    this.ctx = undefined!;
    this.config = undefined!;
  }

  health(): ModuleHealth {
    return {
      status: this.healthy ? 'healthy' : 'degraded',
      message: this.lastError,
      details: {
        cycleCount: this.cycleCount,
        linesEmitted: this.linesEmitted,
        enabledMetrics: this.config?.enabledMetrics,
      },
      lastCheck: new Date(),
    };
  }

  // ── Collection ───────────────────────────────────────────────────────────

  /** Run one collection cycle — collect enabled metrics and emit events. */
  collect(): void {
    try {
      this.cycleCount++;

      for (const metric of this.config.enabledMetrics) {
        switch (metric) {
          case 'cpu':
            this.collectCpu();
            break;
          case 'memory':
            this.collectMemory();
            break;
          case 'loadAvg':
            this.collectLoadAvg();
            break;
          case 'uptime':
            this.collectUptime();
            break;
        }
      }

      this.healthy = true;
    } catch (err: unknown) {
      this.healthy = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.ctx.logger.error('Metric collection failed', undefined, { error: this.lastError });
    }
  }

  // ── Individual Collectors ────────────────────────────────────────────────

  private collectCpu(): void {
    const curr = takeCpuSnapshot();
    if (this.prevCpu) {
      const percent = computeCpuPercent(this.prevCpu, curr);
      this.emitMetricLine(`[METRIC] cpu_usage_percent=${percent}`);

      if (percent >= this.config.thresholds.cpuPercent) {
        this.emitMetricLine(
          `[WARNING] cpu_usage_percent=${percent} exceeds threshold ${this.config.thresholds.cpuPercent}`,
        );
      }
    }
    this.prevCpu = curr;
  }

  private collectMemory(): void {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const percent = Math.round((usedMem / totalMem) * 1000) / 10;
    const usedMb = Math.round(usedMem / (1024 * 1024));
    const totalMb = Math.round(totalMem / (1024 * 1024));

    this.emitMetricLine(
      `[METRIC] memory_usage_percent=${percent} memory_used_mb=${usedMb} memory_total_mb=${totalMb}`,
    );

    if (percent >= this.config.thresholds.memoryPercent) {
      this.emitMetricLine(
        `[WARNING] memory_usage_percent=${percent} exceeds threshold ${this.config.thresholds.memoryPercent}`,
      );
    }
  }

  private collectLoadAvg(): void {
    const [avg1, avg5, avg15] = os.loadavg();
    this.emitMetricLine(
      `[METRIC] load_avg_1m=${avg1.toFixed(2)} load_avg_5m=${avg5.toFixed(2)} load_avg_15m=${avg15.toFixed(2)}`,
    );
  }

  private collectUptime(): void {
    const uptimeSeconds = os.uptime();
    const hours = Math.round((uptimeSeconds / 3600) * 10) / 10;
    this.emitMetricLine(`[METRIC] uptime_hours=${hours}`);
  }

  // ── Emit Helpers ─────────────────────────────────────────────────────────

  private emitMetricLine(line: string): void {
    const payload: LogIngestedPayload = {
      source: this.config.source,
      line,
      ingestedAt: new Date(),
      metadata: {
        collector: 'connector.metrics',
        cycle: this.cycleCount,
      },
    };

    this.ctx.bus.publish<LogIngestedPayload>({
      type: 'log.ingested',
      source: this.manifest.id,
      timestamp: new Date(),
      payload,
    });

    this.linesEmitted++;
  }

  // ── Getters for testing ──────────────────────────────────────────────────

  getConfig(): MetricsConfig {
    return this.config;
  }

  getCycleCount(): number {
    return this.cycleCount;
  }

  getLinesEmitted(): number {
    return this.linesEmitted;
  }
}

// Export helpers for testing
export { takeCpuSnapshot, computeCpuPercent, CpuSnapshot };
