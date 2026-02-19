// ---------------------------------------------------------------------------
// OpsPilot — notifier.teams Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { TeamsNotifier, TeamsPayload } from '../src/modules/notifier.teams/index';
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

function teamsContext(
  infra: ReturnType<typeof createTestInfra>,
  config: Record<string, unknown> = {},
): ModuleContext {
  return {
    moduleId: 'notifier.teams',
    config: {
      webhookUrl: 'https://outlook.office.com/webhook/test',
      events: ['incident.created', 'action.proposed', 'action.executed', 'enrichment.completed'],
      minSeverity: 'info',
      rateLimitPerMinute: 60,
      timeoutMs: 5000,
      ...config,
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'notifier.teams'),
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
      incidentId: 'INC-T-001',
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
      requestId: 'REQ-T-001',
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
      requestId: 'REQ-T-001',
      tokenId: 'TOK-T-001',
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
      incidentId: 'INC-T-001',
      enricherModule: 'enricher.aiSummary',
      enrichmentType: 'ai_summary',
      data: { summary: 'CPU spike due to runaway process' },
      completedAt: new Date(),
    },
  };
}

// ── Lifecycle Tests ────────────────────────────────────────────────────────

describe('notifier.teams — Lifecycle', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: TeamsNotifier;

  beforeEach(() => {
    infra = createTestInfra();
    mod = new TeamsNotifier();
  });

  afterEach(async () => {
    await mod.stop().catch(() => {});
    await mod.destroy().catch(() => {});
  });

  it('has correct manifest', () => {
    assert.equal(mod.manifest.id, 'notifier.teams');
    assert.equal(mod.manifest.type, ModuleType.Notifier);
  });

  it('initializes with config', async () => {
    await mod.initialize(teamsContext(infra));
    const config = mod.getConfig();
    assert.equal(config.webhookUrl, 'https://outlook.office.com/webhook/test');
    assert.equal(config.minSeverity, 'info');
    assert.equal(config.rateLimitPerMinute, 60);
  });

  it('initializes with custom config', async () => {
    await mod.initialize(teamsContext(infra, {
      minSeverity: 'critical',
      rateLimitPerMinute: 10,
    }));
    const config = mod.getConfig();
    assert.equal(config.minSeverity, 'critical');
    assert.equal(config.rateLimitPerMinute, 10);
  });

  it('reports healthy status', async () => {
    await mod.initialize(teamsContext(infra));
    const h = mod.health();
    assert.equal(h.status, 'healthy');
    assert.ok(h.details);
    assert.equal(h.details!.totalSent, 0);
    assert.equal(h.details!.webhookUrl, '***configured***');
  });

  it('starts and stops cleanly', async () => {
    await mod.initialize(teamsContext(infra));
    await mod.start();
    await mod.stop();
  });
});

// ── Message Formatting Tests ───────────────────────────────────────────────

describe('notifier.teams — Message Formatting', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: TeamsNotifier;

  beforeEach(async () => {
    infra = createTestInfra();
    mod = new TeamsNotifier();
    await mod.initialize(teamsContext(infra));
  });

  afterEach(async () => {
    await mod.destroy().catch(() => {});
  });

  it('formats incident.created with severity color', () => {
    const msg = mod.formatMessage(makeIncidentEvent('critical'), 'incident.created');

    assert.equal(msg['@type'], 'MessageCard');
    assert.equal(msg.themeColor, 'ff0000'); // critical = red
    assert.ok(msg.title.includes('High CPU Usage'));
    assert.ok(msg.summary.includes('Incident'));
    assert.equal(msg.sections.length, 1);
    assert.ok(msg.sections[0].facts!.length >= 4);
  });

  it('formats warning incident with orange color', () => {
    const msg = mod.formatMessage(makeIncidentEvent('warning'), 'incident.created');
    assert.equal(msg.themeColor, 'ff9900');
  });

  it('formats info incident with green color', () => {
    const msg = mod.formatMessage(makeIncidentEvent('info'), 'incident.created');
    assert.equal(msg.themeColor, '36a64f');
  });

  it('formats action.proposed', () => {
    const msg = mod.formatMessage(makeActionProposedEvent(), 'action.proposed');

    assert.ok(msg.title.includes('Action Proposed'));
    assert.equal(msg.themeColor, 'ff9900');
    assert.ok(msg.sections.length >= 1);
    assert.ok(msg.sections[0].facts!.some((f) => f.name === 'Type' && f.value === 'restart_service'));
  });

  it('formats action.executed success', () => {
    const msg = mod.formatMessage(makeActionExecutedEvent('success'), 'action.executed');

    assert.ok(msg.title.includes('SUCCESS'));
    assert.equal(msg.themeColor, '36a64f');
  });

  it('formats action.executed failure', () => {
    const msg = mod.formatMessage(makeActionExecutedEvent('failure'), 'action.executed');

    assert.ok(msg.title.includes('FAILURE'));
    assert.equal(msg.themeColor, 'ff0000');
  });

  it('formats enrichment.completed', () => {
    const msg = mod.formatMessage(makeEnrichmentEvent(), 'enrichment.completed');

    assert.ok(msg.title.includes('Enrichment'));
    assert.equal(msg.themeColor, '36a64f');
    assert.ok(msg.sections[0].facts!.some((f) => f.name === 'Incident' && f.value === 'INC-T-001'));
  });

  it('formats unknown event type as generic', () => {
    const event: OpsPilotEvent = {
      type: 'custom.event',
      source: 'test',
      timestamp: new Date(),
      payload: { foo: 'bar' },
    };
    const msg = mod.formatMessage(event, 'custom.event');

    assert.ok(msg.title.includes('custom.event'));
    assert.equal(msg.themeColor, 'cccccc');
  });

  it('includes incident facts correctly', () => {
    const msg = mod.formatMessage(makeIncidentEvent('critical'), 'incident.created');
    const facts = msg.sections[0].facts!;

    const severityFact = facts.find((f) => f.name === 'Severity');
    assert.ok(severityFact);
    assert.equal(severityFact!.value, 'CRITICAL');

    const detectedByFact = facts.find((f) => f.name === 'Detected By');
    assert.ok(detectedByFact);
    assert.equal(detectedByFact!.value, 'detector.threshold');

    const idFact = facts.find((f) => f.name === 'Incident ID');
    assert.ok(idFact);
    assert.equal(idFact!.value, 'INC-T-001');
  });
});

// ── Severity Filtering Tests ───────────────────────────────────────────────

describe('notifier.teams — Severity Filtering', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: TeamsNotifier;

  afterEach(async () => {
    await mod.stop().catch(() => {});
    await mod.destroy().catch(() => {});
  });

  it('drops incidents below minimum severity', async () => {
    infra = createTestInfra();
    mod = new TeamsNotifier();
    await mod.initialize(teamsContext(infra, { minSeverity: 'critical' }));

    let sendCalls = 0;
    mod.sendToTeams = async () => { sendCalls++; };
    await mod.start();

    // Warning should be filtered
    infra.bus.publish(makeIncidentEvent('warning'));
    await sleep(50);
    assert.equal(sendCalls, 0, 'Warning should be filtered');

    // Critical should pass
    infra.bus.publish(makeIncidentEvent('critical'));
    await sleep(50);
    assert.equal(sendCalls, 1, 'Critical should pass through');
  });

  it('allows non-incident events regardless of severity', async () => {
    infra = createTestInfra();
    mod = new TeamsNotifier();
    await mod.initialize(teamsContext(infra, { minSeverity: 'critical' }));

    let sendCalls = 0;
    mod.sendToTeams = async () => { sendCalls++; };
    await mod.start();

    // Enrichment event should not be filtered by severity
    infra.bus.publish(makeEnrichmentEvent());
    await sleep(50);
    assert.equal(sendCalls, 1, 'Enrichment should pass through');
  });
});

// ── Rate Limiting Tests ────────────────────────────────────────────────────

describe('notifier.teams — Rate Limiting', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: TeamsNotifier;

  afterEach(async () => {
    await mod.stop().catch(() => {});
    await mod.destroy().catch(() => {});
  });

  it('drops messages when rate limit exceeded', async () => {
    infra = createTestInfra();
    mod = new TeamsNotifier();
    await mod.initialize(teamsContext(infra, { rateLimitPerMinute: 2 }));
    mod.sendToTeams = async () => {}; // no-op
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

// ── Error Handling Tests ───────────────────────────────────────────────────

describe('notifier.teams — Error Handling', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: TeamsNotifier;

  afterEach(async () => {
    await mod.stop().catch(() => {});
    await mod.destroy().catch(() => {});
  });

  it('tracks errors and reports degraded health', async () => {
    infra = createTestInfra();
    mod = new TeamsNotifier();
    await mod.initialize(teamsContext(infra));

    // Mock sendToTeams to fail once, then succeed
    let callCount = 0;
    mod.sendToTeams = async () => {
      callCount++;
      if (callCount === 1) throw new Error('Network error');
    };
    await mod.start();

    // First: will error
    infra.bus.publish(makeIncidentEvent());
    await sleep(50);

    // Second: will succeed
    infra.bus.publish(makeIncidentEvent());
    await sleep(50);

    const metrics = mod.getMetrics();
    assert.equal(metrics.totalErrors, 1);
    assert.equal(metrics.totalSent, 1);

    const h = mod.health();
    assert.equal(h.status, 'degraded');
    assert.equal(h.message, 'Network error');
  });

  it('reports unhealthy when all sends fail', async () => {
    infra = createTestInfra();
    mod = new TeamsNotifier();
    await mod.initialize(teamsContext(infra));

    mod.sendToTeams = async () => { throw new Error('fail'); };
    await mod.start();

    infra.bus.publish(makeIncidentEvent());
    await sleep(50);

    const h = mod.health();
    assert.equal(h.status, 'unhealthy');
  });
});
