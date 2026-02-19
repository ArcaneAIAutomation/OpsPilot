// ---------------------------------------------------------------------------
// OpsPilot — notifier.pagerduty (PagerDuty Events API v2 Notifier)
// ---------------------------------------------------------------------------
// Sends structured alert events to PagerDuty via the Events API v2.
// Automatically maps OpsPilot incident severity to PagerDuty severity.
//
// PagerDuty Events API v2 Reference:
//   POST https://events.pagerduty.com/v2/enqueue
//   { routing_key, event_action, dedup_key, payload: { ... } }
//
// Features:
//   - Maps incident.created → PagerDuty "trigger" event
//   - Maps action.executed (success) → PagerDuty "resolve" event
//   - Severity mapping: critical→critical, warning→warning, info→info
//   - Dedup key support for alert correlation
//   - Rate limiting and timeout handling
//   - Rich custom_details with OpsPilot context
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
  IncidentCreatedPayload,
  ActionExecutedPayload,
  IncidentSeverity,
} from '../../shared/events';
import configSchema from './schema.json';

// ── Config ─────────────────────────────────────────────────────────────────

interface PagerDutyConfig {
  routingKey: string;
  apiUrl: string;
  events: string[];
  minSeverity: IncidentSeverity;
  dedupKeyPrefix: string;
  source: string;
  component?: string;
  group?: string;
  timeoutMs: number;
  rateLimitPerMinute: number;
}

const DEFAULTS: Omit<PagerDutyConfig, 'routingKey'> = {
  apiUrl: 'https://events.pagerduty.com/v2/enqueue',
  events: ['incident.created', 'action.executed'],
  minSeverity: 'critical',
  dedupKeyPrefix: 'opspilot',
  source: 'OpsPilot',
  timeoutMs: 10_000,
  rateLimitPerMinute: 20,
};

// ── Severity ───────────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<string, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

/** Map OpsPilot severity to PagerDuty severity. */
const PD_SEVERITY_MAP: Record<string, string> = {
  info: 'info',
  warning: 'warning',
  critical: 'critical',
};

// ── PagerDuty Event Types ──────────────────────────────────────────────────

type PdEventAction = 'trigger' | 'acknowledge' | 'resolve';

interface PdPayload {
  summary: string;
  timestamp: string;
  severity: string;
  source: string;
  component?: string;
  group?: string;
  class?: string;
  custom_details?: Record<string, unknown>;
}

interface PdEvent {
  routing_key: string;
  event_action: PdEventAction;
  dedup_key?: string;
  payload?: PdPayload;
}

interface PdResponse {
  status: string;
  message: string;
  dedup_key: string;
}

// ── Module Implementation ──────────────────────────────────────────────────

export class PagerDutyNotifier implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'notifier.pagerduty',
    name: 'PagerDuty Notifier',
    version: '1.0.0',
    type: ModuleType.Notifier,
    description: 'Sends alerts to PagerDuty via Events API v2.',
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private config!: PagerDutyConfig;
  private subscriptions: EventSubscription[] = [];

  // Rate limiter
  private timestamps: number[] = [];

  // Metrics
  private totalSent = 0;
  private totalDropped = 0;
  private totalErrors = 0;
  private lastError?: string;
  private lastDedupKey?: string;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(context: ModuleContext): Promise<void> {
    this.ctx = context;
    const raw = context.config as Partial<PagerDutyConfig>;

    this.config = {
      routingKey: raw.routingKey!,
      apiUrl: raw.apiUrl ?? DEFAULTS.apiUrl,
      events: raw.events ?? [...DEFAULTS.events],
      minSeverity: raw.minSeverity ?? DEFAULTS.minSeverity,
      dedupKeyPrefix: raw.dedupKeyPrefix ?? DEFAULTS.dedupKeyPrefix,
      source: raw.source ?? DEFAULTS.source,
      component: raw.component,
      group: raw.group,
      timeoutMs: raw.timeoutMs ?? DEFAULTS.timeoutMs,
      rateLimitPerMinute: raw.rateLimitPerMinute ?? DEFAULTS.rateLimitPerMinute,
    };

    this.ctx.logger.info('PagerDuty notifier initialized', {
      apiUrl: this.config.apiUrl,
      events: this.config.events,
      minSeverity: this.config.minSeverity,
    });
  }

  async start(): Promise<void> {
    for (const eventType of this.config.events) {
      const sub = this.ctx.bus.subscribe(eventType, (event) => {
        this.onEvent(event, eventType).catch((err) => {
          this.totalErrors++;
          this.lastError = err instanceof Error ? err.message : String(err);
          this.ctx.logger.error('PagerDuty notification error', err instanceof Error ? err : undefined);
        });
      });
      this.subscriptions.push(sub);
    }

    this.ctx.logger.info('PagerDuty notifier started', {
      subscribedTo: this.config.events,
    });
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) sub.unsubscribe();
    this.subscriptions = [];
    this.ctx.logger.info('PagerDuty notifier stopped', {
      totalSent: this.totalSent,
      totalDropped: this.totalDropped,
      totalErrors: this.totalErrors,
    });
  }

  async destroy(): Promise<void> {
    this.timestamps = [];
  }

  health(): ModuleHealth {
    const status =
      this.totalErrors > 0 && this.totalSent === 0
        ? 'unhealthy'
        : this.totalErrors > 0
          ? 'degraded'
          : 'healthy';

    return {
      status,
      message: this.lastError,
      details: {
        totalSent: this.totalSent,
        totalDropped: this.totalDropped,
        totalErrors: this.totalErrors,
        lastDedupKey: this.lastDedupKey,
        routingKey: this.config?.routingKey ? '***configured***' : 'missing',
      },
      lastCheck: new Date(),
    };
  }

  // ── Event Handling ───────────────────────────────────────────────────────

  private async onEvent(event: OpsPilotEvent, eventType: string): Promise<void> {
    // Rate limit
    if (!this.checkRateLimit()) {
      this.totalDropped++;
      this.ctx.logger.warn('PagerDuty rate limit exceeded, dropping', { eventType });
      return;
    }

    const pdEvent = this.buildPdEvent(event, eventType);
    if (!pdEvent) return; // Event filtered out

    await this.sendToPagerDuty(pdEvent);
    this.totalSent++;
    this.lastDedupKey = pdEvent.dedup_key;
  }

  // ── Event Building ──────────────────────────────────────────────────────

  /** Build a PagerDuty event from an OpsPilot event. Returns null if filtered. */
  buildPdEvent(event: OpsPilotEvent, eventType: string): PdEvent | null {
    switch (eventType) {
      case 'incident.created':
        return this.buildIncidentTrigger(event.payload as IncidentCreatedPayload);
      case 'action.executed':
        return this.buildActionResolve(event.payload as ActionExecutedPayload);
      default:
        return this.buildGenericTrigger(event, eventType);
    }
  }

  private buildIncidentTrigger(p: IncidentCreatedPayload): PdEvent | null {
    // Severity filter
    if (SEVERITY_ORDER[p.severity] < SEVERITY_ORDER[this.config.minSeverity]) {
      return null;
    }

    return {
      routing_key: this.config.routingKey,
      event_action: 'trigger',
      dedup_key: `${this.config.dedupKeyPrefix}-${p.incidentId}`,
      payload: {
        summary: `[${p.severity.toUpperCase()}] ${p.title}: ${p.description}`.slice(0, 1024),
        timestamp: new Date(p.detectedAt).toISOString(),
        severity: PD_SEVERITY_MAP[p.severity] ?? 'error',
        source: this.config.source,
        component: this.config.component,
        group: this.config.group,
        class: p.detectedBy,
        custom_details: {
          incidentId: p.incidentId,
          detectedBy: p.detectedBy,
          severity: p.severity,
          description: p.description,
          context: p.context,
        },
      },
    };
  }

  private buildActionResolve(p: ActionExecutedPayload): PdEvent | null {
    // Check if the payload carries an incidentId via metadata
    const incidentId = (p as unknown as Record<string, unknown>)['incidentId'] as string | undefined;

    if (p.result === 'success' && incidentId) {
      // Resolve the corresponding PD alert
      return {
        routing_key: this.config.routingKey,
        event_action: 'resolve',
        dedup_key: `${this.config.dedupKeyPrefix}-${incidentId}`,
      };
    }

    // Failed actions don't resolve — trigger a new alert
    if (p.result === 'failure') {
      return {
        routing_key: this.config.routingKey,
        event_action: 'trigger',
        dedup_key: `${this.config.dedupKeyPrefix}-action-${p.requestId}`,
        payload: {
          summary: `Action failed: ${p.actionType} (request ${p.requestId})`,
          timestamp: new Date(p.executedAt).toISOString(),
          severity: 'error',
          source: this.config.source,
          component: this.config.component,
          group: this.config.group,
          class: 'action.safe',
          custom_details: {
            requestId: p.requestId,
            actionType: p.actionType,
            result: p.result,
            output: p.output,
          },
        },
      };
    }

    return null; // Successful action without incident ID — skip
  }

  private buildGenericTrigger(event: OpsPilotEvent, eventType: string): PdEvent {
    return {
      routing_key: this.config.routingKey,
      event_action: 'trigger',
      dedup_key: `${this.config.dedupKeyPrefix}-${eventType}-${Date.now()}`,
      payload: {
        summary: `[${eventType}] Event from ${event.source}`,
        timestamp: new Date(event.timestamp).toISOString(),
        severity: 'info',
        source: this.config.source,
        component: this.config.component,
        group: this.config.group,
        custom_details: event.payload as Record<string, unknown>,
      },
    };
  }

  // ── HTTP Delivery ────────────────────────────────────────────────────────

  /** Send a PagerDuty event. Exposed for test mocking. */
  async sendToPagerDuty(pdEvent: PdEvent): Promise<PdResponse> {
    const body = JSON.stringify(pdEvent);

    const response = await fetch(this.config.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`PagerDuty API returned ${response.status}: ${text}`);
    }

    return response.json() as Promise<PdResponse>;
  }

  // ── Rate Limiter ─────────────────────────────────────────────────────────

  private checkRateLimit(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((ts) => ts > now - 60_000);
    if (this.timestamps.length >= this.config.rateLimitPerMinute) return false;
    this.timestamps.push(now);
    return true;
  }

  // ── Test Accessors ───────────────────────────────────────────────────────

  getConfig(): PagerDutyConfig {
    return this.config;
  }

  getMetrics(): { totalSent: number; totalDropped: number; totalErrors: number } {
    return { totalSent: this.totalSent, totalDropped: this.totalDropped, totalErrors: this.totalErrors };
  }
}
