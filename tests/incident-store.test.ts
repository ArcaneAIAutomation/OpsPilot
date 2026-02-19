// ---------------------------------------------------------------------------
// OpsPilot — enricher.incidentStore Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IncidentStore, StoredIncident } from '../src/modules/enricher.incidentStore/index';
import { ModuleContext } from '../src/core/types/module';
import { OpsPilotEvent } from '../src/core/types/events';
import {
  IncidentCreatedPayload,
  IncidentUpdatedPayload,
  EnrichmentCompletedPayload,
} from '../src/shared/events';
import { NamespacedStorage } from '../src/core/storage/NamespacedStorage';
import { createTestInfra, sleep } from './helpers';

// ── Helper: build context ──────────────────────────────────────────────────

function buildContext(
  infra: ReturnType<typeof createTestInfra>,
  config: Record<string, unknown> = {},
): ModuleContext {
  return {
    moduleId: 'enricher.incidentStore',
    config: { maxIncidents: 100, retentionMs: 86400000, ...config },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'enricher.incidentStore'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

// ── Helper: publish incident.created ───────────────────────────────────────

function emitIncident(
  infra: ReturnType<typeof createTestInfra>,
  id: string,
  opts?: Partial<IncidentCreatedPayload>,
) {
  const payload: IncidentCreatedPayload = {
    incidentId: id,
    title: opts?.title ?? `Incident ${id}`,
    description: opts?.description ?? `Description for ${id}`,
    severity: opts?.severity ?? 'warning',
    detectedBy: opts?.detectedBy ?? 'detector.test',
    detectedAt: opts?.detectedAt ?? new Date(),
    context: opts?.context,
  };

  return infra.bus.publish<IncidentCreatedPayload>({
    type: 'incident.created',
    source: 'detector.test',
    timestamp: new Date(),
    correlationId: id,
    payload,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('enricher.incidentStore', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let store: IncidentStore;

  beforeEach(() => {
    infra = createTestInfra();
    store = new IncidentStore();
  });

  // ── Storage ──────────────────────────────────────────────────────────

  it('should store an incident from incident.created event', async () => {
    const ctx = buildContext(infra);
    await store.initialize(ctx);
    await store.start();

    await emitIncident(infra, 'inc-1', { severity: 'critical', title: 'Test Error' });
    await sleep(10);

    const incident = await store.getIncident('inc-1');
    assert.ok(incident);
    assert.strictEqual(incident.id, 'inc-1');
    assert.strictEqual(incident.title, 'Test Error');
    assert.strictEqual(incident.severity, 'critical');
    assert.strictEqual(incident.status, 'open');
    assert.ok(incident.createdAt);
    assert.ok(incident.timeline.length >= 1);

    await store.stop();
    await store.destroy();
  });

  it('should store multiple incidents', async () => {
    const ctx = buildContext(infra);
    await store.initialize(ctx);
    await store.start();

    await emitIncident(infra, 'inc-1');
    await emitIncident(infra, 'inc-2');
    await emitIncident(infra, 'inc-3');
    await sleep(10);

    const all = await store.listIncidents();
    assert.strictEqual(all.length, 3);

    await store.stop();
    await store.destroy();
  });

  // ── Query / Filter ───────────────────────────────────────────────────

  it('should filter incidents by severity', async () => {
    const ctx = buildContext(infra);
    await store.initialize(ctx);
    await store.start();

    await emitIncident(infra, 'inc-1', { severity: 'critical' });
    await emitIncident(infra, 'inc-2', { severity: 'warning' });
    await emitIncident(infra, 'inc-3', { severity: 'critical' });
    await sleep(10);

    const critical = await store.listIncidents({ severity: 'critical' });
    assert.strictEqual(critical.length, 2);
    assert.ok(critical.every((i) => i.severity === 'critical'));

    await store.stop();
    await store.destroy();
  });

  it('should filter incidents by status', async () => {
    const ctx = buildContext(infra);
    await store.initialize(ctx);
    await store.start();

    await emitIncident(infra, 'inc-1');
    await emitIncident(infra, 'inc-2');
    await sleep(10);

    await store.updateStatus('inc-1', 'resolved', 'admin');

    const open = await store.listIncidents({ status: 'open' });
    assert.strictEqual(open.length, 1);
    assert.strictEqual(open[0].id, 'inc-2');

    const resolved = await store.listIncidents({ status: 'resolved' });
    assert.strictEqual(resolved.length, 1);
    assert.strictEqual(resolved[0].id, 'inc-1');

    await store.stop();
    await store.destroy();
  });

  it('should respect limit parameter', async () => {
    const ctx = buildContext(infra);
    await store.initialize(ctx);
    await store.start();

    for (let i = 1; i <= 5; i++) {
      await emitIncident(infra, `inc-${i}`);
      await sleep(5); // stagger createdAt timestamps
    }
    await sleep(10);

    const limited = await store.listIncidents({ limit: 2 });
    assert.strictEqual(limited.length, 2);

    await store.stop();
    await store.destroy();
  });

  // ── Status Updates ───────────────────────────────────────────────────

  it('should update incident status and add timeline entry', async () => {
    const ctx = buildContext(infra);
    await store.initialize(ctx);
    await store.start();

    await emitIncident(infra, 'inc-1');
    await sleep(10);

    const updated = await store.updateStatus('inc-1', 'acknowledged', 'on-call');
    assert.strictEqual(updated.status, 'acknowledged');

    const timeline = updated.timeline;
    const statusChange = timeline.find((t) => t.action === 'status.changed');
    assert.ok(statusChange);
    assert.strictEqual(statusChange.actor, 'on-call');
    assert.deepStrictEqual(statusChange.details, {
      oldStatus: 'open',
      newStatus: 'acknowledged',
    });

    await store.stop();
    await store.destroy();
  });

  it('should throw when updating non-existent incident', async () => {
    const ctx = buildContext(infra);
    await store.initialize(ctx);
    await store.start();

    await assert.rejects(
      () => store.updateStatus('nope', 'resolved', 'admin'),
      /not found/i,
    );

    await store.stop();
    await store.destroy();
  });

  it('should emit incident.updated event on status change', async () => {
    const ctx = buildContext(infra);
    await store.initialize(ctx);
    await store.start();

    const updates: OpsPilotEvent<IncidentUpdatedPayload>[] = [];
    infra.bus.subscribe<IncidentUpdatedPayload>('incident.updated', (e) => {
      updates.push(e);
    });

    await emitIncident(infra, 'inc-1');
    await sleep(10);

    await store.updateStatus('inc-1', 'resolved', 'admin');
    await sleep(10);

    const statusUpdates = updates.filter((e) => e.payload.field === 'status');
    assert.strictEqual(statusUpdates.length, 1);
    assert.strictEqual(statusUpdates[0].payload.oldValue, 'open');
    assert.strictEqual(statusUpdates[0].payload.newValue, 'resolved');

    await store.stop();
    await store.destroy();
  });

  // ── Enrichment Attachment ────────────────────────────────────────────

  it('should attach enrichment data to existing incident', async () => {
    const ctx = buildContext(infra);
    await store.initialize(ctx);
    await store.start();

    await emitIncident(infra, 'inc-1');
    await sleep(10);

    // Emit enrichment.completed event
    await infra.bus.publish<EnrichmentCompletedPayload>({
      type: 'enrichment.completed',
      source: 'enricher.aiSummary',
      timestamp: new Date(),
      correlationId: 'inc-1',
      payload: {
        incidentId: 'inc-1',
        enricherModule: 'enricher.aiSummary',
        enrichmentType: 'ai-summary',
        data: { summary: 'This is a test summary' },
        completedAt: new Date(),
      },
    });
    await sleep(10);

    const incident = await store.getIncident('inc-1');
    assert.ok(incident);
    assert.ok(incident.enrichments['enricher.aiSummary']);
    assert.deepStrictEqual(
      (incident.enrichments['enricher.aiSummary'] as any).summary,
      'This is a test summary',
    );

    // Check timeline entry
    const enrichmentEntry = incident.timeline.find((t) => t.action === 'enrichment.added');
    assert.ok(enrichmentEntry);
    assert.strictEqual(enrichmentEntry.actor, 'enricher.aiSummary');

    await store.stop();
    await store.destroy();
  });

  it('should emit incident.updated on enrichment attachment', async () => {
    const ctx = buildContext(infra);
    await store.initialize(ctx);
    await store.start();

    const updates: OpsPilotEvent<IncidentUpdatedPayload>[] = [];
    infra.bus.subscribe<IncidentUpdatedPayload>('incident.updated', (e) => {
      updates.push(e);
    });

    await emitIncident(infra, 'inc-1');
    await sleep(10);

    await infra.bus.publish<EnrichmentCompletedPayload>({
      type: 'enrichment.completed',
      source: 'enricher.test',
      timestamp: new Date(),
      payload: {
        incidentId: 'inc-1',
        enricherModule: 'enricher.test',
        enrichmentType: 'test-enrichment',
        data: { key: 'value' },
        completedAt: new Date(),
      },
    });
    await sleep(10);

    const enrichUpdates = updates.filter((e) => e.payload.field.startsWith('enrichments.'));
    assert.strictEqual(enrichUpdates.length, 1);
    assert.strictEqual(enrichUpdates[0].payload.updatedBy, 'enricher.test');

    await store.stop();
    await store.destroy();
  });

  // ── Summary ──────────────────────────────────────────────────────────

  it('should return summary grouped by severity and status', async () => {
    const ctx = buildContext(infra);
    await store.initialize(ctx);
    await store.start();

    await emitIncident(infra, 'inc-1', { severity: 'critical' });
    await emitIncident(infra, 'inc-2', { severity: 'warning' });
    await emitIncident(infra, 'inc-3', { severity: 'critical' });
    await sleep(10);

    const summary = await store.getSummary();
    assert.strictEqual(summary.total, 3);
    assert.strictEqual(summary.bySeverity['critical'], 2);
    assert.strictEqual(summary.bySeverity['warning'], 1);
    assert.strictEqual(summary.byStatus['open'], 3);

    await store.stop();
    await store.destroy();
  });

  // ── Retention ────────────────────────────────────────────────────────

  it('should enforce maxIncidents capacity', async () => {
    const ctx = buildContext(infra, { maxIncidents: 3, retentionMs: 0 });
    await store.initialize(ctx);
    await store.start();

    for (let i = 1; i <= 5; i++) {
      await emitIncident(infra, `inc-${i}`);
      await sleep(5); // stagger timestamps
    }
    await sleep(20);

    const all = await store.listIncidents();
    assert.ok(all.length <= 3, `Expected at most 3 incidents, got ${all.length}`);

    await store.stop();
    await store.destroy();
  });

  // ── Health ───────────────────────────────────────────────────────────

  it('should report healthy status', async () => {
    const ctx = buildContext(infra);
    await store.initialize(ctx);

    const health = store.health();
    assert.strictEqual(health.status, 'healthy');
    assert.ok(health.lastCheck instanceof Date);
  });
});
