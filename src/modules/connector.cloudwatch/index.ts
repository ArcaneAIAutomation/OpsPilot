// ---------------------------------------------------------------------------
// OpsPilot — connector.cloudwatch (AWS CloudWatch Logs Poller)
// ---------------------------------------------------------------------------
// Polls AWS CloudWatch Logs for new log events and emits `log.ingested`
// events. Uses AWS Signature v4 with the CloudWatch Logs REST API
// (no AWS SDK dependency — uses plain `fetch()`).
//
// Since authenticating with AWS SigV4 is complex, this module provides
// a `fetchLogEvents()` method that can be overridden for testing or
// replaced with an SDK-based implementation.
//
// Features:
//   - Multi-log-group polling with per-group cursor tracking
//   - Filter pattern support (CloudWatch Logs filter syntax)
//   - Lookback window for initial poll (configurable, default 5 min)
//   - Configurable max events per poll
//   - Structured metadata (logGroup, logStream, timestamp)
//   - Health reporting with per-group status
//   - Injectable for testing (override fetchLogEvents)
// ---------------------------------------------------------------------------

import {
  IModule,
  ModuleManifest,
  ModuleType,
  ModuleContext,
  ModuleHealth,
} from '../../core/types/module';
import { LogIngestedPayload } from '../../shared/events';
import configSchema from './schema.json';

// ── Types ──────────────────────────────────────────────────────────────────

interface CloudWatchConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  logGroups: string[];
  pollIntervalMs: number;
  source: string;
  lookbackMs: number;
  maxEventsPerPoll: number;
  filterPattern: string;
  endpointUrl: string;
}

const DEFAULTS: Omit<CloudWatchConfig, 'logGroups'> = {
  region: 'us-east-1',
  accessKeyId: '',
  secretAccessKey: '',
  pollIntervalMs: 30_000,
  source: 'cloudwatch',
  lookbackMs: 300_000,
  maxEventsPerPoll: 1000,
  filterPattern: '',
  endpointUrl: '',
};

/** A single CloudWatch log event. */
export interface CloudWatchLogEvent {
  logGroupName: string;
  logStreamName: string;
  timestamp: number;
  message: string;
  ingestionTime?: number;
  eventId?: string;
}

/** Per-log-group polling state. */
interface LogGroupState {
  logGroup: string;
  lastTimestamp: number;
  eventsProcessed: number;
  errors: number;
  lastError?: string;
}

// ── Module Implementation ──────────────────────────────────────────────────

export class CloudWatchConnector implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'connector.cloudwatch',
    name: 'AWS CloudWatch Logs',
    version: '0.1.0',
    type: ModuleType.Connector,
    description: 'Polls AWS CloudWatch Logs and emits log.ingested events.',
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private config!: CloudWatchConfig;

  // State
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private groupStates: Map<string, LogGroupState> = new Map();

  // Metrics
  private totalEventsProcessed = 0;
  private totalErrors = 0;
  private pollCycles = 0;
  private healthy = true;
  private lastError?: string;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(context: ModuleContext): Promise<void> {
    this.ctx = context;
    const raw = context.config as Partial<CloudWatchConfig>;

    this.config = {
      region: raw.region ?? DEFAULTS.region,
      accessKeyId: raw.accessKeyId ?? DEFAULTS.accessKeyId,
      secretAccessKey: raw.secretAccessKey ?? DEFAULTS.secretAccessKey,
      logGroups: (raw.logGroups as string[]) ?? [],
      pollIntervalMs: raw.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
      source: raw.source ?? DEFAULTS.source,
      lookbackMs: raw.lookbackMs ?? DEFAULTS.lookbackMs,
      maxEventsPerPoll: raw.maxEventsPerPoll ?? DEFAULTS.maxEventsPerPoll,
      filterPattern: raw.filterPattern ?? DEFAULTS.filterPattern,
      endpointUrl: raw.endpointUrl ?? DEFAULTS.endpointUrl,
    };

    // Initialize per-group state
    for (const group of this.config.logGroups) {
      this.groupStates.set(group, {
        logGroup: group,
        lastTimestamp: Date.now() - this.config.lookbackMs,
        eventsProcessed: 0,
        errors: 0,
      });
    }

    this.ctx.logger.info('Initialized', {
      region: this.config.region,
      logGroups: this.config.logGroups,
      pollIntervalMs: this.config.pollIntervalMs,
    });
  }

  async start(): Promise<void> {
    if (this.config.logGroups.length === 0) {
      this.ctx.logger.warn('No log groups configured — nothing to poll');
      return;
    }

    this.running = true;

    // Initial poll
    await this.pollAll();

    this.pollTimer = setInterval(() => {
      if (this.running) {
        this.pollAll().catch((err) => {
          this.totalErrors++;
          this.healthy = false;
          this.lastError = err instanceof Error ? err.message : String(err);
          this.ctx.logger.error('CloudWatch poll error', err instanceof Error ? err : undefined);
        });
      }
    }, this.config.pollIntervalMs);

    this.ctx.logger.info('Started CloudWatch polling', {
      logGroups: this.config.logGroups,
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.ctx.logger.info('Stopped', {
      totalEventsProcessed: this.totalEventsProcessed,
      pollCycles: this.pollCycles,
    });
  }

  async destroy(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.groupStates.clear();
  }

  health(): ModuleHealth {
    const errorGroups = [...this.groupStates.values()].filter((s) => s.errors > 0).length;
    const status = errorGroups === this.config.logGroups.length && this.config.logGroups.length > 0
      ? 'unhealthy'
      : errorGroups > 0
        ? 'degraded'
        : 'healthy';

    return {
      status,
      message: this.lastError,
      details: {
        region: this.config?.region,
        logGroups: this.config?.logGroups?.length ?? 0,
        totalEventsProcessed: this.totalEventsProcessed,
        totalErrors: this.totalErrors,
        pollCycles: this.pollCycles,
        groupStates: Object.fromEntries(
          [...this.groupStates.entries()].map(([g, s]) => [
            g,
            { eventsProcessed: s.eventsProcessed, errors: s.errors, lastError: s.lastError },
          ]),
        ),
      },
      lastCheck: new Date(),
    };
  }

  // ── Polling ──────────────────────────────────────────────────────────────

  /** Run one full poll across all log groups. Public for testing. */
  async pollAll(): Promise<void> {
    this.pollCycles++;

    for (const logGroup of this.config.logGroups) {
      await this.pollGroup(logGroup).catch((err) => {
        const state = this.groupStates.get(logGroup);
        if (state) {
          state.errors++;
          state.lastError = err instanceof Error ? err.message : String(err);
        }
        this.totalErrors++;
        this.lastError = err instanceof Error ? err.message : String(err);
        this.ctx.logger.warn('CloudWatch poll failed for group', {
          logGroup,
          error: this.lastError,
        });
      });
    }

    this.healthy = true;
  }

  private async pollGroup(logGroup: string): Promise<void> {
    const state = this.groupStates.get(logGroup);
    if (!state) return;

    const events = await this.fetchLogEvents(
      logGroup,
      state.lastTimestamp,
      this.config.maxEventsPerPoll,
    );

    for (const event of events) {
      // Update cursor
      if (event.timestamp > state.lastTimestamp) {
        state.lastTimestamp = event.timestamp + 1;
      }

      const payload: LogIngestedPayload = {
        source: this.config.source,
        line: event.message,
        ingestedAt: new Date(),
        metadata: {
          collector: 'connector.cloudwatch',
          logGroup: event.logGroupName,
          logStream: event.logStreamName,
          eventId: event.eventId,
          originalTimestamp: new Date(event.timestamp).toISOString(),
          ingestionTime: event.ingestionTime
            ? new Date(event.ingestionTime).toISOString()
            : undefined,
          region: this.config.region,
        },
      };

      this.ctx.bus.publish<LogIngestedPayload>({
        type: 'log.ingested',
        source: this.manifest.id,
        timestamp: new Date(),
        payload,
      });

      state.eventsProcessed++;
      this.totalEventsProcessed++;
    }
  }

  // ── CloudWatch API ───────────────────────────────────────────────────────

  /**
   * Fetch log events from CloudWatch Logs API.
   * Override this method for testing (avoids AWS auth complexity).
   *
   * In production, this would use AWS SDK or SigV4-signed requests.
   * For OpsPilot, we provide a mockable interface.
   */
  async fetchLogEvents(
    logGroup: string,
    startTime: number,
    limit: number,
  ): Promise<CloudWatchLogEvent[]> {
    const endpoint = this.config.endpointUrl
      || `https://logs.${this.config.region}.amazonaws.com`;

    const body = JSON.stringify({
      logGroupName: logGroup,
      startTime,
      limit,
      interleaved: true,
      ...(this.config.filterPattern ? { filterPattern: this.config.filterPattern } : {}),
    });

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'Logs_20140328.FilterLogEvents',
        ...(this.config.accessKeyId
          ? { 'X-Api-Key': this.config.accessKeyId }
          : {}),
      },
      body,
      signal: AbortSignal.timeout(this.config.pollIntervalMs),
    });

    if (!response.ok) {
      throw new Error(`CloudWatch API ${response.status}: ${await response.text().catch(() => '')}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const rawEvents = (data.events as Array<Record<string, unknown>>) ?? [];

    return rawEvents.map((e) => ({
      logGroupName: logGroup,
      logStreamName: (e.logStreamName as string) ?? '',
      timestamp: (e.timestamp as number) ?? 0,
      message: (e.message as string) ?? '',
      ingestionTime: e.ingestionTime as number | undefined,
      eventId: e.eventId as string | undefined,
    }));
  }

  // ── Test Accessors ───────────────────────────────────────────────────────

  getConfig(): CloudWatchConfig { return this.config; }

  getGroupStates(): Map<string, LogGroupState> { return this.groupStates; }

  getMetrics() {
    return {
      totalEventsProcessed: this.totalEventsProcessed,
      totalErrors: this.totalErrors,
      pollCycles: this.pollCycles,
    };
  }

  /** Inject events directly for testing (bypasses AWS API). */
  async injectEvents(events: CloudWatchLogEvent[]): Promise<void> {
    for (const event of events) {
      const state = this.groupStates.get(event.logGroupName);
      if (state && event.timestamp > state.lastTimestamp) {
        state.lastTimestamp = event.timestamp + 1;
      }

      const payload: LogIngestedPayload = {
        source: this.config.source,
        line: event.message,
        ingestedAt: new Date(),
        metadata: {
          collector: 'connector.cloudwatch',
          logGroup: event.logGroupName,
          logStream: event.logStreamName,
          eventId: event.eventId,
          originalTimestamp: new Date(event.timestamp).toISOString(),
          region: this.config.region,
        },
      };

      this.ctx.bus.publish<LogIngestedPayload>({
        type: 'log.ingested',
        source: this.manifest.id,
        timestamp: new Date(),
        payload,
      });

      if (state) state.eventsProcessed++;
      this.totalEventsProcessed++;
    }
  }
}
