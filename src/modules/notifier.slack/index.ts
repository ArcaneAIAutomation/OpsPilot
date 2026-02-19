// ---------------------------------------------------------------------------
// OpsPilot — notifier.slack (Slack Webhook Notifier)
// ---------------------------------------------------------------------------
// Sends rich Block Kit formatted notifications to Slack via Incoming
// Webhooks. Supports all major OpsPilot event types with colour-coded
// severity, structured fields, and action buttons context.
//
// Features:
//   - Slack Block Kit formatting for rich layout
//   - Severity-based colour coding (green/yellow/red sidebars)
//   - Minimum severity filter for incident events
//   - Per-minute rate limiting
//   - Configurable channel, username, icon override
//   - Timeout and error handling with health reporting
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

// ── Config ─────────────────────────────────────────────────────────────────

interface SlackConfig {
  webhookUrl: string;
  channel?: string;
  username: string;
  iconEmoji: string;
  events: string[];
  minSeverity: IncidentSeverity;
  rateLimitPerMinute: number;
  timeoutMs: number;
}

const DEFAULTS: Omit<SlackConfig, 'webhookUrl'> = {
  username: 'OpsPilot',
  iconEmoji: ':robot_face:',
  events: [
    'incident.created',
    'action.proposed',
    'action.approved',
    'action.executed',
    'enrichment.completed',
  ],
  minSeverity: 'warning',
  rateLimitPerMinute: 30,
  timeoutMs: 10_000,
};

// ── Severity ───────────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<string, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

const SEVERITY_COLOR: Record<string, string> = {
  info: '#36a64f',      // green
  warning: '#ff9900',   // orange
  critical: '#ff0000',  // red
};

const SEVERITY_EMOJI: Record<string, string> = {
  info: ':information_source:',
  warning: ':warning:',
  critical: ':rotating_light:',
};

// ── Slack Block Kit Types ──────────────────────────────────────────────────

interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  fields?: Array<{ type: string; text: string }>;
  elements?: Array<{ type: string; text: string }>;
}

interface SlackAttachment {
  color: string;
  blocks: SlackBlock[];
  fallback?: string;
}

interface SlackPayload {
  username?: string;
  icon_emoji?: string;
  channel?: string;
  text: string;
  attachments?: SlackAttachment[];
}

// ── Module Implementation ──────────────────────────────────────────────────

export class SlackNotifier implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'notifier.slack',
    name: 'Slack Notifier',
    version: '1.0.0',
    type: ModuleType.Notifier,
    description: 'Sends rich notifications to Slack via Incoming Webhooks.',
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private config!: SlackConfig;
  private subscriptions: EventSubscription[] = [];

  // Rate limiter
  private timestamps: number[] = [];

  // Metrics
  private totalSent = 0;
  private totalDropped = 0;
  private totalErrors = 0;
  private lastError?: string;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(context: ModuleContext): Promise<void> {
    this.ctx = context;
    const raw = context.config as Partial<SlackConfig>;

    this.config = {
      webhookUrl: raw.webhookUrl!,
      channel: raw.channel,
      username: raw.username ?? DEFAULTS.username,
      iconEmoji: raw.iconEmoji ?? DEFAULTS.iconEmoji,
      events: raw.events ?? [...DEFAULTS.events],
      minSeverity: raw.minSeverity ?? DEFAULTS.minSeverity,
      rateLimitPerMinute: raw.rateLimitPerMinute ?? DEFAULTS.rateLimitPerMinute,
      timeoutMs: raw.timeoutMs ?? DEFAULTS.timeoutMs,
    };

    this.ctx.logger.info('Slack notifier initialized', {
      channel: this.config.channel,
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
          this.ctx.logger.error('Slack notification error', err instanceof Error ? err : undefined);
        });
      });
      this.subscriptions.push(sub);
    }

    this.ctx.logger.info('Slack notifier started', {
      subscribedTo: this.config.events,
    });
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) sub.unsubscribe();
    this.subscriptions = [];
    this.ctx.logger.info('Slack notifier stopped', {
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
        webhookUrl: this.config?.webhookUrl ? '***configured***' : 'missing',
      },
      lastCheck: new Date(),
    };
  }

  // ── Event Handling ───────────────────────────────────────────────────────

  private async onEvent(event: OpsPilotEvent, eventType: string): Promise<void> {
    // Severity filter for incidents
    if (eventType === 'incident.created') {
      const payload = event.payload as IncidentCreatedPayload;
      if (SEVERITY_ORDER[payload.severity] < SEVERITY_ORDER[this.config.minSeverity]) {
        return;
      }
    }

    // Rate limit
    if (!this.checkRateLimit()) {
      this.totalDropped++;
      this.ctx.logger.warn('Slack rate limit exceeded, dropping', { eventType });
      return;
    }

    const slackPayload = this.formatMessage(event, eventType);
    await this.sendToSlack(slackPayload);
    this.totalSent++;
  }

  // ── Message Formatting ───────────────────────────────────────────────────

  /** Build a Slack Block Kit payload for the given event. Exported for testing. */
  formatMessage(event: OpsPilotEvent, eventType: string): SlackPayload {
    const base: SlackPayload = {
      username: this.config.username,
      icon_emoji: this.config.iconEmoji,
      channel: this.config.channel,
      text: `[${eventType}] from ${event.source}`,
    };

    switch (eventType) {
      case 'incident.created':
        return this.formatIncident(base, event.payload as IncidentCreatedPayload);
      case 'action.proposed':
        return this.formatActionProposed(base, event.payload as ActionProposedPayload);
      case 'action.approved':
        return this.formatActionApproved(base, event.payload as ActionApprovedPayload);
      case 'action.executed':
        return this.formatActionExecuted(base, event.payload as ActionExecutedPayload);
      case 'enrichment.completed':
        return this.formatEnrichment(base, event.payload as EnrichmentCompletedPayload);
      default:
        return this.formatGeneric(base, event, eventType);
    }
  }

  private formatIncident(base: SlackPayload, p: IncidentCreatedPayload): SlackPayload {
    const emoji = SEVERITY_EMOJI[p.severity] ?? ':bell:';
    const color = SEVERITY_COLOR[p.severity] ?? '#cccccc';

    base.text = `${emoji} Incident: ${p.title}`;
    base.attachments = [{
      color,
      fallback: `[${p.severity.toUpperCase()}] ${p.title}: ${p.description}`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: `${emoji} ${p.title}`, emoji: true },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: p.description },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Severity:*\n${p.severity.toUpperCase()}` },
            { type: 'mrkdwn', text: `*Detected By:*\n${p.detectedBy}` },
            { type: 'mrkdwn', text: `*Incident ID:*\n\`${p.incidentId}\`` },
            { type: 'mrkdwn', text: `*Time:*\n${new Date(p.detectedAt).toISOString()}` },
          ],
        },
      ],
    }];

    return base;
  }

  private formatActionProposed(base: SlackPayload, p: ActionProposedPayload): SlackPayload {
    base.text = `:zap: Action Proposed: ${p.actionType}`;
    base.attachments = [{
      color: '#ff9900',
      fallback: `Action proposed: ${p.actionType} - ${p.description}`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: ':zap: Action Proposed', emoji: true },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*${p.actionType}*: ${p.description}` },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Reasoning:*\n${p.reasoning}` },
            { type: 'mrkdwn', text: `*Request ID:*\n\`${p.requestId}\`` },
            { type: 'mrkdwn', text: `*Requested By:*\n${p.requestedBy}` },
          ],
        },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: ':hourglass: _Awaiting human approval_' },
          ],
        },
      ],
    }];

    return base;
  }

  private formatActionApproved(base: SlackPayload, p: ActionApprovedPayload): SlackPayload {
    base.text = `:white_check_mark: Action Approved: ${p.requestId}`;
    base.attachments = [{
      color: '#36a64f',
      fallback: `Action approved: ${p.requestId} by ${p.approvedBy}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:white_check_mark: *Action Approved*\nRequest \`${p.requestId}\` approved by *${p.approvedBy}*`,
          },
        },
      ],
    }];

    return base;
  }

  private formatActionExecuted(base: SlackPayload, p: ActionExecutedPayload): SlackPayload {
    const isSuccess = p.result === 'success';
    const emoji = isSuccess ? ':gear:' : ':x:';
    const color = isSuccess ? '#36a64f' : '#ff0000';

    base.text = `${emoji} Action Executed: ${p.actionType} [${p.result.toUpperCase()}]`;
    base.attachments = [{
      color,
      fallback: `Action ${p.result}: ${p.actionType}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${emoji} *Action Executed [${p.result.toUpperCase()}]*\n*Type:* ${p.actionType}  |  *Request:* \`${p.requestId}\``,
          },
        },
        ...(p.output ? [{
          type: 'section',
          text: { type: 'mrkdwn', text: `*Output:*\n\`\`\`${p.output}\`\`\`` },
        }] : []),
      ],
    }];

    return base;
  }

  private formatEnrichment(base: SlackPayload, p: EnrichmentCompletedPayload): SlackPayload {
    base.text = `:mag: Enrichment completed for incident ${p.incidentId}`;
    base.attachments = [{
      color: '#36a64f',
      fallback: `Enrichment ${p.enrichmentType} completed`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:mag: *Enrichment Completed*\n*Type:* ${p.enrichmentType}  |  *Incident:* \`${p.incidentId}\`\n*By:* ${p.enricherModule}`,
          },
        },
      ],
    }];

    return base;
  }

  private formatGeneric(base: SlackPayload, event: OpsPilotEvent, eventType: string): SlackPayload {
    base.text = `:bell: [${eventType}] from ${event.source}`;
    base.attachments = [{
      color: '#cccccc',
      fallback: `Event: ${eventType}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:bell: *${eventType}*\nSource: ${event.source}\n\`\`\`${JSON.stringify(event.payload, null, 2).slice(0, 500)}\`\`\``,
          },
        },
      ],
    }];

    return base;
  }

  // ── HTTP Delivery ────────────────────────────────────────────────────────

  /** Send a payload to the Slack webhook. Exposed for test mocking. */
  async sendToSlack(payload: SlackPayload): Promise<void> {
    const body = JSON.stringify(payload);

    const response = await fetch(this.config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Slack webhook returned ${response.status}: ${text}`);
    }
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

  getConfig(): SlackConfig {
    return this.config;
  }

  getMetrics(): { totalSent: number; totalDropped: number; totalErrors: number } {
    return { totalSent: this.totalSent, totalDropped: this.totalDropped, totalErrors: this.totalErrors };
  }
}
