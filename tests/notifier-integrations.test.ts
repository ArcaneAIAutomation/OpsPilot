// ---------------------------------------------------------------------------
// OpsPilot — notifier.slack & notifier.pagerduty Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SlackNotifier } from '../src/modules/notifier.slack/index';
import { PagerDutyNotifier } from '../src/modules/notifier.pagerduty/index';
import { ModuleContext, ModuleType } from '../src/core/types/module';
import { NamespacedStorage } from '../src/core/storage/NamespacedStorage';
import { OpsPilotEvent } from '../src/core/types/events';
import {
  IncidentCreatedPayload,
  ActionProposedPayload,
  ActionExecutedPayload,
  EnrichmentCompletedPayload,
} from '../src/shared/events';
import { createTestInfra, sleep } from './helpers';

// ── Helpers ────────────────────────────────────────────────────────────────

function slackContext(
  infra: ReturnType<typeof createTestInfra>,
  config: Record<string, unknown> = {},
): ModuleContext {
  return {
    moduleId: 'notifier.slack',
    config: {
      webhookUrl: 'https://hooks.slack.com/test',
      events: ['incident.created', 'action.proposed', 'action.executed', 'enrichment.completed'],
      minSeverity: 'info',
      rateLimitPerMinute: 60,
      timeoutMs: 5000,
      ...config,
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'notifier.slack'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

function pdContext(
  infra: ReturnType<typeof createTestInfra>,
  config: Record<string, unknown> = {},
): ModuleContext {
  return {
    moduleId: 'notifier.pagerduty',
    config: {
      routingKey: 'test-routing-key-123',
      apiUrl: 'https://events.pagerduty.com/v2/enqueue',
      events: ['incident.created', 'action.executed'],
      minSeverity: 'info',
      rateLimitPerMinute: 60,
      timeoutMs: 5000,
      ...config,
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'notifier.pagerduty'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

function makeIncidentEvent(severity: string = 'critical'): OpsPilotEvent<IncidentCreatedPayload> {
  return {
    type: 'incident.created',
    source: 'test',
    timestamp: new Date(),
    payload: {
      incidentId: 'INC-001',
      title: 'High CPU Usage',
      description: 'CPU at 95% for 5 minutes',
      severity: severity as any,
      detectedBy: 'detector.threshold',
      detectedAt: new Date(),
      context: { host: 'web-01' },
    },
  };
}

function makeActionProposedEvent(): OpsPilotEvent<ActionProposedPayload> {
  return {
    type: 'action.proposed',
    source: 'test',
    timestamp: new Date(),
    payload: {
      requestId: 'REQ-001',
      actionType: 'restart_service',
      description: 'Restart the web service',
      reasoning: 'Service is unresponsive',
      requestedBy: 'action.safe',
    },
  };
}

function makeActionExecutedEvent(result: 'success' | 'failure' = 'success'): OpsPilotEvent<ActionExecutedPayload> {
  return {
    type: 'action.executed',
    source: 'test',
    timestamp: new Date(),
    payload: {
      requestId: 'REQ-001',
      tokenId: 'TOK-001',
      actionType: 'restart_service',
      result,
      output: result === 'success' ? 'Service restarted' : 'Permission denied',
      executedBy: 'action.safe',
      executedAt: new Date(),
    },
  };
}

function makeEnrichmentEvent(): OpsPilotEvent<EnrichmentCompletedPayload> {
  return {
    type: 'enrichment.completed',
    source: 'test',
    timestamp: new Date(),
    payload: {
      incidentId: 'INC-001',
      enricherModule: 'enricher.aiSummary',
      enrichmentType: 'ai_summary',
      data: { summary: 'CPU spike due to runaway process' },
      completedAt: new Date(),
    },
  };
}

// ── Slack Notifier Tests ───────────────────────────────────────────────────

describe('notifier.slack — Slack Notifier', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: SlackNotifier;

  beforeEach(() => {
    infra = createTestInfra();
    mod = new SlackNotifier();
  });

  afterEach(async () => {
    await mod.stop().catch(() => {});
    await mod.destroy().catch(() => {});
  });

  describe('Lifecycle', () => {
    it('has correct manifest', () => {
      assert.equal(mod.manifest.id, 'notifier.slack');
      assert.equal(mod.manifest.type, ModuleType.Notifier);
    });

    it('initializes with config', async () => {
      await mod.initialize(slackContext(infra));
      const config = mod.getConfig();
      assert.equal(config.webhookUrl, 'https://hooks.slack.com/test');
      assert.equal(config.username, 'OpsPilot');
      assert.equal(config.iconEmoji, ':robot_face:');
      assert.equal(config.minSeverity, 'info');
    });

    it('initializes with custom config', async () => {
      await mod.initialize(slackContext(infra, {
        username: 'CustomBot',
        channel: '#custom-channel',
        minSeverity: 'critical',
      }));
      const config = mod.getConfig();
      assert.equal(config.username, 'CustomBot');
      assert.equal(config.channel, '#custom-channel');
      assert.equal(config.minSeverity, 'critical');
    });

    it('reports healthy status', async () => {
      await mod.initialize(slackContext(infra));
      const h = mod.health();
      assert.equal(h.status, 'healthy');
      assert.equal(h.details!['totalSent'], 0);
    });
  });

  describe('Message Formatting', () => {
    it('formats incident.created with Block Kit', async () => {
      await mod.initialize(slackContext(infra));
      const event = makeIncidentEvent('critical');
      const msg = mod.formatMessage(event, 'incident.created');

      assert.ok(msg.text.includes('Incident'));
      assert.ok(msg.attachments);
      assert.equal(msg.attachments!.length, 1);
      assert.equal(msg.attachments![0].color, '#ff0000'); // critical = red
      assert.ok(msg.attachments![0].blocks.length >= 2);
    });

    it('formats warning incident with orange color', async () => {
      await mod.initialize(slackContext(infra));
      const event = makeIncidentEvent('warning');
      const msg = mod.formatMessage(event, 'incident.created');

      assert.equal(msg.attachments![0].color, '#ff9900');
    });

    it('formats info incident with green color', async () => {
      await mod.initialize(slackContext(infra));
      const event = makeIncidentEvent('info');
      const msg = mod.formatMessage(event, 'incident.created');

      assert.equal(msg.attachments![0].color, '#36a64f');
    });

    it('formats action.proposed', async () => {
      await mod.initialize(slackContext(infra));
      const event = makeActionProposedEvent();
      const msg = mod.formatMessage(event, 'action.proposed');

      assert.ok(msg.text.includes('Action Proposed'));
      assert.equal(msg.attachments![0].color, '#ff9900');
    });

    it('formats action.executed success', async () => {
      await mod.initialize(slackContext(infra));
      const event = makeActionExecutedEvent('success');
      const msg = mod.formatMessage(event, 'action.executed');

      assert.ok(msg.text.includes('SUCCESS'));
      assert.equal(msg.attachments![0].color, '#36a64f');
    });

    it('formats action.executed failure', async () => {
      await mod.initialize(slackContext(infra));
      const event = makeActionExecutedEvent('failure');
      const msg = mod.formatMessage(event, 'action.executed');

      assert.ok(msg.text.includes('FAILURE'));
      assert.equal(msg.attachments![0].color, '#ff0000');
    });

    it('formats enrichment.completed', async () => {
      await mod.initialize(slackContext(infra));
      const event = makeEnrichmentEvent();
      const msg = mod.formatMessage(event, 'enrichment.completed');

      assert.ok(msg.text.includes('Enrichment'));
    });

    it('formats unknown event type', async () => {
      await mod.initialize(slackContext(infra));
      const event: OpsPilotEvent = {
        type: 'custom.event',
        source: 'test',
        timestamp: new Date(),
        payload: { foo: 'bar' },
      };
      const msg = mod.formatMessage(event, 'custom.event');

      assert.ok(msg.text.includes('custom.event'));
      assert.equal(msg.attachments![0].color, '#cccccc');
    });

    it('includes channel, username, and icon', async () => {
      await mod.initialize(slackContext(infra, { channel: '#ops' }));
      const msg = mod.formatMessage(makeIncidentEvent(), 'incident.created');

      assert.equal(msg.channel, '#ops');
      assert.equal(msg.username, 'OpsPilot');
      assert.equal(msg.icon_emoji, ':robot_face:');
    });
  });

  describe('Severity Filtering', () => {
    it('drops incidents below minimum severity', async () => {
      // Override sendToSlack to track calls
      let sendCalls = 0;
      await mod.initialize(slackContext(infra, { minSeverity: 'critical' }));
      mod.sendToSlack = async () => { sendCalls++; };
      await mod.start();

      // Emit a warning incident - should be filtered
      infra.bus.publish(makeIncidentEvent('warning'));
      await sleep(50);

      assert.equal(sendCalls, 0, 'Warning should be filtered out');

      // Emit a critical incident - should pass
      infra.bus.publish(makeIncidentEvent('critical'));
      await sleep(50);

      assert.equal(sendCalls, 1, 'Critical should pass through');
    });
  });

  describe('Rate Limiting', () => {
    it('drops messages when rate limit exceeded', async () => {
      await mod.initialize(slackContext(infra, { rateLimitPerMinute: 2 }));
      mod.sendToSlack = async () => {}; // no-op

      await mod.start();

      // Send 3 messages — third should be dropped
      for (let i = 0; i < 3; i++) {
        infra.bus.publish(makeIncidentEvent());
      }
      await sleep(50);

      const metrics = mod.getMetrics();
      assert.equal(metrics.totalSent, 2);
      assert.equal(metrics.totalDropped, 1);
    });
  });
});

// ── PagerDuty Notifier Tests ───────────────────────────────────────────────

describe('notifier.pagerduty — PagerDuty Notifier', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: PagerDutyNotifier;

  beforeEach(() => {
    infra = createTestInfra();
    mod = new PagerDutyNotifier();
  });

  afterEach(async () => {
    await mod.stop().catch(() => {});
    await mod.destroy().catch(() => {});
  });

  describe('Lifecycle', () => {
    it('has correct manifest', () => {
      assert.equal(mod.manifest.id, 'notifier.pagerduty');
      assert.equal(mod.manifest.type, ModuleType.Notifier);
    });

    it('initializes with config', async () => {
      await mod.initialize(pdContext(infra));
      const config = mod.getConfig();
      assert.equal(config.routingKey, 'test-routing-key-123');
      assert.equal(config.apiUrl, 'https://events.pagerduty.com/v2/enqueue');
      assert.equal(config.dedupKeyPrefix, 'opspilot');
    });

    it('reports healthy status', async () => {
      await mod.initialize(pdContext(infra));
      const h = mod.health();
      assert.equal(h.status, 'healthy');
      assert.equal(h.details!['routingKey'], '***configured***');
    });
  });

  describe('Event Building', () => {
    it('builds trigger event for incident.created', async () => {
      await mod.initialize(pdContext(infra));
      const event = makeIncidentEvent('critical');
      const pdEvent = mod.buildPdEvent(event, 'incident.created');

      assert.ok(pdEvent);
      assert.equal(pdEvent!.event_action, 'trigger');
      assert.equal(pdEvent!.routing_key, 'test-routing-key-123');
      assert.equal(pdEvent!.dedup_key, 'opspilot-INC-001');
      assert.ok(pdEvent!.payload);
      assert.equal(pdEvent!.payload!.severity, 'critical');
      assert.ok(pdEvent!.payload!.summary.includes('High CPU Usage'));
      assert.ok(pdEvent!.payload!.custom_details);
    });

    it('filters incidents below min severity', async () => {
      await mod.initialize(pdContext(infra, { minSeverity: 'critical' }));
      const event = makeIncidentEvent('info');
      const pdEvent = mod.buildPdEvent(event, 'incident.created');

      assert.equal(pdEvent, null, 'Info incident should be filtered out');
    });

    it('builds trigger event for failed action', async () => {
      await mod.initialize(pdContext(infra));
      const event = makeActionExecutedEvent('failure');
      const pdEvent = mod.buildPdEvent(event, 'action.executed');

      assert.ok(pdEvent);
      assert.equal(pdEvent!.event_action, 'trigger');
      assert.ok(pdEvent!.payload);
      assert.equal(pdEvent!.payload!.severity, 'error');
      assert.ok(pdEvent!.payload!.summary.includes('Action failed'));
    });

    it('returns null for successful action without incidentId', async () => {
      await mod.initialize(pdContext(infra));
      const event = makeActionExecutedEvent('success');
      // Standard ActionExecutedPayload has no incidentId
      const pdEvent = mod.buildPdEvent(event, 'action.executed');

      assert.equal(pdEvent, null, 'Should skip — no incidentId to resolve');
    });

    it('builds resolve event for successful action with incidentId', async () => {
      await mod.initialize(pdContext(infra));
      const event = makeActionExecutedEvent('success');
      // Add incidentId as extended field
      (event.payload as unknown as Record<string, unknown>).incidentId = 'INC-001';
      const pdEvent = mod.buildPdEvent(event, 'action.executed');

      assert.ok(pdEvent);
      assert.equal(pdEvent!.event_action, 'resolve');
      assert.equal(pdEvent!.dedup_key, 'opspilot-INC-001');
    });

    it('builds generic trigger for unknown event types', async () => {
      await mod.initialize(pdContext(infra));
      const event: OpsPilotEvent = {
        type: 'custom.event',
        source: 'test',
        timestamp: new Date(),
        payload: { foo: 'bar' },
      };
      const pdEvent = mod.buildPdEvent(event, 'custom.event');

      assert.ok(pdEvent);
      assert.equal(pdEvent!.event_action, 'trigger');
      assert.equal(pdEvent!.payload!.severity, 'info');
    });

    it('uses configurable dedupKeyPrefix', async () => {
      await mod.initialize(pdContext(infra, { dedupKeyPrefix: 'myapp' }));
      const event = makeIncidentEvent();
      const pdEvent = mod.buildPdEvent(event, 'incident.created');

      assert.ok(pdEvent!.dedup_key!.startsWith('myapp-'));
    });

    it('includes component and group in payload', async () => {
      await mod.initialize(pdContext(infra, {
        component: 'web-server',
        group: 'production',
      }));
      const event = makeIncidentEvent();
      const pdEvent = mod.buildPdEvent(event, 'incident.created');

      assert.equal(pdEvent!.payload!.component, 'web-server');
      assert.equal(pdEvent!.payload!.group, 'production');
    });

    it('truncates summary to 1024 chars', async () => {
      await mod.initialize(pdContext(infra));
      const event = makeIncidentEvent();
      const payload = event.payload as IncidentCreatedPayload;
      payload.description = 'x'.repeat(2000);
      const pdEvent = mod.buildPdEvent(event, 'incident.created');

      assert.ok(pdEvent!.payload!.summary.length <= 1024);
    });
  });

  describe('Rate Limiting', () => {
    it('drops events when rate limit is exceeded', async () => {
      await mod.initialize(pdContext(infra, { rateLimitPerMinute: 2 }));
      mod.sendToPagerDuty = async () => ({ status: 'success', message: 'ok', dedup_key: 'test' });
      await mod.start();

      for (let i = 0; i < 3; i++) {
        infra.bus.publish(makeIncidentEvent());
      }
      await sleep(50);

      const metrics = mod.getMetrics();
      assert.equal(metrics.totalSent, 2);
      assert.equal(metrics.totalDropped, 1);
    });
  });
});
