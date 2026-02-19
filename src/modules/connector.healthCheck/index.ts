// ---------------------------------------------------------------------------
// OpsPilot — connector.healthCheck (Scheduled Health Check Connector)
// ---------------------------------------------------------------------------
// Periodically probes configured HTTP/TCP endpoints and emits events
// when endpoints are unreachable, return unexpected status codes, or
// when their response bodies don't contain an expected string.
//
// Probe types:
//   - HTTP/HTTPS: fetch with configurable method, status, body match
//   - TCP: raw socket connect to host:port (url starts with tcp://)
//
// On failure the connector emits `log.ingested` events tagged with
// [HEALTH_CHECK] and [FAILURE] so that downstream detectors can create
// incidents. On recovery it emits [RECOVERY] tagged lines.
//
// Features:
//   - Multi-endpoint with per-endpoint config (severity, headers, method)
//   - Consecutive failure threshold before alerting
//   - Recovery detection (emits recovery event when endpoint comes back)
//   - Per-endpoint response-time tracking
//   - TCP connect probe (tcp://host:port)
//   - Configurable timeout per request
//   - Health reporting with per-endpoint status map
// ---------------------------------------------------------------------------

import * as net from 'node:net';
import {
  IModule,
  ModuleManifest,
  ModuleType,
  ModuleContext,
  ModuleHealth,
} from '../../core/types/module';
import { OpsPilotEvent } from '../../core/types/events';
import { LogIngestedPayload } from '../../shared/events';
import configSchema from './schema.json';

// ── Types ──────────────────────────────────────────────────────────────────

interface EndpointConfig {
  id: string;
  name: string;
  url: string;
  method: 'GET' | 'HEAD' | 'POST';
  expectedStatus: number;
  expectedBodyContains?: string;
  headers?: Record<string, string>;
  severity: 'info' | 'warning' | 'critical';
  consecutiveFailures: number;
}

interface HealthCheckConfig {
  intervalMs: number;
  timeoutMs: number;
  endpoints: EndpointConfig[];
  source: string;
}

const ENDPOINT_DEFAULTS: Partial<EndpointConfig> = {
  method: 'GET',
  expectedStatus: 200,
  severity: 'critical',
  consecutiveFailures: 1,
};

const CONFIG_DEFAULTS: HealthCheckConfig = {
  intervalMs: 30_000,
  timeoutMs: 10_000,
  endpoints: [],
  source: 'health-check',
};

/** Per-endpoint runtime state tracked between check cycles. */
export interface EndpointState {
  id: string;
  name: string;
  url: string;
  status: 'unknown' | 'healthy' | 'unhealthy';
  consecutiveFails: number;
  lastCheckAt: number;
  lastResponseMs: number;
  lastError?: string;
  totalChecks: number;
  totalFailures: number;
}

/** Result of a single probe attempt. */
export interface ProbeResult {
  success: boolean;
  responseMs: number;
  statusCode?: number;
  error?: string;
}

// ── Module Implementation ──────────────────────────────────────────────────

export class HealthCheckConnector implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'connector.healthCheck',
    name: 'Health Check Connector',
    version: '0.1.0',
    type: ModuleType.Connector,
    description: 'Periodic HTTP/TCP health probes for configured endpoints.',
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private config!: HealthCheckConfig;
  private states: Map<string, EndpointState> = new Map();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  // Metrics
  private totalCycles = 0;
  private totalProbes = 0;
  private totalFailures = 0;
  private totalRecoveries = 0;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(context: ModuleContext): Promise<void> {
    this.ctx = context;

    // Merge defaults
    const raw = context.config as Record<string, unknown>;
    this.config = {
      intervalMs: (raw.intervalMs as number) ?? CONFIG_DEFAULTS.intervalMs,
      timeoutMs: (raw.timeoutMs as number) ?? CONFIG_DEFAULTS.timeoutMs,
      source: (raw.source as string) ?? CONFIG_DEFAULTS.source,
      endpoints: [],
    };

    // Parse endpoint configs
    const rawEndpoints = (raw.endpoints as Array<Record<string, unknown>>) ?? [];
    for (const ep of rawEndpoints) {
      this.config.endpoints.push({
        id: ep.id as string,
        name: ep.name as string,
        url: ep.url as string,
        method: (ep.method as EndpointConfig['method']) ?? ENDPOINT_DEFAULTS.method!,
        expectedStatus: (ep.expectedStatus as number) ?? ENDPOINT_DEFAULTS.expectedStatus!,
        expectedBodyContains: ep.expectedBodyContains as string | undefined,
        headers: ep.headers as Record<string, string> | undefined,
        severity: (ep.severity as EndpointConfig['severity']) ?? ENDPOINT_DEFAULTS.severity!,
        consecutiveFailures: (ep.consecutiveFailures as number) ?? ENDPOINT_DEFAULTS.consecutiveFailures!,
      });
    }

    // Initialize per-endpoint state
    for (const ep of this.config.endpoints) {
      this.states.set(ep.id, {
        id: ep.id,
        name: ep.name,
        url: ep.url,
        status: 'unknown',
        consecutiveFails: 0,
        lastCheckAt: 0,
        lastResponseMs: 0,
        totalChecks: 0,
        totalFailures: 0,
      });
    }

    this.ctx.logger.info('Initialized', {
      endpointCount: this.config.endpoints.length,
      intervalMs: this.config.intervalMs,
      timeoutMs: this.config.timeoutMs,
    });
  }

  async start(): Promise<void> {
    this.running = true;

    if (this.config.endpoints.length === 0) {
      this.ctx.logger.warn('No endpoints configured — no health checks will run');
      return;
    }

    // Run the first cycle immediately
    await this.runCycle();

    // Then on interval
    this.timer = setInterval(() => {
      if (this.running) this.runCycle().catch((err) => {
        this.ctx.logger.error('Health check cycle error', err as Error);
      });
    }, this.config.intervalMs);

    this.ctx.logger.info('Started health checks', {
      endpoints: this.config.endpoints.map((e) => e.id),
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.ctx.logger.info('Stopped', {
      totalCycles: this.totalCycles,
      totalProbes: this.totalProbes,
      totalFailures: this.totalFailures,
      totalRecoveries: this.totalRecoveries,
    });
  }

  async destroy(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.states.clear();
  }

  health(): ModuleHealth {
    const unhealthyEndpoints = [...this.states.values()].filter(
      (s) => s.status === 'unhealthy',
    ).length;

    const status: ModuleHealth['status'] =
      unhealthyEndpoints > 0 ? 'degraded' : 'healthy';

    return {
      status,
      details: {
        totalCycles: this.totalCycles,
        totalProbes: this.totalProbes,
        totalFailures: this.totalFailures,
        totalRecoveries: this.totalRecoveries,
        endpointCount: this.config.endpoints.length,
        unhealthyEndpoints,
        endpoints: Object.fromEntries(
          [...this.states.entries()].map(([id, s]) => [
            id,
            { status: s.status, lastResponseMs: s.lastResponseMs, consecutiveFails: s.consecutiveFails },
          ]),
        ),
      },
      lastCheck: new Date(),
    };
  }

  // ── Check Cycle ──────────────────────────────────────────────────────────

  /**
   * Run one full check cycle across all endpoints.
   * Public for testability.
   */
  async runCycle(): Promise<void> {
    this.totalCycles++;
    const promises = this.config.endpoints.map((ep) => this.checkEndpoint(ep));
    await Promise.allSettled(promises);
  }

  /**
   * Check a single endpoint. Updates state and emits events as needed.
   */
  private async checkEndpoint(ep: EndpointConfig): Promise<void> {
    const state = this.states.get(ep.id);
    if (!state) return;

    const result = await this.probe(ep);
    state.totalChecks++;
    state.lastCheckAt = Date.now();
    state.lastResponseMs = result.responseMs;
    this.totalProbes++;

    if (result.success) {
      // ── Success ──
      const wasUnhealthy = state.status === 'unhealthy';
      state.consecutiveFails = 0;
      state.status = 'healthy';
      state.lastError = undefined;

      if (wasUnhealthy) {
        // Recovery — emit a recovery event
        this.totalRecoveries++;
        await this.emitLine(
          `[HEALTH_CHECK] [RECOVERY] ${ep.name} (${ep.url}) is reachable again (${result.responseMs}ms)`,
          ep,
          { responseMs: result.responseMs, statusCode: result.statusCode },
        );
      }
    } else {
      // ── Failure ──
      state.consecutiveFails++;
      state.lastError = result.error;
      state.totalFailures++;
      this.totalFailures++;

      if (state.consecutiveFails >= ep.consecutiveFailures) {
        state.status = 'unhealthy';
        await this.emitLine(
          `[HEALTH_CHECK] [FAILURE] ${ep.name} (${ep.url}): ${result.error} (attempt ${state.consecutiveFails})`,
          ep,
          {
            responseMs: result.responseMs,
            statusCode: result.statusCode,
            error: result.error,
            consecutiveFails: state.consecutiveFails,
          },
        );
      }
    }
  }

  // ── Probes ───────────────────────────────────────────────────────────────

  /**
   * Execute a single probe against an endpoint. Exposed for test mocking.
   */
  async probe(ep: EndpointConfig): Promise<ProbeResult> {
    if (ep.url.startsWith('tcp://')) {
      return this.probeTcp(ep);
    }
    return this.probeHttp(ep);
  }

  private async probeHttp(ep: EndpointConfig): Promise<ProbeResult> {
    const start = Date.now();
    try {
      const response = await fetch(ep.url, {
        method: ep.method,
        headers: ep.headers,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });

      const responseMs = Date.now() - start;

      // Status check
      if (response.status !== ep.expectedStatus) {
        return {
          success: false,
          responseMs,
          statusCode: response.status,
          error: `Expected status ${ep.expectedStatus}, got ${response.status}`,
        };
      }

      // Body content check
      if (ep.expectedBodyContains) {
        const body = await response.text();
        if (!body.includes(ep.expectedBodyContains)) {
          return {
            success: false,
            responseMs,
            statusCode: response.status,
            error: `Response body missing expected string "${ep.expectedBodyContains}"`,
          };
        }
      }

      return { success: true, responseMs, statusCode: response.status };
    } catch (err) {
      return {
        success: false,
        responseMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private probeTcp(ep: EndpointConfig): Promise<ProbeResult> {
    return new Promise((resolve) => {
      const start = Date.now();
      const url = new URL(ep.url);
      const host = url.hostname;
      const port = parseInt(url.port || '80', 10);

      const socket = new net.Socket();
      const timer = setTimeout(() => {
        socket.destroy();
        resolve({
          success: false,
          responseMs: Date.now() - start,
          error: `TCP connect timeout after ${this.config.timeoutMs}ms`,
        });
      }, this.config.timeoutMs);

      socket.connect(port, host, () => {
        clearTimeout(timer);
        const responseMs = Date.now() - start;
        socket.destroy();
        resolve({ success: true, responseMs });
      });

      socket.on('error', (err) => {
        clearTimeout(timer);
        socket.destroy();
        resolve({
          success: false,
          responseMs: Date.now() - start,
          error: err.message,
        });
      });
    });
  }

  // ── Event Emission ───────────────────────────────────────────────────────

  /**
   * Emit a log.ingested event with the given line. Exposed for test inspection.
   */
  async emitLine(
    line: string,
    ep: EndpointConfig,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const payload: LogIngestedPayload = {
      source: this.config.source,
      line,
      ingestedAt: new Date(),
      metadata: {
        endpointId: ep.id,
        endpointName: ep.name,
        endpointUrl: ep.url,
        severity: ep.severity,
        collector: 'connector.healthCheck',
        ...metadata,
      },
    };

    await this.ctx.bus.publish<LogIngestedPayload>({
      type: 'log.ingested',
      source: this.manifest.id,
      timestamp: new Date(),
      payload,
    });
  }

  // ── Test Accessors ───────────────────────────────────────────────────────

  getStates(): Map<string, EndpointState> {
    return this.states;
  }

  getMetrics(): {
    totalCycles: number;
    totalProbes: number;
    totalFailures: number;
    totalRecoveries: number;
  } {
    return {
      totalCycles: this.totalCycles,
      totalProbes: this.totalProbes,
      totalFailures: this.totalFailures,
      totalRecoveries: this.totalRecoveries,
    };
  }

  getConfig(): HealthCheckConfig {
    return this.config;
  }
}
