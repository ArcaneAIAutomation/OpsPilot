// ---------------------------------------------------------------------------
// OpsPilot — connector.metrics Module Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  MetricCollector,
  takeCpuSnapshot,
  computeCpuPercent,
} from '../src/modules/connector.metrics/index';
import { ModuleContext, ModuleType } from '../src/core/types/module';
import { NamespacedStorage } from '../src/core/storage/NamespacedStorage';
import { OpsPilotEvent } from '../src/core/types/events';
import { LogIngestedPayload } from '../src/shared/events';
import { createTestInfra, sleep } from './helpers';

// ── Helpers ────────────────────────────────────────────────────────────────

function buildContext(
  infra: ReturnType<typeof createTestInfra>,
  config: Record<string, unknown> = {},
): ModuleContext {
  return {
    moduleId: 'connector.metrics',
    config: {
      intervalMs: 60000, // long — we call collect() manually
      enabledMetrics: ['cpu', 'memory', 'loadAvg', 'uptime'],
      thresholds: {
        cpuPercent: 90,
        memoryPercent: 90,
      },
      source: 'test-metrics',
      ...config,
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'connector.metrics'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('connector.metrics — System Metric Collector', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: MetricCollector;
  let events: OpsPilotEvent[];

  beforeEach(() => {
    infra = createTestInfra();
    mod = new MetricCollector();
    events = [];
    infra.bus.subscribe('log.ingested', (ev) => {
      events.push(ev);
    });
  });

  afterEach(async () => {
    await mod.stop().catch(() => {});
    await mod.destroy().catch(() => {});
  });

  // ── Lifecycle ────────────────────────────────────────────────────────────

  describe('Lifecycle', () => {
    it('has correct manifest', () => {
      assert.equal(mod.manifest.id, 'connector.metrics');
      assert.equal(mod.manifest.type, ModuleType.Connector);
    });

    it('initializes with default config', async () => {
      const ctx = buildContext(infra);
      await mod.initialize(ctx);
      const config = mod.getConfig();
      assert.equal(config.intervalMs, 60000);
      assert.equal(config.source, 'test-metrics');
      assert.deepEqual(config.thresholds, {
        cpuPercent: 90,
        memoryPercent: 90,
      });
    });

    it('starts and stops', async () => {
      const ctx = buildContext(infra);
      await mod.initialize(ctx);
      await mod.start();
      await mod.stop();
      // Should not throw
    });

    it('reports healthy status', async () => {
      const ctx = buildContext(infra);
      await mod.initialize(ctx);
      const h = mod.health();
      assert.equal(h.status, 'healthy');
      assert.equal(h.details!['cycleCount'], 0);
      assert.equal(h.details!['linesEmitted'], 0);
    });
  });

  // ── CPU Helpers ──────────────────────────────────────────────────────────

  describe('CPU Helpers', () => {
    it('takes a CPU snapshot', () => {
      const snap = takeCpuSnapshot();
      assert.ok(snap.idle > 0);
      assert.ok(snap.total > 0);
      assert.ok(snap.total >= snap.idle);
    });

    it('computes CPU percent between snapshots', () => {
      const prev = { idle: 1000, total: 10000 };
      const curr = { idle: 1200, total: 11000 };
      // Total delta = 1000, idle delta = 200, used delta = 800
      // Percent = 800/1000 * 100 = 80%
      const pct = computeCpuPercent(prev, curr);
      assert.equal(pct, 80);
    });

    it('returns 0 when no time has passed', () => {
      const snap = { idle: 1000, total: 10000 };
      assert.equal(computeCpuPercent(snap, snap), 0);
    });
  });

  // ── Collection ───────────────────────────────────────────────────────────

  describe('Collection', () => {
    it('emits metric lines for all enabled metrics', async () => {
      const ctx = buildContext(infra);
      await mod.initialize(ctx);

      // Need two collects: first one sets CPU baseline, second produces CPU metric
      mod.collect();
      const firstBatch = events.length;
      assert.ok(firstBatch >= 3, `Expected ≥3 events (mem+load+uptime), got ${firstBatch}`);

      events.length = 0;
      mod.collect();
      // Second collect should include CPU metric
      assert.ok(events.length >= 4, `Expected ≥4 events (cpu+mem+load+uptime), got ${events.length}`);

      // All events should be log.ingested
      for (const ev of events) {
        assert.equal(ev.type, 'log.ingested');
        assert.equal(ev.source, 'connector.metrics');
      }
    });

    it('emits [METRIC] tagged lines', async () => {
      const ctx = buildContext(infra);
      await mod.initialize(ctx);
      mod.collect();

      const metricLines = events
        .map((e) => (e.payload as LogIngestedPayload).line)
        .filter((line) => line.startsWith('[METRIC]'));

      assert.ok(metricLines.length >= 3, 'Should have at least 3 metric lines');
    });

    it('emits memory metrics with usage details', async () => {
      const ctx = buildContext(infra);
      await mod.initialize(ctx);
      mod.collect();

      const memLine = events
        .map((e) => (e.payload as LogIngestedPayload).line)
        .find((l) => l.includes('memory_usage_percent'));

      assert.ok(memLine, 'Should emit memory metric');
      assert.ok(memLine!.includes('memory_used_mb'));
      assert.ok(memLine!.includes('memory_total_mb'));
    });

    it('emits load average metrics', async () => {
      const ctx = buildContext(infra);
      await mod.initialize(ctx);
      mod.collect();

      const loadLine = events
        .map((e) => (e.payload as LogIngestedPayload).line)
        .find((l) => l.includes('load_avg_1m'));

      assert.ok(loadLine, 'Should emit load average metric');
      assert.ok(loadLine!.includes('load_avg_5m'));
      assert.ok(loadLine!.includes('load_avg_15m'));
    });

    it('emits uptime metric', async () => {
      const ctx = buildContext(infra);
      await mod.initialize(ctx);
      mod.collect();

      const uptimeLine = events
        .map((e) => (e.payload as LogIngestedPayload).line)
        .find((l) => l.includes('uptime_hours'));

      assert.ok(uptimeLine, 'Should emit uptime metric');
    });

    it('tracks cycle count and lines emitted', async () => {
      const ctx = buildContext(infra);
      await mod.initialize(ctx);

      mod.collect();
      assert.equal(mod.getCycleCount(), 1);
      assert.ok(mod.getLinesEmitted() >= 3);

      mod.collect();
      assert.equal(mod.getCycleCount(), 2);
    });

    it('only collects enabled metrics', async () => {
      const ctx = buildContext(infra, {
        enabledMetrics: ['uptime'],
      });
      await mod.initialize(ctx);
      mod.collect();

      assert.equal(events.length, 1);
      const line = (events[0].payload as LogIngestedPayload).line;
      assert.ok(line.includes('uptime_hours'));
    });

    it('sets source from config', async () => {
      const ctx = buildContext(infra, {
        source: 'custom-source',
      });
      await mod.initialize(ctx);
      mod.collect();

      const payload = events[0].payload as LogIngestedPayload;
      assert.equal(payload.source, 'custom-source');
    });

    it('includes metadata in emitted events', async () => {
      const ctx = buildContext(infra);
      await mod.initialize(ctx);
      mod.collect();

      const payload = events[0].payload as LogIngestedPayload;
      assert.ok(payload.metadata);
      assert.equal(payload.metadata!['collector'], 'connector.metrics');
      assert.equal(payload.metadata!['cycle'], 1);
    });
  });

  // ── Threshold Warnings ──────────────────────────────────────────────────

  describe('Threshold Warnings', () => {
    it('emits WARNING when memory exceeds threshold (threshold=0)', async () => {
      // Set memory threshold to 0% so it always triggers
      const ctx = buildContext(infra, {
        enabledMetrics: ['memory'],
        thresholds: { cpuPercent: 90, memoryPercent: 0 },
      });
      await mod.initialize(ctx);
      mod.collect();

      const warnings = events
        .map((e) => (e.payload as LogIngestedPayload).line)
        .filter((l) => l.startsWith('[WARNING]'));

      assert.ok(warnings.length >= 1, 'Should emit at least one warning');
      assert.ok(warnings[0].includes('memory_usage_percent'));
      assert.ok(warnings[0].includes('exceeds threshold'));
    });
  });

  // ── Timer-based collection ──────────────────────────────────────────────

  describe('Timed Collection', () => {
    it('collects on interval when started', async () => {
      const ctx = buildContext(infra, {
        intervalMs: 100,
        enabledMetrics: ['uptime'],
      });
      await mod.initialize(ctx);
      await mod.start();

      await sleep(450);
      await mod.stop();

      assert.ok(mod.getCycleCount() >= 2, `Expected ≥2 cycles, got ${mod.getCycleCount()}`);
      assert.ok(events.length >= 2, `Expected ≥2 events, got ${events.length}`);
    });
  });
});
