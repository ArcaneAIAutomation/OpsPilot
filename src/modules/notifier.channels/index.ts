// ---------------------------------------------------------------------------
// OpsPilot — notifier.channels
// ---------------------------------------------------------------------------
// Multi-channel notification module.  Subscribes to configurable event
// types and routes formatted notifications to one or more channels:
//
//   • console  — Structured, colour-coded output to stdout
//   • webhook  — HTTP POST/PUT to external endpoints (Slack, PagerDuty, etc.)
//
// Safety features:
//   - Global rate-limit prevents notification storms
//   - Per-channel enable/disable toggle
//   - Minimum-severity filter for incident events
//   - Webhook errors are logged and counted, never crash the pipeline
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
  ActionProposedPayload,
  ActionApprovedPayload,
  ActionExecutedPayload,
  EnrichmentCompletedPayload,
  IncidentSeverity,
} from '../../shared/events';
import configSchema from './schema.json';

// ── Config Types ───────────────────────────────────────────────────────────

interface ChannelConfig {
  id: string;
  type: 'console' | 'webhook';
  events: string[];
  minSeverity?: IncidentSeverity;
  webhookUrl?: string;
  webhookMethod?: 'POST' | 'PUT';
  webhookHeaders?: Record<string, string>;
  enabled?: boolean;
}

interface NotifierConfig {
  channels: ChannelConfig[];
  rateLimitPerMinute?: number;
}

// ── Severity Ordering ──────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<string, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

// ── Module Implementation ──────────────────────────────────────────────────

export class NotifierChannelsModule implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'notifier.channels',
    name: 'Notification Channels',
    version: '1.0.0',
    type: ModuleType.Notifier,
    description: 'Routes events to console and webhook notification channels.',
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private channels: ChannelConfig[] = [];
  private subscriptions: EventSubscription[] = [];
  private rateLimit = 60;

  // Rate-limiter state
  private notificationTimestamps: number[] = [];

  // Health counters
  private totalSent = 0;
  private totalDropped = 0;
  private totalErrors = 0;
  private lastError?: string;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(context: ModuleContext): Promise<void> {
    this.ctx = context;
    const cfg = context.config as unknown as NotifierConfig;

    this.channels = cfg.channels.filter((ch) => ch.enabled !== false);
    this.rateLimit = cfg.rateLimitPerMinute ?? 60;

    // Validate webhook channels have required URL
    for (const ch of this.channels) {
      if (ch.type === 'webhook' && !ch.webhookUrl) {
        throw new Error(
          `Webhook channel "${ch.id}" requires a webhookUrl`,
        );
      }
    }

    this.ctx.logger.info('Notifier initialized', {
      channels: this.channels.map((c) => c.id),
      rateLimit: this.rateLimit,
    });
  }

  async start(): Promise<void> {
    // Collect unique event types across all channels
    const eventTypes = new Set<string>();
    for (const ch of this.channels) {
      for (const evt of ch.events) {
        eventTypes.add(evt);
      }
    }

    // Subscribe to each unique event type once
    for (const eventType of eventTypes) {
      const sub = this.ctx.bus.subscribe(eventType, (event) =>
        this.onEvent(event, eventType),
      );
      this.subscriptions.push(sub);
    }

    this.ctx.logger.info('Notifier started', {
      subscribedEvents: [...eventTypes],
    });
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];
    this.ctx.logger.info('Notifier stopped', {
      totalSent: this.totalSent,
      totalDropped: this.totalDropped,
      totalErrors: this.totalErrors,
    });
  }

  async destroy(): Promise<void> {
    this.channels = [];
    this.notificationTimestamps = [];
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
      message: `Sent: ${this.totalSent}, Dropped: ${this.totalDropped}, Errors: ${this.totalErrors}`,
      details: {
        totalSent: this.totalSent,
        totalDropped: this.totalDropped,
        totalErrors: this.totalErrors,
        lastError: this.lastError,
      },
      lastCheck: new Date(),
    };
  }

  // ── Event Dispatch ───────────────────────────────────────────────────────

  private async onEvent(event: OpsPilotEvent<unknown>, eventType: string): Promise<void> {
    // Rate limit check
    if (!this.checkRateLimit()) {
      this.totalDropped++;
      this.ctx.logger.warn('Notification rate limit exceeded, dropping', {
        eventType,
      });
      return;
    }

    // Find channels subscribed to this event type
    const targetChannels = this.channels.filter((ch) =>
      ch.events.includes(eventType),
    );

    for (const channel of targetChannels) {
      // Apply severity filter for incident events
      if (channel.minSeverity && eventType === 'incident.created') {
        const payload = event.payload as IncidentCreatedPayload;
        if (
          SEVERITY_ORDER[payload.severity] <
          SEVERITY_ORDER[channel.minSeverity]
        ) {
          continue;
        }
      }

      try {
        await this.sendNotification(channel, event, eventType);
        this.totalSent++;
      } catch (err) {
        this.totalErrors++;
        this.lastError = err instanceof Error ? err.message : String(err);
        this.ctx.logger.error(
          'Failed to send notification',
          err instanceof Error ? err : new Error(String(err)),
          { channelId: channel.id, eventType },
        );
      }
    }
  }

  // ── Channel Dispatch ─────────────────────────────────────────────────────

  private async sendNotification(
    channel: ChannelConfig,
    event: OpsPilotEvent<unknown>,
    eventType: string,
  ): Promise<void> {
    switch (channel.type) {
      case 'console':
        this.sendConsoleNotification(event, eventType);
        break;
      case 'webhook':
        await this.sendWebhookNotification(channel, event, eventType);
        break;
    }
  }

  // ── Console Channel ──────────────────────────────────────────────────────

  private sendConsoleNotification(event: OpsPilotEvent<unknown>, eventType: string): void {
    const timestamp = event.timestamp instanceof Date
      ? event.timestamp.toISOString()
      : String(event.timestamp);
    const ts = timestamp.replace('T', ' ').slice(0, 19);

    switch (eventType) {
      case 'incident.created': {
        const p = event.payload as IncidentCreatedPayload;
        const sevColor = p.severity === 'critical' ? '\x1b[31m' : p.severity === 'warning' ? '\x1b[33m' : '\x1b[36m';
        this.print(`\n${sevColor}🔔 INCIDENT [${p.severity.toUpperCase()}]\x1b[0m  ${ts}`);
        this.print(`   ${p.title}`);
        this.print(`   ${p.description}`);
        this.print(`   Detected by: ${p.detectedBy}  |  ID: ${p.incidentId}`);
        break;
      }

      case 'action.proposed': {
        const p = event.payload as ActionProposedPayload;
        this.print(`\n\x1b[33m⚡ ACTION PROPOSED\x1b[0m  ${ts}`);
        this.print(`   ${p.actionType}: ${p.description}`);
        this.print(`   Reasoning: ${p.reasoning}`);
        this.print(`   Request ID: ${p.requestId}`);
        this.print(`   \x1b[33m⏳ Awaiting approval...\x1b[0m`);
        break;
      }

      case 'action.approved': {
        const p = event.payload as ActionApprovedPayload;
        this.print(`\n\x1b[32m✓ ACTION APPROVED\x1b[0m  ${ts}`);
        this.print(`   Request: ${p.requestId}  |  Approved by: ${p.approvedBy}`);
        break;
      }

      case 'action.executed': {
        const p = event.payload as ActionExecutedPayload;
        const resultColor = p.result === 'success' ? '\x1b[32m' : '\x1b[31m';
        this.print(`\n${resultColor}⚙ ACTION EXECUTED [${p.result.toUpperCase()}]\x1b[0m  ${ts}`);
        this.print(`   ${p.actionType}  |  Request: ${p.requestId}`);
        if (p.output) {
          this.print(`   Output: ${p.output}`);
        }
        break;
      }

      case 'enrichment.completed': {
        const p = event.payload as EnrichmentCompletedPayload;
        this.print(`\n\x1b[36mℹ ENRICHMENT\x1b[0m  ${ts}`);
        this.print(`   ${p.enrichmentType} for incident ${p.incidentId}`);
        this.print(`   By: ${p.enricherModule}`);
        break;
      }

      default: {
        this.print(`\n📣 [${eventType}]  ${ts}  from ${event.source}`);
        const payload = event.payload;
        if (payload && typeof payload === 'object') {
          const summary = JSON.stringify(payload).slice(0, 200);
          this.print(`   ${summary}`);
        }
        break;
      }
    }
  }

  // ── Webhook Channel ──────────────────────────────────────────────────────

  private async sendWebhookNotification(
    channel: ChannelConfig,
    event: OpsPilotEvent<unknown>,
    eventType: string,
  ): Promise<void> {
    const body = JSON.stringify({
      eventType,
      source: event.source,
      timestamp: event.timestamp,
      correlationId: event.correlationId,
      payload: event.payload,
    });

    const url = channel.webhookUrl!;
    const method = channel.webhookMethod ?? 'POST';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...channel.webhookHeaders,
    };

    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(
        `Webhook ${channel.id} returned ${response.status}: ${response.statusText}`,
      );
    }

    this.ctx.logger.debug('Webhook notification sent', {
      channelId: channel.id,
      eventType,
      statusCode: response.status,
    });
  }

  // ── Rate Limiter ─────────────────────────────────────────────────────────

  private checkRateLimit(): boolean {
    const now = Date.now();
    const windowStart = now - 60_000;

    // Prune old timestamps
    this.notificationTimestamps = this.notificationTimestamps.filter(
      (ts) => ts > windowStart,
    );

    if (this.notificationTimestamps.length >= this.rateLimit) {
      return false;
    }

    this.notificationTimestamps.push(now);
    return true;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private print(msg: string): void {
    process.stdout.write(msg + '\n');
  }
}
