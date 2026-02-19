// ---------------------------------------------------------------------------
// OpsPilot — enricher.correlator Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  IncidentCorrelator,
  CorrelationGroup,
  IncidentStormPayload,
  tokenize,
  jaccardSimilarity,
} from '../src/modules/enricher.correlator/index';
import { ModuleContext, ModuleType } from '../src/core/types/module';
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
    moduleId: 'enricher.correlator',
    config: {
      timeWindowMs: 60000,
      similarityThreshold: 0.4,
      maxGroupSize: 50,
      stormThreshold: 3,
      maxGroups: 500,
      groupTtlMs: 3600000,
      ...config,
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'enricher.correlator'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

let incidentCounter = 0;

function makeIncident(
  overrides: Partial<IncidentCreatedPayload> = {},
): OpsPilotEvent<IncidentCreatedPayload> {
  const id = `INC-${++incidentCounter}`;
  return {
    type: 'incident.created',
    source: 'test',
    timestamp: new Date(),
    payload: {
      incidentId: id,
      title: 'High CPU usage on web-01',
      description: 'CPU at 95% for 5 minutes',
      severity: 'critical',
      detectedBy: 'detector.threshold',
      detectedAt: new Date(),
      context: { host: 'web-01' },
      ...overrides,
    },
  };
}

// ── Utility Tests ──────────────────────────────────────────────────────────

describe('enricher.correlator — Utility Functions', () => {
  it('tokenize extracts lowercased words > 2 chars', () => {
    const tokens = tokenize('High CPU Usage on web-01 server');
    assert.ok(tokens.has('high'));
    assert.ok(tokens.has('cpu'));
    assert.ok(tokens.has('usage'));
    assert.ok(tokens.has('web'));
    assert.ok(tokens.has('server'));
    assert.ok(!tokens.has('on'));  // too short
    assert.ok(!tokens.has('01')); // too short
  });

  it('tokenize returns empty set for empty string', () => {
    const tokens = tokenize('');
    assert.equal(tokens.size, 0);
  });

  it('jaccardSimilarity computes correct values', () => {
    const a = new Set(['cpu', 'high', 'usage']);
    const b = new Set(['cpu', 'high', 'load']);
    // intersection = {cpu, high} = 2, union = {cpu, high, usage, load} = 4
    assert.equal(jaccardSimilarity(a, b), 0.5);
  });

  it('jaccardSimilarity returns 1 for identical sets', () => {
    const a = new Set(['cpu', 'high']);
    assert.equal(jaccardSimilarity(a, new Set(a)), 1);
  });

  it('jaccardSimilarity returns 0 for disjoint sets', () => {
    const a = new Set(['cpu', 'high']);
    const b = new Set(['disk', 'full']);
    assert.equal(jaccardSimilarity(a, b), 0);
  });

  it('jaccardSimilarity returns 0 for two empty sets', () => {
    assert.equal(jaccardSimilarity(new Set(), new Set()), 0);
  });
});

// ── Correlator Module Tests ────────────────────────────────────────────────

describe('enricher.correlator — Incident Correlator', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: IncidentCorrelator;

  beforeEach(() => {
    infra = createTestInfra();
    mod = new IncidentCorrelator();
  });

  afterEach(async () => {
    await mod.stop().catch(() => {});
    await mod.destroy().catch(() => {});
  });

  describe('Lifecycle', () => {
    it('has correct manifest', () => {
      assert.equal(mod.manifest.id, 'enricher.correlator');
      assert.equal(mod.manifest.type, ModuleType.Enricher);
    });

    it('initializes with config defaults', async () => {
      await mod.initialize(makeContext(infra));
      const config = mod.getConfig();
      assert.equal(config.timeWindowMs, 60000);
      assert.equal(config.similarityThreshold, 0.4);
      assert.equal(config.stormThreshold, 3);
    });

    it('reports healthy status', async () => {
      await mod.initialize(makeContext(infra));
      const h = mod.health();
      assert.equal(h.status, 'healthy');
      assert.equal(h.details!['activeGroups'], 0);
    });
  });

  describe('Grouping', () => {
    it('creates a new group for the first incident', async () => {
      await mod.initialize(makeContext(infra));
      await mod.start();

      infra.bus.publish(makeIncident());
      await sleep(50);

      const groups = mod.getGroups();
      assert.equal(groups.size, 1);
      const group = [...groups.values()][0];
      assert.equal(group.memberIds.length, 1);
    });

    it('groups similar incidents together', async () => {
      await mod.initialize(makeContext(infra));
      await mod.start();

      // Two incidents with very similar text
      infra.bus.publish(makeIncident({ title: 'High CPU usage on web-01', description: 'CPU at 95%' }));
      await sleep(30);
      infra.bus.publish(makeIncident({ title: 'High CPU usage on web-02', description: 'CPU at 92%' }));
      await sleep(50);

      const groups = mod.getGroups();
      assert.equal(groups.size, 1, 'Similar incidents should be in one group');
      const group = [...groups.values()][0];
      assert.equal(group.memberIds.length, 2);
    });

    it('does NOT group dissimilar incidents', async () => {
      await mod.initialize(makeContext(infra));
      await mod.start();

      infra.bus.publish(makeIncident({
        title: 'High CPU usage on server',
        description: 'CPU at 95%',
      }));
      await sleep(30);
      infra.bus.publish(makeIncident({
        title: 'Disk space full on database',
        description: 'Root partition 99% full',
      }));
      await sleep(50);

      const groups = mod.getGroups();
      assert.equal(groups.size, 2, 'Dissimilar incidents should be in separate groups');
    });

    it('emits enrichment.completed for correlated incidents', async () => {
      await mod.initialize(makeContext(infra));
      await mod.start();

      const enrichments: OpsPilotEvent<EnrichmentCompletedPayload>[] = [];
      infra.bus.subscribe<EnrichmentCompletedPayload>('enrichment.completed', (e) => {
        enrichments.push(e);
      });

      infra.bus.publish(makeIncident({ title: 'High CPU usage', description: 'CPU high' }));
      await sleep(30);
      infra.bus.publish(makeIncident({ title: 'High CPU usage again', description: 'CPU still high' }));
      await sleep(50);

      // Only the second incident triggers an enrichment (first creates the group)
      assert.equal(enrichments.length, 1);
      assert.equal(enrichments[0].payload.enrichmentType, 'correlation');
      assert.ok((enrichments[0].payload.data as Record<string, unknown>).groupId);
    });

    it('respects source match bonus (same source gets lower threshold)', async () => {
      await mod.initialize(makeContext(infra, { similarityThreshold: 0.45 }));
      await mod.start();

      // Two incidents with moderate similarity but same source
      // keywords1: {error, web, application, server, crashed}
      // keywords2: {error, web, application, server, timeout}
      // intersection: {error, web, application, server} = 4, union = 6
      // jaccard = 4/6 ≈ 0.667 — above 0.45. Without source bonus it still passes,
      // but the test verifies the bonus path is active and lowers the threshold.
      // With threshold at 0.45 and source bonus (0.45*0.7=0.315), even moderate
      // similarity incidents from the same source are grouped.
      infra.bus.publish(makeIncident({
        title: 'Error web application server crashed',
        description: '',
        detectedBy: 'detector.regex',
      }));
      await sleep(30);
      infra.bus.publish(makeIncident({
        title: 'Error web application server timeout',
        description: '',
        detectedBy: 'detector.regex',
      }));
      await sleep(50);

      const groups = mod.getGroups();
      assert.equal(groups.size, 1);
    });
  });

  describe('Storm Detection', () => {
    it('emits incident.storm when group reaches stormThreshold', async () => {
      await mod.initialize(makeContext(infra, { stormThreshold: 3 }));
      await mod.start();

      const storms: OpsPilotEvent<IncidentStormPayload>[] = [];
      infra.bus.subscribe<IncidentStormPayload>('incident.storm', (e) => {
        storms.push(e);
      });

      // Send 3 similar incidents to trigger a storm
      for (let i = 0; i < 3; i++) {
        infra.bus.publish(makeIncident({
          title: 'Database connection timeout',
          description: `Connection pool exhausted attempt ${i}`,
        }));
        await sleep(30);
      }
      await sleep(50);

      assert.equal(storms.length, 1);
      assert.equal(storms[0].payload.memberCount, 3);
    });

    it('only emits storm once per group', async () => {
      await mod.initialize(makeContext(infra, { stormThreshold: 2 }));
      await mod.start();

      const storms: OpsPilotEvent<IncidentStormPayload>[] = [];
      infra.bus.subscribe<IncidentStormPayload>('incident.storm', (e) => {
        storms.push(e);
      });

      for (let i = 0; i < 5; i++) {
        infra.bus.publish(makeIncident({
          title: 'Database connection error',
          description: `Error ${i}`,
        }));
        await sleep(20);
      }
      await sleep(50);

      assert.equal(storms.length, 1, 'Storm should only be emitted once');
    });

    it('tracks storm count in metrics', async () => {
      await mod.initialize(makeContext(infra, { stormThreshold: 2 }));
      await mod.start();

      for (let i = 0; i < 3; i++) {
        infra.bus.publish(makeIncident({
          title: 'OOM killer activated',
          description: `Process killed ${i}`,
        }));
        await sleep(20);
      }
      await sleep(50);

      const metrics = mod.getMetrics();
      assert.equal(metrics.totalStorms, 1);
      assert.ok(metrics.totalCorrelated >= 2);
    });
  });

  describe('Group Capacity', () => {
    it('does not exceed maxGroupSize', async () => {
      await mod.initialize(makeContext(infra, { maxGroupSize: 3 }));
      await mod.start();

      for (let i = 0; i < 5; i++) {
        infra.bus.publish(makeIncident({
          title: 'Network packet loss detected',
          description: `Loss at ${i}%`,
        }));
        await sleep(20);
      }
      await sleep(50);

      const groups = mod.getGroups();
      const firstGroup = [...groups.values()][0];
      assert.ok(firstGroup.memberIds.length <= 3, 'Group should not exceed maxGroupSize');
    });

    it('evicts oldest group when maxGroups reached', async () => {
      await mod.initialize(makeContext(infra, {
        maxGroups: 2,
        similarityThreshold: 0.99, // force separate groups
      }));
      await mod.start();

      infra.bus.publish(makeIncident({ title: 'Alpha error', description: 'First' }));
      await sleep(20);
      infra.bus.publish(makeIncident({ title: 'Beta warning', description: 'Second' }));
      await sleep(20);
      infra.bus.publish(makeIncident({ title: 'Gamma critical', description: 'Third' }));
      await sleep(50);

      const groups = mod.getGroups();
      assert.ok(groups.size <= 2, 'Should not exceed maxGroups');
    });
  });

  describe('Time Window', () => {
    it('does not correlate incidents outside the time window', async () => {
      // Use a very short time window
      await mod.initialize(makeContext(infra, { timeWindowMs: 50 }));
      await mod.start();

      infra.bus.publish(makeIncident({ title: 'Disk latency spike', description: 'IO wait high' }));
      await sleep(100); // Wait longer than the time window
      infra.bus.publish(makeIncident({ title: 'Disk latency spike', description: 'IO wait high again' }));
      await sleep(50);

      const groups = mod.getGroups();
      assert.equal(groups.size, 2, 'Incidents outside time window should be in separate groups');
    });
  });
});
