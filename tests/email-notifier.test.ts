// ---------------------------------------------------------------------------
// OpsPilot — notifier.email Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EmailNotifier, EmailMessage } from '../src/modules/notifier.email/index';
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

function emailContext(
  infra: ReturnType<typeof createTestInfra>,
  config: Record<string, unknown> = {},
): ModuleContext {
  return {
    moduleId: 'notifier.email',
    config: {
      smtpHost: 'smtp.test.local',
      smtpPort: 587,
      from: 'ops@test.local',
      to: ['admin@test.local'],
      subjectPrefix: '[OpsPilot]',
      events: ['incident.created', 'action.proposed', 'action.executed', 'enrichment.completed'],
      minSeverity: 'info',
      rateLimitPerMinute: 60,
      timeoutMs: 5000,
      ...config,
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'notifier.email'),
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
      incidentId: 'INC-E-001',
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
      requestId: 'REQ-E-001',
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
      requestId: 'REQ-E-001',
      tokenId: 'tok-001',
      actionType: 'restart_service',
      result,
      output: result === 'success' ? 'Service restarted' : 'Timeout',
      executedBy: 'action.executor',
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
      incidentId: 'INC-E-001',
      enrichmentType: 'log_context',
      enricherModule: 'enricher.logContext',
      data: { recentLogs: ['err1', 'err2'] },
      completedAt: new Date(),
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('notifier.email', () => {
  let notifier: EmailNotifier;
  let infra: ReturnType<typeof createTestInfra>;

  beforeEach(() => {
    infra = createTestInfra();
    notifier = new EmailNotifier();
  });

  afterEach(async () => {
    try { await notifier.stop(); } catch {}
    try { await notifier.destroy(); } catch {}
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────

  describe('Lifecycle', () => {
    it('exposes correct manifest', () => {
      assert.equal(notifier.manifest.id, 'notifier.email');
      assert.equal(notifier.manifest.type, ModuleType.Notifier);
      assert.equal(notifier.manifest.version, '1.0.0');
      assert.ok(notifier.manifest.configSchema);
    });

    it('initializes with config', async () => {
      await notifier.initialize(emailContext(infra));
      const cfg = notifier.getConfig();
      assert.equal(cfg.smtpHost, 'smtp.test.local');
      assert.equal(cfg.smtpPort, 587);
      assert.equal(cfg.from, 'ops@test.local');
      assert.deepStrictEqual(cfg.to, ['admin@test.local']);
    });

    it('applies defaults for optional fields', async () => {
      await notifier.initialize(emailContext(infra, {
        smtpPort: undefined,
        from: undefined,
        subjectPrefix: undefined,
        minSeverity: undefined,
        rateLimitPerMinute: undefined,
        timeoutMs: undefined,
      }));
      const cfg = notifier.getConfig();
      assert.equal(cfg.smtpPort, 587);
      assert.equal(cfg.from, 'opspilot@localhost');
      assert.equal(cfg.subjectPrefix, '[OpsPilot]');
      assert.equal(cfg.minSeverity, 'warning');
      assert.equal(cfg.rateLimitPerMinute, 10);
      assert.equal(cfg.timeoutMs, 30000);
    });

    it('reports healthy when no errors', async () => {
      await notifier.initialize(emailContext(infra));
      const h = notifier.health();
      assert.equal(h.status, 'healthy');
      assert.ok(h.details);
      assert.equal(h.details!.totalSent, 0);
      assert.equal(h.details!.totalErrors, 0);
    });
  });

  // ── Email Formatting ──────────────────────────────────────────────────

  describe('Email Formatting', () => {
    beforeEach(async () => {
      await notifier.initialize(emailContext(infra));
    });

    it('formats incident email with severity', () => {
      const event = makeIncidentEvent('critical');
      const msg = notifier.formatEmail(event, 'incident.created');
      assert.ok(msg.subject.includes('CRITICAL'));
      assert.ok(msg.subject.includes('High CPU Usage'));
      assert.ok(msg.html.includes('#ff0000'));
      assert.ok(msg.html.includes('INC-E-001'));
    });

    it('formats action proposed email', () => {
      const event = makeActionProposedEvent();
      const msg = notifier.formatEmail(event, 'action.proposed');
      assert.ok(msg.subject.includes('Action Proposed'));
      assert.ok(msg.subject.includes('restart_service'));
      assert.ok(msg.html.includes('REQ-E-001'));
      assert.ok(msg.html.includes('Awaiting human approval'));
    });

    it('formats action executed success email', () => {
      const event = makeActionExecutedEvent('success');
      const msg = notifier.formatEmail(event, 'action.executed');
      assert.ok(msg.subject.includes('SUCCESS'));
      assert.ok(msg.html.includes('#36a64f'));
      assert.ok(msg.html.includes('Service restarted'));
    });

    it('formats action executed failure email', () => {
      const event = makeActionExecutedEvent('failure');
      const msg = notifier.formatEmail(event, 'action.executed');
      assert.ok(msg.subject.includes('FAILURE'));
      assert.ok(msg.html.includes('#ff0000'));
    });

    it('formats enrichment email', () => {
      const event = makeEnrichmentEvent();
      const msg = notifier.formatEmail(event, 'enrichment.completed');
      assert.ok(msg.subject.includes('Enrichment'));
      assert.ok(msg.html.includes('log_context'));
      assert.ok(msg.html.includes('INC-E-001'));
    });

    it('formats generic event email', () => {
      const event: OpsPilotEvent = {
        type: 'custom.event',
        source: 'test',
        timestamp: new Date(),
        payload: { key: 'value' },
      };
      const msg = notifier.formatEmail(event, 'custom.event');
      assert.ok(msg.subject.includes('Event: custom.event'));
      assert.ok(msg.html.includes('custom.event'));
    });

    it('HTML-escapes content to prevent XSS', () => {
      const event = makeIncidentEvent('critical');
      (event.payload as IncidentCreatedPayload).title = '<script>alert("xss")</script>';
      const msg = notifier.formatEmail(event, 'incident.created');
      assert.ok(!msg.html.includes('<script>'));
      assert.ok(msg.html.includes('&lt;script&gt;'));
    });
  });

  // ── Event Emission & Delivery ────────────────────────────────────────

  describe('Event Delivery', () => {
    let sentMessages: EmailMessage[];

    beforeEach(async () => {
      sentMessages = [];
      await notifier.initialize(emailContext(infra));
      // Override sendEmail to capture without real SMTP
      notifier.sendEmail = async (msg: EmailMessage) => {
        sentMessages.push(msg);
      };
      await notifier.start();
    });

    it('sends email on incident event', async () => {
      infra.bus.publish(makeIncidentEvent());
      await sleep(30);
      assert.equal(sentMessages.length, 1);
      assert.ok(sentMessages[0].subject.includes('CRITICAL'));
      const m = notifier.getMetrics();
      assert.equal(m.totalSent, 1);
    });

    it('sends email on action proposed event', async () => {
      infra.bus.publish(makeActionProposedEvent());
      await sleep(30);
      assert.equal(sentMessages.length, 1);
      assert.ok(sentMessages[0].subject.includes('Action Proposed'));
    });

    it('ignores events not in configured list', async () => {
      const event: OpsPilotEvent = {
        type: 'action.approved',
        source: 'test',
        timestamp: new Date(),
        payload: { requestId: 'R1', approvedBy: 'admin', token: 'tok', expiresAt: new Date() },
      };
      infra.bus.publish(event);
      await sleep(30);
      assert.equal(sentMessages.length, 0);
    });
  });

  // ── Severity Filtering ───────────────────────────────────────────────

  describe('Severity Filtering', () => {
    let sentMessages: EmailMessage[];

    beforeEach(async () => {
      sentMessages = [];
      await notifier.initialize(emailContext(infra, { minSeverity: 'warning' }));
      notifier.sendEmail = async (msg: EmailMessage) => {
        sentMessages.push(msg);
      };
      await notifier.start();
    });

    it('drops info incidents when minSeverity is warning', async () => {
      infra.bus.publish(makeIncidentEvent('info'));
      await sleep(30);
      assert.equal(sentMessages.length, 0);
    });

    it('sends warning incidents when minSeverity is warning', async () => {
      infra.bus.publish(makeIncidentEvent('warning'));
      await sleep(30);
      assert.equal(sentMessages.length, 1);
    });

    it('sends critical incidents when minSeverity is warning', async () => {
      infra.bus.publish(makeIncidentEvent('critical'));
      await sleep(30);
      assert.equal(sentMessages.length, 1);
    });
  });

  // ── Rate Limiting ────────────────────────────────────────────────────

  describe('Rate Limiting', () => {
    let sentMessages: EmailMessage[];

    beforeEach(async () => {
      sentMessages = [];
      await notifier.initialize(emailContext(infra, {
        rateLimitPerMinute: 2,
        minSeverity: 'info',
      }));
      notifier.sendEmail = async (msg: EmailMessage) => {
        sentMessages.push(msg);
      };
      await notifier.start();
    });

    it('drops messages exceeding rate limit', async () => {
      // Send 3 events, limit is 2/min
      for (let i = 0; i < 3; i++) {
        infra.bus.publish(makeIncidentEvent('critical'));
        await sleep(10);
      }
      await sleep(50);
      assert.equal(sentMessages.length, 2);
      const m = notifier.getMetrics();
      assert.equal(m.totalDropped, 1);
    });
  });

  // ── Error Handling ───────────────────────────────────────────────────

  describe('Error Handling', () => {
    it('tracks errors and reports degraded health', async () => {
      await notifier.initialize(emailContext(infra, { minSeverity: 'info' }));

      // First call succeeds, second fails
      let callCount = 0;
      notifier.sendEmail = async (_msg: EmailMessage) => {
        callCount++;
        if (callCount === 2) throw new Error('SMTP connection refused');
      };
      await notifier.start();

      infra.bus.publish(makeIncidentEvent('critical'));
      await sleep(30);
      infra.bus.publish(makeIncidentEvent('critical'));
      await sleep(30);

      const m = notifier.getMetrics();
      assert.equal(m.totalSent, 1);
      assert.equal(m.totalErrors, 1);

      const h = notifier.health();
      assert.equal(h.status, 'degraded');
      assert.ok(h.message?.includes('SMTP connection refused'));
    });

    it('reports unhealthy when all sends fail', async () => {
      await notifier.initialize(emailContext(infra, { minSeverity: 'info' }));
      notifier.sendEmail = async () => {
        throw new Error('Connection timeout');
      };
      await notifier.start();

      infra.bus.publish(makeIncidentEvent('critical'));
      await sleep(30);

      const h = notifier.health();
      assert.equal(h.status, 'unhealthy');
    });
  });
});
