// ---------------------------------------------------------------------------
// OpsPilot — action.escalation Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  EscalationEngine,
  EscalationState,
  IncidentEscalatedPayload,
} from '../src/modules/action.escalation/index';
import { ModuleContext } from '../src/core/types/module';
import { NamespacedStorage } from '../src/core/storage/NamespacedStorage';
import { OpsPilotEvent } from '../src/core/types/events';
import {
  IncidentCreatedPayload,
  IncidentUpdatedPayload,
  EnrichmentCompletedPayload,
} from '../src/shared/events';
import { createTestInfra, sleep } from './helpers';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeContext(
  infra: ReturnType<typeof createTestInfra>,
  config: Record<string, unknown> = {},
): ModuleContext {
  return {
    moduleId: 'action.escalation',
    config: {
      checkIntervalMs: 60000, // Large so sweep doesn't auto-fire in tests
      maxTrackedIncidents: 100,
      resolvedStatuses: ['resolved', 'closed'],
      acknowledgedPausesEscalation: true,
      policies: [
        {
          id: 'critical-policy',
          matchSeverity: ['critical'],
          levels: [
            { level: 1, afterMs: 100, notify: ['ops-team'], repeat: false },
            { level: 2, afterMs: 300, notify: ['ops-manager'], repeat: false },
            { level: 3, afterMs: 600, notify: ['vp-eng'], repeat: false },
          ],
        },
        {
          id: 'warning-policy',
          matchSeverity: ['warning'],
          levels: [
            { level: 1, afterMs: 500, notify: ['ops-team'], repeat: false },
          ],
        },
      ],
      ...config,
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'action.escalation'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

let incidentCounter = 0;

function makeIncident(
  overrides: Partial<IncidentCreatedPayload> = {},
): OpsPilotEvent<IncidentCreatedPayload> {
  const id = `INC-ESC-${++incidentCounter}`;
  return {
    type: 'incident.created',
    source: 'test',
    timestamp: new Date(),
    payload: {
      incidentId: id,
      title: 'High CPU usage on web-01',
      description: 'CPU at 95%',
      severity: 'critical',
      detectedBy: 'detector.threshold',
      detectedAt: new Date(),
      ...overrides,
    },
  };
}

function makeUpdate(
  incidentId: string,
  field: string,
  oldValue: unknown,
  newValue: unknown,
): OpsPilotEvent<IncidentUpdatedPayload> {
  return {
    type: 'incident.updated',
    source: 'test',
    timestamp: new Date(),
    payload: {
      incidentId,
      field,
      oldValue,
      newValue,
      updatedBy: 'test-operator',
      updatedAt: new Date(),
    },
  };
}

// ── Lifecycle Tests ────────────────────────────────────────────────────────

describe('action.escalation — Lifecycle', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let engine: EscalationEngine;

  beforeEach(async () => {
    infra = createTestInfra();
    engine = new EscalationEngine();
    await engine.initialize(makeContext(infra));
  });

  afterEach(async () => {
    await engine.destroy();
  });

  it('reports manifest correctly', () => {
    assert.equal(engine.manifest.id, 'action.escalation');
    assert.equal(engine.manifest.type, 'action');
  });

  it('initializes with provided config', () => {
    const cfg = engine.getConfig();
    assert.equal(cfg.policies.length, 2);
    assert.equal(cfg.checkIntervalMs, 60000);
    assert.equal(cfg.acknowledgedPausesEscalation, true);
  });

  it('reports healthy status', () => {
    const h = engine.health();
    assert.equal(h.status, 'healthy');
    assert.ok(h.details);
    assert.equal(h.details!.trackedIncidents, 0);
    assert.equal(h.details!.policies, 2);
  });

  it('starts and stops cleanly', async () => {
    await engine.start();
    await engine.stop();
  });
});

// ── Tracking Tests ─────────────────────────────────────────────────────────

describe('action.escalation — Incident Tracking', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let engine: EscalationEngine;

  beforeEach(async () => {
    infra = createTestInfra();
    engine = new EscalationEngine();
    await engine.initialize(makeContext(infra));
    await engine.start();
  });

  afterEach(async () => {
    await engine.stop();
    await engine.destroy();
  });

  it('tracks incidents matching a policy', async () => {
    const event = makeIncident({ severity: 'critical' });
    await infra.bus.publish(event);
    await sleep(20);

    assert.equal(engine.getTracked().size, 1);
    const state = engine.getTracked().get(event.payload.incidentId)!;
    assert.equal(state.policyId, 'critical-policy');
    assert.equal(state.currentLevel, 0);
    assert.equal(state.status, 'open');
  });

  it('does not track incidents with no matching policy', async () => {
    const event = makeIncident({ severity: 'info' });
    await infra.bus.publish(event);
    await sleep(20);

    assert.equal(engine.getTracked().size, 0);
  });

  it('stops tracking on resolution', async () => {
    const event = makeIncident({ severity: 'critical' });
    await infra.bus.publish(event);
    await sleep(20);
    assert.equal(engine.getTracked().size, 1);

    await infra.bus.publish(makeUpdate(event.payload.incidentId, 'status', 'open', 'resolved'));
    await sleep(20);

    assert.equal(engine.getTracked().size, 0);
    assert.equal(engine.getMetrics().totalResolved, 1);
  });

  it('stops tracking on close', async () => {
    const event = makeIncident({ severity: 'critical' });
    await infra.bus.publish(event);
    await sleep(20);

    await infra.bus.publish(makeUpdate(event.payload.incidentId, 'status', 'open', 'closed'));
    await sleep(20);

    assert.equal(engine.getTracked().size, 0);
  });
});

// ── Escalation Tests ───────────────────────────────────────────────────────

describe('action.escalation — Escalation', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let engine: EscalationEngine;

  beforeEach(async () => {
    infra = createTestInfra();
    engine = new EscalationEngine();
    await engine.initialize(makeContext(infra));
    await engine.start();
  });

  afterEach(async () => {
    await engine.stop();
    await engine.destroy();
  });

  it('escalates to level 1 after timeout', async () => {
    const escalations: OpsPilotEvent<IncidentEscalatedPayload>[] = [];
    infra.bus.subscribe<IncidentEscalatedPayload>('incident.escalated', (e) => {
      escalations.push(e);
    });

    const event = makeIncident({ severity: 'critical' });
    await infra.bus.publish(event);
    await sleep(150); // afterMs for level 1 = 100

    await engine.sweep();
    await sleep(20);

    assert.equal(escalations.length, 1);
    assert.equal(escalations[0].payload.level, 1);
    assert.deepStrictEqual(escalations[0].payload.notify, ['ops-team']);
    assert.equal(escalations[0].payload.incidentId, event.payload.incidentId);
  });

  it('escalates through multiple levels', async () => {
    const escalations: OpsPilotEvent<IncidentEscalatedPayload>[] = [];
    infra.bus.subscribe<IncidentEscalatedPayload>('incident.escalated', (e) => {
      escalations.push(e);
    });

    const event = makeIncident({ severity: 'critical' });
    await infra.bus.publish(event);

    // Wait for L1 (afterMs=100) and sweep
    await sleep(150);
    await engine.sweep();
    await sleep(20);
    assert.equal(escalations.length, 1);
    assert.equal(escalations[0].payload.level, 1);

    // Wait for L2 (afterMs=300) and sweep
    await sleep(200);
    await engine.sweep();
    await sleep(20);
    assert.equal(escalations.length, 2);
    assert.equal(escalations[1].payload.level, 2);
    assert.deepStrictEqual(escalations[1].payload.notify, ['ops-manager']);
  });

  it('escalates to level 3 after sufficient time', async () => {
    const escalations: OpsPilotEvent<IncidentEscalatedPayload>[] = [];
    infra.bus.subscribe<IncidentEscalatedPayload>('incident.escalated', (e) => {
      escalations.push(e);
    });

    const event = makeIncident({ severity: 'critical' });
    await infra.bus.publish(event);

    // Wait for all levels (L3 = 600ms)
    await sleep(650);
    await engine.sweep();
    await sleep(20);

    // Should have escalated through all 3 levels in one sweep
    assert.equal(escalations.length, 3);
    assert.equal(escalations[2].payload.level, 3);
    assert.deepStrictEqual(escalations[2].payload.notify, ['vp-eng']);
  });

  it('emits enrichment.completed on escalation', async () => {
    const enrichments: OpsPilotEvent<EnrichmentCompletedPayload>[] = [];
    infra.bus.subscribe<EnrichmentCompletedPayload>('enrichment.completed', (e) => {
      if (e.payload.enrichmentType === 'escalation') {
        enrichments.push(e);
      }
    });

    const event = makeIncident({ severity: 'critical' });
    await infra.bus.publish(event);
    await sleep(150);
    await engine.sweep();
    await sleep(20);

    assert.equal(enrichments.length, 1);
    assert.equal(enrichments[0].payload.enricherModule, 'action.escalation');
    assert.equal(enrichments[0].payload.data.level, 1);
  });

  it('does not double-escalate the same level', async () => {
    const escalations: OpsPilotEvent<IncidentEscalatedPayload>[] = [];
    infra.bus.subscribe<IncidentEscalatedPayload>('incident.escalated', (e) => {
      escalations.push(e);
    });

    const event = makeIncident({ severity: 'critical' });
    await infra.bus.publish(event);
    await sleep(150);

    await engine.sweep();
    await sleep(20);
    await engine.sweep(); // second sweep at same level
    await sleep(20);

    // Should only have escalated once to level 1 (repeat = false)
    assert.equal(escalations.length, 1);
  });
});

// ── Acknowledgement Tests ──────────────────────────────────────────────────

describe('action.escalation — Acknowledgement', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let engine: EscalationEngine;

  beforeEach(async () => {
    infra = createTestInfra();
    engine = new EscalationEngine();
    await engine.initialize(makeContext(infra));
    await engine.start();
  });

  afterEach(async () => {
    await engine.stop();
    await engine.destroy();
  });

  it('pauses escalation when acknowledged (default config)', async () => {
    const escalations: OpsPilotEvent<IncidentEscalatedPayload>[] = [];
    infra.bus.subscribe<IncidentEscalatedPayload>('incident.escalated', (e) => {
      escalations.push(e);
    });

    const event = makeIncident({ severity: 'critical' });
    await infra.bus.publish(event);
    await sleep(20);

    // Acknowledge before escalation timer fires
    await infra.bus.publish(makeUpdate(
      event.payload.incidentId, 'status', 'open', 'acknowledged',
    ));
    await sleep(150); // Past L1 afterMs

    await engine.sweep();
    await sleep(20);

    // Should NOT have escalated because acknowledgement pauses timers
    assert.equal(escalations.length, 0);
    const state = engine.getTracked().get(event.payload.incidentId)!;
    assert.equal(state.status, 'acknowledged');
  });

  it('does not pause escalation when acknowledgedPausesEscalation=false', async () => {
    await engine.stop();
    await engine.destroy();

    engine = new EscalationEngine();
    await engine.initialize(makeContext(infra, {
      acknowledgedPausesEscalation: false,
    }));
    await engine.start();

    const escalations: OpsPilotEvent<IncidentEscalatedPayload>[] = [];
    infra.bus.subscribe<IncidentEscalatedPayload>('incident.escalated', (e) => {
      escalations.push(e);
    });

    const event = makeIncident({ severity: 'critical' });
    await infra.bus.publish(event);
    await sleep(20);

    // Acknowledge
    await infra.bus.publish(makeUpdate(
      event.payload.incidentId, 'status', 'open', 'acknowledged',
    ));
    await sleep(150);

    await engine.sweep();
    await sleep(20);

    // SHOULD have escalated despite acknowledgement
    assert.equal(escalations.length, 1);
  });
});

// ── Policy Matching Tests ──────────────────────────────────────────────────

describe('action.escalation — Policy Matching', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let engine: EscalationEngine;

  afterEach(async () => {
    await engine.stop();
    await engine.destroy();
  });

  it('matches by title pattern', async () => {
    infra = createTestInfra();
    engine = new EscalationEngine();
    await engine.initialize(makeContext(infra, {
      policies: [
        {
          id: 'title-match',
          matchTitlePattern: 'database',
          levels: [
            { level: 1, afterMs: 100, notify: ['dba-team'], repeat: false },
          ],
        },
      ],
    }));
    await engine.start();

    const dbEvent = makeIncident({ title: 'Database connection timeout', severity: 'warning' });
    const cpuEvent = makeIncident({ title: 'CPU spike', severity: 'warning' });

    await infra.bus.publish(dbEvent);
    await sleep(20);
    await infra.bus.publish(cpuEvent);
    await sleep(20);

    // Only the database incident should be tracked
    assert.equal(engine.getTracked().size, 1);
    assert.ok(engine.getTracked().has(dbEvent.payload.incidentId));
    assert.equal(engine.getTracked().get(dbEvent.payload.incidentId)!.policyId, 'title-match');
  });

  it('matches first policy when multiple could match', async () => {
    infra = createTestInfra();
    engine = new EscalationEngine();
    await engine.initialize(makeContext(infra, {
      policies: [
        {
          id: 'first-policy',
          matchSeverity: ['critical'],
          levels: [
            { level: 1, afterMs: 100, notify: ['team-a'], repeat: false },
          ],
        },
        {
          id: 'second-policy',
          matchSeverity: ['critical'],
          levels: [
            { level: 1, afterMs: 200, notify: ['team-b'], repeat: false },
          ],
        },
      ],
    }));
    await engine.start();

    const event = makeIncident({ severity: 'critical' });
    await infra.bus.publish(event);
    await sleep(20);

    const state = engine.getTracked().get(event.payload.incidentId)!;
    assert.equal(state.policyId, 'first-policy');
  });

  it('combined severity + title matching', async () => {
    infra = createTestInfra();
    engine = new EscalationEngine();
    await engine.initialize(makeContext(infra, {
      policies: [
        {
          id: 'combined',
          matchSeverity: ['critical'],
          matchTitlePattern: 'disk',
          levels: [
            { level: 1, afterMs: 100, notify: ['storage-team'], repeat: false },
          ],
        },
      ],
    }));
    await engine.start();

    // Critical + disk title → match
    const matchEvent = makeIncident({ severity: 'critical', title: 'Disk space low' });
    await infra.bus.publish(matchEvent);
    await sleep(20);
    assert.equal(engine.getTracked().size, 1);

    // Critical + wrong title → no match
    const noMatch1 = makeIncident({ severity: 'critical', title: 'CPU high' });
    await infra.bus.publish(noMatch1);
    await sleep(20);
    assert.equal(engine.getTracked().size, 1); // Still just 1

    // Warning + disk title → no match
    const noMatch2 = makeIncident({ severity: 'warning', title: 'Disk cleanup needed' });
    await infra.bus.publish(noMatch2);
    await sleep(20);
    assert.equal(engine.getTracked().size, 1); // Still just 1
  });
});

// ── Repeat Notification Tests ──────────────────────────────────────────────

describe('action.escalation — Repeat Notifications', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let engine: EscalationEngine;

  afterEach(async () => {
    await engine.stop();
    await engine.destroy();
  });

  it('sends repeated notifications at configured interval', async () => {
    infra = createTestInfra();
    engine = new EscalationEngine();
    await engine.initialize(makeContext(infra, {
      policies: [
        {
          id: 'repeat-policy',
          matchSeverity: ['critical'],
          levels: [
            {
              level: 1,
              afterMs: 50,
              notify: ['ops-team'],
              repeat: true,
              repeatIntervalMs: 100,
            },
          ],
        },
      ],
    }));
    await engine.start();

    const escalations: OpsPilotEvent<IncidentEscalatedPayload>[] = [];
    infra.bus.subscribe<IncidentEscalatedPayload>('incident.escalated', (e) => {
      escalations.push(e);
    });

    const event = makeIncident({ severity: 'critical' });
    await infra.bus.publish(event);

    // First escalation
    await sleep(100);
    await engine.sweep();
    await sleep(20);
    assert.equal(escalations.length, 1);

    // Wait for repeat interval
    await sleep(150);
    await engine.sweep();
    await sleep(20);
    assert.equal(escalations.length, 2);
  });
});

// ── Capacity Tests ─────────────────────────────────────────────────────────

describe('action.escalation — Capacity', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let engine: EscalationEngine;

  afterEach(async () => {
    await engine.stop();
    await engine.destroy();
  });

  it('evicts oldest tracked incident when capacity is exceeded', async () => {
    infra = createTestInfra();
    engine = new EscalationEngine();
    await engine.initialize(makeContext(infra, {
      maxTrackedIncidents: 3,
    }));
    await engine.start();

    const events: OpsPilotEvent<IncidentCreatedPayload>[] = [];
    for (let i = 0; i < 4; i++) {
      const e = makeIncident({ severity: 'critical', title: `Incident ${i}` });
      events.push(e);
      await infra.bus.publish(e);
      await sleep(20);
    }

    assert.equal(engine.getTracked().size, 3);
    // The first (oldest) should have been evicted
    assert.ok(!engine.getTracked().has(events[0].payload.incidentId));
    // The last 3 should remain
    assert.ok(engine.getTracked().has(events[1].payload.incidentId));
    assert.ok(engine.getTracked().has(events[2].payload.incidentId));
    assert.ok(engine.getTracked().has(events[3].payload.incidentId));
  });
});

// ── Metrics Tests ──────────────────────────────────────────────────────────

describe('action.escalation — Metrics', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let engine: EscalationEngine;

  beforeEach(async () => {
    infra = createTestInfra();
    engine = new EscalationEngine();
    await engine.initialize(makeContext(infra));
    await engine.start();
  });

  afterEach(async () => {
    await engine.stop();
    await engine.destroy();
  });

  it('tracks comprehensive metrics', async () => {
    // Create and escalate one incident
    const event = makeIncident({ severity: 'critical' });
    await infra.bus.publish(event);
    await sleep(150);
    await engine.sweep();
    await sleep(20);

    // Resolve it
    await infra.bus.publish(makeUpdate(event.payload.incidentId, 'status', 'open', 'resolved'));
    await sleep(20);

    const metrics = engine.getMetrics();
    assert.equal(metrics.totalTracked, 1);
    assert.equal(metrics.totalEscalations, 1);
    assert.equal(metrics.totalResolved, 1);
    assert.equal(metrics.activeTracked, 0);
  });
});
