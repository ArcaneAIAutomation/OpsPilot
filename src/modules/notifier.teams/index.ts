// ---------------------------------------------------------------------------
// OpsPilot — notifier.teams (Microsoft Teams Webhook Notifier)
// ---------------------------------------------------------------------------
// Sends rich Adaptive Card formatted notifications to Microsoft Teams
// via Incoming Webhooks. Mirrors the notifier.slack pattern with
// Teams-native card formatting.
//
// Features:
//   - Adaptive Card formatting for rich layout
//   - Severity-based colour coding (green/orange/red accent)
//   - Minimum severity filter for incident events
//   - Per-minute rate limiting
//   - Timeout and error handling with health reporting
//   - Structured fact sets for incident/action metadata
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

interface TeamsConfig {
  webhookUrl: string;
  events: string[];
  minSeverity: IncidentSeverity;
  rateLimitPerMinute: number;
  timeoutMs: number;
  themeColor: string;
}

const DEFAULTS: Omit<TeamsConfig, 'webhookUrl'> = {
  events: [
    'incident.created',
    'action.proposed',
    'action.executed',
    'enrichment.completed',
  ],
  minSeverity: 'warning',
  rateLimitPerMinute: 30,
  timeoutMs: 10_000,
  themeColor: '',
};

// ── Severity ───────────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<string, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

const SEVERITY_COLOR: Record<string, string> = {
  info: '36a64f',       // green
  warning: 'ff9900',    // orange
  critical: 'ff0000',   // red
};

const SEVERITY_LABEL: Record<string, string> = {
  info: 'ℹ️ Info',
  warning: '⚠️ Warning',
  critical: '🚨 Critical',
};

// ── Adaptive Card Types ────────────────────────────────────────────────────

interface AdaptiveCardFact {
  name: string;
  value: string;
}

interface AdaptiveCardSection {
  activityTitle?: string;
  activitySubtitle?: string;
  activityImage?: string;
  facts?: AdaptiveCardFact[];
  text?: string;
  markdown?: boolean;
}

/** Legacy MessageCard connector payload (O365 Connector Cards). */
export interface TeamsPayload {
  '@type': 'MessageCard';
  '@context': 'https://schema.org/extensions';
  summary: string;
  themeColor: string;
  title: string;
  sections: AdaptiveCardSection[];
}

// ── Module Implementation ──────────────────────────────────────────────────

export class TeamsNotifier implements IModule {
  readonly manifest: ModuleManifest = {
    id: 'notifier.teams',
    name: 'Microsoft Teams Notifier',
    version: '1.0.0',
    type: ModuleType.Notifier,
    description: 'Sends rich notifications to Microsoft Teams via Incoming Webhooks.',
    configSchema: configSchema as Record<string, unknown>,
  };

  private ctx!: ModuleContext;
  private config!: TeamsConfig;
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
    const raw = context.config as Partial<TeamsConfig>;

    this.config = {
      webhookUrl: raw.webhookUrl!,
      events: raw.events ?? [...DEFAULTS.events],
      minSeverity: raw.minSeverity ?? DEFAULTS.minSeverity,
      rateLimitPerMinute: raw.rateLimitPerMinute ?? DEFAULTS.rateLimitPerMinute,
      timeoutMs: raw.timeoutMs ?? DEFAULTS.timeoutMs,
      themeColor: raw.themeColor ?? DEFAULTS.themeColor,
    };

    this.ctx.logger.info('Teams notifier initialized', {
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
          this.ctx.logger.error('Teams notification error', err instanceof Error ? err : undefined);
        });
      });
      this.subscriptions.push(sub);
    }

    this.ctx.logger.info('Teams notifier started', {
      subscribedTo: this.config.events,
    });
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) sub.unsubscribe();
    this.subscriptions = [];
    this.ctx.logger.info('Teams notifier stopped', {
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
      this.ctx.logger.warn('Teams rate limit exceeded, dropping', { eventType });
      return;
    }

    const card = this.formatMessage(event, eventType);
    await this.sendToTeams(card);
    this.totalSent++;
  }

  // ── Message Formatting ───────────────────────────────────────────────────

  /** Build a Teams MessageCard payload. Exported for testing. */
  formatMessage(event: OpsPilotEvent, eventType: string): TeamsPayload {
    switch (eventType) {
      case 'incident.created':
        return this.formatIncident(event.payload as IncidentCreatedPayload);
      case 'action.proposed':
        return this.formatActionProposed(event.payload as ActionProposedPayload);
      case 'action.approved':
        return this.formatActionApproved(event.payload as ActionApprovedPayload);
      case 'action.executed':
        return this.formatActionExecuted(event.payload as ActionExecutedPayload);
      case 'enrichment.completed':
        return this.formatEnrichment(event.payload as EnrichmentCompletedPayload);
      default:
        return this.formatGeneric(event, eventType);
    }
  }

  private formatIncident(p: IncidentCreatedPayload): TeamsPayload {
    const color = SEVERITY_COLOR[p.severity] ?? 'cccccc';
    const label = SEVERITY_LABEL[p.severity] ?? p.severity.toUpperCase();

    return {
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      summary: `Incident: ${p.title}`,
      themeColor: color,
      title: `${label} — ${p.title}`,
      sections: [
        {
          activityTitle: 'Incident Details',
          facts: [
            { name: 'Severity', value: p.severity.toUpperCase() },
            { name: 'Detected By', value: p.detectedBy },
            { name: 'Incident ID', value: p.incidentId },
            { name: 'Time', value: new Date(p.detectedAt).toISOString() },
          ],
          text: p.description,
          markdown: true,
        },
      ],
    };
  }

  private formatActionProposed(p: ActionProposedPayload): TeamsPayload {
    return {
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      summary: `Action Proposed: ${p.actionType}`,
      themeColor: 'ff9900',
      title: `⚡ Action Proposed: ${p.actionType}`,
      sections: [
        {
          activityTitle: 'Action Details',
          facts: [
            { name: 'Type', value: p.actionType },
            { name: 'Request ID', value: p.requestId },
            { name: 'Requested By', value: p.requestedBy },
          ],
          text: `**${p.description}**\n\n_Reasoning:_ ${p.reasoning}`,
          markdown: true,
        },
        {
          text: '⏳ _Awaiting human approval_',
          markdown: true,
        },
      ],
    };
  }

  private formatActionApproved(p: ActionApprovedPayload): TeamsPayload {
    return {
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      summary: `Action Approved: ${p.requestId}`,
      themeColor: '36a64f',
      title: `✅ Action Approved`,
      sections: [
        {
          facts: [
            { name: 'Request ID', value: p.requestId },
            { name: 'Approved By', value: p.approvedBy },
          ],
          markdown: true,
        },
      ],
    };
  }

  private formatActionExecuted(p: ActionExecutedPayload): TeamsPayload {
    const isSuccess = p.result === 'success';
    const color = isSuccess ? '36a64f' : 'ff0000';
    const icon = isSuccess ? '✅' : '❌';

    return {
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      summary: `Action ${p.result.toUpperCase()}: ${p.actionType}`,
      themeColor: color,
      title: `${icon} Action Executed [${p.result.toUpperCase()}]`,
      sections: [
        {
          activityTitle: 'Execution Details',
          facts: [
            { name: 'Type', value: p.actionType },
            { name: 'Result', value: p.result.toUpperCase() },
            { name: 'Request ID', value: p.requestId },
            { name: 'Executed By', value: p.executedBy },
          ],
          ...(p.output ? { text: `\`\`\`\n${p.output}\n\`\`\`` } : {}),
          markdown: true,
        },
      ],
    };
  }

  private formatEnrichment(p: EnrichmentCompletedPayload): TeamsPayload {
    return {
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      summary: `Enrichment completed for ${p.incidentId}`,
      themeColor: '36a64f',
      title: `🔍 Enrichment Completed`,
      sections: [
        {
          facts: [
            { name: 'Type', value: p.enrichmentType },
            { name: 'Incident', value: p.incidentId },
            { name: 'Module', value: p.enricherModule },
          ],
          markdown: true,
        },
      ],
    };
  }

  private formatGeneric(event: OpsPilotEvent, eventType: string): TeamsPayload {
    return {
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      summary: `Event: ${eventType}`,
      themeColor: 'cccccc',
      title: `🔔 ${eventType}`,
      sections: [
        {
          activityTitle: 'Event Details',
          text: `Source: ${event.source}\n\n\`\`\`\n${JSON.stringify(event.payload, null, 2).slice(0, 500)}\n\`\`\``,
          markdown: true,
        },
      ],
    };
  }

  // ── HTTP Delivery ────────────────────────────────────────────────────────

  /** Send a payload to the Teams webhook. Exposed for test mocking. */
  async sendToTeams(payload: TeamsPayload): Promise<void> {
    const body = JSON.stringify(payload);

    const response = await fetch(this.config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Teams webhook returned ${response.status}: ${text}`);
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

  getConfig(): TeamsConfig {
    return this.config;
  }

  getMetrics(): { totalSent: number; totalDropped: number; totalErrors: number } {
    return { totalSent: this.totalSent, totalDropped: this.totalDropped, totalErrors: this.totalErrors };
  }
}
