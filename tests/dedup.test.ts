// ---------------------------------------------------------------------------
// OpsPilot — enricher.dedup Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DedupEnricher,
  FingerprintEntry,
  IncidentSuppressedPayload,
  computeFingerprint,
} from '../src/modules/enricher.dedup/index';
import { ModuleContext } from '../src/core/types/module';
import { NamespacedStorage } from '../src/core/storage/NamespacedStorage';
import { OpsPilotEvent } from '../src/core/types/events';
import {
  IncidentCreatedPayload,
  EnrichmentCompletedPayload,
} from '../src/shared/events';
import { createTestInfra, sleep } from './helpers';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeContext(
  infra: ReturnType<typeof createTestInfra>,
  config: Record<string, unknown> = {},
): ModuleContext {
  return {
    moduleId: 'enricher.dedup',
    config: {
      windowMs: 5000,
      fingerprintFields: ['title', 'severity', 'detectedBy'],
      maxFingerprints: 100,
      emitSuppressed: true,
      ...config,
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'enricher.dedup'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

let incidentCounter = 0;

function makeIncident(
  overrides: Partial<IncidentCreatedPayload> = {},
): OpsPilotEvent<IncidentCreatedPayload> {
  const id = `INC-DEDUP-${++incidentCounter}`;
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

// ── computeFingerprint Tests ───────────────────────────────────────────────

describe('enricher.dedup — computeFingerprint()', () => {
  it('produces the same hash for identical field values', () => {
    const a: IncidentCreatedPayload = {
      incidentId: 'a',
      title: 'Server down',
      description: 'Cannot connect',
      severity: 'critical',
      detectedBy: 'detector.regex',
      detectedAt: new Date(),
    };
    const b: IncidentCreatedPayload = {
      incidentId: 'b',
      title: 'Server down',
      description: 'Different description',
      severity: 'critical',
      detectedBy: 'detector.regex',
      detectedAt: new Date(),
    };
    const fields = ['title', 'severity', 'detectedBy'];
    assert.equal(computeFingerprint(a, fields), computeFingerprint(b, fields));
  });

  it('produces different hashes when any field differs', () => {
    const a: IncidentCreatedPayload = {
      incidentId: 'a',
      title: 'Server down',
      description: 'desc',
      severity: 'critical',
      detectedBy: 'detector.regex',
      detectedAt: new Date(),
    };
    const b: IncidentCreatedPayload = {
      incidentId: 'b',
      title: 'Server down',
      description: 'desc',
      severity: 'warning',
      detectedBy: 'detector.regex',
      detectedAt: new Date(),
    };
    const fields = ['title', 'severity', 'detectedBy'];
    assert.notEqual(computeFingerprint(a, fields), computeFingerprint(b, fields));
  });

  it('uses all specified fields including description', () => {
    const a: IncidentCreatedPayload = {
      incidentId: 'a',
      title: 'Alert',
      description: 'Desc A',
      severity: 'info',
      detectedBy: 'test',
      detectedAt: new Date(),
    };
    const b: IncidentCreatedPayload = {
      incidentId: 'b',
      title: 'Alert',
      description: 'Desc B',
      severity: 'info',
      detectedBy: 'test',
      detectedAt: new Date(),
    };
    const fields = ['title', 'severity', 'detectedBy', 'description'];
    assert.notEqual(computeFingerprint(a, fields), computeFingerprint(b, fields));
  });

  it('returns a 64-char hex SHA-256 digest', () => {
    const payload: IncidentCreatedPayload = {
      incidentId: 'x',
      title: 'Test',
      description: '',
      severity: 'info',
      detectedBy: 'test',
      detectedAt: new Date(),
    };
    const fp = computeFingerprint(payload, ['title']);
    assert.match(fp, /^[a-f0-9]{64}$/);
  });
});

// ── Module Lifecycle Tests ─────────────────────────────────────────────────

describe('enricher.dedup — Lifecycle', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let dedup: DedupEnricher;

  beforeEach(async () => {
    infra = createTestInfra();
    dedup = new DedupEnricher();
    await dedup.initialize(makeContext(infra));
  });

  afterEach(async () => {
    await dedup.destroy();
  });

  it('reports manifest correctly', () => {
    assert.equal(dedup.manifest.id, 'enricher.dedup');
    assert.equal(dedup.manifest.type, 'enricher');
  });

  it('initializes with provided config', () => {
    const cfg = dedup.getConfig();
    assert.equal(cfg.windowMs, 5000);
    assert.deepStrictEqual(cfg.fingerprintFields, ['title', 'severity', 'detectedBy']);
    assert.equal(cfg.maxFingerprints, 100);
    assert.equal(cfg.emitSuppressed, true);
  });

  it('reports healthy status', () => {
    const h = dedup.health();
    assert.equal(h.status, 'healthy');
    assert.ok(h.details);
    assert.equal(h.details!.activeFingerprints, 0);
  });

  it('starts and stops cleanly', async () => {
    await dedup.start();
    await dedup.stop();
    // No throws
  });
});

// ── Deduplication Logic Tests ──────────────────────────────────────────────

describe('enricher.dedup — Deduplication', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let dedup: DedupEnricher;

  beforeEach(async () => {
    infra = createTestInfra();
    dedup = new DedupEnricher();
    await dedup.initialize(makeContext(infra, { windowMs: 5000 }));
    await dedup.start();
  });

  afterEach(async () => {
    await dedup.stop();
    await dedup.destroy();
  });

  it('lets the first occurrence through', async () => {
    const event = makeIncident();
    await infra.bus.publish(event);
    await sleep(50);

    const metrics = dedup.getMetrics();
    assert.equal(metrics.totalProcessed, 1);
    assert.equal(metrics.totalPassed, 1);
    assert.equal(metrics.totalSuppressed, 0);
    assert.equal(metrics.activeFingerprints, 1);
  });

  it('suppresses exact duplicate within window', async () => {
    const inc1 = makeIncident({ title: 'Dup Test', severity: 'critical', detectedBy: 'test' });
    const inc2 = makeIncident({ title: 'Dup Test', severity: 'critical', detectedBy: 'test' });

    await infra.bus.publish(inc1);
    await sleep(20);
    await infra.bus.publish(inc2);
    await sleep(20);

    const metrics = dedup.getMetrics();
    assert.equal(metrics.totalProcessed, 2);
    assert.equal(metrics.totalPassed, 1);
    assert.equal(metrics.totalSuppressed, 1);
  });

  it('allows different incidents through', async () => {
    const inc1 = makeIncident({ title: 'Error A', severity: 'critical', detectedBy: 'test' });
    const inc2 = makeIncident({ title: 'Error B', severity: 'warning', detectedBy: 'test' });

    await infra.bus.publish(inc1);
    await sleep(20);
    await infra.bus.publish(inc2);
    await sleep(20);

    const metrics = dedup.getMetrics();
    assert.equal(metrics.totalProcessed, 2);
    assert.equal(metrics.totalPassed, 2);
    assert.equal(metrics.totalSuppressed, 0);
  });

  it('tracks occurrence count for suppressed duplicates', async () => {
    const base = { title: 'Repeat', severity: 'warning' as const, detectedBy: 'test' };

    await infra.bus.publish(makeIncident(base));
    await sleep(20);
    await infra.bus.publish(makeIncident(base));
    await sleep(20);
    await infra.bus.publish(makeIncident(base));
    await sleep(20);

    const fingerprints = dedup.getFingerprints();
    assert.equal(fingerprints.size, 1);

    const entry = fingerprints.values().next().value as FingerprintEntry;
    assert.equal(entry.occurrences, 3);
  });

  it('emits incident.suppressed events', async () => {
    const suppressedEvents: OpsPilotEvent<IncidentSuppressedPayload>[] = [];
    infra.bus.subscribe<IncidentSuppressedPayload>('incident.suppressed', (e) => {
      suppressedEvents.push(e);
    });

    const base = { title: 'Suppress Me', severity: 'critical' as const, detectedBy: 'test' };
    const inc1 = makeIncident(base);
    const inc2 = makeIncident(base);

    await infra.bus.publish(inc1);
    await sleep(20);
    await infra.bus.publish(inc2);
    await sleep(20);

    assert.equal(suppressedEvents.length, 1);
    const sp = suppressedEvents[0].payload;
    assert.equal(sp.originalIncidentId, inc1.payload.incidentId);
    assert.equal(sp.suppressedIncidentId, inc2.payload.incidentId);
    assert.equal(sp.occurrences, 2);
  });

  it('emits enrichment.completed on suppression', async () => {
    const enrichments: OpsPilotEvent<EnrichmentCompletedPayload>[] = [];
    infra.bus.subscribe<EnrichmentCompletedPayload>('enrichment.completed', (e) => {
      if (e.payload.enrichmentType === 'dedup_occurrence') {
        enrichments.push(e);
      }
    });

    const base = { title: 'Enrich Test', severity: 'info' as const, detectedBy: 'test' };
    await infra.bus.publish(makeIncident(base));
    await sleep(20);
    await infra.bus.publish(makeIncident(base));
    await sleep(20);

    assert.equal(enrichments.length, 1);
    assert.equal(enrichments[0].payload.enricherModule, 'enricher.dedup');
    assert.equal(enrichments[0].payload.data.occurrences, 2);
  });

  it('does not emit incident.suppressed when emitSuppressed=false', async () => {
    await dedup.stop();
    await dedup.destroy();

    dedup = new DedupEnricher();
    await dedup.initialize(makeContext(infra, {
      windowMs: 5000,
      emitSuppressed: false,
    }));
    await dedup.start();

    const suppressedEvents: OpsPilotEvent<IncidentSuppressedPayload>[] = [];
    infra.bus.subscribe<IncidentSuppressedPayload>('incident.suppressed', (e) => {
      suppressedEvents.push(e);
    });

    const base = { title: 'No Suppress', severity: 'critical' as const, detectedBy: 'test' };
    await infra.bus.publish(makeIncident(base));
    await sleep(20);
    await infra.bus.publish(makeIncident(base));
    await sleep(20);

    assert.equal(suppressedEvents.length, 0);
    // But it should still count suppression
    assert.equal(dedup.getMetrics().totalSuppressed, 1);
  });
});

// ── Fingerprint Expiry Tests ───────────────────────────────────────────────

describe('enricher.dedup — Fingerprint Expiry', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let dedup: DedupEnricher;

  beforeEach(async () => {
    infra = createTestInfra();
    dedup = new DedupEnricher();
  });

  afterEach(async () => {
    await dedup.stop();
    await dedup.destroy();
  });

  it('allows duplicate after window expires', async () => {
    await dedup.initialize(makeContext(infra, { windowMs: 200 }));
    await dedup.start();

    const base = { title: 'Expire Test', severity: 'critical' as const, detectedBy: 'test' };
    await infra.bus.publish(makeIncident(base));
    await sleep(20);
    assert.equal(dedup.getMetrics().totalPassed, 1);

    // Wait for window to expire
    await sleep(250);

    // Publish same fingerprint — should be treated as new
    await infra.bus.publish(makeIncident(base));
    await sleep(20);

    // Both should have passed (not suppressed) since window expired
    assert.equal(dedup.getMetrics().totalPassed, 2);
    assert.equal(dedup.getMetrics().totalSuppressed, 0);
  });
});

// ── Capacity Tests ─────────────────────────────────────────────────────────

describe('enricher.dedup — Capacity', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let dedup: DedupEnricher;

  beforeEach(async () => {
    infra = createTestInfra();
    dedup = new DedupEnricher();
  });

  afterEach(async () => {
    await dedup.stop();
    await dedup.destroy();
  });

  it('evicts oldest fingerprint when capacity is exceeded', async () => {
    await dedup.initialize(makeContext(infra, { maxFingerprints: 3, windowMs: 60000 }));
    await dedup.start();

    // Create 4 unique incidents (different titles)
    for (let i = 0; i < 4; i++) {
      await infra.bus.publish(makeIncident({
        title: `Unique ${i}`,
        severity: 'critical',
        detectedBy: 'test',
      }));
      await sleep(20);
    }

    // Only 3 should remain (maxFingerprints = 3)
    assert.equal(dedup.getFingerprints().size, 3);
    assert.equal(dedup.getMetrics().totalPassed, 4);
  });
});

// ── Health Check Tests ─────────────────────────────────────────────────────

describe('enricher.dedup — Health', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let dedup: DedupEnricher;

  beforeEach(async () => {
    infra = createTestInfra();
    dedup = new DedupEnricher();
    await dedup.initialize(makeContext(infra));
    await dedup.start();
  });

  afterEach(async () => {
    await dedup.stop();
    await dedup.destroy();
  });

  it('health includes suppression rate', async () => {
    const base = { title: 'Health Test', severity: 'critical' as const, detectedBy: 'test' };
    await infra.bus.publish(makeIncident(base));
    await sleep(20);
    await infra.bus.publish(makeIncident(base));
    await sleep(20);

    const h = dedup.health();
    assert.ok(h.details);
    assert.equal(h.details!.totalProcessed, 2);
    assert.equal(h.details!.totalSuppressed, 1);
    assert.equal(h.details!.suppressionRate, '50.0%');
  });
});
